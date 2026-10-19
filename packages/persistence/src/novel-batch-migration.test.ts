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
import { CURRENT_SCHEMA_VERSION } from './schema.js';

it('rolls a failed v51 batch upgrade back and installs the project/target and immutable dependency guards once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-batch-migration-'));
  const database = openProjectDatabase(join(root, 'project.sqlite'));
  try {
    migrateDatabase(database);
    database.exec(`DROP TABLE novel_batch_sources; DROP TABLE novel_batch_dependencies; DROP TABLE novel_batch_children; DROP TABLE novel_task_batches;
      DELETE FROM schema_migrations WHERE version>=52;
      CREATE TRIGGER fail_v52 BEFORE INSERT ON schema_migrations WHEN NEW.version=52 BEGIN SELECT RAISE(ABORT,'v52 failure'); END;`);
    expect(() => migrateDatabase(database)).toThrow('v52 failure');
    expect(getSchemaVersion(database)).toBe(51);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='novel_task_batches'").get(),
    ).toBeUndefined();
    database.exec('DROP TRIGGER fail_v52');
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'novel_batches_%'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(5);
    expect(checkIntegrity(database).ok).toBe(true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
