/** Detailed instructions follow the existing proposal review transaction. */
export const MIGRATION_V54 = `
CREATE TABLE IF NOT EXISTS production_change_set_instructions (
 item_id TEXT PRIMARY KEY REFERENCES agent_change_set_items(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id),
 instruction_json TEXT NOT NULL CHECK(json_valid(instruction_json) AND length(instruction_json)<=524288)
);
CREATE TRIGGER IF NOT EXISTS production_proposal_project_insert
BEFORE INSERT ON production_change_set_instructions
WHEN NOT EXISTS(SELECT 1 FROM agent_change_set_items WHERE id=NEW.item_id AND project_id=NEW.project_id AND entity_type IN('scene','shot'))
BEGIN SELECT RAISE(ABORT,'production proposal project mismatch'); END;
CREATE TABLE IF NOT EXISTS production_defaults (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 row_version INTEGER NOT NULL DEFAULT 1,
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json) AND length(settings_json)<=65536),
 updated_at TEXT NOT NULL
);
`;
