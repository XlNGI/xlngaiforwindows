import { describe, expect, it, vi } from 'vitest';
import { AgentResourceRefresh } from './agent-resource-refresh';

const changes = (documentSequence: number, productionSequence = 0) => ({
  sequence: Math.max(documentSequence, productionSequence),
  documentSequence,
  productionSequence,
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('committed Agent resource refresh', () => {
  it('refreshes running changes, coalesces arrivals and acknowledges only successful refreshes', async () => {
    const tracker = new AgentResourceRefresh();
    let release!: () => void;
    const refresh = vi
      .fn<(kind: 'documentSequence' | 'productionSequence') => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    tracker.observe('p:session', 'task', changes(1), refresh);
    tracker.observe('p:session', 'task', changes(3, 4), refresh);
    release();
    await settle();
    expect(refresh.mock.calls.map((c) => c[0])).toEqual([
      'documentSequence',
      'documentSequence',
      'productionSequence',
    ]);
    tracker.observe('p:session', 'task', changes(3, 4), refresh);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(3);
    refresh.mockRejectedValueOnce(new Error('disconnected'));
    tracker.observe('p:session', 'task', changes(5, 4), refresh);
    await settle();
    tracker.observe('p:session', 'task', changes(5, 4), refresh);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(5);
  });
  it('does not acknowledge an old project/session after a switch', async () => {
    const tracker = new AgentResourceRefresh();
    let release!: () => void;
    const old = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    tracker.observe('p:old', 'task', changes(10), old);
    const current = vi.fn().mockResolvedValue(undefined);
    tracker.observe('p:new', 'task', changes(10), current);
    release();
    await settle();
    tracker.observe('p:new', 'task', changes(10), current);
    await settle();
    expect(current).toHaveBeenCalledOnce();
  });
});
