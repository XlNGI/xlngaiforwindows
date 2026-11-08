import type Database from 'better-sqlite3';

/** Additive: audit summaries and document/version stores remain untouched. */
export function applyMigrationV75(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_context_tasks (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, generation_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 runtime_json TEXT CHECK(runtime_json IS NULL OR json_valid(runtime_json)),
 updated_at TEXT NOT NULL, PRIMARY KEY(project_id,task_id)
);
CREATE INDEX IF NOT EXISTS idx_context_tasks_generation ON agent_context_tasks(project_id,generation_id);
CREATE TABLE IF NOT EXISTS agent_context_results (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
 status TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
 content_hash TEXT NOT NULL, arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,task_id,call_id,content_hash)
);
CREATE INDEX IF NOT EXISTS idx_context_results_call ON agent_context_results(project_id,task_id,call_id,version);
CREATE TABLE IF NOT EXISTS agent_context_evidence (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, source_key TEXT NOT NULL, source_version TEXT NOT NULL,
 range_key TEXT NOT NULL, source_type TEXT NOT NULL, purpose TEXT NOT NULL,
 result_id TEXT NOT NULL REFERENCES agent_context_results(id), content_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','superseded','retired')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(project_id,task_id,source_key,source_version,range_key,content_hash)
);
CREATE INDEX IF NOT EXISTS idx_context_evidence_active ON agent_context_evidence(project_id,task_id,status);
CREATE TABLE IF NOT EXISTS agent_context_checkpoints (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 runtime_json TEXT CHECK(runtime_json IS NULL OR json_valid(runtime_json)),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_context_diagnostics (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at TEXT NOT NULL
);
`);
}
