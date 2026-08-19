import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChangeSetInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { ChangeSetReviewPanel } from './ChangeSetReviewPanel';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));

const proposal: AgentChangeSetInfo = {
  id: 'change-set-1',
  projectId: 'project-1',
  title: 'Opening proposal',
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
      title: 'Scene 01',
      status: 'pending',
    },
    {
      id: 'item-2',
      ordinal: 1,
      entityType: 'shot',
      action: 'create',
      parentItemOrdinal: 0,
      title: 'Wide shot',
      shotStatus: 'planned',
      status: 'pending',
    },
  ],
};

describe('ChangeSetReviewPanel', () => {
  beforeEach(() => {
    vi.mocked(callWorker).mockReset();
  });

  it('reviews a selected item with the proposal row version', async () => {
    const applied = {
      ...proposal,
      status: 'partially_applied' as const,
      rowVersion: 3,
      items: [{ ...proposal.items[0]!, status: 'applied' as const }, proposal.items[1]!],
    };
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'agent.changeSet.list') return Promise.resolve([proposal]);
      if (method === 'agent.changeSet.apply') return Promise.resolve(applied);
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });

    render(<ChangeSetReviewPanel projectId="project-1" writable />);
    expect(await screen.findByText('Opening proposal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Opening proposal/i }));
    const sceneCheckbox = await screen.findByRole('checkbox', { name: 'Select scene Scene 01' });
    fireEvent.click(sceneCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.changeSet.apply', {
        changeSetId: 'change-set-1',
        expectedRowVersion: 2,
        itemIds: ['item-1'],
      }),
    );
    expect(await screen.findByText('Selected proposal changes applied.')).toBeInTheDocument();
  });

  it('does not render without a project or pending proposal', async () => {
    vi.mocked(callWorker).mockResolvedValue([]);
    const { container } = render(<ChangeSetReviewPanel writable projectId="project-1" />);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.changeSet.list', { includeTerminal: false }),
    );
    expect(container.firstChild).toBeNull();
  });
});
