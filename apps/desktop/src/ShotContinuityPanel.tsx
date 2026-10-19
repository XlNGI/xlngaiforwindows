import { useEffect, useRef, useState } from 'react';
import type {
  AssetInfo,
  ShotContinuityContext,
  ShotContinuityMode,
  ShotContinuityPreview,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { useDubbingMedia } from './dubbing/media';
import { ImagePreview } from './ImagePreview';
import { AssetImagePreview } from './AssetImagePreview';
import { referenceAssetName } from './ReferenceCard';
import { streamPreparedLlmGeneration, type LlmStreamRun } from './llm-client';

export function ShotContinuityPanel(props: {
  projectId: string;
  shotId: string;
  writable: boolean;
  sourceDirty: boolean;
  revision?: unknown;
  assets: AssetInfo[];
  llm?: { providerProfileId: string; modelId: string; name: string; vision: boolean };
  onChange: (context: ShotContinuityContext) => void;
  onGenerate: (mode: 'image' | 'video', context: ShotContinuityContext) => void;
}) {
  const callWorker = projectWorker();
  const [context, setContext] = useState<ShotContinuityContext>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [videoId, setVideoId] = useState('');
  const [timeMs, setTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [frames, setFrames] = useState<ShotContinuityPreview[]>([]);
  const [anchor, setAnchor] = useState<number>();
  const [mode, setMode] = useState<ShotContinuityMode>('continue');
  const [notes, setNotes] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [videoPrompt, setVideoPrompt] = useState('');
  const [generating, setGenerating] = useState<'image' | 'video'>();
  const video = useRef<HTMLVideoElement>(null);
  const run = useRef<LlmStreamRun | undefined>(undefined);
  const cancelPromptRequested = useRef(false);
  const alive = useRef(true);
  const version = useRef<number | undefined>(undefined);
  const callbacks = useRef(props);
  callbacks.current = props;
  const media = useDubbingMedia(props.projectId, videoId || undefined, false);
  const adopt = (next: ShotContinuityContext) => {
    version.current = next.rowVersion;
    setContext(next);
    setImagePrompt(next.binding?.imagePrompt ?? '');
    setVideoPrompt(next.binding?.videoPrompt ?? '');
    setMode(next.binding?.mode ?? 'continue');
    setNotes(next.binding?.notes ?? '');
    callbacks.current.onChange(next);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current?.detach();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void callWorker('shot.continuity.get', { shotId: props.shotId })
      .then((next) => {
        if (!active || !next) return;
        if (version.current === next.rowVersion) {
          setContext(next);
          callbacks.current.onChange(next);
        } else adopt(next);
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : '衔接设置读取失败。');
      });
    return () => {
      active = false;
    };
  }, [props.projectId, props.shotId, props.revision]);

  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : '衔接操作失败。');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const extract = () =>
    action(async () => {
      const selectedVideo = videoId;
      const result = await callWorker('shot.continuity.preview', {
        shotId: props.shotId,
        videoAssetId: selectedVideo,
        timeMs,
      });
      if (!alive.current) return;
      if (frames.some((frame) => frame.sourceToken !== result.sourceToken)) {
        setFrames([]);
        setAnchor(undefined);
        throw new Error('来源内容已变化，请重新添加候选帧。');
      }
      setDurationMs(result.durationMs);
      setFrames((current) =>
        [...current.filter((frame) => frame.timeMs !== result.timeMs), result].sort(
          (a, b) => a.timeMs - b.timeMs,
        ),
      );
    });
  const confirm = () =>
    action(async () => {
      if (!context || anchor === undefined || !frames.length) return;
      const next = await callWorker('shot.continuity.confirm', {
        shotId: props.shotId,
        videoAssetId: videoId,
        sourceToken: frames[0]!.sourceToken,
        timesMs: frames.map((frame) => frame.timeMs),
        anchorTimeMs: anchor,
        mode,
        notes,
        expectedRowVersion: context.rowVersion,
      });
      if (!alive.current) return;
      adopt(next);
      setFrames([]);
      setAnchor(undefined);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
      setMessage('选帧已确认。现在可以让 LLM 生成提示词。');
    });
  const generatePrompt = (kind: 'image' | 'video') =>
    action(async () => {
      if (!context?.binding || !props.llm) return;
      const expected = context.rowVersion;
      cancelPromptRequested.current = false;
      setGenerating(kind);
      try {
        const prepared = await callWorker('shot.continuity.prompt.prepare', {
          shotId: props.shotId,
          expectedRowVersion: expected,
          kind,
          providerProfileId: props.llm.providerProfileId,
          modelId: props.llm.modelId,
        });
        if (!alive.current || cancelPromptRequested.current) {
          await callWorker('llm.generation.cancel', { generationId: prepared.stream.generationId });
          return;
        }
        let complete = false;
        let failed = '';
        let text = '';
        const task = streamPreparedLlmGeneration(prepared, {
          onDelta() {},
          onState(state) {
            if (state.status === 'complete') {
              complete = true;
              text = state.assistantMessage.content;
            }
            if (state.status === 'failed' || state.status === 'cancelled')
              failed = state.error ?? '提示词生成已停止。';
          },
        });
        run.current = task;
        await task.completion;
        if (!alive.current) return;
        const latest = await callWorker('shot.continuity.get', { shotId: props.shotId });
        if (!alive.current) return;
        if (
          latest.rowVersion !== expected ||
          latest.stale ||
          version.current !== expected ||
          callbacks.current.sourceDirty
        )
          throw new Error('选帧或下一镜头内容已变化，旧提示词未采用，请重新确认后生成。');
        if (!complete || failed || !text.trim())
          throw new Error(failed || 'LLM 未返回完整提示词，请重试。');
        if (kind === 'image') setImagePrompt(text);
        else setVideoPrompt(text);
        setMessage('LLM 提示词已生成，可以修改后保存并进入制作。');
      } finally {
        run.current = undefined;
        if (alive.current) setGenerating(undefined);
      }
    });
  const usePrompt = (kind: 'image' | 'video') =>
    action(async () => {
      if (!context) return;
      const next = await callWorker('shot.continuity.prompt.save', {
        shotId: props.shotId,
        expectedRowVersion: context.rowVersion,
        kind,
        prompt: kind === 'image' ? imagePrompt : videoPrompt,
      });
      if (!alive.current) return;
      adopt(next);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
      props.onGenerate(kind, next);
    });
  const bindFirstFrame = (assetId: string) =>
    action(async () => {
      if (!context || !assetId) return;
      const next = await callWorker('shot.continuity.firstFrame', {
        shotId: props.shotId,
        expectedRowVersion: context.rowVersion,
        assetId,
      });
      if (!alive.current) return;
      adopt(next);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
    });
  const seek = (nextMs: number) => {
    const next = Math.max(0, Math.min(Math.max(0, durationMs - 1), Math.round(nextMs)));
    setTimeMs(next);
    if (video.current) {
      video.current.pause();
      video.current.currentTime = next / 1000;
    }
  };
  const writable = props.writable && !busy && !props.sourceDirty;
  const selectionPending = Boolean(
    frames.length ||
    (videoId &&
      context?.binding &&
      (videoId !== context.binding.sourceVideoAssetId ||
        mode !== context.binding.mode ||
        notes !== context.binding.notes)),
  );
  const ready = writable && Boolean(context?.binding) && !context?.stale && !selectionPending;
  const canAskLlm = ready && props.llm?.vision;
  const binding = context?.binding;
  const images = [
    ...new Map(
      [...props.assets, ...(context?.images ?? [])]
        .filter(
          (asset) =>
            asset.projectId === props.projectId &&
            !asset.deletedAt &&
            !asset.kind.includes('video'),
        )
        .map((asset) => [asset.id, asset]),
    ).values(),
  ];

  return (
    <section className="shot-continuity-panel" aria-label="镜头衔接">
      <h2>镜头衔接</h2>
      <p>选择上一镜头画面作为首帧，确认后生成衔接提示词。</p>
      {props.sourceDirty && <p role="status">下一镜头内容有未保存修改，请先保存镜头提示词。</p>}
      {!context?.previousShot ? (
        <p>当前镜头没有同场次的上一镜头。</p>
      ) : (
        <>
          <label>
            上一镜头：{context.previousShot.title}
            <select
              aria-label="上一镜头视频"
              value={videoId}
              disabled={!writable}
              onChange={(event) => {
                setVideoId(event.target.value);
                setFrames([]);
                setAnchor(undefined);
                setTimeMs(0);
                setDurationMs(0);
              }}
            >
              <option value="">人工选择视频</option>
              {context.videos.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {referenceAssetName(asset)}
                </option>
              ))}
            </select>
          </label>
          {!context.videos.length && <p>上一镜头还没有成功保存的视频。</p>}
          {videoId && (
            <>
              {media?.src && (
                <video
                  ref={video}
                  key={media.src}
                  src={media.src}
                  controls
                  preload="metadata"
                  aria-label="上一镜头选帧播放器"
                  onLoadedMetadata={(event) =>
                    setDurationMs(Math.round(event.currentTarget.duration * 1000))
                  }
                  onTimeUpdate={(event) =>
                    setTimeMs(Math.round(event.currentTarget.currentTime * 1000))
                  }
                />
              )}
              {media?.error && <p role="status">{media.error}</p>}
              <div className="shot-continuity-actions">
                <label>
                  选帧时间（秒）
                  <input
                    aria-label="选帧时间（秒）"
                    type="number"
                    min="0"
                    max={Math.max(0, durationMs - 1) / 1000}
                    step="0.001"
                    value={timeMs / 1000}
                    disabled={!writable}
                    onChange={(event) => seek(Number(event.target.value) * 1000)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!writable || !durationMs}
                  onClick={() => seek(timeMs - 1000 / (frames[0]?.fps ?? 25))}
                >
                  前移约一帧
                </button>
                <button
                  type="button"
                  disabled={!writable || !durationMs}
                  onClick={() => seek(timeMs + 1000 / (frames[0]?.fps ?? 25))}
                >
                  后移约一帧
                </button>
                <button
                  type="button"
                  disabled={!writable || !durationMs || frames.length >= 4}
                  onClick={() => void extract()}
                >
                  添加此画面
                </button>
              </div>
              <div className="shot-continuity-frames">
                {frames.map((frame) => (
                  <article key={frame.timeMs}>
                    <ImagePreview
                      src={frame.dataUrl}
                      alt={`${(frame.timeMs / 1000).toFixed(3)} 秒候选帧`}
                    />
                    <label>
                      <input
                        type="radio"
                        name={`continuity-anchor-${props.shotId}`}
                        checked={anchor === frame.timeMs}
                        disabled={!writable}
                        onChange={() => setAnchor(frame.timeMs)}
                      />
                      {(frame.timeMs / 1000).toFixed(3)}s · 用作衔接基准
                    </label>
                    <button
                      type="button"
                      disabled={!writable}
                      onClick={() => {
                        setFrames((current) =>
                          current.filter((item) => item.timeMs !== frame.timeMs),
                        );
                        if (anchor === frame.timeMs) setAnchor(undefined);
                      }}
                    >
                      移除此帧
                    </button>
                  </article>
                ))}
              </div>
              <label>
                衔接方式
                <select
                  aria-label="衔接方式"
                  value={mode}
                  disabled={!writable}
                  onChange={(event) => setMode(event.target.value as ShotContinuityMode)}
                >
                  <option value="continue">同机位续拍：直接使用基准帧</option>
                  <option value="reframe">换机位：先生成并确认新首帧</option>
                </select>
              </label>
              <label>
                连续性要求
                <textarea
                  aria-label="连续性要求"
                  value={notes}
                  maxLength={4000}
                  disabled={!writable}
                  placeholder="例如：仍站在第三根桥柱旁，双脚保持原位，只转头看向桥头。"
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!writable || !frames.length || anchor === undefined}
                onClick={() => void confirm()}
              >
                确认所选画面
              </button>
            </>
          )}
        </>
      )}
      {binding && (
        <>
          <h3>已确认的衔接</h3>
          <p>
            {binding.mode === 'continue' ? '同机位续拍' : '换机位'} ·{' '}
            {binding.notes || '未补充连续性要求'}
          </p>
          {context.stale && <p role="alert">剧情或衔接来源已变化，请重新选择并确认画面。</p>}
          {selectionPending && (
            <p role="status">选帧或衔接要求尚未确认，请先确认画面，再生成提示词。</p>
          )}
          <div className="shot-continuity-frames">
            {binding.frames.map((frame) => {
              const asset = context.images.find((item) => item.id === frame.assetId);
              return (
                <article key={frame.assetId}>
                  {asset && <AssetImagePreview asset={asset} />}
                  <span>
                    {(frame.timeMs / 1000).toFixed(3)}s
                    {frame.assetId === binding.anchorAssetId ? ' · 衔接基准' : ''}
                  </span>
                </article>
              );
            })}
          </div>
          {binding.mode === 'reframe' && (
            <label>
              确认下一视频首帧
              <select
                aria-label="确认下一视频首帧"
                value={binding.firstFrameAssetId ?? ''}
                disabled={!ready}
                onChange={(event) => void bindFirstFrame(event.target.value)}
              >
                <option value="">生成新构图后，人工选择图片</option>
                {images
                  .filter((asset) => !binding.frames.some((frame) => frame.assetId === asset.id))
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {referenceAssetName(asset)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <p>
            {props.llm
              ? `提示词 LLM：${props.llm.name}${props.llm.vision ? '' : '（当前模型不支持看图）'}`
              : '请先在会话中选择支持看图的 LLM 连接和模型。'}
          </p>
          {binding.mode === 'reframe' && (
            <>
              <button
                type="button"
                disabled={!canAskLlm}
                onClick={() => void generatePrompt('image')}
              >
                LLM 生成首帧图片提示词
              </button>
              <textarea
                aria-label="衔接首帧图片提示词"
                value={imagePrompt}
                maxLength={20000}
                disabled={!ready}
                onChange={(event) => setImagePrompt(event.target.value)}
              />
              <button
                type="button"
                disabled={!ready || !imagePrompt.trim()}
                onClick={() => void usePrompt('image')}
              >
                保存并制作新首帧
              </button>
            </>
          )}
          <button
            type="button"
            disabled={!canAskLlm || !binding.firstFrameAssetId}
            onClick={() => void generatePrompt('video')}
          >
            LLM 生成后续视频提示词
          </button>
          <textarea
            aria-label="衔接视频提示词"
            value={videoPrompt}
            maxLength={20000}
            disabled={!ready}
            onChange={(event) => setVideoPrompt(event.target.value)}
          />
          <button
            type="button"
            disabled={!ready || !binding.firstFrameAssetId || !videoPrompt.trim()}
            onClick={() => void usePrompt('video')}
          >
            保存并制作衔接视频
          </button>
          <button
            type="button"
            disabled={!writable}
            onClick={() =>
              void action(async () => {
                const next = await callWorker('shot.continuity.clear', {
                  shotId: props.shotId,
                  expectedRowVersion: context.rowVersion,
                });
                if (alive.current) {
                  adopt(next);
                  window.dispatchEvent(new CustomEvent('production-source-updated'));
                }
              })
            }
          >
            解除衔接
          </button>
        </>
      )}
      {generating && (
        <button
          type="button"
          onClick={() => {
            cancelPromptRequested.current = true;
            void run.current?.cancel();
          }}
        >
          停止生成提示词
        </button>
      )}
      {busy && <p role="status">{generating ? '正在生成提示词…' : '正在处理选帧…'}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
