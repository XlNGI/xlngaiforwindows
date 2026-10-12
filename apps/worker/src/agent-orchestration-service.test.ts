import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentOrchestrationService,
  inferNovelWritingIntentFromPrompt,
} from './agent-orchestration-service.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';

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
  it.each(['生成第四章和第五章', '生成小说的第四章和第五章'])(
    'does not silently freeze the first target of an unsplit multi-chapter request: %s',
    async (prompt) => {
      const { project, conversation, orchestration } = await setup();
      const result = orchestration.prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action: 'create_chapter', displayLabel: '第四章' },
      });
      expect(result).toMatchObject({ pendingIntent: { reasonCode: 'TARGET_NOT_UNIQUE' } });
      expect(
        project.access(false, (database) =>
          database.prepare('SELECT count(*) count FROM novel_chapters').get(),
        ),
      ).toEqual({ count: 0 });
    },
  );
  it.each([false, true])(
    'recovers an orphan chapter preparation while preserving drafts (draft=%s)',
    async (withDraft) => {
      const { project, conversation, orchestration } = await setup();
      const rootPath = project.current()!.rootPath;
      const target = orchestration.prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt: '现在生成小说第一章',
        intent: { action: 'create_chapter', displayLabel: '第一章' },
      });
      if ('pendingIntent' in target) throw new Error('Expected a chapter target.');
      const workflow = new DocumentWorkflowService(project);
      if (withDraft)
        workflow.saveDraft({
          documentId: target.documentId,
          title: '用户草稿',
          contentMarkdown: '用户保存的正文',
          expectedDocumentRowVersion: 0,
        });
      expect(orchestration.recoverInterruptedPreparations()).toBe(0);
      project.close();
      project.open(rootPath);
      expect(orchestration.recoverInterruptedPreparations()).toBe(1);
      expect(orchestration.recoverInterruptedPreparations()).toBe(0);
      expect(
        project.access(false, (database) => ({
          task: database
            .prepare('SELECT status, error_code FROM agent_tasks WHERE id = ?')
            .get(target.taskId),
          chapter: database
            .prepare('SELECT lifecycle_status FROM novel_chapters WHERE id = ?')
            .get(target.chapterId),
          locks: database.prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks').get(),
        })),
      ).toEqual({
        task: { status: 'failed', error_code: 'GENERATION_PREPARE_FAILED' },
        chapter: { lifecycle_status: withDraft ? 'reserved' : 'archived' },
        locks: { count: 0 },
      });
      if (withDraft)
        expect(workflow.getDocument(target.documentId).currentVersion?.contentMarkdown).toBe(
          '用户保存的正文',
        );
    },
  );

  it('infers a chapter writer request when the Desktop omits novelIntent', () => {
    expect(inferNovelWritingIntentFromPrompt('请生成第一章小说正文')).toMatchObject({
      action: 'create_chapter',
      displayLabel: '第一章',
    });
    expect(inferNovelWritingIntentFromPrompt('请写一份小说大纲')).toBeUndefined();
  });

  it.each(['帮我生成一个小说', '请创作一部悬疑小说', '请生成小说大纲'])(
    'leaves the broad goal %s to the conversation assistant',
    (prompt) => {
      expect(inferNovelWritingIntentFromPrompt(prompt)).toBeUndefined();
    },
  );

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
      snapshot: database
        .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id = ?')
        .get(prepared.taskId) as { request_snapshot_json: string },
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
    expect(JSON.parse(persisted.snapshot.request_snapshot_json)).toMatchObject({
      intent: {
        version: 1,
        operation: 'novel.chapter.submit_draft',
        targetKind: 'novel-chapter',
        chapterId: prepared.chapterId,
        documentId: prepared.documentId,
      },
    });
  });

  it('allows a new numbered chapter while an earlier chapter remains in review', async () => {
    const { project, conversation, orchestration } = await setup();
    const first = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '现在生成第一章',
      intent: { action: 'create_chapter', displayLabel: '第一章' },
    });
    if ('pendingIntent' in first) throw new Error('Expected the first chapter target.');
    orchestration.markTaskGenerationStarted(first.taskId);
    project.access(true, (database) => {
      const now = new Date().toISOString();
      database
        .prepare(
          "UPDATE agent_tasks SET status = 'waiting_review', phase = 'waiting_review', updated_at = ? WHERE id = ?",
        )
        .run(now, first.taskId);
    });
    const second = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '现在生成第二章',
      intent: { action: 'create_chapter', displayLabel: '第二章', chapterTitle: '第二章' },
    });
    expect(second).toMatchObject({ documentIntent: { operation: 'novel.chapter.submit_draft' } });
    if ('pendingIntent' in second) return;
    expect(second.chapterId).not.toBe(first.chapterId);
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks').get(),
      ),
    ).toEqual({ count: 2 });
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

  it('keeps an inferred novel action pending until its chapter target is explicit', async () => {
    const { project, conversation, orchestration } = await setup();
    const pending = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '续写小说下一章',
    });

    expect(pending).toMatchObject({
      pendingIntent: {
        requestedAction: 'continue_chapter',
        reasonCode: 'TARGET_REQUIRED',
        status: 'pending',
      },
    });
    expect(
      project.access(false, (database) => ({
        tasks: database.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get(),
        pending: database.prepare('SELECT COUNT(*) AS count FROM agent_pending_intents').get(),
      })),
    ).toEqual({ tasks: { count: 0 }, pending: { count: 1 } });
  });

  it('resolves an explicit chapter reference before starting the writing task', async () => {
    const { project, conversation, orchestration } = await setup();
    const initial = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '创作第一章。',
      intent: { action: 'create_chapter', chapterTitle: '雨夜来客', displayLabel: '第一章' },
    });
    if ('pendingIntent' in initial) throw new Error('Expected an initial chapter.');

    project.access(true, (database) => {
      database
        .prepare(
          "UPDATE agent_tasks SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run('2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', initial.taskId);
    });

    const resolved = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '将第一章正文保存到小说中。',
    });
    expect(resolved).toMatchObject({
      chapterId: initial.chapterId,
      documentId: initial.documentId,
      documentIntent: { operation: 'novel.chapter.submit_draft' },
    });
  });

  it('creates the first chapter placeholder for an explicit save request in an empty novel', async () => {
    const { project, conversation, orchestration } = await setup();
    const prepared = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '将生成的正文保存为小说第一章。',
    });
    expect('pendingIntent' in prepared).toBe(false);
    if ('pendingIntent' in prepared) return;
    expect(
      project.access(false, (database) =>
        database
          .prepare(
            `SELECT chapters.display_label, documents.title, targets.created_placeholder
             FROM novel_chapters chapters
             INNER JOIN documents ON documents.id = chapters.document_id
             INNER JOIN agent_task_targets targets ON targets.chapter_id = chapters.id
             WHERE targets.task_id = ?`,
          )
          .get(prepared.taskId),
      ),
    ).toEqual({ display_label: '第一章', title: '第一章', created_placeholder: 1 });
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
