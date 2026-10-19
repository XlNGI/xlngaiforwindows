import type Database from 'better-sqlite3';

/** One project business queue across domains; completed outputs and human review release execution admission. */
export function assertProjectTaskAdmission(database: Database.Database, additional = 1): void {
  const row = database
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM llm_generations WHERE status IN ('prepared','streaming'))+
    (SELECT COUNT(*) FROM generation_jobs WHERE media_state IN ('awaiting_confirmation','submitting','submission_unknown','polling','downloading','validating','committing'))+
    (SELECT COUNT(*) FROM dubbing_jobs WHERE status IN ('pending','running','interrupted','cancelling','submission_unknown'))+
    (SELECT COUNT(*) FROM markdown_export_jobs WHERE status IN('queued','writing','verifying')) AS n`,
    )
    .get() as { n: number };
  const files = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name='file_tasks' AND type='table'")
    .get()
    ? (
        database
          .prepare("SELECT COUNT(*) AS n FROM file_tasks WHERE status IN ('pending','running')")
          .get() as { n: number }
      ).n
    : 0;
  if (row.n + files + additional > 32) throw new Error('Project task queue is full (32).');
}
