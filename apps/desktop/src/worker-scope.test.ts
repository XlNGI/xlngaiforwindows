import { afterEach, expect, it, vi } from 'vitest';
import { callWorker } from './worker-client';
import {
  forgetWorkerScope,
  projectWorker,
  selectWorkerScope,
  workerMediaUrl,
  workerScope,
  WORKER_SCOPE_STALE_EVENT,
} from './worker-scope';
vi.mock('./worker-client', () => ({ callWorker: vi.fn(() => Promise.resolve([])) }));
afterEach(() => {
  forgetWorkerScope('A');
  forgetWorkerScope('B');
  vi.clearAllMocks();
});

it('announces an invalid epoch without replaying a write under a new scope', async () => {
  const a = { projectId: 'A', projectSessionId: 'old' };
  selectWorkerScope(a);
  const client = projectWorker();
  const stale = Object.assign(new Error('Project runtime scope is stale or unavailable.'), {
    workerError: { code: 'STALE_SESSION' },
  });
  vi.mocked(callWorker).mockRejectedValueOnce(stale);
  const events: unknown[] = [];
  const listener = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener(WORKER_SCOPE_STALE_EVENT, listener);
  try {
    await expect(
      client('document.save', { kind: 'note', title: 'original', contentMarkdown: 'text' }),
    ).rejects.toBe(stale);
    expect(events).toEqual([a]);
    expect(callWorker).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(WORKER_SCOPE_STALE_EVENT, listener);
  }
});
it('freezes follow-up RPC ownership across activation, unload and a new epoch', async () => {
  const a = { projectId: 'A', projectSessionId: 'epoch-1' };
  selectWorkerScope(a);
  const clientA = projectWorker();
  selectWorkerScope({ projectId: 'B', projectSessionId: 'epoch-B' });
  const clientB = projectWorker();
  forgetWorkerScope('A');
  selectWorkerScope({ projectId: 'A', projectSessionId: 'epoch-2' });
  await clientA('document.list', {});
  await clientB('document.list', {});
  expect(callWorker).toHaveBeenNthCalledWith(1, 'document.list', {}, a);
  expect(callWorker).toHaveBeenNthCalledWith(
    2,
    'document.list',
    {},
    { projectId: 'B', projectSessionId: 'epoch-B' },
  );
  expect(workerScope('A')?.projectSessionId).toBe('epoch-2');
  expect(workerMediaUrl('image', false, a)).toBe(
    '/worker-media/image?projectId=A&projectSessionId=epoch-1',
  );
  await clientA('project.runtime.list', {});
  expect(callWorker).toHaveBeenLastCalledWith('project.runtime.list', {});
});
