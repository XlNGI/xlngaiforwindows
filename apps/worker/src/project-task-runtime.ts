import type {
  NativeProviderMediaPollParams,
  NativeProviderMediaPollResult,
  ProjectTaskSnapshot,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import type { NativeProviderBridge } from './native-provider-bridge.js';
import type { ProjectService } from './project-service.js';
import type { VideoGenerationService } from './video-generation-service.js';

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 30 * 60 * 1_000;
const MIN_GLOBAL_INTERVAL_MS = 500;
const DOWNLOAD_REFRESH_MS = 500;
const MAX_CONCURRENCY = 2;
const NATIVE_MEDIA_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

interface ScheduledVideoJob {
  job: VideoGenerationJobInfo;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  transportFailures: number;
}

export interface ProjectTaskRuntimeOptions {
  now?: () => number;
  random?: () => number;
}

class InvalidPollResultError extends Error {}

/** Owns recoverable media work for the currently open project, independent of any Desktop page. */
export class ProjectTaskRuntime {
  private readonly jobs = new Map<string, ScheduledVideoJob>();
  private readonly now: () => number;
  private readonly random: () => number;
  private activeRequests = 0;
  private lastRequestAt = 0;
  private revision = 0;
  private runningSessionId?: string;

  constructor(
    private readonly projects: ProjectService,
    private readonly videos: VideoGenerationService,
    private readonly native: Pick<NativeProviderBridge, 'request'>,
    options: ProjectTaskRuntimeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    this.stop();
    const project = this.projects.current();
    const sessionId = this.projects.currentSessionId();
    if (!project || !sessionId) return;
    this.runningSessionId = sessionId;
    this.revision += 1;
    if (project.mode === 'read-write') this.sync(0);
  }

  stop(): void {
    this.runningSessionId = undefined;
    for (const scheduled of this.jobs.values()) {
      if (scheduled.timer) clearTimeout(scheduled.timer);
    }
    this.jobs.clear();
    this.activeRequests = 0;
    this.lastRequestAt = 0;
  }

  /** Re-scan after a submit, pause, resume, cancellation, or other explicit task mutation. */
  kick(): void {
    if (!this.isCurrentSession()) return;
    this.revision += 1;
    this.sync(0);
  }

  snapshot(afterRevision = -1): ProjectTaskSnapshot {
    const project = this.projects.current();
    const projectSessionId = this.projects.currentSessionId();
    if (!project || !projectSessionId) throw new Error('No project is open.');
    const videoJobs = this.videos.list();
    return {
      projectId: project.id,
      projectSessionId,
      revision: this.revision,
      changed: afterRevision !== this.revision,
      activeCount: videoJobs.filter((job) => ['polling', 'downloading'].includes(job.status))
        .length,
      videoJobs,
    };
  }

  private sync(initialDelayMs: number): void {
    if (!this.isCurrentSession()) return;
    let jobs: VideoGenerationJobInfo[];
    try {
      jobs = this.videos.list();
    } catch {
      return;
    }
    const activeIds = new Set(
      jobs
        .filter(
          (job) =>
            (job.status === 'polling' && Boolean(job.providerTaskId)) ||
            job.status === 'downloading',
        )
        .map((job) => job.id),
    );
    for (const jobId of this.jobs.keys()) {
      if (!activeIds.has(jobId)) this.remove(jobId);
    }
    for (const job of jobs) {
      if (!activeIds.has(job.id)) continue;
      const existing = this.jobs.get(job.id);
      if (existing) {
        if (videoJobChanged(existing.job, job)) {
          existing.job = job;
          this.revision += 1;
        }
        continue;
      }
      const scheduled: ScheduledVideoJob = {
        job,
        inFlight: false,
        transportFailures: 0,
      };
      this.jobs.set(job.id, scheduled);
      this.schedule(scheduled, initialDelayMs);
    }
  }

  private schedule(scheduled: ScheduledVideoJob, delayMs: number): void {
    if (
      !this.isCurrentSession() ||
      scheduled.timer ||
      this.jobs.get(scheduled.job.id) !== scheduled
    )
      return;
    scheduled.timer = setTimeout(
      () => {
        scheduled.timer = undefined;
        void this.run(scheduled);
      },
      Math.max(0, delayMs),
    );
  }

  private async run(scheduled: ScheduledVideoJob): Promise<void> {
    if (
      !this.isCurrentSession() ||
      this.jobs.get(scheduled.job.id) !== scheduled ||
      scheduled.inFlight
    ) {
      return;
    }
    scheduled.inFlight = true;
    try {
      const current = this.videos.get(scheduled.job.id);
      this.recordUpdate(scheduled, current);
      if (current.status === 'downloading') {
        this.schedule(scheduled, DOWNLOAD_REFRESH_MS);
        return;
      }
      if (current.status !== 'polling' || !current.providerTaskId) {
        this.remove(current.id);
        return;
      }
      const deadline = current.metadata.pollDeadlineAt
        ? Date.parse(current.metadata.pollDeadlineAt)
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(deadline) && deadline <= this.now()) {
        this.recordUpdate(scheduled, this.videos.timeout(current.id));
        this.remove(current.id);
        return;
      }
      if (this.activeRequests >= MAX_CONCURRENCY) {
        this.schedule(scheduled, MIN_GLOBAL_INTERVAL_MS);
        return;
      }
      const globalWait = MIN_GLOBAL_INTERVAL_MS - (this.now() - this.lastRequestAt);
      if (globalWait > 0) {
        this.schedule(scheduled, globalWait);
        return;
      }
      const providerProfileId = current.metadata.providerProfileId;
      if (!providerProfileId) {
        this.recordUpdate(
          scheduled,
          this.videos.fail({
            jobId: current.id,
            failureKind: 'interrupted',
            message: 'Recovered video task is missing its frozen Provider profile.',
          }),
        );
        this.remove(current.id);
        return;
      }
      const params: NativeProviderMediaPollParams = {
        projectSessionId: this.runningSessionId!,
        providerProfileId,
        adapterKey: current.adapterKey,
        providerRegion: current.metadata.providerRegion,
        providerTaskId: current.providerTaskId,
      };
      const requestSessionId = this.runningSessionId;
      this.activeRequests += 1;
      this.lastRequestAt = this.now();
      let response: NativeProviderMediaPollResult;
      try {
        response = parsePollResult(
          await this.native.request('provider.media.poll', params, NATIVE_MEDIA_REQUEST_TIMEOUT_MS),
        );
      } finally {
        if (this.runningSessionId === requestSessionId) {
          this.activeRequests = Math.max(0, this.activeRequests - 1);
        }
      }
      if (!this.isCurrentSession() || this.jobs.get(current.id) !== scheduled) return;
      const observed =
        response.state === 'cancelled'
          ? this.videos.cancel(current.id)
          : this.videos.observe({
              jobId: current.id,
              providerTaskId: current.providerTaskId,
              providerStatus: response.providerStatus,
              providerBody: normalizedProviderBody(response),
            });
      scheduled.transportFailures = 0;
      this.recordUpdate(scheduled, observed);
      if (observed.status === 'polling') {
        this.schedule(
          scheduled,
          nextProjectTaskDelay(observed.metadata.pollAttempts, response.retryAfterMs, this.random),
        );
      } else if (observed.status === 'downloading') {
        this.schedule(scheduled, DOWNLOAD_REFRESH_MS);
      } else {
        this.remove(observed.id);
      }
    } catch (error) {
      if (!this.isCurrentSession() || this.jobs.get(scheduled.job.id) !== scheduled) return;
      scheduled.transportFailures += 1;
      const retryable =
        !(error instanceof InvalidPollResultError) &&
        (!error ||
          typeof error !== 'object' ||
          !('hostError' in error) ||
          (error as { hostError?: { retryable?: unknown } }).hostError?.retryable !== false);
      if (!retryable) {
        try {
          this.recordUpdate(
            scheduled,
            this.videos.fail({
              jobId: scheduled.job.id,
              failureKind: 'transport',
              message: error instanceof Error ? error.message : 'Native Provider polling failed.',
            }),
          );
        } finally {
          this.remove(scheduled.job.id);
        }
        return;
      }
      this.schedule(
        scheduled,
        nextProjectTaskDelay(
          scheduled.job.metadata.pollAttempts + scheduled.transportFailures,
          undefined,
          this.random,
        ),
      );
    } finally {
      scheduled.inFlight = false;
    }
  }

  private recordUpdate(scheduled: ScheduledVideoJob, next: VideoGenerationJobInfo): void {
    if (videoJobChanged(scheduled.job, next)) {
      this.revision += 1;
    }
    scheduled.job = next;
  }

  private remove(jobId: string): void {
    const scheduled = this.jobs.get(jobId);
    if (scheduled?.timer) clearTimeout(scheduled.timer);
    this.jobs.delete(jobId);
  }

  private isCurrentSession(): boolean {
    return (
      this.runningSessionId !== undefined &&
      this.projects.currentSessionId() === this.runningSessionId
    );
  }
}

