import { Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetInfo,
  AudioFileInfo,
  DocumentSummary,
  SceneInfo,
  SceneCharacterBindingInfo,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { AssetImagePreview } from './AssetImagePreview';
import { ReferenceCard, referenceAssetName } from './ReferenceCard';
import { ShotContinuityPanel } from './ShotContinuityPanel';
import type { ShotContinuityContext } from '@ai-video/contracts';
import { SceneSettingCard, useSceneSettingImages } from './SceneSettingCard';
import { SceneCastEditor } from './SceneCastEditor';
import { effectiveSceneCast, readSceneMedia, sceneMediaParams, useSceneMedia } from './scene-media';

const STORAGE_PREFIX = 'ai-video.shot-reference-assets:';

export type ShotReferenceSlot = 'character' | 'scene' | 'firstFrame';

export interface ShotReferenceAssets {
  characterAssetId?: string;
  characterAssetIds?: string[];
  sceneAssetId?: string;
  firstFrameAssetId?: string;
  continuityReferenceAssetIds?: string[];
  continuityRowVersion?: number;
  continuityPrompt?: string;
  ignoreSceneBinding?: boolean;
}

export function loadShotReferences(projectId: string, shotId: string): ShotReferenceAssets {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId);
    const parsed = raw ? (JSON.parse(raw) as Record<string, ShotReferenceAssets>) : {};
    return parsed[shotId] ?? {};
  } catch {
    return {};
  }
}

export function saveShotReferences(
  projectId: string,
  shotId: string,
  refs: ShotReferenceAssets,
): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId);
    const parsed = raw ? (JSON.parse(raw) as Record<string, ShotReferenceAssets>) : {};
    parsed[shotId] = refs;
    window.localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(parsed));
  } catch {
    // Storage can be unavailable in restricted webviews.
  }
}

function isVideoKind(kind: string): boolean {
  return kind.includes('video');
}

export function ShotWorkspace(props: Parameters<typeof ShotWorkspaceContent>[0]) {
  return <ShotWorkspaceContent key={`${props.projectId}:${props.shotId}`} {...props} />;
}

