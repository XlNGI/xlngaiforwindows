export const MIGRATION_V55 = `
CREATE TABLE IF NOT EXISTS conversation_prompt_templates (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK(length(content) <= 20000),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK(row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_prompt_templates_project
  ON conversation_prompt_templates(project_id, conversation_id);
CREATE TRIGGER IF NOT EXISTS conversation_prompt_templates_project_insert
BEFORE INSERT ON conversation_prompt_templates
WHEN NOT EXISTS (
  SELECT 1 FROM conversations
  WHERE id = NEW.conversation_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'conversation prompt template project mismatch');
END;
CREATE TRIGGER IF NOT EXISTS conversation_prompt_templates_project_update
BEFORE UPDATE OF conversation_id, project_id ON conversation_prompt_templates
WHEN NOT EXISTS (
  SELECT 1 FROM conversations
  WHERE id = NEW.conversation_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'conversation prompt template project mismatch');
END;
`;
