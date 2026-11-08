import { useEffect, useRef, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import type { RoughCutClip } from '@ai-video/contracts';
import { RoughCutPlayback } from './rough-cut-playback';

interface Props {
  clips: RoughCutClip[];
  sources: Record<string, string>;
  unavailable: string[];
  timeMs: number;
  seekRevision: number;
  playing: boolean;
  onTime: (timeMs: number) => void;
  onStopped: () => void;
  onError: (message: string) => void;
}

export function RoughCutPreview(props: Props) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const heldFrame = useRef<HTMLCanvasElement>(null);
  const controller = useRef<RoughCutPlayback>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const playback = new RoughCutPlayback(
      [first.current!, second.current!],
      {
        time: (time) => latest.current.onTime(time),
        stopped: () => latest.current.onStopped(),
        waiting: setWaiting,
        error: (message) => latest.current.onError(message),
      },
      heldFrame.current!,
    );
    controller.current = playback;
    return () => {
      playback.dispose();
      controller.current = undefined;
    };
  }, []);
  useEffect(() => {
    controller.current?.configure(props.clips, props.sources, props.unavailable);
  }, [props.clips, props.sources, props.unavailable.join('\0')]);
  useEffect(() => {
    controller.current?.seek(latest.current.timeMs);
  }, [props.seekRevision]);
  useEffect(() => {
    controller.current?.setPlaying(props.playing);
  }, [props.playing]);
  return (
    <>
      <video ref={first} preload="auto" playsInline aria-label="预览播放器 A" />
      <video ref={second} preload="auto" playsInline aria-label="预览播放器 B" />
      <canvas ref={heldFrame} className="rough-cut-held-frame" aria-hidden="true" />
      {!props.clips.length && (
        <div className="rough-cut-empty">
          <Clapperboard size={36} />
          <span>从素材库拖入视频，或点击“按集导入”开始粗剪</span>
        </div>
      )}
      {waiting && (
        <span className="rough-cut-preview-loading" role="status">
          正在准备画面…
        </span>
      )}
    </>
  );
}
