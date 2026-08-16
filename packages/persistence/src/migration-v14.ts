import type Database from 'better-sqlite3';

const V13_TABLES = [
  'agent_task_events',
  'agent_task_generations',
  'agent_tool_calls',
  'agent_task_document_versions',
  'document_audit_events',
  'document_publications',
  'document_reviews',
  'document_versions',
  'agent_tasks',
] as const;

const V13_TRIGGER_NAMES = [
  'agent_tasks_scope_insert',
  'agent_tasks_scope_update',
  'agent_task_status_update',
  'agent_task_event_project_match',
  'agent_task_generation_project_match',
  'agent_task_event_immutable_update',
  'agent_tool_call_status_update',
  'agent_tool_call_generation_project_match',
  'agent_tool_call_attempt_match',
  'document_version_state_update',
  'document_review_status_update',
  'document_publication_immutable_update',
  'documents_published_version_insert',
  'documents_published_version_update',
  'document_review_version_match',
  'document_publication_version_match',
  'agent_task_document_version_match',
  'document_audit_project_match',
  'document_audit_version_match',
  'document_audit_review_match',
  'document_audit_publication_match',
  'document_audit_task_match',
  'document_audit_immutable_update',
  'document_audit_immutable_delete',
] as const;

const V13_INDEX_NAMES = [
  'idx_agent_tasks_project_status',
  'idx_agent_tasks_conversation',
  'idx_agent_tasks_idempotency',
  'idx_agent_task_events_task',
  'idx_agent_task_events_dedupe',
  'idx_agent_tool_calls_task',
  'idx_agent_tool_calls_provider',
  'idx_agent_tool_calls_idempotency',
  'idx_documents_published',
  'idx_document_versions_state',
  'idx_document_reviews_document',
  'idx_document_reviews_status',
  'idx_document_publications_document',
  'idx_agent_task_document_versions_task',
  'idx_document_audit_project',
  'idx_document_audit_document',
  'idx_document_audit_action',
] as const;

/**
 * SQLite cannot alter the task FK graph in place. v14 therefore replaces the
 * complete inbound closure in one transaction, leaving no table definition
 * that refers to a temporary v13 name.
 */
