export const CURRENT_SCHEMA_VERSION = 31;

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

export const MIGRATION_V11 = `
CREATE TABLE llm_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'streaming', 'complete', 'failed', 'cancelled')
  ),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('legacy', 'native')),
  retry_of_generation_id TEXT REFERENCES llm_generations(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  provider_profile_id TEXT,
  model_id TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

INSERT INTO llm_generations
  (id, project_id, project_session_id, conversation_id, context_snapshot_id,
   user_message_id, assistant_message_id, status, execution_mode,
   provider_profile_id, model_id, error_code, error_message, retryable,
   created_at, updated_at, version)
SELECT attempts.generation_id,
       conversations.project_id,
       'migrated-session',
       attempts.conversation_id,
       attempts.context_snapshot_id,
       attempts.user_message_id,
       attempts.assistant_message_id,
       CASE
         WHEN attempts.status IN ('interrupted', 'failed') THEN 'failed'
         WHEN attempts.status = 'cancelled' THEN 'cancelled'
         WHEN attempts.status = 'complete' THEN 'complete'
         WHEN attempts.status = 'prepared' THEN 'prepared'
         ELSE 'streaming'
       END,
       CASE WHEN attempts.protocol = 'legacy-openai-responses' THEN 'legacy' ELSE 'native' END,
       attempts.provider_profile_id,
       attempts.model_id,
       attempts.error_code,
       attempts.error_message,
       CASE WHEN attempts.status IN ('failed', 'cancelled', 'interrupted') THEN 1 ELSE NULL END,
       attempts.started_at,
       COALESCE(attempts.completed_at, attempts.started_at),
       0
FROM llm_generation_attempts attempts
INNER JOIN conversations ON conversations.id = attempts.conversation_id
WHERE attempts.id = (
  SELECT latest.id
  FROM llm_generation_attempts latest
  WHERE latest.generation_id = attempts.generation_id
  ORDER BY latest.started_at DESC, latest.id DESC
  LIMIT 1
);

CREATE UNIQUE INDEX idx_llm_generations_idempotency
  ON llm_generations(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_llm_generations_conversation
  ON llm_generations(conversation_id, created_at, id);
CREATE INDEX idx_llm_generations_status
  ON llm_generations(project_id, status, updated_at, id);

CREATE TRIGGER conversations_scope_insert
BEFORE INSERT ON conversations
WHEN NEW.scope_type NOT IN ('project', 'scene', 'shot')
  OR (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid conversation scope');
END;

CREATE TRIGGER conversations_scope_update
BEFORE UPDATE OF scope_type, scope_id ON conversations
WHEN NEW.scope_type NOT IN ('project', 'scene', 'shot')
  OR (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid conversation scope');
END;

CREATE TRIGGER chat_messages_status_insert
BEFORE INSERT ON chat_messages
WHEN NEW.status NOT IN ('streaming', 'complete', 'failed')
  OR (NEW.role <> 'assistant' AND NEW.status <> 'complete')
  OR length(NEW.content) > 1000000
BEGIN
  SELECT RAISE(ABORT, 'invalid chat message state');
END;

CREATE TRIGGER chat_messages_status_update
BEFORE UPDATE OF role, status, content ON chat_messages
WHEN NEW.status NOT IN ('streaming', 'complete', 'failed')
  OR (NEW.role <> 'assistant' AND NEW.status <> 'complete')
  OR length(NEW.content) > 1000000
BEGIN
  SELECT RAISE(ABORT, 'invalid chat message state');
END;

CREATE TRIGGER llm_attempt_generation_insert
BEFORE INSERT ON llm_generation_attempts
WHEN NOT EXISTS (SELECT 1 FROM llm_generations WHERE id = NEW.generation_id)
BEGIN
  SELECT RAISE(ABORT, 'llm generation does not exist');
END;

CREATE TRIGGER llm_generation_status_update
BEFORE UPDATE OF status ON llm_generations
WHEN (OLD.status IN ('complete', 'failed', 'cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'prepared' AND NEW.status NOT IN ('prepared', 'streaming', 'complete', 'failed', 'cancelled'))
  OR (OLD.status = 'streaming' AND NEW.status NOT IN ('streaming', 'complete', 'failed', 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'invalid llm generation transition');
END;

CREATE TRIGGER llm_attempt_status_update
BEFORE UPDATE OF status ON llm_generation_attempts
WHEN (OLD.status IN ('complete', 'failed', 'cancelled', 'interrupted') AND NEW.status <> OLD.status)
  OR (OLD.status = 'prepared' AND NEW.status NOT IN ('prepared', 'streaming', 'complete', 'failed', 'cancelled', 'interrupted'))
  OR (OLD.status = 'streaming' AND NEW.status NOT IN ('streaming', 'complete', 'failed', 'cancelled', 'interrupted'))
BEGIN
  SELECT RAISE(ABORT, 'invalid llm attempt transition');
END;

CREATE TRIGGER chat_messages_terminal_update
BEFORE UPDATE OF status ON chat_messages
WHEN OLD.status IN ('complete', 'failed') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'invalid chat message transition');
END;
`;

