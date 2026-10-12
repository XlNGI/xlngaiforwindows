import { describe, expect, it } from 'vitest';
import { RequestScheduler } from './request-scheduler.js';

describe('RequestScheduler', () => {
  it('keeps local writes, cancellation, and task inspection available during media submission', async () => {
    const scheduler = new RequestScheduler();
    let release!: () => void;
    const submission = scheduler.run(
      'media.generation.confirmSubmission',
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(scheduler.run('chat.message.save', () => Promise.resolve('saved'))).resolves.toBe(
      'saved',
    );
    await expect(
      scheduler.run('media.task.cancel', () => Promise.resolve('cancelled')),
    ).resolves.toBe('cancelled');
    await expect(scheduler.run('task.log.list', () => Promise.resolve('tasks'))).resolves.toBe(
      'tasks',
    );
    await expect(
      scheduler.run('generation.job.events.list', () => Promise.resolve('events')),
    ).resolves.toBe('events');
    release();
    await submission;
  });

  it('allows reads to complete while a long background request is active', async () => {
    const scheduler = new RequestScheduler();
    let releaseBackup: (() => void) | undefined;
    const backup = scheduler.run(
      'project.backup',
      () => new Promise<void>((resolve) => (releaseBackup = resolve)),
    );

    await expect(scheduler.run('conversation.list', () => Promise.resolve('ready'))).resolves.toBe(
      'ready',
    );
    releaseBackup?.();
    await backup;
  });

  it('allows agent task inspection while a serialized mutation is active', async () => {
    const scheduler = new RequestScheduler();
    let releaseSave: (() => void) | undefined;
    const save = scheduler.run(
      'chat.message.save',
      () => new Promise<void>((resolve) => (releaseSave = resolve)),
    );

    await expect(scheduler.run('agent.task.get', () => Promise.resolve('task'))).resolves.toBe(
      'task',
    );
    await expect(
      scheduler.run('conversation.runtime.get', () => Promise.resolve('runtime')),
    ).resolves.toBe('runtime');
    releaseSave?.();
    await save;
  });

  it('serializes short mutations in submission order', async () => {
    const scheduler = new RequestScheduler();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = scheduler.run('chat.message.save', async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      events.push('first-end');
    });
    const second = scheduler.run('conversation.create', () => {
      events.push('second');
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('reports queue wait for serialized mutations', async () => {
    const waits: number[] = [];
    const scheduler = new RequestScheduler({
      onQueueWait: (_method, waitMs) => waits.push(waitMs),
    });
    let releaseFirst: (() => void) | undefined;
    const first = scheduler.run(
      'chat.message.save',
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const second = scheduler.run('conversation.create', () => Promise.resolve());

    await Promise.resolve();
    expect(waits).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[1]).toBeGreaterThanOrEqual(0);
  });
});
