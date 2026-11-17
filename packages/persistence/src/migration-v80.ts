import type Database from 'better-sqlite3';
import {
  continuityReferenceImageIds,
  type ShotContinuityBinding,
  type ProductionImageSelection,
} from '@ai-video/contracts';

export function applyMigrationV80(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shot_image_prompts (
      shot_id TEXT PRIMARY KEY REFERENCES shots(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT 'composition' CHECK(purpose IN ('composition','first-frame','last-frame')),
      intent TEXT NOT NULL DEFAULT '',
      bindings_json TEXT CHECK(bindings_json IS NULL OR json_valid(bindings_json)),
      source_token TEXT,
      legacy_prompt TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shot_video_images (
      shot_id TEXT PRIMARY KEY REFERENCES shots(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      selections_json TEXT NOT NULL CHECK(json_valid(selections_json)),
      conflicts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conflicts_json)),
      row_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO shot_image_prompts(shot_id,project_id,prompt,intent,legacy_prompt,updated_at)
    SELECT shot_id,project_id,json_extract(binding_json,'$.imagePrompt'),
      COALESCE(json_extract(binding_json,'$.notes'),''),json_extract(binding_json,'$.imagePrompt'),updated_at
    FROM shot_continuity WHERE json_valid(binding_json) AND json_type(binding_json,'$.imagePrompt')='text';
  `);
  for (const table of ['shot_image_prompts', 'shot_video_images'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_project_insert BEFORE INSERT ON ${table}
    WHEN NOT EXISTS(SELECT 1 FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=NEW.shot_id AND c.project_id=NEW.project_id)
    BEGIN SELECT RAISE(ABORT,'shot image project mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_project_update BEFORE UPDATE OF shot_id,project_id ON ${table}
    WHEN NOT EXISTS(SELECT 1 FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=NEW.shot_id AND c.project_id=NEW.project_id)
    BEGIN SELECT RAISE(ABORT,'shot image project mismatch'); END;
  `);
  const rows = db
    .prepare(
      `SELECT s.id,c.project_id,k.binding_json,r.bindings_json FROM shots s JOIN scenes c ON c.id=s.scene_id
    LEFT JOIN shot_continuity k ON k.shot_id=s.id LEFT JOIN shot_reference_bindings r ON r.shot_id=s.id
    WHERE k.binding_json IS NOT NULL OR r.bindings_json IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    project_id: string;
    binding_json: string | null;
    bindings_json: string | null;
  }>;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO shot_video_images(shot_id,project_id,selections_json,conflicts_json,updated_at) VALUES(?,?,?,?,?)',
  );
  for (const row of rows) {
    const continuity = row.binding_json
      ? (JSON.parse(row.binding_json) as ShotContinuityBinding)
      : undefined;
    const manual = row.bindings_json
      ? (JSON.parse(row.bindings_json) as { firstFrameAssetId?: string })
      : undefined;
    if (!continuity && !manual?.firstFrameAssetId) continue;
    const conflicts: string[] = [];
    if (
      continuity?.firstFrameAssetId &&
      manual?.firstFrameAssetId &&
      continuity.firstFrameAssetId !== manual.firstFrameAssetId
    )
      conflicts.push(
        `旧首帧绑定冲突：${manual.firstFrameAssetId} / ${continuity.firstFrameAssetId}，请明确确认用途。`,
      );
    const first = continuity?.firstFrameAssetId ?? manual?.firstFrameAssetId;
    const ids = [
      ...new Set([
        ...(continuity ? continuityReferenceImageIds(continuity) : []),
        ...(manual?.firstFrameAssetId ? [manual.firstFrameAssetId] : []),
        ...(first ? [first] : []),
      ]),
    ];
    const selections: ProductionImageSelection[] = ids.map((assetId) => ({
      assetId,
      role: assetId === first ? 'first-frame' : 'reference',
    }));
    insert.run(
      row.id,
      row.project_id,
      JSON.stringify(selections),
      JSON.stringify(conflicts),
      new Date().toISOString(),
    );
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS shot_video_images_new_shot AFTER INSERT ON shots
    BEGIN INSERT INTO shot_video_images(shot_id,project_id,selections_json,row_version,updated_at)
      SELECT NEW.id,project_id,'[]',0,datetime('now') FROM scenes WHERE id=NEW.scene_id;
    END;`);
}
