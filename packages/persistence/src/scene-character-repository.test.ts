import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, checkIntegrity } from './database.js';
import { SceneCharacterRepository } from './scene-character-repository.js';
import { VoiceReferenceRepository } from './voice-reference-repository.js';
import { DubbingRepository } from './dubbing-repository.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateDatabase(db);
  for (const id of ['one', 'two']) {
    db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(
      id,
      id,
      'now',
      'now',
    );
    db.prepare(
      "INSERT INTO documents(id,project_id,kind,title,created_at,updated_at) VALUES(?,?,'character','同名角色','now','now')",
    ).run(`${id}-role`, id);
    db.prepare(
      "INSERT INTO scenes(id,project_id,title,position,created_at,updated_at) VALUES(?,?,'场次',0,'now','now')",
    ).run(`${id}-scene`, id);
    for (const kind of ['character', 'shot-video'])
      db.prepare(
        'INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,?,?,?,100,?)',
      ).run(`${id}-${kind}`, id, kind, `assets/${id}-${kind}.png`, 'a'.repeat(64), 'now');
    for (const kind of ['reference', 'imported-dialogue'])
      db.prepare(
        "INSERT INTO audio_files(id,project_id,kind,name,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,channels,created_at) VALUES(?,?,?,?,?,'audio/wav',100,?,3000,48000,1,'now')",
      ).run(`${id}-${kind}`, id, kind, '声音', `assets/audio/${id}-${kind}.wav`, 'a'.repeat(64));
  }
  return db;
}

describe('scene cast and audio storage', () => {
  it('upgrades v47 selections without losing fixed IDs and persists disabled media independently', () => {
    const db = fixture();
    try {
      const repo = new SceneCharacterRepository(db);
      repo.replace('one-scene', [
        { characterDocumentId: 'one-role', imageAssetId: 'one-character' },
      ]);
      db.exec(
        'ALTER TABLE scene_character_bindings DROP COLUMN image_disabled; ALTER TABLE scene_character_bindings DROP COLUMN voice_disabled; DELETE FROM schema_migrations WHERE version>=48; DROP INDEX generation_jobs_source_document;',
      );
      migrateDatabase(db);
      expect(repo.list('one-scene')).toEqual([
        { characterDocumentId: 'one-role', imageAssetId: 'one-character' },
      ]);
      repo.replace('one-scene', [
        { characterDocumentId: 'one-role', imageDisabled: true, voiceDisabled: true },
      ]);
      migrateDatabase(db);
      expect(repo.list('one-scene')).toEqual([
        { characterDocumentId: 'one-role', imageDisabled: true, voiceDisabled: true },
      ]);
      expect(checkIntegrity(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });
  it('binds characters without images and atomically rejects foreign images, voices and video assets', () => {
    const db = fixture();
    try {
      const repo = new SceneCharacterRepository(db);
      const voice = new VoiceReferenceRepository(db, 'two').save({
        characterDocumentId: 'two-role',
        audioId: 'two-reference',
      });
      repo.replace('one-scene', [{ characterDocumentId: 'one-role' }]);
      for (const binding of [
        { characterDocumentId: 'two-role' },
        { characterDocumentId: 'one-role', imageAssetId: 'two-character' },
        { characterDocumentId: 'one-role', imageAssetId: 'one-shot-video' },
        { characterDocumentId: 'one-role', voiceReferenceVersionId: voice.versionId },
      ]) {
        expect(() => repo.replace('one-scene', [binding])).toThrow();
        expect(repo.list('one-scene')).toEqual([{ characterDocumentId: 'one-role' }]);
      }
      db.prepare('UPDATE scenes SET dialogue_audio_id=? WHERE id=?').run(
        'one-imported-dialogue',
        'one-scene',
      );
      expect(() =>
        db
          .prepare('UPDATE scenes SET dialogue_audio_id=? WHERE id=?')
          .run('two-imported-dialogue', 'one-scene'),
      ).toThrow();
      expect(() =>
        db
          .prepare('UPDATE scenes SET dialogue_audio_id=? WHERE id=?')
          .run('one-reference', 'one-scene'),
      ).toThrow();
      expect(new DubbingRepository(db, 'one').countAudioReferences('one-imported-dialogue')).toBe(
        1,
      );
      expect(() =>
        new DubbingRepository(db, 'one').trashAudio(
          'one-imported-dialogue',
          'assets/audio/.trash/one.wav',
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('migrates only explicit valid legacy IDs and dialogue speakers on repeated upgrade', () => {
    const db = fixture();
    try {
      db.exec(`DROP TRIGGER scene_dialogue_insert_valid;DROP TRIGGER scene_dialogue_update_valid;
        DROP TABLE scene_character_bindings;ALTER TABLE scenes DROP COLUMN dialogue_audio_id;
        ALTER TABLE agent_change_set_items DROP COLUMN scene_bindings_json;
        DELETE FROM schema_migrations WHERE version>=46;`);
      db.prepare('UPDATE scenes SET material_bindings_json=? WHERE id=?').run(
        JSON.stringify([
          'invalid legacy entry',
          {
            id: 'valid',
            role: 'character',
            label: '同名角色',
            assetId: 'one-character',
            sourceDocumentId: 'one-role',
            source: 'auto',
          },
          {
            id: 'foreign',
            role: 'character',
            label: '同名角色',
            assetId: 'two-character',
            sourceDocumentId: 'two-role',
            source: 'auto',
          },
          {
            id: 'name-only',
            role: 'character',
            label: '同名角色',
            assetId: 'one-character',
            source: 'auto',
          },
        ]),
        'one-scene',
      );
      db.prepare(
        "INSERT INTO dubbing_cues(id,project_id,scene_id,speaker_kind,character_document_id,text,position,start_ms,created_at,updated_at) VALUES('cue','two','two-scene','character','two-role','对白',0,0,'now','now')",
      ).run();
      migrateDatabase(db);
      migrateDatabase(db);
      const repo = new SceneCharacterRepository(db);
      expect(repo.list('one-scene')).toEqual([
        { characterDocumentId: 'one-role', imageAssetId: 'one-character' },
      ]);
      expect(repo.list('two-scene')).toEqual([{ characterDocumentId: 'two-role' }]);
      expect(checkIntegrity(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });
});
