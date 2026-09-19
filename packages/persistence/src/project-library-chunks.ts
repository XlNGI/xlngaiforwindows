import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { splitNovelRagChunks } from './novel-rag-chunks.js';

export const LIBRARY_SOURCE_TYPES = [
  'document',
  'novel-chapter',
  'novel-reference',
  'memory',
  'constraint',
  'conversation',
  'scene',
  'shot',
  'storyboard',
  'asset',
  'change-set',
  'adaptation',
  'media-task',
] as const;

export type LibraryChunkSourceType = (typeof LIBRARY_SOURCE_TYPES)[number];

export interface ProjectLibraryChunkRecord {
  id: string;
  projectId: string;
  sourceType: LibraryChunkSourceType;
  sourceId: string;
  documentId?: string;
  versionId?: string;
  status: string;
  kind?: string;
  scopeType?: string;
  scopeId?: string;
  title: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  contentText: string;
  contentHash: string;
  characterCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryCatalogRecord {
  id: string;
  sourceType: LibraryChunkSourceType;
  sourceId: string;
  versionId?: string;
  status: string;
  kind?: string;
  title: string;
  updatedAt: string;
}

export interface LibrarySearchHit {
  chunk: ProjectLibraryChunkRecord;
  score: number;
}

export interface LibrarySearchQuery {
  projectId: string;
  query: string;
  sourceTypes?: readonly string[];
  status?: string;
  kind?: string;
  scopeType?: string;
  scopeId?: string;
  includeArchived?: boolean;
  limit?: number;
}

interface LibraryChunkWrite {
  sourceType: LibraryChunkSourceType;
  sourceId: string;
  documentId?: string;
  versionId?: string;
  status: string;
  kind?: string;
  scopeType?: string;
  scopeId?: string;
  title: string;
  content: string;
}

const CATALOG_LIMIT_PER_TYPE = 20;
const CATALOG_LIMIT_CONVERSATIONS = 5;
const LIBRARY_FTS_NAME = 'project_library_fts';

export function projectLibraryFtsEnabled(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(LIBRARY_FTS_NAME),
  );
}

export function probeFts5Trigram(database: Database.Database): boolean {
  try {
    database.exec(
      "CREATE VIRTUAL TABLE temp.library_fts_trigram_probe USING fts5(x, tokenize = 'trigram')",
    );
    database.exec('DROP TABLE temp.library_fts_trigram_probe');
    return true;
  } catch {
    return false;
  }
}

export function createProjectLibraryFts(database: Database.Database): boolean {
  if (!probeFts5Trigram(database)) return false;
  database.exec(`
    CREATE VIRTUAL TABLE project_library_fts USING fts5(
      title,
      content_text,
      tokenize = 'trigram',
      content = 'project_library_chunks',
      content_rowid = 'rowid'
    );
    CREATE TRIGGER project_library_chunks_ai AFTER INSERT ON project_library_chunks BEGIN
      INSERT INTO project_library_fts(rowid, title, content_text)
      VALUES (new.rowid, new.title, new.content_text);
    END;
    CREATE TRIGGER project_library_chunks_ad AFTER DELETE ON project_library_chunks BEGIN
      INSERT INTO project_library_fts(project_library_fts, rowid, title, content_text)
      VALUES ('delete', old.rowid, old.title, old.content_text);
    END;
    CREATE TRIGGER project_library_chunks_au AFTER UPDATE ON project_library_chunks BEGIN
      INSERT INTO project_library_fts(project_library_fts, rowid, title, content_text)
      VALUES ('delete', old.rowid, old.title, old.content_text);
      INSERT INTO project_library_fts(rowid, title, content_text)
      VALUES (new.rowid, new.title, new.content_text);
    END;
  `);
  return true;
}

export function deleteLibrarySourceChunks(
  database: Database.Database,
  projectId: string,
  sourceType: LibraryChunkSourceType,
  sourceId: string,
): void {
  database
    .prepare(
      'DELETE FROM project_library_chunks WHERE project_id = ? AND source_type = ? AND source_id = ?',
    )
    .run(projectId, sourceType, sourceId);
}

