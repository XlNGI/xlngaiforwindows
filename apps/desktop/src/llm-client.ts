import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type {
  AgentGenerationPrepareResult,
  AgentToolConfirmationRequest,
  LlmGenerationCompleteParams,
  LlmGenerationFailParams,
  LlmGenerationIdentity,
  LlmGenerationInfo,
  LlmGenerationPrepareResult,
  LlmNativeStreamEvent,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

const FLUSH_INTERVAL_MS = 250;
const FLUSH_CHARACTER_THRESHOLD = 512;
const CHANNEL_DELIVERY_GRACE_MS = 1_000;

type InvocationBoundaryOutcome = 'continue' | 'terminal' | 'missing';

export interface LlmStreamCallbacks {
  onDelta(content: string): void;
  onState(state: LlmGenerationInfo): void;
  onConfirmation?(request: AgentToolConfirmationRequest): Promise<boolean>;
}

export interface LlmStreamRun {
  readonly identity: LlmGenerationIdentity;
  readonly completion: Promise<void>;
  cancel(): Promise<void>;
}

export function streamPreparedLlmGeneration(
  prepared: LlmGenerationPrepareResult,
  callbacks: LlmStreamCallbacks,
): LlmStreamRun {
  const identity = prepared.stream;
  let aggregate = prepared.generation.assistantMessage.content;
  let persisted = aggregate;
  let terminal = false;
  let closing = false;
  let cancelRequested = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let invocationBoundary:
    { receive(): void; complete(outcome: InvocationBoundaryOutcome): void } | undefined;
  let events = Promise.resolve();
  let writes = Promise.resolve();

  const prepareInvocationBoundary = () => {
    let armDeliveryTimeout = () => {};
    const promise = new Promise<InvocationBoundaryOutcome>((resolve) => {
      let settled = false;
      let received = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: InvocationBoundaryOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (invocationBoundary === boundary) invocationBoundary = undefined;
        resolve(outcome);
      };
      const boundary = {
        receive() {
          if (settled) return;
          received = true;
          if (timer) clearTimeout(timer);
        },
        complete(outcome: InvocationBoundaryOutcome) {
          if (received) settle(outcome);
        },
      };
      invocationBoundary = boundary;
      armDeliveryTimeout = () => {
        if (!settled && !received) {
          timer = setTimeout(() => settle('missing'), CHANNEL_DELIVERY_GRACE_MS);
        }
      };
    });
    return { promise, armDeliveryTimeout };
  };

  const clearFlushTimer = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const observe = async (force = false) => {
    const content = aggregate;
    if (!force && content === persisted) return;
    const state = await callWorker('llm.generation.observe', { ...identity, content });
    persisted = content;
    callbacks.onState(state);
  };

  const queueObserve = () => {
    if (aggregate.length - persisted.length >= FLUSH_CHARACTER_THRESHOLD) {
      clearFlushTimer();
      writes = writes.then(() => observe());
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      writes = writes.then(() => observe());
    }, FLUSH_INTERVAL_MS);
  };

  const fail = async (
    error: string,
    retryable: boolean,
    usage?: LlmGenerationFailParams['usage'],
  ) => {
    if (terminal || closing) return;
    closing = true;
    clearFlushTimer();
    await writes.catch(() => undefined);
    const params: LlmGenerationFailParams = {
      ...identity,
      content: aggregate,
      error: normalizeError(error),
      retryable,
      usage,
    };
    try {
      callbacks.onState(await callWorker('llm.generation.fail', params));
      terminal = true;
    } finally {
      closing = false;
    }
  };

  const cancelWorker = async () => {
    if (terminal || closing) return;
    closing = true;
    clearFlushTimer();
    try {
      await writes.catch(() => undefined);
      await observe().catch(() => undefined);
      callbacks.onState(
        await callWorker('llm.generation.cancel', { generationId: identity.generationId }),
      );
      terminal = true;
    } finally {
      closing = false;
    }
  };

  const handleEvent = async (
    event: LlmNativeStreamEvent,
  ): Promise<InvocationBoundaryOutcome | undefined> => {
    if (terminal || closing) return;
    switch (event.type) {
      case 'started':
        if ((prepared as Partial<AgentGenerationPrepareResult>).agentTaskId) {
          await callWorker('agent.providerStep.start', identity);
        }
        await observe(true);
        break;
      case 'delta':
        if (cancelRequested || !event.delta) return;
        aggregate += event.delta;
        callbacks.onDelta(aggregate);
        queueObserve();
        break;
      case 'toolCalls': {
        const agentTaskId = (prepared as Partial<AgentGenerationPrepareResult>).agentTaskId;
        if (!agentTaskId) {
          await fail('Provider returned tool calls outside an Agent generation.', false);
          return 'terminal';
        }
        if (!event.providerResponseId) {
          await fail('Provider tool calls did not include a continuation identity.', false);
          return 'terminal';
        }
        const execution = await callWorker('agent.generation.executeTools', {
          ...identity,
          providerResponseId: event.providerResponseId,
          calls: event.calls,
          usage: event.usage,
        });
        let continuation = execution.continuation;
        if (!continuation && execution.confirmation && callbacks.onConfirmation) {
          const approved = await callbacks.onConfirmation(execution.confirmation);
          continuation = (
            await callWorker('agent.generation.confirmTool', {
              ...identity,
              confirmationToken: execution.confirmation.confirmationToken,
              approved,
            })
          ).continuation;
        }
        if (!continuation) {
          await fail('This document action requires explicit user confirmation.', false);
          return 'terminal';
        }
        return 'continue';
      }
      case 'complete': {
        closing = true;
        clearFlushTimer();
        await writes;
        const params: LlmGenerationCompleteParams = {
          ...identity,
          content: aggregate,
          providerResponseId: event.providerResponseId,
          finishReason: event.finishReason,
          usage: event.usage,
        };
        try {
          if ((prepared as Partial<AgentGenerationPrepareResult>).agentTaskId) {
            await callWorker('agent.providerStep.complete', {
              ...identity,
              providerResponseId: event.providerResponseId,
              finishReason: event.finishReason,
              usage: event.usage,
            });
          }
          callbacks.onState(await callWorker('llm.generation.complete', params));
          terminal = true;
        } finally {
          closing = false;
        }
        return 'terminal';
      }
      case 'failed':
        await fail(event.error, event.retryable, event.usage);
        return 'terminal';
      case 'cancelled':
        await cancelWorker();
        return 'terminal';
    }
  };

  const createInvocationChannel = () => {
    const channel = new Channel<LlmNativeStreamEvent>();
    channel.onmessage = (event) => {
      const boundary = ['toolCalls', 'complete', 'failed', 'cancelled'].includes(event.type)
        ? invocationBoundary
        : undefined;
      boundary?.receive();
      let outcome: InvocationBoundaryOutcome | undefined;
      events = events
        .then(async () => {
          outcome = await handleEvent(event);
        })
        .catch(async (error: unknown) => {
          await fail(
            error instanceof Error ? error.message : 'LLM stream event failed.',
            true,
          ).catch(() => undefined);
          outcome = 'terminal';
        });
      if (boundary) {
        events = events.finally(() =>
          boundary.complete(outcome ?? (terminal ? 'terminal' : 'missing')),
        );
      }
    };
    return channel;
  };

  const completion = (async () => {
    if (!isTauri()) {
      await fail('Native LLM streaming is only available in the desktop application.', false);
      return;
    }
    try {
      while (true) {
        const boundary = prepareInvocationBoundary();
        await invoke<void>('llm_stream', {
          request: identity,
          onEvent: createInvocationChannel(),
        });
        boundary.armDeliveryTimeout();
        const outcome = await boundary.promise;
        await events;
        if (outcome !== 'continue' || terminal || cancelRequested) break;
      }
      if (!terminal) {
        if (cancelRequested) await cancelWorker();
        else await fail('Native LLM stream ended without a terminal event.', true);
      }
    } catch (error) {
      await events;
      if (cancelRequested) await cancelWorker();
      else await fail(error instanceof Error ? error.message : 'Native LLM stream failed.', true);
    }
  })();

  return {
    identity,
    completion,
    async cancel() {
      if (terminal) return;
      cancelRequested = true;
      try {
        if (isTauri()) {
          await invoke<boolean>('llm_stream_cancel', { attemptId: identity.attemptId });
        }
      } finally {
        await cancelWorker();
      }
    },
  };
}

function normalizeError(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\r\n\0]+/g, ' ')
    .slice(0, 500);
  return normalized || 'LLM generation failed.';
}
