import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RoughCutSequence } from '@ai-video/contracts';
import { migrateDatabase, getSchemaVersion } from './database.js';
import { RoughCutRepository, roughCutReferenceCount } from './rough-cut.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

describe('rough cut migration and local storage', () => {
  it('migrates v65 transactionally, preserves old content, fences projects and rejects stale saves/deletes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    db.function('sha256', () => 'hash');
    try {
      migrateDatabase(db);
      db.exec(`DROP TABLE rough_cut_sequences; DELETE FROM schema_migrations WHERE version >= 66;
        INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','项目','now','now'),('other','其他','now','now');
        INSERT INTO scenes(id,project_id,title,position,created_at,updated_at) VALUES('s','p','原场次',0,'now','now');
        CREATE TRIGGER fail_v66 BEFORE INSERT ON schema_migrations WHEN NEW.version=66 BEGIN SELECT RAISE(ABORT,'v66 failure'); END;`);
      expect(() => migrateDatabase(db)).toThrow('v66 failure');
      expect(getSchemaVersion(db)).toBe(65);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='rough_cut_sequences'").get(),
      ).toBeUndefined();
      db.exec('DROP TRIGGER fail_v66');
      expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT title FROM scenes WHERE id='s'").get()).toEqual({
        title: '原场次',
      });
      const repo = new RoughCutRepository(db);
      const input: RoughCutSequence = {
        id: 'seq',
        projectId: 'p',
        name: '第一集',
        sceneIds: ['s'],
        clips: [],
        rowVersion: 0,
        createdAt: 'now',
        updatedAt: 'now',
      };
      const saved = repo.save(input, 0);
      expect(saved.rowVersion).toBe(1);
      expect(repo.get('other', saved.id)).toBeUndefined();
      expect(() => repo.save({ ...input, projectId: 'other' }, 0)).toThrow('不属于');
      expect(() => repo.save(input, 0)).toThrow('已在其他页面更新');
      expect(() => repo.delete('p', 'seq', 0)).toThrow('已更新');
      expect(roughCutReferenceCount(db, 'p', 'asset')).toBe(0);
      repo.delete('p', 'seq', 1);
      expect(repo.list('p')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
