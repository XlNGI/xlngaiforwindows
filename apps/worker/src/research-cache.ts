import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';

const RESEARCH_CACHE_RELATIVE_ROOT = 'cache/research';
export const RESEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const RESEARCH_CACHE_MAX_BYTES = 128 * 1024 * 1024;

export interface ResearchCacheCleanupResult {
  missingCount: number;
  expiredCount: number;
  evictedCount: number;
  removedBytes: number;
  retainedBytes: number;
}

interface CacheRow {
  project_id: string;
  content_hash: string;
  cache_relative_path: string;
  byte_count: number;
  last_accessed_at: string;
  expires_at: string;
  status: 'present' | 'missing' | 'expired';
}

function assertCacheRelativePath(projectRoot: string, cacheRelativePath: string): string {
  if (
    !cacheRelativePath.startsWith(`${RESEARCH_CACHE_RELATIVE_ROOT}/`) ||
    cacheRelativePath.includes('..')
  ) {
    throw new Error('Research cache path is outside the allowed directory.');
  }
  const absolute = resolve(projectRoot, ...cacheRelativePath.split('/'));
  const child = relative(resolve(projectRoot, RESEARCH_CACHE_RELATIVE_ROOT), absolute);
  if (
    child === '' ||
    child.startsWith(`..${sep}`) ||
    child === '..' ||
    child.includes(`..${sep}`)
  ) {
    throw new Error('Research cache path is outside the allowed directory.');
  }
  return absolute;
}

function removeFileIfRegular(path: string): number {
  if (!existsSync(path)) return 0;
  const stats = lstatSync(path);
  if (!stats.isFile()) return 0;
  unlinkSync(path);
  return stats.size;
}

function markSourcesUnavailable(
  database: Database.Database,
  projectId: string,
  contentHash: string,
  errorCode: 'RESEARCH_CACHE_MISSING' | 'RESEARCH_CACHE_EXPIRED' | 'RESEARCH_CACHE_EVICTED',
): void {
  database
    .prepare(
      `UPDATE agent_research_sources
       SET status = 'failed', error_code = ?
       WHERE project_id = ? AND content_hash = ? AND status = 'fetched'`,
    )
    .run(errorCode, projectId, contentHash);
}

export function registerResearchCache(params: {
  database: Database.Database;
  projectId: string;
  projectRoot: string;
  contentHash: string;
  cacheRelativePath: string;
  byteCount: number;
  now: string;
}): void {
  const cachePath = assertCacheRelativePath(params.projectRoot, params.cacheRelativePath);
  if (!existsSync(cachePath) || !lstatSync(cachePath).isFile()) {
    throw new Error('Research cache file is missing before index registration.');
  }
  const expiresAt = new Date(Date.parse(params.now) + RESEARCH_CACHE_TTL_MS).toISOString();
  params.database
    .prepare(
      `INSERT INTO agent_research_cache
       (project_id, content_hash, cache_relative_path, byte_count, created_at,
        last_accessed_at, expires_at, status, last_error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'present', NULL)
       ON CONFLICT(project_id, content_hash) DO UPDATE SET
         cache_relative_path = excluded.cache_relative_path,
         byte_count = excluded.byte_count,
         last_accessed_at = excluded.last_accessed_at,
         expires_at = excluded.expires_at,
         status = 'present',
         last_error_code = NULL`,
    )
    .run(
      params.projectId,
      params.contentHash,
      params.cacheRelativePath,
      params.byteCount,
      params.now,
      params.now,
      expiresAt,
    );
}

export function clearResearchCacheIndex(database: Database.Database, projectId: string): number {
  return database.prepare('DELETE FROM agent_research_cache WHERE project_id = ?').run(projectId)
    .changes;
}

