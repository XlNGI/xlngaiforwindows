import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createRepositories } from '@ai-video/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageGenerationService } from './image-generation-service.js';
import { ProjectService } from './project-service.js';
import { NovelService } from './novel-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { MarkdownExportService } from './markdown-export-service.js';

const fixtures: Array<{ base: string; projects: ProjectService }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { base, projects } of fixtures.splice(0)) {
    projects.close();
    await rm(base, { recursive: true, force: true });
  }
});

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'project-export-regression-'));
  const projects = new ProjectService({ recentProjectsPath: join(base, 'recent.json') });
  fixtures.push({ base, projects });
  const project = projects.create(join(base, 'project'), 'Export fixture');
  const content = Buffer.from('immutable image fixture');
  const relativePath = 'assets/images/fixture.png';
  await writeFile(join(project.rootPath, relativePath), content);
  projects.access(true, (db) =>
    createRepositories(db).assets.save({
      id: 'image',
      projectId: project.id,
      kind: 'generated-image',
      relativePath,
      contentHash: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      createdAt: new Date().toISOString(),
    }),
  );
  return { base, projects, project, relativePath, content, destination: join(base, 'exported') };
}

function afterSnapshot(projects: ProjectService, action: () => Promise<void> | void) {
  const database = projects.access(false, (db) => db);
  const backup = database.backup.bind(database);
  vi.spyOn(database, 'backup').mockImplementation(async (destination) => {
    const result = await backup(destination);
    await action();
    return result;
  });
}

describe('consistent project export', () => {
  it.each(['files', 'merged'] as const)(
    'retains and verifies completed %s novel export packages',
    async (exportFormat) => {
      const f = await setup();
      const chapter = new NovelService(f.projects).saveChapter({ title: 'Chapter' });
      new DocumentWorkflowService(f.projects).saveDraft({
        documentId: chapter.documentId,
        title: 'Chapter',
        contentMarkdown: 'Saved chapter',
        expectedDocumentRowVersion: 0,
        authorType: 'user',
      });
      const exported = await new MarkdownExportService(f.projects).prepare({
        exportType: 'work',
        exportFormat,
        includeDraft: true,
      });
      await f.projects.exportProject(f.destination);
      const relativePackage = f.projects.access(
        false,
        (db) =>
          db
            .prepare('SELECT package_relative_path AS path FROM markdown_export_jobs WHERE id = ?')
            .get(exported.id) as { path: string },
      );
      expect(
        await readFile(join(f.destination, relativePackage.path, 'manifest.json'), 'utf8'),
      ).toBe(await readFile(join(exported.packagePath, 'manifest.json'), 'utf8'));
      f.projects.close();
      f.projects.open(f.destination);
      const recovered = new MarkdownExportService(f.projects, vi.fn());
      expect(await recovered.reveal({ jobId: exported.id })).toMatchObject({
        path: join(f.destination, relativePackage.path),
      });
    },
  );

  it('rejects a deletion after the database snapshot instead of publishing a broken project', async () => {
    const f = await setup();
    afterSnapshot(f.projects, () => {
      new ImageGenerationService(f.projects).deleteAsset('image');
    });
    await expect(f.projects.exportProject(f.destination)).rejects.toThrow(/export|导出/i);
    expect(existsSync(f.destination)).toBe(false);
    expect(existsSync(join(f.project.rootPath, 'cache/deleted-assets/image.png'))).toBe(true);
    expect((await readdir(f.base)).some((name) => name.startsWith('.project-export-'))).toBe(false);
  });

  it('verifies snapshot hashes and leaves an existing empty destination intact on failure', async () => {
    const f = await setup();
    await mkdir(f.destination);
    afterSnapshot(f.projects, () => writeFile(join(f.project.rootPath, f.relativePath), 'changed'));
    await expect(f.projects.exportProject(f.destination)).rejects.toThrow(/export|导出/i);
    expect(await readdir(f.destination)).toEqual([]);
  });

  it('exports deleted assets at their recoverable paths and validates them against the snapshot', async () => {
    const f = await setup();
    new ImageGenerationService(f.projects).deleteAsset('image');
    await f.projects.exportProject(f.destination);
    expect(await readFile(join(f.destination, 'cache/deleted-assets/image.png'))).toEqual(
      f.content,
    );
    const db = new Database(join(f.destination, 'project.sqlite'), { readonly: true });
    try {
      expect(
        db.prepare('SELECT trash_relative_path FROM assets WHERE id = ?').get('image'),
      ).toMatchObject({ trash_relative_path: join('cache', 'deleted-assets', 'image.png') });
    } finally {
      db.close();
    }
    const copy = new ProjectService({ recentProjectsPath: join(f.base, 'copy-recent.json') });
    try {
      copy.open(f.destination);
      expect(copy.integrity().ok).toBe(true);
      new ImageGenerationService(copy).restoreAsset('image');
      expect(await readFile(join(f.destination, f.relativePath))).toEqual(f.content);
    } finally {
      copy.close();
    }
  });

  it('does not publish a snapshot after the project session changes', async () => {
    const f = await setup();
    afterSnapshot(f.projects, () => {
      f.projects.close();
      f.projects.open(f.project.rootPath);
    });
    await expect(f.projects.exportProject(f.destination)).rejects.toThrow(/session|会话/i);
    expect(existsSync(f.destination)).toBe(false);
  });

  it('preserves a file placed in the destination while a snapshot was being made', async () => {
    const f = await setup();
    afterSnapshot(f.projects, async () => {
      await mkdir(f.destination);
      await writeFile(join(f.destination, 'user.txt'), 'user content');
    });
    await expect(f.projects.exportProject(f.destination)).rejects.toThrow(/destination|目标/i);
    expect(await readdir(f.destination)).toEqual(['user.txt']);
    expect(await readFile(join(f.destination, 'user.txt'), 'utf8')).toBe('user content');
  });

  it('rejects export directory links instead of following them outside the project', async () => {
    const f = await setup();
    const outside = join(f.base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.txt'), 'not part of project');
    await symlink(outside, join(f.project.rootPath, 'exports', 'linked'), 'junction');
    await expect(f.projects.exportProject(f.destination)).rejects.toThrow(/link|链接/i);
    expect(existsSync(f.destination)).toBe(false);
    expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('not part of project');
  });
});
