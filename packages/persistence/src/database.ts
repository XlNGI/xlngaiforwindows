import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { IntegrityReport } from '@ai-video/domain';
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATION_V70,
  MIGRATION_V69,
  MIGRATION_V68,
  MIGRATION_V67,
  MIGRATION_V66,
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
  MIGRATION_V36,
  MIGRATION_V38,
  MIGRATION_V39,
  MIGRATION_V40,
  MIGRATION_V41,
  MIGRATION_V42,
  MIGRATION_V47,
  MIGRATION_V48,
  MIGRATION_V49,
} from './schema.js';
import { runV14Rebuild } from './migration-v14.js';
import { MIGRATION_V44 } from './migration-v44.js';
import { MIGRATION_V45 } from './migration-v45.js';
import { MIGRATION_V46 } from './migration-v46.js';
import { MIGRATION_V50 } from './migration-v50.js';
import { MIGRATION_V51 } from './migration-v51.js';
import { MIGRATION_V52 } from './migration-v52.js';
import { MIGRATION_V53 } from './migration-v53.js';
import { MIGRATION_V54 } from './migration-v54.js';
import { MIGRATION_V55 } from './migration-v55.js';
import { MIGRATION_V56 } from './migration-v56.js';
import { widenLibraryReadAuthorizationLimit } from './migration-v57.js';
import { MIGRATION_V58 } from './migration-v58.js';
import { MIGRATION_V59 } from './migration-v59.js';
import { applyMigrationV60 } from './migration-v60.js';
import { applyMigrationV61 } from './migration-v61.js';
import { applyMigrationV62 } from './migration-v62.js';
import { MIGRATION_V63 } from './migration-v63.js';
import { applyMigrationV64 } from './migration-v64.js';
import { applyMigrationV65 } from './migration-v65.js';
import { applyMigrationV71 } from './migration-v71.js';
import { applyMigrationV72 } from './migration-v72.js';
import { MIGRATION_V73 } from './migration-v73.js';
import { applyMigrationV74 } from './migration-v74.js';
import { applyMigrationV75 } from './migration-v75.js';
import { applyMigrationV76 } from './migration-v76.js';
import { rewriteLegacyContextSnapshots } from './migration-v16.js';
import { widenAgentTaskToolCallLimit } from './migration-v18.js';
import { addSchemaQueryTaskType } from './migration-v35.js';
import { backfillCurrentNovelRagChunks } from './novel-rag-chunks.js';
import {
  backfillProjectLibraryChunks,
  backfillProjectStructureNodes,
  createProjectLibraryFts,
  rebuildLibraryChunksForDocument,
} from './project-library-chunks.js';

const documentMutationAuthorizations = new WeakMap<Database.Database, Map<string, number>>();

function mutationAuthorizationKey(documentId: string, operation: string): string {
  return `${documentId}\u001f${operation}`;
}

function registerDocumentMutationFunction(database: Database.Database): void {
  if (documentMutationAuthorizations.has(database)) return;
  documentMutationAuthorizations.set(database, new Map());
  database.function('document_mutation_allowed', (documentId: unknown, operation: unknown) =>
    documentMutationAuthorizations
      .get(database)
      ?.has(mutationAuthorizationKey(String(documentId), String(operation)))
      ? 1
      : 0,
  );
}

