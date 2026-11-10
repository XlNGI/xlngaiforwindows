const model: Model<'openai-responses'> = {
  id: 'model',
  name: 'Model',
  api: 'openai-responses',
  provider: 'native',
  baseUrl: 'native://provider',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};
import type { NativeProviderStreamStartParams, SidecarEnvelope } from '@ai-video/contracts';
import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPiStreamFunction,
  JsonLineWriter,
  NativeProviderBridge,
  type NativeProviderTransport,
} from './native-provider-bridge.js';

const params: NativeProviderStreamStartParams = {
  generationId: 'generation',
  attemptId: 'attempt',
  projectId: 'project',
  projectSessionId: 'session',
  conversationId: 'conversation',
  providerProfileId: 'profile',
  modelId: 'model',
  remoteModelId: 'remote-model',
  protocol: 'openai-responses',
  baseUrl: 'https://example.com/v1',
  systemInstruction: 'system',
  context: 'context',
  prompt: 'prompt',
};

function transport() {
  const sent: Array<Extract<SidecarEnvelope, { kind: 'host.request' }>> = [];
  return {
    sent,
    value: {
      send: vi.fn((envelope: Extract<SidecarEnvelope, { kind: 'host.request' }>) => {
        sent.push(envelope);
        return Promise.resolve();
      }),
    } satisfies NativeProviderTransport,
  };
}

function event(
  requestId: string,
  sequence: number,
  value: Extract<SidecarEnvelope, { kind: 'host.event' }>['event'],
) {
  return { kind: 'host.event', requestId, sequence, event: value } as const;
}

