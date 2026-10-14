import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceReferenceRepository, DubbingRepository } from '@ai-video/persistence';
import type {
  ProviderModelInfo,
  ProviderProfileInfo,
  AdapterParameters,
} from '@ai-video/contracts';
import { getAdapter } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { DubbingService } from './dubbing-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { VideoGenerationService } from './video-generation-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { AdapterService } from './adapter-service.js';
import { MediaPreparationService } from './media-preparation-service.js';
import { MediaOrchestrationService } from './media-orchestration-service.js';
import { ProjectTaskRuntime } from './project-task-runtime.js';
import { listProviderDefinitions, emptyModelCapabilities } from './provider-registry.js';
import type { AppSettingsService } from './app-settings-service.js';
import type { NativeProviderBridge } from './native-provider-bridge.js';

const resources = resolve('../desktop/src-tauri/resources/ffmpeg');
const roots: string[] = [];
const projects: ProjectService[] = [];
let mediaRoot: string;
let wav: string;
let image: string;
let video: string;
beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'official-video-media-'));
  wav = join(mediaRoot, 'voice.wav');
  image = join(mediaRoot, 'actor.png');
  video = join(mediaRoot, 'scene.mp4');
  const executable = join(resources, 'ffmpeg.exe');
  const run = (args: string[]) =>
    execFileSync(executable, ['-v', 'error', '-n', ...args], { windowsHide: true, timeout: 30000 });
  run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=520:sample_rate=48000:duration=3',
    '-c:a',
    'pcm_s16le',
    wav,
  ]);
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=640x480', '-frames:v', '1', image]);
  run([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x480:r=25:d=5',
    '-c:v',
    'libopenh264',
    '-an',
    video,
  ]);
});
afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
});

async function fixture(
  provider: string,
  contract: string,
  revision: number,
  remoteModelId: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'official-video-project-'));
  roots.push(root);
  const ps = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  projects.push(ps);
  const project = ps.create(join(root, 'project'), '角色声音视频');
  const content = new ContentService(ps);
  const character = content.saveDocument({
    kind: 'character',
    title: '主角',
    contentMarkdown: '# 主角',
  });
  const scene = content.saveScene({ title: '第一场' });
  const audioService = new DubbingService(
    ps,
    { getProfile: () => null, listModels: () => [] },
    { runtime: new FfmpegRuntime({ resourceDirectory: resources }) },
  );
  const imported = await audioService.importAudio({ sourcePath: wav, kind: 'reference' });
  const voice = ps.access(true, (db) =>
    new VoiceReferenceRepository(db, project.id).save({
      characterDocumentId: character.id,
      audioId: imported.audio.id,
    }),
  );
  const imageId = randomUUID();
  const relativeImage = `assets/images/${imageId}.png`;
  mkdirSync(join(project.rootPath, 'assets/images'), { recursive: true });
  copyFileSync(image, join(project.rootPath, relativeImage));
  ps.access(true, (db) =>
    db
      .prepare(
        'INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        imageId,
        project.id,
        'character',
        relativeImage,
        createHash('sha256').update(readFileSync(image)).digest('hex'),
        statSync(image).size,
        new Date().toISOString(),
      ),
  );
  const definition = listProviderDefinitions().find((value) => value.providerType === provider)!;
  const stamp = new Date().toISOString();
  const profile: ProviderProfileInfo = {
    ...definition,
    id: randomUUID(),
    enabled: true,
    connectionStatus: 'ready',
    createdAt: stamp,
    updatedAt: stamp,
    ...(provider === 'wan-video'
      ? { baseUrl: 'https://fixture-space.cn-beijing.maas.aliyuncs.com' }
      : {}),
  };
  const model: ProviderModelInfo = {
    id: randomUUID(),
    providerProfileId: profile.id,
    remoteModelId,
    displayName: remoteModelId,
    enabled: true,
    source: 'built-in',
    capabilities: { ...emptyModelCapabilities(), videoGeneration: true },
    contractId: contract,
    contractRevision: revision,
    contractStatus: 'enabled',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const settings = {
    getProfile: () => profile,
    listModels: () => [model],
    listModelPricing: () => [],
    getAdapterSchemaRecord: () => undefined,
  } as unknown as AppSettingsService;
  const videos = new VideoGenerationService(ps);
  const images = new ImageGenerationService(ps);
  const prepare = new MediaPreparationService(ps, settings, new AdapterService(ps), images, videos);
  const adapterKey = `REFERENCE_TO_VIDEO:${provider}:${contract}:contract-${revision}`;
  expect(getAdapter(adapterKey)).toBeDefined();
  const parameters: AdapterParameters =
    provider === 'wan-video'
      ? {
          prompt: '图1的主角用音频1音色说你好。',
          media: [
            { type: 'reference_image', url: `asset://${imageId}` },
            {
              type: 'reference_audio',
              url: `character-voice://${character.id}/${voice.versionId}`,
            },
          ],
          duration: 5,
        }
      : {
          content: [
            { type: 'text', text: '图1的主角用音频1音色说你好。' },
            {
              type: 'image_url',
              image_url: { url: `asset://${imageId}` },
              role: 'reference_image',
            },
            {
              type: 'audio_url',
              audio_url: { url: `character-voice://${character.id}/${voice.versionId}` },
              role: 'reference_audio',
            },
          ],
          duration: 5,
          resolution: provider === 'minimax-video' ? '768P' : '720p',
        };
  const request = vi
    .fn<(method: string, params: unknown) => Promise<unknown>>()
    .mockResolvedValue({ status: 200, taskId: `task-${provider}` });
  const orchestration = new MediaOrchestrationService(ps, settings, images, videos, {
    request,
  } as unknown as NativeProviderBridge);
  return {
    ps,
    project,
    scene,
    character,
    voice,
    imported,
    videos,
    prepare,
    orchestration,
    request,
    parameters,
    adapterKey,
    profile,
    model,
  };
}

