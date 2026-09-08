import { createHash, randomBytes } from 'node:crypto';
import type {
  AdapterParameters,
  ImageGenerationJobInfo,
  MediaSubmissionConfirmParams,
  MediaSubmissionConfirmationRequest,
  MediaSubmissionRequestParams,
  MediaSubmissionResult,
  MediaTaskCancellationOutcome,
  MediaInputReferenceV1,
  MediaTaskCancelParams,
  NativeProviderMediaCancelParams,
  NativeProviderMediaSubmitParams,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import type { JobRecord } from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { getAdapter, validateAdapterParameters } from '@ai-video/generation-adapters';
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AppSettingsService } from './app-settings-service.js';
import type { ImageGenerationService } from './image-generation-service.js';
import { NativeProviderRequestError, type NativeProviderBridge } from './native-provider-bridge.js';
import type { ProjectService } from './project-service.js';
import type { VideoGenerationService } from './video-generation-service.js';
import { resolveMediaProviderRoute } from './media-preparation-service.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

interface ResolvedMediaSubmission {
  draftVersion: number;
  providerProfileId: string;
  providerRegion: NativeProviderMediaSubmitParams['providerRegion'];
  modelId: string;
  remoteModelId: string;
  adapterKey: string;
  parameters: AdapterParameters;
  inputs?: MediaInputReferenceV1[];
  providerName: string;
  modelName: string;
  costNotice: { required: true; summary: string };
}

/**
 * The sole Worker-owned boundary for paid media submission. It creates a
 * reviewable confirmation first, then consumes that confirmation exactly once
 * before crossing the Native Provider boundary.
 */
export class MediaOrchestrationService {
  private readonly confirmationTokens = new Map<string, string>();

  constructor(
    private readonly projects: ProjectService,
    private readonly settings: AppSettingsService,
    private readonly images: ImageGenerationService,
    private readonly videos: VideoGenerationService,
    private readonly native: NativeProviderBridge,
    private readonly adapterResolver: typeof getAdapter = getAdapter,
  ) {}

