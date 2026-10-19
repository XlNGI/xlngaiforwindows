import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { MarkdownExportService } from './markdown-export-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';
import { validateSessionRequestParams } from './request-validation.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('MarkdownExportService', () => {
  it('requires explicit draft inclusion, exports only selected chapters in order and marks draft filenames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-export-drafts-'));
    directories.push(directory);
    const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projects.push(project);
    project.create(join(directory, 'project'), 'Novel');
    const novel = new NovelService(project);
    const workflow = new DocumentWorkflowService(project);
    const chapters = ['First', 'Second', 'Third'].map((title) => {
      const chapter = novel.saveChapter({ title });
      workflow.saveDraft({
        documentId: chapter.documentId,
        title,
        contentMarkdown: `${title} body`,
        expectedDocumentRowVersion: 0,
        authorType: 'user',
      });
      return chapter;
    });
    const exports = new MarkdownExportService(project);
    await expect(exports.prepare({ exportType: 'work' })).rejects.toThrow('请勾选“包含草稿”');
    const job = await exports.prepare({
      exportType: 'selection',
      chapterIds: [chapters[2]!.id, chapters[0]!.id],
      includeDraft: true,
    });
    expect(job.itemCount).toBe(2);
    const manifest = JSON.parse(await readFile(join(job.packagePath, 'manifest.json'), 'utf8')) as {
      items: Array<{ chapterId: string; sourceState: string; relativePath: string }>;
    };
    expect(manifest.items.map((item) => item.chapterId)).toEqual([
      chapters[0]!.id,
      chapters[2]!.id,
    ]);
    for (const item of manifest.items) {
      expect(item.sourceState).toBe('draft');
      expect(item.relativePath).toMatch(/\.draft\.v1\.md$/);
    }
    expect(
      await readFile(join(job.packagePath, manifest.items[0]!.relativePath), 'utf8'),
    ).toContain('First body');
  });

  it('marks merged drafts, verifies their recovery hashes and opens only a completed export owned by the current project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-export-open-'));
    directories.push(directory);
    const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projects.push(project);
    project.create(join(directory, 'project'), 'Novel');
    const chapter = new NovelService(project).saveChapter({ title: 'Draft' });
    new DocumentWorkflowService(project).saveDraft({
      documentId: chapter.documentId,
      title: 'Draft',
      contentMarkdown: 'Saved draft body',
      expectedDocumentRowVersion: 0,
      authorType: 'user',
    });
    const openDirectory = vi.fn();
    const exports = new MarkdownExportService(project, openDirectory);
    const job = await exports.prepare({
      exportType: 'work',
      exportFormat: 'merged',
      includeDraft: true,
    });
    expect(await readFile(join(job.packagePath, 'merged.draft.md'), 'utf8')).toContain(
      'Saved draft body',
    );
    expect(await exports.reveal({ jobId: job.id })).toEqual({ path: job.packagePath });
    expect(openDirectory).toHaveBeenCalledExactlyOnceWith(job.packagePath);
    openDirectory.mockClear();
    await expect(exports.reveal({ jobId: 'unknown-export' })).rejects.toThrow('没有找到已完成');
    const setVerifying = () =>
      project.access(true, (database) => {
        database
          .prepare("UPDATE markdown_export_jobs SET status = 'verifying' WHERE id = ?")
          .run(job.id);
        database
          .prepare("UPDATE markdown_export_items SET status = 'verifying' WHERE job_id = ?")
          .run(job.id);
      });
    setVerifying();
    await expect(exports.reveal({ jobId: job.id })).rejects.toThrow('没有找到已完成');
    expect(exports.reconcile()).toEqual({ succeeded: 1, failed: 0 });
    await writeFile(join(job.packagePath, 'merged.draft.md'), 'Tampered body', 'utf8');
    setVerifying();
    expect(exports.reconcile()).toEqual({ succeeded: 0, failed: 1 });
    expect(openDirectory).not.toHaveBeenCalled();

    const otherJob = await exports.prepare({ exportType: 'work', includeDraft: true });
    project.access(true, (database) =>
      database
        .prepare('UPDATE markdown_export_jobs SET package_relative_path = ? WHERE id = ?')
        .run('exports/../outside', otherJob.id),
    );
    await expect(exports.reveal({ jobId: otherJob.id })).rejects.toThrow('导出目录无效');
    const movedJob = await exports.prepare({ exportType: 'work', includeDraft: true });
    await rm(movedJob.packagePath, { recursive: true, force: true });
    await expect(exports.reveal({ jobId: movedJob.id })).rejects.toThrow('已被移动或删除');
    project.close();
    project.create(join(directory, 'other-project'), 'Other novel');
    await expect(exports.reveal({ jobId: otherJob.id })).rejects.toThrow('没有找到已完成');
    expect(openDirectory).not.toHaveBeenCalled();
  });

  it('accepts long-novel chapter selections and rejects arbitrary paths at the folder-opening boundary', () => {
    const params = {
      exportType: 'selection',
      chapterIds: Array.from({ length: 1000 }, (_, index) => `chapter-${index}`),
    };
    expect(validateSessionRequestParams('novel.export.prepare', params)).toBe(params);
    expect(() =>
      validateSessionRequestParams('novel.export.prepare', {
        ...params,
        chapterIds: Array(10_001).fill('chapter'),
      }),
    ).toThrow('10000');
    expect(validateSessionRequestParams('novel.export.reveal', { jobId: 'export' })).toEqual({
      jobId: 'export',
    });
    expect(() =>
      validateSessionRequestParams('novel.export.reveal', {
        jobId: 'export',
        path: 'C:/elsewhere',
      }),
    ).toThrow();
    expect(() => validateSessionRequestParams('novel.export.reveal', { jobId: '' })).toThrow();
  });

  it('freezes a published chapter into an immutable package and manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-export-'));
    directories.push(directory);
    const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projects.push(project);
    project.create(join(directory, 'project'), 'Novel');
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: 'Opening', displayLabel: 'Chapter 1' });
    const workflow = new DocumentWorkflowService(project);
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: 'Opening',
      contentMarkdown: 'The rain started.',
      expectedDocumentRowVersion: 0,
      authorType: 'user',
    });
    workflow.submitReview({
      documentId: draft.id,
      documentVersionId: draft.currentVersionId,
      expectedDocumentRowVersion: draft.rowVersion,
    });
    const reviewed = workflow.getDocument(draft.id);
    workflow.publish({
      documentId: draft.id,
      documentVersionId: reviewed.currentVersionId,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });

    const job = await new MarkdownExportService(project).prepare({
      exportType: 'work',
      exportFormat: 'files',
    });
    expect(job.status).toBe('succeeded');
    expect(job.itemCount).toBe(1);
    const manifest = JSON.parse(await readFile(join(job.packagePath, 'manifest.json'), 'utf8')) as {
      items: Array<{ sourceState: string; chapterId: string; outputHash: string }>;
    };
    expect(manifest.items[0]).toMatchObject({ sourceState: 'published', chapterId: chapter.id });
    expect(manifest.items[0]?.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT output_hash FROM markdown_export_items').get(),
      ),
    ).toMatchObject({ output_hash: manifest.items[0]?.outputHash });
  });

  it('writes a merged package with each frozen chapter in ordinal order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-export-merged-'));
    directories.push(directory);
    const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projects.push(project);
    project.create(join(directory, 'project'), 'Novel');
    const novel = new NovelService(project);
    const first = novel.saveChapter({ title: 'First', displayLabel: 'Chapter 1' });
    const second = novel.saveChapter({ title: 'Second', displayLabel: 'Chapter 2' });
    const workflow = new DocumentWorkflowService(project);
    for (const [chapter, content] of [
      [first, 'First body'],
      [second, 'Second body'],
    ] as const) {
      const draft = workflow.saveDraft({
        documentId: chapter.documentId,
        title: chapter.title,
        contentMarkdown: content,
        expectedDocumentRowVersion: 0,
        authorType: 'user',
      });
      workflow.submitReview({
        documentId: draft.id,
        documentVersionId: draft.currentVersionId,
        expectedDocumentRowVersion: draft.rowVersion,
      });
      const reviewed = workflow.getDocument(draft.id);
      workflow.publish({
        documentId: draft.id,
        documentVersionId: reviewed.currentVersionId,
        expectedDocumentRowVersion: reviewed.rowVersion,
        expectedPublishedVersionId: reviewed.publishedVersionId,
      });
    }

    const job = await new MarkdownExportService(project).prepare({
      exportType: 'work',
      exportFormat: 'merged',
    });
    const merged = await readFile(join(job.packagePath, 'merged.md'), 'utf8');
    expect(merged).toContain('# Chapter 1 First\n\nFirst body');
    expect(merged).toContain('# Chapter 2 Second\n\nSecond body');
    expect(merged.indexOf('First body')).toBeLessThan(merged.indexOf('Second body'));
  });

  it('reconciles a verified final package and fails an unverifiable interrupted package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-export-recovery-'));
    directories.push(directory);
    const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projects.push(project);
    project.create(join(directory, 'project'), 'Novel');
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: 'Opening', displayLabel: 'Chapter 1' });
    const workflow = new DocumentWorkflowService(project);
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: 'Body',
      expectedDocumentRowVersion: 0,
      authorType: 'user',
    });
    workflow.submitReview({
      documentId: draft.id,
      documentVersionId: draft.currentVersionId,
      expectedDocumentRowVersion: draft.rowVersion,
    });
    const reviewed = workflow.getDocument(draft.id);
    workflow.publish({
      documentId: draft.id,
      documentVersionId: reviewed.currentVersionId,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });
    const exports = new MarkdownExportService(project);
    const verified = await exports.prepare({ exportType: 'work', exportFormat: 'files' });
    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE markdown_export_jobs SET status = 'verifying', completed_at = NULL WHERE id = ?",
        )
        .run(verified.id);
      database
        .prepare("UPDATE markdown_export_items SET status = 'verifying' WHERE job_id = ?")
        .run(verified.id);
    });
    expect(exports.reconcile()).toEqual({ succeeded: 1, failed: 0 });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status FROM markdown_export_jobs WHERE id = ?').get(verified.id),
      ),
    ).toMatchObject({ status: 'succeeded' });

    const interrupted = await exports.prepare({ exportType: 'work', exportFormat: 'merged' });
    await rm(join(interrupted.packagePath, 'manifest.sha256'));
    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE markdown_export_jobs SET status = 'writing', completed_at = NULL WHERE id = ?",
        )
        .run(interrupted.id);
      database
        .prepare("UPDATE markdown_export_items SET status = 'writing' WHERE job_id = ?")
        .run(interrupted.id);
    });
    expect(exports.reconcile()).toEqual({ succeeded: 0, failed: 1 });
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT status, error_code FROM markdown_export_jobs WHERE id = ?')
          .get(interrupted.id),
      ),
    ).toMatchObject({ status: 'failed', error_code: 'EXPORT_RECOVERY_FAILED' });
  });

  it('fails recovery when a stored package path or output hash is tampered with', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-export-hardening-'));
    directories.push(directory);
    const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projects.push(project);
    project.create(join(directory, 'project'), 'Novel');
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: 'Opening', displayLabel: 'Chapter 1' });
    const workflow = new DocumentWorkflowService(project);
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: 'Body',
      expectedDocumentRowVersion: 0,
      authorType: 'user',
    });
    workflow.submitReview({
      documentId: draft.id,
      documentVersionId: draft.currentVersionId,
      expectedDocumentRowVersion: draft.rowVersion,
    });
    const reviewed = workflow.getDocument(draft.id);
    workflow.publish({
      documentId: draft.id,
      documentVersionId: reviewed.currentVersionId,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });
    const exports = new MarkdownExportService(project);
    const job = await exports.prepare({ exportType: 'work', exportFormat: 'files' });
    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE markdown_export_jobs SET status = 'verifying', completed_at = NULL, package_relative_path = ? WHERE id = ?",
        )
        .run('exports/../outside', job.id);
      database
        .prepare("UPDATE markdown_export_items SET status = 'verifying' WHERE job_id = ?")
        .run(job.id);
    });
    expect(exports.reconcile()).toEqual({ succeeded: 0, failed: 1 });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT error_code FROM markdown_export_jobs WHERE id = ?').get(job.id),
      ),
    ).toMatchObject({ error_code: 'EXPORT_RECOVERY_FAILED' });

    const merged = await exports.prepare({ exportType: 'work', exportFormat: 'merged' });
    await writeFile(join(merged.packagePath, 'merged.md'), 'externally modified', 'utf8');
    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE markdown_export_jobs SET status = 'verifying', completed_at = NULL WHERE id = ?",
        )
        .run(merged.id);
      database
        .prepare("UPDATE markdown_export_items SET status = 'verifying' WHERE job_id = ?")
        .run(merged.id);
    });
    expect(exports.reconcile()).toEqual({ succeeded: 0, failed: 1 });

    const linked = await exports.prepare({ exportType: 'work', exportFormat: 'files' });
    const linkedManifest = JSON.parse(
      await readFile(join(linked.packagePath, 'manifest.json'), 'utf8'),
    ) as { items: Array<{ relativePath: string }> };
    const outputPath = join(linked.packagePath, linkedManifest.items[0]!.relativePath);
    await link(outputPath, join(directory, 'export-hardlink.md'));
    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE markdown_export_jobs SET status = 'verifying', completed_at = NULL WHERE id = ?",
        )
        .run(linked.id);
      database
        .prepare("UPDATE markdown_export_items SET status = 'verifying' WHERE job_id = ?")
        .run(linked.id);
    });
    expect(exports.reconcile()).toEqual({ succeeded: 0, failed: 1 });
  });
});