export function reconcileResearchCache(
  database: Database.Database,
  projectId: string,
  projectRoot: string,
): number {
  let missingCount = 0;
  const rows = database
    .prepare('SELECT * FROM agent_research_cache WHERE project_id = ?')
    .all(projectId) as CacheRow[];
  const markMissing = database.prepare(
    `UPDATE agent_research_cache
     SET status = 'missing', last_error_code = 'RESEARCH_CACHE_MISSING'
     WHERE project_id = ? AND content_hash = ?`,
  );
  for (const row of rows) {
    const path = assertCacheRelativePath(projectRoot, row.cache_relative_path);
    let valid = false;
    if (existsSync(path)) {
      const stats = lstatSync(path);
      valid = stats.isFile() && stats.size === row.byte_count;
    }
    if (!valid && row.status !== 'missing') {
      markMissing.run(projectId, row.content_hash);
      markSourcesUnavailable(database, projectId, row.content_hash, 'RESEARCH_CACHE_MISSING');
      missingCount += 1;
    }
  }
  return missingCount;
}

export function cleanupResearchCache(params: {
  database: Database.Database;
  projectId: string;
  projectRoot: string;
  now: string;
  maxBytes?: number;
}): ResearchCacheCleanupResult {
  const maxBytes = Math.max(0, Math.floor(params.maxBytes ?? RESEARCH_CACHE_MAX_BYTES));
  const result: ResearchCacheCleanupResult = {
    missingCount: reconcileResearchCache(params.database, params.projectId, params.projectRoot),
    expiredCount: 0,
    evictedCount: 0,
    removedBytes: 0,
    retainedBytes: 0,
  };
  const rows = params.database
    .prepare(
      `SELECT * FROM agent_research_cache
       WHERE project_id = ?
       ORDER BY last_accessed_at ASC, content_hash ASC`,
    )
    .all(params.projectId) as CacheRow[];
  const referenceCount = params.database.prepare(
    `SELECT COUNT(*) AS count
     FROM document_version_research_sources
     WHERE project_id = ? AND source_id IN (
       SELECT id FROM agent_research_sources
       WHERE project_id = ? AND content_hash = ?
     )`,
  );
  const remove = params.database.prepare(
    'DELETE FROM agent_research_cache WHERE project_id = ? AND content_hash = ?',
  );
  const nowMs = Date.parse(params.now);
  const retained: CacheRow[] = [];
  for (const row of rows) {
    const references = (
      referenceCount.get(params.projectId, params.projectId, row.content_hash) as {
        count: number;
      }
    ).count;
    const expired = Date.parse(row.expires_at) <= nowMs;
    if ((expired || row.status !== 'present') && references === 0) {
      const path = assertCacheRelativePath(params.projectRoot, row.cache_relative_path);
      result.removedBytes += removeFileIfRegular(path);
      remove.run(params.projectId, row.content_hash);
      if (expired) {
        result.expiredCount += 1;
        markSourcesUnavailable(
          params.database,
          params.projectId,
          row.content_hash,
          'RESEARCH_CACHE_EXPIRED',
        );
      }
      continue;
    }
    retained.push(row);
  }
  let retainedBytes = retained
    .filter((row) => row.status === 'present')
    .reduce((total, row) => total + row.byte_count, 0);
  for (const row of retained) {
    if (retainedBytes <= maxBytes || row.status !== 'present') continue;
    const references = (
      referenceCount.get(params.projectId, params.projectId, row.content_hash) as {
        count: number;
      }
    ).count;
    if (references > 0) continue;
    const path = assertCacheRelativePath(params.projectRoot, row.cache_relative_path);
    const removedBytes = removeFileIfRegular(path);
    remove.run(params.projectId, row.content_hash);
    retainedBytes = Math.max(0, retainedBytes - row.byte_count);
    result.removedBytes += removedBytes;
    result.evictedCount += 1;
    markSourcesUnavailable(
      params.database,
      params.projectId,
      row.content_hash,
      'RESEARCH_CACHE_EVICTED',
    );
  }
  result.retainedBytes = retainedBytes;
  return result;
}

export function ensureResearchCacheDirectory(projectRoot: string): void {
  mkdirSync(join(projectRoot, RESEARCH_CACHE_RELATIVE_ROOT), { recursive: true });
}

export function inspectResearchCacheDirectory(projectRoot: string): number {
  const directory = resolve(projectRoot, RESEARCH_CACHE_RELATIVE_ROOT);
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).length;
}
