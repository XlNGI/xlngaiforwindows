import { useEffect, useRef, useState } from 'react';
import type { AssetInfo, ShotContinuityContext } from '@ai-video/contracts';
import { continuityReferenceImageIds, continuitySourceImageIds } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { AssetImagePreview } from './AssetImagePreview';
import { referenceAssetName } from './ReferenceCard';
import { ContinuitySourceSelector } from './ContinuitySourceSelector';
import { ContinuityAssetPicker } from './ContinuityAssetPicker';
import { resolveAssetDrop, useAssetDrop } from './assets/use-asset-drop';

export function ShotContinuityPanel(props: {
  projectId: string;
  shotId: string;
  writable: boolean;
  sourceDirty: boolean;
  revision?: unknown;
  assets: AssetInfo[];
  llm?: { providerProfileId: string; modelId: string; name: string; vision: boolean };
  onChange: (context: ShotContinuityContext) => void;
  onGenerate: (mode: 'image', context: ShotContinuityContext) => void;
  onAskAgent?: (context: ShotContinuityContext) => Promise<void> | void;
}) {
  const callWorker = projectWorker();
  const [context, setContext] = useState<ShotContinuityContext>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectionPending, setSelectionPending] = useState(false);
  const [notes, setNotes] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [outputIds, setOutputIds] = useState<string[]>([]);
  const [firstFrame, setFirstFrame] = useState('');
  const [outputAssets, setOutputAssets] = useState<AssetInfo[]>([]);
  const edited = useRef({ notes: false, prompt: false, outputs: false });
  const alive = useRef(true);
  const running = useRef(false);
  const version = useRef<number | undefined>(undefined);
  const callbacks = useRef(props);
  callbacks.current = props;
  const adopt = (next: ShotContinuityContext, preserveEdits = false) => {
    version.current = next.rowVersion;
    setContext(next);
    if (!preserveEdits || !edited.current.prompt) setImagePrompt(next.binding?.imagePrompt ?? '');
    if (!preserveEdits || !edited.current.notes) setNotes(next.binding?.notes ?? '');
    if (!preserveEdits || !edited.current.outputs) {
      setOutputIds(
        next.binding
          ? [
              ...new Set([
                ...continuityReferenceImageIds(next.binding),
                ...(next.binding.firstFrameAssetId ? [next.binding.firstFrameAssetId] : []),
              ]),
            ]
          : [],
      );
      setFirstFrame(next.binding?.firstFrameAssetId ?? '');
    }
    if (!preserveEdits) edited.current = { notes: false, prompt: false, outputs: false };
    callbacks.current.onChange(next);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
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
        } else adopt(next, true);
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : '衔接设置读取失败。');
      });
    return () => {
      active = false;
    };
  }, [props.projectId, props.shotId, props.revision]);
  const action = async (work: () => Promise<void>) => {
    if (running.current || !props.writable || props.sourceDirty) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : '衔接操作失败。');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const changed = () => window.dispatchEvent(new CustomEvent('production-source-updated'));
  const reconfirm = () =>
    action(async () => {
      if (
        !context?.binding ||
        !context.reconfirmable ||
        context.currentShotRowVersion === undefined
      )
        return;
      const next = await callWorker('shot.continuity.reconfirm', {
        shotId: props.shotId,
        expectedRowVersion: context.rowVersion,
        expectedTargetRowVersion: context.currentShotRowVersion,
      });
      if (!alive.current) return;
      adopt(next, true);
      changed();
      setMessage('已确认沿用现有选帧，可以填充本镜视频表单。');
    });
  const askAgent = () =>
    action(async () => {
      if (!context || !props.onAskAgent) return;
      const next =
        notes.trim() === context.binding?.notes
          ? context
          : await callWorker('shot.continuity.intent.save', {
              shotId: props.shotId,
              expectedRowVersion: context.rowVersion,
              notes,
            });
      if (!alive.current) return;
      adopt(next, true);
      await props.onAskAgent(next);
      if (alive.current)
        setMessage('已交给 Agent。可在会话中继续说明目标，保存后的图片提示词会显示在这里。');
    });
  const savePrompt = (fill: boolean) =>
    action(async () => {
      if (!context) return;
      const intended =
        notes.trim() === context.binding?.notes
          ? context
          : await callWorker('shot.continuity.intent.save', {
              shotId: props.shotId,
              expectedRowVersion: context.rowVersion,
              notes,
            });
      if (!alive.current) return;
      const next = await callWorker('shot.continuity.prompt.save', {
        shotId: props.shotId,
        expectedRowVersion: intended.rowVersion,
        kind: 'image',
        prompt: imagePrompt,
      });
      if (!alive.current) return;
      edited.current.prompt = false;
      edited.current.notes = false;
      adopt(next, true);
      changed();
      if (fill) props.onGenerate('image', next);
      else setMessage('参考图提示词已保存。');
    });
  const writable = props.writable && !busy && !props.sourceDirty;
  const ready = writable && Boolean(context?.binding) && !context?.stale && !selectionPending;
  const binding = context?.binding;
  const images = [
    ...new Map(
      [...props.assets, ...(context?.images ?? []), ...outputAssets]
        .filter(
          (asset) =>
            asset.projectId === props.projectId &&
            !asset.deletedAt &&
            !asset.kind.includes('video'),
        )
        .map((asset) => [asset.id, asset]),
    ).values(),
  ];
  const toggleOutput = (asset: AssetInfo) => {
    if (!outputIds.includes(asset.id) && outputIds.length >= 12) {
      setMessage('本镜头最多绑定 12 张图片。');
      return;
    }
    edited.current.outputs = true;
    setOutputAssets((current) => [
      ...new Map([...current, asset].map((item) => [item.id, item])).values(),
    ]);
    setOutputIds((current) =>
      current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id],
    );
    if (firstFrame === asset.id) setFirstFrame('');
  };
  const outputDrop = useAssetDrop<HTMLDivElement>({
    enabled: ready,
    onDrop: (raw) => {
      void action(async () => {
        const { payload } = await resolveAssetDrop(
          raw,
          props.projectId,
          ['image'],
          12 - outputIds.length,
        );
        const assets = await callWorker('shot.continuity.assets', {
          shotId: props.shotId,
          assetIds: payload.assets.map((asset) => asset.id),
        });
        if (!alive.current) return;
        edited.current.outputs = true;
        setOutputAssets((current) => [
          ...new Map([...current, ...assets].map((asset) => [asset.id, asset])).values(),
        ]);
        setOutputIds((current) => [...new Set([...current, ...assets.map((asset) => asset.id)])]);
      });
    },
  });
  const saveOutputs = () =>
    action(async () => {
      if (!context) return;
      const next = await callWorker('shot.continuity.references', {
        shotId: props.shotId,
        expectedRowVersion: context.rowVersion,
        assetIds: outputIds,
        firstFrameAssetId: firstFrame || undefined,
      });
      if (!alive.current) return;
      edited.current.outputs = false;
      adopt(next, true);
      changed();
      setMessage('本镜头参考图片已确认绑定。');
    });
  return (
    <section className="shot-continuity-panel" aria-label="镜头衔接">
      <h2>镜头衔接</h2>
      {props.sourceDirty && <p role="status">本镜头内容有未保存修改，请先保存镜头提示词。</p>}
      <ContinuitySourceSelector
        key={`${props.projectId}:${props.shotId}`}
        projectId={props.projectId}
        shotId={props.shotId}
        context={context}
        writable={writable}
        notes={notes}
        onConfirm={adopt}
        onPending={setSelectionPending}
      />
      {binding && (
        <>
          <h3>已确认的衔接</h3>
          {context.stale &&
            (context.reconfirmable ? (
              <>
                <p role="alert">镜头提示词已变化，请核对现有参考画面，再明确确认是否沿用。</p>
                <button
                  type="button"
                  disabled={
                    !writable || selectionPending || context.currentShotRowVersion === undefined
                  }
                  onClick={() => void reconfirm()}
                >
                  确认沿用现有选帧
                </button>
              </>
            ) : (
              <p role="alert">剧情或衔接来源已变化，请重新选择并确认画面。</p>
            ))}
          {selectionPending && <p role="status">参考画面尚未确认，请确认或放弃本次选择。</p>}
          <div className="shot-continuity-frames">
            {continuitySourceImageIds(binding).map((assetId) => {
              const asset = context.images.find((item) => item.id === assetId);
              const frame = binding.frames.find((item) => item.assetId === assetId);
              return (
                <article key={assetId}>
                  {asset && <AssetImagePreview asset={asset} resolution="original" />}
                  <span>
                    {frame ? `${(frame.timeMs / 1000).toFixed(3)}s` : '参考图片'}
                    {assetId === binding.anchorAssetId ? ' · 衔接基准' : ''}
                  </span>
                </article>
              );
            })}
          </div>
          <label>
            生成要求
            <textarea
              aria-label="参考图生成要求"
              value={notes}
              maxLength={4000}
              disabled={!writable}
              placeholder="例如：本镜头中人物已转身后的侧面中景，保持服装、持物和其他人物位置。"
              onChange={(event) => {
                edited.current.notes = true;
                setNotes(event.target.value);
              }}
            />
          </label>
          <p>
            {props.llm
              ? `模型：${props.llm.name}${props.llm.vision ? '' : '（不支持看图）'}`
              : '未选择视觉模型，可手填提示词。'}
          </p>
          <button
            type="button"
            aria-label="交给 Agent 编写参考图提示词"
            disabled={!ready || !props.llm?.vision || !props.onAskAgent}
            onClick={() => void askAgent()}
          >
            Agent 编写
          </button>
          <label>
            图片提示词
            <textarea
              aria-label="参考图图片提示词"
              value={imagePrompt}
              maxLength={20000}
              disabled={!ready}
              onChange={(event) => {
                edited.current.prompt = true;
                setImagePrompt(event.target.value);
              }}
            />
          </label>
          <div className="shot-continuity-actions">
            <button
              type="button"
              aria-label="保存图片提示词"
              disabled={!ready || !imagePrompt.trim()}
              onClick={() => void savePrompt(false)}
            >
              保存提示词
            </button>
            <button
              type="button"
              className="continuity-primary-action"
              aria-label="填充参考图生图表单"
              disabled={!ready || !imagePrompt.trim()}
              onClick={() => void savePrompt(true)}
            >
              填充生图表单
            </button>
          </div>
          <h3>绑定本镜头图片</h3>
          <div
            ref={outputDrop.ref}
            {...outputDrop.handlers}
            className={`continuity-output-selector ${outputDrop.hovering ? 'is-asset-drag-over' : ''}`}
          >
            <ContinuityAssetPicker
              projectId={props.projectId}
              selectedIds={outputIds}
              onToggle={toggleOutput}
              disabled={!ready}
              imagesOnly
              label="从项目选择本镜图片"
            />
            <label>
              添加本镜头图片
              <select
                aria-label="添加本镜头图片"
                value=""
                disabled={!ready}
                onChange={(event) => {
                  const asset = images.find((item) => item.id === event.target.value);
                  if (asset) toggleOutput(asset);
                }}
              >
                <option value="">选择图片加入或移除</option>
                {images.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {referenceAssetName(asset)}
                  </option>
                ))}
              </select>
            </label>
            <div className="shot-continuity-frames">
              {outputIds.map((assetId, index) => {
                const asset = images.find((item) => item.id === assetId);
                return (
                  <article key={assetId}>
                    {asset && <AssetImagePreview asset={asset} resolution="original" />}
                    <span>
                      图片 {index + 1}
                      {firstFrame === assetId ? ' · 首帧' : ' · 普通参考图'}
                    </span>
                    <button
                      type="button"
                      disabled={!ready || index === 0}
                      onClick={() => {
                        edited.current.outputs = true;
                        setOutputIds((current) => {
                          const next = [...current];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          return next;
                        });
                      }}
                    >
                      前移图片 {index + 1}
                    </button>
                    <button
                      type="button"
                      disabled={!ready}
                      onClick={() => {
                        if (asset) toggleOutput(asset);
                        else {
                          edited.current.outputs = true;
                          setOutputIds((current) => current.filter((id) => id !== assetId));
                          if (firstFrame === assetId) setFirstFrame('');
                        }
                      }}
                    >
                      移除图片 {index + 1}
                    </button>
                  </article>
                );
              })}
            </div>
            <label>
              本镜头首帧
              <select
                aria-label="本镜头首帧"
                value={firstFrame}
                disabled={!ready || !outputIds.length}
                onChange={(event) => {
                  edited.current.outputs = true;
                  setFirstFrame(event.target.value);
                }}
              >
                <option value="">全部作为普通参考图</option>
                {outputIds.map((assetId, index) => (
                  <option key={assetId} value={assetId}>
                    图片 {index + 1}
                  </option>
                ))}
              </select>
            </label>
            {edited.current.outputs && <p role="status">图片绑定待确认。</p>}
            <button
              type="button"
              disabled={!ready || !edited.current.outputs}
              onClick={() => void saveOutputs()}
            >
              确认绑定图片
            </button>
          </div>
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
                  changed();
                }
              })
            }
          >
            解除衔接
          </button>
        </>
      )}
      {busy && <p role="status">正在处理…</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
