import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultWorkspaceLayout } from './workspace-reducer';
import {
  readWorkspaceLayout,
  workspaceStorageKey,
  writeWorkspaceLayout,
} from './workspace-storage';

describe('workspace storage', () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map<string, string>();
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

  afterEach(() => values.clear());

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
});
