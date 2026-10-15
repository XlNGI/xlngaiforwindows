import type Database from 'better-sqlite3';
import type { SceneCharacterBindingInfo } from '@ai-video/contracts';

export class SceneCharacterRepository {
  constructor(private readonly database: Database.Database) {}

  list(sceneId: string): SceneCharacterBindingInfo[] {
    const rows = this.database
      .prepare(
        `SELECT character_document_id AS characterDocumentId,
      image_asset_id AS imageAssetId,voice_reference_version_id AS voiceReferenceVersionId
      FROM scene_character_bindings WHERE scene_id=? ORDER BY position,character_document_id`,
      )
      .all(sceneId) as Array<{
      characterDocumentId: string;
      imageAssetId: string | null;
      voiceReferenceVersionId: string | null;
    }>;
    return rows.map((row) => ({
      characterDocumentId: row.characterDocumentId,
      ...(row.imageAssetId ? { imageAssetId: row.imageAssetId } : {}),
      ...(row.voiceReferenceVersionId
        ? { voiceReferenceVersionId: row.voiceReferenceVersionId }
        : {}),
    }));
  }

  replace(sceneId: string, bindings: SceneCharacterBindingInfo[]): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM scene_character_bindings WHERE scene_id=?').run(sceneId);
      const insert = this.database.prepare(`INSERT INTO scene_character_bindings
        (scene_id,character_document_id,image_asset_id,voice_reference_version_id,position) VALUES (?,?,?,?,?)`);
      bindings.forEach((binding, index) =>
        insert.run(
          sceneId,
          binding.characterDocumentId,
          binding.imageAssetId ?? null,
          binding.voiceReferenceVersionId ?? null,
          index,
        ),
      );
    })();
  }
}
