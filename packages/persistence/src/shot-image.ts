import type Database from 'better-sqlite3';
import type {
  ShotImageRecord,
  ShotImageSaveParams,
  ShotVideoImages,
  ProductionImageSelection,
} from '@ai-video/contracts';

export function readShotImage(
  db: Database.Database,
  projectId: string,
  shotId: string,
): ShotImageRecord {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='shot_image_prompts'").get()) {
    const legacy = db
      .prepare('SELECT binding_json FROM shot_continuity WHERE shot_id=? AND project_id=?')
      .get(shotId, projectId) as { binding_json: string | null } | undefined;
    const binding = legacy?.binding_json
      ? (JSON.parse(legacy.binding_json) as { imagePrompt?: string; notes?: string })
      : undefined;
    return {
      shotId,
      prompt: binding?.imagePrompt ?? '',
      purpose: 'composition',
      intent: binding?.notes ?? '',
      rowVersion: 0,
      ...(binding?.imagePrompt !== undefined ? { legacyPrompt: binding.imagePrompt } : {}),
    };
  }
  const row = db
    .prepare('SELECT * FROM shot_image_prompts WHERE shot_id=? AND project_id=?')
    .get(shotId, projectId) as
    | {
        prompt: string;
        purpose: ShotImageRecord['purpose'];
        intent: string;
        bindings_json: string | null;
        source_token: string | null;
        row_version: number;
        legacy_prompt: string | null;
      }
    | undefined;
  return {
    shotId,
    prompt: row?.prompt ?? '',
    purpose: row?.purpose ?? 'composition',
    intent: row?.intent ?? '',
    rowVersion: row?.row_version ?? 0,
    ...(row?.bindings_json
      ? { bindings: JSON.parse(row.bindings_json) as NonNullable<ShotImageRecord['bindings']> }
      : {}),
    ...(row?.source_token ? { sourceToken: row.source_token } : {}),
    ...(row?.legacy_prompt !== null && row?.legacy_prompt !== undefined
      ? { legacyPrompt: row.legacy_prompt }
      : {}),
  };
}
export function writeShotImage(
  db: Database.Database,
  projectId: string,
  params: ShotImageSaveParams,
): ShotImageRecord {
  return db.transaction(() => {
    const before = readShotImage(db, projectId, params.shotId);
    if (before.rowVersion !== params.expectedRowVersion)
      throw new Error('图片提示词已更新，请重新读取后保存；当前草稿已保留。');
    db.prepare(
      `INSERT INTO shot_image_prompts(shot_id,project_id,prompt,purpose,intent,bindings_json,source_token,row_version,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(shot_id) DO UPDATE SET prompt=excluded.prompt,purpose=excluded.purpose,intent=excluded.intent,
      bindings_json=excluded.bindings_json,source_token=excluded.source_token,row_version=excluded.row_version,updated_at=excluded.updated_at`,
    ).run(
      params.shotId,
      projectId,
      params.prompt,
      params.purpose,
      params.intent,
      JSON.stringify(params.bindings ?? before.bindings) ?? null,
      params.sourceToken,
      before.rowVersion + 1,
      new Date().toISOString(),
    );
    return readShotImage(db, projectId, params.shotId);
  })();
}
export function readShotVideoImages(
  db: Database.Database,
  projectId: string,
  shotId: string,
): ShotVideoImages {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='shot_video_images'").get())
    return { shotId, rowVersion: 0, conflicts: [] };
  const row = db
    .prepare(
      'SELECT selections_json,conflicts_json,row_version FROM shot_video_images WHERE shot_id=? AND project_id=?',
    )
    .get(shotId, projectId) as
    { selections_json: string; conflicts_json: string; row_version: number } | undefined;
  const selections = row
    ? (JSON.parse(row.selections_json) as ProductionImageSelection[])
    : undefined;
  const conflicts = row ? (JSON.parse(row.conflicts_json) as string[]) : [];
  // The new-shot trigger reserves version 0; it is not a user-confirmed clear.
  // Keep existing placeholder rows compatible without rewriting project data.
  const placeholder = row?.row_version === 0 && !selections?.length && !conflicts.length;
  return {
    shotId,
    rowVersion: row?.row_version ?? 0,
    conflicts,
    ...(selections && !placeholder ? { selections } : {}),
  };
}
export function writeShotVideoImages(
  db: Database.Database,
  projectId: string,
  shotId: string,
  expectedRowVersion: number,
  selections: ProductionImageSelection[],
): ShotVideoImages {
  return db.transaction(() => {
    if (readShotVideoImages(db, projectId, shotId).rowVersion !== expectedRowVersion)
      throw new Error('视频采用图片已更新，请重新读取后再确认。');
    db.prepare(
      `INSERT INTO shot_video_images(shot_id,project_id,selections_json,row_version,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(shot_id) DO UPDATE SET selections_json=excluded.selections_json,conflicts_json='[]',row_version=excluded.row_version,updated_at=excluded.updated_at`,
    ).run(
      shotId,
      projectId,
      JSON.stringify(selections),
      expectedRowVersion + 1,
      new Date().toISOString(),
    );
    return readShotVideoImages(db, projectId, shotId);
  })();
}
