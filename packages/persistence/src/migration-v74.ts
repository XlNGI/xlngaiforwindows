import type Database from 'better-sqlite3';

/** Recoverable scene/shot lifecycle; children retain their individual archive state. */
export function applyMigrationV74(database: Database.Database): void {
  for (const table of ['scenes', 'shots']) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'archived_at'))
      database.exec(`ALTER TABLE ${table} ADD COLUMN archived_at TEXT`);
  }
  database.exec(`
CREATE INDEX IF NOT EXISTS idx_scenes_lifecycle ON scenes(project_id, archived_at, position);
CREATE INDEX IF NOT EXISTS idx_shots_lifecycle ON shots(scene_id, archived_at, position);
CREATE TABLE IF NOT EXISTS production_lifecycle_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('scene','shot')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('archive','restore')),
  previous_row_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS archived_scene_read_only BEFORE UPDATE ON scenes
WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS OLD.archived_at
BEGIN SELECT RAISE(ABORT, 'Scene is archived. Restore it before editing.'); END;
CREATE TRIGGER IF NOT EXISTS archived_scene_shot_insert BEFORE INSERT ON shots
WHEN EXISTS(SELECT 1 FROM scenes WHERE id=NEW.scene_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Scene is archived. Restore it before editing.'); END;
CREATE TRIGGER IF NOT EXISTS archived_shot_read_only BEFORE UPDATE ON shots
WHEN (OLD.archived_at IS NOT NULL AND NEW.archived_at IS OLD.archived_at)
  OR EXISTS(SELECT 1 FROM scenes WHERE id=NEW.scene_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Scene or shot is archived. Restore it before editing.'); END;
CREATE TRIGGER IF NOT EXISTS archived_storyboard_read_only BEFORE UPDATE ON documents
WHEN EXISTS(SELECT 1 FROM shots JOIN scenes ON scenes.id=shots.scene_id
  WHERE shots.document_id=OLD.id AND (shots.archived_at IS NOT NULL OR scenes.archived_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'Scene or shot is archived. Restore it before editing.'); END;
CREATE TRIGGER IF NOT EXISTS archived_storyboard_version_insert BEFORE INSERT ON document_versions
WHEN EXISTS(SELECT 1 FROM shots JOIN scenes ON scenes.id=shots.scene_id
  WHERE shots.document_id=NEW.document_id AND (shots.archived_at IS NOT NULL OR scenes.archived_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'Scene or shot is archived. Restore it before editing.'); END;
`);
}
