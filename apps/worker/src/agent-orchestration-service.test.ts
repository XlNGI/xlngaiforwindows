import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentOrchestrationService } from './agent-orchestration-service.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-novel-orchestration-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), '雾港纪事');
  const content = new ContentService(project);
  const conversation = content.createConversation({ scopeType: 'project', title: '小说创作' });
  return {
    project,
    conversation,
    orchestration: new AgentOrchestrationService(project),
  };
}

describe('AgentOrchestrationService', () => {
  it('creates a reserved chapter, task target, and chapter lock atomically before generation', async () => {
    const { project, conversation, orchestration } = await setup();
    const prepared = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '请创作第一章，描写雾港的雨夜。',
      intent: { action: 'create_chapter', chapterTitle: '雨夜来客', displayLabel: '第一章' },
    });

    expect('pendingIntent' in prepared).toBe(false);
    if ('pendingIntent' in prepared) return;
    expect(prepared.documentIntent).toEqual({
      operation: 'novel.chapter.submit_draft',
      documentId: prepared.documentId,
    });
    const persisted = project.access(false, (database) => ({
      chapter: database
        .prepare(
          'SELECT document_id, lifecycle_status, display_label FROM novel_chapters WHERE id = ?',
        )
        .get(prepared.chapterId),
      target: database
        .prepare(
          'SELECT document_id, chapter_id, action, created_placeholder FROM agent_task_targets WHERE task_id = ?',
        )
        .get(prepared.taskId),
      lock: database
        .prepare('SELECT task_id FROM novel_chapter_task_locks WHERE chapter_id = ?')
        .get(prepared.chapterId),
      task: database
        .prepare('SELECT status, phase FROM agent_tasks WHERE id = ?')
        .get(prepared.taskId),
    }));
    expect(persisted.chapter).toMatchObject({
      document_id: prepared.documentId,
      lifecycle_status: 'reserved',
      display_label: '第一章',
    });
    expect(persisted.target).toMatchObject({
      document_id: prepared.documentId,
      chapter_id: prepared.chapterId,
      action: 'create_chapter',
      created_placeholder: 1,
    });
    expect(persisted.lock).toEqual({ task_id: prepared.taskId });
    expect(persisted.task).toEqual({ status: 'queued', phase: 'intent_resolving' });
  });

  it('keeps ambiguous or negated writing requests out of business tables', async () => {
    const { project, conversation, orchestration } = await setup();
    const pending = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '不要续写章节，先聊聊人物关系。',
      intent: { action: 'continue_chapter' },
    });

    expect(pending).toMatchObject({
      pendingIntent: { reasonCode: 'NEGATED_ACTION', status: 'pending' },
    });
    expect(
      project.access(false, (database) => ({
        tasks: database.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get(),
        chapters: database.prepare('SELECT COUNT(*) AS count FROM novel_chapters').get(),
        pending: database.prepare('SELECT COUNT(*) AS count FROM agent_pending_intents').get(),
      })),
    ).toEqual({ tasks: { count: 0 }, chapters: { count: 0 }, pending: { count: 1 } });
  });

  it('permits only one active task per chapter and releases the lock at a terminal task state', async () => {
    const { project, conversation, orchestration } = await setup();
    const initial = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '创作第一章。',
      intent: { action: 'create_chapter', chapterTitle: '雨夜来客' },
    });
    if ('pendingIntent' in initial) throw new Error('Expected executable intent.');
    expect(() =>
      orchestration.prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt: '重写这一章。',
        intent: { action: 'rewrite_chapter', chapterId: initial.chapterId },
      }),
    ).toThrow('already has an active writing task');

    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE agent_tasks SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run('2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', initial.taskId);
    });
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks WHERE chapter_id = ?')
          .get(initial.chapterId),
      ),
    ).toEqual({ count: 0 });
    const retry = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '重写这一章。',
      intent: { action: 'rewrite_chapter', chapterId: initial.chapterId },
    });
    expect(retry).toMatchObject({ chapterId: initial.chapterId, documentId: initial.documentId });
  });

  it('archives an unused generation placeholder when preparation fails before a draft exists', async () => {
    const { project, conversation, orchestration } = await setup();
    const prepared = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '创作第一章。',
      intent: { action: 'create_chapter', chapterTitle: '雨夜来客' },
    });
    if ('pendingIntent' in prepared) throw new Error('Expected executable intent.');

    orchestration.failTaskBeforeGeneration(prepared.taskId, 'Provider profile was not found.');
    expect(
      project.access(false, (database) => ({
        task: database.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(prepared.taskId),
        chapter: database
          .prepare('SELECT lifecycle_status, archive_reason FROM novel_chapters WHERE id = ?')
          .get(prepared.chapterId),
        document: database
          .prepare('SELECT lifecycle_status FROM documents WHERE id = ?')
          .get(prepared.documentId),
        locks: database
          .prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks WHERE chapter_id = ?')
          .get(prepared.chapterId),
      })),
    ).toEqual({
      task: { status: 'failed' },
      chapter: { lifecycle_status: 'archived', archive_reason: 'generation_placeholder' },
      document: { lifecycle_status: 'archived' },
      locks: { count: 0 },
    });
  });
});
