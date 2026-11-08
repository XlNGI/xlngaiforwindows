import { Save, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  ProductionShotAuthoringIR,
  ProductionImageBindingPromptEntry,
  SceneCharacterBindingInfo,
  ShotReferenceBindingInfo,
  ProductionImageSelection,
} from '@ai-video/contracts';
import {
  productionImageBindingPrompt,
  continuityReferenceImageIds,
  continuitySourceImageIds,
  productionShotReferenceIds,
  stripProductionImageBindingPrompt,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { AssetImagePreview } from './AssetImagePreview';
import { ReferenceCard, referenceAssetName } from './ReferenceCard';
import { ShotContinuityPanel } from './ShotContinuityPanel';
import type { ShotContinuityContext } from '@ai-video/contracts';
import { SceneSettingCard, useSceneSettingImages } from './SceneSettingCard';
import { SceneCastEditor } from './SceneCastEditor';
import { effectiveSceneCast, readSceneMedia, sceneMediaParams, useSceneMedia } from './scene-media';
import { MarkdownEditor } from './MarkdownEditor';
import {
  promptImageReferences as createPromptImageReferences,
  remapPromptReferences,
} from './prompt-references';

export function shotReferenceImageSelections(
  refs: ShotReferenceAssets,
): ProductionImageSelection[] {
  const selections: ProductionImageSelection[] = [];
  const selected = new Set<string>();
  const add = (assetId: string | undefined, role: ProductionImageSelection['role']) => {
    if (!assetId) return;
    if (selected.has(assetId)) {
      // An explicit frame binding wins without uploading the same image twice.
      if (role === 'first-frame')
        selections.find((image) => image.assetId === assetId)!.role = role;
      return;
    }
    selected.add(assetId);
    selections.push({ assetId, role });
  };
  const characterIds = refs.characterBindings?.length
    ? refs.characterBindings.map((binding) => binding.assetId)
    : (refs.characterAssetIds ?? []);
  characterIds.forEach((assetId) => add(assetId, 'character'));
  add(refs.characterAssetId, 'character');
  const sceneIds = refs.sceneBindings?.length
    ? refs.sceneBindings.map((binding) => binding.assetId)
    : (refs.sceneAssetIds ?? []);
  add(refs.sceneAssetId, 'scene');
  sceneIds.forEach((assetId) => add(assetId, 'scene'));
  add(refs.firstFrameAssetId, 'first-frame');
  refs.continuityReferenceAssetIds?.forEach((assetId) => add(assetId, 'reference'));
  return selections;
}

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

function durableReferences(next: ShotReferenceAssets): ShotReferenceBindingInfo {
  return {
    ...(next.characterBindings?.length ? { characterBindings: next.characterBindings } : {}),
    ...(next.sceneBindings?.length ? { sceneBindings: next.sceneBindings } : {}),
    ...(next.characterAssetId ? { characterAssetId: next.characterAssetId } : {}),
    ...(next.characterAssetIds?.length ? { characterAssetIds: next.characterAssetIds } : {}),
    ...(next.sceneAssetId ? { sceneAssetId: next.sceneAssetId } : {}),
    ...(next.sceneAssetIds?.length ? { sceneAssetIds: next.sceneAssetIds } : {}),
    ...(next.firstFrameAssetId ? { firstFrameAssetId: next.firstFrameAssetId } : {}),
    ...(next.ignoreSceneBinding ? { ignoreSceneBinding: true } : {}),
  };
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
  onRepairBindings,
  onAskContinuityAgent,
  onPrepareGenerate,
  onGenerateImage,
  onGenerateVideo,
  onStoryboardTitleChange,
  onStoryboardContentChange,
  onSaveStoryboard,
  mediaRevision,
  onOpenDocument,
  referenceBindings,
  authoringIR,
  onSaveReferenceBindings,
  continuitySourceDirty = false,
  llm,
}: {
  projectId?: string;
  shotId: string;
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
  onRepairBindings?: (prompt: string) => Promise<unknown> | void;
  onAskContinuityAgent?: (context: ShotContinuityContext) => Promise<void> | void;
  onPrepareGenerate?: (mode: 'image' | 'video', prompt: string, refs: ShotReferenceAssets) => void;
  onGenerateImage: (refs: ShotReferenceAssets, prompt?: string) => void;
  onGenerateVideo: (refs: ShotReferenceAssets, prompt?: string) => void;
  onStoryboardTitleChange: (value: string) => void;
  onStoryboardContentChange: (value: string) => void;
  onSaveStoryboard: () => void;
  mediaRevision?: number;
  onOpenDocument?: (id: string) => void;
  referenceBindings?: ShotReferenceBindingInfo;
  authoringIR?: ProductionShotAuthoringIR;
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
  const [characters, setCharacters] = useState<SceneCharacterBindingInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [continuity, setContinuity] = useState<ShotContinuityContext>();
  const [continuityRevision, setContinuityRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setContinuityRevision((value) => value + 1);
    window.addEventListener('production-source-updated', refresh);
    return () => window.removeEventListener('production-source-updated', refresh);
  }, [projectId, shotId]);

  const continuityRefresh = useMemo(
    () => ({ mediaRevision, continuityRevision }),
    [mediaRevision, continuityRevision],
  );
  const revision = useMemo(() => ({ assets, mediaRevision }), [assets, mediaRevision]);
  const promptCharacterScopeKey = `${projectId ?? ''}:${shotId}`;
  const [promptCharacterScope, setPromptCharacterScope] = useState<
    | {
        key: string;
        authoringIR?: ProductionShotAuthoringIR;
      }
    | undefined
  >();
  useEffect(() => {
    let active = true;
    const apply = (ir?: ProductionShotAuthoringIR) => {
      setPromptCharacterScope({ key: promptCharacterScopeKey, authoringIR: ir });
    };
    setPromptCharacterScope(undefined);
    if (authoringIR) {
      apply(authoringIR);
      return () => {
        active = false;
      };
    }
    if (!projectId) {
      apply();
      return;
    }
    void Promise.resolve()
      .then(() => callWorker('production.read', { target: { kind: 'shot', id: shotId } }))
      .then((production) => {
        const ir = production?.authoringIR;
        if (active) apply(ir?.kind === 'shot' ? (ir as ProductionShotAuthoringIR) : undefined);
      })
      .catch(() => {
        if (active) apply();
      });
    return () => {
      active = false;
    };
  }, [authoringIR, projectId, shotId, promptCharacterScopeKey]);
  const currentPromptCharacterScope =
    promptCharacterScope?.key === promptCharacterScopeKey
      ? {
          key: promptCharacterScope.key,
          ...productionShotReferenceIds({
            authoringIR: promptCharacterScope.authoringIR,
            referenceBindings,
          }),
        }
      : undefined;
  const sceneDocumentIds = currentPromptCharacterScope?.sceneDocumentIds ?? [];
  const primarySceneDocumentId = sceneDocumentIds[0];
  const promptDocumentGroups = [
    {
      key: 'character',
      label: '角色',
      documentIds: currentPromptCharacterScope?.characterDocumentIds ?? [],
    },
    { key: 'scene', label: '场景', documentIds: sceneDocumentIds },
    {
      key: 'prop',
      label: '道具',
      documentIds: currentPromptCharacterScope?.propDocumentIds ?? [],
    },
  ] as const;
  const sceneMaterials = refs.sceneBindings ?? [];
  const castMedia = useSceneMedia(
    projectId,
    sceneMediaParams(
      characters,
      [
        refs.characterAssetId,
        refs.sceneAssetId,
        ...(refs.sceneAssetIds ?? []),
        ...sceneMaterials.map((binding) => binding.assetId),
        refs.firstFrameAssetId,
      ].filter((id): id is string => Boolean(id)),
    ),
    revision,
  );
  useEffect(() => {
    if (!currentPromptCharacterScope) {
      setCharacters([]);
      return;
    }
    const savedBindings = new Map(
      (refs.characterBindings ?? []).map((binding) => [
        binding.characterDocumentId,
        binding.assetId,
      ]),
    );
    const legacyAssets =
      refs.characterAssetIds ?? (refs.characterAssetId ? [refs.characterAssetId] : []);
    setCharacters(
      currentPromptCharacterScope.characterDocumentIds.map((characterDocumentId, index) => {
        const assetId = savedBindings.get(characterDocumentId) ?? legacyAssets[index];
        return { characterDocumentId, ...(assetId ? { imageAssetId: assetId } : {}) };
      }),
    );
  }, [
    currentPromptCharacterScope?.key,
    currentPromptCharacterScope?.characterDocumentIds.join('|'),
    refs.characterBindings,
    refs.characterAssetId,
    refs.characterAssetIds,
  ]);
  const [referenceMessage, setReferenceMessage] = useState('');
  const [repairPending, setRepairPending] = useState(false);
  const [fillingMode, setFillingMode] = useState<'image' | 'video'>();
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
  const boundSceneAvailable = setting.available;
  const sceneReferenceEntries = sceneDocumentIds.flatMap((sourceDocumentId) => {
    const saved = sceneMaterials.find((binding) => binding.sourceDocumentId === sourceDocumentId);
    const defaultAsset = setting.assetsByDocument[sourceDocumentId]?.[0];
    const assetId = saved?.assetId ?? defaultAsset?.id;
    return assetId ? [{ sourceDocumentId, assetId }] : [];
  });
  const currentScope = useRef('');
  const referenceEditRevision = useRef(0);
  const bindingSnapshot = JSON.stringify(durableReferences(referenceBindings ?? {}));
  const observedBindingSnapshot = useRef(bindingSnapshot);
  const savedBindingSnapshot = useRef<string | undefined>(undefined);
  if (observedBindingSnapshot.current !== bindingSnapshot) {
    observedBindingSnapshot.current = bindingSnapshot;
    // A save echoes this action's resolved defaults. Other binding changes invalidate it.
    if (bindingSnapshot !== savedBindingSnapshot.current) referenceEditRevision.current += 1;
  }
  currentScope.current = JSON.stringify({
    projectId,
    shotId,
    references: currentPromptCharacterScope,
    boundSceneAvailable,
    referenceEditRevision: referenceEditRevision.current,
    prompt,
    continuity: continuity?.binding && {
      shotId: continuity.shotId,
      rowVersion: continuity.rowVersion,
      stale: continuity.stale,
      binding: continuity.binding,
    },
  });
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
    ...(continuity?.binding
      ? {
          firstFrameAssetId: continuity.binding.firstFrameAssetId,
          continuityReferenceAssetIds: continuityReferenceImageIds(continuity.binding),
        }
      : {}),
    sceneAssetId: refs.ignoreSceneBinding
      ? undefined
      : (refs.sceneAssetId ?? sceneReferenceEntries[0]?.assetId),
    sceneAssetIds: refs.ignoreSceneBinding
      ? undefined
      : (refs.sceneAssetIds ??
        (sceneReferenceEntries.length > 1
          ? sceneReferenceEntries.map((binding) => binding.assetId)
          : undefined)),
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

  const persist = (next: ShotReferenceAssets, saveLocal = true) => {
    setRefs(next);
    if (saveLocal && projectId) saveShotReferences(projectId, shotId, next);
    if (onSaveReferenceBindings) {
      const durable = durableReferences(next);
      savedBindingSnapshot.current = JSON.stringify(durable);
      referenceSave.current = referenceSave.current
        .catch(() => undefined)
        .then(() => onSaveReferenceBindings(durable));
    }
    return referenceSave.current;
  };

  const persistFromControl = (next: ShotReferenceAssets) => {
    referenceEditRevision.current += 1;
    void persist(next).catch((error: unknown) => {
      setReferenceMessage(error instanceof Error ? error.message : '镜头参考图保存失败。');
    });
  };

  const assign = (slot: ShotReferenceSlot, assetId?: string) => {
    if (slot === 'firstFrame' && continuity?.binding) {
      const scope = currentScope.current;
      void callWorker('shot.continuity.reference', {
        shotId,
        assetId,
        role: 'first-frame',
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
      characterBindings: slot === 'character' ? undefined : refs.characterBindings,
      sceneBindings:
        slot === 'scene'
          ? assetId && primarySceneDocumentId
            ? [
                ...(refs.sceneBindings ?? []).filter(
                  (binding) => binding.sourceDocumentId !== primarySceneDocumentId,
                ),
                { sourceDocumentId: primarySceneDocumentId, assetId },
              ]
            : (refs.sceneBindings ?? []).filter(
                (binding) => binding.sourceDocumentId !== primarySceneDocumentId,
              )
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
    setSaving(true);
    const scope = currentScope.current;
    try {
      await resolveBoundReferences();
      return currentScope.current === scope;
    } catch (error) {
      if (currentScope.current === scope)
        setReferenceMessage(error instanceof Error ? error.message : '参考资料保存失败。');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const repairBindings = async () => {
    if (!onRepairBindings || repairPending || !writable || !prompt.trim()) return;
    setRepairPending(true);
    setReferenceMessage('');
    try {
      await onRepairBindings(stripProductionImageBindingPrompt(prompt));
      setReferenceMessage('修复请求已发送到会话。');
    } catch (error) {
      setReferenceMessage(error instanceof Error ? error.message : '镜头绑定修复失败。');
    } finally {
      setRepairPending(false);
    }
  };

  const resolveBoundReferences = async (
    beforeSave?: (references: ShotReferenceAssets) => void,
  ): Promise<ShotReferenceAssets> => {
    const expectedScope = currentScope.current;
    if (!currentPromptCharacterScope)
      throw new Error('镜头引用关系尚未读取，请稍后重试或修复本镜绑定。');
    const next = { ...effectiveRefs };
    if (refs.ignoreSceneBinding || sceneDocumentIds.length === 0) {
      delete next.sceneAssetId;
      delete next.sceneAssetIds;
      delete next.sceneBindings;
    } else {
      if (!boundSceneAvailable) throw new Error('本镜绑定的场景资料不可用，请修复绑定。');
      const structured = new Map(
        (next.sceneBindings ?? []).map((binding) => [binding.sourceDocumentId, binding.assetId]),
      );
      const legacyAssets = next.sceneAssetIds ?? (next.sceneAssetId ? [next.sceneAssetId] : []);
      const missingIds = sceneDocumentIds.filter(
        (id, index) =>
          !structured.has(id) && !legacyAssets[index] && !setting.assetsByDocument[id]?.length,
      );
      const groups = await Promise.all(
        missingIds.map((sourceDocumentId) =>
          callWorker('asset.list', { sourceDocumentId, sort: 'created-desc', limit: 200 }),
        ),
      );
      const fetchedDefaults = new Map(
        missingIds.flatMap((id, index) => {
          const asset = groups[index]?.find(
            (item) => item.projectId === projectId && !item.deletedAt && !isVideoKind(item.kind),
          );
          return asset ? [[id, asset.id] as const] : [];
        }),
      );
      const selected = sceneDocumentIds.flatMap((sourceDocumentId, index) => {
        const assetId =
          structured.get(sourceDocumentId) ??
          legacyAssets[index] ??
          setting.assetsByDocument[sourceDocumentId]?.[0]?.id ??
          fetchedDefaults.get(sourceDocumentId);
        return assetId ? [{ sourceDocumentId, assetId }] : [];
      });
      next.sceneBindings = selected;
      if (selected.length) {
        next.sceneAssetId = selected[0]!.assetId;
        if (selected.length > 1) next.sceneAssetIds = selected.map((binding) => binding.assetId);
        else delete next.sceneAssetIds;
      } else {
        delete next.sceneAssetId;
        delete next.sceneAssetIds;
      }
      delete next.ignoreSceneBinding;
    }
    if (projectId && currentPromptCharacterScope.characterDocumentIds.length) {
      const shotCharacters = currentPromptCharacterScope.characterDocumentIds.map(
        (characterDocumentId) =>
          characters.find((character) => character.characterDocumentId === characterDocumentId) ?? {
            characterDocumentId,
          },
      );
      const media = await readSceneMedia(projectId, sceneMediaParams(shotCharacters));
      if (currentScope.current !== expectedScope)
        throw new Error('镜头或绑定已变化，请重新确认后再填表。');
      const resolvedCharacters = effectiveSceneCast(shotCharacters, media);
      const selections = resolvedCharacters.flatMap((character) =>
        character.imageAssetId
          ? [
              {
                characterDocumentId: character.characterDocumentId,
                assetId: character.imageAssetId,
              },
            ]
          : [],
      );
      if (selections.length) {
        next.characterBindings = selections;
        next.characterAssetIds = [...new Set(selections.map((binding) => binding.assetId))];
      } else {
        delete next.characterBindings;
        delete next.characterAssetIds;
      }
      delete next.characterAssetId;
    }
    if (currentScope.current !== expectedScope) throw new Error('镜头或场景已切换，请重新生成。');
    beforeSave?.(next);
    await persist(next, false);
    if (currentScope.current !== expectedScope)
      throw new Error('镜头或绑定已变化，请重新确认后再填表。');
    return next;
  };

  const generate = async (mode: 'image' | 'video') => {
    if (saving || !writable || fillingMode) return;
    const expectedScope = currentScope.current;
    setReferenceMessage('');
    setFillingMode(mode);
    try {
      if (continuity?.stale)
        throw new Error(
          continuity.reconfirmable
            ? '镜头提示词已变化，请在镜头衔接中确认沿用现有选帧后再填充。'
            : '剧情或衔接来源已变化，请先重新确认选帧。',
        );
      const withContinuity = (references: ShotReferenceAssets): ShotReferenceAssets => ({
        ...references,
        ...(continuity?.binding
          ? {
              continuityRowVersion: continuity.rowVersion,
              continuityPrompt: mode === 'image' ? continuity.binding.imagePrompt : undefined,
              ...(mode === 'image'
                ? {
                    firstFrameAssetId: undefined,
                    continuityReferenceAssetIds: continuitySourceImageIds(continuity.binding),
                  }
                : {}),
            }
          : {}),
      });
      const resolved = await resolveBoundReferences((references) => {
        if (currentScope.current === expectedScope)
          onPrepareGenerate?.(mode, prompt, withContinuity(references));
      });
      if (currentScope.current !== expectedScope) return;
      if (
        mode === 'video' &&
        ![
          ...(resolved.characterAssetIds ?? []),
          resolved.characterAssetId,
          ...(resolved.sceneAssetIds ?? []),
          resolved.sceneAssetId,
          resolved.firstFrameAssetId,
          ...(resolved.continuityReferenceAssetIds ?? []),
        ].some(Boolean)
      )
        throw new Error('请先生成或选择参考图。');
      const selected = withContinuity(resolved);
      const selectedReferences = createPromptImageReferences(
        shotReferenceImageSelections(selected).map(({ assetId, role }) => ({
          url: `project-asset://${assetId}`,
          role,
        })),
      );
      const remappedPrompt = remapPromptReferences(promptReferences, selectedReferences, {
        prompt,
      }).prompt;
      const selectedPrompt = typeof remappedPrompt === 'string' ? remappedPrompt : prompt;
      if (selectedPrompt !== prompt) onPromptChange(selectedPrompt);
      onPrepareGenerate?.(mode, selectedPrompt, selected);
      if (mode === 'image') onGenerateImage(selected, selectedPrompt);
      else onGenerateVideo(selected, selectedPrompt);
    } catch (error) {
      if (currentScope.current === expectedScope)
        setReferenceMessage(error instanceof Error ? error.message : '参考图读取失败');
    } finally {
      setFillingMode(undefined);
    }
  };

  const bindingScopeLoading = Boolean(projectId && !currentPromptCharacterScope);
  const scopedCharacters = currentPromptCharacterScope ? characters : [];
  const effectivePromptCharacters = effectiveSceneCast(
    scopedCharacters,
    castMedia.value ?? { characters: [], assets: [], voices: [] },
  );
  const promptCharacterBindings = refs.characterBindings?.filter((binding) =>
    currentPromptCharacterScope?.characterDocumentIds.includes(binding.characterDocumentId),
  );
  const promptCharacterAssetIds = promptCharacterBindings?.length
    ? promptCharacterBindings.map((binding) => binding.assetId)
    : effectivePromptCharacters.flatMap((character) =>
        character.imageAssetId && !character.imageDisabled ? [character.imageAssetId] : [],
      );
  const promptImageSelections = shotReferenceImageSelections({
    ...effectiveRefs,
    ...(promptCharacterBindings ? { characterBindings: promptCharacterBindings } : {}),
    characterAssetIds: promptCharacterAssetIds,
    sceneAssetId: effectiveRefs.sceneAssetId,
    sceneAssetIds: effectiveRefs.sceneAssetIds,
  });
  const hasSelectedRefs = promptImageSelections.length > 0;
  const promptImageLabels = new Map<string, string>();
  const setPromptImageLabel = (assetId: string, documentId?: string, fallback?: string) => {
    if (!assetId) return;
    const label = documents.find((document) => document.id === documentId)?.title ?? fallback;
    if (label?.trim() && !promptImageLabels.has(assetId))
      promptImageLabels.set(assetId, label.trim());
  };
  refs.characterBindings?.forEach((binding) =>
    setPromptImageLabel(binding.assetId, binding.characterDocumentId),
  );
  refs.sceneBindings?.forEach((binding) =>
    setPromptImageLabel(binding.assetId, binding.sourceDocumentId),
  );
  effectivePromptCharacters.forEach((character) =>
    setPromptImageLabel(character.imageAssetId ?? '', character.characterDocumentId),
  );
  sceneMaterials.forEach((binding) =>
    setPromptImageLabel(binding.assetId, binding.sourceDocumentId),
  );
  if (effectiveRefs.sceneAssetId)
    setPromptImageLabel(
      effectiveRefs.sceneAssetId,
      refs.sceneBindings?.find((binding) => binding.assetId === effectiveRefs.sceneAssetId)
        ?.sourceDocumentId ?? primarySceneDocumentId,
      '当前场景',
    );
  if (refs.firstFrameAssetId) promptImageLabels.set(refs.firstFrameAssetId, '首帧');
  refs.continuityReferenceAssetIds?.forEach((assetId) =>
    setPromptImageLabel(assetId, undefined, '连续性参考'),
  );
  const promptBindingEntries: ProductionImageBindingPromptEntry[] = promptImageSelections.map(
    ({ assetId, role }, index) => ({
      imageIndex: index + 1,
      role,
      ...(promptImageLabels.get(assetId) ? { label: promptImageLabels.get(assetId) } : {}),
    }),
  );
  const displayedPrompt = productionImageBindingPrompt(
    prompt,
    promptImageSelections.length,
    promptBindingEntries,
    (index) => `图片${index}`,
  );
  const handlePromptEdit = useCallback(
    (value: string) => onPromptChange(stripProductionImageBindingPrompt(value)),
    [onPromptChange],
  );
  const promptReferences = createPromptImageReferences(
    promptImageSelections.map(({ assetId, role }) => ({ url: `project-asset://${assetId}`, role })),
  );
  const promptReferenceSnapshot = useRef(promptReferences);
  useEffect(() => {
    const previous = promptReferenceSnapshot.current;
    const changed =
      previous.length !== promptReferences.length ||
      previous.some((item, index) => item.id !== promptReferences[index]?.id);
    if (changed) {
      const remapped = remapPromptReferences(previous, promptReferences, { prompt });
      if (typeof remapped.prompt === 'string' && remapped.prompt !== prompt)
        onPromptChange(remapped.prompt);
    }
    promptReferenceSnapshot.current = promptReferences;
  }, [prompt, promptReferences, onPromptChange]);

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
        <MarkdownEditor
          className="shot-prompt-editor"
          label="镜头提示词"
          value={displayedPrompt}
          onChange={handlePromptEdit}
          placeholder={'\u8f93\u5165\u672c\u955c\u753b\u9762\u63d0\u793a\u8bcd\u2026'}
          autoPreviewOnBlur
          readOnly={!writable}
          references={promptReferences}
          projectId={projectId}
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
          {onRepairBindings && (
            <button
              className="button secondary"
              type="button"
              disabled={!writable || repairPending || !prompt.trim() || Boolean(fillingMode)}
              onClick={() => void repairBindings()}
            >
              <Wrench size={13} /> {repairPending ? '正在修复…' : '修复绑定'}
            </button>
          )}
          <button
            className="button primary"
            type="button"
            disabled={
              !writable || saving || bindingScopeLoading || Boolean(fillingMode) || !prompt.trim()
            }
            onClick={() => {
              void generate('image');
            }}
          >
            填充本镜图片表单
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={
              !writable || saving || bindingScopeLoading || Boolean(fillingMode) || !hasSelectedRefs
            }
            onClick={() => {
              void generate('video');
            }}
          >
            填充本镜视频表单
          </button>
        </div>
        {fillingMode && (
          <p className="shot-reference-message" role="status" aria-live="polite">
            {fillingMode === 'image'
              ? '正在解析本镜绑定并填充画面表单…'
              : '正在解析本镜绑定并填充视频表单…'}
          </p>
        )}
      </section>
      {referenceMessage && <p role="status">{referenceMessage}</p>}
      <section className="shot-ir-reference-summary" aria-label="提示词资料引用">
        <h3>提示词资料引用</h3>
        {currentPromptCharacterScope ? (
          <div className="shot-ir-reference-groups">
            {promptDocumentGroups.map((group) => (
              <div className="shot-ir-reference-group" key={group.key}>
                <span className="shot-ir-reference-role">{group.label}</span>
                <div className="shot-ir-reference-documents">
                  {group.documentIds.length ? (
                    group.documentIds.map((documentId) => {
                      const document = documents.find((item) => item.id === documentId);
                      return document ? (
                        <span
                          className="shot-ir-reference-document"
                          key={documentId}
                          title={`${document.title}\n${document.id}`}
                        >
                          {document.title}
                        </span>
                      ) : (
                        <span
                          className="shot-ir-reference-document is-unavailable"
                          key={documentId}
                          title={documentId}
                          aria-label={`${group.label}资料不可用，文档 ID ${documentId}`}
                        >
                          资料不可用
                        </span>
                      );
                    })
                  ) : (
                    <span className="shot-ir-reference-empty">未引用</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="shot-ir-reference-loading" role="status">
            正在读取提示词引用
          </p>
        )}
      </section>
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
          heading="本镜角色绑定"
          allowRosterChanges={false}
          showVoiceReferences={false}
          showDialogueSettings={false}
          sceneLabel={
            sceneDocumentIds.length
              ? sceneDocumentIds
                  .map((id) => documents.find((item) => item.id === id)?.title ?? '资料不可用')
                  .join('、')
              : undefined
          }
          scopeNote="角色由本镜提示词确认；此处只选择本镜使用的参考图。"
          audios={[]}
          writable={writable && !saving && !fillingMode}
          onChange={(next) => {
            referenceEditRevision.current += 1;
            setCharacters(next);
          }}
          onDialogueChange={() => undefined}
          onAudioImported={() => undefined}
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
              busy={Boolean(fillingMode)}
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
            busy={saving || Boolean(fillingMode)}
            message={setting.error}
            onOpen={onOpenDocument}
            onSelectImage={(id) => assign('scene', id)}
            onDropAsset={(asset) => assign('scene', asset.id)}
            imageDisabled={refs.ignoreSceneBinding}
            onRestore={
              sceneDocumentIds.length &&
              (refs.sceneAssetId ||
                refs.sceneAssetIds?.length ||
                refs.ignoreSceneBinding ||
                refs.sceneBindings?.length)
                ? () => {
                    const next = { ...refs };
                    next.sceneBindings = (next.sceneBindings ?? []).filter(
                      (binding) => binding.sourceDocumentId !== primarySceneDocumentId,
                    );
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
            asset={availableAssets.find((a) => a.id === effectiveRefs.firstFrameAssetId)}
            candidates={availableAssets}
            projectId={projectId}
            writable={writable && !saving}
            busy={Boolean(fillingMode)}
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
            key={`${projectId}:${shotId}`}
            projectId={projectId}
            shotId={shotId}
            writable={writable && !saving}
            sourceDirty={continuitySourceDirty}
            revision={continuityRefresh}
            assets={availableAssets}
            llm={llm}
            onAskAgent={onAskContinuityAgent}
            onChange={(next) => {
              setContinuity(next);
              setRefs((current) => {
                if (!next.binding && !continuity?.binding) return current;
                const updated = {
                  ...current,
                  firstFrameAssetId: next.binding
                    ? next.binding.firstFrameAssetId
                    : continuity?.binding
                      ? undefined
                      : current.firstFrameAssetId,
                  continuityReferenceAssetIds: next.binding
                    ? continuityReferenceImageIds(next.binding)
                    : [],
                  continuityPrompt: undefined,
                };
                saveShotReferences(projectId, shotId, updated);
                return updated;
              });
            }}
            onGenerate={(mode, next) => {
              const selected = {
                ...effectiveRefs,
                continuityRowVersion: next.rowVersion,
                continuityPrompt: next.binding?.imagePrompt,
                firstFrameAssetId: undefined,
                ...(mode === 'image'
                  ? {
                      continuityReferenceAssetIds: next.binding
                        ? continuitySourceImageIds(next.binding)
                        : [],
                    }
                  : {}),
              };
              onGenerateImage(selected, prompt);
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
          <MarkdownEditor
            label="分镜内容"
            value={storyboardContent}
            onChange={onStoryboardContentChange}
            placeholder={'# \u5206\u955c\n\n1. \u955c\u5934\u63cf\u8ff0\u2026'}
            autoPreviewOnBlur
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
  busy = false,
  projectId,
  onSelect,
}: {
  label: string;
  asset?: AssetInfo;
  candidates: AssetInfo[];
  writable: boolean;
  busy?: boolean;
  projectId?: string;
  onSelect: (assetId?: string) => void;
}) {
  return (
    <ReferenceCard
      label={label}
      asset={asset}
      writable={writable && !busy}
      projectId={projectId}
      onDropAsset={(a) => onSelect(a.id)}
      selector={
        <select
          aria-label={label}
          value={asset?.id ?? ''}
          disabled={!writable || busy}
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