export function rebuildLibraryChunksForDocument(
  database: Database.Database,
  projectId: string,
  documentId: string,
  now = new Date().toISOString(),
): number {
  const document = database
    .prepare(
      `SELECT documents.id, documents.kind, documents.title, documents.current_version_id,
              documents.published_version_id, documents.lifecycle_status, documents.scope_type,
              documents.scope_id, chapters.id AS chapter_id, chapters.display_label AS chapter_label
       FROM documents
       LEFT JOIN novel_chapters chapters ON chapters.document_id = documents.id
       WHERE documents.id = ? AND documents.project_id = ?`,
    )
    .get(documentId, projectId) as
    | {
        id: string;
        kind: string;
        title: string;
        current_version_id: string | null;
        published_version_id: string | null;
        lifecycle_status: string;
        scope_type: string | null;
        scope_id: string | null;
        chapter_id: string | null;
        chapter_label: string | null;
      }
    | undefined;
  database
    .prepare('DELETE FROM project_library_chunks WHERE project_id = ? AND document_id = ?')
    .run(projectId, documentId);
  if (!document) return 0;
  const source = resolveDocumentSource(database, document);
  const versionIds = [document.current_version_id, document.published_version_id].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );
  let count = 0;
  for (const versionId of versionIds) {
    const version = database
      .prepare('SELECT content_markdown FROM document_versions WHERE id = ?')
      .get(versionId) as { content_markdown: string } | undefined;
    if (!version?.content_markdown.trim()) continue;
    count += insertLibraryWrites(
      database,
      projectId,
      [
        {
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          documentId,
          versionId,
          status: document.published_version_id === versionId ? 'published' : 'draft',
          kind: document.kind,
          scopeType: document.scope_type ?? undefined,
          scopeId: document.scope_id ?? undefined,
          title: source.title,
          content: version.content_markdown,
        },
      ],
      now,
    );
  }
  return count;
}

export function rebuildLibraryChunksForRecord(
  database: Database.Database,
  projectId: string,
  write: LibraryChunkWrite,
  now = new Date().toISOString(),
): number {
  deleteLibrarySourceChunks(database, projectId, write.sourceType, write.sourceId);
  if (!write.content.trim()) return 0;
  return insertLibraryWrites(database, projectId, [write], now);
}

export function rebuildLibraryChunksForAsset(
  database: Database.Database,
  projectId: string,
  assetId: string,
  now = new Date().toISOString(),
): number {
  const row = database
    .prepare(
      `SELECT assets.id, assets.kind, assets.alias, assets.relative_path, assets.deleted_at,
              GROUP_CONCAT(tags.name, ' ') AS tag_names
       FROM assets
       LEFT JOIN asset_tag_assignments assignments ON assignments.asset_id = assets.id
       LEFT JOIN tags ON tags.id = assignments.tag_id
       WHERE assets.id = ? AND assets.project_id = ?
       GROUP BY assets.id`,
    )
    .get(assetId, projectId) as
    | {
        id: string;
        kind: string;
        alias: string;
        relative_path: string;
        deleted_at: string | null;
        tag_names: string | null;
      }
    | undefined;
  if (!row) {
    deleteLibrarySourceChunks(database, projectId, 'asset', assetId);
    return 0;
  }
  const fileName = row.relative_path.replace(/\\/g, '/').split('/').at(-1) ?? row.relative_path;
  const title = row.alias.trim() || fileName;
  return rebuildLibraryChunksForRecord(
    database,
    projectId,
    {
      sourceType: 'asset',
      sourceId: row.id,
      status: row.deleted_at ? 'trash' : 'active',
      kind: row.kind,
      title,
      content: [title, fileName, row.kind, row.tag_names].filter(Boolean).join('\n'),
    },
    now,
  );
}