export const MIGRATION_V12 = `
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_session_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  user_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('document-create', 'document-update')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'scene', 'shot')),
  scope_id TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  request_hash TEXT NOT NULL,
  context_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting_review', 'completed', 'failed', 'cancelled')
  ),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('published', 'rejected', 'discarded')),
  retry_of_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE TABLE agent_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  actor_type TEXT,
  actor_id TEXT,
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, sequence)
);

CREATE TABLE agent_task_generations (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, generation_id),
  UNIQUE(task_id, ordinal),
  UNIQUE(generation_id)
);

CREATE TABLE agent_tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  generation_id TEXT REFERENCES llm_generations(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES llm_generation_attempts(id) ON DELETE SET NULL,
  provider_call_id TEXT,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  arguments_hash TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  status TEXT NOT NULL CHECK (
    status IN ('received', 'validated', 'executing', 'succeeded', 'failed', 'cancelled')
  ),
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

ALTER TABLE documents ADD COLUMN published_version_id TEXT;
ALTER TABLE documents ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'archived'));
ALTER TABLE documents ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0
  CHECK (row_version >= 0);

ALTER TABLE document_versions ADD COLUMN state TEXT NOT NULL DEFAULT 'published'
  CHECK (
    state IN (
      'draft', 'in_review', 'published', 'changes_requested',
      'rejected', 'superseded', 'discarded'
    )
  );
ALTER TABLE document_versions ADD COLUMN base_version_id TEXT
  REFERENCES document_versions(id) ON DELETE SET NULL;
ALTER TABLE document_versions ADD COLUMN title_snapshot TEXT;
ALTER TABLE document_versions ADD COLUMN scope_type_snapshot TEXT;
ALTER TABLE document_versions ADD COLUMN scope_id_snapshot TEXT;
ALTER TABLE document_versions ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'
  CHECK (author_type IN ('user', 'agent', 'import', 'migration'));
ALTER TABLE document_versions ADD COLUMN author_id TEXT;
ALTER TABLE document_versions ADD COLUMN source_task_id TEXT
  REFERENCES agent_tasks(id) ON DELETE SET NULL;
ALTER TABLE document_versions ADD COLUMN source_message_id TEXT
  REFERENCES chat_messages(id) ON DELETE SET NULL;
ALTER TABLE document_versions ADD COLUMN context_snapshot_id TEXT
  REFERENCES context_snapshots(id) ON DELETE SET NULL;
ALTER TABLE document_versions ADD COLUMN content_hash TEXT;
ALTER TABLE document_versions ADD COLUMN state_updated_at TEXT;
ALTER TABLE document_versions ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0
  CHECK (state_version >= 0);

CREATE TABLE document_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'changes_requested', 'rejected', 'withdrawn')
  ),
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT,
  requested_at TEXT NOT NULL,
  decided_by_type TEXT,
  decided_by_id TEXT,
  decided_at TEXT,
  comment TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE(document_version_id)
);

CREATE TABLE document_publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  publication_no INTEGER NOT NULL CHECK (publication_no > 0),
  review_id TEXT REFERENCES document_reviews(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  published_by_type TEXT NOT NULL,
  published_by_id TEXT,
  published_at TEXT NOT NULL,
  UNIQUE(document_id, publication_no),
  UNIQUE(document_version_id)
);

CREATE TABLE agent_task_document_versions (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'regenerate')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, document_version_id, operation)
);

UPDATE documents
SET published_version_id = current_version_id
WHERE current_version_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM document_versions
    WHERE document_versions.id = documents.current_version_id
      AND document_versions.document_id = documents.id
  );

UPDATE document_versions
SET title_snapshot = (
      SELECT title FROM documents WHERE documents.id = document_versions.document_id
    ),
    scope_type_snapshot = (
      SELECT scope_type FROM documents WHERE documents.id = document_versions.document_id
    ),
    scope_id_snapshot = (
      SELECT scope_id FROM documents WHERE documents.id = document_versions.document_id
    ),
    state_updated_at = created_at
WHERE title_snapshot IS NULL;

INSERT INTO document_publications
  (id, project_id, document_id, document_version_id, publication_no,
   published_by_type, published_by_id, published_at)
SELECT 'migration-publication-' || documents.id,
       documents.project_id,
       documents.id,
       documents.published_version_id,
       1,
       'migration',
       NULL,
       COALESCE(document_versions.created_at, documents.updated_at)
FROM documents
INNER JOIN document_versions ON document_versions.id = documents.published_version_id
WHERE documents.published_version_id IS NOT NULL;

CREATE INDEX idx_agent_tasks_project_status
  ON agent_tasks(project_id, status, updated_at, id);
CREATE INDEX idx_agent_tasks_conversation
  ON agent_tasks(conversation_id, created_at, id);
CREATE UNIQUE INDEX idx_agent_tasks_idempotency
  ON agent_tasks(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_agent_task_events_task
  ON agent_task_events(task_id, sequence);
CREATE UNIQUE INDEX idx_agent_task_events_dedupe
  ON agent_task_events(task_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_agent_tool_calls_task
  ON agent_tool_calls(task_id, created_at, id);
CREATE UNIQUE INDEX idx_agent_tool_calls_provider
  ON agent_tool_calls(task_id, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_tool_calls_idempotency
  ON agent_tool_calls(task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_documents_published
  ON documents(project_id, published_version_id, lifecycle_status);
CREATE INDEX idx_document_versions_state
  ON document_versions(document_id, state, version, id);
CREATE INDEX idx_document_reviews_document
  ON document_reviews(document_id, requested_at, id);
CREATE INDEX idx_document_reviews_status
  ON document_reviews(project_id, status, requested_at, id);
CREATE INDEX idx_document_publications_document
  ON document_publications(document_id, publication_no DESC, id DESC);
CREATE INDEX idx_agent_task_document_versions_task
  ON agent_task_document_versions(task_id, created_at, document_version_id);

CREATE TRIGGER agent_tasks_scope_insert
BEFORE INSERT ON agent_tasks
WHEN (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent task scope');
END;

CREATE TRIGGER agent_tasks_scope_update
BEFORE UPDATE OF scope_type, scope_id ON agent_tasks
WHEN (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent task scope');
END;

CREATE TRIGGER agent_task_status_update
BEFORE UPDATE OF status ON agent_tasks
WHEN (OLD.status IN ('completed', 'failed', 'cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'running', 'failed', 'cancelled'))
  OR (OLD.status = 'running' AND NEW.status NOT IN (
    'running', 'waiting_review', 'completed', 'failed', 'cancelled'
  ))
  OR (OLD.status = 'waiting_review' AND NEW.status NOT IN (
    'waiting_review', 'running', 'completed', 'cancelled'
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid agent task transition');
END;

CREATE TRIGGER agent_task_event_project_match
BEFORE INSERT ON agent_task_events
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE agent_tasks.id = NEW.task_id
    AND agent_tasks.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'event project does not match task');
END;

CREATE TRIGGER agent_task_generation_project_match
BEFORE INSERT ON agent_task_generations
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks
  INNER JOIN llm_generations ON llm_generations.id = NEW.generation_id
  WHERE agent_tasks.id = NEW.task_id
    AND agent_tasks.project_id = llm_generations.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'generation project does not match task');
END;

CREATE TRIGGER agent_task_event_immutable_update
BEFORE UPDATE ON agent_task_events
BEGIN
  SELECT RAISE(ABORT, 'agent task events are immutable');
END;

CREATE TRIGGER agent_tool_call_status_update
BEFORE UPDATE OF status ON agent_tool_calls
WHEN (OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'received' AND NEW.status NOT IN (
    'received', 'validated', 'failed', 'cancelled'
  ))
  OR (OLD.status = 'validated' AND NEW.status NOT IN (
    'validated', 'executing', 'failed', 'cancelled'
  ))
  OR (OLD.status = 'executing' AND NEW.status NOT IN (
    'executing', 'succeeded', 'failed', 'cancelled'
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid agent tool call transition');
END;

CREATE TRIGGER agent_tool_call_generation_project_match
BEFORE INSERT ON agent_tool_calls
WHEN NEW.generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_tasks
    INNER JOIN llm_generations ON llm_generations.id = NEW.generation_id
    WHERE agent_tasks.id = NEW.task_id
      AND agent_tasks.project_id = llm_generations.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'tool call generation project does not match task');
END;

CREATE TRIGGER agent_tool_call_attempt_match
BEFORE INSERT ON agent_tool_calls
WHEN NEW.attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM llm_generation_attempts
    WHERE llm_generation_attempts.id = NEW.attempt_id
      AND (NEW.generation_id IS NULL OR llm_generation_attempts.generation_id = NEW.generation_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'tool call attempt does not match generation');
END;

CREATE TRIGGER document_version_state_update
BEFORE UPDATE OF state ON document_versions
WHEN (OLD.state IN ('published', 'rejected', 'superseded', 'discarded') AND NEW.state <> OLD.state)
  OR (OLD.state = 'draft' AND NEW.state NOT IN (
    'draft', 'in_review', 'superseded', 'discarded'
  ))
  OR (OLD.state = 'in_review' AND NEW.state NOT IN (
    'in_review', 'published', 'changes_requested', 'rejected', 'superseded', 'discarded'
  ))
  OR (OLD.state = 'changes_requested' AND NEW.state NOT IN (
    'changes_requested', 'draft', 'superseded', 'discarded'
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid document version transition');
END;

CREATE TRIGGER document_review_status_update
BEFORE UPDATE OF status ON document_reviews
WHEN (OLD.status IN ('approved', 'changes_requested', 'rejected', 'withdrawn')
      AND NEW.status <> OLD.status)
  OR (OLD.status = 'pending' AND NEW.status NOT IN (
    'pending', 'approved', 'changes_requested', 'rejected', 'withdrawn'
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid document review transition');
END;

CREATE TRIGGER document_publication_immutable_update
BEFORE UPDATE ON document_publications
BEGIN
  SELECT RAISE(ABORT, 'document publications are immutable');
END;

CREATE TRIGGER documents_published_version_insert
BEFORE INSERT ON documents
WHEN NEW.published_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM document_versions
    WHERE document_versions.id = NEW.published_version_id
      AND document_versions.document_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'published version does not belong to document');
END;

CREATE TRIGGER documents_published_version_update
BEFORE UPDATE OF published_version_id ON documents
WHEN NEW.published_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM document_versions
    WHERE document_versions.id = NEW.published_version_id
      AND document_versions.document_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'published version does not belong to document');
END;

CREATE TRIGGER document_review_version_match
BEFORE INSERT ON document_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM documents
  INNER JOIN document_versions ON document_versions.id = NEW.document_version_id
  WHERE documents.id = NEW.document_id
    AND documents.project_id = NEW.project_id
    AND document_versions.document_id = NEW.document_id
)
BEGIN
  SELECT RAISE(ABORT, 'review version does not belong to document');
END;

CREATE TRIGGER document_publication_version_match
BEFORE INSERT ON document_publications
WHEN NOT EXISTS (
  SELECT 1 FROM documents
  INNER JOIN document_versions ON document_versions.id = NEW.document_version_id
  WHERE documents.id = NEW.document_id
    AND documents.project_id = NEW.project_id
    AND document_versions.document_id = NEW.document_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication version does not belong to document');
END;

CREATE TRIGGER agent_task_document_version_match
BEFORE INSERT ON agent_task_document_versions
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks
  INNER JOIN documents ON documents.project_id = agent_tasks.project_id
  INNER JOIN document_versions ON document_versions.id = NEW.document_version_id
  WHERE agent_tasks.id = NEW.task_id
    AND documents.id = NEW.document_id
    AND document_versions.document_id = NEW.document_id
)
BEGIN
  SELECT RAISE(ABORT, 'task document version does not belong to document');
END;
`;

