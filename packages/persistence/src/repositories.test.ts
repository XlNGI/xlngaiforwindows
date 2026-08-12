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
      scopeType: 'project',
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
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.shots.save({
      id: 'shot',
      sceneId: 'scene',
      title: 'Shot 1',
      position: 0,
      status: 'draft',
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
      createdAt: 'now',
      updatedAt: 'now',
    });
    repositories.contextSnapshots.save({
      id: 'snapshot',
      projectId: 'project',
      purpose: 'test-context',
      contentJson: '{"version":1}',
      createdAt: 'now',
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
    expect(repositories.jobs.listByProject('project')).toMatchObject([{ status: 'draft' }]);
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
      scopeType: 'project',
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
