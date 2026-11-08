import { useEffect, useRef, useState, type RefObject } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** Windows supplies paths through Tauri, not through browser File objects. */
export function useContinuityFileDrop(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onFiles: (paths: string[]) => void,
  onError: (message: string) => void,
) {
  const latest = useRef({ enabled, onFiles, onError });
  latest.current = { enabled, onFiles, onError };
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let active = true;
    let dispose: (() => void) | undefined;
    void Promise.resolve()
      .then(() =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (!active) return;
          if (payload.type === 'leave' || !latest.current.enabled) {
            setHovering(false);
            return;
          }
          const ratio = window.devicePixelRatio || 1;
          const hit = document.elementFromPoint(
            payload.position.x / ratio,
            payload.position.y / ratio,
          );
          const inside = Boolean(
            ref.current && hit?.closest('[data-continuity-file-drop]') === ref.current,
          );
          setHovering(inside && payload.type !== 'drop');
          if (inside && payload.type === 'drop') latest.current.onFiles(payload.paths);
        }),
      )
      .then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      })
      .catch(() => {
        if (active) latest.current.onError('本地文件拖入暂不可用，可通过选择文件添加。');
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [ref]);
  return enabled && hovering;
}
