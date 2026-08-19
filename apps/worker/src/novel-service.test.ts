import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-novel-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), '雾港纪事');
  return { project, novel: new NovelService(project), content: new ContentService(project) };
}

describe('NovelService', () => {
  it('lazily creates one project profile and uses CAS for profile updates', async () => {
    const { novel } = await setup();

    expect(novel.getProfile({ createIfMissing: false })).toBeUndefined();
    const created = novel.getProfile();
    expect(created).toMatchObject({ projectName: '雾港纪事', language: 'zh-CN', rowVersion: 0 });
    const updated = novel.updateProfile({ language: 'en-US', expectedRowVersion: 0 });
    expect(updated).toMatchObject({ language: 'en-US', rowVersion: 1 });
    expect(() => novel.updateProfile({ language: 'ja-JP', expectedRowVersion: 0 })).toThrow(
      'updated elsewhere',
    );
  });

  it('keeps chapter structure separate from document content and rejects a second binding', async () => {
    const { novel } = await setup();
    const volume = novel.saveVolume({ title: '第一卷 雾港' });
    const chapter = novel.saveChapter({
      volumeId: volume.id,
      title: '雨夜来客',
      displayLabel: '序章',
    });

    expect(chapter).toMatchObject({
      volumeId: volume.id,
      title: '雨夜来客',
      displayLabel: '序章',
      lifecycleStatus: 'active',
    });
    expect(novel.listChapters({ volumeId: volume.id })).toEqual([
      expect.objectContaining({ id: chapter.id, documentId: chapter.documentId }),
    ]);
    expect(() =>
      novel.saveBinding({
        documentId: chapter.documentId,
        role: 'note',
        domainScope: 'novel',
      }),
    ).toThrow('document binding target does not match project');
  });

  it('preserves positions across archive and explicit restore', async () => {
    const { novel } = await setup();
    const first = novel.saveChapter({ title: '第一章' });
    const second = novel.saveChapter({ title: '第二章' });
    expect([first.position, second.position]).toEqual([0, 1]);

    const archived = novel.archiveChapter({ chapterId: first.id, expectedRowVersion: 0 });
    expect(archived).toMatchObject({ lifecycleStatus: 'archived', archiveReason: 'user_archive' });
    expect(novel.listChapters()).toEqual([expect.objectContaining({ id: second.id })]);
    const restored = novel.restoreChapter({ chapterId: first.id, expectedRowVersion: 1 });
    expect(restored).toMatchObject({
      lifecycleStatus: 'active',
      position: 0,
      archiveReason: undefined,
    });
    expect(novel.listChapters().map((chapter) => chapter.id)).toEqual([first.id, second.id]);
  });

  it('allows a non-chapter document to receive one validated novel binding', async () => {
    const { novel, content } = await setup();
    const document = content.saveDocument({
      kind: 'outline',
      title: '人物设定',
      contentMarkdown: '林舟是一名航海士。',
    });
    const binding = novel.saveBinding({
      documentId: document.id,
      role: 'character-bible',
      domainScope: 'novel',
    });
    expect(novel.listBindings()).toEqual([
      expect.objectContaining({ id: binding.id, documentId: document.id, role: 'character-bible' }),
    ]);
    expect(() =>
      novel.saveBinding({
        documentId: document.id,
        role: 'world-bible',
        domainScope: 'novel',
      }),
    ).toThrow();
  });

  it('freezes the chapter structure with each publication', async () => {
    const { project, novel } = await setup();
    const chapter = novel.saveChapter({ title: '雨夜来客', displayLabel: '第一章' });
    const workflow = new DocumentWorkflowService(project);
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '雨落在雾港的石阶上。',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    workflow.submitReview({
      documentId: chapter.documentId,
      documentVersionId: draft.currentVersion!.id,
      expectedDocumentRowVersion: draft.rowVersion,
    });
    const published = workflow.publish({
      documentId: chapter.documentId,
      documentVersionId: draft.currentVersion!.id,
      expectedDocumentRowVersion: draft.rowVersion + 1,
    });

    const snapshot = project.access(false, (database) =>
      database
        .prepare(
          `SELECT chapter_id, document_version_id, work_title_snapshot, display_label_snapshot,
                  chapter_title_snapshot, snapshot_origin, structure_hash
           FROM novel_chapter_publication_snapshots WHERE publication_id = ?`,
        )
        .get(published.publication.id),
    ) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      chapter_id: chapter.id,
      document_version_id: draft.currentVersion!.id,
      work_title_snapshot: '雾港纪事',
      display_label_snapshot: '第一章',
      chapter_title_snapshot: '雨夜来客',
      snapshot_origin: 'native',
    });
    expect(snapshot.structure_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
