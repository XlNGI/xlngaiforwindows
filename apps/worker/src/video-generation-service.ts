import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, extname, join } from 'node:path';
import type {
  AdapterParameters,
  AssetInfo,
  VideoAssetKind,
  VideoGenerationAttachTaskParams,
  VideoGenerationFailParams,
  VideoGenerationFailureKind,
  VideoGenerationJobInfo,
  VideoGenerationMetadataInfo,
  VideoGenerationObserveParams,
  VideoGenerationPrepareParams,
  VideoProviderRegion,
} from '@ai-video/contracts';
import type { AssetRecord, GenerationResultRecord, JobRecord } from '@ai-video/domain';
import { getAdapter, validateAdapterParameters } from '@ai-video/generation-adapters';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { assertStorageCapacity } from './storage-capacity.js';
import { multiplyDecimalStrings } from './usage-cost.js';

const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const OFF_PEAK_POLL_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const PROVIDER_TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const ACTIVE_STATES = new Set([
  'created',
  'queueing',
  'queued',
  'processing',
  'running',
  'pending',
]);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed-out', 'cancelled']);
const VIDEO_CAPABILITIES = new Set([
  'TEXT_TO_VIDEO',
  'IMAGE_TO_VIDEO',
  'REFERENCE_TO_VIDEO',
  'START_END_TO_VIDEO',
]);

interface VideoJobMetadata extends VideoGenerationMetadataInfo {
  assetKind: VideoAssetKind;
  pricingSnapshot?: CreditPricingSnapshot;
  pausedAt?: string;
}

interface CreditPricingSnapshot {
  currency: string;
  creditPrice: string;
}

export interface VideoCreditPricingResolver {
  resolveCreditPricing(
    providerProfileId: string,
    modelId: string,
  ): CreditPricingSnapshot | undefined;
}

interface DownloadedVideo {
  temporaryPath: string;
  extension: string;
  contentHash: string;
  sizeBytes: number;
}

type StorageCapacityCheck = (directoryPath: string, requiredBytes: number) => void;

export class VideoGenerationService {
  private readonly downloads = new Map<string, AbortController>();

  constructor(
    private readonly projects: ProjectService,
    private readonly storageCapacityCheck: StorageCapacityCheck = assertStorageCapacity,
    private readonly pricingResolver?: VideoCreditPricingResolver,
  ) {}