export function rebuildLibraryChunksForChangeSet(
  database: Database.Database,
  projectId: string,
  changeSetId: string,
  now = new Date().toISOString(),
): number {
  const row = database
    .prepare(
      'SELECT id, title, status, updated_at FROM agent_change_sets WHERE id = ? AND project_id = ?',
    )
    .get(changeSetId, projectId) as
    { id: string; title: string; status: string; updated_at: string } | undefined;
  if (!row) {
    deleteLibrarySourceChunks(database, projectId, 'change-set', changeSetId);
    return 0;
  }
  const items = (
    database
      .prepare(
        'SELECT title FROM agent_change_set_items WHERE change_set_id = ? ORDER BY ordinal LIMIT 20',
      )
      .all(changeSetId) as Array<{ title: string }>
  ).map((item) => item.title);
  return rebuildLibraryChunksForRecord(
    database,
    projectId,
    {
      sourceType: 'change-set',
      sourceId: row.id,
      status: row.status,
      title: row.title,
      content: [row.title, row.status, ...items].join('\n'),
    },
    now,
  );
}

export function rebuildLibraryChunksForAdaptation(
  database: Database.Database,
  projectId: string,
  proposalId: string,
  now = new Date().toISOString(),
): number {
  const row = database
    .prepare(
      `SELECT proposals.id, chapters.display_label, documents.title
       FROM novel_adaptation_proposals proposals
       INNER JOIN novel_chapters chapters ON chapters.id = proposals.source_chapter_id
       INNER JOIN documents ON documents.id = proposals.proposal_document_id
       WHERE proposals.id = ? AND proposals.project_id = ?`,
    )
    .get(proposalId, projectId) as
    { id: string; display_label: string | null; title: string } | undefined;
  if (!row) {
    deleteLibrarySourceChunks(database, projectId, 'adaptation', proposalId);
    return 0;
  }
  const title = `改编提案：${row.display_label?.trim() || row.title}`;
  return rebuildLibraryChunksForRecord(
    database,
    projectId,
    {
      sourceType: 'adaptation',
      sourceId: row.id,
      status: 'active',
      title,
      content: title,
    },
    now,
  );
}

export function rebuildLibraryChunksForMediaTask(
  database: Database.Database,
  projectId: string,
  jobId: string,
  now = new Date().toISOString(),
): number {
  const row = database
    .prepare(
      `SELECT id, adapter_key, status, media_state FROM generation_jobs
       WHERE id = ? AND project_id = ?`,
    )
    .get(jobId, projectId) as
    { id: string; adapter_key: string; status: string; media_state: string | null } | undefined;
  if (!row) {
    deleteLibrarySourceChunks(database, projectId, 'media-task', jobId);
    return 0;
  }
  return rebuildLibraryChunksForRecord(
    database,
    projectId,
    {
      sourceType: 'media-task',
      sourceId: row.id,
      status: row.media_state || row.status,
      kind: row.adapter_key,
      title: `媒体任务 ${row.adapter_key}`,
      content: [row.adapter_key, row.status, row.media_state].filter(Boolean).join('\n'),
    },
    now,
  );
}

export function backfillProjectLibraryChunks(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database.prepare('SELECT id, project_id FROM documents').all() as Array<{
    id: string;
    project_id: string;
  }>) {
    count += rebuildLibraryChunksForDocument(database, row.project_id, row.id, now);
  }
  count += backfillMemories(database, now);
  count += backfillConstraints(database, now);
  count += backfillMessages(database, now);
  count += backfillScenes(database, now);
  count += backfillShots(database, now);
  count += backfillAssets(database, now);
  count += backfillChangeSets(database, now);
  count += backfillAdaptations(database, now);
  count += backfillMediaTasks(database, now);
  return count;
}

export function listProjectLibraryCatalog(
  database: Database.Database,
  projectId: string,
): LibraryCatalogRecord[] {
  return [
    ...catalogDocuments(database, projectId),
    ...catalogMemories(database, projectId),
    ...catalogConstraints(database, projectId),
    ...catalogConversations(database, projectId),
    ...catalogScenes(database, projectId),
    ...catalogShots(database, projectId),
    ...catalogAssets(database, projectId),
    ...catalogChangeSets(database, projectId),
    ...catalogAdaptations(database, projectId),
    ...catalogMediaTasks(database, projectId),
  ];
}

