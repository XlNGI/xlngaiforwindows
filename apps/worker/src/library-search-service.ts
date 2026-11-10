import { DOCUMENT_DELIVERY_TOOLS } from './agent-delivery-capabilities.js';
import { createHash, randomBytes } from 'node:crypto';
import type {
  LibraryErrorCode,
  LibraryReadResult,
  LibrarySearchResult,
  LibrarySearchMatchKind,
  LibrarySearchMode,
  LibrarySourceStatus,
} from '@ai-video/contracts';
import { validatePromptBindings } from '@ai-video/contracts';
import type Database from 'better-sqlite3';
import {
  getProjectLibraryChunk,
  getProjectLibraryRevision,
  librarySnippet,
  LIBRARY_SOURCE_TYPES,
  listProjectLibrarySourceChunks,
  searchProjectStructureNodesPage,
  searchProjectLibraryChunksPage,
  taskLibraryVisibility,
} from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { taskPlanScope } from './agent-task-deliverables.js';
const SOURCE_HANDLE_TTL_MS = 10 * 60000;
const SEARCH_CACHE_LIMIT = 64;
const SOURCE_HANDLE_LIMIT = 4000;
const DEFAULT_READ_CHARS = 4000;
const MAX_READ_CHARS = 20000;
const DRAFT_CANDIDATE_NOTE = '未审核候选资料，不能当作已发布权威';
export class LibraryError extends Error {
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}
interface LibraryHandleRecord {
  sourceHandle: string;
  taskId: string;
  attemptId: string;
  projectId: string;
  projectRoot: string;
  chunkId: string;
  citationLabel: string;
  structureKind?: LibrarySearchResult['sources'][number]['structureKind'];
  structurePath?: string[];
  structureNodeId?: string;
  expiresAt: number;
}
type ContentSearchHit = ReturnType<typeof searchProjectLibraryChunksPage>['hits'][number];
type StructureSearchHit = ReturnType<typeof searchProjectStructureNodesPage>['hits'][number];
interface LibrarySearchPage {
  hits: Array<ContentSearchHit | StructureSearchHit>;
  truncated: boolean;
}
export class LibrarySearchService {
  private readonly sourceHandles = new Map<string, LibraryHandleRecord>();
  private readonly searchCache = new Map<string, LibrarySearchPage>();
  constructor(private readonly projects: ProjectService) {}
  search(params: {
    taskId: string;
    attemptId: string;
    query: string;
    searchMode?: LibrarySearchMode;
    sourceTypes?: string[];
    status?: string;
    kind?: string;
    scopeType?: string;
    scopeId?: string;
    structurePath?: string[];
    offset?: number;
    includeArchived?: boolean;
    limit?: number;
  }): LibrarySearchResult {
    const searchMode = params.searchMode ?? 'content';
    if (searchMode !== 'content' && searchMode !== 'structure') {
      throw new LibraryError('LIBRARY_SEARCH_FAILED', 'Library search mode is invalid.', false);
    }
    const query = normalizeQuery(params.query, searchMode === 'structure');
    const structurePath = normalizeStructurePath(params.structurePath);
    const sourceTypes = normalizeSourceTypes(params.sourceTypes);
    const offset = boundedInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return this.projects.access(false, (database, project) => {
      const generationId = (
        database
          .prepare('SELECT generation_id AS id FROM llm_generation_attempts WHERE id=?')
          .get(params.attemptId) as
          | {
              id: string;
            }
          | undefined
      )?.id;
      const limit = boundedInteger(params.limit, searchMode === 'structure' ? 20 : 8, 1, 20);
      const revision = getProjectLibraryRevision(database, project.id);
      const cacheKey = sha256(
        JSON.stringify({
          projectRoot: project.rootPath,
          projectId: project.id,
          generationId: generationId ?? `unverified:${params.attemptId}`,
          revision,
          query,
          searchMode,
          sourceTypes: sourceTypes ? [...new Set(sourceTypes)].sort() : null,
          status: params.status ?? null,
          kind: params.kind ?? null,
          scopeType: params.scopeType ?? null,
          scopeId: params.scopeId ?? null,
          structurePath: structurePath ?? null,
          offset,
          includeArchived: params.includeArchived === true,
          limit,
        }),
      );
      let page = this.readCachedPage(database, project.id, generationId, cacheKey);
      if (!page) {
        page =
          searchMode === 'structure'
            ? searchProjectStructureNodesPage(database, {
                projectId: project.id,
                generationId,
                query,
                sourceTypes,
                status: params.status,
                kind: params.kind,
                scopeType: params.scopeType,
                scopeId: params.scopeId,
                includeArchived: params.includeArchived,
                structurePath,
                offset,
                limit,
              })
            : searchProjectLibraryChunksPage(database, {
                projectId: project.id,
                generationId,
                query,
                sourceTypes,
                status: params.status,
                kind: params.kind,
                scopeType: params.scopeType,
                scopeId: params.scopeId,
                includeArchived: params.includeArchived,
                limit,
              });
        this.writeCachedPage(cacheKey, page);
      }
      const { hits, truncated } = page;
      this.pruneExpiredHandles();
      const sources = hits.map((hit, index) => {
        const sourceHandle = randomBytes(24).toString('base64url');
        const citationLabel = `L${index + 1}`;
        const chunk = hit.chunk;
        const structure = 'node' in hit ? hit.node : hit.structure;
        this.sourceHandles.set(sourceHandle, {
          sourceHandle,
          taskId: params.taskId,
          attemptId: params.attemptId,
          projectId: project.id,
          projectRoot: project.rootPath,
          chunkId: chunk.id,
          citationLabel,
          structureKind: structure?.kind,
          structurePath: structure?.path,
          structureNodeId: structure?.id,
          expiresAt: Date.now() + SOURCE_HANDLE_TTL_MS,
        });
        if (this.sourceHandles.size > SOURCE_HANDLE_LIMIT) {
          const oldestHandle = this.sourceHandles.keys().next().value;
          if (oldestHandle) this.sourceHandles.delete(oldestHandle);
        }
        const matchKind: LibrarySearchMatchKind =
          searchMode === 'structure' ||
          chunk.title.toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN'))
            ? 'title'
            : 'body';
        return {
          sourceHandle,
          sourceType: chunk.sourceType,
          sourceId: chunk.sourceId,
          versionId: chunk.versionId,
          status: chunk.status as LibrarySourceStatus,
          kind: chunk.kind,
          title: chunk.title,
          matchKind,
          snippet: 'node' in hit ? '' : librarySnippet(chunk.contentText, query),
          citationLabel,
          updatedAt: chunk.updatedAt,
          chunkOrdinal: 'node' in hit ? hit.node.ordinal : chunk.ordinal,
          startOffset: 'node' in hit ? hit.node.startOffset : chunk.startOffset,
          endOffset: 'node' in hit ? hit.node.endOffset : chunk.endOffset,
          ...(structure
            ? {
                structureKind: structure.kind,
                structurePath: structure.path,
                ...(structure.kind ? { structureNodeId: structure.id } : {}),
              }
            : {}),
        };
      });
      return {
        status: 'searched' as const,
        searchMode,
        queryHash: sha256(query),
        resultCount: sources.length,
        ...(sources.length === 0
          ? {
              guidance:
                'No matches for this query and filters; this does not mean retrieval is unavailable. Check the catalog/resourceMap sourceType. sourceTypes=["document"] excludes novel-reference (novel outlines, character bibles and world settings). If unsure, omit sourceTypes or use the actual sourceType, then read a returned sourceHandle; document IDs are not handles.',
            }
          : {}),
        truncated,
        ...(searchMode === 'structure' && truncated ? { nextOffset: offset + sources.length } : {}),
        sources,
      };
    });
  }
  /** Direct versioned readback of a known task target, using the existing read path. */
  readArtifact(params: {
    taskId: string;
    attemptId: string;
    documentId: string;
    expectedVersionId: string;
    maxChars?: number;
    includeBindings?: boolean;
    offset?: number;
  }): LibraryReadResult {
    const sourceHandle = this.projects.access(false, (database, project) => {
      const generation = database
        .prepare(
          `SELECT g.id FROM llm_generation_attempts a JOIN llm_generations g ON g.id=a.generation_id
         JOIN agent_task_generations l ON l.generation_id=g.id
         WHERE a.id=? AND l.task_id=? AND g.project_id=?`,
        )
        .get(params.attemptId, params.taskId, project.id) as
        | {
            id: string;
          }
        | undefined;
      if (!generation)
        throw new LibraryError('LIBRARY_READ_BLOCKED', 'Artifact is outside this task.', false);
      const known =
        taskPlanScope(database, project.id, generation.id, params.taskId).some((item) =>
          item.targetIds.includes(params.documentId),
        ) ||
        Boolean(
          database
            .prepare(
              `SELECT 1 FROM agent_tool_calls WHERE project_id=? AND task_id=? AND status='succeeded'
           AND tool_name IN (${DOCUMENT_DELIVERY_TOOLS.map(() => '?').join(',')}) AND json_valid(result_summary_json) AND json_extract(result_summary_json,'$.documentId')=? LIMIT 1`,
            )
            .get(project.id, params.taskId, ...DOCUMENT_DELIVERY_TOOLS, params.documentId),
        ) ||
        Boolean(
          database
            .prepare(
              `SELECT 1 FROM agent_context_results WHERE project_id=? AND task_id=? AND status='completed'
           AND tool_name IN ('library.read','document.read') AND json_valid(content)
           AND (json_extract(content,'$.sourceId')=? OR json_extract(content,'$.documentId')=?) LIMIT 1`,
            )
            .get(project.id, params.taskId, params.documentId, params.documentId),
        );
      if (!known)
        throw new LibraryError(
          'LIBRARY_READ_BLOCKED',
          'Direct read requires a saved task artifact or registered target. Discover other sources using library.search.',
          false,
        );
      const chunk = database
        .prepare(
          `SELECT chunks.id FROM project_library_chunks chunks JOIN documents d ON d.id=chunks.document_id
         WHERE chunks.project_id=? AND d.id=? AND d.lifecycle_status='active'
         AND chunks.version_id=? AND d.current_version_id=chunks.version_id
         AND ${taskLibraryVisibility()} ORDER BY chunks.id LIMIT 1`,
        )
        .get(project.id, params.documentId, params.expectedVersionId, generation.id) as
        | {
            id: string;
          }
        | undefined;
      if (!chunk)
        throw new LibraryError(
          'LIBRARY_READ_BLOCKED',
          'Artifact version is stale or unavailable. Read current task state/metadata before deciding how to proceed.',
          false,
        );
      this.pruneExpiredHandles();
      const handle = randomBytes(24).toString('base64url');
      this.sourceHandles.set(handle, {
        sourceHandle: handle,
        taskId: params.taskId,
        attemptId: params.attemptId,
        projectId: project.id,
        projectRoot: project.rootPath,
        chunkId: chunk.id,
        citationLabel: 'Artifact',
        expiresAt: Date.now() + SOURCE_HANDLE_TTL_MS,
      });
      return handle;
    });
    return this.read({ ...params, sourceHandle, readMode: 'source' });
  }
  read(params: {
    taskId: string;
    attemptId: string;
    sourceHandle: string;
    maxChars?: number;
    readMode?: 'chunk' | 'source';
    includeBindings?: boolean;
    offset?: number;
  }): LibraryReadResult {
    const handle = this.sourceHandles.get(params.sourceHandle);
    if (
      !handle ||
      handle.taskId !== params.taskId ||
      handle.attemptId !== params.attemptId ||
      handle.expiresAt <= Date.now()
    ) {
      throw new LibraryError(
        'LIBRARY_HANDLE_INVALID',
        'Library source handle is invalid or expired. Use a sourceHandle returned by library.search in this task and attempt; document IDs, version IDs and resourceIds are not handles. Search again with the correct sourceType or omit sourceTypes when unsure.',
        false,
      );
    }
    const readMode = params.readMode ?? 'chunk';
    if (readMode !== 'chunk' && readMode !== 'source') {
      throw new LibraryError('LIBRARY_READ_BLOCKED', 'Library read mode is invalid.', false);
    }
    if (params.includeBindings && readMode !== 'source')
      throw new LibraryError(
        'LIBRARY_READ_BLOCKED',
        'bindings is available only with readMode="source" for the exact retrieved document version.',
        false,
      );
    const offset = boundedInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const requestedMaxChars = boundedInteger(
      params.maxChars,
      readMode === 'source' ? MAX_READ_CHARS : DEFAULT_READ_CHARS,
      1,
      MAX_READ_CHARS,
    );
    // Keep an explicitly requested IR plus its Markdown page below the common
    // Agent tool-result bound, even for non-ASCII text.
    const maxChars = params.includeBindings ? Math.min(requestedMaxChars, 4000) : requestedMaxChars;
    return this.projects.access(false, (database, project) => {
      if (project.id !== handle.projectId || project.rootPath !== handle.projectRoot) {
        throw new LibraryError(
          'LIBRARY_HANDLE_INVALID',
          'Library source handle is invalid or expired.',
          false,
        );
      }
      const chunk = getProjectLibraryChunk(database, project.id, handle.chunkId);
      if (!chunk) {
        throw new LibraryError(
          'LIBRARY_READ_BLOCKED',
          'Library source is no longer available.',
          false,
        );
      }
      const generationId = (
        database
          .prepare('SELECT generation_id AS id FROM llm_generation_attempts WHERE id=?')
          .get(params.attemptId) as
          | {
              id: string;
            }
          | undefined
      )?.id;
      if (
        generationId &&
        !database
          .prepare(
            `SELECT 1 FROM project_library_chunks chunks WHERE chunks.id=? AND ${taskLibraryVisibility()}`,
          )
          .get(chunk.id, generationId)
      )
        throw new LibraryError(
          'LIBRARY_READ_BLOCKED',
          'Source is outside this task history boundary.',
          false,
        );
      // Use the immutable document version when possible. RAG chunks trim
      // whitespace and overlap, so joining them cannot reproduce every paragraph.
      const version =
        readMode === 'source' && chunk.documentId && chunk.versionId
          ? (database
              .prepare(
                `SELECT versions.content_markdown, versions.content_hash, versions.sample_text
                 FROM document_versions versions
                 INNER JOIN documents ON documents.id = versions.document_id
                 WHERE documents.project_id = ? AND documents.id = ? AND versions.id = ?`,
              )
              .get(project.id, chunk.documentId, chunk.versionId) as
              | {
                  content_markdown: string;
                  content_hash: string | null;
                  sample_text: string | null;
                }
              | undefined)
          : undefined;
      const contentBeforeLimit =
        readMode === 'source'
          ? (version?.content_markdown ??
            mergeSourceChunks(
              listProjectLibrarySourceChunks(
                database,
                project.id,
                chunk.sourceType,
                chunk.sourceId,
                chunk.versionId,
              ),
            ))
          : chunk.contentText;
      const bindings =
        params.includeBindings && chunk.documentId && chunk.versionId
          ? (() => {
              const row = database
                .prepare(
                  `SELECT versions.bindings_json, documents.kind
                   FROM document_versions versions
                   JOIN documents ON documents.id=versions.document_id
                   WHERE documents.project_id=? AND documents.id=? AND versions.id=?`,
                )
                .get(project.id, chunk.documentId, chunk.versionId) as
                | {
                    bindings_json: string | null;
                    kind: string;
                  }
                | undefined;
              if (
                !row?.bindings_json ||
                !['character', 'scene', 'prop', 'voice'].includes(row.kind)
              )
                return undefined;
              return validatePromptBindings(JSON.parse(row.bindings_json));
            })()
          : undefined;
      if (offset > contentBeforeLimit.length) {
        throw new LibraryError(
          'LIBRARY_READ_BLOCKED',
          'Library read offset is outside the source.',
          false,
        );
      }
      let endOffset = Math.min(contentBeforeLimit.length, offset + maxChars);
      // Never split a surrogate pair when a page ends in a non-BMP character.
      if (
        endOffset < contentBeforeLimit.length &&
        /[\uD800-\uDBFF]/u.test(contentBeforeLimit[endOffset - 1] ?? '')
      ) {
        endOffset -= 1;
      }
      if (endOffset === offset && offset < contentBeforeLimit.length) {
        throw new LibraryError(
          'LIBRARY_READ_BLOCKED',
          'Increase maxChars to read the next character.',
          false,
        );
      }
      const content = contentBeforeLimit.slice(offset, endOffset);
      const truncated = endOffset < contentBeforeLimit.length;
      return {
        status: 'read' as const,
        sourceHandle: handle.sourceHandle,
        readMode,
        sourceType: chunk.sourceType,
        sourceId: chunk.sourceId,
        versionId: chunk.versionId,
        sourceStatus: chunk.status as LibrarySourceStatus,
        kind: chunk.kind,
        title: chunk.title,
        content,
        ...(bindings ? { bindings } : {}),
        ...(version?.sample_text !== null && version?.sample_text !== undefined
          ? { sampleText: version.sample_text }
          : {}),
        characterCount: content.length,
        startOffset: offset,
        endOffset,
        ...(truncated ? { nextOffset: endOffset } : {}),
        totalCharacters: contentBeforeLimit.length,
        contentHash: version?.content_hash ?? sha256(contentBeforeLimit),
        truncated,
        citationLabel: handle.citationLabel,
        untrusted: false as const,
        ...(handle.structureKind
          ? {
              structureKind: handle.structureKind,
              structurePath: handle.structurePath,
              structureNodeId: handle.structureNodeId,
            }
          : {}),
        ...(chunk.status === 'draft' ? { candidateNote: DRAFT_CANDIDATE_NOTE } : {}),
      };
    });
  }
  private readCachedPage(
    database: Database.Database,
    projectId: string,
    generationId: string | undefined,
    cacheKey: string,
  ): LibrarySearchPage | undefined {
    const cached = this.searchCache.get(cacheKey);
    if (!cached) return undefined;
    const refreshedHits: LibrarySearchPage['hits'] = [];
    for (const hit of cached.hits) {
      const chunk = getProjectLibraryChunk(database, projectId, hit.chunk.id);
      if (!chunk) return undefined;
      if (
        generationId &&
        !database
          .prepare(
            `SELECT 1 FROM project_library_chunks chunks WHERE chunks.id=? AND ${taskLibraryVisibility()}`,
          )
          .get(chunk.id, generationId)
      ) {
        return undefined;
      }
      refreshedHits.push({ ...hit, chunk });
    }
    this.searchCache.delete(cacheKey);
    this.searchCache.set(cacheKey, cached);
    return { ...cached, hits: refreshedHits };
  }
  private writeCachedPage(cacheKey: string, page: LibrarySearchPage): void {
    this.searchCache.delete(cacheKey);
    this.searchCache.set(cacheKey, page);
    while (this.searchCache.size > SEARCH_CACHE_LIMIT) {
      const oldestKey = this.searchCache.keys().next().value;
      if (!oldestKey) break;
      this.searchCache.delete(oldestKey);
    }
  }
  private pruneExpiredHandles(): void {
    const now = Date.now();
    for (const [handle, source] of this.sourceHandles) {
      if (source.expiresAt <= now) this.sourceHandles.delete(handle);
    }
  }
}
function mergeSourceChunks(
  chunks: Array<{
    startOffset: number;
    endOffset: number;
    contentText: string;
  }>,
): string {
  if (chunks.length === 0) return '';
  let content = '';
  let coveredUntil = 0;
  for (const chunk of chunks) {
    const start = Math.max(0, chunk.startOffset);
    const end = Math.max(start, chunk.endOffset);
    if (end <= coveredUntil) continue;
    if (content && start > coveredUntil) content += '\n\n';
    const skip = Math.max(0, coveredUntil - start);
    content += chunk.contentText.slice(skip);
    coveredUntil = end;
  }
  return content;
}
function normalizeQuery(value: string, allowStructureWildcard = false): string {
  const query = value
    .normalize('NFC')
    .replace(/[\0\r\n\t]+/g, ' ')
    .trim();
  if (!query || query.length > 200 || (query === '*' && !allowStructureWildcard)) {
    throw new LibraryError('LIBRARY_SEARCH_FAILED', 'Library search query is invalid.', false);
  }
  return query;
}
function normalizeSourceTypes(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const allowed = new Set<string>(LIBRARY_SOURCE_TYPES);
  if (value.some((item) => !allowed.has(item))) {
    throw new LibraryError('LIBRARY_SEARCH_FAILED', 'Library sourceTypes is invalid.', false);
  }
  return value;
}
function normalizeStructurePath(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    value.length > 20 ||
    value.some((segment) => typeof segment !== 'string' || !segment.trim() || segment.length > 200)
  ) {
    throw new LibraryError('LIBRARY_SEARCH_FAILED', 'Library structurePath is invalid.', false);
  }
  return value.map((segment) => segment.normalize('NFC').trim());
}
function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LibraryError('LIBRARY_SEARCH_FAILED', 'Library numeric argument is invalid.', false);
  }
  return value;
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
