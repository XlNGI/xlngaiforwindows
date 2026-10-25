import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextService } from './context-service.js';
import { ContentService } from './content-service.js';
import { DocumentWorkflowError, DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import { createRepositories } from '@ai-video/persistence';
import { AgentOrchestrationService } from './agent-orchestration-service.js';

const directories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-document-workflow-'));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  services.push(projects);
  projects.create(join(directory, 'project'), 'Workflow Project');
  const content = new ContentService(projects);
  const workflow = new DocumentWorkflowService(projects);
  const contexts = new ContextService(projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  const user = content.saveMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '请生成项目大纲',
  });
  const assistant = content.saveMessage({
    conversationId: conversation.id,
    replyToMessageId: user.id,
    role: 'assistant',
    content: '# 项目大纲\n\n- 第一幕：雾港',
  });
  return { projects, content, workflow, contexts, conversation, user, assistant };
}

describe('DocumentWorkflowService', () => {
  it('stores open prop IR with immutable versions, restores it, and clears it when prose is edited alone', async () => {
    const { workflow } = await setup();
    const originalIR = {
      schemaVersion: 1 as const,
      kind: 'prop' as const,
      data: { material: '旧铁', shape: '断刃', history: ['祖传', '缺口'] },
    };
    const created = workflow.saveDraft({
      kind: 'prop',
      title: '断剑',
      contentMarkdown: '# 断剑\n刃口有缺损。',
      contentIR: originalIR,
    });
    expect(created.kind).toBe('prop');
    expect(created.currentVersion?.contentIR).toEqual(originalIR);

    const revised = workflow.saveDraft({
      documentId: created.id,
      title: created.title,
      contentMarkdown: '# 断剑\n剑格刻有旧纹。',
      contentIR: { schemaVersion: 1, kind: 'prop', data: { mark: '旧纹' } },
      expectedDocumentRowVersion: created.rowVersion,
    });
    expect(revised.currentVersion?.contentIR).toEqual({
      schemaVersion: 1,
      kind: 'prop',
      data: { mark: '旧纹' },
    });

    const restored = workflow.restoreDocument({
      documentId: revised.id,
      versionId: created.currentVersion!.id,
    });
    expect(restored.currentVersion?.contentIR).toEqual(originalIR);

    const proseOnlyEdit = workflow.saveDraft({
      documentId: restored.id,
      title: restored.title,
      contentMarkdown: '# 断剑\n新增文字但未更新结构化资料。',
      expectedDocumentRowVersion: restored.rowVersion,
    });
    expect(proseOnlyEdit.currentVersion?.contentIR).toBeUndefined();
    expect(workflow.listVersions(created.id).map((version) => version.contentIR)).toEqual([
      undefined,
      originalIR,
      { schemaVersion: 1, kind: 'prop', data: { mark: '旧纹' } },
      originalIR,
    ]);
  });

  it('keeps saved chapter documents out of the general document list', async () => {
    const { projects, workflow, conversation } = await setup();
    const orchestration = new AgentOrchestrationService(projects);
    const target = orchestration.prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: projects.currentSessionId()!,
      prompt: '生成第三章',
      intent: { action: 'create_chapter', displayLabel: '第三章' },
    });
    if ('pendingIntent' in target) throw new Error('Expected target');
    workflow.saveDraft({
      documentId: target.documentId,
      title: '第三章 记忆当',
      contentMarkdown: '小说章节正文',
      expectedDocumentRowVersion: 0,
    });
    const reference = workflow.saveDraft({ title: '独立笔记', contentMarkdown: '普通文档' });
    expect(workflow.listDocuments().map((document) => document.id)).toContain(reference.id);
    expect(workflow.listDocuments().map((document) => document.id)).not.toContain(
      target.documentId,
    );
    expect(workflow.getDocument(target.documentId).currentVersion?.contentMarkdown).toBe(
      '小说章节正文',
    );
  });
  it('reports and filters media submission states and classifies Vidu images by capability', async () => {
    const { projects, workflow } = await setup();
    projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      for (const [id, adapterKey, mediaState] of [
        [
          'uncertain-image',
          'TEXT_TO_IMAGE:unicompapi:cn.qwen.qwen-image-3-0:contract-1',
          'submission_unknown',
        ],
        ['vidu-image', 'TEXT_TO_IMAGE:vidu:viduq2:v2', 'submitting'],
        ['vidu-video', 'REFERENCE_TO_VIDEO:vidu:viduq3:v2', 'polling'],
      ] as const) {
        repositories.jobs.save({
          id,
          projectId: project.id,
          adapterKey,
          mediaState,
          status: mediaState === 'polling' ? 'polling' : 'running',
          requestJson: '{}',
          createdAt: '2026-10-12T01:53:13.000Z',
          updatedAt: '2026-10-12T01:53:44.000Z',
        });
      }
    });
    expect(workflow.listTaskLog({ kind: 'image' }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'uncertain-image',
          status: 'submission_unknown',
          kind: 'image',
        }),
        expect.objectContaining({ sourceId: 'vidu-image', status: 'submitting', kind: 'image' }),
      ]),
    );
    expect(
      workflow.listTaskLog({ status: 'submission_unknown' }).items.map((item) => item.sourceId),
    ).toEqual(['uncertain-image']);
    expect(workflow.listTaskLog({ status: 'running' }).items).toEqual([]);
    expect(workflow.listTaskLog({ kind: 'video' }).items).toEqual([
      expect.objectContaining({ sourceId: 'vidu-video', status: 'polling' }),
    ]);
  });

  it('lists an agent draft in catalog and marks it published without injecting the body', async () => {
    const { projects, content, workflow, contexts, conversation, assistant } = await setup();
    const created = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      idempotencyKey: 'draft-request-1',
    });

    expect(created.document.currentVersion?.state).toBe('draft');
    expect(created.document.publishedVersionId).toBeUndefined();
    expect(created.task.status).toBe('waiting_review');
    const initialTaskDetail = workflow.getTask({ taskId: created.task.id });
    expect(initialTaskDetail.task).toMatchObject({
      id: created.task.id,
      status: 'waiting_review',
    });
    expect(initialTaskDetail.events.map((event) => event.eventType)).toEqual([
      'agent.task.created',
      'agent.task.started',
      'document.draft.created',
      'agent.task.waiting_review',
    ]);
    expect(initialTaskDetail.documents).toEqual([
      expect.objectContaining({
        documentId: created.document.id,
        documentVersionId: created.document.currentVersion?.id,
        operation: 'create',
      }),
    ]);
    expect(
      projects.access(false, (database, project) =>
        createRepositories(database)
          .documentWorkflowAudits.listByProject(project.id)
          .map((event) => ({ action: event.action, actorType: event.actorType })),
      ),
    ).toEqual([{ action: 'draft_saved', actorType: 'agent' }]);
    const draftContext = contexts.compile(conversation.id);
    expect(draftContext.sources.some((source) => source.id === created.document.id)).toBe(false);
    expect(
      draftContext.catalog.some(
        (item) => item.sourceId === created.document.id && item.status === 'draft',
      ),
    ).toBe(true);
    const review = workflow.submitReview({
      documentId: created.document.id,
      expectedDocumentRowVersion: created.document.rowVersion,
    });
    expect(review.status).toBe('pending');
    const reviewed = workflow.getDocument(created.document.id);
    const published = workflow.publish({
      documentId: created.document.id,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });

    expect(published.document.publishedVersionId).toBe(published.document.currentVersion?.id);
    const publishedContext = contexts.compile(conversation.id);
    expect(publishedContext.sources.some((source) => source.id === created.document.id)).toBe(
      false,
    );
    expect(
      publishedContext.catalog.some(
        (item) => item.sourceId === created.document.id && item.status === 'published',
      ),
    ).toBe(true);
    expect(workflow.getTask({ taskId: created.task.id }).task).toMatchObject({
      status: 'completed',
      outcome: 'published',
    });
    expect(content.listDocuments()).toHaveLength(1);
    expect(
      projects.access(false, (database, project) =>
        createRepositories(database)
          .documentWorkflowAudits.listByProject(project.id)
          .map((event) => event.action),
      ),
    ).toEqual(['published', 'review_submitted', 'draft_saved']);
  });

  it('self-publishes a draft atomically and rolls back review creation on conflict', async () => {
    const { projects, workflow, assistant } = await setup();
    const created = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      idempotencyKey: 'self-publish-success',
    });
    const published = workflow.selfPublish({
      documentId: created.document.id,
      expectedDocumentRowVersion: created.document.rowVersion,
      expectedPublishedVersionId: created.document.publishedVersionId,
    });
    expect(published.document.currentVersion?.state).toBe('published');
    expect(published.document.publishedVersionId).toBe(published.document.currentVersion?.id);
    expect(
      projects.access(false, (database) =>
        database
          .prepare('SELECT status FROM document_reviews WHERE document_id = ?')
          .get(created.document.id),
      ),
    ).toMatchObject({ status: 'approved' });

    const second = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      targetDocumentId: created.document.id,
      expectedDocumentRowVersion: published.document.rowVersion,
      idempotencyKey: 'self-publish-conflict',
    });
    expect(() =>
      workflow.selfPublish({
        documentId: second.document.id,
        expectedDocumentRowVersion: second.document.rowVersion,
        expectedPublishedVersionId: 'stale-publication',
      }),
    ).toThrow('DOCUMENT_BASE_CONFLICT');
    expect(workflow.getDocument(second.document.id).currentVersion?.state).toBe('draft');
    expect(
      projects.access(
        false,
        (database) =>
          (
            database
              .prepare(
                'SELECT COUNT(*) AS count FROM document_reviews WHERE document_version_id = ?',
              )
              .get(second.document.currentVersionId) as { count: number }
          ).count,
      ),
    ).toBe(0);
  });

  it('replays task events with a sequence cursor and bounded pages', async () => {
    const { workflow, assistant } = await setup();
    const created = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      idempotencyKey: 'event-replay',
    });

    const first = workflow.getTaskEvents({ taskId: created.task.id, limit: 2 });
    expect(first.events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(first.hasMore).toBe(true);
    expect(first.nextSequence).toBe(1);

    const second = workflow.getTaskEvents({
      taskId: created.task.id,
      afterSequence: first.nextSequence,
      limit: 10,
    });
    expect(second.events.map((event) => event.eventType)).toEqual([
      'document.draft.created',
      'agent.task.waiting_review',
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.nextSequence).toBe(3);
  });

  it('does not replay task events across project boundaries', async () => {
    const { workflow, assistant } = await setup();
    const created = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      idempotencyKey: 'event-project-isolation',
    });
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-document-workflow-isolation-'));
    directories.push(directory);
    const isolatedProjects = new ProjectService({
      recentProjectsPath: join(directory, 'recent.json'),
    });
    services.push(isolatedProjects);
    isolatedProjects.create(join(directory, 'project'), 'Isolated Project');
    const isolatedWorkflow = new DocumentWorkflowService(isolatedProjects);

    expect(() => isolatedWorkflow.getTaskEvents({ taskId: created.task.id })).toThrow(
      'Agent task was not found.',
    );
  });

  it('reuses an idempotent task and rejects a stale editor', async () => {
    const { workflow, assistant } = await setup();
    const first = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      title: '同一草稿',
      idempotencyKey: 'same-request',
    });
    const repeated = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      title: '同一草稿',
      idempotencyKey: 'same-request',
    });
    expect(repeated.task.id).toBe(first.task.id);
    expect(repeated.document.id).toBe(first.document.id);

    expect(() =>
      workflow.saveDraft({
        documentId: first.document.id,
        title: '过时编辑',
        contentMarkdown: '覆盖',
        expectedDocumentRowVersion: first.document.rowVersion - 1,
      }),
    ).toThrow(DocumentWorkflowError);
  });

  it('does not allow user messages to become agent document artifacts', async () => {
    const { workflow, user } = await setup();
    expect(() => workflow.createDocumentDraftFromMessage({ messageId: user.id })).toThrow(
      'Only completed assistant messages',
    );
  });

  it('keeps the task provenance when a user revises an agent draft', async () => {
    const { workflow, assistant } = await setup();
    const created = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      idempotencyKey: 'revision-request',
    });

    const revised = workflow.saveDraft({
      documentId: created.document.id,
      title: 'User revised draft',
      contentMarkdown: '# User revision',
      expectedDocumentRowVersion: created.document.rowVersion,
    });

    expect(revised.currentVersion?.sourceTaskId).toBe(created.task.id);
    expect(workflow.getTask({ taskId: created.task.id }).documents.at(-1)).toMatchObject({
      documentVersionId: revised.currentVersion?.id,
      operation: 'update',
    });
    expect(
      workflow.listTaskLog({ limit: 20 }).items.filter((item) => item.sourceId === created.task.id),
    ).toHaveLength(1);

    const review = workflow.submitReview({
      documentId: revised.id,
      expectedDocumentRowVersion: revised.rowVersion,
    });
    expect(review.status).toBe('pending');
    const reviewed = workflow.getDocument(revised.id);
    workflow.publish({
      documentId: revised.id,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });
    expect(workflow.getTask({ taskId: created.task.id }).task).toMatchObject({
      status: 'completed',
      outcome: 'published',
    });
  });

  it('returns an in-review draft for changes without completing its Agent task', async () => {
    const { workflow, assistant } = await setup();
    const created = workflow.createDocumentDraftFromMessage({
      messageId: assistant.id,
      idempotencyKey: 'changes-requested',
    });
    workflow.submitReview({
      documentId: created.document.id,
      expectedDocumentRowVersion: created.document.rowVersion,
    });
    const reviewed = workflow.getDocument(created.document.id);

    const review = workflow.requestChanges({
      documentId: reviewed.id,
      expectedDocumentRowVersion: reviewed.rowVersion,
      comment: '补充人物动机。',
    });

    expect(review).toMatchObject({ status: 'changes_requested', comment: '补充人物动机。' });
    const returned = workflow.getDocument(created.document.id);
    expect(returned.currentVersion?.state).toBe('changes_requested');
    expect(workflow.getTask({ taskId: created.task.id }).task.status).toBe('waiting_review');

    const revised = workflow.saveDraft({
      documentId: returned.id,
      title: returned.title,
      contentMarkdown: '# 项目大纲\n\n补充人物动机。',
      expectedDocumentRowVersion: returned.rowVersion,
    });
    expect(revised.currentVersion).toMatchObject({ state: 'draft', sourceTaskId: created.task.id });
  });

  it('audits manual saves, restores, review decisions, and rejection separately from task events', async () => {
    const { projects, workflow } = await setup();
    const first = workflow.saveDraft({
      title: 'Manual document',
      contentMarkdown: '# First',
    });
    const restored = workflow.restoreDocument({
      documentId: first.id,
      versionId: first.currentVersion!.id,
    });
    const submitted = workflow.submitReview({
      documentId: restored.id,
      expectedDocumentRowVersion: restored.rowVersion,
    });
    const inReview = workflow.getDocument(restored.id);
    workflow.requestChanges({
      documentId: restored.id,
      expectedDocumentRowVersion: inReview.rowVersion,
      comment: 'Please revise',
    });
    const returned = workflow.getDocument(restored.id);
    const revised = workflow.saveDraft({
      documentId: returned.id,
      title: returned.title,
      contentMarkdown: '# Revised',
      expectedDocumentRowVersion: returned.rowVersion,
    });
    workflow.submitReview({
      documentId: revised.id,
      expectedDocumentRowVersion: revised.rowVersion,
    });
    const secondReview = workflow.getDocument(revised.id);
    workflow.rejectReview({
      documentId: revised.id,
      expectedDocumentRowVersion: secondReview.rowVersion,
      comment: 'Not ready',
    });

    expect(submitted.status).toBe('pending');
    expect(
      projects.access(false, (database) =>
        createRepositories(database)
          .documentWorkflowAudits.listByDocument(first.id)
          .sort((left, right) => left.sequence - right.sequence)
          .map((event) => event.action),
      ),
    ).toEqual([
      'draft_saved',
      'draft_restored',
      'review_submitted',
      'review_changes_requested',
      'draft_saved',
      'review_submitted',
      'review_rejected',
    ]);
  });
});
