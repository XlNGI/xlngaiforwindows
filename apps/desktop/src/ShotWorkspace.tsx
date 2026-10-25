import { Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetInfo,
  AudioFileInfo,
  DocumentSummary,
  SceneInfo,
  SceneCharacterBindingInfo,
  ShotReferenceBindingInfo,
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
  characterBindings?: NonNullable<ShotReferenceBindingInfo['characterBindings']>;
  sceneBindings?: NonNullable<ShotReferenceBindingInfo['sceneBindings']>;
  characterAssetId?: string;
  characterAssetIds?: string[];
  sceneAssetId?: string;
  sceneAssetIds?: string[];
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
  referenceBindings,
  onSaveReferenceBindings,
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
  referenceBindings?: ShotReferenceBindingInfo;
  onSaveReferenceBindings?: (bindings: ShotReferenceBindingInfo | null) => Promise<unknown>;
  continuitySourceDirty?: boolean;
  llm?: { providerProfileId: string; modelId: string; name: string; vision: boolean };
}) {
  const callWorker = projectWorker();
  const [refs, setRefs] = useState<ShotReferenceAssets>(() => {
    const local = projectId ? loadShotReferences(projectId, shotId) : {};
    return referenceBindings
      ? {
          continuityReferenceAssetIds: local.continuityReferenceAssetIds,
          continuityRowVersion: local.continuityRowVersion,
          continuityPrompt: local.continuityPrompt,
          ...referenceBindings,
        }
      : local;
  });
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
  const sceneDocumentIds = Array.from(
    new Set(
      scene?.sceneDocumentIds?.length
        ? scene.sceneDocumentIds
        : sceneDocumentId
          ? [sceneDocumentId]
          : [],
    ),
  );
  const primarySceneDocumentId = sceneDocumentId ?? sceneDocumentIds[0];
  const sceneMaterials =
    scene?.materialBindings?.filter(
      (binding) =>
        binding.role === 'scene' &&
        (binding.source === 'manual' || sceneDocumentIds.includes(binding.sourceDocumentId ?? '')),
    ) ?? [];
  const sceneMaterial = scene?.materialBindings?.find(
    (b) =>
      b.role === 'scene' &&
      (b.source === 'manual' || sceneDocumentIds.includes(b.sourceDocumentId ?? '')),
  );
  const castMedia = useSceneMedia(
    projectId,
    sceneMediaParams(
      characters,
      [
        sceneMaterial?.assetId,
        refs.characterAssetId,
        refs.sceneAssetId,
        ...(refs.sceneAssetIds ?? []),
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
  const referenceSave = useRef<Promise<unknown>>(Promise.resolve());
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
  const setting = useSceneSettingImages(projectId, sceneDocumentIds, documents, revision);
  const inheritedSceneAsset = setting.assets[0];
  const boundSceneAvailable = setting.available;
  const currentScope = useRef('');
  currentScope.current = `${projectId}:${shotId}:${sceneDocumentIds.join('|')}:${boundSceneAvailable}:${JSON.stringify(characters)}:${dialogueAudioId}`;
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
          ...setting.assets,
        ]
          .filter((a) => a.projectId === projectId && !a.deletedAt && !isVideoKind(a.kind))
          .map((a) => [a.id, a]),
      ).values(),
    ],
    [assets, setting.assets, castMedia.value, projectId, continuity],
  );
  const effectiveRefs = {
    ...refs,
    sceneAssetId:
      refs.sceneAssetId ??
      (refs.ignoreSceneBinding ? undefined : (sceneMaterial?.assetId ?? inheritedSceneAsset?.id)),
    sceneAssetIds:
      refs.sceneAssetIds ??
      (refs.ignoreSceneBinding
        ? undefined
        : sceneMaterials.length > 1
          ? sceneMaterials.map((binding) => binding.assetId)
          : undefined),
  };

  useEffect(() => {
    const local = projectId ? loadShotReferences(projectId, shotId) : {};
    setRefs(
      referenceBindings
        ? {
            continuityReferenceAssetIds: local.continuityReferenceAssetIds,
            continuityRowVersion: local.continuityRowVersion,
            continuityPrompt: local.continuityPrompt,
            ...referenceBindings,
          }
        : local,
    );
  }, [projectId, shotId, referenceBindings]);

  const durableReferences = (next: ShotReferenceAssets): ShotReferenceBindingInfo => ({
    ...(next.characterBindings?.length ? { characterBindings: next.characterBindings } : {}),
    ...(next.sceneBindings?.length ? { sceneBindings: next.sceneBindings } : {}),
    ...(next.characterAssetId ? { characterAssetId: next.characterAssetId } : {}),
    ...(next.characterAssetIds?.length ? { characterAssetIds: next.characterAssetIds } : {}),
    ...(next.sceneAssetId ? { sceneAssetId: next.sceneAssetId } : {}),
    ...(next.sceneAssetIds?.length ? { sceneAssetIds: next.sceneAssetIds } : {}),
    ...(next.firstFrameAssetId ? { firstFrameAssetId: next.firstFrameAssetId } : {}),
    ...(next.ignoreSceneBinding ? { ignoreSceneBinding: true } : {}),
  });

  const persist = (next: ShotReferenceAssets, saveLocal = true) => {
    setRefs(next);
    if (saveLocal && projectId) saveShotReferences(projectId, shotId, next);
    if (onSaveReferenceBindings) {
      const durable = durableReferences(next);
      referenceSave.current = referenceSave.current
        .catch(() => undefined)
        .then(() => onSaveReferenceBindings(durable));
    }
    return referenceSave.current;
  };

  const persistFromControl = (next: ShotReferenceAssets) => {
    void persist(next).catch((error: unknown) => {
      setReferenceMessage(error instanceof Error ? error.message : '镜头参考图保存失败。');
    });
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
      characterBindings:
        slot === 'character'
          ? undefined
          : refs.characterBindings,
      sceneBindings:
        slot === 'scene'
          ? assetId && primarySceneDocumentId
            ? [{ sourceDocumentId: primarySceneDocumentId, assetId }]
            : undefined
          : refs.sceneBindings,
      characterAssetId: slot === 'character' ? assetId : refs.characterAssetId,
      characterAssetIds: slot === 'character' ? undefined : refs.characterAssetIds,
      sceneAssetId: slot === 'scene' ? assetId : refs.sceneAssetId,
      sceneAssetIds: slot === 'scene' ? (assetId ? [assetId] : undefined) : refs.sceneAssetIds,
      firstFrameAssetId: slot === 'firstFrame' ? assetId : refs.firstFrameAssetId,
    };
    if (slot === 'scene' && sceneDocumentIds.length) {
      if (!assetId) next.ignoreSceneBinding = true;
      else delete next.ignoreSceneBinding;
    }
    persistFromControl(next);
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
    if (!next.sceneAssetIds?.length && !refs.ignoreSceneBinding && sceneMaterials.length > 1)
      next.sceneAssetIds = sceneMaterials.map((binding) => binding.assetId);
    if (onSaveReferenceBindings && !next.sceneBindings?.length && !refs.ignoreSceneBinding && sceneMaterials.length) {
      const mapped = sceneMaterials.flatMap((binding) =>
        binding.sourceDocumentId
          ? [{ sourceDocumentId: binding.sourceDocumentId, assetId: binding.assetId }]
          : [],
      );
      if (mapped.length) next.sceneBindings = mapped;
    }
    if (sceneDocumentIds.length && !next.sceneAssetIds?.length && !refs.ignoreSceneBinding) {
      if (!boundSceneAvailable) throw new Error('绑定场景资料不可用，请重新选择场次的场景。');
      const groups = await Promise.all(
        sceneDocumentIds.map((sourceDocumentId) =>
          callWorker('asset.list', {
            sourceDocumentId,
            sort: 'created-desc',
            limit: 200,
          }),
        ),
      );
      const sceneAssetEntries = groups
        .map((items, index) => {
          const asset = items.find(
            (item) => item.projectId === projectId && !item.deletedAt && !isVideoKind(item.kind),
          );
          return asset ? { sourceDocumentId: sceneDocumentIds[index]!, asset } : undefined;
        })
        .filter(
          (entry): entry is { sourceDocumentId: string; asset: AssetInfo } => Boolean(entry),
        );
      const sceneAssets = sceneAssetEntries.map((entry) => entry.asset);
      if (sceneAssets.length)
        next = {
          ...next,
          sceneAssetId: next.sceneAssetId ?? sceneAssets[0]?.id,
          ...(onSaveReferenceBindings
            ? {
                sceneBindings: sceneAssetEntries.map(({ sourceDocumentId, asset }) => ({
                  sourceDocumentId,
                  assetId: asset.id,
                })),
              }
            : {}),
          ...(sceneAssets.length > 1
            ? { sceneAssetIds: sceneAssets.map((asset) => asset.id) }
            : {}),
        };
    }
    if (characters.length && projectId) {
      const production = await callWorker('production.read', {
        target: { kind: 'shot', id: shotId },
      }).catch(() => undefined);
      if (currentScope.current !== expectedScope) throw new Error('镜头或场景已切换，请重新生成。');
      const characterIds = production?.authoringIR?.references?.characterDocumentIds;
      const shotCharacters = characters.filter(
        (character) =>
          characterIds === undefined || characterIds.includes(character.characterDocumentId),
      );
      const media = await readSceneMedia(projectId, sceneMediaParams(shotCharacters));
      const ids = effectiveSceneCast(shotCharacters, media).flatMap((c) =>
        c.imageAssetId ? [c.imageAssetId] : [],
      );
      next.characterAssetIds = [...new Set(ids)];
      if (onSaveReferenceBindings)
        next.characterBindings = effectiveSceneCast(shotCharacters, media).flatMap((character) =>
          character.imageAssetId
            ? [{ characterDocumentId: character.characterDocumentId, assetId: character.imageAssetId }]
            : [],
        );
    }
    if (currentScope.current !== expectedScope) throw new Error('镜头或场景已切换，请重新生成。');
    // Automatic scene/cast defaults are saved to the durable binding record,
    // but must not become a local override that blocks future scene changes.
    await persist(next, false);
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
          ...(resolved.sceneAssetIds ?? []),
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
    effectiveRefs.sceneAssetIds?.length ||
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
            disabled={!writable || (!hasSelectedRefs && !sceneDocumentIds.length)}
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
            sceneDocumentIds.length
              ? sceneDocumentIds
                  .map((id) => documents.find((item) => item.id === id)?.title ?? '资料不可用')
                  .join('、')
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
            documentId={primarySceneDocumentId}
            documentIds={sceneDocumentIds}
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
              sceneDocumentIds.length &&
              (refs.sceneAssetId || refs.sceneAssetIds?.length || refs.ignoreSceneBinding)
                ? () => {
                    const next = { ...refs };
                    delete next.sceneAssetId;
                    delete next.sceneAssetIds;
                    delete next.ignoreSceneBinding;
                    persistFromControl(next);
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
