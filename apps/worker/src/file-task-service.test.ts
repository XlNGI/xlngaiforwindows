import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories, checkIntegrity } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { NovelService } from './novel-service.js';
import { FileTaskService } from './file-task-service.js';
import { MarkdownExportService } from './markdown-export-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ExecutionPool } from './execution-pool.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.restoreAllMocks();
});
async function fixture(pool = new ExecutionPool()) {
  const root = await mkdtemp(join(tmpdir(), 'file-task-'));
  const project = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  project.create(join(root, 'project'), 'File tasks');
  const novel = new NovelService(project),
    files = new FileTaskService(project, novel, pool),
    exports = new MarkdownExportService(project, undefined, pool);
  cleanup.push(async () => {
    await files.stop();
    await exports.stop();
    project.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, novel, files, exports, pool };
}
it('persists queue acceptance, cancels only its own waiter, coalesces an operation key and keeps imported text and indexes atomic', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = f.pool.run(
    'file-io',
    'another-project',
    undefined,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const exportSpy = vi.spyOn(f.project, 'exportProject');
  const cancelled = f.files.create({
    kind: 'project-export',
    destinationRoot: join(f.root, 'cancelled-output'),
    idempotencyKey: 'cancel-export',
  });
  const params = {
    kind: 'novel-import' as const,
    idempotencyKey: 'import-once',
    input: {
      volumeTitle: 'Volume',
      chapters: [
        { title: 'One', contentMarkdown: 'Atomic imported source token' },
        { title: 'Two', contentMarkdown: 'Independent source token' },
      ],
    },
  };
  const imported = f.files.create(params);
  expect(f.files.create(params).id).toBe(imported.id);
  expect(() =>
    f.files.create({ ...params, input: { ...params.input, volumeTitle: 'Other' } }),
  ).toThrow('different input');
  expect(f.files.get(imported.id).status).toBe('pending');
  expect((await f.files.cancel(cancelled.id)).status).toBe('cancelled');
  expect(exportSpy).not.toHaveBeenCalled();
  expect(f.novel.listChapters()).toEqual([]);
  release();
  await held;
  expect((await f.files.wait(imported.id)).status).toBe('succeeded');
  expect(f.novel.listChapters()).toHaveLength(2);
  f.project.access(false, (database) => {
    expect(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM project_library_chunks WHERE source_type='novel-chapter'",
          )
          .get() as { n: number }
      ).n,
    ).toBeGreaterThan(0);
    expect(checkIntegrity(database).ok).toBe(true);
    expect(
      database.prepare('SELECT input_json FROM file_tasks WHERE id=?').get(imported.id),
    ).toEqual({ input_json: '{}' });
  });
  const invalid = f.files.create({
    kind: 'novel-import',
    idempotencyKey: 'invalid-import',
    input: {
      chapters: [
        { title: 'Would have been written', contentMarkdown: 'valid' },
        { title: 'Invalid', contentMarkdown: '  ' },
      ],
    },
  });
  expect((await f.files.wait(invalid.id)).status).toBe('failed');
  expect(f.novel.listChapters()).toHaveLength(2);
});

it('runs a real export with complete references and leaves a nonempty destination intact on failure', async () => {
  const f = await fixture(),
    bytes = Buffer.from('owned reference bytes'),
    hash = createHash('sha256').update(bytes).digest('hex');
  const path = join(f.project.current()!.rootPath, 'assets', 'images', 'source.bin');
  await writeFile(path, bytes);
  f.project.access(true, (database, project) =>
    createRepositories(database).assets.save({
      id: 'asset',
      projectId: project.id,
      kind: 'generated-image',
      relativePath: 'assets/images/source.bin',
      contentHash: hash,
      sizeBytes: bytes.length,
      createdAt: 'now',
    }),
  );
  const destination = join(f.root, 'exported');
  const job = f.files.create({
    kind: 'project-export',
    destinationRoot: destination,
    idempotencyKey: 'real-export',
  });
  const done = await f.files.wait(job.id);
  expect(done.status).toBe('succeeded');
  expect(await readFile(join(destination, 'assets', 'images', 'source.bin'))).toEqual(bytes);
  expect(
    JSON.parse(await readFile(join(destination, 'project-snapshot.json'), 'utf8')),
  ).toMatchObject({ kind: 'project-history', projectId: f.project.current()!.id });
  const occupied = join(f.root, 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'user.txt'), 'keep');
  const failed = f.files.create({
    kind: 'project-export',
    destinationRoot: occupied,
    idempotencyKey: 'occupied-export',
  });
  expect((await f.files.wait(failed.id)).status).toBe('failed');
  expect(await readFile(join(occupied, 'user.txt'), 'utf8')).toBe('keep');
});

