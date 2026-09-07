import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@ai-video/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmGenerationIdentity, LlmInputAttachment } from '@ai-video/contracts';
import { AdapterService } from './adapter-service.js';
import { AppSettingsService } from './app-settings-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { MediaPreparationService, resolveMediaProviderRoute } from './media-preparation-service.js';
import { ProjectService } from './project-service.js';
import { VideoGenerationService } from './video-generation-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];
const settingsServices: AppSettingsService[] = [];
const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xn6pAAAAAElFTkSuQmCC';
const largePngBytes = Buffer.alloc(12_000);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(largePngBytes);
const largePng = `data:image/png;base64,${largePngBytes.toString('base64')}`;
const unboundPngBytes = Buffer.alloc(80, 1);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(unboundPngBytes);
const unboundPng = `data:image/png;base64,${unboundPngBytes.toString('base64')}`;

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const project of projects.splice(0)) project.close();
  for (const settings of settingsServices.splice(0)) settings.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup(attachments: LlmInputAttachment[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'media-preparation-'));
  directories.push(directory);
  const projectsService = new ProjectService({
    recentProjectsPath: join(directory, 'recent.json'),
  });
  projects.push(projectsService);
  const project = projectsService.create(join(directory, 'project'), 'Media project');
  const conversation = new ContentService(projectsService).createConversation({
    scopeType: 'project',
  });
  const settings = new AppSettingsService({ appDataDirectory: join(directory, 'settings') });
  settingsServices.push(settings);
  const profile = settings.createProfile({
    name: 'UniCompAPI Media',
    category: 'multi',
    providerType: 'unicompapi',
    accessType: 'official',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://unicompapi.com/v1',
  });
  settings.completeConnectionTest({
    profileId: profile.id,
    status: 'ready',
    models: [
      { id: 'qwen-image' },
      { id: 'qwen-image-edit-2509' },
      { id: 'doubao-seedance-2-0-260128' },
    ],
  });
  for (const model of settings.listModels(profile.id)) {
    settings.updateModel({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: model.capabilities,
      enabled: true,
    });
  }
  const adapters = new AdapterService(projectsService);
  const service = new MediaPreparationService(
    projectsService,
    settings,
    adapters,
    new ImageGenerationService(projectsService),
    new VideoGenerationService(projectsService),
    () => attachments,
  );
  const identity: LlmGenerationIdentity = {
    generationId: 'generation',
    attemptId: 'attempt',
    projectId: project.id,
    projectSessionId: projectsService.currentSessionId()!,
    conversationId: conversation.id,
  };
  return { directory, projectsService, settings, profile, service, identity };
}

