import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MediaModelSelectionSnapshot,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { getAdapter } from '@ai-video/generation-adapters';
import type { AppSettingsService } from './app-settings-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { MediaOrchestrationService } from './media-orchestration-service.js';
import { NativeProviderRequestError, type NativeProviderBridge } from './native-provider-bridge.js';
import { ProjectService } from './project-service.js';
import { VideoGenerationService } from './video-generation-service.js';

const roots: string[] = [];
const projects: ProjectService[] = [];
const providerProfileId = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
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
  const service = new MediaOrchestrationService(
    projectsService,
    settings,
    images,
    videos,
    {
      request,
    } as unknown as NativeProviderBridge,
    (key) => adapterLookup.resolve(key),
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