describe('official audio reference video pipeline with actual local media', () => {
  it.each([
    ['wan-video', 'cn.qwen.wan3-0-video', 3, 'wan3.0-video'],
    ['seedance-video', 'cn.bytedance.seedance2-5.video', 2, 'doubao-seedance-2-5-260628'],
    ['minimax-video', 'cn.minimax.h3.video', 2, 'MiniMax-H3'],
  ] as const)(
    'prepares, confirms, resumes and archives %s output without media bytes in IPC',
    async (provider, contract, revision, remote) => {
      const f = await fixture(provider, contract, revision, remote);
      const pending = f.prepare.prepareVideo({
        sceneId: f.scene.id,
        adapterKey: f.adapterKey,
        parameters: f.parameters,
        providerRegion: 'cn',
        providerProfileId: f.profile.id,
        modelId: f.model.id,
      });
      expect(f.request).not.toHaveBeenCalled();
      const review = f.orchestration.requestSubmission({ jobId: pending.id });
      expect(review.confirmation).toBeDefined();
      const submitted = await f.orchestration.confirmSubmission({
        jobId: pending.id,
        confirmationToken: review.confirmation!.confirmationToken,
        approved: true,
      });
      expect(submitted.job.status).toBe('polling');
      const sent = JSON.stringify(f.request.mock.calls[0]?.[1]);
      expect(sent).toContain('controlled-file://');
      expect(sent).not.toContain('base64');
      expect(sent).toContain('sha256');
      expect(sent).toContain(f.character.id);
      if (provider === 'wan-video') expect(sent).toContain(f.profile.baseUrl);
      const taskId = (submitted.job as { providerTaskId?: string }).providerTaskId;
      expect(taskId).toBe(`task-${provider}`);
      expect(
        f.ps.access(false, (db) =>
          new DubbingRepository(db, f.project.id).countAudioReferences(f.imported.audio.id),
        ),
      ).toBeGreaterThan(1);
      f.ps.close();
      f.ps.open(f.project.rootPath);
      const nativeRoot = join(tmpdir(), 'ai-video-workspace-unicompapi');
      mkdirSync(nativeRoot, { recursive: true });
      const nativeDir = await mkdtemp(join(nativeRoot, 'official-fixture-'));
      roots.push(nativeDir);
      const output = join(nativeDir, 'output.mp4');
      copyFileSync(video, output);
      const poll = vi
        .fn<(method: string, params: unknown) => Promise<unknown>>()
        .mockResolvedValue({
          providerStatus: 200,
          state: 'succeeded',
          output: { type: 'native_temporary_file', path: output, contentType: 'video/mp4' },
        });
      const runtime = new ProjectTaskRuntime(
        f.ps,
        f.videos,
        { request: poll },
        { random: () => 0 },
      );
      runtime.start();
      try {
        await vi.waitFor(() => expect(f.videos.get(pending.id).status).toBe('succeeded'), {
          timeout: 10000,
          interval: 25,
        });
        expect(poll.mock.calls[0]?.[1]).toEqual(
          expect.objectContaining({ providerTaskId: taskId, adapterKey: f.adapterKey }),
        );
        if (provider === 'wan-video')
          expect(poll.mock.calls[0]?.[1]).toEqual(
            expect.objectContaining({ baseUrl: f.profile.baseUrl }),
          );
        const result = f.videos.get(pending.id).results[0]!.asset;
        expect(result.kind).toBe('scene-video');
        expect(readFileSync(join(f.ps.current()!.rootPath, result.relativePath))).toEqual(
          readFileSync(video),
        );
        expect(f.request).toHaveBeenCalledTimes(1);
      } finally {
        runtime.stop();
      }
    },
  );
  it('rejects stale voice versions before any paid submission and preserves cancellation with late IDs', async () => {
    const f = await fixture('wan-video', 'cn.qwen.wan3-0-video', 3, 'wan3.0-video');
    const imported = await new DubbingService(f.ps, {
      getProfile: () => null,
      listModels: () => [],
    }).importAudio({ sourcePath: wav, kind: 'reference' });
    f.ps.access(true, (db) =>
      new VoiceReferenceRepository(db, f.project.id).save({
        characterDocumentId: f.character.id,
        audioId: imported.audio.id,
        expectedRowVersion: f.voice.rowVersion,
      }),
    );
    expect(() =>
      f.prepare.prepareVideo({
        adapterKey: f.adapterKey,
        parameters: f.parameters,
        providerRegion: 'cn',
        providerProfileId: f.profile.id,
        modelId: f.model.id,
      }),
    ).toThrow('已更新');
    expect(f.request).not.toHaveBeenCalled();
    const simple = f.videos.prepare({
      adapterKey: f.adapterKey,
      parameters: { prompt: '你好' },
      providerRegion: 'cn',
      providerProfileId: f.profile.id,
      modelId: f.model.id,
    });
    f.videos.cancel(simple.id);
    const late = f.videos.attachTask({ jobId: simple.id, providerTaskId: 'late-safe-id' });
    expect(late.status).toBe('cancelled');
    expect(late.providerTaskId).toBe('late-safe-id');
  });
  it('rejects a changed Wan workspace after the production inputs were frozen', async () => {
    const f = await fixture('wan-video', 'cn.qwen.wan3-0-video', 3, 'wan3.0-video');
    const pending = f.prepare.prepareVideo({
      adapterKey: f.adapterKey,
      parameters: f.parameters,
      providerRegion: 'cn',
      providerProfileId: f.profile.id,
      modelId: f.model.id,
    });
    f.profile.baseUrl = 'https://other-space.cn-beijing.maas.aliyuncs.com';
    expect(() => f.orchestration.requestSubmission({ jobId: pending.id })).toThrow(
      'Provider workspace URL',
    );
    expect(f.request).not.toHaveBeenCalled();
  });
});
