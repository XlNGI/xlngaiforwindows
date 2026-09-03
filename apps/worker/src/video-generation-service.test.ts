import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@ai-video/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import {
  VideoGenerationService,
  type VideoCreditPricingResolver,
} from './video-generation-service.js';

const roots: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const project of projects.splice(0)) project.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  storageCapacityCheck?: (directoryPath: string, requiredBytes: number) => void,
  pricingResolver?: VideoCreditPricingResolver,
) {
  const base = await mkdtemp(join(tmpdir(), 'ai-video-video-'));
  roots.push(base);
  const project = new ProjectService({ recentProjectsPath: join(base, 'recent.json') });
  projects.push(project);
  project.create(join(base, 'project'), 'Video Project');
  return {
    project,
    service: new VideoGenerationService(project, storageCapacityCheck, pricingResolver),
  };
}

function prepare(service: VideoGenerationService) {
  return service.prepare({
    adapterKey: 'START_END_TO_VIDEO:vidu:viduq3-pro:v2',
    parameters: {
      images: ['https://example.invalid/start.png', 'https://example.invalid/end.png'],
      prompt: 'slow camera move',
      duration: 5,
      resolution: '720p',
      audio: true,
    },
    assetKind: 'shot-video',
    providerRegion: 'global',
    providerProfileId: '11111111-1111-4111-8111-111111111111',
    modelId: 'viduq3-pro',
  });
}

function mp4Response(): Response {
  return new Response(
    new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
    { status: 200, headers: { 'content-type': 'video/mp4' } },
  );
}

