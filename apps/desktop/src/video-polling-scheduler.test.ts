import type { VideoGenerationJobInfo } from '@ai-video/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextDelay, VideoPollingScheduler } from './video-polling-scheduler';

function job(id = 'job'): VideoGenerationJobInfo {
  return {
    id,
    projectId: 'project',
    adapterKey: 'IMAGE_TO_VIDEO:vidu:viduq3-pro:v2',
    assetKind: 'shot-video',
    providerTaskId: `provider-${id}`,
    status: 'polling',
    request: {
      images: ['https://example.invalid/input.png'],
      duration: 5,
      resolution: '720p',
      audio: true,
    },
    metadata: {
      providerRegion: 'global',
      pollAttempts: 0,
      pollDeadlineAt: '2026-08-02T01:00:00.000Z',
    },
    results: [],
    elapsedMs: 0,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VideoPollingScheduler', () => {
  it('deduplicates a job and stops after a terminal observation', async () => {
    const poll = vi.fn(() => Promise.resolve({ status: 200, body: { state: 'success' } }));
    const completed = { ...job(), status: 'succeeded' as const };
    const observe = vi.fn(() => Promise.resolve(completed));
    const onTerminal = vi.fn();
    const scheduler = new VideoPollingScheduler({
      poll,
      observe,
      timeout: vi.fn(),
      refresh: vi.fn(),
      onUpdate: vi.fn(),
      onTransientError: vi.fn(),
      onTerminal,
      random: () => 0,
    });

    scheduler.sync([job()]);
    scheduler.sync([job()]);
    await vi.advanceTimersByTimeAsync(0);

    expect(poll).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(completed);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledOnce();
  });

  it('backs off after a transient transport failure', async () => {
    const poll = vi
      .fn<() => Promise<{ status: number; body: unknown }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ status: 200, body: { state: 'processing' } });
    const observe = vi.fn(() =>
      Promise.resolve({ ...job(), metadata: { ...job().metadata, pollAttempts: 1 } }),
    );
    const scheduler = new VideoPollingScheduler({
      poll,
      observe,
      timeout: vi.fn(),
      refresh: vi.fn(),
      onUpdate: vi.fn(),
      onTransientError: vi.fn(),
      onTerminal: vi.fn(),
      random: () => 0,
    });

    scheduler.sync([job()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('uses the persisted deadline instead of polling an expired job', async () => {
    const expired = {
      ...job(),
      metadata: { ...job().metadata, pollDeadlineAt: '2026-08-01T23:59:59.000Z' },
    };
    const timedOut = { ...expired, status: 'timed-out' as const };
    const timeout = vi.fn(() => Promise.resolve(timedOut));
    const poll = vi.fn();
    const onTerminal = vi.fn();
    const scheduler = new VideoPollingScheduler({
      poll,
      observe: vi.fn(),
      timeout,
      refresh: vi.fn(),
      onUpdate: vi.fn(),
      onTransientError: vi.fn(),
      onTerminal,
    });

    scheduler.sync([expired]);
    await vi.advanceTimersByTimeAsync(0);

    expect(timeout).toHaveBeenCalledWith(expired);
    expect(poll).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(timedOut);
  });

  it('isolates an in-flight result after disposal', async () => {
    let resolvePoll: (value: { status: number; body: unknown }) => void = () => undefined;
    const pendingPoll = new Promise<{ status: number; body: unknown }>((resolve) => {
      resolvePoll = resolve;
    });
    const observe = vi.fn();
    const scheduler = new VideoPollingScheduler({
      poll: vi.fn(() => pendingPoll),
      observe,
      timeout: vi.fn(),
      refresh: vi.fn(),
      onUpdate: vi.fn(),
      onTransientError: vi.fn(),
      onTerminal: vi.fn(),
    });

    scheduler.sync([job()]);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.dispose();
    resolvePoll({ status: 200, body: { state: 'success' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).not.toHaveBeenCalled();
  });

  it('refreshes local download state without polling the Provider', async () => {
    const downloading = { ...job(), status: 'downloading' as const };
    const completed = { ...downloading, status: 'succeeded' as const };
    const refresh = vi.fn(() => Promise.resolve(completed));
    const poll = vi.fn();
    const onTerminal = vi.fn();
    const scheduler = new VideoPollingScheduler({
      poll,
      observe: vi.fn(),
      timeout: vi.fn(),
      refresh,
      onUpdate: vi.fn(),
      onTransientError: vi.fn(),
      onTerminal,
    });

    scheduler.sync([downloading]);
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledWith(downloading);
    expect(poll).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(completed);
  });

  it('continues with local refresh after Provider success starts a download', async () => {
    const downloading = { ...job(), status: 'downloading' as const };
    const completed = { ...downloading, status: 'succeeded' as const };
    const refresh = vi.fn(() => Promise.resolve(completed));
    const onTerminal = vi.fn();
    const scheduler = new VideoPollingScheduler({
      poll: vi.fn(() => Promise.resolve({ status: 200, body: { state: 'success' } })),
      observe: vi.fn(() => Promise.resolve(downloading)),
      timeout: vi.fn(),
      refresh,
      onUpdate: vi.fn(),
      onTransientError: vi.fn(),
      onTerminal,
      random: () => 0,
    });

    scheduler.sync([job()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(refresh).toHaveBeenCalledWith(downloading);
    expect(onTerminal).toHaveBeenCalledWith(completed);
  });

  it('does not publish an observation that resolves after disposal', async () => {
    let resolveObservation: (value: VideoGenerationJobInfo) => void = () => undefined;
    const pendingObservation = new Promise<VideoGenerationJobInfo>((resolve) => {
      resolveObservation = resolve;
    });
    const onUpdate = vi.fn();
    const onTerminal = vi.fn();
    const observe = vi.fn(() => pendingObservation);
    const scheduler = new VideoPollingScheduler({
      poll: vi.fn(() => Promise.resolve({ status: 200, body: { state: 'success' } })),
      observe,
      timeout: vi.fn(),
      refresh: vi.fn(),
      onUpdate,
      onTransientError: vi.fn(),
      onTerminal,
    });

    scheduler.sync([job()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledOnce();
    scheduler.dispose();
    resolveObservation({ ...job(), status: 'succeeded' });
    await Promise.resolve();
    await Promise.resolve();

    expect(onUpdate).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });
});

describe('nextDelay', () => {
  it('applies bounded exponential backoff and jitter', () => {
    expect(nextDelay(1, () => 0)).toBe(2_000);
    expect(nextDelay(2, () => 1)).toBe(5_000);
    expect(nextDelay(99, () => 1)).toBe(37_500);
  });
});