  prepare(params: VideoGenerationPrepareParams): VideoGenerationJobInfo {
    const adapter = getAdapter(params.adapterKey);
    if (!adapter || !VIDEO_CAPABILITIES.has(adapter.capability)) {
      throw new Error('Video generation adapter was not found.');
    }
    const validation = validateAdapterParameters(params.adapterKey, params.parameters);
    if (!validation.valid) throw new Error('Video generation parameters are invalid.');
    const assetKind = params.assetKind ?? 'shot-video';
    if (assetKind !== 'generated-video' && assetKind !== 'shot-video') {
      throw new Error('Video asset kind is invalid.');
    }
    const providerRegion = requireProviderRegion(params.providerRegion);
    const providerProfileId = params.providerProfileId
      ? requireProviderProfileId(params.providerProfileId)
      : undefined;
    const modelId = params.modelId ? requireModelId(params.modelId) : undefined;
    if (Boolean(providerProfileId) !== Boolean(modelId)) {
      throw new Error('Provider profile and model must be supplied together.');
    }
    const pricingSnapshot =
      providerProfileId && modelId
        ? this.pricingResolver?.resolveCreditPricing(providerProfileId, modelId)
        : undefined;

    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      if (params.shotId) {
        const shot = repositories.shots.get(params.shotId);
        const scene = shot ? repositories.scenes.get(shot.sceneId) : undefined;
        if (!shot || !scene || scene.projectId !== project.id) {
          throw new Error('Shot was not found.');
        }
      }
      const now = new Date().toISOString();
      const record: JobRecord = {
        id: randomUUID(),
        projectId: project.id,
        shotId: params.shotId,
        adapterKey: params.adapterKey,
        status: 'pending',
        requestJson: JSON.stringify(cloneParameters(params.parameters)),
        metadataJson: JSON.stringify({
          assetKind,
          providerRegion,
          providerProfileId,
          modelId,
          pricingSnapshot,
          pollAttempts: 0,
        } satisfies VideoJobMetadata),
        createdAt: now,
        updatedAt: now,
      };
      repositories.jobs.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.toInfo(record, [], []);
    });
  }

  attachTask(params: VideoGenerationAttachTaskParams): VideoGenerationJobInfo {
    const providerTaskId = requireProviderTaskId(params.providerTaskId);
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(params.jobId);
      this.requireVideoJob(job, project.id);
      if (TERMINAL_STATUSES.has(job.status)) return this.infoFromRepositories(job);
      if (job.providerTaskId) {
        if (job.providerTaskId !== providerTaskId) {
          throw new Error('Generation job is already bound to another provider task.');
        }
        if (job.status === 'polling' || job.status === 'paused') {
          return this.infoFromRepositories(job);
        }
      }
      if (job.status !== 'pending')
        throw new Error('Generation job cannot attach a provider task.');

      const now = new Date().toISOString();
      const request = JSON.parse(job.requestJson) as AdapterParameters;
      const timeoutMs =
        request.off_peak === true ? OFF_PEAK_POLL_TIMEOUT_MS : DEFAULT_POLL_TIMEOUT_MS;
      const metadata = this.metadata(job);
      const attached: JobRecord = {
        ...job,
        providerTaskId,
        status: 'polling',
        metadataJson: JSON.stringify({
          ...metadata,
          providerState: 'submitted',
          pollDeadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
        } satisfies VideoJobMetadata),
        updatedAt: now,
      };
      database.transaction(() => {
        repositories.jobs.save(attached);
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return this.toInfo(attached, [], []);
    });
  }

  observe(params: VideoGenerationObserveParams): VideoGenerationJobInfo {
    const providerTaskId = requireProviderTaskId(params.providerTaskId);
    const projectSession = this.projects.current();
    if (!projectSession) throw new Error('No project is open.');
    const job = this.projects.access(false, (database, project) => {
      if (project !== projectSession)
        throw new Error('Project session changed during video polling.');
      const found = createRepositories(database).jobs.get(params.jobId);
      this.requireVideoJob(found, project.id);
      if (found.providerTaskId !== providerTaskId) {
        throw new Error('Provider task does not belong to the generation job.');
      }
      return found;
    });
    if (job.status !== 'polling') return this.get(job.id);

    const metadata = observedMetadata(this.metadata(job), params.providerBody);
    if (params.providerStatus === 429 || params.providerStatus >= 500) {
      return this.persistObservation(job.id, providerTaskId, {
        ...metadata,
        providerState: `retryable-http-${params.providerStatus}`,
      });
    }
    if (params.providerStatus < 200 || params.providerStatus >= 300) {
      return this.transitionFailure(
        job.id,
        'provider',
        `Provider polling failed with HTTP ${params.providerStatus}.`,
        metadata,
      );
    }

    const state = providerState(params.providerBody);
    if (state && ACTIVE_STATES.has(state)) {
      return this.persistObservation(job.id, providerTaskId, { ...metadata, providerState: state });
    }
    if (state === 'failed' || state === 'error') {
      return this.transitionFailure(
        job.id,
        'provider',
        providerFailureMessage(params.providerBody),
        { ...metadata, providerState: state },
      );
    }
    if (state !== 'success' && state !== 'succeeded' && state !== 'completed') {
      return this.transitionFailure(
        job.id,
        'provider',
        state
          ? `Provider returned unsupported video task state: ${state}.`
          : 'Provider polling response did not contain a supported task state.',
        metadata,
      );
    }

    let source: string;
    try {
      source = extractVideoSource(params.providerBody);
    } catch (error) {
      return this.transitionFailure(
        job.id,
        'provider',
        error instanceof Error ? error.message : 'Provider returned no video output.',
        { ...metadata, providerState: state },
      );
    }
    const completedMetadata = {
      ...metadata,
      providerState: state,
    };
    const downloading = this.transitionToDownloading(job.id, providerTaskId, completedMetadata);
    this.startDownload(projectSession, job, providerTaskId, source, completedMetadata);
    return downloading;
  }

  fail(params: VideoGenerationFailParams): VideoGenerationJobInfo {
    return this.transitionFailure(
      params.jobId,
      params.failureKind,
      params.message ?? failureMessage(params.failureKind),
    );
  }

  pause(jobId: string): VideoGenerationJobInfo {
    return this.transitionActive(jobId, 'paused', (metadata, now) => ({
      ...metadata,
      pausedAt: now,
    }));
  }

  resume(jobId: string): VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (job.status !== 'paused') return this.infoFromRepositories(job);
      if (!job.providerTaskId) throw new Error('Paused video job has no provider task.');
      const now = new Date().toISOString();
      const metadata = this.metadata(job);
      const pausedAt = metadata.pausedAt ? Date.parse(metadata.pausedAt) : Date.now();
      const deadline = metadata.pollDeadlineAt ? Date.parse(metadata.pollDeadlineAt) : Date.now();
      const pausedDuration = Math.max(0, Date.now() - pausedAt);
      const resumed: JobRecord = {
        ...job,
        status: 'polling',
        metadataJson: JSON.stringify({
          ...metadata,
          pausedAt: undefined,
          pollDeadlineAt: new Date(deadline + pausedDuration).toISOString(),
        } satisfies VideoJobMetadata),
        updatedAt: now,
      };
      repositories.jobs.save(resumed);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.infoFromRepositories(resumed);
    });
  }

  timeout(jobId: string): VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (job.status !== 'polling') return this.infoFromRepositories(job);
      const metadata = this.metadata(job);
      const deadline = metadata.pollDeadlineAt ? Date.parse(metadata.pollDeadlineAt) : 0;
      if (Number.isFinite(deadline) && deadline > Date.now()) {
        throw new Error('Video generation deadline has not elapsed.');
      }
      return this.transitionFailure(
        job.id,
        'timeout',
        'Video generation timed out before Provider completion.',
        metadata,
        'timed-out',
      );
    });
  }

  cancel(jobId: string): VideoGenerationJobInfo {
    this.downloads.get(jobId)?.abort();
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (!['pending', 'polling', 'downloading', 'paused'].includes(job.status)) {
        return this.infoFromRepositories(job);
      }
      const now = new Date().toISOString();
      const cancelled = { ...job, status: 'cancelled', errorJson: undefined, updatedAt: now };
      repositories.jobs.save(cancelled);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.infoFromRepositories(cancelled);
    });
  }

  cancelAll(): void {
    for (const controller of this.downloads.values()) controller.abort();
    this.downloads.clear();
  }

  get(jobId: string): VideoGenerationJobInfo {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      return this.infoFromRepositories(job);
    });
  }

  list(): VideoGenerationJobInfo[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const assets = repositories.assets.listByProject(project.id);
      return repositories.jobs
        .listByProject(project.id)
        .filter((job) => VIDEO_CAPABILITIES.has(getAdapter(job.adapterKey)?.capability ?? ''))
        .map((job) => this.toInfo(job, assets, repositories.generationResults.listByJob(job.id)))
        .reverse();
    });
  }

  recoverInterrupted(): number {
    const current = this.projects.current();
    if (!current || current.mode !== 'read-write') return 0;
    return this.projects.access(true, (database, project) => {
      cleanupVideoTemporaryFiles(project.rootPath);
      const repositories = createRepositories(database);
      const jobs = repositories.jobs
        .listByProject(project.id)
        .filter((job) => VIDEO_CAPABILITIES.has(getAdapter(job.adapterKey)?.capability ?? ''));
      const interrupted = jobs.filter(
        (job) =>
          job.status === 'pending' ||
          job.status === 'running' ||
          job.status === 'downloading' ||
          (job.status === 'polling' && !job.providerTaskId),
      );
      if (interrupted.length === 0) return 0;
      const now = new Date().toISOString();
      database.transaction(() => {
        for (const job of interrupted) {
          if (job.providerTaskId) {
            repositories.jobs.save({ ...job, status: 'polling', updatedAt: now });
          } else {
            const metadata = this.metadata(job);
            repositories.jobs.save({
              ...job,
              status: 'failed',
              errorJson: JSON.stringify({
                message: 'Video submission was interrupted before a provider task was recorded.',
              }),
              metadataJson: JSON.stringify({
                ...metadata,
                failureKind: 'interrupted',
              } satisfies VideoJobMetadata),
              updatedAt: now,
            });
          }
        }
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return interrupted.length;
    });
  }

  private persistObservation(
    jobId: string,
    providerTaskId: string,
    metadata: VideoJobMetadata,
  ): VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (job.status !== 'polling') return this.infoFromRepositories(job);
      if (job.providerTaskId !== providerTaskId) {
        throw new Error('Provider task does not belong to the generation job.');
      }
      const now = new Date().toISOString();
      const updated = { ...job, metadataJson: JSON.stringify(metadata), updatedAt: now };
      repositories.jobs.save(updated);
      return this.infoFromRepositories(updated);
    });
  }

  private transitionActive(
    jobId: string,
    status: 'paused',
    metadataChange: (metadata: VideoJobMetadata, now: string) => VideoJobMetadata,
  ): VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (job.status !== 'polling') return this.infoFromRepositories(job);
      const now = new Date().toISOString();
      const updated = {
        ...job,
        status,
        metadataJson: JSON.stringify(metadataChange(this.metadata(job), now)),
        updatedAt: now,
      };
      repositories.jobs.save(updated);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.infoFromRepositories(updated);
    });
  }

  private transitionFailure(
    jobId: string,
    failureKind: VideoGenerationFailureKind,
    message: string,
    suppliedMetadata?: VideoJobMetadata,
    status: 'failed' | 'timed-out' = 'failed',
  ): VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (!['pending', 'polling', 'downloading', 'paused', 'running'].includes(job.status)) {
        return this.infoFromRepositories(job);
      }
      const now = new Date().toISOString();
      const metadata = suppliedMetadata ?? this.metadata(job);
      const failed: JobRecord = {
        ...job,
        status,
        errorJson: JSON.stringify({ message: sanitizeError(message) }),
        metadataJson: JSON.stringify({ ...metadata, failureKind } satisfies VideoJobMetadata),
        updatedAt: now,
      };
      repositories.jobs.save(failed);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.infoFromRepositories(failed);
    });
  }

  private transitionToDownloading(
    jobId: string,
    providerTaskId: string,
    metadata: VideoJobMetadata,
  ): VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      this.requireVideoJob(job, project.id);
      if (job.status !== 'polling') return this.infoFromRepositories(job);
      if (job.providerTaskId !== providerTaskId) {
        throw new Error('Provider task does not belong to the generation job.');
      }
      const now = new Date().toISOString();
      const downloading: JobRecord = {
        ...job,
        status: 'downloading',
        metadataJson: JSON.stringify(metadata),
        updatedAt: now,
      };
      repositories.jobs.save(downloading);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.infoFromRepositories(downloading);
    });
  }

  private startDownload(
    projectSession: NonNullable<ReturnType<ProjectService['current']>>,
    job: JobRecord,
    providerTaskId: string,
    source: string,
    metadata: VideoJobMetadata,
  ): void {
    if (this.downloads.has(job.id)) return;
    const controller = new AbortController();
    this.downloads.set(job.id, controller);
    void this.downloadAndComplete(
      projectSession,
      job,
      providerTaskId,
      source,
      metadata,
      controller.signal,
    )
      .catch((error) => {
        if (this.projects.current() !== projectSession) return;
        try {
          this.transitionFailure(
            job.id,
            'download',
            error instanceof Error ? error.message : 'Video download finalization failed.',
            metadata,
          );
        } catch {
          // A concurrent close owns recovery when the project session is no longer writable.
        }
      })
      .finally(() => {
        if (this.downloads.get(job.id) === controller) this.downloads.delete(job.id);
      });
  }

  private async downloadAndComplete(
    projectSession: NonNullable<ReturnType<ProjectService['current']>>,
    job: JobRecord,
    providerTaskId: string,
    source: string,
    metadata: VideoJobMetadata,
    signal: AbortSignal,
  ): Promise<VideoGenerationJobInfo> {
    const assetId = randomUUID();
    const temporaryPath = resolveProjectRelativePath(
      projectSession.rootPath,
      join('assets', 'videos', `.${assetId}.${process.pid}.tmp`),
    );
    mkdirSync(join(projectSession.rootPath, 'assets', 'videos'), { recursive: true });
    let downloaded: DownloadedVideo;
    try {
      downloaded = await downloadVideo(source, temporaryPath, signal, this.storageCapacityCheck);
    } catch (error) {
      if (this.projects.current() !== projectSession) {
        rmSync(temporaryPath, { force: true });
        throw new Error('Project session changed during video download.');
      }
      return this.transitionFailure(
        job.id,
        'download',
        error instanceof Error ? error.message : 'Video download failed.',
        metadata,
      );
    }

    if (this.projects.current() !== projectSession) {
      rmSync(downloaded.temporaryPath, { force: true });
      throw new Error('Project session changed during video download.');
    }
    return this.projects.access(true, (database, project) => {
      if (project !== projectSession) {
        rmSync(downloaded.temporaryPath, { force: true });
        throw new Error('Project session changed during video download.');
      }
      const repositories = createRepositories(database);
      const current = repositories.jobs.get(job.id);
      this.requireVideoJob(current, project.id);
      if (current.status !== 'downloading' || current.providerTaskId !== providerTaskId) {
        rmSync(downloaded.temporaryPath, { force: true });
        return this.infoFromRepositories(current);
      }

      const relativePath = join('assets', 'videos', `${assetId}${downloaded.extension}`);
      const finalPath = resolveProjectRelativePath(project.rootPath, relativePath);
      const now = new Date().toISOString();
      const asset: AssetRecord = {
        id: assetId,
        projectId: project.id,
        kind: metadata.assetKind,
        relativePath,
        contentHash: downloaded.contentHash,
        sizeBytes: downloaded.sizeBytes,
        createdAt: now,
      };
      const result: GenerationResultRecord = {
        id: randomUUID(),
        jobId: current.id,
        assetId,
        createdAt: now,
      };
      const completed: JobRecord = {
        ...current,
        status: 'succeeded',
        errorJson: undefined,
        metadataJson: JSON.stringify(metadata),
        updatedAt: now,
      };
      renameSync(downloaded.temporaryPath, finalPath);
      try {
        database.transaction(() => {
          repositories.assets.save(asset);
          repositories.generationResults.save(result);
          repositories.jobs.save(completed);
          repositories.projects.touch(now);
        })();
      } catch (error) {
        rmSync(finalPath, { force: true });
        throw error;
      }
      project.updatedAt = now;
      return this.toInfo(completed, [asset], [result]);
    });
  }

  private requireVideoJob(job: JobRecord | undefined, projectId: string): asserts job is JobRecord {
    if (
      !job ||
      job.projectId !== projectId ||
      !VIDEO_CAPABILITIES.has(getAdapter(job.adapterKey)?.capability ?? '')
    ) {
      throw new Error('Video generation job was not found.');
    }
  }

  private metadata(job: JobRecord): VideoJobMetadata {
    const parsed = job.metadataJson
      ? (JSON.parse(job.metadataJson) as Partial<VideoJobMetadata>)
      : {};
    return {
      assetKind:
        parsed.assetKind === 'generated-video' || parsed.assetKind === 'shot-video'
          ? parsed.assetKind
          : 'shot-video',
      providerRegion: requireProviderRegion(parsed.providerRegion ?? 'global'),
      providerProfileId: parsed.providerProfileId
        ? requireProviderProfileId(parsed.providerProfileId)
        : undefined,
      modelId: parsed.modelId ? requireModelId(parsed.modelId) : undefined,
      pollAttempts:
        typeof parsed.pollAttempts === 'number' && Number.isFinite(parsed.pollAttempts)
          ? Math.max(0, Math.floor(parsed.pollAttempts))
          : 0,
      providerState: parsed.providerState,
      lastPolledAt: parsed.lastPolledAt,
      pollDeadlineAt: parsed.pollDeadlineAt,
      failureKind: parsed.failureKind,
      cost: parsed.cost,
      pricingSnapshot: normalizeCreditPricingSnapshot(parsed.pricingSnapshot),
      pausedAt: parsed.pausedAt,
    };
  }

  private infoFromRepositories(job: JobRecord): VideoGenerationJobInfo {
    return this.projects.access(false, (database, project) => {
      if (job.projectId !== project.id) throw new Error('Video generation job was not found.');
      const repositories = createRepositories(database);
      return this.toInfo(
        job,
        repositories.assets.listByProject(project.id),
        repositories.generationResults.listByJob(job.id),
      );
    });
  }

  private toInfo(
    job: JobRecord,
    assets: AssetRecord[],
    results: GenerationResultRecord[],
  ): VideoGenerationJobInfo {
    const metadata = this.metadata(job);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const terminal = TERMINAL_STATUSES.has(job.status);
    const elapsedEnd = terminal ? Date.parse(job.updatedAt) : Date.now();
    const elapsedStart = Date.parse(job.createdAt);
    return {
      id: job.id,
      projectId: job.projectId,
      shotId: job.shotId,
      adapterKey: job.adapterKey,
      assetKind: metadata.assetKind,
      providerTaskId: job.providerTaskId,
      status: job.status as VideoGenerationJobInfo['status'],
      request: JSON.parse(job.requestJson) as AdapterParameters,
      metadata: {
        providerRegion: metadata.providerRegion,
        providerProfileId: metadata.providerProfileId,
        modelId: metadata.modelId,
        providerState: metadata.providerState,
        pollAttempts: metadata.pollAttempts,
        lastPolledAt: metadata.lastPolledAt,
        pollDeadlineAt: metadata.pollDeadlineAt,
        failureKind: metadata.failureKind,
        cost: metadata.cost,
      },
      results: results.flatMap((result) => {
        const asset = result.assetId ? assetById.get(result.assetId) : undefined;
        return asset
          ? [
              {
                id: result.id,
                jobId: result.jobId,
                asset: toAssetInfo(asset),
                createdAt: result.createdAt,
              },
            ]
          : [];
      }),
      error: job.errorJson
        ? (JSON.parse(job.errorJson) as { message?: string }).message
        : undefined,
      elapsedMs:
        Number.isFinite(elapsedEnd) && Number.isFinite(elapsedStart)
          ? Math.max(0, elapsedEnd - elapsedStart)
          : 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}

function cleanupVideoTemporaryFiles(projectRoot: string): void {
  const directory = resolveProjectRelativePath(projectRoot, join('assets', 'videos'));
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (/^\.[0-9a-f-]{36}\.\d+\.tmp$/i.test(name)) {
      rmSync(resolveProjectRelativePath(projectRoot, join('assets', 'videos', name)), {
        force: true,
      });
    }
  }
}

