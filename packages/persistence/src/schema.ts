export const CURRENT_SCHEMA_VERSION = 10;

export const MIGRATION_V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  content_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version)
);

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, position)
);

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scene_id, position)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE constraints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  source_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, relative_path)
);

CREATE TABLE generation_drafts (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  adapter_key TEXT NOT NULL,
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  updated_at TEXT NOT NULL,
  UNIQUE(shot_id, adapter_key)
);

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
  adapter_key TEXT NOT NULL,
  provider_task_id TEXT,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE generation_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  provider_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_scenes_project ON scenes(project_id, position);
CREATE INDEX idx_shots_scene ON shots(scene_id, position);
CREATE INDEX idx_conversations_scope ON conversations(project_id, scope_type, scope_id);
CREATE INDEX idx_assets_project ON assets(project_id);
CREATE INDEX idx_jobs_status ON generation_jobs(project_id, status);
`;

export const MIGRATION_V2 = `
ALTER TABLE documents ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'project';
ALTER TABLE documents ADD COLUMN scope_id TEXT;

CREATE INDEX idx_documents_scope ON documents(project_id, scope_type, scope_id);
CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id, created_at, id);
CREATE INDEX idx_context_snapshots_project ON context_snapshots(project_id, created_at);
`;

export const MIGRATION_V3 = `
ALTER TABLE chat_messages ADD COLUMN reply_to_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE INDEX idx_chat_messages_reply ON chat_messages(reply_to_message_id);
`;

export const MIGRATION_V4 = `
CREATE INDEX idx_generation_results_job ON generation_results(job_id, created_at);
`;

export const MIGRATION_V5 = `
ALTER TABLE generation_jobs ADD COLUMN metadata_json TEXT
  CHECK (metadata_json IS NULL OR json_valid(metadata_json));
`;

export const MIGRATION_V6 = `
UPDATE assets
SET source_url = CASE
  WHEN instr(source_url, '?') > 0 AND instr(source_url, '#') > 0
    THEN substr(source_url, 1, min(instr(source_url, '?'), instr(source_url, '#')) - 1)
  WHEN instr(source_url, '?') > 0 THEN substr(source_url, 1, instr(source_url, '?') - 1)
  WHEN instr(source_url, '#') > 0 THEN substr(source_url, 1, instr(source_url, '#') - 1)
  ELSE source_url
END
WHERE source_url LIKE 'http://%' OR source_url LIKE 'https://%';

UPDATE generation_results
SET provider_url = CASE
  WHEN instr(provider_url, '?') > 0 AND instr(provider_url, '#') > 0
    THEN substr(provider_url, 1, min(instr(provider_url, '?'), instr(provider_url, '#')) - 1)
  WHEN instr(provider_url, '?') > 0 THEN substr(provider_url, 1, instr(provider_url, '?') - 1)
  WHEN instr(provider_url, '#') > 0 THEN substr(provider_url, 1, instr(provider_url, '#') - 1)
  ELSE provider_url
END
WHERE provider_url LIKE 'http://%' OR provider_url LIKE 'https://%';
`;

export const MIGRATION_V7 = `
CREATE TABLE llm_generation_attempts (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
  provider_profile_id TEXT,
  provider_name_snapshot TEXT NOT NULL,
  model_id TEXT,
  model_name_snapshot TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'streaming', 'complete', 'failed', 'cancelled', 'interrupted')
  ),
  started_at TEXT NOT NULL,
  first_token_at TEXT,
  completed_at TEXT,
  provider_response_id TEXT,
  finish_reason TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  raw_usage_json TEXT CHECK (raw_usage_json IS NULL OR json_valid(raw_usage_json)),
  pricing_snapshot_json TEXT CHECK (
    pricing_snapshot_json IS NULL OR json_valid(pricing_snapshot_json)
  ),
  estimated_cost TEXT,
  currency TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX idx_llm_attempts_project ON llm_generation_attempts(conversation_id, started_at, id);
CREATE INDEX idx_llm_attempts_assistant ON llm_generation_attempts(assistant_message_id, started_at);
CREATE INDEX idx_llm_attempts_generation ON llm_generation_attempts(generation_id, started_at);
CREATE INDEX idx_llm_attempts_status ON llm_generation_attempts(status, started_at);
`;

export const MIGRATION_V8 = `
ALTER TABLE assets ADD COLUMN alias TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN updated_at TEXT;
ALTER TABLE assets ADD COLUMN deleted_at TEXT;
ALTER TABLE assets ADD COLUMN trash_relative_path TEXT;
UPDATE assets SET updated_at = created_at WHERE updated_at IS NULL;
CREATE INDEX idx_assets_library ON assets(project_id, deleted_at, created_at, id);
`;

export const MIGRATION_V9 = `
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);
CREATE TABLE asset_tag_assignments (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(asset_id, tag_id)
);
CREATE INDEX idx_asset_tags_tag ON asset_tag_assignments(tag_id, asset_id);
`;

export const MIGRATION_V10 = `
CREATE TABLE asset_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);
CREATE TABLE asset_group_tags (
  group_id TEXT NOT NULL REFERENCES asset_groups(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  PRIMARY KEY(group_id, tag_id)
);
CREATE INDEX idx_asset_group_tags_tag ON asset_group_tags(tag_id, group_id);
`;
