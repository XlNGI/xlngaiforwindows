import { expect, it } from 'vitest';
import type { AgentToolConfirmationRequest } from '@ai-video/contracts';
import { TaskConfirmationQueue, type TaskConfirmation } from './task-confirmations';

const request = (token: string) => ({ confirmationToken: token }) as AgentToolConfirmationRequest;
it('keeps concurrent confirmations independent, coalesces replay and ignores stale decisions', async () => {
  let items: TaskConfirmation[] = [];
  const queue = new TaskConfirmationQueue((next) => {
    items = next;
  });
  const a = queue.request('A', 'Project A', 'tool', request('token'));
  const b = queue.request('B', 'Project B', 'tool', request('token'));
  expect(queue.request('A', 'Project A', 'tool', request('token'))).toBe(a);
  expect(items.map((item) => item.owner)).toEqual(['A', 'B']);
  const oldKey = items[0]!.key;
  queue.removeOwner('A');
  await expect(a).resolves.toBe(false);
  let resolvedB = false;
  void b.then(() => {
    resolvedB = true;
  });
  queue.decide(oldKey, true);
  await Promise.resolve();
  expect(resolvedB).toBe(false);
  expect(items[0]?.label).toBe('Project B');
  queue.decide(items[0]!.key, true);
  await expect(b).resolves.toBe(true);
  expect(items).toEqual([]);
});
