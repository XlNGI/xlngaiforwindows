import { NetworkAdmission } from '@ai-video/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withNetworkResponse } from './network-transfer.js';

const origin = 'https://download.test/result';
const fast = { globalRate: 1000, serviceRate: 1000, globalBurst: 100, serviceBurst: 100 };
const textBody = (response: Response, read: <T>(operation: () => Promise<T>) => Promise<T>) =>
  read(() => response.text());

describe('outbound result transfers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('holds concurrency until the entire body is read, bounding bursts before fetch', async () => {
    const admission = new NetworkAdmission({ ...fast, serviceConcurrency: 1, serviceQueue: 1 });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('second'));
    vi.stubGlobal('fetch', fetch);
    const first = withNetworkResponse(origin, {}, textBody, admission);
    await vi.advanceTimersByTimeAsync(0);
    const second = withNetworkResponse(origin, {}, textBody, admission);
    await expect(withNetworkResponse(origin, {}, textBody, admission)).rejects.toMatchObject({
      reason: 'REQUEST_QUEUE_FULL',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    body.enqueue(new TextEncoder().encode('first'));
    body.close();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cleans unread bodies and keeps local storage/validation errors out of the breaker', async () => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 1 });
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      withNetworkResponse(origin, {}, () => Promise.reject(new Error('disk full')), admission),
    ).rejects.toThrow('disk full');
    expect(cancel).toHaveBeenCalledOnce();
    await expect(withNetworkResponse(origin, {}, textBody, admission)).resolves.toBe('ok');
  });

  it('counts a body disconnection as a failure and refuses subsequent requests without fetch', async () => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 1 });
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection reset'));
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(withNetworkResponse(origin, {}, textBody, admission)).rejects.toThrow(
      'connection reset',
    );
    await expect(withNetworkResponse(origin, {}, textBody, admission)).rejects.toMatchObject({
      reason: 'PROVIDER_CIRCUIT_OPEN',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([408, 503])(
    'counts HTTP %i as provider failure even when caller rejects the response',
    async (status) => {
      const admission = new NetworkAdmission({ ...fast, failureThreshold: 1 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
      await expect(
        withNetworkResponse(origin, {}, () => Promise.reject(new Error('HTTP error')), admission),
      ).rejects.toThrow('HTTP error');
      await expect(admission.acquire(origin)).rejects.toMatchObject({
        reason: 'PROVIDER_CIRCUIT_OPEN',
      });
    },
  );

  it('shares 429 cooldown with other operations on the same service and releases other services', async () => {
    const admission = new NetworkAdmission({ ...fast });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('busy', { status: 429, headers: { 'retry-after': '2' } }));
    vi.stubGlobal('fetch', fetch);
    await withNetworkResponse(origin, {}, textBody, admission);
    await expect(admission.acquire('https://download.test/another-model')).rejects.toMatchObject({
      reason: 'PROVIDER_COOLDOWN',
    });
    (await admission.acquire('https://another.test')).finish({ kind: 'success' });
    await vi.advanceTimersByTimeAsync(2000);
    (await admission.acquire(origin)).finish({ kind: 'success' });
  });

  it.each(['AbortError', 'TimeoutError'])('distinguishes %s from provider faults', async (name) => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener(
              'abort',
              () => {
                const reason: unknown = init.signal!.reason;
                reject(reason instanceof Error ? reason : new Error('Aborted'));
              },
              {
                once: true,
              },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = withNetworkResponse(origin, { signal: controller.signal }, textBody, admission);
    const rejected = expect(pending).rejects.toMatchObject({ name });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('interrupted', name));
    await rejected;
    if (name === 'TimeoutError') {
      await expect(admission.acquire(origin)).rejects.toMatchObject({
        reason: 'PROVIDER_CIRCUIT_OPEN',
      });
    } else {
      (await admission.acquire(origin)).finish({ kind: 'success' });
    }
  });

  it('checks the redirect destination separately before contacting it', async () => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 1 });
    (await admission.acquire('https://cdn.test')).finish({ kind: 'failure' });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://cdn.test/result' } }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(withNetworkResponse(origin, {}, textBody, admission)).rejects.toMatchObject({
      reason: 'PROVIDER_CIRCUIT_OPEN',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(origin);
  });
});