function requireProviderTaskId(value: string): string {
  if (!PROVIDER_TASK_ID_PATTERN.test(value)) throw new Error('Provider task id is invalid.');
  return value;
}

function requireProviderRegion(value: string): VideoProviderRegion {
  if (value !== 'global' && value !== 'cn') throw new Error('Provider region is invalid.');
  return value;
}

function requireProviderProfileId(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error('Provider profile ID is invalid.');
  }
  return normalized;
}

function requireModelId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Provider model ID is invalid.');
  }
  return normalized;
}

function cloneParameters(parameters: AdapterParameters): AdapterParameters {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) =>
            item.toLowerCase().startsWith('data:image/') ? 'local-image://omitted' : item,
          )
        : typeof value === 'string' && value.toLowerCase().startsWith('data:image/')
          ? 'local-image://omitted'
          : value,
    ]),
  );
}

function observedMetadata(metadata: VideoJobMetadata, body: unknown): VideoJobMetadata {
  const cost = providerCost(body) ?? metadata.cost;
  return {
    ...metadata,
    pollAttempts: metadata.pollAttempts + 1,
    lastPolledAt: new Date().toISOString(),
    cost: priceProviderCost(cost, metadata.pricingSnapshot),
  };
}

function normalizeCreditPricingSnapshot(value: unknown): CreditPricingSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<CreditPricingSnapshot>;
  if (
    typeof candidate.currency !== 'string' ||
    !/^[A-Z]{3,8}$/.test(candidate.currency) ||
    typeof candidate.creditPrice !== 'string' ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(candidate.creditPrice)
  ) {
    return undefined;
  }
  return { currency: candidate.currency, creditPrice: candidate.creditPrice };
}

