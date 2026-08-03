import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  CircleAlert,
  CircleCheck,
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
  ProviderModelInfo,
  ProviderProfileInfo,
  VideoAssetKind,
  VideoGenerationJobInfo,
  VideoGenerationMetadataInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import {
  cancelVideoProviderTask,
  pollVideoProviderTask,
  submitProviderRequest,
  submitVideoProviderTask,
} from './provider-client';
import { VideoPollingScheduler } from './video-polling-scheduler';
import {
  hasLocalImageParameters,
  isLocalImageDataUrl,
  MAX_LOCAL_IMAGE_TOTAL_BYTES,
  readLocalImageFile,
  totalLocalImageBytes,
  type LocalImageSelection,
} from './local-image-input';

interface ProductionPanelProps {
  expanded?: boolean;
  capability?: GenerationCapability;
  projectId?: string;
  projectRootPath?: string;
  shotId?: string;
  writable: boolean;
  assets?: AssetInfo[];
  onAssetsChanged?: (assets: AssetInfo[], selectedAssetId?: string) => void;
  onOpenAssetLibrary?: (assetId?: string) => void;
  onOpenProviderSettings?: () => void;
}

const AUTO_SAVE_STORAGE_KEY = 'ai-video.image-auto-save-local';
const PROVIDER_PROFILE_STORAGE_KEY = 'ai-video.production-provider-profiles';

