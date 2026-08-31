import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { IntegrityReport } from '@ai-video/domain';
import {
  APP_MIGRATION_V1,
  APP_MIGRATION_V2,
  APP_MIGRATION_V3,
  APP_MIGRATION_V4,
  CURRENT_APP_SCHEMA_VERSION,
} from './app-schema.js';
import type { OpenDatabaseOptions } from './database.js';

export function openAppDatabase(
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

export function getAppSchemaVersion(database: Database.Database): number {
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_schema_migrations'",
    )
    .get();
  if (!table) return 0;
  const row = database
    .prepare('SELECT MAX(version) AS version FROM app_schema_migrations')
    .get() as { version: number | null };
  return row.version ?? 0;
}

export function migrateAppDatabase(
  database: Database.Database,
  now = new Date().toISOString(),
): number {
  const currentVersion = getAppSchemaVersion(database);
  if (currentVersion > CURRENT_APP_SCHEMA_VERSION) {
    throw new Error(
      `App schema v${currentVersion} is newer than supported v${CURRENT_APP_SCHEMA_VERSION}.`,
    );
  }
  if (currentVersion === 0) {
    database.transaction(() => {
      database.exec(APP_MIGRATION_V1);
      database
        .prepare('INSERT INTO app_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, now);
    })();
  }
  if (getAppSchemaVersion(database) === 1) {
    database.transaction(() => {
      database.exec(APP_MIGRATION_V2);
      database
        .prepare('INSERT INTO app_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(2, now);
    })();
  }
  if (getAppSchemaVersion(database) === 2) {
    database.transaction(() => {
      database.exec(APP_MIGRATION_V3);
      database
        .prepare('INSERT INTO app_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(3, now);
    })();
  }
  if (getAppSchemaVersion(database) === 3) {
    database.transaction(() => {
      database.exec(APP_MIGRATION_V4);
      database
        .prepare('INSERT INTO app_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(4, now);
    })();
  }
  return getAppSchemaVersion(database);
}

export function checkAppIntegrity(database: Database.Database): IntegrityReport {
  const rows = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const foreignKeyRows = database.pragma('foreign_key_check') as Array<Record<string, unknown>>;
  const messages = rows.map((row) => row.integrity_check);
  if (foreignKeyRows.length > 0)
    messages.push(`${foreignKeyRows.length} foreign key violation(s).`);
  return {
    ok: rows.length === 1 && rows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0,
    messages,
    schemaVersion: getAppSchemaVersion(database),
  };
}
