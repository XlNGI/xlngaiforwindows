import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AudioFileInfo, DubbingJobInfo, DubbingJobStepInfo } from '@ai-video/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { checkIntegrity, migrateDatabase, openProjectDatabase } from './database.js';
import {
  DubbingConflictError,
  DubbingReferenceError,
  DubbingRepository,
} from './dubbing-repository.js';

const temporary: Array<{ root: string; database: Database.Database }> = [];
const now = '2026-10-14T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  for (const { root, database } of temporary.splice(0)) {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai-video-dubbing-'));
  const database = openProjectDatabase(join(root, 'project.sqlite'));
  temporary.push({ root, database });
  migrateDatabase(database);
  for (const id of ['project', 'other']) {
    database
      .prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)')
      .run(id, id, now, now);
    database
      .prepare(
        'INSERT INTO documents (id,project_id,kind,title,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(`${id}-character`, id, 'character', '角色', now, now);
    database
      .prepare(
        'INSERT INTO scenes (id,project_id,title,position,created_at,updated_at) VALUES (?,?,?,0,?,?)',
      )
      .run(`${id}-scene`, id, '场次', now, now);
    database
      .prepare(
        'INSERT INTO assets (id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(`${id}-video`, id, 'video', 'assets/videos/video.mp4', hash('video'), 100, now);
  }
  return {
    database,
    repo: new DubbingRepository(database, 'project'),
    other: new DubbingRepository(database, 'other'),
  };
}
function audio(id: string, projectId = 'project'): AudioFileInfo {
  return {
    id,
    projectId,
    kind: 'imported-dialogue',
    name: id,
    relativePath: `assets/audio/dialogue/${id}.wav`,
    mime: 'audio/wav',
    sizeBytes: 100,
    contentHash: hash(id),
    durationMs: 1000,
    sampleRate: 32000,
    channels: 1,
    createdAt: now,
  };
}
function voice(repo: DubbingRepository) {
  return repo.saveVoice(
    {
      characterDocumentId: `${repo.projectId}-character`,
      providerProfileId: 'speech-provider',
      model: 'speech-2.8-hd',
      voiceId: 'fixed-voice',
      speed: 1,
      pitch: 0,
    },
    now,
  );
}
function cue(repo: DubbingRepository) {
  const profile = voice(repo);
  return repo.saveCue(
    {
      sceneId: `${repo.projectId}-scene`,
      speakerKind: 'character',
      characterDocumentId: `${repo.projectId}-character`,
      voiceProfileId: profile.id,
      text: '今天出发。',
      position: 0,
      startMs: 0,
      lipSync: false,
    },
    now,
  );
}
function job(id: string, projectId = 'project'): DubbingJobInfo {
  return {
    id,
    projectId,
    sceneId: `${projectId}-scene`,
    kind: 'compose',
    status: 'pending',
    planVersion: 1,
    inputHash: hash(id),
    inputSnapshot: { sceneId: `${projectId}-scene` },
    budget: { state: 'unknown', maxAttempts: 1 },
    idempotencyKey: id,
    sourceVideoAssetId: `${projectId}-video`,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}
function step(jobId: string, id = 'step'): DubbingJobStepInfo {
  return {
    id,
    jobId,
    stepKey: 'compose',
    kind: 'compose',
    dependencies: [],
    status: 'pending',
    attempt: 1,
    inputHash: hash(id),
    idempotencyKey: id,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe('dedicated project dubbing store', () => {
  it('upgrades a v43 project and preserves character, scene, and video data on repeated open', async () => {
    const { database } = await fixture();
    database.pragma('foreign_keys=OFF');
    const triggers = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('character_voice_profiles','character_voice_profile_versions','audio_files','dubbing_cues','dubbing_takes','dubbing_jobs','dubbing_job_steps','dubbing_job_audio_references') OR name='voice_character_deleted'",
      )
      .all() as { name: string }[];
    for (const { name } of triggers) database.exec(`DROP TRIGGER "${name}"`);
    for (const table of [
      'video_input_audio_references',
      'character_voice_reference_versions',
      'character_voice_references',
      'dubbing_job_audio_references',
      'dubbing_job_steps',
      'dubbing_takes',
      'dubbing_cues',
      'character_voice_profile_versions',
      'character_voice_profiles',
      'audio_files',
      'dubbing_jobs',
    ])
      database.exec(`DROP TABLE "${table}"`);
    database.prepare('DELETE FROM schema_migrations WHERE version>=44').run();
    database.pragma('foreign_keys=ON');
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database.prepare('SELECT title FROM documents WHERE id=?').get('project-character'),
    ).toEqual({ title: '角色' });
    expect(database.prepare('SELECT count(*) AS count FROM assets').get()).toEqual({ count: 2 });
    expect(checkIntegrity(database).ok).toBe(true);
  });

  it('uses stable character identities, immutable voice versions, and CAS while preserving history after deletion', async () => {
    const { database, repo } = await fixture();
    const first = voice(repo);
    database.prepare('UPDATE documents SET title=? WHERE id=?').run('改名', 'project-character');
    expect(repo.getVoiceForCharacter('project-character')?.id).toBe(first.id);
    const second = repo.saveVoice(
      { ...first, voiceId: 'new-voice', expectedRowVersion: first.rowVersion },
      now,
    );
    expect(second).toMatchObject({
      id: first.id,
      revision: 2,
      rowVersion: 2,
      voiceId: 'new-voice',
    });
    expect(repo.getVoiceVersion(first.versionId)?.voiceId).toBe('fixed-voice');
    expect(() => repo.saveVoice({ ...first, expectedRowVersion: 1 }, now)).toThrow(
      DubbingConflictError,
    );
    expect(() =>
      database
        .prepare('UPDATE character_voice_profile_versions SET voice_id=? WHERE id=?')
        .run('bad', first.versionId),
    ).toThrow('immutable');
    database.prepare('DELETE FROM documents WHERE id=?').run('project-character');
    expect(repo.getVoice(first.id)?.archivedAt).toBe(now);
    expect(repo.listVoices()).toEqual([]);
    expect(repo.listVoices(true)).toHaveLength(1);
    expect(repo.getVoiceVersion(first.versionId)?.voiceId).toBe('fixed-voice');
    expect(checkIntegrity(database).ok).toBe(true);
  });

  it('keeps takes and confirmed audio immutable, preserves timing edits, and clears selection when text changes', async () => {
    const { database, repo } = await fixture();
    const entry = cue(repo);
    const savedAudio = repo.registerAudio(audio('take-audio'));
    const take = repo.addTake({
      id: 'take',
      projectId: 'project',
      cueId: entry.id,
      cueRowVersion: entry.rowVersion,
      textHash: hash(entry.text),
      audioId: savedAudio.id,
      parameters: {},
      createdAt: now,
    });
    const adopted = repo.adoptTake(entry.id, take.id, entry.rowVersion, now);
    expect(adopted.selectedTakeId).toBe(take.id);
    expect(() => repo.adoptTake(entry.id, take.id, entry.rowVersion, now)).toThrow(
      DubbingConflictError,
    );
    const moved = repo.saveCue(
      { ...adopted, startMs: 1000, expectedRowVersion: adopted.rowVersion },
      now,
    );
    expect(moved.selectedTakeId).toBe(take.id);
    const edited = repo.saveCue(
      { ...moved, text: '明天出发。', expectedRowVersion: moved.rowVersion },
      now,
    );
    expect(edited.selectedTakeId).toBeUndefined();
    expect(edited.takes).toHaveLength(1);
    expect(() => repo.adoptTake(entry.id, take.id, edited.rowVersion, now)).toThrow(
      'different dialogue',
    );
    expect(() => repo.trashAudio(savedAudio.id, 'assets/audio/.trash/take-audio.wav', now)).toThrow(
      DubbingReferenceError,
    );
    expect(() =>
      database.prepare('UPDATE audio_files SET duration_ms=2000 WHERE id=?').run(savedAudio.id),
    ).toThrow('immutable');
    repo.deleteCue(entry.id, edited.rowVersion, now);
    expect(repo.listCues('project-scene')).toEqual([]);
    expect(repo.listTakes(entry.id)).toHaveLength(1);
    expect(checkIntegrity(database).ok).toBe(true);
  });

  it('rejects cross-project speakers, takes, source videos and media results both through repository and SQL constraints', async () => {
    const { database, repo, other } = await fixture();
    const entry = cue(repo);
    const foreignAudio = other.registerAudio(audio('foreign-audio', 'other'));
    expect(repo.getAudio(foreignAudio.id)).toBeUndefined();
    expect(() => repo.registerAudio(audio('wrong', 'other'))).toThrow('another project');
    expect(() =>
      repo.saveVoice(
        {
          characterDocumentId: 'other-character',
          providerProfileId: 'p',
          model: 'm',
          voiceId: 'v',
          speed: 1,
          pitch: 0,
        },
        now,
      ),
    ).toThrow('belong');
    expect(() => repo.saveCue({ ...entry, id: undefined, sceneId: 'other-scene' }, now)).toThrow(
      'invalid cue',
    );
    expect(() =>
      repo.addTake({
        id: 'foreign-take',
        projectId: 'project',
        cueId: entry.id,
        cueRowVersion: 1,
        textHash: hash(entry.text),
        audioId: foreignAudio.id,
        parameters: {},
        createdAt: now,
      }),
    ).toThrow('another project');
    expect(() => repo.addJob({ ...job('bad-video'), sourceVideoAssetId: 'other-video' })).toThrow(
      'invalid dubbing',
    );
    const saved = repo.addJob(job('good-job'));
    expect(() =>
      repo.updateJob(saved.id, { outputAssetId: 'other-video' }, saved.rowVersion, now),
    ).toThrow('another project');
    expect(database.prepare('SELECT count(*) AS count FROM dubbing_jobs').get()).toEqual({
      count: 1,
    });
    expect(checkIntegrity(database).ok).toBe(true);
  });

  it('protects frozen plans, idempotency, successful step attempts, and historical video/audio references', async () => {
    const { database, repo } = await fixture();
    const savedAudio = repo.registerAudio(audio('job-audio'));
    const saved = repo.addJob(job('job'), [savedAudio.id]);
    expect(() =>
      repo.addJob({ ...job('duplicate'), idempotencyKey: saved.idempotencyKey }),
    ).toThrow('UNIQUE');
    expect(() =>
      database
        .prepare('UPDATE dubbing_jobs SET input_snapshot_json=? WHERE id=?')
        .run('{}', saved.id),
    ).toThrow('immutable');
    const pending = repo.addStep(step(saved.id));
    const complete = repo.updateStep(
      pending.id,
      {
        status: 'complete',
        resultRelativePath: 'assets/dubbing/job/step.mp4',
        resultContentHash: hash('result'),
      },
      pending.rowVersion,
      now,
    );
    expect(() =>
      repo.updateStep(complete.id, { status: 'failed' }, complete.rowVersion, now),
    ).toThrow('immutable');
    const retry = repo.addStep({ ...step(saved.id, 'step-2'), attempt: 2, stepKey: 'other-step' });
    expect(repo.listSteps(saved.id)).toHaveLength(2);
    expect(repo.getStep(retry.id)?.status).toBe('pending');
    expect(repo.countVideoReferences('project-video')).toBe(1);
    expect(repo.countAudioReferences(savedAudio.id)).toBe(1);
    expect(() => database.prepare('DELETE FROM assets WHERE id=?').run('project-video')).toThrow(
      'FOREIGN KEY',
    );
    expect(() => repo.trashAudio(savedAudio.id, 'assets/audio/.trash/job-audio.wav', now)).toThrow(
      DubbingReferenceError,
    );
    expect(checkIntegrity(database).ok).toBe(true);
  });

  it('round-trips unreferenced audio through trash and restore, bounds input, and refuses purge outside trash', async () => {
    const { repo } = await fixture();
    repo.registerAudio(audio('unused'));
    expect(() => repo.purgeAudio('unused')).toThrow('Only trashed');
    expect(() =>
      repo.registerAudio({
        ...audio('escape'),
        relativePath: 'assets/audio/dialogue/../../escape.wav',
      }),
    ).toThrow('Invalid project audio path');
    expect(() => repo.registerAudio({ ...audio('big'), sizeBytes: 21 * 1024 * 1024 })).toThrow(
      'CHECK',
    );
    expect(repo.trashAudio('unused', 'assets/audio/.trash/unused.wav', now).deletedAt).toBe(now);
    expect(repo.listAudio({ deleted: 'trash' })).toHaveLength(1);
    expect(repo.restoreAudio('unused').deletedAt).toBeUndefined();
    repo.trashAudio('unused', 'assets/audio/.trash/unused.wav', now);
    repo.purgeAudio('unused');
    expect(repo.getAudio('unused')).toBeUndefined();
    const profile = voice(repo);
    expect(() =>
      repo.saveCue({
        sceneId: 'project-scene',
        speakerKind: 'narration',
        voiceProfileId: profile.id,
        text: '旁白',
        position: 0,
        startMs: 0,
        lipSync: true,
      }),
    ).toThrow('CHECK');
  });
});
