import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTaskSnapshot } from '@ai-video/contracts';
import { useProjectTaskSubscription } from './use-project-task-subscription';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));

const snapshot = (revision: number, activeCount: number): ProjectTaskSnapshot => ({
  projectId: 'project',
  projectSessionId: 'session',
  revision,
  changed: true,
  activeCount,
  videoJobs: [],
});

describe('useProjectTaskSubscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(callWorker).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('uses one revisioned subscription owner and refreshes active work every second', async () => {
    vi.mocked(callWorker)
      .mockResolvedValueOnce(snapshot(1, 1))
      .mockResolvedValueOnce({ ...snapshot(1, 1), changed: false })
      .mockResolvedValueOnce(snapshot(2, 0));
    const { result } = renderHook(() => useProjectTaskSubscription('project'));

    await act(() => Promise.resolve());
    expect(result.current?.revision).toBe(1);
    expect(callWorker).toHaveBeenLastCalledWith('project.task.subscribe', { afterRevision: -1 });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(callWorker).toHaveBeenLastCalledWith('project.task.subscribe', { afterRevision: 1 });
    expect(result.current?.revision).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current?.revision).toBe(2);
  });

  it('stops the old session and ignores snapshots from another project', async () => {
    vi.mocked(callWorker).mockResolvedValue(snapshot(1, 0));
    const initialProps: { projectId?: string } = { projectId: 'project' };
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId?: string }) => useProjectTaskSubscription(projectId),
      { initialProps },
    );
    await act(() => Promise.resolve());
    expect(result.current?.projectId).toBe('project');

    vi.mocked(callWorker).mockResolvedValue({ ...snapshot(2, 0), projectId: 'stale' });
    rerender({ projectId: undefined });
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(result.current).toBeUndefined();
    expect(callWorker).toHaveBeenCalledTimes(1);
  });
});
