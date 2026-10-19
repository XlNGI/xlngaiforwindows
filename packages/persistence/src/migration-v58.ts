export const MIGRATION_V58 = `
CREATE TABLE IF NOT EXISTS llm_provider_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  generation_id TEXT NOT NULL REFERENCES llm_generations(id),
  attempt_id TEXT NOT NULL REFERENCES llm_generation_attempts(id),
  project_session_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
);
CREATE INDEX IF NOT EXISTS llm_provider_requests_generation ON llm_provider_requests(generation_id,created_at);
CREATE TABLE IF NOT EXISTS scene_structure_stages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  execution_key TEXT NOT NULL, title TEXT NOT NULL,
  expected_scene_count INTEGER NOT NULL CHECK(expected_scene_count BETWEEN 1 AND 20),
  row_version INTEGER NOT NULL DEFAULT 0,
  scenes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scenes_json)),
  change_set_id TEXT REFERENCES agent_change_sets(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, conversation_id, execution_key)
);
`;