export function searchProjectLibraryChunks(
  database: Database.Database,
  params: LibrarySearchQuery,
): LibrarySearchHit[] {
  const query = params.query.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const rows = loadSearchCandidates(database, params, query);
  const scored = rows
    .map((row) => ({ chunk: toChunkRecord(row), score: libraryChunkScore(row, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.chunk.updatedAt.localeCompare(left.chunk.updatedAt) ||
        left.chunk.id.localeCompare(right.chunk.id),
    );
  const seen = new Set<string>();
  const hits: LibrarySearchHit[] = [];
  for (const item of scored) {
    const key = `${item.chunk.sourceType}:${item.chunk.sourceId}:${item.chunk.versionId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(item);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function getProjectLibraryChunk(
  database: Database.Database,
  projectId: string,
  chunkId: string,
): ProjectLibraryChunkRecord | undefined {
  const row = database
    .prepare('SELECT * FROM project_library_chunks WHERE project_id = ? AND id = ?')
    .get(projectId, chunkId) as LibraryChunkRow | undefined;
  return row ? toChunkRecord(row) : undefined;
}

export function librarySnippet(content: string, query: string, maxChars = 400): string {
  const haystack = content.toLocaleLowerCase('zh-CN');
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  let index = needle ? haystack.indexOf(needle) : 0;
  if (index < 0) {
    const term = libraryQueryTerms(query)[0];
    index = term ? haystack.indexOf(term) : 0;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - Math.floor(maxChars / 4));
  const snippet = content.slice(start, start + maxChars).trim();
  return snippet.length < content.length && start > 0 ? `…${snippet}` : snippet;
}

export function libraryQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  const segments = query.toLocaleLowerCase('zh-CN').match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/u.test(segment)) {
      if (segment.length === 1) terms.add(segment);
      for (let index = 0; index < segment.length - 1 && terms.size < 64; index += 1) {
        terms.add(segment.slice(index, index + 2));
      }
    } else if (segment.length >= 2) {
      terms.add(segment);
    }
    if (terms.size >= 64) break;
  }
  return [...terms];
}

function insertLibraryWrites(
  database: Database.Database,
  projectId: string,
  writes: LibraryChunkWrite[],
  now: string,
): number {
  const insert = database.prepare(
    `INSERT INTO project_library_chunks
     (id, project_id, source_type, source_id, document_id, version_id, status, kind,
      scope_type, scope_id, title, ordinal, start_offset, end_offset, content_text,
      content_hash, character_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const write of writes) {
    const pieces = splitLibraryContent(write.content);
    for (const piece of pieces) {
      insert.run(
        randomUUID(),
        projectId,
        write.sourceType,
        write.sourceId,
        write.documentId ?? null,
        write.versionId ?? null,
        write.status,
        write.kind ?? null,
        write.scopeType ?? null,
        write.scopeId ?? null,
        write.title,
        piece.ordinal,
        piece.startOffset,
        piece.endOffset,
        piece.contentText,
        piece.contentHash,
        [...piece.contentText].length,
        now,
        now,
      );
      count += 1;
    }
  }
  return count;
}

function splitLibraryContent(content: string) {
  const chunks = splitNovelRagChunks(content);
  if (chunks.length > 0) return chunks;
  const trimmed = content.trim();
  if (!trimmed) return [];
  return [
    {
      ordinal: 0,
      startOffset: 0,
      endOffset: content.length,
      contentText: trimmed,
      contentHash: createHash('sha256').update(trimmed, 'utf8').digest('hex'),
    },
  ];
}

function resolveDocumentSource(
  database: Database.Database,
  document: {
    id: string;
    kind: string;
    title: string;
    chapter_id: string | null;
    chapter_label: string | null;
  },
): { sourceType: LibraryChunkSourceType; sourceId: string; title: string } {
  if (document.chapter_id) {
    return {
      sourceType: 'novel-chapter',
      sourceId: document.chapter_id,
      title: document.chapter_label?.trim() || document.title,
    };
  }
  if (document.kind === 'storyboard') {
    return { sourceType: 'storyboard', sourceId: document.id, title: document.title };
  }
  const binding = database
    .prepare(
      `SELECT 1 AS present FROM document_bindings
       WHERE document_id = ? AND status = 'active' AND domain_scope = 'novel' LIMIT 1`,
    )
    .get(document.id) as { present: number } | undefined;
  if (binding) {
    return { sourceType: 'novel-reference', sourceId: document.id, title: document.title };
  }
  return { sourceType: 'document', sourceId: document.id, title: document.title };
}

interface LibraryChunkRow {
  id: string;
  project_id: string;
  source_type: string;
  source_id: string;
  document_id: string | null;
  version_id: string | null;
  status: string;
  kind: string | null;
  scope_type: string | null;
  scope_id: string | null;
  title: string;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  content_text: string;
  content_hash: string;
  character_count: number;
  created_at: string;
  updated_at: string;
}

function loadSearchCandidates(
  database: Database.Database,
  params: LibrarySearchQuery,
  query: string,
): LibraryChunkRow[] {
  const filters = ['chunks.project_id = ?'];
  const values: unknown[] = [params.projectId];
  if (params.sourceTypes && params.sourceTypes.length > 0) {
    filters.push(`chunks.source_type IN (${params.sourceTypes.map(() => '?').join(', ')})`);
    values.push(...params.sourceTypes);
  }
  if (params.status && params.status !== 'any') {
    filters.push('chunks.status = ?');
    values.push(params.status);
  } else if (params.status !== 'any') {
    filters.push("chunks.status <> 'trash'");
  }
  if (params.kind) {
    filters.push('chunks.kind = ?');
    values.push(params.kind);
  }
  if (params.scopeType) {
    filters.push('chunks.scope_type = ?');
    values.push(params.scopeType);
  }
  if (params.scopeId) {
    filters.push('chunks.scope_id = ?');
    values.push(params.scopeId);
  }
  if (!params.includeArchived) {
    filters.push(`NOT EXISTS (
      SELECT 1 FROM documents archived
      WHERE archived.id = chunks.document_id AND archived.lifecycle_status = 'archived'
    )`);
  }
  const where = filters.join(' AND ');
  if (projectLibraryFtsEnabled(database) && [...query].length >= 3) {
    try {
      const rows = database
        .prepare(
          `SELECT chunks.*
           FROM project_library_fts
           INNER JOIN project_library_chunks chunks ON chunks.rowid = project_library_fts.rowid
           WHERE project_library_fts MATCH ? AND ${where}
           ORDER BY chunks.updated_at DESC, chunks.id LIMIT 500`,
        )
        .all(`"${query.replaceAll('"', '""')}"`, ...values) as LibraryChunkRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Fall through to explicit n-gram scoring; never tokenize on whitespace.
    }
  }
  return database
    .prepare(
      `SELECT chunks.* FROM project_library_chunks chunks WHERE ${where}
       ORDER BY chunks.updated_at DESC, chunks.id LIMIT 5000`,
    )
    .all(...values) as LibraryChunkRow[];
}

function libraryChunkScore(row: LibraryChunkRow, query: string): number {
  const haystack = `${row.title}\n${row.content_text}`.toLocaleLowerCase('zh-CN');
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  let score = 0;
  if (needle && haystack.includes(needle)) score += Math.min(needle.length, 12) * 4;
  if (row.title.toLocaleLowerCase('zh-CN').includes(needle)) score += 8;
  for (const term of libraryQueryTerms(query)) {
    if (haystack.includes(term)) score += Math.min(term.length, 6);
  }
  return score;
}

function toChunkRecord(row: LibraryChunkRow): ProjectLibraryChunkRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type as LibraryChunkSourceType,
    sourceId: row.source_id,
    documentId: row.document_id ?? undefined,
    versionId: row.version_id ?? undefined,
    status: row.status,
    kind: row.kind ?? undefined,
    scopeType: row.scope_type ?? undefined,
    scopeId: row.scope_id ?? undefined,
    title: row.title,
    ordinal: row.ordinal,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    contentText: row.content_text,
    contentHash: row.content_hash,
    characterCount: row.character_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function catalogDocuments(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  const rows = database
    .prepare(
      `SELECT documents.id, documents.kind, documents.title, documents.updated_at,
              documents.current_version_id, documents.published_version_id,
              chapters.id AS chapter_id, chapters.display_label AS chapter_label
       FROM documents
       LEFT JOIN novel_chapters chapters ON chapters.document_id = documents.id
       WHERE documents.project_id = ? AND documents.lifecycle_status = 'active'
         AND documents.current_version_id IS NOT NULL
       ORDER BY documents.updated_at DESC, documents.id LIMIT ?`,
    )
    .all(projectId, CATALOG_LIMIT_PER_TYPE * 3) as Array<{
    id: string;
    kind: string;
    title: string;
    updated_at: string;
    current_version_id: string;
    published_version_id: string | null;
    chapter_id: string | null;
    chapter_label: string | null;
  }>;
  const counts = new Map<string, number>();
  const items: LibraryCatalogRecord[] = [];
  for (const row of rows) {
    const sourceType: LibraryChunkSourceType = row.chapter_id
      ? 'novel-chapter'
      : row.kind === 'storyboard'
        ? 'storyboard'
        : 'document';
    const used = counts.get(sourceType) ?? 0;
    if (used >= CATALOG_LIMIT_PER_TYPE) continue;
    counts.set(sourceType, used + 1);
    items.push({
      id: `${sourceType}:${row.chapter_id ?? row.id}:${row.current_version_id}`,
      sourceType,
      sourceId: row.chapter_id ?? row.id,
      versionId: row.current_version_id,
      status: row.published_version_id === row.current_version_id ? 'published' : 'draft',
      kind: row.kind,
      title: row.chapter_label?.trim() || row.title,
      updatedAt: row.updated_at,
    });
  }
  return items;
}

function catalogMemories(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        'SELECT id, updated_at FROM memories WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ?',
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{ id: string; updated_at: string }>
  ).map((row) => ({
    id: `memory:${row.id}`,
    sourceType: 'memory' as const,
    sourceId: row.id,
    status: 'memory',
    title: '项目记忆',
    updatedAt: row.updated_at,
  }));
}

function catalogConstraints(
  database: Database.Database,
  projectId: string,
): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        'SELECT id, kind, updated_at FROM constraints WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ?',
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      kind: string;
      updated_at: string;
    }>
  ).map((row) => ({
    id: `constraint:${row.id}`,
    sourceType: 'constraint' as const,
    sourceId: row.id,
    status: 'constraint',
    kind: row.kind,
    title: `生产约束：${row.kind}`,
    updatedAt: row.updated_at,
  }));
}

