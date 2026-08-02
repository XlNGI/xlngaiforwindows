import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Eye,
  FolderOpen,
  ImagePlus,
  KeyRound,
  Pause,
  Play,
  Plus,
  Save,
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
  VideoAssetKind,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import {
  canUseSecureCredentials,
  deleteCredential,
  getCredentialStatus,
  setCredential,
  type CredentialStatus,
} from './credential-client';
import { callWorker } from './worker-client';
import {
  cancelVideoProviderTask,
  pollVideoProviderTask,
  submitProviderRequest,
  submitVideoProviderTask,
  type ProviderRegion,
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
  projectId?: string;
  projectRootPath?: string;
  shotId?: string;
  writable: boolean;
  assets?: AssetInfo[];
  onAssetsChanged?: (assets: AssetInfo[], selectedAssetId?: string) => void;
  onOpenAssetLibrary?: (assetId?: string) => void;
}

const PROVIDER_REGION_STORAGE_KEY = 'ai-video.vidu-provider-region';
const AUTO_SAVE_STORAGE_KEY = 'ai-video.image-auto-save-local';

function initialProviderRegion(): ProviderRegion {
  try {
    const stored = window.localStorage.getItem(PROVIDER_REGION_STORAGE_KEY);
    if (stored === 'global' || stored === 'cn') return stored;
  } catch {
    // The native WebView normally exposes localStorage; use the domestic default if it does not.
  }
  return 'cn';
}

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

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
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

