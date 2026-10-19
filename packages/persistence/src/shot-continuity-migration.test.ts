import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './database.js';
import { readShotContinuity, writeShotContinuity } from './shot-continuity.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

describe('shot continuity migration and selection CAS', () => {
  it('upgrades v55 atomically, fences projects, preserves legacy prompts and avoids stale writes after clearing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shot-continuity-migration-'));
    const db = openProjectDatabase(join(directory, 'project.sqlite'));
    try {
      migrateDatabase(db);
      db.exec(`DROP TABLE shot_continuity; DELETE FROM schema_migrations WHERE version>=56;
        INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','项目','now','now'),('other','其他','now','now');
        INSERT INTO scenes(id,project_id,title,position,created_at,updated_at) VALUES('s','p','场次',0,'now','now');
        INSERT INTO shots(id,scene_id,title,position,prompt,created_at,updated_at) VALUES('shot','s','镜头',0,'原提示词','now','now');
        CREATE TRIGGER fail_v56 BEFORE INSERT ON schema_migrations WHEN NEW.version=56 BEGIN SELECT RAISE(ABORT,'v56 failure'); END;`);
      expect(() => migrateDatabase(db)).toThrow('v56 failure');
      expect(getSchemaVersion(db)).toBe(55);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='shot_continuity'").get(),
      ).toBeUndefined();
      db.exec('DROP TRIGGER fail_v56');
      expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT prompt FROM shots WHERE id='shot'").get()).toEqual({
        prompt: '原提示词',
      });
      expect(() => writeShotContinuity(db, 'other', 'shot', 0, undefined)).toThrow(
        'project mismatch',
      );
      expect(readShotContinuity(db, 'p', 'shot')).toEqual({ shotId: 'shot', rowVersion: 0 });
      writeShotContinuity(db, 'p', 'shot', 0, undefined);
      expect(() => writeShotContinuity(db, 'p', 'shot', 0, undefined)).toThrow('已更新');
      writeShotContinuity(db, 'p', 'shot', 1, undefined);
      expect(readShotContinuity(db, 'p', 'shot').rowVersion).toBe(2);
      db.exec("DELETE FROM shots WHERE id='shot'");
      expect(db.prepare('SELECT * FROM shot_continuity').all()).toEqual([]);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
