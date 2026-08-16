import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextService } from './context-service.js';
import { ContentService } from './content-service.js';
import { DocumentWorkflowError, DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import { createRepositories } from '@ai-video/persistence';

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
  it('keeps an agent draft out of context until explicit publication', async () => {
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
    expect(
      contexts.compile(conversation.id).sources.some((source) => source.id === created.document.id),
    ).toBe(false);

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
    expect(
      contexts.compile(conversation.id).sources.some((source) => source.id === created.document.id),
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
      workflow.listTaskLog({ limit: 20 }).filter((item) => item.sourceId === created.task.id),
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
