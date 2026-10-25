import type Database from 'better-sqlite3';
import { validateProductionAuthoringIR } from '@ai-video/contracts';
import { SceneCharacterRepository } from '@ai-video/persistence';
import type {
  ProductionAuthoringIR,
  SceneCharacterBindingInfo,
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import { resolvedCast, productionReferenceImage } from './scene-cast-binding.js';
import { validateProductionIRReferences } from './project-ir-validation.js';

/** Project explicit IDs only; never interpret prompt text or open IR data. */
export function resolveIRSceneBindings(
  db: Database.Database,
  projectId: string,
  sceneId: string,
  ir: ProductionAuthoringIR,
  previous: {
    sceneDocumentId?: string;
    sceneDocumentIds?: string[];
    characterBindings?: SceneCharacterBindingInfo[];
    materialBindings?: SceneMaterialBindingInfo[];
  },
) {
  validateProductionIRReferences(db, projectId, ir);
  const refs = ir.references;
  const settings = refs?.sceneDocumentIds;
  const sceneDocumentIds =
    settings === undefined
      ? (previous.sceneDocumentIds ??
        (previous.sceneDocumentId ? [previous.sceneDocumentId] : undefined))
      : [...settings];
  // The legacy column can represent one setting only. Never select an arbitrary
  // setting when the IR explicitly references several locations.
  const sceneDocumentId =
    settings === undefined
      ? previous.sceneDocumentId
      : settings.length === 1
        ? settings[0]
        : settings.includes(previous.sceneDocumentId ?? '')
          ? previous.sceneDocumentId
          : undefined;
  const characterBindings =
    refs?.characterDocumentIds === undefined
      ? (previous.characterBindings ?? [])
      : resolvedCast(db, projectId, sceneId, refs.characterDocumentIds);
  const materials = (previous.materialBindings ?? []).filter((binding) => {
    if (binding.source === 'manual') return true;
    const ids =
      binding.role === 'scene'
        ? settings
        : binding.role === 'prop'
          ? refs?.propDocumentIds
          : undefined;
    return (
      ids === undefined ||
      Boolean(binding.sourceDocumentId && ids.includes(binding.sourceDocumentId))
    );
  });
  return {
    sceneDocumentId,
    sceneDocumentIds,
    characterBindings,
    materialBindings: resolveIRMaterialBindings(db, projectId, materials, ir),
  };
}

/** Resolve missing defaults at production time too, so later generated media is usable. */
export function resolveIRMaterialBindings(
  db: Database.Database,
  projectId: string,
  previous: SceneMaterialBindingInfo[],
  ...irs: Array<ProductionAuthoringIR | undefined>
): SceneMaterialBindingInfo[] {
  const materials = [...previous];
  for (const ir of irs) {
    for (const [field, role] of [
      ['sceneDocumentIds', 'scene'],
      ['propDocumentIds', 'prop'],
    ] as const) {
      for (const id of ir?.references?.[field] ?? []) {
        if (materials.some((b) => b.role === role && b.sourceDocumentId === id)) continue;
        const document = db
          .prepare(
            "SELECT title FROM documents WHERE id=? AND project_id=? AND kind=? AND lifecycle_status='active' AND NOT EXISTS(SELECT 1 FROM document_bindings b WHERE b.document_id=documents.id AND b.domain_scope='novel' AND b.status<>'archived')",
          )
          .get(id, projectId, role === 'scene' ? 'scene' : 'prop') as { title: string } | undefined;
        if (!document) continue;
        const image = productionReferenceImage(db, projectId, id);
        if (image)
          materials.push({
            id: `${role}:${id}`,
            role,
            label: document.title,
            assetId: image.id,
            sourceDocumentId: id,
            source: 'auto',
          });
      }
    }
  }
  return materials;
}

/** One-time, write-side compatibility repair. Explicit later unbinding stays unbound. */
export function repairIRSceneBindings(db: Database.Database): void {
  db.transaction(() => {
    const rows = db
      .prepare(
        'SELECT id,project_id,video_prompt,authoring_ir_json,scene_document_id,material_bindings_json FROM scenes WHERE authoring_bindings_applied=0',
      )
      .all() as Array<{
      id: string;
      project_id: string;
      video_prompt: string | null;
      authoring_ir_json: string | null;
      scene_document_id: string | null;
      material_bindings_json: string;
    }>;
    const cast = new SceneCharacterRepository(db);
    for (const row of rows) {
      let projected: ReturnType<typeof resolveIRSceneBindings> | undefined;
      const characters = cast.list(row.id);
      const materials = JSON.parse(row.material_bindings_json) as SceneMaterialBindingInfo[];
      try {
        if (row.authoring_ir_json) {
          const ir = validateProductionAuthoringIR(JSON.parse(row.authoring_ir_json), 'scene');
          if (ir.prompt === row.video_prompt) {
            validateProductionIRReferences(db, row.project_id, ir);
            projected = resolveIRSceneBindings(
              db,
              row.project_id,
              row.id,
              {
                ...ir,
                references: {
                  ...ir.references,
                  ...(characters.length ? { characterDocumentIds: undefined } : {}),
                },
              },
              {
                sceneDocumentId: row.scene_document_id ?? undefined,
                characterBindings: characters,
                materialBindings: materials,
              },
            );
          }
        }
      } catch {
        // Invalid/stale historic references remain inspectable, never guessed or partly applied.
      }
      if (
        projected &&
        (projected.sceneDocumentId !== (row.scene_document_id ?? undefined) ||
          JSON.stringify(projected.characterBindings) !== JSON.stringify(characters) ||
          JSON.stringify(projected.materialBindings) !== JSON.stringify(materials))
      ) {
        db.prepare(
          'UPDATE scenes SET scene_document_id=?,material_bindings_json=?,row_version=row_version+1,updated_at=? WHERE id=?',
        ).run(
          projected.sceneDocumentId ?? null,
          JSON.stringify(projected.materialBindings),
          new Date().toISOString(),
          row.id,
        );
        cast.replace(row.id, projected.characterBindings);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(
          new Date().toISOString(),
          row.project_id,
        );
      }
      db.prepare('UPDATE scenes SET authoring_bindings_applied=1 WHERE id=?').run(row.id);
    }
  })();
}
