import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ImagePreview } from './ImagePreview';
import { useProductionInstructions } from './use-production-instructions';
import { ProjectProductionDefaults } from './ProjectProductionDefaults';
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
import { AssetImagePreview } from './AssetImagePreview';
import {
  CircleAlert,
  CircleCheck,
  ChevronDown,
  ChevronUp,
  Eye,
  FolderOpen,
  ImagePlus,
  Pause,
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
  WandSparkles,
  Square,
  Video,
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
  ImagePreviewInfo,
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
import { projectWorker, workerMediaUrl } from './worker-scope';
import {
  adapterBindsCatalogModel,
  isWanMediaAdapter,
  productionAudioSupport,
  seedProductionInputs,
} from '@ai-video/contracts';
import {
  generationErrorFeedback,
  generationStatusLabel,
  generationTaskStatus,
  videoProgressGuidance,
} from './generation-feedback';
import { MediaSubmissionConfirmationDialog } from './media-confirmation';
import {
  hasLocalImageParameters,
  isLocalImageDataUrl,
  MAX_LOCAL_IMAGE_TOTAL_BYTES,
  readLocalImageFile,
  totalLocalImageBytes,
  type LocalImageSelection,
} from './local-image-input';

interface ProductionPanelProps {
  onRequestSubmissionApproval?: (
    confirmation: MediaSubmissionConfirmationRequest,
  ) => Promise<boolean>;
  expanded?: boolean;
  capability?: GenerationCapability;
  projectId?: string;
  projectSessionId?: string;
  /** Identity of the loaded project view, including reopening the same project. */
  projectViewEpoch?: object;
  projectRootPath?: string;
  shotId?: string;
  sceneId?: string;
  sourceDocumentId?: string;
  seedPrompt?: string;
  seedImages?: string[];
  seedReferenceBindings?: SceneMaterialBindingInfo[];
  seedImageBindings?: import('@ai-video/contracts').ProductionImageSelection[];
  preferredAssetKind?: ImageAssetKind;
  writable: boolean;
  assets?: AssetInfo[];
  videoJobs?: VideoGenerationJobInfo[];
  imageJobs?: import('@ai-video/contracts').ImageGenerationJobInfo[];
  focusedAssetId?: string;
  focusedJobId?: string;
  onAssetsChanged?: (assets: AssetInfo[], selectedAssetId?: string) => void;
  onOpenAssetLibrary?: (assetId?: string) => void;
  onOpenProviderSettings?: () => void;
  providerSettingsRevision?: number;
}

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
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          (Array.isArray(value) &&
            value.every(
              (item) =>
                typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
            ) &&
            !value.some(isLocalImageDataUrl)),
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
        ([, value]) =>
          value !== undefined &&
          !isLocalImageDataUrl(value) &&
          !(Array.isArray(value) && value.some(isLocalImageDataUrl)),
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

/**
 * Contracts are schema-first. Legacy descriptors may still provide an
 * explicit uiSchema, but a descriptor without one gets a deterministic form
 * derived from its JSON Schema so new provider bindings do not require a new
 * React component.
 */
function schemaDerivedFields(adapter: AdapterDescriptor): AdapterUiField[] {
  const explicit = adapter.uiSchema?.fields ?? [];
  if (explicit.length > 0) return [...explicit].sort((a, b) => a.order - b.order);
  return Object.entries(adapter.parameterSchema.properties).map(([key, property], index) => {
    const control: AdapterUiField['control'] =
      property.type === 'object' || (property.type === 'array' && property.items?.type !== 'string')
        ? 'structured'
        : property.type === 'boolean'
          ? 'toggle'
          : property.type === 'integer'
            ? 'number'
            : property.enum?.length
              ? 'select'
              : property.type === 'array' && property.items?.format === 'uri'
                ? 'url-list'
                : property.title.length > 40 ||
                    /prompt|message|description|content|text/iu.test(key)
                  ? 'textarea'
                  : 'text';
    return { key, control, group: 'basic', order: index * 10 };
  });
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

function isVideoAsset(asset: AssetInfo | undefined): boolean {
  return (
    asset?.kind === 'generated-video' ||
    asset?.kind === 'shot-video' ||
    asset?.kind === 'scene-video'
  );
}

function isAssetReference(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('asset://') && value.length > 8;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(kibibytes >= 10 ? 0 : 1)} KiB`;
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
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

function mediaSrcForAbsolutePath(absolutePath: string): string | undefined {
  try {
    return convertFileSrc(absolutePath);
  } catch {
    return undefined;
  }
}

function mediaSrcForAsset(assetId: string, absolutePath: string): string | undefined {
  if (!('__TAURI_INTERNALS__' in window)) return workerMediaUrl(assetId);
  return mediaSrcForAbsolutePath(absolutePath);
}

export function ProductionPanel({
  expanded = false,
  capability,
  projectId,
  projectSessionId,
  projectViewEpoch,
  projectRootPath,
  shotId,
  sceneId,
  sourceDocumentId,
  seedPrompt,
  seedImages,
  seedReferenceBindings,
  seedImageBindings,
  preferredAssetKind,
  writable,
  assets: controlledAssets,
  videoJobs = [],
  imageJobs = [],
  focusedAssetId,
  focusedJobId,
  onAssetsChanged,
  onOpenAssetLibrary,
  onOpenProviderSettings,
  providerSettingsRevision = 0,
  onRequestSubmissionApproval,
}: ProductionPanelProps) {
  const callWorker = projectWorker();
  const [catalog, setCatalog] = useState<AdapterCatalogResult>();
  const [profiles, setProfiles] = useState<ProviderProfileInfo[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [adapterKey, setAdapterKey] = useState('');
  const [catalogModelId, setCatalogModelId] = useState('');
  const [adapter, setAdapter] = useState<AdapterDescriptor>();
  const [parameters, setParameters] = useState<AdapterParameters>({});
  const [formReady, setFormReady] = useState(false);
  const [draftOverrides, setDraftOverrides] = useState<AdapterParameters>();
  const [segmentShotIds, setSegmentShotIds] = useState<string[]>();
  const [sceneSegments, setSceneSegments] = useState<ProductionSegment[]>([]);
  const [completeScenePrompt, setCompleteScenePrompt] = useState('');
  const productionInstructions = useProductionInstructions({
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
    ready: formReady && adapter?.key === adapterKey,
    setParameters,
    initialOverrides: draftOverrides,
    shotIds: segmentShotIds,
    inputImages: seedImageBindings,
  });
  useEffect(() => {
    setSegmentShotIds(undefined);
    setSceneSegments([]);
    setCompleteScenePrompt('');
  }, [projectId, sceneId, adapterKey, selectedProfileId]);
  useEffect(() => {
    const result = productionInstructions.result;
    if (
      sceneId &&
      result?.target.id === sceneId &&
      !result.source?.shotIds &&
      result.timeline?.length
    ) {
      setSceneSegments(result.segments ?? []);
      setCompleteScenePrompt(result.compiledPrompt ?? '');
    }
  }, [sceneId, productionInstructions.result]);
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
  const [voiceReferences, setVoiceReferences] = useState<CharacterVoiceReferenceInfo[]>([]);
  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>([]);
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
  const compiledSceneInputs = productionInstructions.result?.sceneInputs;
  const productionInstruction = productionInstructions.result?.instruction;
  const needsVoiceInput =
    !productionInstruction ||
    productionInstruction.audio.mode === 'voice-reference' ||
    productionInstruction.resources.some((r) => r.required && r.kind === 'voice-reference');
  const needsDialogueInput =
    !productionInstruction ||
    productionInstruction.audio.mode === 'dialogue-driven' ||
    productionInstruction.resources.some((r) => r.required && r.kind === 'dialogue-audio');
  const compiledSceneInputsRef = useRef(compiledSceneInputs);
  compiledSceneInputsRef.current = compiledSceneInputs;
  const compiledReferenceBindings = useMemo<SceneMaterialBindingInfo[] | undefined>(() => {
    if (!compiledSceneInputs || productionInstructions.result?.issues.length) return undefined;
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
  }, [compiledSceneInputs, productionInstructions.result?.issues]);
  useEffect(() => {
    if (!compiledSceneInputs || productionInstructions.result?.issues.length) return;
    const { scene: latest, media } = compiledSceneInputs;
    setSceneInputsLoading(false);
    setSceneInputsError('');
    setBoundScene(latest);
    setVoiceReferences(media.voices);
    setSelectedVoiceIds(
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
  }, [
    compiledSceneInputs,
    productionInstructions.result?.issues,
    needsVoiceInput,
    needsDialogueInput,
  ]);
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
                  adapter && productionAudioSupport(adapter).dialogueDriven
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
                        .map((binding) => binding.characterDocumentId),
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
  const [localAssets, setLocalAssets] = useState<AssetInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [preview, setPreview] = useState<ImagePreviewInfo>();
  const [generatedImages, setGeneratedImages] = useState<{
    projectId?: string;
    assets: AssetInfo[];
  }>();
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string>();
  const [savingPreview, setSavingPreview] = useState(false);
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
    setPreview(undefined);
    setGeneratedImages(undefined);
    setSavingPreview(false);
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
  const assets = controlledAssets ?? localAssets;
  const selectedAsset = assets.find((item) => item.id === selectedAssetId);
  const selectedImageAsset = isVideoAsset(selectedAsset) ? undefined : selectedAsset;
  const selectedVideoAsset = isVideoAsset(selectedAsset) ? selectedAsset : undefined;
  const unsavedPreview = preview?.jobId && !preview.assetId ? preview : undefined;
  const showResultPreview = Boolean(preview || selectedImageAsset || selectedVideoAsset);
  const effectiveCapability =
    catalog?.capabilities.some((item) => item.key === capability) === true
      ? capability!
      : (catalog?.capabilities[0]?.key ?? capability ?? 'TEXT_TO_IMAGE');

  useEffect(() => {
    setGeneratedImages(undefined);
  }, [projectId, shotId, sceneId, sourceDocumentId]);

  useEffect(() => {
    if (preferredAssetKind) setAssetKind(preferredAssetKind);
  }, [preferredAssetKind, sourceDocumentId]);

  useEffect(() => {
    if (!seedPrompt && seedImages === undefined) return;
    if (seedImageBindings) return;
    setParameters((current) =>
      productionInstructions.preserveEdits(
        usesStructuredVideoParameters(adapter)
          ? seedOfficialVideoParameters(
              adapter!,
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
    seedImageBindings,
    sourceDocumentId,
    adapter,
    productionInstructions.preserveEdits,
  ]);

  useEffect(() => {
    if (focusedAssetId && assets.some((item) => item.id === focusedAssetId)) {
      setSelectedAssetId(focusedAssetId);
    }
    if (focusedJobId) setGenerationJobId(focusedJobId);
  }, [assets, focusedAssetId, focusedJobId]);

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

  const eligibleProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          ((profile.providerType === 'vidu' && profile.protocol === 'vidu-v2') ||
            ['wan-video', 'seedance-video', 'minimax-video'].includes(profile.providerType) ||
            (profile.providerType === 'unicompapi' &&
              profile.protocol === 'openai-chat-completions')) &&
          profile.enabled &&
          profile.connectionStatus === 'ready' &&
          (profile.category === 'multi' ||
            (isVideoCapability(effectiveCapability)
              ? profile.category === 'video'
              : profile.category === 'image')),
      ),
    [effectiveCapability, profiles],
  );
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
          if (seedImageBindings) {
            try {
              return seedProductionInputs(
                resolved,
                params,
                seedPromptRef.current,
                seedImageBindings.map((image) => ({
                  ...image,
                  url: 'project-asset://' + image.assetId,
                })),
              );
            } catch {
              return params;
            }
          }
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
    seedImageBindings,
  ]);

  useEffect(() => {
    let active = true;
    if (controlledAssets !== undefined) return () => undefined;
    setLocalAssets([]);
    setSelectedAssetId(undefined);
    if (!projectId) return () => undefined;
    void callWorker('asset.list', {})
      .then((items) => {
        if (active) setLocalAssets(items);
      })
      .catch((reason) => {
        if (active) setGenerationStatus(errorMessage(reason, '素材列表读取失败。'));
      });
    return () => {
      active = false;
    };
  }, [controlledAssets, projectId]);

  useEffect(() => {
    if (!selectedAssetId || isVideoAsset(selectedAsset)) {
      // Keep unsaved generation previews (jobId without assetId) when selection clears or a video is selected.
      setPreview((current) => (current?.jobId && !current.assetId ? current : undefined));
      return;
    }
    let active = true;
    setPreview((current) => (current?.assetId === selectedAssetId ? current : undefined));
    void callWorker('asset.mediaSource', { assetId: selectedAssetId })
      .then((source) => {
        const dataUrl = mediaSrcForAsset(selectedAssetId, source.path);
        if (active && dataUrl) {
          setPreview({ assetId: selectedAssetId, dataUrl, contentType: source.contentType });
        }
      })
      .catch((reason) => {
        if (active) setGenerationStatus(errorMessage(reason, '素材预览读取失败。'));
      });
    return () => {
      active = false;
    };
  }, [selectedAsset?.kind, selectedAssetId]);

  useEffect(() => {
    if (!selectedAsset || !isVideoAsset(selectedAsset) || !projectRootPath) {
      setVideoPreviewUrl(undefined);
      return;
    }
    const root = projectRootPath.replace(/[\\/]+$/, '');
    setVideoPreviewUrl(mediaSrcForAbsolutePath(`${root}\\${selectedAsset.relativePath}`));
  }, [projectRootPath, selectedAsset]);

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
        : effectiveCapability === 'REFERENCE_TO_IMAGE'
          ? model.capabilities.imageEditing === true || model.capabilities.imageGeneration
          : model.capabilities.imageGeneration;
      if (!supportsCapability) return [];
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
  }, [capabilityAdapters, effectiveCapability, models, selectedProfile]);
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
    productionInstructions.changed(key, value);
    setParameters((current) => {
      const next = { ...current };
      if (value === undefined || value === '') {
        delete next[key];
      } else {
        next[key] = value;
      }
      if (adapterKey) writeStoredParameters(adapterKey, next);
      return next;
    });
    setErrors((current) => current.filter((error) => normalizeErrorPath(error.path) !== key));
    setMessage('');
    setGenerationStatus('');
  };

  const publishAssets = (nextAssets: AssetInfo[], nextSelectedAssetId?: string) => {
    if (controlledAssets === undefined) setLocalAssets(nextAssets);
    if (nextSelectedAssetId !== undefined) {
      setSelectedAssetId(nextSelectedAssetId);
    } else if (selectedAssetId && !nextAssets.some((item) => item.id === selectedAssetId)) {
      setSelectedAssetId(nextAssets[0]?.id);
    }
    onAssetsChanged?.(nextAssets, nextSelectedAssetId);
  };

  const localAssetPath = (asset: AssetInfo): string => {
    if (!projectRootPath) return asset.relativePath;
    const root = projectRootPath.replace(/[\\/]+$/, '');
    return `${root}\\${asset.relativePath}`;
  };

  const revealAsset = async (asset: AssetInfo | undefined = selectedAsset) => {
    if (!asset) return;
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

  const savePreviewToAssetLibrary = async () => {
    if (!preview?.jobId || preview.assetId || !writable) return;
    const scope = submissionScope;
    const isCurrent = () => currentSubmissionScope.current === scope;
    setSavingPreview(true);
    setGenerationStatus('');
    try {
      const saved = await callWorker('image.generate.savePreview', {
        jobId: preview.jobId,
        dataUrl: preview.dataUrl,
        contentType: preview.contentType,
        assetKind,
      });
      if (!isCurrent()) return;
      const savedAsset = saved.results.find((result) => result.asset)?.asset;
      const nextAssets = await callWorker('asset.list', {});
      if (!isCurrent()) return;
      publishAssets(nextAssets, savedAsset?.id);
      if (saved.preview) setPreview(saved.preview);
      setGenerationStatus('图片已保存到本地素材库。');
    } catch (reason) {
      if (isCurrent()) setGenerationStatus(errorMessage(reason, '预览保存失败。'));
    } finally {
      if (isCurrent()) setSavingPreview(false);
    }
  };

  const saveDraft = async () => {
    if (!adapter) return;
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
        Array.isArray(value) ? value.some(isLocalImageDataUrl) : isLocalImageDataUrl(value),
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
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters,
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
        parameters,
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
    if (!adapter || !selectedProfile || !selectedModel || !writable) return;
    const isCurrent = beginSubmission();
    setGenerationStatus('');
    try {
      const productionSource = await productionInstructions.beforeSubmit();
      if (!isCurrent()) return;
      const submissionParameters = parameters;
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
      if (completed.status === 'succeeded' && completed.preview) {
        setPreview(completed.preview);
      }
      const savedAsset = completed.results.find((result) => result.asset)?.asset;
      if (completed.status === 'succeeded') {
        setGeneratedImages({
          projectId,
          assets: completed.results.flatMap((result) => (result.asset ? [result.asset] : [])),
        });
      }
      if (completed.status === 'succeeded' && savedAsset) {
        const nextAssets = await callWorker('asset.list', {});
        if (!isCurrent()) return;
        publishAssets(nextAssets, savedAsset.id);
        if (completed.preview) {
          setPreview(completed.preview);
        } else {
          await callWorker('asset.mediaSource', { assetId: savedAsset.id })
            .then((source) => {
              if (!isCurrent()) return;
              const dataUrl = mediaSrcForAsset(savedAsset.id, source.path);
              if (dataUrl) {
                setPreview({
                  assetId: savedAsset.id,
                  jobId: completed.id,
                  dataUrl,
                  contentType: source.contentType,
                });
              }
            })
            .catch(() => undefined);
        }
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

  const generateVideo = async () => {
    if (
      !adapter ||
      !selectedProfile ||
      !selectedModel ||
      !isVideoCapability(adapter.capability) ||
      !writable
    )
      return;
    const isCurrent = beginSubmission();
    setGenerationStatus('');
    try {
      const productionSource = await productionInstructions.beforeSubmit();
      if (!isCurrent()) return;
      if (sceneInputsLoading || sceneInputsError)
        throw new Error(sceneInputsError || '正在读取场次绑定，请稍后提交。');
      const support = productionAudioSupport(adapter);
      const driving = support.dialogueDriven;
      if (
        boundScene &&
        !isOfficialVoiceVideo(adapter) &&
        ((needsDialogueInput && boundScene.dialogueAudioId) ||
          (needsVoiceInput &&
            boundScene.characterBindings?.some((item) => item.voiceReferenceVersionId)))
      )
        throw new Error(
          '当前连接不支持本场绑定的声音输入，请选择支持声音的视频模型，或先调整场次声音绑定。',
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
      const submissionParameters = isOfficialVoiceVideo(adapter)
        ? addOfficialRoleVoices(
            adapter,
            parameters,
            selectedVoices,
            needsDialogueInput ? dialogueAudio?.id : undefined,
            compiledReferenceBindings ?? seedReferenceBindings,
          )
        : parameters;
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

  const renameAsset = async (asset: AssetInfo) => {
    const currentName = asset.relativePath.split(/[\\/]/).pop() ?? 'image.png';
    const name = window.prompt('请输入新文件名，并保留扩展名：', currentName);
    if (!name) return;
    try {
      const renamed = await callWorker('asset.rename', { assetId: asset.id, name });
      publishAssets(
        assets.map((item) => (item.id === renamed.id ? renamed : item)),
        renamed.id,
      );
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '素材重命名失败。'));
    }
  };

  const removeAsset = async (asset: AssetInfo) => {
    if (!window.confirm('确定删除此图片素材？')) return;
    try {
      await callWorker('asset.delete', { assetId: asset.id });
      const nextAssets = assets.filter((item) => item.id !== asset.id);
      publishAssets(nextAssets);
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '素材删除失败。'));
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

  const fields = adapter ? schemaDerivedFields(adapter) : [];
  const basicFields = fields.filter((field) => field.group === 'basic');
  const advancedFields = fields.filter((field) => field.group === 'advanced');

  const draftSaveHint = !writable
    ? '当前项目为只读'
    : !shotId && !sceneId
      ? '请先选择镜头'
      : !selectedProfile || !selectedModel
        ? '请先选择供应商连接和模型'
        : undefined;

  return (
    <aside className={`production-panel panel-border${expanded ? ' expanded' : ''}`}>
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
            {projectId && (
              <ProjectProductionDefaults
                key={`${projectId}:${projectSessionId}`}
                writable={writable}
                onSaved={productionInstructions.refreshKeepingEdits}
              />
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
                        : profile.baseUrl === 'https://api.vidu.cn'
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
                <span>请在设置中心添加并测试官方视频供应商或 UniCompAPI 连接。</span>
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
                <div className="adapter-meta">
                  <strong>{adapter.modelLabel}</strong>
                  <span>
                    {selectedProfile?.name} · {adapter.providerLabel} · API {adapter.apiVersion}
                  </span>
                </div>
                <div className="parameter-fields">
                  {adapter.provider === 'unicompapi' && isWanMediaAdapter(adapter) && (
                    <p role="note">
                      “生成音频”控制成片是否带声音。指定声音参考时，在“参考素材”中添加“参考音频”，填写公网音频地址；本地声音样本请使用万相官方连接。
                    </p>
                  )}
                  {(productionInstructions.result?.source || productionInstructions.error) && (
                    <section aria-label="制作内容适配">
                      {Boolean(productionInstructions.result?.notices?.length) && (
                        <div role="status" aria-label="模型适配说明">
                          <ul>
                            {productionInstructions.result!.notices!.map((notice, index) => (
                              <li key={`${notice.code}:${index}`}>{notice.message}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {sceneSegments.length > 1 && (
                        <label className="parameter-field">
                          本次制作范围
                          <select
                            disabled={busy || productionInstructions.loading}
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
                      {productionInstructions.result?.estimatedDurationSeconds !== undefined && (
                        <p>
                          剧情预计 {productionInstructions.result.estimatedDurationSeconds} 秒
                          {productionInstructions.result.requestedDurationSeconds !== undefined
                            ? ` · 模型请求 ${productionInstructions.result.requestedDurationSeconds} 秒`
                            : ''}
                          。镜头节奏按剧情安排。
                        </p>
                      )}
                      {Boolean(productionInstructions.result?.timeline?.length) && (
                        <details>
                          <summary>
                            场次分镜时间轴（{productionInstructions.result!.timeline!.length} 镜头）
                          </summary>
                          <ol>
                            {productionInstructions.result!.timeline!.map((entry) => (
                              <li key={entry.shotId}>
                                {entry.title}：
                                {entry.startSeconds === undefined || entry.endSeconds === undefined
                                  ? '时间待补充'
                                  : `${entry.startSeconds}—${entry.endSeconds} 秒`}
                              </li>
                            ))}
                          </ol>
                        </details>
                      )}
                      {productionInstructions.result?.issues.some(
                        (issue) => issue.code === 'SCENE_REQUIRES_SEGMENTS',
                      ) && (
                        <section aria-label="场次分段制作建议">
                          <p>完整场次已保留。以下按现有镜头边界分段；请逐段制作后合成。</p>
                          <ol>
                            {productionInstructions.result.segments?.map((segment, index) => (
                              <li key={index}>
                                第 {index + 1} 段：
                                {segment.shotIds
                                  .map(
                                    (id) =>
                                      productionInstructions.result?.timeline?.find(
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
                      {productionInstructions.overriddenFields.length > 0 && (
                        <p>已保留你修改或保存的表单值；重新填入会替换这些值。</p>
                      )}
                      <p
                        role={
                          productionInstructions.error ||
                          productionInstructions.result?.issues.length
                            ? 'alert'
                            : 'status'
                        }
                      >
                        {productionInstructions.error ||
                          productionInstructions.result?.issues
                            .map((issue) => issue.message)
                            .join('；') ||
                          `已填入制作内容 · 版本 ${productionInstructions.result?.source?.revision}`}
                      </p>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || productionInstructions.loading}
                        onClick={productionInstructions.refill}
                      >
                        重新填入制作内容
                      </button>
                    </section>
                  )}
                  {basicFields.map((field) => (
                    <ParameterField
                      key={`${projectId ?? 'no-project'}:${shotId ?? 'no-shot'}:${adapter.key}:${field.key}`}
                      field={field}
                      property={adapter.parameterSchema.properties[field.key]!}
                      value={parameters[field.key]}
                      required={adapter.parameterSchema.required.includes(field.key)}
                      error={
                        errors.find((item) => normalizeErrorPath(item.path) === field.key)?.message
                      }
                      onChange={(value) => updateParameter(field.key, value)}
                      projectId={projectId}
                    />
                  ))}
                </div>
                {advancedFields.length > 0 && (
                  <details className="advanced-parameters">
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
                        />
                      ))}
                    </div>
                  </details>
                )}

                {isOfficialVoiceVideo(adapter) && (
                  <section className="parameter-fields">
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
                            {dialogueAudio.name} · {(dialogueAudio.durationMs / 1000).toFixed(1)} 秒
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p>
                          场次选用的声音版本会预先选中，图片与声音按实际提交顺序编号。声音版本变化后需回场次重新选择。
                        </p>
                        {voiceReferences.length === 0 ? (
                          <p>请先在“角色与场景”的角色资料中导入声音样本。</p>
                        ) : (
                          voiceReferences.map((voice) => (
                            <label key={voice.id}>
                              <input
                                type="checkbox"
                                disabled={!writable || busy}
                                checked={selectedVoiceIds.includes(voice.characterDocumentId)}
                                onChange={(event) =>
                                  setSelectedVoiceIds((current) =>
                                    event.target.checked
                                      ? [...current, voice.characterDocumentId]
                                      : current.filter((id) => id !== voice.characterDocumentId),
                                  )
                                }
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

                <div className="draft-actions">
                  <div className="draft-action-row">
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => void saveDraft()}
                      disabled={!writable || busy}
                      title={draftSaveHint}
                    >
                      <Save size={14} />
                      保存草稿
                    </button>
                    {isVideoCapability(adapter.capability) ? (
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void generateVideo()}
                        disabled={
                          !writable ||
                          busy ||
                          !formReady ||
                          productionInstructions.loading ||
                          !selectedProfile ||
                          !selectedModel
                        }
                      >
                        <Video size={14} />
                        提交视频任务
                      </button>
                    ) : (
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void generateImage()}
                        disabled={
                          !writable ||
                          busy ||
                          !formReady ||
                          productionInstructions.loading ||
                          !selectedProfile ||
                          !selectedModel
                        }
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
                    ) : (
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
                            <option value="first-frame">首帧</option>
                            <option value="last-frame">尾帧</option>
                          </select>
                        </label>
                      </>
                    )}
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
                {isVideoCapability(adapter.capability) && (
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
                                onClick={() => setSelectedAssetId(resultAsset.id)}
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
                    {videoJobs.length === 0 && (
                      <span className="video-task-empty">暂无视频任务</span>
                    )}
                  </section>
                )}
              </>
            )}
          </div>

          <div className="production-panel-result" aria-label="生成结果">
            <header className="production-result-header">
              <strong>生成结果</strong>
              {showResultPreview && <span>自动预览</span>}
            </header>
            {showResultPreview ? (
              <div className="asset-preview-card result-preview-card">
                <div className="asset-preview-frame">
                  {selectedVideoAsset ? (
                    videoPreviewUrl ? (
                      <video
                        key={selectedVideoAsset.id}
                        src={videoPreviewUrl}
                        controls
                        autoPlay
                        playsInline
                        aria-label={selectedVideoAsset.relativePath}
                      />
                    ) : (
                      <div className="video-result-fallback">
                        <Video size={36} />
                        <span>视频已就绪</span>
                        <button
                          className="button primary"
                          type="button"
                          onClick={() => void openAsset(selectedVideoAsset)}
                        >
                          <Play size={14} />
                          播放视频
                        </button>
                      </div>
                    )
                  ) : preview ? (
                    <ImagePreview
                      key={preview.dataUrl}
                      src={preview.dataUrl}
                      alt={selectedImageAsset?.relativePath ?? '生成图片预览'}
                    />
                  ) : (
                    <span>正在读取预览</span>
                  )}
                </div>
                <div className="asset-preview-meta">
                  <strong>
                    {selectedVideoAsset?.relativePath ??
                      selectedImageAsset?.relativePath ??
                      '本次生成预览'}
                  </strong>
                  {(selectedVideoAsset || selectedImageAsset) && (
                    <small>{localAssetPath(selectedVideoAsset ?? selectedImageAsset!)}</small>
                  )}
                </div>
                {(selectedImageAsset || selectedVideoAsset) && (
                  <div className="asset-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={() => void revealAsset(selectedVideoAsset ?? selectedImageAsset)}
                    >
                      <FolderOpen size={14} />
                      打开位置
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={() =>
                        onOpenAssetLibrary?.((selectedVideoAsset ?? selectedImageAsset)!.id)
                      }
                    >
                      <Eye size={14} />
                      查看素材库
                    </button>
                  </div>
                )}
                {unsavedPreview && !selectedImageAsset && !selectedVideoAsset && (
                  <div className="asset-actions single">
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => void savePreviewToAssetLibrary()}
                      disabled={!writable || savingPreview}
                    >
                      <Save size={14} />
                      保存到素材库
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="production-result-empty">
                <ImagePlus size={28} />
                <strong>生成完成后将在此自动预览</strong>
                <span>图片直接显示；视频完成后自动选中并尝试内嵌播放。</span>
              </div>
            )}
            {assets.length > 0 && (
              <>
                {generatedImages &&
                generatedImages.projectId === projectId &&
                generatedImages.assets.length > 1 ? (
                  <div className="generated-image-results" aria-label="本次生成的全部图片">
                    {generatedImages.assets.map((item) => (
                      <AssetImagePreview key={item.id} asset={item} />
                    ))}
                  </div>
                ) : null}
                <div className="asset-list" aria-label="素材列表">
                  {assets.map((asset) => (
                    <div
                      className={`asset-row${asset.id === selectedAssetId ? ' selected' : ''}`}
                      key={asset.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedAssetId(asset.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ')
                          setSelectedAssetId(asset.id);
                      }}
                    >
                      <span title={asset.sourceUrl}>{asset.relativePath}</span>
                      <small title={localAssetPath(asset)}>
                        {asset.kind} · {(asset.sizeBytes / 1024).toFixed(1)} KiB
                      </small>
                      <button
                        className="icon-button subtle"
                        type="button"
                        title="打开位置"
                        onClick={(event) => {
                          event.stopPropagation();
                          void revealAsset(asset);
                        }}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        className="icon-button subtle"
                        type="button"
                        title="重命名素材"
                        onClick={(event) => {
                          event.stopPropagation();
                          void renameAsset(asset);
                        }}
                      >
                        <Save size={13} />
                      </button>
                      <button
                        className="icon-button danger"
                        type="button"
                        title="删除素材"
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeAsset(asset);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
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
}

function ParameterField({
  field,
  property,
  value,
  required,
  error,
  onChange,
  projectId,
}: ParameterFieldProps) {
  const callWorker = projectWorker();
  const inputId = `parameter-${field.key}`;
  const [localFiles, setLocalFiles] = useState<Array<LocalImageSelection | undefined>>([]);
  const [selectionError, setSelectionError] = useState('');
  const label = (
    <label htmlFor={inputId}>
      {property.title}
      {required && <span aria-label="必填">*</span>}
    </label>
  );
  const description = property.description ? <small>{property.description}</small> : null;

  if (field.control === 'structured')
    return (
      <div className={`parameter-field ${error ? 'invalid' : ''}`}>
        <StructuredParameterField
          schema={property}
          value={value}
          onChange={onChange}
          label={property.title}
          path={inputId}
        />
        {description}
        {error && <small>{error}</small>}
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
        {error && <small>{error}</small>}
      </div>
    );
  }

  if (field.control === 'url-list') {
    const minimumRows = Math.max(1, property.minItems ?? 1);
    const currentItems = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    const items = Array.from(
      { length: Math.max(minimumRows, currentItems.length) },
      (_, index) => currentItems[index] ?? '',
    );
    const commitItems = (next: string[]) => {
      let length = next.length;
      while (length > minimumRows && !next[length - 1]) length -= 1;
      setSelectionError('');
      onChange(next.slice(0, length));
    };
    const chooseLocalFile = async (file: File | undefined, index: number) => {
      if (!file) return;
      try {
        const selected = await readLocalImageFile(file);
        const next = [...items];
        next[index] = selected.dataUrl;
        if (totalLocalImageBytes(next) > MAX_LOCAL_IMAGE_TOTAL_BYTES) {
          throw new Error('同一请求中的本地图片合计不能超过 20 MiB。');
        }
        setLocalFiles((current) => {
          const updated = [...current];
          updated[index] = selected;
          return updated;
        });
        commitItems(next);
      } catch (reason) {
        setSelectionError(errorMessage(reason, '本地图片选择失败。'));
      }
    };
    const clearItem = (index: number) => {
      if (items.length <= minimumRows) {
        const next = [...items];
        next[index] = '';
        setLocalFiles((current) => {
          const updated = [...current];
          updated[index] = undefined;
          return updated;
        });
        commitItems(next);
      } else {
        setLocalFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
        commitItems(items.filter((_, itemIndex) => itemIndex !== index));
      }
    };
    const moveItem = (index: number, offset: number) => {
      const destination = index + offset;
      if (destination < 0 || destination >= items.length) return;
      const next = [...items];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      setLocalFiles((current) => {
        const updated = [...current];
        [updated[index], updated[destination]] = [updated[destination], updated[index]];
        return updated;
      });
      commitItems(next);
    };
    const visibleError = selectionError || error;
    const dropAssets = async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      try {
        const raw = event.dataTransfer.getData('application/x-ai-video-asset+json');
        const payload = JSON.parse(raw) as {
          version?: number;
          projectId?: string;
          assets?: Array<{ id: string; kind: string }>;
        };
        if (payload.version !== 1 || payload.projectId !== projectId || !payload.assets?.length)
          throw new Error('只能拖入当前项目的素材。');
        if (payload.assets.some((item) => item.kind.includes('video')))
          throw new Error('此参数只接受图片素材。');
        const maximum = property.maxItems ?? 20;
        if (payload.assets.length > maximum) throw new Error(`最多可拖入 ${maximum} 项素材。`);
        await Promise.all(
          payload.assets.map((item) => callWorker('asset.mediaSource', { assetId: item.id })),
        );
        const next = payload.assets.map((item) => `asset://${item.id}`);
        while (next.length < minimumRows) next.push('');
        commitItems(next);
      } catch (reason) {
        setSelectionError(errorMessage(reason, '素材拖入失败。'));
      }
    };
    return (
      <div
        className={`parameter-field asset-drop-target ${visibleError ? 'invalid' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => void dropAssets(event)}
      >
        {label}
        {description}
        <div className="url-list">
          {items.map((item, index) => {
            const selectedFile = localFiles[index];
            const localFile = selectedFile?.dataUrl === item ? selectedFile : undefined;
            const orderedRole = property.minItems === 2 && property.maxItems === 2;
            const rowLabel = orderedRole ? (index === 0 ? '首帧' : '尾帧') : undefined;
            const fileInputId = `${inputId}-file-${index}`;
            const assetId = isAssetReference(item) ? item.slice(8) : undefined;
            const hasImage = isLocalImageDataUrl(item) || Boolean(assetId);
            const imageName = assetId ? '素材库图片' : (localFile?.name ?? '本地图片');
            const previewLabel = `${rowLabel ?? property.title}：${imageName}`;
            return (
              <div className="url-list-item" key={`${field.key}-${index}`}>
                {rowLabel && <span className="url-row-role">{rowLabel}</span>}
                <div className={`url-row${hasImage ? ' has-image' : ''}`}>
                  {hasImage ? (
                    <div className="local-image-value" id={index === 0 ? inputId : undefined}>
                      {assetId ? (
                        <AssetImagePreview
                          assetId={assetId}
                          projectId={projectId}
                          alt={previewLabel}
                        />
                      ) : (
                        <ImagePreview src={item} alt={previewLabel} />
                      )}
                      <span>
                        <strong title={imageName}>{imageName}</strong>
                        {localFile && <small>{formatBytes(localFile.size)}</small>}
                      </span>
                    </div>
                  ) : (
                    <input
                      id={index === 0 ? inputId : undefined}
                      aria-label={rowLabel ? `${rowLabel} URL` : undefined}
                      type="url"
                      value={item}
                      placeholder={rowLabel ? `输入${rowLabel}公开 URL` : field.placeholder}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = event.target.value;
                        setLocalFiles((current) => {
                          const updated = [...current];
                          updated[index] = undefined;
                          return updated;
                        });
                        commitItems(next);
                      }}
                    />
                  )}
                  <label
                    className="icon-button subtle file-picker-button"
                    htmlFor={fileInputId}
                    title={item ? '替换为本地图片' : '选择本地图片'}
                  >
                    <ImagePlus size={14} />
                    <input
                      id={fileInputId}
                      className="url-file-input"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,.jpg,.jpeg,.png,.webp"
                      aria-label={`为${rowLabel ?? property.title}选择本地图片`}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = '';
                        void chooseLocalFile(file, index);
                      }}
                    />
                  </label>
                  <button
                    className="icon-button subtle"
                    type="button"
                    title="上移"
                    onClick={() => moveItem(index, -1)}
                    disabled={index === 0}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    className="icon-button subtle"
                    type="button"
                    title="下移"
                    onClick={() => moveItem(index, 1)}
                    disabled={index >= items.length - 1}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    className="icon-button subtle"
                    type="button"
                    title={item ? '清除此图片输入' : '移除此输入行'}
                    onClick={() => clearItem(index)}
                    disabled={!item && items.length <= minimumRows}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
          {(property.maxItems === undefined || items.length < property.maxItems) && (
            <button
              className="icon-button subtle"
              type="button"
              title="添加图片输入"
              onClick={() => commitItems([...items, ''])}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {visibleError && <small>{visibleError}</small>}
      </div>
    );
  }

  const enumValues = property.enum ?? [];
  return (
    <div className={`parameter-field ${error ? 'invalid' : ''}`}>
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
        <textarea
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          maxLength={property.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
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
      {error && <small>{error}</small>}
    </div>
  );
}
