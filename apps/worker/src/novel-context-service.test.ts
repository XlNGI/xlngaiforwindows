import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { calculateNovelContextBudget, NovelContextService } from './novel-context-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-novel-context-'));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  services.push(projects);
  projects.create(join(directory, 'project'), 'Novel Context');
  const content = new ContentService(projects);
  const workflow = new DocumentWorkflowService(projects);
  const novel = new NovelService(projects);
  const context = new NovelContextService(projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  return { projects, content, workflow, novel, context, conversation };
}

function publish(workflow: DocumentWorkflowService, documentId: string): void {
  const current = workflow.getDocument(documentId);
  workflow.submitReview({ documentId, expectedDocumentRowVersion: current.rowVersion });
  const reviewed = workflow.getDocument(documentId);
  workflow.publish({
    documentId,
    expectedDocumentRowVersion: reviewed.rowVersion,
    expectedPublishedVersionId: reviewed.publishedVersionId,
  });
}

describe('NovelContextService', () => {
  it('scales the default budget with source size while honoring explicit budgets', () => {
    expect(calculateNovelContextBudget(0, 0)).toBe(24_000);
    expect(calculateNovelContextBudget(40_000, 8)).toBe(38_000);
    expect(calculateNovelContextBudget(2_000_000, 200)).toBe(80_000);
    expect(calculateNovelContextBudget(2_000_000, 200, 12_000)).toBe(12_000);
  });

  it('retrieves saved draft chunks and keeps published summaries as derived context', async () => {
    const { projects, workflow, novel, context, conversation } = await setup();
    const chapter = novel.saveChapter({ title: '第一章' });
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '已发布章节内容。'.repeat(800),
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    publish(workflow, draft.id);
    const unpublished = novel.saveChapter({ title: '草稿章节' });
    workflow.saveDraft({
      documentId: unpublished.documentId,
      title: unpublished.title,
      contentMarkdown: '不应进入小说上下文。',
      expectedDocumentRowVersion: unpublished.documentRowVersion,
    });

    const first = context.compile(conversation.id);
    const second = context.compile(conversation.id);
    expect(first.systemInstruction).toContain('长篇小说');
    expect(first.rendered).toContain('已发布章节内容');
    expect(first.rendered).toContain('不应进入小说上下文');
    expect(first.sources.some((source) => source.id.startsWith('novel-rag-chunk:'))).toBe(true);
    expect(
      first.sources.find((source) => source.id.startsWith('chapter-summary:'))?.summaryCacheKey,
    ).toBe(
      second.sources.find((source) => source.id.startsWith('chapter-summary:'))?.summaryCacheKey,
    );
    const summaries = projects.access(false, (database, project) =>
      database
        .prepare(
          'SELECT status, COUNT(*) AS count FROM novel_chapter_summaries WHERE project_id = ? GROUP BY status',
        )
        .all(project.id),
    );
    expect(summaries).toEqual([{ status: 'current', count: 1 }]);
  });

  it('compiles short-drama context with selected chapters and published references', async () => {
    const { workflow, novel, context, conversation } = await setup();
    const character = workflow.saveDraft({
      kind: 'character',
      title: '角色提示词',
      contentMarkdown: '# 林澈\n灯塔守望员。',
    });
    publish(workflow, character.id);
    novel.saveBinding({
      documentId: character.id,
      role: 'character-bible',
      domainScope: 'short-drama',
    });
    const chapter = novel.saveChapter({ title: '第一章' });
    workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '前三章内容。'.repeat(30),
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    const unpublished = novel.saveChapter({ title: '未选章节' });
    workflow.saveDraft({
      documentId: unpublished.documentId,
      title: unpublished.title,
      contentMarkdown: '不应进入短剧上下文。',
      expectedDocumentRowVersion: unpublished.documentRowVersion,
    });

    const compiled = context.compileShortDrama(conversation.id, undefined, [chapter.id]);
    expect(compiled.systemInstruction).toContain('短剧分集创作助手');
    expect(compiled.systemInstruction).toContain('[角色:名称]');
    expect(compiled.rendered).toContain('前三章内容');
    expect(compiled.rendered).toContain('短剧资料：角色提示词');
    expect(compiled.rendered).not.toContain('不应进入短剧上下文');

    const novelMode = context.compile(conversation.id, undefined, chapter.id);
    expect(novelMode.systemInstruction).toContain('长篇小说');
    expect(novelMode.rendered).not.toContain('短剧资料：角色提示词');
  });

  it('restricts short-drama RAG context to only the selected saved drafts in a long novel', async () => {
    const { workflow, novel, context, conversation } = await setup();
    const published: Array<{ id: string }> = [];
    for (let index = 1; index <= 14; index += 1) {
      const chapter = novel.saveChapter({ title: `第${index}章` });
      workflow.saveDraft({
        documentId: chapter.documentId,
        title: chapter.title,
        contentMarkdown: `第${index}章正文内容。`,
        expectedDocumentRowVersion: chapter.documentRowVersion,
      });
      published.push({ id: chapter.id });
    }
    const selected = [published[1]!, published[2]!, published[3]!].map((row) => row.id);
    const compiled = context.compileShortDrama(conversation.id, undefined, selected);
    expect(compiled.rendered).toContain('第2章正文内容。');
    expect(compiled.rendered).toContain('第3章正文内容。');
    expect(compiled.rendered).toContain('第4章正文内容。');
    expect(compiled.rendered).not.toContain('第1章正文内容。');
    expect(compiled.rendered).not.toContain('第14章正文内容。');
    expect(compiled.sources.some((source) => source.label.startsWith('本集章节：'))).toBe(true);
  });

  it('fails short-drama generation when selected chapters have not been saved', async () => {
    const { novel, context, conversation } = await setup();
    const chapter = novel.saveChapter({ title: '未发布章节' });
    expect(() => context.compileShortDrama(conversation.id, undefined, [chapter.id])).toThrow(
      /尚未保存/,
    );
  });

  it('marks chapter summaries stale when a newer publication is created', async () => {
    const { projects, workflow, novel, context, conversation } = await setup();
    const chapter = novel.saveChapter({ title: '连续性章节' });
    const first = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '第一版内容。',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    publish(workflow, first.id);
    context.compile(conversation.id);
    const current = workflow.getDocument(chapter.documentId);
    workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '第二版内容。',
      expectedDocumentRowVersion: current.rowVersion,
    });
    publish(workflow, chapter.documentId);
    const rows = projects.access(
      false,
      (database, project) =>
        database
          .prepare(
            'SELECT status, source_document_version_id FROM novel_chapter_summaries WHERE project_id = ?',
          )
          .all(project.id) as Array<{ status: string; source_document_version_id: string }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('stale');
    const report = context.consistencyReport();
    expect(report.chapterCount).toBe(1);
    expect(report.staleSummaryCount).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it('selects opening chapters and the frozen target neighborhood in a long novel', async () => {
    const { workflow, novel, context, conversation } = await setup();
    const chapters = [];
    for (let index = 0; index < 14; index += 1) {
      const chapter = novel.saveChapter({
        title: `Chapter ${index + 1}`,
        displayLabel: `C${index + 1}`,
      });
      const draft = workflow.saveDraft({
        documentId: chapter.documentId,
        title: chapter.title,
        contentMarkdown: `Published body ${index + 1}`,
        expectedDocumentRowVersion: chapter.documentRowVersion,
      });
      publish(workflow, draft.id);
      chapters.push(chapter);
    }

    const compiled = context.compile(conversation.id, undefined, chapters[8]!.id);
    const selectedIds = compiled.sources
      .filter((source) => source.id.startsWith('novel-rag-chunk:'))
      .map((source) => source.id.split(':')[1]!)
      .filter((id, index, rows) => rows.indexOf(id) === index);
    expect(selectedIds).toEqual([
      chapters[8]!.id,
      ...chapters.slice(0, 8).map((chapter) => chapter.id),
    ]);
    expect(selectedIds).not.toContain(chapters[13]!.id);
  });
});
