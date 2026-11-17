import { useEffect, useRef, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  ShotImageContext,
  ShotImagePurpose,
  PromptBindingIR,
  ProductionImageSelection,
  ShotContinuityContext,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { MarkdownEditor } from './MarkdownEditor';
import { AssetImagePreview } from './AssetImagePreview';
import { ContinuityAssetPicker } from './ContinuityAssetPicker';
import { referenceAssetName } from './ReferenceCard';

interface Draft {
  prompt: string;
  purpose: ShotImagePurpose;
  intent: string;
  bindings: PromptBindingIR;
  rowVersion: number;
  sourceToken: string;
  dirty: boolean;
}
// Window-local drafts survive directory navigation without writing project data or another window's edits.
const drafts = new Map<string, Draft>();
const adoptionDrafts = new Map<
  string,
  { selections: ProductionImageSelection[]; rowVersion: number }
>();
export function discardShotImageDraft(projectId: string, shotId: string) {
  const key = `${projectId}:${shotId}`;
  drafts.delete(key);
  adoptionDrafts.delete(key);
}
export function ShotImageWorkspace(props: {
  projectId: string;
  shotId: string;
  writable: boolean;
  assets: AssetInfo[];
  documents: DocumentSummary[];
  revision?: unknown;
  candidates?: AssetInfo[];
  onContext: (context: ShotImageContext) => void;
  onFill: (context: ShotImageContext) => void;
  onAskAgent?: (context: ShotImageContext) => Promise<void> | void;
  sources: React.ReactNode;
  continuity?: ShotContinuityContext;
  sourcesPending?: boolean;
}) {
  const worker = projectWorker();
  const key = `${props.projectId}:${props.shotId}`;
  const [context, setContext] = useState<ShotImageContext>();
  const [draft, setDraft] = useState<Draft | undefined>(() => drafts.get(key));
  const [selections, setSelections] = useState<ProductionImageSelection[]>(
    () => adoptionDrafts.get(key)?.selections ?? [],
  );
  const [adoptionDirty, setAdoptionDirty] = useState(() => adoptionDrafts.has(key));
  const adoptionVersion = useRef(adoptionDrafts.get(key)?.rowVersion ?? 0);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const alive = useRef(true),
    running = useRef(false),
    edited = useRef(Boolean(draft?.dirty)),
    adoptionEdited = useRef(adoptionDrafts.has(key));
  const callbacks = useRef(props);
  callbacks.current = props;
  const adopt = (next: ShotImageContext) => {
    if (!next || !next.videoImages || next.shotId !== props.shotId) return;
    setContext(next);
    callbacks.current.onContext(next);
    if (!edited.current)
      setDraft({
        prompt: next.prompt,
        purpose: next.purpose,
        intent: next.intent,
        bindings: next.bindings ?? { schemaVersion: 1 },
        rowVersion: next.rowVersion,
        sourceToken: next.currentSourceToken,
        dirty: false,
      });
    if (!adoptionEdited.current) {
      setSelections(next.videoImages.selections ?? []);
      adoptionVersion.current = next.videoImages.rowVersion;
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void worker('shot.image.get', { shotId: props.shotId })
      .then((next) => {
        if (active && next) adopt(next);
      })
      .catch((error) => {
        if (active) setMessage(String(error instanceof Error ? error.message : error));
      });
    return () => {
      active = false;
    };
  }, [props.projectId, props.shotId, props.revision]);
  const change = (value: Partial<Draft>) => {
    if (!draft) return;
    const next = { ...draft, ...value, dirty: true };
    edited.current = true;
    drafts.set(key, next);
    setDraft(next);
  };
  const editSelections = (
    update: (current: ProductionImageSelection[]) => ProductionImageSelection[],
  ) => {
    adoptionEdited.current = true;
    setAdoptionDirty(true);
    setSelections((current) => {
      const next = update(current);
      adoptionDrafts.set(key, { selections: next, rowVersion: adoptionVersion.current });
      return next;
    });
  };
  const action = async (work: () => Promise<void>) => {
    if (!props.writable || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      if (alive.current)
        setMessage(error instanceof Error ? error.message : '操作失败，草稿已保留。');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = async (fill = false) => {
    if (!draft || !context) return;
    if (context.sourceStale || props.sourcesPending)
      throw new Error('参考来源需要确认，当前草稿已保留。');
    const next = await worker('shot.image.save', {
      shotId: props.shotId,
      expectedRowVersion: draft.rowVersion,
      sourceToken: draft.sourceToken,
      prompt: draft.prompt,
      purpose: draft.purpose,
      intent: draft.intent,
      bindings: draft.bindings,
    });
    if (!alive.current) return;
    edited.current = false;
    drafts.delete(key);
    adopt(next);
    window.dispatchEvent(new CustomEvent('production-source-updated'));
    if (fill) {
      const preview = await worker('shot.prompt.preview', { shotId: props.shotId, kind: 'image' });
      if (alive.current)
        props.onFill({ ...next, prompt: preview.prompt, inputImages: preview.inputImages });
    } else setMessage('图片提示词已保存。');
  };
  const allAssets = [
    ...new Map(
      [...props.assets, ...(context?.assets ?? [])]
        .filter(
          (asset) =>
            asset.projectId === props.projectId &&
            !asset.deletedAt &&
            !asset.kind.includes('video'),
        )
        .map((asset) => [asset.id, asset]),
    ).values(),
  ];
  const choose = (asset: AssetInfo) => {
    if (!props.writable || busy) return;
    if (!selections.some((image) => image.assetId === asset.id) && selections.length >= 12) {
      setMessage('最多采用 12 张图片。');
      return;
    }
    editSelections((current) =>
      current.some((image) => image.assetId === asset.id)
        ? current.filter((image) => image.assetId !== asset.id)
        : [...current, { assetId: asset.id, role: 'reference' }],
    );
  };
  return (
    <section className="shot-image-workspace" aria-label="本镜参考图工作区">
      <section className="shot-image-sources">
        <h2>参考来源</h2>
        <div className="shot-video-image-list">
          {context?.inputImages.map((image, index) => {
            const asset = allAssets.find((asset) => asset.id === image.assetId);
            return (
              <article key={image.assetId}>
                {asset && <AssetImagePreview asset={asset} />}
                <span>{image.label ?? `参考图片 ${index + 1}`}</span>
              </article>
            );
          })}
        </div>
        <details
          className="workspace-extra shot-source-tools"
          open={context?.sourceStale || props.sourcesPending || undefined}
        >
          <summary>添加来源 / 视频选帧</summary>
          {props.sources}
        </details>
      </section>
      <div className="shot-image-authoring">
        <section className="shot-image-prompt-panel">
          <div className="shot-prompt-heading">
            <h2>图片提示词</h2>
            <span className="shot-status">{draft?.dirty ? '未保存' : '已保存'}</span>
          </div>
          <label>
            创作目标
            <select
              aria-label="图片创作目标"
              disabled={!props.writable || busy}
              value={draft?.purpose ?? 'composition'}
              onChange={(event) => change({ purpose: event.target.value as ShotImagePurpose })}
            >
              <option value="composition">构图参考</option>
              <option value="first-frame">视频首帧画面</option>
              <option value="last-frame">视频末帧画面</option>
            </select>
          </label>
          <p className="shot-scope-note">
            创作目标只说明要画的瞬间；实际视频用途在右侧采用图片时指定。
          </p>
          <details className="workspace-extra shot-image-instructions">
            <summary>本镜图片要求与出镜资料</summary>
            <label>
              本镜图片要求
              <textarea
                aria-label="本镜图片要求"
                maxLength={4000}
                value={draft?.intent ?? ''}
                disabled={!props.writable || busy}
                onChange={(event) => change({ intent: event.target.value })}
              />
            </label>
            <details className="workspace-extra">
              <summary>本图实际出镜资料</summary>
              <p>从共享资料中明确选择本图实际人物、场景和道具；不会自动继承视频后半段的人物。</p>
              {(['character', 'scene', 'prop'] as const).map((kind) => {
                const field =
                  kind === 'character'
                    ? 'characterDocumentIds'
                    : kind === 'scene'
                      ? 'sceneDocumentIds'
                      : 'propDocumentIds';
                return (
                  <fieldset key={kind}>
                    <legend>
                      {kind === 'character' ? '人物' : kind === 'scene' ? '场景' : '道具'}
                    </legend>
                    {props.documents
                      .filter(
                        (doc) =>
                          doc.kind === kind &&
                          doc.projectId === props.projectId &&
                          doc.lifecycleStatus === 'active',
                      )
                      .map((doc) => (
                        <label key={doc.id}>
                          <input
                            type="checkbox"
                            disabled={!props.writable || busy}
                            checked={draft?.bindings[field]?.includes(doc.id) ?? false}
                            onChange={(event) =>
                              change({
                                bindings: {
                                  ...(draft?.bindings ?? { schemaVersion: 1 }),
                                  [field]: event.target.checked
                                    ? [...(draft?.bindings[field] ?? []), doc.id]
                                    : (draft?.bindings[field] ?? []).filter((id) => id !== doc.id),
                                },
                              })
                            }
                          />
                          {doc.title}
                        </label>
                      ))}
                  </fieldset>
                );
              })}
            </details>
          </details>
          <MarkdownEditor
            label="本镜图片提示词"
            value={draft?.prompt ?? ''}
            onChange={(prompt) => change({ prompt })}
            readOnly={!props.writable || busy || !draft}
            autoPreviewOnBlur
            projectId={props.projectId}
            className="shot-prompt-editor"
          />
          {(context?.stale ||
            (draft && context && draft.sourceToken !== context.currentSourceToken)) && (
            <div role="alert">
              <p>创作依据已变化，旧正文与草稿已保留。请核对后确认沿用，或交给 Agent 重新编写。</p>
              <button
                type="button"
                disabled={!props.writable || busy || context.sourceStale}
                onClick={() => change({ sourceToken: context.currentSourceToken })}
              >
                已核对，沿用当前图片正文
              </button>
            </div>
          )}
          {draft && context && draft.rowVersion !== context.rowVersion && (
            <p role="alert">其他窗口已保存新版本。当前草稿保留，请复制需要的内容后重新载入。</p>
          )}
          <div className="shot-prompt-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!props.writable || busy || !draft}
              onClick={() => void action(() => save())}
            >
              保存图片提示词
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={
                !props.writable || busy || !context || context.sourceStale || !props.onAskAgent
              }
              onClick={() =>
                void action(async () => {
                  await save();
                  if (alive.current && context)
                    await props.onAskAgent?.(
                      await worker('shot.image.get', { shotId: props.shotId }),
                    );
                })
              }
            >
              Agent 编写图片
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!props.writable || busy || !draft?.prompt.trim() || context?.sourceStale}
              onClick={() => void action(() => save(true))}
            >
              填充本镜图片表单
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const next = await worker('shot.image.get', { shotId: props.shotId });
                  if (alive.current) {
                    edited.current = false;
                    drafts.delete(key);
                    adopt(next);
                  }
                })
              }
            >
              重新载入已保存正文
            </button>
          </div>
        </section>
      </div>
      <section className="shot-adopted-images" aria-label="本镜图片">
        <h2>本镜图片</h2>
        <p className="shot-scope-note">
          生成结果先作为候选；确认采用后才供本镜视频使用。移除引用不会删除素材。
        </p>
        <ContinuityAssetPicker
          projectId={props.projectId}
          selectedIds={selections.map((i) => i.assetId)}
          onToggle={choose}
          disabled={!props.writable || busy}
          imagesOnly
          label="从项目添加本镜图片"
        />
        <div className="shot-image-candidates">
          {(props.candidates ?? [])
            .filter(
              (asset) =>
                asset.projectId === props.projectId &&
                !asset.deletedAt &&
                !selections.some((i) => i.assetId === asset.id),
            )
            .map((asset) => (
              <article key={asset.id}>
                <AssetImagePreview asset={asset} />
                <button
                  type="button"
                  disabled={!props.writable || busy}
                  onClick={() => choose(asset)}
                >
                  采用 {referenceAssetName(asset)}
                </button>
              </article>
            ))}
        </div>
        <h3>供视频采用的图片{adoptionDirty ? ' · 待确认' : ''}</h3>
        {context && context.videoImages.selections === undefined && !adoptionDirty && (
          <p className="shot-scope-note">
            尚未单独确认视频图片，填表时沿用镜头已绑定的参考图。在此确认后使用下方列表；确认空列表则不填入图片。
          </p>
        )}
        {context?.videoImages.conflicts.map((message) => (
          <p role="alert" key={message}>
            {message}
          </p>
        ))}
        {selections.map((image, index) => (
          <article className="shot-adopted-image" key={image.assetId}>
            {allAssets.find((asset) => asset.id === image.assetId) && (
              <AssetImagePreview asset={allAssets.find((asset) => asset.id === image.assetId)!} />
            )}
            <span>
              图片 {index + 1} · {image.assetId}
            </span>
            <select
              aria-label={`图片 ${index + 1} 视频用途`}
              value={image.role}
              disabled={!props.writable || busy}
              onChange={(event) => {
                editSelections((current) =>
                  current.map((item) =>
                    item.assetId === image.assetId
                      ? { ...item, role: event.target.value as ProductionImageSelection['role'] }
                      : event.target.value === 'first-frame' && item.role === 'first-frame'
                        ? { ...item, role: 'reference' }
                        : item,
                  ),
                );
              }}
            >
              <option value="reference">普通参考</option>
              <option value="first-frame">显式首帧</option>
              {image.role === 'character' && <option value="character">角色参考</option>}
              {image.role === 'scene' && <option value="scene">场景参考</option>}
            </select>
            <div>
              <button
                type="button"
                disabled={!props.writable || busy || index === 0}
                onClick={() => {
                  editSelections((current) => {
                    const next = [...current];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    return next;
                  });
                }}
              >
                前移
              </button>
              <button
                type="button"
                disabled={!props.writable || busy}
                onClick={() => {
                  editSelections((current) =>
                    current.filter((item) => item.assetId !== image.assetId),
                  );
                }}
              >
                移除
              </button>
            </div>
          </article>
        ))}
        <button
          className="button secondary"
          type="button"
          disabled={
            !props.writable ||
            busy ||
            !context ||
            (!adoptionDirty &&
              context.videoImages.selections !== undefined &&
              !context.videoImages.conflicts.length)
          }
          onClick={() =>
            void action(async () => {
              if (!context) return;
              const next = await worker('shot.videoImages.save', {
                shotId: props.shotId,
                expectedRowVersion: adoptionVersion.current,
                selections,
              });
              if (!alive.current) return;
              adoptionDrafts.delete(key);
              adoptionEdited.current = false;
              setAdoptionDirty(false);
              adopt(next);
              window.dispatchEvent(new CustomEvent('production-source-updated'));
              setMessage('已确认本镜视频采用图片。');
            })
          }
        >
          确认采用图片
        </button>
      </section>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
