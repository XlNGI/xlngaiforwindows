import { validateContextLimits } from './model-context-policy.js';
import {
  SIDECAR_ENVELOPE_MAX_BYTES,
  type HostError,
  type NativeProviderHostEvent,
  type HostMethod,
  type NativeProviderStreamStartParams,
  type SidecarEnvelope,
} from '@ai-video/contracts';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import { randomUUID, createHash } from 'node:crypto';

export interface JsonLineWritable {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export class SidecarEnvelopeSizeError extends Error {}

/** Serializes every JSONL write and waits for the underlying stream callback (including backpressure). */
export class JsonLineWriter {
  private tail = Promise.resolve();

  constructor(private readonly writable: JsonLineWritable) {}

  write(value: unknown): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(value)}\n`;
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (Buffer.byteLength(line, 'utf8') > envelopeLimit(value)) {
      return Promise.reject(
        new SidecarEnvelopeSizeError('Sidecar envelope exceeds the 2 MiB limit.'),
      );
    }
    const pending = this.tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          try {
            this.writable.write(line, (error) => (error ? reject(error) : resolve()));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

export interface NativeProviderTransport {
  send(envelope: Extract<SidecarEnvelope, { kind: 'host.request' }>): Promise<void>;
}

export interface NativeProviderStreamCallbacks {
  onEvent(event: NativeProviderHostEvent): void;
}

export interface NativeProviderStreamHandle {
  requestId: string;
  done: Promise<NativeProviderHostEvent>;
  cancel(): void;
}

export class NativeProviderRequestError extends Error {
  override readonly name = 'NativeProviderRequestError';

  constructor(readonly hostError: HostError) {
    super(hostError.message);
  }
}

interface PendingStream {
  params: NativeProviderStreamStartParams;
  callbacks: NativeProviderStreamCallbacks;
  expectedSequence: number;
  terminal: boolean;
  cancelSent: boolean;
  resolve: (event: NativeProviderHostEvent) => void;
}

const TERMINAL_TYPES = new Set<NativeProviderHostEvent['type']>([
  'complete',
  'failed',
  'cancelled',
]);
const HOST_ERROR_CODES = new Set<HostError['code']>([
  'INVALID_ENVELOPE',
  'MESSAGE_TOO_LARGE',
  'METHOD_NOT_FOUND',
  'INVALID_PARAMETERS',
  'PROVIDER_UNAVAILABLE',
  'SUBMISSION_UNKNOWN',
  'AUTHENTICATION_FAILED',
  'RATE_LIMITED',
  'PROVIDER_FAILED',
  'REQUEST_NOT_SENT',
  'INTERRUPTED',
  'CANCELLED',
  'STALE_SESSION',
  'TIMEOUT',
  'INTERNAL_ERROR',
]);
const SENSITIVE_KEYS = new Set(['secret', 'authorization', 'headers', 'apikey', 'signedurl']);

export class NativeProviderBridge {
  private readonly pending = new Map<string, PendingStream>();
  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextRequestOrdinal = 0;
  private closed = false;

  constructor(
    private readonly transport: NativeProviderTransport,
    private readonly createRequestId: () => string = () =>
      `host-${Date.now().toString(36)}-${(++this.nextRequestOrdinal).toString(36)}`,
  ) {}

  start(
    params: NativeProviderStreamStartParams,
    callbacks: NativeProviderStreamCallbacks,
    signal?: AbortSignal,
  ): NativeProviderStreamHandle {
    if (this.closed) throw this.closedRequestError();
    validateStartParams(params);
    const requestId = this.createRequestId();
    if (!requestId || this.pending.has(requestId)) {
      throw new Error('Native Provider request ID must be unique.');
    }
    let resolve!: (event: NativeProviderHostEvent) => void;
    const done = new Promise<NativeProviderHostEvent>((doneResolve) => {
      resolve = doneResolve;
    });
    const pending: PendingStream = {
      params,
      callbacks,
      expectedSequence: 0,
      terminal: false,
      cancelSent: false,
      resolve,
    };
    this.pending.set(requestId, pending);

    const envelope = {
      kind: 'host.request',
      requestId,
      method: 'provider.stream.start',
      params,
    } as const;
    assertEnvelopeSize(envelope);
    void this.transport.send(envelope).catch((error) => {
      this.failLocally(requestId, hostError('PROVIDER_UNAVAILABLE', error, true));
    });

    const cancel = (): void => this.cancel(requestId);
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      void done.finally(() => signal.removeEventListener('abort', cancel));
    }
    return { requestId, done, cancel };
  }

  /** Send a bounded one-shot request to the Native host and await its correlated response. */
  request<M extends HostMethod>(method: M, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closedRequestError());
    assertNoSensitiveData(params);
    const requestId = this.createRequestId();
    if (!requestId || this.pending.has(requestId) || this.pendingRequests.has(requestId)) {
      return Promise.reject(new Error('Native Provider request ID must be unique.'));
    }
    const envelope = { kind: 'host.request', requestId, method, params } as const;
    assertEnvelopeSize(envelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new NativeProviderRequestError(
            hostError('TIMEOUT', `Native Provider request timed out after ${timeoutMs} ms.`, true),
          ),
        );
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      void this.transport.send(envelope).catch((error) => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        pending.reject(
          new NativeProviderRequestError(hostError('PROVIDER_UNAVAILABLE', error, true)),
        );
      });
    });
  }

  /** Returns true only for a recognized host envelope; legacy Worker responses remain untouched. */
  handleEnvelope(value: unknown): boolean {
    if (!isRecord(value) || (value.kind !== 'host.event' && value.kind !== 'host.response')) {
      return false;
    }
    try {
      assertEnvelopeSize(value);
      assertNoSensitiveData(value);
      if (value.kind === 'host.response') {
        this.handleResponse(value);
      } else {
        this.handleEvent(value);
      }
    } catch (error) {
      const requestId = typeof value.requestId === 'string' ? value.requestId : undefined;
      if (requestId && this.pendingRequests.has(requestId)) {
        this.failOneShot(requestId, hostError('INVALID_ENVELOPE', error, false));
        return true;
      }
      if (!requestId || !this.pending.has(requestId)) throw error;
      this.cancel(requestId);
      this.failLocally(requestId, hostError('INVALID_ENVELOPE', error, false));
    }
    return true;
  }

  interruptAll(error: HostError): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(requestId);
      this.failLocally(requestId, error);
    }
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.reject(new NativeProviderRequestError(error));
    }
  }

  /** Shutdown is permanent for this transport; retry callbacks cannot submit new work. */
  close(error: HostError): void {
    if (this.closed) return;
    this.closed = true;
    this.interruptAll(error);
  }

  private closedRequestError(): NativeProviderRequestError {
    return new NativeProviderRequestError({
      code: 'REQUEST_NOT_SENT',
      message: 'Native host admission is closed; the request was not sent.',
      retryable: true,
    });
  }

  private handleResponse(value: Record<string, unknown>): void {
    assertExactKeys(
      value,
      value.ok === true
        ? ['kind', 'requestId', 'ok', 'result']
        : ['kind', 'requestId', 'ok', 'error'],
    );
    const requestId = requireString(value.requestId, 'host.response.requestId');
    const oneShot = this.pendingRequests.get(requestId);
    if (oneShot) {
      const parsedError = value.ok === false ? parseHostError(value.error) : undefined;
      if (value.ok !== true && value.ok !== false)
        throw new Error('host.response.ok must be boolean.');
      clearTimeout(oneShot.timer);
      this.pendingRequests.delete(requestId);
      if (parsedError) oneShot.reject(new NativeProviderRequestError(parsedError));
      else oneShot.resolve(value.result);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending || pending.terminal) return;
    if (value.ok === false) {
      this.failLocally(requestId, parseHostError(value.error));
    } else if (value.ok !== true) {
      throw new Error('host.response.ok must be boolean.');
    }
  }

  private failOneShot(requestId: string, error: HostError): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.reject(new NativeProviderRequestError(error));
  }

  private handleEvent(value: Record<string, unknown>): void {
    assertExactKeys(value, ['kind', 'requestId', 'sequence', 'event']);
    const requestId = requireString(value.requestId, 'host.event.requestId');
    const pending = this.pending.get(requestId);
    if (!pending || pending.terminal) return;
    const sequence = value.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      throw new Error('host.event.sequence must be a non-negative safe integer.');
    }
    if ((sequence as number) < pending.expectedSequence) return;
    if ((sequence as number) > pending.expectedSequence) {
      this.cancel(requestId);
      this.failLocally(
        requestId,
        hostError('INTERRUPTED', 'Native Provider event sequence has a gap.', true),
      );
      return;
    }
    const event = parseHostEvent(value.event);
    if (event.projectSessionId !== pending.params.projectSessionId) {
      this.cancel(requestId);
      this.failLocally(
        requestId,
        hostError(
          'STALE_SESSION',
          'Native Provider event belongs to a stale project session.',
          false,
        ),
      );
      return;
    }
    pending.expectedSequence += 1;
    pending.callbacks.onEvent(event);
    if (TERMINAL_TYPES.has(event.type)) this.finish(requestId, event);
  }

  private cancel(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.terminal || pending.cancelSent) return;
    pending.cancelSent = true;
    const envelope = {
      kind: 'host.request',
      requestId: `${requestId}:cancel`,
      method: 'provider.stream.cancel',
      params: {
        streamRequestId: requestId,
        projectSessionId: pending.params.projectSessionId,
      },
    } as const;
    void this.transport.send(envelope).catch(() => undefined);
  }

  private failLocally(requestId: string, error: HostError): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.terminal) return;
    const event: NativeProviderHostEvent = {
      type: error.code === 'CANCELLED' ? 'cancelled' : 'failed',
      projectSessionId: pending.params.projectSessionId,
      ...(error.code === 'CANCELLED' ? {} : { error }),
    } as NativeProviderHostEvent;
    pending.callbacks.onEvent(event);
    this.finish(requestId, event);
  }

  private finish(requestId: string, event: NativeProviderHostEvent): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.terminal) return;
    pending.terminal = true;
    this.pending.delete(requestId);
    pending.resolve(event);
  }
}

export type NativeProviderParamsResolver = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
) => NativeProviderStreamStartParams | Promise<NativeProviderStreamStartParams>;

/** Adapts Native host events to Pi's streamFunction contract without ever throwing to the Agent loop. */
export function createPiStreamFunction(
  bridge: NativeProviderBridge,
  resolveParams: NativeProviderParamsResolver,
  observe?: (requestId: string, stage: string, metadata: Record<string, unknown>) => void,
  onUsage?: (
    requestId: string,
    usage: Extract<NativeProviderHostEvent, { type: 'usage' }>['usage'],
  ) => void,
  beforeRetry?: () => void,
  recoverContext?: () => boolean,
): StreamFunction {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(model);
    const toolArgumentOutputs = new Map<string, { name: string; argumentsJson: string }>();
    const contextRejected = new Set<string>();
    stream.push({ type: 'start', partial: cloneMessage(message) });
    const startAttempt = (retryAttempt: number): void => {
      const requestId = randomUUID();
      const retryMetadata = { retryAttempt };
      let unchangedContext = false;
      const cancelled = (): boolean => {
        if (!options?.signal?.aborted) return false;
        observe?.(requestId, 'cancelled', retryMetadata);
        finishPiError(stream, message, 'aborted', 'Native Provider request was cancelled.');
        return true;
      };
      const dispatch = () =>
        Promise.resolve()
          .then(() => resolveParams(model, context, options))
          .then((params) => {
            if (cancelled()) return;
            const inputHash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
            if (contextRejected.has(inputHash)) {
              unchangedContext = true;
              throw new Error(
                'CONTEXT_BUDGET_EXCEEDED: Context recovery produced the same rejected request. Original task data and saved results are preserved.',
              );
            }
            observe?.(requestId, 'dispatching', {
              ...retryMetadata,
              inputHash,
              inputBytes: Buffer.byteLength(JSON.stringify(params)),
              toolCount: params.tools?.length ?? 0,
              inferenceSettings: params.inferenceSettings ?? {
                reasoning: 'provider_default',
                output: 'provider_default',
              },
            });
            let terminalObserved = false;
            let receivedOutput = false;
            bridge.start(
              params,
              {
                onEvent: (event) => {
                  if (terminalObserved) return;
                  // A retry replaces only a rejected model request. Never replay a
                  // response after text, reasoning, tool arguments or usage arrived.
                  if (
                    [
                      'text_delta',
                      'thinking_delta',
                      'tool_call_start',
                      'tool_call_delta',
                      'tool_call_end',
                      'usage',
                    ].includes(event.type)
                  )
                    receivedOutput = true;
                  if (event.type === 'request_progress' && event.stage === 'tool_arguments')
                    receivedOutput = true;
                  if (
                    event.type === 'failed' &&
                    !receivedOutput &&
                    retryAttempt < 2 &&
                    !options?.signal?.aborted &&
                    event.error.code === 'PROVIDER_FAILED' &&
                    event.error.retryable &&
                    // Gateways also use 520/524/529. Honor the native retryable
                    // classification across HTTP server errors, under the same
                    // output fence and retry limit as ordinary 500/502 failures.
                    (((event.error.providerStatus ?? 0) >= 500 &&
                      (event.error.providerStatus ?? 0) <= 599) ||
                      (event.error.providerStatus == null &&
                        ['WINHTTP_RESPONSE_HEADERS', 'WINHTTP_REQUEST_SEND'].includes(
                          event.error.providerErrorCode ?? '',
                        )))
                  ) {
                    terminalObserved = true;
                    observe?.(requestId, 'failed', {
                      ...retryMetadata,
                      errorCode: event.error.code,
                      failureOrigin: 'provider',
                      providerStatus: event.error.providerStatus,
                      providerErrorCode: event.error.providerErrorCode,
                      providerErrorMessage: sanitizeTelemetryError(event.error.message),
                    });
                    startAttempt(retryAttempt + 1);
                    return;
                  }
                  if (
                    event.type === 'failed' &&
                    !receivedOutput &&
                    retryAttempt < 2 &&
                    !options?.signal?.aborted &&
                    isContextLimitFailure(event.error) &&
                    recoverContext?.()
                  ) {
                    terminalObserved = true;
                    contextRejected.add(inputHash);
                    observe?.(requestId, 'failed', {
                      ...retryMetadata,
                      errorCode: 'CONTEXT_BUDGET_EXCEEDED',
                      failureOrigin:
                        event.error.providerErrorCode === 'CONTEXT_BUDGET_EXCEEDED'
                          ? 'local_context'
                          : 'provider',
                    });
                    startAttempt(retryAttempt + 1);
                    return;
                  }
                  if (event.type === 'usage') onUsage?.(requestId, event.usage);
                  applyPiEvent(stream, message, event, toolArgumentOutputs);
                  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
                    terminalObserved = true;
                    observe?.(
                      requestId,
                      message.stopReason === 'aborted' ? 'cancelled' : 'failed',
                      {
                        errorCode:
                          event.type === 'failed' ? event.error.code : 'INVALID_PROVIDER_RESPONSE',
                        failureOrigin:
                          event.type === 'failed' &&
                          event.error.providerErrorCode === 'CONTEXT_BUDGET_EXCEEDED'
                            ? 'local_context'
                            : event.type === 'failed' && event.error.code === 'PROVIDER_FAILED'
                              ? 'provider'
                              : 'bridge',
                        ...(event.type === 'failed'
                          ? {
                              providerStatus: event.error.providerStatus,
                              providerErrorCode: event.error.providerErrorCode,
                              providerErrorMessage: sanitizeTelemetryError(event.error.message),
                            }
                          : {}),
                      },
                    );
                    return;
                  }
                  if (event.type === 'request_progress')
                    observe?.(requestId, event.stage, {
                      argumentBytes: event.argumentBytes,
                      toolName: event.toolName,
                      receivedBytes: event.receivedBytes,
                      requestBodyHash: event.requestBodyHash,
                      requestBodyBytes: event.requestBodyBytes,
                      wireContext: event.wireContext,
                    });
                  else if (event.type === 'text_delta' || event.type === 'thinking_delta')
                    observe?.(
                      requestId,
                      event.type === 'text_delta' ? 'visible_text' : 'thinking',
                      {},
                    );
                  else if (['complete', 'failed', 'cancelled'].includes(event.type))
                    observe?.(
                      requestId,
                      event.type,
                      event.type === 'complete'
                        ? { finishReason: event.finishReason }
                        : event.type === 'failed'
                          ? {
                              errorCode: event.error.code,
                              providerStatus: event.error.providerStatus,
                              providerErrorCode: event.error.providerErrorCode,
                              providerErrorMessage: sanitizeTelemetryError(event.error.message),
                            }
                          : {},
                    );
                  if (event.type === 'complete') terminalObserved = true;
                },
              },
              options?.signal,
            );
          });
      const run = async () => {
        observe?.(requestId, 'preparing', retryMetadata);
        if (retryAttempt > 0) {
          const delayMs = retryAttempt * 1000;
          observe?.(requestId, 'retry_wait', { ...retryMetadata, delayMs });
          await waitForProviderRetry(delayMs, options?.signal);
          if (cancelled()) return;
          // Re-admit every HTTP request through the task budget and session fence.
          beforeRetry?.();
        }
        if (cancelled()) return;
        await dispatch();
      };
      void run().catch((error) => {
        const aborted = options?.signal?.aborted;
        const localContext = /^(CONTEXT_BUDGET_EXCEEDED|AGENT_REPEATED_READ_STALLED)(?::|$)/.exec(
          errorMessage(error),
        )?.[1];
        try {
          observe?.(requestId, aborted ? 'cancelled' : 'failed', {
            ...retryMetadata,
            errorCode: localContext ?? 'BRIDGE_FAILED',
            failureOrigin: localContext ? 'local_context' : 'bridge',
          });
        } catch {
          // A closed project can reject accounting too. Always settle Pi;
          // the dispatch failed and must not leave the Agent waiting forever.
        }
        if (
          !aborted &&
          !unchangedContext &&
          localContext === 'CONTEXT_BUDGET_EXCEEDED' &&
          retryAttempt < 2 &&
          recoverContext?.()
        ) {
          startAttempt(retryAttempt + 1);
          return;
        }
        finishPiError(stream, message, aborted ? 'aborted' : 'error', errorMessage(error));
      });
    };
    startAttempt(0);
    return stream;
  };
}

function waitForProviderRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });
}

function applyPiEvent(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  event: NativeProviderHostEvent,
  toolArgumentOutputs: Map<string, { name: string; argumentsJson: string }>,
): void {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
  switch (event.type) {
    case 'request_progress':
      return;
    case 'started':
      return;
    case 'text_delta': {
      const index = ensureTextContent(stream, message);
      const content = message.content[index]!;
      if (content.type !== 'text') return;
      content.text += event.delta;
      stream.push({
        type: 'text_delta',
        contentIndex: index,
        delta: event.delta,
        partial: cloneMessage(message),
      });
      return;
    }
    case 'thinking_delta': {
      const index = ensureThinkingContent(stream, message);
      const content = message.content[index]!;
      if (content.type !== 'thinking') return;
      content.thinking += event.delta;
      stream.push({
        type: 'thinking_delta',
        contentIndex: index,
        delta: event.delta,
        partial: cloneMessage(message),
      });
      return;
    }
    case 'tool_call_start': {
      toolArgumentOutputs.set(event.callId, { name: event.name, argumentsJson: '' });
      const call: ToolCall = {
        type: 'toolCall',
        id: event.callId,
        name: event.name,
        arguments: {},
      };
      message.content.push(call);
      stream.push({
        type: 'toolcall_start',
        contentIndex: message.content.length - 1,
        partial: cloneMessage(message),
      });
      return;
    }
    case 'tool_call_delta': {
      const output = toolArgumentOutputs.get(event.callId);
      if (output) output.argumentsJson += event.delta;
      const index = findToolCall(message, event.callId);
      if (index >= 0)
        stream.push({
          type: 'toolcall_delta',
          contentIndex: index,
          delta: event.delta,
          partial: cloneMessage(message),
        });
      return;
    }
    case 'tool_call_end': {
      let args: Record<string, unknown>;
      try {
        args = parseArguments(event.call.argumentsJson);
      } catch {
        const failureFingerprint = createHash('sha256')
          .update(event.call.name, 'utf8')
          .update('\0')
          .update(event.call.argumentsJson, 'utf8')
          .digest('hex');
        finishPiError(
          stream,
          message,
          'error',
          `INVALID_TOOL_ARGUMENTS: ${event.call.name.slice(0, 128)} returned invalid object JSON (${Buffer.byteLength(event.call.argumentsJson, 'utf8')} bytes). No tool was executed. Retry with smaller staged submissions. failureFingerprint=${failureFingerprint}`,
        );
        return;
      }
      let index = findToolCall(message, event.call.id);
      const call: ToolCall = {
        type: 'toolCall',
        id: event.call.id,
        name: event.call.name,
        arguments: args,
      };
      toolArgumentOutputs.set(event.call.id, {
        name: event.call.name,
        argumentsJson: event.call.argumentsJson,
      });
      if (index < 0) {
        message.content.push(call);
        index = message.content.length - 1;
        stream.push({
          type: 'toolcall_start',
          contentIndex: index,
          partial: cloneMessage(message),
        });
      } else {
        message.content[index] = call;
      }
      stream.push({
        type: 'toolcall_end',
        contentIndex: index,
        toolCall: call,
        partial: cloneMessage(message),
      });
      return;
    }
    case 'usage':
      message.usage = toPiUsage(event.usage);
      return;
    case 'complete': {
      closeOpenContent(stream, message);
      message.responseId = event.providerResponseId;
      message.rawStopReason = event.finishReason;
      if (
        ['length', 'max_tokens', 'max_output_tokens', 'content_filter', 'incomplete'].includes(
          event.finishReason ?? '',
        )
      ) {
        const output = {
          text: message.content
            .filter((content) => content.type === 'text')
            .map((content) => content.text),
          tools: Array.from(toolArgumentOutputs.values(), ({ name, argumentsJson }) => ({
            name,
            argumentsJson,
          })),
        };
        const failureFingerprint = createHash('sha256')
          .update(event.finishReason ?? '')
          .update('\0')
          .update(JSON.stringify(output))
          .digest('hex');
        finishPiError(
          stream,
          message,
          'error',
          `INCOMPLETE_TOOL_OUTPUT: finishReason=${event.finishReason}. No tool was executed; use smaller staged submissions. failureFingerprint=${failureFingerprint}`,
        );
        return;
      }
      message.stopReason = message.content.some((content) => content.type === 'toolCall')
        ? 'toolUse'
        : event.finishReason === 'length'
          ? 'length'
          : 'stop';
      stream.push({ type: 'done', reason: message.stopReason, message: cloneMessage(message) });
      return;
    }
    case 'failed':
      finishPiError(stream, message, 'error', event.error.message);
      return;
    case 'cancelled':
      finishPiError(stream, message, 'aborted', 'Native Provider request was cancelled.');
  }
}

function createAssistantMessage(model: Model<string>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toPiUsage(usage: Extract<NativeProviderHostEvent, { type: 'usage' }>['usage']): Usage {
  const cost = Number(usage.providerReportedCost?.amount ?? 0);
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cachedInputTokens ?? 0,
    cacheWrite: 0,
    reasoning: usage.reasoningTokens,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Number.isFinite(cost) ? cost : 0,
    },
  };
}

function ensureTextContent(stream: AssistantMessageEventStream, message: AssistantMessage): number {
  const last = message.content.at(-1);
  if (last?.type === 'text') return message.content.length - 1;
  message.content.push({ type: 'text', text: '' });
  const index = message.content.length - 1;
  stream.push({ type: 'text_start', contentIndex: index, partial: cloneMessage(message) });
  return index;
}

function ensureThinkingContent(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
): number {
  const last = message.content.at(-1);
  if (last?.type === 'thinking') return message.content.length - 1;
  message.content.push({ type: 'thinking', thinking: '' });
  const index = message.content.length - 1;
  stream.push({ type: 'thinking_start', contentIndex: index, partial: cloneMessage(message) });
  return index;
}

function closeOpenContent(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  message.content.forEach((content, index) => {
    if (content.type === 'text')
      stream.push({
        type: 'text_end',
        contentIndex: index,
        content: content.text,
        partial: cloneMessage(message),
      });
    if (content.type === 'thinking')
      stream.push({
        type: 'thinking_end',
        contentIndex: index,
        content: content.thinking,
        partial: cloneMessage(message),
      });
  });
}

function finishPiError(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  reason: 'error' | 'aborted',
  error: string,
): void {
  closeOpenContent(stream, message);
  message.stopReason = reason;
  message.errorMessage = error;
  stream.push({ type: 'error', reason, error: cloneMessage(message) });
}

function findToolCall(message: AssistantMessage, callId: string): number {
  return message.content.findIndex(
    (content) => content.type === 'toolCall' && content.id === callId,
  );
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Tool arguments must be an object.');
  return parsed;
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return structuredClone(message);
}

function validateStartParams(params: NativeProviderStreamStartParams): void {
  assertNoSensitiveData(params);
  assertExactKeys(params as unknown as Record<string, unknown>, [
    'generationId',
    'inferenceSettings',
    'modelCapabilities',
    'contextTurns',
    'attemptId',
    'projectId',
    'projectSessionId',
    'conversationId',
    'providerProfileId',
    'modelId',
    'remoteModelId',
    'protocol',
    'baseUrl',
    'systemInstruction',
    'context',
    'prompt',
    'attachments',
    'tools',
    'continuation',
  ]);
  if (params.contextTurns) {
    if (params.continuation)
      throw new Error('Cannot combine rebuilt context turns and provider continuation.');
    // ContextManager selects history using the model budget. The transport
    // validates its shape and pairing; turn count is not a model limit.
    if (!Array.isArray(params.contextTurns)) throw new Error('Invalid context turns.');
    const seen = new Set<string>();
    for (const turn of params.contextTurns) {
      assertExactKeys(turn as unknown as Record<string, unknown>, [
        'content',
        'calls',
        'outputs',
        'userMessages',
      ]);
      if (
        !Array.isArray(turn.calls) ||
        !Array.isArray(turn.outputs) ||
        turn.calls.length !== turn.outputs.length
      )
        throw new Error('Unpaired context tool outputs.');
      for (const call of turn.calls) {
        assertExactKeys(call, ['id', 'name', 'argumentsJson']);
        if (!call.id || !call.name || seen.has(call.id)) throw new Error('Invalid context call.');
        seen.add(call.id);
        JSON.parse(call.argumentsJson);
      }
      const outputIds = new Set<string>();
      for (const output of turn.outputs) {
        assertExactKeys(output as unknown as Record<string, unknown>, ['callId', 'output']);
        if (
          typeof output.output !== 'string' ||
          outputIds.has(output.callId) ||
          !turn.calls.some((call) => call.id === output.callId)
        )
          throw new Error('Invalid context output.');
        outputIds.add(output.callId);
      }
    }
  }
  if (params.modelCapabilities) {
    validateContextLimits(params.modelCapabilities);
    if (params.modelCapabilities.modelId !== params.modelId)
      throw new Error('Model capability identity mismatch.');
  }
  if (params.inferenceSettings) {
    const settings = params.inferenceSettings;
    assertExactKeys(settings as unknown as Record<string, unknown>, [
      'maxOutputTokens',
      'outputTokenParameter',
      'reasoning',
    ]);
    if (
      !Number.isSafeInteger(settings.maxOutputTokens) ||
      settings.maxOutputTokens < 1 ||
      settings.maxOutputTokens > 0xffffffff ||
      settings.reasoning !== 'provider_default' ||
      (params.protocol === 'openai-responses'
        ? settings.outputTokenParameter !== 'max_output_tokens'
        : !['max_tokens', 'max_completion_tokens'].includes(settings.outputTokenParameter))
    )
      throw new Error('Unsupported inference settings for this protocol.');
  }
  for (const key of [
    'generationId',
    'attemptId',
    'projectId',
    'projectSessionId',
    'conversationId',
    'providerProfileId',
    'modelId',
    'remoteModelId',
    'baseUrl',
  ] as const) {
    requireString(params[key], `provider.stream.start.${key}`);
  }
  if (params.protocol !== 'openai-responses' && params.protocol !== 'openai-chat-completions') {
    throw new Error('provider.stream.start.protocol is invalid.');
  }
  assertEnvelopeSize({
    kind: 'host.request',
    requestId: 'size-check',
    method: 'provider.stream.start',
    params,
  });
}

function parseHostEvent(value: unknown): NativeProviderHostEvent {
  if (!isRecord(value)) throw new Error('host.event.event must be an object.');
  const type = requireString(
    value.type,
    'host.event.event.type',
  ) as NativeProviderHostEvent['type'];
  const common = ['type', 'projectSessionId'];
  requireString(value.projectSessionId, 'host.event.event.projectSessionId');
  switch (type) {
    case 'request_progress':
      assertExactKeys(value, [
        ...common,
        'stage',
        'argumentBytes',
        'toolName',
        'receivedBytes',
        'requestBodyHash',
        'requestBodyBytes',
        'wireContext',
      ]);
      if (
        ![
          'native_queued',
          'admitted',
          'sent',
          'headers',
          'first_byte',
          'receiving',
          'tool_arguments',
        ].includes(String(value.stage))
      )
        throw new Error('Unknown native request stage.');
      if (value.wireContext !== undefined) {
        if (!isRecord(value.wireContext)) throw new Error('Invalid wire meter.');
        const wire = value.wireContext;
        for (const field of [
          'estimatedInputTokens',
          'requestBodyBytes',
          'systemTokens',
          'toolSchemaTokens',
          'messageTokens',
          'imageTokens',
          'reservedOutputTokens',
        ])
          if (!Number.isSafeInteger(wire[field]) || Number(wire[field]) < 0)
            throw new Error('Invalid wire meter count.');
        for (const field of ['meter', 'protocol', 'capabilitySource'])
          if (typeof wire[field] !== 'string') throw new Error('Invalid wire meter provenance.');
        if (
          wire.requestedOutputTokens !== undefined &&
          (!Number.isSafeInteger(wire.requestedOutputTokens) ||
            Number(wire.requestedOutputTokens) < Number(wire.reservedOutputTokens))
        )
          throw new Error('Invalid requested output allowance.');
      }
      if (
        value.requestBodyHash !== undefined &&
        (typeof value.requestBodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestBodyHash))
      )
        throw new Error('Invalid request body hash.');
      for (const field of ['argumentBytes', 'receivedBytes', 'requestBodyBytes'])
        if (
          value[field] !== undefined &&
          (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)
        )
          throw new Error('Invalid progress byte count.');
      if (
        value.toolName !== undefined &&
        (typeof value.toolName !== 'string' || value.toolName.length > 256)
      )
        throw new Error('Invalid progress tool name.');
      break;
    case 'started':
    case 'cancelled':
      assertExactKeys(value, common);
      break;
    case 'text_delta':
    case 'thinking_delta':
      assertExactKeys(value, [...common, 'delta']);
      requireString(value.delta, `${type}.delta`, true);
      break;
    case 'tool_call_start':
      assertExactKeys(value, [...common, 'callId', 'name']);
      requireString(value.callId, 'tool_call_start.callId');
      requireString(value.name, 'tool_call_start.name');
      break;
    case 'tool_call_delta':
      assertExactKeys(value, [...common, 'callId', 'delta']);
      requireString(value.callId, 'tool_call_delta.callId');
      requireString(value.delta, 'tool_call_delta.delta', true);
      break;
    case 'tool_call_end':
      assertExactKeys(value, [...common, 'call']);
      if (!isRecord(value.call)) throw new Error('tool_call_end.call must be an object.');
      assertExactKeys(value.call, ['id', 'name', 'argumentsJson']);
      requireString(value.call.id, 'tool_call_end.call.id');
      requireString(value.call.name, 'tool_call_end.call.name');
      requireString(value.call.argumentsJson, 'tool_call_end.call.argumentsJson', true);
      break;
    case 'usage':
      assertExactKeys(value, [...common, 'usage']);
      if (!isRecord(value.usage)) throw new Error('usage.usage must be an object.');
      break;
    case 'complete':
      assertExactKeys(value, [...common, 'providerResponseId', 'finishReason']);
      break;
    case 'failed':
      assertExactKeys(value, [...common, 'error']);
      parseHostError(value.error);
      break;
    default:
      throw new Error('Unknown Native Provider event type.');
  }
  return value as unknown as NativeProviderHostEvent;
}

function parseHostError(value: unknown): HostError {
  if (!isRecord(value)) throw new Error('Host error must be an object.');
  assertExactKeys(value, [
    'code',
    'message',
    'retryable',
    'providerErrorCode',
    'providerTaskId',
    'providerStatus',
  ]);
  const code = requireString(value.code, 'host.error.code') as HostError['code'];
  if (!HOST_ERROR_CODES.has(code)) throw new Error('host.error.code is invalid.');
  const message = requireString(value.message, 'host.error.message');
  if (typeof value.retryable !== 'boolean')
    throw new Error('host.error.retryable must be boolean.');
  for (const key of ['providerErrorCode', 'providerTaskId'] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value[key]))
    )
      throw new Error('Host error provider identity is invalid.');
  }
  if (
    value.providerStatus !== undefined &&
    (typeof value.providerStatus !== 'number' ||
      !Number.isInteger(value.providerStatus) ||
      value.providerStatus < 100 ||
      value.providerStatus > 599)
  )
    throw new Error('Host provider status is invalid.');
  return {
    code,
    message,
    retryable: value.retryable,
    ...(value.providerStatus !== undefined ? { providerStatus: value.providerStatus } : {}),
    ...(value.providerErrorCode ? { providerErrorCode: value.providerErrorCode as string } : {}),
    ...(value.providerTaskId ? { providerTaskId: value.providerTaskId as string } : {}),
  };
}

function hostError(code: HostError['code'], error: unknown, retryable: boolean): HostError {
  return { code, message: errorMessage(error), retryable };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeTelemetryError(message: string): string {
  return message
    .replace(/\b(Bearer\s+)\S+/giu, '$1[redacted]')
    .replace(
      /\b(authorization|x-api-key|api[_-]?key|access_token|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[redacted]',
    )
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, '$1?[query redacted]')
    .slice(0, 500);
}

function assertEnvelopeSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') + 1 > envelopeLimit(value)) {
    throw new Error('Sidecar envelope exceeds the 2 MiB limit.');
  }
}

function assertNoSensitiveData(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (/^https?:\/\/[^\s?]+\?[^\s]*(?:x-amz-signature|signature|sig|token)=/iu.test(value)) {
      throw new Error('Signed URLs cannot cross the Native Provider boundary.');
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoSensitiveData(item, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/giu, '').toLowerCase();
    if (SENSITIVE_KEYS.has(normalized) || normalized.startsWith('authorization')) {
      throw new Error(`Sensitive field '${key}' cannot cross the Native Provider boundary.`);
    }
    assertNoSensitiveData(item, seen);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) throw new Error(`Unknown envelope field: ${unknown}`);
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isContextLimitFailure(error: HostError): boolean {
  return (
    [
      'CONTEXT_BUDGET_EXCEEDED',
      'context_length_exceeded',
      'context_window_exceeded',
      'max_context_length',
      'input_tokens_exceeded',
    ].includes(error.providerErrorCode ?? '') &&
    ![402, 403, 429, 500, 502, 503, 504].includes(error.providerStatus ?? 0)
  );
}

function envelopeLimit(value: unknown): number {
  const v = value as { kind?: string; method?: string } | undefined;
  return v?.kind === 'host.request' && v.method === 'provider.stream.start'
    ? 64 * 1024 * 1024
    : SIDECAR_ENVELOPE_MAX_BYTES;
}