export const MIGRATION_V13 = `
CREATE TABLE document_audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  action TEXT NOT NULL CHECK (
    action IN (
      'draft_saved', 'draft_restored', 'review_submitted',
      'review_changes_requested', 'review_rejected', 'published'
    )
  ),
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('user', 'agent', 'system', 'import', 'migration')
  ),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 256),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  review_id TEXT REFERENCES document_reviews(id) ON DELETE SET NULL,
  publication_id TEXT REFERENCES document_publications(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      json_valid(metadata_json)
      AND json_type(metadata_json) = 'object'
      AND length(metadata_json) <= 4096
    ),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, sequence)
);

CREATE INDEX idx_document_audit_project
  ON document_audit_events(project_id, sequence DESC, id DESC);
CREATE INDEX idx_document_audit_document
  ON document_audit_events(document_id, sequence DESC, id DESC);
CREATE INDEX idx_document_audit_action
  ON document_audit_events(project_id, action, sequence DESC, id DESC);

CREATE TRIGGER document_audit_project_match
BEFORE INSERT ON document_audit_events
WHEN NOT EXISTS (
  SELECT 1 FROM documents
  WHERE documents.id = NEW.document_id
    AND documents.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'document audit project does not match document');
END;

CREATE TRIGGER document_audit_version_match
BEFORE INSERT ON document_audit_events
WHEN NOT EXISTS (
  SELECT 1 FROM document_versions
  WHERE document_versions.id = NEW.document_version_id
    AND document_versions.document_id = NEW.document_id
)
  OR (NEW.source_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_versions
    WHERE document_versions.id = NEW.source_version_id
      AND document_versions.document_id = NEW.document_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'document audit version does not match document');
END;

CREATE TRIGGER document_audit_review_match
BEFORE INSERT ON document_audit_events
WHEN NEW.review_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_reviews
  WHERE document_reviews.id = NEW.review_id
    AND document_reviews.project_id = NEW.project_id
    AND document_reviews.document_id = NEW.document_id
    AND document_reviews.document_version_id = NEW.document_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'document audit review does not match document');
END;

CREATE TRIGGER document_audit_publication_match
BEFORE INSERT ON document_audit_events
WHEN NEW.publication_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_publications
  WHERE document_publications.id = NEW.publication_id
    AND document_publications.project_id = NEW.project_id
    AND document_publications.document_id = NEW.document_id
    AND document_publications.document_version_id = NEW.document_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'document audit publication does not match document');
END;

CREATE TRIGGER document_audit_task_match
BEFORE INSERT ON document_audit_events
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE agent_tasks.id = NEW.task_id
    AND agent_tasks.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'document audit task does not match project');
END;

CREATE TRIGGER document_audit_immutable_update
BEFORE UPDATE ON document_audit_events
BEGIN
  SELECT RAISE(ABORT, 'document audit events are immutable');
END;

CREATE TRIGGER document_audit_immutable_delete
BEFORE DELETE ON document_audit_events
BEGIN
  SELECT RAISE(ABORT, 'document audit events are immutable');
END;
`;

export const MIGRATION_V15 = `
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
`;

export const MIGRATION_V17 = `
CREATE TABLE agent_research_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  provider_step_id TEXT NOT NULL REFERENCES llm_provider_steps(id) ON DELETE RESTRICT,
  tool_call_id TEXT NOT NULL REFERENCES agent_tool_calls(id) ON DELETE RESTRICT,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 120),
  source_handle_hash TEXT NOT NULL,
  canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 4096),
  url_hash TEXT NOT NULL,
  site TEXT NOT NULL CHECK (length(site) BETWEEN 1 AND 255),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  retrieved_at TEXT NOT NULL,
  content_hash TEXT,
  character_count INTEGER CHECK (character_count IS NULL OR character_count >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  cache_relative_path TEXT CHECK (
    cache_relative_path IS NULL
    OR (
      cache_relative_path LIKE 'cache/research/%'
      AND cache_relative_path NOT LIKE '%..%'
      AND length(cache_relative_path) <= 512
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('searched', 'fetched', 'excluded', 'failed')),
  citation_label TEXT CHECK (citation_label IS NULL OR length(citation_label) <= 80),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 120),
  created_at TEXT NOT NULL,
  UNIQUE(tool_call_id, canonical_url),
  FOREIGN KEY(attempt_id, generation_id)
    REFERENCES llm_generation_attempts(id, generation_id) ON DELETE RESTRICT,
  FOREIGN KEY(provider_step_id, project_id)
    REFERENCES llm_provider_steps(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX idx_agent_research_sources_task
  ON agent_research_sources(task_id, created_at, id);
CREATE INDEX idx_agent_research_sources_attempt
  ON agent_research_sources(attempt_id, provider_step_id, id);

CREATE TRIGGER agent_research_source_match
BEFORE INSERT ON agent_research_sources
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tool_calls calls
  WHERE calls.id = NEW.tool_call_id
    AND calls.project_id = NEW.project_id
    AND calls.task_id = NEW.task_id
    AND calls.generation_id = NEW.generation_id
    AND calls.attempt_id = NEW.attempt_id
    AND calls.provider_step_id = NEW.provider_step_id
    AND calls.tool_name IN ('research.search', 'research.fetch')
)
BEGIN
  SELECT RAISE(ABORT, 'research source does not match its tool call');
END;
`;

export const MIGRATION_V19 = `
ALTER TABLE agent_research_sources
  ADD COLUMN adoption_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (adoption_status IN ('unreviewed', 'adopted', 'excluded'));
ALTER TABLE agent_research_sources
  ADD COLUMN adoption_reason TEXT
    CHECK (adoption_reason IS NULL OR length(adoption_reason) <= 500);

CREATE TABLE agent_research_cache (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  cache_relative_path TEXT NOT NULL CHECK (
    cache_relative_path LIKE 'cache/research/%'
    AND cache_relative_path NOT LIKE '%..%'
    AND length(cache_relative_path) <= 512
  ),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'missing', 'expired')),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 120),
  PRIMARY KEY (project_id, content_hash),
  UNIQUE (project_id, cache_relative_path)
);

CREATE INDEX idx_agent_research_cache_expiry
  ON agent_research_cache(project_id, expires_at, last_accessed_at, content_hash);

CREATE TABLE document_version_research_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES agent_research_sources(id) ON DELETE RESTRICT,
  citation_label TEXT NOT NULL CHECK (length(citation_label) BETWEEN 1 AND 80),
  citation_reason TEXT CHECK (citation_reason IS NULL OR length(citation_reason) <= 500),
  created_at TEXT NOT NULL,
  UNIQUE(document_version_id, source_id),
  UNIQUE(document_version_id, citation_label)
);

CREATE INDEX idx_document_version_research_sources_project
  ON document_version_research_sources(project_id, document_version_id, citation_label);
CREATE INDEX idx_document_version_research_sources_source
  ON document_version_research_sources(source_id, document_version_id);

CREATE TRIGGER agent_research_cache_project_match
BEFORE INSERT ON agent_research_cache
WHEN NOT EXISTS (
  SELECT 1 FROM projects WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'research cache does not match a project');
END;

CREATE TRIGGER document_version_research_source_match
BEFORE INSERT ON document_version_research_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM document_versions versions
  INNER JOIN documents documents ON documents.id = versions.document_id
  WHERE versions.id = NEW.document_version_id
    AND versions.document_id = NEW.document_id
    AND documents.project_id = NEW.project_id
)
  OR NOT EXISTS (
    SELECT 1 FROM agent_research_sources sources
    WHERE sources.id = NEW.source_id
      AND sources.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'research citation does not match project, document, or source');
END;
`;