export function runV14Rebuild(database: Database.Database, appliedAt: string): void {
  const foreignKeys = database.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeys !== 1) throw new Error('v14 migration requires foreign keys to be enabled.');

  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.pragma('legacy_alter_table = ON');
      for (const trigger of V13_TRIGGER_NAMES) database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      for (const index of V13_INDEX_NAMES) database.exec(`DROP INDEX IF EXISTS ${index}`);
      for (const table of V13_TABLES) {
        database.exec(`ALTER TABLE ${table} RENAME TO __v13_old_${table}`);
      }

      database.exec(V14_SCHEMA);
      copyV13Rows(database);
      database.exec(V14_INDEXES_AND_TRIGGERS);

      for (const table of V13_TABLES) database.exec(`DROP TABLE __v13_old_${table}`);
      const foreignKeyErrors = database.pragma('foreign_key_check') as Array<
        Record<string, unknown>
      >;
      if (foreignKeyErrors.length > 0) {
        throw new Error(
          `v14 migration produced ${foreignKeyErrors.length} foreign key violation(s).`,
        );
      }
      const staleReferences = database
        .prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%__v13_old_%'")
        .all() as Array<{ name: string }>;
      if (staleReferences.length > 0) {
        throw new Error(
          `v14 migration left stale schema references: ${staleReferences.map((row) => row.name).join(', ')}`,
        );
      }
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(14, appliedAt);
      database.pragma('legacy_alter_table = OFF');
    })();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function copyV13Rows(database: Database.Database): void {
  database.exec(`
    INSERT INTO agent_tasks
      (id, project_id, project_session_id, conversation_id, user_message_id, task_type,
       scope_type, scope_id, title, request_snapshot_json, request_hash, context_snapshot_id,
       status, outcome, retry_of_task_id, idempotency_key, error_code, error_message, retryable,
       created_at, started_at, updated_at, completed_at, phase, row_version)
    SELECT id, project_id, project_session_id, conversation_id, user_message_id, task_type,
           scope_type, scope_id, title, request_snapshot_json, request_hash, context_snapshot_id,
           status, outcome, retry_of_task_id, idempotency_key, error_code, error_message, retryable,
           created_at, started_at, updated_at, completed_at,
           CASE status
             WHEN 'queued' THEN 'queued'
             WHEN 'running' THEN 'model_running'
             WHEN 'waiting_review' THEN 'waiting_review'
             ELSE 'recovering'
           END,
           version
    FROM __v13_old_agent_tasks;

    INSERT INTO document_versions
      (id, document_id, version, content_markdown, state, base_version_id, title_snapshot,
       scope_type_snapshot, scope_id_snapshot, author_type, author_id, source_task_id,
       source_message_id, context_snapshot_id, content_hash, state_updated_at, state_version, created_at)
    SELECT id, document_id, version, content_markdown, state, base_version_id, title_snapshot,
           scope_type_snapshot, scope_id_snapshot, author_type, author_id, source_task_id,
           source_message_id, context_snapshot_id, content_hash, state_updated_at, state_version, created_at
    FROM __v13_old_document_versions;

    INSERT INTO document_reviews
      (id, project_id, document_id, document_version_id, task_id, status, requested_by_type,
       requested_by_id, requested_at, decided_by_type, decided_by_id, decided_at, comment, version)
    SELECT id, project_id, document_id, document_version_id, task_id, status, requested_by_type,
           requested_by_id, requested_at, decided_by_type, decided_by_id, decided_at, comment, version
    FROM __v13_old_document_reviews;

    INSERT INTO document_publications
      (id, project_id, document_id, document_version_id, previous_version_id, publication_no,
       review_id, task_id, published_by_type, published_by_id, published_at)
    SELECT id, project_id, document_id, document_version_id, previous_version_id, publication_no,
           review_id, task_id, published_by_type, published_by_id, published_at
    FROM __v13_old_document_publications;

    INSERT INTO document_audit_events
      (id, project_id, sequence, action, actor_type, actor_id, document_id, document_version_id,
       source_version_id, review_id, publication_id, task_id, metadata_json, created_at)
    SELECT id, project_id, sequence, action, actor_type, actor_id, document_id, document_version_id,
           source_version_id, review_id, publication_id, task_id, metadata_json, created_at
    FROM __v13_old_document_audit_events;

    INSERT INTO agent_task_events
      (id, task_id, project_id, sequence, event_type, level, actor_type, actor_id, summary,
       payload_json, dedupe_key, created_at)
    SELECT id, task_id, project_id, sequence, event_type, level, actor_type, actor_id, summary,
           payload_json, dedupe_key, created_at
    FROM __v13_old_agent_task_events;

    INSERT INTO agent_task_generations (task_id, generation_id, ordinal, purpose, created_at)
    SELECT task_id, generation_id, ordinal, purpose, created_at
    FROM __v13_old_agent_task_generations;

    INSERT INTO agent_tool_calls
      (id, project_id, task_id, generation_id, attempt_id, tool_name, normalized_arguments_hash,
       arguments_summary_json, status, idempotency_key, error_code, error_message, created_at,
       started_at, completed_at, version, redaction_state)
    SELECT calls.id, tasks.project_id, calls.task_id, calls.generation_id, calls.attempt_id,
           calls.tool_name, calls.arguments_hash,
           json_object('legacy', 1, 'toolName', calls.tool_name),
           CASE calls.status
             WHEN 'received' THEN 'received'
             WHEN 'validated' THEN 'validated'
             WHEN 'executing' THEN 'executing'
             WHEN 'succeeded' THEN 'succeeded'
             WHEN 'failed' THEN 'failed'
             ELSE 'cancelled'
           END,
           'legacy:' || calls.id, calls.error_code, calls.error_message, calls.created_at,
           calls.started_at, calls.completed_at, calls.version, 'legacy_redacted'
    FROM __v13_old_agent_tool_calls calls
    INNER JOIN agent_tasks tasks ON tasks.id = calls.task_id;

    INSERT INTO agent_task_document_versions
      (task_id, document_id, document_version_id, operation, created_at)
    SELECT task_id, document_id, document_version_id, operation, created_at
    FROM __v13_old_agent_task_document_versions;

    INSERT INTO agent_task_document_artifacts
      (id, project_id, task_id, document_id, document_version_id, artifact_role, disposition,
       row_version, created_at, updated_at)
    SELECT 'migration-artifact:' || candidate.task_id,
           candidate.project_id, candidate.task_id, candidate.document_id, candidate.document_version_id,
           'primary',
           CASE versions.state
             WHEN 'published' THEN 'published'
             WHEN 'rejected' THEN 'rejected'
             WHEN 'discarded' THEN 'discarded'
             ELSE 'draft'
           END,
           0, candidate.created_at, candidate.created_at
    FROM (
      SELECT tasks.id AS task_id, tasks.project_id, history.document_id,
             history.document_version_id, history.created_at
      FROM agent_tasks tasks
      INNER JOIN agent_task_document_versions history ON history.task_id = tasks.id
      WHERE tasks.task_type IN ('document-create', 'document-update')
        AND (SELECT COUNT(DISTINCT h.document_id)
             FROM agent_task_document_versions h WHERE h.task_id = tasks.id) = 1
        AND NOT EXISTS (
          SELECT 1 FROM agent_task_document_versions invalid
          INNER JOIN document_versions invalid_version ON invalid_version.id = invalid.document_version_id
          WHERE invalid.task_id = tasks.id
            AND (invalid_version.document_id <> invalid.document_id
              OR invalid_version.source_task_id IS NOT tasks.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_task_document_versions later
          WHERE later.task_id = history.task_id
            AND (later.created_at > history.created_at
              OR (later.created_at = history.created_at AND later.document_version_id > history.document_version_id))
        )
    ) candidate
    INNER JOIN document_versions versions ON versions.id = candidate.document_version_id;
  `);
}