function ShotWorkspaceContent({
  projectId,
  shotId,
  sceneDocumentId,
  shotTitle,
  shotStatus,
  shotPosition,
  prompt,
  writable,
  assets,
  documents,
  storyboardTitle,
  storyboardContent,
  storyboardBusy,
  hasStoryboard,
  onPromptChange,
  onSavePrompt,
  onGenerateImage,
  onGenerateVideo,
  onStoryboardTitleChange,
  onStoryboardContentChange,
  onSaveStoryboard,
  scene,
  mediaRevision,
  onSaveSceneReferences,
  onBindSceneDocument,
  onOpenDocument,
  sceneBindingBusy,
  sceneBindingMessage,
  continuitySourceDirty = false,
  llm,
}: {
  projectId?: string;
  shotId: string;
  sceneDocumentId?: string;
  shotTitle: string;
  shotStatus: string;
  shotPosition: number;
  prompt: string;
  writable: boolean;
  assets: AssetInfo[];
  documents: DocumentSummary[];
  storyboardTitle: string;
  storyboardContent: string;
  storyboardBusy: boolean;
  hasStoryboard: boolean;
  onPromptChange: (value: string) => void;
  onSavePrompt: () => void;
  onGenerateImage: (refs: ShotReferenceAssets) => void;
  onGenerateVideo: (refs: ShotReferenceAssets) => void;
  onStoryboardTitleChange: (value: string) => void;
  onStoryboardContentChange: (value: string) => void;
  onSaveStoryboard: () => void;
  scene?: SceneInfo;
  mediaRevision?: number;
  onSaveSceneReferences?: (
    characters: SceneCharacterBindingInfo[],
    dialogueAudioId?: string,
  ) => Promise<unknown>;
  onBindSceneDocument?: (id: string) => void;
  onOpenDocument?: (id: string) => void;
  sceneBindingBusy?: boolean;
  sceneBindingMessage?: string;
  continuitySourceDirty?: boolean;
  llm?: { providerProfileId: string; modelId: string; name: string; vision: boolean };
}) {
  const callWorker = projectWorker();
  const [refs, setRefs] = useState<ShotReferenceAssets>(() =>
    projectId ? loadShotReferences(projectId, shotId) : {},
  );
  const [characters, setCharacters] = useState(scene?.characterBindings ?? []);
  const [dialogueAudioId, setDialogueAudioId] = useState(scene?.dialogueAudioId);
  const [audios, setAudios] = useState<AudioFileInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [continuity, setContinuity] = useState<ShotContinuityContext>();
  const [continuityRevision, setContinuityRevision] = useState(0);
  const continuityRefresh = useMemo(
    () => ({ mediaRevision, continuityRevision }),
    [mediaRevision, continuityRevision],
  );
  const revision = useMemo(() => ({ assets, mediaRevision }), [assets, mediaRevision]);
  const sceneMaterial = scene?.materialBindings?.find(
    (b) => b.role === 'scene' && (b.source === 'manual' || b.sourceDocumentId === sceneDocumentId),
  );
  const castMedia = useSceneMedia(
    projectId,
    sceneMediaParams(
      characters,
      [
        sceneMaterial?.assetId,
        refs.characterAssetId,
        refs.sceneAssetId,
        refs.firstFrameAssetId,
      ].filter((id): id is string => Boolean(id)),
    ),
    revision,
  );
  const savedCharacters = JSON.stringify(scene?.characterBindings ?? []);
  useEffect(() => {
    setCharacters(scene?.characterBindings ?? []);
  }, [savedCharacters]);
  useEffect(() => {
    setDialogueAudioId(scene?.dialogueAudioId);
  }, [scene?.dialogueAudioId]);
  useEffect(() => {
    let active = true;
    if (projectId && onSaveSceneReferences)
      void callWorker('audio.list', {})
        .then((items) => {
          if (active) setAudios(items);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId]);
  const [referenceMessage, setReferenceMessage] = useState('');
  const [shotImageResults, setShotImageResults] = useState<{
    shotId: string;
    projectId?: string;
    assets: AssetInfo[];
  }>();

  useEffect(() => {
    let active = true;
    if (projectId)
      void callWorker('asset.list', { shotId, sort: 'created-desc', limit: 60 })
        .then((items) => {
          if (active)
            setShotImageResults({
              shotId,
              projectId,
              assets: items.filter(
                (item) =>
                  item.projectId === projectId && !item.deletedAt && !isVideoKind(item.kind),
              ),
            });
        })
        .catch(() => {
          if (active) setShotImageResults({ shotId, projectId, assets: [] });
        });
    return () => {
      active = false;
    };
  }, [projectId, shotId, assets]);
  const setting = useSceneSettingImages(projectId, sceneDocumentId, documents, revision);
  const inheritedSceneAsset = setting.assets[0];
  const boundSceneAvailable = setting.available;
  const currentScope = useRef('');
  currentScope.current = `${projectId}:${shotId}:${sceneDocumentId}:${boundSceneAvailable}:${JSON.stringify(characters)}:${dialogueAudioId}`;
  useEffect(
    () => () => {
      currentScope.current = '';
    },
    [],
  );

  const availableAssets = useMemo(
    () => [
      ...new Map(
        [
          ...assets,
          ...(continuity?.images ?? []),
          ...(castMedia.value?.assets ?? []),
          ...(inheritedSceneAsset ? [inheritedSceneAsset] : []),
        ]
          .filter((a) => a.projectId === projectId && !a.deletedAt && !isVideoKind(a.kind))
          .map((a) => [a.id, a]),
      ).values(),
    ],
    [assets, inheritedSceneAsset, castMedia.value, projectId, continuity],
  );
  const effectiveRefs = {
    ...refs,
    sceneAssetId:
      refs.sceneAssetId ??
      (refs.ignoreSceneBinding ? undefined : (sceneMaterial?.assetId ?? inheritedSceneAsset?.id)),
  };

  useEffect(() => {
    setRefs(projectId ? loadShotReferences(projectId, shotId) : {});
  }, [projectId, shotId]);

  const persist = (next: ShotReferenceAssets) => {
    setRefs(next);
    if (projectId) saveShotReferences(projectId, shotId, next);
  };

  const assign = (slot: ShotReferenceSlot, assetId?: string) => {
    if (slot === 'firstFrame' && continuity?.binding) {
      if (!assetId) {
        setReferenceMessage('请先解除镜头衔接，再清除首帧。');
        return;
      }
      const scope = currentScope.current;
      void callWorker('shot.continuity.firstFrame', {
        shotId,
        assetId,
        expectedRowVersion: continuity.rowVersion,
      })
        .then(() => {
          if (currentScope.current === scope) setContinuityRevision((value) => value + 1);
        })
        .catch((error: unknown) => {
          if (currentScope.current === scope)
            setReferenceMessage(error instanceof Error ? error.message : '首帧更新失败。');
        });
      return;
    }
    const next = {
      ...refs,
      characterAssetId: slot === 'character' ? assetId : refs.characterAssetId,
      sceneAssetId: slot === 'scene' ? assetId : refs.sceneAssetId,
      firstFrameAssetId: slot === 'firstFrame' ? assetId : refs.firstFrameAssetId,
    };
    if (slot === 'scene' && sceneDocumentId) {
      if (!assetId) next.ignoreSceneBinding = true;
      else delete next.ignoreSceneBinding;
    }
    persist(next);
  };

  const saveReferences = async () => {
    if (saving || !writable) return false;
    if (
      JSON.stringify(characters) === JSON.stringify(scene?.characterBindings ?? []) &&
      dialogueAudioId === scene?.dialogueAudioId
    )
      return true;
    if (!onSaveSceneReferences) return true;
    setSaving(true);
    const scope = currentScope.current;
    try {
      const saved = await onSaveSceneReferences(characters, dialogueAudioId);
      return Boolean(saved) && currentScope.current === scope;
    } catch (error) {
      if (currentScope.current === scope)
        setReferenceMessage(error instanceof Error ? error.message : '参考资料保存失败。');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const resolveBoundReferences = async (): Promise<ShotReferenceAssets> => {
    const expectedScope = currentScope.current;
    let next = { ...refs };
    if (!next.sceneAssetId && !refs.ignoreSceneBinding && sceneMaterial)
      next.sceneAssetId = sceneMaterial.assetId;
    if (sceneDocumentId && !next.sceneAssetId && !refs.ignoreSceneBinding) {
      if (!boundSceneAvailable) throw new Error('绑定场景资料不可用，请重新选择场次的场景。');
      const items = await callWorker('asset.list', {
        sourceDocumentId: sceneDocumentId,
        sort: 'created-desc',
        limit: 200,
      });
      const asset = items.find(
        (item) => item.projectId === projectId && !item.deletedAt && !isVideoKind(item.kind),
      );
      if (asset) {
        next = { ...next, sceneAssetId: asset.id };
      }
    }
    if (characters.length && projectId) {
      const media = await readSceneMedia(projectId, sceneMediaParams(characters));
      const ids = effectiveSceneCast(characters, media).flatMap((c) =>
        c.imageAssetId ? [c.imageAssetId] : [],
      );
      next.characterAssetIds = [...new Set(ids)];
    }
    if (currentScope.current !== expectedScope) throw new Error('镜头或场景已切换，请重新生成。');
    if (sceneDocumentId && !refs.sceneAssetId) {
      const explicitRefs = { ...refs };
      delete explicitRefs.sceneAssetId;
      persist(explicitRefs);
    } else persist(refs);
    return next;
  };

  const generate = async (mode: 'image' | 'video') => {
    const expectedScope = currentScope.current;
    setReferenceMessage('');
    try {
      if (!(await saveReferences())) return;
      const resolved = await resolveBoundReferences();
      if (currentScope.current !== expectedScope) return;
      if (
        mode === 'video' &&
        ![
          ...(resolved.characterAssetIds ?? []),
          resolved.characterAssetId,
          resolved.sceneAssetId,
          resolved.firstFrameAssetId,
        ].some(Boolean)
      )
        throw new Error('请先生成或选择参考图。');
      const selected = {
        ...resolved,
        ...(continuity?.binding
          ? {
              continuityRowVersion: continuity.rowVersion,
              continuityPrompt:
                mode === 'image' ? continuity.binding.imagePrompt : continuity.binding.videoPrompt,
              ...(mode === 'image'
                ? {
                    continuityReferenceAssetIds: continuity.binding.frames.map(
                      (frame) => frame.assetId,
                    ),
                  }
                : {}),
            }
          : {}),
      };
      if (mode === 'image') onGenerateImage(selected);
      else onGenerateVideo(selected);
    } catch (error) {
      if (currentScope.current === expectedScope)
        setReferenceMessage(error instanceof Error ? error.message : '参考图读取失败');
    }
  };

  const hasSelectedRefs = Boolean(
    characters.some((c) => !c.imageDisabled) ||
    refs.characterAssetId ||
    effectiveRefs.sceneAssetId ||
    refs.firstFrameAssetId,
  );

  return (
    <div className="shot-workspace">
      <section className="shot-prompt-panel" aria-labelledby="shot-prompt-heading">
        <div className="shot-prompt-heading">
          <div>
            <h2 id="shot-prompt-heading">{'\u955c\u5934\u63d0\u793a\u8bcd'}</h2>
          </div>
          <span className="shot-status" title={shotTitle}>
            {`镜头 ${shotPosition + 1} · ${shotStatus === 'draft' ? '草稿' : shotStatus === 'published' ? '已发布' : shotStatus === 'ready' ? '就绪' : shotStatus}`}
          </span>
        </div>
        <textarea
          className="markdown-editor shot-prompt-editor"
          aria-label={'\u955c\u5934\u63d0\u793a\u8bcd'}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={'\u8f93\u5165\u672c\u955c\u753b\u9762\u63d0\u793a\u8bcd\u2026'}
          readOnly={!writable}
        />
        <div className="shot-prompt-actions">
          <button
            className="button secondary"
            type="button"
            disabled={!writable || saving}
            onClick={() => {
              void saveReferences().then((saved) => {
                if (saved) onSavePrompt();
              });
            }}
          >
            <Save size={13} /> {'\u4fdd\u5b58\u63d0\u793a\u8bcd'}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!writable || !prompt.trim()}
            onClick={() => {
              void generate('image');
            }}
          >
            {'\u751f\u6210\u672c\u955c\u753b\u9762'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={!writable || (!hasSelectedRefs && !sceneDocumentId)}
            onClick={() => {
              void generate('video');
            }}
          >
            {'\u7528\u53c2\u8003\u56fe\u751f\u6210\u89c6\u9891'}
          </button>
        </div>
      </section>
      {referenceMessage && <p role="status">{referenceMessage}</p>}
      {characters.length > 0 && castMedia.error && (
        <p role="status">
          {castMedia.error}{' '}
          <button type="button" onClick={castMedia.retry}>
            重试读取参考资料
          </button>
        </p>
      )}
      {projectId ? (
        <SceneCastEditor
          projectId={projectId}
          characters={characters}
          documents={documents}
          assets={availableAssets}
          voices={castMedia.value?.voices ?? []}
          defaults={castMedia.value?.characters ?? []}
          mediaLoading={castMedia.loading}
          sceneLabel={
            sceneDocumentId
              ? (documents.find((item) => item.id === sceneDocumentId)?.title ?? '资料不可用')
              : undefined
          }
          scopeNote={
            scene
              ? `沿用「${scene.title}」的角色与场景；修改角色绑定会同步到同场镜头。`
              : '选择本镜使用的角色、场景与首帧。'
          }
          audios={audios}
          dialogueAudioId={dialogueAudioId}
          writable={writable && !saving}
          onChange={setCharacters}
          onDialogueChange={setDialogueAudioId}
          onAudioImported={(audio) =>
            setAudios((items) => [audio, ...items.filter((a) => a.id !== audio.id)])
          }
          actions={
            <button
              className="button secondary"
              type="button"
              disabled={!writable || saving}
              onClick={() => void saveReferences()}
            >
              保存绑定
            </button>
          }
        >
          {characters.length === 0 || refs.characterAssetId ? (
            <ReferenceSlot
              label="角色参考"
              asset={availableAssets.find((a) => a.id === refs.characterAssetId)}
              candidates={availableAssets}
              projectId={projectId}
              writable={writable && !saving}
              onSelect={(id) => assign('character', id)}
            />
          ) : null}
          <SceneSettingCard
            projectId={projectId}
            documentId={sceneDocumentId}
            documents={documents}
            asset={availableAssets.find((a) => a.id === effectiveRefs.sceneAssetId)}
            images={setting.assets}
            candidates={availableAssets}
            writable={writable && !saving}
            busy={sceneBindingBusy}
            message={sceneBindingMessage || setting.error}
            onBind={onBindSceneDocument}
            onOpen={onOpenDocument}
            onSelectImage={(id) => assign('scene', id)}
            onDropAsset={(asset) => assign('scene', asset.id)}
            imageDisabled={refs.ignoreSceneBinding}
            onRestore={
              sceneDocumentId && (refs.sceneAssetId || refs.ignoreSceneBinding)
                ? () => {
                    const next = { ...refs };
                    delete next.sceneAssetId;
                    delete next.ignoreSceneBinding;
                    persist(next);
                  }
                : undefined
            }
          />
          <ReferenceSlot
            label="首帧"
            asset={availableAssets.find((a) => a.id === refs.firstFrameAssetId)}
            candidates={availableAssets}
            projectId={projectId}
            writable={writable && !saving}
            onSelect={(id) => assign('firstFrame', id)}
          />
        </SceneCastEditor>
      ) : null}
      {shotImageResults?.shotId === shotId &&
      shotImageResults.projectId === projectId &&
      shotImageResults.assets.length > 0 ? (
        <section className="shot-generated-images" aria-label="本镜头已生成图片">
          <h2>已生成图片</h2>
          <div className="generated-image-results">
            {shotImageResults.assets.map((item) => (
              <AssetImagePreview key={item.id} asset={item} />
            ))}
          </div>
        </section>
      ) : null}
      {projectId && (
        <details
          className="workspace-extra shot-continuity-extra"
          open={Boolean(continuity?.stale)}
        >
          <summary>镜头衔接{continuity?.binding ? ' · 已绑定' : ''}</summary>
          <ShotContinuityPanel
            projectId={projectId}
            shotId={shotId}
            writable={writable && !saving}
            sourceDirty={continuitySourceDirty}
            revision={continuityRefresh}
            assets={availableAssets}
            llm={llm}
            onChange={(next) => {
              setContinuity(next);
              setRefs((current) => {
                if (!next.binding && !continuity?.binding) return current;
                const updated = { ...current, firstFrameAssetId: next.binding?.firstFrameAssetId };
                saveShotReferences(projectId, shotId, updated);
                return updated;
              });
            }}
            onGenerate={(mode, next) => {
              const selected = {
                ...effectiveRefs,
                continuityRowVersion: next.rowVersion,
                continuityPrompt:
                  mode === 'image' ? next.binding?.imagePrompt : next.binding?.videoPrompt,
                firstFrameAssetId: next.binding?.firstFrameAssetId,
                ...(mode === 'image'
                  ? {
                      continuityReferenceAssetIds: next.binding?.frames.map(
                        (frame) => frame.assetId,
                      ),
                    }
                  : {}),
              };
              if (mode === 'image') onGenerateImage(selected);
              else onGenerateVideo(selected);
            }}
          />
        </details>
      )}
      <details className="workspace-extra shot-notes-extra">
        <summary>分镜说明{hasStoryboard ? ' · 已保存' : ' · 可选'}</summary>
        <section className="shot-notes-panel" aria-labelledby="shot-notes-heading">
          <h2 id="shot-notes-heading">{'\u5206\u955c\u8bf4\u660e'}</h2>
          <p>补充给创作者看的分镜笔记。</p>
          <label className="title-field">
            {'\u5206\u955c\u6807\u9898'}
            <input
              value={storyboardTitle}
              onChange={(event) => onStoryboardTitleChange(event.target.value)}
              placeholder={'\u8f93\u5165\u5206\u955c\u6807\u9898'}
              readOnly={!writable || storyboardBusy}
            />
          </label>
          <textarea
            className="markdown-editor"
            aria-label={'\u5206\u955c\u5185\u5bb9'}
            value={storyboardContent}
            onChange={(event) => onStoryboardContentChange(event.target.value)}
            placeholder={'# \u5206\u955c\n\n1. \u955c\u5934\u63cf\u8ff0\u2026'}
            readOnly={!writable || storyboardBusy}
          />
          <div className="toolbar-actions">
            <button
              className="button primary"
              type="button"
              disabled={!writable || storyboardBusy}
              onClick={onSaveStoryboard}
            >
              <Save size={13} />
              {hasStoryboard ? '\u4fdd\u5b58\u5206\u955c' : '\u65b0\u5efa\u5206\u955c'}
            </button>
            {storyboardBusy ? (
              <span className="inline-status">{'\u4fdd\u5b58\u4e2d\u2026'}</span>
            ) : null}
          </div>
        </section>
      </details>
    </div>
  );
}

function ReferenceSlot({
  label,
  asset,
  candidates,
  writable,
  projectId,
  onSelect,
}: {
  label: string;
  asset?: AssetInfo;
  candidates: AssetInfo[];
  writable: boolean;
  projectId?: string;
  onSelect: (assetId?: string) => void;
}) {
  return (
    <ReferenceCard
      label={label}
      asset={asset}
      writable={writable}
      projectId={projectId}
      onDropAsset={(a) => onSelect(a.id)}
      selector={
        <select
          aria-label={label}
          value={asset?.id ?? ''}
          disabled={!writable}
          onChange={(event) => onSelect(event.target.value || undefined)}
        >
          <option value="">未选择</option>
          {(asset && !candidates.some((a) => a.id === asset.id)
            ? [asset, ...candidates]
            : candidates
          ).map((a) => (
            <option key={a.id} value={a.id}>
              {referenceAssetName(a)}
            </option>
          ))}
        </select>
      }
    >
      {asset && (
        <button
          type="button"
          className="text-button"
          disabled={!writable}
          onClick={() => onSelect(undefined)}
        >
          清除
        </button>
      )}
    </ReferenceCard>
  );
}
