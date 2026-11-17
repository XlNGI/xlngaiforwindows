import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ProductionImageSelection } from '@ai-video/contracts';
import { readShotContinuity, readShotImage } from '@ai-video/persistence';

/** Source fingerprints exclude authored text and adopted outputs so these remain independent. */
export function shotImageSourceToken(
  db: Database.Database,
  projectId: string,
  shotId: string,
  inputImages: ProductionImageSelection[],
) {
  const image = readShotImage(db, projectId, shotId);
  const binding = readShotContinuity(db, projectId, shotId).binding;
  const source = binding && {
    frames: binding.frames,
    images: binding.sourceImages,
    videos: binding.sourceVideos,
    anchor: binding.anchorAssetId,
    sourceHash: binding.sourceVideoHash,
  };
  const assets = inputImages.map(
    (input) =>
      db
        .prepare(
          'SELECT id,content_hash,relative_path,deleted_at FROM assets WHERE id=? AND project_id=?',
        )
        .get(input.assetId, projectId) ?? null,
  );
  const shot = db.prepare('SELECT row_version FROM shots WHERE id=?').get(shotId);
  const documentIds = [
    ...new Set([
      ...(image.bindings?.characterDocumentIds ?? []),
      ...(image.bindings?.sceneDocumentIds ?? []),
      ...(image.bindings?.propDocumentIds ?? []),
    ]),
  ];
  const documents = documentIds.map(
    (id) =>
      db
        .prepare(
          'SELECT id,current_version_id,published_version_id,lifecycle_status FROM documents WHERE id=? AND project_id=?',
        )
        .get(id, projectId) ?? null,
  );
  return createHash('sha256')
    .update(
      JSON.stringify([
        projectId,
        shotId,
        shot,
        image.bindings,
        documents,
        source,
        inputImages,
        assets,
      ]),
    )
    .digest('hex');
}
