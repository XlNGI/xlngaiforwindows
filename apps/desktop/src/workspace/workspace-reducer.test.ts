import { describe, expect, it } from 'vitest';
import { clampBounds } from './workspace-geometry';
import { createDefaultWorkspaceLayout, workspaceReducer } from './workspace-reducer';

const viewport = { width: 1440, height: 900 };

describe('workspaceReducer', () => {
  it('focuses an existing floating panel without creating a duplicate', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    const next = workspaceReducer(layout, { type: 'focus', panelId: 'conversation' });

    expect(Object.keys(next.panels)).toEqual(['document', 'conversation']);
    expect(next.panels.conversation.zOrder).toBeGreaterThan(next.panels.document.zOrder);
  });

  it('restores a closed conversation in the right dock', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    const closed = workspaceReducer(layout, { type: 'close', panelId: 'conversation' });
    const reopened = workspaceReducer(closed, { type: 'open', panelId: 'conversation' });

    expect(reopened.panels.conversation).toMatchObject({ open: true, mode: 'docked' });
  });

  it('clamps floating windows inside the usable application area', () => {
    expect(
      clampBounds(
        { x: -100, y: -100, width: 2_000, height: 2_000 },
        { width: 800, height: 600 },
        { width: 360, height: 420 },
      ),
    ).toEqual({ x: 12, y: 48, width: 776, height: 540 });
  });

  it('restores the previous floating geometry after maximizing', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    const beforeMaximize = layout.panels.conversation.bounds;
    const maximized = workspaceReducer(layout, {
      type: 'maximize',
      panelId: 'conversation',
      viewport,
    });
    const restored = workspaceReducer(maximized, { type: 'restore', panelId: 'conversation' });

    expect(restored.panels.conversation).toMatchObject({
      mode: 'floating',
      bounds: beforeMaximize,
    });
  });

  it('keeps maximized panels matched to the workspace after a resize', () => {
    const layout = workspaceReducer(createDefaultWorkspaceLayout('project', viewport), {
      type: 'maximize',
      panelId: 'document',
      viewport,
    });
    const resized = workspaceReducer(layout, {
      type: 'clamp',
      viewport: { width: 900, height: 700 },
    });

    expect(resized.panels.document.bounds).toEqual({ x: 0, y: 36, width: 900, height: 664 });
  });
});