describe('MediaPreparationService', () => {
  it('lists only ready official models whose capability and adapter match the inputs', async () => {
    const { settings, profile, service, identity } = await setup();
    const draftProfile = settings.createProfile({
      name: 'Not connected',
      category: 'multi',
      providerType: 'vidu',
      accessType: 'official',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.com',
    });
    const context = service.selectionContext(
      'video',
      { prompt: 'A dragon flying in the sky' },
      identity,
    );

    expect(context.candidates.length).toBeGreaterThan(0);
    expect(
      context.candidates.every((candidate) => candidate.providerProfileId === profile.id),
    ).toBe(true);
    expect(
      context.candidates.every((candidate) =>
        candidate.adapters.every((adapter) => adapter.capability === 'TEXT_TO_VIDEO'),
      ),
    ).toBe(true);
    expect(
      context.candidates.some((candidate) => candidate.providerProfileId === draftProfile.id),
    ).toBe(false);
    const pendingSchema = context.candidates[0]!.adapters[0]!;
    settings.proposeAdapterSchema(
      { adapterKey: pendingSchema.key, descriptor: pendingSchema, reason: 'Awaiting review' },
      [],
    );
    const refreshed = service.selectionContext(
      'video',
      { prompt: 'A dragon flying in the sky' },
      identity,
    );
    expect(
      refreshed.candidates.some((candidate) =>
        candidate.adapters.some((adapter) => adapter.key === pendingSchema.key),
      ),
    ).toBe(false);
  });

  it('creates only a local draft after selection and freezes the validated Provider route', async () => {
    const { projectsService, profile, service, identity } = await setup();
    const context = service.selectionContext(
      'video',
      { prompt: 'A dragon flying in the sky' },
      identity,
    );
    expect(
      projectsService.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters[0]!;

    const draft = service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {},
      },
      identity,
    );

    expect(draft).toMatchObject({
      kind: 'video',
      status: 'draft',
      mediaModelSelection: {
        providerProfileId: profile.id,
        providerType: 'unicompapi',
        providerBaseUrlCategory: 'official-unicompapi',
        providerRegion: 'unicompapi',
        modelId: candidate.modelId,
        remoteModelId: candidate.remoteModelId,
        adapterKey: adapter.key,
        adapterSchemaVersion: adapter.schemaVersion,
        adapterSchemaSource: 'official-adapter',
      },
    });
    expect(draft.normalizedParameters.prompt).toBe('A dragon flying in the sky');
    const persisted = projectsService.access(
      false,
      (database) =>
        database
          .prepare(
            'SELECT status, provider_task_id, task_snapshot_json FROM generation_jobs WHERE id = ?',
          )
          .get(draft.draftId) as {
          status: string;
          provider_task_id: string | null;
          task_snapshot_json: string;
        },
    );
    expect(persisted.status).toBe('pending');
    expect(persisted.provider_task_id).toBeNull();
    const snapshot = JSON.parse(persisted.task_snapshot_json) as {
      inputs?: Array<{ type: string; handle: string; contentType: string }>;
    };
    expect(snapshot).toMatchObject({
      mediaModelSelection: draft.mediaModelSelection,
      costNoticeAcknowledged: false,
    });
    expect(snapshot.inputs).toEqual([]);
  });

  it('rejects tampered selections and never creates a job for them', async () => {
    const { projectsService, service, identity } = await setup();
    const context = service.selectionContext('image', { prompt: 'Paint a red dragon' }, identity);
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters[0]!;

    expect(() =>
      service.prepareSelected(
        context,
        {
          providerProfileId: candidate.providerProfileId,
          modelId: 'tampered-model-id',
          adapterKey: adapter.key,
          parameters: {},
        },
        identity,
      ),
    ).toThrow('no longer available');
    expect(() =>
      service.selectionContext(
        'image',
        { prompt: 'Paint a dragon' },
        {
          ...identity,
          projectId: 'another-project',
        },
      ),
    ).toThrow('current project session');
    expect(
      projectsService.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('accepts a canonical attachment only for the shown input count and redacts it everywhere durable', async () => {
    const { projectsService, service, identity } = await setup([
      { name: 'reference.png', mimeType: 'image/png', dataUrl: largePng },
    ]);
    expect(largePng.length).toBeGreaterThan(10_000);
    const context = service.selectionContext(
      'video',
      { prompt: 'Animate the reference image' },
      identity,
    );
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters[0]!;
    expect(adapter.parameterSchema.properties.images).toBeDefined();

    const draft = service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: { images: [largePng] },
      },
      identity,
    );

    expect(JSON.stringify(draft)).not.toContain('base64');
    expect(draft.normalizedParameters.images).toEqual(['attachment://omitted']);
    const durable = projectsService.access(
      false,
      (database) =>
        database
          .prepare('SELECT request_json, task_snapshot_json FROM generation_jobs WHERE id = ?')
          .get(draft.draftId) as { request_json: string; task_snapshot_json: string },
    );
    expect(JSON.stringify(durable)).not.toContain('base64');
    expect(durable.request_json).toContain('local-image://omitted');
    const snapshotWithInput = JSON.parse(
      projectsService.access(
        false,
        (database) =>
          database
            .prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id = ?')
            .get(draft.draftId) as { task_snapshot_json: string },
      ).task_snapshot_json,
    ) as { inputs?: Array<{ type: string; handle: string; contentType: string }> };
    expect(snapshotWithInput.inputs).toHaveLength(1);
    expect(snapshotWithInput.inputs?.[0]).toMatchObject({
      type: 'controlled_temporary_file',
      contentType: 'image/png',
    });
    const inputHandle = snapshotWithInput.inputs?.[0]?.handle;
    expect(inputHandle).toMatch(/^cache\/media-inputs\/[0-9a-f-]+\.png$/u);
    if (!inputHandle) throw new Error('Expected one controlled media input handle.');
    expect(existsSync(join(projectsService.current()!.rootPath, inputHandle))).toBe(true);
  });

  it('materializes direct UI Data URLs under the Native-controlled shared root', async () => {
    const { directory, projectsService, service } = await setup();
    const nativeRoot = join(directory, 'native-root');
    vi.stubEnv('AI_VIDEO_MEDIA_INPUT_ROOT', nativeRoot);

    const job = service.prepareImage({
      adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      parameters: {
        images: [largePng],
        prompt: 'Restyle the reference',
        aspect_ratio: '16:9',
        resolution: '1080p',
      },
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const snapshot = projectsService.access(false, (database) => {
      const row = database
        .prepare('SELECT request_json, task_snapshot_json FROM generation_jobs WHERE id = ?')
        .get(job.id) as { request_json: string; task_snapshot_json: string };
      expect(row.request_json).not.toContain('base64');
      return JSON.parse(row.task_snapshot_json) as {
        parameters: { images: string[] };
        inputs: Array<{ type: string; handle?: string }>;
      };
    });
    expect(JSON.stringify(snapshot)).not.toContain('base64');
    expect(snapshot.parameters.images[0]).toMatch(/^controlled-file:\/\/cache\/media-inputs\//u);
    const handle = snapshot.inputs.find(
      (item) => item.type === 'controlled_temporary_file',
    )?.handle;
    expect(handle).toBeDefined();
    expect(existsSync(join(nativeRoot, handle!))).toBe(true);
    expect(existsSync(join(projectsService.current()!.rootPath, handle!))).toBe(false);
  });

  it('copies Agent asset inputs into controlled files and retains only asset provenance', async () => {
    const { directory, projectsService, service, identity } = await setup();
    const nativeRoot = join(directory, 'native-root');
    vi.stubEnv('AI_VIDEO_MEDIA_INPUT_ROOT', nativeRoot);
    const assetId = '11111111-1111-4111-8111-111111111111';
    const relativePath = 'assets/images/reference.png';
    const sourcePath = join(projectsService.current()!.rootPath, relativePath);
    mkdirSync(join(projectsService.current()!.rootPath, 'assets', 'images'), { recursive: true });
    writeFileSync(sourcePath, largePngBytes);
    projectsService.access(true, (database, project) => {
      createRepositories(database).assets.save({
        id: assetId,
        projectId: project.id,
        kind: 'generated-image',
        relativePath,
        contentHash: createHash('sha256').update(largePngBytes).digest('hex'),
        sizeBytes: largePngBytes.byteLength,
        createdAt: new Date().toISOString(),
      });
    });

    const context = service.selectionContext(
      'video',
      { prompt: 'Animate this asset', inputAssetIds: [assetId] },
      identity,
    );
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters.find((item) => item.parameterSchema.properties.images)!;
    const draft = service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {},
      },
      identity,
    );
    const snapshot = projectsService.access(false, (database) => {
      const row = database
        .prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id = ?')
        .get(draft.draftId) as { task_snapshot_json: string };
      return JSON.parse(row.task_snapshot_json) as {
        parameters: { images: string[] };
        inputs: Array<{ type: string; assetId?: string; handle?: string }>;
      };
    });
    expect(snapshot.inputs).toEqual(
      expect.arrayContaining([
        { type: 'asset', assetId },
        expect.objectContaining({ type: 'controlled_temporary_file' }),
      ]),
    );
    expect(snapshot.parameters.images).toHaveLength(1);
    expect(snapshot.parameters.images[0]).toMatch(/^controlled-file:\/\//u);
    const handle = snapshot.inputs.find(
      (item) => item.type === 'controlled_temporary_file',
    )?.handle;
    expect(existsSync(join(nativeRoot, handle!))).toBe(true);
  });

  it('rejects malformed inline images, raw Base64, and absolute paths before draft creation', async () => {
    const { projectsService, service, identity } = await setup([
      { name: 'reference.png', mimeType: 'image/png', dataUrl: tinyPng },
    ]);
    const context = service.selectionContext(
      'video',
      { prompt: 'Animate the reference image' },
      identity,
    );
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters[0]!;
    const select = (images: string[]) =>
      service.prepareSelected(
        context,
        {
          providerProfileId: candidate.providerProfileId,
          modelId: candidate.modelId,
          adapterKey: adapter.key,
          parameters: { images },
        },
        identity,
      );

    expect(() => select(['data:image/png;base64,%%%'])).toThrow('parameter images is invalid');
    expect(() => select(['A'.repeat(600)])).toThrow('parameter images is invalid');
    expect(() => select(['C:\\Users\\test\\reference.png'])).toThrow('parameter images is invalid');
    expect(() => select([unboundPng])).toThrow('not one of the attachments frozen');
    expect(
      projectsService.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('only accepts normalized official media Provider routes', async () => {
    const { settings, profile } = await setup();
    expect(resolveMediaProviderRoute(settings.getProfile(profile.id)!)).toEqual({
      providerType: 'unicompapi',
      providerRegion: 'unicompapi',
      baseUrlCategory: 'official-unicompapi',
    });
    expect(
      resolveMediaProviderRoute({
        ...settings.getProfile(profile.id)!,
        accessType: 'custom',
      }),
    ).toBeUndefined();
  });
});
