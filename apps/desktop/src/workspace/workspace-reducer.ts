import {
  clampBounds,
  defaultConversationBounds,
  defaultDocumentBounds,
  maximizedBounds,
} from './workspace-geometry';
import type {
  FloatingBounds,
  WorkspaceLayoutState,
  WorkspacePanelId,
  WorkspaceViewport,
} from './workspace-types';

export type { WorkspaceLayoutState } from './workspace-types';

export type WorkspaceAction =
  | { type: 'hydrate'; state: WorkspaceLayoutState }
  | { type: 'open'; panelId: WorkspacePanelId }
  | { type: 'close'; panelId: WorkspacePanelId }
  | { type: 'focus'; panelId: WorkspacePanelId }
  | { type: 'float'; panelId: WorkspacePanelId }
  | { type: 'dock'; panelId: WorkspacePanelId }
  | { type: 'maximize'; panelId: WorkspacePanelId; viewport: WorkspaceViewport }
  | { type: 'restore'; panelId: WorkspacePanelId }
  | { type: 'setBounds'; panelId: WorkspacePanelId; bounds: FloatingBounds }
  | { type: 'clamp'; viewport: WorkspaceViewport }
  | { type: 'tile'; viewport: WorkspaceViewport }
  | { type: 'reset'; state: WorkspaceLayoutState };

export function createDefaultWorkspaceLayout(
  projectId: string | undefined,
  viewport: WorkspaceViewport,
): WorkspaceLayoutState {
  return {
    version: 1,
    projectId,
    activePanelId: 'conversation',
    panels: {
      document: {
        id: 'document',
        mode: 'docked',
        dockTarget: 'center',
        bounds: defaultDocumentBounds(viewport),
        zOrder: 1,
        open: true,
      },
      conversation: {
        id: 'conversation',
        mode: 'docked',
        dockTarget: 'right',
        bounds: defaultConversationBounds(viewport),
        zOrder: 2,
        open: true,
      },
    },
  };
}

export function workspaceReducer(
  state: WorkspaceLayoutState,
  action: WorkspaceAction,
): WorkspaceLayoutState {
  if (action.type === 'hydrate' || action.type === 'reset') return action.state;
  if (action.type === 'clamp') return clampWorkspace(state, action.viewport);
  if (action.type === 'tile') return tileWorkspace(state, action.viewport);

  const panel = state.panels[action.panelId];
  const highest = Math.max(...Object.values(state.panels).map((item) => item.zOrder));
  const nextPanel = { ...panel };

  if (action.type === 'open') {
    nextPanel.open = true;
    nextPanel.zOrder = highest + 1;
  } else if (action.type === 'close') {
    nextPanel.open = false;
  } else if (action.type === 'focus') {
    nextPanel.zOrder = highest + 1;
  } else if (action.type === 'float') {
    nextPanel.open = true;
    nextPanel.mode = 'floating';
    nextPanel.zOrder = highest + 1;
  } else if (action.type === 'dock') {
    nextPanel.open = true;
    nextPanel.mode = 'docked';
  } else if (action.type === 'maximize') {
    nextPanel.open = true;
    if (nextPanel.mode !== 'maximized') nextPanel.restoreBounds = nextPanel.bounds;
    nextPanel.mode = 'maximized';
    nextPanel.bounds = maximizedBounds(action.viewport);
    nextPanel.zOrder = highest + 1;
  } else if (action.type === 'restore') {
    nextPanel.mode = 'floating';
    nextPanel.bounds = nextPanel.restoreBounds ?? nextPanel.bounds;
    nextPanel.restoreBounds = undefined;
    nextPanel.zOrder = highest + 1;
  } else if (action.type === 'setBounds') {
    nextPanel.bounds = action.bounds;
  }

  return normalizeZOrder({
    ...state,
    activePanelId: action.type === 'close' ? state.activePanelId : action.panelId,
    panels: { ...state.panels, [action.panelId]: nextPanel },
  });
}

function clampWorkspace(
  state: WorkspaceLayoutState,
  viewport: WorkspaceViewport,
): WorkspaceLayoutState {
  return {
    ...state,
    panels: {
      document: {
        ...state.panels.document,
        bounds:
          state.panels.document.mode === 'maximized'
            ? maximizedBounds(viewport)
            : clampBounds(state.panels.document.bounds, viewport, { width: 560, height: 400 }),
      },
      conversation: {
        ...state.panels.conversation,
        bounds:
          state.panels.conversation.mode === 'maximized'
            ? maximizedBounds(viewport)
            : clampBounds(state.panels.conversation.bounds, viewport, {
                width: 360,
                height: 420,
              }),
      },
    },
  };
}

function tileWorkspace(
  state: WorkspaceLayoutState,
  viewport: WorkspaceViewport,
): WorkspaceLayoutState {
  const documentWidth = Math.max(560, Math.floor((viewport.width - 48) * 0.62));
  const conversationWidth = Math.max(360, viewport.width - documentWidth - 36);
  return clampWorkspace(
    {
      ...state,
      panels: {
        document: {
          ...state.panels.document,
          open: true,
          mode: 'floating',
          bounds: { x: 12, y: 48, width: documentWidth, height: viewport.height - 60 },
        },
        conversation: {
          ...state.panels.conversation,
          open: true,
          mode: 'floating',
          bounds: {
            x: documentWidth + 24,
            y: 48,
            width: conversationWidth,
            height: viewport.height - 60,
          },
        },
      },
    },
    viewport,
  );
}

function normalizeZOrder(state: WorkspaceLayoutState): WorkspaceLayoutState {
  const ordered = Object.values(state.panels)
    .sort((left, right) => left.zOrder - right.zOrder)
    .map((panel, index) => ({ ...panel, zOrder: index + 1 }));
  return {
    ...state,
    panels: {
      document: ordered.find((panel) => panel.id === 'document')!,
      conversation: ordered.find((panel) => panel.id === 'conversation')!,
    },
  };
}
