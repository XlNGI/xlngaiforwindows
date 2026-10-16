import type {
  AssetInfo,
  SceneMediaResolveParams,
  SceneMediaResolveResult,
} from '@ai-video/contracts';
import { VoiceReferenceRepository } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

/** Resolve a bounded scene projection, independently of library pagination. No filesystem reads. */
export function resolveSceneMedia(
  projects: ProjectService,
  input: SceneMediaResolveParams,
): SceneMediaResolveResult {
  return projects.access(false, (db, project) => {
    const ids = input.characterDocumentIds;
    const documents = ids.length
      ? (db
          .prepare(
            `
      SELECT d.id,d.lifecycle_status AS status,
        (SELECT current_version_id FROM character_voice_references WHERE project_id=d.project_id AND character_document_id=d.id) AS voiceVersionId,
        (SELECT a.id FROM generation_jobs j JOIN generation_results r ON r.job_id=j.id
         JOIN assets a ON a.id=r.asset_id AND a.project_id=j.project_id
         WHERE j.project_id=d.project_id AND json_extract(j.task_snapshot_json,'$.sourceDocumentId')=d.id
           AND a.deleted_at IS NULL AND lower(a.kind) NOT LIKE '%video%'
         ORDER BY a.created_at,a.id LIMIT 1) AS imageId
      FROM documents d WHERE d.project_id=? AND d.kind='character' AND d.id IN (${ids.map(() => '?').join(',')})
        AND NOT EXISTS(SELECT 1 FROM document_bindings b WHERE b.document_id=d.id AND b.domain_scope='novel' AND b.status<>'archived')
    `,
          )
          .all(project.id, ...ids) as Array<{
          id: string;
          status: string;
          imageId: string | null;
          voiceVersionId: string | null;
        }>)
      : [];
    const related = ids.length
      ? (db
          .prepare(
            `WITH ranked AS (
      SELECT a.id,json_extract(j.task_snapshot_json,'$.sourceDocumentId') AS documentId,
        ROW_NUMBER() OVER (PARTITION BY json_extract(j.task_snapshot_json,'$.sourceDocumentId') ORDER BY a.created_at DESC,a.id DESC) AS position
      FROM generation_jobs j JOIN generation_results r ON r.job_id=j.id JOIN assets a ON a.id=r.asset_id AND a.project_id=j.project_id
      WHERE j.project_id=? AND json_extract(j.task_snapshot_json,'$.sourceDocumentId') IN (${ids.map(() => '?').join(',')})
        AND a.deleted_at IS NULL AND lower(a.kind) NOT LIKE '%video%'
    ) SELECT id,documentId FROM ranked WHERE position<=8`,
          )
          .all(project.id, ...ids) as Array<{ id: string; documentId: string }>)
      : [];
    const assetIds = [
      ...new Set([
        ...(input.assetIds ?? []),
        ...related.map((a) => a.id),
        ...documents
          .filter((d) => d.status === 'active')
          .flatMap((d) => (d.imageId ? [d.imageId] : [])),
      ]),
    ];
    const assets = assetIds.length
      ? (db
          .prepare(
            `SELECT id,project_id AS projectId,kind,relative_path AS relativePath,
      content_hash AS contentHash,size_bytes AS sizeBytes,alias,created_at AS createdAt,updated_at AS updatedAt
      FROM assets WHERE project_id=? AND deleted_at IS NULL AND lower(kind) NOT LIKE '%video%'
      AND id IN (${assetIds.map(() => '?').join(',')})`,
          )
          .all(project.id, ...assetIds) as AssetInfo[])
      : [];
    const voices = new VoiceReferenceRepository(db, project.id).forCharacters(
      documents.map((d) => d.id),
      input.voiceVersionIds,
    );
    return {
      assets,
      voices,
      characters: ids.map((id) => {
        const document = documents.find((d) => d.id === id);
        return {
          characterDocumentId: id,
          ...(document?.status === 'active'
            ? {
                defaultImage: assets.find((a) => a.id === document.imageId),
                images: assets.filter(
                  (a) =>
                    a.id === document.imageId ||
                    related.some((r) => r.documentId === id && r.id === a.id),
                ),
                voice: voices.find(
                  (v) => v.versionId === document.voiceVersionId && v.characterDocumentId === id,
                ),
              }
            : {}),
        };
      }),
    };
  });
}
