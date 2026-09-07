import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@ai-video/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from './project-service.js';
import { nextProjectTaskDelay, ProjectTaskRuntime } from './project-task-runtime.js';
import { VideoGenerationService } from './video-generation-service.js';

const roots: string[] = [];
const projects: ProjectService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const project of projects.splice(0)) project.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'project-task-runtime-'));
  roots.push(root);
  const projectsService = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  projects.push(projectsService);
  projectsService.create(join(root, 'project'), 'Project task runtime');
  const videos = new VideoGenerationService(projectsService);
  const request =
    vi.fn<(method: string, params: unknown, timeoutMs?: number) => Promise<unknown>>();
  const runtime = new ProjectTaskRuntime(projectsService, videos, { request }, { random: () => 0 });
  return { root, projectsService, videos, request, runtime };
}

function attach(videos: VideoGenerationService, suffix = '1') {
  const job = videos.prepare({
    adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
    parameters: {
      prompt: `camera move ${suffix}`,
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      audio: true,
    },
    providerRegion: 'global',
    providerProfileId: '11111111-1111-4111-8111-111111111111',
    modelId: 'viduq3-pro',
  });
  return videos.attachTask({ jobId: job.id, providerTaskId: `provider-${suffix}` });
}

function attachUnicomp(videos: VideoGenerationService) {
  const job = videos.prepare({
    adapterKey: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
    parameters: { prompt: 'camera push', duration: 5, ratio: '16:9' },
    providerRegion: 'unicompapi',
    providerProfileId: '11111111-1111-4111-8111-111111111111',
    modelId: 'kling-v3-turbo',
  });
  return videos.attachTask({ jobId: job.id, providerTaskId: 'unicomp-task' });
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function runningPoll(providerStatus = 200, retryAfterMs?: number) {
  return {
    providerStatus,
    state: 'running' as const,
    providerState: 'processing',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

describe('ProjectTaskRuntime', () => {
  it('polls persisted jobs without a Desktop page owner and publishes revisioned snapshots', async () => {
    const { projectsService, videos, request, runtime } = await setup();
    const job = attach(videos);
    request.mockResolvedValue(runningPoll());

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledWith(
      'provider.media.poll',
      expect.objectContaining({
        projectSessionId: projectsService.currentSessionId(),
        providerTaskId: job.providerTaskId,
      }),
      600_000,
    );
    expect(runtime.snapshot(-1)).toMatchObject({
      changed: true,
      activeCount: 1,
      videoJobs: [{ id: job.id, status: 'polling', metadata: { pollAttempts: 1 } }],
    });
    const revision = runtime.snapshot().revision;
    expect(runtime.snapshot(revision).changed).toBe(false);
  });

  it('enforces global spacing and concurrency limits across jobs', async () => {
    const { videos, request, runtime } = await setup();
    attach(videos, '1');
    attach(videos, '2');
    attach(videos, '3');
    const pending: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(2);

    pending[0]!({
      providerStatus: 400,
      state: 'failed',
      error: { message: 'terminal fixture', retryable: false },
    });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('waits for Provider Retry-After before polling again', async () => {
    const { videos, request, runtime } = await setup();
    attach(videos);
    request.mockResolvedValueOnce(runningPoll(429, 10_000)).mockResolvedValue(runningPoll());

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Native returns an unnormalized Provider body', async () => {
    const { videos, request, runtime } = await setup();
    const job = attach(videos);
    request.mockResolvedValue({
      providerStatus: 200,
      state: 'succeeded',
      body: {
        creations: [{ url: 'https://cdn.example/video.mp4?X-Amz-Signature=secret' }],
      },
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(videos.get(job.id)).toMatchObject({
      status: 'failed',
      metadata: { failureKind: 'transport' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it('ignores a late Native result after the project session changes', async () => {
    const { root, projectsService, videos, request, runtime } = await setup();
    attach(videos);
    let resolvePoll: (value: unknown) => void = () => undefined;
    request.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const observe = vi.spyOn(videos, 'observe');

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    projectsService.close();
    projectsService.create(join(root, 'next-project'), 'Next project');
    resolvePoll(runningPoll());
    await flushAsyncWork();

    expect(observe).not.toHaveBeenCalled();
  });

  it('does not release the new session concurrency budget for a late old-session request', async () => {
    const { root, projectsService, videos, request, runtime } = await setup();
    attach(videos, 'old');
    const pending: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    projectsService.close();
    projectsService.create(join(root, 'next-project'), 'Next project');
    attach(videos, 'new-1');
    attach(videos, 'new-2');
    attach(videos, 'new-3');
    runtime.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(3);

    pending[0]!(runningPoll());
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(500);

    expect(request).toHaveBeenCalledTimes(3);
    runtime.stop();
  });

  it('resumes a persisted Provider task when a project is reopened', async () => {
    const { projectsService, videos, request, runtime } = await setup();
    const rootPath = projectsService.current()!.rootPath;
    const job = attach(videos);
    projectsService.close();
    projectsService.open(rootPath);
    expect(videos.recoverInterrupted()).toBe(0);
    request.mockResolvedValue(runningPoll());

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledWith(
      'provider.media.poll',
      expect.objectContaining({ providerTaskId: job.providerTaskId }),
      600_000,
    );
    expect(videos.get(job.id)).toMatchObject({ status: 'polling', providerTaskId: 'provider-1' });
  });

  it('commits one asset from a Native UniCompAPI file and remains idempotent', async () => {
    const { projectsService, videos, request, runtime } = await setup();
    const job = attachUnicomp(videos);
    const nativeDirectory = join(tmpdir(), 'ai-video-workspace-unicompapi');
    mkdirSync(nativeDirectory, { recursive: true });
    const nativePath = join(nativeDirectory, `runtime-${process.pid}-${Date.now()}.mp4`);
    writeFileSync(
      nativePath,
      new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
    );
    request.mockResolvedValue({
      providerStatus: 200,
      state: 'succeeded',
      providerState: 'completed',
      output: {
        type: 'native_temporary_file',
        path: nativePath,
        contentType: 'video/mp4',
      },
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(videos.get(job.id).status).toBe('succeeded'));
    runtime.kick();
    await vi.advanceTimersByTimeAsync(5_000);

    const completed = videos.get(job.id);
    expect(existsSync(nativePath)).toBe(false);
    expect(completed.results).toHaveLength(1);
    projectsService.access(false, (database) => {
      const repositories = createRepositories(database);
      expect(repositories.generationResults.listByJob(job.id)).toHaveLength(1);
      expect(repositories.assets.listByProject(job.projectId)).toHaveLength(1);
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('commits a Native-normalized Vidu WebM output without exposing its signed URL', async () => {
    const { projectsService, videos, request, runtime } = await setup();
    const job = attach(videos, 'vidu-webm');
    const nativeDirectory = join(tmpdir(), 'ai-video-workspace-unicompapi');
    mkdirSync(nativeDirectory, { recursive: true });
    const nativePath = join(nativeDirectory, `runtime-${process.pid}-${Date.now()}.webm`);
    writeFileSync(nativePath, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
    request.mockResolvedValue({
      providerStatus: 200,
      state: 'succeeded',
      providerState: 'success',
      cost: { amount: 4, unit: 'credits' },
      output: {
        type: 'native_temporary_file',
        path: nativePath,
        contentType: 'video/webm',
      },
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(videos.get(job.id).status).toBe('succeeded'));

    const completed = videos.get(job.id);
    expect(completed.metadata.cost).toMatchObject({ amount: 4, unit: 'credits' });
    expect(completed.results[0]?.asset.relativePath).toMatch(/\.webm$/);
    expect(existsSync(nativePath)).toBe(false);
    projectsService.access(false, (database) => {
      const repositories = createRepositories(database);
      expect(repositories.assets.listByProject(job.projectId)).toHaveLength(1);
    });
  });

  it('removes paused and cancelled jobs from scheduled work', async () => {
    const { videos, request, runtime } = await setup();
    const paused = attach(videos, 'paused');
    videos.pause(paused.id);
    request.mockResolvedValue(runningPoll());

    runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).not.toHaveBeenCalled();

    videos.resume(paused.id);
    runtime.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    videos.cancel(paused.id);
    runtime.kick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(runtime.snapshot().activeCount).toBe(0);
  });
});

describe('nextProjectTaskDelay', () => {
  it('applies bounded jitter and Retry-After', () => {
    expect(nextProjectTaskDelay(1, undefined, () => 0)).toBe(2_000);
    expect(nextProjectTaskDelay(2, undefined, () => 1)).toBe(5_000);
    expect(nextProjectTaskDelay(1, 10_000, () => 0)).toBe(10_000);
    expect(nextProjectTaskDelay(99, 60_000, () => 1)).toBe(60_000);
    expect(nextProjectTaskDelay(99, 3_600_000, () => 1)).toBe(1_800_000);
  });
});