describe('JsonLineWriter', () => {
  it('serializes concurrent writes without interleaving and waits for callbacks', async () => {
    const chunks: string[] = [];
    const callbacks: Array<(error?: Error | null) => void> = [];
    const writer = new JsonLineWriter({
      write(chunk, callback) {
        chunks.push(chunk);
        callbacks.push(callback);
        return false;
      },
    });

    const first = writer.write({ id: 1 });
    const second = writer.write({ id: 2 });
    await Promise.resolve();
    expect(chunks).toEqual(['{"id":1}\n']);
    callbacks.shift()?.();
    await first;
    await Promise.resolve();
    expect(chunks).toEqual(['{"id":1}\n', '{"id":2}\n']);
    callbacks.shift()?.();
    await second;
  });

  it('rejects an envelope larger than 2 MiB without writing it', async () => {
    const write = vi.fn();
    const writer = new JsonLineWriter({ write });
    await expect(writer.write({ value: 'x'.repeat(2 * 1024 * 1024) })).rejects.toThrow('2 MiB');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('NativeProviderBridge', () => {
  it('closes host admission before settling pending work and never resubmits after shutdown', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value);
    const stream = bridge.start(params, { onEvent: vi.fn() });
    const pending = bridge.request('provider.dubbing.submit', {});
    const error = {
      code: 'INTERRUPTED' as const,
      message: 'Worker stopped for recovery.',
      retryable: true,
    };
    bridge.close(error);
    await expect(pending).rejects.toMatchObject({ hostError: error });
    await expect(stream.done).resolves.toMatchObject({ type: 'failed', error });
    const sent = io.sent.length;
    expect(sent).toBe(3); // Stream, one-shot and the owned stream cancellation.
    bridge.close(error);
    await expect(bridge.request('provider.dubbing.submit', {})).rejects.toMatchObject({
      hostError: { code: 'REQUEST_NOT_SENT' },
    });
    expect(() => bridge.start(params, { onEvent: vi.fn() })).toThrow('request was not sent');
    expect(io.sent).toHaveLength(sent);
    expect(
      bridge.handleEnvelope({
        kind: 'host.response',
        requestId: io.sent[1]!.requestId,
        ok: true,
        result: {},
      }),
    ).toBe(true);
  });

  it('preserves an observed numeric HTTP status for safe query retries', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value, () => 'dubbing-poll');
    const request = bridge.request('provider.dubbing.poll', { providerTaskId: 'generation_123' });
    const error = {
      code: 'PROVIDER_FAILED',
      message: 'Service temporarily unavailable.',
      retryable: false,
      providerStatus: 503,
      providerTaskId: 'generation_123',
    };
    bridge.handleEnvelope({ kind: 'host.response', requestId: 'dubbing-poll', ok: false, error });
    await expect(request).rejects.toMatchObject({ hostError: error });
    expect(io.sent).toHaveLength(1);
  });

  it.each(['500', 99, 600, 500.5, null])(
    'rejects malformed providerStatus %j without leaving the request pending',
    async (providerStatus) => {
      const io = transport();
      const bridge = new NativeProviderBridge(io.value, () => 'dubbing-poll');
      const request = bridge.request('provider.dubbing.poll', {});
      expect(
        bridge.handleEnvelope({
          kind: 'host.response',
          requestId: 'dubbing-poll',
          ok: false,
          error: {
            code: 'PROVIDER_FAILED',
            message: 'Unavailable.',
            retryable: false,
            providerStatus,
          },
        }),
      ).toBe(true);
      await expect(request).rejects.toMatchObject({ hostError: { code: 'INVALID_ENVELOPE' } });
    },
  );

  it.each([
    'SUBMISSION_UNKNOWN',
    'AUTHENTICATION_FAILED',
    'RATE_LIMITED',
    'TIMEOUT',
    'INTERRUPTED',
  ] as const)(
    'preserves official dubbing %s classifications and a safe recovery task ID',
    async (code) => {
      const io = transport();
      const bridge = new NativeProviderBridge(io.value, () => 'dubbing-submit');
      const request = bridge.request('provider.dubbing.submit', {
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        idempotencyKey: 'persisted-key',
      });
      const error = {
        code,
        message: 'Official dubbing request could not be completed.',
        retryable: false,
        providerErrorCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
        providerTaskId: 'generation_123',
      };
      expect(
        bridge.handleEnvelope({
          kind: 'host.response',
          requestId: 'dubbing-submit',
          ok: false,
          error,
        }),
      ).toBe(true);
      await expect(request).rejects.toMatchObject({ hostError: error });
      expect(io.sent).toHaveLength(1);
    },
  );

  it.each([
    { providerTaskId: 'https://output.example/video?sig=secret' },
    { providerTaskId: '../other-project' },
    { providerTaskId: 'x'.repeat(129) },
    { providerErrorCode: 'code\r\nx-api-key: secret' },
    { signedUrl: 'https://output.example/video?sig=secret' },
    { audioBase64: 'not-an-error-field' },
  ])(
    'rejects credential or arbitrary media data disguised as a dubbing recovery identity: %j',
    async (extra) => {
      const io = transport();
      const bridge = new NativeProviderBridge(io.value, () => 'dubbing-submit');
      const request = bridge.request('provider.dubbing.submit', {});
      bridge.handleEnvelope({
        kind: 'host.response',
        requestId: 'dubbing-submit',
        ok: false,
        error: {
          code: 'SUBMISSION_UNKNOWN',
          message: 'Submission result is unknown.',
          retryable: false,
          ...extra,
        },
      });
      await expect(request).rejects.toMatchObject({ hostError: { code: 'INVALID_ENVELOPE' } });
      expect(io.sent).toHaveLength(1);
    },
  );

  it('preserves an unsent admission refusal for both request and stream callers', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value);
    const error = {
      code: 'REQUEST_NOT_SENT' as const,
      message: 'REQUEST_QUEUE_FULL: 当前请求较多，请稍后重试。',
      retryable: true,
    };
    const request = bridge.request('provider.media.submit', {});
    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: io.sent[0]!.requestId,
      ok: false,
      error,
    });
    await expect(request).rejects.toMatchObject({ hostError: error });
    const stream = bridge.start(params, { onEvent: vi.fn() });
    bridge.handleEnvelope(
      event(stream.requestId, 0, { type: 'failed', projectSessionId: 'session', error }),
    );
    await expect(stream.done).resolves.toMatchObject({ type: 'failed', error });
  });

  it('correlates concurrent requests and ignores duplicate sequences', async () => {
    const io = transport();
    const ids = ['request-a', 'request-b'];
    const bridge = new NativeProviderBridge(io.value, () => ids.shift()!);
    const seenA = vi.fn();
    const seenB = vi.fn();
    const a = bridge.start(params, { onEvent: seenA });
    const b = bridge.start({ ...params, attemptId: 'attempt-b' }, { onEvent: seenB });

    bridge.handleEnvelope(event(b.requestId, 0, { type: 'started', projectSessionId: 'session' }));
    bridge.handleEnvelope(event(a.requestId, 0, { type: 'started', projectSessionId: 'session' }));
    bridge.handleEnvelope(event(a.requestId, 0, { type: 'started', projectSessionId: 'session' }));
    bridge.handleEnvelope(event(a.requestId, 1, { type: 'complete', projectSessionId: 'session' }));
    bridge.handleEnvelope(
      event(b.requestId, 1, { type: 'cancelled', projectSessionId: 'session' }),
    );

    await expect(a.done).resolves.toMatchObject({ type: 'complete' });
    await expect(b.done).resolves.toMatchObject({ type: 'cancelled' });
    expect(seenA).toHaveBeenCalledTimes(2);
    expect(seenB).toHaveBeenCalledTimes(2);
  });

  it('interrupts a stream gap, sends one cancellation, and ignores late terminal events', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value, () => 'request');
    const seen = vi.fn();
    const handle = bridge.start(params, { onEvent: seen });

    bridge.handleEnvelope(event('request', 1, { type: 'complete', projectSessionId: 'session' }));
    bridge.handleEnvelope(event('request', 0, { type: 'complete', projectSessionId: 'session' }));
    handle.cancel();

    await expect(handle.done).resolves.toMatchObject({
      type: 'failed',
      error: { code: 'INTERRUPTED' },
    });
    expect(io.sent.filter((item) => item.method === 'provider.stream.cancel')).toHaveLength(1);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('propagates AbortSignal once and rejects stale project-session events', async () => {
    const io = transport();
    let ordinal = 0;
    const bridge = new NativeProviderBridge(io.value, () => `request-${++ordinal}`);
    const abort = new AbortController();
    const aborted = bridge.start(params, { onEvent: vi.fn() }, abort.signal);
    abort.abort();
    abort.abort();
    expect(io.sent.filter((item) => item.method === 'provider.stream.cancel')).toHaveLength(1);

    const stale = bridge.start(params, { onEvent: vi.fn() });
    bridge.handleEnvelope(event(stale.requestId, 0, { type: 'started', projectSessionId: 'old' }));
    await expect(stale.done).resolves.toMatchObject({
      type: 'failed',
      error: { code: 'STALE_SESSION' },
    });
    expect(io.sent.filter((item) => item.method === 'provider.stream.cancel')).toHaveLength(2);
    void aborted;
  });

  it('validates rebuilt native tool pairs and rejects duplicate or opaque history', () => {
    const turn = {
      calls: [{ id: 'c1', name: 'library.read', argumentsJson: '{}' }],
      outputs: [{ callId: 'c1', output: 'receipt' }],
    };
    for (const contextTurns of [
      [{ ...turn, outputs: [] }],
      [turn, turn],
      [{ ...turn, outputs: [{ callId: 'other', output: 'receipt' }] }],
    ])
      expect(() =>
        new NativeProviderBridge(transport().value).start(
          { ...params, contextTurns },
          { onEvent: vi.fn() },
        ),
      ).toThrow();
    expect(() =>
      new NativeProviderBridge(transport().value).start(
        {
          ...params,
          contextTurns: [turn],
          continuation: { protocol: 'openai-responses', previousResponseId: 'opaque', outputs: [] },
        },
        { onEvent: vi.fn() },
      ),
    ).toThrow();
  });

  it('rejects secrets, headers, authorization handles, signed URLs, and unknown fields', () => {
    const bridge = new NativeProviderBridge(transport().value, () => 'request');
    for (const unsafe of [
      { ...params, apiKey: 'secret' },
      { ...params, headers: { authorization: 'secret' } },
      {
        ...params,
        tools: [{ name: 'tool', description: 'tool', parameters: {}, authorizationHandle: 'cap' }],
      },
      { ...params, baseUrl: 'https://example.com/v1?X-Amz-Signature=secret' },
      { ...params, unexpected: true },
    ]) {
      expect(() => bridge.start(unsafe, { onEvent: vi.fn() })).toThrow();
    }
  });

  it('does not consume legacy Worker responses', () => {
    const bridge = new NativeProviderBridge(transport().value);
    expect(bridge.handleEnvelope({ id: 'legacy', protocolVersion: 1, ok: true, result: {} })).toBe(
      false,
    );
  });

  it('terminates a correlated stream when the host envelope is malformed', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value, () => 'request');
    const handle = bridge.start(params, { onEvent: vi.fn() });

    expect(
      bridge.handleEnvelope({
        ...event('request', 0, { type: 'started', projectSessionId: 'session' }),
        unknown: true,
      }),
    ).toBe(true);

    await expect(handle.done).resolves.toMatchObject({
      type: 'failed',
      error: { code: 'INVALID_ENVELOPE' },
    });
    expect(io.sent.filter((item) => item.method === 'provider.stream.cancel')).toHaveLength(1);
  });

  it('correlates concurrent one-shot responses and ignores a duplicate response', async () => {
    const io = transport();
    const ids = ['one-shot-a', 'one-shot-b'];
    const bridge = new NativeProviderBridge(io.value, () => ids.shift()!);
    const first = bridge.request('provider.media.cancel', { taskId: 'a' });
    const second = bridge.request('provider.media.cancel', { taskId: 'b' });

    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: 'one-shot-b',
      ok: true,
      result: { cancelled: true },
    });
    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: 'one-shot-a',
      ok: true,
      result: { cancelled: false },
    });
    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: 'one-shot-a',
      ok: true,
      result: { cancelled: true },
    });

    await expect(first).resolves.toEqual({ cancelled: false });
    await expect(second).resolves.toEqual({ cancelled: true });
  });

  it('preserves a correlated one-shot host error and rejects malformed responses immediately', async () => {
    const io = transport();
    const ids = ['failed-request', 'malformed-request'];
    const bridge = new NativeProviderBridge(io.value, () => ids.shift()!);
    const failed = bridge.request('provider.media.submit', {});
    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: 'failed-request',
      ok: false,
      error: { code: 'INVALID_PARAMETERS', message: 'invalid input', retryable: false },
    });
    await expect(failed).rejects.toMatchObject({
      name: 'NativeProviderRequestError',
      hostError: { code: 'INVALID_PARAMETERS', retryable: false },
    });

    const malformed = bridge.request('provider.media.submit', {});
    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: 'malformed-request',
      ok: true,
      result: {},
      unexpected: true,
    });
    await expect(malformed).rejects.toMatchObject({
      hostError: { code: 'INVALID_ENVELOPE' },
    });
  });
});