function catalogConversations(
  database: Database.Database,
  projectId: string,
): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        `SELECT id, title, updated_at FROM conversations
         WHERE project_id = ? AND archived_at IS NULL
         ORDER BY CASE WHEN TRIM(COALESCE(title, '')) IN ('', '新会话', '会话') THEN 1 ELSE 0 END,
                  updated_at DESC, id
         LIMIT ?`,
      )
      .all(projectId, CATALOG_LIMIT_CONVERSATIONS) as Array<{
      id: string;
      title: string | null;
      updated_at: string;
    }>
  ).map((row) => ({
    id: `conversation:${row.id}`,
    sourceType: 'conversation' as const,
    sourceId: row.id,
    status: 'conversation',
    title: row.title?.trim() || '会话',
    updatedAt: row.updated_at,
  }));
}

function catalogScenes(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        'SELECT id, title, updated_at FROM scenes WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ?',
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      title: string;
      updated_at: string;
    }>
  ).map((row) => ({
    id: `scene:${row.id}`,
    sourceType: 'scene' as const,
    sourceId: row.id,
    status: 'active',
    title: row.title,
    updatedAt: row.updated_at,
  }));
}

function catalogShots(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        `SELECT shots.id, shots.title, shots.updated_at, shots.status
         FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id
         WHERE scenes.project_id = ?
         ORDER BY shots.updated_at DESC, shots.id LIMIT ?`,
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      title: string;
      updated_at: string;
      status: string;
    }>
  ).map((row) => ({
    id: `shot:${row.id}`,
    sourceType: 'shot' as const,
    sourceId: row.id,
    status: row.status || 'active',
    title: row.title,
    updatedAt: row.updated_at,
  }));
}

