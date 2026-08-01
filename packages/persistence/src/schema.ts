export const CURRENT_SCHEMA_VERSION = 4;

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
