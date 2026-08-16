export type WorkspacePaneId = 'editor' | 'production' | 'conversation';

export const DEFAULT_WORKSPACE_PANE_ORDER: WorkspacePaneId[] = [
  'editor',
  'production',
  'conversation',
];

const storagePrefix = 'ai-video.workspace-pane-order.v1:';

function storageKey(projectId: string | undefined): string {
  return `${storagePrefix}${projectId ?? 'no-project'}`;
}

function isPaneId(value: unknown): value is WorkspacePaneId {
  return value === 'editor' || value === 'production' || value === 'conversation';
}

export function readWorkspacePaneOrder(projectId: string | undefined): WorkspacePaneId[] {
  try {
    const raw = window.localStorage?.getItem(storageKey(projectId));
    if (!raw) return [...DEFAULT_WORKSPACE_PANE_ORDER];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_WORKSPACE_PANE_ORDER];
    const order = parsed.filter(isPaneId);
    return [...order, ...DEFAULT_WORKSPACE_PANE_ORDER.filter((paneId) => !order.includes(paneId))];
  } catch {
    return [...DEFAULT_WORKSPACE_PANE_ORDER];
  }
}

export function writeWorkspacePaneOrder(
  projectId: string | undefined,
  order: WorkspacePaneId[],
): void {
  try {
    window.localStorage?.setItem(storageKey(projectId), JSON.stringify(order));
  } catch {
    // The order remains available for the current session when storage is unavailable.
  }
}
