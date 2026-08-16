import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DetachedPanelEnvelope, DetachedPanelSnapshot } from './detached-window';
import { DetachedPanelApp } from './DetachedPanelApp';

const eventApi = vi.hoisted(() => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    eventApi.listeners.set(event, handler);
    return Promise.resolve(() => eventApi.listeners.delete(event));
  }),
}));

const windowApi = vi.hoisted(() => ({ close: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: eventApi.emitTo,
  listen: eventApi.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApi,
}));

describe('DetachedPanelApp', () => {
  it('renders a document snapshot and forwards edits and reattach actions to main', async () => {
    render(
      <DetachedPanelApp
        config={{
          panelId: 'document',
          projectId: 'project',
          entityId: 'document',
          label: 'workspace-document-project-document',
          sessionId: 'workspace-document-project-document',
        }}
      />,
    );

    await waitFor(() =>
      expect(eventApi.emitTo).toHaveBeenCalledWith(
        'main',
        'workspace-panel-ready',
        expect.anything(),
      ),
    );
    const snapshot: DetachedPanelSnapshot = {
      panelId: 'document',
      projectId: 'project',
      projectName: 'Project',
      documentId: 'document',
      title: 'Outline',
      kind: 'outline',
      content: '# Draft',
      state: 'draft',
      writable: true,
      busy: false,
      statusMessage: '',
      versions: [
        {
          id: 'version-1',
          documentId: 'document',
          version: 1,
          contentMarkdown: '# Draft',
          state: 'draft',
          titleSnapshot: 'Outline',
          authorType: 'user',
          createdAt: 'now',
        },
      ],
      currentVersionId: 'version-1',
      rowVersion: 1,
    };
    const envelope: DetachedPanelEnvelope<DetachedPanelSnapshot> = {
      label: 'workspace-document-project-document',
      payload: snapshot,
    };
    act(() => {
      eventApi.listeners.get('workspace-panel-snapshot')?.({ payload: envelope });
    });

    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 1,
      payload: { panelId: 'document', type: 'document-submit-review' },
    });

    fireEvent.change(screen.getByDisplayValue('Outline'), { target: { value: 'Outline 2' } });
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 2,
      payload: { panelId: 'document', type: 'document-title', value: 'Outline 2' },
    });
    expect(screen.queryByLabelText('类型')).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: '提交审核' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '附加' }));
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 3,
      payload: { panelId: 'document', type: 'attach' },
    });
    expect(windowApi.close).toHaveBeenCalledOnce();
  });

  it('ignores stale or mismatched snapshots from another detached session', async () => {
    const config = {
      panelId: 'document' as const,
      projectId: 'project',
      entityId: 'document',
      label: 'workspace-document-project-document',
      sessionId: 'workspace-document-project-document',
    };
    render(<DetachedPanelApp config={config} />);
    const listener = eventApi.listeners.get('workspace-panel-snapshot');
    const snapshot: DetachedPanelSnapshot = {
      panelId: 'document',
      projectId: 'project',
      projectName: 'Project',
      documentId: 'document',
      title: 'Current title',
      kind: 'note',
      content: 'Current body',
      state: 'draft',
      writable: true,
      busy: false,
      statusMessage: '',
      versions: [],
      rowVersion: 1,
    };

    act(() => {
      listener?.({
        payload: {
          label: config.label,
          projectId: config.projectId,
          entityId: config.entityId,
          sequence: 4,
          payload: snapshot,
        },
      });
    });
    expect(await screen.findByDisplayValue('Current title')).toBeInTheDocument();

    act(() => {
      listener?.({
        payload: {
          label: config.label,
          projectId: config.projectId,
          entityId: config.entityId,
          sequence: 3,
          payload: { ...snapshot, title: 'Old title' },
        },
      });
      listener?.({
        payload: {
          label: config.label,
          projectId: config.projectId,
          entityId: 'other-document',
          sequence: 5,
          payload: { ...snapshot, documentId: 'other-document', title: 'Other title' },
        },
      });
    });

    expect(screen.getByDisplayValue('Current title')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Old title')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Other title')).not.toBeInTheDocument();
  });
});
