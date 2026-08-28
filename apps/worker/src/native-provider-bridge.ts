import {
  SIDECAR_ENVELOPE_MAX_BYTES,
  type HostError,
  type NativeProviderHostEvent,
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

export interface JsonLineWritable {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

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
    if (Buffer.byteLength(line, 'utf8') > SIDECAR_ENVELOPE_MAX_BYTES) {
      return Promise.reject(new Error('Sidecar envelope exceeds the 2 MiB limit.'));
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
const SENSITIVE_KEYS = new Set(['secret', 'authorization', 'headers', 'apikey', 'signedurl']);

export class NativeProviderBridge {
  private readonly pending = new Map<string, PendingStream>();
  private nextRequestOrdinal = 0;

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
  }

  private handleResponse(value: Record<string, unknown>): void {
    assertExactKeys(
      value,
      value.ok === true
        ? ['kind', 'requestId', 'ok', 'result']
        : ['kind', 'requestId', 'ok', 'error'],
    );
    const requestId = requireString(value.requestId, 'host.response.requestId');
    const pending = this.pending.get(requestId);
    if (!pending || pending.terminal) return;
    if (value.ok === false) {
      this.failLocally(requestId, parseHostError(value.error));
    } else if (value.ok !== true) {
      throw new Error('host.response.ok must be boolean.');
    }
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
): StreamFunction {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(model);
    stream.push({ type: 'start', partial: cloneMessage(message) });
    void Promise.resolve()
      .then(() => resolveParams(model, context, options))
      .then((params) => {
        bridge.start(
          params,
          { onEvent: (event) => applyPiEvent(stream, message, event) },
          options?.signal,
        );
      })
      .catch((error) => finishPiError(stream, message, 'error', errorMessage(error)));
    return stream;
  };
}

function applyPiEvent(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  event: NativeProviderHostEvent,
): void {
  switch (event.type) {
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
      let index = findToolCall(message, event.call.id);
      const call: ToolCall = {
        type: 'toolCall',
        id: event.call.id,
        name: event.call.name,
        arguments: parseArguments(event.call.argumentsJson),
      };
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
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return structuredClone(message);
}

function validateStartParams(params: NativeProviderStreamStartParams): void {
  assertNoSensitiveData(params);
  assertExactKeys(params as unknown as Record<string, unknown>, [
    'generationId',
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
    'tools',
    'continuation',
  ]);
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
  assertExactKeys(value, ['code', 'message', 'retryable']);
  const code = requireString(value.code, 'host.error.code') as HostError['code'];
  const message = requireString(value.message, 'host.error.message');
  if (typeof value.retryable !== 'boolean')
    throw new Error('host.error.retryable must be boolean.');
  return { code, message, retryable: value.retryable };
}

function hostError(code: HostError['code'], error: unknown, retryable: boolean): HostError {
  return { code, message: errorMessage(error), retryable };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertEnvelopeSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') + 1 > SIDECAR_ENVELOPE_MAX_BYTES) {
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
