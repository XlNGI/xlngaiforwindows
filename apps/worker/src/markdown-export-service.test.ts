import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { MarkdownExportService } from './markdown-export-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('MarkdownExportService', () => {
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

    const job = new MarkdownExportService(project).prepare({
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

    const job = new MarkdownExportService(project).prepare({
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
    const verified = exports.prepare({ exportType: 'work', exportFormat: 'files' });
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

    const interrupted = exports.prepare({ exportType: 'work', exportFormat: 'merged' });
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
    const job = exports.prepare({ exportType: 'work', exportFormat: 'files' });
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

    const merged = exports.prepare({ exportType: 'work', exportFormat: 'merged' });
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

    const linked = exports.prepare({ exportType: 'work', exportFormat: 'files' });
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
