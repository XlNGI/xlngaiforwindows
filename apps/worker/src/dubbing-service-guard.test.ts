import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  NativeDubbingPollParams,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettingsService } from './app-settings-service.js';
import { ContentService } from './content-service.js';
import { DubbingService } from './dubbing-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { NativeProviderRequestError } from './native-provider-bridge.js';
import { ProjectService } from './project-service.js';
import { emptyModelCapabilities } from './provider-registry.js';

const speechProfileId: string = randomUUID();
const syncProfileId: string = randomUUID();
const stamp = '2026-10-14T00:00:00.000Z';
const videoBytes = Buffer.from('\0\0\0\x18ftypisom-fixture-video');
const audioBytes = Buffer.from('RIFF0000WAVE-fixture-audio');
const open: Array<{ directory: string; project: ProjectService; service: DubbingService }> = [];

const settings: Pick<AppSettingsService, 'getProfile' | 'listModels'> = {
  getProfile(profileId): ProviderProfileInfo | null {
    if (![speechProfileId, syncProfileId].includes(profileId)) return null;
    const speech = profileId === speechProfileId;
    return {
      id: profileId,
      name: 'Local fixture',
      category: speech ? 'multi' : 'video',
      providerType: speech ? 'minimax-speech' : 'sync',
      protocol: speech ? 'minimax-speech' : 'sync-lipsync',
      accessType: 'official',
      baseUrl: speech ? 'https://api.minimax.cn' : 'https://api.sync.so',
      enabled: true,
      connectionStatus: 'ready',
      createdAt: stamp,
      updatedAt: stamp,
    };
  },
  listModels(profileId): ProviderModelInfo[] {
    const speech = profileId === speechProfileId;
    return [
      {
        id: `${profileId}-model`,
        providerProfileId: profileId,
        remoteModelId: speech ? 'speech-2.8-hd' : 'sync-3',
        displayName: 'Local fixture',
        capabilities: { ...emptyModelCapabilities(), speechSynthesis: speech, lipSync: !speech },
        source: 'manual',
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];
  },
};

async function fixture(
  request = vi.fn((method: string, params: unknown) => {
    void method;
    void params;
    return Promise.resolve({ cancelled: true });
  }),
) {
  const directory = await mkdtemp(join(tmpdir(), 'dubbing-service-guard-'));
  const root = join(directory, 'project');
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  project.create(root, 'Guard fixture');
  const content = new ContentService(project);
  const character = content.saveDocument({
    kind: 'character',
    title: '角色',
    contentMarkdown: '# 角色',
  });
  const scene = content.saveScene({ title: '场次' });
  const runtime = new FfmpegRuntime();
  vi.spyOn(runtime, 'availability').mockResolvedValue({
    available: true,
    version: 'local fixture',
  });
  vi.spyOn(runtime, 'probe').mockResolvedValue({
    hasAudio: true,
    hasVideo: true,
    durationMs: 4000,
    fps: 25,
    width: 160,
    height: 120,
  });
  vi.spyOn(runtime, 'validate').mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('.wav') || path.endsWith('.mp3')
        ? { hasAudio: true, hasVideo: false, durationMs: 800, sampleRate: 48000, channels: 1 }
        : { hasAudio: false, hasVideo: true, durationMs: 800, fps: 25, width: 160, height: 120 },
    ),
  );
  vi.spyOn(runtime, 'extractClip').mockImplementation((source, output) => {
    void source;
    writeFileSync(output, videoBytes);
    return Promise.resolve({
      hasAudio: false,
      hasVideo: true,
      durationMs: 800,
      fps: 25,
      width: 160,
      height: 120,
    });
  });
  vi.spyOn(runtime, 'convertAudio').mockImplementation((source, output) => {
    copyFileSync(source, output);
    return Promise.resolve({
      hasAudio: true,
      hasVideo: false,
      durationMs: 800,
      sampleRate: 48000,
      channels: 1,
    });
  });
  vi.spyOn(runtime, 'composeDubbing').mockImplementation((source, output) => {
    void source;
    writeFileSync(output, videoBytes);
    return Promise.resolve({ hasAudio: true, hasVideo: true, durationMs: 4000, fps: 25 });
  });
  const service = new DubbingService(project, settings, {
    runtime,
    native: { request },
    pollIntervalMs: 1,
  });
  open.push({ directory, project, service });
  const voice = service.saveVoice({
    characterDocumentId: character.id,
    providerProfileId: speechProfileId,
    model: 'speech-2.8-hd',
    voiceId: 'Chinese (Mandarin)_Lyrical_Voice',
    speed: 1,
    pitch: 0,
  });
  const sourceVideoAssetId = randomUUID();
  const sourceRelative = `assets/videos/${sourceVideoAssetId}.mp4`;
  mkdirSync(dirname(join(root, sourceRelative)), { recursive: true });
  writeFileSync(join(root, sourceRelative), videoBytes);
  project.access(true, (db, current) =>
    createRepositories(db).assets.save({
      id: sourceVideoAssetId,
      projectId: current.id,
      kind: 'video',
      relativePath: sourceRelative,
      contentHash: createHash('sha256').update(videoBytes).digest('hex'),
      sizeBytes: videoBytes.length,
      createdAt: stamp,
    }),
  );
  const cue = service.saveCue({
    sceneId: scene.id,
    speakerKind: 'character',
    characterDocumentId: character.id,
    voiceProfileId: voice.id,
    text: '保持固定音色。',
    position: 0,
    startMs: 1000,
    lipSync: true,
    visibleSpeaker: '唯一人物',
    speakerCoordinates: [0.5, 0.5],
  });
  const input = join(directory, 'audio.wav');
  writeFileSync(input, audioBytes);
  const imported = await service.importAudio({
    sourcePath: input,
    cueId: cue.id,
    expectedRowVersion: cue.rowVersion,
  });
  const adopted = service.adoptTake(cue.id, imported.take!.id, cue.rowVersion);
  const submit = (budget?: {
    currency: string;
    unitPrice?: number;
    maxAmount?: number;
    maxAttempts?: number;
  }) =>
    service.submit({
      sceneId: scene.id,
      sourceVideoAssetId,
      mode: 'lipsync',
      providerProfileId: syncProfileId,
      model: 'sync-3',
      costAcknowledged: true,
      removeSourceAudioAcknowledged: true,
      budget,
    });
  return { root, project, service, voice, cue: adopted, request, submit };
}

