import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type {
  AgentToolConfirmationRequest,
  LlmGenerationCompleteParams,
  LlmGenerationFailParams,
  LlmGenerationIdentity,
  LlmGenerationInfo,
  LlmGenerationPrepareResult,
  LlmNativeStreamEvent,
  ConversationTaskMode,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
  MediaSubmissionConfirmationRequest,
  ConversationRuntimeLiveAction,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

export function coalesceVisibleDelta(accumulated: string, incoming: string): string | undefined {
  if (!incoming) return undefined;
  const leadingTrimmed = incoming.replace(/^(?:\r\n|\n|\r)+/, '');
  if (!accumulated) return leadingTrimmed || undefined;
  const prefix = prefixVisibleDelta(accumulated, incoming);
  if (prefix !== false) return prefix;
  if (!leadingTrimmed) return undefined;
  if (leadingTrimmed === incoming) return incoming;
  const trimmedPrefix = prefixVisibleDelta(accumulated, leadingTrimmed);
  if (trimmedPrefix !== false) return trimmedPrefix;
  if (isVisibleReplay(accumulated, leadingTrimmed)) return undefined;
  return incoming;
}

function prefixVisibleDelta(accumulated: string, incoming: string): string | undefined | false {
  if (incoming === accumulated || accumulated.startsWith(incoming)) return undefined;
  if (incoming.startsWith(accumulated)) {
    const suffix = incoming.slice(accumulated.length);
    return suffix || undefined;
  }
  return false;
}

function isVisibleReplay(accumulated: string, incoming: string): boolean {
  if (!incoming || accumulated === incoming) return true;
  if (!accumulated.endsWith(incoming)) return false;
  const prefix = accumulated.slice(0, accumulated.length - incoming.length);
  return prefix.length === 0 || prefix.endsWith('\n');
}

const FLUSH_INTERVAL_MS = 250;
const FLUSH_CHARACTER_THRESHOLD = 512;
const CHANNEL_DELIVERY_GRACE_MS = 1_000;
const PI_POLL_INTERVAL_MS = 300;
const PI_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

type InvocationBoundaryOutcome = 'terminal' | 'missing';
type AgentCapablePrepared = LlmGenerationPrepareResult & {
  agentTaskId?: string;
  runtimeMode?: ConversationTaskMode;
};

export interface LlmStreamCallbacks {
  onDelta(content: string): void;
  onState(state: LlmGenerationInfo): void;
  onLiveActions?(actions: ConversationRuntimeLiveAction[]): void;
  onConfirmation?(request: AgentToolConfirmationRequest): Promise<boolean>;
  onMediaSelection?(
    request: MediaModelSelectionRequest,
  ): Promise<MediaModelSelectionDecision | undefined>;
  onMediaSubmission?(request: MediaSubmissionConfirmationRequest): Promise<boolean>;
}

export interface LlmStreamRun {
  readonly identity: LlmGenerationIdentity;
  readonly completion: Promise<void>;
  cancel(): Promise<void>;
  detach(): void;
}

export function streamPreparedLlmGeneration(
  prepared: LlmGenerationPrepareResult,
  callbacks: LlmStreamCallbacks,
  options: { observeOnly?: boolean } = {},
): LlmStreamRun {
  const identity = prepared.stream;
  const callWorker = projectWorker({
    projectId: identity.projectId,
    projectSessionId: identity.projectSessionId,
  });
  // Prepared descriptors from older clients are also owned by the Worker.
  const piRuntime = Boolean((prepared as AgentCapablePrepared).agentTaskId);
  let aggregate = prepared.generation.assistantMessage.content;
  let streamVisible = '';
  let persisted = aggregate;
  let terminal = false;
  let detached = false;
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

  // Serialize pending observations so an older snapshot cannot overwrite a newer one.
  const enqueueObserve = (force = false) => {
    writes = writes.then(() => observe(force));
    return writes;
  };

  const queueObserve = () => {
    if (aggregate.length - persisted.length >= FLUSH_CHARACTER_THRESHOLD) {
      clearFlushTimer();
      void enqueueObserve();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void enqueueObserve();
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
      await enqueueObserve().catch(() => undefined);
      callbacks.onState(
        await callWorker('llm.generation.cancel', { generationId: identity.generationId }),
      );
      terminal = true;
    } finally {
      closing = false;
    }
  };

  const cancelOwnedRuntime = async () => {
    if (!piRuntime) return;
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
        streamVisible = '';
        await enqueueObserve(true);
        break;
      case 'delta':
        if (cancelRequested || !event.delta) return;
        {
          streamVisible += event.delta;
          const fragment = coalesceVisibleDelta(aggregate, streamVisible);
          if (!fragment) return;
          aggregate += fragment;
          callbacks.onDelta(aggregate);
        }
        queueObserve();
        break;
      case 'confirmation':
      case 'toolCalls':
        await fail(
          'Unexpected Agent event in a plain LLM stream. Agent tasks must run in the Worker.',
          false,
        );
        return 'terminal';
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
      const boundary = ['confirmation', 'toolCalls', 'complete', 'failed', 'cancelled'].includes(
        event.type,
      )
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
      if (piRuntime) {
        const runtimeMode = (prepared as AgentCapablePrepared).runtimeMode ?? 'document';
        if (!options.observeOnly)
          await callWorker('conversation.runtime.start', {
            ...identity,
            taskId: (prepared as AgentCapablePrepared).agentTaskId!,
            mode: runtimeMode,
            prompt: prepared.generation.userMessage.content,
          });
        const deadline = Date.now() + PI_POLL_TIMEOUT_MS;
        const handledConfirmations = new Set<string>();
        const handledMediaSelections = new Set<string>();
        const handledMediaSubmissions = new Set<string>();
        while (!detached) {
          if (Date.now() >= deadline) {
            throw new Error('Pi observation timed out; the task continues in the background.');
          }
          await new Promise((resolve) => setTimeout(resolve, PI_POLL_INTERVAL_MS));
          const runtimeState = await callWorker('conversation.runtime.get', {
            generationId: identity.generationId,
          });
          callbacks.onLiveActions?.(runtimeState.liveActions ?? []);
          if (
            runtimeState.confirmation &&
            !handledConfirmations.has(runtimeState.confirmation.confirmationToken)
          ) {
            handledConfirmations.add(runtimeState.confirmation.confirmationToken);
            const approved = callbacks.onConfirmation
              ? await callbacks.onConfirmation(runtimeState.confirmation)
              : false;
            if (detached || cancelRequested) return;
            const confirmed = await callWorker('conversation.runtime.confirm', {
              generationId: identity.generationId,
              confirmationToken: runtimeState.confirmation.confirmationToken,
              approved,
            });
            if (!confirmed.accepted) {
              throw new Error('Pi Agent confirmation was no longer pending.');
            }
          }
          if (
            runtimeState.mediaSelection &&
            !handledMediaSelections.has(runtimeState.mediaSelection.selectionToken)
          ) {
            handledMediaSelections.add(runtimeState.mediaSelection.selectionToken);
            const selection = callbacks.onMediaSelection
              ? await callbacks.onMediaSelection(runtimeState.mediaSelection)
              : undefined;
            if (detached || cancelRequested) return;
            const selected = await callWorker('conversation.runtime.selectMedia', {
              generationId: identity.generationId,
              selectionToken: runtimeState.mediaSelection.selectionToken,
              selection,
            });
            if (!selected.accepted) {
              throw new Error('Pi Agent media selection was no longer pending.');
            }
          }
          if (
            runtimeState.mediaSubmission &&
            !handledMediaSubmissions.has(runtimeState.mediaSubmission.confirmationToken)
          ) {
            handledMediaSubmissions.add(runtimeState.mediaSubmission.confirmationToken);
            const approved = callbacks.onMediaSubmission
              ? await callbacks.onMediaSubmission(runtimeState.mediaSubmission)
              : false;
            if (detached || cancelRequested) return;
            const confirmed = await callWorker('conversation.runtime.confirmMediaSubmission', {
              generationId: identity.generationId,
              jobId: runtimeState.mediaSubmission.jobId,
              confirmationToken: runtimeState.mediaSubmission.confirmationToken,
              approved,
            });
            if (!confirmed.accepted) {
              throw new Error('Pi Agent media submission confirmation was no longer pending.');
            }
          }
          const current = await callWorker('llm.generation.get', {
            generationId: identity.generationId,
          });
          callbacks.onState(current);
          if (!['prepared', 'streaming'].includes(current.status)) break;
        }
        terminal = true;
        return;
      }
      const boundary = prepareInvocationBoundary();
      await invoke<void>('llm_stream', { request: identity, onEvent: createInvocationChannel() });
      boundary.armDeliveryTimeout();
      await boundary.promise;
      await events;
      if (!terminal) {
        if (cancelRequested) await cancelWorker();
        else await fail('Native LLM stream ended without a terminal event.', true);
      }
    } catch (error) {
      if (piRuntime && !cancelRequested) throw error;
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
    detach() {
      detached = true;
    },
    async cancel() {
      if (terminal) return;
      cancelRequested = true;
      try {
        await cancelOwnedRuntime();
        if (isTauri() && !piRuntime) {
          await invoke<boolean>('llm_stream_cancel', {
            attemptId: identity.attemptId,
          });
        }
      } finally {
        // Persist cancellation if observation closes before a terminal update.
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
