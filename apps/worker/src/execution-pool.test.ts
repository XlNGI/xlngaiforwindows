import { expect, it } from 'vitest';
import { ExecutionPool } from './execution-pool.js';

it('bounds actual text overlap to 2/project and 4/app, removes cancelled waiters, and makes progress across projects', async () => {
  const pool = new ExecutionPool();
  const releases = new Map<string, () => void>();
  const active = new Set<string>();
  let peak = 0;
  const start = (owner: string, id: string, signal?: AbortSignal) =>
    pool.run('text', owner, signal, async () => {
      active.add(id);
      peak = Math.max(peak, active.size);
      expect([...active].filter((item) => item.startsWith(owner)).length).toBeLessThanOrEqual(2);
      await new Promise<void>((resolve) => releases.set(id, resolve));
      active.delete(id);
    });
  const a1 = start('A', 'A1'),
    a2 = start('A', 'A2'),
    a3 = start('A', 'A3');
  const b1 = start('B', 'B1'),
    b2 = start('B', 'B2');
  const controller = new AbortController();
  const cancelled = start('C', 'C1', controller.signal);
  controller.abort(new Error('cancel queued'));
  await expect(cancelled).rejects.toThrow('cancel queued');
  expect(active.size).toBe(4);
  expect(active.has('A3')).toBe(false);
  releases.get('A1')!();
  await a1;
  expect(active.has('A3')).toBe(true);
  expect(active.has('C1')).toBe(false);
  for (const release of releases.values()) release();
  await Promise.all([a2, a3, b1, b2]);
  expect(peak).toBe(4);
});

it('releases execution slots during human confirmation and reacquires fairly before resuming', async () => {
  const pool = new ExecutionPool(),
    decisions = new Map<string, () => void>(),
    started: string[] = [],
    resumed: string[] = [];
  const tasks = Array.from({ length: 8 }, (_, index) =>
    pool.run('text', index % 2 ? 'B' : 'A', undefined, async (lease) => {
      const id = String(index);
      started.push(id);
      await lease.suspend(() => new Promise<void>((resolve) => decisions.set(id, resolve)));
      resumed.push(id);
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(started).toHaveLength(8);
  expect(resumed).toEqual([]);
  const extra = pool.run('text', 'C', undefined, () => Promise.resolve('C progressed'));
  expect(await extra).toBe('C progressed');
  for (const decide of decisions.values()) decide();
  await Promise.all(tasks);
  expect(new Set(resumed).size).toBe(8);
});

it('makes bounded progress for all projects under mixed stage pressure with no leaked permits', async () => {
  const pool = new ExecutionPool(),
    counts = new Map<string, number>(),
    active = new Map<string, number>();
  let maximum = 0,
    total = 0;
  const tasks = Array.from({ length: 80 }, (_, index) => {
    const owner = String(index % 4);
    return pool.run('text', owner, undefined, async () => {
      total += 1;
      maximum = Math.max(maximum, total);
      active.set(owner, (active.get(owner) ?? 0) + 1);
      expect(active.get(owner)).toBeLessThanOrEqual(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
      total -= 1;
      active.set(owner, active.get(owner)! - 1);
    });
  });
  await Promise.all(tasks);
  expect([...counts.values()]).toEqual([20, 20, 20, 20]);
  expect(maximum).toBe(4);
  expect(await pool.run('text', 'after-pressure', undefined, () => Promise.resolve(true))).toBe(
    true,
  );
});
