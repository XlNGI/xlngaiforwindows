import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export function linkResearchCitations(
  database: Database.Database,
  projectId: string,
  taskId: string,
  documentVersionId: string | undefined,
  contentMarkdown: string,
  now: string,
): void {
  if (!documentVersionId) throw new Error('Agent draft did not produce a document version.');
  const labels = [...contentMarkdown.matchAll(/\[R([1-9][0-9]*)\]/g)].map(
    (match) => `R${match[1]}`,
  );
  const distinctLabels = [...new Set(labels)];
  const sources = database
    .prepare(
      `SELECT id, citation_label AS citationLabel
       FROM agent_research_sources
       WHERE project_id = ? AND task_id = ? AND status = 'fetched'`,
    )
    .all(projectId, taskId) as Array<{ id: string; citationLabel: string | null }>;
  const byLabel = new Map(
    sources
      .filter((source): source is { id: string; citationLabel: string } => !!source.citationLabel)
      .map((source) => [source.citationLabel, source.id]),
  );
  for (const label of distinctLabels) {
    if (!byLabel.has(label)) {
      throw new Error(`RESEARCH_CITATION_INVALID: unknown citation label ${label}.`);
    }
  }
  const version = database
    .prepare(
      `SELECT versions.document_id AS documentId
       FROM document_versions versions
       INNER JOIN documents documents ON documents.id = versions.document_id
       WHERE versions.id = ? AND documents.project_id = ?`,
    )
    .get(documentVersionId, projectId) as { documentId: string } | undefined;
  if (!version) throw new Error('RESEARCH_CITATION_INVALID: document version is out of scope.');
  const insert = database.prepare(
    `INSERT INTO document_version_research_sources
     (id, project_id, document_id, document_version_id, source_id, citation_label,
      citation_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_version_id, source_id) DO NOTHING`,
  );
  for (const label of distinctLabels) {
    const sourceId = byLabel.get(label)!;
    insert.run(
      randomUUID(),
      projectId,
      version.documentId,
      documentVersionId,
      sourceId,
      label,
      'explicit Markdown citation in Agent draft',
      now,
    );
    database
      .prepare(
        `UPDATE agent_research_sources
         SET adoption_status = 'adopted', adoption_reason = ?
         WHERE id = ? AND project_id = ? AND task_id = ?`,
      )
      .run(`Cited by document version ${documentVersionId}.`, sourceId, projectId, taskId);
  }
  database
    .prepare(
      `UPDATE agent_research_sources
       SET adoption_status = 'excluded', adoption_reason = ?
       WHERE project_id = ? AND task_id = ? AND status = 'fetched'
         AND adoption_status = 'unreviewed'`,
    )
    .run(`Not cited by Agent draft version ${documentVersionId}.`, projectId, taskId);
}
