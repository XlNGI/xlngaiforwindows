import type Database from 'better-sqlite3';

/** Durable, project-scoped manual image selections for a shot. */
export function applyMigrationV65(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shot_reference_bindings (
      shot_id TEXT PRIMARY KEY REFERENCES shots(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      bindings_json TEXT NOT NULL CHECK (
        json_valid(bindings_json) AND json_type(bindings_json) = 'object'
      ),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shot_reference_bindings_project
      ON shot_reference_bindings(project_id, updated_at, shot_id);
  `);
}