describe('VideoGenerationService', () => {
  it('redacts local image Data URLs from the durable video request', async () => {
    const { project, service } = await setup();
    const localImage = 'DATA:image/png;base64,iVBORw0KGgo=';
    const job = service.prepare({
      adapterKey: 'IMAGE_TO_VIDEO:vidu:viduq3-pro:v2',
      parameters: {
        images: [localImage, localImage],
        duration: 5,
        resolution: '720p',
        audio: true,
      },
      providerRegion: 'cn',
    });

    expect(job.request.images).toEqual(['local-image://omitted', 'local-image://omitted']);
    project.access(false, (database) => {
      const row = database
        .prepare('SELECT request_json, task_snapshot_json FROM generation_jobs WHERE id = ?')
        .get(job.id) as { request_json: string; task_snapshot_json: string };
      expect(row.request_json).not.toContain('iVBORw0KGgo=');
      expect(JSON.parse(row.task_snapshot_json)).toMatchObject({
        capability: 'video',
        adapterKey: 'IMAGE_TO_VIDEO:vidu:viduq3-pro:v2',
        schemaVersion: 1,
        providerRegion: 'cn',
        parameters: { images: ['local-image://omitted', 'local-image://omitted'] },
      });
    });
  });

  it('accepts only validated video adapters', async () => {
    const { service } = await setup();
    expect(() =>
      service.prepare({
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
        providerRegion: 'global',
      }),
    ).toThrow('Video generation adapter was not found.');
    expect(() =>
      service.prepare({
        adapterKey: 'START_END_TO_VIDEO:vidu:viduq3-pro:v2',
        parameters: { images: [], duration: 99, resolution: '720p', audio: true },
        providerRegion: 'global',
      }),
    ).toThrow('Video generation parameters are invalid.');
    expect(
      service.prepare({
        adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
        parameters: {
          prompt: 'slow camera move through a misty street',
          duration: 5,
          aspect_ratio: '16:9',
          resolution: '720p',
          audio: true,
        },
        providerRegion: 'cn',
      }),
    ).toMatchObject({ status: 'pending', adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2' });
    expect(
      service.prepare({
        adapterKey: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
        parameters: { prompt: 'slow camera move', duration: 5, ratio: '16:9' },
        providerRegion: 'unicompapi',
        providerProfileId: '11111111-1111-4111-8111-111111111111',
        modelId: 'kling-v3-turbo',
      }),
    ).toMatchObject({
      status: 'pending',
      adapterKey: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
      metadata: { providerRegion: 'unicompapi', modelId: 'kling-v3-turbo' },
    });
  });

  it('persists the provider task id and polling state atomically and idempotently', async () => {
    const { project, service } = await setup();
    const job = prepare(service);
    const attached = service.attachTask({ jobId: job.id, providerTaskId: 'provider-task-1' });

    expect(attached).toMatchObject({
      status: 'polling',
      providerTaskId: 'provider-task-1',
      metadata: {
        providerProfileId: '11111111-1111-4111-8111-111111111111',
        modelId: 'viduq3-pro',
        pollAttempts: 0,
        providerState: 'submitted',
      },
    });
    expect(service.attachTask({ jobId: job.id, providerTaskId: 'provider-task-1' })).toMatchObject({
      id: attached.id,
      status: 'polling',
      providerTaskId: 'provider-task-1',
      metadata: { providerState: 'submitted', pollAttempts: 0 },
    });
    expect(() => service.attachTask({ jobId: job.id, providerTaskId: 'provider-task-2' })).toThrow(
      'already bound',
    );
    project.access(false, (database) => {
      expect(
        database
          .prepare('SELECT provider_task_id, status FROM generation_jobs WHERE id = ?')
          .get(job.id),
      ).toMatchObject({ provider_task_id: 'provider-task-1', status: 'polling' });
    });
  });

  it('freezes the selected Provider profile, region, and model in the task snapshot', async () => {
    const { project, service } = await setup();
    const job = prepare(service);

    project.access(false, (database) => {
      const row = database
        .prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id = ?')
        .get(job.id) as { task_snapshot_json: string };
      expect(JSON.parse(row.task_snapshot_json)).toMatchObject({
        capability: 'video',
        providerProfileId: '11111111-1111-4111-8111-111111111111',
        providerRegion: 'global',
        modelId: 'viduq3-pro',
      });
    });
  });

  it('keeps retryable poll failures active and records bounded observation metadata', async () => {
    const { service } = await setup();
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });

    const retrying = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 429,
      providerBody: { state: 'queueing', token: 'must-not-persist' },
    });

    expect(retrying).toMatchObject({
      status: 'polling',
      metadata: { pollAttempts: 1, providerState: 'retryable-http-429' },
    });
    expect(JSON.stringify(retrying)).not.toContain('must-not-persist');
  });

  it('keeps standard in_progress video states active', async () => {
    const { service } = await setup();
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });

    const retrying = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: { status: 'in_progress' },
    });

    expect(retrying).toMatchObject({
      status: 'polling',
      providerTaskId: 'provider-task',
      metadata: { pollAttempts: 1, providerState: 'in_progress' },
    });
  });

  it('keeps UniCompAPI unknown video states active while other providers fail closed', async () => {
    const { service } = await setup();
    const unicompJob = service.prepare({
      adapterKey: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
      parameters: { prompt: 'slow camera move', duration: 5, ratio: '16:9' },
      providerRegion: 'unicompapi',
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      modelId: 'kling-v3-turbo',
    });
    service.attachTask({ jobId: unicompJob.id, providerTaskId: 'unicomp-task' });

    const retrying = service.observe({
      jobId: unicompJob.id,
      providerTaskId: 'unicomp-task',
      providerStatus: 200,
      providerBody: { status: 'unknown' },
    });

    expect(retrying).toMatchObject({
      status: 'polling',
      providerTaskId: 'unicomp-task',
      metadata: { pollAttempts: 1, providerState: 'unknown' },
    });

    const otherJob = prepare(service);
    service.attachTask({ jobId: otherJob.id, providerTaskId: 'vidu-task' });
    const failed = service.observe({
      jobId: otherJob.id,
      providerTaskId: 'vidu-task',
      providerStatus: 200,
      providerBody: { status: 'unknown' },
    });

    expect(failed).toMatchObject({ status: 'failed', metadata: { failureKind: 'provider' } });
    expect(failed.error).toBe('Provider returned unsupported video task state: unknown.');
  });

  it('downloads only creation video output and commits one local asset and terminal job', async () => {
    const { project, service } = await setup(undefined, {
      resolveCreditPricing: () => ({ currency: 'CNY', creditPrice: '0.03125' }),
    });
    const signedOutput = 'https://cdn.example.invalid/output.mp4?signature=must-not-persist';
    const fetchMock = vi.fn(() => Promise.resolve(mp4Response()));
    vi.stubGlobal('fetch', fetchMock);
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });

    const downloading = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: {
        state: 'success',
        input: { images: ['https://example.invalid/input.png'] },
        creations: [{ cover_url: 'https://example.invalid/cover.png', url: signedOutput }],
        credits: '4',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      signedOutput,
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(downloading).toMatchObject({
      status: 'downloading',
      metadata: {
        pollAttempts: 1,
        cost: {
          amount: 4,
          unit: 'credits',
          unitPrice: '0.03125',
          estimatedAmount: '0.125',
          currency: 'CNY',
        },
      },
      results: [],
    });
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('succeeded'));
    const completed = service.get(job.id);
    expect(completed).toMatchObject({
      status: 'succeeded',
      metadata: {
        pollAttempts: 1,
        cost: {
          amount: 4,
          unit: 'credits',
          unitPrice: '0.03125',
          estimatedAmount: '0.125',
          currency: 'CNY',
        },
      },
      results: [{ asset: { kind: 'shot-video' } }],
    });
    const asset = completed.results[0]!.asset;
    expect(asset.sourceUrl).toBeUndefined();
    expect(asset.relativePath).toMatch(/^assets[\\/]videos[\\/].+\.mp4$/);
    expect(existsSync(join(project.current()!.rootPath, asset.relativePath))).toBe(true);
    project.access(false, (database) => {
      const bytes = database.serialize();
      expect(bytes.includes(Buffer.from('must-not-persist'))).toBe(false);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM generation_results WHERE job_id = ?')
          .get(job.id),
      ).toMatchObject({ count: 1 });
    });
    const assetService = new ImageGenerationService(
      project,
      () => undefined,
      () => undefined,
    );
    expect(
      assetService.renameAsset({ assetId: asset.id, name: 'edited.mp4' }).relativePath,
    ).toMatch(/^assets[\\/]videos[\\/]edited\.mp4$/);
    const repeated = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: { state: 'success', creations: [{ url: signedOutput }] },
    });
    expect(repeated).toMatchObject({
      status: 'succeeded',
      results: [{ id: completed.results[0]!.id }],
    });
    expect(repeated.results[0]!.asset.relativePath).toMatch(/^assets[\\/]videos[\\/]edited\.mp4$/);
    expect(repeated.results).toHaveLength(1);
  });

  it('consumes and removes an authenticated native UniCompAPI video download', async () => {
    const { service } = await setup();
    const nativeDirectory = join(tmpdir(), 'ai-video-workspace-unicompapi');
    mkdirSync(nativeDirectory, { recursive: true });
    const nativePath = join(nativeDirectory, `test-${process.pid}-${Date.now()}.mp4`);
    writeFileSync(
      nativePath,
      new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
    );
    const job = service.prepare({
      adapterKey: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
      parameters: { prompt: 'camera push', duration: 5 },
      providerRegion: 'unicompapi',
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      modelId: 'kling-v3-turbo',
    });
    service.attachTask({ jobId: job.id, providerTaskId: 'unicomp-task' });

    const downloading = service.observe({
      jobId: job.id,
      providerTaskId: 'unicomp-task',
      providerStatus: 200,
      providerBody: { status: 'completed', nativeVideoFilePath: nativePath },
    });

    expect(downloading.status).toBe('downloading');
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('succeeded'));
    expect(existsSync(nativePath)).toBe(false);
    expect(service.get(job.id)).toMatchObject({
      status: 'succeeded',
      metadata: { providerRegion: 'unicompapi' },
      results: [{ asset: { kind: 'shot-video' } }],
    });
  });

  it('fails success without a video URL and never treats the input image as output', async () => {
    const { service } = await setup();
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });

    const failed = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: {
        state: 'success',
        input: { images: ['https://example.invalid/input.png'] },
        creations: [{ cover_url: 'https://example.invalid/cover.png' }],
      },
    });

    expect(failed).toMatchObject({ status: 'failed', metadata: { failureKind: 'provider' } });
    expect(failed.error).toContain('without a video output URL');
    expect(service.list()[0]?.results).toHaveLength(0);
  });

  it('rejects an oversized video from Content-Length without creating a partial asset', async () => {
    const { project, service } = await setup();
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-large-video' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(new Uint8Array(), {
            status: 200,
            headers: {
              'content-type': 'video/mp4',
              'content-length': String(512 * 1024 * 1024 + 1),
            },
          }),
        ),
      ),
    );

    const observation = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-large-video',
      providerStatus: 200,
      providerBody: {
        state: 'success',
        creations: [{ video_url: 'https://example.com/large.mp4' }],
      },
    });
    expect(observation.status).toBe('downloading');
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('failed'));

    const failed = service.get(job.id);
    expect(failed.error).toContain('512 MiB limit');
    expect(failed.results).toEqual([]);
    expect(readdirSync(join(project.current()!.rootPath, 'assets', 'videos'))).toEqual([]);
  });

  it('checks actual streamed bytes when Content-Length is absent', async () => {
    const storageCapacityCheck = vi.fn((_directoryPath: string, requiredBytes: number) => {
      if (requiredBytes > 0) throw new Error('Insufficient disk space for media output.');
    });
    const { project, service } = await setup(storageCapacityCheck);
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-chunked-video' });
    const response = mp4Response();
    expect(response.headers.get('content-length')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)),
    );

    const observation = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-chunked-video',
      providerStatus: 200,
      providerBody: {
        state: 'success',
        creations: [{ video_url: 'https://example.com/chunked.mp4' }],
      },
    });
    expect(observation.status).toBe('downloading');
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('failed'));

    expect(storageCapacityCheck).toHaveBeenCalledWith(expect.any(String), 16);
    expect(service.get(job.id).error).toContain('Insufficient disk space');
    expect(readdirSync(join(project.current()!.rootPath, 'assets', 'videos'))).toEqual([]);
  });

  it('does not commit a video cancelled while the download is pending', async () => {
    const { project, service } = await setup();
    let resolveFetch: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });

    const observation = service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: {
        state: 'success',
        creations: [{ url: 'https://cdn.example.invalid/output.mp4' }],
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    service.cancel(job.id);
    resolveFetch(mp4Response());

    expect(observation).toMatchObject({ status: 'downloading', results: [] });
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('cancelled'));
    await vi.waitFor(() =>
      expect(
        readdirSync(join(project.current()!.rootPath, 'assets', 'videos')).filter((name) =>
          name.endsWith('.tmp'),
        ),
      ).toEqual([]),
    );
    expect(service.list()[0]?.status).toBe('cancelled');
  });

  it('isolates and cleans a background download when the project changes', async () => {
    const { project, service } = await setup();
    const originalRoot = project.current()!.rootPath;
    let resolveFetch: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });
    service.observe({
      jobId: job.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: {
        state: 'success',
        creations: [{ url: 'https://cdn.example.invalid/output.mp4' }],
      },
    });

    service.cancelAll();
    project.create(join(originalRoot, '..', 'other-project'), 'Other Project');
    resolveFetch(mp4Response());

    await vi.waitFor(() =>
      expect(
        readdirSync(join(originalRoot, 'assets', 'videos')).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]),
    );
    expect(service.list()).toEqual([]);
    project.open(originalRoot);
    expect(service.recoverInterrupted()).toBe(1);
    expect(service.get(job.id)).toMatchObject({ status: 'polling', results: [] });
  });

  it('preserves submitted jobs for restart polling and fails unsubmitted jobs', async () => {
    const { project, service } = await setup();
    const rootPath = project.current()!.rootPath;
    const pending = prepare(service);
    const attached = prepare(service);
    const downloading = prepare(service);
    service.attachTask({ jobId: attached.id, providerTaskId: 'provider-task' });
    service.attachTask({ jobId: downloading.id, providerTaskId: 'provider-download-task' });
    project.access(true, (database) => {
      const repositories = createRepositories(database);
      const current = repositories.jobs.get(downloading.id)!;
      repositories.jobs.save({ ...current, status: 'downloading' });
      const pendingCurrent = repositories.jobs.get(pending.id)!;
      repositories.jobs.save({ ...pendingCurrent, adapterKey: 'removed-adapter:v1' });
    });
    project.close();
    project.open(rootPath);
    const videoDirectory = join(rootPath, 'assets', 'videos');
    const staleTemporary = join(videoDirectory, '.00000000-0000-0000-0000-000000000000.999.tmp');
    const retainedFile = join(videoDirectory, 'keep.tmp');
    writeFileSync(staleTemporary, 'stale');
    writeFileSync(retainedFile, 'keep');

    expect(service.recoverInterrupted()).toBe(2);
    expect(existsSync(staleTemporary)).toBe(false);
    expect(existsSync(retainedFile)).toBe(true);
    expect(service.get(pending.id)).toMatchObject({
      status: 'failed',
      metadata: { failureKind: 'interrupted' },
    });
    expect(service.get(attached.id)).toMatchObject({
      status: 'polling',
      providerTaskId: 'provider-task',
    });
    expect(service.get(downloading.id)).toMatchObject({
      status: 'polling',
      providerTaskId: 'provider-download-task',
    });
    project.access(false, (database) => {
      const events = createRepositories(database).generationJobEvents;
      expect(events.listByJob(pending.id).at(-1)).toMatchObject({
        phase: 'fail',
        status: 'failed',
      });
      expect(events.listByJob(attached.id).at(-1)).toMatchObject({
        phase: 'submit',
        status: 'polling',
      });
      expect(events.listByJob(downloading.id).at(-1)).toMatchObject({
        phase: 'poll',
        status: 'polling',
      });
    });
    expect(service.recoverInterrupted()).toBe(0);
  });

  it('pauses, resumes with an extended deadline, times out, and keeps terminal state stable', async () => {
    const { project, service } = await setup();
    const job = prepare(service);
    service.attachTask({ jobId: job.id, providerTaskId: 'provider-task' });
    const paused = service.pause(job.id);
    expect(paused.status).toBe('paused');
    const resumed = service.resume(job.id);
    expect(resumed.status).toBe('polling');

    project.access(true, (database) => {
      const repositories = createRepositories(database);
      const current = repositories.jobs.get(job.id)!;
      const metadata = JSON.parse(current.metadataJson!) as Record<string, unknown>;
      repositories.jobs.save({
        ...current,
        metadataJson: JSON.stringify({ ...metadata, pollDeadlineAt: '2000-01-01T00:00:00.000Z' }),
      });
    });
    const timedOut = service.timeout(job.id);
    expect(timedOut).toMatchObject({
      status: 'timed-out',
      metadata: { failureKind: 'timeout' },
    });
    expect(service.cancel(job.id)).toMatchObject({
      id: timedOut.id,
      status: 'timed-out',
      metadata: { failureKind: 'timeout' },
    });
  });
});
