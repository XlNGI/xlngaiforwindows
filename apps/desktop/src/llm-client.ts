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
  let continueRequested = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let events = Promise.resolve();
  let writes = Promise.resolve();
  const channel = new Channel<LlmNativeStreamEvent>();

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

  const handleEvent = async (event: LlmNativeStreamEvent) => {
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
        if (!agentTaskId || !event.providerResponseId) {
          await fail('Provider returned tool calls outside an Agent generation.', false);
          break;
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
          break;
        }
        continueRequested = true;
        break;
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
        break;
      }
      case 'failed':
        await fail(event.error, event.retryable, event.usage);
        break;
      case 'cancelled':
        await cancelWorker();
        break;
    }
  };

  channel.onmessage = (event) => {
    events = events
      .then(() => handleEvent(event))
      .catch(async (error: unknown) => {
        await fail(error instanceof Error ? error.message : 'LLM stream event failed.', true).catch(
          () => undefined,
        );
      });
  };

  const completion = (async () => {
    if (!isTauri()) {
      await fail('Native LLM streaming is only available in the desktop application.', false);
      return;
    }
    try {
      do {
        continueRequested = false;
        await invoke<void>('llm_stream', { request: identity, onEvent: channel });
        await events;
      } while (continueRequested && !terminal && !cancelRequested);
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
