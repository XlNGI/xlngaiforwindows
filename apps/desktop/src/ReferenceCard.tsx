import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AssetInfo } from '@ai-video/contracts';
import { AssetImagePreview } from './AssetImagePreview';
import { projectWorker } from './worker-scope';

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
  return (
    <article
      className="shot-reference-slot"
      aria-label={`${label}卡片`}
      onDragOver={(event) => {
        if (!writable || !onDropAsset) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        void (async () => {
          event.preventDefault();
          if (!writable || !onDropAsset) return;
          const token = ++request.current;
          const callWorker = projectWorker();
          try {
            const raw =
              event.dataTransfer.getData('application/x-ai-video-asset+json') ||
              event.dataTransfer.getData('text/plain');
            const payload = JSON.parse(raw) as {
              version?: number;
              projectId?: string;
              assets?: Array<{ id: string }>;
            };
            if (payload.version !== 1 || !projectId || payload.projectId !== projectId)
              throw new Error('只能拖入当前项目的素材。');
            if (payload.assets?.length !== 1 || typeof payload.assets[0]?.id !== 'string')
              throw new Error('每张参考卡片只能放入一张图片。');
            const assetId = payload.assets[0].id;
            const result = await callWorker('scene.media.resolve', {
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
            await callWorker('asset.mediaSource', { assetId: image.id });
            if (token !== request.current) return;
            setMessage('');
            onDropAsset(image);
          } catch (error) {
            if (token === request.current)
              setMessage(error instanceof Error ? error.message : '素材拖入失败。');
          }
        })();
      }}
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