export const MIGRATION_V20 = `
CREATE TABLE novel_profiles (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  language TEXT NOT NULL DEFAULT 'zh-CN' CHECK (length(language) BETWEEN 2 AND 35),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE novel_volumes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, position)
);

CREATE TABLE novel_chapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  volume_id TEXT REFERENCES novel_volumes(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  display_label TEXT NOT NULL CHECK (length(trim(display_label)) BETWEEN 1 AND 80),
  lifecycle_status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (lifecycle_status IN ('reserved', 'active', 'archived')),
  archive_reason TEXT CHECK (archive_reason IN ('user_archive', 'generation_placeholder')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (lifecycle_status = 'archived' AND archive_reason IS NOT NULL)
    OR (lifecycle_status IN ('reserved', 'active') AND archive_reason IS NULL)
  )
);

CREATE UNIQUE INDEX uq_novel_chapter_position_unscoped
  ON novel_chapters(project_id, position)
  WHERE volume_id IS NULL;
CREATE UNIQUE INDEX uq_novel_chapter_position_scoped
  ON novel_chapters(project_id, volume_id, position)
  WHERE volume_id IS NOT NULL;

CREATE TABLE document_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  volume_id TEXT REFERENCES novel_volumes(id) ON DELETE RESTRICT,
  chapter_id TEXT REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  shot_id TEXT REFERENCES shots(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN (
    'work-outline', 'volume-outline', 'character-bible', 'world-bible', 'timeline',
    'style-guide', 'adaptation-proposal', 'screenplay', 'scene-outline', 'shot-plan',
    'research', 'note'
  )),
  domain_scope TEXT NOT NULL CHECK (domain_scope IN ('shared', 'novel', 'short-drama')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'needs_review')),
  migration_issue_code TEXT CHECK (migration_issue_code IS NULL OR length(migration_issue_code) <= 120),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (volume_id IS NOT NULL) + (chapter_id IS NOT NULL) + (scene_id IS NOT NULL) + (shot_id IS NOT NULL)
    <= 1
  ),
  CHECK (role != 'volume-outline' OR volume_id IS NOT NULL),
  CHECK (role != 'scene-outline' OR scene_id IS NOT NULL),
  CHECK (role != 'shot-plan' OR shot_id IS NOT NULL),
  CHECK (domain_scope != 'novel' OR scene_id IS NULL),
  CHECK (domain_scope != 'novel' OR shot_id IS NULL),
  CHECK (domain_scope != 'short-drama' OR volume_id IS NULL),
  CHECK (domain_scope != 'short-drama' OR chapter_id IS NULL)
);

CREATE INDEX idx_novel_volumes_project ON novel_volumes(project_id, position, id);
CREATE INDEX idx_novel_chapters_project ON novel_chapters(project_id, volume_id, position, id);
CREATE INDEX idx_document_bindings_project ON document_bindings(project_id, status, domain_scope, role, id);

CREATE TABLE novel_chapter_publication_snapshots (
  publication_id TEXT PRIMARY KEY REFERENCES document_publications(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  work_title_snapshot TEXT NOT NULL,
  volume_title_snapshot TEXT,
  position_snapshot INTEGER NOT NULL CHECK (position_snapshot >= 0),
  display_label_snapshot TEXT NOT NULL CHECK (length(trim(display_label_snapshot)) BETWEEN 1 AND 80),
  chapter_title_snapshot TEXT NOT NULL CHECK (length(trim(chapter_title_snapshot)) BETWEEN 1 AND 200),
  structure_hash TEXT NOT NULL CHECK (length(structure_hash) = 64),
  snapshot_origin TEXT NOT NULL CHECK (snapshot_origin IN ('native', 'migrated-current')),
  created_at TEXT NOT NULL,
  UNIQUE(chapter_id, document_version_id)
);

CREATE INDEX idx_novel_publication_snapshots_chapter
  ON novel_chapter_publication_snapshots(chapter_id, document_version_id);

CREATE TRIGGER novel_chapter_project_match_insert
BEFORE INSERT ON novel_chapters
WHEN NOT EXISTS (
  SELECT 1 FROM documents WHERE id = NEW.document_id AND project_id = NEW.project_id
)
OR (NEW.volume_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_volumes WHERE id = NEW.volume_id AND project_id = NEW.project_id
))
BEGIN
  SELECT RAISE(ABORT, 'novel chapter target does not match project');
END;

CREATE TRIGGER novel_chapter_project_match_update
BEFORE UPDATE OF project_id, volume_id, document_id ON novel_chapters
WHEN NOT EXISTS (
  SELECT 1 FROM documents WHERE id = NEW.document_id AND project_id = NEW.project_id
)
OR (NEW.volume_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_volumes WHERE id = NEW.volume_id AND project_id = NEW.project_id
))
BEGIN
  SELECT RAISE(ABORT, 'novel chapter target does not match project');
END;

CREATE TRIGGER document_binding_project_match_insert
BEFORE INSERT ON document_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM documents WHERE id = NEW.document_id AND project_id = NEW.project_id
)
OR (NEW.volume_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_volumes WHERE id = NEW.volume_id AND project_id = NEW.project_id
))
OR (NEW.chapter_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_chapters WHERE id = NEW.chapter_id AND project_id = NEW.project_id
))
OR (NEW.scene_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scenes WHERE id = NEW.scene_id AND project_id = NEW.project_id
))
OR (NEW.shot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id
    WHERE shots.id = NEW.shot_id AND scenes.project_id = NEW.project_id
))
OR EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = NEW.document_id)
BEGIN
  SELECT RAISE(ABORT, 'document binding target does not match project');
END;

CREATE TRIGGER document_binding_project_match_update
BEFORE UPDATE OF project_id, document_id, volume_id, chapter_id, scene_id, shot_id ON document_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM documents WHERE id = NEW.document_id AND project_id = NEW.project_id
)
OR (NEW.volume_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_volumes WHERE id = NEW.volume_id AND project_id = NEW.project_id
))
OR (NEW.chapter_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_chapters WHERE id = NEW.chapter_id AND project_id = NEW.project_id
))
OR (NEW.scene_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scenes WHERE id = NEW.scene_id AND project_id = NEW.project_id
))
OR (NEW.shot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id
    WHERE shots.id = NEW.shot_id AND scenes.project_id = NEW.project_id
))
OR EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = NEW.document_id)
BEGIN
  SELECT RAISE(ABORT, 'document binding target does not match project');
END;

INSERT INTO document_bindings (
  id, project_id, document_id, volume_id, chapter_id, scene_id, shot_id,
  role, domain_scope, status, migration_issue_code, row_version, created_at, updated_at
)
SELECT
  'migration-binding-' || documents.id,
  documents.project_id,
  documents.id,
  NULL,
  NULL,
  CASE WHEN documents.scope_type = 'scene' AND scenes.id IS NOT NULL THEN scenes.id ELSE NULL END,
  CASE WHEN documents.scope_type = 'shot' AND shots.id IS NOT NULL THEN shots.id ELSE NULL END,
  CASE
    WHEN documents.scope_type = 'scene' AND scenes.id IS NOT NULL THEN 'scene-outline'
    WHEN documents.scope_type = 'shot' AND shots.id IS NOT NULL THEN 'shot-plan'
    WHEN documents.kind = 'character' THEN 'character-bible'
    WHEN documents.kind = 'outline' OR documents.kind = 'plan' THEN 'work-outline'
    ELSE 'note'
  END,
  CASE WHEN documents.scope_type IN ('scene', 'shot') AND (scenes.id IS NOT NULL OR shots.id IS NOT NULL)
    THEN 'short-drama' ELSE 'shared' END,
  CASE
    WHEN documents.scope_type = 'project' THEN 'active'
    WHEN documents.scope_type = 'scene' AND scenes.id IS NOT NULL THEN 'active'
    WHEN documents.scope_type = 'shot' AND shots.id IS NOT NULL THEN 'active'
    ELSE 'needs_review'
  END,
  CASE
    WHEN documents.scope_type = 'project' OR (documents.scope_type = 'scene' AND scenes.id IS NOT NULL)
      OR (documents.scope_type = 'shot' AND shots.id IS NOT NULL) THEN NULL
    ELSE 'UNSUPPORTED_OR_MISSING_SCOPE'
  END,
  0,
  documents.created_at,
  documents.updated_at
FROM documents
LEFT JOIN scenes ON scenes.id = documents.scope_id AND scenes.project_id = documents.project_id
LEFT JOIN shots ON shots.id = documents.scope_id
  AND EXISTS (
    SELECT 1 FROM scenes AS shot_scenes
    WHERE shot_scenes.id = shots.scene_id AND shot_scenes.project_id = documents.project_id
  )
WHERE NOT EXISTS (SELECT 1 FROM document_bindings WHERE document_id = documents.id);

CREATE TRIGGER novel_chapter_publication_snapshot_insert
AFTER INSERT ON document_publications
WHEN EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = NEW.document_id)
BEGIN
  INSERT INTO novel_chapter_publication_snapshots (
    publication_id, project_id, chapter_id, document_version_id,
    work_title_snapshot, volume_title_snapshot, position_snapshot, display_label_snapshot,
    chapter_title_snapshot, structure_hash, snapshot_origin, created_at
  )
  SELECT
    NEW.id, chapters.project_id, chapters.id, NEW.document_version_id,
    projects.name, volumes.title, chapters.position, chapters.display_label,
    versions.title_snapshot,
    sha256(
      projects.name || char(31) || coalesce(volumes.title, '') || char(31) ||
      chapters.position || char(31) || chapters.display_label || char(31) || versions.title_snapshot
    ),
    'native', NEW.published_at
  FROM novel_chapters AS chapters
  INNER JOIN projects ON projects.id = chapters.project_id
  INNER JOIN document_versions AS versions ON versions.id = NEW.document_version_id
  LEFT JOIN novel_volumes AS volumes ON volumes.id = chapters.volume_id
  WHERE chapters.document_id = NEW.document_id
    AND NEW.project_id = chapters.project_id
    AND versions.document_id = chapters.document_id;

  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'novel chapter publication snapshot could not be created')
  END;
END;

CREATE TRIGGER novel_chapter_published_version_requires_publication
BEFORE UPDATE OF published_version_id ON documents
WHEN NEW.published_version_id IS NOT OLD.published_version_id
  AND EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = NEW.id)
  AND NOT EXISTS (
    SELECT 1 FROM document_publications
    WHERE document_id = NEW.id AND document_version_id = NEW.published_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'novel chapter publication requires a publication snapshot');
END;
`;