export function nextProjectTaskDelay(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, random())));
  const retryAfter =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.floor(retryAfterMs)))
      : 0;
  return Math.max(exponential + jitter, retryAfter);
}

function videoJobChanged(current: VideoGenerationJobInfo, next: VideoGenerationJobInfo): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
}

function parsePollResult(value: unknown): NativeProviderMediaPollResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPollResultError('Native Provider poll result must be an object.');
  }
  const result = value as Record<string, unknown>;
  assertExactKeys(result, [
    'providerStatus',
    'state',
    'providerState',
    'progress',
    'cost',
    'output',
    'error',
    'retryAfterMs',
  ]);
  if (
    typeof result.providerStatus !== 'number' ||
    !Number.isInteger(result.providerStatus) ||
    result.providerStatus < 0
  ) {
    throw new InvalidPollResultError('Native Provider poll status is invalid.');
  }
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(result.state))) {
    throw new InvalidPollResultError('Native Provider task state is invalid.');
  }
  if (
    result.providerState !== undefined &&
    (typeof result.providerState !== 'string' ||
      result.providerState.length < 1 ||
      result.providerState.length > 64)
  ) {
    throw new InvalidPollResultError('Native Provider task state detail is invalid.');
  }
  if (
    result.progress !== undefined &&
    (typeof result.progress !== 'number' ||
      !Number.isFinite(result.progress) ||
      result.progress < 0)
  ) {
    throw new InvalidPollResultError('Native Provider progress is invalid.');
  }
  if (
    result.retryAfterMs !== undefined &&
    (typeof result.retryAfterMs !== 'number' ||
      !Number.isFinite(result.retryAfterMs) ||
      result.retryAfterMs < 0)
  ) {
    throw new InvalidPollResultError('Native Provider Retry-After value is invalid.');
  }
  const cost = parseCost(result.cost);
  const output = parseOutput(result.output);
  const error = parseProviderError(result.error);
  const state = result.state as NativeProviderMediaPollResult['state'];
  if ((state === 'succeeded') !== Boolean(output)) {
    throw new InvalidPollResultError('Native Provider output does not match its task state.');
  }
  if ((state === 'failed') !== Boolean(error)) {
    throw new InvalidPollResultError('Native Provider error does not match its task state.');
  }
  return {
    providerStatus: result.providerStatus,
    state,
    providerState: result.providerState,
    progress: result.progress,
    cost,
    output,
    error,
    retryAfterMs: result.retryAfterMs,
  };
}

