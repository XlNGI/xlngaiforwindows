import type {
  DocumentSummary,
  SceneCharacterBindingInfo,
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';

/** Keep one ordered image list for UI seeds and provider numbering. */
export function sceneReferenceBindings(
  materials: SceneMaterialBindingInfo[],
  cast: SceneCharacterBindingInfo[],
  documents: DocumentSummary[],
): SceneMaterialBindingInfo[] {
  return [
    ...materials.filter((item) => item.role !== 'character'),
    ...cast.flatMap((character) =>
      character.imageAssetId
        ? [
            {
              id: `character:${character.characterDocumentId}`,
              role: 'character' as const,
              label:
                documents.find((document) => document.id === character.characterDocumentId)
                  ?.title ?? character.characterDocumentId,
              assetId: character.imageAssetId,
              sourceDocumentId: character.characterDocumentId,
              source: 'manual' as const,
            },
          ]
        : [],
    ),
  ];
}
