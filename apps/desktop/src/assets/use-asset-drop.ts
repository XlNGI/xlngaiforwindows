import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ASSET_POINTER_DRAG, type AssetPointerDrag } from './asset-pointer-drag';
import { projectWorker, workerScope } from '../worker-scope';

export const ASSET_DRAG_MIME = 'application/x-ai-video-asset+json';
const DISABLED_DROP_TARGET =
  'fieldset[disabled], [aria-disabled="true"], [data-asset-drop-disabled="true"]';
export interface AssetDropSnapshot {
  version: 1;
  projectId: string;
  assets: Array<{ id: string; kind: string }>;
}

export function parseAssetDrop(raw: string): AssetDropSnapshot {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('素材拖放数据无效。');
  const payload = data as Partial<AssetDropSnapshot>;
  if (
    payload.version !== 1 ||
    typeof payload.projectId !== 'string' ||
    !Array.isArray(payload.assets) ||
    !payload.assets.length ||
    payload.assets.length > 200 ||
    payload.assets.some(
      (asset) =>
        !asset || typeof asset.id !== 'string' || !asset.id || typeof asset.kind !== 'string',
    ) ||
    new Set(payload.assets.map((asset) => asset.id)).size !== payload.assets.length
  )
    throw new Error('素材拖放数据无效。');
  return payload as AssetDropSnapshot;
}

export function readAssetDrop(transfer: DataTransfer): string | undefined {
  const raw = transfer.getData(ASSET_DRAG_MIME) || transfer.getData('text/plain');
  try {
    const data: unknown = JSON.parse(raw);
    return data && typeof data === 'object' && 'version' in data && 'assets' in data
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve IDs through the owning Worker; never trust paths or MIME from the drag source. */
export async function resolveAssetDrop(
  raw: string,
  projectId: string | undefined,
  kinds: Array<'image' | 'video'>,
  maximum: number,
) {
  const payload = parseAssetDrop(raw);
  if (!projectId || payload.projectId !== projectId) throw new Error('只能拖入当前项目的素材。');
  if (payload.assets.length > maximum) throw new Error(`最多可拖入 ${maximum} 项素材。`);
  const accepts = (kind: string) => kinds.includes(kind.includes('video') ? 'video' : 'image');
  const typeError = () =>
    new Error(
      kinds.length === 1 && kinds[0] === 'image'
        ? '此参数只接受图片素材。'
        : '此处不支持该类型的素材。',
    );
  if (payload.assets.some((asset) => !accepts(asset.kind))) throw typeError();
  const scope = workerScope(projectId);
  if (workerScope() && !scope) throw new Error('任务所属项目尚未挂接，请重新打开项目。');
  const worker = projectWorker(scope);
  const sources = await Promise.all(
    payload.assets.map((asset) => worker('asset.mediaSource', { assetId: asset.id })),
  );
  if (scope?.projectSessionId !== workerScope(projectId)?.projectSessionId)
    throw new Error('项目已切换，请重新拖入素材。');
  if (sources.some((source) => !kinds.some((kind) => source.contentType.startsWith(`${kind}/`))))
    throw typeError();
  return { payload, sources, scope };
}

/** Both HTML dragging and the Windows WebView pointer fallback use the same receiver. */
export function useAssetDrop<T extends HTMLElement>({
  enabled = true,
  onDrop,
}: {
  enabled?: boolean;
  onDrop: (serialized: string, target: Element | null) => void;
}) {
  const ref = useRef<T>(null);
  const available = () => enabled && !ref.current?.closest(DISABLED_DROP_TARGET);
  const latest = useRef({ enabled, onDrop });
  latest.current = { enabled, onDrop };
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    const receive = (event: Event) => {
      const custom = event as CustomEvent<AssetPointerDrag>;
      const { phase, serialized, x, y } = custom.detail;
      if (phase === 'cancel') {
        setHovering(false);
        return;
      }
      if (!latest.current.enabled || !ref.current || ref.current.closest(DISABLED_DROP_TARGET)) {
        setHovering(false);
        return;
      }
      if (phase === 'probe') {
        custom.preventDefault();
        return;
      }
      const hit = document.elementFromPoint(x, y);
      const inside = hit?.closest('[data-asset-drop-zone]') === ref.current;
      setHovering(Boolean(inside && phase === 'move'));
      if (!inside) return;
      custom.preventDefault();
      if (phase === 'drop') latest.current.onDrop(serialized, hit);
    };
    document.addEventListener(ASSET_POINTER_DRAG, receive);
    return () => document.removeEventListener(ASSET_POINTER_DRAG, receive);
  }, []);
  const onDragOver = (event: DragEvent<T>) => {
    if (!available()) return;
    const types = Array.from(event.dataTransfer.types ?? []);
    if (types.length && !types.some((type) => [ASSET_DRAG_MIME, 'text/plain'].includes(type)))
      return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setHovering(true);
  };
  return {
    ref,
    hovering: enabled && hovering,
    handlers: {
      'data-asset-drop-zone': true,
      onDragOver,
      onDragLeave: (event: DragEvent<T>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovering(false);
      },
      onDrop: (event: DragEvent<T>) => {
        setHovering(false);
        const raw = readAssetDrop(event.dataTransfer);
        if (!raw) return;
        event.preventDefault();
        event.stopPropagation();
        if (available()) onDrop(raw, event.target as Element);
      },
      onDragEnd: () => setHovering(false),
    },
  };
}