function priceProviderCost(
  cost: VideoGenerationMetadataInfo['cost'] | undefined,
  pricing: CreditPricingSnapshot | undefined,
): VideoGenerationMetadataInfo['cost'] | undefined {
  if (!cost || cost.unit !== 'credits' || !pricing) return cost;
  const credits = cost.amount.toFixed(12).replace(/\.?0+$/, '');
  return {
    ...cost,
    unitPrice: pricing.creditPrice,
    estimatedAmount: multiplyDecimalStrings(credits || '0', pricing.creditPrice),
    currency: pricing.currency,
  };
}

function providerState(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const object = body as Record<string, unknown>;
  const direct = object.state ?? object.status;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
  const data = object.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? providerState(data) : undefined;
}

function providerCost(body: unknown): VideoGenerationMetadataInfo['cost'] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = providerCost(item);
      if (found) return found;
    }
    return undefined;
  }
  const object = body as Record<string, unknown>;
  for (const [key, unit] of [
    ['credits_used', 'credits'],
    ['creditsUsed', 'credits'],
    ['credits', 'credits'],
    ['cost', 'unknown'],
  ] as const) {
    const value = object[key];
    const amount =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
          ? Number(value)
          : undefined;
    if (amount !== undefined && Number.isFinite(amount) && amount >= 0) {
      return { amount, unit };
    }
  }
  for (const value of Object.values(object)) {
    const found = providerCost(value);
    if (found) return found;
  }
  return undefined;
}

