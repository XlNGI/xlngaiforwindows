export const MIGRATION_V79 = `
CREATE TABLE IF NOT EXISTS conversation_prompt_template_variants (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  templates_json TEXT NOT NULL CHECK(json_valid(templates_json) AND json_type(templates_json)='object')
);
CREATE TRIGGER IF NOT EXISTS conversation_prompt_template_variants_project_insert
BEFORE INSERT ON conversation_prompt_template_variants
WHEN NOT EXISTS (SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'conversation prompt template project mismatch'); END;
CREATE TRIGGER IF NOT EXISTS conversation_prompt_template_variants_project_update
BEFORE UPDATE OF conversation_id, project_id ON conversation_prompt_template_variants
WHEN NOT EXISTS (SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'conversation prompt template project mismatch'); END;
`;
