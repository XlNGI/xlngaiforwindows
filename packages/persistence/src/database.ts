import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { IntegrityReport } from '@ai-video/domain';
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATION_V1,
  MIGRATION_V2,
  MIGRATION_V3,
  MIGRATION_V4,
  MIGRATION_V5,
  MIGRATION_V6,
  MIGRATION_V7,
  MIGRATION_V8,
  MIGRATION_V9,
  MIGRATION_V10,
  MIGRATION_V11,
  MIGRATION_V12,
  MIGRATION_V13,
  MIGRATION_V15,
  MIGRATION_V17,
  MIGRATION_V19,
  MIGRATION_V20,
  MIGRATION_V21,
  MIGRATION_V22,
  MIGRATION_V23,
  MIGRATION_V24,
  MIGRATION_V25,
  MIGRATION_V26,
  MIGRATION_V27,
  MIGRATION_V28,
  MIGRATION_V29,
  MIGRATION_V30,
  MIGRATION_V31,
  MIGRATION_V32,
  MIGRATION_V33,
  MIGRATION_V34,
} from './schema.js';
import { runV14Rebuild } from './migration-v14.js';
import { rewriteLegacyContextSnapshots } from './migration-v16.js';
import { widenAgentTaskToolCallLimit } from './migration-v18.js';
import { addSchemaQueryTaskType } from './migration-v35.js';
import { backfillCurrentNovelRagChunks } from './novel-rag-chunks.js';

export interface OpenDatabaseOptions {
  readonly?: boolean;
  nativeBinding?: string | object;
}

