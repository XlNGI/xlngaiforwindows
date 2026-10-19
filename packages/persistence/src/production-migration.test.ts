import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './index.js';

describe('detailed production migration', () => {
  it('upgrades v53 atomically, preserves legacy prompts and can retry a failed migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scene-production-migration-'));
    const db = openProjectDatabase(join(directory, 'project.sqlite'));
    try {
      migrateDatabase(db);
      db.exec(`DROP TABLE production_change_set_instructions; DROP TABLE production_defaults;
        DELETE FROM schema_migrations WHERE version>=54;
        INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','旧项目','now','now');
        INSERT INTO scenes(id,project_id,title,position,video_prompt,created_at,updated_at) VALUES('s','p','场次',0,'旧场次提示词','now','now');
        INSERT INTO shots(id,scene_id,title,position,prompt,created_at,updated_at) VALUES('shot','s','镜头',0,'旧分镜提示词','now','now');
        CREATE TRIGGER fail_v54 BEFORE INSERT ON schema_migrations WHEN NEW.version=54 BEGIN SELECT RAISE(ABORT,'v54 failure'); END;`);
      expect(() => migrateDatabase(db)).toThrow('v54 failure');
      expect(getSchemaVersion(db)).toBe(53);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='production_defaults'").get(),
      ).toBeUndefined();
      db.exec('DROP TRIGGER fail_v54');
      expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT video_prompt FROM scenes WHERE id='s'").get()).toEqual({
        video_prompt: '旧场次提示词',
      });
      expect(db.prepare("SELECT prompt FROM shots WHERE id='shot'").get()).toEqual({
        prompt: '旧分镜提示词',
      });
      expect(() =>
        db.prepare('INSERT INTO production_defaults VALUES(?,?,?,?)').run('p', 1, 'invalid', 'now'),
      ).toThrow();
      expect(() =>
        db
          .prepare('INSERT INTO production_change_set_instructions VALUES(?,?,?)')
          .run('missing', 'p', '{}'),
      ).toThrow();
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
