import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type {
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
const PI_POLL_INTERVAL_MS = 300;
const PI_POLL_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_PROVIDER_INVOCATIONS = 16;

type InvocationBoundaryOutcome = 'continue' | 'terminal' | 'missing';
type AgentCapablePrepared = LlmGenerationPrepareResult & {
  agentTaskId?: string;
  runtimeOwner?: 'desktop' | 'native-agent' | 'pi';
};

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
  const nativeAgentRuntime =
    Boolean((prepared as AgentCapablePrepared).agentTaskId) &&
    (prepared as AgentCapablePrepared).runtimeOwner === 'native-agent';
  const piRuntime =
    Boolean((prepared as AgentCapablePrepared).agentTaskId) &&
    (prepared as AgentCapablePrepared).runtimeOwner === 'pi';
  let aggregate = prepared.generation.assistantMessage.content;
  let persisted = aggregate;
  let terminal = false;
  let closing = false;
  let cancelRequested = false;
  let providerInvocationCount = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let invocationBoundary:
    { receive(): void; complete(outcome: InvocationBoundaryOutcome): void } | undefined;
  let events = Promise.resolve();
  let writes = Promise.resolve();
  let resolveNativeRuntimeTerminal: (() => void) | undefined;
  const nativeRuntimeTerminal = nativeAgentRuntime
    ? new Promise<void>((resolve) => {
        resolveNativeRuntimeTerminal = resolve;
      })
    : undefined;

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

  const cancelOwnedRuntime = async () => {
    if (!nativeAgentRuntime && !piRuntime) return;
    await callWorker('agent.generation.cancel', {
      generationId: identity.generationId,
    }).catch(() => undefined);
  };

  const handleEvent = async (
    event: LlmNativeStreamEvent,
  ): Promise<InvocationBoundaryOutcome | undefined> => {
    if (terminal || closing) return;
    switch (event.type) {
      case 'started':
        if ((prepared as AgentCapablePrepared).agentTaskId && !nativeAgentRuntime) {
          await callWorker('agent.providerStep.start', identity);
        }
        if (!nativeAgentRuntime) await observe(true);
        break;
      case 'delta':
        if (cancelRequested || !event.delta) return;
        aggregate += event.delta;
        callbacks.onDelta(aggregate);
        if (!nativeAgentRuntime) queueObserve();
        break;
      case 'confirmation': {
        if (!nativeAgentRuntime) {
          await fail('Native confirmation was received outside an Agent runtime.', false);
          return 'terminal';
        }
        const approved = callbacks.onConfirmation
          ? await callbacks.onConfirmation(event.confirmation)
          : false;
        const accepted = await invoke<boolean>('agent_runtime_confirm', {
          attemptId: identity.attemptId,
          confirmationToken: event.confirmation.confirmationToken,
          approved,
        });
        if (!accepted) throw new Error('Native Agent confirmation was no longer pending.');
        break;
      }
      case 'toolCalls': {
        const agentTaskId = (prepared as AgentCapablePrepared).agentTaskId;
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
        if (nativeAgentRuntime) {
          try {
            callbacks.onState(
              await callWorker('llm.generation.get', { generationId: identity.generationId }),
            );
            terminal = true;
          } finally {
            closing = false;
          }
          return 'terminal';
        }
        const params: LlmGenerationCompleteParams = {
          ...identity,
          content: aggregate,
          providerResponseId: event.providerResponseId,
          finishReason: event.finishReason,
          usage: event.usage,
        };
        try {
          if ((prepared as AgentCapablePrepared).agentTaskId) {
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
        if (nativeAgentRuntime) {
          const current = await callWorker('llm.generation.get', {
            generationId: identity.generationId,
          });
          callbacks.onState(
            ['complete', 'failed', 'cancelled'].includes(current.status)
              ? current
              : await callWorker('llm.generation.fail', {
                  ...identity,
                  content: aggregate,
                  error: event.error,
                  retryable: event.retryable,
                  usage: event.usage,
                }),
          );
          terminal = true;
          return 'terminal';
        }
        await fail(event.error, event.retryable, event.usage);
        return 'terminal';
      case 'cancelled':
        if (nativeAgentRuntime) {
          callbacks.onState(
            await callWorker('llm.generation.get', { generationId: identity.generationId }),
          );
          terminal = true;
          return 'terminal';
        }
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
      if (nativeAgentRuntime && ['complete', 'failed', 'cancelled'].includes(event.type)) {
        events = events.finally(() => resolveNativeRuntimeTerminal?.());
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
      if (piRuntime) {
        await callWorker('conversation.runtime.start', {
          ...identity,
          taskId: (prepared as AgentCapablePrepared).agentTaskId!,
          mode: 'short-drama',
          prompt: prepared.generation.userMessage.content,
        });
        const deadline = Date.now() + PI_POLL_TIMEOUT_MS;
        while (true) {
          if (Date.now() >= deadline) {
            await cancelOwnedRuntime();
            throw new Error('Pi runtime did not reach a terminal state before the timeout.');
          }
          await new Promise((resolve) => setTimeout(resolve, PI_POLL_INTERVAL_MS));
          const current = await callWorker('llm.generation.get', {
            generationId: identity.generationId,
          });
          callbacks.onState(current);
          if (!['prepared', 'streaming'].includes(current.status)) break;
        }
        terminal = true;
        return;
      }
      if (nativeAgentRuntime) {
        const channel = createInvocationChannel();
        try {
          await invoke<void>('agent_runtime_start', {
            request: identity,
            onEvent: channel,
          });
        } catch (startError) {
          const attached = await invoke<boolean>('agent_runtime_subscribe', {
            attemptId: identity.attemptId,
            onEvent: channel,
          });
          if (!attached) throw startError;
        }
        await nativeRuntimeTerminal;
        await events;
        return;
      }
      while (true) {
        providerInvocationCount += 1;
        if (providerInvocationCount > MAX_PROVIDER_INVOCATIONS) {
          await fail(
            `Provider exceeded the ${MAX_PROVIDER_INVOCATIONS}-invocation safety limit.`,
            true,
          );
          await cancelOwnedRuntime();
          break;
        }
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
      else {
        await cancelOwnedRuntime();
        await fail(error instanceof Error ? error.message : 'Native LLM stream failed.', true);
      }
    }
  })();

  return {
    identity,
    completion,
    async cancel() {
      if (terminal) return;
      cancelRequested = true;
      try {
        await cancelOwnedRuntime();
        if (isTauri() && !piRuntime) {
          await invoke<boolean>(nativeAgentRuntime ? 'agent_runtime_cancel' : 'llm_stream_cancel', {
            attemptId: identity.attemptId,
          });
        }
      } finally {
        // Persist cancellation from the caller as well as asking the runtime to
        // stop. Native Agent normally reports its own cancelled event, but that
        // event can be lost while a view is closing or switching scope. The
        // Worker operation is idempotent, so the runtime's eventual callback is
        // harmless and SQLite still reaches a terminal state immediately.
        try {
          await cancelWorker();
        } finally {
          resolveNativeRuntimeTerminal?.();
        }
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
