import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
} from './schema.js';

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
