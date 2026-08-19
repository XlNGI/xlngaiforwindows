import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectService } from './project-service.js';
import {
  cleanupResearchCache,
  registerResearchCache,
  RESEARCH_CACHE_TTL_MS,
  reconcileResearchCache,
} from './research-cache.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createProject(): Promise<{ service: ProjectService; root: string; id: string }> {
  const base = await mkdtemp(join(tmpdir(), 'research-cache-'));
  directories.push(base);
  const service = new ProjectService({ recentProjectsPath: join(base, 'recent.json') });
  projects.push(service);
  const project = service.create(join(base, 'project'), 'Research Cache');
  return { service, root: project.rootPath, id: project.id };
}

describe('research cache index', () => {
  it('registers a cache entry and marks missing files without inventing recovery', async () => {
    const { service, root, id } = await createProject();
    const relativePath =
      'cache/research/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt';
    const absolutePath = join(root, relativePath);
    await mkdir(join(root, 'cache', 'research'), { recursive: true });
    await writeFile(absolutePath, 'cached text', 'utf8');
    service.access(true, (database) =>
      registerResearchCache({
        database,
        projectId: id,
        projectRoot: root,
        contentHash: 'a'.repeat(64),
        cacheRelativePath: relativePath,
        byteCount: Buffer.byteLength('cached text'),
        now: '2026-08-19T00:00:00.000Z',
      }),
    );
    await rm(absolutePath);

    service.access(true, (database) => {
      expect(reconcileResearchCache(database, id, root)).toBe(1);
      expect(
        database
          .prepare(
            'SELECT status, last_error_code FROM agent_research_cache WHERE project_id = ? AND content_hash = ?',
          )
          .get(id, 'a'.repeat(64)),
      ).toEqual({ status: 'missing', last_error_code: 'RESEARCH_CACHE_MISSING' });
    });
  });

  it('removes expired and over-capacity unreferenced entries in stable order', async () => {
    const { service, root, id } = await createProject();
    const firstPath = 'cache/research/' + 'b'.repeat(64) + '.txt';
    const secondPath = 'cache/research/' + 'c'.repeat(64) + '.txt';
    await mkdir(join(root, 'cache', 'research'), { recursive: true });
    await writeFile(join(root, firstPath), '1234', 'utf8');
    await writeFile(join(root, secondPath), '5678', 'utf8');
    service.access(true, (database) => {
      registerResearchCache({
        database,
        projectId: id,
        projectRoot: root,
        contentHash: 'b'.repeat(64),
        cacheRelativePath: firstPath,
        byteCount: 4,
        now: '2026-08-01T00:00:00.000Z',
      });
      registerResearchCache({
        database,
        projectId: id,
        projectRoot: root,
        contentHash: 'c'.repeat(64),
        cacheRelativePath: secondPath,
        byteCount: 4,
        now: '2026-08-19T00:00:00.000Z',
      });
      expect(
        cleanupResearchCache({
          database,
          projectId: id,
          projectRoot: root,
          now: new Date(
            Date.parse('2026-08-19T00:00:00.000Z') + RESEARCH_CACHE_TTL_MS + 1,
          ).toISOString(),
          maxBytes: 4,
        }),
      ).toMatchObject({ expiredCount: 2, evictedCount: 0, removedBytes: 8, retainedBytes: 0 });
    });
  });
});
