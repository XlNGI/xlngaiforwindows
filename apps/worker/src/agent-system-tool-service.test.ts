import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetInfo, ProviderModelInfo, ProviderProfileInfo } from '@ai-video/contracts';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
  type AgentSettingsToolService,
} from './agent-system-tool-service.js';
import { AgentToolPolicyError, unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { ContentService } from './content-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

it('declares questions as a core system tool and returns a persisted form receipt', async () => {
  const { service, content, project, current, identity } = await setup();
  const user = content.saveMessage({
    conversationId: current.id,
    role: 'user',
    content: '设计短剧',
  });
  const assistant = content.saveMessage({
    conversationId: current.id,
    replyToMessageId: user.id,
    role: 'assistant',
    content: '请确认方向',
  });
  const workflow = new DocumentWorkflowService(project);
  const { task } = workflow.createDocumentDraftFromMessage({ messageId: assistant.id });
  expect(service.availableOperations()).toContain('conversation.ask');
  const receipt = service.execute(
    'conversation.ask',
    {
      key: 'direction',
      title: '确认方向',
      questions: [{ id: 'notes', prompt: '你的想法', type: 'text' }],
    },
    { ...identity, taskId: task.id },
  );
  expect(receipt).toMatchObject({
    status: 'pending',
    questionCount: 1,
    presentation: 'conversation-form',
    awaitingUserAnswer: true,
  });
  expect(receipt).not.toHaveProperty('answers');
  expect(
    workflow.getTask({ taskId: task.id }).events.find((event) => event.userInput)?.userInput?.id,
  ).toBe(receipt.formId);
});

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-system-tools-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  const opened = project.create(join(directory, 'project'), 'System Tool Project');
  const content = new ContentService(project);
  const novels = new NovelService(project);
  const current = content.createConversation({ scopeType: 'project', title: 'Current' });
  content.createConversation({ scopeType: 'project', title: 'Research Notes' });
  const asset: AssetInfo = {
    id: 'asset-1',
    projectId: opened.id,
    kind: 'generated-image',
    relativePath: 'assets/private.png',
    contentHash: 'hash',
    sizeBytes: 42,
    sourceUrl: 'https://signed.example/private?token=secret',
    alias: 'Cover',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const assets: AgentAssetToolService = {
    listAssets: () => [asset],
    getAssetInfo: (assetId) => {
      if (assetId !== asset.id) throw new Error('Asset was not found.');
      return asset;
    },
    updateAssetAlias: ({ assetId, alias }) => {
      if (assetId !== asset.id) throw new Error('Asset was not found.');
      return { ...asset, alias };
    },
    listTags: () => [],
    createTag: () => {
      throw new Error('Not implemented in this fixture.');
    },
    updateTag: () => {
      throw new Error('Not implemented in this fixture.');
    },
    deleteTag: () => ({ deleted: true }),
    changeAssetTags: () => [asset],
    listGroups: () => [],
    createGroup: () => {
      throw new Error('Not implemented in this fixture.');
    },
    updateGroup: () => {
      throw new Error('Not implemented in this fixture.');
    },
    deleteGroup: () => ({ deleted: true }),
    resolveGroup: () => [asset],
    deleteAsset: () => ({ deleted: true, referenceCount: 0 }),
    restoreAsset: () => asset,
  };
  const profile: ProviderProfileInfo = {
    id: 'profile-1',
    name: 'Provider',
    category: 'multi',
    providerType: 'custom-provider',
    accessType: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://private.example/v1',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const model: ProviderModelInfo = {
    id: 'model-1',
    providerProfileId: profile.id,
    remoteModelId: 'private-remote-name',
    displayName: 'Assistant',
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      reasoning: false,
      tools: true,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: false,
      videoGeneration: false,
    },
    source: 'manual',
    enabled: true,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const settings: AgentSettingsToolService = {
    listProfiles: () => [profile],
    listModels: () => [model],
  };
  const mediaTasks = {
    getTask: (taskId: string) => ({
      taskId,
      kind: 'video' as const,
      state: 'polling' as const,
      adapterKey: 'TEXT_TO_VIDEO:unicompapi:test:v1',
      resultAssetIds: [],
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z',
    }),
  };
  return {
    project,
    content,
    assets,
    settings,
    service: new AgentSystemToolService(
      project,
      content,
      assets,
      settings,
      mediaTasks,
      undefined,
      undefined,
      undefined,
      novels,
    ),
    identity: {
      projectId: opened.id,
      projectSessionId: project.currentSessionId()!,
      conversationId: current.id,
    },
    current,
    novels,
  };
}

describe('AgentSystemToolService', () => {
  it('lets the model route a new generation to an independent or completed follow-up task', async () => {
    const { service, identity, project, current } = await setup();
    const now = new Date().toISOString();
    const ids = {
      snapshot: randomUUID(),
      target: randomUUID(),
      current: randomUUID(),
      targetUser: randomUUID(),
      targetAssistant: randomUUID(),
      currentUser: randomUUID(),
      currentAssistant: randomUUID(),
      task: randomUUID(),
    };
    project.access(true, (db, opened) =>
      db.transaction(() => {
        for (const id of [ids.snapshot])
          db.prepare(
            'INSERT INTO context_snapshots(id,project_id,purpose,content_json,created_at) VALUES(?,?,?,?,?)',
          ).run(id, opened.id, 'test', '{}', now);
        db.prepare(
          'INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)',
        ).run(ids.targetUser, current.id, 'user', '上一轮任务', 'complete', now);
        db.prepare(
          'INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)',
        ).run(ids.targetAssistant, current.id, 'assistant', '上一轮已完成结果', 'complete', now);
        db.prepare(
          'INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)',
        ).run(ids.currentUser, current.id, 'user', '继续上一轮', 'complete', now);
        db.prepare(
          'INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)',
        ).run(ids.currentAssistant, current.id, 'assistant', '', 'streaming', now);
        const insertGeneration = db.prepare(
          `INSERT INTO llm_generations(id,project_id,project_session_id,conversation_id,context_snapshot_id,user_message_id,assistant_message_id,status,execution_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        );
        insertGeneration.run(
          ids.target,
          opened.id,
          identity.projectSessionId,
          current.id,
          ids.snapshot,
          ids.targetUser,
          ids.targetAssistant,
          'complete',
          'native',
          now,
          now,
        );
        insertGeneration.run(
          ids.current,
          opened.id,
          identity.projectSessionId,
          current.id,
          ids.snapshot,
          ids.currentUser,
          ids.currentAssistant,
          'streaming',
          'native',
          now,
          now,
        );
        db.prepare(
          'INSERT INTO generation_branches(generation_id,branch_id,input_message_id,history_cutoff,excluded_generation_ids_json,execution,dependency_generation_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(ids.target, ids.target, ids.targetUser, 0, '[]', 'legacy', null, now);
        db.prepare(
          'INSERT INTO generation_branches(generation_id,branch_id,input_message_id,history_cutoff,excluded_generation_ids_json,execution,dependency_generation_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(ids.current, ids.current, ids.currentUser, 0, '[]', 'legacy', null, now);
        db.prepare(
          `INSERT INTO agent_tasks(id,project_id,project_session_id,conversation_id,user_message_id,task_type,scope_type,title,request_snapshot_json,request_hash,context_snapshot_id,status,created_at,started_at,updated_at,phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          ids.task,
          opened.id,
          identity.projectSessionId,
          current.id,
          ids.currentUser,
          'document-create',
          'project',
          'route test',
          '{}',
          'route-test',
          ids.snapshot,
          'running',
          now,
          now,
          now,
          'model_running',
        );
        db.prepare(
          'INSERT INTO agent_task_generations(task_id,generation_id,ordinal,purpose,created_at) VALUES(?,?,?,?,?)',
        ).run(ids.task, ids.current, 0, 'route', now);
      })(),
    );
    const routed = service.execute(
      'conversation.task.route',
      {
        decision: 'follow_up',
        targetGenerationId: ids.target,
        rationale: '用户明确要求继续上一轮',
      },
      { ...identity, taskId: ids.task, toolCallId: 'route-call' },
    );
    expect(routed).toMatchObject({
      status: 'routed',
      decision: 'follow_up',
      targetGenerationId: ids.target,
    });
    expect(
      project.access(false, (db) =>
        db
          .prepare(
            'SELECT execution,dependency_generation_id,dependency_snapshot_json FROM generation_branches WHERE generation_id=?',
          )
          .get(ids.current),
      ),
    ).toMatchObject({ execution: 'ordered', dependency_generation_id: ids.target });
    const independent = service.execute(
      'conversation.task.route',
      { decision: 'independent', rationale: '新请求是独立工作' },
      { ...identity, taskId: ids.task, toolCallId: 'route-call-2' },
    );
    expect(independent).toMatchObject({ status: 'routed', decision: 'independent' });
    expect(
      project.access(false, (db) =>
        db
          .prepare(
            'SELECT execution,dependency_generation_id FROM generation_branches WHERE generation_id=?',
          )
          .get(ids.current),
      ),
    ).toEqual({ execution: 'parallel', dependency_generation_id: null });
  });
  it('reads the exact existing scene and its cast on demand without name resolution', async () => {
    const { service, identity, content } = await setup();
    const actor = content.saveDocument({
      kind: 'character',
      title: '老周',
      contentMarkdown: '# 老周',
    });
    const scene = content.saveScene({
      title: '同名场次',
      videoPrompt: '司机转身，他没有说话。',
      characterBindings: [{ characterDocumentId: actor.id }],
    });
    expect(service.execute('production.defaults.get', {}, identity)).toEqual({
      rowVersion: 0,
      settings: {},
    });
    const result = service.execute('scene.read', { sceneId: scene.id }, identity);
    expect(result).toMatchObject({
      status: 'read',
      scene: { id: scene.id, characterBindings: scene.characterBindings, hasPrompt: true },
      shots: [],
      target: { kind: 'scene', id: scene.id },
      rowVersion: scene.rowVersion,
      issues: [],
    });
    expect(JSON.stringify(result)).not.toContain(scene.videoPrompt);
    expect(
      service.execute('scene.read', { sceneId: scene.id, view: 'text' }, identity),
    ).toMatchObject({ text: scene.videoPrompt });
    const mediaRead = service.execute('scene.read', { sceneId: scene.id, view: 'media' }, identity);
    expect(mediaRead.status).toBe('read');
    expect(JSON.stringify(mediaRead)).toContain('saved-production-bindings');
    expect(JSON.stringify(mediaRead)).toContain(actor.id);
    expect(JSON.stringify(mediaRead)).toContain('"selectionSource":"none"');
    expect(JSON.stringify(result)).not.toContain('"token"');
    expect(() => service.execute('scene.read', { sceneId: 'missing' }, identity)).toThrow(
      'current project',
    );
    expect(() =>
      service.execute('scene.read', { sceneId: scene.id, prompt: '老周' }, identity),
    ).toThrow('unsupported field');
  });
  it('lists novel chapters without bodies and applies chapter lifecycle changes with CAS', async () => {
    const { service, identity, novels } = await setup();
    novels.getProfile({ createIfMissing: true });
    const chapter = novels.saveChapter({ title: '第一章 雾港' });

    expect(service.execute('novel.chapter.list', {}, identity)).toMatchObject({
      status: 'succeeded',
      chapters: [
        expect.objectContaining({
          id: chapter.id,
          title: '第一章 雾港',
          lifecycleStatus: 'active',
          rowVersion: chapter.rowVersion,
        }),
      ],
    });

    const pending = service.prepareConfirmation(
      'novel.chapter.archive',
      { chapterId: chapter.id, expectedRowVersion: chapter.rowVersion },
      identity,
    );
    expect(pending).toMatchObject({
      affectedEntities: [{ type: 'novel-chapter', id: chapter.id }],
      executionArguments: {
        chapterId: chapter.id,
        expectedRowVersion: chapter.rowVersion,
        reason: 'user_archive',
      },
    });
    expect(novels.listChapters({ includeArchived: true })[0]?.lifecycleStatus).toBe('active');

    const archived = service.executeConfirmed(
      'novel.chapter.archive',
      pending.executionArguments,
      identity,
    );
    expect(archived).toMatchObject({ status: 'archived', chapter: { id: chapter.id } });
    const archivedChapter = novels.listChapters({ includeArchived: true })[0]!;
    expect(archivedChapter.lifecycleStatus).toBe('archived');

    const restored = service.executeConfirmed(
      'novel.chapter.restore',
      { chapterId: chapter.id, expectedRowVersion: archivedChapter.rowVersion },
      identity,
    );
    expect(restored).toMatchObject({ status: 'restored', chapter: { id: chapter.id } });
    expect(novels.listChapters({ includeArchived: true })[0]?.lifecycleStatus).toBe('active');
  });

  it('exposes chapter metadata editing without body submission and rejects unsupported mutations', async () => {
    const { service, identity, novels } = await setup();
    const chapter = novels.saveChapter({
      title: '第二章 深夜剑冢',
      displayLabel: '第二章 深夜剑冢',
    });
    const params = {
      chapterId: chapter.id,
      expectedChapterRowVersion: chapter.rowVersion,
      expectedDocumentRowVersion: chapter.documentRowVersion,
      displayLabel: '第 2 章',
    };
    expect(service.availableOperations()).toContain('novel.chapter.update_metadata');
    expect(
      unifiedAgentToolRegistry.require('novel.chapter.update_metadata').confirmationPolicy,
    ).toBe('explicit-user-intent');
    for (const unsupported of [
      { contentMarkdown: '覆盖正文' },
      { position: 8 },
      { volumeId: 'other-volume' },
    ]) {
      expect(() =>
        service.execute('novel.chapter.update_metadata', { ...params, ...unsupported }, identity),
      ).toThrow('unsupported field');
    }
    expect(() =>
      service.execute(
        'novel.chapter.update_metadata',
        { ...params, displayLabel: undefined },
        identity,
      ),
    ).toThrow('Provide title or displayLabel');
    expect(() =>
      service.execute('novel.chapter.update_metadata', { ...params, displayLabel: ' ' }, identity),
    ).toThrow();
    expect(() =>
      service.execute(
        'novel.chapter.update_metadata',
        { ...params, expectedDocumentRowVersion: undefined },
        identity,
      ),
    ).toThrow();
    expect(service.execute('novel.chapter.update_metadata', params, identity)).toMatchObject({
      status: 'chapter_metadata_saved',
      chapterId: chapter.id,
      chapter: { title: chapter.title, displayLabel: '第 2 章' },
      locator: { workspace: 'novel', chapterId: chapter.id, documentId: chapter.documentId },
    });
    expect(() => service.execute('novel.chapter.update_metadata', params, identity)).toThrow(
      'updated elsewhere',
    );
  });

  it('rejects stale or foreign novel chapter lifecycle requests', async () => {
    const first = await setup();
    first.novels.getProfile({ createIfMissing: true });
    const chapter = first.novels.saveChapter({ title: '当前项目章节' });
    expect(() =>
      first.service.prepareConfirmation(
        'novel.chapter.archive',
        { chapterId: chapter.id, expectedRowVersion: chapter.rowVersion + 1 },
        first.identity,
      ),
    ).toThrow('AGENT_TOOL_ARGUMENTS_INVALID');

    const second = await setup();
    expect(() =>
      second.service.prepareConfirmation(
        'novel.chapter.archive',
        { chapterId: chapter.id, expectedRowVersion: chapter.rowVersion },
        second.identity,
      ),
    ).toThrow('AGENT_TOOL_PROJECT_SCOPE');
  });

  it('returns bounded project, conversation, asset, and redacted settings summaries', async () => {
    const { service, identity } = await setup();
    const project = service.execute('project.get_context', {}, identity);
    const conversations = service.execute(
      'conversation.search',
      { query: 'research', limit: 10 },
      identity,
    );
    const assets = service.execute('asset.search', { limit: 10 }, identity);
    const settings = service.execute('settings.get', { capability: 'text' }, identity);

    for (const result of [project, conversations, assets, settings]) {
      expect(() => unifiedAgentToolRegistry.serializeResult(result)).not.toThrow();
    }
    expect(JSON.stringify(project)).not.toContain('rootPath');
    expect(conversations).toMatchObject({
      conversations: [expect.objectContaining({ title: 'Research Notes' })],
    });
    expect(JSON.stringify(assets)).not.toMatch(/relativePath|contentHash|sourceUrl|token=secret/u);
    expect(JSON.stringify(settings)).not.toMatch(/baseUrl|remoteModelId|private\.example/u);
  });

  it('returns only the normalized media task summary', async () => {
    const { service, identity } = await setup();
    expect(service.availableOperations()).toContain('media.task.get');
    const result = service.execute('media.task.get', { taskId: 'media-task' }, identity);

    expect(result).toMatchObject({
      status: 'succeeded',
      task: { taskId: 'media-task', kind: 'video', state: 'polling', resultAssetIds: [] },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /rootPath|relativePath|providerBody|providerResponse/iu,
    );
  });

  it('omits media task inspection when its service is not configured', async () => {
    const { project, content, assets, settings, identity } = await setup();
    const service = new AgentSystemToolService(project, content, assets, settings);

    expect(service.availableOperations()).not.toContain('media.task.get');
    expect(() => service.execute('media.task.get', { taskId: 'media-task' }, identity)).toThrow(
      'Media task inspection is not configured for this runtime.',
    );
  });

  it('renames only the current conversation and rejects a model-provided conversation ID', async () => {
    const { service, identity, content, current } = await setup();
    expect(service.execute('conversation.rename', { title: 'Renamed' }, identity)).toMatchObject({
      conversation: { id: current.id, title: 'Renamed' },
    });
    expect(
      content
        .listConversations({ includeArchived: true })
        .items.find((item) => item.id === current.id)?.title,
    ).toBe('Renamed');
    expect(() =>
      service.execute(
        'conversation.rename',
        { conversationId: 'other', title: 'Forbidden' },
        identity,
      ),
    ).toThrow('unsupported field conversationId');
  });

  it('rejects stale sessions and cross-project asset identifiers', async () => {
    const { service, identity } = await setup();
    expect(() =>
      service.execute('project.get_context', {}, { ...identity, projectSessionId: 'stale' }),
    ).toThrow('AGENT_TOOL_PROJECT_SCOPE');
    try {
      service.execute('asset.update_alias', { assetId: 'other-project', alias: 'x' }, identity);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolPolicyError);
      expect((error as AgentToolPolicyError).code).toBe('AGENT_TOOL_PROJECT_SCOPE');
    }
  });
});
