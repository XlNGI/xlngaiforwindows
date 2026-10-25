import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MediaModelSelectionSnapshot,
  ProviderModelInfo,
  ProviderProfileInfo,
  SidecarEnvelope,
} from '@ai-video/contracts';
import { getAdapter } from '@ai-video/generation-adapters';
import { createRepositories } from '@ai-video/persistence';
import type { AppSettingsService } from './app-settings-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { MediaOrchestrationService } from './media-orchestration-service.js';
import { NativeProviderRequestError, NativeProviderBridge } from './native-provider-bridge.js';
import { ProjectService } from './project-service.js';
import { VideoGenerationService } from './video-generation-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import { TaskScheduleService } from './task-schedule-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectTaskRuntime } from './project-task-runtime.js';

const roots: string[] = [];
const projects: ProjectService[] = [];
const providerProfileId = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(scheduled = false, schedulingEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'media-orchestration-'));
  roots.push(root);
  const projectsService = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  projects.push(projectsService);
  const project = projectsService.create(join(root, 'project'), 'Media orchestration');
  const images = new ImageGenerationService(projectsService);
  const videos = new VideoGenerationService(projectsService);
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>();
  const profile: ProviderProfileInfo = {
    id: providerProfileId,
    name: 'Selected Provider',
    category: 'multi',
    providerType: 'vidu',
    accessType: 'official',
    protocol: 'vidu-v2',
    baseUrl: 'https://api.vidu.com',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  };
  const models: ProviderModelInfo[] = [
    providerModel('image-model', 'viduq2', 'Selected Image Model', 'image'),
    providerModel('video-model', 'viduq3-pro', 'Selected Video Model', 'video'),
  ];
  const settings = {
    getProfile: () => profile,
    listModels: () => models,
    listModelPricing: () => [],
  } as unknown as AppSettingsService;
  const adapterLookup: { resolve: typeof getAdapter } = { resolve: getAdapter };
  const scheduler = new TaskScheduleService(projectsService, { enabled: schedulingEnabled });
  const service = new MediaOrchestrationService(
    projectsService,
    settings,
    images,
    videos,
    {
      request,
    } as unknown as NativeProviderBridge,
    (key) => adapterLookup.resolve(key),
    scheduled ? scheduler : undefined,
  );
  return {
    root,
    project,
    projectsService,
    images,
    videos,
    request,
    service,
    profile,
    models,
    adapterLookup,
    settings,
    scheduler,
  };
}

function providerModel(
  id: string,
  remoteModelId: string,
  displayName: string,
  kind: 'image' | 'video',
): ProviderModelInfo {
  return {
    id,
    providerProfileId,
    remoteModelId,
    displayName,
    capabilities: {
      text: false,
      vision: false,
      streaming: false,
      reasoning: false,
      tools: false,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: kind === 'image',
      videoGeneration: kind === 'video',
    },
    source: 'built-in',
    enabled: true,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  };
}

const imageSelection: MediaModelSelectionSnapshot = {
  providerProfileId,
  providerType: 'vidu',
  providerBaseUrlCategory: 'official-vidu-global',
  providerRegion: 'global',
  modelId: 'image-model',
  remoteModelId: 'viduq2',
  adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
  adapterSchemaVersion: 1,
  adapterSchemaSource: 'official-adapter',
};

const videoSelection: MediaModelSelectionSnapshot = {
  ...imageSelection,
  modelId: 'video-model',
  remoteModelId: 'viduq3-pro',
  adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
};

function prepareImage(images: ImageGenerationService) {
  return images.prepare({
    adapterKey: imageSelection.adapterKey,
    parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    providerProfileId,
    modelId: imageSelection.modelId,
    mediaModelSelection: imageSelection,
  });
}

function prepareVideo(videos: VideoGenerationService) {
  return videos.prepare({
    adapterKey: videoSelection.adapterKey,
    parameters: {
      prompt: 'camera move',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      audio: true,
    },
    providerRegion: 'global',
    providerProfileId,
    modelId: videoSelection.modelId,
    mediaModelSelection: videoSelection,
  });
}

