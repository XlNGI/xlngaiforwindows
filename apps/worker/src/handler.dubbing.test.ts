import { CURRENT_SCHEMA_VERSION } from '@ai-video/persistence';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkerMethod, WorkerMethodMap } from '@ai-video/contracts';
import { IPC_PROTOCOL_VERSION } from '@ai-video/contracts';
import { createRepositories, DubbingRepository, openProjectDatabase } from '@ai-video/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, parseRequest } from './handler.js';
import { ProjectService } from './project-service.js';

// The singleton handler keeps its settings connection until the worker exits.
// Isolate it from both other test workers and the user's actual app settings.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.AI_VIDEO_APP_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-video-dubbing-handler-settings-'),
  );
});

const temporaryDirectories: string[] = [];
const profileIds: string[] = [];
const owners: ProjectService[] = [];
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function rpc<M extends WorkerMethod>(method: M, params: WorkerMethodMap[M]['params']) {
  const request = parseRequest({
    id: randomUUID(),
    protocolVersion: IPC_PROTOCOL_VERSION,
    method,
    params,
  });
  const response = 'ok' in request ? request : await handleRequest(request);
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as WorkerMethodMap[M]['result'];
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-handler-dubbing-'));
  temporaryDirectories.push(directory);
  const root = join(directory, 'project');
  const project = await rpc('project.create', { rootPath: root, name: '本地配音路由验证' });
  const scene = await rpc('scene.save', { title: '对白场次' });
  const character = await rpc('document.save', {
    kind: 'character',
    title: '小林',
    contentMarkdown: '角色资料',
  });
  const profile = await rpc('provider.profile.create', {
    name: `Dubbing fixture ${randomUUID()}`,
    category: 'multi',
    providerType: 'minimax-speech',
    accessType: 'official',
    protocol: 'minimax-speech',
    baseUrl: 'https://api.minimax.cn',
  });
  profileIds.push(profile.id);
  const voice = await rpc('characterVoice.save', {
    characterDocumentId: character.id,
    providerProfileId: profile.id,
    model: 'speech-2.8-hd',
    voiceId: 'fixture-voice-only',
    speed: 1,
    pitch: 0,
  });
  const cue = await rpc('dubbing.cue.save', {
    sceneId: scene.id,
    speakerKind: 'character',
    characterDocumentId: character.id,
    voiceProfileId: voice.id,
    text: '今天出发。',
    position: 0,
    startMs: 0,
    lipSync: false,
  });
  const wav = join(directory, 'line.wav');
  const ffmpeg = resolve('../desktop/src-tauri/resources/ffmpeg/ffmpeg.exe');
  execFileSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:duration=0.6',
      '-ar',
      '32000',
      '-ac',
      '1',
      wav,
    ],
    { windowsHide: true },
  );
  return { directory, root, project, scene, character, profile, voice, cue, wav };
}
afterEach(async () => {
  await rpc('project.close', {});
  for (const owner of owners.splice(0)) owner.close();
  for (const profileId of profileIds.splice(0))
    await rpc('provider.profile.archive', { profileId });
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('dubbing Worker RPC integration', () => {
  it.each(['wav', 'mp3'])(
    'imports and persists a role voice sample through the %s RPC entrypoint',
    async (format) => {
      const f = await fixture();
      let sourcePath = f.wav;
      if (format === 'mp3') {
        sourcePath = join(f.directory, 'sample.mp3');
        execFileSync(
          resolve('../desktop/src-tauri/resources/ffmpeg/ffmpeg.exe'),
          ['-v', 'error', '-i', f.wav, sourcePath],
          { windowsHide: true },
        );
      }
      expect(await rpc('characterVoiceReference.list', {})).toEqual([]);
      const imported = await rpc('audio.import', { sourcePath, kind: 'reference' });
      const saved = await rpc('characterVoiceReference.save', {
        characterDocumentId: f.character.id,
        audioId: imported.audio.id,
        expectedRowVersion: 0,
      });
      expect(saved).toMatchObject({
        projectId: f.project.id,
        characterDocumentId: f.character.id,
        audioId: imported.audio.id,
        revision: 1,
        rowVersion: 1,
      });
      expect(await rpc('characterVoiceReference.list', {})).toEqual([saved]);
      const source = await rpc('audio.mediaSource', { audioId: saved.audioId });
      expect(digest(await readFile(source.path))).toBe(imported.audio.contentHash);
      expect(await rpc('asset.list', {})).toEqual([]);

      const replacement = await rpc('characterVoiceReference.save', {
        characterDocumentId: f.character.id,
        audioId: imported.audio.id,
        expectedRowVersion: saved.rowVersion,
      });
      expect(replacement).toMatchObject({ id: saved.id, revision: 2, rowVersion: 2 });
      expect(replacement.versionId).not.toBe(saved.versionId);
      await expect(
        rpc('characterVoiceReference.save', {
          characterDocumentId: f.character.id,
          audioId: imported.audio.id,
          expectedRowVersion: saved.rowVersion,
        }),
      ).rejects.toThrow('角色声音样本已变化');
      await rpc('project.close', {});
      await rpc('project.open', { rootPath: f.root });
      expect(await rpc('characterVoiceReference.list', {})).toEqual([replacement]);
      await rpc('project.create', { rootPath: join(f.directory, 'other'), name: '独立项目' });
      expect(await rpc('characterVoiceReference.list', {})).toEqual([]);
    },
  );

  it('keeps scene and task subscriptions bounded while retaining full frozen job history on demand', async () => {
    const f = await fixture();
    const imported = await rpc('audio.import', {
      sourcePath: f.wav,
      cueId: f.cue.id,
      expectedRowVersion: f.cue.rowVersion,
    });
    const unused = await rpc('audio.import', { sourcePath: f.wav });
    const database = openProjectDatabase(join(f.root, 'project.sqlite'));
    let oldestTakeId = '';
    let newestJobId = '';
    try {
      const repo = new DubbingRepository(database, f.project.id);
      for (let index = 0; index < 12; index++) {
        const id = randomUUID();
        repo.addTake({
          id,
          projectId: f.project.id,
          cueId: f.cue.id,
          cueRowVersion: f.cue.rowVersion,
          textHash: digest(f.cue.text),
          audioId: imported.audio.id,
          parameters: {},
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        });
        if (!index) oldestTakeId = id;
      }
      repo.adoptTake(f.cue.id, oldestTakeId, f.cue.rowVersion);
      const snapshot = {
        cue: { id: f.cue.id, text: '台词正文'.repeat(10000) },
        voice: f.voice,
        plan: 'frozen-history'.repeat(1000),
      };
      for (let index = 0; index < 105; index++) {
        newestJobId = randomUUID();
        repo.addJob({
          id: newestJobId,
          projectId: f.project.id,
          sceneId: f.scene.id,
          kind: 'speech',
          status: 'complete',
          planVersion: 1,
          inputHash: digest(String(index)),
          inputSnapshot: snapshot,
          budget: { state: 'unknown' },
          idempotencyKey: newestJobId,
          rowVersion: 1,
          createdAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
        });
      }
    } finally {
      database.close();
    }
    const scene = await rpc('dubbing.scene.get', { sceneId: f.scene.id });
    expect(scene.jobs).toHaveLength(60);
    expect(scene.cues[0]?.takes).toHaveLength(6);
    expect(scene.cues[0]?.takes?.some((take) => take.id === oldestTakeId)).toBe(true);
    expect(scene.audioFiles.some((audio) => audio.id === unused.audio.id)).toBe(false);
    expect(scene.jobs.every((job) => job.inputSnapshot.cue === undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(scene))).toBeLessThan(2 * 1024 * 1024);
    const taskSnapshot = await rpc('project.task.subscribe', {});
    expect(taskSnapshot.dubbingJobs).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(taskSnapshot))).toBeLessThan(2 * 1024 * 1024);
    const detail = await rpc('dubbing.job.get', { jobId: newestJobId });
    expect((detail?.inputSnapshot.cue as { text: string }).text).toHaveLength(40000);
  });

  it('round-trips local audio, adopts via CAS, exposes task history, and resolves scene output sources without fake generation jobs', async () => {
    const f = await fixture();
    expect(await rpc('characterVoice.list', {})).toEqual([
      expect.objectContaining({ id: f.voice.id, characterDocumentId: f.character.id }),
    ]);
    const imported = await rpc('audio.import', {
      sourcePath: f.wav,
      cueId: f.cue.id,
      expectedRowVersion: f.cue.rowVersion,
    });
    expect(imported.audio).toMatchObject({ mime: 'audio/wav', sampleRate: 32000, channels: 1 });
    const adopted = await rpc('dubbing.take.adopt', {
      cueId: f.cue.id,
      takeId: imported.take!.id,
      expectedRowVersion: f.cue.rowVersion,
    });
    expect(adopted.selectedTakeId).toBe(imported.take!.id);
    expect(await rpc('audio.mediaSource', { audioId: imported.audio.id })).toMatchObject({
      assetId: imported.audio.id,
      contentType: 'audio/wav',
    });
    expect(await rpc('project.integrity', {})).toMatchObject({ ok: true });
    const importedPath = join(f.root, imported.audio.relativePath);
    const originalAudio = await readFile(importedPath);
    await appendFile(importedPath, Buffer.from('changed-file'));
    const alteredIntegrity = await rpc('project.integrity', {});
    expect(alteredIntegrity).toMatchObject({ ok: false, schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(alteredIntegrity.messages.some((message) => message.includes(imported.audio.id))).toBe(
      true,
    );
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(importedPath, originalAudio),
    );
    expect(await rpc('project.integrity', {})).toMatchObject({
      ok: true,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    const jobId = randomUUID();
    const assetId = randomUUID();
    const videoRelative = `assets/videos/${assetId}.mp4`;
    const videoPath = join(f.root, videoRelative);
    execFileSync(
      resolve('../desktop/src-tauri/resources/ffmpeg/ffmpeg.exe'),
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=128x96:r=25:d=1',
        '-an',
        '-c:v',
        'libopenh264',
        videoPath,
      ],
      { windowsHide: true },
    );
    const bytes = await readFile(videoPath);
    const database = openProjectDatabase(join(f.root, 'project.sqlite'));
    try {
      createRepositories(database).assets.save({
        id: assetId,
        projectId: f.project.id,
        kind: 'scene-video',
        relativePath: videoRelative,
        contentHash: digest(bytes),
        sizeBytes: bytes.length,
        createdAt: new Date().toISOString(),
      });
      const repo = new DubbingRepository(database, f.project.id);
      const stamp = new Date().toISOString();
      repo.addJob(
        {
          id: jobId,
          projectId: f.project.id,
          sceneId: f.scene.id,
          kind: 'compose',
          status: 'complete',
          planVersion: 1,
          inputHash: digest('fixture'),
          inputSnapshot: { cueIds: [f.cue.id] },
          budget: {
            state: 'estimated',
            currency: 'LOCAL',
            unit: 'local-task',
            unitPrice: 0,
            estimatedTotal: 0,
          },
          idempotencyKey: jobId,
          sourceVideoAssetId: assetId,
          outputAssetId: assetId,
          rowVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        },
        [imported.audio.id],
      );
      expect(database.prepare('SELECT count(*) AS count FROM generation_jobs').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
    const tasks = await rpc('task.log.list', { kind: 'dubbing' });
    expect(tasks.items).toEqual([
      expect.objectContaining({
        kind: 'dubbing',
        sourceId: jobId,
        sceneId: f.scene.id,
        status: 'complete',
      }),
    ]);
    expect((await rpc('project.task.subscribe', {})).dubbingJobs).toEqual([
      expect.objectContaining({ id: jobId }),
    ]);
    expect(await rpc('asset.source.locate', { assetId })).toMatchObject({
      sourceKind: 'dubbing',
      jobId,
      sceneId: f.scene.id,
    });
    expect(await rpc('asset.list', { sceneId: f.scene.id })).toEqual([
      expect.objectContaining({ id: assetId }),
    ]);
    await expect(rpc('asset.delete', { assetId })).rejects.toThrow('referenced');
    expect(await rpc('asset.delete', { assetId, confirm: true })).toMatchObject({
      deleted: true,
      referenceCount: 1,
    });
    await expect(rpc('dubbing.output.adopt', { jobId, expectedRowVersion: 1 })).rejects.toThrow();
    await expect(rpc('asset.purge', { assetId, confirm: true })).rejects.toThrow();
    expect(await rpc('project.integrity', {})).toMatchObject({ ok: true });
    const restored = await rpc('asset.restore', { assetId });
    expect(restored.deletedAt).toBeUndefined();
    const temporarilyMissing = `${videoPath}.missing`;
    await rename(videoPath, temporarilyMissing);
    try {
      await expect(rpc('dubbing.output.adopt', { jobId, expectedRowVersion: 1 })).rejects.toThrow();
      expect((await rpc('dubbing.job.get', { jobId }))?.adoptedAt).toBeUndefined();
    } finally {
      await rename(temporarilyMissing, videoPath);
    }
    expect((await rpc('dubbing.output.adopt', { jobId, expectedRowVersion: 1 })).adoptedAt).toEqual(
      expect.any(String),
    );
    await expect(rpc('dubbing.output.adopt', { jobId, expectedRowVersion: 1 })).rejects.toThrow(
      'changed',
    );
  });

  it('opens saved dubbing read-only and permits getters/playback while rejecting writes and remote work', async () => {
    const f = await fixture();
    const imported = await rpc('audio.import', {
      sourcePath: f.wav,
      cueId: f.cue.id,
      expectedRowVersion: f.cue.rowVersion,
    });
    await rpc('project.close', {});
    const owner = new ProjectService({
      recentProjectsPath: join(f.directory, 'owner-recent.json'),
    });
    owners.push(owner);
    owner.open(f.root);
    expect(await rpc('project.open', { rootPath: f.root })).toMatchObject({ mode: 'read-only' });
    expect((await rpc('dubbing.scene.get', { sceneId: f.scene.id })).cues).toHaveLength(1);
    expect(await rpc('audio.get', { audioId: imported.audio.id })).toMatchObject({
      id: imported.audio.id,
    });
    expect(await rpc('audio.mediaSource', { audioId: imported.audio.id })).toMatchObject({
      contentType: 'audio/wav',
    });
    expect(await rpc('dubbing.job.list', {})).toEqual([]);
    expect((await rpc('task.log.list', { kind: 'dubbing' })).items).toEqual([]);
    await expect(
      rpc('dubbing.cue.delete', { cueId: f.cue.id, expectedRowVersion: f.cue.rowVersion }),
    ).rejects.toThrow('PROJECT_READ_ONLY');
    await expect(rpc('audio.import', { sourcePath: f.wav })).rejects.toThrow('PROJECT_READ_ONLY');
    await expect(
      rpc('dubbing.take.adopt', {
        cueId: f.cue.id,
        takeId: imported.take!.id,
        expectedRowVersion: f.cue.rowVersion,
      }),
    ).rejects.toThrow('PROJECT_READ_ONLY');
    await expect(
      rpc('dubbing.take.generate', {
        cueId: f.cue.id,
        expectedRowVersion: f.cue.rowVersion,
        costAcknowledged: true,
      }),
    ).rejects.toThrow('PROJECT_READ_ONLY');
  });

  it('rejects stale imports, cross-project lookup, bad media, and unacknowledged or unavailable paid connections', async () => {
    const f = await fixture();
    await expect(
      rpc('dubbing.take.generate', {
        cueId: f.cue.id,
        expectedRowVersion: f.cue.rowVersion,
        costAcknowledged: false,
      }),
    ).rejects.toThrow();
    await expect(
      rpc('dubbing.take.generate', {
        cueId: f.cue.id,
        expectedRowVersion: f.cue.rowVersion,
        costAcknowledged: true,
      }),
    ).rejects.toThrow();
    expect(await rpc('dubbing.job.list', {})).toEqual([]);
    await expect(
      rpc('audio.import', { sourcePath: f.wav, cueId: f.cue.id, expectedRowVersion: 0 }),
    ).rejects.toThrow();
    const bad = join(f.directory, 'fake.mp3');
    await copyFile(join(f.root, 'project.sqlite'), bad);
    await expect(rpc('audio.import', { sourcePath: bad })).rejects.toThrow();
    const imported = await rpc('audio.import', { sourcePath: f.wav });
    const secondRoot = join(f.directory, 'second-project');
    await rpc('project.create', { rootPath: secondRoot, name: '独立项目' });
    expect(await rpc('audio.get', { audioId: imported.audio.id })).toBeNull();
    await expect(rpc('dubbing.scene.get', { sceneId: f.scene.id })).rejects.toThrow();
    expect(await rpc('characterVoice.list', {})).toEqual([]);
  });
});