const V14_SCHEMA = `
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  project_session_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  user_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'document-create', 'document-update', 'document-query', 'document-archive', 'document-restore'
  )),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'scene', 'shot')),
  scope_id TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  request_hash TEXT NOT NULL,
  context_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_review', 'completed', 'failed', 'cancelled')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('published', 'rejected', 'discarded', 'read-only', 'archived', 'restored')),
  retry_of_task_id TEXT REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  phase TEXT NOT NULL DEFAULT 'queued' CHECK (phase IN (
    'queued', 'intent_resolving', 'context_compiling', 'model_running', 'tool_validating',
    'waiting_confirmation', 'artifact_persisting', 'waiting_review', 'recovering'
  )),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  tool_call_limit INTEGER NOT NULL DEFAULT 8 CHECK (tool_call_limit BETWEEN 1 AND 16),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count BETWEEN 0 AND tool_call_limit),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'archived')),
  archived_at TEXT
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  content_markdown TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'published' CHECK (state IN ('draft', 'in_review', 'published', 'changes_requested', 'rejected', 'superseded', 'discarded')),
  base_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  title_snapshot TEXT,
  scope_type_snapshot TEXT,
  scope_id_snapshot TEXT,
  author_type TEXT NOT NULL DEFAULT 'user' CHECK (author_type IN ('user', 'agent', 'import', 'migration')),
  author_id TEXT,
  source_task_id TEXT REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  source_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  context_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
  content_hash TEXT,
  state_updated_at TEXT,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version)
);

CREATE TABLE document_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'withdrawn')),
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
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  publication_no INTEGER NOT NULL CHECK (publication_no > 0),
  review_id TEXT REFERENCES document_reviews(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  published_by_type TEXT NOT NULL,
  published_by_id TEXT,
  published_at TEXT NOT NULL,
  UNIQUE(document_id, publication_no),
  UNIQUE(document_version_id)
);

CREATE TABLE document_audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  action TEXT NOT NULL CHECK (action IN ('draft_saved', 'draft_restored', 'review_submitted', 'review_changes_requested', 'review_rejected', 'published')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'import', 'migration')),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 256),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  review_id TEXT REFERENCES document_reviews(id) ON DELETE SET NULL,
  publication_id TEXT REFERENCES document_publications(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object' AND length(metadata_json) <= 4096),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, sequence)
);

CREATE TABLE agent_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
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
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, generation_id),
  UNIQUE(task_id, ordinal),
  UNIQUE(generation_id)
);

CREATE TABLE llm_provider_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  protocol TEXT NOT NULL,
  provider_response_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'in_flight', 'complete', 'failed', 'interrupted')),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count BETWEEN 0 AND 8),
  finish_reason TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  provider_reported_cost TEXT,
  currency TEXT,
  continuation_manifest_json TEXT CHECK (continuation_manifest_json IS NULL OR json_valid(continuation_manifest_json)),
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(attempt_id, ordinal),
  UNIQUE(id, project_id),
  FOREIGN KEY(attempt_id, generation_id) REFERENCES llm_generation_attempts(id, generation_id) ON DELETE RESTRICT
);

CREATE TABLE agent_tool_authorizations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  provider_step_id TEXT NOT NULL REFERENCES llm_provider_steps(id) ON DELETE RESTRICT,
  project_session_id TEXT NOT NULL,
  allowed_operation TEXT NOT NULL,
  target_document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  scope_type TEXT,
  scope_id TEXT,
  base_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  expected_document_row_version INTEGER,
  policy_version TEXT NOT NULL,
  tool_schema_version TEXT NOT NULL,
  authorization_handle_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'revoked', 'expired')),
  max_call_uses INTEGER NOT NULL CHECK (max_call_uses BETWEEN 1 AND 8),
  used_call_count INTEGER NOT NULL DEFAULT 0 CHECK (used_call_count BETWEEN 0 AND max_call_uses),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY(provider_step_id, project_id) REFERENCES llm_provider_steps(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE agent_tool_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  generation_id TEXT REFERENCES llm_generations(id) ON DELETE RESTRICT,
  attempt_id TEXT,
  authorization_id TEXT REFERENCES agent_tool_authorizations(id) ON DELETE RESTRICT,
  provider_step_id TEXT REFERENCES llm_provider_steps(id) ON DELETE RESTRICT,
  provider_call_id TEXT,
  tool_ordinal INTEGER CHECK (tool_ordinal IS NULL OR tool_ordinal >= 0),
  tool_name TEXT NOT NULL,
  normalized_arguments_hash TEXT NOT NULL,
  arguments_summary_json TEXT NOT NULL CHECK (json_valid(arguments_summary_json)),
  content_hash TEXT,
  content_length INTEGER CHECK (content_length IS NULL OR content_length >= 0),
  result_summary_json TEXT CHECK (result_summary_json IS NULL OR json_valid(result_summary_json)),
  result_document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  result_document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('received', 'validated', 'awaiting_confirmation', 'executing', 'succeeded', 'failed', 'cancelled')),
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  redaction_state TEXT NOT NULL CHECK (redaction_state IN ('native', 'legacy_redacted')),
  UNIQUE(id, project_id),
  CHECK (
    (provider_step_id IS NOT NULL AND authorization_id IS NOT NULL AND generation_id IS NOT NULL
      AND attempt_id IS NOT NULL AND provider_call_id IS NOT NULL AND tool_ordinal IS NOT NULL
      AND idempotency_key IS NULL AND redaction_state = 'native')
    OR
    (provider_step_id IS NULL AND authorization_id IS NULL AND generation_id IS NULL
      AND attempt_id IS NULL AND provider_call_id IS NULL AND tool_ordinal IS NULL
      AND idempotency_key IS NOT NULL AND redaction_state IN ('native', 'legacy_redacted'))
    OR
    (provider_step_id IS NULL AND authorization_id IS NULL AND provider_call_id IS NULL
      AND tool_ordinal IS NULL AND idempotency_key IS NOT NULL AND redaction_state = 'legacy_redacted')
  )
);

CREATE TABLE agent_task_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  original_tool_call_id TEXT NOT NULL REFERENCES agent_tool_calls(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  target_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  expected_document_row_version INTEGER,
  normalized_arguments_hash TEXT NOT NULL,
  continuation_descriptor_json TEXT NOT NULL CHECK (json_valid(continuation_descriptor_json)),
  token_hash TEXT NOT NULL,
  continuation_authorization_id TEXT REFERENCES agent_tool_authorizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'rejected', 'expired', 'consumed')),
  expires_at TEXT NOT NULL,
  approved_by_type TEXT,
  approved_by_id TEXT,
  approved_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_task_document_versions (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'regenerate')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, document_version_id, operation)
);

CREATE TABLE agent_task_document_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  artifact_role TEXT NOT NULL CHECK (artifact_role IN ('primary')),
  disposition TEXT NOT NULL CHECK (disposition IN ('draft', 'published', 'rejected', 'discarded')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, artifact_role)
);

CREATE UNIQUE INDEX idx_llm_attempts_generation_pair ON llm_generation_attempts(id, generation_id);
`;

