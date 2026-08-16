import { afterEach, describe, expect, it } from 'vitest';
import { detachedPanelLabel, parseDetachedPanelConfig } from './detached-window';

describe('detached window configuration', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('creates stable Tauri-safe labels for panel entities', () => {
    expect(detachedPanelLabel('document', 'project:one', 'document/one')).toBe(
      'workspace-document-project-one-document-one',
    );
  });

  it('parses a detached panel route and rejects an ordinary app route', () => {
    expect(parseDetachedPanelConfig()).toBeUndefined();
    window.history.replaceState(
      {},
      '',
      '/?workspacePanel=conversation&projectId=project&entityId=conversation&windowLabel=workspace-conversation-project',
    );

    expect(parseDetachedPanelConfig()).toEqual({
      panelId: 'conversation',
      projectId: 'project',
      entityId: 'conversation',
      label: 'workspace-conversation-project',
      sessionId: 'workspace-conversation-project',
    });
  });
});
