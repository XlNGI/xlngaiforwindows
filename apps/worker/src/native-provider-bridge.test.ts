import type { NativeProviderStreamStartParams, SidecarEnvelope } from '@ai-video/contracts';
import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
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
});

describe('createPiStreamFunction', () => {
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
