import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmProviderError, OpenAIResponsesProvider } from './index.js';
import { NetworkAdmission } from './network-admission.js';

async function expectTimeout(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    throw new Error('Expected provider request to time out.');
  } catch (error) {
    expect(error).toBeInstanceOf(LlmProviderError);
    if (!(error instanceof LlmProviderError)) throw error;
    expect(error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(error.message).toContain(message);
  }
}

describe('OpenAIResponsesProvider', () => {
  it('requires configuration without exposing a key', async () => {
    const provider = new OpenAIResponsesProvider();
    expect(provider.status()).toMatchObject({ configured: false, model: '' });
    await expect(
      provider.stream({ systemInstruction: '', context: '', prompt: '', onDelta() {} }),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });

  it('parses Responses API text deltas', async () => {
    const payload = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}',
      'event: response.completed\ndata: {"type":"response.completed"}',
      '',
    ].join('\n\n');
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(payload, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    const deltas: string[] = [];
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: fetcher,
    });
    const result = await provider.stream({
      systemInstruction: 'director',
      context: 'context',
      prompt: 'prompt',
      onDelta: (delta) => deltas.push(delta),
    });
    expect(result).toMatchObject({ providerResponseId: 'resp_1', content: '你好' });
    expect(deltas).toEqual(['你好']);
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body === 'string' ? body : '').not.toContain('test');
  });

  it('parses function call items and argument deltas without executing them', async () => {
    const payload = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_tool"}}',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"document.create_draft","arguments":""}}',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"title\\":\\"Outline\\"}"}',
      'event: response.completed\ndata: {"type":"response.completed"}',
      '',
    ].join('\n\n');
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () =>
        Promise.resolve(
          new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        ),
    });
    await expect(
      provider.stream({
        systemInstruction: '',
        context: '',
        prompt: '',
        tools: [{ name: 'document.create_draft', parameters: { type: 'object' } }],
        onDelta() {},
      }),
    ).resolves.toMatchObject({
      toolCalls: [
        { id: 'call_1', name: 'document.create_draft', argumentsJson: '{"title":"Outline"}' },
      ],
    });
  });

  it.each([
    [
      'response.failed',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Provider failed"}}}',
      'Provider failed',
    ],
    [
      'response.incomplete',
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{}}',
      'incomplete',
    ],
  ])('rejects the %s terminal event', async (_name, payload, message) => {
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () =>
        Promise.resolve(
          new Response(payload, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    });

    await expect(
      provider.stream({ systemInstruction: '', context: '', prompt: '', onDelta() {} }),
    ).rejects.toThrow(message);
  });

  it('rejects a stream that ends before response.completed', async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () =>
        Promise.resolve(
          new Response(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    });

    await expect(
      provider.stream({ systemInstruction: '', context: '', prompt: '', onDelta() {} }),
    ).rejects.toThrow('before response.completed');
  });

  it('times out when the provider never returns response headers', async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () => new Promise<Response>(() => undefined),
      firstByteTimeoutMs: 20,
      totalTimeoutMs: 100,
    });

    await expect(
      provider.stream({ systemInstruction: '', context: '', prompt: '', onDelta() {} }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
  });

  it('times out when the response stream never produces its first byte', async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () => Promise.resolve(new Response(new ReadableStream())),
      firstByteTimeoutMs: 20,
      totalTimeoutMs: 100,
    });

    await expectTimeout(
      provider.stream({ systemInstruction: '', context: '', prompt: '', onDelta() {} }),
      'first-byte',
    );
  });

  it('times out when a stream stalls after producing data', async () => {
    const encoder = new TextEncoder();
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                  ),
                );
              },
            }),
          ),
        ),
      firstByteTimeoutMs: 50,
      idleTimeoutMs: 20,
      totalTimeoutMs: 100,
    });

    await expectTimeout(
      provider.stream({ systemInstruction: '', context: '', prompt: '', onDelta() {} }),
      'idle',
    );
  });

  it('returns promptly on caller abort even when fetch ignores the signal', async () => {
    const controller = new AbortController();
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      networkAdmission: new NetworkAdmission(),
      fetch: () => new Promise<Response>(() => undefined),
      firstByteTimeoutMs: 5_000,
    });
    const result = provider.stream({
      systemInstruction: '',
      context: '',
      prompt: '',
      signal: controller.signal,
      onDelta() {},
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('OpenAI transport admission', () => {
  const request = { systemInstruction: '', context: '', prompt: '', onDelta() {} };
  const encoder = new TextEncoder();
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('preserves local callback errors without poisoning service health', async () => {
    const networkAdmission = new NetworkAdmission({ failureThreshold: 1 });
    const callbackError = new Error('Local database write failed.');
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"text"}\n\ndata: {"type":"response.completed"}\n\n',
        ),
      ),
    );
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      fetch: fetcher,
      networkAdmission,
    });
    await expect(
      provider.stream({
        ...request,
        onDelta() {
          throw callbackError;
        },
      }),
    ).rejects.toBe(callbackError);
    await expect(provider.stream(request)).resolves.toMatchObject({ content: 'text' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects unserializable caller input before admission without counting a remote failure', async () => {
    const networkAdmission = new NetworkAdmission({ failureThreshold: 1 });
    const acquire = vi.spyOn(networkAdmission, 'acquire');
    const parameters: Record<string, unknown> = {};
    parameters.circular = parameters;
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('data: {"type":"response.completed"}\n\n')),
    );
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      fetch: fetcher,
      networkAdmission,
    });
    await expect(
      provider.stream({ ...request, tools: [{ name: 'test', parameters }] }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(acquire).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(provider.stream(request)).resolves.toMatchObject({ content: '' });
  });

  it('holds the shared permit until stream completion and releases it without waiting for EOF', async () => {
    const networkAdmission = new NetworkAdmission({ serviceConcurrency: 1 });
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
            },
            cancel,
          }),
        ),
      ),
    );
    const one = new OpenAIResponsesProvider({ apiKey: 'one', fetch: fetcher, networkAdmission });
    const two = new OpenAIResponsesProvider({ apiKey: 'two', fetch: fetcher, networkAdmission });
    const first = one.stream(request);
    const second = two.stream(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    streams[0]!.enqueue(
      encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    streams[0]!.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    streams[1]!.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
    await second;
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('cancels queued calls before fetch and releases active cancellations without opening the circuit', async () => {
    const networkAdmission = new NetworkAdmission({ serviceConcurrency: 1, failureThreshold: 1 });
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      fetch: fetcher,
      networkAdmission,
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = provider.stream({ ...request, signal: activeController.signal });
    const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    const queued = provider.stream({ ...request, signal: queuedController.signal });
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    queuedController.abort();
    await queuedRejected;
    expect(fetcher).toHaveBeenCalledOnce();
    activeController.abort();
    await activeRejected;
    const nextController = new AbortController();
    const next = provider.stream({ ...request, signal: nextController.signal });
    const nextRejected = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    nextController.abort();
    await nextRejected;
  });

  it.each([408, 500])(
    'counts HTTP %i as a fault but never automatically replays the request',
    async (status) => {
      const networkAdmission = new NetworkAdmission({ failureThreshold: 1 });
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status })));
      const provider = new OpenAIResponsesProvider({
        apiKey: 'test',
        fetch: fetcher,
        networkAdmission,
      });
      await expect(provider.stream(request)).rejects.toMatchObject({
        code: 'REQUEST_FAILED',
        retryable: true,
      });
      await expect(provider.stream(request)).rejects.toMatchObject({
        code: 'REQUEST_NOT_SENT',
        retryable: true,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('honors HTTP 429 cooldown and does not count authentication errors as faults', async () => {
    const networkAdmission = new NetworkAdmission({ failureThreshold: 1 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response('data: {"type":"response.completed"}\n\n'));
    const provider = new OpenAIResponsesProvider({
      apiKey: 'test',
      fetch: fetcher,
      networkAdmission,
    });
    await expect(provider.stream(request)).rejects.toMatchObject({ code: 'AUTHENTICATION' });
    await expect(provider.stream(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(provider.stream(request)).rejects.toThrow('PROVIDER_COOLDOWN');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(provider.stream(request)).resolves.toMatchObject({ content: '' });
  });
});