  requestSubmission(params: MediaSubmissionRequestParams): MediaSubmissionResult {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(params.jobId);
      if (!job || job.projectId !== project.id)
        throw new Error('Media generation job was not found.');
      const kind = this.kind(job.adapterKey, job.taskSnapshotJson);
      const current = this.info(kind, job.id);
      if (isTerminal(current)) {
        this.confirmationTokens.delete(job.id);
        return { kind, job: current };
      }
      const snapshot = readSnapshot(job.taskSnapshotJson);
      if (job.mediaState !== 'draft' && job.mediaState !== 'awaiting_confirmation') {
        return { kind, job: current };
      }
      const projectSessionId = this.projects.currentSessionId();
      if (!projectSessionId) throw new Error('No project session is open.');
      if (job.mediaState === 'awaiting_confirmation') {
        const cachedToken = this.confirmationTokens.get(job.id);
        const expiresAt = job.submissionConfirmationExpiresAt;
        const expiresAtMs = Date.parse(expiresAt ?? '');
        if (
          cachedToken &&
          expiresAt &&
          Number.isFinite(expiresAtMs) &&
          expiresAtMs > Date.now() &&
          job.submissionConfirmationProjectSessionId === projectSessionId &&
          hash(cachedToken) === job.submissionConfirmationTokenHash
        ) {
          const resolved = this.resolveSubmission(job, snapshot, kind);
          return {
            kind,
            job: current,
            confirmation: this.confirmation(job.id, kind, resolved, expiresAt, cachedToken),
          };
        }
        if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
          return { kind, job: current };
        }
      }
      const resolved = this.resolveSubmission(job, snapshot, kind);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();
      const confirmation = this.confirmation(job.id, kind, resolved, expiresAt, token);
      const now = new Date().toISOString();
      const awaitingConfirmation: JobRecord = {
        ...job,
        mediaState: 'awaiting_confirmation',
        submissionConfirmationTokenHash: hash(token),
        submissionConfirmationExpiresAt: expiresAt,
        submissionConfirmationConsumedAt: undefined,
        submissionConfirmationProjectSessionId: projectSessionId,
        updatedAt: now,
      };
      database.transaction(() => {
        repositories.jobs.save(awaitingConfirmation);
        repositories.generationJobEvents.append({
          id: cryptoRandomId(),
          jobId: job.id,
          projectId: project.id,
          phase: 'submit',
          status: 'awaiting_confirmation',
          summary: 'Waiting for explicit confirmation before paid media submission.',
          createdAt: now,
        });
        repositories.projects.touch(now);
      })();
      this.confirmationTokens.set(job.id, token);
      project.updatedAt = now;
      return {
        kind,
        job: this.info(kind, job.id),
        confirmation,
      };
    });
  }

  async confirmSubmission(params: MediaSubmissionConfirmParams): Promise<MediaSubmissionResult> {
    const prepared:
      | { kind: 'image' | 'video'; job: JobRecord; skip: true }
      | {
          kind: 'image' | 'video';
          job: JobRecord;
          projectSessionId: string;
          snapshot: Record<string, unknown>;
          resolved: ResolvedMediaSubmission;
          skip: false;
        } = this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(params.jobId);
      if (!job || job.projectId !== project.id)
        throw new Error('Media generation job was not found.');
      const kind = this.kind(job.adapterKey, job.taskSnapshotJson);
      const snapshot = readSnapshot(job.taskSnapshotJson);
      const projectSessionId = this.projects.currentSessionId();
      if (
        !projectSessionId ||
        job.mediaState !== 'awaiting_confirmation' ||
        !job.submissionConfirmationTokenHash ||
        !job.submissionConfirmationExpiresAt ||
        job.submissionConfirmationProjectSessionId !== projectSessionId ||
        Date.parse(job.submissionConfirmationExpiresAt) <= Date.now() ||
        hash(params.confirmationToken) !== job.submissionConfirmationTokenHash
      ) {
        throw new Error('Media submission confirmation is invalid, expired, or already consumed.');
      }
      const resolved = this.resolveSubmission(job, snapshot, kind);
      const now = new Date().toISOString();
      if (!params.approved) {
        const cancelled = {
          ...job,
          mediaState: 'cancelled' as const,
          status: 'cancelled',
          submissionConfirmationConsumedAt: now,
          submissionConfirmationTokenHash: undefined,
          submissionConfirmationExpiresAt: undefined,
          submissionConfirmationProjectSessionId: undefined,
          updatedAt: now,
        };
        database.transaction(() => {
          repositories.jobs.save(cancelled);
          repositories.generationJobEvents.append({
            id: cryptoRandomId(),
            jobId: job.id,
            projectId: project.id,
            phase: 'submit',
            status: 'cancelled',
            summary: 'Paid media submission was rejected by the user.',
            createdAt: now,
          });
          repositories.projects.touch(now);
        })();
        project.updatedAt = now;
        return { kind, job: cancelled, skip: true as const };
      }
      const updated = {
        ...job,
        mediaState: 'submitting' as const,
        submissionIdempotencyKey: job.submissionIdempotencyKey ?? `media-submit:${job.id}`,
        submissionAttemptId: job.submissionAttemptId ?? cryptoRandomId(),
        submissionConfirmationConsumedAt: now,
        submissionConfirmationTokenHash: undefined,
        submissionConfirmationExpiresAt: undefined,
        submissionConfirmationProjectSessionId: undefined,
        updatedAt: now,
      };
      database.transaction(() => {
        repositories.jobs.save(updated);
        repositories.generationJobEvents.append({
          id: cryptoRandomId(),
          jobId: job.id,
          projectId: project.id,
          phase: 'submit',
          status: 'submitting',
          summary: 'Paid media submission started after explicit confirmation.',
          createdAt: now,
        });
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return { kind, job: updated, projectSessionId, snapshot, resolved, skip: false as const };
    });
    this.confirmationTokens.delete(params.jobId);
    if (prepared.skip) {
      if (prepared.job.status === 'cancelled') {
        cleanupControlledInputs(
          readSnapshot(prepared.job.taskSnapshotJson),
          this.projects.current()?.rootPath,
        );
      }
      return { kind: prepared.kind, job: this.info(prepared.kind, prepared.job.id) };
    }
    const kind = prepared.kind;
    const job = this.info(kind, prepared.job.id);
    if (this.projects.currentSessionId() !== prepared.projectSessionId) {
      cleanupControlledInputs(prepared.snapshot, this.projects.current()?.rootPath);
      throw new Error('Project session changed before media submission.');
    }
    const snapshot = prepared.snapshot;
    const resolved = prepared.resolved;
    const request: NativeProviderMediaSubmitParams = {
      projectSessionId: prepared.projectSessionId,
      providerProfileId: resolved.providerProfileId,
      adapterKey: resolved.adapterKey,
      providerRegion: resolved.providerRegion,
      modelId: resolved.modelId,
      remoteModelId: resolved.remoteModelId,
      parameters: resolved.parameters,
      inputs: resolved.inputs,
      kind,
    };
    let response: unknown;
    try {
      response = await this.native.request('provider.media.submit', request);
    } catch (error) {
      if (this.projects.currentSessionId() !== prepared.projectSessionId) {
        cleanupControlledInputs(snapshot, this.projects.current()?.rootPath);
        throw new Error('Project session changed during media submission.');
      }
      if (
        error instanceof NativeProviderRequestError &&
        ['INVALID_PARAMETERS', 'METHOD_NOT_FOUND'].includes(error.hostError.code)
      ) {
        cleanupControlledInputs(snapshot, this.projects.current()?.rootPath);
        return {
          kind,
          job: this.failKnown(job.id, kind, error.message),
        };
      }
      cleanupControlledInputs(snapshot, this.projects.current()?.rootPath);
      return {
        kind,
        job: this.markUnknown(job.id, kind, error instanceof Error ? error.message : String(error)),
      };
    }
    const body = asRecord(response);
    cleanupControlledInputs(snapshot, this.projects.current()?.rootPath);
    if (this.projects.currentSessionId() !== prepared.projectSessionId) {
      throw new Error('Project session changed during media submission.');
    }
    const status = typeof body.status === 'number' ? body.status : 0;
    if (kind === 'image') {
      const completed = await this.images.complete({
        jobId: job.id,
        projectSessionId: prepared.projectSessionId,
        providerStatus: status,
        providerBody: body.body,
        assetKind: 'generated-image',
      });
      return { kind, job: completed };
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId : undefined;
    if (status < 200 || status >= 300 || !taskId) {
      const failed = this.videos.fail({
        jobId: job.id,
        projectSessionId: prepared.projectSessionId,
        failureKind: 'provider',
        message:
          typeof body.errorMessage === 'string' ? body.errorMessage : `Provider HTTP ${status}`,
      });
      return { kind, job: failed };
    }
    const attached = this.videos.attachTask({
      jobId: job.id,
      providerTaskId: taskId,
      projectSessionId: prepared.projectSessionId,
    });
    return { kind, job: attached };
  }

  private failKnown(
    jobId: string,
    kind: 'image' | 'video',
    message: string,
  ): ImageGenerationJobInfo | VideoGenerationJobInfo {
    return kind === 'image'
      ? this.images.failSubmission(jobId, message)
      : this.videos.fail({ jobId, failureKind: 'provider', message });
  }

  async cancel(params: MediaTaskCancelParams): Promise<MediaSubmissionResult> {
    const projectSessionId = params.projectSessionId ?? this.projects.currentSessionId();
    if (!projectSessionId || this.projects.currentSessionId() !== projectSessionId) {
      throw new Error('Project session changed before media cancellation.');
    }
    const current = this.projects.access(false, (database, project) => {
      const job = createRepositories(database).jobs.get(params.jobId);
      if (!job || job.projectId !== project.id)
        throw new Error('Media generation job was not found.');
      return job;
    });
    const kind = this.kind(current.adapterKey, current.taskSnapshotJson);
    this.confirmationTokens.delete(current.id);
    const currentInfo = this.info(kind, current.id);
    if (isTerminal(currentInfo)) return { kind, job: currentInfo };
    const snapshot = readSnapshot(current.taskSnapshotJson);
    let cancellation: MediaTaskCancellationOutcome = {
      localCancelled: true,
      provider:
        current.mediaState === 'submitting' || current.mediaState === 'submission_unknown'
          ? 'unknown'
          : 'not_submitted',
    };
    if (kind === 'video' && current.providerTaskId) {
      try {
        const resolved = this.resolveSubmission(current, snapshot, kind);
        const request: NativeProviderMediaCancelParams = {
          projectSessionId,
          providerProfileId: resolved.providerProfileId,
          adapterKey: current.adapterKey,
          providerRegion: resolved.providerRegion,
          providerTaskId: current.providerTaskId,
        };
        const body = asRecord(await this.native.request('provider.media.cancel', request));
        const providerStatus =
          typeof body.status === 'number' && Number.isFinite(body.status) ? body.status : undefined;
        cancellation = {
          localCancelled: true,
          provider:
            body.supported === false
              ? 'unsupported'
              : body.supported === true && body.cancelled === true
                ? 'cancelled'
                : body.supported === true
                  ? 'rejected'
                  : 'unknown',
          ...(providerStatus === undefined ? {} : { providerStatus }),
        };
      } catch {
        cancellation = { localCancelled: true, provider: 'unknown' };
      }
    }
    cleanupControlledInputs(snapshot, this.projects.current()?.rootPath);
    if (this.projects.currentSessionId() !== projectSessionId) {
      throw new Error('Project session changed during media cancellation.');
    }
    const job =
      kind === 'image'
        ? this.images.cancel(current.id, projectSessionId)
        : this.videos.cancel(current.id, projectSessionId);
    return { kind, job, cancellation };
  }

  recoverInterrupted(): number {
    const current = this.projects.current();
    if (!current || current.mode !== 'read-write') return 0;
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const interrupted = repositories.jobs
        .listByProject(project.id)
        .filter(
          (job) => job.mediaState === 'awaiting_confirmation' || job.mediaState === 'submitting',
        );
      if (interrupted.length === 0) return 0;
      const now = new Date().toISOString();
      database.transaction(() => {
        for (const job of interrupted) {
          const awaitingConfirmation = job.mediaState === 'awaiting_confirmation';
          repositories.jobs.save({
            ...job,
            mediaState: awaitingConfirmation ? 'draft' : 'submission_unknown',
            errorJson: awaitingConfirmation
              ? job.errorJson
              : JSON.stringify({
                  message:
                    'Submission status is unknown because the application stopped before the Provider response was recorded.',
                }),
            submissionConfirmationTokenHash: undefined,
            submissionConfirmationExpiresAt: undefined,
            submissionConfirmationProjectSessionId: undefined,
            updatedAt: now,
          });
          repositories.generationJobEvents.append({
            id: cryptoRandomId(),
            jobId: job.id,
            projectId: project.id,
            phase: 'submit',
            status: awaitingConfirmation ? 'draft' : 'submission_unknown',
            summary: awaitingConfirmation
              ? 'Expired confirmation was cleared after the project session restarted.'
              : 'Submission was interrupted after confirmation; automatic retry is disabled.',
            detailsJson: JSON.stringify({ recovery: true }),
            createdAt: now,
          });
        }
        repositories.projects.touch(now);
      })();
      for (const job of interrupted) this.confirmationTokens.delete(job.id);
      project.updatedAt = now;
      return interrupted.length;
    });
  }

  private markUnknown(
    jobId: string,
    kind: 'image' | 'video',
    message: string,
  ): ImageGenerationJobInfo | VideoGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      if (!job || job.projectId !== project.id)
        throw new Error('Media generation job was not found.');
      const now = new Date().toISOString();
      database.transaction(() => {
        repositories.jobs.save({
          ...job,
          mediaState: 'submission_unknown',
          errorJson: JSON.stringify({ message: `Submission status is unknown: ${message}` }),
          updatedAt: now,
        });
        repositories.generationJobEvents.append({
          id: cryptoRandomId(),
          jobId,
          projectId: project.id,
          phase: 'submit',
          status: 'submission_unknown',
          summary: 'Provider submission outcome is unknown; automatic retry is disabled.',
          createdAt: now,
        });
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return this.info(kind, jobId);
    });
  }

  private info(
    kind: 'image' | 'video',
    id: string,
  ): ImageGenerationJobInfo | VideoGenerationJobInfo {
    return kind === 'image' ? this.images.get(id) : this.videos.get(id);
  }

  private kind(adapterKey: string, snapshotJson?: string): 'image' | 'video' {
    if (readSnapshot(snapshotJson).capability === 'video') return 'video';
    return adapterKey.includes('TO_VIDEO') ? 'video' : 'image';
  }

  private confirmation(
    jobId: string,
    kind: 'image' | 'video',
    resolved: ResolvedMediaSubmission,
    expiresAt: string,
    token: string,
  ): MediaSubmissionConfirmationRequest {
    return {
      confirmationToken: token,
      jobId,
      kind,
      draftVersion: resolved.draftVersion,
      providerName: resolved.providerName,
      modelName: resolved.modelName,
      adapterKey: resolved.adapterKey,
      parameterSummary: summarizeParameters(resolved.parameters),
      costNotice: resolved.costNotice,
      expiresAt,
    };
  }

  private resolveSubmission(
    job: JobRecord,
    snapshot: Record<string, unknown>,
    kind: 'image' | 'video',
  ): ResolvedMediaSubmission {
    if (snapshot.version !== 1) throw new Error('Media draft version is not supported.');
    const frozen = asRecord(snapshot.mediaModelSelection);
    const providerProfileId = requiredSnapshotString(
      frozen.providerProfileId ?? snapshot.providerProfileId,
      'Provider profile',
    );
    const profile = this.settings.getProfile(providerProfileId);
    const route = profile ? resolveMediaProviderRoute(profile) : undefined;
    if (!profile || !route || !profile.enabled || profile.connectionStatus !== 'ready') {
      throw new Error('The frozen media Provider is no longer ready.');
    }
    assertFrozenValue(frozen.providerType, route.providerType, 'Provider type');
    assertFrozenValue(frozen.providerBaseUrlCategory, route.baseUrlCategory, 'Provider URL');
    assertFrozenValue(
      frozen.providerRegion ?? snapshot.providerRegion,
      route.providerRegion,
      'Provider region',
    );

    const frozenModelId = requiredSnapshotString(frozen.modelId ?? snapshot.modelId, 'Media model');
    const model = this.settings
      .listModels(profile.id)
      .find((item) => item.id === frozenModelId || item.remoteModelId === frozenModelId);
    if (!model || !model.enabled || model.unavailableAt) {
      throw new Error('The frozen media model is no longer available.');
    }
    assertFrozenValue(frozen.remoteModelId, model.remoteModelId, 'Remote model');

    const adapterKey = requiredSnapshotString(
      frozen.adapterKey ?? snapshot.adapterKey ?? job.adapterKey,
      'Media adapter',
    );
    if (adapterKey !== job.adapterKey) throw new Error('The frozen media adapter does not match.');
    const adapter = this.adapterResolver(adapterKey);
    if (
      !adapter ||
      adapter.provider !== route.providerType ||
      adapter.model !== model.remoteModelId ||
      (kind === 'image') !== adapter.capability.endsWith('TO_IMAGE')
    ) {
      throw new Error('The frozen media adapter is no longer compatible.');
    }
    const frozenSchemaVersion = frozen.adapterSchemaVersion ?? snapshot.schemaVersion;
    if (frozenSchemaVersion !== undefined && frozenSchemaVersion !== adapter.schemaVersion) {
      throw new Error('The frozen media Adapter Schema version is no longer available.');
    }

    const parameters = snapshot.parameters ?? parseJsonRecord(job.requestJson);
    if (!isRecord(parameters)) throw new Error('The frozen media parameters are invalid.');
    const normalizedParameters = structuredClone(parameters) as AdapterParameters;
    if (!validateAdapterParameters(adapterKey, normalizedParameters).valid) {
      throw new Error('The frozen media parameters no longer match the Adapter Schema.');
    }
    const inputs = parseMediaInputs(snapshot.inputs);
    const pricing = this.settings
      .listModelPricing(profile.id)
      .find((item) => item.modelId === model.id);
    return {
      draftVersion: 1,
      providerProfileId: profile.id,
      providerRegion: route.providerRegion,
      modelId: model.id,
      remoteModelId: model.remoteModelId,
      adapterKey,
      parameters: normalizedParameters,
      inputs,
      providerName: profile.name,
      modelName: model.displayName,
      costNotice: {
        required: true,
        summary: pricing
          ? 'The selected Provider may charge for this request.'
          : 'The selected Provider may charge according to its pricing.',
      },
    };
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`;
}
function readSnapshot(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function requiredSnapshotString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is missing from the media task snapshot.`);
  }
  return value.trim();
}
function assertFrozenValue(value: unknown, current: string, label: string): void {
  if (value !== undefined && value !== current) {
    throw new Error(`${label} no longer matches the frozen media task snapshot.`);
  }
}
function parseMediaInputs(value: unknown): MediaInputReferenceV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('The frozen media input references are invalid.');
  return value.map((input) => {
    if (!isRecord(input)) throw new Error('The frozen media input reference is invalid.');
    if (input.type === 'asset' && typeof input.assetId === 'string' && input.assetId.trim()) {
      return { type: 'asset', assetId: input.assetId };
    }
    if (
      input.type === 'controlled_temporary_file' &&
      typeof input.handle === 'string' &&
      input.handle.startsWith('cache/media-inputs/') &&
      !input.handle.includes('..') &&
      !input.handle.includes('\\') &&
      typeof input.contentType === 'string'
    ) {
      return {
        type: 'controlled_temporary_file',
        handle: input.handle,
        contentType: input.contentType,
      };
    }
    throw new Error('The frozen media input reference is invalid.');
  });
}
function summarizeParameters(parameters: AdapterParameters): Array<{ key: string; value: string }> {
  return Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 40)
    .map(([key, value]) => ({ key, value: summarizeParameterValue(value) }));
}
function summarizeParameterValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.startsWith('controlled-file://') || value.startsWith('asset://')) {
      return 'selected local input';
    }
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return `${url.origin}${url.pathname}`.slice(0, 200);
      }
    } catch {
      // Ordinary prompt or enum value.
    }
    return value.slice(0, 200);
  }
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item === 'string' && item.includes('://'))) {
      return `${value.length} selected input(s)`;
    }
    return JSON.stringify(value).slice(0, 200);
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value).slice(0, 200) : serialized.slice(0, 200);
}
function isTerminal(job: ImageGenerationJobInfo | VideoGenerationJobInfo): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed-out'].includes(job.status);
}

function cleanupControlledInputs(snapshot: Record<string, unknown>, fallbackRoot?: string): void {
  const rootValue = process.env.AI_VIDEO_MEDIA_INPUT_ROOT?.trim() || fallbackRoot;
  if (!rootValue) return;
  const root = resolve(rootValue);
  const inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
  for (const input of inputs) {
    const record = asRecord(input);
    const handle =
      record.type === 'controlled_temporary_file' && typeof record.handle === 'string'
        ? record.handle
        : undefined;
    if (typeof handle !== 'string' || !handle.startsWith('cache/media-inputs/')) continue;
    if (handle.includes('..') || handle.includes('\\')) continue;
    const path = resolve(root, handle);
    if (path.startsWith(`${root}${sep}`)) rmSync(path, { force: true });
  }
}
