import { createHash, randomBytes } from 'node:crypto';
import type {
  LibraryErrorCode,
  LibraryReadResult,
  LibrarySearchResult,
  LibrarySourceStatus,
} from '@ai-video/contracts';
import {
  getProjectLibraryChunk,
  librarySnippet,
  LIBRARY_SOURCE_TYPES,
  listProjectLibrarySourceChunks,
  searchProjectLibraryChunksPage,
} from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

const SOURCE_HANDLE_TTL_MS = 10 * 60_000;
const SEARCH_CALL_LIMIT = 4;
const READ_CALL_LIMIT = 8;
const DEFAULT_READ_CHARS = 4_000;
const MAX_READ_CHARS = 20_000;
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
  chunkId: string;
  citationLabel: string;
  expiresAt: number;
}

interface LibraryUsage {
  search: number;
  read: number;
}

export class LibrarySearchService {
  private readonly sourceHandles = new Map<string, LibraryHandleRecord>();
  private readonly usage = new Map<string, LibraryUsage>();

  constructor(private readonly projects: ProjectService) {}

  search(params: {
    taskId: string;
    attemptId: string;
    query: string;
    sourceTypes?: string[];
    status?: string;
    kind?: string;
    scopeType?: string;
    scopeId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): LibrarySearchResult {
    this.assertBudget(params.taskId, params.attemptId, 'search');
    const query = normalizeQuery(params.query);
    const sourceTypes = normalizeSourceTypes(params.sourceTypes);
    return this.projects.access(false, (database, project) => {
      const { hits, truncated } = searchProjectLibraryChunksPage(database, {
        projectId: project.id,
        query,
        sourceTypes,
        status: params.status,
        kind: params.kind,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        includeArchived: params.includeArchived,
        limit: boundedInteger(params.limit, 8, 1, 20),
      });
      this.pruneExpiredHandles();
      const sources = hits.map((hit, index) => {
        const sourceHandle = randomBytes(24).toString('base64url');
        const citationLabel = `L${index + 1}`;
        this.sourceHandles.set(sourceHandle, {
          sourceHandle,
          taskId: params.taskId,
          attemptId: params.attemptId,
          projectId: project.id,
          chunkId: hit.chunk.id,
          citationLabel,
          expiresAt: Date.now() + SOURCE_HANDLE_TTL_MS,
        });
        return {
          sourceHandle,
          sourceType: hit.chunk.sourceType,
          sourceId: hit.chunk.sourceId,
          versionId: hit.chunk.versionId,
          status: hit.chunk.status as LibrarySourceStatus,
          kind: hit.chunk.kind,
          title: hit.chunk.title,
          snippet: librarySnippet(hit.chunk.contentText, query),
          citationLabel,
          updatedAt: hit.chunk.updatedAt,
          chunkOrdinal: hit.chunk.ordinal,
          startOffset: hit.chunk.startOffset,
          endOffset: hit.chunk.endOffset,
        };
      });
      this.incrementUsage(params.taskId, params.attemptId, 'search');
      return {
        status: 'searched' as const,
        queryHash: sha256(query),
        resultCount: sources.length,
        truncated,
        sources,
      };
    });
  }

  read(params: {
    taskId: string;
    attemptId: string;
    sourceHandle: string;
    maxChars?: number;
    readMode?: 'chunk' | 'source';
    offset?: number;
  }): LibraryReadResult {
    this.assertBudget(params.taskId, params.attemptId, 'read');
    const handle = this.sourceHandles.get(params.sourceHandle);
    if (
      !handle ||
      handle.taskId !== params.taskId ||
      handle.attemptId !== params.attemptId ||
      handle.expiresAt <= Date.now()
    ) {
      throw new LibraryError(
        'LIBRARY_HANDLE_INVALID',
        'Library source handle is invalid or expired.',
        false,
      );
    }
    const readMode = params.readMode ?? 'chunk';
    if (readMode !== 'chunk' && readMode !== 'source') {
      throw new LibraryError('LIBRARY_READ_BLOCKED', 'Library read mode is invalid.', false);
    }
    const offset = boundedInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxChars = boundedInteger(
      params.maxChars,
      readMode === 'source' ? MAX_READ_CHARS : DEFAULT_READ_CHARS,
      1,
      MAX_READ_CHARS,
    );
    return this.projects.access(false, (database, project) => {
      if (project.id !== handle.projectId) {
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
      // Use the immutable document version when possible. RAG chunks trim
      // whitespace and overlap, so joining them cannot reproduce every paragraph.
      const version =
        readMode === 'source' && chunk.documentId && chunk.versionId
          ? (database
              .prepare(
                `SELECT versions.content_markdown, versions.content_hash
                 FROM document_versions versions
                 INNER JOIN documents ON documents.id = versions.document_id
                 WHERE documents.project_id = ? AND documents.id = ? AND versions.id = ?`,
              )
              .get(project.id, chunk.documentId, chunk.versionId) as
              { content_markdown: string; content_hash: string | null } | undefined)
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
      this.incrementUsage(params.taskId, params.attemptId, 'read');
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
        characterCount: content.length,
        startOffset: offset,
        endOffset,
        ...(truncated ? { nextOffset: endOffset } : {}),
        totalCharacters: contentBeforeLimit.length,
        contentHash: version?.content_hash ?? sha256(contentBeforeLimit),
        truncated,
        citationLabel: handle.citationLabel,
        untrusted: false as const,
        ...(chunk.status === 'draft' ? { candidateNote: DRAFT_CANDIDATE_NOTE } : {}),
      };
    });
  }

  private assertBudget(taskId: string, attemptId: string, operation: 'search' | 'read'): void {
    const usage = this.usage.get(usageKey(taskId, attemptId)) ?? { search: 0, read: 0 };
    const limit = operation === 'search' ? SEARCH_CALL_LIMIT : READ_CALL_LIMIT;
    if (usage[operation] >= limit) {
      throw new LibraryError(
        'LIBRARY_BUDGET_EXCEEDED',
        operation === 'search'
          ? '本轮检索次数已达上限。请停止检索；已有证据不足时说明缺口，不得编造未读取的项目内容。'
          : '本轮正文读取次数已达上限。请停止读取并说明已读取范围及缺口，不得把未读部分当作已知内容。',
        false,
      );
    }
  }

  private incrementUsage(taskId: string, attemptId: string, operation: 'search' | 'read'): void {
    const key = usageKey(taskId, attemptId);
    const usage = this.usage.get(key) ?? { search: 0, read: 0 };
    usage[operation] += 1;
    this.usage.set(key, usage);
  }

  private pruneExpiredHandles(): void {
    const now = Date.now();
    for (const [handle, source] of this.sourceHandles) {
      if (source.expiresAt <= now) this.sourceHandles.delete(handle);
    }
  }
}

function mergeSourceChunks(
  chunks: Array<{ startOffset: number; endOffset: number; contentText: string }>,
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

function normalizeQuery(value: string): string {
  const query = value
    .normalize('NFC')
    .replace(/[\0\r\n\t]+/g, ' ')
    .trim();
  if (!query || query.length > 200) {
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

function usageKey(taskId: string, attemptId: string): string {
  return `${taskId}:${attemptId}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
