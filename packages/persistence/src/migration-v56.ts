export const MIGRATION_V56 = `
CREATE TABLE IF NOT EXISTS shot_continuity (
  shot_id TEXT PRIMARY KEY REFERENCES shots(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  binding_json TEXT CHECK(binding_json IS NULL OR (json_valid(binding_json) AND length(binding_json) <= 100000)),
  row_version INTEGER NOT NULL CHECK(row_version > 0),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shot_continuity_project ON shot_continuity(project_id, shot_id);
CREATE TRIGGER IF NOT EXISTS shot_continuity_project_insert BEFORE INSERT ON shot_continuity
WHEN NOT EXISTS (SELECT 1 FROM shots JOIN scenes ON scenes.id=shots.scene_id
                 WHERE shots.id=NEW.shot_id AND scenes.project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'shot continuity project mismatch'); END;
CREATE TRIGGER IF NOT EXISTS shot_continuity_project_update BEFORE UPDATE OF project_id,shot_id ON shot_continuity
WHEN NOT EXISTS (SELECT 1 FROM shots JOIN scenes ON scenes.id=shots.scene_id
                 WHERE shots.id=NEW.shot_id AND scenes.project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'shot continuity project mismatch'); END;
`;
