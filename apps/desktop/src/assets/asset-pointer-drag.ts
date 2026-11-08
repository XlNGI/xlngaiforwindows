import type { AssetInfo } from '@ai-video/contracts';

export const ASSET_POINTER_DRAG = 'ai-video:asset-pointer-drag';
export interface AssetPointerDrag {
  phase: 'probe' | 'move' | 'drop' | 'cancel';
  serialized: string;
  x: number;
  y: number;
}

export function serializeAssetDrag(items: AssetInfo[], sourceType = 'asset', sourceId?: string) {
  const ordered = [...items].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return JSON.stringify({
    version: 1,
    projectId: ordered[0]?.projectId,
    sourceType,
    sourceId,
    snapshotAt: new Date().toISOString(),
    assets: ordered.map(({ id, kind, createdAt }) => ({ id, kind, createdAt })),
  });
}

/** Same-document pointer transport for WebViews that intercept native HTML dragging. */
export function dispatchAssetPointerDrag(detail: AssetPointerDrag): boolean {
  return !document.dispatchEvent(new CustomEvent(ASSET_POINTER_DRAG, { detail, cancelable: true }));
}
