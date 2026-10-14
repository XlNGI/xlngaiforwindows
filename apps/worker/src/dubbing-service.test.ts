import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  DubbingCueInfo,
  DubbingJobInfo,
  NativeDubbingPollParams,
  NativeDubbingSpeechParams,
  NativeDubbingSubmitParams,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { createRepositories, DubbingRepository } from '@ai-video/persistence';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettingsService } from './app-settings-service.js';
import { ContentService } from './content-service.js';
import { DubbingService, type DubbingServiceOptions } from './dubbing-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { NativeProviderRequestError } from './native-provider-bridge.js';
import { ProjectService } from './project-service.js';
import { emptyModelCapabilities } from './provider-registry.js';

const resources = resolve('../desktop/src-tauri/resources/ffmpeg');
const runtime = new FfmpegRuntime({ resourceDirectory: resources });
const speechId = randomUUID();
const syncId = randomUUID();
const stamp = '2026-10-14T00:00:00.000Z';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const live: Array<{ directory: string; projects: ProjectService; service: DubbingService }> = [];
let fixtures: string;
let wav: string;
let mp3: string;
let video: string;
let lipVideo: string;

const profiles: ProviderProfileInfo[] = [
  {
    id: speechId,
    name: 'Speech fixture',
    category: 'multi',
    providerType: 'minimax-speech',
    accessType: 'official',
    protocol: 'minimax-speech',
    baseUrl: 'https://api.minimax.cn',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: stamp,
    updatedAt: stamp,
  },
  {
    id: syncId,
    name: 'Sync fixture',
    category: 'video',
    providerType: 'sync',
    accessType: 'official',
    protocol: 'sync-lipsync',
    baseUrl: 'https://api.sync.so',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: stamp,
    updatedAt: stamp,
  },
];
const settings: Pick<AppSettingsService, 'getProfile' | 'listModels'> = {
  getProfile: (id) => profiles.find((profile) => profile.id === id) ?? null,
  listModels: (profileId): ProviderModelInfo[] => [
    {
      id: `${profileId}-model`,
      providerProfileId: profileId,
      remoteModelId: profileId === speechId ? 'speech-2.8-hd' : 'sync-3',
      displayName: 'Fixture',
      capabilities: {
        ...emptyModelCapabilities(),
        speechSynthesis: profileId === speechId,
        lipSync: profileId === syncId,
      },
      source: 'manual',
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
};

async function setup(options: DubbingServiceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-dubbing-service-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  const root = join(directory, 'project');
  projects.create(root, '配音 fixture');
  const content = new ContentService(projects);
  const character = content.saveDocument({
    kind: 'character',
    title: '角色甲',
    contentMarkdown: '# 角色甲',
  });
  const scene = content.saveScene({ title: '场次一' });
  const service = new DubbingService(projects, settings, {
    runtime,
    pollIntervalMs: 1,
    ...options,
  });
  live.push({ directory, projects, service });
  const voice = service.saveVoice({
    characterDocumentId: character.id,
    providerProfileId: speechId,
    model: 'speech-2.8-hd',
    voiceId: 'fixed-voice-one',
    speed: 1,
    pitch: 0,
  });
  const sourceAssetId = randomUUID();
  const sourceRelative = `assets/videos/${sourceAssetId}.mp4`;
  await copyFile(video, join(root, sourceRelative));
  const bytes = await readFile(video);
  projects.access(true, (db, project) =>
    createRepositories(db).assets.save({
      id: sourceAssetId,
      projectId: project.id,
      kind: 'scene-video',
      relativePath: sourceRelative,
      contentHash: digest(bytes),
      sizeBytes: bytes.length,
      createdAt: stamp,
    }),
  );
  const cue = (startMs = 1000, text = '今天出发。', position = 0, lipSync = false) =>
    service.saveCue({
      sceneId: scene.id,
      speakerKind: 'character',
      characterDocumentId: character.id,
      voiceProfileId: voice.id,
      text,
      position,
      startMs,
      lipSync,
      ...(lipSync
        ? { visibleSpeaker: '画面正中唯一人物', speakerCoordinates: [0.5, 0.5] as [number, number] }
        : {}),
    });
  const importTake = async (entry: DubbingCueInfo, path = wav) => {
    const imported = await service.importAudio({
      sourcePath: path,
      cueId: entry.id,
      expectedRowVersion: entry.rowVersion,
      sceneId: scene.id,
    });
    const adopted = service.adoptTake(entry.id, imported.take!.id, entry.rowVersion);
    return { ...imported, cue: adopted };
  };
  const compose = (mode: 'compose' | 'lipsync' = 'compose') =>
    service.submit({
      sceneId: scene.id,
      sourceVideoAssetId: sourceAssetId,
      mode,
      costAcknowledged: mode === 'lipsync',
      removeSourceAudioAcknowledged: true,
      ...(mode === 'lipsync' ? { providerProfileId: syncId, model: 'sync-3' } : {}),
    });
  const job = async (id: string, status = 'complete'): Promise<DubbingJobInfo> => {
    await expect
      .poll(
        () => {
          const current = service.getJob(id)!;
          if (
            status === 'complete' &&
            ['failed', 'cancelled', 'submission_unknown'].includes(current.status)
          ) {
            throw new Error(`Dubbing failed: ${current.errorKind} ${current.error}`);
          }
          return current.status;
        },
        { timeout: 12000 },
      )
      .toBe(status);
    return service.getJob(id)!;
  };
  return {
    directory,
    projects,
    root,
    content,
    character,
    scene,
    service,
    voice,
    sourceAssetId,
    sourceRelative,
    cue,
    importTake,
    compose,
    job,
  };
}

afterEach(async () => {
  for (const { directory, projects, service } of live.splice(0)) {
    await service.cancelAll();
    projects.close();
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe.runIf(process.platform === 'win32')(
  'fixed voice dubbing service with actual bundled media',
  () => {
    beforeAll(async () => {
      fixtures = await mkdtemp(join(tmpdir(), 'ai-video-dubbing-service-fixtures-'));
      wav = join(fixtures, 'dialogue.wav');
      mp3 = join(fixtures, 'dialogue.mp3');
      video = join(fixtures, 'scene.mp4');
      lipVideo = join(fixtures, 'lip.mp4');
      const encode = (args: string[]) =>
        execFileSync(
          join(resources, 'ffmpeg.exe'),
          ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
          { windowsHide: true, timeout: 30000 },
        );
      encode([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000:duration=0.8',
        '-c:a',
        'pcm_s16le',
        wav,
      ]);
      encode(['-i', wav, '-c:a', 'libmp3lame', mp3]);
      encode([
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x120:r=25:d=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=4',
        '-c:v',
        'libopenh264',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        '4000000',
        '-c:a',
        'aac',
        video,
      ]);
      encode([
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=160x120:r=25:d=0.8',
        '-c:v',
        'libopenh264',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        '4000000',
        lipVideo,
      ]);
    });

    afterAll(async () => {
      if (fixtures) await rm(fixtures, { recursive: true, force: true });
    });

    it('imports WAV and MP3 into a dedicated audio store, adopts via CAS and reopens playback', async () => {
      const f = await setup();
      const first = await f.importTake(f.cue());
      const second = await f.importTake(f.cue(2400, '明天再见。', 1), mp3);
      expect(first.audio.mime).toBe('audio/wav');
      expect(second.audio.mime).toBe('audio/mpeg');
      expect(() =>
        f.service.adoptTake(first.cue.id, first.take!.id, first.cue.rowVersion - 1),
      ).toThrow();
      const snapshot = f.service.scene(f.scene.id);
      expect(snapshot.audioFiles).toHaveLength(2);
      expect(snapshot.cues.every((entry) => entry.selectedTakeId)).toBe(true);
      expect(
        f.projects.access(false, (db, project) =>
          createRepositories(db).assets.listByProject(project.id),
        ),
      ).toHaveLength(1);
      const source = f.service.audioSource(first.audio.id);
      expect(source.contentType).toBe('audio/wav');
      expect(await runtime.validate(source.path)).toMatchObject({
        hasAudio: true,
        durationMs: 800,
      });
      expect(() => f.service.trashAudio(first.audio.id)).toThrow('引用');
      f.projects.close();
      f.projects.open(f.root);
      expect(f.service.scene(f.scene.id).cues[0]?.selectedTakeId).toBe(first.take!.id);
      expect(await readFile(f.service.audioSource(second.audio.id).path)).toEqual(
        await readFile(mp3),
      );
    });

    it('preserves immutable voice versions after character rename and rejects stale voice edits', async () => {
      const f = await setup();
      f.content.saveDocument({
        documentId: f.character.id,
        title: '新名字',
        contentMarkdown: '# 新名字',
      });
      expect(f.service.listVoices()[0]?.characterDocumentId).toBe(f.character.id);
      const second = f.service.saveVoice({
        ...f.voice,
        voiceId: 'fixed-voice-two',
        expectedRowVersion: f.voice.rowVersion,
      });
      expect(second.revision).toBe(2);
      expect(() =>
        f.service.saveVoice({ ...f.voice, expectedRowVersion: f.voice.rowVersion }),
      ).toThrow();
      expect(
        f.projects.access(
          false,
          (db, project) =>
            new DubbingRepository(db, project.id).getVoiceVersion(f.voice.versionId)?.voiceId,
        ),
      ).toBe('fixed-voice-one');
    });

    it('composes a new scene, preserves source bytes and supports export plus output adoption', async () => {
      const f = await setup();
      await f.importTake(f.cue());
      const pending = await f.compose();
      const complete = await f.job(pending.id);
      const output = f.projects.access(false, (db) =>
        createRepositories(db).assets.get(complete.outputAssetId!),
      )!;
      expect(output.id).not.toBe(f.sourceAssetId);
      expect(output.contentHash).toBe(digest(await readFile(join(f.root, output.relativePath))));
      expect(await readFile(join(f.root, f.sourceRelative))).toEqual(await readFile(video));
      expect(await runtime.validate(join(f.root, output.relativePath))).toMatchObject({
        durationMs: 4000,
        hasAudio: true,
        hasVideo: true,
      });
      expect(f.service.adoptOutput(complete.id, complete.rowVersion).adoptedAt).toBeTruthy();
      expect(() => f.service.assertVideoDeletable(f.sourceAssetId, true)).toThrow('来源');
      const destination = join(f.directory, 'exported');
      await f.projects.exportProject(destination);
      f.projects.close();
      f.projects.open(destination);
      expect(f.service.getJob(complete.id)?.status).toBe('complete');
      expect(await readFile(join(destination, output.relativePath))).toEqual(
        await readFile(join(f.root, output.relativePath)),
      );
      expect(existsSync(f.service.audioSource(f.service.listAudio()[0]!.id).path)).toBe(true);
    });

    it('deduplicates repeated identical production submissions', async () => {
      const f = await setup();
      await f.importTake(f.cue());
      const first = await f.compose();
      const second = await f.compose();
      expect(second.id).toBe(first.id);
      await f.job(first.id);
      expect(f.service.listJobs()).toHaveLength(1);
    });

    it('rejects overlapping dialogue, short videos and stale text without creating jobs', async () => {
      const f = await setup();
      const first = await f.importTake(f.cue(1000));
      const second = await f.importTake(f.cue(1500, '不要重叠。', 1));
      await expect(f.compose()).rejects.toMatchObject({ code: 'OVERLAPPING_CUES' });
      const moved = f.service.saveCue({
        ...second.cue,
        startMs: 3500,
        expectedRowVersion: second.cue.rowVersion,
      });
      await expect(f.compose()).rejects.toMatchObject({ code: 'VIDEO_TOO_SHORT' });
      f.service.saveCue({
        ...moved,
        startMs: 2400,
        text: '改过的台词。',
        expectedRowVersion: moved.rowVersion,
      });
      await expect(f.compose()).rejects.toMatchObject({ code: 'TAKE_REQUIRED' });
      expect(() => f.service.adoptTake(moved.id, second.take!.id, moved.rowVersion + 1)).toThrow(
        '变化',
      );
      expect(f.service.listJobs()).toHaveLength(0);
      expect(first.audio.contentHash).toBe(digest(await readFile(wav)));
    });

    it('rejects changed source and confirmed audio bytes before production', async () => {
      const f = await setup();
      const imported = await f.importTake(f.cue());
      await writeFile(join(f.root, imported.audio.relativePath), await readFile(mp3));
      await expect(f.compose()).rejects.toMatchObject({ code: 'AUDIO_CHANGED' });
      await writeFile(join(f.root, imported.audio.relativePath), await readFile(wav));
      const source = join(f.root, f.sourceRelative);
      const bytes = await readFile(source);
      await writeFile(source, Buffer.concat([bytes, Buffer.from('modified')]));
      await expect(f.compose()).rejects.toMatchObject({ code: 'VIDEO_CHANGED' });
      expect(f.service.listJobs()).toHaveLength(0);
    });

    it('soft-deletes, restores and purges standalone reference audio without touching material assets', async () => {
      const f = await setup();
      const imported = await f.service.importAudio({ sourcePath: wav, kind: 'reference' });
      const trashed = f.service.trashAudio(imported.audio.id);
      expect(trashed.deletedAt).toBeTruthy();
      expect(() => f.service.audioSource(imported.audio.id)).toThrow('回收站');
      expect(f.service.restoreAudio(imported.audio.id).deletedAt).toBeUndefined();
      f.service.trashAudio(imported.audio.id);
      expect(f.service.purgeAudio(imported.audio.id, true)).toEqual({ purged: true });
      expect(f.service.audio(imported.audio.id)).toBeNull();
      expect(
        f.projects.access(false, (db, project) =>
          createRepositories(db).assets.listByProject(project.id),
        ),
      ).toHaveLength(1);
    });

    it('rejects fake extensions and damaged audio without registering files', async () => {
      const f = await setup();
      const fake = join(f.directory, 'fake.wav');
      await writeFile(fake, await readFile(video));
      await expect(f.service.importAudio({ sourcePath: fake })).rejects.toMatchObject({
        code: 'INVALID_AUDIO',
      });
      const truncated = join(f.directory, 'truncated.wav');
      const bytes = await readFile(wav);
      await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
      await expect(f.service.importAudio({ sourcePath: truncated })).rejects.toThrow(
        'Media processing failed',
      );
      expect(f.service.listAudio()).toHaveLength(0);
    });

    it('permits playback in a read-only project while rejecting production writes', async () => {
      const f = await setup();
      const imported = await f.importTake(f.cue());
      const reader = new ProjectService({
        recentProjectsPath: join(f.directory, 'reader-recent.json'),
      });
      expect(reader.open(f.root).mode).toBe('read-only');
      const service = new DubbingService(reader, settings, { runtime });
      try {
        expect(service.scene(f.scene.id).cues).toHaveLength(1);
        expect(existsSync(service.audioSource(imported.audio.id).path)).toBe(true);
        expect(() =>
          service.saveVoice({
            ...f.voice,
            voiceId: 'changed',
            expectedRowVersion: f.voice.rowVersion,
          }),
        ).toThrow('read-only');
        await expect(service.importAudio({ sourcePath: wav })).rejects.toThrow('read-only');
        await expect(
          service.submit({
            sceneId: f.scene.id,
            sourceVideoAssetId: f.sourceAssetId,
            mode: 'compose',
            costAcknowledged: false,
            removeSourceAudioAcknowledged: true,
          }),
        ).rejects.toThrow('read-only');
      } finally {
        reader.close();
      }
    });

    it('retries failed local composition as a new immutable attempt while retaining its adopted audio', async () => {
      const f = await setup();
      const imported = await f.importTake(f.cue());
      const spy = vi
        .spyOn(runtime, 'composeDubbing')
        .mockRejectedValueOnce(new Error('fixture local output failure'));
      const pending = await f.compose();
      await f.job(pending.id, 'failed');
      const first = f.projects.access(false, (db, project) =>
        new DubbingRepository(db, project.id).listSteps(pending.id),
      )[0]!;
      expect(first).toMatchObject({ kind: 'compose', status: 'failed', attempt: 1 });
      const retried = f.service.retry({ jobId: pending.id });
      expect(retried.id).toBe(pending.id);
      await f.job(pending.id);
      const attempts = f.projects.access(false, (db, project) =>
        new DubbingRepository(db, project.id).listSteps(pending.id),
      );
      expect(attempts).toHaveLength(2);
      expect(attempts.map((step) => [step.status, step.attempt])).toEqual([
        ['failed', 1],
        ['complete', 2],
      ]);
      expect(f.service.scene(f.scene.id).cues[0]?.selectedTakeId).toBe(imported.take!.id);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('uses the frozen fixed voice for TTS and retains it after later voice changes', async () => {
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method !== 'provider.dubbing.speech') return { cancelled: true };
        const p = params as NativeDubbingSpeechParams;
        const output = join(p.projectRoot, p.outputRelativePath);
        mkdirSync(dirname(output), { recursive: true });
        await copyFile(mp3, output);
        return {
          relativePath: p.outputRelativePath,
          mime: 'audio/mpeg',
          sizeBytes: statSync(output).size,
        };
      });
      const f = await setup({ native: { request } });
      const cue = f.cue();
      const pending = f.service.generateTake({
        cueId: cue.id,
        expectedRowVersion: cue.rowVersion,
        costAcknowledged: true,
      });
      f.service.saveVoice({
        ...f.voice,
        voiceId: 'next-voice',
        expectedRowVersion: f.voice.rowVersion,
      });
      await f.job(pending.id);
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.speech'),
      ).toHaveLength(1);
      expect(request.mock.calls[0]?.[1]).toMatchObject({
        voiceId: 'fixed-voice-one',
        model: 'speech-2.8-hd',
        text: cue.text,
        speed: 1,
        pitch: 0,
      });
      const take = f.service.scene(f.scene.id).cues[0]!.takes![0]!;
      expect(take.voiceSnapshot?.voiceId).toBe('fixed-voice-one');
      expect(take.voiceVersionId).toBe(f.voice.versionId);
      expect(
        f.service.generateTake({
          cueId: cue.id,
          expectedRowVersion: cue.rowVersion,
          costAcknowledged: true,
        }).id,
      ).not.toBe(pending.id);
    });

    it('keeps interrupted TTS submission unknown and refuses automatic paid retry', async () => {
      const request = vi.fn(() =>
        Promise.reject(
          new NativeProviderRequestError({
            code: 'TIMEOUT',
            message: 'fixture timeout',
            retryable: true,
          }),
        ),
      );
      const f = await setup({ native: { request } });
      const cue = f.cue();
      const pending = f.service.generateTake({
        cueId: cue.id,
        expectedRowVersion: cue.rowVersion,
        costAcknowledged: true,
      });
      await f.job(pending.id, 'submission_unknown');
      f.service.recover();
      expect(() =>
        f.service.generateTake({
          cueId: cue.id,
          expectedRowVersion: cue.rowVersion,
          costAcknowledged: true,
        }),
      ).toThrow('提交结果');
      expect(() => f.service.retry({ jobId: pending.id, costAcknowledged: true })).toThrow('未知');
      expect(request).toHaveBeenCalledTimes(1);
      expect(f.service.listAudio()).toHaveLength(0);
    });

    it('refuses force-new TTS while an equivalent paid submission remains unknown', async () => {
      const request = vi.fn(() =>
        Promise.reject(
          new NativeProviderRequestError({
            code: 'INTERRUPTED',
            message: 'fixture interrupted',
            retryable: true,
          }),
        ),
      );
      const f = await setup({ native: { request } });
      const cue = f.cue();
      const pending = f.service.generateTake({
        cueId: cue.id,
        expectedRowVersion: cue.rowVersion,
        costAcknowledged: true,
      });
      await f.job(pending.id, 'submission_unknown');
      expect(() =>
        f.service.generateTake({
          cueId: cue.id,
          expectedRowVersion: cue.rowVersion,
          costAcknowledged: true,
          forceNewTake: true,
        }),
      ).toThrow('提交结果');
      expect(request).toHaveBeenCalledTimes(1);
      expect(f.service.listJobs()).toHaveLength(1);
    });

    it('recovers a crashed running speech submission as unknown and never sends another request', async () => {
      const request = vi.fn(() => Promise.resolve({ unexpected: true }));
      const f = await setup({ native: { request } });
      const cue = f.cue();
      const jobId = randomUUID();
      const input = { cue, voice: f.voice };
      f.projects.access(true, (db, project) => {
        const repo = new DubbingRepository(db, project.id);
        repo.addJob({
          id: jobId,
          projectId: project.id,
          sceneId: f.scene.id,
          kind: 'speech',
          status: 'running',
          planVersion: 1,
          inputHash: digest(JSON.stringify(input)),
          inputSnapshot: input,
          budget: { state: 'unknown', maxAttempts: 1 },
          idempotencyKey: randomUUID(),
          rowVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
        repo.addStep({
          id: randomUUID(),
          jobId,
          stepKey: 'speech',
          kind: 'speech',
          dependencies: [],
          status: 'running',
          attempt: 1,
          inputHash: digest('running speech'),
          idempotencyKey: randomUUID(),
          rowVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
      });
      f.projects.close();
      f.projects.open(f.root);
      const recoveredService = new DubbingService(f.projects, settings, {
        runtime,
        native: { request },
      });
      recoveredService.recover();
      expect(recoveredService.getJob(jobId)).toMatchObject({
        status: 'submission_unknown',
        errorKind: 'SUBMISSION_UNKNOWN',
      });
      expect(() => recoveredService.retry({ jobId, costAcknowledged: true })).toThrow('未知');
      expect(() =>
        recoveredService.generateTake({
          cueId: cue.id,
          expectedRowVersion: cue.rowVersion,
          costAcknowledged: true,
          forceNewTake: true,
        }),
      ).toThrow('提交结果');
      expect(request).not.toHaveBeenCalled();
      expect(recoveredService.listAudio()).toHaveLength(0);
    });

    it('submits one frozen lip interval then polls and composes the confirmed local audio', async () => {
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method === 'provider.dubbing.submit') {
          const p = params as NativeDubbingSubmitParams;
          expect(await runtime.validate(join(p.projectRoot, p.videoRelativePath))).toMatchObject({
            durationMs: 800,
            hasVideo: true,
            hasAudio: false,
          });
          expect(await runtime.validate(join(p.projectRoot, p.audioRelativePath))).toMatchObject({
            durationMs: 800,
            sampleRate: 48000,
          });
          expect(p.speakerCoordinates).toEqual([80, 60]);
          return { providerTaskId: 'fixture-remote-task' };
        }
        if (method === 'provider.dubbing.poll') {
          const p = params as NativeDubbingPollParams;
          const output = join(p.projectRoot, p.outputRelativePath);
          mkdirSync(dirname(output), { recursive: true });
          await copyFile(lipVideo, output);
          return { status: 'complete', relativePath: p.outputRelativePath };
        }
        return { cancelled: true };
      });
      const f = await setup({ native: { request } });
      const imported = await f.importTake(f.cue(1000, '只有一个说话人物。', 0, true));
      const pending = await f.compose('lipsync');
      const complete = await f.job(pending.id);
      expect(complete.providerTaskId).toBe('fixture-remote-task');
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.submit'),
      ).toHaveLength(1);
      const steps = f.projects.access(false, (db, project) =>
        new DubbingRepository(db, project.id).listSteps(complete.id),
      );
      expect(steps.every((step) => step.status === 'complete')).toBe(true);
      expect(steps.find((step) => step.kind === 'lipsync')?.resultRelativePath).toMatch(
        /^assets[\\/]dubbing/,
      );
      expect(
        existsSync(
          join(f.root, steps.find((step) => step.kind === 'lipsync')!.resultRelativePath!),
        ),
      ).toBe(true);
      expect(digest(await readFile(join(f.root, imported.audio.relativePath)))).toBe(
        imported.audio.contentHash,
      );
    });

    it('recovers a persisted remote task by polling its original ID without submitting again', async () => {
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method === 'provider.dubbing.submit')
          throw new Error('A recovered remote task must not submit twice.');
        if (method === 'provider.dubbing.poll') {
          const p = params as NativeDubbingPollParams;
          expect(p.providerTaskId).toBe('persisted-task');
          const output = join(p.projectRoot, p.outputRelativePath);
          mkdirSync(dirname(output), { recursive: true });
          await copyFile(lipVideo, output);
          return { status: 'complete', relativePath: p.outputRelativePath };
        }
        return { cancelled: true };
      });
      const f = await setup({ native: { request } });
      const imported = await f.importTake(f.cue(1000, '恢复后不要重复扣费。', 0, true));
      const jobId = randomUUID();
      const snapshot = {
        sourceVideoAssetId: f.sourceAssetId,
        sourceRelativePath: f.sourceRelative,
        sourceContentHash: digest(await readFile(video)),
        durationMs: 4000,
        providerProfileId: syncId,
        model: 'sync-3',
        cues: [{ cue: imported.cue, take: imported.take, audio: imported.audio, endMs: 1800 }],
      };
      f.projects.access(true, (db, project) => {
        const repo = new DubbingRepository(db, project.id);
        repo.addJob(
          {
            id: jobId,
            projectId: project.id,
            sceneId: f.scene.id,
            kind: 'lipsync',
            status: 'running',
            planVersion: 1,
            inputHash: digest(JSON.stringify(snapshot)),
            inputSnapshot: snapshot,
            budget: { state: 'unknown', maxAttempts: 1 },
            idempotencyKey: randomUUID(),
            sourceVideoAssetId: f.sourceAssetId,
            providerTaskId: 'persisted-task',
            deadline: new Date(Date.now() + 60000).toISOString(),
            rowVersion: 1,
            createdAt: stamp,
            updatedAt: stamp,
          },
          [imported.audio.id],
        );
        repo.addStep({
          id: randomUUID(),
          jobId,
          stepKey: `lipsync:${imported.cue.id}`,
          kind: 'lipsync',
          dependencies: [],
          status: 'running',
          attempt: 1,
          inputHash: digest('persisted step'),
          idempotencyKey: randomUUID(),
          providerTaskId: 'persisted-task',
          rowVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
      });
      f.projects.close();
      f.projects.open(f.root);
      f.service.recover();
      await f.job(jobId);
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.submit'),
      ).toHaveLength(0);
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.poll'),
      ).toHaveLength(1);
    });

    it('reuses a completed lip interval after adding another cue without charging for the unchanged clip', async () => {
      let remoteTasks = 0;
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method === 'provider.dubbing.submit')
          return { providerTaskId: `reusable-task-${++remoteTasks}` };
        if (method === 'provider.dubbing.poll') {
          const p = params as NativeDubbingPollParams;
          const output = join(p.projectRoot, p.outputRelativePath);
          mkdirSync(dirname(output), { recursive: true });
          await copyFile(lipVideo, output);
          return { status: 'complete', relativePath: p.outputRelativePath };
        }
        return { cancelled: true };
      });
      const f = await setup({ native: { request } });
      const firstCue = await f.importTake(f.cue(1000, '保留成功口型片段。', 0, true));
      const initial = await f.compose('lipsync');
      await f.job(initial.id);
      const originalStep = f.projects.access(false, (db, project) =>
        new DubbingRepository(db, project.id)
          .listSteps(initial.id)
          .find((step) => step.kind === 'lipsync'),
      )!;
      await f.importTake(f.cue(2400, '只制作这个新增片段。', 1, true));
      const next = await f.service.submit({
        sceneId: f.scene.id,
        sourceVideoAssetId: f.sourceAssetId,
        mode: 'lipsync',
        providerProfileId: syncId,
        model: 'sync-3',
        costAcknowledged: true,
        removeSourceAudioAcknowledged: true,
        budget: { currency: 'USD', unitPrice: 1, maxAmount: 3, maxAttempts: 3 },
      });
      expect(next.id).not.toBe(initial.id);
      await f.job(next.id);
      const steps = f.projects.access(false, (db, project) =>
        new DubbingRepository(db, project.id).listSteps(next.id),
      );
      const reused = steps.find((step) => step.stepKey === `lipsync:${firstCue.cue.id}`)!;
      expect(reused).toMatchObject({
        status: 'complete',
        inputHash: originalStep.inputHash,
        resultRelativePath: originalStep.resultRelativePath,
        resultContentHash: originalStep.resultContentHash,
      });
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.submit'),
      ).toHaveLength(2);
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.poll'),
      ).toHaveLength(2);
      expect(existsSync(join(f.root, originalStep.resultRelativePath!))).toBe(true);
    });

    it('cancels native work and drops late results across a project switch', async () => {
      let resolveSpeech: ((result: unknown) => void) | undefined;
      const request = vi.fn((method: string) =>
        method === 'provider.dubbing.speech'
          ? new Promise<unknown>((resolveResult) => {
              resolveSpeech = resolveResult;
            })
          : Promise.resolve({ cancelled: true }),
      );
      const f = await setup({ native: { request } });
      const cue = f.cue();
      const pending = f.service.generateTake({
        cueId: cue.id,
        expectedRowVersion: cue.rowVersion,
        costAcknowledged: true,
      });
      await expect.poll(() => Boolean(resolveSpeech)).toBe(true);
      expect(f.service.cancel(pending.id).status).toBe('cancelled');
      f.projects.close();
      f.projects.create(join(f.directory, 'second'), '第二项目');
      resolveSpeech!({ relativePath: 'invalid', mime: 'audio/mpeg', sizeBytes: 0 });
      await expect.poll(() => f.service.listJobs().length).toBe(0);
      expect(f.service.listAudio()).toHaveLength(0);
      f.projects.close();
      f.projects.open(f.root);
      expect(f.service.getJob(pending.id)?.status).toBe('cancelled');
      f.service.recover();
      expect(
        request.mock.calls.filter(([method]) => method === 'provider.dubbing.speech'),
      ).toHaveLength(1);
    });
  },
);