function catalogAssets(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        `SELECT id, kind, alias, relative_path, updated_at, created_at
         FROM assets WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY COALESCE(updated_at, created_at) DESC, id LIMIT ?`,
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      kind: string;
      alias: string;
      relative_path: string;
      updated_at: string | null;
      created_at: string;
    }>
  ).map((row) => ({
    id: `asset:${row.id}`,
    sourceType: 'asset' as const,
    sourceId: row.id,
    status: 'active',
    kind: row.kind,
    title: row.alias.trim() || row.relative_path.replace(/\\/g, '/').split('/').at(-1) || row.id,
    updatedAt: row.updated_at ?? row.created_at,
  }));
}

function backfillMemories(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database
    .prepare('SELECT id, project_id, content, scope_type, scope_id FROM memories')
    .all() as Array<{
    id: string;
    project_id: string;
    content: string;
    scope_type: string;
    scope_id: string | null;
  }>) {
    count += rebuildLibraryChunksForRecord(
      database,
      row.project_id,
      {
        sourceType: 'memory',
        sourceId: row.id,
        status: 'memory',
        scopeType: row.scope_type,
        scopeId: row.scope_id ?? undefined,
        title: '项目记忆',
        content: row.content,
      },
      now,
    );
  }
  return count;
}

function backfillConstraints(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database
    .prepare('SELECT id, project_id, kind, content, scope_type, scope_id FROM constraints')
    .all() as Array<{
    id: string;
    project_id: string;
    kind: string;
    content: string;
    scope_type: string;
    scope_id: string | null;
  }>) {
    count += rebuildLibraryChunksForRecord(
      database,
      row.project_id,
      {
        sourceType: 'constraint',
        sourceId: row.id,
        status: 'constraint',
        kind: row.kind,
        scopeType: row.scope_type,
        scopeId: row.scope_id ?? undefined,
        title: `生产约束：${row.kind}`,
        content: row.content,
      },
      now,
    );
  }
  return count;
}

