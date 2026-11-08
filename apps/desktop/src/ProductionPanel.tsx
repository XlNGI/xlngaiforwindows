import { PromptReferenceEditor } from './PromptReferenceEditor';
import {
  canonicalPromptParameters,
  promptReferences,
  remapPromptReferences,
  type PromptReference,
} from './prompt-references';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ImageListParameterField } from './ImageListParameterField';
import { StructuredAssetDrop } from './assets/StructuredAssetDrop';
import { useProductionAuthoring } from './use-production-authoring';
import { ProductionTimingDetails } from './ProductionTimingDetails';
import { ProductionInputRoleDetails } from './ProductionInputRoleDetails';
import { ProjectProductionDefaults } from './ProjectProductionDefaults';
import { ParameterHelp } from './ParameterHelp';
import type { ProductionSegment } from '@ai-video/contracts';
import { parameterScalarText, StructuredParameterField } from './StructuredParameterField';
import {
  addOfficialRoleVoices,
  isOfficialVoiceVideo,
  seedOfficialVideoParameters,
  usesStructuredVideoParameters,
} from './official-video-parameters';
import type { CharacterVoiceReferenceInfo, AudioFileInfo } from '@ai-video/contracts';
import { open as openAudioDialog } from '@tauri-apps/plugin-dialog';
import {
  CircleAlert,
  CircleCheck,
  Eye,
  FolderOpen,
  Pause,
  Play,
  Save,
  Settings2,
  WandSparkles,
  Square,
  Video,
  Volume2,
} from 'lucide-react';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AdapterParameterProperty,
  AdapterParameters,
  AdapterUiField,
  AdapterValidationError,
  AssetInfo,
  GenerationCapability,
  ImageAssetKind,
  MediaSubmissionConfirmationRequest,
  MediaTaskCancellationOutcome,
  ProviderModelInfo,
  ProviderProfileInfo,
  VideoAssetKind,
  VideoGenerationJobInfo,
  VideoGenerationMetadataInfo,
  SceneInfo,
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import type { ProductionCapability } from './use-production-state';
import { projectWorker } from './worker-scope';
import {
  adapterBindsCatalogModel,
  addProductionAudioBindings,
  addProductionImageBindings,
  productionAudioImageBindings,
  productionAudioSupport,
  productionImageSelectionsFromBindings,
  productionImagesFromParameters,
  productionFrameInputConflict,
  resolveProductionFrameInputs,
  seedProductionInputs,
  sceneReferenceImageParameters,
} from '@ai-video/contracts';
import {
  generationErrorFeedback,
  generationStatusLabel,
  generationTaskStatus,
  videoProgressGuidance,
} from './generation-feedback';
import { MediaSubmissionConfirmationDialog } from './media-confirmation';
import { hasLocalImageParameters } from './local-image-input';
import { useDubbingMedia } from './dubbing/media';

interface ProductionPanelProps {
  onRequestSubmissionApproval?: (
    confirmation: MediaSubmissionConfirmationRequest,
  ) => Promise<boolean>;
  expanded?: boolean;
  capability?: ProductionCapability;
  projectId?: string;
  projectSessionId?: string;
  /** Identity of the loaded project view, including reopening the same project. */
  projectViewEpoch?: object;
  /** Identity of the latest explicit fill action from a source workspace. */
  seedEventKey?: object;
  shotId?: string;
  sceneId?: string;
  sourceDocumentId?: string;
  seedPrompt?: string;
  seedParameters?: AdapterParameters;
  audioReference?: {
    characterDocumentId: string;
    expectedVoiceVersionId: string;
    providerProfileId: string;
    model: string;
  };
  seedImages?: string[];
  seedReferenceBindings?: SceneMaterialBindingInfo[];
  seedImageBindings?: import('@ai-video/contracts').ProductionImageSelection[];
  preferredAssetKind?: ImageAssetKind;
  writable: boolean;
  assets?: AssetInfo[];
  videoJobs?: VideoGenerationJobInfo[];
  imageJobs?: import('@ai-video/contracts').ImageGenerationJobInfo[];
  focusedJobId?: string;
  onAssetsChanged?: (assets: AssetInfo[], selectedAssetId?: string) => void;
  onOpenAssetLibrary?: (assetId?: string) => void;
  onOpenProviderSettings?: () => void;
  providerSettingsRevision?: number;
}

type MediaProductionPanelProps = Omit<ProductionPanelProps, 'capability'> & {
  capability?: GenerationCapability;
};

const PROVIDER_PROFILE_STORAGE_KEY = 'ai-video.production-provider-profiles';

/**
 * Remember the user's parameter values per adapter so that switching models or
 * capabilities does not silently reset a filled-in form.
 *
 * Local image data URLs are deliberately excluded: they are per-submission
 * payloads that can exceed the storage quota and must never be persisted.
 */
const PARAMETER_STORAGE_KEY = 'ai-video.production-adapter-parameters';

function readStoredParameters(adapterKey: string): AdapterParameters {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PARAMETER_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    const entry = stored[adapterKey];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).filter(
        ([, value]) =>
          value !== null && !hasLocalImageParameters({ value: value as AdapterParameters[string] }),
      ),
    ) as AdapterParameters;
  } catch {
    return {};
  }
}

function writeStoredParameters(adapterKey: string, parameters: AdapterParameters): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PARAMETER_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    const persisted = Object.fromEntries(
      Object.entries(parameters).filter(
        ([, value]) => value !== undefined && !hasLocalImageParameters({ value }),
      ),
    );
    stored[adapterKey] = persisted;
    window.localStorage.setItem(PARAMETER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Parameter memory is best-effort; the form still works without storage.
  }
}

function defaultParameters(adapter: AdapterDescriptor): AdapterParameters {
  return Object.fromEntries(
    Object.entries(adapter.parameterSchema.properties)
      .filter(([, property]) => property.default !== undefined)
      .map(([key, property]) => [key, property.default!]),
  );
}

