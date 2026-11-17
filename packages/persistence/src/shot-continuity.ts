import type Database from 'better-sqlite3';
import type { ShotContinuityBinding, ShotContinuityState } from '@ai-video/contracts';
import { readShotImage, readShotVideoImages } from './shot-image.js';

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
  const binding = row?.binding_json
    ? (JSON.parse(row.binding_json) as ShotContinuityBinding)
    : undefined;
  // Read-only legacy databases may predate the independent authoring tables.
  const migrated = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE name='shot_image_prompts'").get(),
  );
  if (binding && migrated) {
    binding.imagePrompt = readShotImage(database, projectId, shotId).prompt;
    const adopted = readShotVideoImages(database, projectId, shotId);
    if (adopted.selections !== undefined) {
      binding.referenceAssetIds = adopted.selections
        .filter((image) => image.role !== 'first-frame')
        .map((image) => image.assetId);
      binding.firstFrameAssetId = adopted.selections.find(
        (image) => image.role === 'first-frame',
      )?.assetId;
      if (
        !binding.referenceAssetId ||
        !binding.referenceAssetIds.includes(binding.referenceAssetId)
      ) {
        binding.referenceAssetId = undefined;
        binding.referenceRole = undefined;
      }
    }
  }
  return {
    shotId,
    rowVersion: row?.row_version ?? 0,
    ...(binding ? { binding } : {}),
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
