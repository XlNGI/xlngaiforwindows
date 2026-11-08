import { productionShotReferenceIds, type ShotInfo } from '@ai-video/contracts';

export type ShotBindingRole = 'character' | 'scene' | 'prop';

export interface ShotBindingSummaryEntry {
  role: ShotBindingRole;
  documentId: string;
  shotIds: string[];
  shotTitles: string[];
  assetIds: string[];
}

export type ShotReferenceDocumentIds = {
  characterDocumentIds: string[];
  sceneDocumentIds: string[];
  propDocumentIds: string[];
};

export function shotReferenceDocumentIdsByScene(
  scenes: Array<{ id: string }>,
  shotsByScene: Map<string, ShotInfo[]>,
): Record<string, ShotReferenceDocumentIds> {
  return Object.fromEntries(
    scenes.flatMap((scene) => {
      const ids = {
        characterDocumentIds: new Set<string>(),
        sceneDocumentIds: new Set<string>(),
        propDocumentIds: new Set<string>(),
      };
      for (const shot of shotsByScene.get(scene.id) ?? []) {
        const references = productionShotReferenceIds(shot);
        for (const id of references.characterDocumentIds) ids.characterDocumentIds.add(id);
        for (const id of references.sceneDocumentIds) ids.sceneDocumentIds.add(id);
        for (const id of references.propDocumentIds) ids.propDocumentIds.add(id);
      }
      return ids.characterDocumentIds.size || ids.sceneDocumentIds.size || ids.propDocumentIds.size
        ? [
            [
              scene.id,
              {
                characterDocumentIds: [...ids.characterDocumentIds],
                sceneDocumentIds: [...ids.sceneDocumentIds],
                propDocumentIds: [...ids.propDocumentIds],
              },
            ],
          ]
        : [];
    }),
  );
}

/** Scene pages display the union of shot-authored references, never scene-owned bindings. */
export function aggregateShotBindings(shots: ShotInfo[]): ShotBindingSummaryEntry[] {
  const entries = new Map<string, ShotBindingSummaryEntry>();
  for (const shot of shots) {
    const references = productionShotReferenceIds(shot);
    const idsByRole: Record<ShotBindingRole, string[]> = {
      character: references.characterDocumentIds,
      scene: references.sceneDocumentIds,
      prop: references.propDocumentIds,
    };
    const assetsByDocument = new Map<string, string[]>();
    for (const binding of shot.referenceBindings?.characterBindings ?? [])
      assetsByDocument.set(binding.characterDocumentId, [
        ...(assetsByDocument.get(binding.characterDocumentId) ?? []),
        binding.assetId,
      ]);
    for (const binding of shot.referenceBindings?.sceneBindings ?? [])
      assetsByDocument.set(binding.sourceDocumentId, [
        ...(assetsByDocument.get(binding.sourceDocumentId) ?? []),
        binding.assetId,
      ]);

    for (const role of ['character', 'scene', 'prop'] as const) {
      for (const documentId of new Set(idsByRole[role])) {
        const key = `${role}:${documentId}`;
        const entry = entries.get(key) ?? {
          role,
          documentId,
          shotIds: [],
          shotTitles: [],
          assetIds: [],
        };
        if (!entry.shotIds.includes(shot.id)) {
          entry.shotIds.push(shot.id);
          entry.shotTitles.push(shot.title);
        }
        const explicitIds = assetsByDocument.get(documentId) ?? [];
        for (const assetId of explicitIds)
          if (!entry.assetIds.includes(assetId)) entry.assetIds.push(assetId);
        entries.set(key, entry);
      }
    }
  }

  return [...entries.values()];
}
