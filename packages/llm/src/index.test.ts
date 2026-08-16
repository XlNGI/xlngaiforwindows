import { describe, expect, it, vi } from 'vitest';
import { LlmProviderError, OpenAIResponsesProvider } from './index.js';

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
    expect(provider.status()).toMatchObject({ configured: false, model: 'gpt-5.6-sol' });
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
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
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