function backfillMessages(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database
    .prepare(
      `SELECT messages.id, conversations.project_id, messages.content, messages.role,
              conversations.title, conversations.scope_type, conversations.scope_id
       FROM chat_messages messages
       INNER JOIN conversations ON conversations.id = messages.conversation_id
       WHERE messages.status = 'complete'`,
    )
    .all() as Array<{
    id: string;
    project_id: string;
    content: string;
    role: string;
    title: string | null;
    scope_type: string;
    scope_id: string | null;
  }>) {
    count += rebuildLibraryChunksForRecord(
      database,
      row.project_id,
      {
        sourceType: 'conversation',
        sourceId: row.id,
        status: 'conversation',
        kind: row.role,
        scopeType: row.scope_type,
        scopeId: row.scope_id ?? undefined,
        title: row.title?.trim() || '会话记录',
        content: `${row.role}: ${row.content}`,
      },
      now,
    );
  }
  return count;
}

function backfillScenes(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database.prepare('SELECT id, project_id, title FROM scenes').all() as Array<{
    id: string;
    project_id: string;
    title: string;
  }>) {
    count += rebuildLibraryChunksForRecord(
      database,
      row.project_id,
      {
        sourceType: 'scene',
        sourceId: row.id,
        status: 'active',
        title: row.title,
        content: row.title,
        scopeType: 'scene',
        scopeId: row.id,
      },
      now,
    );
  }
  return count;
}

function backfillShots(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database
    .prepare(
      `SELECT shots.id, scenes.project_id, shots.title, shots.prompt, shots.status, shots.document_id
       FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id`,
    )
    .all() as Array<{
    id: string;
    project_id: string;
    title: string;
    prompt: string | null;
    status: string;
    document_id: string | null;
  }>) {
    count += rebuildLibraryChunksForRecord(
      database,
      row.project_id,
      {
        sourceType: 'shot',
        sourceId: row.id,
        documentId: row.document_id ?? undefined,
        status: row.status || 'active',
        title: row.title,
        content: [row.title, row.prompt?.trim()].filter(Boolean).join('\n'),
        scopeType: 'shot',
        scopeId: row.id,
      },
      now,
    );
  }
  return count;
}

