import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './database.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

it('rolls back request/stage migration as one transaction and preserves existing project data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-pipeline-migration-'));
  const db = openProjectDatabase(join(directory, 'project.sqlite'));
  try {
    migrateDatabase(db);
    db.exec(`DROP TABLE scene_structure_stages; DROP TABLE llm_provider_requests;
      ALTER TABLE llm_generations DROP COLUMN user_request; ALTER TABLE llm_generations DROP COLUMN session_constraints;
      DELETE FROM schema_migrations WHERE version>=58;
      ALTER TABLE agent_tasks DROP COLUMN completion_state;
      INSERT INTO projects(id,name,created_at,updated_at) VALUES('legacy','保留项目','now','now');
      CREATE TRIGGER fail_v58 BEFORE INSERT ON schema_migrations WHEN NEW.version=58 BEGIN SELECT RAISE(ABORT,'v58 failure'); END;`);
    expect(() => migrateDatabase(db)).toThrow('v58 failure');
    expect(getSchemaVersion(db)).toBe(57);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='llm_provider_requests'").get(),
    ).toBeUndefined();
    expect(
      (db.prepare('PRAGMA table_info(llm_generations)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'user_request',
      ),
    ).toBe(false);
    db.exec('DROP TRIGGER fail_v58');
    expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM projects WHERE id='legacy'").get()).toEqual({
      name: '保留项目',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      (db.prepare('PRAGMA table_info(agent_tasks)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'completion_state',
      ),
    ).toBe(true);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
