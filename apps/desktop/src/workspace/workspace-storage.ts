import type { FloatingBounds, WorkspaceLayoutState, WorkspacePanelState } from './workspace-types';

const STORAGE_PREFIX = 'ai-video.workspace-layout.v1';

export function workspaceStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

export function readWorkspaceLayout(projectId: string): WorkspaceLayoutState | undefined {
  try {
    const raw = window.localStorage.getItem(workspaceStorageKey(projectId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WorkspaceLayoutState;
    if (parsed.version !== 1 || parsed.projectId !== projectId || !isValidPanelSet(parsed.panels)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isValidPanelSet(value: unknown): value is WorkspaceLayoutState['panels'] {
  if (!value || typeof value !== 'object') return false;
  const panels = value as Record<string, unknown>;
  return (
    isValidPanel(panels.document, 'document') && isValidPanel(panels.conversation, 'conversation')
  );
}

function isValidPanel(value: unknown, id: WorkspacePanelState['id']): value is WorkspacePanelState {
  if (!value || typeof value !== 'object') return false;
  const panel = value as Partial<WorkspacePanelState>;
  return (
    panel.id === id &&
    (panel.mode === 'docked' || panel.mode === 'floating' || panel.mode === 'maximized') &&
    (panel.dockTarget === 'center' || panel.dockTarget === 'right') &&
    typeof panel.open === 'boolean' &&
    typeof panel.zOrder === 'number' &&
    Number.isFinite(panel.zOrder) &&
    isValidBounds(panel.bounds)
  );
}

function isValidBounds(value: unknown): value is FloatingBounds {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Partial<FloatingBounds>;
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(
    (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
  );
}

export function writeWorkspaceLayout(layout: WorkspaceLayoutState): void {
  if (!layout.projectId) return;
  try {
    window.localStorage.setItem(workspaceStorageKey(layout.projectId), JSON.stringify(layout));
  } catch {
    // Layout is a non-critical local preference.
  }
}