function initialAutoSaveLocal(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function defaultParameters(adapter: AdapterDescriptor): AdapterParameters {
  return Object.fromEntries(
    Object.entries(adapter.parameterSchema.properties)
      .filter(([, property]) => property.default !== undefined)
      .map(([key, property]) => [key, property.default!]),
  );
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

function isVideoAsset(asset: AssetInfo | undefined): boolean {
  return asset?.kind === 'generated-video' || asset?.kind === 'shot-video';
}

function videoStatusLabel(status: VideoGenerationJobInfo['status']): string {
  const labels: Record<VideoGenerationJobInfo['status'], string> = {
    pending: '正在提交',
    polling: '生成中',
    downloading: '下载中',
    paused: '已暂停',
    succeeded: '已完成',
    failed: '失败',
    'timed-out': '已超时',
    cancelled: '已取消',
  };
  return labels[status];
}

function isVideoCapability(capability: GenerationCapability | undefined): boolean {
  return (
    capability === 'TEXT_TO_VIDEO' ||
    capability === 'IMAGE_TO_VIDEO' ||
    capability === 'REFERENCE_TO_VIDEO' ||
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

function upsertVideoJob(
  jobs: VideoGenerationJobInfo[],
  next: VideoGenerationJobInfo,
): VideoGenerationJobInfo[] {
  const existing = jobs.findIndex((job) => job.id === next.id);
  if (existing < 0) return [next, ...jobs];
  const updated = [...jobs];
  updated[existing] = next;
  return updated;
}

function notifyVideoTerminal(job: VideoGenerationJobInfo): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const title = job.status === 'succeeded' ? '视频生成完成' : '视频任务已结束';
  try {
    new Notification(title, { body: videoStatusLabel(job.status) });
  } catch {
    // The task center remains the durable notification surface when OS notifications are unavailable.
  }
}

function mediaSrcForAbsolutePath(absolutePath: string): string | undefined {
  try {
    return convertFileSrc(absolutePath);
  } catch {
    return undefined;
  }
}

export function ProductionPanel({
  expanded = false,
  capability,
  projectId,
  projectRootPath,
  shotId,
  writable,
  assets: controlledAssets,
  onAssetsChanged,
  onOpenAssetLibrary,
  onOpenProviderSettings,
}: ProductionPanelProps) {
  const [catalog, setCatalog] = useState<AdapterCatalogResult>();
  const [profiles, setProfiles] = useState<ProviderProfileInfo[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [adapterKey, setAdapterKey] = useState('');
  const [adapter, setAdapter] = useState<AdapterDescriptor>();
  const [parameters, setParameters] = useState<AdapterParameters>({});
  const [errors, setErrors] = useState<AdapterValidationError[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const [generationJobId, setGenerationJobId] = useState<string>();
  const [generationStatus, setGenerationStatus] = useState('');
  const [assetKind, setAssetKind] = useState<ImageAssetKind>('generated-image');
  const [videoAssetKind, setVideoAssetKind] = useState<VideoAssetKind>('shot-video');
  const [videoJobs, setVideoJobs] = useState<VideoGenerationJobInfo[]>([]);
  const [localAssets, setLocalAssets] = useState<AssetInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [preview, setPreview] = useState<ImagePreviewInfo>();
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string>();
  const [autoSaveLocal, setAutoSaveLocal] = useState(initialAutoSaveLocal);
  const [savingPreview, setSavingPreview] = useState(false);
  const videoScheduler = useRef<VideoPollingScheduler | undefined>(undefined);
  const onAssetsChangedRef = useRef(onAssetsChanged);
  const controlledAssetsRef = useRef(controlledAssets);
  const currentProjectIdRef = useRef(projectId);
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

  onAssetsChangedRef.current = onAssetsChanged;
  controlledAssetsRef.current = controlledAssets;
  currentProjectIdRef.current = projectId;

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, autoSaveLocal ? 'true' : 'false');
    } catch {
      // Auto-save remains valid for the current session when storage is unavailable.
    }
  }, [autoSaveLocal]);

  useEffect(() => {
    void Promise.all([callWorker('adapter.catalog', {}), callWorker('provider.profile.list', {})])
      .then(([nextCatalog, nextProfiles]) => {
        setCatalog(nextCatalog);
        setProfiles(nextProfiles ?? []);
      })
      .catch((reason) => setMessage(errorMessage(reason, '适配器目录读取失败')));
  }, []);

  const eligibleProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          profile.providerType === 'vidu' &&
          profile.protocol === 'vidu-v2' &&
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
  const providerRegion = selectedProfile?.baseUrl === 'https://api.vidu.cn' ? 'cn' : 'global';

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
    void callWorker('provider.model.list', { profileId: selectedProfileId })
      .then((items) => {
        if (active) setModels(items);
      })
      .catch((reason) => {
        if (active) setMessage(errorMessage(reason, '供应商模型读取失败'));
      });
    return () => {
      active = false;
    };
  }, [selectedProfileId]);

  useEffect(() => {
    const selected = catalog?.adapters.find((item) => item.key === adapterKey);
    if (!selected) {
      setAdapter(undefined);
      setParameters({});
      return;
    }
    let active = true;
    void callWorker('adapter.resolve', {
      capability: selected.capability,
      provider: selected.provider,
      model: selected.model,
      apiVersion: selected.apiVersion,
    })
      .then(async (resolved) => {
        if (!active) return;
        setAdapter(resolved);
        setErrors([]);
        setMessage('');
        const defaults = defaultParameters(resolved);
        setParameters(defaults);
        if (!shotId) {
          return;
        }
        const selectedModel = models.find((model) => model.remoteModelId === resolved.model);
        if (!selectedProfile || !selectedModel) return;
        const draft = await callWorker('generation.draft.get', {
          shotId,
          adapterKey: resolved.key,
          providerProfileId: selectedProfile.id,
          modelId: selectedModel.remoteModelId,
        });
        if (active) setParameters(draft?.parameters ?? defaults);
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
  }, [adapterKey, catalog, models, projectId, selectedProfile, shotId]);

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
    videoScheduler.current?.dispose();
    videoScheduler.current = undefined;
    setVideoJobs([]);
    if (!projectId) return () => undefined;
    let active = true;
    const scheduler = writable
      ? new VideoPollingScheduler({
          poll: (job) =>
            pollVideoProviderTask(
              job.adapterKey,
              job.metadata.providerProfileId,
              job.providerTaskId!,
              job.metadata.providerRegion,
            ),
          observe: (job, response) =>
            callWorker('video.generate.observe', {
              jobId: job.id,
              providerTaskId: job.providerTaskId!,
              providerStatus: response.status,
              providerBody: response.body,
            }),
          timeout: (job) => callWorker('video.generate.timeout', { jobId: job.id }),
          refresh: (job) => callWorker('video.generate.get', { jobId: job.id }),
          onUpdate: (job) => {
            if (!active || job.projectId !== projectId) return;
            setVideoJobs((current) => upsertVideoJob(current, job));
          },
          onTransientError: (job, reason) => {
            if (!active || job.projectId !== projectId) return;
            setGenerationStatus(
              `视频任务查询暂时失败，正在自动重试：${errorMessage(reason, '网络错误')}`,
            );
          },
          onTerminal: (job) => {
            if (!active || job.projectId !== projectId) return;
            setGenerationStatus(job.error ?? `视频任务${videoStatusLabel(job.status)}。`);
            notifyVideoTerminal(job);
            if (job.status === 'succeeded') {
              const assetId = job.results[0]?.asset.id;
              if (assetId) setSelectedAssetId(assetId);
              void callWorker('asset.list', {}).then((items) => {
                if (!active) return;
                if (controlledAssetsRef.current === undefined) setLocalAssets(items);
                onAssetsChangedRef.current?.(items, assetId);
              });
            }
          },
        })
      : undefined;
    videoScheduler.current = scheduler;
    void callWorker('video.generate.list', {})
      .then((jobs) => {
        if (active) setVideoJobs(jobs);
      })
      .catch((reason) => {
        if (active) setGenerationStatus(errorMessage(reason, '视频任务列表读取失败。'));
      });
    return () => {
      active = false;
      scheduler?.dispose();
      if (videoScheduler.current === scheduler) videoScheduler.current = undefined;
    };
  }, [projectId, writable]);

  useEffect(() => {
    videoScheduler.current?.sync(videoJobs);
  }, [videoJobs]);

  useEffect(() => {
    if (!selectedAssetId || isVideoAsset(selectedAsset)) {
      // Keep unsaved generation previews (jobId without assetId) when selection clears or a video is selected.
      setPreview((current) => (current?.jobId && !current.assetId ? current : undefined));
      return;
    }
    let active = true;
    setPreview((current) => (current?.assetId === selectedAssetId ? current : undefined));
    void callWorker('asset.preview', { assetId: selectedAssetId })
      .then((nextPreview) => {
        if (active) setPreview(nextPreview);
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
  const modelOptions = useMemo(
    () =>
      capabilityAdapters.filter((item) =>
        models.some(
          (model) =>
            model.remoteModelId === item.model &&
            model.enabled &&
            !model.unavailableAt &&
            (isVideoCapability(effectiveCapability)
              ? model.capabilities.videoGeneration
              : model.capabilities.imageGeneration),
        ),
      ),
    [capabilityAdapters, effectiveCapability, models],
  );
  const selectedModel = models.find((model) => model.remoteModelId === adapter?.model);

  useEffect(() => {
    const nextAdapterKey = modelOptions.some((item) => item.key === adapterKey)
      ? adapterKey
      : (modelOptions[0]?.key ?? '');
    if (nextAdapterKey !== adapterKey) setAdapterKey(nextAdapterKey);
  }, [adapterKey, modelOptions]);

  const chooseProfile = (profileId: string) => {
    setSelectedProfileId(profileId);
    setModels([]);
    setAdapterKey('');
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
    setParameters((current) => {
      if (value === undefined || value === '') {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: value };
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
    setSavingPreview(true);
    setGenerationStatus('');
    try {
      const saved = await callWorker('image.generate.savePreview', {
        jobId: preview.jobId,
        dataUrl: preview.dataUrl,
        contentType: preview.contentType,
        assetKind,
      });
      const savedAsset = saved.results.find((result) => result.asset)?.asset;
      const nextAssets = await callWorker('asset.list', {});
      publishAssets(nextAssets, savedAsset?.id);
      if (saved.preview) setPreview(saved.preview);
      setGenerationStatus('图片已保存到本地素材库。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '预览保存失败。'));
    } finally {
      setSavingPreview(false);
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
    setBusy(true);
    setMessage('');
    try {
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters,
      });
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
      setMessage(`草稿已保存 · ${new Date(saved.updatedAt).toLocaleTimeString()}`);
    } catch (reason) {
      setMessage(errorMessage(reason, '草稿保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const generateImage = async () => {
    if (!adapter || !selectedProfile || !selectedModel || !writable) return;
    let preparedJobId: string | undefined;
    setBusy(true);
    setGenerationStatus('');
    try {
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters,
      });
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const job = await callWorker('image.generate.prepare', {
        shotId,
        adapterKey: adapter.key,
        parameters,
      });
      preparedJobId = job.id;
      setGenerationJobId(job.id);
      setGenerationStatus('正在请求 Provider...');
      const response = await submitProviderRequest(
        adapter.key,
        parameters,
        selectedProfile.id,
        providerRegion,
      );
      const completed = await callWorker('image.generate.complete', {
        jobId: job.id,
        providerStatus: response.status,
        providerBody: response.body,
        assetKind,
        saveAsset: autoSaveLocal,
      });
      if (completed.status === 'succeeded' && completed.preview) {
        if (!autoSaveLocal) setSelectedAssetId(undefined);
        setPreview(completed.preview);
      }
      const savedAsset = completed.results.find((result) => result.asset)?.asset;
      if (completed.status === 'succeeded' && savedAsset) {
        const nextAssets = await callWorker('asset.list', {});
        publishAssets(nextAssets, savedAsset.id);
        if (completed.preview) setPreview(completed.preview);
      }
      setGenerationStatus(
        completed.status === 'succeeded'
          ? autoSaveLocal
            ? '图片已保存到本地素材库。'
            : '图片已生成，仅预览，未保存到素材库。'
          : completed.status === 'cancelled'
            ? '已取消图片生成。'
            : (completed.error ?? '生成失败。'),
      );
    } catch (reason) {
      if (preparedJobId) {
        try {
          await callWorker('image.generate.fail', { jobId: preparedJobId });
        } catch {
          // Project close/restart recovery owns terminalization when the Worker is unavailable.
        }
      }
      setGenerationStatus(errorMessage(reason, '图片生成失败。'));
    } finally {
      setGenerationJobId(undefined);
      setBusy(false);
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
    let preparedJobId: string | undefined;
    const submissionProjectId = projectId;
    setBusy(true);
    setGenerationStatus('');
    try {
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters,
      });
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const prepared = await callWorker('video.generate.prepare', {
        shotId,
        adapterKey: adapter.key,
        parameters,
        providerRegion,
        providerProfileId: selectedProfile.id,
        modelId: selectedModel.remoteModelId,
        assetKind: videoAssetKind,
      });
      if (currentProjectIdRef.current !== submissionProjectId) return;
      preparedJobId = prepared.id;
      setVideoJobs((current) => upsertVideoJob(current, prepared));
      setGenerationStatus('正在提交视频任务...');
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => undefined);
      }
      const response = await submitVideoProviderTask(
        adapter.key,
        parameters,
        selectedProfile.id,
        providerRegion,
      );
      if (currentProjectIdRef.current !== submissionProjectId) return;
      if (response.status < 200 || response.status >= 300 || !response.taskId) {
        const failed = await callWorker('video.generate.fail', {
          jobId: prepared.id,
          failureKind: 'provider',
          message: `Provider 视频任务提交失败，HTTP ${response.status}。`,
        });
        setVideoJobs((current) => upsertVideoJob(current, failed));
        setGenerationStatus(failed.error ?? '视频任务提交失败。');
        return;
      }
      const attached = await callWorker('video.generate.attachTask', {
        jobId: prepared.id,
        providerTaskId: response.taskId,
      });
      if (currentProjectIdRef.current !== submissionProjectId) return;
      setVideoJobs((current) => upsertVideoJob(current, attached));
      setGenerationStatus('视频任务已提交，正在本地查询。');
    } catch (reason) {
      if (preparedJobId && currentProjectIdRef.current === submissionProjectId) {
        try {
          const failed = await callWorker('video.generate.fail', {
            jobId: preparedJobId,
            failureKind: 'transport',
            message: errorMessage(reason, '视频任务提交传输失败。'),
          });
          setVideoJobs((current) => upsertVideoJob(current, failed));
        } catch {
          // Restart recovery terminalizes an unsubmitted job when the Worker is unavailable.
        }
      }
      if (currentProjectIdRef.current === submissionProjectId) {
        setGenerationStatus(errorMessage(reason, '视频任务提交失败。'));
      }
    } finally {
      setBusy(false);
    }
  };

  const pauseVideo = async (job: VideoGenerationJobInfo) => {
    try {
      const paused = await callWorker('video.generate.pause', { jobId: job.id });
      setVideoJobs((current) => upsertVideoJob(current, paused));
      setGenerationStatus('视频任务轮询已暂停。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '暂停视频任务失败。'));
    }
  };

  const resumeVideo = async (job: VideoGenerationJobInfo) => {
    try {
      const resumed = await callWorker('video.generate.resume', { jobId: job.id });
      setVideoJobs((current) => upsertVideoJob(current, resumed));
      setGenerationStatus('视频任务已继续查询。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '继续视频任务失败。'));
    }
  };

  const cancelVideo = async (job: VideoGenerationJobInfo) => {
    try {
      const cancelled = await callWorker('video.generate.cancel', { jobId: job.id });
      setVideoJobs((current) => upsertVideoJob(current, cancelled));
      if (job.providerTaskId) {
        void cancelVideoProviderTask(
          job.adapterKey,
          job.metadata.providerProfileId,
          job.providerTaskId,
          job.metadata.providerRegion,
        ).catch(() => undefined);
      }
      setGenerationStatus('视频任务已取消，本地轮询已停止。');
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
    try {
      await callWorker('image.generate.cancel', { jobId: generationJobId });
      setGenerationStatus('已取消图片生成。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '取消失败。'));
    }
  };

  const fields: AdapterUiField[] = [...(adapter?.uiSchema.fields ?? [])].sort(
    (a, b) => a.order - b.order,
  );
  const basicFields = fields.filter((field) => field.group === 'basic');
  const advancedFields = fields.filter((field) => field.group === 'advanced');

  const draftSaveHint = !writable
    ? '当前项目为只读'
    : !shotId
      ? '请先选择镜头'
      : !selectedProfile || !selectedModel
        ? '请先选择供应商连接和模型'
        : undefined;

  return (
    <aside className={`production-panel panel-border${expanded ? ' expanded' : ''}`}>
      <div className="panel-heading">
        <span>生产参数</span>
        {adapter && <small>Schema {adapter.schemaVersion}</small>}
      </div>
      {!catalog ? (
        <div className="parameter-placeholder">正在读取适配器目录</div>
      ) : (
        <div className="production-panel-body">
          <div className="production-panel-main">
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
                      {profile.baseUrl === 'https://api.vidu.cn' ? '中国站' : '国际站'}
                    </option>
                  ))}
                </select>
              </div>
              {eligibleProfiles.length > 0 && (
                <div className="field-group">
                  <label htmlFor="model">模型</label>
                  <select
                    id="model"
                    value={adapterKey}
                    onChange={(event) => setAdapterKey(event.target.value)}
                    disabled={modelOptions.length === 0 || busy}
                  >
                    {modelOptions.length === 0 && <option value="">没有已启用的兼容模型</option>}
                    {modelOptions.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.modelLabel}
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
                <span>请在设置中心添加并测试 Vidu 中国站或国际站连接。</span>
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
                        />
                      ))}
                    </div>
                  </details>
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
                        disabled={!writable || busy || !selectedProfile || !selectedModel}
                      >
                        <Video size={14} />
                        提交视频任务
                      </button>
                    ) : (
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void generateImage()}
                        disabled={!writable || busy || !selectedProfile || !selectedModel}
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
                          value={videoAssetKind}
                          onChange={(event) =>
                            setVideoAssetKind(event.target.value as VideoAssetKind)
                          }
                          disabled={busy}
                        >
                          <option value="shot-video">镜头视频</option>
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
                        <label className="auto-save-toggle">
                          <input
                            type="checkbox"
                            checked={autoSaveLocal}
                            onChange={(event) => setAutoSaveLocal(event.target.checked)}
                            disabled={busy}
                          />
                          自动保存到本地素材库
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
                            <strong>{videoStatusLabel(job.status)}</strong>
                            <span>{formatElapsed(job.elapsedMs)}</span>
                            <small>
                              {formatVideoCost(job.metadata.cost)}
                              {' · '}
                              查询 {job.metadata.pollAttempts} 次
                            </small>
                            {job.error && <small className="error-copy">{job.error}</small>}
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
                                className="icon-button subtle"
                                type="button"
                                title="预览结果"
                                onClick={() => setSelectedAssetId(resultAsset.id)}
                              >
                                <Eye size={13} />
                              </button>
                            )}
                            {resultAsset && (
                              <button
                                className="icon-button subtle"
                                type="button"
                                title="播放视频"
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
                    <img
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
              <div className="asset-list" aria-label="素材列表">
                {assets.map((asset) => (
                  <div
                    className={`asset-row${asset.id === selectedAssetId ? ' selected' : ''}`}
                    key={asset.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedAssetId(asset.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setSelectedAssetId(asset.id);
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
}

function ParameterField({
  field,
  property,
  value,
  required,
  error,
  onChange,
}: ParameterFieldProps) {
  const inputId = `parameter-${field.key}`;
  const [localFiles, setLocalFiles] = useState<Array<LocalImageSelection | undefined>>([]);
  const [selectionError, setSelectionError] = useState('');
  const label = (
    <label htmlFor={inputId}>
      {property.title}
      {required && <span aria-label="必填">*</span>}
    </label>
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
        {error && <small>{error}</small>}
      </div>
    );
  }

  if (field.control === 'url-list') {
    const minimumRows = Math.max(1, property.minItems ?? 1);
    const currentItems = Array.isArray(value) ? value : [];
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
    const visibleError = selectionError || error;
    return (
      <div className={`parameter-field ${visibleError ? 'invalid' : ''}`}>
        {label}
        <div className="url-list">
          {items.map((item, index) => {
            const selectedFile = localFiles[index];
            const localFile = selectedFile?.dataUrl === item ? selectedFile : undefined;
            const orderedRole = property.minItems === 2 && property.maxItems === 2;
            const rowLabel = orderedRole ? (index === 0 ? '首帧' : '尾帧') : undefined;
            const fileInputId = `${inputId}-file-${index}`;
            return (
              <div className="url-list-item" key={`${field.key}-${index}`}>
                {rowLabel && <span className="url-row-role">{rowLabel}</span>}
                <div className="url-row">
                  {isLocalImageDataUrl(item) ? (
                    <div className="local-image-value" id={index === 0 ? inputId : undefined}>
                      <img src={item} alt="" />
                      <span>
                        <strong>{localFile?.name ?? '本地图片'}</strong>
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
      {field.control === 'select' ? (
        <select
          id={inputId}
          value={value === undefined ? '' : String(value)}
          onChange={(event) =>
            onChange(property.type === 'integer' ? Number(event.target.value) : event.target.value)
          }
        >
          {enumValues.map((item) => (
            <option key={String(item)} value={String(item)}>
              {String(item)}
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
