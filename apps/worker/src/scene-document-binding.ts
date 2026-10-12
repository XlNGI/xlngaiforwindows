import type Database from 'better-sqlite3';

export function requireProductionSceneDocument(
  database: Database.Database,
  projectId: string,
  documentId: string,
): { title: string } {
  const document = database
    .prepare(
      `SELECT d.title FROM documents d
    WHERE d.id = ? AND d.project_id = ? AND d.kind = 'scene' AND d.lifecycle_status = 'active'
      AND NOT EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM document_bindings WHERE document_id = d.id AND domain_scope = 'novel' AND status != 'archived')`,
    )
    .get(documentId, projectId) as { title: string } | undefined;
  if (!document) throw new Error('场次只能绑定当前项目中有效的制作场景资料。');
  return document;
}
