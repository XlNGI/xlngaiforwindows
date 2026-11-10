import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@ai-video/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmGenerationIdentity, LlmInputAttachment } from '@ai-video/contracts';
import { AdapterService } from './adapter-service.js';
import { AppSettingsService } from './app-settings-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import {
  MediaPreparationService,
  parseMediaPrepareArguments,
  resolveMediaProviderRoute,
} from './media-preparation-service.js';
import { ProjectService } from './project-service.js';
import { VideoGenerationService } from './video-generation-service.js';
import { ProductionService } from './production-service.js';
const directories: string[] = [];
const projects: ProjectService[] = [];
const settingsServices: AppSettingsService[] = [];
const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xn6pAAAAAElFTkSuQmCC';
const largePngBytes = Buffer.alloc(12000);
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
      { id: 'vendor-hosted-video-model' },
    ],
  });
  const bindings = {
    'qwen-image': {
      capabilities: { ...settings.listModels(profile.id)[0]!.capabilities, imageGeneration: true },
      parameterTemplateKey: 'openai-compatible-image',
    },
    'qwen-image-edit-2509': {
      capabilities: { ...settings.listModels(profile.id)[0]!.capabilities, imageEditing: true },
      parameterTemplateKey: 'qwen-image-edit',
    },
    'vendor-hosted-video-model': {
      capabilities: { ...settings.listModels(profile.id)[0]!.capabilities, videoGeneration: true },
      parameterTemplateKey: 'openai-compatible-video',
    },
  } as const;
  for (const model of settings.listModels(profile.id)) {
    const binding = bindings[model.remoteModelId as keyof typeof bindings];
    if (!binding) throw new Error('missing template binding for ' + model.remoteModelId);
    settings.updateModel({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: binding.capabilities,
      enabled: true,
      parameterTemplateKey: binding.parameterTemplateKey,
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
  it.each(['image', 'video'] as const)(
    'accepts a verified compressed JPEG with the original PNG label for %s without relaxing attachment binding',
    async (kind) => {
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
      const jpeg = `data:image/jpeg;base64,${bytes.toString('base64')}`;
      const attachment = { name: 'original.png', mimeType: 'image/png', dataUrl: jpeg };
      const f = await setup([attachment]);
      const prompt = '保持全部手动要求和参考图，抽刀时定格。';
      const context = f.service.selectionContext(kind, { prompt }, f.identity);
      expect(context.arguments.prompt).toBe(prompt);
      expect(context.inputAttachmentCount).toBe(1);
      expect(context.inputAttachments).toEqual([
        { contentType: 'image/jpeg', sha256: createHash('sha256').update(bytes).digest('hex') },
      ]);
      const candidate = context.candidates.find((item) =>
        item.adapters.some((adapter) => adapter.parameterSchema.properties.images),
      )!;
      const adapter = candidate.adapters.find((item) => item.parameterSchema.properties.images)!;
      const selection = {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: { images: [jpeg] },
      };
      expect(() =>
        f.service.prepareSelected(
          context,
          { ...selection, parameters: { images: [unboundPng] } },
          f.identity,
        ),
      ).toThrow('not one of the attachments frozen');
      const draft = f.service.prepareSelected(context, selection, f.identity);
      expect(draft.normalizedParameters.prompt).toBe(prompt);
      const job = f.projectsService.access(false, (db) =>
        createRepositories(db).jobs.get(draft.draftId)!,
      );
      const snapshot = JSON.parse(job.taskSnapshotJson!) as {
        inputs: Array<{
          handle: string;
          contentType: string;
        }>;
      };
      expect(snapshot.inputs).toHaveLength(1);
      expect(snapshot.inputs[0]!.contentType).toBe('image/jpeg');
      expect(
        readFileSync(join(f.projectsService.current()!.rootPath, snapshot.inputs[0]!.handle)),
      ).toEqual(bytes);
      expect(attachment).toEqual({ name: 'original.png', mimeType: 'image/png', dataUrl: jpeg });
      expect(job.providerTaskId).toBeUndefined();
    },
  );
  it.each([
    'data:image/png;base64,/9j/',
    'data:image/jpeg;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,YmFk',
    'data:image/jpeg;base64,%%%',
  ])(
    'rejects invalid encoded image content even when the outer MIME matches (%s)',
    async (dataUrl) => {
      const f = await setup([{ name: 'reference.png', mimeType: 'image/png', dataUrl }]);
      expect(() =>
        f.service.selectionContext('image', { prompt: '保持参考图' }, f.identity),
      ).toThrow('parameter images is invalid');
    },
  );
  it('prepares one composite scene by default but preserves the reviewed count and prompt', async () => {
    const f = await setup();
    const doc = new ContentService(f.projectsService).saveDocument({
      kind: 'scene',
      title: '旧码头',
      contentMarkdown: '木栈道与灯塔',
      scopeType: 'project',
    });
    const context = f.service.selectionContext(
      'image',
      {
        prompt: '旧码头',
        sourceDocumentId: doc.id,
        parameters: { n: 4 },
      },
      f.identity,
    );
    expect(context.arguments.assetKind).toBe('scene');
    expect(context.arguments.parameters.n).toBe(1);
    expect(context.arguments.prompt).toContain('主图是占画面主要面积');
    const candidate = context.candidates.find((item) => item.remoteModelId === 'qwen-image')!;
    const selection = {
      providerProfileId: candidate.providerProfileId,
      modelId: candidate.modelId,
      adapterKey: candidate.adapters[0]!.key,
      parameters: {},
    };
    const initial = f.service.prepareSelected(context, selection, f.identity);
    const reviewed = f.service.prepareReviewedSelection(
      context,
      {
        ...selection,
        parameters: { prompt: '用户审核：同版式随机变体', n: 2 },
      },
      f.identity,
    );
    const snapshots = [initial, reviewed].map((draft) =>
      f.projectsService.access(
        false,
        (db) =>
          JSON.parse(createRepositories(db).jobs.get(draft.draftId)!.taskSnapshotJson!) as {
            parameters: {
              prompt: string;
              n: number;
            };
          },
      ),
    );
    expect(snapshots[0]!.parameters.n).toBe(1);
    expect(snapshots[0]!.parameters.prompt).toContain('一张复合参考图');
    expect(snapshots[1]!.parameters).toMatchObject({ n: 2, prompt: '用户审核：同版式随机变体' });
  });
  it('preserves long Agent-authored prompts through media preparation parsing', () => {
    const prompt = '当前会话要求：'.padEnd(6000, '固定约束。');
    expect(parseMediaPrepareArguments('image', { prompt }).prompt).toBe(prompt);
  });
  it('keeps reference descriptions and timed video prose intact when preparing a local video draft', async () => {
    const f = await setup([{ name: 'reference.png', mimeType: 'image/png', dataUrl: tinyPng }]);
    const prompt = `输入图片说明：本次输入一张图，图1为本段首帧及人物外观参考。
视频目标：林澈离开雨夜车站，动作连贯。
【基础设定】林澈穿青色雨衣；保留同期雨声与脚步声，无对白，无配乐。
【氛围与画质】近景向后拉远，冷灰灯光照亮湿地。
动态流程：0.0至3.0秒，林澈转身；3.0至6.0秒，沿站台走远；6.0至8.0秒，前景站柱遮住身影。
负面约束：不改人物容貌与衣服固有色，不出现字幕或水印。`;
    const context = f.service.selectionContext('video', { prompt }, f.identity);
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters.find((item) => item.parameterSchema.properties.images)!;
    const draft = f.service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: { images: [tinyPng], duration: 8 },
      },
      f.identity,
    );
    expect(draft.normalizedParameters.prompt).toBe(prompt);
    expect(draft.normalizedParameters.images).toEqual(['attachment://omitted']);
    const job = f.projectsService.access(false, (db) =>
      createRepositories(db).jobs.get(draft.draftId)!,
    );
    const snapshot = JSON.parse(job.taskSnapshotJson!) as {
      parameters: {
        prompt: string;
      };
    };
    expect(snapshot.parameters.prompt).toBe(prompt);
    expect(job.providerTaskId).toBeUndefined();
  });
  it('prepares current Qwen image editing with local references and freezes only controlled handles', async () => {
    const f = await setup([{ name: 'reference.png', mimeType: 'image/png', dataUrl: tinyPng }]);
    const model = f.settings.createManualModel({
      profileId: f.profile.id,
      remoteModelId: 'qwen-image-3.0',
      capabilities: {
        ...f.settings.listModels(f.profile.id)[0]!.capabilities,
        imageGeneration: true,
        imageEditing: true,
      },
      enabled: true,
    });
    const context = f.service.selectionContext(
      'image',
      {
        prompt: '保留人物，将背景改为海边',
        parameters: { images: ['https://example.com/background.png'] },
      },
      f.identity,
    );
    const candidate = context.candidates.find((item) => item.modelId === model.id)!;
    expect(candidate.adapters.map((a) => a.capability)).toEqual(['REFERENCE_TO_IMAGE']);
    const adapter = candidate.adapters[0]!;
    expect(adapter.key).toBe('REFERENCE_TO_IMAGE:unicompapi:cn.qwen.qwen-image-3-0:contract-2');
    const draft = f.service.prepareSelected(
      context,
      {
        providerProfileId: f.profile.id,
        modelId: model.id,
        adapterKey: adapter.key,
        parameters: { images: [tinyPng, 'https://example.com/background.png'] },
      },
      f.identity,
    );
    const row = f.projectsService.access(false, (db) =>
      createRepositories(db).jobs.get(draft.draftId)!,
    );
    const snapshot = JSON.parse(row.taskSnapshotJson!) as {
      parameters: {
        images: string[];
      };
      inputs: unknown[];
    };
    expect(snapshot.parameters.images).toEqual([
      expect.stringMatching(/^controlled-file:\/\//u),
      'https://example.com/background.png',
    ]);
    expect(row.requestJson).not.toContain('base64');
    expect(row.taskSnapshotJson).not.toContain('base64');
    expect(snapshot.inputs).toHaveLength(1);
  });
  it('retains the prop image kind when preparing an Agent-selected image model', async () => {
    const f = await setup();
    const document = new ContentService(f.projectsService).saveDocument({
      kind: 'prop',
      title: '铁木杖',
      contentMarkdown: '铁木杖，白底展示',
      scopeType: 'project',
    });
    const context = f.service.selectionContext(
      'image',
      { prompt: '铁木杖，白底展示', assetKind: 'prop', sourceDocumentId: document.id },
      f.identity,
    );
    const candidate = context.candidates.find((item) => item.remoteModelId === 'qwen-image')!;
    const draft = f.service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: candidate.adapters[0]!.key,
        parameters: {},
      },
      f.identity,
    );
    const job = f.projectsService.access(false, (db) =>
      createRepositories(db).jobs.get(draft.draftId)!,
    );
    expect(JSON.parse(job.taskSnapshotJson!)).toMatchObject({
      assetKind: 'prop',
      sourceDocumentId: document.id,
    });
  });
  it('still rejects an unavailable image in the final form before creating a generation job', async () => {
    const f = await setup();
    const content = new ContentService(f.projectsService);
    const scene = content.saveScene({ title: '铁匠铺' });
    const shot = content.saveShot({ sceneId: scene.id, title: '拒绝' });
    expect(() =>
      f.service.prepareImage({
        adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
        shotId: shot.id,
        productionSource: { mode: 'form', token: 'forged', target: { kind: 'shot', id: shot.id } },
        parameters: {
          prompt: '用户填写的镜头',
          images: ['project-asset://missing'],
          resolution: '1080p',
        },
      }),
    ).toThrow('Every media input asset must be an active image in the current project');
    expect(
      f.projectsService.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });
  it('prepares a directly edited shot form from API-valid parameters without rerunning fill', async () => {
    const f = await setup();
    const content = new ContentService(f.projectsService);
    const scene = content.saveScene({ title: '空镜场次' });
    const shot = content.saveShot({ sceneId: scene.id, title: '手动填写', prompt: '' });
    const parameters = {
      prompt: '用户在表单中填写的镜头',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      audio: true,
    };
    const adapterKey = 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2';
    const job = f.service.prepareVideo({
      shotId: shot.id,
      adapterKey,
      parameters,
      providerRegion: 'global',
    });
    const snapshot = f.projectsService.access(
      false,
      (db) =>
        JSON.parse(
          (
            db.prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id=?').get(job.id) as {
              task_snapshot_json: string;
            }
          ).task_snapshot_json,
        ) as {
          parameters: typeof parameters;
          productionSource?: unknown;
        },
    );
    expect(snapshot.parameters).toEqual(parameters);
    expect(snapshot.productionSource).toBeUndefined();
    expect(() =>
      f.service.prepareVideo({
        shotId: shot.id,
        adapterKey,
        parameters: { ...parameters, duration: 9999 },
        providerRegion: 'global',
      }),
    ).toThrow('Video generation parameters are invalid');
    expect(
      f.projectsService.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 1 });
  });
  it('uses the production source and authored duration when Agent prepares an existing shot', async () => {
    const f = await setup();
    const content = new ContentService(f.projectsService);
    const scene = content.saveScene({ title: '雨夜' });
    const shot = content.saveShot({ sceneId: scene.id, title: '观察' });
    const production = new ProductionService(f.projectsService);
    content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: shot.title,
      expectedRowVersion: shot.rowVersion,
      ...{
        prompt: '观察雨中的车站',
        timing: { estimatedDurationSeconds: 8 },
      },
    });
    const context = f.service.selectionContext(
      'video',
      { prompt: '观察雨中的车站', shotId: shot.id },
      f.identity,
    );
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters.find((a) => a.capability === 'TEXT_TO_VIDEO')!;
    const draft = f.service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {},
      },
      f.identity,
    );
    const row = f.projectsService.access(false, (db) =>
      db
        .prepare('SELECT request_json,task_snapshot_json FROM generation_jobs WHERE id=?')
        .get(draft.draftId),
    ) as {
      request_json: string;
      task_snapshot_json: string;
    };
    const request = JSON.parse(row.request_json) as {
      duration: number;
    };
    const snapshot = JSON.parse(row.task_snapshot_json) as {
      productionSource: import('@ai-video/contracts').ProductionSource;
    };
    expect(request.duration).toBe(8);
    expect(snapshot.productionSource).toEqual(
      production.compile({ target: { kind: 'shot', id: shot.id }, adapterKey: adapter.key }).source,
    );
    expect(snapshot.productionSource.target.id).toBe(shot.id);
  });
  it('offers UniComp Wan media modes to Agent requests and preserves public audio when mapping images', async () => {
    const { settings, profile, service, identity, projectsService } = await setup();
    const model = settings.createManualModel({
      profileId: profile.id,
      remoteModelId: 'wan3.0-video',
      capabilities: {
        ...settings.listModels(profile.id)[0]!.capabilities,
        text: false,
        imageGeneration: false,
        imageEditing: false,
        videoGeneration: true,
      },
      enabled: true,
    });
    const media = [{ type: 'reference_audio', url: 'https://example.com/voice.wav' }];
    const context = service.selectionContext(
      'video',
      {
        prompt: '使用音频1的音色',
        parameters: { images: ['https://example.com/actor.png'], media, audio: true },
      },
      identity,
    );
    const candidate = context.candidates.find((item) => item.modelId === model.id)!;
    expect(candidate.adapters.map((item) => item.capability)).toEqual(
      expect.arrayContaining(['IMAGE_TO_VIDEO', 'REFERENCE_TO_VIDEO']),
    );
    expect(candidate.adapters.some((item) => item.contractRevision === 1)).toBe(false);
    const key = 'REFERENCE_TO_VIDEO:unicompapi:cn.qwen.wan3-0-video:contract-3';
    const draft = service.prepareSelected(
      context,
      { providerProfileId: profile.id, modelId: model.id, adapterKey: key, parameters: {} },
      identity,
    );
    const job = projectsService.access(false, (db) =>
      createRepositories(db).jobs.get(draft.draftId)!,
    );
    const request = JSON.parse(job.requestJson) as Record<string, unknown>;
    expect(request).not.toHaveProperty('images');
    expect(request.media).toEqual([
      { type: 'reference_image', url: 'https://example.com/actor.png' },
      ...media,
    ]);
    expect(job.status).toBe('pending');
    const videoContext = service.selectionContext(
      'video',
      { prompt: '参考该视频', parameters: { video: 'https://example.com/reference.mp4' } },
      identity,
    );
    expect(
      videoContext.candidates
        .find((item) => item.modelId === model.id)
        ?.adapters.map((item) => item.capability),
    ).toEqual(['REFERENCE_TO_VIDEO']);
    const videoDraft = service.prepareSelected(
      videoContext,
      { providerProfileId: profile.id, modelId: model.id, adapterKey: key, parameters: {} },
      identity,
    );
    const videoJob = projectsService.access(false, (db) =>
      createRepositories(db).jobs.get(videoDraft.draftId)!,
    );
    expect(JSON.parse(videoJob.requestJson)).toMatchObject({
      media: [{ type: 'reference_video', url: 'https://example.com/reference.mp4' }],
    });
  });
  it('prepares HappyHorse with nine references through its official contract without a channel template', async () => {
    const { settings, profile, service, identity, projectsService } = await setup();
    const model = settings.createManualModel({
      profileId: profile.id,
      remoteModelId: 'happyhorse-1.1-r2v',
      capabilities: {
        ...settings.listModels(profile.id)[0]!.capabilities,
        text: false,
        imageGeneration: false,
        imageEditing: false,
        videoGeneration: true,
      },
      enabled: true,
    });
    const images = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`);
    const context = service.selectionContext(
      'video',
      { prompt: '[Image 1] walks through the scene', parameters: { images } },
      identity,
    );
    const candidate = context.candidates.find((item) => item.modelId === model.id)!;
    expect(candidate.adapters.map((item) => item.key)).toEqual([
      'REFERENCE_TO_VIDEO:unicompapi:cn.happyhorse.1.1.r2v:contract-1',
    ]);
    const draft = service.prepareSelected(
      context,
      {
        providerProfileId: profile.id,
        modelId: model.id,
        adapterKey: candidate.adapters[0]!.key,
        parameters: { images },
      },
      identity,
    );
    expect(draft.mediaModelSelection).toMatchObject({
      contractId: 'cn.happyhorse.1.1.r2v',
      contractRevision: 1,
    });
    projectsService.access(false, (database) => {
      const saved = createRepositories(database).jobs.get(draft.draftId)!;
      const snapshot = JSON.parse(saved.taskSnapshotJson!) as {
        contractSnapshot: {
          parameterSchema: {
            properties: {
              images: {
                maxItems: number;
              };
            };
          };
        };
      };
      expect(snapshot.contractSnapshot.parameterSchema.properties.images.maxItems).toBe(9);
    });
  });
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
    expect(context.candidates.map((candidate) => candidate.remoteModelId)).toEqual([
      'vendor-hosted-video-model',
    ]);
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
      inputs?: Array<{
        type: string;
        handle: string;
        contentType: string;
      }>;
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
    expect(largePng.length).toBeGreaterThan(10000);
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
          .get(draft.draftId) as {
          request_json: string;
          task_snapshot_json: string;
        },
    );
    expect(JSON.stringify(durable)).not.toContain('base64');
    expect(durable.request_json).toContain('local-image://omitted');
    const snapshotWithInput = JSON.parse(
      projectsService.access(
        false,
        (database) =>
          database
            .prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id = ?')
            .get(draft.draftId) as {
            task_snapshot_json: string;
          },
      ).task_snapshot_json,
    ) as {
      inputs?: Array<{
        type: string;
        handle: string;
        contentType: string;
      }>;
    };
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
  it('freezes local files chosen in a reviewed UI decision without importing them or relaxing Agent inputs', async () => {
    const { projectsService, service, identity } = await setup([
      { name: 'original.png', mimeType: 'image/png', dataUrl: tinyPng },
    ]);
    const context = service.selectionContext(
      'video',
      { prompt: 'Animate the chosen picture' },
      identity,
    );
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters[0]!;
    const selection = {
      providerProfileId: candidate.providerProfileId,
      modelId: candidate.modelId,
      adapterKey: adapter.key,
      parameters: { images: [unboundPng] },
    };
    expect(() => service.prepareSelected(context, selection, identity)).toThrow(
      'not one of the attachments frozen',
    );
    expect(() =>
      service.prepareReviewedSelection(
        context,
        {
          ...selection,
          parameters: { images: ['data:image/png;base64,YmFk'] },
        },
        identity,
      ),
    ).toThrow('parameter images is invalid');
    const draft = service.prepareReviewedSelection(context, selection, identity);
    expect(draft.normalizedParameters.images).toEqual(['attachment://omitted']);
    expect(JSON.stringify(draft)).not.toContain('base64');
    const saved = projectsService.access(false, (database) => ({
      assets: database.prepare('SELECT COUNT(*) AS count FROM assets').get(),
      job: database
        .prepare('SELECT request_json,task_snapshot_json FROM generation_jobs WHERE id=?')
        .get(draft.draftId),
    }));
    expect(saved.assets).toEqual({ count: 0 });
    expect(JSON.stringify(saved.job)).not.toContain('base64');
    expect(JSON.stringify(saved.job)).toContain('controlled_temporary_file');
    expect(context.inputAttachments).toHaveLength(1);
    expect(context.inputAttachments[0]?.sha256).not.toBe(
      createHash('sha256').update(unboundPngBytes).digest('hex'),
    );
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
        .get(job.id) as {
        request_json: string;
        task_snapshot_json: string;
      };
      expect(row.request_json).not.toContain('base64');
      return JSON.parse(row.task_snapshot_json) as {
        parameters: {
          images: string[];
        };
        inputs: Array<{
          type: string;
          handle?: string;
        }>;
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
  it('materializes a large Desktop asset reference without returning inline bytes over IPC', async () => {
    const { directory, projectsService, service } = await setup();
    const nativeRoot = join(directory, 'native-root');
    vi.stubEnv('AI_VIDEO_MEDIA_INPUT_ROOT', nativeRoot);
    const bytes = Buffer.alloc(6 * 1024 * 1024);
    largePngBytes.copy(bytes);
    const relativePath = 'assets/images/large.png';
    mkdirSync(join(projectsService.current()!.rootPath, 'assets/images'), { recursive: true });
    writeFileSync(join(projectsService.current()!.rootPath, relativePath), bytes);
    projectsService.access(true, (database, project) =>
      createRepositories(database).assets.save({
        id: 'large-reference',
        projectId: project.id,
        kind: 'generated-image',
        relativePath,
        sizeBytes: bytes.length,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        createdAt: new Date().toISOString(),
      }),
    );
    const job = service.prepareImage({
      adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      parameters: {
        images: ['asset://large-reference'],
        prompt: 'Restyle',
        aspect_ratio: '16:9',
        resolution: '1080p',
      },
    });
    expect(Buffer.byteLength(JSON.stringify(job))).toBeLessThan(16 * 1024);
    const snapshot = projectsService.access(
      false,
      (database) =>
        JSON.parse(
          (
            database
              .prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id=?')
              .get(job.id) as {
              task_snapshot_json: string;
            }
          ).task_snapshot_json,
        ) as {
          parameters: {
            images: string[];
          };
          inputs: Array<{
            type: string;
            assetId?: string;
            handle?: string;
          }>;
        },
    );
    expect(snapshot.inputs).toContainEqual({ type: 'asset', assetId: 'large-reference' });
    expect(snapshot.parameters.images[0]).toMatch(/^controlled-file:\/\/cache\/media-inputs\//);
    const handle = snapshot.inputs.find(
      (input) => input.type === 'controlled_temporary_file',
    )?.handle;
    if (!handle) throw new Error('Expected a controlled media input.');
    expect(readFileSync(join(nativeRoot, handle)).equals(bytes)).toBe(true);
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
        .get(draft.draftId) as {
        task_snapshot_json: string;
      };
      return JSON.parse(row.task_snapshot_json) as {
        parameters: {
          images: string[];
        };
        inputs: Array<{
          type: string;
          assetId?: string;
          handle?: string;
        }>;
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
    const edited = service.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {
          prompt: '用户修改后的图序说明',
          images: ['https://example.com/reviewed.png'],
        },
      },
      identity,
    );
    const editedSnapshot = projectsService.access(false, (db) => {
      const row = createRepositories(db).jobs.get(edited.draftId)!;
      return JSON.parse(row.taskSnapshotJson!) as {
        parameters: {
          prompt: string;
          images: string[];
        };
        inputs?: unknown[];
      };
    });
    expect(editedSnapshot.parameters).toMatchObject({
      prompt: '用户修改后的图序说明',
      images: ['https://example.com/reviewed.png'],
    });
    expect(editedSnapshot.inputs ?? []).not.toContainEqual({ type: 'asset', assetId });
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
    const selectedProfile = settings.getProfile(profile.id)!;
    expect(resolveMediaProviderRoute(settings.getProfile(profile.id)!)).toEqual({
      providerType: 'unicompapi',
      providerRegion: 'unicompapi',
      baseUrlCategory: 'official-unicompapi',
    });
    expect(
      resolveMediaProviderRoute({
        ...selectedProfile,
        category: 'llm',
        providerType: 'openai',
        accessType: 'official',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).toEqual({
      providerType: 'openai',
      providerRegion: 'global',
      baseUrlCategory: 'official-openai',
    });
    expect(
      resolveMediaProviderRoute({
        ...selectedProfile,
        category: 'llm',
        providerType: 'openai',
        accessType: 'official',
        protocol: 'openai-responses',
        baseUrl: 'https://proxy.example/v1',
      }),
    ).toBeUndefined();
    expect(
      resolveMediaProviderRoute({
        ...selectedProfile,
        accessType: 'custom',
      }),
    ).toBeUndefined();
  });
  it('offers custom OpenAI Images to enabled models without a model binding', async () => {
    const f = await setup();
    const customProfile = f.settings.createProfile({
      name: 'Custom Images',
      category: 'llm',
      providerType: 'custom',
      accessType: 'custom',
      protocol: 'openai-responses',
      baseUrl: 'https://images.example/v1',
    });
    f.settings.completeConnectionTest({
      profileId: customProfile.id,
      status: 'ready',
      models: [{ id: 'vendor-image-model' }, { id: 'vendor-edit-model' }],
    });
    const models = f.settings.listModels(customProfile.id);
    const model = models.find((item) => item.remoteModelId === 'vendor-image-model');
    const editModel = models.find((item) => item.remoteModelId === 'vendor-edit-model');
    if (!model || !editModel) throw new Error('expected both custom image models');
    f.settings.updateModel({
      profileId: customProfile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: { ...model.capabilities, imageGeneration: true },
      enabled: true,
    });
    f.settings.updateModel({
      profileId: customProfile.id,
      modelId: editModel.id,
      displayName: editModel.displayName,
      capabilities: { ...editModel.capabilities, imageEditing: true },
      enabled: true,
    });
    expect(
      f.settings.listModels(customProfile.id).map((item) => item.parameterTemplateKey),
    ).toEqual([undefined, undefined]);
    const context = f.service.selectionContext('image', { prompt: 'A red fox' }, f.identity);
    expect(
      context.candidates
        .filter((item) => item.providerProfileId === customProfile.id)
        .map((item) => item.remoteModelId),
    ).toEqual(['vendor-image-model']);
    const candidate = context.candidates.find(
      (item) => item.providerProfileId === customProfile.id,
    )!;
    const adapter = candidate.adapters.find(
      (item) => item.key === 'TEXT_TO_IMAGE:custom:openai-images:v1',
    )!;
    expect(candidate.remoteModelId).toBe('vendor-image-model');
    const draft = f.service.prepareSelected(
      context,
      {
        providerProfileId: customProfile.id,
        modelId: model.id,
        adapterKey: adapter.key,
        parameters: { prompt: 'A red fox' },
      },
      f.identity,
    );
    expect(draft.mediaModelSelection).toMatchObject({
      providerBaseUrl: 'https://images.example/v1',
      providerBaseUrlCategory: 'custom-openai-compatible',
      providerRegion: 'global',
    });
    expect(draft.normalizedParameters).toMatchObject({ prompt: 'A red fox' });
  });
  it('offers custom OpenAI-compatible video models without a model binding', async () => {
    const f = await setup();
    const customProfile = f.settings.createProfile({
      name: 'Custom Video',
      category: 'multi',
      providerType: 'custom',
      accessType: 'custom',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://video.example/v1',
    });
    f.settings.completeConnectionTest({
      profileId: customProfile.id,
      status: 'ready',
      models: [{ id: 'vendor-video-model' }],
    });
    const model = f.settings.listModels(customProfile.id)[0];
    if (!model) throw new Error('expected a synchronized custom video model');
    f.settings.updateModel({
      profileId: customProfile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: { ...model.capabilities, videoGeneration: true },
      enabled: true,
    });
    const textContext = f.service.selectionContext(
      'video',
      { prompt: 'A slow camera move' },
      f.identity,
    );
    const candidate = textContext.candidates.find(
      (item) => item.providerProfileId === customProfile.id,
    );
    expect(candidate?.remoteModelId).toBe('vendor-video-model');
    const textAdapter = candidate?.adapters.find(
      (item) => item.key === 'TEXT_TO_VIDEO:custom:openai-compatible-video:v1',
    );
    expect(textAdapter).toBeDefined();
    const imageContext = f.service.selectionContext(
      'video',
      {
        prompt: 'Animate the reference',
        parameters: { images: ['https://images.example/reference.png'] },
      },
      f.identity,
    );
    expect(
      imageContext.candidates
        .find((item) => item.providerProfileId === customProfile.id)
        ?.adapters.map((item) => item.key),
    ).toContain('IMAGE_TO_VIDEO:custom:openai-compatible-video:v1');
    const draft = f.service.prepareSelected(
      textContext,
      {
        providerProfileId: customProfile.id,
        modelId: model.id,
        adapterKey: textAdapter!.key,
        parameters: { prompt: 'A slow camera move', duration: 8 },
      },
      f.identity,
    );
    expect(draft.mediaModelSelection).toMatchObject({
      providerBaseUrl: 'https://video.example/v1',
      providerBaseUrlCategory: 'custom-openai-compatible',
      remoteModelId: 'vendor-video-model',
    });
  });
});
