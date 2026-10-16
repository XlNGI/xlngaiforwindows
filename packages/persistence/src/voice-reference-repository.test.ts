import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, getSchemaVersion } from './database.js';
import { VoiceReferenceRepository } from './voice-reference-repository.js';
import { DubbingRepository } from './dubbing-repository.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateDatabase(db);
  const now = new Date().toISOString();
  for (const project of ['one', 'two']) {
    db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(
      project,
      project,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO documents(id,project_id,kind,title,created_at,updated_at) VALUES(?,?,'character',?,?,?)",
    ).run(`${project}-role`, project, '角色', now, now);
    for (const revision of [1, 2])
      db.prepare(
        "INSERT INTO audio_files(id,project_id,kind,name,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,channels,created_at) VALUES(?,?,'reference',?,?,'audio/wav',100,?,3000,48000,1,?)",
      ).run(
        `${project}-audio${revision}`,
        project,
        '样本',
        `assets/audio/reference/${project}-${revision}.wav`,
        'a'.repeat(64),
        now,
      );
  }
  return db;
}
describe('versioned role voice samples', () => {
  it('migrates, freezes versions, uses stable role identities and protects audio references', () => {
    const db = fixture();
    try {
      expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      const repo = new VoiceReferenceRepository(db, 'one');
      const first = repo.save({ characterDocumentId: 'one-role', audioId: 'one-audio1' });
      db.prepare('UPDATE documents SET title=? WHERE id=?').run('新角色名', 'one-role');
      const second = repo.save({
        characterDocumentId: 'one-role',
        audioId: 'one-audio2',
        expectedRowVersion: first.rowVersion,
      });
      expect(second.revision).toBe(2);
      expect(second.characterName).toBe('新角色名');
      expect(() =>
        db
          .prepare('UPDATE character_voice_reference_versions SET audio_id=? WHERE id=?')
          .run('one-audio2', first.versionId),
      ).toThrow('immutable');
      expect(new DubbingRepository(db, 'one').countAudioReferences('one-audio1')).toBe(1);
      expect(repo.list()).toHaveLength(1);
      migrateDatabase(db);
      expect(repo.list()[0]?.versionId).toBe(second.versionId);
    } finally {
      db.close();
    }
  });
  it('rejects stale edits, foreign roles and foreign audio without partial versions', () => {
    const db = fixture();
    try {
      const repo = new VoiceReferenceRepository(db, 'one');
      const first = repo.save({ characterDocumentId: 'one-role', audioId: 'one-audio1' });
      expect(() =>
        repo.save({
          characterDocumentId: 'one-role',
          audioId: 'one-audio2',
          expectedRowVersion: 0,
        }),
      ).toThrow('已变化');
      expect(() => repo.save({ characterDocumentId: 'two-role', audioId: 'one-audio1' })).toThrow(
        '不属于',
      );
      expect(() =>
        repo.save({
          characterDocumentId: 'one-role',
          audioId: 'two-audio1',
          expectedRowVersion: first.rowVersion,
        }),
      ).toThrow();
      expect(repo.list()[0]?.versionId).toBe(first.versionId);
    } finally {
      db.close();
    }
  });
});
