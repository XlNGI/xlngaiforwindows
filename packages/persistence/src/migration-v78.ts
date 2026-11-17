import type Database from 'better-sqlite3';

/** Current document bindings can be removed without rewriting immutable media provenance. */
export function applyMigrationV78(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_image_exclusions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      removed_at TEXT NOT NULL,
      PRIMARY KEY(document_id, asset_id)
    );
    CREATE TRIGGER IF NOT EXISTS document_image_exclusions_project_insert
    BEFORE INSERT ON document_image_exclusions
    WHEN (SELECT project_id FROM documents WHERE id=NEW.document_id) IS NOT NEW.project_id
      OR (SELECT project_id FROM assets WHERE id=NEW.asset_id) IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'document image project mismatch');
    END;
    CREATE TRIGGER IF NOT EXISTS document_image_exclusions_project_update
    BEFORE UPDATE ON document_image_exclusions
    WHEN (SELECT project_id FROM documents WHERE id=NEW.document_id) IS NOT NEW.project_id
      OR (SELECT project_id FROM assets WHERE id=NEW.asset_id) IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'document image project mismatch');
    END;
  `);
}