function providerFailureMessage(body: unknown): string {
  const code = findNamedString(body, ['err_code', 'error_code', 'code']);
  const message = findNamedString(body, ['message', 'error']);
  if (code && message) return `Provider video task failed (${code}): ${message}`;
  if (code) return `Provider video task failed (${code}).`;
  return message ? `Provider video task failed: ${message}` : 'Provider video task failed.';
}

function findNamedString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 200);
  }
  const data = object.data;
  return data && typeof data === 'object' ? findNamedString(data, keys) : undefined;
}

function extractVideoSource(value: unknown): string {
  const source = findVideoCreationSource(value);
  if (!source) throw new Error('Provider reported success without a video output URL.');
  const url = new URL(source);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    isPrivateHostname(url.hostname)
  ) {
    throw new Error('Provider returned an unsafe video output URL.');
  }
  return url.toString();
}

function findVideoCreationSource(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoCreationSource(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ['creations', 'Creations']) {
    const creations = object[key];
    if (!Array.isArray(creations)) continue;
    for (const creation of creations) {
      if (!creation || typeof creation !== 'object' || Array.isArray(creation)) continue;
      const item = creation as Record<string, unknown>;
      for (const field of ['video_url', 'videoUrl', 'url', 'uri']) {
        const candidate = item[field];
        if (typeof candidate === 'string' && /^https:\/\//i.test(candidate)) return candidate;
      }
    }
  }
  for (const child of Object.values(object)) {
    const found = findVideoCreationSource(child);
    if (found) return found;
  }
  return undefined;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return version === 6 && (normalized === '::1' || /^(fc|fd|fe80)/.test(normalized));
}

async function downloadVideo(
  source: string,
  temporaryPath: string,
  cancellationSignal: AbortSignal,
  storageCapacityCheck: StorageCapacityCheck,
): Promise<DownloadedVideo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_DOWNLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, cancellationSignal]);
  let descriptor: number | undefined;
  try {
    const response = await fetch(source, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Video download failed with HTTP ${response.status}.`);
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const extension = videoExtension(contentType, source);
    const declaredSizeValue = response.headers.get('content-length');
    const declaredSize = declaredSizeValue === null ? undefined : Number(declaredSizeValue);
    if (declaredSize !== undefined) {
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new Error('Video download returned an invalid Content-Length.');
      }
      if (declaredSize > MAX_VIDEO_BYTES) {
        throw new Error('Video download exceeds the 512 MiB limit.');
      }
      storageCapacityCheck(dirname(temporaryPath), declaredSize);
    }
    if (!response.body) throw new Error('Video download returned an empty body.');
    descriptor = openSync(temporaryPath, 'wx');
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let sizeBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > MAX_VIDEO_BYTES) throw new Error('Video download exceeds the 512 MiB limit.');
      storageCapacityCheck(dirname(temporaryPath), value.byteLength);
      hash.update(value);
      writeSync(descriptor, value);
    }
    closeSync(descriptor);
    descriptor = undefined;
    if (sizeBytes === 0 || statSync(temporaryPath).size !== sizeBytes) {
      throw new Error('Video download was empty or truncated.');
    }
    validateVideoSignature(temporaryPath, extension);
    return {
      temporaryPath,
      extension,
      contentHash: hash.digest('hex'),
      sizeBytes,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Video download timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function videoExtension(contentType: string, source: string): '.mp4' | '.webm' {
  if (contentType === 'video/mp4') return '.mp4';
  if (contentType === 'video/webm') return '.webm';
  const extension = extname(new URL(source).pathname).toLowerCase();
  if (
    contentType === 'application/octet-stream' &&
    (extension === '.mp4' || extension === '.webm')
  ) {
    return extension;
  }
  throw new Error('Downloaded result is not a supported MP4 or WebM video.');
}

function validateVideoSignature(path: string, extension: '.mp4' | '.webm'): void {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(16);
    const length = readSync(descriptor, header, 0, header.length, 0);
    const valid =
      extension === '.mp4'
        ? length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp'
        : length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!valid) throw new Error('Downloaded video signature does not match its media type.');
  } finally {
    closeSync(descriptor);
  }
}

function sanitizeError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b(?:token|bearer)\s+\S+/gi, '[CREDENTIAL]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function failureMessage(kind: VideoGenerationFailureKind): string {
  const messages: Record<VideoGenerationFailureKind, string> = {
    transport: 'Provider transport failed before video task submission completed.',
    provider: 'Provider video task failed.',
    download: 'Video result download failed.',
    interrupted: 'Video generation was interrupted.',
    timeout: 'Video generation timed out.',
  };
  return messages[kind];
}

function toAssetInfo(asset: AssetRecord): AssetInfo {
  return { ...asset };
}
