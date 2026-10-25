import type Database from 'better-sqlite3';

/** Distinguish pre-fix IR-only rows from later explicit binding edits. */
export function applyMigrationV61(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(scenes)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'authoring_bindings_applied'))
    database.exec(
      'ALTER TABLE scenes ADD COLUMN authoring_bindings_applied INTEGER NOT NULL DEFAULT 0 CHECK(authoring_bindings_applied IN (0,1))',
    );
}