describe('createPiStreamFunction', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'rejects malformed and truncated tool arguments before Pi execution (%s)',
    async (protocol) => {
      for (const [argumentsJson, finishReason] of [
        ['{"scenes":[', 'tool_calls'],
        ['[]', 'tool_calls'],
        ['{"scenes":[]}', 'length'],
      ] as const) {
        const io = transport();
        const bridge = new NativeProviderBridge(io.value, () => 'invalid-request');
        const observe = vi.fn();
        const stream = createPiStreamFunction(
          bridge,
          () => ({ ...params, protocol }),
          observe,
        )(model, {
          messages: [],
        });
        await Promise.resolve();
        await Promise.resolve();
        bridge.handleEnvelope(
          event('invalid-request', 0, {
            type: 'tool_call_end',
            projectSessionId: 'session',
            call: { id: 'bad', name: 'scene.submit_structure', argumentsJson },
          }),
        );
        bridge.handleEnvelope(
          event('invalid-request', 1, {
            type: 'complete',
            projectSessionId: 'session',
            finishReason,
          }),
        );
        const events: AssistantMessageEvent[] = [];
        for await (const item of stream) events.push(item);
        const last = events.at(-1)!;
        expect(last).toMatchObject({
          type: 'error',
          reason: 'error',
          error: {
            stopReason: 'error',
          },
        });
        if (last?.type === 'error')
          expect(last.error.errorMessage).toContain('No tool was executed');
        expect(events.some((item) => item.type === 'done')).toBe(false);
        expect(observe.mock.calls.some((call) => call[1] === 'complete')).toBe(false);
        expect(observe.mock.calls.some((call) => call[1] === 'failed')).toBe(true);
      }
    },
  );

  it('forwards safe request progress independently of tool execution and passes declared settings', async () => {
    const io = transport();
    const observe = vi.fn();
    const bridge = new NativeProviderBridge(io.value, () => 'progress-request');
    const inferenceSettings = {
      maxOutputTokens: 8192,
      outputTokenParameter: 'max_output_tokens' as const,
      reasoning: 'provider_default' as const,
    };
    const stream = createPiStreamFunction(
      bridge,
      () => ({ ...params, inferenceSettings }),
      observe,
    )(model, { messages: [] });
    await Promise.resolve();
    await Promise.resolve();
    bridge.handleEnvelope(
      event('progress-request', 0, {
        type: 'request_progress',
        projectSessionId: 'session',
        stage: 'tool_arguments',
        toolName: 'scene.structure.stage',
        argumentBytes: 20000,
        nativeElapsedMs: 123,
      }),
    );
    bridge.handleEnvelope(
      event('progress-request', 1, { type: 'cancelled', projectSessionId: 'session' }),
    );
    const events: AssistantMessageEvent[] = [];
    for await (const item of stream) events.push(item);
    expect(observe).toHaveBeenCalledWith(
      expect.any(String),
      'tool_arguments',
      expect.objectContaining({ argumentBytes: 20000, nativeElapsedMs: 123 }),
    );
    expect(observe).toHaveBeenCalledWith(
      expect.any(String),
      'dispatching',
      expect.objectContaining({ hostRequestId: 'progress-request' }),
    );
    const timing = observe.mock.calls.find((call) => call[1] === 'tool_arguments')?.[2] as Record<
      string,
      unknown
    >;
    expect(typeof timing.workerElapsedMs).toBe('number');
    expect(events.some((item) => item.type === 'toolcall_start')).toBe(false);
    expect(io.sent[0]!.params).toMatchObject({ inferenceSettings });
  });

  it('maps text, thinking, tool, usage, and completion events to Pi', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value, () => 'pi-request');
    const streamFn = createPiStreamFunction(bridge, () => params);
    const stream = streamFn(model, { messages: [] });
    await Promise.resolve();
    await Promise.resolve();
    bridge.handleEnvelope(event('pi-request', 0, { type: 'started', projectSessionId: 'session' }));
    bridge.handleEnvelope(
      event('pi-request', 1, {
        type: 'thinking_delta',
        projectSessionId: 'session',
        delta: 'think',
      }),
    );
    bridge.handleEnvelope(
      event('pi-request', 2, { type: 'text_delta', projectSessionId: 'session', delta: 'hello' }),
    );
    bridge.handleEnvelope(
      event('pi-request', 3, {
        type: 'tool_call_start',
        projectSessionId: 'session',
        callId: 'call',
        name: 'outline',
      }),
    );
    bridge.handleEnvelope(
      event('pi-request', 4, {
        type: 'tool_call_delta',
        projectSessionId: 'session',
        callId: 'call',
        delta: '{"chapter":1}',
      }),
    );
    bridge.handleEnvelope(
      event('pi-request', 5, {
        type: 'tool_call_end',
        projectSessionId: 'session',
        call: { id: 'call', name: 'outline', argumentsJson: '{"chapter":1}' },
      }),
    );
    bridge.handleEnvelope(
      event('pi-request', 6, {
        type: 'usage',
        projectSessionId: 'session',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    );
    bridge.handleEnvelope(
      event('pi-request', 7, {
        type: 'complete',
        projectSessionId: 'session',
        providerResponseId: 'response',
      }),
    );

    const events: AssistantMessageEvent[] = [];
    for await (const item of stream) events.push(item);
    expect(events.map((item) => item.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'text_start',
      'text_delta',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'thinking_end',
      'text_end',
      'done',
    ]);
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'toolUse',
      responseId: 'response',
      usage: { input: 10, output: 5, totalTokens: 15 },
    });
  });

  it.each([500, 502, 503, 504, 520, 524, 529, 599])(
    'retries retryable HTTP %s with the same completed tool context and independent accounting',
    async (providerStatus) => {
      vi.useFakeTimers();
      const io = transport();
      const bridge = new NativeProviderBridge(io.value);
      const observe = vi.fn();
      const reserveRetry = vi.fn();
      const recoverContext = vi.fn(() => true);
      const continuationParams = {
        ...params,
        continuation: {
          protocol: 'openai-responses' as const,
          previousResponseId: 'already-completed-response',
          outputs: [{ callId: 'saved-draft', output: '{"status":"succeeded","id":"draft"}' }],
        },
      };
      const resolveParams = vi.fn(() => continuationParams);
      const stream = createPiStreamFunction(
        bridge,
        resolveParams,
        observe,
        undefined,
        reserveRetry,
        recoverContext,
      )(model, { messages: [] });
      await vi.advanceTimersByTimeAsync(0);
      bridge.handleEnvelope(
        event(io.sent[0]!.requestId, 0, {
          type: 'failed',
          projectSessionId: 'session',
          error: {
            code: 'PROVIDER_FAILED',
            message: `Provider HTTP ${providerStatus}: Service Error`,
            retryable: true,
            providerStatus,
          },
        }),
      );
      expect(io.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(io.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(io.sent).toHaveLength(2);
      expect(io.sent[1]!.requestId).not.toBe(io.sent[0]!.requestId);
      expect(io.sent[1]!.params).toEqual(continuationParams);
      expect(resolveParams).toHaveBeenCalledTimes(2);
      expect(reserveRetry).toHaveBeenCalledTimes(1);
      expect(recoverContext).not.toHaveBeenCalled();
      bridge.handleEnvelope(
        event(io.sent[1]!.requestId, 0, {
          type: 'text_delta',
          projectSessionId: 'session',
          delta: '已完成。',
        }),
      );
      bridge.handleEnvelope(
        event(io.sent[1]!.requestId, 1, {
          type: 'complete',
          projectSessionId: 'session',
          finishReason: 'stop',
        }),
      );
      const events: AssistantMessageEvent[] = [];
      for await (const item of stream) events.push(item);
      expect(events.filter((item) => item.type === 'error')).toEqual([]);
      expect(events.filter((item) => item.type === 'start')).toHaveLength(1);
      await expect(stream.result()).resolves.toMatchObject({
        stopReason: 'stop',
        content: [{ type: 'text', text: '已完成。' }],
      });
      expect(observe.mock.calls.filter(([, stage]) => stage === 'failed')).toHaveLength(1);
      expect(observe.mock.calls.filter(([, stage]) => stage === 'complete')).toHaveLength(1);
      expect(observe).toHaveBeenCalledWith(
        expect.any(String),
        'retry_wait',
        expect.objectContaining({
          retryAttempt: 1,
          delayMs: 1000,
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['WINHTTP_RESPONSE_HEADERS', 'WINHTTP_REQUEST_SEND'])(
    'retries explicitly classified %s transport failure before output',
    async (providerErrorCode) => {
      vi.useFakeTimers();
      const io = transport();
      const bridge = new NativeProviderBridge(io.value);
      const observe = vi.fn();
      const reserveRetry = vi.fn();
      const stream = createPiStreamFunction(
        bridge,
        () => params,
        observe,
        undefined,
        reserveRetry,
      )(model, { messages: [] });
      await vi.advanceTimersByTimeAsync(0);
      bridge.handleEnvelope(
        event(io.sent[0]!.requestId, 0, {
          type: 'failed',
          projectSessionId: 'session',
          error: {
            code: 'PROVIDER_FAILED',
            message: 'LLM transport failed before receiving output',
            retryable: true,
            providerErrorCode,
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(io.sent).toHaveLength(2);
      expect(reserveRetry).toHaveBeenCalledTimes(1);
      bridge.handleEnvelope(
        event(io.sent[1]!.requestId, 0, {
          type: 'text_delta',
          projectSessionId: 'session',
          delta: '已恢复。',
        }),
      );
      bridge.handleEnvelope(
        event(io.sent[1]!.requestId, 1, {
          type: 'complete',
          projectSessionId: 'session',
          finishReason: 'stop',
        }),
      );
      for await (const item of stream) void item;
      await expect(stream.result()).resolves.toMatchObject({
        stopReason: 'stop',
        content: [{ type: 'text', text: '已恢复。' }],
      });
      expect(observe).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({
          failureOrigin: 'provider',
          providerErrorCode,
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([503, 520])(
    'stops after two HTTP %s retries and leaves every request terminal',
    async (providerStatus) => {
      vi.useFakeTimers();
      const io = transport();
      const bridge = new NativeProviderBridge(io.value);
      const observe = vi.fn();
      const reserveRetry = vi.fn();
      const stream = createPiStreamFunction(
        bridge,
        () => params,
        observe,
        undefined,
        reserveRetry,
      )(model, { messages: [] });
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.advanceTimersByTimeAsync(attempt * 1000);
        expect(io.sent).toHaveLength(attempt + 1);
        bridge.handleEnvelope(
          event(io.sent[attempt]!.requestId, 0, {
            type: 'failed',
            projectSessionId: 'session',
            error: {
              code: 'PROVIDER_FAILED',
              message: `Provider HTTP ${providerStatus}: unavailable`,
              retryable: true,
              providerStatus,
            },
          }),
        );
      }
      for await (const item of stream) void item;
      await expect(stream.result()).resolves.toMatchObject({
        stopReason: 'error',
        errorMessage: `Provider HTTP ${providerStatus}: unavailable`,
      });
      expect(reserveRetry).toHaveBeenCalledTimes(2);
      expect(observe.mock.calls.filter(([, stage]) => stage === 'failed')).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('records local context refusal separately from a bridge or provider error without sending', async () => {
    const io = transport();
    const observe = vi.fn();
    const stream = createPiStreamFunction(
      new NativeProviderBridge(io.value),
      () => {
        throw new Error('CONTEXT_BUDGET_EXCEEDED: 本地预算不足');
      },
      observe,
    )(model, { messages: [] });
    for await (const item of stream) void item;
    expect(io.sent).toHaveLength(0);
    expect(observe).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({
        errorCode: 'CONTEXT_BUDGET_EXCEEDED',
        failureOrigin: 'local_context',
      }),
    );
  });

  it.each(['cancel', 'budget', 'stale-session'] as const)(
    'does not dispatch a retry after %s',
    async (reason) => {
      vi.useFakeTimers();
      const io = transport();
      const bridge = new NativeProviderBridge(io.value);
      const observe = vi.fn();
      const controller = new AbortController();
      let resolutions = 0;
      const reserveRetry = vi.fn(() => {
        if (reason === 'budget') throw new Error('AGENT_TURN_QUOTA_EXHAUSTED');
      });
      const stream = createPiStreamFunction(
        bridge,
        () => {
          if (++resolutions > 1 && reason === 'stale-session') throw new Error('STALE_SESSION');
          return params;
        },
        observe,
        undefined,
        reserveRetry,
      )(model, { messages: [] }, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      bridge.handleEnvelope(
        event(io.sent[0]!.requestId, 0, {
          type: 'failed',
          projectSessionId: 'session',
          error: {
            code: 'PROVIDER_FAILED',
            message: 'Provider HTTP 502',
            retryable: true,
            providerStatus: 502,
          },
        }),
      );
      if (reason === 'cancel') controller.abort();
      await vi.advanceTimersByTimeAsync(1000);
      for await (const item of stream) void item;
      expect(io.sent).toHaveLength(1);
      await expect(stream.result()).resolves.toMatchObject({
        stopReason: reason === 'cancel' ? 'aborted' : 'error',
      });
      const prepared = observe.mock.calls.filter(([, stage]) => stage === 'preparing');
      expect(prepared).toHaveLength(2);
      for (const [id] of prepared)
        expect(
          observe.mock.calls.some(
            ([key, stage]) => key === id && ['failed', 'cancelled'].includes(stage as string),
          ),
        ).toBe(true);
      expect(reserveRetry).toHaveBeenCalledTimes(reason === 'cancel' ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { type: 'text_delta', delta: 'partial' },
    { type: 'thinking_delta', delta: 'internal' },
    { type: 'tool_call_start', callId: 'call', name: 'save' },
    { type: 'tool_call_end', call: { id: 'call', name: 'save', argumentsJson: '{}' } },
    { type: 'usage', usage: { inputTokens: 10 } },
    { type: 'request_progress', stage: 'tool_arguments', argumentBytes: 12 },
  ] as const)('does not replay after receiving $type', async (output) => {
    vi.useFakeTimers();
    const io = transport();
    const bridge = new NativeProviderBridge(io.value);
    const stream = createPiStreamFunction(bridge, () => params)(model, { messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    bridge.handleEnvelope(
      event(io.sent[0]!.requestId, 0, { ...output, projectSessionId: 'session' }),
    );
    bridge.handleEnvelope(
      event(io.sent[0]!.requestId, 1, {
        type: 'failed',
        projectSessionId: 'session',
        error: {
          code: 'PROVIDER_FAILED',
          message: 'HTTP 520 after output',
          retryable: true,
          providerStatus: 520,
        },
      }),
    );
    for await (const item of stream) void item;
    expect(io.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles the stream when a project switch also prevents terminal accounting', async () => {
    vi.useFakeTimers();
    const io = transport();
    const bridge = new NativeProviderBridge(io.value);
    let closed = false;
    const stream = createPiStreamFunction(
      bridge,
      () => {
        if (closed) throw new Error('Project session changed during generation.');
        return params;
      },
      () => {
        if (closed) throw new Error('Project session changed during accounting.');
      },
    )(model, { messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    bridge.handleEnvelope(
      event(io.sent[0]!.requestId, 0, {
        type: 'failed',
        projectSessionId: 'session',
        error: {
          code: 'PROVIDER_FAILED',
          message: 'Provider HTTP 500',
          retryable: true,
          providerStatus: 500,
        },
      }),
    );
    closed = true;
    await vi.advanceTimersByTimeAsync(1000);
    for await (const item of stream) void item;
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'error',
      errorMessage: 'Project session changed during generation.',
    });
    expect(io.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { code: 'PROVIDER_FAILED', providerStatus: 401, retryable: true },
    { code: 'PROVIDER_FAILED', providerStatus: 429, retryable: true },
    { code: 'PROVIDER_FAILED', providerStatus: 500, retryable: false },
    { code: 'PROVIDER_FAILED', providerStatus: 520, retryable: false },
    { code: 'PROVIDER_FAILED', retryable: true },
    { code: 'PROVIDER_FAILED', providerErrorCode: 'WINHTTP_RESPONSE_HEADERS', retryable: false },
    {
      code: 'PROVIDER_FAILED',
      providerStatus: 429,
      providerErrorCode: 'WINHTTP_RESPONSE_HEADERS',
      retryable: true,
    },
    { code: 'TIMEOUT', providerStatus: 504, retryable: true },
    { code: 'SUBMISSION_UNKNOWN', providerStatus: 500, retryable: true },
  ] as const)('does not infer recovery from ambiguous or refused errors: %j', async (error) => {
    vi.useFakeTimers();
    const io = transport();
    const bridge = new NativeProviderBridge(io.value);
    const stream = createPiStreamFunction(bridge, () => params)(model, { messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    bridge.handleEnvelope(
      event(io.sent[0]!.requestId, 0, {
        type: 'failed',
        projectSessionId: 'session',
        error: { ...error, message: 'Provider HTTP 500' },
      }),
    );
    for await (const item of stream) void item;
    expect(io.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records bounded Provider failure diagnostics after redacting credentials and URL queries', async () => {
    const io = transport();
    const bridge = new NativeProviderBridge(io.value, () => 'provider-failure');
    const observe = vi.fn();
    const stream = createPiStreamFunction(bridge, () => params, observe)(model, { messages: [] });
    await Promise.resolve();
    await Promise.resolve();
    bridge.handleEnvelope(
      event('provider-failure', 0, {
        type: 'failed',
        projectSessionId: 'session',
        error: {
          code: 'PROVIDER_FAILED',
          message:
            'HTTP 429 api_key=secret Bearer hidden https://provider.invalid/path?token=private',
          retryable: true,
          providerStatus: 429,
          providerErrorCode: 'rate_limit_exceeded',
        },
      }),
    );
    for await (const _item of stream) void _item;

    expect(observe).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({
        errorCode: 'PROVIDER_FAILED',
        providerStatus: 429,
        providerErrorCode: 'rate_limit_exceeded',
        providerErrorMessage:
          'HTTP 429 api_key=[redacted] Bearer [redacted] https://provider.invalid/path?[query redacted]',
      }),
    );
  });

  it('encodes resolver failures as Pi error events instead of throwing', async () => {
    const streamFn = createPiStreamFunction(new NativeProviderBridge(transport().value), () => {
      throw new Error('runtime unavailable');
    });
    const stream = streamFn(model, { messages: [] });
    const events: AssistantMessageEvent[] = [];
    for await (const item of stream) events.push(item);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      error: { errorMessage: 'runtime unavailable' },
    });
  });
});

it.each([
  { providerStatus: 429, providerErrorCode: 'rate_limit_exceeded' },
  { providerStatus: 402, providerErrorCode: 'insufficient_quota' },
  { providerStatus: undefined, providerErrorCode: 'NETWORK_ERROR' },
])('does not classify a provider failure as context overflow: %j', async (error) => {
  vi.useFakeTimers();
  const io = transport(),
    bridge = new NativeProviderBridge(io.value),
    recover = vi.fn(() => true);
  const stream = createPiStreamFunction(
    bridge,
    () => params,
    undefined,
    undefined,
    undefined,
    recover,
  )(model, { messages: [] });
  await vi.advanceTimersByTimeAsync(0);
  bridge.handleEnvelope(
    event(io.sent[0]!.requestId, 0, {
      type: 'failed',
      projectSessionId: 'session',
      error: {
        code: 'PROVIDER_FAILED',
        message: 'context mention in unrelated error',
        retryable: true,
        ...error,
      },
    }),
  );
  for await (const item of stream) void item;
  expect(recover).not.toHaveBeenCalled();
  expect(io.sent).toHaveLength(1);
});
it('bounds context recovery to two retries and rebuilds each request', async () => {
  vi.useFakeTimers();
  const io = transport(),
    bridge = new NativeProviderBridge(io.value),
    recover = vi.fn(() => true),
    resolver = vi.fn(() => ({ ...params, prompt: `rebuilt-${resolver.mock.calls.length}` }));
  const stream = createPiStreamFunction(
    bridge,
    resolver,
    undefined,
    undefined,
    undefined,
    recover,
  )(model, { messages: [] });
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(i * 1000);
    bridge.handleEnvelope(
      event(io.sent[i]!.requestId, 0, {
        type: 'failed',
        projectSessionId: 'session',
        error: {
          code: 'PROVIDER_FAILED',
          message: 'context exceeded',
          retryable: false,
          providerErrorCode: 'CONTEXT_BUDGET_EXCEEDED',
        },
      }),
    );
  }
  for await (const item of stream) void item;
  expect(resolver).toHaveBeenCalledTimes(3);
  expect(recover).toHaveBeenCalledTimes(2);
  expect(io.sent).toHaveLength(3);
});
it('does not dispatch an unchanged context-rejected request or mislabel the local failure', async () => {
  vi.useFakeTimers();
  const io = transport();
  const bridge = new NativeProviderBridge(io.value);
  const recover = vi.fn(() => true);
  const observe = vi.fn();
  const stream = createPiStreamFunction(
    bridge,
    () => params,
    observe,
    undefined,
    undefined,
    recover,
  )(model, { messages: [] });
  await vi.advanceTimersByTimeAsync(0);
  bridge.handleEnvelope(
    event(io.sent[0]!.requestId, 0, {
      type: 'failed',
      projectSessionId: 'session',
      error: {
        code: 'PROVIDER_FAILED',
        message: 'CONTEXT_BUDGET_EXCEEDED: native protocol estimate 45106 > input budget 44800',
        providerErrorCode: 'CONTEXT_BUDGET_EXCEEDED',
        retryable: false,
      },
    }),
  );
  await vi.advanceTimersByTimeAsync(4000);
  const events = [];
  for await (const item of stream) events.push(item);
  expect(io.sent).toHaveLength(1);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { errorMessage: expect.stringContaining('same rejected request') as unknown },
  });
  expect(observe.mock.calls.filter(([, stage]) => stage === 'failed')).toEqual([
    expect.arrayContaining([expect.objectContaining({ failureOrigin: 'local_context' })]),
    expect.arrayContaining([expect.objectContaining({ failureOrigin: 'local_context' })]),
  ]);
});
it('recovers local assembly overflow without dispatching impossible requests', async () => {
  vi.useFakeTimers();
  const io = transport(),
    bridge = new NativeProviderBridge(io.value),
    recover = vi.fn(() => true),
    resolver = vi.fn(() => {
      throw new Error('CONTEXT_BUDGET_EXCEEDED: required context');
    });
  const stream = createPiStreamFunction(
    bridge,
    resolver,
    undefined,
    undefined,
    undefined,
    recover,
  )(model, { messages: [] });
  await vi.advanceTimersByTimeAsync(4000);
  for await (const item of stream) void item;
  expect(resolver).toHaveBeenCalledTimes(3);
  expect(recover).toHaveBeenCalledTimes(2);
  expect(io.sent).toHaveLength(0);
});
it('allows a model request larger than 2 MiB while preserving the ordinary envelope bound', async () => {
  const io = transport(),
    bridge = new NativeProviderBridge(io.value);
  const handle = bridge.start(
    {
      ...params,
      prompt: 'x'.repeat(3 * 1024 * 1024),
      modelCapabilities: {
        modelId: params.modelId,
        contextWindow: 1000000,
        capabilitySource: 'manual_config',
      },
    },
    { onEvent: () => undefined },
  );
  expect(io.sent).toHaveLength(1);
  bridge.handleEnvelope(
    event(handle.requestId, 0, {
      type: 'complete',
      projectSessionId: 'session',
      finishReason: 'stop',
    }),
  );
  await handle.done;
});