/** P3: persist novel-writing intent resolution before a Provider generation starts. */
export const MIGRATION_V21 = `
CREATE TABLE agent_pending_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  requested_action TEXT CHECK (requested_action IN ('create_chapter', 'continue_chapter', 'rewrite_chapter')),
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'cancelled', 'expired')),
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_pending_intents_project
  ON agent_pending_intents(project_id, status, expires_at, created_at);
CREATE INDEX idx_agent_pending_intents_conversation
  ON agent_pending_intents(conversation_id, status, created_at);

CREATE TABLE agent_task_targets (
  task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('novel-chapter', 'novel-reference')),
  chapter_id TEXT REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create_chapter', 'continue_chapter', 'rewrite_chapter', 'update_reference')),
  created_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (created_placeholder IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (
    (target_kind = 'novel-chapter' AND chapter_id IS NOT NULL
      AND action IN ('create_chapter', 'continue_chapter', 'rewrite_chapter'))
    OR
    (target_kind = 'novel-reference' AND chapter_id IS NULL AND action = 'update_reference')
  )
);

CREATE INDEX idx_agent_task_targets_project_document
  ON agent_task_targets(project_id, document_id, task_id);

CREATE TABLE novel_chapter_task_locks (
  chapter_id TEXT PRIMARY KEY REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  acquired_at TEXT NOT NULL
);

CREATE INDEX idx_novel_chapter_task_locks_project
  ON novel_chapter_task_locks(project_id, acquired_at, task_id);

ALTER TABLE agent_tool_calls ADD COLUMN target_chapter_id TEXT
  REFERENCES novel_chapters(id) ON DELETE RESTRICT;
ALTER TABLE agent_tool_calls ADD COLUMN target_document_id TEXT
  REFERENCES documents(id) ON DELETE RESTRICT;

CREATE TRIGGER agent_pending_intent_project_match
BEFORE INSERT ON agent_pending_intents
WHEN NOT EXISTS (
  SELECT 1 FROM conversations
  WHERE conversations.id = NEW.conversation_id
    AND conversations.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'pending intent conversation does not match project');
END;

CREATE TRIGGER agent_task_target_project_match
BEFORE INSERT ON agent_task_targets
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE agent_tasks.id = NEW.task_id AND agent_tasks.project_id = NEW.project_id
)
OR NOT EXISTS (
  SELECT 1 FROM documents
  WHERE documents.id = NEW.document_id AND documents.project_id = NEW.project_id
)
OR (NEW.chapter_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM novel_chapters
  WHERE novel_chapters.id = NEW.chapter_id
    AND novel_chapters.project_id = NEW.project_id
    AND novel_chapters.document_id = NEW.document_id
))
OR (NEW.target_kind = 'novel-reference' AND EXISTS (
  SELECT 1 FROM novel_chapters WHERE novel_chapters.document_id = NEW.document_id
))
BEGIN
  SELECT RAISE(ABORT, 'agent task target does not match project domain target');
END;

CREATE TRIGGER novel_chapter_task_lock_match
BEFORE INSERT ON novel_chapter_task_locks
WHEN NOT EXISTS (
  SELECT 1 FROM novel_chapters
  WHERE novel_chapters.id = NEW.chapter_id AND novel_chapters.project_id = NEW.project_id
)
OR NOT EXISTS (
  SELECT 1 FROM agent_task_targets
  WHERE agent_task_targets.task_id = NEW.task_id
    AND agent_task_targets.project_id = NEW.project_id
    AND agent_task_targets.chapter_id = NEW.chapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'chapter task lock does not match task target');
END;

CREATE TRIGGER agent_tool_call_novel_target_match
BEFORE INSERT ON agent_tool_calls
WHEN NEW.tool_name = 'novel.chapter.submit_draft'
  AND NEW.target_chapter_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM agent_task_targets WHERE task_id = NEW.task_id)
  AND NOT EXISTS (
    SELECT 1 FROM agent_task_targets
    WHERE agent_task_targets.task_id = NEW.task_id
      AND agent_task_targets.target_kind = 'novel-chapter'
      AND agent_task_targets.chapter_id = NEW.target_chapter_id
      AND agent_task_targets.document_id = NEW.target_document_id
  )
BEGIN
  SELECT RAISE(ABORT, 'novel chapter tool target does not match task target');
END;

CREATE TRIGGER agent_task_terminal_release_chapter_lock
AFTER UPDATE OF status ON agent_tasks
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
BEGIN
  DELETE FROM novel_chapter_task_locks WHERE task_id = NEW.id;
END;
`;

