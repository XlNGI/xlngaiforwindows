import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './database.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

it('upgrades v73 lifecycle atomically and retries safely without changing saved production content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-lifecycle-migration-'));
  const database = openProjectDatabase(join(directory, 'project.sqlite'));
  try {
    migrateDatabase(database);
    database.exec(`
      DROP TRIGGER agent_changes_scenes_update;
      DROP TRIGGER agent_changes_shots_update;
      DROP TRIGGER archived_scene_read_only;
      DROP TRIGGER archived_scene_shot_insert;
      DROP TRIGGER archived_shot_read_only;
      DROP TRIGGER archived_storyboard_read_only;
      DROP TRIGGER archived_storyboard_version_insert;
      DROP INDEX idx_scenes_lifecycle;
      DROP INDEX idx_shots_lifecycle;
      DROP TABLE production_lifecycle_events;
      ALTER TABLE scenes DROP COLUMN archived_at;
      ALTER TABLE shots DROP COLUMN archived_at;
      DELETE FROM schema_migrations WHERE version>=74;
      INSERT INTO projects(id,name,created_at,updated_at) VALUES('project','Project','now','now');
      INSERT INTO scenes(id,project_id,title,position,video_prompt,created_at,updated_at)
        VALUES('scene','project','Original scene',0,'Scene prompt','now','now');
      INSERT INTO shots(id,scene_id,title,position,prompt,created_at,updated_at)
        VALUES('shot','scene','Original shot',0,'Shot prompt','now','now');
      CREATE TRIGGER fail_v74 BEFORE INSERT ON schema_migrations WHEN NEW.version=74
        BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;
    `);
    expect(getSchemaVersion(database)).toBe(73);
    expect(() => migrateDatabase(database)).toThrow('fixture migration failure');
    expect(
      (database.prepare('PRAGMA table_info(scenes)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'archived_at',
      ),
    ).toBe(false);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE name='production_lifecycle_events'")
        .get(),
    ).toBeUndefined();
    database.exec('DROP TRIGGER fail_v74');
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    database.exec('DELETE FROM schema_migrations WHERE version=74');
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database.prepare('SELECT title,video_prompt,archived_at,row_version FROM scenes').get(),
    ).toEqual({
      title: 'Original scene',
      video_prompt: 'Scene prompt',
      archived_at: null,
      row_version: 0,
    });
    expect(
      database.prepare('SELECT title,prompt,archived_at,row_version FROM shots').get(),
    ).toEqual({ title: 'Original shot', prompt: 'Shot prompt', archived_at: null, row_version: 0 });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
