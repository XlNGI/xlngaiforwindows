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
});
