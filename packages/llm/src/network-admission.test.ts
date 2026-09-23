import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkAdmission, retryAfterMs } from './network-admission.js';

const fast = { globalRate: 1000, serviceRate: 1000, globalBurst: 100, serviceBurst: 100 };
const a = 'https://service-a.test/v1';
const b = 'https://service-b.test/v1';
const success = { kind: 'success' } as const;
const failure = { kind: 'failure' } as const;

describe('network admission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('limits bursts and request rate across normalized service origins', async () => {
    const admission = new NetworkAdmission();
    const first = await admission.acquire(a);
    const second = await admission.acquire('https://SERVICE-A.test:443/other-model');
    const third = await admission.acquire(a);
    const ready = vi.fn();
    const fourth = admission.acquire(a).then((permit) => {
      ready();
      return permit;
    });
    first.finish(success);
    await vi.advanceTimersByTimeAsync(499);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toHaveBeenCalledOnce();
    (await fourth).finish(success);
    second.finish(success);
    third.finish(success);
  });

  it('holds both concurrency limits until release and lets another service advance', async () => {
    const admission = new NetworkAdmission({
      ...fast,
      globalConcurrency: 2,
      serviceConcurrency: 1,
    });
    const activeA = await admission.acquire(a);
    const aReady = vi.fn();
    const queuedA = admission.acquire(a).then((permit) => {
      aReady();
      return permit;
    });
    const activeB = await admission.acquire(b);
    const bReady = vi.fn();
    const queuedB = admission.acquire(b).then((permit) => {
      bReady();
      return permit;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(aReady).not.toHaveBeenCalled();
    expect(bReady).not.toHaveBeenCalled();
    activeB.finish(success);
    (await queuedB).finish(success);
    expect(aReady).not.toHaveBeenCalled();
    activeA.finish(success);
    (await queuedA).finish(success);
    // Double terminal notification cannot create a phantom concurrency slot.
    activeA.finish(success);
  });

  it('enforces the global rate across distinct services after the burst is exhausted', async () => {
    const admission = new NetworkAdmission();
    for (let index = 0; index < 8; index++) {
      (await admission.acquire(`https://rate-${index}.test`)).finish(success);
    }
    const ready = vi.fn();
    const ninth = admission.acquire('https://ninth.test').then((permit) => {
      ready();
      return permit;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toHaveBeenCalledOnce();
    (await ninth).finish(success);
  });

  it('bounds global and per-service queues, expires waiters and removes cancelled work', async () => {
    const admission = new NetworkAdmission({
      ...fast,
      globalConcurrency: 1,
      serviceQueue: 1,
      globalQueue: 2,
      queueTimeoutMs: 100,
    });
    const active = await admission.acquire(a);
    const controller = new AbortController();
    const queuedA = admission.acquire(a, controller.signal);
    const cancelled = expect(queuedA).rejects.toMatchObject({ name: 'AbortError' });
    await expect(admission.acquire(a)).rejects.toMatchObject({
      reason: 'REQUEST_QUEUE_FULL',
      code: 'REQUEST_NOT_SENT',
    });
    const queuedB = admission.acquire(b);
    const timedOut = expect(queuedB).rejects.toMatchObject({ reason: 'REQUEST_QUEUE_TIMEOUT' });
    await expect(admission.acquire('https://service-c.test')).rejects.toMatchObject({
      reason: 'REQUEST_QUEUE_FULL',
    });
    controller.abort();
    await cancelled;
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    active.finish(success);
    (await admission.acquire(a)).finish(success);
  });

  it('opens after consecutive failures, isolates services and permits only one recovery probe', async () => {
    const admission = new NetworkAdmission({
      ...fast,
      failureThreshold: 2,
      circuitCooldownMs: 100,
    });
    (await admission.acquire(a)).finish(failure);
    (await admission.acquire(a)).finish(failure);
    await expect(admission.acquire(a)).rejects.toMatchObject({ reason: 'PROVIDER_CIRCUIT_OPEN' });
    (await admission.acquire(b)).finish(success);
    await vi.advanceTimersByTimeAsync(100);
    const probe = await admission.acquire(a);
    await expect(admission.acquire(a)).rejects.toMatchObject({ reason: 'PROVIDER_CIRCUIT_OPEN' });
    probe.finish(failure);
    await expect(admission.acquire(a)).rejects.toMatchObject({ reason: 'PROVIDER_CIRCUIT_OPEN' });
    await vi.advanceTimersByTimeAsync(100);
    (await admission.acquire(a)).finish(success);
    (await admission.acquire(a)).finish(success);
  });

  it('ignores a stale successful request when later failures have opened the circuit', async () => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 1 });
    const older = await admission.acquire(a);
    (await admission.acquire(a)).finish(failure);
    older.finish(success);
    await expect(admission.acquire(a)).rejects.toMatchObject({ reason: 'PROVIDER_CIRCUIT_OPEN' });
  });

  it('resets failure streak on success and expires failures outside the window', async () => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 2, failureWindowMs: 50 });
    (await admission.acquire(a)).finish(failure);
    (await admission.acquire(a)).finish(success);
    (await admission.acquire(a)).finish(failure);
    await vi.advanceTimersByTimeAsync(51);
    (await admission.acquire(a)).finish(failure);
    (await admission.acquire(a)).finish(success);
  });

  it('applies Retry-After cooling to queued and subsequent requests without fault counting', async () => {
    const admission = new NetworkAdmission({ ...fast, serviceConcurrency: 1, failureThreshold: 1 });
    const first = await admission.acquire(a);
    const queued = admission.acquire(a);
    const rejection = expect(queued).rejects.toMatchObject({ reason: 'PROVIDER_COOLDOWN' });
    first.finish({ kind: 'cooldown', retryAfterMs: 150 });
    await rejection;
    await expect(admission.acquire(a)).rejects.toMatchObject({ reason: 'PROVIDER_COOLDOWN' });
    (await admission.acquire(b)).finish(success);
    await vi.advanceTimersByTimeAsync(150);
    (await admission.acquire(a)).finish(success);
  });

  it('lets cancelled probes be replaced without adding a remote fault', async () => {
    const admission = new NetworkAdmission({ ...fast, failureThreshold: 1, circuitCooldownMs: 10 });
    (await admission.acquire(a)).finish(failure);
    await vi.advanceTimersByTimeAsync(10);
    (await admission.acquire(a)).finish({ kind: 'neutral' });
    (await admission.acquire(a)).finish(success);
  });

  it('bounds numeric and HTTP-date Retry-After with a fallback', () => {
    expect(retryAfterMs('2')).toBe(2_000);
    expect(retryAfterMs(new Date(Date.now() + 10_000).toUTCString())).toBe(10_000);
    expect(retryAfterMs('99999999')).toBe(30 * 60_000);
    expect(retryAfterMs('invalid')).toBe(30_000);
    expect(retryAfterMs(null)).toBe(30_000);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, 999_999_999])(
    'bounds cooldown duration supplied directly by callers (%s)',
    async (duration) => {
      const admission = new NetworkAdmission({ ...fast });
      (await admission.acquire(a)).finish({ kind: 'cooldown', retryAfterMs: duration });
      await vi.advanceTimersByTimeAsync(Number.isFinite(duration) ? 30 * 60_000 : 30_000);
      (await admission.acquire(a)).finish(success);
    },
  );

  it('bounds service state without evicting active requests or resetting protections', async () => {
    const admission = new NetworkAdmission({ ...fast, serviceLimit: 2, failureThreshold: 1 });
    const active = await admission.acquire(a);
    (await admission.acquire(b)).finish(failure);
    await expect(admission.acquire('https://third.test')).rejects.toMatchObject({
      reason: 'REQUEST_QUEUE_FULL',
    });
    active.finish(success);
    // Only a fully replenished idle origin can be removed; the circuit survives.
    await vi.advanceTimersByTimeAsync(1);
    (await admission.acquire('https://third.test')).finish(success);
    await expect(admission.acquire(b)).rejects.toMatchObject({ reason: 'PROVIDER_CIRCUIT_OPEN' });
  });

  it('keeps queue deadlines and circuit recovery monotonic when the wall clock moves backwards', async () => {
    const admission = new NetworkAdmission({
      ...fast,
      serviceConcurrency: 1,
      queueTimeoutMs: 100,
      failureThreshold: 1,
      circuitCooldownMs: 100,
    });
    const active = await admission.acquire(a);
    const queued = admission.acquire(a);
    const timeout = expect(queued).rejects.toMatchObject({ reason: 'REQUEST_QUEUE_TIMEOUT' });
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(100);
    await timeout;
    active.finish(failure);
    vi.setSystemTime(new Date('2010-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(100);
    (await admission.acquire(a)).finish(success);
  });
});