export function ProductionPanel({
  projectId,
  projectRootPath,
  shotId,
  writable,
  assets: controlledAssets,
  onAssetsChanged,
  onOpenAssetLibrary,
}: ProductionPanelProps) {
  const [catalog, setCatalog] = useState<AdapterCatalogResult>();
  const [capability, setCapability] = useState<GenerationCapability>();
  const [provider, setProvider] = useState('');
  const [providerRegion, setProviderRegion] = useState<ProviderRegion>(initialProviderRegion);
  const [adapterKey, setAdapterKey] = useState('');
  const [adapter, setAdapter] = useState<AdapterDescriptor>();
  const [parameters, setParameters] = useState<AdapterParameters>({});
  const [errors, setErrors] = useState<AdapterValidationError[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const [credential, setCredentialState] = useState<CredentialStatus>();
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialMessage, setCredentialMessage] = useState('');
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [generationJobId, setGenerationJobId] = useState<string>();
  const [generationStatus, setGenerationStatus] = useState('');
  const [assetKind, setAssetKind] = useState<ImageAssetKind>('generated-image');
  const [videoAssetKind, setVideoAssetKind] = useState<VideoAssetKind>('shot-video');
  const [videoJobs, setVideoJobs] = useState<VideoGenerationJobInfo[]>([]);
  const [localAssets, setLocalAssets] = useState<AssetInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [preview, setPreview] = useState<ImagePreviewInfo>();
  const [autoSaveLocal, setAutoSaveLocal] = useState(initialAutoSaveLocal);
  const [savingPreview, setSavingPreview] = useState(false);
  const videoScheduler = useRef<VideoPollingScheduler | undefined>(undefined);
  const onAssetsChangedRef = useRef(onAssetsChanged);
  const controlledAssetsRef = useRef(controlledAssets);
  const currentProjectIdRef = useRef(projectId);
  const assets = controlledAssets ?? localAssets;
  const selectedAsset = assets.find((item) => item.id === selectedAssetId);
  const selectedImageAsset = isVideoAsset(selectedAsset) ? undefined : selectedAsset;

  onAssetsChangedRef.current = onAssetsChanged;
  controlledAssetsRef.current = controlledAssets;
  currentProjectIdRef.current = projectId;

  const credentialProvider =
    adapter?.provider === 'vidu' && providerRegion === 'cn'
      ? `${adapter.credentialProvider}-cn`
      : adapter?.credentialProvider;

  useEffect(() => {
    try {
      window.localStorage.setItem(PROVIDER_REGION_STORAGE_KEY, providerRegion);
    } catch {
      // Region remains valid for the current session when storage is unavailable.
    }
  }, [providerRegion]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, autoSaveLocal ? 'true' : 'false');
    } catch {
      // Auto-save remains valid for the current session when storage is unavailable.
    }
  }, [autoSaveLocal]);

  useEffect(() => {
    void callWorker('adapter.catalog', {})
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        const first = nextCatalog.adapters[0];
        if (first) {
          setCapability(first.capability);
          setProvider(first.provider);
          setAdapterKey(first.key);
        }
      })
      .catch((reason) => setMessage(errorMessage(reason, '适配器目录读取失败')));
  }, []);

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
        const draft = await callWorker('generation.draft.get', {
          shotId,
          adapterKey: resolved.key,
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
  }, [adapterKey, catalog, projectId, shotId]);

  useEffect(() => {
    setCredentialState(undefined);
    setCredentialMessage('');
    if (!credentialProvider || !canUseSecureCredentials()) return;
    void getCredentialStatus(credentialProvider)
      .then(setCredentialState)
      .catch((reason) => setCredentialMessage(errorMessage(reason, '凭据状态读取失败')));
  }, [credentialProvider]);

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
            pollVideoProviderTask(job.adapterKey, job.metadata.providerRegion, job.providerTaskId!),
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
    setPreview(undefined);
    if (!selectedAssetId || isVideoAsset(selectedAsset)) return;
    let active = true;
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

  const capabilityAdapters = useMemo(
    () => catalog?.adapters.filter((item) => item.capability === capability) ?? [],
    [catalog, capability],
  );
  const providerOptions = useMemo(
    () => uniqueBy(capabilityAdapters, (item) => item.provider),
    [capabilityAdapters],
  );
  const modelOptions = useMemo(
    () => capabilityAdapters.filter((item) => item.provider === provider),
    [capabilityAdapters, provider],
  );

  const chooseCapability = (next: GenerationCapability) => {
    const first = catalog?.adapters.find((item) => item.capability === next);
    setCapability(next);
    setProvider(first?.provider ?? '');
    setAdapterKey(first?.key ?? '');
  };

  const chooseProvider = (next: string) => {
    const first = capabilityAdapters.find((item) => item.provider === next);
    setProvider(next);
    setAdapterKey(first?.key ?? '');
  };

  const chooseProviderRegion = (next: ProviderRegion) => {
    setProviderRegion(next);
    setCredentialState(undefined);
    setCredentialSecret('');
    setCredentialMessage('');
    setGenerationStatus('');
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
    if (!adapter || !shotId) return;
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
        parameters,
      });
      setMessage(`草稿已保存 · ${new Date(saved.updatedAt).toLocaleTimeString()}`);
    } catch (reason) {
      setMessage(errorMessage(reason, '草稿保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const saveCredential = async () => {
    if (!adapter || !credentialProvider || !credentialSecret) return;
    setCredentialBusy(true);
    setCredentialMessage('');
    try {
      setCredentialState(await setCredential(credentialProvider, credentialSecret));
      setCredentialSecret('');
      setCredentialMessage('凭据已保存到 Windows 凭据管理器');
    } catch (reason) {
      setCredentialMessage(errorMessage(reason, '凭据保存失败'));
    } finally {
      setCredentialBusy(false);
    }
  };

  const generateImage = async () => {
    if (!adapter || !writable) return;
    if (canUseSecureCredentials() && credential?.configured !== true) {
      setGenerationStatus(
        credential
          ? '请先为当前 Vidu 服务区域保存 API Key。'
          : '正在读取当前 Vidu 服务区域的凭据状态，请稍后重试。',
      );
      return;
    }
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
      const response = await submitProviderRequest(adapter.key, parameters, providerRegion);
      const completed = await callWorker('image.generate.complete', {
        jobId: job.id,
        providerStatus: response.status,
        providerBody: response.body,
        assetKind,
        saveAsset: autoSaveLocal,
      });
      if (completed.preview) {
        if (!autoSaveLocal) setSelectedAssetId(undefined);
        setPreview(completed.preview);
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
      const savedAsset = completed.results.find((result) => result.asset)?.asset;
      if (completed.status === 'succeeded' && savedAsset) {
        const nextAssets = await callWorker('asset.list', {});
        publishAssets(nextAssets, savedAsset.id);
      }
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
    if (!adapter || !isVideoCapability(adapter.capability) || !writable) return;
    if (canUseSecureCredentials() && credential?.configured !== true) {
      setGenerationStatus(
        credential
          ? '请先为当前 Vidu 服务区域保存 API Key。'
          : '正在读取当前 Vidu 服务区域的凭据状态，请稍后重试。',
      );
      return;
    }
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
        assetKind: videoAssetKind,
      });
      if (currentProjectIdRef.current !== submissionProjectId) return;
      preparedJobId = prepared.id;
      setVideoJobs((current) => upsertVideoJob(current, prepared));
      setGenerationStatus('正在提交视频任务...');
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => undefined);
      }
      const response = await submitVideoProviderTask(adapter.key, parameters, providerRegion);
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
          job.metadata.providerRegion,
          job.providerTaskId,
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

  const removeCredential = async () => {
    if (!credentialProvider) return;
    if (!adapter || !window.confirm('删除此供应商的本机凭据？')) return;
    setCredentialBusy(true);
    setCredentialMessage('');
    try {
      setCredentialState(await deleteCredential(credentialProvider));
      setCredentialMessage('凭据已删除');
    } catch (reason) {
      setCredentialMessage(errorMessage(reason, '凭据删除失败'));
    } finally {
      setCredentialBusy(false);
    }
  };

  const fields: AdapterUiField[] = [...(adapter?.uiSchema.fields ?? [])].sort(
    (a, b) => a.order - b.order,
  );
  const basicFields = fields.filter((field) => field.group === 'basic');
  const advancedFields = fields.filter((field) => field.group === 'advanced');

  return (
    <aside className="production-panel panel-border">
      <div className="panel-heading">
        <span>生产参数</span>
        {adapter && <small>Schema {adapter.schemaVersion}</small>}
      </div>
      {!catalog ? (
        <div className="parameter-placeholder">正在读取适配器目录</div>
      ) : (
        <>
          <div className="field-group">
            <label htmlFor="capability">生产方式</label>
            <select
              id="capability"
              value={capability ?? ''}
              onChange={(event) => chooseCapability(event.target.value as GenerationCapability)}
            >
              {catalog.capabilities.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="provider">供应商</label>
            <select
              id="provider"
              value={provider}
              onChange={(event) => chooseProvider(event.target.value)}
            >
              {providerOptions.map((item) => (
                <option key={item.provider} value={item.provider}>
                  {item.providerLabel}
                </option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="model">模型</label>
            <select
              id="model"
              value={adapterKey}
              onChange={(event) => setAdapterKey(event.target.value)}
            >
              {modelOptions.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.modelLabel} · {item.apiVersion}
                </option>
              ))}
            </select>
          </div>

          {provider === 'vidu' && (
            <div className="field-group">
              <label htmlFor="provider-region">Vidu 服务区域</label>
              <select
                id="provider-region"
                value={providerRegion}
                onChange={(event) => chooseProviderRegion(event.target.value as ProviderRegion)}
                disabled={busy || credentialBusy}
              >
                <option value="cn">中国站 (api.vidu.cn)</option>
                <option value="global">国际站 (api.vidu.com)</option>
              </select>
            </div>
          )}

          {adapter && (
            <>
              <div className="adapter-meta">
                <strong>{adapter.modelLabel}</strong>
                <span>
                  {adapter.providerLabel} · API {adapter.apiVersion}
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
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={!writable || !shotId || busy}
                >
                  <Save size={14} />
                  保存草稿
                </button>
                {message && (
                  <span className={errors.length > 0 ? 'validation-error' : 'validation-ok'}>
                    {errors.length > 0 ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
                    {message}
                  </span>
                )}
                {isVideoCapability(adapter.capability) ? (
                  <>
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => void generateVideo()}
                      disabled={!writable || busy}
                    >
                      <Video size={14} />
                      提交视频任务
                    </button>
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
                  </>
                ) : (
                  <>
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => void generateImage()}
                      disabled={!writable || busy}
                    >
                      <WandSparkles size={14} />
                      生成图片
                    </button>
                    {generationJobId && busy && (
                      <button
                        className="icon-button danger"
                        type="button"
                        title="取消生成"
                        onClick={() => void cancelImage()}
                      >
                        <Square size={13} />
                      </button>
                    )}
                    <label className="asset-kind-field">
                      保存为
                      <select
                        value={assetKind}
                        onChange={(event) => setAssetKind(event.target.value as typeof assetKind)}
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
                {generationStatus && <span className="credential-message">{generationStatus}</span>}
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
                            {job.metadata.cost
                              ? `${job.metadata.cost.amount} ${job.metadata.cost.unit}`
                              : '费用未返回'}
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
                          {['pending', 'polling', 'downloading', 'paused'].includes(job.status) && (
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
                  {videoJobs.length === 0 && <span className="video-task-empty">暂无视频任务</span>}
                </section>
              )}
              {(preview || selectedImageAsset) && (
                <div className="asset-preview-card" aria-label="图片预览">
                  <div className="asset-preview-frame">
                    {preview ? (
                      <img
                        src={preview.dataUrl}
                        alt={selectedImageAsset?.relativePath ?? '生成图片预览'}
                      />
                    ) : (
                      <span>正在读取预览</span>
                    )}
                  </div>
                  <div className="asset-preview-meta">
                    <strong>{selectedImageAsset?.relativePath ?? '本次生成预览'}</strong>
                    {selectedImageAsset && <small>{localAssetPath(selectedImageAsset)}</small>}
                  </div>
                  {selectedImageAsset && (
                    <div className="asset-actions">
                      <button
                        className="button"
                        type="button"
                        onClick={() => void revealAsset(selectedImageAsset)}
                      >
                        <FolderOpen size={14} />
                        打开位置
                      </button>
                      <button
                        className="button"
                        type="button"
                        onClick={() => onOpenAssetLibrary?.(selectedImageAsset.id)}
                      >
                        <Eye size={14} />
                        查看素材库
                      </button>
                    </div>
                  )}
                  {preview?.jobId && !preview.assetId && !selectedImageAsset && (
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
              )}

              <details className="credential-section">
                <summary>
                  <KeyRound size={14} />
                  供应商凭据
                  <span className={credential?.configured ? 'configured' : ''}>
                    {credential?.configured ? '已配置' : '未配置'}
                  </span>
                </summary>
                <div className="credential-controls">
                  <input
                    type="password"
                    value={credentialSecret}
                    onChange={(event) => setCredentialSecret(event.target.value)}
                    placeholder={`${adapter.providerLabel} API Key`}
                    autoComplete="new-password"
                    disabled={!canUseSecureCredentials() || credentialBusy}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    title="保存凭据"
                    onClick={() => void saveCredential()}
                    disabled={!credentialSecret || !canUseSecureCredentials() || credentialBusy}
                  >
                    <Save size={15} />
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    title="删除凭据"
                    onClick={() => void removeCredential()}
                    disabled={!credential?.configured || credentialBusy}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {credentialMessage && (
                  <span className="credential-message">{credentialMessage}</span>
                )}
              </details>
            </>
          )}
        </>
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