const V14_INDEXES_AND_TRIGGERS = `
CREATE INDEX idx_agent_tasks_project_status ON agent_tasks(project_id, status, updated_at, id);
CREATE INDEX idx_agent_tasks_conversation ON agent_tasks(conversation_id, created_at, id);
CREATE UNIQUE INDEX idx_agent_tasks_idempotency ON agent_tasks(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_agent_task_events_task ON agent_task_events(task_id, sequence);
CREATE UNIQUE INDEX idx_agent_task_events_dedupe ON agent_task_events(task_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_agent_task_generations_generation ON agent_task_generations(generation_id);
CREATE INDEX idx_llm_provider_steps_attempt ON llm_provider_steps(attempt_id, ordinal);
CREATE INDEX idx_agent_tool_authorizations_step ON agent_tool_authorizations(provider_step_id, status, expires_at);
CREATE INDEX idx_agent_tool_calls_task ON agent_tool_calls(task_id, created_at, id);
CREATE UNIQUE INDEX idx_agent_tool_calls_provider_scope ON agent_tool_calls(task_id, attempt_id, provider_step_id, provider_call_id) WHERE provider_call_id IS NOT NULL AND provider_step_id IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_tool_calls_manual_idempotency ON agent_tool_calls(task_id, idempotency_key) WHERE provider_step_id IS NULL AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_task_confirmation_pending ON agent_task_confirmations(task_id) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_agent_task_confirmation_continuation ON agent_task_confirmations(continuation_authorization_id) WHERE continuation_authorization_id IS NOT NULL;
CREATE INDEX idx_agent_task_document_versions_task ON agent_task_document_versions(task_id, created_at, document_version_id);
CREATE INDEX idx_agent_task_document_artifacts_task ON agent_task_document_artifacts(task_id, updated_at);
CREATE INDEX idx_document_versions_state ON document_versions(document_id, state, version, id);
CREATE INDEX idx_document_reviews_document ON document_reviews(document_id, requested_at, id);
CREATE INDEX idx_document_reviews_status ON document_reviews(project_id, status, requested_at, id);
CREATE INDEX idx_document_publications_document ON document_publications(document_id, publication_no DESC, id DESC);
CREATE INDEX idx_document_audit_project ON document_audit_events(project_id, sequence DESC, id DESC);
CREATE INDEX idx_document_audit_document ON document_audit_events(document_id, sequence DESC, id DESC);
CREATE INDEX idx_document_audit_action ON document_audit_events(project_id, action, sequence DESC, id DESC);

CREATE TRIGGER agent_tasks_scope_insert BEFORE INSERT ON agent_tasks
WHEN (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL) OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid agent task scope'); END;
CREATE TRIGGER agent_tasks_scope_update BEFORE UPDATE OF scope_type, scope_id ON agent_tasks
WHEN (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL) OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid agent task scope'); END;
CREATE TRIGGER agent_task_status_update BEFORE UPDATE OF status ON agent_tasks
WHEN (OLD.status IN ('completed', 'failed', 'cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'running', 'failed', 'cancelled'))
  OR (OLD.status = 'running' AND NEW.status NOT IN ('running', 'waiting_review', 'completed', 'failed', 'cancelled'))
  OR (OLD.status = 'waiting_review' AND NEW.status NOT IN ('waiting_review', 'running', 'completed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'invalid agent task transition'); END;
CREATE TRIGGER agent_task_event_project_match BEFORE INSERT ON agent_task_events
WHEN NOT EXISTS (SELECT 1 FROM agent_tasks WHERE id = NEW.task_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'event project does not match task'); END;
CREATE TRIGGER agent_task_generation_project_match BEFORE INSERT ON agent_task_generations
WHEN NOT EXISTS (SELECT 1 FROM agent_tasks INNER JOIN llm_generations ON llm_generations.id = NEW.generation_id WHERE agent_tasks.id = NEW.task_id AND agent_tasks.project_id = llm_generations.project_id)
BEGIN SELECT RAISE(ABORT, 'generation project does not match task'); END;
CREATE TRIGGER agent_task_event_immutable_update BEFORE UPDATE ON agent_task_events
BEGIN SELECT RAISE(ABORT, 'agent task events are immutable'); END;
CREATE TRIGGER agent_tool_call_status_update BEFORE UPDATE OF status ON agent_tool_calls
WHEN (OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'received' AND NEW.status NOT IN ('received', 'validated', 'failed', 'cancelled'))
  OR (OLD.status = 'validated' AND NEW.status NOT IN ('validated', 'awaiting_confirmation', 'executing', 'failed', 'cancelled'))
  OR (OLD.status = 'awaiting_confirmation' AND NEW.status NOT IN ('awaiting_confirmation', 'executing', 'failed', 'cancelled'))
  OR (OLD.status = 'executing' AND NEW.status NOT IN ('executing', 'succeeded', 'failed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'invalid agent tool call transition'); END;
CREATE TRIGGER agent_tool_call_project_match BEFORE INSERT ON agent_tool_calls
WHEN NOT EXISTS (SELECT 1 FROM agent_tasks WHERE id = NEW.task_id AND project_id = NEW.project_id)
  OR (NEW.result_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.result_document_id AND project_id = NEW.project_id))
  OR (NEW.result_document_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_versions WHERE id = NEW.result_document_version_id AND document_id = NEW.result_document_id))
BEGIN SELECT RAISE(ABORT, 'tool call project or result does not match task'); END;
CREATE TRIGGER agent_tool_call_provider_match BEFORE INSERT ON agent_tool_calls
WHEN NEW.provider_step_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM llm_provider_steps steps
  INNER JOIN agent_task_generations links ON links.generation_id = steps.generation_id
  WHERE steps.id = NEW.provider_step_id AND steps.project_id = NEW.project_id AND links.task_id = NEW.task_id
    AND steps.generation_id = NEW.generation_id AND steps.attempt_id = NEW.attempt_id
)
BEGIN SELECT RAISE(ABORT, 'tool call provider step does not match task'); END;
CREATE TRIGGER agent_tool_call_authorization_match BEFORE INSERT ON agent_tool_calls
WHEN NEW.authorization_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_tool_authorizations authorizations
  WHERE authorizations.id = NEW.authorization_id AND authorizations.project_id = NEW.project_id
    AND authorizations.task_id = NEW.task_id AND authorizations.generation_id = NEW.generation_id
    AND authorizations.attempt_id = NEW.attempt_id AND authorizations.provider_step_id = NEW.provider_step_id
)
BEGIN SELECT RAISE(ABORT, 'tool call authorization does not match provider step'); END;
CREATE TRIGGER agent_tool_authorization_match BEFORE INSERT ON agent_tool_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks tasks INNER JOIN llm_provider_steps steps ON steps.id = NEW.provider_step_id
  INNER JOIN agent_task_generations links ON links.generation_id = steps.generation_id
  WHERE tasks.id = NEW.task_id AND tasks.project_id = NEW.project_id AND tasks.project_session_id = NEW.project_session_id
    AND links.task_id = NEW.task_id AND steps.project_id = NEW.project_id
    AND steps.generation_id = NEW.generation_id AND steps.attempt_id = NEW.attempt_id
)
BEGIN SELECT RAISE(ABORT, 'tool authorization does not match task or provider step'); END;
CREATE TRIGGER agent_task_confirmation_match BEFORE INSERT ON agent_task_confirmations
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tool_calls calls
  WHERE calls.id = NEW.original_tool_call_id AND calls.project_id = NEW.project_id
    AND calls.task_id = NEW.task_id AND calls.generation_id = NEW.generation_id AND calls.attempt_id = NEW.attempt_id
)
BEGIN SELECT RAISE(ABORT, 'confirmation does not match original tool call'); END;
CREATE TRIGGER agent_task_document_version_match BEFORE INSERT ON agent_task_document_versions
WHEN NOT EXISTS (SELECT 1 FROM agent_tasks INNER JOIN documents ON documents.project_id = agent_tasks.project_id INNER JOIN document_versions ON document_versions.id = NEW.document_version_id WHERE agent_tasks.id = NEW.task_id AND documents.id = NEW.document_id AND document_versions.document_id = NEW.document_id)
BEGIN SELECT RAISE(ABORT, 'task document version does not belong to document'); END;
CREATE TRIGGER agent_task_document_artifact_match BEFORE INSERT ON agent_task_document_artifacts
WHEN NOT EXISTS (SELECT 1 FROM agent_tasks INNER JOIN documents ON documents.project_id = agent_tasks.project_id INNER JOIN document_versions ON document_versions.id = NEW.document_version_id WHERE agent_tasks.id = NEW.task_id AND agent_tasks.project_id = NEW.project_id AND agent_tasks.task_type IN ('document-create', 'document-update') AND documents.id = NEW.document_id AND document_versions.document_id = NEW.document_id)
BEGIN SELECT RAISE(ABORT, 'task primary artifact does not match document task'); END;
CREATE TRIGGER document_version_state_update BEFORE UPDATE OF state ON document_versions
WHEN (OLD.state IN ('published', 'rejected', 'superseded', 'discarded') AND NEW.state <> OLD.state)
  OR (OLD.state = 'draft' AND NEW.state NOT IN ('draft', 'in_review', 'superseded', 'discarded'))
  OR (OLD.state = 'in_review' AND NEW.state NOT IN ('in_review', 'published', 'changes_requested', 'rejected', 'superseded', 'discarded'))
  OR (OLD.state = 'changes_requested' AND NEW.state NOT IN ('changes_requested', 'draft', 'superseded', 'discarded'))
BEGIN SELECT RAISE(ABORT, 'invalid document version transition'); END;
CREATE TRIGGER document_review_status_update BEFORE UPDATE OF status ON document_reviews
WHEN (OLD.status IN ('approved', 'changes_requested', 'rejected', 'withdrawn') AND NEW.status <> OLD.status)
  OR (OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'approved', 'changes_requested', 'rejected', 'withdrawn'))
BEGIN SELECT RAISE(ABORT, 'invalid document review transition'); END;
CREATE TRIGGER document_publication_immutable_update BEFORE UPDATE ON document_publications
BEGIN SELECT RAISE(ABORT, 'document publications are immutable'); END;
CREATE TRIGGER documents_published_version_insert BEFORE INSERT ON documents
WHEN NEW.published_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_versions WHERE id = NEW.published_version_id AND document_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'published version does not belong to document'); END;
CREATE TRIGGER documents_published_version_update BEFORE UPDATE OF published_version_id ON documents
WHEN NEW.published_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_versions WHERE id = NEW.published_version_id AND document_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'published version does not belong to document'); END;
CREATE TRIGGER document_review_version_match BEFORE INSERT ON document_reviews
WHEN NOT EXISTS (SELECT 1 FROM documents INNER JOIN document_versions ON document_versions.id = NEW.document_version_id WHERE documents.id = NEW.document_id AND documents.project_id = NEW.project_id AND document_versions.document_id = NEW.document_id)
BEGIN SELECT RAISE(ABORT, 'review version does not belong to document'); END;
CREATE TRIGGER document_publication_version_match BEFORE INSERT ON document_publications
WHEN NOT EXISTS (SELECT 1 FROM documents INNER JOIN document_versions ON document_versions.id = NEW.document_version_id WHERE documents.id = NEW.document_id AND documents.project_id = NEW.project_id AND document_versions.document_id = NEW.document_id)
BEGIN SELECT RAISE(ABORT, 'publication version does not belong to document'); END;
CREATE TRIGGER document_audit_project_match BEFORE INSERT ON document_audit_events
WHEN NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'document audit project does not match document'); END;
CREATE TRIGGER document_audit_version_match BEFORE INSERT ON document_audit_events
WHEN NOT EXISTS (SELECT 1 FROM document_versions WHERE id = NEW.document_version_id AND document_id = NEW.document_id)
  OR (NEW.source_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_versions WHERE id = NEW.source_version_id AND document_id = NEW.document_id))
BEGIN SELECT RAISE(ABORT, 'document audit version does not match document'); END;
CREATE TRIGGER document_audit_review_match BEFORE INSERT ON document_audit_events
WHEN NEW.review_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_reviews WHERE id = NEW.review_id AND project_id = NEW.project_id AND document_id = NEW.document_id AND document_version_id = NEW.document_version_id)
BEGIN SELECT RAISE(ABORT, 'document audit review does not match document'); END;
CREATE TRIGGER document_audit_publication_match BEFORE INSERT ON document_audit_events
WHEN NEW.publication_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_publications WHERE id = NEW.publication_id AND project_id = NEW.project_id AND document_id = NEW.document_id AND document_version_id = NEW.document_version_id)
BEGIN SELECT RAISE(ABORT, 'document audit publication does not match document'); END;
CREATE TRIGGER document_audit_task_match BEFORE INSERT ON document_audit_events
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_tasks WHERE id = NEW.task_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'document audit task does not match project'); END;
CREATE TRIGGER document_audit_immutable_update BEFORE UPDATE ON document_audit_events
BEGIN SELECT RAISE(ABORT, 'document audit events are immutable'); END;
CREATE TRIGGER document_audit_immutable_delete BEFORE DELETE ON document_audit_events
BEGIN SELECT RAISE(ABORT, 'document audit events are immutable'); END;
`;
