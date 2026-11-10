/** Shared tool capabilities only; domain authorization/CAS remain in their services. */
export const DELIVERY_CAPABILITIES = {
  'document.submit_draft': { kind: 'document', create: true, prepared: true },
  'novel.chapter.write_draft': { kind: 'document', create: true, prepared: true },
  'scene.submit_structure': { kind: 'structure', create: true, prepared: true },
  'scene.structure.stage': { kind: 'structure', create: true, prepared: true },
  'novel.episode.submit_structure': { kind: 'structure', create: false, prepared: false },
  'scene.update_shot_prompts': { kind: 'shot', create: false, prepared: true },
  'scene.update_shot_timings': { kind: 'shot', create: false, prepared: true },
} as const;

export type DeliveryTool = keyof typeof DELIVERY_CAPABILITIES;
export const DELIVERY_TOOLS = Object.keys(DELIVERY_CAPABILITIES) as DeliveryTool[];
export const DOCUMENT_DELIVERY_TOOLS = DELIVERY_TOOLS.filter(isDocumentDeliveryTool);
export const CREATION_DELIVERY_TOOLS = DELIVERY_TOOLS.filter(
  (name) => DELIVERY_CAPABILITIES[name].create,
);
export const PREPARED_DELIVERY_TOOLS = DELIVERY_TOOLS.filter(
  (name) => DELIVERY_CAPABILITIES[name].prepared,
);
export function isDocumentDeliveryTool(tool: string): boolean {
  return DELIVERY_CAPABILITIES[tool as DeliveryTool]?.kind === 'document';
}

/** Explicit removal is restricted to optional caller-owned fields, never arbitrary paths. */
export const PREPARED_DELETABLE_FIELDS = new Set([
  'documentId',
  'chapterId',
  'volumeId',
  'displayLabel',
  'baseVersionId',
  'expectedRevision',
  'expectedChapterRowVersion',
  'expectedDocumentRowVersion',
  'expectedRowVersion',
  'outputId',
  'outputKey',
  'outputIndex',
  'bindingRole',
]);

/** These misplaced root fields are not part of the staging envelope. */
export function preparedDeletableFields(tool: string): ReadonlySet<string> {
  if (tool === 'production.bundle' || tool === 'production.bundle.submit') return new Set();
  return tool === 'scene.structure.stage'
    ? new Set([...PREPARED_DELETABLE_FIELDS, 'title', 'sceneDocumentId', 'characterDocumentIds'])
    : PREPARED_DELETABLE_FIELDS;
}