function backfillAssets(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database.prepare('SELECT id, project_id FROM assets').all() as Array<{
    id: string;
    project_id: string;
  }>) {
    count += rebuildLibraryChunksForAsset(database, row.project_id, row.id, now);
  }
  return count;
}

function backfillChangeSets(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database
    .prepare('SELECT id, project_id FROM agent_change_sets')
    .all() as Array<{
    id: string;
    project_id: string;
  }>) {
    count += rebuildLibraryChunksForChangeSet(database, row.project_id, row.id, now);
  }
  return count;
}

function backfillAdaptations(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database
    .prepare('SELECT id, project_id FROM novel_adaptation_proposals')
    .all() as Array<{ id: string; project_id: string }>) {
    count += rebuildLibraryChunksForAdaptation(database, row.project_id, row.id, now);
  }
  return count;
}

function backfillMediaTasks(database: Database.Database, now: string): number {
  let count = 0;
  for (const row of database.prepare('SELECT id, project_id FROM generation_jobs').all() as Array<{
    id: string;
    project_id: string;
  }>) {
    count += rebuildLibraryChunksForMediaTask(database, row.project_id, row.id, now);
  }
  return count;
}

function catalogChangeSets(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        `SELECT id, title, status, updated_at FROM agent_change_sets
         WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      title: string;
      status: string;
      updated_at: string;
    }>
  ).map((row) => ({
    id: `change-set:${row.id}`,
    sourceType: 'change-set' as const,
    sourceId: row.id,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  }));
}

function catalogAdaptations(
  database: Database.Database,
  projectId: string,
): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        `SELECT proposals.id, documents.title, documents.updated_at
         FROM novel_adaptation_proposals proposals
         INNER JOIN documents ON documents.id = proposals.proposal_document_id
         WHERE proposals.project_id = ?
         ORDER BY documents.updated_at DESC, proposals.id LIMIT ?`,
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      title: string;
      updated_at: string;
    }>
  ).map((row) => ({
    id: `adaptation:${row.id}`,
    sourceType: 'adaptation' as const,
    sourceId: row.id,
    status: 'active',
    title: `改编提案：${row.title}`,
    updatedAt: row.updated_at,
  }));
}

function catalogMediaTasks(database: Database.Database, projectId: string): LibraryCatalogRecord[] {
  return (
    database
      .prepare(
        `SELECT id, adapter_key, status, media_state, updated_at FROM generation_jobs
         WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(projectId, CATALOG_LIMIT_PER_TYPE) as Array<{
      id: string;
      adapter_key: string;
      status: string;
      media_state: string | null;
      updated_at: string;
    }>
  ).map((row) => ({
    id: `media-task:${row.id}`,
    sourceType: 'media-task' as const,
    sourceId: row.id,
    status: row.media_state || row.status,
    kind: row.adapter_key,
    title: `媒体任务 ${row.adapter_key}`,
    updatedAt: row.updated_at,
  }));
}

export function syncLibraryChunksForChatMessage(
  database: Database.Database,
  projectId: string,
  message: { id: string; content: string; role: string; status: string },
  conversation: { title?: string; scopeType?: string; scopeId?: string },
  now = new Date().toISOString(),
): number {
  if (message.status !== 'complete' || !message.content.trim()) {
    deleteLibrarySourceChunks(database, projectId, 'conversation', message.id);
    return 0;
  }
  return rebuildLibraryChunksForRecord(
    database,
    projectId,
    {
      sourceType: 'conversation',
      sourceId: message.id,
      status: 'conversation',
      kind: message.role,
      scopeType: conversation.scopeType,
      scopeId: conversation.scopeId,
      title: conversation.title?.trim() || '会话记录',
      content: `${message.role}: ${message.content}`,
    },
    now,
  );
}
