import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChangeSetInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { GeneratedDraftSync } from './GeneratedDraftSync';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));

const proposal: AgentChangeSetInfo = {
  id: 'change-set-1',
  projectId: 'project-1',
  title: '旧版生成内容',
  status: 'proposed',
  rowVersion: 2,
  createdAt: 'now',
  updatedAt: 'now',
  items: [
    {
      id: 'item-1',
      ordinal: 0,
      entityType: 'scene',
      action: 'create',
      title: '庭院',
      status: 'pending',
    },
  ],
};
const saved: AgentChangeSetInfo = {
  ...proposal,
  status: 'applied',
  rowVersion: 3,
  items: [{ ...proposal.items[0]!, status: 'applied', appliedEntityId: 'scene-1' }],
};

describe('GeneratedDraftSync', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(callWorker).mockReset();
  });

  it('saves existing proposals automatically and leaves no review panel after saving', async () => {
    const onSaved = vi.fn();
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'agent.changeSet.list') return Promise.resolve([proposal]);
      if (method === 'agent.changeSet.apply') return Promise.resolve(saved);
      throw new Error(`Unexpected method ${method}`);
    });
    const { container } = render(
      <GeneratedDraftSync projectId="project-1" writable onSaved={onSaved} />,
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(callWorker).toHaveBeenCalledWith('agent.changeSet.apply', {
      changeSetId: proposal.id,
      expectedRowVersion: 2,
    });
    expect(container.firstChild).toBeNull();
  });

  it('shows a conflict without requesting approval or overwriting the current content', async () => {
    const onSaved = vi.fn();
    vi.mocked(callWorker).mockImplementation((method) =>
      Promise.resolve(
        method === 'agent.changeSet.list' ? [proposal] : { ...proposal, status: 'conflicted' },
      ),
    );
    render(<GeneratedDraftSync projectId="project-1" writable onSaved={onSaved} />);
    expect(await screen.findByRole('status')).toHaveTextContent('部分生成内容与当前版本冲突');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not save in a read-only project', () => {
    render(<GeneratedDraftSync projectId="project-1" writable={false} />);
    expect(callWorker).not.toHaveBeenCalled();
  });

  it('can retry a failed save on refresh without requiring approval', async () => {
    const onSaved = vi.fn();
    let attempts = 0;
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'agent.changeSet.list') return Promise.resolve([proposal]);
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('保存连接中断')) : Promise.resolve(saved);
    });
    const { rerender } = render(
      <GeneratedDraftSync projectId="project-1" writable onSaved={onSaved} />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('保存连接中断');
    rerender(
      <GeneratedDraftSync projectId="project-1" writable refreshRevision={1} onSaved={onSaved} />,
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(attempts).toBe(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not repeat in-flight writes and ignores refreshes from a previous project', async () => {
    let finish!: (value: AgentChangeSetInfo) => void;
    const applying = new Promise<AgentChangeSetInfo>((resolve) => {
      finish = resolve;
    });
    const onSaved = vi.fn();
    vi.mocked(callWorker).mockImplementation((method) =>
      method === 'agent.changeSet.list' ? Promise.resolve([proposal]) : applying,
    );
    const { rerender } = render(
      <GeneratedDraftSync projectId="project-1" writable onSaved={onSaved} />,
    );
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.changeSet.apply', expect.anything()),
    );
    rerender(
      <GeneratedDraftSync projectId="project-1" writable refreshRevision={1} onSaved={onSaved} />,
    );
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.changeSet.list'),
      ).toHaveLength(2),
    );
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.changeSet.apply'),
    ).toHaveLength(1);
    rerender(<GeneratedDraftSync projectId="project-2" writable={false} onSaved={onSaved} />);
    finish(saved);
    await applying;
    expect(onSaved).not.toHaveBeenCalled();
  });
});
