import type Database from 'better-sqlite3';

/** Additive execution facts. Existing receipts, results and project data are retained. */
export function applyMigrationV76(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_execution_outputs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL, plan_key TEXT NOT NULL, tool_name TEXT NOT NULL,
 quantity INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(project_id,task_id,plan_key)
);
CREATE TABLE IF NOT EXISTS agent_execution_commits (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL, operation_key TEXT NOT NULL, tool_name TEXT NOT NULL,
 receipt_id TEXT NOT NULL REFERENCES agent_write_receipts(id),
 effect TEXT NOT NULL, change_sequence INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(project_id,task_id,operation_key)
);
CREATE TABLE IF NOT EXISTS agent_execution_output_adoptions (
 project_id TEXT NOT NULL, task_id TEXT NOT NULL,
 operation_key TEXT NOT NULL, output_id TEXT NOT NULL REFERENCES agent_execution_outputs(id),
 PRIMARY KEY(project_id,task_id,operation_key), UNIQUE(output_id)
);
CREATE TABLE IF NOT EXISTS agent_execution_scope (
 id INTEGER PRIMARY KEY CHECK(id=1), task_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_resource_changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
 task_id TEXT, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
 operation TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_changes_task ON agent_resource_changes(project_id,task_id,sequence);
`);
  // Ordinary UI writes also produce project changes, without an Agent task scope.
  for (const [table, kind, project] of [
    ['documents', 'document', 'NEW.project_id'],
    ['scenes', 'scene', 'NEW.project_id'],
    ['shots', 'shot', '(SELECT project_id FROM scenes WHERE id=NEW.scene_id)'],
    ['scene_structure_stages', 'structure-stage', 'NEW.project_id'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.length) continue;
    const changed = columns
      .filter(({ name }) => !['updated_at', 'row_version'].includes(name))
      .map(({ name }) => `OLD."${name}" IS NOT NEW."${name}"`)
      .join(' OR ');
    for (const operation of ['INSERT', 'UPDATE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS agent_changes_${table}_${operation.toLowerCase()}
AFTER ${operation} ON ${table} ${operation === 'UPDATE' ? `WHEN ${changed}` : ''} BEGIN
 INSERT INTO agent_resource_changes(project_id,task_id,resource_type,resource_id,operation,created_at)
 VALUES(${project},(SELECT task_id FROM agent_execution_scope WHERE id=1),'${kind}',NEW.id,'${operation.toLowerCase()}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;`);
    }
  }
}