/** P5: bounded, recoverable text fragments from interrupted novel-writing tasks. */
export const MIGRATION_V22 = `
CREATE TABLE agent_partial_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  provider_step_id TEXT NOT NULL,
  tool_call_id TEXT,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('chapter', 'reference-create', 'reference-update')),
  chapter_id TEXT REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  content_text TEXT NOT NULL CHECK (length(CAST(content_text AS BLOB)) BETWEEN 1 AND 1048576),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  content_length INTEGER NOT NULL CHECK (content_length BETWEEN 1 AND 1048576),
  format TEXT NOT NULL CHECK (format = 'validated-text'),
  status TEXT NOT NULL CHECK (status IN ('recoverable', 'recovered', 'discarded', 'expired')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  recovered_document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  recovered_document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  recovered_by_type TEXT CHECK (recovered_by_type IS NULL OR recovered_by_type = 'user'),
  recovered_by_id TEXT,
  recovered_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_step_id, source_ordinal),
  FOREIGN KEY(provider_step_id, project_id)
    REFERENCES llm_provider_steps(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id, project_id)
    REFERENCES agent_tool_calls(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, generation_id)
    REFERENCES llm_generation_attempts(id, generation_id) ON DELETE RESTRICT,
  CHECK (
    (target_kind = 'chapter' AND chapter_id IS NOT NULL AND document_id IS NOT NULL)
    OR (target_kind = 'reference-update' AND chapter_id IS NULL AND document_id IS NOT NULL)
    OR (target_kind = 'reference-create' AND chapter_id IS NULL AND document_id IS NULL)
  ),
  CHECK (
    (status = 'recovered' AND recovered_document_id IS NOT NULL AND recovered_document_version_id IS NOT NULL
      AND recovered_by_type = 'user' AND recovered_by_id IS NOT NULL AND recovered_at IS NOT NULL)
    OR (status != 'recovered' AND recovered_document_id IS NULL AND recovered_document_version_id IS NULL
      AND recovered_by_type IS NULL AND recovered_by_id IS NULL AND recovered_at IS NULL)
  )
);

CREATE UNIQUE INDEX uq_agent_partial_artifacts_tool_call
  ON agent_partial_artifacts(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX idx_agent_partial_artifacts_project_status
  ON agent_partial_artifacts(project_id, status, expires_at, created_at);

CREATE TRIGGER agent_partial_artifact_match
BEFORE INSERT ON agent_partial_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks tasks
  INNER JOIN agent_task_generations links ON links.task_id = tasks.id
  INNER JOIN llm_provider_steps steps ON steps.id = NEW.provider_step_id
  WHERE tasks.id = NEW.task_id AND tasks.project_id = NEW.project_id
    AND links.generation_id = NEW.generation_id
    AND steps.project_id = NEW.project_id AND steps.generation_id = NEW.generation_id
    AND steps.attempt_id = NEW.attempt_id
)
OR (NEW.tool_call_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_tool_calls calls
  WHERE calls.id = NEW.tool_call_id AND calls.project_id = NEW.project_id
    AND calls.task_id = NEW.task_id AND calls.generation_id = NEW.generation_id
    AND calls.attempt_id = NEW.attempt_id AND calls.provider_step_id = NEW.provider_step_id
))
OR (NEW.target_kind = 'chapter' AND NOT EXISTS (
  SELECT 1 FROM novel_chapters chapters
  WHERE chapters.id = NEW.chapter_id AND chapters.project_id = NEW.project_id
    AND chapters.document_id = NEW.document_id
))
OR (NEW.target_kind = 'reference-update' AND NOT EXISTS (
  SELECT 1 FROM documents WHERE id = NEW.document_id AND project_id = NEW.project_id
))
OR NEW.content_hash != sha256(NEW.content_text)
OR NEW.content_length != length(CAST(NEW.content_text AS BLOB))
BEGIN
  SELECT RAISE(ABORT, 'partial artifact does not match task, target, or content');
END;
`;

/** P8: immutable Markdown export jobs and frozen chapter items. */
export const MIGRATION_V23 = `
CREATE TABLE markdown_export_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  export_type TEXT NOT NULL CHECK (export_type IN ('chapter', 'selection', 'volume', 'work')),
  export_format TEXT NOT NULL CHECK (export_format IN ('files', 'merged')),
  destination_root TEXT NOT NULL,
  package_relative_path TEXT NOT NULL UNIQUE,
  staging_relative_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'writing', 'verifying', 'succeeded', 'failed', 'cancelled')),
  requested_by_type TEXT NOT NULL CHECK (requested_by_type = 'user'),
  requested_by_id TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  manifest_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
  ,UNIQUE(id, project_id)
);

CREATE TABLE markdown_export_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES markdown_export_jobs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_state TEXT NOT NULL CHECK (source_state IN ('published', 'draft')),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  work_title_snapshot TEXT NOT NULL,
  volume_title_snapshot TEXT,
  position_snapshot INTEGER NOT NULL CHECK (position_snapshot >= 0),
  display_label_snapshot TEXT NOT NULL,
  chapter_title_snapshot TEXT NOT NULL,
  publication_no INTEGER,
  document_version_no INTEGER NOT NULL CHECK (document_version_no >= 1),
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'writing', 'verifying', 'succeeded', 'failed')),
  byte_size INTEGER,
  output_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, ordinal),
  UNIQUE(job_id, chapter_id),
  FOREIGN KEY(job_id, project_id) REFERENCES markdown_export_jobs(id, project_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_markdown_export_jobs_project_package
  ON markdown_export_jobs(project_id, package_relative_path);
CREATE INDEX idx_markdown_export_items_job ON markdown_export_items(job_id, ordinal);

CREATE TRIGGER markdown_export_item_project_match
BEFORE INSERT ON markdown_export_items
WHEN NOT EXISTS (
  SELECT 1 FROM markdown_export_jobs jobs
  WHERE jobs.id = NEW.job_id AND jobs.project_id = NEW.project_id
)
OR NOT EXISTS (
  SELECT 1 FROM novel_chapters chapters
  WHERE chapters.id = NEW.chapter_id AND chapters.project_id = NEW.project_id
    AND chapters.document_id = NEW.document_id
)
OR NOT EXISTS (
  SELECT 1 FROM documents documents
  WHERE documents.id = NEW.document_id AND documents.project_id = NEW.project_id
)
OR NOT EXISTS (
  SELECT 1 FROM document_versions versions
  WHERE versions.id = NEW.document_version_id AND versions.document_id = NEW.document_id
    AND versions.version = NEW.document_version_no
)
OR (NEW.source_state = 'published' AND (NEW.publication_no IS NULL OR NOT EXISTS (
  SELECT 1 FROM novel_chapter_publication_snapshots snapshots
  INNER JOIN document_publications publications ON publications.id = snapshots.publication_id
  WHERE snapshots.chapter_id = NEW.chapter_id AND snapshots.document_version_id = NEW.document_version_id
    AND publications.publication_no = NEW.publication_no
)))
BEGIN
  SELECT RAISE(ABORT, 'markdown export item source mismatch');
END;

CREATE TRIGGER markdown_export_item_immutable
BEFORE UPDATE OF job_id, project_id, ordinal, chapter_id, document_id, document_version_id,
  source_state, source_content_hash, work_title_snapshot, volume_title_snapshot,
  position_snapshot, display_label_snapshot, chapter_title_snapshot, publication_no,
  document_version_no, relative_path ON markdown_export_items
BEGIN
  SELECT RAISE(ABORT, 'markdown export item source is immutable');
END;
`;

/** P8: immutable provenance for a short-drama adaptation proposal. */
export const MIGRATION_V24 = `
CREATE TABLE novel_adaptation_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  proposal_document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  proposal_document_version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE RESTRICT,
  target_change_set_id TEXT,
  adaptation_task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_chapter_id, source_document_version_id, proposal_document_version_id)
);

CREATE INDEX idx_novel_adaptation_proposals_source
  ON novel_adaptation_proposals(project_id, source_chapter_id, source_document_version_id);

CREATE TRIGGER novel_adaptation_proposal_project_match
BEFORE INSERT ON novel_adaptation_proposals
WHEN NOT EXISTS (
  SELECT 1 FROM novel_chapters chapters
  WHERE chapters.id = NEW.source_chapter_id AND chapters.project_id = NEW.project_id
    AND chapters.document_id = (
      SELECT document_id FROM document_versions WHERE id = NEW.source_document_version_id
    )
)
OR NOT EXISTS (
  SELECT 1 FROM document_versions versions
  INNER JOIN documents documents ON documents.id = versions.document_id
  WHERE versions.id = NEW.proposal_document_version_id
    AND documents.id = NEW.proposal_document_id AND documents.project_id = NEW.project_id
)
OR NOT EXISTS (
  SELECT 1 FROM agent_tasks tasks
  WHERE tasks.id = NEW.adaptation_task_id AND tasks.project_id = NEW.project_id
)
OR NEW.source_content_hash != (
  SELECT sha256(content_markdown) FROM document_versions WHERE id = NEW.source_document_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'novel adaptation proposal does not match project or source');
END;
`;

