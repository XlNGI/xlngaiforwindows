import type { VideoGenerationJobInfo } from '@ai-video/contracts';
import type { NativeProviderResponse } from './provider-client';

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const MIN_GLOBAL_INTERVAL_MS = 500;
const MAX_CONCURRENCY = 2;

export interface VideoPollingSchedulerDependencies {
  poll: (job: VideoGenerationJobInfo) => Promise<NativeProviderResponse>;
  observe: (
    job: VideoGenerationJobInfo,
    response: NativeProviderResponse,
  ) => Promise<VideoGenerationJobInfo>;
  timeout: (job: VideoGenerationJobInfo) => Promise<VideoGenerationJobInfo>;
  refresh: (job: VideoGenerationJobInfo) => Promise<VideoGenerationJobInfo>;
  onUpdate: (job: VideoGenerationJobInfo) => void;
  onTransientError: (job: VideoGenerationJobInfo, error: unknown) => void;
  onTerminal: (job: VideoGenerationJobInfo) => void;
  now?: () => number;
  random?: () => number;
}

interface ScheduledJob {
  job: VideoGenerationJobInfo;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  transportFailures: number;
}

export class VideoPollingScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly now: () => number;
  private readonly random: () => number;
  private activeRequests = 0;
  private lastRequestAt = 0;
  private disposed = false;

  constructor(private readonly dependencies: VideoPollingSchedulerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  sync(jobs: VideoGenerationJobInfo[]): void {
    if (this.disposed) return;
    const activeIds = new Set(
      jobs
        .filter(
          (job) =>
            (job.status === 'polling' || job.status === 'downloading') &&
            Boolean(job.providerTaskId),
        )
        .map((job) => job.id),
    );
    for (const jobId of this.jobs.keys()) {
      if (!activeIds.has(jobId)) this.stop(jobId);
    }
    for (const job of jobs) {
      if (!['polling', 'downloading'].includes(job.status) || !job.providerTaskId) continue;
      const existing = this.jobs.get(job.id);
      if (existing) {
        existing.job = job;
      } else {
        const scheduled = { job, inFlight: false, transportFailures: 0 };
        this.jobs.set(job.id, scheduled);
        this.schedule(scheduled, 0);
      }
    }
  }

  stop(jobId: string): void {
    const scheduled = this.jobs.get(jobId);
    if (!scheduled) return;
    if (scheduled.timer) clearTimeout(scheduled.timer);
    this.jobs.delete(jobId);
  }

  dispose(): void {
    this.disposed = true;
    for (const jobId of [...this.jobs.keys()]) this.stop(jobId);
  }

  private schedule(scheduled: ScheduledJob, delayMs: number): void {
    if (this.disposed || scheduled.timer) return;
    scheduled.timer = setTimeout(
      () => {
        scheduled.timer = undefined;
        void this.run(scheduled);
      },
      Math.max(0, delayMs),
    );
  }

  private async run(scheduled: ScheduledJob): Promise<void> {
    if (this.disposed || this.jobs.get(scheduled.job.id) !== scheduled || scheduled.inFlight)
      return;
    const deadline = scheduled.job.metadata.pollDeadlineAt
      ? Date.parse(scheduled.job.metadata.pollDeadlineAt)
      : Number.POSITIVE_INFINITY;
    if (scheduled.job.status === 'polling' && Number.isFinite(deadline) && deadline <= this.now()) {
      scheduled.inFlight = true;
      let terminal = false;
      try {
        const timedOut = await this.dependencies.timeout(scheduled.job);
        if (this.jobs.get(scheduled.job.id) !== scheduled) return;
        this.dependencies.onUpdate(timedOut);
        this.dependencies.onTerminal(timedOut);
        terminal = true;
      } catch (error) {
        this.dependencies.onTransientError(scheduled.job, error);
        this.schedule(scheduled, BASE_DELAY_MS);
      } finally {
        scheduled.inFlight = false;
        if (terminal && this.jobs.get(scheduled.job.id) === scheduled) {
          this.stop(scheduled.job.id);
        }
      }
      return;
    }
    if (scheduled.job.status === 'downloading') {
      scheduled.inFlight = true;
      try {
        const refreshed = await this.dependencies.refresh(scheduled.job);
        if (this.jobs.get(scheduled.job.id) !== scheduled) return;
        scheduled.job = refreshed;
        this.dependencies.onUpdate(refreshed);
        if (refreshed.status === 'downloading') {
          this.schedule(scheduled, BASE_DELAY_MS);
        } else {
          this.dependencies.onTerminal(refreshed);
          this.stop(refreshed.id);
        }
      } catch (error) {
        if (this.jobs.get(scheduled.job.id) !== scheduled) return;
        this.dependencies.onTransientError(scheduled.job, error);
        this.schedule(scheduled, BASE_DELAY_MS);
      } finally {
        scheduled.inFlight = false;
      }
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

    scheduled.inFlight = true;
    this.activeRequests += 1;
    this.lastRequestAt = this.now();
    try {
      const response = await this.dependencies.poll(scheduled.job);
      if (this.jobs.get(scheduled.job.id) !== scheduled) return;
      const observed = await this.dependencies.observe(scheduled.job, response);
      if (this.jobs.get(scheduled.job.id) !== scheduled) return;
      scheduled.job = observed;
      scheduled.transportFailures = 0;
      this.dependencies.onUpdate(observed);
      if (observed.status === 'polling') {
        this.schedule(scheduled, nextDelay(observed.metadata.pollAttempts, this.random));
      } else if (observed.status === 'downloading') {
        this.schedule(scheduled, BASE_DELAY_MS);
      } else {
        this.dependencies.onTerminal(observed);
        this.stop(observed.id);
      }
    } catch (error) {
      if (this.jobs.get(scheduled.job.id) !== scheduled) return;
      scheduled.transportFailures += 1;
      this.dependencies.onTransientError(scheduled.job, error);
      this.schedule(
        scheduled,
        nextDelay(scheduled.job.metadata.pollAttempts + scheduled.transportFailures, this.random),
      );
    } finally {
      scheduled.inFlight = false;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }
}

export function nextDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, random())));
  return exponential + jitter;
}
