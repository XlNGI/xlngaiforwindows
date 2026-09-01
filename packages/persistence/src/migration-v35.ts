import type Database from 'better-sqlite3';

const TASK_INDEXES = [
  'idx_agent_tasks_project_status',
  'idx_agent_tasks_conversation',
  'idx_agent_tasks_idempotency',
] as const;

const TASK_TRIGGERS = [
  'agent_tasks_scope_insert',
  'agent_tasks_scope_update',
  'agent_task_status_update',
  'agent_task_terminal_release_chapter_lock',
] as const;

/** Rebuild agent_tasks to admit the read-only adapter schema task type. */
export function addSchemaQueryTaskType(database: Database.Database, appliedAt: string): void {
  const foreignKeys = database.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeys !== 1) throw new Error('v35 migration requires foreign keys to be enabled.');

  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.pragma('legacy_alter_table = ON');
      for (const trigger of TASK_TRIGGERS) database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      for (const index of TASK_INDEXES) database.exec(`DROP INDEX IF EXISTS ${index}`);
      database.exec('ALTER TABLE agent_tasks RENAME TO __v34_old_agent_tasks');
      database.exec(V35_AGENT_TASKS_SCHEMA);
      database.exec(`
        INSERT INTO agent_tasks
          (id, project_id, project_session_id, conversation_id, user_message_id, task_type,
           scope_type, scope_id, title, request_snapshot_json, request_hash, context_snapshot_id,
           status, outcome, retry_of_task_id, idempotency_key, error_code, error_message, retryable,
           created_at, started_at, updated_at, completed_at, phase, row_version, tool_call_limit,
           tool_call_count, lifecycle_status, archived_at)
        SELECT id, project_id, project_session_id, conversation_id, user_message_id, task_type,
               scope_type, scope_id, title, request_snapshot_json, request_hash, context_snapshot_id,
               status, outcome, retry_of_task_id, idempotency_key, error_code, error_message,
               retryable, created_at, started_at, updated_at, completed_at, phase, row_version,
               tool_call_limit, tool_call_count, lifecycle_status, archived_at
        FROM __v34_old_agent_tasks;
      `);
      database.exec(V35_TASK_INDEXES_AND_TRIGGERS);
      database.exec('DROP TABLE __v34_old_agent_tasks');
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(35, appliedAt);
      database.pragma('legacy_alter_table = OFF');
    })();
  } finally {
    database.pragma('legacy_alter_table = OFF');
    database.pragma('foreign_keys = ON');
  }
}

const V35_AGENT_TASKS_SCHEMA = `
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  project_session_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  user_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'document-create', 'document-update', 'document-query', 'document-archive', 'document-restore',
    'schema-query'
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
  tool_call_limit INTEGER NOT NULL DEFAULT 16 CHECK (tool_call_limit BETWEEN 1 AND 32),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count BETWEEN 0 AND tool_call_limit),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'archived')),
  archived_at TEXT
);
`;

const V35_TASK_INDEXES_AND_TRIGGERS = `
CREATE INDEX idx_agent_tasks_project_status ON agent_tasks(project_id, status, updated_at, id);
CREATE INDEX idx_agent_tasks_conversation ON agent_tasks(conversation_id, created_at, id);
CREATE UNIQUE INDEX idx_agent_tasks_idempotency ON agent_tasks(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER agent_tasks_scope_insert BEFORE INSERT ON agent_tasks
WHEN (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid agent task scope'); END;
CREATE TRIGGER agent_tasks_scope_update BEFORE UPDATE OF scope_type, scope_id ON agent_tasks
WHEN (NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_type IN ('scene', 'shot') AND NEW.scope_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid agent task scope'); END;
CREATE TRIGGER agent_task_status_update BEFORE UPDATE OF status ON agent_tasks
WHEN (OLD.status IN ('completed', 'failed', 'cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'running', 'failed', 'cancelled'))
  OR (OLD.status = 'running' AND NEW.status NOT IN ('running', 'waiting_review', 'completed', 'failed', 'cancelled'))
  OR (OLD.status = 'waiting_review' AND NEW.status NOT IN ('waiting_review', 'running', 'completed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'invalid agent task transition'); END;
CREATE TRIGGER agent_task_terminal_release_chapter_lock
AFTER UPDATE OF status ON agent_tasks
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
BEGIN
  DELETE FROM novel_chapter_task_locks WHERE task_id = NEW.id;
END;
`;
