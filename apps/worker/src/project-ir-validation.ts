import type Database from 'better-sqlite3';
import type { ProductionAuthoringIR } from '@ai-video/contracts';

/** Validate authored document references without interpreting their contents. */
export function validateProductionIRReferences(
  database: Database.Database,
  projectId: string,
  ir: ProductionAuthoringIR,
): void {
  const references = ir.references ?? {};
  const expected: Array<
    [
      'characterDocumentIds' | 'sceneDocumentIds' | 'propDocumentIds',
      'character' | 'scene' | 'prop',
    ]
  > = [
    ['characterDocumentIds', 'character'],
    ['sceneDocumentIds', 'scene'],
    ['propDocumentIds', 'prop'],
  ];
  const find = database.prepare(
    `SELECT 1 FROM documents d WHERE d.id=? AND d.project_id=? AND d.kind=?
     AND d.lifecycle_status='active'
     AND NOT EXISTS(
       SELECT 1 FROM document_bindings b
       WHERE b.document_id=d.id AND b.domain_scope='novel' AND b.status<>'archived'
     )`,
  );
  for (const [field, kind] of expected)
    for (const id of references[field] ?? [])
      if (!find.get(id, projectId, kind))
        throw new Error(
          `Authoring IR reference ${id} is not an active ${kind} document in this project.`,
        );
}
