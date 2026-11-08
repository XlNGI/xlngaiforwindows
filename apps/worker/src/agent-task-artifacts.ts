import type Database from 'better-sqlite3';
import { contextContentHash } from '@ai-video/persistence';

export type ReviewArtifact = {
  id: string;
  kind: 'document' | 'shot';
  body: string;
  updatedAt: string;
  title?: string;
  documentKind?: string;
  versionId?: string;
  sourceIds?: string[];
};
export type ReadResult = { content: string; created_at: string };

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringsIn);
}

/** A save receipt or a metadata-only read is never evidence of reading the final text. */
export function hasCurrentRead(artifact: ReviewArtifact, reads: ReadResult[]): boolean {
  const pages = new Map<
    string,
    { json: boolean; parts: Array<{ offset: number; text: string }> }
  >();
  for (const read of reads) {
    if (read.created_at < artifact.updatedAt) continue;
    try {
      const value = JSON.parse(read.content) as Record<string, unknown>;
      const target = value.target as { id?: unknown } | undefined;
      const document = value.document as { id?: unknown } | undefined;
      if (
        ![artifact.id, ...(artifact.sourceIds ?? [])].some((id) =>
          [value.sourceId, value.documentId, value.shotId, target?.id, document?.id].includes(id),
        )
      )
        continue;
      if (
        artifact.kind === 'document' &&
        typeof value.versionId === 'string' &&
        artifact.versionId &&
        value.versionId !== artifact.versionId
      )
        continue;
      const page = value.contentPage as
        | { offset?: unknown; text?: unknown; expectedVersion?: unknown; format?: unknown }
        | undefined;
      // A page containing the whole prompt is still only one part of authoring
      // JSON (timing/references may follow). Never inspect nested page strings
      // as if they were a complete read result.
      if (!page && value.startOffset === undefined) {
        if (stringsIn(value).some((text) => artifact.body && text.includes(artifact.body)))
          return true;
        continue;
      }
      const offset = page?.offset ?? value.startOffset;
      const text = page?.text ?? value.content;
      const version = page?.expectedVersion ?? value.versionId ?? value.version;
      if (typeof offset !== 'number' || typeof text !== 'string' || !version) continue;
      const json = page?.format === 'json' || value.view === 'authoring';
      const key = JSON.stringify([version, value.view, value.readMode, json]);
      const group = pages.get(key) ?? { json, parts: [] };
      group.parts.push({ offset, text });
      pages.set(key, group);
    } catch {
      // Opaque or incomplete JSON cannot establish review coverage.
    }
  }
  for (const { parts, json } of pages.values()) {
    let assembled = '';
    for (const part of parts.sort((a, b) => a.offset - b.offset)) {
      if (part.offset > assembled.length) break;
      assembled += part.text.slice(Math.max(0, assembled.length - part.offset));
    }
    if (!json && artifact.body && assembled.includes(artifact.body)) return true;
    try {
      if (
        stringsIn(JSON.parse(assembled)).some(
          (text) => artifact.body && text.includes(artifact.body),
        )
      )
        return true;
    } catch {
      // Authoring pages are JSON; every page must be read before parsing.
    }
  }
  return false;
}

/** Resolve current active project objects; identities never come from model claims. */
export function currentTaskArtifact(
  db: Database.Database,
  projectId: string,
  id: string,
  kind: 'document' | 'shot',
): ReviewArtifact | undefined {
  if (kind === 'document') {
    const row = db
      .prepare(
        `SELECT d.id,d.kind,d.title,d.updated_at,d.current_version_id,v.content_markdown FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id WHERE d.project_id=? AND d.id=? AND d.lifecycle_status='active'`,
      )
      .get(projectId, id) as
      | {
          id: string;
          kind: string;
          title: string;
          updated_at: string;
          current_version_id: string;
          content_markdown: string;
        }
      | undefined;
    return (
      row && {
        id: row.id,
        kind,
        body: row.content_markdown,
        updatedAt: row.updated_at,
        title: row.title,
        documentKind: row.kind,
        versionId: row.current_version_id,
      }
    );
  }
  const row = db
    .prepare(
      `SELECT s.id,s.updated_at,s.authoring_ir_json FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE c.project_id=? AND s.id=? AND c.archived_at IS NULL AND s.archived_at IS NULL`,
    )
    .get(projectId, id) as
    { id: string; updated_at: string; authoring_ir_json: string } | undefined;
  if (!row) return undefined;
  try {
    const ir = JSON.parse(row.authoring_ir_json) as { prompt?: string };
    return {
      id: row.id,
      kind,
      body: ir.prompt ?? '',
      updatedAt: row.updated_at,
      versionId: contextContentHash(row.authoring_ir_json),
    };
  } catch {
    return undefined;
  }
}
export function taskArtifactReads(
  db: Database.Database,
  projectId: string,
  taskId: string,
): ReadResult[] {
  return db
    .prepare(
      `SELECT content,created_at FROM agent_context_results WHERE project_id=? AND task_id=? AND status='completed' AND tool_name IN ('production.read','scene.read','document.read','library.read') ORDER BY rowid`,
    )
    .all(projectId, taskId) as ReadResult[];
}

export function currentTargetVersion(
  db: Database.Database,
  projectId: string,
  id: string,
  kind: 'document' | 'shot' | 'scene',
): string {
  if (kind !== 'scene') return currentTaskArtifact(db, projectId, id, kind)?.versionId ?? 'missing';
  const rows = db
    .prepare(
      `SELECT s.id,s.authoring_ir_json FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE c.project_id=? AND c.id=? AND c.archived_at IS NULL AND s.archived_at IS NULL ORDER BY s.id`,
    )
    .all(projectId, id);
  return rows.length ? contextContentHash(JSON.stringify(rows)) : 'missing';
}