afterEach(async () => {
  for (const { directory, project, service } of open.splice(0)) {
    await service.cancelAll();
    project.close();
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('fixed voice submission guards without paid network calls', () => {
  it('accepts documented voice IDs with spaces while refusing header control characters', async () => {
    const f = await fixture();
    expect(f.voice.voiceId).toBe('Chinese (Mandarin)_Lyrical_Voice');
    expect(() =>
      f.service.saveVoice({
        ...f.voice,
        voiceId: 'voice\r\nx-api-key: secret',
        expectedRowVersion: f.voice.rowVersion,
      }),
    ).toThrow('音色 ID');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('expires a queued speech authorization before issuing a Native request', async () => {
    const f = await fixture();
    const job = f.service.generateTake({
      cueId: f.cue.id,
      expectedRowVersion: f.cue.rowVersion,
      costAcknowledged: true,
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000);
    await expect.poll(() => f.service.getJob(job.id)?.status).toBe('failed');
    expect(f.service.getJob(job.id)?.errorKind).toBe('DEADLINE_EXCEEDED');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('keeps a cancelled job cancelled when a late uncertain submit response arrives', async () => {
    let rejectSubmit!: (error: Error) => void;
    const request = vi.fn((method: string, params: unknown) => {
      void params;
      if (method === 'provider.dubbing.submit')
        return new Promise<never>((_resolve, reject) => {
          rejectSubmit = reject;
        });
      return Promise.resolve({ cancelled: true });
    });
    const f = await fixture(request);
    const job = await f.submit();
    await expect.poll(() => Boolean(rejectSubmit)).toBe(true);
    expect(f.service.cancel(job.id).status).toBe('cancelled');
    rejectSubmit(
      new NativeProviderRequestError({
        code: 'SUBMISSION_UNKNOWN',
        message: 'Uncertain outcome.',
        retryable: false,
        providerTaskId: 'generation_123',
      }),
    );
    await f.service.cancelAll();
    expect(f.service.getJob(job.id)?.status).toBe('cancelled');
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.poll'),
    ).toHaveLength(0);
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.submit'),
    ).toHaveLength(1);
  });

  it('recovers a safe task ID from an uncertain submit and polls without another paid submission', async () => {
    const request = vi.fn((method: string, params: unknown) => {
      if (method === 'provider.dubbing.submit')
        return Promise.reject(
          new NativeProviderRequestError({
            code: 'SUBMISSION_UNKNOWN',
            message: 'Uncertain outcome.',
            retryable: false,
            providerTaskId: 'generation_123',
            providerErrorCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
          }),
        );
      if (method === 'provider.dubbing.poll') {
        const input = params as NativeDubbingPollParams;
        expect(input.providerTaskId).toBe('generation_123');
        expect(input.outputRelativePath).not.toContain('\\');
        writeFileSync(join(input.projectRoot, input.outputRelativePath), videoBytes);
        return Promise.resolve({ status: 'complete', relativePath: input.outputRelativePath });
      }
      return Promise.resolve({ cancelled: true });
    });
    const f = await fixture(request);
    const job = await f.submit();
    await expect.poll(() => f.service.getJob(job.id)?.status).toBe('complete');
    expect(f.service.getJob(job.id)?.providerTaskId).toBe('generation_123');
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.submit'),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.poll'),
    ).toHaveLength(1);
    const submitted = request.mock.calls.find(
      ([method]) => method === 'provider.dubbing.submit',
    )![1] as { videoRelativePath: string; audioRelativePath: string; speakerCoordinates: number[] };
    expect(submitted.videoRelativePath).not.toContain('\\');
    expect(submitted.audioRelativePath).not.toContain('\\');
    expect(submitted.speakerCoordinates).toEqual([80, 60]);
  });

  it('rejects an estimate exceeding the authorized amount before creating or sending a job', async () => {
    const f = await fixture();
    await expect(f.submit({ currency: 'USD', unitPrice: 1, maxAmount: 0.5 })).rejects.toMatchObject(
      { code: 'BUDGET_EXCEEDED' },
    );
    expect(f.service.listJobs()).toHaveLength(0);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('keeps a paid submission with HTTP 500 and no task ID unknown and blocks another billable take', async () => {
    const request = vi.fn((method: string, params: unknown) => {
      void params;
      if (method === 'provider.dubbing.speech')
        return Promise.reject(
          new NativeProviderRequestError({
            code: 'PROVIDER_FAILED',
            message: 'Server failed after receiving submission.',
            retryable: false,
            providerStatus: 500,
          }),
        );
      return Promise.resolve({ cancelled: true });
    });
    const f = await fixture(request);
    const job = f.service.generateTake({
      cueId: f.cue.id,
      expectedRowVersion: f.cue.rowVersion,
      costAcknowledged: true,
    });
    await expect.poll(() => f.service.getJob(job.id)?.status).toBe('submission_unknown');
    expect(() =>
      f.service.generateTake({
        cueId: f.cue.id,
        expectedRowVersion: f.cue.rowVersion,
        costAcknowledged: true,
        forceNewTake: true,
      }),
    ).toThrow();
    expect(() => f.service.retry({ jobId: job.id, costAcknowledged: true })).toThrow();
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.speech'),
    ).toHaveLength(1);
    expect(f.service.listJobs()).toHaveLength(1);
  });

  it('retries rate-limited and HTTP 503 queries while retaining one paid Sync submission', async () => {
    let polls = 0;
    const request = vi.fn((method: string, params: unknown) => {
      if (method === 'provider.dubbing.submit')
        return Promise.resolve({ providerTaskId: 'generation_123' });
      if (method === 'provider.dubbing.poll') {
        const input = params as NativeDubbingPollParams;
        expect(input.providerTaskId).toBe('generation_123');
        polls += 1;
        if (polls === 1)
          return Promise.reject(
            new NativeProviderRequestError({
              code: 'RATE_LIMITED',
              message: 'Query rate limit.',
              retryable: false,
              providerStatus: 429,
            }),
          );
        if (polls === 2)
          return Promise.reject(
            new NativeProviderRequestError({
              code: 'PROVIDER_FAILED',
              message: 'Query service unavailable.',
              retryable: false,
              providerStatus: 503,
            }),
          );
        writeFileSync(join(input.projectRoot, input.outputRelativePath), videoBytes);
        return Promise.resolve({ status: 'complete', relativePath: input.outputRelativePath });
      }
      return Promise.resolve({ cancelled: true });
    });
    const f = await fixture(request);
    const job = await f.submit();
    await expect.poll(() => f.service.getJob(job.id)?.status).toBe('complete');
    expect(f.service.getJob(job.id)?.providerTaskId).toBe('generation_123');
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.submit'),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(([method]) => method === 'provider.dubbing.poll'),
    ).toHaveLength(3);
  });
});
