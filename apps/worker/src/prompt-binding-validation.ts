import type Database from 'better-sqlite3';
import { validatePromptBindings, type PromptBindingIR } from '@ai-video/contracts';

/** IDs are authoritative. Prompt text and names never create relationships. */
export function validatePromptBindingReferences(
  db: Database.Database,
  projectId: string,
  value: PromptBindingIR,
): void {
  const bindings = validatePromptBindings(value);
  const find = db.prepare(`SELECT 1 FROM documents d WHERE d.id=? AND d.project_id=? AND d.kind=?
    AND d.lifecycle_status='active' AND NOT EXISTS(SELECT 1 FROM document_bindings b
    WHERE b.document_id=d.id AND b.domain_scope='novel' AND b.status<>'archived')`);
  const require = (id: string, kind: string, field: string) => {
    if (!find.get(id, projectId, kind))
      throw new Error(
        `INVALID_BINDING_REFERENCE: ${field}: ${id} must be an active ${kind} document in this project.`,
      );
  };
  for (const [field, kind] of [
    ['characterDocumentIds', 'character'],
    ['sceneDocumentIds', 'scene'],
    ['propDocumentIds', 'prop'],
  ] as const)
    for (const id of bindings[field] ?? []) require(id, kind, field);
  if (bindings.voiceDocumentId) require(bindings.voiceDocumentId, 'voice', 'voiceDocumentId');
  for (const relation of bindings.voiceBindings ?? []) {
    require(relation.voiceDocumentId, 'voice', 'voiceBindings.voiceDocumentId');
    if (relation.characterDocumentId)
      require(relation.characterDocumentId, 'character', 'voiceBindings.characterDocumentId');
  }
}
