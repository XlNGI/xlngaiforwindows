import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AssetInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { ImagePreview } from './ImagePreview';

export function AssetImagePreview({ asset }: { asset: AssetInfo }) {
  const [source, setSource] = useState<{ assetId: string; src?: string; failed?: boolean }>();
  const name = asset.alias?.trim() || asset.relativePath.split(/[\\/]/).pop() || '生成图片';
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => callWorker('asset.mediaSource', { assetId: asset.id }))
      .then((media) => {
        const src =
          '__TAURI_INTERNALS__' in window
            ? convertFileSrc(media.path)
            : `/worker-media/${encodeURIComponent(asset.id)}`;
        if (active) setSource({ assetId: asset.id, src });
      })
      .catch(() => {
        if (active) setSource({ assetId: asset.id, failed: true });
      });
    return () => {
      active = false;
    };
  }, [asset.id, asset.projectId]);
  const current = source?.assetId === asset.id ? source : undefined;
  return current?.src ? (
    <ImagePreview key={current.src} src={current.src} alt={name} />
  ) : (
    <span className="image-preview-error">
      {current?.failed ? '图片暂时无法预览' : '正在读取图片…'}
    </span>
  );
}
