import type Database from 'better-sqlite3';
import type { ShotContinuityBinding, ShotContinuityState } from '@ai-video/contracts';

export function readShotContinuity(
  database: Database.Database,
  projectId: string,
  shotId: string,
): ShotContinuityState {
  const row = database
    .prepare(
      'SELECT binding_json,row_version FROM shot_continuity WHERE shot_id=? AND project_id=?',
    )
    .get(shotId, projectId) as { binding_json: string | null; row_version: number } | undefined;
  return {
    shotId,
    rowVersion: row?.row_version ?? 0,
    ...(row?.binding_json
      ? { binding: JSON.parse(row.binding_json) as ShotContinuityBinding }
      : {}),
  };
}

export function writeShotContinuity(
  database: Database.Database,
  projectId: string,
  shotId: string,
  expectedRowVersion: number,
  binding: ShotContinuityBinding | undefined,
): ShotContinuityState {
  return database.transaction(() => {
    if (readShotContinuity(database, projectId, shotId).rowVersion !== expectedRowVersion)
      throw new Error('衔接设置已更新，请重新读取后再操作。');
    database
      .prepare(
        `INSERT INTO shot_continuity(shot_id,project_id,binding_json,row_version,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(shot_id) DO UPDATE SET
      binding_json=excluded.binding_json,row_version=excluded.row_version,updated_at=excluded.updated_at`,
      )
      .run(
        shotId,
        projectId,
        binding ? JSON.stringify(binding) : null,
        expectedRowVersion + 1,
        new Date().toISOString(),
      );
    return readShotContinuity(database, projectId, shotId);
  })();
}
