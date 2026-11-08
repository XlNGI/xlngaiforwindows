import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AssetInfo } from '@ai-video/contracts';
import { AssetImagePreview } from './AssetImagePreview';
import { projectWorker, workerScope } from './worker-scope';
import { resolveAssetDrop, useAssetDrop } from './assets/use-asset-drop';

export function referenceAssetName(asset: AssetInfo): string {
  return asset.alias?.trim() || asset.relativePath.split(/[\\/]/).pop() || asset.id;
}

/** One image interaction for cast, locations, materials and first frames. */
export function ReferenceCard({
  label,
  asset,
  projectId,
  writable,
  emptyText = '拖入或下拉选择',
  onDropAsset,
  selector,
  children,
}: {
  label: string;
  asset?: AssetInfo;
  projectId?: string;
  writable: boolean;
  emptyText?: string;
  onDropAsset?: (asset: AssetInfo) => void;
  selector: ReactNode;
  children?: ReactNode;
}) {
  const [message, setMessage] = useState('');
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [projectId, label, writable, asset?.id],
  );
  const drop = useAssetDrop<HTMLElement>({
    enabled: writable && Boolean(onDropAsset),
    onDrop: (raw) => {
      void (async () => {
        const token = ++request.current;
        try {
          const { payload, scope } = await resolveAssetDrop(raw, projectId, ['image'], 1);
          const assetId = payload.assets[0]!.id;
          const result = await projectWorker(scope)('scene.media.resolve', {
            characterDocumentIds: [],
            assetIds: [assetId],
          });
          const image = result.assets.find(
            (item) =>
              item.id === assetId &&
              item.projectId === projectId &&
              !item.deletedAt &&
              !item.kind.toLowerCase().includes('video'),
          );
          if (!image) throw new Error('图片不可用，请重新选择。');
          if (
            token !== request.current ||
            scope?.projectSessionId !== workerScope(projectId)?.projectSessionId
          )
            return;
          setMessage('');
          onDropAsset?.(image);
        } catch (error) {
          if (token === request.current)
            setMessage(error instanceof Error ? error.message : '素材拖入失败。');
        }
      })();
    },
  });
  return (
    <article
      ref={drop.ref}
      {...drop.handlers}
      className={`shot-reference-slot ${drop.hovering ? 'is-asset-drag-over' : ''}`}
      aria-label={`${label}卡片`}
    >
      <strong className="reference-card-title" title={label}>
        {label}
      </strong>
      <div className="reference-card-preview">
        {asset ? (
          <AssetImagePreview asset={asset} />
        ) : (
          <span className="shot-reference-empty">
            <ImageIcon size={18} />
            {emptyText}
          </span>
        )}
      </div>
      <div className="reference-card-controls">
        {selector}
        {children}
      </div>
      {message && <small role="status">{message}</small>}
    </article>
  );
}
