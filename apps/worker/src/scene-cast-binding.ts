import type Database from 'better-sqlite3';
import type { SceneCharacterBindingInfo } from '@ai-video/contracts';
import { SceneCharacterRepository } from '@ai-video/persistence';

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
  return ids.map((id) => {
    const existing = previous.find((item) => item.characterDocumentId === id);
    if (existing) return existing;
    return {
      characterDocumentId: id,
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

/** Validate a manually selected image without guessing imported-file provenance. */
export function validateProductionImageBinding(
  database: Database.Database,
  projectId: string,
  assetId: string,
  sourceDocumentId: string,
  expectedKind: 'character' | 'scene' | 'prop',
): void {
  const document = database
    .prepare(
      `SELECT id FROM documents
       WHERE id=? AND project_id=? AND kind=? AND lifecycle_status='active'
         AND NOT EXISTS(
           SELECT 1 FROM document_bindings b
           WHERE b.document_id=documents.id AND b.domain_scope='novel' AND b.status<>'archived'
         )`,
    )
    .get(sourceDocumentId, projectId, expectedKind);
  if (!document) throw new Error('参考图来源文档类型与绑定角色不一致。');

  const asset = database
    .prepare(
      `SELECT id FROM assets
       WHERE id=? AND project_id=? AND deleted_at IS NULL
         AND lower(kind) NOT LIKE '%video%'`,
    )
    .get(assetId, projectId);
  if (!asset) throw new Error('绑定的参考图不是当前项目中的有效图片。');

  const provenance = database
    .prepare(
      `SELECT DISTINCT json_extract(j.task_snapshot_json,'$.sourceDocumentId') AS sourceDocumentId
       FROM generation_results r
       JOIN generation_jobs j ON j.id=r.job_id AND j.project_id=?
       WHERE r.asset_id=? AND json_extract(j.task_snapshot_json,'$.sourceDocumentId') IS NOT NULL`,
    )
    .all(projectId, assetId) as Array<{ sourceDocumentId: string | null }>;
  const knownSources = provenance
    .map((row) => row.sourceDocumentId)
    .filter((id): id is string => Boolean(id));
  if (knownSources.length && !knownSources.includes(sourceDocumentId))
    throw new Error('参考图不是该角色、场景或道具文档生成的素材。');
}
