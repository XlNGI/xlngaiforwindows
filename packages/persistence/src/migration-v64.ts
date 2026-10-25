import type Database from 'better-sqlite3';

/** Internal Agent run-budget ledger. This is deliberately not exposed as UI state. */
export const MIGRATION_V64 = `
ALTER TABLE agent_tasks ADD COLUMN quota_state TEXT NOT NULL DEFAULT 'active'
  CHECK (quota_state IN ('active', 'paused_budget', 'provider_rate_limited', 'provider_quota_exhausted', 'context_exhausted'));
ALTER TABLE agent_tasks ADD COLUMN quota_error_code TEXT;
ALTER TABLE agent_tasks ADD COLUMN turn_limit INTEGER NOT NULL DEFAULT 24
  CHECK (turn_limit BETWEEN 1 AND 64);
ALTER TABLE agent_tasks ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0
  CHECK (turn_count >= 0);
ALTER TABLE agent_tasks ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (input_tokens >= 0);
ALTER TABLE agent_tasks ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (output_tokens >= 0);
ALTER TABLE agent_tasks ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (reasoning_tokens >= 0);
ALTER TABLE agent_tasks ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (total_tokens >= 0);
ALTER TABLE agent_tasks ADD COLUMN provider_reported_cost TEXT;
ALTER TABLE agent_tasks ADD COLUMN provider_cost_currency TEXT;
ALTER TABLE agent_tasks ADD COLUMN quota_checkpoint_at TEXT;

CREATE TABLE agent_task_usage (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  provider_reported_cost TEXT,
  currency TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, request_id)
);
CREATE INDEX agent_task_usage_task ON agent_task_usage(task_id, updated_at);
`;

const AGENT_TASK_COLUMNS = [
  `quota_state TEXT NOT NULL DEFAULT 'active'
    CHECK (quota_state IN ('active', 'paused_budget', 'provider_rate_limited', 'provider_quota_exhausted', 'context_exhausted'))`,
  'quota_error_code TEXT',
  'turn_limit INTEGER NOT NULL DEFAULT 24 CHECK (turn_limit BETWEEN 1 AND 64)',
  'turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0)',
  'input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0)',
  'output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0)',
  'reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0)',
  'total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0)',
  'provider_reported_cost TEXT',
  'provider_cost_currency TEXT',
  'quota_checkpoint_at TEXT',
] as const;

/**
 * Apply v64 to both normal upgrades and historical fixtures whose migration
 * ledger was restored without rolling back the physical schema. Each schema
 * object is checked independently so a partially applied migration can be
 * retried safely inside the caller's transaction.
 */
export function applyMigrationV64(database: Database.Database): void {
  const columns = new Set(
    (database.prepare('PRAGMA table_info(agent_tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const definition of AGENT_TASK_COLUMNS) {
    const name = definition.slice(0, definition.indexOf(' '));
    if (!columns.has(name)) database.exec(`ALTER TABLE agent_tasks ADD COLUMN ${definition}`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_task_usage (
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
      provider_reported_cost TEXT,
      currency TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS agent_task_usage_task ON agent_task_usage(task_id, updated_at);
  `);
}
