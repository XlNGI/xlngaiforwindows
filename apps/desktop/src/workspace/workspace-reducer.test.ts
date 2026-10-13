import { describe, expect, it } from 'vitest';
import { clampBounds } from './workspace-geometry';
import { createDefaultWorkspaceLayout, workspaceReducer } from './workspace-reducer';

const viewport = { width: 1440, height: 900 };

describe('workspaceReducer', () => {
  it('focuses an existing floating panel without creating a duplicate', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    const next = workspaceReducer(layout, { type: 'focus', panelId: 'conversation' });

    expect(Object.keys(next.panels)).toEqual(['document', 'assets', 'conversation']);
    expect(next.panels.conversation.zOrder).toBeGreaterThan(next.panels.document.zOrder);
  });

  it('restores a closed conversation in the right dock', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    const closed = workspaceReducer(layout, { type: 'close', panelId: 'conversation' });
    const reopened = workspaceReducer(closed, { type: 'open', panelId: 'conversation' });

    expect(reopened.panels.conversation).toMatchObject({ open: true, mode: 'docked' });
  });

  it('opens assets alongside the document and conversation without replacing either panel', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    expect(layout.panels.assets).toMatchObject({
      open: false,
      mode: 'docked',
      dockTarget: 'center',
    });

    const opened = workspaceReducer(layout, { type: 'open', panelId: 'assets' });
    expect(opened.panels.assets).toMatchObject({ open: true, mode: 'docked' });
    expect(opened.panels.document.open).toBe(true);
    expect(opened.panels.conversation.open).toBe(true);
    expect(opened.activePanelId).toBe('assets');
    expect(opened.panels.assets.zOrder).toBeGreaterThan(opened.panels.document.zOrder);
    expect(opened.panels.assets.zOrder).toBeGreaterThan(opened.panels.conversation.zOrder);

    const focused = workspaceReducer(opened, { type: 'focus', panelId: 'document' });
    expect(focused.panels.assets.open).toBe(true);
    expect(focused.panels.document.zOrder).toBeGreaterThan(focused.panels.assets.zOrder);

    const closed = workspaceReducer(focused, { type: 'close', panelId: 'assets' });
    expect(closed.panels.assets.open).toBe(false);
    expect(closed.panels.document.open).toBe(true);
  });

  it('floats, maximizes, restores, and docks assets while retaining the other panels', () => {
    const layout = createDefaultWorkspaceLayout('project', viewport);
    const floating = workspaceReducer(layout, { type: 'float', panelId: 'assets' });
    const beforeMaximize = floating.panels.assets.bounds;
    const maximized = workspaceReducer(floating, { type: 'maximize', panelId: 'assets', viewport });
    expect(maximized.panels.assets).toMatchObject({
      open: true,
      mode: 'maximized',
      bounds: { x: 0, y: 36, width: 1440, height: 864 },
    });

    const restored = workspaceReducer(maximized, { type: 'restore', panelId: 'assets' });
    expect(restored.panels.assets).toMatchObject({ mode: 'floating', bounds: beforeMaximize });
    const docked = workspaceReducer(restored, { type: 'dock', panelId: 'assets' });
    expect(docked.panels.assets).toMatchObject({ mode: 'docked', dockTarget: 'center' });
    expect(docked.panels.document.bounds).toEqual(layout.panels.document.bounds);
    expect(docked.panels.conversation.bounds).toEqual(layout.panels.conversation.bounds);
  });

  it('preserves and clamps an open asset panel when tiling the main panels', () => {
    const layout = workspaceReducer(createDefaultWorkspaceLayout('project', viewport), {
      type: 'float',
      panelId: 'assets',
    });
    const offscreen = workspaceReducer(layout, {
      type: 'setBounds',
      panelId: 'assets',
      bounds: { x: 1300, y: 800, width: 100, height: 100 },
    });
    const tiled = workspaceReducer(offscreen, {
      type: 'tile',
      viewport: { width: 800, height: 600 },
    });

    expect(tiled.panels.assets).toMatchObject({
      open: true,
      mode: 'floating',
      bounds: { x: 228, y: 188, width: 560, height: 400 },
    });
    expect(tiled.panels.document.open).toBe(true);
    expect(tiled.panels.conversation.open).toBe(true);
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

  it('keeps maximized assets usable on narrow viewports', () => {
    const layout = workspaceReducer(createDefaultWorkspaceLayout('project', viewport), {
      type: 'maximize',
      panelId: 'assets',
      viewport,
    });
    const resized = workspaceReducer(layout, {
      type: 'clamp',
      viewport: { width: 390, height: 844 },
    });
    expect(resized.panels.assets.bounds).toEqual({ x: 0, y: 36, width: 390, height: 808 });
    expect(Object.keys(resized.panels)).toHaveLength(3);
  });
});
