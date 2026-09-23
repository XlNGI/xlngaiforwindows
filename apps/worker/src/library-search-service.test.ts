import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { LibraryError, LibrarySearchService } from './library-search-service.js';
import { NovelService } from './novel-service.js';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-library-search-'));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  services.push(projects);
  projects.create(join(directory, 'project'), 'Library Project');
  return {
    projects,
    content: new ContentService(projects),
    workflow: new DocumentWorkflowService(projects),
    novels: new NovelService(projects),
    library: new LibrarySearchService(projects),
  };
}

describe('LibrarySearchService', () => {
  it('finds unpublished markdown drafts and labels them as draft', async () => {
    const { content, library } = await setup();
    content.saveDocument({
      kind: 'character',
      title: '林澈',
      contentMarkdown: '林澈是灯塔守望员，常在旧码头看海。',
    });
    const result = library.search({
      taskId: 'task',
      attemptId: 'attempt',
      query: '林澈',
    });
    expect(result.resultCount).toBeGreaterThan(0);
    expect(result.sources[0]).toMatchObject({
      title: '林澈',
      status: 'draft',
      sourceType: 'document',
      citationLabel: 'L1',
    });
    expect(result.sources[0]?.snippet).toContain('灯塔守望员');
    const read = library.read({
      taskId: 'task',
      attemptId: 'attempt',
      sourceHandle: result.sources[0]!.sourceHandle,
    });
    expect(read.status).toBe('read');
    expect(read.candidateNote).toBe('未审核候选资料，不能当作已发布权威');
    expect(read.content).toContain('旧码头');
  });

  it('returns the structural path used to locate a matching section', async () => {
    const { content, library } = await setup();
    content.saveDocument({
      kind: 'scene',
      title: '雾港剧本',
      contentMarkdown: '# 第一章 雨夜来客\n## 场景一 旧码头\n林澈在潮声里回头。',
    });
    const result = library.search({ taskId: 'structure-task', attemptId: 'a', query: '林澈' });
    expect(result.sources[0]).toMatchObject({
      structureKind: 'scene',
      structurePath: ['雾港剧本', '第一章 雨夜来客', '场景一 旧码头'],
    });
    const read = library.read({
      taskId: 'structure-task',
      attemptId: 'a',
      sourceHandle: result.sources[0]!.sourceHandle,
    });
    expect(read).toMatchObject({
      structureKind: 'scene',
      structurePath: ['雾港剧本', '第一章 雨夜来客', '场景一 旧码头'],
    });
  });

  it('browses structure metadata before reading the same source', async () => {
    const { content, library } = await setup();
    content.saveDocument({
      kind: 'scene',
      title: '结构导航文档',
      contentMarkdown: '# 第一章\n## 场景一 旧码头\n林澈在潮声里回头。\n## 场景二 灯塔\n雾散。',
    });
    const tree = library.search({
      taskId: 'structure-browse',
      attemptId: 'a',
      query: '*',
      searchMode: 'structure',
      structurePath: ['结构导航文档', '第一章'],
      status: 'draft',
      limit: 2,
    });
    expect(tree.searchMode).toBe('structure');
    expect(tree.sources.map((source) => source.structurePath)).toEqual([
      ['结构导航文档', '第一章'],
      ['结构导航文档', '第一章', '场景一 旧码头'],
    ]);
    expect(tree.nextOffset).toBe(2);
    expect(tree.sources.every((source) => source.snippet === '')).toBe(true);
    const nextTree = library.search({
      taskId: 'structure-browse',
      attemptId: 'a',
      query: '*',
      searchMode: 'structure',
      structurePath: ['结构导航文档', '第一章'],
      status: 'draft',
      offset: tree.nextOffset,
      limit: 2,
    });
    expect(nextTree.sources.map((source) => source.structurePath)).toEqual([
      ['结构导航文档', '第一章', '场景二 灯塔'],
    ]);
    const read = library.read({
      taskId: 'structure-browse',
      attemptId: 'a',
      sourceHandle: tree.sources[1]!.sourceHandle,
      readMode: 'source',
    });
    expect(read.content).toContain('林澈在潮声里回头');
    expect(read.structurePath).toEqual(['结构导航文档', '第一章', '场景一 旧码头']);
  });

  it('indexes imported novel drafts without publishing', async () => {
    const { novels, library } = await setup();
    novels.importNovel({
      chapters: [
        {
          title: '雾港',
          displayLabel: '第一章',
          contentMarkdown: '雾港的雨落在石阶上，林澈提着马灯走向旧码头。',
        },
      ],
    });
    const result = library.search({
      taskId: 'task',
      attemptId: 'attempt',
      query: '旧码头',
    });
    expect(result.sources[0]).toMatchObject({
      sourceType: 'novel-chapter',
      status: 'draft',
      title: '第一章 雾港',
    });
    expect(
      library.search({ taskId: 'task', attemptId: 'title-query', query: '雾港' }).sources[0],
    ).toMatchObject({
      sourceType: 'novel-chapter',
      title: '第一章 雾港',
    });
  });

  it('finds a chapter by title even when the body does not repeat the location name', async () => {
    const { novels, library } = await setup();
    novels.importNovel({
      chapters: [
        {
          title: '灯塔',
          displayLabel: '第 2 章',
          contentMarkdown: '雨落在石阶上，只有潮声。',
        },
      ],
    });
    const result = library.search({
      taskId: 'task',
      attemptId: 'attempt',
      query: '灯塔',
    });
    expect(result.sources[0]).toMatchObject({
      sourceType: 'novel-chapter',
      title: '第 2 章 灯塔',
    });
    expect(
      library.search({ taskId: 'task', attemptId: 'compact', query: '第2章' }).sources[0],
    ).toMatchObject({
      title: '第 2 章 灯塔',
    });
  });
  it('rejects expired and cross-task handles', async () => {
    const { content, library } = await setup();
    content.saveDocument({
      kind: 'scene',
      title: '旧码头',
      contentMarkdown: '夜晚的旧码头只有潮声。',
    });
    const result = library.search({
      taskId: 'task-a',
      attemptId: 'attempt-a',
      query: '旧码头',
    });
    expect(() =>
      library.read({
        taskId: 'task-b',
        attemptId: 'attempt-a',
        sourceHandle: result.sources[0]!.sourceHandle,
      }),
    ).toThrow(LibraryError);
  });

  it('exhausts the per-task search budget', async () => {
    const { content, library } = await setup();
    content.saveDocument({
      kind: 'outline',
      title: '大纲',
      contentMarkdown: '林澈的故事从雾港开始。',
    });
    for (let index = 0; index < 4; index += 1) {
      library.search({ taskId: 'task', attemptId: 'attempt', query: '林澈' });
    }
    expect(() => library.search({ taskId: 'task', attemptId: 'attempt', query: '林澈' })).toThrow(
      /LIBRARY_BUDGET_EXCEEDED|budget|上限/,
    );
  });

  it('indexes memories, constraints, conversations, and asset aliases', async () => {
    const { content, library, projects } = await setup();
    content.messageToConstraint({
      messageId: content.saveMessage({
        conversationId: content.createConversation({ scopeType: 'project' }).id,
        role: 'user',
        content: '所有镜头保持冷色调',
      }).id,
      kind: 'production',
    });
    content.messageToMemory(
      content.saveMessage({
        conversationId: content.createConversation({ scopeType: 'project' }).id,
        role: 'user',
        content: '记住林澈怕海雾',
      }).id,
    );
    content.saveMessage({
      conversationId: content.createConversation({ scopeType: 'project' }).id,
      role: 'user',
      content: '旧码头今晚有潮声',
    });
    projects.access(true, (database, project) => {
      const now = new Date().toISOString();
      createRepositories(database).assets.save({
        id: 'asset-hero',
        projectId: project.id,
        kind: 'image',
        relativePath: 'library/hero.png',
        contentHash: 'a'.repeat(64),
        sizeBytes: 12,
        alias: '雾港角色图',
        createdAt: now,
        updatedAt: now,
      });
    });
    expect(
      library.search({ taskId: 't', attemptId: 'a', query: '冷色调' }).sources[0],
    ).toMatchObject({
      sourceType: 'constraint',
      status: 'constraint',
    });
    expect(
      library.search({ taskId: 't', attemptId: 'b', query: '怕海雾' }).sources[0],
    ).toMatchObject({
      sourceType: 'memory',
      status: 'memory',
    });
    expect(
      library.search({
        taskId: 't',
        attemptId: 'c',
        query: '潮声',
        sourceTypes: ['conversation'],
      }).sources[0],
    ).toMatchObject({
      sourceType: 'conversation',
      status: 'conversation',
    });
    expect(
      library.search({ taskId: 't', attemptId: 'd', query: '雾港角色图' }).sources[0],
    ).toMatchObject({
      sourceType: 'asset',
      title: '雾港角色图',
    });
  });

  it('distinguishes published versions from later drafts', async () => {
    const { content, workflow, library } = await setup();
    const document = content.saveDocument({
      kind: 'outline',
      title: '项目大纲',
      contentMarkdown: '第一版雾港提纲',
    });
    workflow.submitReview({
      documentId: document.id,
      expectedDocumentRowVersion: document.rowVersion,
    });
    const reviewed = workflow.getDocument(document.id);
    workflow.publish({
      documentId: document.id,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });
    content.saveDocument({
      documentId: document.id,
      kind: 'outline',
      title: '项目大纲',
      contentMarkdown: '第二版灯塔提纲',
      expectedDocumentRowVersion: workflow.getDocument(document.id).rowVersion,
    });
    const draftHit = library.search({
      taskId: 't',
      attemptId: 'a',
      query: '灯塔提纲',
      status: 'draft',
    });
    const publishedHit = library.search({
      taskId: 't',
      attemptId: 'b',
      query: '雾港提纲',
      status: 'published',
    });
    expect(draftHit.sources[0]?.status).toBe('draft');
    expect(publishedHit.sources[0]?.status).toBe('published');
  });

  it('truncates library.read to maxChars', async () => {
    const { content, library } = await setup();
    content.saveDocument({
      kind: 'note',
      title: '长文',
      contentMarkdown: '林澈' + '海'.repeat(200),
    });
    const searched = library.search({ taskId: 't', attemptId: 'a', query: '林澈' });
    const read = library.read({
      taskId: 't',
      attemptId: 'a',
      sourceHandle: searched.sources[0]!.sourceHandle,
      maxChars: 12,
    });
    expect(read.status).toBe('read');
    expect(read.truncated).toBe(true);
    expect(read.content.length).toBe(12);
  });

  it('reads a novel chapter as an ordered source when requested', async () => {
    const { novels, library } = await setup();
    const chapterBody = `  开头线索。\n\n${'海雾中的灯塔。\n\n'.repeat(500)}结尾线索。  `;
    novels.importNovel({
      chapters: [
        {
          title: '雾港',
          displayLabel: '第 1 章',
          contentMarkdown: chapterBody,
        },
      ],
    });
    const searched = library.search({
      taskId: 'source-task',
      attemptId: 'source-attempt',
      query: '第一章',
      sourceTypes: ['novel-chapter'],
    });
    const read = library.read({
      taskId: 'source-task',
      attemptId: 'source-attempt',
      sourceHandle: searched.sources[0]!.sourceHandle,
      readMode: 'source',
      maxChars: 20_000,
    });
    expect(read.readMode).toBe('source');
    expect(read.content.trimStart().startsWith('开头线索。')).toBe(true);
    expect(read.content).toContain('结尾线索。');
    expect(read.content).toBe(chapterBody.trim());
    expect(read.truncated).toBe(false);
  });

  it('continues long source reads without gaps, overlaps, or crossing versions', async () => {
    const { content, library } = await setup();
    const body = '序章\n\n' + '这是带有段落的证据🧭。\n\n'.repeat(2400) + '最后的线索。';
    const document = content.saveDocument({
      kind: 'note',
      title: '长篇证据',
      contentMarkdown: body,
    });
    const searched = library.search({ taskId: 't', attemptId: 'a', query: '长篇证据' });
    const args = {
      taskId: 't',
      attemptId: 'a',
      sourceHandle: searched.sources[0]!.sourceHandle,
      readMode: 'source' as const,
    };
    const first = library.read(args);
    expect(first).toMatchObject({ truncated: true, startOffset: 0, totalCharacters: body.length });
    expect(first.nextOffset).toBe(first.endOffset);
    const second = library.read({ ...args, offset: first.nextOffset });
    expect(first.content + second.content).toBe(body);
    expect(second).toMatchObject({
      truncated: false,
      contentHash: first.contentHash,
      versionId: first.versionId,
    });
    expect(second.nextOffset).toBeUndefined();
    content.saveDocument({
      documentId: document.id,
      kind: 'note',
      title: document.title,
      contentMarkdown: '另一个版本',
      expectedDocumentRowVersion: document.rowVersion,
    });
    expect(() => library.read(args)).toThrow('Library source is no longer available');
  });

  it('does not index incomplete streaming chat messages', async () => {
    const { content, library } = await setup();
    const conversation = content.createConversation({ scopeType: 'project' });
    content.saveMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '流式中的灯塔正文',
      status: 'streaming',
    });
    expect(library.search({ taskId: 't', attemptId: 'a', query: '灯塔正文' }).resultCount).toBe(0);
  });

  it('reports truncated search results and chunk positions without unrelated filler', async () => {
    const { novels, library } = await setup();
    novels.importNovel({
      chapters: [1, 2, 3].map((number) => ({
        title: `线索${number}`,
        contentMarkdown: '候选章节正文。',
      })),
    });
    const common = { taskId: 't', attemptId: 'a', sourceTypes: ['novel-chapter'] };
    const first = library.search({ ...common, query: '第一章', limit: 1 });
    expect(first).toMatchObject({ resultCount: 1, truncated: false });
    expect(first.sources[0]).toMatchObject({
      title: '第 1 章 线索1',
      chunkOrdinal: 0,
      startOffset: 0,
    });
    expect(library.search({ ...common, query: '候选章节', limit: 1 })).toMatchObject({
      resultCount: 1,
      truncated: true,
    });
    expect(library.search({ ...common, query: '月球空间站' })).toMatchObject({
      resultCount: 0,
      truncated: false,
    });
  });
});