function parseCost(value: unknown): NativeProviderMediaPollResult['cost'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPollResultError('Native Provider cost is invalid.');
  }
  const cost = value as Record<string, unknown>;
  assertExactKeys(cost, ['amount', 'unit']);
  if (
    typeof cost.amount !== 'number' ||
    !Number.isFinite(cost.amount) ||
    cost.amount < 0 ||
    (cost.unit !== 'credits' && cost.unit !== 'unknown')
  ) {
    throw new InvalidPollResultError('Native Provider cost is invalid.');
  }
  return { amount: cost.amount, unit: cost.unit };
}

function parseOutput(value: unknown): NativeProviderMediaPollResult['output'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPollResultError('Native Provider output is invalid.');
  }
  const output = value as Record<string, unknown>;
  assertExactKeys(output, ['type', 'path', 'contentType']);
  if (
    output.type !== 'native_temporary_file' ||
    typeof output.path !== 'string' ||
    output.path.length < 1 ||
    output.path.length > 32_767 ||
    (output.contentType !== undefined && typeof output.contentType !== 'string')
  ) {
    throw new InvalidPollResultError('Native Provider output is invalid.');
  }
  return {
    type: output.type,
    path: output.path,
    contentType: output.contentType,
  };
}

function parseProviderError(value: unknown): NativeProviderMediaPollResult['error'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPollResultError('Native Provider error is invalid.');
  }
  const error = value as Record<string, unknown>;
  assertExactKeys(error, ['code', 'message', 'retryable']);
  if (
    (error.code !== undefined && typeof error.code !== 'string') ||
    typeof error.message !== 'string' ||
    error.message.length < 1 ||
    error.message.length > 500 ||
    typeof error.retryable !== 'boolean'
  ) {
    throw new InvalidPollResultError('Native Provider error is invalid.');
  }
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function normalizedProviderBody(result: NativeProviderMediaPollResult): Record<string, unknown> {
  return {
    state: result.providerState ?? result.state,
    ...(result.progress === undefined ? {} : { progress: result.progress }),
    ...(result.cost ? { cost: result.cost } : {}),
    ...(result.output ? { output: result.output } : {}),
    ...(result.error
      ? {
          code: result.error.code,
          message: result.error.message,
        }
      : {}),
  };
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) {
    throw new InvalidPollResultError(
      `Native Provider result contains an unknown field: ${unknown}.`,
    );
  }
}