/** P7: derived summaries for published novel chapters. */
export const MIGRATION_V25 = `
CREATE TABLE novel_chapter_summaries (
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  summary_version INTEGER NOT NULL CHECK (summary_version = 1),
  summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) BETWEEN 1 AND 12000),
  generator TEXT NOT NULL CHECK (generator = 'deterministic-extractive-v1'),
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chapter_id, source_document_version_id, summary_version)
);

CREATE INDEX idx_novel_chapter_summaries_current
  ON novel_chapter_summaries(project_id, chapter_id, status, source_document_version_id);

CREATE TRIGGER novel_chapter_summary_project_match
BEFORE INSERT ON novel_chapter_summaries
WHEN NOT EXISTS (
  SELECT 1 FROM novel_chapters chapters
  INNER JOIN document_versions versions ON versions.document_id = chapters.document_id
  WHERE chapters.id = NEW.chapter_id AND chapters.project_id = NEW.project_id
    AND versions.id = NEW.source_document_version_id
    AND sha256(versions.content_markdown) = NEW.source_content_hash
)
BEGIN
  SELECT RAISE(ABORT, 'novel chapter summary does not match source version');
END;

CREATE TRIGGER novel_chapter_summary_stale_on_publication
AFTER INSERT ON document_publications
WHEN EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = NEW.document_id)
BEGIN
  UPDATE novel_chapter_summaries
  SET status = 'stale', updated_at = NEW.published_at
  WHERE chapter_id = (SELECT id FROM novel_chapters WHERE document_id = NEW.document_id)
    AND source_document_version_id != NEW.document_version_id
    AND status = 'current';
END;
`;

/** Agent P7: optimistic concurrency for scene and shot change-set targets. */
export const MIGRATION_V26 = `
ALTER TABLE scenes ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0);
ALTER TABLE shots ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0);

CREATE TABLE agent_change_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'partially_applied', 'applied', 'rejected', 'conflicted')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(id, project_id)
);

CREATE TABLE agent_change_set_items (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES agent_change_sets(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('scene', 'shot')),
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  target_id TEXT,
  parent_scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  parent_item_id TEXT REFERENCES agent_change_set_items(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  shot_status TEXT,
  expected_row_version INTEGER CHECK (expected_row_version IS NULL OR expected_row_version >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'conflicted')),
  applied_entity_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(change_set_id, ordinal),
  UNIQUE(id, change_set_id),
  FOREIGN KEY(change_set_id, project_id)
    REFERENCES agent_change_sets(id, project_id) ON DELETE RESTRICT,
  CHECK (
    (action = 'create' AND target_id IS NULL AND expected_row_version IS NULL)
    OR (action = 'update' AND target_id IS NOT NULL AND expected_row_version IS NOT NULL)
  ),
  CHECK (
    (entity_type = 'scene' AND parent_scene_id IS NULL AND parent_item_id IS NULL AND shot_status IS NULL)
    OR (entity_type = 'shot' AND action = 'create'
      AND ((parent_scene_id IS NOT NULL AND parent_item_id IS NULL)
        OR (parent_scene_id IS NULL AND parent_item_id IS NOT NULL)))
    OR (entity_type = 'shot' AND action = 'update'
      AND parent_scene_id IS NULL AND parent_item_id IS NULL)
  )
);

CREATE INDEX idx_agent_change_sets_project_status
  ON agent_change_sets(project_id, status, created_at, id);
CREATE INDEX idx_agent_change_set_items_set_status
  ON agent_change_set_items(change_set_id, status, ordinal);

CREATE TRIGGER agent_change_set_task_project_match
BEFORE INSERT ON agent_change_sets
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_tasks WHERE id = NEW.task_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'change set task does not belong to project');
END;

CREATE TRIGGER agent_change_set_item_target_match
BEFORE INSERT ON agent_change_set_items
WHEN (NEW.entity_type = 'scene' AND NEW.action = 'update' AND NOT EXISTS (
  SELECT 1 FROM scenes WHERE id = NEW.target_id AND project_id = NEW.project_id
))
OR (NEW.entity_type = 'shot' AND NEW.action = 'update' AND NOT EXISTS (
  SELECT 1 FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id
  WHERE shots.id = NEW.target_id AND scenes.project_id = NEW.project_id
))
OR (NEW.parent_scene_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scenes WHERE id = NEW.parent_scene_id AND project_id = NEW.project_id
))
OR (NEW.parent_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_change_set_items parent
  WHERE parent.id = NEW.parent_item_id AND parent.change_set_id = NEW.change_set_id
    AND parent.project_id = NEW.project_id AND parent.entity_type = 'scene' AND parent.action = 'create'
))
BEGIN
  SELECT RAISE(ABORT, 'change set item target does not belong to project or proposal');
END;
`;

/** Agent P7: allow document mutations to travel with scene/shot proposals. */
export const MIGRATION_V27 = `
DROP TRIGGER IF EXISTS agent_change_set_item_target_match;
DROP INDEX IF EXISTS idx_agent_change_set_items_set_status;
ALTER TABLE agent_change_set_items RENAME TO agent_change_set_items_v26;

CREATE TABLE agent_change_set_items (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES agent_change_sets(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('scene', 'shot', 'document')),
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  target_id TEXT,
  parent_scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  parent_item_id TEXT REFERENCES agent_change_set_items(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  shot_status TEXT,
  document_kind TEXT,
  content_markdown TEXT,
  scope_type TEXT,
  scope_id TEXT,
  expected_row_version INTEGER CHECK (expected_row_version IS NULL OR expected_row_version >= 0),
  expected_current_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'conflicted')),
  applied_entity_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(change_set_id, ordinal),
  UNIQUE(id, change_set_id),
  FOREIGN KEY(change_set_id, project_id)
    REFERENCES agent_change_sets(id, project_id) ON DELETE RESTRICT,
  CHECK (
    (action = 'create' AND target_id IS NULL AND expected_row_version IS NULL)
    OR (action = 'update' AND target_id IS NOT NULL AND expected_row_version IS NOT NULL)
  ),
  CHECK (
    (entity_type = 'scene' AND parent_scene_id IS NULL AND parent_item_id IS NULL
      AND shot_status IS NULL AND document_kind IS NULL AND content_markdown IS NULL
      AND scope_type IS NULL AND scope_id IS NULL AND expected_current_version_id IS NULL)
    OR (entity_type = 'shot' AND action = 'create'
      AND ((parent_scene_id IS NOT NULL AND parent_item_id IS NULL)
        OR (parent_scene_id IS NULL AND parent_item_id IS NOT NULL))
      AND document_kind IS NULL AND content_markdown IS NULL AND scope_type IS NULL
      AND scope_id IS NULL AND expected_current_version_id IS NULL)
    OR (entity_type = 'shot' AND action = 'update'
      AND parent_scene_id IS NULL AND parent_item_id IS NULL
      AND document_kind IS NULL AND content_markdown IS NULL AND scope_type IS NULL
      AND scope_id IS NULL AND expected_current_version_id IS NULL)
    OR (entity_type = 'document' AND parent_scene_id IS NULL AND parent_item_id IS NULL
      AND shot_status IS NULL AND document_kind IS NOT NULL AND content_markdown IS NOT NULL)
  )
);

INSERT INTO agent_change_set_items
  (id, change_set_id, project_id, ordinal, entity_type, action, target_id,
   parent_scene_id, parent_item_id, title, shot_status, status, applied_entity_id,
   error_code, expected_row_version, created_at, updated_at)
SELECT id, change_set_id, project_id, ordinal, entity_type, action, target_id,
       parent_scene_id, parent_item_id, title, shot_status, status, applied_entity_id,
       error_code, expected_row_version, created_at, updated_at
FROM agent_change_set_items_v26;

DROP TABLE agent_change_set_items_v26;
CREATE INDEX idx_agent_change_set_items_set_status
  ON agent_change_set_items(change_set_id, status, ordinal);

CREATE TRIGGER agent_change_set_item_target_match
BEFORE INSERT ON agent_change_set_items
WHEN (NEW.entity_type = 'scene' AND NEW.action = 'update' AND NOT EXISTS (
  SELECT 1 FROM scenes WHERE id = NEW.target_id AND project_id = NEW.project_id
))
OR (NEW.entity_type = 'shot' AND NEW.action = 'update' AND NOT EXISTS (
  SELECT 1 FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id
  WHERE shots.id = NEW.target_id AND scenes.project_id = NEW.project_id
))
OR (NEW.entity_type = 'document' AND NEW.action = 'update' AND NOT EXISTS (
  SELECT 1 FROM documents WHERE id = NEW.target_id AND project_id = NEW.project_id
))
OR (NEW.parent_scene_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scenes WHERE id = NEW.parent_scene_id AND project_id = NEW.project_id
))
OR (NEW.parent_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_change_set_items parent
  WHERE parent.id = NEW.parent_item_id AND parent.change_set_id = NEW.change_set_id
    AND parent.project_id = NEW.project_id AND parent.entity_type = 'scene' AND parent.action = 'create'
))
OR (NEW.expected_current_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_versions versions
  INNER JOIN documents ON documents.id = versions.document_id
  WHERE versions.id = NEW.expected_current_version_id AND documents.project_id = NEW.project_id
))
BEGIN
  SELECT RAISE(ABORT, 'change set item target does not belong to project or proposal');
END;
`;

