/** Persistent dispatch ownership for the first (video) scheduling adapter. */
export const MIGRATION_V50 = `
CREATE TABLE IF NOT EXISTS task_schedule_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_job_id TEXT NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE RESTRICT,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  schedule_state TEXT NOT NULL CHECK(schedule_state IN ('pending','claimed','waiting','settled')),
  wait_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,operation_key), UNIQUE(id,project_id)
);
CREATE TABLE IF NOT EXISTS task_schedule_dependencies (
  task_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY(task_id,upstream_id), CHECK(task_id<>upstream_id),
  FOREIGN KEY(task_id,project_id) REFERENCES task_schedule_entries(id,project_id) ON DELETE CASCADE,
  FOREIGN KEY(upstream_id,project_id) REFERENCES task_schedule_entries(id,project_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS task_schedule_artifacts (
  task_id TEXT NOT NULL REFERENCES task_schedule_entries(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES task_schedule_entries(id) ON DELETE RESTRICT,
  source_asset_id TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(task_id,upstream_id,source_asset_id)
);
CREATE TABLE IF NOT EXISTS task_schedule_dispatches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('submit','poll')),
  status TEXT NOT NULL CHECK(status IN ('active','released','interrupted')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(task_id,project_id) REFERENCES task_schedule_entries(id,project_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS task_schedule_active_dispatch
  ON task_schedule_dispatches(task_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS task_schedule_capacity ON task_schedule_dispatches(project_id,stage,status);
CREATE TABLE IF NOT EXISTS task_schedule_events (
  task_id TEXT NOT NULL REFERENCES task_schedule_entries(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  dispatch_id TEXT REFERENCES task_schedule_dispatches(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id,sequence)
);
CREATE TRIGGER IF NOT EXISTS task_schedule_owner_project BEFORE INSERT ON task_schedule_entries
WHEN NOT EXISTS(SELECT 1 FROM generation_jobs WHERE id=NEW.owner_job_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'scheduled job must belong to project'); END;
`;
