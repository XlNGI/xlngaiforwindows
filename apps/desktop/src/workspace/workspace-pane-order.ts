export type WorkspacePaneId = 'editor' | 'production' | 'assets' | 'conversation';

export const DEFAULT_WORKSPACE_PANE_ORDER: WorkspacePaneId[] = [
  'editor',
  'production',
  'assets',
  'conversation',
];

const storagePrefix = 'ai-video.workspace-pane-order.v1:';

function storageKey(projectId: string | undefined): string {
  return `${storagePrefix}${projectId ?? 'no-project'}`;
}

function isPaneId(value: unknown): value is WorkspacePaneId {
  return (
    value === 'editor' || value === 'production' || value === 'assets' || value === 'conversation'
  );
}

export function readWorkspacePaneOrder(projectId: string | undefined): WorkspacePaneId[] {
  try {
    const raw = window.localStorage?.getItem(storageKey(projectId));
    if (!raw) return [...DEFAULT_WORKSPACE_PANE_ORDER];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_WORKSPACE_PANE_ORDER];
    const order = [...new Set(parsed.filter(isPaneId))];
    for (const [index, paneId] of DEFAULT_WORKSPACE_PANE_ORDER.entries()) {
      if (order.includes(paneId)) continue;
      const successor = DEFAULT_WORKSPACE_PANE_ORDER.slice(index + 1).find((id) =>
        order.includes(id),
      );
      const targetIndex = successor === undefined ? order.length : order.indexOf(successor);
      order.splice(targetIndex, 0, paneId);
    }
    return order;
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
