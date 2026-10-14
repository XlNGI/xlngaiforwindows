import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { callWorker } from '../worker-client';

export function dubbingMediaSource(id: string, path: string, audio: boolean): string {
  return '__TAURI_INTERNALS__' in window
    ? convertFileSrc(path)
    : `/worker-media/${audio ? 'audio/' : ''}${encodeURIComponent(id)}`;
}

/** Project-bound previews discard responses from a closed or switched project. */
export function useDubbingMedia(projectId: string, id: string | undefined, audio: boolean) {
  const key = `${projectId}:${id ?? ''}:${audio ? 'audio' : 'video'}`;
  const [source, setSource] = useState<{ key: string; src?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    if (id) {
      void (
        audio
          ? callWorker('audio.mediaSource', { audioId: id })
          : callWorker('asset.mediaSource', { assetId: id })
      )
        .then((media) => {
          if (active) setSource({ key, src: dubbingMediaSource(id, media.path, audio) });
        })
        .catch(() => {
          if (active) setSource({ key, error: '文件暂时无法播放，请检查项目中的素材。' });
        });
    }
    return () => {
      active = false;
    };
  }, [key, id, audio]);
  return source?.key === key ? source : undefined;
}
