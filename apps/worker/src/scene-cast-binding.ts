import type Database from 'better-sqlite3';
import type { SceneCharacterBindingInfo } from '@ai-video/contracts';
import { SceneCharacterRepository, VoiceReferenceRepository } from '@ai-video/persistence';

/** Validate model-selected identities; prompt text is never used to infer a relationship. */
export function requireProductionCharacters(
  database: Database.Database,
  projectId: string,
  ids: unknown,
): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length)
    throw new Error('出场角色必须是不超过 30 个的唯一角色文档 ID。');
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim() || id.length > 200)
      throw new Error('角色文档 ID 无效。');
    const row = database
      .prepare(
        `SELECT d.id FROM documents d
      WHERE d.id=? AND d.project_id=? AND d.kind='character' AND d.lifecycle_status='active'
      AND NOT EXISTS(SELECT 1 FROM novel_chapters WHERE document_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM document_bindings WHERE document_id=d.id AND domain_scope='novel' AND status<>'archived')`,
      )
      .get(id, projectId);
    if (!row) throw new Error('只能绑定当前项目中有效的制作角色资料。');
  }
}

/** Retain explicit media selections for existing cast; initialize media only for newly bound IDs. */
export function resolvedCast(
  database: Database.Database,
  projectId: string,
  sceneId: string,
  ids: string[],
): SceneCharacterBindingInfo[] {
  requireProductionCharacters(database, projectId, ids);
  const previous = new SceneCharacterRepository(database).list(sceneId);
  const speakers = database
    .prepare(
      `SELECT DISTINCT character_document_id AS id FROM dubbing_cues
    WHERE scene_id=? AND deleted_at IS NULL AND speaker_kind='character'`,
    )
    .all(sceneId) as Array<{ id: string }>;
  if (speakers.some((speaker) => !ids.includes(speaker.id)))
    throw new Error('角色仍有本场台词，请先移除或更改对应台词。');
  const voices = new VoiceReferenceRepository(database, projectId).list();
  return ids.map((id) => {
    const existing = previous.find((item) => item.characterDocumentId === id);
    if (existing) return existing;
    const voice = voices.find((item) => item.characterDocumentId === id);
    const image = productionReferenceImage(database, projectId, id);
    return {
      characterDocumentId: id,
      ...(image ? { imageAssetId: image.id } : {}),
      ...(voice ? { voiceReferenceVersionId: voice.versionId } : {}),
    };
  });
}

export function productionReferenceImage(
  database: Database.Database,
  projectId: string,
  documentId: string,
): { id: string } | undefined {
  return database
    .prepare(
      `SELECT a.id FROM assets a
      JOIN generation_results r ON r.asset_id=a.id
      JOIN generation_jobs j ON j.id=r.job_id AND j.project_id=a.project_id
      WHERE a.project_id=? AND a.deleted_at IS NULL AND lower(a.kind) NOT LIKE '%video%'
        AND json_extract(j.task_snapshot_json,'$.sourceDocumentId')=?
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,
    )
    .get(projectId, documentId) as { id: string } | undefined;
}
