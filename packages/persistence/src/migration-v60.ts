import type Database from 'better-sqlite3';

/** Add version-pinned content IR and Agent-authored scene/shot IR. Old rows stay null. */
const V60_COLUMNS = [
  ['document_versions', 'content_ir_json'],
  ['scenes', 'authoring_ir_json'],
  ['shots', 'authoring_ir_json'],
  ['agent_change_set_items', 'production_authoring_ir_json'],
] as const;

export const MIGRATION_V60 = V60_COLUMNS.map(
  ([table, column]) =>
    `ALTER TABLE ${table} ADD COLUMN ${column} TEXT\n  CHECK (${column} IS NULL OR json_valid(${column}));`,
).join('\n');

/** Tolerates a schema-migration ledger restored without the columns being rolled back. */
export function applyMigrationV60(database: Database.Database): void {
  for (const [table, column] of V60_COLUMNS) {
    const present = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!present.some((entry) => entry.name === column))
      database.exec(
        `ALTER TABLE ${table} ADD COLUMN ${column} TEXT\n         CHECK (${column} IS NULL OR json_valid(${column}));`,
      );
  }
}
