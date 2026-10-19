import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AssetInfo } from '@ai-video/contracts';
import { projectWorker, workerMediaUrl } from './worker-scope';
import { ImagePreview } from './ImagePreview';

type AssetImagePreviewProps =
  { asset: AssetInfo } | { assetId: string; projectId?: string; alt: string };

export function AssetImagePreview(props: AssetImagePreviewProps) {
  const callWorker = projectWorker();
  const assetId = 'asset' in props ? props.asset.id : props.assetId;
  const projectId = 'asset' in props ? props.asset.projectId : props.projectId;
  const name =
    'asset' in props
      ? props.asset.alias?.trim() || props.asset.relativePath.split(/[\\/]/).pop() || '生成图片'
      : props.alt;
  const [source, setSource] = useState<{
    assetId: string;
    projectId?: string;
    src?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => callWorker('asset.mediaSource', { assetId }))
      .then((media) => {
        const src =
          '__TAURI_INTERNALS__' in window ? convertFileSrc(media.path) : workerMediaUrl(assetId);
        if (active) setSource({ assetId, projectId, src });
      })
      .catch(() => {
        if (active) setSource({ assetId, projectId, failed: true });
      });
    return () => {
      active = false;
    };
  }, [assetId, projectId]);
  const current =
    source?.assetId === assetId && source.projectId === projectId ? source : undefined;
  return current?.src ? (
    <ImagePreview key={current.src} src={current.src} alt={name} />
  ) : (
    <span className="image-preview-error">
      {current?.failed ? '图片暂时无法预览' : '正在读取图片…'}
    </span>
  );
}
