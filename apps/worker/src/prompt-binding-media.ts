import type Database from 'better-sqlite3';
import type {
  PromptBindingIR,
  SceneCharacterBindingInfo,
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import { resolvedCast, productionReferenceImage } from './scene-cast-binding.js';
import { validatePromptBindingReferences } from './prompt-binding-validation.js';

export function resolvePromptSceneBindings(
  db: Database.Database,
  projectId: string,
  sceneId: string,
  bindings: PromptBindingIR,
  previous: {
    sceneDocumentId?: string;
    sceneDocumentIds?: string[];
    characterBindings?: SceneCharacterBindingInfo[];
    materialBindings?: SceneMaterialBindingInfo[];
  },
) {
  validatePromptBindingReferences(db, projectId, bindings);
  const sceneDocumentIds =
    bindings.sceneDocumentIds ??
    previous.sceneDocumentIds ??
    (previous.sceneDocumentId ? [previous.sceneDocumentId] : []);
  const materials = (previous.materialBindings ?? []).filter(
    (item) =>
      item.source === 'manual' ||
      (item.role === 'scene'
        ? bindings.sceneDocumentIds
        : item.role === 'prop'
          ? bindings.propDocumentIds
          : undefined
      )?.includes(item.sourceDocumentId ?? '') !== false,
  );
  return {
    sceneDocumentIds,
    sceneDocumentId: sceneDocumentIds.length === 1 ? sceneDocumentIds[0] : undefined,
    characterBindings:
      bindings.characterDocumentIds === undefined
        ? (previous.characterBindings ?? [])
        : resolvedCast(db, projectId, sceneId, bindings.characterDocumentIds),
    materialBindings: resolvePromptMaterialBindings(db, projectId, materials, bindings),
  };
}

/** Resolve media from explicit prompt IDs, including media created after a binding was saved. */
export function resolvePromptMaterialBindings(
  db: Database.Database,
  projectId: string,
  previous: SceneMaterialBindingInfo[],
  ...scopes: Array<PromptBindingIR | undefined>
): SceneMaterialBindingInfo[] {
  const result = [...previous];
  for (const bindings of scopes)
    for (const [field, role] of [
      ['sceneDocumentIds', 'scene'],
      ['propDocumentIds', 'prop'],
    ] as const)
      for (const id of bindings?.[field] ?? []) {
        if (result.some((item) => item.role === role && item.sourceDocumentId === id)) continue;
        const document = db
          .prepare(
            "SELECT title FROM documents WHERE id=? AND project_id=? AND kind=? AND lifecycle_status='active'",
          )
          .get(id, projectId, role) as { title: string } | undefined;
        const image = document && productionReferenceImage(db, projectId, id);
        if (document && image)
          result.push({
            id: `${role}:${id}`,
            role,
            label: document.title,
            assetId: image.id,
            sourceDocumentId: id,
            source: 'auto',
          });
      }
  return result;
}
