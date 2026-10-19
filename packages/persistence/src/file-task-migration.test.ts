import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  openProjectDatabase,
  migrateDatabase,
  getSchemaVersion,
  checkIntegrity,
} from './database.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
it('rolls v53 file ownership back on migration failure and prevents terminal tasks from being replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-task-migration-')),
    database = openProjectDatabase(join(root, 'project.sqlite'));
  try {
    migrateDatabase(database);
    database.exec(`DROP TABLE file_tasks;DELETE FROM schema_migrations WHERE version>=53;
  CREATE TRIGGER fail_v53 BEFORE INSERT ON schema_migrations WHEN NEW.version=53 BEGIN SELECT RAISE(ABORT,'v53 failure');END;`);
    expect(() => migrateDatabase(database)).toThrow('v53 failure');
    expect(getSchemaVersion(database)).toBe(52);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='file_tasks'").get(),
    ).toBeUndefined();
    database.exec('DROP TRIGGER fail_v53');
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    database.exec(
      "INSERT INTO projects(id,name,created_at,updated_at)VALUES('project','Project','now','now')",
    );
    database
      .prepare(
        "INSERT INTO file_tasks(id,project_id,runtime_epoch,kind,operation_key,request_hash,input_json,status,created_at,updated_at)VALUES('file','project','epoch','project-export','operation','hash','{}','succeeded','now','now')",
      )
      .run();
    expect(() =>
      database.prepare("UPDATE file_tasks SET status='running' WHERE id='file'").run(),
    ).toThrow('terminal state');
    expect(() =>
      database.prepare("UPDATE file_tasks SET runtime_epoch='new' WHERE id='file'").run(),
    ).toThrow('identity');
    expect(checkIntegrity(database).ok).toBe(true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