/** Grants one document a narrowly scoped mutation for the duration of a Worker operation. */
export function withDocumentMutationAuthorization<T>(
  database: Database.Database,
  documentId: string,
  operation: 'unpublish',
  callback: () => T,
): T {
  registerDocumentMutationFunction(database);
  const authorizations = documentMutationAuthorizations.get(database)!;
  const key = mutationAuthorizationKey(documentId, operation);
  authorizations.set(key, (authorizations.get(key) ?? 0) + 1);
  try {
    return callback();
  } finally {
    const count = authorizations.get(key) ?? 0;
    if (count <= 1) authorizations.delete(key);
    else authorizations.set(key, count - 1);
  }
}

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
    registerDocumentMutationFunction(database);
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
  registerDocumentMutationFunction(database);
  const currentVersion = getSchemaVersion(database);
  if (currentVersion > 0 && currentVersion < 76) {
    // A physical schema can be ahead of its migration ledger after interruption.
    // Later-schema observers must not reference columns rebuilt by older migrations.
    database.transaction(() => {
      for (const table of ['documents', 'scenes', 'shots', 'scene_structure_stages'])
        for (const op of ['insert', 'update'])
          database.exec(`DROP TRIGGER IF EXISTS agent_changes_${table}_${op}`);
    })();
  }
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
  if (getSchemaVersion(database) === 35) {
    database.transaction(() => {
      database.exec(MIGRATION_V36);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(36, now);
    })();
  }
  if (getSchemaVersion(database) === 36) {
    database.transaction(() => {
      applyMigrationV37(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(37, now);
    })();
  }
  if (getSchemaVersion(database) === 37) {
    database.transaction(() => {
      database.exec(MIGRATION_V38);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(38, now);
    })();
  }
  if (getSchemaVersion(database) === 38) {
    database.transaction(() => {
      applyMigrationV39(database, now);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(39, now);
    })();
  }
  if (getSchemaVersion(database) === 39) {
    database.transaction(() => {
      applyMigrationV40(database, now);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(40, now);
    })();
  }
  if (getSchemaVersion(database) === 40) {
    database.transaction(() => {
      database.exec(MIGRATION_V41);
      backfillProjectStructureNodes(database, now);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(41, now);
    })();
  }
  if (getSchemaVersion(database) === 41) {
    database.transaction(() => {
      database.exec(MIGRATION_V42);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(42, now);
    })();
  }
  if (getSchemaVersion(database) === 42) {
    database.transaction(() => {
      applyMigrationV43(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(43, now);
    })();
  }
  if (getSchemaVersion(database) === 43) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V44);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(44, now);
    })();
  }
  if (getSchemaVersion(database) === 44) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V45);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(45, now);
    })();
  }
  if (getSchemaVersion(database) === 45) {
    checkpoint(database);
    database.transaction(() => {
      const columns = database.prepare('PRAGMA table_info(scenes)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'dialogue_audio_id'))
        database.exec(
          'ALTER TABLE scenes ADD COLUMN dialogue_audio_id TEXT REFERENCES audio_files(id) ON DELETE RESTRICT',
        );
      database.exec(MIGRATION_V46);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(46, now);
    })();
  }
  if (getSchemaVersion(database) === 46) {
    checkpoint(database);
    database.transaction(() => {
      const columns = database.prepare('PRAGMA table_info(agent_change_set_items)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'scene_bindings_json'))
        database.exec(MIGRATION_V47);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(47, now);
    })();
  }
  if (getSchemaVersion(database) === 47) {
    checkpoint(database);
    database.transaction(() => {
      const columns = database
        .prepare('PRAGMA table_info(scene_character_bindings)')
        .all() as Array<{ name: string }>;
      // Historical migration fixtures may retain columns from a newer schema.
      if (!columns.some((column) => column.name === 'image_disabled')) database.exec(MIGRATION_V48);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(48, now);
    })();
  }
  if (getSchemaVersion(database) === 48) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V49);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(49, now);
    })();
  }
  if (getSchemaVersion(database) === 49) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V50);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(50, now);
    })();
  }
  if (getSchemaVersion(database) === 50) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V51);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(51, now);
    })();
  }
  if (getSchemaVersion(database) === 51) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V52);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(52, now);
    })();
  }
  if (getSchemaVersion(database) === 52) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V53);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(53, now);
    })();
  }
  if (getSchemaVersion(database) === 53) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V54);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(54, now);
    })();
  }
  if (getSchemaVersion(database) === 54) {
    checkpoint(database);
    database.transaction(() => {
      database.exec(MIGRATION_V55);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(55, now);
    })();
  }
  if (currentVersion < 56) {
    database.transaction(() => {
      database.exec(MIGRATION_V56);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(56, now);
    })();
  }
  if (currentVersion < 57) {
    widenLibraryReadAuthorizationLimit(database, now);
  }
  if (currentVersion < 58) {
    database.transaction(() => {
      const columns = new Set(
        (
          database.prepare('PRAGMA table_info(llm_generations)').all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      for (const column of ['user_request', 'session_constraints'])
        if (!columns.has(column))
          database.exec(`ALTER TABLE llm_generations ADD COLUMN ${column} TEXT`);
      database.exec(MIGRATION_V58);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(58, now);
    })();
  }
  if (currentVersion < 59) {
    database.transaction(() => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(agent_tasks)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      if (!columns.has('completion_state')) database.exec(MIGRATION_V59);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(59, now);
    })();
  }
  if (getSchemaVersion(database) < 60) {
    database.transaction(() => {
      applyMigrationV60(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(60, now);
    })();
  }
  if (getSchemaVersion(database) < 61) {
    database.transaction(() => {
      applyMigrationV61(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(61, now);
    })();
  }
  if (getSchemaVersion(database) < 62) {
    database.transaction(() => {
      applyMigrationV62(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(62, now);
    })();
  }
  if (getSchemaVersion(database) < 63) {
    database.transaction(() => {
      database.exec(MIGRATION_V63);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(63, now);
    })();
  }
  if (getSchemaVersion(database) < 64) {
    database.transaction(() => {
      applyMigrationV64(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(64, now);
    })();
  }
  if (getSchemaVersion(database) < 65) {
    database.transaction(() => {
      applyMigrationV65(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(65, now);
    })();
  }
  if (getSchemaVersion(database) < 66) {
    database.transaction(() => {
      database.exec(MIGRATION_V66);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(66, now);
    })();
  }
  if (getSchemaVersion(database) < 67) {
    database.transaction(() => {
      const generationColumns = new Set(
        (
          database.prepare('PRAGMA table_info(llm_generations)').all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      if (!generationColumns.has('request_fingerprint')) {
        database.exec(
          `ALTER TABLE llm_generations ADD COLUMN request_fingerprint TEXT
           CHECK (request_fingerprint IS NULL OR length(request_fingerprint) = 64)`,
        );
      }
      database.exec(MIGRATION_V67);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(67, now);
    })();
  }
  if (getSchemaVersion(database) < 68) {
    database.transaction(() => {
      database.exec(MIGRATION_V68);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(68, now);
    })();
  }
  if (getSchemaVersion(database) < 69) {
    database.transaction(() => {
      database.exec(MIGRATION_V69);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(69, now);
    })();
  }
  if (getSchemaVersion(database) < 70) {
    database.transaction(() => {
      database.exec(MIGRATION_V70);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(70, now);
    })();
  }
  if (getSchemaVersion(database) < 71) {
    database.transaction(() => {
      applyMigrationV71(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(71, now);
    })();
  }
  if (getSchemaVersion(database) < 72) {
    database.transaction(() => {
      applyMigrationV72(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(72, now);
    })();
  }
  if (getSchemaVersion(database) < 73) {
    database.transaction(() => {
      database.exec(MIGRATION_V73);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(73, now);
    })();
  }
  if (getSchemaVersion(database) < 74) {
    database.transaction(() => {
      applyMigrationV74(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(74, now);
    })();
  }
  if (getSchemaVersion(database) < 75) {
    database.transaction(() => {
      applyMigrationV75(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(75, now);
    })();
  }
  if (getSchemaVersion(database) < 76) {
    database.transaction(() => {
      applyMigrationV76(database);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(76, now);
    })();
  }
  return getSchemaVersion(database);
}

function applyMigrationV43(database: Database.Database): void {
  const columns = new Set(
    (database.prepare('PRAGMA table_info(scenes)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('video_prompt'))
    database.exec('ALTER TABLE scenes ADD COLUMN video_prompt TEXT');
  if (!columns.has('material_bindings_json')) {
    database.exec(
      "ALTER TABLE scenes ADD COLUMN material_bindings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(material_bindings_json))",
    );
  }
}

function applyMigrationV39(database: Database.Database, now: string): void {
  database.exec(MIGRATION_V39);
  createProjectLibraryFts(database);
  backfillProjectLibraryChunks(database, now);
}

function applyMigrationV40(database: Database.Database, now: string): void {
  database.exec(MIGRATION_V40);
  const rows = database.prepare('SELECT id, project_id FROM documents').all() as Array<{
    id: string;
    project_id: string;
  }>;
  for (const row of rows) {
    rebuildLibraryChunksForDocument(database, row.project_id, row.id, now);
  }
}

function applyMigrationV37(database: Database.Database): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info('generation_jobs')").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const statements: Array<[string, string]> = [
    [
      'media_state',
      "ALTER TABLE generation_jobs ADD COLUMN media_state TEXT NOT NULL DEFAULT 'draft' CHECK (media_state IN ('draft', 'awaiting_confirmation', 'submitting', 'polling', 'submission_unknown', 'downloading', 'validating', 'committing', 'succeeded', 'failed', 'timed_out', 'cancelled'))",
    ],
    [
      'submission_idempotency_key',
      'ALTER TABLE generation_jobs ADD COLUMN submission_idempotency_key TEXT',
    ],
    [
      'submission_confirmation_token_hash',
      'ALTER TABLE generation_jobs ADD COLUMN submission_confirmation_token_hash TEXT',
    ],
    [
      'submission_confirmation_expires_at',
      'ALTER TABLE generation_jobs ADD COLUMN submission_confirmation_expires_at TEXT',
    ],
    [
      'submission_confirmation_consumed_at',
      'ALTER TABLE generation_jobs ADD COLUMN submission_confirmation_consumed_at TEXT',
    ],
    [
      'submission_confirmation_project_session_id',
      'ALTER TABLE generation_jobs ADD COLUMN submission_confirmation_project_session_id TEXT',
    ],
    ['submission_attempt_id', 'ALTER TABLE generation_jobs ADD COLUMN submission_attempt_id TEXT'],
  ];
  for (const [column, statement] of statements) if (!columns.has(column)) database.exec(statement);
  database.exec(`
    UPDATE generation_jobs
    SET media_state = CASE
      WHEN status = 'succeeded' THEN 'succeeded'
      WHEN status = 'failed' THEN 'failed'
      WHEN status = 'cancelled' THEN 'cancelled'
      WHEN status = 'timed-out' THEN 'timed_out'
      WHEN status IN ('polling', 'downloading', 'paused') THEN 'polling'
      WHEN status IN ('pending', 'running') THEN 'submission_unknown'
      ELSE COALESCE(media_state, 'draft')
    END;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_submission_idempotency
      ON generation_jobs(project_id, submission_idempotency_key)
      WHERE submission_idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_media_state
      ON generation_jobs(project_id, media_state, updated_at, id);
    CREATE TRIGGER IF NOT EXISTS generation_jobs_media_terminal_immutable
    BEFORE UPDATE OF media_state ON generation_jobs
    WHEN OLD.media_state IN ('succeeded', 'failed', 'timed_out', 'cancelled')
      AND NEW.media_state <> OLD.media_state
    BEGIN
      SELECT RAISE(ABORT, 'terminal media state is immutable');
    END;
  `);
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
