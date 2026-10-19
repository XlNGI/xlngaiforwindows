import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkIntegrity,
  getSchemaVersion,
  migrateDatabase,
  openProjectDatabase,
} from './database.js';

it('upgrades v49 atomically, preserves existing jobs and enforces single scoped dispatch ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-schedule-migration-'));
  const db = openProjectDatabase(join(root, 'project.sqlite'));
  try {
    migrateDatabase(db);
    db.exec(`DROP TABLE task_schedule_events; DROP TABLE task_schedule_dispatches;
      DROP TABLE task_schedule_artifacts; DROP TABLE task_schedule_dependencies;
      DROP TABLE task_schedule_entries; DELETE FROM schema_migrations WHERE version>=50;
      INSERT INTO projects(id,name,created_at,updated_at) VALUES('a','A','now','now'),('b','B','now','now');
      INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,created_at,updated_at)
      VALUES('job-a','a','TEXT_TO_VIDEO:fixture','pending','{}','now','now'),('job-b','b','TEXT_TO_VIDEO:fixture','pending','{}','now','now');
      CREATE TRIGGER fail_schedule_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=50
      BEGIN SELECT RAISE(ABORT,'v50 failure'); END;`);
    expect(() => migrateDatabase(db)).toThrow('v50 failure');
    expect(getSchemaVersion(db)).toBe(49);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_schedule_entries'").get(),
    ).toBeUndefined();
    db.exec('DROP TRIGGER fail_schedule_migration');
    expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT status FROM generation_jobs WHERE id=?').get('job-a')).toEqual({
      status: 'pending',
    });
    const entry = db.prepare(
      `INSERT INTO task_schedule_entries(id,project_id,owner_job_id,operation_key,request_hash,schedule_state,created_at,updated_at) VALUES(?,?,?,?,?,'pending','now','now')`,
    );
    expect(() => entry.run('foreign', 'a', 'job-b', 'foreign', 'hash')).toThrow(
      'belong to project',
    );
    entry.run('task-a', 'a', 'job-a', 'video:job-a', 'hash');
    const claim = db.prepare(
      "INSERT INTO task_schedule_dispatches(id,task_id,project_id,runtime_epoch,stage,status,created_at) VALUES(?,'task-a','a','epoch','submit','active','now')",
    );
    claim.run('first');
    expect(() => claim.run('duplicate')).toThrow(/UNIQUE/);
    expect(checkIntegrity(db).ok).toBe(true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