describe('MediaOrchestrationService', () => {
  it('stores confirmed prop generation under the source document type and preserves gallery lookup', async () => {
    const f = await setup();
    const prop = new ContentService(f.projectsService).saveDocument({
      kind: 'prop',
      title: '铁木杖',
      contentMarkdown: '铁箍杖尖',
    });
    const job = f.images.prepare({
      adapterKey: imageSelection.adapterKey,
      parameters: { prompt: '铁木杖', aspect_ratio: '16:9', resolution: '1080p' },
      sourceDocumentId: prop.id,
      assetKind: 'prop',
      providerProfileId,
      modelId: imageSelection.modelId,
      mediaModelSelection: imageSelection,
    });
    f.request.mockResolvedValue({
      status: 200,
      body: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });
    const pending = f.service.requestSubmission({ jobId: job.id });
    const completed = await f.service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(completed.job).toMatchObject({ status: 'succeeded' });
    expect(completed.job.results[0]?.asset).toMatchObject({ kind: 'prop' });
    expect(f.images.listAssets({ sourceDocumentId: prop.id })).toMatchObject([
      { id: completed.job.results[0]?.asset?.id, kind: 'prop' },
    ]);
  });

  it('submits the frozen final form after saved production notes change during paid confirmation', async () => {
    const f = await setup();
    const content = new ContentService(f.projectsService);
    const scene = content.saveScene({ title: '铁匠铺' });
    const shot = content.saveShot({ sceneId: scene.id, title: '拒绝' });
    const target = { kind: 'shot' as const, id: shot.id };
    const production = new ProductionService(f.projectsService);
    content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: shot.title,
      expectedRowVersion: shot.rowVersion,
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '原制作说明',
        timing: { estimatedDurationSeconds: 20, rationale: '剧情时长' },
      },
    });
    const parameters = {
      prompt: '江晚继续打铁，老瞎子走入雾中',
      duration: 5,
      aspect_ratio: '9:16',
      resolution: '720p',
      audio: true,
    };
    const job = f.videos.prepare({
      adapterKey: videoSelection.adapterKey,
      shotId: shot.id,
      productionSource: production.compile({ target, adapterKey: videoSelection.adapterKey })
        .source!,
      parameters,
      providerRegion: 'global',
      providerProfileId,
      modelId: videoSelection.modelId,
      mediaModelSelection: videoSelection,
    });
    const pending = f.service.requestSubmission({ jobId: job.id });
    expect(f.request).not.toHaveBeenCalled();
    content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: shot.title,
      prompt: '另行修订的沈孤鸿剧情',
      expectedRowVersion: production.read(target).rowVersion,
    });
    f.request.mockResolvedValue({ status: 200, taskId: 'final-form-task' });
    await f.service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.request.mock.calls[0])).toContain(parameters.prompt);
    expect(JSON.stringify(f.request.mock.calls[0])).not.toContain('沈孤鸿');
    expect(f.videos.get(job.id)).toMatchObject({
      providerTaskId: 'final-form-task',
      request: parameters,
    });
  });

  it('coalesces duplicate confirmed requests into one execution and one paid submission', async () => {
    const f = await setup(true);
    const job = prepareVideo(f.videos);
    const confirmation = f.service.requestSubmission({ jobId: job.id }).confirmation!;
    let finish!: (value: unknown) => void;
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const params = {
      jobId: job.id,
      confirmationToken: confirmation.confirmationToken,
      approved: true,
    };
    const first = f.service.confirmSubmission(params);
    const duplicate = f.service.confirmSubmission(params);
    await expect(
      f.service.confirmSubmission({ ...params, confirmationToken: 'wrong-token' }),
    ).rejects.toThrow('confirmation');
    expect(f.request).toHaveBeenCalledOnce();
    finish({ status: 200, taskId: 'same-remote-task' });
    const results = await Promise.all([first, duplicate]);
    expect(results[0]).toEqual(results[1]);
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('keeps the existing paid submission path when new scheduling is disabled at startup', async () => {
    const f = await setup(true, false);
    const job = prepareVideo(f.videos);
    const confirmation = f.service.requestSubmission({ jobId: job.id }).confirmation!;
    f.request.mockResolvedValue({ status: 200, taskId: 'legacy-remote' });
    await f.service.confirmSubmission({
      jobId: job.id,
      confirmationToken: confirmation.confirmationToken,
      approved: true,
    });
    expect(f.videos.get(job.id).providerTaskId).toBe('legacy-remote');
    expect(f.scheduler.list()).toEqual([]);
    expect(f.request).toHaveBeenCalledOnce();
    expect(() => f.scheduler.register(job.id)).toThrow('disabled');
  });
  it('releases a dependent confirmed video only after its upstream output is committed locally', async () => {
    const f = await setup(true);
    const upstream = prepareVideo(f.videos);
    const downstream = prepareVideo(f.videos);
    f.scheduler.register(upstream.id);
    f.scheduler.register(downstream.id, [upstream.id]);
    const directory = join(tmpdir(), 'ai-video-workspace-unicompapi');
    await mkdir(directory, { recursive: true });
    const output = join(directory, `schedule-${upstream.id}.mp4`);
    await writeFile(
      output,
      new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
    );
    f.request.mockImplementation((method, params) =>
      Promise.resolve(
        method === 'provider.media.submit'
          ? { status: 200, taskId: `remote-${(params as { operationId: string }).operationId}` }
          : {
              providerStatus: 200,
              state: 'succeeded',
              providerState: 'success',
              output: { type: 'native_temporary_file', path: output, contentType: 'video/mp4' },
            },
      ),
    );
    const approve = (jobId: string) => {
      const confirmation = f.service.requestSubmission({ jobId }).confirmation!;
      return f.service.confirmSubmission({
        jobId,
        confirmationToken: confirmation.confirmationToken,
        approved: true,
      });
    };
    const waiting = approve(downstream.id);
    await expect.poll(() => f.scheduler.get(downstream.id).waitReason).toBe('dependency');
    expect(f.request).not.toHaveBeenCalled();
    await approve(upstream.id);
    const runtime = new ProjectTaskRuntime(
      f.projectsService,
      f.videos,
      { request: f.request },
      { scheduler: f.scheduler },
    );
    try {
      runtime.start();
      const result = await waiting;
      expect(result.job.status).toBe('polling');
      expect(f.videos.get(upstream.id).status).toBe('succeeded');
      const bindings = f.projectsService.access(
        false,
        (db) =>
          db
            .prepare(
              'SELECT asset_id AS assetId, content_hash AS hash FROM task_schedule_artifacts WHERE task_id=?',
            )
            .all(downstream.id) as Array<{ assetId: string; hash: string }>,
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.assetId).toBe(f.videos.get(upstream.id).results[0]!.asset?.id);
      f.images.deleteAsset(bindings[0]!.assetId);
      f.images.purgeAsset(bindings[0]!.assetId, true);
      const history = f.projectsService.access(false, (db) =>
        db
          .prepare(
            'SELECT source_asset_id AS sourceId,asset_id AS assetId FROM task_schedule_artifacts WHERE task_id=?',
          )
          .get(downstream.id),
      );
      expect(history).toEqual({ sourceId: bindings[0]!.assetId, assetId: null });
    } finally {
      runtime.stop();
      await rm(output, { force: true });
    }
  });
  it('runs two confirmed video submissions concurrently, queues the third and cancels it without sending', async () => {
    const f = await setup(true);
    const jobs = Array.from({ length: 3 }, () => prepareVideo(f.videos));
    const confirmations = jobs.map(
      (job) => f.service.requestSubmission({ jobId: job.id }).confirmation!,
    );
    const pending: Array<(value: unknown) => void> = [];
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const runs = confirmations.map((confirmation) =>
      f.service
        .confirmSubmission({
          jobId: confirmation.jobId,
          confirmationToken: confirmation.confirmationToken,
          approved: true,
        })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        ),
    );
    await expect.poll(() => pending.length).toBe(2);
    expect(f.scheduler.get(jobs[2]!.id)).toMatchObject({ waitReason: 'capacity' });
    const logs = new DocumentWorkflowService(f.projectsService).listTaskLog();
    expect(logs.items.find((item) => item.sourceId === jobs[2]!.id)?.scheduling?.waitReason).toBe(
      'capacity',
    );
    await f.service.cancel({ jobId: jobs[2]!.id });
    await expect.poll(() => f.scheduler.get(jobs[2]!.id).domainState).toBe('cancelled');
    pending[0]!({ status: 200, taskId: 'remote-one' });
    pending[1]!({ status: 200, taskId: 'remote-two' });
    await Promise.all(runs);
    expect(
      f.request.mock.calls.filter(([method]) => method === 'provider.media.submit'),
    ).toHaveLength(2);
    expect(f.videos.get(jobs[0]!.id).providerTaskId).toBe('remote-one');
    expect(f.videos.get(jobs[1]!.id).providerTaskId).toBe('remote-two');
    expect(f.scheduler.list()).toHaveLength(3);
    const events = f.scheduler.events(jobs[0]!.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.some((event) => event.kind === 'submit.response_received')).toBe(true);
  });

  it('blocks dependent submissions and rejects self dependencies without invoking a Provider', async () => {
    const f = await setup(true);
    const upstream = prepareVideo(f.videos);
    const downstream = prepareVideo(f.videos);
    f.scheduler.register(upstream.id);
    expect(() => f.scheduler.register(downstream.id, [downstream.id])).toThrow(/dependency/i);
    f.scheduler.register(downstream.id, [upstream.id]);
    const confirmation = f.service.requestSubmission({ jobId: downstream.id }).confirmation!;
    const result = f.service
      .confirmSubmission({
        jobId: downstream.id,
        confirmationToken: confirmation.confirmationToken,
        approved: true,
      })
      .catch((error: unknown) => error);
    await expect.poll(() => f.scheduler.get(downstream.id).waitReason).toBe('dependency');
    expect(f.request).not.toHaveBeenCalled();
    f.videos.fail({ jobId: upstream.id, failureKind: 'provider', message: 'upstream failed' });
    expect(await result).toBeInstanceOf(Error);
    expect(f.scheduler.get(downstream.id).waitReason).toBe('dependency_failed');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('recovers dispatch ownership without replaying an unknown paid submission', async () => {
    const f = await setup(true);
    const job = prepareVideo(f.videos);
    const confirmation = f.service.requestSubmission({ jobId: job.id }).confirmation!;
    f.request.mockRejectedValue(
      new NativeProviderRequestError({ code: 'TIMEOUT', message: 'Lost reply', retryable: true }),
    );
    await f.service.confirmSubmission({
      jobId: job.id,
      confirmationToken: confirmation.confirmationToken,
      approved: true,
    });
    expect(f.scheduler.get(job.id).domainState).toBe('submission_unknown');
    const root = f.project.rootPath;
    f.projectsService.close();
    f.projectsService.open(root);
    f.scheduler.recover();
    f.service.recoverInterrupted();
    expect(f.scheduler.get(job.id).domainState).toBe('submission_unknown');
    expect(f.request).toHaveBeenCalledOnce();
  });

  it('enforces a persisted queue bound and never grants the same dispatch twice', async () => {
    const f = await setup(true);
    const first = prepareVideo(f.videos);
    f.service.requestSubmission({ jobId: first.id });
    f.scheduler.register(first.id);
    const dispatch = f.scheduler.claim(first.id, 'submit')!;
    expect(dispatch).toBeDefined();
    expect(f.scheduler.claim(first.id, 'submit')).toBeUndefined();
    for (let i = 1; i < 32; i++) f.scheduler.register(prepareVideo(f.videos).id);
    expect(() => f.scheduler.register(prepareVideo(f.videos).id)).toThrow(/queue is full/);
    const root = f.project.rootPath;
    f.projectsService.close();
    f.projectsService.open(root);
    f.scheduler.recover();
    expect(f.scheduler.isCurrent(dispatch)).toBe(false);
    const next = f.scheduler.claim(first.id, 'submit')!;
    expect(next.id).not.toBe(dispatch.id);
    f.scheduler.release(dispatch);
    expect(f.scheduler.isCurrent(next)).toBe(true);
    f.scheduler.release(next);
  });

  it('rechecks the source target at paid confirmation and still permits rejecting a stale draft', async () => {
    const { projectsService, images, service, request } = await setup();
    const content = new ContentService(projectsService);
    const actor = content.saveDocument({
      kind: 'character',
      title: '林澈',
      contentMarkdown: '原始',
    });
    const production = new ProductionService(projectsService);
    const target = { kind: 'character' as const, id: actor.id };
    content.saveDocument({
      documentId: actor.id,
      kind: 'character',
      title: actor.title,
      contentMarkdown: '蓝色外套',
    });
    const source = production.compile({ target, adapterKey: imageSelection.adapterKey }).source!;
    const job = images.prepare({
      adapterKey: imageSelection.adapterKey,
      parameters: { prompt: '蓝色外套', aspect_ratio: '16:9', resolution: '1080p' },
      sourceDocumentId: actor.id,
      productionSource: source,
      providerProfileId,
      modelId: imageSelection.modelId,
      mediaModelSelection: imageSelection,
    });
    const pending = service.requestSubmission({ jobId: job.id });
    content.saveDocument({
      documentId: actor.id,
      kind: 'character',
      title: actor.title,
      contentMarkdown: '红色外套',
    });
    projectsService.access(true, (db) =>
      db.prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?").run(actor.id),
    );
    await expect(
      service.confirmSubmission({
        jobId: job.id,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).rejects.toThrow('制作来源');
    expect(request).not.toHaveBeenCalled();
    expect(images.get(job.id).mediaState).toBe('awaiting_confirmation');
    await expect(
      service.confirmSubmission({
        jobId: job.id,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: false,
      }),
    ).resolves.toMatchObject({ job: { mediaState: 'cancelled' } });
    expect(request).not.toHaveBeenCalled();
  });
  it('records local output failures after HTTP success as failed without resubmitting', async () => {
    const { images, service, request } = await setup();
    const job = prepareImage(images);
    const pending = service.requestSubmission({ jobId: job.id });
    const message =
      'Provider image response received; local output processing failed: download blocked';
    request.mockResolvedValueOnce({ status: 200, body: { nativeImageOutputError: message } });
    const result = await service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(result.job).toMatchObject({ status: 'failed', mediaState: 'failed', error: message });
    expect(result.job.error).not.toContain('Submission status is unknown');
    expect(service.requestSubmission({ jobId: job.id }).confirmation).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('receives a Native image result through the real bridge and saves its preview and asset', async () => {
    const { images, videos, settings, projectsService } = await setup();
    const sent: Array<Extract<SidecarEnvelope, { kind: 'host.request' }>> = [];
    const bridge = new NativeProviderBridge({
      send: (envelope) => {
        sent.push(envelope);
        return Promise.resolve();
      },
    });
    const service = new MediaOrchestrationService(
      projectsService,
      settings,
      images,
      videos,
      bridge,
    );
    const nativeRoot = join(tmpdir(), 'ai-video-workspace-unicompapi');
    await mkdir(nativeRoot, { recursive: true });
    const nativeDirectory = await mkdtemp(join(nativeRoot, 'image-receive-'));
    roots.push(nativeDirectory);
    const nativeImageFilePath = join(nativeDirectory, 'image-output.png');
    await writeFile(nativeImageFilePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const job = prepareImage(images);
    const pending = service.requestSubmission({ jobId: job.id });
    const submission = service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bridge.handleEnvelope({
      kind: 'host.response',
      requestId: sent[0]!.requestId,
      ok: true,
      result: { status: 200, body: { data: [{ nativeImageFilePath, contentType: 'image/png' }] } },
    });
    const result = await submission;
    expect(result.job).toMatchObject({ status: 'succeeded', mediaState: 'succeeded' });
    expect(result.job.results[0]?.asset).toBeDefined();
    expect(images.get(job.id).results[0]?.asset).toBeDefined();
    expect(result.job).toHaveProperty('preview.contentType', 'image/png');
    expect(sent).toHaveLength(1);
  });

  it('waits for synchronous images beyond the default Native bridge timeout', async () => {
    const { images, videos, settings, projectsService } = await setup();
    const sent: Array<Extract<SidecarEnvelope, { kind: 'host.request' }>> = [];
    const bridge = new NativeProviderBridge({
      send: (envelope) => {
        sent.push(envelope);
        return Promise.resolve();
      },
    });
    const service = new MediaOrchestrationService(
      projectsService,
      settings,
      images,
      videos,
      bridge,
    );
    const job = prepareImage(images);
    const pending = service.requestSubmission({ jobId: job.id });
    vi.useFakeTimers();
    try {
      const submission = service.confirmSubmission({
        jobId: job.id,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      });
      // Inference can outlast the Native bridge's default two-minute request deadline.
      await vi.advanceTimersByTimeAsync(180_000);
      expect(images.get(job.id).mediaState).toBe('submitting');
      bridge.handleEnvelope({
        kind: 'host.response',
        requestId: sent[0]!.requestId,
        ok: true,
        result: { status: 400, body: { error: { message: 'mock provider rejection' } } },
      });
      const result = await submission;
      expect(result.job).toMatchObject({ status: 'failed', mediaState: 'failed' });
      expect(result.job.error).toContain('HTTP 400');
      expect(service.requestSubmission({ jobId: job.id }).confirmation).toBeUndefined();
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves cancellation when an in-flight image submission later fails', async () => {
    const { images, service, request } = await setup();
    const job = prepareImage(images);
    const pending = service.requestSubmission({ jobId: job.id });
    let rejectSubmission!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise((_, reject) => (rejectSubmission = reject)));
    const submission = service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    await vi.waitFor(() => expect(images.get(job.id).mediaState).toBe('submitting'));
    await service.cancel({ jobId: job.id });
    rejectSubmission(new Error('response timed out'));
    expect((await submission).job).toMatchObject({ status: 'cancelled', mediaState: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('waits beyond the default bridge deadline for one HappyHorse submission and freezes its official contract', async () => {
    const { profile, models, images, videos, settings, projectsService } = await setup();
    const sent: Array<Extract<SidecarEnvelope, { kind: 'host.request' }>> = [];
    const bridge = new NativeProviderBridge({
      send: (envelope) => {
        sent.push(envelope);
        return Promise.resolve();
      },
    });
    const service = new MediaOrchestrationService(
      projectsService,
      settings,
      images,
      videos,
      bridge,
    );
    Object.assign(profile, {
      providerType: 'unicompapi',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const model = providerModel(
      'happyhorse-model',
      'happyhorse-1.1-t2v',
      'HappyHorse 1.1',
      'video',
    );
    Object.assign(model, {
      contractId: 'cn.happyhorse.1.1.t2v',
      contractRevision: 1,
      contractStatus: 'enabled',
    });
    models.push(model);
    const adapterKey = 'TEXT_TO_VIDEO:unicompapi:cn.happyhorse.1.1.t2v:contract-1';
    const parameters = {
      prompt: 'A horse running',
      duration: 15,
      resolution: '1080P',
      ratio: '21:9',
      seed: 2147483647,
      watermark: false,
    };
    const job = videos.prepare({
      adapterKey,
      parameters,
      providerRegion: 'unicompapi',
      providerProfileId,
      modelId: model.id,
    });
    const pending = service.requestSubmission({ jobId: job.id });
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof service.confirmSubmission>>;
    try {
      const submission = service.confirmSubmission({
        jobId: job.id,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(videos.get(job.id).mediaState).toBe('submitting');
      expect(sent).toHaveLength(1);
      bridge.handleEnvelope({
        kind: 'host.response',
        requestId: sent[0]!.requestId,
        ok: true,
        result: { status: 200, taskId: 'official-task', state: 'PENDING' },
      });
      result = await submission;
    } finally {
      vi.useRealTimers();
    }
    expect(result.job).toMatchObject({ status: 'polling', providerTaskId: 'official-task' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'provider.media.submit',
      params: { adapterKey, remoteModelId: 'happyhorse-1.1-t2v', parameters },
    });
    expect(
      projectsService.access(
        false,
        (database) =>
          JSON.parse(createRepositories(database).jobs.get(job.id)!.taskSnapshotJson!) as {
            contractSnapshot: { contract: { source: { url: string } } };
          },
      ).contractSnapshot.contract.source.url,
    ).toContain('help.aliyun.com');
  });

  it('persists only a token hash and invokes Native exactly once after confirmation', async () => {
    const { projectsService, videos, request, service } = await setup();
    const job = prepareVideo(videos);
    const pending = service.requestSubmission({ jobId: job.id });
    const token = pending.confirmation!.confirmationToken;
    const repeatedRequest = service.requestSubmission({ jobId: job.id });

    expect(request).not.toHaveBeenCalled();
    expect(repeatedRequest.confirmation?.confirmationToken).toBe(token);
    expect(pending.confirmation).toMatchObject({
      draftVersion: 1,
      providerName: 'Selected Provider',
      modelName: 'Selected Video Model',
    });
    expect(pending.confirmation?.parameterSummary).toContainEqual({ key: 'duration', value: '5' });
    expect(pending.confirmation?.parameterSummary).toContainEqual({
      key: 'prompt',
      value: 'camera move',
    });
    const stored = projectsService.access(false, (database) =>
      database
        .prepare(
          `SELECT submission_confirmation_token_hash AS tokenHash,
                  submission_confirmation_project_session_id AS projectSessionId
           FROM generation_jobs WHERE id = ?`,
        )
        .get(job.id),
    ) as { tokenHash: string; projectSessionId: string };
    expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.projectSessionId).toBe(projectsService.currentSessionId());

    request.mockResolvedValue({ status: 200, taskId: 'provider-task-1' });
    const confirmed = await service.confirmSubmission({
      jobId: job.id,
      confirmationToken: token,
      approved: true,
    });
    expect(confirmed.job).toMatchObject({
      status: 'polling',
      mediaState: 'polling',
      providerTaskId: 'provider-task-1',
    });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      service.confirmSubmission({ jobId: job.id, confirmationToken: token, approved: true }),
    ).rejects.toThrow('already consumed');
    expect(request).toHaveBeenCalledTimes(1);

    const atomic = projectsService.access(false, (database) =>
      database
        .prepare(
          'SELECT status, media_state AS mediaState, provider_task_id AS providerTaskId FROM generation_jobs WHERE id = ?',
        )
        .get(job.id),
    );
    expect(atomic).toEqual({
      status: 'polling',
      mediaState: 'polling',
      providerTaskId: 'provider-task-1',
    });
  });

  it('revalidates frozen Provider, model, and Adapter facts before Native submission', async () => {
    const { images, videos, request, service, profile, models, adapterLookup } = await setup();

    const providerJob = prepareImage(images);
    const providerPending = service.requestSubmission({ jobId: providerJob.id });
    profile.baseUrl = 'https://api.vidu.cn';
    await expect(
      service.confirmSubmission({
        jobId: providerJob.id,
        confirmationToken: providerPending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).rejects.toThrow('Provider URL');
    expect(images.get(providerJob.id).mediaState).toBe('awaiting_confirmation');
    profile.baseUrl = 'https://api.vidu.com';

    const modelJob = prepareVideo(videos);
    const modelPending = service.requestSubmission({ jobId: modelJob.id });
    const videoModel = models.find((model) => model.id === videoSelection.modelId)!;
    videoModel.remoteModelId = 'viduq3-turbo';
    await expect(
      service.confirmSubmission({
        jobId: modelJob.id,
        confirmationToken: modelPending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).rejects.toThrow('Remote model');
    expect(videos.get(modelJob.id).mediaState).toBe('awaiting_confirmation');
    videoModel.remoteModelId = videoSelection.remoteModelId;

    const adapterJob = prepareImage(images);
    const adapterPending = service.requestSubmission({ jobId: adapterJob.id });
    adapterLookup.resolve = (key) => {
      const adapter = getAdapter(key);
      return adapter ? { ...adapter, schemaVersion: adapter.schemaVersion + 1 } : undefined;
    };
    await expect(
      service.confirmSubmission({
        jobId: adapterJob.id,
        confirmationToken: adapterPending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).rejects.toThrow('Adapter Schema version');
    expect(images.get(adapterJob.id).mediaState).toBe('awaiting_confirmation');
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts a complete legacy snapshot and keeps incomplete snapshots local', async () => {
    const { images, request, service } = await setup();
    const legacy = images.prepare({
      adapterKey: imageSelection.adapterKey,
      parameters: { prompt: 'legacy frame', aspect_ratio: '16:9', resolution: '1080p' },
      providerProfileId,
      modelId: imageSelection.modelId,
    });
    expect(service.requestSubmission({ jobId: legacy.id }).confirmation).toMatchObject({
      draftVersion: 1,
      modelName: 'Selected Image Model',
    });

    const incomplete = images.prepare({
      adapterKey: imageSelection.adapterKey,
      parameters: { prompt: 'incomplete frame', aspect_ratio: '16:9', resolution: '1080p' },
      providerProfileId: '',
      modelId: '',
    });
    expect(() => service.requestSubmission({ jobId: incomplete.id })).toThrow(
      'Provider profile is missing',
    );
    expect(images.get(incomplete.id).mediaState).toBe('draft');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects tampered, expired, and cross-session confirmations before Native submission', async () => {
    const { root, projectsService, images, request, service } = await setup();
    const job = prepareImage(images);
    const pending = service.requestSubmission({ jobId: job.id });
    const token = pending.confirmation!.confirmationToken;

    await expect(
      service.confirmSubmission({ jobId: job.id, confirmationToken: `${token}x`, approved: true }),
    ).rejects.toThrow('invalid, expired');
    expect(request).not.toHaveBeenCalled();

    projectsService.access(true, (database) => {
      database
        .prepare('UPDATE generation_jobs SET submission_confirmation_expires_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', job.id);
    });
    await expect(
      service.confirmSubmission({ jobId: job.id, confirmationToken: token, approved: true }),
    ).rejects.toThrow('invalid, expired');
    expect(request).not.toHaveBeenCalled();

    projectsService.access(true, (database) => {
      database
        .prepare('UPDATE generation_jobs SET submission_confirmation_expires_at = ? WHERE id = ?')
        .run('2999-01-01T00:00:00.000Z', job.id);
    });
    projectsService.close();
    projectsService.open(join(root, 'project'));
    await expect(
      service.confirmSubmission({ jobId: job.id, confirmationToken: token, approved: true }),
    ).rejects.toThrow('invalid, expired');
    expect(request).not.toHaveBeenCalled();
  });

  it('maps explicit Provider HTTP rejection to failed and transport ambiguity to submission_unknown', async () => {
    const { videos, request, service } = await setup();
    const rejected = prepareVideo(videos);
    const rejectedPending = service.requestSubmission({ jobId: rejected.id });
    request.mockResolvedValueOnce({ status: 402, errorMessage: 'payment required' });
    const failed = await service.confirmSubmission({
      jobId: rejected.id,
      confirmationToken: rejectedPending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(failed.job).toMatchObject({ status: 'failed', mediaState: 'failed' });

    const ambiguous = prepareVideo(videos);
    const ambiguousPending = service.requestSubmission({ jobId: ambiguous.id });
    request.mockRejectedValueOnce(new Error('connection closed after request write'));
    const unknown = await service.confirmSubmission({
      jobId: ambiguous.id,
      confirmationToken: ambiguousPending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(unknown.job).toMatchObject({ mediaState: 'submission_unknown' });
    expect(unknown.job.error).toContain('Submission status is unknown');
  });

  it.each([
    ['INVALID_ENVELOPE', 'submission_unknown'],
    ['INTERNAL_ERROR', 'submission_unknown'],
    ['INVALID_PARAMETERS', 'failed'],
    ['METHOD_NOT_FOUND', 'failed'],
    ['REQUEST_NOT_SENT', 'failed'],
  ] as const)('maps Native %s to %s without retrying', async (code, mediaState) => {
    const { videos, request, service } = await setup();
    const job = prepareVideo(videos);
    const pending = service.requestSubmission({ jobId: job.id });
    request.mockRejectedValueOnce(
      new NativeProviderRequestError({ code, message: `Native ${code}`, retryable: false }),
    );

    const result = await service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });

    expect(result.job.mediaState).toBe(mediaState);
    expect(service.requestSubmission({ jobId: job.id }).confirmation).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ supported: false, status: 501 }, 'unsupported', 501],
    [{ supported: true, cancelled: false, status: 409 }, 'rejected', 409],
    [{ supported: true, cancelled: true, status: 202 }, 'cancelled', 202],
    [new Error('cancel response lost'), 'unknown', undefined],
  ] as const)(
    'reports the bounded Provider cancellation outcome %#',
    async (reply, outcome, status) => {
      const { videos, request, service } = await setup();
      const job = prepareVideo(videos);
      const pending = service.requestSubmission({ jobId: job.id });
      request.mockResolvedValueOnce({ status: 200, taskId: `provider-${job.id}` });
      await service.confirmSubmission({
        jobId: job.id,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      });
      if (reply instanceof Error) request.mockRejectedValueOnce(reply);
      else request.mockResolvedValueOnce(reply);

      const cancelled = await service.cancel({ jobId: job.id });

      expect(cancelled.job).toMatchObject({ status: 'cancelled', mediaState: 'cancelled' });
      expect(cancelled.cancellation).toEqual({
        localCancelled: true,
        provider: outcome,
        ...(status === undefined ? {} : { providerStatus: status }),
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it('requires the valid confirmation token even when the user rejects submission', async () => {
    const { images, request, service } = await setup();
    const job = prepareImage(images);
    const pending = service.requestSubmission({ jobId: job.id });
    await expect(
      service.confirmSubmission({ jobId: job.id, confirmationToken: 'invalid', approved: false }),
    ).rejects.toThrow('invalid, expired');
    const cancelled = await service.confirmSubmission({
      jobId: job.id,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: false,
    });
    expect(cancelled.job).toMatchObject({ status: 'cancelled', mediaState: 'cancelled' });
    await expect(
      service.confirmSubmission({
        jobId: job.id,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: false,
      }),
    ).rejects.toThrow('already consumed');
    expect(request).not.toHaveBeenCalled();
  });

  it('recovers expired confirmation and uncertain in-flight submission without re-submitting', async () => {
    const { root, projectsService, images, videos, request, service } = await setup();
    const awaiting = prepareImage(images);
    service.requestSubmission({ jobId: awaiting.id });

    projectsService.close();
    projectsService.open(join(root, 'project'));
    expect(service.recoverInterrupted()).toBe(1);
    expect(images.recoverInterrupted()).toBe(0);
    expect(service.requestSubmission({ jobId: awaiting.id }).confirmation).toBeDefined();
    expect(request).not.toHaveBeenCalled();

    const submitting = prepareVideo(videos);
    const submittingPending = service.requestSubmission({ jobId: submitting.id });
    projectsService.access(true, (database) => {
      database
        .prepare(
          `UPDATE generation_jobs
           SET media_state = 'submitting', submission_idempotency_key = ?,
               submission_confirmation_token_hash = NULL,
               submission_confirmation_expires_at = NULL,
               submission_confirmation_consumed_at = ?,
               submission_confirmation_project_session_id = NULL
           WHERE id = ?`,
        )
        .run(`media-submit:${submitting.id}`, new Date().toISOString(), submitting.id);
    });
    expect(submittingPending.confirmation).toBeDefined();

    projectsService.close();
    projectsService.open(join(root, 'project'));
    expect(service.recoverInterrupted()).toBe(2);
    expect(videos.recoverInterrupted()).toBe(0);
    expect(videos.get(submitting.id)).toMatchObject({
      status: 'pending',
      mediaState: 'submission_unknown',
    });
    expect(service.requestSubmission({ jobId: submitting.id }).confirmation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

it('shares bounded submit admission for images and video, coalesces one image owner, and revalidates queued confirmation before sending', async () => {
  const f = await setup(true);
  const a = prepareImage(f.images),
    b = prepareImage(f.images),
    cancelled = prepareVideo(f.videos),
    expired = prepareImage(f.images);
  const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  let inFlight = 0,
    peak = 0;
  f.request.mockImplementation(
    (_method, params) =>
      new Promise((resolve, reject) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        pending.set((params as { operationId: string }).operationId, {
          resolve: (value) => {
            inFlight -= 1;
            resolve(value);
          },
          reject: (reason) => {
            inFlight -= 1;
            reject(reason);
          },
        });
      }),
  );
  const confirmations = new Map(
    [a, b, cancelled, expired].map((job) => [
      job.id,
      f.service.requestSubmission({ jobId: job.id }).confirmation!,
    ]),
  );
  const approve = (id: string) =>
    f.service.confirmSubmission({
      jobId: id,
      confirmationToken: confirmations.get(id)!.confirmationToken,
      approved: true,
    });
  const first = approve(a.id),
    duplicate = approve(a.id),
    second = approve(b.id);
  const cancelQueued = approve(cancelled.id).catch((reason: unknown) => reason),
    expireQueued = approve(expired.id).catch((reason: unknown) => reason);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(peak).toBe(2);
  await f.service.cancel({ jobId: cancelled.id });
  f.projectsService.access(true, (database) =>
    database
      .prepare('UPDATE generation_jobs SET submission_confirmation_expires_at=? WHERE id=?')
      .run('2000-01-01T00:00:00.000Z', expired.id),
  );
  pending
    .get(b.id)!
    .resolve({ status: 200, body: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] } });
  expect((await second).job.status).toBe('succeeded');
  expect(await expireQueued).toBeInstanceOf(Error);
  expect(await cancelQueued).toBeInstanceOf(Error);
  expect(f.request).toHaveBeenCalledTimes(2);
  pending.get(a.id)!.reject(new Error('Accepted request response was lost'));
  const [unknown, replayed] = await Promise.all([first, duplicate]);
  expect(unknown).toEqual(replayed);
  expect(unknown.job.mediaState).toBe('submission_unknown');
  expect(f.images.listAssets({})).toHaveLength(1);
  f.service.recoverInterrupted();
  expect(f.service.requestSubmission({ jobId: a.id }).confirmation).toBeUndefined();
  expect(f.request).toHaveBeenCalledTimes(2);
});
