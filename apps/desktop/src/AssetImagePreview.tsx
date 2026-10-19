import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AssetInfo, AssetMediaSourceInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { ImagePreview } from './ImagePreview';

type AssetImagePreviewProps =
  { asset: AssetInfo } | { assetId: string; projectId?: string; alt: string };

const pending = new Map<string, Promise<AssetMediaSourceInfo>>();
function source(projectId: string | undefined, assetId: string, thumbnail: boolean) {
  const key = `${projectId}:${assetId}:${thumbnail}`;
  let request = pending.get(key);
  if (!request) {
    request = Promise.resolve().then(() =>
      callWorker(thumbnail ? 'asset.thumbnail' : 'asset.mediaSource', { assetId }),
    );
    pending.set(key, request);
    void request
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      })
      .catch(() => undefined);
  }
  return request.then((media) =>
    '__TAURI_INTERNALS__' in window
      ? convertFileSrc(media.path)
      : `/worker-media/${encodeURIComponent(assetId)}${thumbnail ? '?thumbnail=1' : ''}`,
  );
}

export function AssetImagePreview(props: AssetImagePreviewProps) {
  const assetId = 'asset' in props ? props.asset.id : props.assetId;
  const projectId = 'asset' in props ? props.asset.projectId : props.projectId;
  const name =
    'asset' in props
      ? props.asset.alias?.trim() || props.asset.relativePath.split(/[\\/]/).pop() || '生成图片'
      : props.alt;
  return (
    <Preview key={`${projectId}:${assetId}`} projectId={projectId} assetId={assetId} name={name} />
  );
}

function Preview({
  projectId,
  assetId,
  name,
}: {
  projectId?: string;
  assetId: string;
  name: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [retry, setRetry] = useState(0);
  const [media, setMedia] = useState<{ src?: string; failed?: boolean }>();
  const full = useCallback(() => source(projectId, assetId, false), [projectId, assetId]);
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    if (visible) {
      setMedia(undefined);
      void source(projectId, assetId, true)
        .then((src) => {
          if (active) setMedia({ src });
        })
        .catch(() => {
          if (active) setMedia({ failed: true });
        });
    }
    return () => {
      active = false;
    };
  }, [projectId, assetId, visible, retry]);
  return (
    <span ref={element} className="asset-image-preview">
      {media?.src ? (
        <ImagePreview src={media.src} alt={name} loadFullSrc={full} />
      ) : (
        <span className="image-preview-error">
          {media?.failed ? (
            <>
              图片暂时无法预览{' '}
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                重试图片
              </button>
            </>
          ) : (
            '正在读取图片…'
          )}
        </span>
      )}
    </span>
  );
}
