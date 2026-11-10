import type Database from 'better-sqlite3';

/** Wall-clock observation; local operation durations use the separate monotonic metrics. */
export function bundleTiming(db: Database.Database, projectId: string, taskId: string) {
  const row = db
    .prepare(
      'SELECT created_at,completed_at,request_snapshot_json FROM agent_tasks WHERE id=? AND project_id=?',
    )
    .get(taskId, projectId) as {
    created_at: string;
    completed_at: string | null;
    request_snapshot_json: string;
  };
  const snapshot = JSON.parse(row.request_snapshot_json) as { productionRequestedAt?: string };
  const created = Date.parse(row.created_at),
    requested = Date.parse(snapshot.productionRequestedAt ?? '');
  // Clock skew must not produce negative preparation or a fabricated click measurement.
  const requestedAt =
    Number.isFinite(requested) && requested <= created ? snapshot.productionRequestedAt : undefined;
  return {
    ...(requestedAt ? { requestedAt, preparationMs: created - requested } : {}),
    taskCreatedAt: row.created_at,
    elapsedMs: Math.max(
      0,
      Date.parse(row.completed_at ?? new Date().toISOString()) -
        (requestedAt ? requested : created),
    ),
  };
}
