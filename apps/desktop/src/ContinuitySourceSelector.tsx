import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Film, X } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { AssetInfo, ShotContinuityContext, ShotContinuityPreview } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { useDubbingMedia } from './dubbing/media';
import { ImagePreview } from './ImagePreview';
import { AssetImagePreview } from './AssetImagePreview';
import { referenceAssetName } from './ReferenceCard';
import { ContinuityAssetPicker } from './ContinuityAssetPicker';
import { resolveAssetDrop, useAssetDrop } from './assets/use-asset-drop';
import { useContinuityFileDrop } from './continuity-file-drop';

interface Candidate extends ShotContinuityPreview {
  videoAssetId: string;
  selected: boolean;
}
const frameKey = (frame: { videoAssetId: string; timeMs: number }) =>
  `frame:${frame.videoAssetId}:${frame.timeMs}`;

export function ContinuitySourceSelector(props: {
  projectId: string;
  shotId: string;
  context?: ShotContinuityContext;
  writable: boolean;
  notes: string;
  onConfirm: (context: ShotContinuityContext) => void;
  onPending: (pending: boolean) => void;
}) {
  const worker = projectWorker();
  const [sources, setSources] = useState<AssetInfo[]>([]);
  const [frames, setFrames] = useState<Candidate[]>([]);
  const candidates = useRef(frames);
  candidates.current = frames;
  const [videoId, setVideoId] = useState('');
  const [durationMs, setDurationMs] = useState(0);
  const [timeMs, setTimeMs] = useState(0);
  const [fps, setFps] = useState(25);
  const [anchor, setAnchor] = useState('');
  const [count, setCount] = useState(4);
  const [allVideos, setAllVideos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batching, setBatching] = useState(false);
  const [message, setMessage] = useState('');
  const running = useRef(false);
  const cancelled = useRef(false);
  const alive = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const video = useRef<HTMLVideoElement>(null);
  const media = useDubbingMedia(props.projectId, videoId || undefined, false);
  const writable = props.writable && !busy && Boolean(props.context);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelled.current = true;
    };
  }, []);
  useEffect(() => {
    latest.current.onPending(Boolean(busy || sources.length || frames.length));
  }, [busy, sources, frames]);
  useEffect(() => {
    if (!props.writable) cancelled.current = true;
  }, [props.writable]);
  useEffect(() => {
    let active = true;
    setDurationMs(0);
    setTimeMs(0);
    if (videoId)
      void worker('shot.continuity.probe', { shotId: props.shotId, videoAssetId: videoId })
        .then((info) => {
          if (active && info) {
            setDurationMs(info.durationMs);
            setFps(info.fps);
          }
        })
        .catch((error: unknown) => {
          if (active) setMessage(error instanceof Error ? error.message : '视频信息读取失败。');
        });
    return () => {
      active = false;
    };
  }, [props.projectId, props.shotId, videoId]);
  const action = async (work: () => Promise<void>) => {
    if (running.current || !props.writable || !props.context) return;
    running.current = true;
    cancelled.current = false;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : '素材操作失败。');
    } finally {
      running.current = false;
      if (alive.current) {
        setBusy(false);
        setBatching(false);
      }
    }
  };
  const valid = () => alive.current && latest.current.writable && !cancelled.current;
  const addSources = (added: AssetInfo[]) => {
    const next = [...new Map([...sources, ...added].map((asset) => [asset.id, asset])).values()];
    if (next.length > 12) throw new Error('来源素材最多选择 12 项，请先移除部分素材。');
    setSources(next);
    if (!videoId) setVideoId(added.find((asset) => asset.kind.includes('video'))?.id ?? '');
  };
  const importFiles = (paths: string[]) =>
    action(async () => {
      if (sources.length + paths.length > 12)
        throw new Error('来源素材最多选择 12 项，请先移除部分素材。');
      const imported = await worker('shot.continuity.import', {
        shotId: props.shotId,
        sourcePaths: paths,
      });
      if (!valid()) return;
      addSources(imported);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
      setMessage(`已添加 ${imported.length} 项本地素材，请选择画面和衔接基准后确认。`);
    });
  const drop = useAssetDrop<HTMLDivElement>({
    enabled: writable,
    onDrop: (raw) => {
      void action(async () => {
        const { payload } = await resolveAssetDrop(raw, props.projectId, ['image', 'video'], 12);
        const assets = await worker('shot.continuity.assets', {
          shotId: props.shotId,
          assetIds: payload.assets.map((asset) => asset.id),
        });
        if (valid()) addSources(assets);
      });
    },
  });
  const fileHover = useContinuityFileDrop(
    drop.ref,
    writable,
    (paths) => {
      void importFiles(paths);
    },
    setMessage,
  );
  const chooseFiles = () =>
    action(async () => {
      if (!('__TAURI_INTERNALS__' in window))
        throw new Error('请在 Windows 桌面应用中选择或拖入电脑文件。');
      const paths = await openDialog({
        multiple: true,
        filters: [
          {
            name: '图片和视频',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'm4v', 'mkv', 'webm'],
          },
        ],
      });
      if (!valid() || !paths) return;
      const list = typeof paths === 'string' ? [paths] : paths;
      if (sources.length + list.length > 12) throw new Error('来源素材最多选择 12 项。');
      const imported = await worker('shot.continuity.import', {
        shotId: props.shotId,
        sourcePaths: list,
      });
      if (valid()) {
        addSources(imported);
        window.dispatchEvent(new CustomEvent('production-source-updated'));
      }
    });
  const append = (videoAssetId: string, preview: ShotContinuityPreview, selected: boolean) => {
    const old = candidates.current;
    if (
      old.some(
        (frame) => frame.videoAssetId === videoAssetId && frame.sourceToken !== preview.sourceToken,
      )
    )
      throw new Error('该视频或镜头内容已变化，请移除其旧候选画面后重新抽帧。');
    const candidate = { ...preview, videoAssetId, selected };
    const next = [...old.filter((frame) => frameKey(frame) !== frameKey(candidate)), candidate];
    if (next.length > 24) throw new Error('候选画面最多 24 张，请先移除部分候选。');
    candidates.current = next;
    setFrames(next);
  };
  const extract = () =>
    action(async () => {
      const preview = await worker('shot.continuity.preview', {
        shotId: props.shotId,
        videoAssetId: videoId,
        timeMs,
      });
      if (valid()) {
        append(videoId, preview, true);
        setDurationMs(preview.durationMs);
      }
    });
  const videos = sources.filter((asset) => asset.kind.includes('video'));
  const images = sources.filter((asset) => !asset.kind.includes('video'));
  const batch = () =>
    action(async () => {
      const targets = allVideos ? videos : videos.filter((asset) => asset.id === videoId);
      if (!Number.isInteger(count) || count < 2 || count > 12 || !targets.length)
        throw new Error('请选择视频，并设置每段抽取 2–12 帧。');
      if (frames.length + count * targets.length > 24)
        throw new Error('本批次会超过 24 张候选画面，请减少抽帧数或视频数。');
      setBatching(true);
      let completed = 0;
      for (const asset of targets) {
        const info = await worker('shot.continuity.probe', {
          shotId: props.shotId,
          videoAssetId: asset.id,
        });
        if (!valid()) break;
        if (info.durationMs < count) throw new Error('视频太短，无法提取指定数量的不同画面。');
        for (let index = 0; index < count && valid(); index++) {
          setMessage(`正在批量抽帧 ${completed + 1}/${count * targets.length}…`);
          const preview = await worker('shot.continuity.preview', {
            shotId: props.shotId,
            videoAssetId: asset.id,
            timeMs: Math.round((index * (info.durationMs - 1)) / (count - 1)),
          });
          if (!valid()) break;
          if (preview.sourceToken !== info.sourceToken)
            throw new Error('来源视频已变化，请重新抽帧。');
          append(asset.id, preview, false);
          completed++;
        }
      }
      if (alive.current)
        setMessage(
          cancelled.current
            ? `已停止后续抽帧，保留已完成的 ${completed} 张候选画面。`
            : `已抽取 ${completed} 张候选画面，请勾选并指定衔接基准。`,
        );
    });
  const selectedFrames = frames.filter((frame) => frame.selected);
  const selectedCount = selectedFrames.length + images.length;
  const anchorValid =
    images.some((asset) => anchor === `image:${asset.id}`) ||
    selectedFrames.some((frame) => frameKey(frame) === anchor);
  const confirm = () =>
    action(async () => {
      if (!props.context || !anchorValid || !selectedCount || selectedCount > 12) return;
      const frame = selectedFrames.find((item) => frameKey(item) === anchor);
      const next = await worker('shot.continuity.selection.confirm', {
        shotId: props.shotId,
        expectedRowVersion: props.context.rowVersion,
        notes: props.notes,
        frames: selectedFrames.map(({ videoAssetId, sourceToken, timeMs }) => ({
          videoAssetId,
          sourceToken,
          timeMs,
        })),
        imageAssetIds: images.map((asset) => asset.id),
        anchor: frame
          ? { videoAssetId: frame.videoAssetId, timeMs: frame.timeMs }
          : { assetId: anchor.slice('image:'.length) },
      });
      if (!valid()) return;
      setSources([]);
      setFrames([]);
      candidates.current = [];
      setAnchor('');
      setVideoId('');
      props.onConfirm(next);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
      setMessage('参考画面已确认。现在可以向 Agent 描述要生成的参考图。');
    });
  const seek = (nextMs: number) => {
    const next = Math.max(0, Math.min(durationMs - 1, Math.round(nextMs)));
    setTimeMs(next);
    if (video.current) {
      video.current.pause();
      video.current.currentTime = next / 1000;
    }
  };
  const remove = (assetId: string) => {
    setSources((current) => current.filter((asset) => asset.id !== assetId));
    setFrames((current) => current.filter((frame) => frame.videoAssetId !== assetId));
    if (videoId === assetId) setVideoId(videos.find((asset) => asset.id !== assetId)?.id ?? '');
    if (anchor === `image:${assetId}` || anchor.startsWith(`frame:${assetId}:`)) setAnchor('');
  };
  return (
    <div
      ref={drop.ref}
      {...drop.handlers}
      data-continuity-file-drop
      className={`continuity-source-selector ${drop.hovering || fileHover ? 'is-asset-drag-over' : ''}`}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types ?? []).includes('Files')) {
          event.preventDefault();
          event.stopPropagation();
        } else drop.handlers.onDragOver(event);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files?.length) {
          event.preventDefault();
          event.stopPropagation();
          setMessage('请在 Windows 桌面应用中拖入电脑文件，或使用选择文件。');
        } else drop.handlers.onDrop(event);
      }}
    >
      <div className="continuity-section-heading">
        <h3>参考素材</h3>
        <span>{sources.length}/12</span>
      </div>
      <ContinuityAssetPicker
        projectId={props.projectId}
        selectedIds={sources.map((asset) => asset.id)}
        disabled={!writable}
        label="从项目素材选择"
        actions={
          <button type="button" disabled={!writable} onClick={() => void chooseFiles()}>
            选择电脑文件
          </button>
        }
        onToggle={(asset) => {
          if (sources.some((item) => item.id === asset.id)) remove(asset.id);
          else
            try {
              addSources([asset]);
            } catch (error) {
              setMessage((error as Error).message);
            }
        }}
      />
      {props.context?.previousShot && (
        <label>
          <span title={props.context.previousShot.title}>上一镜头</span>
          <select
            aria-label="上一镜头推荐视频"
            value=""
            disabled={!writable}
            onChange={(event) => {
              const asset = props.context?.videos.find((item) => item.id === event.target.value);
              if (asset)
                try {
                  addSources([asset]);
                  setVideoId(asset.id);
                } catch (error) {
                  setMessage((error as Error).message);
                }
            }}
          >
            <option value="">选择推荐视频</option>
            {props.context.videos.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {referenceAssetName(asset)}
              </option>
            ))}
          </select>
        </label>
      )}
      {videos.length > 0 && (
        <div className="continuity-selected-videos" aria-label="已选视频">
          {videos.map((asset) => (
            <div className={asset.id === videoId ? 'is-current' : ''} key={asset.id}>
              <Film size={14} aria-hidden="true" />
              <button
                type="button"
                className="continuity-source-name"
                title={referenceAssetName(asset)}
                aria-label={`预览视频 ${referenceAssetName(asset)}`}
                aria-pressed={asset.id === videoId}
                disabled={!writable}
                onClick={() => setVideoId(asset.id)}
              >
                {referenceAssetName(asset)}
              </button>
              <button
                type="button"
                className="continuity-icon-button"
                aria-label={`移除素材 ${referenceAssetName(asset)}`}
                title="移除视频"
                disabled={!writable}
                onClick={() => remove(asset.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="shot-continuity-frames">
          {images.map((asset) => (
            <article key={asset.id}>
              <AssetImagePreview asset={asset} resolution="original" />
              <span title={referenceAssetName(asset)}>{referenceAssetName(asset)}</span>
              <label>
                <input
                  type="radio"
                  name={`source-anchor-${props.shotId}`}
                  disabled={!writable}
                  checked={anchor === `image:${asset.id}`}
                  onChange={() => setAnchor(`image:${asset.id}`)}
                />
                用作衔接基准
              </label>
              <button type="button" disabled={!writable} onClick={() => remove(asset.id)}>
                移除此素材
              </button>
            </article>
          ))}
        </div>
      )}
      {videoId && (
        <div className="continuity-frame-editor">
          {media?.src && (
            <video
              ref={video}
              key={media.src}
              src={media.src}
              controls
              preload="metadata"
              aria-label="选帧播放器"
              onLoadedMetadata={(event) => {
                if (Number.isFinite(event.currentTarget.duration))
                  setDurationMs(Math.round(event.currentTarget.duration * 1000));
              }}
              onTimeUpdate={(event) =>
                setTimeMs(Math.round(event.currentTarget.currentTime * 1000))
              }
            />
          )}
          {media?.error && <p role="status">{media.error} 仍可尝试本地抽帧。</p>}
          <div className="continuity-frame-controls">
            <label>
              时间（秒）
              <input
                aria-label="选帧时间（秒）"
                type="number"
                min="0"
                max={Math.max(0, durationMs - 1) / 1000}
                step="0.001"
                value={timeMs / 1000}
                disabled={!writable || !durationMs}
                onChange={(event) => seek(Number(event.target.value) * 1000)}
              />
            </label>
            <button
              type="button"
              className="continuity-icon-button"
              aria-label="前移约一帧"
              title="前移约一帧"
              disabled={!writable || !durationMs}
              onClick={() => seek(timeMs - 1000 / fps)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="continuity-icon-button"
              aria-label="后移约一帧"
              title="后移约一帧"
              disabled={!writable || !durationMs}
              onClick={() => seek(timeMs + 1000 / fps)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="continuity-primary-action"
              disabled={!writable || !durationMs || frames.length >= 24}
              onClick={() => void extract()}
            >
              添加此画面
            </button>
          </div>
          <div className="continuity-batch-controls">
            <label>
              每段帧数
              <input
                aria-label="每段抽帧数"
                type="number"
                min="2"
                max="12"
                value={count}
                disabled={!writable}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </label>
            <label>
              范围
              <select
                aria-label="抽帧范围"
                value={allVideos ? 'all' : 'current'}
                disabled={!writable}
                onChange={(event) => setAllVideos(event.target.value === 'all')}
              >
                <option value="current">当前视频</option>
                <option value="all">所有已选视频（{videos.length}）</option>
              </select>
            </label>
            <button type="button" disabled={!writable || !durationMs} onClick={() => void batch()}>
              批量抽帧
            </button>
            {batching && (
              <button
                type="button"
                onClick={() => {
                  cancelled.current = true;
                }}
              >
                停止抽帧
              </button>
            )}
          </div>
        </div>
      )}
      {frames.length > 0 && (
        <>
          <div className="shot-continuity-actions">
            <span>候选画面 {frames.length} 张</span>
            <button
              type="button"
              aria-label="全选候选画面"
              disabled={!writable || frames.length + images.length > 12}
              onClick={() =>
                setFrames((current) => current.map((frame) => ({ ...frame, selected: true })))
              }
            >
              全选
            </button>
            <button
              type="button"
              aria-label="取消画面选择"
              disabled={!writable}
              onClick={() => {
                setFrames((current) => current.map((frame) => ({ ...frame, selected: false })));
                if (anchor.startsWith('frame:')) setAnchor('');
              }}
            >
              取消选择
            </button>
            <button
              type="button"
              aria-label="清空候选画面"
              disabled={!writable}
              onClick={() => {
                setFrames([]);
                if (anchor.startsWith('frame:')) setAnchor('');
              }}
            >
              清空
            </button>
          </div>
          <div className="shot-continuity-frames">
            {frames.map((frame) => (
              <article key={frameKey(frame)}>
                <ImagePreview
                  src={frame.dataUrl}
                  alt={`${referenceAssetName(sources.find((asset) => asset.id === frame.videoAssetId)!)} ${(frame.timeMs / 1000).toFixed(3)} 秒候选帧`}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={frame.selected}
                    disabled={!writable}
                    aria-label={`选择画面 ${frame.videoAssetId} ${frame.timeMs}`}
                    onChange={(event) => {
                      setFrames((current) =>
                        current.map((item) =>
                          frameKey(item) === frameKey(frame)
                            ? { ...item, selected: event.target.checked }
                            : item,
                        ),
                      );
                      if (!event.target.checked && anchor === frameKey(frame)) setAnchor('');
                    }}
                  />
                  {(frame.timeMs / 1000).toFixed(3)}s
                </label>
                <label>
                  <input
                    type="radio"
                    name={`source-anchor-${props.shotId}`}
                    checked={anchor === frameKey(frame)}
                    disabled={!writable || !frame.selected}
                    onChange={() => setAnchor(frameKey(frame))}
                  />
                  用作衔接基准
                </label>
                <button
                  type="button"
                  disabled={!writable}
                  onClick={() => {
                    setFrames((current) =>
                      current.filter((item) => frameKey(item) !== frameKey(frame)),
                    );
                    if (anchor === frameKey(frame)) setAnchor('');
                  }}
                >
                  移除此帧
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {(sources.length > 0 || frames.length > 0) && (
        <div className="shot-continuity-actions">
          <span>已选 {selectedCount}/12 张参考画面</span>
          <button
            type="button"
            className="continuity-primary-action"
            disabled={!writable || !selectedCount || selectedCount > 12 || !anchorValid}
            onClick={() => void confirm()}
          >
            确认所选画面
          </button>
          <button
            type="button"
            disabled={!writable}
            onClick={() => {
              setSources([]);
              setFrames([]);
              setAnchor('');
              setVideoId('');
            }}
          >
            放弃本次选择
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
