import { describe, expect, it } from 'vitest';
import { RequestScheduler } from './request-scheduler.js';

describe('RequestScheduler', () => {
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
});
