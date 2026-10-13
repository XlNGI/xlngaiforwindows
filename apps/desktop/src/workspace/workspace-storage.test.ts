import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultWorkspaceLayout } from './workspace-reducer';
import { readWorkspacePaneOrder, writeWorkspacePaneOrder } from './workspace-pane-order';
import {
  readWorkspaceLayout,
  workspaceStorageKey,
  writeWorkspaceLayout,
} from './workspace-storage';

describe('workspace storage', () => {
  let values: Map<string, string>;
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    values = new Map<string, string>();
    originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  afterEach(() => {
    values.clear();
    if (originalLocalStorage) {
      Object.defineProperty(window, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(window, 'localStorage');
    }
  });

  it('isolates persisted layout by project id', () => {
    const layout = createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 });
    layout.panels.conversation.open = false;
    writeWorkspaceLayout(layout);

    expect(readWorkspaceLayout('project-a')?.panels.conversation.open).toBe(false);
    expect(readWorkspaceLayout('project-b')).toBeUndefined();
  });

  it('rejects malformed stored bounds', () => {
    window.localStorage.setItem(
      workspaceStorageKey('project-a'),
      JSON.stringify({
        ...createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 }),
        panels: {
          ...createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 }).panels,
          conversation: {
            ...createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 }).panels
              .conversation,
            bounds: { x: Number.NaN, y: 12, width: 400, height: 500 },
          },
        },
      }),
    );

    expect(readWorkspaceLayout('project-a')).toBeUndefined();
  });

  it('adds a closed docked asset panel to legacy v1 layouts without changing saved panels', () => {
    const layout = createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 });
    layout.panels.document.mode = 'floating';
    layout.panels.document.bounds = { x: 100, y: 120, width: 800, height: 500 };
    layout.panels.conversation.open = false;
    window.localStorage.setItem(
      workspaceStorageKey('project-a'),
      JSON.stringify({
        ...layout,
        panels: { document: layout.panels.document, conversation: layout.panels.conversation },
      }),
    );

    const restored = readWorkspaceLayout('project-a');
    expect(restored?.panels.assets).toMatchObject({
      id: 'assets',
      mode: 'docked',
      dockTarget: 'center',
      open: false,
    });
    expect(restored?.panels.document).toEqual(layout.panels.document);
    expect(restored?.panels.conversation).toEqual(layout.panels.conversation);
    expect(restored?.activePanelId).toBe(layout.activePanelId);
  });

  it('restores the independent asset panel visibility and floating bounds', () => {
    const layout = createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 });
    layout.panels.assets.open = true;
    layout.panels.assets.mode = 'floating';
    layout.panels.assets.bounds = { x: 240, y: 120, width: 720, height: 560 };
    layout.activePanelId = 'assets';
    writeWorkspaceLayout(layout);

    expect(readWorkspaceLayout('project-a')).toEqual(layout);
  });

  it('rejects invalid asset panel state instead of treating it as a legacy layout', () => {
    const layout = createDefaultWorkspaceLayout('project-a', { width: 1440, height: 900 });
    window.localStorage.setItem(
      workspaceStorageKey('project-a'),
      JSON.stringify({
        ...layout,
        panels: { ...layout.panels, assets: { ...layout.panels.assets, mode: 'invalid' } },
      }),
    );

    expect(readWorkspaceLayout('project-a')).toBeUndefined();
  });

  it('adds assets before the conversation when upgrading the legacy pane order', () => {
    writeWorkspacePaneOrder('project-a', ['production', 'editor', 'conversation']);

    expect(readWorkspacePaneOrder('project-a')).toEqual([
      'production',
      'editor',
      'assets',
      'conversation',
    ]);
    expect(readWorkspacePaneOrder('project-b')).toEqual([
      'editor',
      'production',
      'assets',
      'conversation',
    ]);
  });

  it('keeps customized asset pane order without duplicating panes', () => {
    writeWorkspacePaneOrder('project-a', [
      'assets',
      'editor',
      'assets',
      'production',
      'conversation',
    ]);

    expect(readWorkspacePaneOrder('project-a')).toEqual([
      'assets',
      'editor',
      'production',
      'conversation',
    ]);
  });
});
