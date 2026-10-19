/** Domain owners for file work that previously had no durable job. */
export const MIGRATION_V53 = `
CREATE TABLE IF NOT EXISTS file_tasks(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),runtime_epoch TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('project-export','project-backup','novel-import')),
 operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 status TEXT NOT NULL CHECK(status IN('pending','running','succeeded','failed','cancelled','interrupted')),
 progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 error TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN(0,1)),row_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(project_id,operation_key)
);
CREATE INDEX IF NOT EXISTS file_tasks_project_status ON file_tasks(project_id,status,updated_at,id);
CREATE TRIGGER IF NOT EXISTS file_tasks_identity_immutable BEFORE UPDATE OF project_id,runtime_epoch,kind,operation_key,request_hash ON file_tasks
BEGIN SELECT RAISE(ABORT,'file task identity is immutable');END;
CREATE TRIGGER IF NOT EXISTS file_tasks_terminal_immutable BEFORE UPDATE OF status ON file_tasks
WHEN OLD.status IN('succeeded','failed','cancelled','interrupted') AND NEW.status<>OLD.status
BEGIN SELECT RAISE(ABORT,'file task terminal state is immutable');END;
`;
