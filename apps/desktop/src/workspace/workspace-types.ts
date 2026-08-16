export type WorkspacePanelId = 'document' | 'conversation';

export type WorkspacePanelMode = 'docked' | 'floating' | 'maximized';

export type WorkspaceDockTarget = 'center' | 'right';

export interface FloatingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspacePanelState {
  id: WorkspacePanelId;
  mode: WorkspacePanelMode;
  dockTarget: WorkspaceDockTarget;
  bounds: FloatingBounds;
  restoreBounds?: FloatingBounds;
  zOrder: number;
  open: boolean;
}

export interface WorkspaceLayoutState {
  version: 1;
  projectId?: string;
  activePanelId?: WorkspacePanelId;
  panels: Record<WorkspacePanelId, WorkspacePanelState>;
}

export interface WorkspaceViewport {
  width: number;
  height: number;
}