it('keeps one existing Markdown owner, freezes source versions, and cancels a queued export without touching its sibling output', async () => {
  const f = await fixture();
  const chapter = f.novel.saveChapter({ title: 'Frozen' }),
    documents = new DocumentWorkflowService(f.project);
  const draft = documents.saveDraft({
    documentId: chapter.documentId,
    title: 'Frozen',
    contentMarkdown: 'Original frozen export',
    expectedDocumentRowVersion: 0,
  });
  let release!: () => void;
  const held = f.pool.run(
    'file-io',
    'other',
    undefined,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const first = f.exports.start({ exportType: 'work', includeDraft: true }),
    second = f.exports.start({ exportType: 'work', includeDraft: true });
  expect(first.status).toBe('queued');
  expect((await f.exports.cancel(second.id)).status).toBe('cancelled');
  documents.saveDraft({
    documentId: chapter.documentId,
    title: 'Changed',
    contentMarkdown: 'Later edited content',
    expectedDocumentRowVersion: draft.rowVersion,
  });
  release();
  await held;
  await f.exports.wait(first.id);
  expect(f.exports.get(first.id).status).toBe('succeeded');
  expect(f.exports.list()).toHaveLength(2);
  expect(f.files.list()).toEqual([]);
  const manifest = JSON.parse(await readFile(join(first.packagePath, 'manifest.json'), 'utf8')) as {
    items: Array<{ relativePath: string; documentVersionId: string }>;
  };
  expect(manifest.items[0]!.documentVersionId).toBe(draft.currentVersionId);
  expect(
    await readFile(join(first.packagePath, manifest.items[0]!.relativePath), 'utf8'),
  ).toContain('Original frozen export');
  expect(
    (await readdir(join(f.project.current()!.rootPath, 'exports'))).some((name) =>
      name.includes(second.id),
    ),
  ).toBe(false);
});

it('cancels import during preparation with no partial chapters or index changes and interrupts persisted work without replay', async () => {
  const f = await fixture();
  const importJob = f.files.create({
    kind: 'novel-import',
    idempotencyKey: 'cancel-import',
    input: {
      chapters: Array.from({ length: 30 }, (_, index) => ({
        title: 'Chapter ' + index,
        contentMarkdown: 'Prepare source. '.repeat(20000),
      })),
    },
  });
  await expect.poll(() => f.files.get(importJob.id).progress).toBeGreaterThan(0);
  expect((await f.files.cancel(importJob.id)).status).toBe('cancelled');
  expect(f.novel.listChapters()).toEqual([]);
  f.project.access(true, (database, project) =>
    database
      .prepare(
        `INSERT INTO file_tasks(id,project_id,runtime_epoch,kind,operation_key,request_hash,input_json,status,created_at,updated_at)VALUES('crashed',?,'old','project-export','crashed','hash','{}','running','now','now')`,
      )
      .run(project.id),
  );
  const exportSpy = vi.spyOn(f.project, 'exportProject');
  f.files.recover();
  expect(f.files.get('crashed').status).toBe('interrupted');
  expect(exportSpy).not.toHaveBeenCalled();
});

it('rejects the thirty-third project business task and cancels the full queue without a backup side effect', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = f.pool.run(
    'file-io',
    'external-project',
    undefined,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const backup = vi.spyOn(f.project, 'backup');
  const tasks = Array.from({ length: 32 }, (_, index) =>
    f.files.create({ kind: 'project-backup', idempotencyKey: 'bounded-' + index }),
  );
  expect(() =>
    f.files.create({
      kind: 'novel-import',
      idempotencyKey: 'thirty-third',
      input: { chapters: [{ title: 'No admission', contentMarkdown: 'not written' }] },
    }),
  ).toThrow('queue is full');
  await Promise.all(tasks.map((job) => f.files.cancel(job.id)));
  expect(f.files.list().every((job) => job.status === 'cancelled')).toBe(true);
  expect(backup).not.toHaveBeenCalled();
  release();
  await held;
});
