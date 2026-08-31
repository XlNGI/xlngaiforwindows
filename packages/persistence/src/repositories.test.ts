import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, migrateDatabase, openProjectDatabase } from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('repositories', () => {
  it('persists conversation-scoped model preferences independently by capability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-model-preferences-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Preferences', 'now', 'now');
    const repositories = createRepositories(database);
    repositories.conversations.save({
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Chat',
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.conversationModelPreferences.save({
      conversationId: 'conversation',
      capability: 'image',
      providerProfileId: 'profile-image',
      modelId: 'model-image',
      confirmedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    });
    repositories.conversationModelPreferences.save({
      conversationId: 'conversation',
      capability: 'video',
      providerProfileId: 'profile-video',
      modelId: 'model-video',
      confirmedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    });

    expect(repositories.conversationModelPreferences.get('conversation', 'image')).toMatchObject({
      modelId: 'model-image',
    });
    expect(
      repositories.conversationModelPreferences.listByConversation('conversation'),
    ).toHaveLength(2);
    repositories.conversationModelPreferences.delete('conversation', 'image');
    expect(repositories.conversationModelPreferences.get('conversation', 'image')).toBeUndefined();
    expect(repositories.conversationModelPreferences.get('conversation', 'video')).toMatchObject({
      modelId: 'model-video',
    });
    database.close();
  });

  it('persists and reads every M1 aggregate root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-repositories-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Repositories', 'now', 'now');
    const repositories = createRepositories(database);

    repositories.documents.saveVersion(
      {
        id: 'versioned-document',
        projectId: 'project',
        kind: 'outline',
        title: 'Versioned Outline',
        scopeType: 'project',
        currentVersionId: 'version-1',
        createdAt: 'now',
        updatedAt: 'now',
      },
      {
        id: 'version-1',
        documentId: 'versioned-document',
        version: 1,
        contentMarkdown: '# First',
        createdAt: 'now',
      },
    );

    repositories.documents.save({
      id: 'document',
      projectId: 'project',
      kind: 'outline',
      title: 'Outline',
      scopeType: 'project' as const,
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.conversations.save({
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Chat',
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.chatMessages.save({
      id: 'message',
      conversationId: 'conversation',
      role: 'user',
      content: 'Hello',
      status: 'complete',
      createdAt: 'now',
    });
    repositories.chatMessages.save({
      id: 'assistant-message',
      conversationId: 'conversation',
      replyToMessageId: 'message',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: 'now',
    });
    repositories.scenes.save({
      id: 'scene',
      projectId: 'project',
      title: 'Scene 1',
      position: 0,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.shots.save({
      id: 'shot',
      sceneId: 'scene',
      title: 'Shot 1',
      position: 0,
      status: 'draft',
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.memories.save({
      id: 'memory',
      projectId: 'project',
      scopeType: 'project',
      content: 'A fact',
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.constraints.save({
      id: 'constraint',
      projectId: 'project',
      scopeType: 'project',
      kind: 'visual',
      content: 'No text',
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.assets.save({
      id: 'asset',
      projectId: 'project',
      kind: 'image',
      relativePath: 'assets/images/frame.png',
      contentHash: 'abc',
      sizeBytes: 123,
      createdAt: 'now',
    });
    repositories.generationDrafts.save({
      id: 'draft',
      shotId: 'shot',
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parametersJson: '{"prompt":"first"}',
      updatedAt: 'now',
    });
    repositories.generationDrafts.save({
      id: 'ignored-on-upsert',
      shotId: 'shot',
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parametersJson: '{"prompt":"updated"}',
      updatedAt: 'later',
    });
    repositories.jobs.save({
      id: 'job',
      projectId: 'project',
      adapterKey: 'image:test:v1',
      status: 'draft',
      requestJson: '{}',
      taskSnapshotJson: '{"version":1,"adapterKey":"image:test:v1"}',
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.generationJobEvents.append({
      id: 'event-prepare',
      jobId: 'job',
      projectId: 'project',
      phase: 'prepare',
      status: 'running',
      summary: 'prepared',
      createdAt: 'now',
    });
    repositories.generationJobEvents.append({
      id: 'event-complete',
      jobId: 'job',
      projectId: 'project',
      phase: 'complete',
      status: 'succeeded',
      summary: 'complete',
      createdAt: 'later',
    });
    expect(repositories.generationJobEvents.listByJob('job')).toMatchObject([
      { sequence: 0, phase: 'prepare' },
      { sequence: 1, phase: 'complete' },
    ]);
    expect(repositories.generationJobEvents.listByJobPage('job', 0, 2)).toMatchObject([
      { sequence: 1, phase: 'complete' },
    ]);
    repositories.jobs.save({
      id: 'job',
      projectId: 'project',
      adapterKey: 'image:test:v1',
      status: 'succeeded',
      requestJson: '{}',
      createdAt: 'now',
      updatedAt: 'later',
    });
    repositories.contextSnapshots.save({
      id: 'snapshot',
      projectId: 'project',
      purpose: 'test-context',
      contentJson: '{"version":1}',
      createdAt: 'now',
    });
    repositories.llmGenerations.insert({
      id: 'generation',
      projectId: 'project',
      projectSessionId: 'project-session',
      conversationId: 'conversation',
      contextSnapshotId: 'snapshot',
      userMessageId: 'message',
      assistantMessageId: 'assistant-message',
      status: 'streaming',
      executionMode: 'native',
      providerProfileId: 'profile',
      modelId: 'model',
      createdAt: 'now',
      updatedAt: 'now',
      version: 0,
    });
    repositories.llmGenerationAttempts.save({
      id: 'attempt',
      generationId: 'generation',
      conversationId: 'conversation',
      userMessageId: 'message',
      assistantMessageId: 'assistant-message',
      contextSnapshotId: 'snapshot',
      providerProfileId: 'profile',
      providerNameSnapshot: 'Provider',
      modelId: 'model',
      modelNameSnapshot: 'Model',
      protocol: 'openai-responses',
      status: 'streaming',
      startedAt: 'now',
      pricingSnapshotJson:
        '{"currency":"USD","unitTokens":1000000,"inputPrice":"1","outputPrice":"2","configuredAt":"now"}',
    });

    expect(repositories.documents.get('document')).toMatchObject({ title: 'Outline' });
    expect(repositories.documents.listVersions('versioned-document')).toMatchObject([
      { version: 1, contentMarkdown: '# First' },
    ]);
    expect(repositories.conversations.listByProject('project')).toHaveLength(1);
    expect(repositories.chatMessages.get('assistant-message')).toMatchObject({
      replyToMessageId: 'message',
      status: 'streaming',
    });
    expect(repositories.chatMessages.failStreamingByProject('project', 'Interrupted')).toBe(1);
    expect(repositories.chatMessages.get('assistant-message')).toMatchObject({
      content: 'Interrupted',
      status: 'failed',
    });
    expect(repositories.scenes.listByProject('project')).toHaveLength(1);
    expect(repositories.shots.listByScene('scene')).toHaveLength(1);
    expect(repositories.memories.get('memory')).toMatchObject({ content: 'A fact' });
    expect(repositories.constraints.get('constraint')).toMatchObject({ kind: 'visual' });
    expect(repositories.assets.get('asset')).toMatchObject({ sizeBytes: 123 });
    expect(repositories.generationDrafts.get('shot', 'TEXT_TO_IMAGE:vidu:viduq2:v2')).toMatchObject(
      { id: 'draft', parametersJson: '{"prompt":"updated"}', updatedAt: 'later' },
    );
    expect(repositories.jobs.listByProject('project')).toMatchObject([
      { status: 'succeeded', taskSnapshotJson: '{"version":1,"adapterKey":"image:test:v1"}' },
    ]);
    expect(() =>
      repositories.jobs.save({
        id: 'job',
        projectId: 'project',
        adapterKey: 'image:test:v1',
        status: 'succeeded',
        requestJson: '{}',
        taskSnapshotJson: '{"version":2}',
        createdAt: 'now',
        updatedAt: 'later',
      }),
    ).toThrow('generation task snapshot is immutable');
    expect(repositories.contextSnapshots.get('snapshot')).toMatchObject({
      purpose: 'test-context',
      contentJson: '{"version":1}',
    });
    expect(repositories.contextSnapshots.listByProject('project', 10)).toHaveLength(1);
    expect(
      repositories.llmGenerationAttempts.getByAssistantMessage('assistant-message'),
    ).toMatchObject({
      id: 'attempt',
      status: 'streaming',
      providerNameSnapshot: 'Provider',
    });
    expect(
      repositories.llmGenerationAttempts.failActiveByProject(
        'project',
        'later',
        'Worker restarted',
      ),
    ).toBe(1);
    expect(repositories.llmGenerationAttempts.listByProject('project')).toMatchObject([
      { id: 'attempt', status: 'failed', completedAt: 'later', errorCode: 'worker-restarted' },
    ]);
    database.close();
  });

  it('persists agent task drafts, review decisions, publications, and immutable events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-agent-task-repositories-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Agent tasks', 'now', 'now');
    const repositories = createRepositories(database);

    repositories.conversations.save({
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Agent chat',
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.chatMessages.save({
      id: 'user',
      conversationId: 'conversation',
      role: 'user',
      content: 'Create a project document.',
      status: 'complete',
      createdAt: 'now',
    });
    repositories.chatMessages.save({
      id: 'assistant',
      conversationId: 'conversation',
      replyToMessageId: 'user',
      role: 'assistant',
      content: 'Draft created.',
      status: 'complete',
      createdAt: 'now',
    });
    repositories.contextSnapshots.save({
      id: 'snapshot',
      projectId: 'project',
      purpose: 'agent-task',
      contentJson: '{"version":1}',
      createdAt: 'now',
    });
    repositories.llmGenerations.insert({
      id: 'generation',
      projectId: 'project',
      projectSessionId: 'session',
      conversationId: 'conversation',
      contextSnapshotId: 'snapshot',
      userMessageId: 'user',
      assistantMessageId: 'assistant',
      status: 'complete',
      executionMode: 'native',
      createdAt: 'now',
      updatedAt: 'now',
      version: 0,
    });
    repositories.llmGenerationAttempts.save({
      id: 'attempt',
      generationId: 'generation',
      conversationId: 'conversation',
      userMessageId: 'user',
      assistantMessageId: 'assistant',
      contextSnapshotId: 'snapshot',
      providerNameSnapshot: 'Provider',
      modelNameSnapshot: 'Model',
      protocol: 'responses',
      status: 'complete',
      startedAt: 'now',
      completedAt: 'later',
    });
    repositories.agentTasks.save({
      id: 'task',
      projectId: 'project',
      projectSessionId: 'session',
      conversationId: 'conversation',
      userMessageId: 'user',
      taskType: 'document-create',
      scopeType: 'project',
      title: 'Create synopsis',
      requestSnapshotJson: '{"prompt":"Create a synopsis"}',
      requestHash: 'request-hash',
      contextSnapshotId: 'snapshot',
      status: 'queued',
      idempotencyKey: 'task-key',
      createdAt: 'now',
      updatedAt: 'now',
      phase: 'queued',
      rowVersion: 0,
      toolCallLimit: 8,
      toolCallCount: 0,
      lifecycleStatus: 'active',
    });
    const runningTask = {
      ...repositories.agentTasks.get('task')!,
      status: 'running' as const,
      startedAt: 'later',
      updatedAt: 'later',
      rowVersion: 1,
    };
    expect(repositories.agentTasks.update(runningTask, 0)).toBe(true);
    expect(repositories.agentTasks.update(runningTask, 0)).toBe(false);
    expect(repositories.agentTasks.getByIdempotencyKey('project', 'task-key')).toMatchObject({
      id: 'task',
      status: 'running',
    });
    repositories.agentTaskEvents.append({
      id: 'event',
      taskId: 'task',
      projectId: 'project',
      sequence: 0,
      eventType: 'agent.task.created',
      level: 'info',
      summary: 'Task created',
      dedupeKey: 'created',
      createdAt: 'now',
    });
    expect(repositories.agentTaskEvents.listByTask('task')).toMatchObject([
      { eventType: 'agent.task.created', sequence: 0 },
    ]);
    expect(() =>
      database
        .prepare("UPDATE agent_task_events SET summary = 'changed' WHERE id = ?")
        .run('event'),
    ).toThrow('agent task events are immutable');
    repositories.agentTaskGenerations.link({
      taskId: 'task',
      generationId: 'generation',
      ordinal: 0,
      purpose: 'initial',
      createdAt: 'later',
    });
    expect(repositories.agentTaskGenerations.listByTask('task')).toMatchObject([
      { generationId: 'generation', ordinal: 0 },
    ]);
    repositories.llmProviderSteps.save({
      id: 'step',
      projectId: 'project',
      generationId: 'generation',
      attemptId: 'attempt',
      ordinal: 0,
      protocol: 'responses',
      status: 'complete',
      toolCallCount: 0,
      requestHash: 'request-hash',
      startedAt: 'later',
    });
    expect(repositories.llmProviderSteps.listByAttempt('attempt')).toMatchObject([
      { id: 'step', ordinal: 0, status: 'complete' },
    ]);
    repositories.agentToolAuthorizations.save({
      id: 'authorization',
      projectId: 'project',
      taskId: 'task',
      generationId: 'generation',
      attemptId: 'attempt',
      providerStepId: 'step',
      projectSessionId: 'session',
      allowedOperation: 'document.create_draft',
      policyVersion: 'policy-1',
      toolSchemaVersion: 'tools-1',
      authorizationHandleHash: 'handle-hash',
      status: 'issued',
      maxCallUses: 1,
      usedCallCount: 0,
      expiresAt: 'later',
      rowVersion: 0,
      createdAt: 'later',
    });
    expect(repositories.agentToolAuthorizations.get('authorization')).toMatchObject({
      providerStepId: 'step',
      usedCallCount: 0,
    });
    repositories.agentToolCalls.save({
      id: 'tool-call',
      projectId: 'project',
      taskId: 'task',
      toolName: 'project.document.createDraft',
      normalizedArgumentsHash: 'arguments-hash',
      argumentsSummaryJson: '{"operation":"create"}',
      status: 'received',
      idempotencyKey: 'tool-key',
      createdAt: 'later',
      version: 0,
      redactionState: 'native',
    });
    const validatedCall = {
      ...repositories.agentToolCalls.get('tool-call')!,
      status: 'validated' as const,
      version: 1,
    };
    expect(repositories.agentToolCalls.update(validatedCall, 0)).toBe(true);
    expect(repositories.agentToolCalls.getByIdempotencyKey('task', 'tool-key')).toMatchObject({
      id: 'tool-call',
    });

    repositories.documents.saveVersion(
      {
        id: 'document',
        projectId: 'project',
        kind: 'note',
        title: 'Synopsis',
        scopeType: 'project',
        currentVersionId: 'published-version',
        createdAt: 'now',
        updatedAt: 'now',
      },
      {
        id: 'published-version',
        documentId: 'document',
        version: 1,
        contentMarkdown: '# Published',
        state: 'published',
        createdAt: 'now',
      },
    );
    const publishedDocument = repositories.documents.get('document')!;
    repositories.documents.saveVersion(
      {
        ...publishedDocument,
        currentVersionId: 'draft-version',
        title: 'Synopsis draft',
        updatedAt: 'later',
      },
      {
        id: 'draft-version',
        documentId: 'document',
        version: 2,
        contentMarkdown: '# Draft',
        state: 'draft',
        baseVersionId: 'published-version',
        authorType: 'agent',
        sourceTaskId: 'task',
        sourceMessageId: 'assistant',
        contextSnapshotId: 'snapshot',
        createdAt: 'later',
      },
    );
    expect(repositories.documents.get('document')).toMatchObject({
      currentVersionId: 'draft-version',
      publishedVersionId: 'published-version',
      rowVersion: 1,
    });
    expect(repositories.documents.getVersion('draft-version')).toMatchObject({
      state: 'draft',
      baseVersionId: 'published-version',
      authorType: 'agent',
      sourceTaskId: 'task',
    });
    repositories.agentTaskDocumentVersions.link({
      taskId: 'task',
      documentId: 'document',
      documentVersionId: 'draft-version',
      operation: 'create',
      createdAt: 'later',
    });
    repositories.documentReviews.save({
      id: 'review',
      projectId: 'project',
      documentId: 'document',
      documentVersionId: 'draft-version',
      taskId: 'task',
      status: 'pending',
      requestedByType: 'agent',
      requestedAt: 'later',
      version: 0,
    });
    const approvedReview = {
      ...repositories.documentReviews.get('review')!,
      status: 'approved' as const,
      decidedByType: 'user',
      decidedAt: 'later',
      version: 1,
    };
    expect(repositories.documentReviews.update(approvedReview, 0)).toBe(true);
    expect(
      repositories.documents.updateVersionState('draft-version', 'in_review', 0, 'later'),
    ).toBe(true);
    expect(
      repositories.documents.updateVersionState('draft-version', 'published', 1, 'later'),
    ).toBe(true);
    expect(
      repositories.documents.updatePublishedVersion('document', 'draft-version', 1, 'later'),
    ).toBe(true);
    repositories.documentPublications.append({
      id: 'publication',
      projectId: 'project',
      documentId: 'document',
      documentVersionId: 'draft-version',
      previousVersionId: 'published-version',
      publicationNo: 2,
      reviewId: 'review',
      taskId: 'task',
      publishedByType: 'user',
      publishedAt: 'later',
    });
    expect(repositories.documentPublications.listByDocument('document')).toMatchObject([
      { id: 'publication', documentVersionId: 'draft-version', publicationNo: 2 },
    ]);
    repositories.documentWorkflowAudits.append({
      id: 'audit-publication',
      projectId: 'project',
      sequence: 0,
      action: 'published',
      actorType: 'user',
      actorId: 'local-user',
      documentId: 'document',
      documentVersionId: 'draft-version',
      sourceVersionId: 'published-version',
      reviewId: 'review',
      publicationId: 'publication',
      taskId: 'task',
      metadataJson: '{"previousVersionId":"published-version"}',
      createdAt: 'later',
    });
    expect(repositories.documentWorkflowAudits.listByProject('project', 1)).toMatchObject([
      {
        id: 'audit-publication',
        action: 'published',
        documentVersionId: 'draft-version',
        publicationId: 'publication',
      },
    ]);
    expect(repositories.documentWorkflowAudits.listByDocument('document')).toMatchObject([
      { id: 'audit-publication', sourceVersionId: 'published-version' },
    ]);
    expect(() =>
      database
        .prepare('UPDATE document_audit_events SET action = ? WHERE id = ?')
        .run('draft_saved', 'audit-publication'),
    ).toThrow('document audit events are immutable');
    expect(() =>
      database.prepare('DELETE FROM document_audit_events WHERE id = ?').run('audit-publication'),
    ).toThrow('document audit events are immutable');
    expect(repositories.agentTaskDocumentVersions.listByTask('task')).toMatchObject([
      { documentVersionId: 'draft-version', operation: 'create' },
    ]);
    expect(() =>
      database
        .prepare('UPDATE document_publications SET publication_no = 3 WHERE id = ?')
        .run('publication'),
    ).toThrow('document publications are immutable');
    database.close();
  });

  it('rolls back document metadata when a version insert fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-document-transaction-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Transactions', 'now', 'now');
    const repository = createRepositories(database).documents;
    const original = {
      id: 'document',
      projectId: 'project',
      kind: 'outline',
      title: 'Original',
      scopeType: 'project' as const,
      currentVersionId: 'version-1',
      createdAt: 'now',
      updatedAt: 'now',
    };
    repository.saveVersion(original, {
      id: 'version-1',
      documentId: 'document',
      version: 1,
      contentMarkdown: 'Original',
      createdAt: 'now',
    });

    expect(() =>
      repository.saveVersion(
        { ...original, title: 'Must roll back', currentVersionId: 'version-duplicate' },
        {
          id: 'version-duplicate',
          documentId: 'document',
          version: 1,
          contentMarkdown: 'Duplicate',
          createdAt: 'later',
        },
      ),
    ).toThrow();
    expect(repository.get('document')).toMatchObject({
      title: 'Original',
      currentVersionId: 'version-1',
    });
    database.close();
  });

  it('orders conversations by latest activity with a deterministic id tie-breaker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-conversation-order-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Ordering', 'now', 'now');
    const conversations = createRepositories(database).conversations;
    for (const id of ['a', 'b']) {
      conversations.save({
        id,
        projectId: 'project',
        scopeType: 'project',
        title: id,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    }
    conversations.save({
      id: 'older',
      projectId: 'project',
      scopeType: 'project',
      title: 'older',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(conversations.listByProject('project').map((item) => item.id)).toEqual([
      'b',
      'a',
      'older',
    ]);
    database.close();
  });

  it('persists conversation archive state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-conversation-archive-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Archive', 'now', 'now');
    const conversations = createRepositories(database).conversations;

    conversations.save({
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Chat',
      createdAt: 'now',
      updatedAt: 'now',
      archivedAt: '2026-08-16T00:00:00.000Z',
    });

    expect(conversations.get('conversation')).toMatchObject({
      archivedAt: '2026-08-16T00:00:00.000Z',
    });

    conversations.save({
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Chat',
      createdAt: 'now',
      updatedAt: 'now',
    });
    expect(conversations.get('conversation')).toMatchObject({ archivedAt: undefined });
    database.close();
  });

  it('deletes only old unreferenced context snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-context-cleanup-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Context Cleanup', 'now', 'now');
    const repositories = createRepositories(database);
    repositories.contextSnapshots.save({
      id: 'old-unreferenced',
      projectId: 'project',
      purpose: 'llm-generation',
      contentJson: '{}',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    repositories.contextSnapshots.save({
      id: 'referenced',
      projectId: 'project',
      purpose: 'llm-generation',
      contentJson: '{}',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    repositories.contextSnapshots.save({
      id: 'recent',
      projectId: 'project',
      purpose: 'llm-generation',
      contentJson: '{}',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    repositories.documents.saveVersion(
      {
        id: 'document',
        projectId: 'project',
        kind: 'note',
        title: 'Doc',
        scopeType: 'project',
        currentVersionId: 'version',
        createdAt: 'now',
        updatedAt: 'now',
      },
      {
        id: 'version',
        documentId: 'document',
        version: 1,
        contentMarkdown: '# Doc',
        createdAt: 'now',
        contextSnapshotId: 'referenced',
      },
    );

    const removed = repositories.contextSnapshots.deleteUnreferencedOlderThan(
      'project',
      '2026-07-01T00:00:00.000Z',
      10,
    );
    expect(removed).toBe(1);
    expect(repositories.contextSnapshots.get('old-unreferenced')).toBeUndefined();
    expect(repositories.contextSnapshots.get('referenced')).toMatchObject({ id: 'referenced' });
    expect(repositories.contextSnapshots.get('recent')).toMatchObject({ id: 'recent' });
    database.close();
  });

  it('searches assets by tag name without crossing project boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-asset-search-'));
    temporaryDirectories.push(directory);
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    migrateDatabase(database);
    const now = '2026-08-12T00:00:00.000Z';
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project-a', 'Project A', now, now);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project-b', 'Project B', now, now);
    const repositories = createRepositories(database);

    for (const [id, projectId] of [
      ['asset-a', 'project-a'],
      ['asset-b', 'project-b'],
    ] as const) {
      repositories.assets.save({
        id,
        projectId,
        kind: 'image',
        relativePath: `assets/${id}.png`,
        contentHash: id,
        sizeBytes: 10,
        createdAt: now,
      });
    }
    repositories.assets.saveTag({
      id: 'tag-a',
      projectId: 'project-a',
      name: 'Hero',
      normalizedName: 'hero',
      createdBy: 'local-user',
      createdAt: now,
      updatedAt: now,
    });
    repositories.assets.saveTag({
      id: 'tag-b',
      projectId: 'project-b',
      name: 'Hero',
      normalizedName: 'hero',
      createdBy: 'local-user',
      createdAt: now,
      updatedAt: now,
    });
    repositories.assets.replaceTags('asset-a', ['tag-a'], now);
    repositories.assets.replaceTags('asset-b', ['tag-b'], now);

    expect(repositories.assets.queryByProject('project-a', { keyword: 'hero' })).toMatchObject([
      { id: 'asset-a', projectId: 'project-a' },
    ]);
    expect(repositories.assets.queryByProject('project-b', { keyword: 'Hero' })).toMatchObject([
      { id: 'asset-b', projectId: 'project-b' },
    ]);
    database.close();
  });
});
