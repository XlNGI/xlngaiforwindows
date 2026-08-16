export interface LlmProviderStatus {
  key: string;
  name: string;
  model: string;
  configured: boolean;
}

export interface LlmStreamRequest {
  systemInstruction: string;
  context: string;
  prompt: string;
  tools?: readonly LlmToolDefinition[];
  signal?: AbortSignal;
  onDelta(delta: string): void;
}

export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface LlmStreamResult {
  providerResponseId?: string;
  model: string;
  content: string;
  toolCalls: LlmToolCall[];
}

export interface LlmProvider {
  status(): LlmProviderStatus;
  stream(request: LlmStreamRequest): Promise<LlmStreamResult>;
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  totalTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      'NOT_CONFIGURED' | 'AUTHENTICATION' | 'RATE_LIMITED' | 'TIMEOUT' | 'REQUEST_FAILED',
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class OpenAIResponsesProvider implements LlmProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly totalTimeoutMs: number;
  private readonly firstByteTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = options.model ?? 'gpt-5.6-sol';
    this.fetcher = options.fetch ?? fetch;
    this.totalTimeoutMs = positiveTimeout(options.totalTimeoutMs, 120_000);
    this.firstByteTimeoutMs = positiveTimeout(options.firstByteTimeoutMs, 30_000);
    this.idleTimeoutMs = positiveTimeout(options.idleTimeoutMs, 30_000);
  }

  status(): LlmProviderStatus {
    return { key: 'openai', name: 'OpenAI', model: this.model, configured: Boolean(this.apiKey) };
  }

  async stream(request: LlmStreamRequest): Promise<LlmStreamResult> {
    if (!this.apiKey)
      throw new LlmProviderError('OPENAI_API_KEY is not configured.', 'NOT_CONFIGURED', false);
    if (request.signal?.aborted) throw abortError(request.signal);

    const startedAt = Date.now();
    const totalDeadline = startedAt + this.totalTimeoutMs;
    const firstByteDeadline = startedAt + this.firstByteTimeoutMs;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response;
    try {
      try {
        response = await waitForDeadline(
          this.fetcher(`${this.baseUrl}/responses`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: this.model,
              instructions: request.systemInstruction,
              input: `# 项目上下文\n\n${request.context}\n\n# 用户请求\n\n${request.prompt}`,
              reasoning: { effort: 'none' },
              store: false,
              stream: true,
              ...(request.tools?.length
                ? {
                    tools: request.tools.map((tool) => ({
                      type: 'function',
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    })),
                  }
                : {}),
            }),
            signal: controller.signal,
          }),
          {
            deadline: Math.min(totalDeadline, firstByteDeadline),
            signal: request.signal,
            timeoutMessage:
              totalDeadline <= firstByteDeadline
                ? 'OpenAI request exceeded the total timeout.'
                : 'OpenAI response did not return headers before the first-byte timeout.',
            onTimeout: (error) => controller.abort(error),
          },
        );
      } catch (error) {
        if (error instanceof LlmProviderError || request.signal?.aborted) throw error;
        throw new LlmProviderError('OpenAI request could not be started.', 'REQUEST_FAILED', true);
      }

      if (!response.ok) {
        const message = await waitForDeadline(safeErrorMessage(response), {
          deadline: totalDeadline,
          signal: request.signal,
          timeoutMessage: 'OpenAI error response exceeded the total timeout.',
          onTimeout: (error) => controller.abort(error),
        });
        if (response.status === 401 || response.status === 403) {
          throw new LlmProviderError(message, 'AUTHENTICATION', false);
        }
        if (response.status === 429) throw new LlmProviderError(message, 'RATE_LIMITED', true);
        throw new LlmProviderError(message, 'REQUEST_FAILED', response.status >= 500);
      }
      if (!response.body)
        throw new LlmProviderError('OpenAI returned an empty stream.', 'REQUEST_FAILED', true);

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let providerResponseId: string | undefined;
      const toolCalls = new Map<string, { id: string; name: string; argumentsJson: string }>();
      let completed = false;
      let receivedBytes = false;
      while (true) {
        const phaseDeadline = receivedBytes ? Date.now() + this.idleTimeoutMs : firstByteDeadline;
        const deadline = Math.min(totalDeadline, phaseDeadline);
        const { done, value } = await waitForDeadline(reader.read(), {
          deadline,
          signal: request.signal,
          timeoutMessage:
            totalDeadline <= phaseDeadline
              ? 'OpenAI stream exceeded the total timeout.'
              : receivedBytes
                ? 'OpenAI stream exceeded the idle timeout.'
                : 'OpenAI stream exceeded the first-byte timeout.',
          onTimeout: (error) => controller.abort(error),
        });
        if (value && value.byteLength > 0) receivedBytes = true;
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        if (done && buffer.trim()) {
          events.push(buffer);
          buffer = '';
        }
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (!data || data === '[DONE]') continue;
          const parsed = JSON.parse(data) as OpenAIStreamEvent;
          if (parsed.type === 'response.created') providerResponseId = parsed.response?.id;
          if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            content += parsed.delta;
            request.onDelta(parsed.delta);
          }
          if (
            parsed.type === 'response.output_item.added' &&
            parsed.item?.type === 'function_call'
          ) {
            const id = parsed.item.call_id ?? parsed.item.id;
            const itemKey = parsed.item.id ?? id;
            if (id && itemKey && parsed.item.name) {
              toolCalls.set(itemKey, {
                id,
                name: parsed.item.name,
                argumentsJson: parsed.item.arguments ?? '',
              });
            }
          }
          if (parsed.type === 'response.function_call_arguments.delta') {
            const id = parsed.item_id;
            const call = id ? toolCalls.get(id) : undefined;
            if (call) call.argumentsJson += parsed.delta ?? '';
          }
          if (parsed.type === 'response.function_call_arguments.done') {
            const id = parsed.item_id;
            const call = id ? toolCalls.get(id) : undefined;
            if (call && parsed.arguments !== undefined) call.argumentsJson = parsed.arguments;
          }
          if (parsed.type === 'error') {
            throw new LlmProviderError(
              parsed.message ?? parsed.error?.message ?? 'OpenAI stream failed.',
              'REQUEST_FAILED',
              true,
            );
          }
          if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
            throw new LlmProviderError(
              parsed.response?.error?.message ??
                `OpenAI stream ended with ${parsed.type.replace('response.', '')} status.`,
              'REQUEST_FAILED',
              true,
            );
          }
          if (parsed.type === 'response.completed') completed = true;
        }
        if (done) break;
      }
      if (!completed) {
        throw new LlmProviderError(
          'OpenAI stream ended before response.completed.',
          'REQUEST_FAILED',
          true,
        );
      }
      const completedToolCalls = [...toolCalls.values()].map((call) => ({
        id: call.id,
        name: call.name,
        argumentsJson: call.argumentsJson,
      }));
      return { providerResponseId, model: this.model, content, toolCalls: completedToolCalls };
    } catch (error) {
      if (reader) void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

interface OpenAIStreamEvent {
  type: string;
  delta?: string;
  message?: string;
  error?: { message?: string };
  response?: { id?: string; error?: { message?: string } };
  item_id?: string;
  arguments?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `OpenAI request failed (${response.status}).`;
  } catch {
    return `OpenAI request failed (${response.status}).`;
  }
}

interface DeadlineOptions {
  deadline: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  onTimeout(error: LlmProviderError): void;
}

function waitForDeadline<T>(promise: Promise<T>, options: DeadlineOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(abortError(options.signal)));
    const timer = setTimeout(
      () => {
        const error = new LlmProviderError(options.timeoutMessage, 'TIMEOUT', true);
        finish(() => reject(error));
        options.onTimeout(error);
      },
      Math.max(options.deadline - Date.now(), 0),
    );
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(asError(error))),
    );
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal?.reason === 'string' ? signal.reason : 'Aborted',
    'AbortError',
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
