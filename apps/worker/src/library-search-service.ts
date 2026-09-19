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
  searchProjectLibraryChunks,
} from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

const SOURCE_HANDLE_TTL_MS = 10 * 60_000;
const SEARCH_CALL_LIMIT = 8;
const READ_CALL_LIMIT = 16;
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
      const hits = searchProjectLibraryChunks(database, {
        projectId: project.id,
        query,
        sourceTypes,
        status: params.status,
        kind: params.kind,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        includeArchived: params.includeArchived,
        limit: params.limit,
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
        };
      });
      this.incrementUsage(params.taskId, params.attemptId, 'search');
      return {
        status: 'searched' as const,
        queryHash: sha256(query),
        resultCount: sources.length,
        truncated: false,
        sources,
      };
    });
  }

  read(params: {
    taskId: string;
    attemptId: string;
    sourceHandle: string;
    maxChars?: number;
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
    const maxChars = boundedInteger(params.maxChars, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
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
      const truncated = chunk.contentText.length > maxChars;
      const content = chunk.contentText.slice(0, maxChars);
      this.incrementUsage(params.taskId, params.attemptId, 'read');
      return {
        status: 'read' as const,
        sourceHandle: handle.sourceHandle,
        sourceType: chunk.sourceType,
        sourceId: chunk.sourceId,
        versionId: chunk.versionId,
        sourceStatus: chunk.status as LibrarySourceStatus,
        kind: chunk.kind,
        title: chunk.title,
        content,
        characterCount: content.length,
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
          ? 'Library search budget has been exhausted.'
          : 'Library read budget has been exhausted.',
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