function productionPromptTexts(parameters: AdapterParameters): string[] {
  const texts = typeof parameters.prompt === 'string' ? [parameters.prompt] : [];
  if (Array.isArray(parameters.content))
    for (const item of parameters.content)
      if (item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text')
        texts.push(typeof item.text === 'string' ? item.text : '');
  return texts;
}

function hasImageDescriptions(parameters: AdapterParameters): boolean {
  return productionPromptTexts(parameters).some((text) => text.includes('【输入图片说明】'));
}

/**
 * Contracts are schema-first. Legacy descriptors may still provide an
 * explicit uiSchema, but a descriptor without one gets a deterministic form
 * derived from its JSON Schema so new provider bindings do not require a new
 * React component.
 */
function schemaDerivedFields(adapter: AdapterDescriptor): AdapterUiField[] {
  const configured = adapter.uiSchema?.fields ?? [];
  const explicit = configured.filter((field) => !field.hidden);
  const explicitKeys = new Set(configured.map((field) => field.key));
  const nextOrder = explicit.reduce((maximum, field) => Math.max(maximum, field.order), 0);
  const derived = Object.entries(adapter.parameterSchema.properties)
    .filter(([key, property]) => !explicitKeys.has(key) && property.const === undefined)
    .map(([key, property], index) => {
      const control: AdapterUiField['control'] =
        property.type === 'object' ||
        (property.type === 'array' && property.items?.type !== 'string')
          ? 'structured'
          : property.type === 'boolean'
            ? 'toggle'
            : property.type === 'integer'
              ? 'number'
              : property.enum?.length
                ? 'select'
                : property.type === 'array' && property.items?.format === 'uri'
                  ? 'url-list'
                  : (property.title ?? '').length > 40 ||
                      /prompt|message|description|content|text/iu.test(key)
                    ? 'textarea'
                    : 'text';
      return {
        key,
        control,
        group: explicit.length > 0 ? ('advanced' as const) : ('basic' as const),
        order: nextOrder + (index + 1) * 10,
      };
    });
  return [...explicit, ...derived].sort((a, b) => a.order - b.order);
}

function normalizeErrorPath(path: string): string {
  return path.replace(/^\//, '');
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

function cancellationMessage(cancellation?: MediaTaskCancellationOutcome): string {
  if (!cancellation || ['not_submitted', 'cancelled'].includes(cancellation.provider)) {
    return '视频任务已取消，本地轮询已停止。';
  }
  const reason =
    cancellation.provider === 'unsupported'
      ? 'Provider 不支持远端取消'
      : cancellation.provider === 'rejected'
        ? 'Provider 未接受远端取消'
        : '远端取消结果未知';
  return `视频任务已取消，仅停止本地轮询；${reason}，Provider 任务可能仍会继续。`;
}

function isVideoCapability(capability: GenerationCapability | undefined): boolean {
  return (
    capability === 'TEXT_TO_VIDEO' ||
    capability === 'IMAGE_TO_VIDEO' ||
    capability === 'REFERENCE_TO_VIDEO' ||
    capability === 'VIDEO_TO_VIDEO' ||
    capability === 'START_END_TO_VIDEO'
  );
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function formatVideoCost(cost: VideoGenerationMetadataInfo['cost'] | undefined): string {
  if (!cost) return '费用未返回';
  if (cost.unit !== 'credits') return `${cost.amount} ${cost.unit}`;
  const credits = `${cost.amount} 积分`;
  return cost.estimatedAmount && cost.currency
    ? `${credits} · ${cost.currency} ${cost.estimatedAmount}（${cost.unitPrice}/积分）`
    : `${credits} · 未配置每积分单价`;
}

const SUBMISSION_UNKNOWN_MESSAGE =
  '提交结果未知。为避免重复扣费，系统不会自动重试，请先到 Provider 后台核对。';

function AudioSamplePreview({ projectId, audio }: { projectId: string; audio: AudioFileInfo }) {
  const source = useDubbingMedia(projectId, audio.id, true);
  return (
    <li className="production-audio-sample">
      <div className="production-audio-sample-heading">
        <strong>{audio.name}</strong>
        <span>
          {(audio.durationMs / 1000).toFixed(1)} 秒 · {(audio.sizeBytes / 1024).toFixed(0)} KB
        </span>
      </div>
      {source?.src ? (
        <audio controls preload="metadata" src={source.src} aria-label={`试听${audio.name}`} />
      ) : (
        <span role={source?.error ? 'status' : undefined}>
          {source?.error ?? '正在读取音频样本…'}
        </span>
      )}
    </li>
  );
}

function MediaProductionPanel({
  expanded = false,
  capability,
  projectId,
  projectSessionId,
  projectViewEpoch,
  seedEventKey,
  shotId,
  sceneId,
  sourceDocumentId,
  seedPrompt,
  seedParameters,
  audioReference,
  seedImages,
  seedReferenceBindings,
  seedImageBindings,
  preferredAssetKind,
  writable,
  videoJobs = [],
  imageJobs = [],
  focusedJobId,
  onAssetsChanged,
  onOpenAssetLibrary,
  onOpenProviderSettings,
  providerSettingsRevision = 0,
  onRequestSubmissionApproval,
}: MediaProductionPanelProps) {
  const callWorker = projectWorker();
  const [adapter, setAdapter] = useState<AdapterDescriptor>();
  const [parameters, setParameters] = useState<AdapterParameters>({});
  const parametersRef = useRef(parameters);
  parametersRef.current = parameters;
  const preserveImageDescriptionEditsRef = useRef(false);
  // Bindings are the saved reference source; normalize them once so the form,
  // compiler and final submission all receive the same ordered image list.
  const effectiveSeedImageBindings = useMemo(
    () => seedImageBindings ?? productionImageSelectionsFromBindings(seedReferenceBindings),
    [seedImageBindings, seedReferenceBindings],
  );
  const bindSeedImagePrompt = useCallback(
    (descriptor: AdapterDescriptor, current: AdapterParameters): AdapterParameters =>
      effectiveSeedImageBindings
        ? addProductionImageBindings(descriptor, current, effectiveSeedImageBindings)
        : current,
    [effectiveSeedImageBindings],
  );
  const setAuthoringParameters = useCallback(
    (update: (current: AdapterParameters) => AdapterParameters) =>
      setParameters((current) => {
        const next = update(current);
        return adapter && !preserveImageDescriptionEditsRef.current
          ? bindSeedImagePrompt(adapter, next)
          : next;
      }),
    [adapter, bindSeedImagePrompt],
  );
  const [catalog, setCatalog] = useState<AdapterCatalogResult>();
  const effectiveCapability = capability ?? catalog?.capabilities[0]?.key ?? 'TEXT_TO_IMAGE';
  const [profiles, setProfiles] = useState<ProviderProfileInfo[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [adapterKey, setAdapterKey] = useState('');
  const [catalogModelId, setCatalogModelId] = useState('');
  const [formReady, setFormReady] = useState(false);
  const [seedError, setSeedError] = useState('');
  const actionBlockReasonId = useId();
  const frameInputConflict = adapter
    ? productionFrameInputConflict(adapter, parameters, effectiveSeedImageBindings)
    : undefined;
  const frameConflictRef = useRef<HTMLElement>(null);
  const hasFrameInputConflict = Boolean(frameInputConflict);
  useEffect(() => {
    if (hasFrameInputConflict) frameConflictRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [hasFrameInputConflict, seedEventKey]);
  const currentImages = adapter ? productionImagesFromParameters(adapter, parameters) : [];
  const displayedCapability =
    adapter &&
    isVideoCapability(adapter.capability) &&
    (adapter.parameterSchema.properties.media || adapter.parameterSchema.properties.content) &&
    currentImages.length
      ? currentImages.some((image) => image.role === 'first-frame' || image.role === 'last-frame')
        ? currentImages.some((image) => image.role === 'last-frame')
          ? 'START_END_TO_VIDEO'
          : 'IMAGE_TO_VIDEO'
        : 'REFERENCE_TO_VIDEO'
      : effectiveCapability;
  const [draftOverrides, setDraftOverrides] = useState<AdapterParameters>();
  const [segmentShotIds, setSegmentShotIds] = useState<string[]>();
  const [sceneSegments, setSceneSegments] = useState<ProductionSegment[]>([]);
  const [completeScenePrompt, setCompleteScenePrompt] = useState('');
  const productionAuthoring = useProductionAuthoring({
    projectId,
    target:
      sourceDocumentId && (preferredAssetKind === 'character' || preferredAssetKind === 'scene')
        ? {
            kind: preferredAssetKind === 'character' ? 'character' : 'setting',
            id: sourceDocumentId,
          }
        : sceneId
          ? { kind: 'scene', id: sceneId }
          : shotId
            ? { kind: 'shot', id: shotId }
            : undefined,
    adapter,
    providerKey: `${selectedProfileId}:${catalogModelId}`,
    ready:
      formReady &&
      !seedError &&
      adapter?.key === adapterKey &&
      adapter?.capability === effectiveCapability,
    setParameters: setAuthoringParameters,
    initialOverrides: seedPrompt
      ? {
          ...(preferredAssetKind === 'scene' && sourceDocumentId && adapter
            ? sceneReferenceImageParameters(adapter, draftOverrides ?? {})
            : draftOverrides),
          prompt: seedPrompt,
        }
      : draftOverrides,
    shotIds: segmentShotIds,
    inputImages: effectiveSeedImageBindings,
  });
  const seedEventKeyRef = useRef<object | undefined>(undefined);
  useEffect(() => {
    if (
      !seedEventKey ||
      !adapter ||
      !formReady ||
      adapter.key !== adapterKey ||
      adapter.capability !== effectiveCapability ||
      seedEventKeyRef.current === seedEventKey
    )
      return;
    try {
      const seeded = bindSeedImagePrompt(adapter, {
        ...seedProductionInputs(
          adapter,
          parametersRef.current,
          seedPrompt,
          effectiveSeedImageBindings?.map((image) => ({
            ...image,
            url: `project-asset://${image.assetId}`,
          })),
        ),
        ...(seedParameters ?? {}),
      });
      seedEventKeyRef.current = seedEventKey;
      preserveImageDescriptionEditsRef.current = false;
      productionAuthoring.refill();
      setSeedError('');
      for (const field of ['prompt', 'content', 'images', 'media'] as const)
        if (seeded[field] !== parametersRef.current[field])
          productionAuthoring.changed(field, seeded[field]);
      for (const [field, value] of Object.entries(seedParameters ?? {}))
        productionAuthoring.changed(field, value);
      setParameters(seeded);
    } catch (reason) {
      setSeedError(errorMessage(reason, '制作表单填充失败'));
    }
  }, [
    adapter,
    adapterKey,
    effectiveCapability,
    formReady,
    bindSeedImagePrompt,
    effectiveSeedImageBindings,
    productionAuthoring.changed,
    productionAuthoring.refill,
    seedEventKey,
    seedParameters,
    seedPrompt,
  ]);
  useEffect(() => {
    setSegmentShotIds(undefined);
    setSceneSegments([]);
    setCompleteScenePrompt('');
  }, [projectId, sceneId, adapterKey, selectedProfileId]);
  useEffect(() => {
    const result = productionAuthoring.result;
    if (
      sceneId &&
      result?.target.id === sceneId &&
      !result.source?.shotIds &&
      result.timeline?.length
    ) {
      setSceneSegments(result.segments ?? []);
      setCompleteScenePrompt(result.compiledPrompt ?? '');
    }
  }, [sceneId, productionAuthoring.result]);
  const [errors, setErrors] = useState<AdapterValidationError[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** Pending paid submission awaiting an explicit user decision. */
  const [paidSubmission, setPaidSubmission] = useState<MediaSubmissionConfirmationRequest>();
  const paidSubmissionResolver = useRef<((approved: boolean) => void) | undefined>(undefined);
  const requestPaidSubmissionApproval = (
    confirmation: MediaSubmissionConfirmationRequest,
  ): Promise<boolean> =>
    onRequestSubmissionApproval
      ? onRequestSubmissionApproval(confirmation)
      : new Promise<boolean>((resolve) => {
          paidSubmissionResolver.current?.(false);
          setPaidSubmission(confirmation);
          paidSubmissionResolver.current = (approved) => {
            paidSubmissionResolver.current = undefined;
            setPaidSubmission(undefined);
            resolve(approved);
          };
        });

  const [generationJobId, setGenerationJobId] = useState<string>();
  const [generationStatus, setGenerationStatus] = useState('');
  const [audioSamples, setAudioSamples] = useState<AudioFileInfo[]>([]);
  const [audioSamplesLoading, setAudioSamplesLoading] = useState(false);
  const [audioSamplesError, setAudioSamplesError] = useState('');
  useEffect(() => {
    let active = true;
    if (!projectId || effectiveCapability !== 'TEXT_TO_AUDIO') {
      setAudioSamples([]);
      setAudioSamplesLoading(false);
      setAudioSamplesError('');
      return () => {
        active = false;
      };
    }
    setAudioSamplesLoading(true);
    setAudioSamplesError('');
    void callWorker('audio.list', { kind: 'reference' })
      .then((items) => {
        if (active)
          setAudioSamples(
            items
              .filter((item) => !item.deletedAt)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
              .slice(0, 12),
          );
      })
      .catch((reason: unknown) => {
        if (active) setAudioSamplesError(errorMessage(reason, '项目音频样本读取失败。'));
      })
      .finally(() => {
        if (active) setAudioSamplesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [effectiveCapability, projectId, projectSessionId]);
  const [voiceReferences, setVoiceReferences] = useState<CharacterVoiceReferenceInfo[]>([]);
  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>([]);
  const restoredVoiceIds =
    adapter && draftOverrides
      ? promptReferences(adapter, draftOverrides).flatMap((reference) =>
          reference.kind === 'audio' && reference.url.startsWith('character-voice://')
            ? [reference.url.slice('character-voice://'.length).split('/')[0]!]
            : [],
        )
      : undefined;
  const restoredVoiceIdsRef = useRef(restoredVoiceIds);
  restoredVoiceIdsRef.current = restoredVoiceIds;
  useEffect(() => {
    if (restoredVoiceIdsRef.current) setSelectedVoiceIds(restoredVoiceIdsRef.current);
  }, [draftOverrides, adapter]);
  const [dialogueAudio, setDialogueAudio] = useState<AudioFileInfo>();
  const [rawBoundScene, setBoundScene] = useState<SceneInfo>();
  const boundScene = rawBoundScene
    ? {
        ...rawBoundScene,
        characterBindings: rawBoundScene.characterBindings?.map((binding) => ({
          ...binding,
          voiceReferenceVersionId: binding.voiceDisabled
            ? undefined
            : (binding.voiceReferenceVersionId ??
              voiceReferences.find((v) => v.characterDocumentId === binding.characterDocumentId)
                ?.versionId),
        })),
      }
    : undefined;
  const [sceneInputsLoading, setSceneInputsLoading] = useState(false);
  const [sceneInputsError, setSceneInputsError] = useState('');
  const compiledSceneInputs = productionAuthoring.result?.sceneInputs;
  const promptReviewNotices = (productionAuthoring.result?.notices ?? []).filter(
    (notice) => notice.code.endsWith('_REVIEW') || notice.code === 'AUTHORING_REVIEW_NOTE',
  );
  const adaptationNotices = (productionAuthoring.result?.notices ?? []).filter(
    (notice) => !promptReviewNotices.includes(notice) && notice.code !== 'MODEL_DURATION_PADDING',
  );
  const needsVoiceInput = true;
  const needsDialogueInput = true;
  const compiledSceneInputsRef = useRef(compiledSceneInputs);
  compiledSceneInputsRef.current = compiledSceneInputs;
  const compiledReferenceBindings = useMemo<SceneMaterialBindingInfo[] | undefined>(() => {
    if (!compiledSceneInputs) return undefined;
    const { scene: latest, media } = compiledSceneInputs;
    return [
      ...(latest.materialBindings ?? []).filter((b) => b.role !== 'character'),
      ...(latest.characterBindings ?? []).flatMap((binding) => {
        const id = binding.imageDisabled
          ? undefined
          : (binding.imageAssetId ??
            media.characters.find((c) => c.characterDocumentId === binding.characterDocumentId)
              ?.defaultImage?.id);
        return id
          ? [
              {
                id: `cast-${binding.characterDocumentId}`,
                role: 'character' as const,
                label: compiledSceneInputs.characterNames[binding.characterDocumentId] ?? '角色',
                assetId: id,
                sourceDocumentId: binding.characterDocumentId,
                source: 'auto' as const,
              },
            ]
          : [];
      }),
    ];
  }, [compiledSceneInputs]);
  useEffect(() => {
    if (!compiledSceneInputs) return;
    const { scene: latest, media } = compiledSceneInputs;
    setSceneInputsLoading(false);
    setSceneInputsError('');
    setBoundScene(latest);
    setVoiceReferences(media.voices);
    setSelectedVoiceIds(
      restoredVoiceIdsRef.current ??
        (needsVoiceInput ? (latest.characterBindings ?? []) : [])
          .filter(
            (binding) =>
              !binding.voiceDisabled &&
              (binding.voiceReferenceVersionId ||
                media.characters.find((c) => c.characterDocumentId === binding.characterDocumentId)
                  ?.voice),
          )
          .map((binding) => binding.characterDocumentId),
    );
    setDialogueAudio(undefined);
    if (needsDialogueInput && latest.dialogueAudioId) {
      let active = true;
      setSceneInputsLoading(true);
      void callWorker('audio.get', { audioId: latest.dialogueAudioId })
        .then((value) => {
          if (active) setDialogueAudio(value ?? undefined);
        })
        .catch(() => {
          if (active) setSceneInputsError('完整对白不可用，请重新绑定。');
        })
        .finally(() => {
          if (active) setSceneInputsLoading(false);
        });
      return () => {
        active = false;
      };
    }
  }, [compiledSceneInputs, needsVoiceInput, needsDialogueInput]);
  useEffect(() => {
    let active = true;
    setVoiceReferences([]);
    setSelectedVoiceIds([]);
    setDialogueAudio(undefined);
    setBoundScene(undefined);
    setSceneInputsError('');
    setSceneInputsLoading(Boolean(projectId && sceneId));
    if (!projectId || (!isOfficialVoiceVideo(adapter) && !sceneId))
      return () => {
        active = false;
      };
    let defaultsApplied = false;
    let sequence = 0;
    const refresh = () => {
      const token = ++sequence;
      if (projectId)
        void Promise.all([
          isOfficialVoiceVideo(adapter) || sceneId
            ? callWorker('characterVoiceReference.list', {})
            : Promise.resolve([]),
          sceneId ? callWorker('scene.list', {}) : Promise.resolve([]),
        ])
          .then(async ([values, scenes]) => {
            if (!active || token !== sequence) return;
            if (compiledSceneInputsRef.current) return;
            setVoiceReferences(values ?? []);
            if (sceneId && !defaultsApplied) {
              const currentScene = scenes.find((item) => item.id === sceneId);
              if (!currentScene) throw new Error('当前场次不存在，请重新打开。');
              const audio = currentScene.dialogueAudioId
                ? await callWorker('audio.get', { audioId: currentScene.dialogueAudioId })
                : undefined;
              if (active && token === sequence) {
                defaultsApplied = true;
                setBoundScene(currentScene);
                setDialogueAudio(audio ?? undefined);
                setSelectedVoiceIds(
                  restoredVoiceIdsRef.current ??
                    (adapter && productionAudioSupport(adapter).dialogueDriven
                      ? []
                      : (currentScene.characterBindings ?? [])
                          .filter(
                            (binding) =>
                              !binding.voiceDisabled &&
                              (binding.voiceReferenceVersionId ||
                                values?.some(
                                  (v) => v.characterDocumentId === binding.characterDocumentId,
                                )),
                          )
                          .map((binding) => binding.characterDocumentId)),
                );
              }
            }
            if (active && token === sequence) {
              setSceneInputsLoading(false);
              setSceneInputsError('');
            }
          })
          .catch((error) => {
            if (active && token === sequence) {
              setSceneInputsLoading(false);
              setSceneInputsError(errorMessage(error, '场次声音读取失败，请重新打开制作页。'));
            }
          });
    };
    refresh();
    window.addEventListener('character-voice-reference-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('character-voice-reference-updated', refresh);
    };
  }, [projectId, sceneId, adapter?.provider, adapter?.contractId, seedReferenceBindings]);
  const [assetKind, setAssetKind] = useState<ImageAssetKind>(
    preferredAssetKind ?? 'generated-image',
  );
  const [videoAssetKind, setVideoAssetKind] = useState<VideoAssetKind>('shot-video');
  const submissionScope = useMemo(
    () => ({}),
    [projectId, projectSessionId, projectViewEpoch, shotId, sceneId, sourceDocumentId],
  );
  const currentSubmissionScope = useRef(submissionScope);
  currentSubmissionScope.current = submissionScope;
  const activeSubmission = useRef<object | undefined>(undefined);
  const beginSubmission = () => {
    const token = {};
    activeSubmission.current = token;
    const isCurrent = () =>
      currentSubmissionScope.current === submissionScope && activeSubmission.current === token;
    setBusy(true);
    return isCurrent;
  };
  useEffect(() => {
    activeSubmission.current = undefined;
    paidSubmissionResolver.current?.(false);
    setBusy(false);
    setGenerationJobId(undefined);
    setGenerationStatus('');
    setMessage('');
    setErrors([]);
    return () => {
      activeSubmission.current = undefined;
      paidSubmissionResolver.current?.(false);
    };
  }, [submissionScope]);
  const seedPromptRef = useRef(seedPrompt);
  seedPromptRef.current = seedPrompt;
  const seedImagesRef = useRef(seedImages);
  seedImagesRef.current = seedImages;

  useEffect(() => {
    if (preferredAssetKind) setAssetKind(preferredAssetKind);
  }, [preferredAssetKind, sourceDocumentId]);

  useEffect(() => {
    if (!seedPrompt && seedImages === undefined) return;
    if (effectiveSeedImageBindings) return;
    if (!adapter || adapter.key !== adapterKey || adapter.capability !== effectiveCapability)
      return;
    setParameters((current) =>
      productionAuthoring.preserveEdits(
        usesStructuredVideoParameters(adapter)
          ? seedOfficialVideoParameters(
              adapter,
              current,
              seedPrompt,
              seedImages ?? [],
              seedImages !== undefined,
            )
          : {
              ...current,
              ...(seedPrompt ? { prompt: seedPrompt } : {}),
              ...(seedImages ? { images: seedImages } : {}),
            },
      ),
    );
  }, [
    seedPrompt,
    seedImages,
    effectiveSeedImageBindings,
    sourceDocumentId,
    adapter,
    adapterKey,
    effectiveCapability,
    productionAuthoring.preserveEdits,
  ]);

  useEffect(() => {
    if (focusedJobId) setGenerationJobId(focusedJobId);
  }, [focusedJobId]);

  useEffect(() => {
    let active = true;
    void Promise.all([callWorker('adapter.catalog', {}), callWorker('provider.profile.list', {})])
      .then(([nextCatalog, nextProfiles]) => {
        if (!active) return;
        setCatalog(nextCatalog);
        setProfiles(nextProfiles ?? []);
      })
      .catch((reason) => {
        if (active) setMessage(errorMessage(reason, '适配器目录读取失败'));
      });
    return () => {
      active = false;
    };
  }, [providerSettingsRevision]);

  const eligibleProfiles = useMemo(() => {
    const customMediaAdapterAvailable = catalog?.adapters.some(
      (adapter) => adapter.provider === 'custom' && adapter.capability === effectiveCapability,
    );
    return profiles.filter((profile) => {
      const customCompatibleProfile =
        customMediaAdapterAvailable &&
        profile.accessType === 'custom' &&
        profile.providerType === 'custom' &&
        (profile.category === 'llm' || profile.category === 'multi') &&
        ['openai-responses', 'openai-chat-completions'].includes(profile.protocol);
      const officialMediaProfile =
        (profile.providerType === 'vidu' && profile.protocol === 'vidu-v2') ||
        ['wan-video', 'seedance-video', 'minimax-video'].includes(profile.providerType) ||
        (effectiveCapability === 'TEXT_TO_AUDIO' &&
          profile.providerType === 'minimax-speech' &&
          profile.protocol === 'minimax-speech') ||
        (profile.providerType === 'unicompapi' && profile.protocol === 'openai-chat-completions');
      return (
        (!audioReference ||
          (profile.id === audioReference.providerProfileId &&
            profile.providerType === 'minimax-speech')) &&
        (officialMediaProfile || customCompatibleProfile) &&
        profile.enabled &&
        profile.connectionStatus === 'ready' &&
        (profile.category === 'multi' ||
          customCompatibleProfile ||
          (isVideoCapability(effectiveCapability)
            ? profile.category === 'video'
            : effectiveCapability === 'TEXT_TO_AUDIO'
              ? false
              : profile.category === 'image'))
      );
    });
  }, [audioReference, catalog, effectiveCapability, profiles]);
  const selectedProfile = eligibleProfiles.find((profile) => profile.id === selectedProfileId);
  const providerRegion =
    selectedProfile?.providerType === 'unicompapi'
      ? 'unicompapi'
      : selectedProfile?.baseUrl === 'https://api.vidu.cn' ||
          ['wan-video', 'seedance-video', 'minimax-video'].includes(
            selectedProfile?.providerType ?? '',
          )
        ? 'cn'
        : 'global';

  useEffect(() => {
    let storedProfileId = '';
    try {
      const stored = JSON.parse(
        window.localStorage.getItem(PROVIDER_PROFILE_STORAGE_KEY) ?? '{}',
      ) as Record<string, unknown>;
      if (typeof stored[effectiveCapability] === 'string') {
        storedProfileId = stored[effectiveCapability];
      }
    } catch {
      // Fall back to the first eligible profile when stored preferences are unavailable.
    }
    const nextProfileId = eligibleProfiles.some((profile) => profile.id === selectedProfileId)
      ? selectedProfileId
      : eligibleProfiles.some((profile) => profile.id === storedProfileId)
        ? storedProfileId
        : (eligibleProfiles[0]?.id ?? '');
    if (nextProfileId !== selectedProfileId) setSelectedProfileId(nextProfileId);
  }, [effectiveCapability, eligibleProfiles, selectedProfileId]);

  useEffect(() => {
    if (!selectedProfileId) {
      setModels([]);
      return;
    }
    let active = true;
    void Promise.resolve(callWorker('provider.model.list', { profileId: selectedProfileId }))
      .then((items) => {
        if (active) setModels(items);
      })
      .catch((reason) => {
        if (active) setMessage(errorMessage(reason, '供应商模型读取失败'));
      });
    return () => {
      active = false;
    };
  }, [providerSettingsRevision, selectedProfileId]);

  useEffect(() => {
    const selected = catalog?.adapters.find((item) => item.key === adapterKey);
    preserveImageDescriptionEditsRef.current = false;
    setFormReady(false);
    setDraftOverrides(undefined);
    if (!selected) {
      setAdapter(undefined);
      setParameters({});
      return;
    }
    let active = true;
    void Promise.resolve(
      callWorker('adapter.resolve', {
        capability: selected.capability,
        provider: selected.provider,
        model: selected.model,
        apiVersion: selected.apiVersion,
      }),
    )
      .then(async (resolved) => {
        if (!active) return;
        setAdapter(resolved);
        setErrors([]);
        setMessage('');
        const defaults = defaultParameters(resolved);
        const withSeed = (params: AdapterParameters): AdapterParameters => {
          if (preferredAssetKind === 'scene' && sourceDocumentId)
            params = sceneReferenceImageParameters(resolved, params);
          if (effectiveSeedImageBindings) {
            try {
              const seeded = bindSeedImagePrompt(resolved, {
                ...seedProductionInputs(
                  resolved,
                  params,
                  seedPromptRef.current,
                  effectiveSeedImageBindings.map((image) => ({
                    ...image,
                    url: 'project-asset://' + image.assetId,
                  })),
                ),
                ...(seedParameters ?? {}),
              });
              setSeedError('');
              return seeded;
            } catch (reason) {
              setSeedError(errorMessage(reason, '制作表单填充失败'));
              return params;
            }
          }
          setSeedError('');
          if (seedParameters) return { ...params, ...seedParameters };
          if (usesStructuredVideoParameters(resolved))
            return seedOfficialVideoParameters(
              resolved,
              params,
              seedPromptRef.current,
              seedImagesRef.current ?? [],
              seedImagesRef.current !== undefined,
            );
          const next = { ...params };
          if (seedPromptRef.current) next.prompt = seedPromptRef.current;
          if (seedImagesRef.current?.length) next.images = seedImagesRef.current;
          return next;
        };
        setParameters(withSeed(defaults));
        if (!shotId) {
          return;
        }
        const selectedModel =
          models.find((model) => model.id === catalogModelId) ??
          models.find(
            (model) =>
              selectedProfile &&
              adapterBindsCatalogModel(resolved, {
                providerType: selectedProfile.providerType,
                remoteModelId: model.remoteModelId,
                parameterTemplateKey: model.parameterTemplateKey,
                contractStatus: model.contractStatus,
              }),
          );
        if (!selectedProfile || !selectedModel) {
          // Without a project draft the remembered form values are the only
          // thing standing between the user and an empty parameter form.
          if (active)
            setParameters(withSeed({ ...defaults, ...readStoredParameters(resolved.key) }));
          return;
        }
        try {
          const draft = await callWorker('generation.draft.get', {
            shotId,
            adapterKey: resolved.key,
            providerProfileId: selectedProfile.id,
            modelId: selectedModel.remoteModelId,
          });
          if (active && draft?.parameters) setDraftOverrides(draft.parameters);
          // Precedence: schema defaults < remembered form values < project draft < document seed.
          if (active)
            setParameters(
              withSeed({
                ...defaults,
                ...readStoredParameters(resolved.key),
                ...(draft?.parameters ?? {}),
              }),
            );
        } catch {
          if (active)
            setParameters(withSeed({ ...defaults, ...readStoredParameters(resolved.key) }));
        }
      })
      .finally(() => {
        if (active) setFormReady(true);
      })
      .catch((reason) => {
        if (active) {
          setAdapter(undefined);
          setParameters({});
          setMessage(errorMessage(reason, '适配器解析失败'));
        }
      });
    return () => {
      active = false;
    };
  }, [
    adapterKey,
    catalog,
    catalogModelId,
    models,
    projectId,
    selectedProfile,
    shotId,
    sceneId,
    sourceDocumentId,
    effectiveSeedImageBindings,
    seedParameters,
    preferredAssetKind,
  ]);

  const capabilityAdapters = useMemo(
    () => catalog?.adapters.filter((item) => item.capability === effectiveCapability) ?? [],
    [catalog, effectiveCapability],
  );
  const modelOptions = useMemo(() => {
    if (!selectedProfile) return [];
    return models.flatMap((model) => {
      if (!model.enabled || model.unavailableAt) return [];
      const supportsCapability = isVideoCapability(effectiveCapability)
        ? model.capabilities.videoGeneration
        : effectiveCapability === 'TEXT_TO_AUDIO'
          ? model.capabilities.speechSynthesis === true
          : effectiveCapability === 'REFERENCE_TO_IMAGE'
            ? model.capabilities.imageEditing === true || model.capabilities.imageGeneration
            : model.capabilities.imageGeneration;
      if (
        !supportsCapability ||
        (audioReference !== undefined && model.remoteModelId !== audioReference.model)
      )
        return [];
      return capabilityAdapters
        .filter((adapter) =>
          adapterBindsCatalogModel(adapter, {
            providerType: selectedProfile.providerType,
            remoteModelId: model.remoteModelId,
            parameterTemplateKey: model.parameterTemplateKey,
            contractStatus: model.contractStatus,
          }),
        )
        .map((adapter) => ({
          optionKey: `${model.id}::${adapter.key}`,
          adapter,
          model,
        }));
    });
  }, [audioReference, capabilityAdapters, effectiveCapability, models, selectedProfile]);
  const selectedModel =
    modelOptions.find((item) => item.model.id === catalogModelId && item.adapter.key === adapterKey)
      ?.model ?? models.find((model) => model.id === catalogModelId);

  useEffect(() => {
    const current = modelOptions.find(
      (item) => item.model.id === catalogModelId && item.adapter.key === adapterKey,
    );
    const next = current ?? modelOptions[0];
    const nextAdapterKey = next?.adapter.key ?? '';
    const nextModelId = next?.model.id ?? '';
    if (nextAdapterKey !== adapterKey) setAdapterKey(nextAdapterKey);
    if (nextModelId !== catalogModelId) setCatalogModelId(nextModelId);
  }, [adapterKey, catalogModelId, modelOptions]);

  const chooseProfile = (profileId: string) => {
    setSelectedProfileId(profileId);
    setModels([]);
    setAdapterKey('');
    setCatalogModelId('');
    setGenerationStatus('');
    try {
      const stored = JSON.parse(
        window.localStorage.getItem(PROVIDER_PROFILE_STORAGE_KEY) ?? '{}',
      ) as Record<string, unknown>;
      window.localStorage.setItem(
        PROVIDER_PROFILE_STORAGE_KEY,
        JSON.stringify({ ...stored, [effectiveCapability]: profileId }),
      );
    } catch {
      // Profile selection remains valid for the current session when storage is unavailable.
    }
  };

  const updateParameter = (key: string, value: AdapterParameters[string] | undefined) => {
    if (['images', 'media', 'content'].includes(key)) {
      // Manual corrections are authoritative; submission still validates the final API inputs.
      seedEventKeyRef.current = seedEventKey;
      setSeedError('');
    }
    productionAuthoring.changed(key, value);
    const current = parametersRef.current;
    const updated = { ...current };
    if (value === undefined || value === '') delete updated[key];
    else updated[key] = value;
    const beforeReferences = referenceInputs(current);
    const afterReferences = referenceInputs(updated);
    // Structured content contains both text and media. Editing its text is
    // authoritative, including partial changes inside generated descriptions.
    // Rendering an alias as a chip is not a change to the authored text.
    if (
      (key === 'prompt' || key === 'content') &&
      JSON.stringify(
        productionPromptTexts(canonicalPromptParameters(current, beforeReferences)),
      ) !==
        JSON.stringify(productionPromptTexts(canonicalPromptParameters(updated, beforeReferences)))
    )
      preserveImageDescriptionEditsRef.current = true;
    const remapped = ['images', 'media', 'content', 'video'].includes(key)
      ? remapPromptReferences(beforeReferences, afterReferences, updated)
      : updated;
    const next =
      adapter &&
      !preserveImageDescriptionEditsRef.current &&
      hasImageDescriptions(remapped) &&
      ['images', 'media', 'content'].includes(key) &&
      JSON.stringify(productionImagesFromParameters(adapter, current)) !==
        JSON.stringify(productionImagesFromParameters(adapter, updated))
        ? bindSeedImagePrompt(adapter, remapped)
        : remapped;
    for (const field of ['prompt', 'content'])
      if (next[field] !== current[field]) productionAuthoring.changed(field, next[field]);
    if (adapterKey) writeStoredParameters(adapterKey, next);
    parametersRef.current = next;
    setParameters(next);
    setErrors((current) => current.filter((error) => normalizeErrorPath(error.path) !== key));
    setMessage('');
    setGenerationStatus('');
  };

  const revealAsset = async (asset: AssetInfo) => {
    try {
      const result = await callWorker('asset.reveal', { assetId: asset.id });
      setGenerationStatus(`已打开本地位置：${result.path}`);
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '本地位置打开失败。'));
    }
  };

  const openAsset = async (asset: AssetInfo) => {
    try {
      await callWorker('asset.open', { assetId: asset.id });
      setGenerationStatus('已使用本机默认应用打开素材。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '素材打开失败。'));
    }
  };

  const saveDraft = async () => {
    if (!adapter || frameInputConflict || seedError || !formReady) return;
    if (!shotId) {
      setMessage('请先在左侧选择镜头后再保存草稿。');
      return;
    }
    if (!selectedProfile || !selectedModel) {
      setMessage('请先选择可用的供应商连接和模型。');
      return;
    }
    if (hasLocalImageParameters(parameters)) {
      const localField = Object.entries(parameters).find(([, value]) =>
        hasLocalImageParameters({ value }),
      )?.[0];
      setErrors(
        localField
          ? [{ path: localField, message: '本地图片仅用于当前提交，不会写入项目草稿。' }]
          : [],
      );
      setMessage('本地图片不会写入草稿，请改用公开 URL 后保存。');
      return;
    }
    const isCurrent = beginSubmission();
    setMessage('');
    try {
      const projectedParameters = projectSelectedInputs(parameters);
      const draftParameters = canonicalPromptParameters(
        projectedParameters,
        promptReferences(adapter, projectedParameters),
      );
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters: draftParameters,
      });
      if (!isCurrent()) return;
      setErrors(validation.errors);
      if (!validation.valid) {
        setMessage(`${validation.errors.length} 项参数需要修正`);
        return;
      }
      const saved = await callWorker('generation.draft.save', {
        shotId,
        adapterKey: adapter.key,
        providerProfileId: selectedProfile.id,
        modelId: selectedModel.remoteModelId,
        parameters: draftParameters,
      });
      if (!isCurrent()) return;
      setMessage(`草稿已保存 · ${new Date(saved.updatedAt).toLocaleTimeString()}`);
    } catch (reason) {
      if (isCurrent()) setMessage(errorMessage(reason, '草稿保存失败'));
    } finally {
      if (isCurrent()) {
        setBusy(false);
        activeSubmission.current = undefined;
      }
    }
  };

  const generateImage = async () => {
    if (
      !adapter ||
      adapter.key !== adapterKey ||
      adapter.capability !== effectiveCapability ||
      !formReady ||
      !selectedProfile ||
      !selectedModel ||
      !writable ||
      seedError
    )
      return;
    const isCurrent = beginSubmission();
    setGenerationStatus('');
    try {
      const productionSource = await productionAuthoring.beforeSubmit();
      if (!isCurrent()) return;
      const submissionParameters = canonicalPromptParameters(
        parameters,
        promptReferences(adapter, parameters),
      );
      if (!isCurrent()) return;
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters: submissionParameters,
      });
      if (!isCurrent()) return;
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const job = await callWorker('image.generate.prepare', {
        ...(productionSource ? { productionSource } : {}),
        shotId,
        sourceDocumentId,
        assetKind,
        adapterKey: adapter.key,
        parameters: submissionParameters,
        providerProfileId: selectedProfile.id,
        modelId: selectedModel.remoteModelId,
      });
      if (!isCurrent()) return;
      setGenerationJobId(job.id);
      setGenerationStatus('正在请求 Provider...');
      const pending = await callWorker('media.generation.requestSubmission', { jobId: job.id });
      if (!isCurrent()) return;
      if (!pending.confirmation) throw new Error('Image submission confirmation is unavailable.');
      const approved = await requestPaidSubmissionApproval(pending.confirmation);
      if (!onRequestSubmissionApproval && !isCurrent()) return;
      if (!approved) {
        await callWorker('media.task.cancel', { jobId: job.id });
        return;
      }
      const completion = callWorker('media.generation.confirmSubmission', {
        jobId: job.id,
        confirmationToken: pending.confirmation.confirmationToken,
        approved: true,
      });
      if (isCurrent()) setBusy(false);
      const completed = (await completion)
        .job as import('@ai-video/contracts').ImageGenerationJobInfo;
      if (!isCurrent()) return;
      const savedAsset = completed.results.find((result) => result.asset)?.asset;
      if (completed.status === 'succeeded' && savedAsset) {
        const nextAssets = await callWorker('asset.list', {});
        if (!isCurrent()) return;
        onAssetsChanged?.(nextAssets, savedAsset.id);
      }
      if (!isCurrent()) return;
      setGenerationStatus(
        completed.mediaState === 'submission_unknown'
          ? SUBMISSION_UNKNOWN_MESSAGE
          : completed.status === 'succeeded'
            ? '图片已保存到本地素材库。'
            : completed.status === 'cancelled'
              ? '已取消图片生成。'
              : completed.error
                ? generationErrorFeedback(completed.error).userMessage
                : '生成失败。',
      );
    } catch (reason) {
      if (isCurrent()) setGenerationStatus(errorMessage(reason, '图片生成失败。'));
    } finally {
      if (isCurrent()) {
        setGenerationJobId(undefined);
        setBusy(false);
        activeSubmission.current = undefined;
      }
    }
  };

  const generateAudioSample = async () => {
    if (
      !adapter ||
      adapter.capability !== 'TEXT_TO_AUDIO' ||
      !selectedProfile ||
      !selectedModel ||
      !writable ||
      busy ||
      seedError ||
      !formReady ||
      adapter.key !== adapterKey ||
      adapter.capability !== effectiveCapability
    )
      return;
    const isCurrent = beginSubmission();
    setGenerationStatus('');
    try {
      const submissionParameters = { ...parameters };
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters: submissionParameters,
      });
      if (!isCurrent()) return;
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const pending = await callWorker('audio.sample.prepare', {
        adapterKey: adapter.key,
        providerProfileId: selectedProfile.id,
        modelId: selectedModel.remoteModelId,
        parameters: submissionParameters,
      });
      if (!isCurrent()) return;
      const approved = await requestPaidSubmissionApproval(pending.confirmation);
      if (!onRequestSubmissionApproval && !isCurrent()) return;
      if (!approved) {
        await callWorker('audio.sample.confirm', {
          confirmationToken: pending.confirmation.confirmationToken,
          approved: false,
        });
        if (isCurrent()) setGenerationStatus('已取消音频样本生成。');
        return;
      }
      const completion = callWorker('audio.sample.confirm', {
        confirmationToken: pending.confirmation.confirmationToken,
        approved: true,
      });
      if (isCurrent()) {
        setGenerationStatus('正在生成音频样本…');
      }
      const result = await completion;
      if (!isCurrent()) return;
      if (!result.approved) {
        setGenerationStatus('已取消音频样本生成。');
        return;
      }
      setAudioSamples((current) =>
        [result.audio, ...current.filter((item) => item.id !== result.audio.id)].slice(0, 12),
      );
      setGenerationStatus('音频样本已保存到当前项目。');
    } catch (reason) {
      if (isCurrent()) setGenerationStatus(errorMessage(reason, '音频样本生成失败。'));
    } finally {
      if (isCurrent()) {
        setBusy(false);
        activeSubmission.current = undefined;
      }
    }
  };

  const generateAudioReference = async () => {
    if (!adapter || adapter.capability !== 'TEXT_TO_AUDIO' || !audioReference) {
      setGenerationStatus('请从角色资料中打开“制作视频声音参考”以绑定生成音频。');
      return;
    }
    if (
      !selectedProfile ||
      !selectedModel ||
      !writable ||
      seedError ||
      !formReady ||
      adapter.key !== adapterKey ||
      adapter.capability !== effectiveCapability
    )
      return;
    const isCurrent = beginSubmission();
    setGenerationStatus('');
    try {
      const submissionParameters = { ...parameters };
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters: submissionParameters,
      });
      if (!isCurrent()) return;
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const pending = await callWorker('characterVoiceReference.prepare', {
        characterDocumentId: audioReference.characterDocumentId,
        expectedVoiceVersionId: audioReference.expectedVoiceVersionId,
        adapterKey: adapter.key,
        providerProfileId: selectedProfile.id,
        modelId: selectedModel.remoteModelId,
        parameters: submissionParameters,
      });
      if (!isCurrent()) return;
      const approved = await requestPaidSubmissionApproval(pending.confirmation);
      if (!onRequestSubmissionApproval && !isCurrent()) return;
      if (!approved) {
        await callWorker('characterVoiceReference.confirm', {
          confirmationToken: pending.confirmation.confirmationToken,
          approved: false,
        });
        if (isCurrent()) setGenerationStatus('已取消声音参考制作。');
        return;
      }
      const completion = callWorker('characterVoiceReference.confirm', {
        confirmationToken: pending.confirmation.confirmationToken,
        approved: true,
      });
      if (isCurrent()) {
        setBusy(false);
        setGenerationStatus('正在生成并绑定视频声音参考…');
      }
      const result = await completion;
      if (!isCurrent()) return;
      if (!result.approved) {
        setGenerationStatus('已取消声音参考制作。');
        return;
      }
      window.dispatchEvent(
        new CustomEvent('character-voice-reference-updated', {
          detail: {
            projectId,
            characterDocumentId: audioReference.characterDocumentId,
          },
        }),
      );
      setGenerationStatus('声音参考已生成并绑定到角色。');
    } catch (reason) {
      if (isCurrent()) setGenerationStatus(errorMessage(reason, '声音参考制作失败。'));
    } finally {
      if (isCurrent()) {
        setBusy(false);
        activeSubmission.current = undefined;
      }
    }
  };

  const generateVideo = async () => {
    if (
      !adapter ||
      adapter.key !== adapterKey ||
      adapter.capability !== effectiveCapability ||
      !formReady ||
      !selectedProfile ||
      !selectedModel ||
      !isVideoCapability(adapter.capability) ||
      seedError ||
      frameInputConflict ||
      !writable
    )
      return;
    const isCurrent = beginSubmission();
    setGenerationStatus('');
    try {
      const productionSource = await productionAuthoring.beforeSubmit();
      if (!isCurrent()) return;
      if (sceneInputsLoading || sceneInputsError)
        throw new Error(sceneInputsError || '正在读取场次绑定，请稍后提交。');
      const support = productionAudioSupport(adapter);
      const driving = support.dialogueDriven;
      if (
        boundScene &&
        !isOfficialVoiceVideo(adapter) &&
        ((needsDialogueInput && boundScene.dialogueAudioId) ||
          (needsVoiceInput && selectedVoiceIds.length > 0))
      )
        throw new Error(
          support.voiceReference && selectedVoiceIds.length > 0 && !boundScene.dialogueAudioId
            ? '当前模型支持音频参考，但当前连接未接入本地角色声音上传。请切换支持本地声音上传的连接，或取消本次角色声音选择后，在“参考素材”中添加公网参考音频地址。'
            : '当前连接无法传入本场选用的本地声音。请切换支持本地声音上传的连接，或调整本次声音选择和完整对白绑定。',
        );
      if (needsDialogueInput && !driving && boundScene?.dialogueAudioId)
        throw new Error(
          '本场绑定了完整对白，请选择支持完整对白驱动的模型，或先解除完整对白绑定后使用音色参考。',
        );
      if (needsDialogueInput && driving && boundScene?.dialogueAudioId && !dialogueAudio)
        throw new Error('本场完整对白不可用，请重新绑定。');
      if (
        driving &&
        !dialogueAudio &&
        needsVoiceInput &&
        boundScene?.characterBindings?.some((item) => item.voiceReferenceVersionId)
      )
        throw new Error(
          '当前模型使用完整对白驱动，不能使用本场的角色音色样本；请绑定完整对白或选择支持音色参考的模型。',
        );
      const selectedVoices = selectedVoiceIds.map((id) => {
        const binding = boundScene?.characterBindings?.find(
          (item) => item.characterDocumentId === id,
        );
        const voice = voiceReferences.find(
          (item) =>
            item.characterDocumentId === id &&
            (!binding?.voiceReferenceVersionId ||
              item.versionId === binding.voiceReferenceVersionId),
        );
        if (
          !voice ||
          (binding?.voiceReferenceVersionId && voice.versionId !== binding.voiceReferenceVersionId)
        )
          throw new Error('场次绑定的声音样本已变化或不可用，请回场次重新选择并保存。');
        return voice;
      });
      const preservesAuthoredImagePrompt = productionAuthoring.overriddenFields.some((field) =>
        ['prompt', 'content'].includes(field),
      );
      const sceneImageBindings = compiledReferenceBindings ?? seedReferenceBindings ?? [];
      const projectedParameters = isOfficialVoiceVideo(adapter)
        ? addOfficialRoleVoices(
            adapter,
            parameters,
            selectedVoices,
            needsDialogueInput ? dialogueAudio?.id : undefined,
            preservesAuthoredImagePrompt ? [] : sceneImageBindings,
          )
        : parameters;
      const audioBoundParameters = isOfficialVoiceVideo(adapter)
        ? addProductionAudioBindings(
            adapter,
            projectedParameters,
            selectedVoices,
            productionAudioImageBindings(adapter, projectedParameters, sceneImageBindings),
          )
        : projectedParameters;
      const submissionParameters = canonicalPromptParameters(
        audioBoundParameters,
        promptReferences(adapter, audioBoundParameters),
      );
      if (!isCurrent()) return;
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters: submissionParameters,
      });
      if (!isCurrent()) return;
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const prepared = await callWorker('video.generate.prepare', {
        ...(productionSource ? { productionSource } : {}),
        shotId,
        sceneId,
        adapterKey: adapter.key,
        parameters: submissionParameters,
        providerRegion,
        providerProfileId: selectedProfile.id,
        modelId: selectedModel.remoteModelId,
        assetKind: sceneId ? 'scene-video' : videoAssetKind,
      });
      if (!isCurrent()) return;
      setGenerationStatus('正在提交视频任务...');
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => undefined);
      }
      if (!isCurrent()) return;
      const pending = await callWorker('media.generation.requestSubmission', {
        jobId: prepared.id,
      });
      if (!isCurrent()) return;
      if (!pending.confirmation) throw new Error('Video submission confirmation is unavailable.');
      const approved = await requestPaidSubmissionApproval(pending.confirmation);
      if (!onRequestSubmissionApproval && !isCurrent()) return;
      if (!approved) {
        const cancelled = await callWorker('media.task.cancel', { jobId: prepared.id });
        if (!isCurrent()) return;
        setGenerationStatus(cancellationMessage(cancelled.cancellation));
        return;
      }
      const submission = callWorker('media.generation.confirmSubmission', {
        jobId: prepared.id,
        confirmationToken: pending.confirmation.confirmationToken,
        approved: true,
      });
      if (isCurrent()) setBusy(false);
      const response = await submission;
      if (!isCurrent()) return;
      const submitted = response.job as VideoGenerationJobInfo;
      if (submitted.mediaState === 'submission_unknown') {
        setGenerationStatus(SUBMISSION_UNKNOWN_MESSAGE);
        return;
      }
      if (submitted.status === 'failed' || !submitted.providerTaskId) {
        setGenerationStatus(
          submitted.error
            ? generationErrorFeedback(submitted.error, 'provider').userMessage
            : '视频任务提交失败。',
        );
        return;
      }
      if (!isCurrent()) return;
      setGenerationStatus('视频任务已提交，项目后台正在处理。');
    } catch (reason) {
      if (isCurrent()) {
        setGenerationStatus(errorMessage(reason, '视频任务提交失败。'));
      }
    } finally {
      if (isCurrent()) {
        setBusy(false);
        activeSubmission.current = undefined;
      }
    }
  };

  const importDrivingAudio = async () => {
    if (!writable || busy || !('__TAURI_INTERNALS__' in window)) {
      setGenerationStatus('请在 Windows 桌面应用中导入完整对白音频。');
      return;
    }
    if (sceneId && (sceneInputsLoading || sceneInputsError || !boundScene)) {
      setGenerationStatus(sceneInputsError || '正在读取场次绑定，请稍后导入。');
      return;
    }
    const isCurrentScene = beginSubmission();
    try {
      const path = await openAudioDialog({
        multiple: false,
        filters: [{ name: '完整对白音频', extensions: ['wav', 'mp3'] }],
      });
      if (typeof path !== 'string' || !isCurrentScene()) return;
      const result = await callWorker('audio.import', {
        sourcePath: path,
        kind: 'imported-dialogue',
      });
      if (isCurrentScene()) {
        if (boundScene) {
          const updated = await callWorker('scene.save', {
            sceneId: boundScene.id,
            title: boundScene.title,
            dialogueAudioId: result.audio.id,
            expectedRowVersion: boundScene.rowVersion,
          });
          if (!isCurrentScene()) return;
          setBoundScene(updated);
          window.dispatchEvent(new Event('scene-cast-updated'));
        }
        setDialogueAudio(result.audio);
      }
    } catch (error) {
      if (isCurrentScene()) setGenerationStatus(errorMessage(error, '对白音频导入失败。'));
    } finally {
      if (isCurrentScene()) {
        setBusy(false);
        activeSubmission.current = undefined;
      }
    }
  };

  const pauseVideo = async (job: VideoGenerationJobInfo) => {
    try {
      await callWorker('video.generate.pause', { jobId: job.id });
      setGenerationStatus('视频任务轮询已暂停。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '暂停视频任务失败。'));
    }
  };

  const resumeVideo = async (job: VideoGenerationJobInfo) => {
    try {
      await callWorker('video.generate.resume', { jobId: job.id });
      setGenerationStatus('视频任务已继续查询。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '继续视频任务失败。'));
    }
  };

  const cancelVideo = async (job: VideoGenerationJobInfo) => {
    try {
      const cancelled = await callWorker('media.task.cancel', { jobId: job.id });
      setGenerationStatus(cancellationMessage(cancelled.cancellation));
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '取消视频任务失败。'));
    }
  };

  const cancelImage = async () => {
    if (!generationJobId) return;
    const owner = activeSubmission.current;
    const scope = submissionScope;
    const isCurrent = () =>
      currentSubmissionScope.current === scope && activeSubmission.current === owner;
    try {
      await callWorker('image.generate.cancel', { jobId: generationJobId });
      if (isCurrent()) setGenerationStatus('已取消图片生成。');
    } catch (reason) {
      if (isCurrent()) setGenerationStatus(errorMessage(reason, '取消失败。'));
    }
  };

  const projectSelectedInputs = (
    current: AdapterParameters,
    voiceIds = selectedVoiceIds,
  ): AdapterParameters => {
    if (!adapter || !isOfficialVoiceVideo(adapter)) return current;
    const voices = voiceIds.map((id) => {
      const binding = boundScene?.characterBindings?.find(
        (item) => item.characterDocumentId === id,
      );
      const voice = voiceReferences.find(
        (item) =>
          item.characterDocumentId === id &&
          (!binding?.voiceReferenceVersionId || item.versionId === binding.voiceReferenceVersionId),
      );
      if (!voice) throw new Error('场次绑定的声音样本已变化或不可用，请回场次重新选择并保存。');
      return voice;
    });
    return addOfficialRoleVoices(adapter, current, voices, dialogueAudio?.id);
  };
  const selectedVoicePromptBindings = useCallback(
    (voiceIds = selectedVoiceIds) =>
      voiceIds.flatMap((id) => {
        const binding = rawBoundScene?.characterBindings?.find(
          (item) => item.characterDocumentId === id,
        );
        const voice = voiceReferences.find(
          (item) =>
            item.characterDocumentId === id &&
            (!binding?.voiceReferenceVersionId ||
              item.versionId === binding.voiceReferenceVersionId),
        );
        return voice ? [voice] : [];
      }),
    [rawBoundScene?.characterBindings, selectedVoiceIds, voiceReferences],
  );
  useEffect(() => {
    if (!adapter || !isOfficialVoiceVideo(adapter) || sceneInputsLoading) return;
    if (!voiceReferences.length && !selectedVoiceIds.length) return;
    setParameters((current) => {
      const imageBindings = compiledReferenceBindings ?? seedReferenceBindings ?? [];
      return addProductionAudioBindings(
        adapter,
        current,
        selectedVoicePromptBindings(),
        productionAudioImageBindings(adapter, current, imageBindings),
      );
    });
  }, [
    adapter,
    selectedVoiceIds,
    voiceReferences,
    selectedVoicePromptBindings,
    sceneInputsLoading,
    compiledReferenceBindings,
    seedReferenceBindings,
  ]);
  const referenceInputs = (
    current: AdapterParameters,
    voiceIds = selectedVoiceIds,
  ): PromptReference[] => {
    if (!adapter) return [];
    try {
      return promptReferences(adapter, projectSelectedInputs(current, voiceIds));
    } catch {
      return promptReferences(adapter, current);
    }
  };
  const references = referenceInputs(parameters);
  const fields = adapter ? schemaDerivedFields(adapter) : [];
  const basicFields = fields.filter((field) => field.group === 'basic');
  const contentControls = new Set<AdapterUiField['control']>([
    'textarea',
    'url-list',
    'structured',
  ]);
  const contentFields = basicFields.filter((field) => contentControls.has(field.control));
  const outputFields = basicFields.filter((field) => !contentControls.has(field.control));
  const advancedFields = fields.filter((field) => field.group === 'advanced');
  const renderParameter = (field: AdapterUiField) => (
    <ParameterField
      key={`${projectId ?? 'no-project'}:${shotId ?? 'no-shot'}:${adapter!.key}:${field.key}`}
      field={field}
      property={adapter!.parameterSchema.properties[field.key]!}
      value={parameters[field.key]}
      required={adapter!.parameterSchema.required.includes(field.key)}
      error={errors.find((item) => normalizeErrorPath(item.path) === field.key)?.message}
      onChange={(value) => updateParameter(field.key, value)}
      projectId={projectId}
      references={references}
    />
  );

  const draftDisabledReason = !writable
    ? '当前项目为只读，不能保存或提交。'
    : busy
      ? '正在处理当前操作，请稍候。'
      : !formReady
        ? '正在准备模型表单，请稍候。'
        : seedError
          ? `填充失败：${seedError} 请切换模型或修正图片输入后再生成。`
          : frameInputConflict
            ? '图片用途冲突尚未处理，请先选择下方的图片用途，再保存或提交。'
            : undefined;
  const submissionDisabledReason =
    draftDisabledReason ??
    (adapter?.key !== adapterKey || adapter?.capability !== effectiveCapability
      ? '正在切换模型表单，请稍候。'
      : !selectedProfile
        ? '请先选择可用的供应商连接。'
        : !selectedModel
          ? '请先选择可用的模型。'
          : adapter?.capability === 'TEXT_TO_AUDIO'
            ? undefined
            : productionAuthoring.loading
              ? '正在读取制作内容，请稍候；完成后即可提交。'
              : undefined);
  const frameConflictContents = frameInputConflict && adapter && (
    <>
      <p>
        已保留全部 {currentImages.length} 张图片。
        {frameInputConflict.field === 'images'
          ? '当前模型不能同时使用这些图片用途，请仅保留首帧或更换支持多图参考的模型。'
          : '当前模型的严格首尾帧与参考素材不能混用，请选择用途或更换模型。'}
      </p>
      <p>
        {frameInputConflict.canUseReferences ? '全部作为参考图会保留图片，但不锁定首帧；' : ''}
        仅使用首帧会移除其余参考素材。此选择只修改当前表单。
      </p>
      <div className="draft-action-row">
        {frameInputConflict.canUseReferences && (
          <button
            className="button secondary"
            type="button"
            disabled={!writable || busy || !formReady}
            onClick={() => {
              const next = resolveProductionFrameInputs(
                adapter,
                parameters,
                'references',
                effectiveSeedImageBindings,
              );
              updateParameter(frameInputConflict.field, next[frameInputConflict.field]);
            }}
          >
            全部作为参考图
          </button>
        )}
        {frameInputConflict.firstFrameIndex >= 0 && (
          <button
            className="button secondary"
            type="button"
            disabled={!writable || busy || !formReady}
            onClick={() => {
              const next = resolveProductionFrameInputs(
                adapter,
                parameters,
                'first-frame',
                effectiveSeedImageBindings,
              );
              updateParameter(frameInputConflict.field, next[frameInputConflict.field]);
            }}
          >
            仅使用首帧
          </button>
        )}
      </div>
    </>
  );
  const draftSaveHint =
    draftDisabledReason ??
    (!shotId && !sceneId
      ? '请先选择镜头'
      : !selectedProfile || !selectedModel
        ? '请先选择供应商连接和模型'
        : undefined);

  return (
    <aside
      className={`production-panel panel-border${expanded ? ' expanded' : ''}`}
      data-asset-drop-disabled={!writable || busy}
    >
      {imageJobs.some((job) =>
        ['awaiting_confirmation', 'submitting', 'downloading', 'submission_unknown'].includes(
          job.mediaState ?? '',
        ),
      ) && (
        <section className="production-image-tasks" aria-label="图片后台任务">
          {imageJobs
            .filter((job) =>
              ['awaiting_confirmation', 'submitting', 'downloading', 'submission_unknown'].includes(
                job.mediaState ?? '',
              ),
            )
            .map((job) => (
              <div key={job.id}>
                <span>
                  {typeof job.request.prompt === 'string'
                    ? job.request.prompt.slice(0, 40)
                    : '图片任务'}{' '}
                  ·{' '}
                  {job.mediaState === 'submission_unknown'
                    ? '提交结果待核实'
                    : job.mediaState === 'downloading'
                      ? '下载中'
                      : job.mediaState === 'awaiting_confirmation'
                        ? '排队或等待确认'
                        : '生成中'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void callWorker('media.task.cancel', { jobId: job.id }).catch(
                      (reason: unknown) => setGenerationStatus(errorMessage(reason, '取消失败。')),
                    )
                  }
                >
                  取消此图片任务
                </button>
              </div>
            ))}
        </section>
      )}
      {paidSubmission && (
        <MediaSubmissionConfirmationDialog
          confirmation={paidSubmission}
          onDecide={(approved) => paidSubmissionResolver.current?.(approved)}
        />
      )}
      {!catalog ? (
        <div className="parameter-placeholder">正在读取适配器目录</div>
      ) : (
        <div className="production-panel-body">
          <div className="production-panel-main">
            <p className="production-status-message" aria-label="当前制作模式">
              当前制作模式：
              {catalog.capabilities.find((item) => item.key === displayedCapability)?.label ??
                displayedCapability}
              {frameInputConflict ? '（图片用途待确认）' : ''}
            </p>
            {seedError && (
              <p role="alert" className="validation-error">
                填充失败：{seedError} 请切换模型或修正图片输入后再生成。
              </p>
            )}
            <div className="production-config-row">
              <div className="field-group">
                <label htmlFor="provider-profile">供应商连接</label>
                <select
                  id="provider-profile"
                  value={selectedProfileId}
                  onChange={(event) => chooseProfile(event.target.value)}
                  disabled={eligibleProfiles.length === 0 || busy}
                >
                  {eligibleProfiles.length === 0 && <option value="">没有可用连接</option>}
                  {eligibleProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} ·{' '}
                      {profile.providerType === 'unicompapi'
                        ? 'UniCompAPI'
                        : profile.accessType === 'custom'
                          ? '自定义 OpenAI 兼容'
                          : profile.baseUrl === 'https://api.vidu.cn' ||
                              ['wan-video', 'seedance-video', 'minimax-video'].includes(
                                profile.providerType,
                              )
                            ? '中国站'
                            : '国际站'}
                    </option>
                  ))}
                </select>
              </div>
              {eligibleProfiles.length > 0 && (
                <div className="field-group">
                  <label htmlFor="model">模型</label>
                  <select
                    id="model"
                    value={catalogModelId && adapterKey ? `${catalogModelId}::${adapterKey}` : ''}
                    onChange={(event) => {
                      const [nextModelId, ...adapterParts] = event.target.value.split('::');
                      setCatalogModelId(nextModelId ?? '');
                      setAdapterKey(adapterParts.join('::'));
                    }}
                    disabled={modelOptions.length === 0 || busy}
                  >
                    {modelOptions.length === 0 && <option value="">没有已启用的兼容模型</option>}
                    {modelOptions.map((item) => (
                      <option key={item.optionKey} value={item.optionKey}>
                        {item.model.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {eligibleProfiles.length === 0 ? (
              <div className="provider-required-state">
                <Settings2 size={20} />
                <strong>还没有可用于制作的供应商连接</strong>
                <span>
                  请在设置中心添加并测试官方媒体供应商、UniCompAPI，或文生图所用的 OpenAI
                  兼容自定义连接。
                </span>
                <button className="button secondary" type="button" onClick={onOpenProviderSettings}>
                  前往供应商与模型
                </button>
              </div>
            ) : null}

            {selectedProfile && modelOptions.length === 0 && (
              <div className="provider-required-state compact">
                <strong>当前连接没有兼容模型</strong>
                <span>请在设置中心启用支持当前制作方式的模型。</span>
                <button className="button secondary" type="button" onClick={onOpenProviderSettings}>
                  管理模型
                </button>
              </div>
            )}

            {adapter && (
              <>
                {frameInputConflict && (
                  <section
                    ref={frameConflictRef}
                    role="alert"
                    className="production-notes"
                    aria-label="图片用途冲突"
                  >
                    {frameConflictContents}
                  </section>
                )}
                <div className="parameter-fields production-content-fields">
                  {contentFields.map(renderParameter)}
                  {(productionAuthoring.result?.source || productionAuthoring.error) && (
                    <details
                      className="production-adaptation"
                      aria-label="制作内容适配"
                      open={Boolean(
                        productionAuthoring.error ||
                        productionAuthoring.result?.issues.length ||
                        promptReviewNotices.length ||
                        (isVideoCapability(adapter.capability) && currentImages.length) ||
                        (productionAuthoring.result?.estimatedDurationSeconds !== undefined &&
                          Number(parameters.duration) > 0 &&
                          Number(parameters.duration) !==
                            productionAuthoring.result.estimatedDurationSeconds),
                      )}
                    >
                      <summary>制作说明</summary>
                      <div className="production-adaptation-body">
                        {promptReviewNotices.length > 0 && (
                          <div className="production-notes" role="status" aria-label="镜头内容提醒">
                            <ul>
                              {promptReviewNotices.map((notice, index) => (
                                <li key={`${notice.code}:${index}`}>
                                  {notice.targetTitle
                                    ? `「${notice.targetTitle}」：${notice.message}`
                                    : notice.message}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {adaptationNotices.length > 0 && (
                          <div className="production-notes" role="status" aria-label="模型适配说明">
                            <ul>
                              {adaptationNotices.map((notice, index) => (
                                <li key={`${notice.code}:${index}`}>{notice.message}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {sceneSegments.length > 1 && (
                          <label className="parameter-field">
                            本次制作范围
                            <select
                              disabled={busy || productionAuthoring.loading}
                              value={
                                segmentShotIds
                                  ? String(
                                      sceneSegments.findIndex(
                                        (segment) =>
                                          segment.shotIds.join(',') === segmentShotIds.join(','),
                                      ),
                                    )
                                  : 'full'
                              }
                              onChange={(event) =>
                                setSegmentShotIds(
                                  event.target.value === 'full'
                                    ? undefined
                                    : sceneSegments[Number(event.target.value)]?.shotIds,
                                )
                              }
                            >
                              <option value="full">完整场次（全部分镜）</option>
                              {sceneSegments.map((segment, index) => (
                                <option
                                  key={index}
                                  value={index}
                                  disabled={segment.needsShotRevision}
                                >
                                  第 {index + 1} 段 · 剧情预计 {segment.estimatedDurationSeconds} 秒
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {segmentShotIds && completeScenePrompt && (
                          <details>
                            <summary>查看完整场次方案</summary>
                            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                              {completeScenePrompt}
                            </pre>
                          </details>
                        )}
                        {isVideoCapability(adapter.capability) && (
                          <>
                            <ProductionTimingDetails
                              result={productionAuthoring.result}
                              requestedDuration={parameters.duration}
                            />
                            <ProductionInputRoleDetails images={currentImages} />
                          </>
                        )}
                        {productionAuthoring.result?.issues.some(
                          (issue) => issue.code === 'SCENE_REQUIRES_SEGMENTS',
                        ) && (
                          <section aria-label="场次分段制作建议">
                            <p>完整场次已保留。以下按现有镜头边界分段；请逐段制作后合成。</p>
                            <ol>
                              {productionAuthoring.result.segments?.map((segment, index) => (
                                <li key={index}>
                                  第 {index + 1} 段：
                                  {segment.shotIds
                                    .map(
                                      (id) =>
                                        productionAuthoring.result?.timeline?.find(
                                          (entry) => entry.shotId === id,
                                        )?.title ?? id,
                                    )
                                    .join('、')}
                                  ，剧情预计 {segment.estimatedDurationSeconds} 秒
                                  {segment.needsShotRevision
                                    ? '；单镜也超过模型能力，需要更长时长的模型或重新设计镜头。'
                                    : `，模型请求 ${segment.requestedDurationSeconds} 秒。`}
                                </li>
                              ))}
                            </ol>
                          </section>
                        )}
                        {productionAuthoring.overriddenFields.length > 0 && (
                          <p>已保留修改或保存的参数；重新填入将覆盖这些值。</p>
                        )}
                        <p>制作说明仅供参考，可自由修改表单；生成时以当前表单为准。</p>
                        <div className="production-adaptation-actions">
                          <p role="status">
                            {productionAuthoring.error ||
                              productionAuthoring.result?.issues
                                .map((issue) =>
                                  issue.targetTitle
                                    ? `「${issue.targetTitle}」：${issue.message}`
                                    : issue.message,
                                )
                                .join('；') ||
                              '已填入制作内容'}
                          </p>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={busy || productionAuthoring.loading}
                            onClick={productionAuthoring.refill}
                          >
                            重新填入制作内容
                          </button>
                        </div>
                      </div>
                    </details>
                  )}
                </div>
                <details className="production-more-settings" open={errors.length > 0}>
                  <summary>更多设置</summary>
                  {outputFields.length > 0 && (
                    <section className="production-output-section" aria-label="输出设置">
                      <h3>输出设置</h3>
                      <div className="parameter-fields production-output-fields">
                        {outputFields.map(renderParameter)}
                      </div>
                    </section>
                  )}
                  {advancedFields.length > 0 && (
                    <details
                      className="advanced-parameters"
                      open={errors.some((error) =>
                        advancedFields.some(
                          (field) => normalizeErrorPath(error.path) === field.key,
                        ),
                      )}
                    >
                      <summary>专业参数</summary>
                      <div className="parameter-fields">
                        {advancedFields.map((field) => (
                          <ParameterField
                            key={`${projectId ?? 'no-project'}:${shotId ?? 'no-shot'}:${adapter.key}:${field.key}`}
                            field={field}
                            property={adapter.parameterSchema.properties[field.key]!}
                            value={parameters[field.key]}
                            required={adapter.parameterSchema.required.includes(field.key)}
                            error={
                              errors.find((item) => normalizeErrorPath(item.path) === field.key)
                                ?.message
                            }
                            onChange={(value) => updateParameter(field.key, value)}
                            projectId={projectId}
                            references={references}
                          />
                        ))}
                      </div>
                    </details>
                  )}
                  {projectId && (
                    <ProjectProductionDefaults
                      key={`${projectId}:${projectSessionId}`}
                      writable={writable}
                      onSaved={productionAuthoring.refreshKeepingEdits}
                    />
                  )}
                  {adapter.provider === 'unicompapi' &&
                    productionAudioSupport(adapter).voiceReference && (
                      <p className="production-settings-note" role="note">
                        “生成音频”控制成片是否带声音。指定声音参考时，在参考素材中添加参考音频，填写公网音频地址；本地声音样本请使用对应模型的官方视频连接。
                      </p>
                    )}
                </details>

                {(isOfficialVoiceVideo(adapter) ||
                  (productionAudioSupport(adapter).voiceReference &&
                    Boolean(boundScene?.characterBindings?.length))) &&
                  (productionAudioSupport(adapter).dialogueDriven ||
                    voiceReferences.length > 0) && (
                    <section className="parameter-fields production-audio-inputs">
                      <h3>
                        {productionAudioSupport(adapter).dialogueDriven
                          ? '完整对白驱动'
                          : '角色声音参考'}
                      </h3>
                      {productionAudioSupport(adapter).dialogueDriven ? (
                        <>
                          <p>
                            万相 2.7
                            使用完整对白录音驱动画面。音频中的台词会保留，请勿把它当作生成新台词的声音样本。
                          </p>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={
                              !writable || busy || sceneInputsLoading || Boolean(sceneInputsError)
                            }
                            onClick={() => void importDrivingAudio()}
                          >
                            {dialogueAudio ? '更换完整对白' : '导入完整对白'}
                          </button>
                          {dialogueAudio && (
                            <p>
                              {dialogueAudio.name} · {(dialogueAudio.durationMs / 1000).toFixed(1)}{' '}
                              秒
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          {isOfficialVoiceVideo(adapter) ? (
                            <p>
                              场次选用的声音版本会预先选中，图片与声音按实际提交顺序编号。声音版本变化后需回场次重新选择。
                            </p>
                          ) : (
                            <p role="note">
                              当前模型支持音频参考，但当前连接未接入本地角色声音上传。请切换支持本地声音上传的连接，或取消下方勾选后，在“参考素材”中添加公网参考音频地址。取消勾选只影响本次表单，不修改场次声音绑定。
                            </p>
                          )}
                          {voiceReferences.length === 0 ? (
                            <p>请先在“角色与场景”的角色资料中导入声音样本。</p>
                          ) : (
                            voiceReferences.map((voice) => (
                              <label key={voice.id}>
                                <input
                                  type="checkbox"
                                  disabled={!writable || busy}
                                  checked={selectedVoiceIds.includes(voice.characterDocumentId)}
                                  onChange={(event) => {
                                    const nextIds = event.target.checked
                                      ? [...selectedVoiceIds, voice.characterDocumentId]
                                      : selectedVoiceIds.filter(
                                          (id) => id !== voice.characterDocumentId,
                                        );
                                    const withoutSavedVoices = { ...parameters };
                                    for (const key of ['media', 'content']) {
                                      const value = parameters[key];
                                      if (Array.isArray(value))
                                        withoutSavedVoices[key] = value.filter((item) => {
                                          if (
                                            !item ||
                                            typeof item !== 'object' ||
                                            Array.isArray(item)
                                          )
                                            return true;
                                          const url =
                                            item.type === 'reference_audio'
                                              ? item.url
                                              : item.type === 'audio_url' &&
                                                  item.audio_url &&
                                                  typeof item.audio_url === 'object' &&
                                                  !Array.isArray(item.audio_url)
                                                ? item.audio_url.url
                                                : undefined;
                                          return (
                                            typeof url !== 'string' ||
                                            !url.startsWith('character-voice://')
                                          );
                                        });
                                    }
                                    const next = remapPromptReferences(
                                      referenceInputs(parameters),
                                      referenceInputs(withoutSavedVoices, nextIds),
                                      withoutSavedVoices,
                                    );
                                    const nextWithAudioBindings = adapter
                                      ? addProductionAudioBindings(
                                          adapter,
                                          next,
                                          isOfficialVoiceVideo(adapter)
                                            ? selectedVoicePromptBindings(nextIds)
                                            : [],
                                          productionAudioImageBindings(
                                            adapter,
                                            next,
                                            compiledReferenceBindings ??
                                              seedReferenceBindings ??
                                              [],
                                          ),
                                        )
                                      : next;
                                    const previousPrompt = adapter
                                      ? addProductionAudioBindings(adapter, parameters, [])
                                      : parameters;
                                    const nextPrompt = adapter
                                      ? addProductionAudioBindings(
                                          adapter,
                                          nextWithAudioBindings,
                                          [],
                                        )
                                      : nextWithAudioBindings;
                                    for (const field of ['prompt', 'content'])
                                      if (nextPrompt[field] !== previousPrompt[field])
                                        productionAuthoring.changed(field, nextPrompt[field]);
                                    setParameters(nextWithAudioBindings);
                                    productionAuthoring.changed(
                                      'media',
                                      nextWithAudioBindings.media,
                                    );
                                    productionAuthoring.changed(
                                      'content',
                                      nextWithAudioBindings.content,
                                    );
                                    setSelectedVoiceIds(nextIds);
                                  }}
                                />
                                {voice.characterName} · 声音版本 {voice.revision} ·{' '}
                                {(voice.durationMs / 1000).toFixed(1)} 秒
                              </label>
                            ))
                          )}
                        </>
                      )}
                    </section>
                  )}

                {adapter.capability === 'TEXT_TO_AUDIO' ? (
                  <p className="production-settings-note" role="note">
                    生成的音频样本会保存到当前项目，可在此试听。
                  </p>
                ) : null}
                <div className="draft-actions">
                  {submissionDisabledReason && (
                    <section className="production-action-blocker" aria-label="提交前检查">
                      <p id={actionBlockReasonId} role="status">
                        {submissionDisabledReason}
                      </p>
                      {frameConflictContents}
                    </section>
                  )}
                  <div
                    className={`draft-action-row${adapter.capability === 'TEXT_TO_AUDIO' ? ' production-audio-action-row' : ''}`}
                  >
                    {adapter.capability !== 'TEXT_TO_AUDIO' ? (
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => void saveDraft()}
                        disabled={Boolean(draftDisabledReason)}
                        aria-describedby={draftDisabledReason ? actionBlockReasonId : undefined}
                        title={draftSaveHint}
                      >
                        <Save size={14} />
                        保存草稿
                      </button>
                    ) : null}
                    {adapter.capability === 'TEXT_TO_AUDIO' ? (
                      <>
                        <button
                          className="button primary"
                          type="button"
                          onClick={() => void generateAudioSample()}
                          disabled={Boolean(submissionDisabledReason)}
                          aria-describedby={
                            submissionDisabledReason ? actionBlockReasonId : undefined
                          }
                          title={submissionDisabledReason}
                        >
                          <Volume2 size={14} />
                          生成音频样本
                        </button>
                        {audioReference ? (
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => void generateAudioReference()}
                            disabled={Boolean(submissionDisabledReason)}
                            aria-describedby={
                              submissionDisabledReason ? actionBlockReasonId : undefined
                            }
                            title={submissionDisabledReason}
                          >
                            <Volume2 size={14} />
                            制作声音参考
                          </button>
                        ) : null}
                      </>
                    ) : isVideoCapability(adapter.capability) ? (
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void generateVideo()}
                        disabled={Boolean(submissionDisabledReason)}
                        aria-describedby={
                          submissionDisabledReason ? actionBlockReasonId : undefined
                        }
                        title={submissionDisabledReason}
                      >
                        <Video size={14} />
                        提交视频任务
                      </button>
                    ) : (
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void generateImage()}
                        disabled={Boolean(submissionDisabledReason)}
                        aria-describedby={
                          submissionDisabledReason ? actionBlockReasonId : undefined
                        }
                        title={submissionDisabledReason}
                      >
                        <WandSparkles size={14} />
                        生成图片
                      </button>
                    )}
                    {generationJobId && busy && !isVideoCapability(adapter.capability) && (
                      <button
                        className="icon-button danger"
                        type="button"
                        title="取消生成"
                        onClick={() => void cancelImage()}
                      >
                        <Square size={13} />
                      </button>
                    )}
                  </div>
                  <div className="draft-options-row">
                    {isVideoCapability(adapter.capability) ? (
                      <label className="asset-kind-field">
                        保存为
                        <select
                          value={sceneId ? 'scene-video' : videoAssetKind}
                          onChange={(event) =>
                            setVideoAssetKind(event.target.value as VideoAssetKind)
                          }
                          disabled={busy || Boolean(sceneId)}
                        >
                          {sceneId ? (
                            <option value="scene-video">场次视频</option>
                          ) : (
                            <option value="shot-video">镜头视频</option>
                          )}
                          <option value="generated-video">普通视频素材</option>
                        </select>
                      </label>
                    ) : adapter.capability !== 'TEXT_TO_AUDIO' ? (
                      <>
                        <label className="asset-kind-field">
                          保存为
                          <select
                            value={assetKind}
                            onChange={(event) =>
                              setAssetKind(event.target.value as typeof assetKind)
                            }
                            disabled={busy}
                          >
                            <option value="generated-image">普通素材</option>
                            <option value="character">角色</option>
                            <option value="scene">场景</option>
                            <option value="prop">道具</option>
                            <option value="first-frame">首帧</option>
                            <option value="last-frame">尾帧</option>
                          </select>
                        </label>
                      </>
                    ) : null}
                  </div>
                  {message && (
                    <span className={errors.length > 0 ? 'validation-error' : 'validation-ok'}>
                      {errors.length > 0 ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
                      {message}
                    </span>
                  )}
                  {generationStatus && (
                    <span className="production-status-message">{generationStatus}</span>
                  )}
                </div>
                {adapter.capability === 'TEXT_TO_AUDIO' ? (
                  <section className="production-audio-samples" aria-label="项目音频样本">
                    <header>
                      <h3>项目音频样本</h3>
                      <span>{audioSamples.length}</span>
                    </header>
                    {audioSamplesLoading ? <p>正在读取音频样本…</p> : null}
                    {audioSamplesError ? <p role="status">{audioSamplesError}</p> : null}
                    {!audioSamplesLoading && !audioSamplesError && audioSamples.length === 0 ? (
                      <p>尚无音频样本。</p>
                    ) : null}
                    {audioSamples.length > 0 ? (
                      <ul>
                        {audioSamples.map((audio) => (
                          <AudioSamplePreview
                            key={audio.id}
                            projectId={projectId ?? ''}
                            audio={audio}
                          />
                        ))}
                      </ul>
                    ) : null}
                  </section>
                ) : null}
                {isVideoCapability(adapter.capability) && videoJobs.length > 0 && (
                  <section className="video-task-center" aria-label="视频任务">
                    <header>
                      <strong>视频任务</strong>
                      <span>{videoJobs.length}</span>
                    </header>
                    {videoJobs.map((job) => {
                      const resultAsset = job.results[0]?.asset;
                      return (
                        <div className="video-task-row" key={job.id}>
                          <div className="video-task-summary">
                            <strong>{generationStatusLabel(generationTaskStatus(job))}</strong>
                            <span>{formatElapsed(job.elapsedMs)}</span>
                            <small>
                              {formatVideoCost(job.metadata.cost)}
                              {' · '}
                              查询 {job.metadata.pollAttempts} 次
                            </small>
                            <small className="video-task-guidance">
                              {videoProgressGuidance(job)}
                            </small>
                            {job.status === 'polling' && job.metadata.lastPollError && (
                              <small className="error-copy">
                                最近一次查询异常（正在重试）：{job.metadata.lastPollError}
                              </small>
                            )}
                            {job.error && (
                              <small className="error-copy">
                                {job.mediaState === 'submission_unknown'
                                  ? SUBMISSION_UNKNOWN_MESSAGE
                                  : generationErrorFeedback(job.error, job.metadata.failureKind)
                                      .userMessage}
                              </small>
                            )}
                          </div>
                          <div className="video-task-actions">
                            {job.status === 'polling' && (
                              <button
                                className="icon-button subtle"
                                type="button"
                                title="暂停查询"
                                onClick={() => void pauseVideo(job)}
                              >
                                <Pause size={13} />
                              </button>
                            )}
                            {job.status === 'paused' && (
                              <button
                                className="icon-button subtle"
                                type="button"
                                title="继续查询"
                                onClick={() => void resumeVideo(job)}
                              >
                                <Play size={13} />
                              </button>
                            )}
                            {['pending', 'polling', 'downloading', 'paused'].includes(
                              job.status,
                            ) && (
                              <button
                                className="icon-button danger"
                                type="button"
                                title="取消任务"
                                onClick={() => void cancelVideo(job)}
                              >
                                <Square size={13} />
                              </button>
                            )}
                            {resultAsset && (
                              <button
                                className="button primary video-task-result-button"
                                type="button"
                                title="查看生成素材"
                                disabled={!onOpenAssetLibrary}
                                onClick={() => onOpenAssetLibrary?.(resultAsset.id)}
                              >
                                <Eye size={13} />
                                查看素材
                              </button>
                            )}
                            {resultAsset && (
                              <button
                                className="icon-button subtle"
                                type="button"
                                title="使用系统播放器打开"
                                onClick={() => void openAsset(resultAsset)}
                              >
                                <Play size={13} />
                              </button>
                            )}
                            {resultAsset && (
                              <button
                                className="icon-button subtle"
                                type="button"
                                title="打开视频位置"
                                onClick={() => void revealAsset(resultAsset)}
                              >
                                <FolderOpen size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

export function ProductionPanel({
  capability,
  projectId,
  sceneId,
  writable,
  onOpenAssetLibrary,
  ...mediaProps
}: ProductionPanelProps) {
  return (
    <MediaProductionPanel
      {...mediaProps}
      capability={capability}
      projectId={projectId}
      shotId={capability === 'TEXT_TO_AUDIO' ? undefined : mediaProps.shotId}
      sceneId={capability === 'TEXT_TO_AUDIO' ? undefined : sceneId}
      sourceDocumentId={capability === 'TEXT_TO_AUDIO' ? undefined : mediaProps.sourceDocumentId}
      writable={writable}
      onOpenAssetLibrary={onOpenAssetLibrary}
    />
  );
}

interface ParameterFieldProps {
  field: AdapterUiField;
  property: AdapterParameterProperty;
  value?: AdapterParameters[string];
  required: boolean;
  error?: string;
  onChange: (value: AdapterParameters[string] | undefined) => void;
  projectId?: string;
  references: PromptReference[];
}

function ParameterField({
  field,
  property,
  value,
  required,
  error,
  onChange,
  projectId,
  references,
}: ParameterFieldProps) {
  const inputId = `parameter-${field.key}`;
  const label = (
    <label htmlFor={inputId}>
      {property.title}
      {required && <span aria-label="必填">*</span>}
    </label>
  );
  const description = <ParameterHelp description={property.description} label={property.title} />;

  if (field.control === 'structured')
    return (
      <div className={`parameter-field ${error ? 'invalid' : ''}`}>
        <StructuredParameterField
          schema={property}
          value={value}
          onChange={onChange}
          label={property.title}
          path={inputId}
          projectId={projectId}
          references={references}
        />
        {description}
        {error && <small className="parameter-error">{error}</small>}
      </div>
    );

  if (field.control === 'toggle') {
    return (
      <div className={`parameter-field toggle-field ${error ? 'invalid' : ''}`}>
        <label htmlFor={inputId}>
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{property.title}</span>
        </label>
        {description}
        {error && <small className="parameter-error">{error}</small>}
      </div>
    );
  }

  if (field.control === 'url-list')
    return (
      <ImageListParameterField
        field={field}
        property={property}
        value={value}
        error={error}
        onChange={onChange}
        projectId={projectId}
        inputId={inputId}
        label={label}
        description={description}
      />
    );

  const enumValues = property.enum ?? [];
  return (
    <StructuredAssetDrop
      schema={property}
      value={value}
      projectId={projectId}
      onChange={onChange}
      mediaKind={
        ['video', 'video_url'].includes(field.key) && property.type === 'string'
          ? 'video'
          : undefined
      }
    >
      <div
        className={`parameter-field ${field.control === 'textarea' ? 'prompt-field ' : ''}${error ? 'invalid' : ''}`}
      >
        {label}
        {description}
        {field.control === 'select' ? (
          <select
            id={inputId}
            value={parameterScalarText(value)}
            onChange={(event) =>
              onChange(
                property.type === 'integer' || property.type === 'number'
                  ? Number(event.target.value)
                  : event.target.value,
              )
            }
          >
            {enumValues.map((item) => (
              <option key={parameterScalarText(item)} value={parameterScalarText(item)}>
                {parameterScalarText(item)}
              </option>
            ))}
          </select>
        ) : field.control === 'textarea' ? (
          references.length && field.key === 'prompt' ? (
            <PromptReferenceEditor
              id={inputId}
              label={property.title}
              value={typeof value === 'string' ? value : ''}
              references={references}
              projectId={projectId}
              maxLength={property.maxLength}
              onChange={onChange}
            />
          ) : (
            <textarea
              id={inputId}
              value={typeof value === 'string' ? value : ''}
              maxLength={property.maxLength}
              onChange={(event) => onChange(event.target.value)}
            />
          )
        ) : (
          <input
            id={inputId}
            type={field.control === 'number' ? 'number' : 'text'}
            value={typeof value === 'number' || typeof value === 'string' ? value : ''}
            min={property.minimum}
            max={property.maximum}
            onChange={(event) =>
              onChange(
                field.control === 'number'
                  ? event.target.value
                    ? Number(event.target.value)
                    : undefined
                  : event.target.value,
              )
            }
          />
        )}
        {error && <small className="parameter-error">{error}</small>}
      </div>
    </StructuredAssetDrop>
  );
}
