import type Database from 'better-sqlite3';

const OLD_LIMIT = 'CHECK (max_call_uses BETWEEN 1 AND 8)';
const LIBRARY_LIMIT =
  "CHECK (max_call_uses BETWEEN 1 AND CASE WHEN allowed_operation = 'library.read' THEN 16 ELSE 8 END)";

/** Align a read authorization's lifetime quota with the existing library.read limit. */
export function widenLibraryReadAuthorizationLimit(
  database: Database.Database,
  appliedAt: string,
): void {
  if (database.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('v57 migration requires foreign keys to be enabled.');
  }
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_authorizations'",
    )
    .get() as { sql: string };
  if (!table.sql.includes(OLD_LIMIT) && !table.sql.includes(LIBRARY_LIMIT)) {
    throw new Error('v57 migration encountered an unexpected authorization schema.');
  }
  const objects = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'agent_tool_authorizations' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
    )
    .all() as Array<{ type: 'index' | 'trigger'; name: string; sql: string }>;
  const legacyAlterTable = database.pragma('legacy_alter_table', { simple: true }) as number;
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      // Keep references in tool audits and confirmations pointed at the original name.
      database.pragma('legacy_alter_table = ON');
      for (const object of objects) {
        database.exec(`DROP ${object.type} "${object.name.replaceAll('"', '""')}"`);
      }
      database.exec('ALTER TABLE agent_tool_authorizations RENAME TO __v56_old_authorizations');
      database.exec(table.sql.replace(OLD_LIMIT, LIBRARY_LIMIT));
      database.exec('INSERT INTO agent_tool_authorizations SELECT * FROM __v56_old_authorizations');
      for (const object of objects) database.exec(object.sql);
      database.exec('DROP TABLE __v56_old_authorizations');
      const foreignKeyErrors = database.pragma('foreign_key_check') as unknown[];
      if (foreignKeyErrors.length > 0) {
        throw new Error(
          `v57 migration produced ${foreignKeyErrors.length} foreign key violation(s).`,
        );
      }
      if (
        database
          .prepare("SELECT 1 FROM sqlite_master WHERE sql LIKE '%__v56_old_authorizations%'")
          .get()
      ) {
        throw new Error('v57 migration left stale authorization references.');
      }
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(57, appliedAt);
    })();
  } finally {
    database.pragma(`legacy_alter_table = ${legacyAlterTable}`);
    database.pragma('foreign_keys = ON');
  }
}