export function openProjectDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): Database.Database {
  const databasePath = resolve(path);
  if (!options.readonly) mkdirSync(dirname(databasePath), { recursive: true });
  const databaseOptions: Database.Options = {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
  };
  if (options.nativeBinding) {
    databaseOptions.nativeBinding = options.nativeBinding as unknown as string;
  }
  const database = new Database(databasePath, databaseOptions);
  try {
    database.function('sha256', { deterministic: true }, (value: unknown) =>
      createHash('sha256').update(String(value), 'utf8').digest('hex'),
    );
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (!options.readonly) {
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = NORMAL');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function getSchemaVersion(database: Database.Database): number {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return 0;
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

export function migrateDatabase(
  database: Database.Database,
  now = new Date().toISOString(),
): number {
  const currentVersion = getSchemaVersion(database);
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Project schema v${currentVersion} is newer than supported v${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  if (currentVersion === 0) {
    database.transaction(() => {
      database.exec(MIGRATION_V1);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, now);
    })();
  }
  if (getSchemaVersion(database) === 1) {
    database.transaction(() => {
      database.exec(MIGRATION_V2);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(2, now);
    })();
  }
  if (getSchemaVersion(database) === 2) {
    database.transaction(() => {
      database.exec(MIGRATION_V3);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(3, now);
    })();
  }
  if (getSchemaVersion(database) === 3) {
    database.transaction(() => {
      database.exec(MIGRATION_V4);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(4, now);
    })();
  }
  if (getSchemaVersion(database) === 4) {
    database.transaction(() => {
      database.exec(MIGRATION_V5);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(5, now);
    })();
  }
  if (getSchemaVersion(database) === 5) {
    database.transaction(() => {
      database.exec(MIGRATION_V6);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(6, now);
    })();
  }
  if (getSchemaVersion(database) === 6) {
    database.transaction(() => {
      database.exec(MIGRATION_V7);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(7, now);
    })();
  }
  if (getSchemaVersion(database) === 7) {
    database.transaction(() => {
      database.exec(MIGRATION_V8);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(8, now);
    })();
  }
  if (getSchemaVersion(database) === 8) {
    database.transaction(() => {
      database.exec(MIGRATION_V9);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(9, now);
    })();
  }
  if (getSchemaVersion(database) === 9) {
    database.transaction(() => {
      database.exec(MIGRATION_V10);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(10, now);
    })();
  }
  if (getSchemaVersion(database) === 10) {
    database.transaction(() => {
      database.exec(MIGRATION_V11);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(11, now);
    })();
  }
  if (getSchemaVersion(database) === 11) {
    database.transaction(() => {
      database.exec(MIGRATION_V12);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(12, now);
    })();
  }
  if (getSchemaVersion(database) === 12) {
    database.transaction(() => {
      database.exec(MIGRATION_V13);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(13, now);
    })();
  }
  if (getSchemaVersion(database) === 13) {
    runV14Rebuild(database, now);
  }
  if (getSchemaVersion(database) === 14) {
    database.transaction(() => {
      database.exec(MIGRATION_V15);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(15, now);
    })();
  }
  if (getSchemaVersion(database) === 15) {
    database.transaction(() => {
      rewriteLegacyContextSnapshots(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(16, now);
    })();
  }
  if (getSchemaVersion(database) === 16) {
    database.transaction(() => {
      database.exec(MIGRATION_V17);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(17, now);
    })();
  }
  if (getSchemaVersion(database) === 17) {
    widenAgentTaskToolCallLimit(database, now);
  }
  if (getSchemaVersion(database) === 18) {
    database.transaction(() => {
      database.exec(MIGRATION_V19);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(19, now);
    })();
  }
  if (getSchemaVersion(database) === 19) {
    database.transaction(() => {
      database.exec(MIGRATION_V20);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(20, now);
    })();
  }
  if (getSchemaVersion(database) === 20) {
    database.transaction(() => {
      database.exec(MIGRATION_V21);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(21, now);
    })();
  }
  if (getSchemaVersion(database) === 21) {
    database.transaction(() => {
      database.exec(MIGRATION_V22);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(22, now);
    })();
  }
  if (getSchemaVersion(database) === 22) {
    database.transaction(() => {
      database.exec(MIGRATION_V23);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(23, now);
    })();
  }
  if (getSchemaVersion(database) === 23) {
    database.transaction(() => {
      database.exec(MIGRATION_V24);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(24, now);
    })();
  }
  if (getSchemaVersion(database) === 24) {
    database.transaction(() => {
      database.exec(MIGRATION_V25);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(25, now);
    })();
  }
  if (getSchemaVersion(database) === 25) {
    database.transaction(() => {
      database.exec(MIGRATION_V26);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(26, now);
    })();
  }
  if (getSchemaVersion(database) === 26) {
    database.transaction(() => {
      database.exec(MIGRATION_V27);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(27, now);
    })();
  }
  if (getSchemaVersion(database) === 27) {
    database.transaction(() => {
      database.exec(MIGRATION_V28);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(28, now);
    })();
  }
  if (getSchemaVersion(database) === 28) {
    database.transaction(() => {
      database.exec(MIGRATION_V29);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(29, now);
    })();
  }
  if (getSchemaVersion(database) === 29) {
    database.transaction(() => {
      database.exec(MIGRATION_V30);
      backfillCurrentNovelRagChunks(database, now);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(30, now);
    })();
  }
  if (getSchemaVersion(database) === 30) {
    database.transaction(() => {
      database.exec(MIGRATION_V31);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(31, now);
    })();
  }
  if (getSchemaVersion(database) === 31) {
    database.transaction(() => {
      database.exec(MIGRATION_V32);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(32, now);
    })();
  }
  if (getSchemaVersion(database) === 32) {
    database.transaction(() => {
      const column = database
        .prepare(
          "SELECT name FROM pragma_table_info('generation_jobs') WHERE name = 'task_snapshot_json'",
        )
        .get();
      if (!column) {
        database.exec(MIGRATION_V33);
      } else {
        database.exec(`
          CREATE TRIGGER IF NOT EXISTS generation_jobs_task_snapshot_immutable
          BEFORE UPDATE OF task_snapshot_json ON generation_jobs
          WHEN OLD.task_snapshot_json IS NOT NULL
            AND (NEW.task_snapshot_json IS NULL OR NEW.task_snapshot_json <> OLD.task_snapshot_json)
          BEGIN
            SELECT RAISE(ABORT, 'generation task snapshot is immutable');
          END;
        `);
      }
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(33, now);
    })();
  }
  if (getSchemaVersion(database) === 33) {
    database.transaction(() => {
      database.exec(MIGRATION_V34);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(34, now);
    })();
  }
  if (getSchemaVersion(database) === 34) {
    addSchemaQueryTaskType(database, now);
  }
  return getSchemaVersion(database);
}

export function checkIntegrity(database: Database.Database): IntegrityReport {
  const rows = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const foreignKeyRows = database.pragma('foreign_key_check') as Array<Record<string, unknown>>;
  const messages = rows.map((row) => row.integrity_check);
  if (foreignKeyRows.length > 0) {
    messages.push(`${foreignKeyRows.length} foreign key violation(s).`);
  }
  return {
    ok: rows.length === 1 && rows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0,
    messages,
    schemaVersion: getSchemaVersion(database),
  };
}

export function checkpoint(database: Database.Database): void {
  database.pragma('wal_checkpoint(TRUNCATE)');
}
