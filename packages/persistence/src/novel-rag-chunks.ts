import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

const TARGET_CHUNK_CHARACTERS = 1_600;
const MIN_CHUNK_CHARACTERS = 800;
const MAX_CHUNK_CHARACTERS = 2_200;
const CHUNK_OVERLAP_CHARACTERS = 160;

export interface NovelRagChunkDraft {
  ordinal: number;
  startOffset: number;
  endOffset: number;
  contentText: string;
  contentHash: string;
}

export interface NovelRagRebuildResult {
  chapterId?: string;
  chunkCount: number;
}

interface NovelChapterScopeRow {
  id: string;
  project_id: string;
}

interface NovelRagBackfillRow {
  project_id: string;
  document_id: string;
  document_version_id: string;
  content_markdown: string;
}

export function splitNovelRagChunks(content: string): NovelRagChunkDraft[] {
  if (!content.trim()) return [];
  const chunks: NovelRagChunkDraft[] = [];
  let start = skipWhitespace(content, 0);

  while (start < content.length) {
    const end = findChunkEnd(content, start);
    const trimmed = trimChunk(content, start, end);
    if (trimmed.endOffset > trimmed.startOffset) {
      const contentText = content.slice(trimmed.startOffset, trimmed.endOffset);
      chunks.push({
        ordinal: chunks.length,
        startOffset: trimmed.startOffset,
        endOffset: trimmed.endOffset,
        contentText,
        contentHash: createHash('sha256').update(contentText, 'utf8').digest('hex'),
      });
    }
    if (end >= content.length) break;
    const overlapStart = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS);
    start = skipWhitespace(content, overlapStart);
  }

  return chunks;
}

export function rebuildNovelRagChunks(
  database: Database.Database,
  params: {
    projectId: string;
    documentId: string;
    documentVersionId: string;
    contentMarkdown: string;
    now?: string;
  },
): NovelRagRebuildResult {
  const chapter = database
    .prepare(
      `SELECT id, project_id FROM novel_chapters
       WHERE document_id = ? AND project_id = ?`,
    )
    .get(params.documentId, params.projectId) as NovelChapterScopeRow | undefined;
  if (!chapter) return { chunkCount: 0 };

  const now = params.now ?? new Date().toISOString();
  const chunks = splitNovelRagChunks(params.contentMarkdown);
  database.prepare('DELETE FROM novel_rag_chunks WHERE chapter_id = ?').run(chapter.id);
  const insert = database.prepare(
    `INSERT INTO novel_rag_chunks
     (id, project_id, chapter_id, document_id, source_document_version_id, ordinal,
      start_offset, end_offset, content_text, content_hash, character_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const chunk of chunks) {
    insert.run(
      randomUUID(),
      params.projectId,
      chapter.id,
      params.documentId,
      params.documentVersionId,
      chunk.ordinal,
      chunk.startOffset,
      chunk.endOffset,
      chunk.contentText,
      chunk.contentHash,
      [...chunk.contentText].length,
      now,
      now,
    );
  }
  return { chapterId: chapter.id, chunkCount: chunks.length };
}

export function backfillCurrentNovelRagChunks(database: Database.Database, now: string): number {
  const rows = database
    .prepare(
      `SELECT chapters.project_id, chapters.document_id,
              versions.id AS document_version_id, versions.content_markdown
       FROM novel_chapters chapters
       INNER JOIN documents ON documents.id = chapters.document_id
       INNER JOIN document_versions versions ON versions.id = documents.current_version_id
       WHERE length(trim(versions.content_markdown)) > 0
       ORDER BY chapters.project_id, chapters.position, chapters.id`,
    )
    .all() as NovelRagBackfillRow[];
  let chunkCount = 0;
  for (const row of rows) {
    chunkCount += rebuildNovelRagChunks(database, {
      projectId: row.project_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      contentMarkdown: row.content_markdown,
      now,
    }).chunkCount;
  }
  return chunkCount;
}

function findChunkEnd(content: string, start: number): number {
  const remaining = content.length - start;
  if (remaining <= MAX_CHUNK_CHARACTERS) return content.length;

  const preferredEnd = Math.min(content.length, start + TARGET_CHUNK_CHARACTERS);
  const maximumEnd = Math.min(content.length, start + MAX_CHUNK_CHARACTERS);
  const minimumEnd = Math.min(content.length, start + MIN_CHUNK_CHARACTERS);
  const forwardParagraph = content.indexOf('\n\n', preferredEnd);
  if (forwardParagraph >= preferredEnd && forwardParagraph <= maximumEnd)
    return forwardParagraph + 2;

  const backwardParagraph = content.lastIndexOf('\n\n', preferredEnd);
  if (backwardParagraph >= minimumEnd) return backwardParagraph + 2;

  const boundary = findSentenceBoundary(content, preferredEnd, minimumEnd, maximumEnd);
  return boundary ?? maximumEnd;
}

function findSentenceBoundary(
  content: string,
  preferredEnd: number,
  minimumEnd: number,
  maximumEnd: number,
): number | undefined {
  const sentenceEnd = /[。！？!?；;\n]/u;
  for (let index = preferredEnd; index < maximumEnd; index += 1) {
    if (sentenceEnd.test(content[index] ?? '')) return index + 1;
  }
  for (let index = preferredEnd - 1; index >= minimumEnd; index -= 1) {
    if (sentenceEnd.test(content[index] ?? '')) return index + 1;
  }
  return undefined;
}

function trimChunk(
  content: string,
  startOffset: number,
  endOffset: number,
): { startOffset: number; endOffset: number } {
  let start = startOffset;
  let end = endOffset;
  while (start < end && /\s/u.test(content[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(content[end - 1] ?? '')) end -= 1;
  return { startOffset: start, endOffset: end };
}

function skipWhitespace(content: string, offset: number): number {
  let next = offset;
  while (next < content.length && /\s/u.test(content[next] ?? '')) next += 1;
  return next;
}