export const MIGRATION_V28 = `
ALTER TABLE shots ADD COLUMN document_id TEXT;
CREATE UNIQUE INDEX idx_shots_document_id ON shots(document_id) WHERE document_id IS NOT NULL;
`;

/** S1: short-drama episode prompts. */
export const MIGRATION_V29 = `
ALTER TABLE shots ADD COLUMN prompt TEXT
  CHECK (prompt IS NULL OR length(trim(prompt)) <= 2000);
ALTER TABLE agent_change_set_items ADD COLUMN shot_prompt TEXT
  CHECK (shot_prompt IS NULL OR length(trim(shot_prompt)) <= 2000);

CREATE TRIGGER agent_change_set_item_shot_prompt_match
BEFORE INSERT ON agent_change_set_items
WHEN NEW.shot_prompt IS NOT NULL AND NEW.entity_type != 'shot'
BEGIN
  SELECT RAISE(ABORT, 'shot prompt is only allowed on shot items');
END;
`;

/** Locally persisted RAG chunks for the current saved novel chapter drafts. */
export const MIGRATION_V30 = `
CREATE TABLE novel_rag_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  content_text TEXT NOT NULL CHECK (length(content_text) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  character_count INTEGER NOT NULL CHECK (character_count = length(content_text)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chapter_id, ordinal)
);

CREATE INDEX idx_novel_rag_chunks_project_chapter
  ON novel_rag_chunks(project_id, chapter_id, ordinal);
CREATE INDEX idx_novel_rag_chunks_current_version
  ON novel_rag_chunks(project_id, source_document_version_id, chapter_id);

CREATE TRIGGER novel_rag_chunk_scope_match
BEFORE INSERT ON novel_rag_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM novel_chapters chapters
  INNER JOIN documents ON documents.id = chapters.document_id
  INNER JOIN document_versions versions ON versions.document_id = documents.id
  WHERE chapters.id = NEW.chapter_id
    AND chapters.project_id = NEW.project_id
    AND documents.id = NEW.document_id
    AND documents.project_id = NEW.project_id
    AND versions.id = NEW.source_document_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'novel RAG chunk does not match project chapter version');
END;
`;

/** P2: Pi-independent conversation task plans and multi-deliverable state. */
export const MIGRATION_V31 = `
CREATE TABLE agent_task_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES agent_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version = 1),
  mode TEXT NOT NULL CHECK (mode IN ('document', 'novel-writing', 'short-drama')),
  action TEXT NOT NULL CHECK (action IN ('generate', 'revise', 'analyze')),
  target_platform TEXT CHECK (
    target_platform IS NULL OR target_platform IN ('seedance', 'generic-video', 'generic-image')
  ),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
  trusted_scope_json TEXT NOT NULL
    CHECK (json_valid(trusted_scope_json) AND json_type(trusted_scope_json) = 'object'),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  status TEXT NOT NULL DEFAULT 'frozen'
    CHECK (status IN ('frozen', 'active', 'succeeded', 'failed', 'cancelled')),
  idempotency_key TEXT,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (target_platform IS NULL OR mode = 'short-drama')
);

CREATE UNIQUE INDEX idx_agent_task_plans_project_idempotency
  ON agent_task_plans(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_agent_task_plans_project_status
  ON agent_task_plans(project_id, status, updated_at, id);

CREATE TABLE agent_task_deliverables (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES agent_task_plans(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'episode-outline', 'character-prompts', 'scene-prompts',
    'scene-shot-structure', 'shot-prompts', 'production-notes'
  )),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  depends_on_json TEXT NOT NULL
    CHECK (json_valid(depends_on_json) AND json_type(depends_on_json) = 'array'),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'ready', 'in_progress', 'succeeded', 'failed', 'blocked', 'cancelled')
  ),
  entity_type TEXT CHECK (entity_type IS NULL OR entity_type IN ('document', 'change-set', 'task')),
  entity_id TEXT,
  error_code TEXT,
  error_message TEXT,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, ordinal),
  UNIQUE(plan_id, kind),
  CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))
);

CREATE INDEX idx_agent_task_deliverables_plan_status
  ON agent_task_deliverables(plan_id, status, ordinal);
CREATE INDEX idx_agent_task_deliverables_task
  ON agent_task_deliverables(task_id, ordinal);

CREATE TRIGGER agent_task_plan_project_match
BEFORE INSERT ON agent_task_plans
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE agent_tasks.id = NEW.task_id AND agent_tasks.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent task plan does not match task project');
END;

CREATE TRIGGER agent_task_deliverable_scope_match
BEFORE INSERT ON agent_task_deliverables
WHEN NOT EXISTS (
  SELECT 1 FROM agent_task_plans
  WHERE agent_task_plans.id = NEW.plan_id
    AND agent_task_plans.task_id = NEW.task_id
    AND agent_task_plans.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent task deliverable does not match plan scope');
END;

CREATE TRIGGER agent_task_plan_status_transition
BEFORE UPDATE OF status ON agent_task_plans
WHEN (OLD.status = 'frozen' AND NEW.status NOT IN ('frozen', 'active', 'failed', 'cancelled'))
  OR (OLD.status = 'active' AND NEW.status NOT IN ('active', 'succeeded', 'failed', 'cancelled'))
  OR (OLD.status = 'failed' AND NEW.status NOT IN ('failed', 'active', 'cancelled'))
  OR (OLD.status IN ('succeeded', 'cancelled') AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent task plan status transition');
END;

CREATE TRIGGER agent_task_deliverable_status_transition
BEFORE UPDATE OF status ON agent_task_deliverables
WHEN (OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'ready', 'blocked', 'cancelled'))
  OR (OLD.status = 'ready' AND NEW.status NOT IN ('ready', 'in_progress', 'blocked', 'cancelled'))
  OR (OLD.status = 'in_progress' AND NEW.status NOT IN ('in_progress', 'succeeded', 'failed', 'blocked', 'cancelled'))
  OR (OLD.status IN ('failed', 'blocked') AND NEW.status NOT IN (OLD.status, 'ready', 'cancelled'))
  OR (OLD.status IN ('succeeded', 'cancelled') AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent task deliverable status transition');
END;
`;
