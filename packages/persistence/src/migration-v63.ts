/** Local review forms survive Agent completion. No Provider jobs are created here. */
export const MIGRATION_V63 = `
CREATE TABLE IF NOT EXISTS production_review_forms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  task_id TEXT REFERENCES agent_tasks(id),
  form_key TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
  source_rows_json TEXT NOT NULL CHECK(json_valid(source_rows_json)),
  draft_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitting','submitted','cancelled')),
  job_id TEXT,
  error TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,conversation_id,form_key)
);
CREATE INDEX IF NOT EXISTS production_review_forms_conversation ON production_review_forms(project_id,conversation_id,created_at);
`;
