import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  openAppDatabase,
  migrateAppDatabase,
  getAppSchemaVersion,
  checkAppIntegrity,
} from './app-database.js';

it('upgrades application v7 registration metadata atomically without copying project content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-runtime-app-migration-'));
  const db = openAppDatabase(join(root, 'app.sqlite'));
  try {
    migrateAppDatabase(db);
    db.exec(`DROP TABLE project_runtime_registrations;DELETE FROM app_schema_migrations WHERE version>=8;
      INSERT INTO provider_profiles(id,name,category,provider_type,access_type,protocol,base_url,enabled,connection_status,created_at,updated_at)
      VALUES('provider','Existing','multi','vidu','official','vidu-v2','https://api.vidu.com',1,'ready','now','now');
      CREATE TRIGGER fail_runtime_registry BEFORE INSERT ON app_schema_migrations WHEN NEW.version=8
      BEGIN SELECT RAISE(ABORT,'v8 failure'); END;`);
    expect(() => migrateAppDatabase(db)).toThrow('v8 failure');
    expect(getAppSchemaVersion(db)).toBe(7);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_runtime_registrations'").get(),
    ).toBeUndefined();
    db.exec('DROP TRIGGER fail_runtime_registry');
    expect(migrateAppDatabase(db)).toBe(8);
    expect(migrateAppDatabase(db)).toBe(8);
    expect(db.prepare('SELECT name FROM provider_profiles WHERE id=?').get('provider')).toEqual({
      name: 'Existing',
    });
    const fields = (
      db.prepare("PRAGMA table_info('project_runtime_registrations')").all() as Array<{
        name: string;
      }>
    ).map((field) => field.name);
    expect(fields).toEqual([
      'project_id',
      'canonical_path',
      'directory_identity',
      'recover_on_startup',
      'last_error',
      'updated_at',
    ]);
    expect(checkAppIntegrity(db).ok).toBe(true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
