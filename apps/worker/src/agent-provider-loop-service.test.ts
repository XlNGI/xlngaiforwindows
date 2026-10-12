import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '@ai-video/llm';
import { AGENT_TOOL_RESULT_LIMITS } from '@ai-video/contracts';
import {
  AgentProviderLoopService,
  inferNovelReference,
  type AgentMediaSubmissionExecutor,
} from './agent-provider-loop-service.js';
import { ChangeSetService } from './change-set-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService, type LlmSelectionResolver } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { ResearchService } from './research-service.js';
import { NovelContextService } from './novel-context-service.js';
import { NovelService } from './novel-service.js';
import { getAdapter } from '@ai-video/generation-adapters';
import { AgentSystemToolService } from './agent-system-tool-service.js';
import { AdapterService } from './adapter-service.js';
import { AppSettingsService } from './app-settings-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { MediaPreparationService } from './media-preparation-service.js';
import { VideoGenerationService } from './video-generation-service.js';
import { AgentOrchestrationService } from './agent-orchestration-service.js';
import { prepareAgentGeneration } from './agent-generation-preparation.js';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import { TaskPlanService } from './task-plan-service.js';
import { ProjectStructureCompiler } from './structure-compiler.js';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const directories: string[] = [];
const projects: ProjectService[] = [];
const settingsServices: AppSettingsService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  for (const settings of settingsServices.splice(0)) settings.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup(
  protocol: 'openai-responses' | 'openai-chat-completions' = 'openai-responses',
  research?: ResearchService,
) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-provider-loop-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), 'Agent Tool Project');
  const content = new ContentService(project);
  const conversation = content.createConversation({ scopeType: 'project' });
  const novels = new NovelService(project);
  const provider: LlmProvider = {
    status: () => ({ key: 'unused', name: 'Unused', model: 'unused', configured: false }),
    stream: () => Promise.reject(new Error('native provider is used for this test')),
  };
  const selectionResolver: LlmSelectionResolver = {
    resolveLlmSelection: () => ({
      providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
      providerName: 'Local Mock',
      modelId: '123e4567-e89b-42d3-a456-426614174001',
      modelName: 'Mock Model',
      remoteModelId: 'mock-model',
      protocol,
      baseUrl: 'https://mock.invalid/v1',
    }),
  };
  const generations = new GenerationService(
    project,
    content,
    new ContextService(project),
    provider,
    { selectionResolver },
  );
  const workflow = new DocumentWorkflowService(project);
  const loop = new AgentProviderLoopService(project, workflow, research);
  return { conversation, generations, loop, project, workflow, novels };
}

async function setupMedia(
  ready = true,
  protocol: 'openai-responses' | 'openai-chat-completions' = 'openai-responses',
) {
  const base = await setup(protocol);
  const directory = await mkdtemp(join(tmpdir(), 'agent-provider-media-settings-'));
  directories.push(directory);
  const settings = new AppSettingsService({ appDataDirectory: directory });
  settingsServices.push(settings);
  const profile = settings.createProfile({
    name: 'UniCompAPI Media',
    category: 'multi',
    providerType: 'unicompapi',
    accessType: 'official',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://unicompapi.com/v1',
  });
  if (ready) {
    settings.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'vendor-hosted-video-model' }],
    });
    for (const model of settings.listModels(profile.id)) {
      settings.updateModel({
        profileId: profile.id,
        modelId: model.id,
        displayName: model.displayName,
        capabilities: { ...model.capabilities, videoGeneration: true },
        enabled: true,
        parameterTemplateKey: 'openai-compatible-video',
      });
    }
  }
  const images = new ImageGenerationService(base.project);
  const videos = new VideoGenerationService(base.project);
  const media = new MediaPreparationService(
    base.project,
    settings,
    new AdapterService(base.project),
    images,
    videos,
    (identity) => base.generations.runtime(identity).attachments ?? [],
  );
  return {
    ...base,
    profile,
    images,
    videos,
    media,
    loop: new AgentProviderLoopService(
      base.project,
      base.workflow,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      media,
    ),
  };
}

function createSystemLoop(
  project: ProjectService,
  workflow: DocumentWorkflowService,
  novels?: NovelService,
  media?: MediaPreparationService,
) {
  return new AgentProviderLoopService(
    project,
    workflow,
    undefined,
    undefined,
    undefined,
    undefined,
    new AgentSystemToolService(
      project,
      new ContentService(project),
      {
        listAssets: () => [],
        getAssetInfo: () => {
          throw new Error('Asset was not found.');
        },
        updateAssetAlias: () => {
          throw new Error('Asset was not found.');
        },
        listTags: () => [],
        createTag: () => {
          throw new Error('Not implemented in this fixture.');
        },
        updateTag: () => {
          throw new Error('Not implemented in this fixture.');
        },
        deleteTag: () => ({ deleted: true }),
        changeAssetTags: () => [],
        listGroups: () => [],
        createGroup: () => {
          throw new Error('Not implemented in this fixture.');
        },
        updateGroup: () => {
          throw new Error('Not implemented in this fixture.');
        },
        deleteGroup: () => ({ deleted: true }),
        resolveGroup: () => [],
        deleteAsset: () => ({ deleted: true, referenceCount: 0 }),
        restoreAsset: () => {
          throw new Error('Asset was not found.');
        },
      },
      { listProfiles: () => [], listModels: () => [] },
      undefined,
      workflow,
      undefined,
      new ProjectStructureCompiler(),
      novels,
    ),
    media,
  );
}

function taskSnapshot(project: ProjectService, taskId: string): Record<string, unknown> {
  return project.access(false, (database) => {
    const row = database
      .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id = ?')
      .get(taskId) as { request_snapshot_json: string };
    return JSON.parse(row.request_snapshot_json) as Record<string, unknown>;
  });
}

describe('AgentProviderLoopService', () => {
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'Pi lets the model query and submit two independent chapter drafts through %s',
    async (protocol) => {
      const { conversation, generations, project, workflow, novels } = await setup(protocol);
      const loop = createSystemLoop(project, workflow, novels);
      const prompt = '  生成小说的第四章和第五章，先不要发布。  ';
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
        novelIntent: { action: 'create_chapter', displayLabel: '第四章' },
      });
      const agent = loop.prepare(prepared.stream, prompt, undefined, {
        operation: 'document.list',
      });
      generations.configureAgentTools(prepared.stream, agent.tools);
      expect(generations.runtime(prepared.stream).prompt).toBe(prompt);
      expect(generations.runtime(prepared.stream).systemInstruction).toContain('可选 UI 目标提示');
      expect(novels.listChapters()).toHaveLength(0);
      expect(workflow.listDocuments()).toHaveLength(0);
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('document.list', {}, { id: 'list-documents' })], {
          stopReason: 'toolUse',
          responseId: 'list-response',
        }),
        fauxAssistantMessage([fauxToolCall('novel.chapter.list', {}, { id: 'list-chapters' })], {
          stopReason: 'toolUse',
          responseId: 'chapters-response',
        }),
        ...['第四章', '第五章'].map((label) =>
          fauxAssistantMessage(
            [
              fauxToolCall(
                'novel.chapter.write_draft',
                {
                  action: 'create_chapter',
                  title: `${label} 雾港`,
                  displayLabel: label,
                  contentMarkdown: `${label}的完整正文。`,
                },
                { id: label },
              ),
            ],
            { stopReason: 'toolUse', responseId: `${label}-response` },
          ),
        ),
        fauxAssistantMessage('两章草稿已保存，等待审核。'),
      ]);
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: {} as never,
        providerTools: loop,
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('Ordinary prompts must not start a classifier/planner round.');
        },
      });
      await runtime.start({
        ...prepared.stream,
        identity: prepared.stream,
        taskId: agent.taskId,
        mode: 'document',
        prompt,
      });
      await runtime.wait(prepared.stream.generationId);
      expect(generations.get(prepared.stream.generationId).status).toBe('complete');
      expect(novels.listChapters().map((chapter) => chapter.displayLabel)).toEqual([
        '第四章',
        '第五章',
      ]);
      const children = project.access(false, (database) =>
        database
          .prepare(
            `SELECT id, status, request_snapshot_json FROM agent_tasks WHERE json_extract(request_snapshot_json, '$.parentTaskId') = ? ORDER BY created_at, id`,
          )
          .all(agent.taskId),
      ) as Array<{ id: string; status: string; request_snapshot_json: string }>;
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.status === 'waiting_review')).toBe(true);
      for (const child of children) {
        const detail = workflow.getTask({ taskId: child.id });
        expect(detail.documents).toHaveLength(1);
        expect(detail.target?.targetKind).toBe('novel-chapter');
      }
      const parent = workflow.getTask({ taskId: agent.taskId });
      expect(parent.task.status).toBe('completed');
      expect(parent.task.outcome).not.toBe('read-only');
      expect(parent.documents).toHaveLength(2);
      expect(parent.target?.chapterId).toBe(novels.listChapters()[1]!.id);
      expect(
        project.access(false, (database) =>
          database.prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks').get(),
        ),
      ).toEqual({ count: 2 });
      expect(
        project.access(false, (database) =>
          database.prepare('SELECT COUNT(*) AS count FROM agent_task_confirmations').get(),
        ),
      ).toEqual({ count: 0 });
    },
  );

  it.each([
    '不要保存，讨论一下第五章该怎么写',
    'Could we explore possibilities?',
    '往前推进两回，按我们刚才商量的来',
  ])(
    'passes the raw prompt to the model with stable tools and no premature business writes: %s',
    async (prompt) => {
      const { conversation, generations, project, workflow, novels } = await setup();
      const loop = createSystemLoop(project, workflow, novels);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, prompt, undefined, {
        operation: 'document.list',
      });
      expect(agent.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'document.submit_draft',
          'novel.chapter.write_draft',
          'novel.chapter.list',
          'conversation.rename',
          'asset.search',
        ]),
      );
      expect(novels.listChapters()).toHaveLength(0);
      loop.startProviderStep(prepared.stream);
      loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' });
      expect(workflow.listDocuments()).toHaveLength(0);
      expect(workflow.getTask({ taskId: agent.taskId }).task.status).toBe('completed');
    },
  );

  it('rolls back invalid model targets and stale CAS, and preserves chapter review locks', async () => {
    const { conversation, generations, project, workflow, novels } = await setup();
    const chapter = novels.importNovel({ chapters: [{ title: '雾港', contentMarkdown: '原文' }] })
      .chapters[0]!;
    const loop = createSystemLoop(project, workflow, novels);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '沿用刚才的安排',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '沿用刚才的安排', undefined, {
      operation: 'document.list',
    });
    let tools = agent.tools;
    let ordinal = 0;
    const invoke = async (name: string, args: Record<string, unknown>) => {
      loop.startProviderStep(prepared.stream);
      const result = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: `response-${ordinal}`,
        calls: [
          {
            id: `call-${ordinal++}`,
            name,
            argumentsJson: JSON.stringify(args),
            authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
          },
        ],
      });
      tools = result.tools!;
      return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
    };
    const common = { title: '不要归档的雾港', contentMarkdown: '修订正文' };
    for (const args of [
      { ...common, action: 'create_chapter', volumeId: 'foreign-or-missing-volume' },
      {
        ...common,
        action: 'rewrite_chapter',
        chapterId: 'missing-chapter',
        expectedChapterRowVersion: 0,
        expectedDocumentRowVersion: 0,
        baseVersionId: null,
      },
      {
        ...common,
        action: 'rewrite_chapter',
        chapterId: chapter.id,
        expectedChapterRowVersion: chapter.rowVersion,
        expectedDocumentRowVersion: chapter.documentRowVersion + 1,
        baseVersionId: workflow.getDocument(chapter.documentId).currentVersionId ?? null,
      },
      { ...common, action: 'create_chapter', unexpectedField: true },
    ])
      expect(await invoke('novel.chapter.write_draft', args)).toMatchObject({ status: 'rejected' });
    expect(novels.listChapters()).toHaveLength(1);
    expect(workflow.listTasks()).toHaveLength(1);
    const saved = await invoke('novel.chapter.write_draft', {
      ...common,
      action: 'rewrite_chapter',
      chapterId: chapter.id,
      expectedChapterRowVersion: chapter.rowVersion,
      expectedDocumentRowVersion: chapter.documentRowVersion,
      baseVersionId: workflow.getDocument(chapter.documentId).currentVersionId ?? null,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('draft_saved');
    const latest = novels.listChapters()[0]!;
    expect(
      await invoke('novel.chapter.write_draft', {
        ...common,
        action: 'rewrite_chapter',
        chapterId: latest.id,
        expectedChapterRowVersion: latest.rowVersion,
        expectedDocumentRowVersion: latest.documentRowVersion,
        baseVersionId: workflow.getDocument(latest.documentId).currentVersionId ?? null,
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await invoke('document.submit_draft', {
        ...common,
        documentKind: 'note',
        documentId: latest.documentId,
        expectedDocumentRowVersion: latest.documentRowVersion,
        baseVersionId: workflow.getDocument(latest.documentId).currentVersionId ?? null,
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(workflow.listTasks()).toHaveLength(2);
    expect(workflow.getDocument(latest.documentId).currentVersion?.contentMarkdown).toBe(
      '修订正文',
    );
  });

  it('lets the model save multiple typed documents and an explicit novel reference, without keyword inference', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '照这个方向来吧',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '照这个方向来吧', undefined, {
      operation: 'document.list',
    });
    let tools = agent.tools;
    for (const [i, kind] of ['outline', 'character'].entries()) {
      loop.startProviderStep(prepared.stream);
      const result = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: `doc-response-${i}`,
        calls: [
          {
            id: `doc-call-${i}`,
            name: 'document.submit_draft',
            authorizationHandle: tools.find((tool) => tool.name === 'document.submit_draft')!
              .authorizationHandle,
            argumentsJson: JSON.stringify({
              title: `资料${i}`,
              documentKind: kind,
              contentMarkdown: `完整内容${i}`,
              ...(i === 0 ? { bindingRole: 'work-outline' } : {}),
            }),
          },
        ],
      });
      expect(JSON.parse(result.continuation!.outputs[0]!.output) as unknown).toMatchObject({
        status: 'draft_saved',
      });
      tools = result.tools!;
    }
    expect(
      workflow
        .listDocuments()
        .map((doc) => doc.kind)
        .sort(),
    ).toEqual(['character', 'outline']);
    expect(workflow.getTask({ taskId: agent.taskId }).documents).toHaveLength(2);
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT role, domain_scope FROM document_bindings').get(),
      ),
    ).toEqual({ role: 'work-outline', domain_scope: 'novel' });
    const existing = workflow.listDocuments().find((document) => document.kind === 'character')!;
    loop.startProviderStep(prepared.stream);
    const revised = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'revision-response',
      calls: [
        {
          id: 'revision-call',
          name: 'document.submit_draft',
          authorizationHandle: tools.find((tool) => tool.name === 'document.submit_draft')!
            .authorizationHandle,
          argumentsJson: JSON.stringify({
            title: existing.title,
            contentMarkdown: '修订后的完整内容',
            documentKind: existing.kind,
            documentId: existing.id,
            expectedDocumentRowVersion: existing.rowVersion,
            baseVersionId: existing.currentVersionId,
          }),
        },
      ],
    });
    const revision = JSON.parse(revised.continuation!.outputs[0]!.output) as {
      status: string;
      taskId: string;
    };
    expect(revision.status).toBe('draft_saved');
    expect(workflow.getTask({ taskId: revision.taskId }).documents[0]?.operation).toBe('update');
    expect(workflow.getDocument(existing.id).currentVersion?.contentMarkdown).toBe(
      '修订后的完整内容',
    );
  });

  it('rejects real foreign IDs and archived chapters without creating child artifacts', async () => {
    const local = await setup();
    const foreign = await setup();
    const foreignChapter = foreign.novels.importNovel({
      chapters: [{ title: '外部章节', contentMarkdown: '外部正文' }],
    }).chapters[0]!;
    const archived = local.novels.importNovel({
      chapters: [{ title: '已归档', contentMarkdown: '已归档正文' }],
    }).chapters[0]!;
    local.novels.archiveChapter({
      chapterId: archived.id,
      expectedRowVersion: archived.rowVersion,
    });
    const loop = createSystemLoop(local.project, local.workflow, local.novels);
    const prepared = local.generations.prepare({
      conversationId: local.conversation.id,
      prompt: '按约定来',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    let tools = loop.prepare(prepared.stream, '按约定来', undefined, {
      operation: 'document.list',
    }).tools;
    for (const [i, chapter] of [foreignChapter, archived].entries()) {
      loop.startProviderStep(prepared.stream);
      const result = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: `foreign-response-${i}`,
        calls: [
          {
            id: `foreign-call-${i}`,
            name: 'novel.chapter.write_draft',
            authorizationHandle: tools.find((tool) => tool.name === 'novel.chapter.write_draft')!
              .authorizationHandle,
            argumentsJson: JSON.stringify({
              action: 'rewrite_chapter',
              chapterId: chapter.id,
              expectedChapterRowVersion: chapter.rowVersion,
              expectedDocumentRowVersion: chapter.documentRowVersion,
              baseVersionId: null,
              title: '不应写入',
              contentMarkdown: '不应写入',
            }),
          },
        ],
      });
      expect(JSON.parse(result.continuation!.outputs[0]!.output) as unknown).toMatchObject({
        status: 'rejected',
      });
      tools = result.tools!;
    }
    expect(local.workflow.listTasks()).toHaveLength(1);
    expect(local.workflow.getDocument(archived.documentId).currentVersion?.contentMarkdown).toBe(
      '已归档正文',
    );
    expect(
      foreign.workflow.getDocument(foreignChapter.documentId).currentVersion?.contentMarkdown,
    ).toBe('外部正文');
  });

  it('enforces the actual task quota and rejects old handles for model selected draft tools', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '照商量的来',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '照商量的来', undefined, {
      operation: 'document.list',
    });
    project.access(true, (database) =>
      database.prepare('UPDATE agent_tasks SET tool_call_limit = 1 WHERE id = ?').run(agent.taskId),
    );
    const old = agent.tools.find((tool) => tool.name === 'document.submit_draft')!;
    const args = JSON.stringify({
      title: '已授权草稿',
      contentMarkdown: '完整内容',
      documentKind: 'note',
    });
    loop.startProviderStep(prepared.stream);
    const saved = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'quota-save',
      calls: [
        {
          id: 'quota-first',
          name: old.name,
          authorizationHandle: old.authorizationHandle,
          argumentsJson: args,
        },
      ],
    });
    loop.startProviderStep(prepared.stream);
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'quota-old',
        calls: [
          {
            id: 'quota-replay',
            name: old.name,
            authorizationHandle: old.authorizationHandle,
            argumentsJson: args,
          },
        ],
      }),
    ).rejects.toThrow('AGENT_TOOL_AUTHORIZATION_REPLAYED');
    const fresh = saved.tools!.find((tool) => tool.name === old.name)!;
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'quota-new',
        calls: [
          {
            id: 'quota-second',
            name: fresh.name,
            authorizationHandle: fresh.authorizationHandle,
            argumentsJson: args,
          },
        ],
      }),
    ).rejects.toThrow('quota is exhausted');
    expect(workflow.listDocuments()).toHaveLength(1);
    expect(workflow.listTasks()).toHaveLength(2);
  });
  it('classifies novel reference requests separately from screenplay documents', () => {
    expect(inferNovelReference('请生成小说大纲')).toEqual({
      role: 'work-outline',
      kind: 'outline',
    });
    expect(inferNovelReference('整理小说人物设定')).toEqual({
      role: 'character-bible',
      kind: 'character',
    });
    expect(inferNovelReference('生成短剧大纲')).toBeUndefined();
    expect(inferNovelReference('写一份项目大纲')).toBeUndefined();
  });

  it('pauses a natural-language video request for media selection and resumes with a local draft', async () => {
    const { conversation, generations, loop, project } = await setupMedia();
    const prompt = '帮我生成龙在天空翱翔的视频';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    const videoTool = agent.tools.find((tool) => tool.name === 'media.video.prepare');
    expect(videoTool).toBeDefined();
    loop.startProviderStep(prepared.stream);

    const paused = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'media-response',
      calls: [
        {
          id: 'media-call',
          name: 'media.video.prepare',
          authorizationHandle: videoTool!.authorizationHandle,
          argumentsJson: JSON.stringify({ prompt: '一条龙在天空翱翔，电影感镜头' }),
        },
      ],
    });

    expect(paused.continuation).toBeUndefined();
    expect(paused.mediaSelection?.candidates.length).toBeGreaterThan(0);
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
    const pending = project.access(
      false,
      (database) =>
        database
          .prepare(
            'SELECT status, request_json, selection_summary_json FROM agent_media_selections',
          )
          .get() as {
          status: string;
          request_json: string;
          selection_summary_json: string | null;
        },
    );
    expect(pending).toMatchObject({ status: 'pending', selection_summary_json: null });
    expect(pending.request_json).not.toContain(paused.mediaSelection!.selectionToken);

    const candidate = paused.mediaSelection!.candidates[0]!;
    const adapter = candidate.adapters[0]!;
    expect(() =>
      loop.selectMedia({
        ...prepared.stream,
        projectId: 'another-project',
        selectionToken: paused.mediaSelection!.selectionToken,
        selection: {
          providerProfileId: candidate.providerProfileId,
          modelId: candidate.modelId,
          adapterKey: adapter.key,
          parameters: {},
        },
      }),
    ).toThrow('current project session');
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
    const resumed = loop.selectMedia({
      ...prepared.stream,
      selectionToken: paused.mediaSelection!.selectionToken,
      selection: {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {},
      },
    });
    const output = resumed.continuation!.outputs[0]!.output;

    expect(JSON.parse(output)).toMatchObject({
      status: 'prepared',
      draft: {
        kind: 'video',
        status: 'draft',
        mediaModelSelection: {
          providerProfileId: candidate.providerProfileId,
          modelId: candidate.modelId,
          remoteModelId: candidate.remoteModelId,
          adapterKey: adapter.key,
        },
      },
    });
    expect(output).not.toMatch(/data:image|base64|[A-Z]:\\|credential|api[_-]?key/iu);
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT status, provider_task_id, task_snapshot_json FROM generation_jobs')
          .get(),
      ),
    ).toMatchObject({ status: 'pending', provider_task_id: null });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status FROM agent_media_selections').get(),
      ),
    ).toEqual({ status: 'consumed' });
    expect(() =>
      loop.selectMedia({
        ...prepared.stream,
        selectionToken: paused.mediaSelection!.selectionToken,
        selection: {
          providerProfileId: candidate.providerProfileId,
          modelId: candidate.modelId,
          adapterKey: adapter.key,
          parameters: {},
        },
      }),
    ).toThrow('already been resolved');
  });

  it('continues the same Provider call after one confirmed media submission', async () => {
    const base = await setupMedia();
    const requestSubmission = vi.fn<AgentMediaSubmissionExecutor['requestSubmission']>(
      ({ jobId }) => ({
        kind: 'video',
        job: base.videos.get(jobId),
        confirmation: {
          confirmationToken: 'media-confirmation-token',
          jobId,
          kind: 'video',
          draftVersion: 1,
          providerName: 'Selected Provider',
          modelName: 'Selected Model',
          adapterKey: 'TEXT_TO_VIDEO:unicompapi:doubao-seedance-2-0-260128:v1',
          parameterSummary: [{ key: 'prompt', value: 'cinematic dragon' }],
          costNotice: { required: true, summary: 'Paid request.' },
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      }),
    );
    const confirmSubmission = vi.fn<AgentMediaSubmissionExecutor['confirmSubmission']>(
      ({ jobId }) =>
        Promise.resolve({
          kind: 'video',
          job: base.videos.attachTask({ jobId, providerTaskId: 'provider-task-private' }),
        }),
    );
    const cancelSubmission = vi.fn<AgentMediaSubmissionExecutor['cancel']>(({ jobId }) =>
      Promise.resolve({
        kind: 'video',
        job: base.videos.cancel(jobId),
        cancellation: {
          localCancelled: true,
          provider: 'unsupported',
        },
      }),
    );
    const mediaSubmission: AgentMediaSubmissionExecutor = {
      requestSubmission,
      confirmSubmission,
      cancel: cancelSubmission,
    };
    const loop = new AgentProviderLoopService(
      base.project,
      base.workflow,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      base.media,
      mediaSubmission,
    );
    const prompt = 'Generate a cinematic video of a dragon flying through clouds.';
    const prepared = base.generations.prepare({
      conversationId: base.conversation.id,
      prompt,
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    const prepareTool = agent.tools.find((tool) => tool.name === 'media.video.prepare')!;
    loop.startProviderStep(prepared.stream);
    const selectionPending = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'prepare-provider-response',
      calls: [
        {
          id: 'prepare-provider-call',
          name: 'media.video.prepare',
          authorizationHandle: prepareTool.authorizationHandle,
          argumentsJson: JSON.stringify({ prompt }),
        },
      ],
    });
    const candidate = selectionPending.mediaSelection!.candidates[0]!;
    const adapter = candidate.adapters[0]!;
    const selected = loop.selectMedia({
      ...prepared.stream,
      selectionToken: selectionPending.mediaSelection!.selectionToken,
      selection: {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {},
      },
    });
    const preparedOutput = JSON.parse(selected.continuation!.outputs[0]!.output) as {
      draft: { draftId: string };
    };
    const submitTool = selected.tools!.find((tool) => tool.name === 'media.generation.submit')!;
    const storedSubmitAuthorization = base.project.access(false, (database) =>
      database
        .prepare(
          `SELECT authorization_handle_hash AS handleHash FROM agent_tool_authorizations
           WHERE allowed_operation = 'media.generation.submit'
             AND provider_step_id = (
               SELECT id FROM llm_provider_steps WHERE attempt_id = ? ORDER BY ordinal DESC LIMIT 1
             )`,
        )
        .get(prepared.stream.attemptId),
    ) as { handleHash: string };
    expect(
      createHash('sha256')
        .update(submitTool.authorizationHandle ?? '')
        .digest('hex'),
    ).toBe(storedSubmitAuthorization.handleHash);
    const submissionPending = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'submit-provider-response',
      calls: [
        {
          id: 'submit-provider-call',
          name: 'media.generation.submit',
          authorizationHandle: submitTool.authorizationHandle,
          argumentsJson: JSON.stringify({ taskId: preparedOutput.draft.draftId }),
        },
      ],
    });

    expect(submissionPending.continuation).toBeUndefined();
    expect(submissionPending.mediaSubmission?.confirmationToken).toBe('media-confirmation-token');
    expect(requestSubmission).toHaveBeenCalledTimes(1);
    expect(confirmSubmission).not.toHaveBeenCalled();
    expect(
      base.project.access(false, (database) =>
        database
          .prepare(
            `SELECT used_call_count AS usedCallCount FROM agent_tool_authorizations
             WHERE id = (
               SELECT authorization_id FROM agent_tool_calls WHERE provider_call_id = 'submit-provider-call'
             )`,
          )
          .get(),
      ),
    ).toEqual({ usedCallCount: 0 });

    const confirmed = await loop.confirmMediaSubmission({
      ...prepared.stream,
      jobId: preparedOutput.draft.draftId,
      confirmationToken: 'media-confirmation-token',
      approved: true,
    });
    expect(confirmSubmission).toHaveBeenCalledTimes(1);
    expect(confirmed.continuation).toMatchObject({
      protocol: 'openai-responses',
      previousResponseId: 'submit-provider-response',
      outputs: [{ callId: 'submit-provider-call' }],
    });
    const output = JSON.parse(confirmed.continuation!.outputs[0]!.output) as Record<
      string,
      unknown
    >;
    expect(output).toEqual({
      version: 1,
      status: 'polling',
      taskId: preparedOutput.draft.draftId,
      resultAssetIds: [],
    });
    expect(JSON.stringify(output)).not.toContain('provider-task-private');
    expect(
      base.project.access(false, (database) =>
        database
          .prepare(
            `SELECT authorizations.used_call_count AS usedCallCount, tasks.phase
             FROM agent_tool_calls calls
             INNER JOIN agent_tool_authorizations authorizations ON authorizations.id = calls.authorization_id
             INNER JOIN agent_tasks tasks ON tasks.id = authorizations.task_id
             WHERE calls.provider_call_id = 'submit-provider-call'`,
          )
          .get(),
      ),
    ).toEqual({ usedCallCount: 1, phase: 'model_running' });
    await expect(
      loop.confirmMediaSubmission({
        ...prepared.stream,
        jobId: preparedOutput.draft.draftId,
        confirmationToken: 'media-confirmation-token',
        approved: true,
      }),
    ).rejects.toThrow('no longer pending');
    expect(confirmSubmission).toHaveBeenCalledTimes(1);

    const cancelTool = confirmed.tools!.find((tool) => tool.name === 'media.task.cancel')!;
    const cancelled = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'cancel-provider-response',
      calls: [
        {
          id: 'cancel-provider-call',
          name: 'media.task.cancel',
          authorizationHandle: cancelTool.authorizationHandle,
          argumentsJson: JSON.stringify({ taskId: preparedOutput.draft.draftId }),
        },
      ],
    });
    expect(cancelled.mediaSubmission).toBeUndefined();
    expect(cancelled.continuation).toMatchObject({
      previousResponseId: 'cancel-provider-response',
      outputs: [{ callId: 'cancel-provider-call' }],
    });
    expect(JSON.parse(cancelled.continuation!.outputs[0]!.output)).toEqual({
      version: 1,
      status: 'cancelled',
      taskId: preparedOutput.draft.draftId,
      resultAssetIds: [],
      cancellation: {
        localCancelled: true,
        provider: 'unsupported',
      },
    });
    expect(cancelSubmission).toHaveBeenCalledTimes(1);
    expect(requestSubmission).toHaveBeenCalledTimes(1);
    expect(
      base.project.access(false, (database) =>
        database
          .prepare(
            `SELECT calls.status, authorizations.used_call_count AS usedCallCount, steps.finish_reason AS finishReason
             FROM agent_tool_calls calls
             INNER JOIN agent_tool_authorizations authorizations ON authorizations.id = calls.authorization_id
             INNER JOIN llm_provider_steps steps ON steps.id = calls.provider_step_id
             WHERE calls.provider_call_id = 'cancel-provider-call'`,
          )
          .get(),
      ),
    ).toEqual({ status: 'succeeded', usedCallCount: 1, finishReason: 'tool_calls' });
  });

  it('rejects a media selection identity from another conversation in the same project', async () => {
    const { conversation, generations, loop, project } = await setupMedia();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Generate a video',
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(prepared.stream, 'Generate a video');
    const videoTool = agent.tools.find((tool) => tool.name === 'media.video.prepare')!;
    loop.startProviderStep(prepared.stream);
    const paused = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'cross-conversation-media-response',
      calls: [
        {
          id: 'cross-conversation-media-call',
          name: 'media.video.prepare',
          authorizationHandle: videoTool.authorizationHandle,
          argumentsJson: JSON.stringify({ prompt: 'A cinematic sky' }),
        },
      ],
    });
    const anotherConversation = new ContentService(project).createConversation({
      scopeType: 'project',
    });

    expect(() =>
      loop.selectMedia({
        ...prepared.stream,
        conversationId: anotherConversation.id,
        selectionToken: paused.mediaSelection!.selectionToken,
        selection: undefined,
      }),
    ).toThrow('current project session');
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status FROM agent_media_selections').get(),
      ),
    ).toEqual({ status: 'pending' });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('expires an unanswered media selection without creating a draft', async () => {
    const { conversation, generations, loop, project } = await setupMedia();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成一段天空视频',
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(prepared.stream, '生成一段天空视频');
    const videoTool = agent.tools.find((tool) => tool.name === 'media.video.prepare')!;
    loop.startProviderStep(prepared.stream);
    const paused = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'expired-media-response',
      calls: [
        {
          id: 'expired-media-call',
          name: 'media.video.prepare',
          authorizationHandle: videoTool.authorizationHandle,
          argumentsJson: JSON.stringify({ prompt: '云层之上的电影镜头' }),
        },
      ],
    });
    project.access(true, (database) =>
      database
        .prepare("UPDATE agent_media_selections SET expires_at = '2000-01-01T00:00:00.000Z'")
        .run(),
    );

    expect(() =>
      loop.selectMedia({
        ...prepared.stream,
        selectionToken: paused.mediaSelection!.selectionToken,
        selection: undefined,
      }),
    ).toThrow('expired');
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status FROM agent_media_selections').get(),
      ),
    ).toEqual({ status: 'expired' });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('returns media unavailable without creating a job when no compatible model is ready', async () => {
    const { conversation, generations, loop, project } = await setupMedia(false);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '帮我生成龙在天空翱翔的视频',
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(prepared.stream, '帮我生成龙在天空翱翔的视频');
    const videoTool = agent.tools.find((tool) => tool.name === 'media.video.prepare')!;
    loop.startProviderStep(prepared.stream);

    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'media-unavailable-response',
      calls: [
        {
          id: 'media-unavailable-call',
          name: 'media.video.prepare',
          authorizationHandle: videoTool.authorizationHandle,
          argumentsJson: JSON.stringify({ prompt: '一条龙在天空翱翔' }),
        },
      ],
    });

    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'unavailable',
      kind: 'video',
    });
    expect(result.mediaSelection).toBeUndefined();
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('queries an adapter schema through a separately authorized read-only tool step', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const descriptor = getAdapter('TEXT_TO_IMAGE:vidu:viduq2:v2');
    if (!descriptor) throw new Error('Expected the Vidu Q2 adapter fixture.');
    const loop = new AgentProviderLoopService(project, workflow, undefined, undefined, {
      get: (adapterKey) => (adapterKey === descriptor.key ? descriptor : null),
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '查看图片模型支持哪些参数',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '查看图片模型支持哪些参数',
      '查询 Schema',
      { operation: 'adapter.schema.get' },
      'network_disabled',
    );
    expect(agent.tools.map((tool) => tool.name)).toEqual(['adapter.schema.get']);
    loop.startProviderStep(prepared.stream);
    const tool = agent.tools[0]!;
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_schema',
      calls: [
        {
          id: 'call_schema',
          name: 'adapter.schema.get',
          authorizationHandle: tool.authorizationHandle,
          argumentsJson: JSON.stringify({ adapterKey: descriptor.key }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(descriptor.key);
    const returned = JSON.parse(result.continuation!.outputs[0]!.output) as {
      descriptor?: Record<string, unknown>;
    };
    expect(returned.descriptor).not.toHaveProperty('endpoint');
    expect(returned.descriptor).not.toHaveProperty('credentialProvider');
    const persisted = project.access(
      false,
      (database) =>
        database
          .prepare(
            `SELECT tool_name, status, arguments_summary_json FROM agent_tool_calls
           WHERE task_id = ? ORDER BY created_at`,
          )
          .all(agent.taskId) as Array<{
          tool_name: string;
          status: string;
          arguments_summary_json: string;
        }>,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ tool_name: 'adapter.schema.get', status: 'succeeded' });
    expect(persisted[0]?.arguments_summary_json).toContain(descriptor.key);
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT status, outcome, task_type FROM agent_tasks WHERE id = ?')
          .get(agent.taskId),
      ),
    ).toEqual({ status: 'completed', outcome: 'read-only', task_type: 'schema-query' });
  });

  it('records a schema proposal and leaves the task waiting for explicit confirmation', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const descriptor = getAdapter('TEXT_TO_IMAGE:vidu:viduq2:v2');
    if (!descriptor) throw new Error('Expected the Vidu Q2 adapter fixture.');
    let proposed = false;
    const loop = new AgentProviderLoopService(
      project,
      workflow,
      undefined,
      undefined,
      {
        get: () => descriptor,
      },
      {
        propose: ({ adapterKey, descriptor: next, reason, conversationId }) => {
          proposed =
            adapterKey === descriptor.key &&
            next.key === descriptor.key &&
            conversationId === conversation.id;
          return {
            status: 'proposed',
            adapterKey,
            version: 2,
            requiresConfirmation: true,
            diff: [reason ?? 'parameter changed'],
          };
        },
        listAudits: (adapterKey) => [
          {
            id: 'audit-1',
            adapterKey,
            version: 1,
            action: 'confirmed',
            actorType: 'user',
            reason: 'initial',
            createdAt: '2026-09-02T00:00:00.000Z',
          },
        ],
      },
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '修改图片模型参数 Schema',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '修改图片模型参数 Schema',
      '提议 Schema 修改',
      { operation: 'adapter.schema.propose' },
      'network_disabled',
    );
    expect(agent.tools.map((tool) => tool.name)).toEqual(['adapter.schema.propose']);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_schema_propose',
      calls: [
        {
          id: 'call_schema_propose',
          name: 'adapter.schema.propose',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            adapterKey: descriptor.key,
            descriptor,
            reason: '补充默认值',
          }),
        },
      ],
    });
    expect(proposed).toBe(true);
    expect(result.continuation?.outputs[0]?.output).toContain('requiresUserConfirmation');
    // Pi may use one final Provider turn to explain the pending schema review.
    // That turn must not erase the external confirmation state.
    loop.startProviderStep(prepared.stream);
    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_schema_explained',
      finishReason: 'stop',
    });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status, phase FROM agent_tasks WHERE id = ?').get(agent.taskId),
      ),
    ).toEqual({ status: 'running', phase: 'waiting_confirmation' });
    expect(workflow.getTask({ taskId: agent.taskId }).pendingSchemaConfirmation).toMatchObject({
      action: 'adapter.schema.propose',
      adapterKey: descriptor.key,
      version: 2,
      status: 'pending',
    });
  });

  it('freezes the trusted target platform with a short-drama task snapshot', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成 AI 漫剧提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成 AI 漫剧提示词',
      'Seedance 漫剧',
      { operation: 'novel.episode.submit_draft' },
      'project_only',
      undefined,
      ['chapter-1'],
      'seedance',
    );
    const snapshot = project.access(false, (database) => {
      const row = database
        .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id = ?')
        .get(agent.taskId) as { request_snapshot_json: string };
      return JSON.parse(row.request_snapshot_json) as Record<string, unknown>;
    });
    expect(snapshot).toMatchObject({
      agentMode: 'short-drama',
      selectedChapterIds: ['chapter-1'],
      targetPlatform: 'seedance',
    });
  });

  it('freezes explicit request model-selection provenance on a new Agent task', async () => {
    const { conversation, generations, loop, project } = await setup();
    const confirmedAt = '2026-09-07T10:00:00.000Z';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Draft a project brief',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Draft a project brief',
      undefined,
      { operation: 'document.create_draft' },
      'project_only',
      undefined,
      undefined,
      undefined,
      { source: 'request', capability: 'text', confirmedAt },
    );

    expect(taskSnapshot(project, agent.taskId).modelSelection).toEqual({
      version: 1,
      capability: 'text',
      providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
      modelId: '123e4567-e89b-42d3-a456-426614174001',
      source: 'request',
      confirmedAt,
    });
  });

  it('freezes persisted conversation-preference provenance with its confirmation time', async () => {
    const { conversation, generations, loop, project } = await setup();
    const confirmedAt = '2026-09-06T08:30:00.000Z';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Summarize this project',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Summarize this project',
      undefined,
      { operation: 'document.list' },
      'project_only',
      undefined,
      undefined,
      undefined,
      { source: 'conversation-preference', capability: 'text', confirmedAt },
    );

    expect(taskSnapshot(project, agent.taskId).modelSelection).toMatchObject({
      source: 'conversation-preference',
      confirmedAt,
      providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
      modelId: '123e4567-e89b-42d3-a456-426614174001',
    });
  });

  it('merges model-selection provenance into a pre-created novel task snapshot', async () => {
    const { conversation, generations, loop, project } = await setup();
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: '雾港来客' });
    const orchestration = new AgentOrchestrationService(project).prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt: '续写当前章节',
      intent: { action: 'continue_chapter', chapterId: chapter.id },
    });
    if ('pendingIntent' in orchestration) throw new Error('Expected a pre-created novel task.');
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '续写当前章节',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const confirmedAt = '2026-09-07T11:00:00.000Z';

    loop.prepare(
      prepared.stream,
      '续写当前章节',
      chapter.title,
      orchestration.documentIntent,
      'project_only',
      orchestration.taskId,
      undefined,
      undefined,
      { source: 'request', capability: 'text', confirmedAt },
    );

    expect(taskSnapshot(project, orchestration.taskId)).toMatchObject({
      version: 1,
      agentMode: 'novel-writing',
      action: 'continue_chapter',
      chapterId: chapter.id,
      documentId: chapter.documentId,
      modelSelection: {
        version: 1,
        source: 'request',
        capability: 'text',
        confirmedAt,
      },
    });
  });

  it('rejects conflicting provenance after an Agent task model selection is frozen', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Draft a project brief',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const confirmedAt = '2026-09-07T12:00:00.000Z';
    const agent = loop.prepare(
      prepared.stream,
      'Draft a project brief',
      undefined,
      { operation: 'document.create_draft' },
      'project_only',
      undefined,
      undefined,
      undefined,
      { source: 'request', capability: 'text', confirmedAt },
    );

    expect(() =>
      loop.prepare(
        prepared.stream,
        'Draft a project brief',
        undefined,
        { operation: 'document.create_draft' },
        'project_only',
        undefined,
        undefined,
        undefined,
        { source: 'conversation-preference', capability: 'text', confirmedAt },
      ),
    ).toThrow('Agent task model-selection provenance is already frozen.');
    expect(taskSnapshot(project, agent.taskId).modelSelection).toMatchObject({
      source: 'request',
      confirmedAt,
    });
  });

  it('authorizes the novel chapter draft tool only for an exact chapter document target', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: '雾港来客' });
    const seeded = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '旧稿。',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '续写当前章节',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '续写当前章节',
      '续写',
      { operation: 'novel.chapter.submit_draft', documentId: chapter.documentId },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'novel.chapter.submit_draft',
      'library.search',
      'library.read',
    ]);
    loop.startProviderStep(prepared.stream);
    const tool = agent.tools[0]!;
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_novel',
      calls: [
        {
          id: 'call_novel',
          name: 'novel.chapter.submit_draft',
          authorizationHandle: tool.authorizationHandle,
          argumentsJson: JSON.stringify({ title: '雾港来客', contentMarkdown: '新稿。' }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('novel_draft_submitted');
    expect(result.confirmation).toBeUndefined();
    expect(workflow.getDocument(chapter.documentId).currentVersion?.contentMarkdown).toBe('新稿。');
    expect(seeded.currentVersion?.contentMarkdown).toBe('旧稿。');
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'requires and saves the first chapter draft through %s',
    async (protocol) => {
      const { conversation, generations, loop, project, workflow, novels } = await setup(protocol);
      const prompt = '写小说第一章《意外重逢》';
      const orchestration = new AgentOrchestrationService(project);
      const target = orchestration.prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action: 'create_chapter', chapterTitle: '意外重逢' },
      });
      if ('pendingIntent' in target) throw new Error('Expected a reserved chapter.');
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(
        prepared.stream,
        prompt,
        undefined,
        target.documentIntent,
        'project_only',
        target.taskId,
      );
      generations.configureAgentTools(prepared.stream, agent.tools);
      expect(taskSnapshot(project, target.taskId)).toMatchObject({
        primaryOperation: 'novel.chapter.submit_draft',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        toolManifest: expect.arrayContaining([
          expect.objectContaining({ operation: 'novel.chapter.submit_draft' }),
          expect.objectContaining({ operation: 'library.search' }),
          expect.objectContaining({ operation: 'library.read' }),
        ]),
      });
      const runtime = generations.runtime(prepared.stream);
      expect(runtime.systemInstruction).toContain('# Agent novel chapter write policy');
      expect(runtime.systemInstruction).toContain('novel.chapter.submit_draft 保存完整正文');
      expect(runtime.systemInstruction).toContain('无需再次询问是否保存或请求二次授权');
      expect(runtime.systemInstruction).toContain('后续章节由独立任务生成');
      expect(runtime.systemInstruction).toContain('不得要求用户通过聊天重新授权来修复内部授权');
      expect(runtime.systemInstruction).not.toContain('# Agent document write policy');
      expect(
        project.access(false, (database) =>
          database
            .prepare('SELECT user_message_id, context_snapshot_id FROM agent_tasks WHERE id = ?')
            .get(target.taskId),
        ),
      ).toEqual({
        user_message_id: prepared.generation.userMessage.id,
        context_snapshot_id: prepared.generation.snapshotId,
      });
      loop.startProviderStep(prepared.stream);
      expect(() => loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' })).toThrow(
        'AGENT_CHAPTER_NOT_WRITTEN',
      );
      const tool = agent.tools.find((item) => item.name === 'novel.chapter.submit_draft')!;
      await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'chapter-write',
        calls: [
          {
            id: 'chapter-write-call',
            name: tool.name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: '意外重逢',
              contentMarkdown: '苏念推开咖啡馆的门。',
            }),
          },
        ],
      });
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
      const document = workflow.getDocument(target.documentId);
      expect(document.currentVersion?.contentMarkdown).toBe('苏念推开咖啡馆的门。');
      expect(document.currentVersion?.baseVersionId).toBeUndefined();
      expect(novels.listChapters()).toMatchObject([
        { id: target.chapterId, lifecycleStatus: 'active' },
      ]);
      expect(workflow.getTask({ taskId: target.taskId })).toMatchObject({
        task: { status: 'waiting_review' },
        target: { chapterId: target.chapterId, documentVersionId: document.currentVersion?.id },
      });
      expect(
        project.access(false, (database) =>
          database
            .prepare('SELECT COUNT(*) AS count FROM novel_rag_chunks WHERE chapter_id = ?')
            .get(target.chapterId),
        ),
      ).toMatchObject({ count: 1 });
    },
  );

  it.each(['continue_chapter', 'rewrite_chapter'] as const)(
    'does not count an existing draft as the result of a %s task',
    async (action) => {
      const { conversation, generations, loop, project, workflow, novels } = await setup();
      const chapter = novels.saveChapter({ title: '意外重逢' });
      workflow.saveDraft({
        documentId: chapter.documentId,
        title: chapter.title,
        contentMarkdown: '已有正文。',
        expectedDocumentRowVersion: chapter.documentRowVersion,
      });
      const prompt = action === 'continue_chapter' ? '续写本章' : '重写本章';
      const target = new AgentOrchestrationService(project).prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action, chapterId: chapter.id },
      });
      if ('pendingIntent' in target) throw new Error('Expected an existing chapter target.');
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      loop.prepare(
        prepared.stream,
        prompt,
        undefined,
        target.documentIntent,
        'project_only',
        target.taskId,
      );
      loop.startProviderStep(prepared.stream);
      expect(() => loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' })).toThrow(
        'AGENT_CHAPTER_NOT_WRITTEN',
      );
      loop.terminateGeneration(prepared.generation.generationId, 'failed');
      expect(novels.listChapters()).toMatchObject([{ id: chapter.id, lifecycleStatus: 'active' }]);
      expect(workflow.getDocument(chapter.documentId).currentVersion?.contentMarkdown).toBe(
        '已有正文。',
      );
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'saves a numbered second chapter with a model-supplied title through %s',
    async (protocol) => {
      const { conversation, generations, loop, project, workflow, novels } = await setup(protocol);
      const firstChapter = novels.saveChapter({ title: '意外重逢', displayLabel: '第一章' });
      const firstDraft = workflow.saveDraft({
        documentId: firstChapter.documentId,
        title: firstChapter.title,
        contentMarkdown: '苏念答应与沈逸见面。',
        expectedDocumentRowVersion: firstChapter.documentRowVersion,
      });
      const prompt = '帮我生成第二章';
      const target = new AgentOrchestrationService(project).prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action: 'create_chapter', displayLabel: '第二章' },
      });
      if ('pendingIntent' in target) throw new Error('Numbered chapter request should start.');
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(
        prepared.stream,
        prompt,
        undefined,
        target.documentIntent,
        'project_only',
        target.taskId,
      );
      generations.configureAgentTools(prepared.stream, agent.tools);
      expect(generations.runtime(prepared.stream).systemInstruction).toContain(
        '根据正文拟定正式章名',
      );
      loop.startProviderStep(prepared.stream);
      const tool = agent.tools.find((item) => item.name === 'novel.chapter.submit_draft')!;
      await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'second-chapter-write',
        calls: [
          {
            id: 'second-chapter-call',
            name: tool.name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: '旧约重逢',
              contentMarkdown: '沈逸已经在约定的街口等她。',
            }),
          },
        ],
      });
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
      expect(novels.listChapters()).toMatchObject([
        { id: firstChapter.id, title: '意外重逢', displayLabel: '第一章' },
        {
          id: target.chapterId,
          title: '旧约重逢',
          displayLabel: '第二章',
          lifecycleStatus: 'active',
        },
      ]);
      expect(workflow.getDocument(target.documentId).currentVersion?.titleSnapshot).toBe(
        '旧约重逢',
      );
      expect(workflow.getDocument(target.documentId).currentVersion?.contentMarkdown).toBe(
        '沈逸已经在约定的街口等她。',
      );
      expect(workflow.getDocument(firstChapter.documentId).currentVersion?.id).toBe(
        firstDraft.currentVersion?.id,
      );
      expect(workflow.getTask({ taskId: target.taskId }).target).toMatchObject({
        chapterId: target.chapterId,
        documentId: target.documentId,
      });
    },
  );

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'archives an empty reserved chapter after generation is %s',
    async (reason) => {
      const { conversation, generations, loop, project, workflow, novels } = await setup();
      const prompt = '写小说第一章《意外重逢》';
      const target = new AgentOrchestrationService(project).prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action: 'create_chapter', chapterTitle: '意外重逢' },
      });
      if ('pendingIntent' in target) throw new Error('Expected a reserved chapter.');
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      loop.prepare(
        prepared.stream,
        prompt,
        undefined,
        target.documentIntent,
        'project_only',
        target.taskId,
      );
      loop.terminateGeneration(prepared.generation.generationId, reason);
      expect(novels.listChapters()).toEqual([]);
      expect(novels.listChapters({ includeArchived: true })).toMatchObject([
        {
          id: target.chapterId,
          lifecycleStatus: 'archived',
          archiveReason: 'generation_placeholder',
        },
      ]);
      expect(workflow.getDocument(target.documentId).lifecycleStatus).toBe('archived');
      expect(
        project.access(false, (database) =>
          database
            .prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks WHERE task_id = ?')
            .get(target.taskId),
        ),
      ).toEqual({ count: 0 });
    },
  );

  it('preserves user edits made after the first chapter write authorization was frozen', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const prompt = '写小说第一章《意外重逢》';
    const target = new AgentOrchestrationService(project).prepareNovelTask({
      conversationId: conversation.id,
      projectSessionId: project.currentSessionId()!,
      prompt,
      intent: { action: 'create_chapter', chapterTitle: '意外重逢' },
    });
    if ('pendingIntent' in target) throw new Error('Expected a reserved chapter.');
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      prompt,
      undefined,
      target.documentIntent,
      'project_only',
      target.taskId,
    );
    workflow.saveDraft({
      documentId: target.documentId,
      title: '用户标题',
      contentMarkdown: '用户正文。',
      expectedDocumentRowVersion: 0,
    });
    loop.startProviderStep(prepared.stream);
    const tool = agent.tools.find((item) => item.name === 'novel.chapter.submit_draft')!;
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'stale-chapter-write',
        calls: [
          {
            id: 'stale-write',
            name: tool.name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify({ title: '模型标题', contentMarkdown: '模型正文。' }),
          },
        ],
      }),
    ).rejects.toThrow('Document was changed in another window.');
    loop.terminateGeneration(prepared.generation.generationId, 'failed');
    expect(workflow.getDocument(target.documentId).currentVersion?.contentMarkdown).toBe(
      '用户正文。',
    );
    expect(workflow.getDocument(target.documentId).lifecycleStatus).toBe('active');
  });

  it.each([true, false])(
    'Pi validates a saved chapter after library lookup (write=%s)',
    async (write) => {
      const { conversation, generations, loop, project, workflow, novels } = await setup();
      workflow.saveDraft({ title: '已有故事设定', contentMarkdown: '苏念在咖啡馆遇见陆屿。' });
      const prompt = '写小说第一章《意外重逢》';
      const target = new AgentOrchestrationService(project).prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action: 'create_chapter', chapterTitle: '意外重逢' },
      });
      if ('pendingIntent' in target) throw new Error('Expected a reserved chapter.');
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(
        prepared.stream,
        prompt,
        undefined,
        target.documentIntent,
        'project_only',
        target.taskId,
      );
      generations.configureAgentTools(prepared.stream, agent.tools);
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('library.search', { query: '已有故事设定' }, { id: 'lookup' })],
          { stopReason: 'toolUse', responseId: 'lookup-response' },
        ),
        ...(write
          ? [
              fauxAssistantMessage(
                [
                  fauxToolCall(
                    'novel.chapter.submit_draft',
                    {
                      title: '意外重逢',
                      contentMarkdown: '苏念推开咖啡馆的门，陆屿抬头看向她。',
                    },
                    { id: 'write' },
                  ),
                ],
                { stopReason: 'toolUse', responseId: 'written' },
              ),
              fauxAssistantMessage('已保存第一章《意外重逢》。'),
            ]
          : [fauxAssistantMessage('已了解背景。你想续写还是重写？')]),
      ]);
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: {} as never,
        providerTools: loop,
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('Unexpected planner');
        },
      });
      await runtime.start({
        ...prepared.stream,
        identity: prepared.stream,
        taskId: target.taskId,
        mode: 'novel-writing',
        prompt,
      });
      await runtime.wait(prepared.stream.generationId);
      const result = generations.get(prepared.stream.generationId);
      expect(result.status).toBe(write ? 'complete' : 'failed');
      expect(novels.listChapters()).toHaveLength(write ? 1 : 0);
      if (write) {
        expect(workflow.getDocument(target.documentId).currentVersion?.contentMarkdown).toContain(
          '苏念推开咖啡馆',
        );
      } else {
        expect(result.error).toContain('AGENT_CHAPTER_NOT_WRITTEN');
        expect(novels.listChapters({ includeArchived: true })).toMatchObject([
          {
            id: target.chapterId,
            lifecycleStatus: 'archived',
            archiveReason: 'generation_placeholder',
          },
        ]);
      }
      expect(
        project.access(false, (database) =>
          database
            .prepare(
              'SELECT tool_name, status FROM agent_tool_calls WHERE task_id = ? ORDER BY created_at',
            )
            .all(target.taskId),
        ),
      ).toEqual(
        write
          ? [
              { tool_name: 'library.search', status: 'succeeded' },
              { tool_name: 'novel.chapter.submit_draft', status: 'succeeded' },
            ]
          : [{ tool_name: 'library.search', status: 'succeeded' }],
      );
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'saves the first chapter with system and media tools enabled through %s',
    async (protocol) => {
      const { conversation, generations, project, workflow, novels, media } = await setupMedia(
        true,
        protocol,
      );
      const loop = createSystemLoop(project, workflow, novels, media);
      const prompt = '现在生成小说第一章';
      workflow.saveDraft({
        title: '《时间典当行》小说大纲',
        contentMarkdown: '拾光斋午夜营业，主角陈拾接待典当时间的客人。',
        kind: 'outline',
      });
      const orchestration = new AgentOrchestrationService(project);
      const target = orchestration.prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt,
        intent: { action: 'create_chapter', displayLabel: '第一章' },
      });
      if ('pendingIntent' in target) throw new Error('Expected a reserved chapter.');
      const prepared = prepareAgentGeneration(
        { generations, loop, orchestration },
        {
          conversationId: conversation.id,
          prompt,
          providerProfileId: 'profile',
          modelId: 'model',
          researchMode: 'project_only',
          agentMode: 'document',
        },
        target,
      );
      expect(generations.runtime(prepared.stream).tools?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'novel.chapter.submit_draft',
          'project.get_context',
          'library.search',
          'media.image.prepare',
          'media.video.prepare',
          'media.generation.submit',
          'media.task.cancel',
        ]),
      );
      expect(taskSnapshot(project, target.taskId).primaryOperation).toBe(
        'novel.chapter.submit_draft',
      );
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('project.get_context', {}, { id: 'context' })], {
          stopReason: 'toolUse',
          responseId: 'context-response',
        }),
        fauxAssistantMessage(
          [fauxToolCall('library.search', { query: '时间典当行' }, { id: 'lookup' })],
          { stopReason: 'toolUse', responseId: 'lookup-response' },
        ),
        fauxAssistantMessage(
          [
            fauxToolCall(
              'novel.chapter.submit_draft',
              { title: '午夜来客', contentMarkdown: '陈拾推开拾光斋的门，午夜的钟声响起。' },
              { id: 'write' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'write-response' },
        ),
        fauxAssistantMessage('第一章《午夜来客》已保存。'),
      ]);
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: new TaskPlanService(project),
        providerTools: loop,
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('Unexpected planner');
        },
      });
      await runtime.start({
        ...prepared.stream,
        identity: prepared.stream,
        taskId: target.taskId,
        mode: 'document',
        prompt,
      });
      await runtime.wait(prepared.stream.generationId);
      expect(generations.get(prepared.stream.generationId).status).toBe('complete');
      expect(workflow.getDocument(target.documentId).currentVersion?.contentMarkdown).toBe(
        '陈拾推开拾光斋的门，午夜的钟声响起。',
      );
      expect(novels.listChapters()).toMatchObject([
        { id: target.chapterId, lifecycleStatus: 'active', title: '午夜来客' },
      ]);
      expect(taskSnapshot(project, target.taskId).primaryOperation).toBe(
        'novel.chapter.submit_draft',
      );
    },
  );

  it.each(['generation', 'manifest', 'configuration'] as const)(
    'cleans chapter placeholders and messages when %s preparation fails',
    async (stage) => {
      const { conversation, generations, loop, project } = await setup();
      const orchestration = new AgentOrchestrationService(project);
      const target = orchestration.prepareNovelTask({
        conversationId: conversation.id,
        projectSessionId: project.currentSessionId()!,
        prompt: '现在生成小说第一章',
        intent: { action: 'create_chapter', displayLabel: '第一章' },
      });
      if ('pendingIntent' in target) throw new Error('Expected a chapter target.');
      const failure = new Error(`${stage} preparation failed`);
      if (stage === 'generation')
        vi.spyOn(generations, 'prepare').mockImplementation(() => {
          throw failure;
        });
      if (stage === 'manifest')
        vi.spyOn(loop, 'prepare').mockImplementation(() => {
          throw failure;
        });
      if (stage === 'configuration')
        vi.spyOn(generations, 'configureAgentTools').mockImplementation(() => {
          throw failure;
        });
      expect(() =>
        prepareAgentGeneration(
          { generations, loop, orchestration },
          {
            conversationId: conversation.id,
            prompt: '现在生成小说第一章',
            providerProfileId: 'profile',
            modelId: 'model',
            agentMode: 'document',
          },
          target,
        ),
      ).toThrow(failure);
      const state = project.access(false, (database) => ({
        task: database.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(target.taskId),
        chapter: database
          .prepare('SELECT lifecycle_status FROM novel_chapters WHERE id = ?')
          .get(target.chapterId),
        document: database
          .prepare('SELECT lifecycle_status FROM documents WHERE id = ?')
          .get(target.documentId),
        locks: database.prepare('SELECT COUNT(*) AS count FROM novel_chapter_task_locks').get(),
        generations: database.prepare('SELECT status FROM llm_generations').all(),
        assistants: database
          .prepare("SELECT status FROM chat_messages WHERE role = 'assistant'")
          .all(),
      }));
      expect(state).toEqual({
        task: { status: 'failed' },
        chapter: { lifecycle_status: 'archived' },
        document: { lifecycle_status: 'archived' },
        locks: { count: 0 },
        generations: stage === 'generation' ? [] : [{ status: 'failed' }],
        assistants: stage === 'generation' ? [] : [{ status: 'failed' }],
      });
    },
  );

  it('fails an ordinary Agent task when tool configuration fails', async () => {
    const { conversation, generations, loop, project } = await setup();
    vi.spyOn(generations, 'configureAgentTools').mockImplementation(() => {
      throw new Error('Configuration failed');
    });
    expect(() =>
      prepareAgentGeneration(
        { generations, loop, orchestration: new AgentOrchestrationService(project) },
        {
          conversationId: conversation.id,
          prompt: '保存项目说明',
          providerProfileId: 'profile',
          modelId: 'model',
          agentMode: 'document',
        },
      ),
    ).toThrow('Configuration failed');
    expect(
      project.access(false, (database) => ({
        tasks: database.prepare('SELECT status FROM agent_tasks').all(),
        generations: database.prepare('SELECT status FROM llm_generations').all(),
        authorizations: database
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_tool_authorizations WHERE status = 'issued'",
          )
          .get(),
      })),
    ).toEqual({
      tasks: [{ status: 'failed' }],
      generations: [{ status: 'failed' }],
      authorizations: { count: 0 },
    });
  });

  it('creates an adaptation proposal from a published chapter without creating drama structure', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: 'Published chapter' });
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: 'Published source content',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    workflow.submitReview({
      documentId: chapter.documentId,
      documentVersionId: draft.currentVersion!.id,
      expectedDocumentRowVersion: draft.rowVersion,
    });
    workflow.publish({
      documentId: chapter.documentId,
      documentVersionId: draft.currentVersion!.id,
      expectedDocumentRowVersion: draft.rowVersion + 1,
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create an adaptation proposal',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Create an adaptation proposal',
      'Adaptation proposal',
      { operation: 'novel.adaptation.submit_proposal', documentId: chapter.documentId },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'novel.adaptation.submit_proposal',
      'library.search',
      'library.read',
    ]);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_adaptation',
      calls: [
        {
          id: 'call_adaptation',
          name: 'novel.adaptation.submit_proposal',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Adaptation proposal',
            contentMarkdown: 'Scene candidates and character beats.',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('adaptation_proposal_submitted');
    const stored = project.access(false, (database) => ({
      proposal: database.prepare('SELECT * FROM novel_adaptation_proposals').get() as Record<
        string,
        unknown
      >,
      binding: database
        .prepare(
          "SELECT role, domain_scope FROM document_bindings WHERE role = 'adaptation-proposal'",
        )
        .get() as Record<string, unknown>,
      scenes: database.prepare('SELECT COUNT(*) AS count FROM scenes').get() as { count: number },
      shots: database.prepare('SELECT COUNT(*) AS count FROM shots').get() as { count: number },
    }));
    expect(stored.proposal.source_chapter_id).toBe(chapter.id);
    expect(typeof stored.proposal.adaptation_task_id).toBe('string');
    expect(stored.binding).toEqual({ role: 'adaptation-proposal', domain_scope: 'short-drama' });
    expect(stored.scenes.count).toBe(0);
    expect(stored.shots.count).toBe(0);
  });

  it('searches and fetches external evidence before creating one document draft', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: (input) =>
        Promise.resolve(
          requestUrl(input).startsWith('https://search.test/')
            ? new Response(
                JSON.stringify({
                  Heading: 'Verified biography',
                  AbstractURL: 'https://source.test/biography',
                  AbstractText: 'A public biographical source.',
                }),
                { headers: { 'content-type': 'application/json' } },
              )
            : new Response('<main><h1>Biography</h1><p>Verified external facts.</p></main>', {
                headers: { 'content-type': 'text/html' },
              }),
        ),
    });
    const { conversation, generations, loop, project, workflow } = await setup(
      'openai-responses',
      research,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a sourced biography.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a sourced biography.');
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'library.search',
      'library.read',
      'research.search',
      'research.fetch',
    ]);
    expect(generations.runtime(prepared.stream).systemInstruction).toContain(
      '# Agent external research policy',
    );
    loop.startProviderStep(prepared.stream);

    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    const searched = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_search',
      calls: [
        {
          id: 'call_search',
          name: 'research.search',
          authorizationHandle: searchTool.authorizationHandle,
          argumentsJson: JSON.stringify({ query: 'verified biography', limit: 3 }),
        },
      ],
    });
    const searchOutput = JSON.parse(searched.continuation!.outputs[0]!.output) as {
      sources: Array<{ sourceHandle: string }>;
    };
    expect(searchOutput.sources).toHaveLength(1);
    generations.configureAgentTools(prepared.stream, searched.tools ?? [], searched.continuation);
    loop.startProviderStep(prepared.stream);

    const fetchTool = searched.tools?.find((tool) => tool.name === 'research.fetch');
    const fetched = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch',
      calls: [
        {
          id: 'call_fetch',
          name: 'research.fetch',
          authorizationHandle: fetchTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            sourceHandle: searchOutput.sources[0]!.sourceHandle,
          }),
        },
      ],
    });
    expect(fetched.continuation?.outputs[0]?.output).toContain('Verified external facts.');
    expect(fetched.continuation?.outputs[0]?.output).toContain('untrusted evidence');
    expect(fetched.continuation?.outputs[0]?.output).toContain('R2');
    generations.configureAgentTools(prepared.stream, fetched.tools ?? [], fetched.continuation);
    loop.startProviderStep(prepared.stream);

    const createTool = fetched.tools?.find((tool) => tool.name === 'document.create_draft');
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'resp_draft_invalid',
        calls: [
          {
            id: 'call_draft_invalid',
            name: 'document.create_draft',
            authorizationHandle: createTool?.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: 'Invalid sourced biography',
              contentMarkdown: '# Invalid\n\nUnknown source [R99]',
            }),
          },
        ],
      }),
    ).rejects.toThrow('RESEARCH_CITATION_INVALID');
    const drafted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_draft',
      calls: [
        {
          id: 'call_draft',
          name: 'document.create_draft',
          authorizationHandle: createTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Sourced biography',
            contentMarkdown:
              '# Sourced biography\n\nVerified external facts. [R2]\n\nSources: https://source.test/biography',
          }),
        },
      ],
    });
    expect(drafted.continuation?.outputs[0]?.output).toContain('draft_created');
    loop.startProviderStep(prepared.stream);
    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_final',
      finishReason: 'completed',
    });

    expect(workflow.listDocuments()).toHaveLength(1);
    project.access(false, (database) => {
      expect(
        database
          .prepare('SELECT status, COUNT(*) AS count FROM agent_research_sources GROUP BY status')
          .all(),
      ).toEqual([
        { status: 'fetched', count: 1 },
        { status: 'searched', count: 1 },
      ]);
      expect(
        database
          .prepare(
            `SELECT adoption_status, adoption_reason, citation_label
             FROM agent_research_sources WHERE status = 'fetched'`,
          )
          .get(),
      ).toMatchObject({ adoption_status: 'adopted', citation_label: 'R2' });
      expect(
        database
          .prepare(
            `SELECT citation_label FROM document_version_research_sources
             WHERE document_version_id = (SELECT current_version_id FROM documents LIMIT 1)`,
          )
          .get(),
      ).toEqual({ citation_label: 'R2' });
      const cache = database
        .prepare('SELECT byte_count, status FROM agent_research_cache')
        .get() as { byte_count: number; status: string };
      expect(cache.status).toBe('present');
      expect(cache.byte_count).toBeGreaterThan(0);
      const summaries = database
        .prepare(
          `SELECT arguments_summary_json, result_summary_json FROM agent_tool_calls
           WHERE tool_name LIKE 'research.%' ORDER BY tool_ordinal`,
        )
        .all() as Array<{ arguments_summary_json: string; result_summary_json: string }>;
      expect(JSON.stringify(summaries)).not.toContain('verified biography');
      expect(JSON.stringify(summaries)).not.toContain('Verified external facts.');
    });
  });

  it('executes parallel read-only searches under one step authorization', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: (input) => {
        const query = new URL(requestUrl(input)).searchParams.get('q') ?? 'source';
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Heading: query,
              AbstractURL: `https://source.test/${encodeURIComponent(query)}`,
              AbstractText: `Result for ${query}`,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    const { conversation, generations, loop, project } = await setup(
      'openai-chat-completions',
      research,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Compare two factual sources.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Compare two factual sources.');
    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    loop.startProviderStep(prepared.stream);

    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'chatcmpl_parallel_search',
      calls: ['alpha', 'beta'].map((query, index) => ({
        id: `call_search_${index}`,
        name: 'research.search',
        authorizationHandle: searchTool.authorizationHandle,
        argumentsJson: JSON.stringify({ query }),
      })),
    });

    expect(result.continuation?.outputs).toHaveLength(2);
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'library.search',
      'library.read',
      'research.search',
      'research.fetch',
    ]);
    project.access(false, (database) => {
      expect(
        database
          .prepare(
            `SELECT used_call_count FROM agent_tool_authorizations
             WHERE provider_step_id = (SELECT id FROM llm_provider_steps WHERE ordinal = 0)
               AND allowed_operation = 'research.search'`,
          )
          .get(),
      ).toEqual({ used_call_count: 2 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_tool_calls WHERE tool_name = 'research.search'",
          )
          .get(),
      ).toEqual({ count: 2 });
    });
  });

  it('reuses the same library authorization across sequential Provider tool calls', async () => {
    const { conversation, generations, loop, project } = await setup();
    new ContentService(project).saveDocument({
      kind: 'character',
      title: 'City gate hero',
      contentMarkdown: 'The hero waits at the city gate before dawn.',
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Find the city gate draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Find the city gate draft.');
    const searchTool = agent.tools.find((tool) => tool.name === 'library.search')!;
    const readTool = agent.tools.find((tool) => tool.name === 'library.read')!;
    loop.startProviderStep(prepared.stream);

    const first = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_library_search_1',
      calls: [
        {
          id: 'call_library_search_1',
          name: 'library.search',
          authorizationHandle: searchTool.authorizationHandle,
          argumentsJson: JSON.stringify({ query: 'city gate' }),
        },
      ],
    });
    const firstOutput = JSON.parse(first.continuation!.outputs[0]!.output) as {
      status: string;
      sources: Array<{ sourceHandle: string; title: string }>;
    };
    expect(firstOutput.status).not.toBe('failed');
    expect(firstOutput.sources[0]?.title).toBe('City gate hero');
    expect(first.tools?.find((tool) => tool.name === 'library.search')?.authorizationHandle).toBe(
      searchTool.authorizationHandle,
    );

    const second = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_library_search_2',
      calls: [
        {
          id: 'call_library_search_2',
          name: 'library.search',
          authorizationHandle: searchTool.authorizationHandle,
          argumentsJson: JSON.stringify({ query: 'city gate' }),
        },
      ],
    });
    const secondOutput = JSON.parse(second.continuation!.outputs[0]!.output) as {
      status: string;
      errorCode?: string;
      sources: Array<{ title: string }>;
    };
    expect(secondOutput.status).toBe('searched');
    expect(secondOutput.errorCode).toBeUndefined();
    expect(secondOutput.sources.map((source) => source.title)).toContain('City gate hero');

    const read = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_library_read',
      calls: [
        {
          id: 'call_library_read',
          name: 'library.read',
          authorizationHandle: readTool.authorizationHandle,
          argumentsJson: JSON.stringify({
            sourceHandle: firstOutput.sources[0]!.sourceHandle,
          }),
        },
      ],
    });
    expect(read.continuation!.outputs[0]!.output).toContain('city gate');
    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_provider_steps').get()).toEqual({
        count: 1,
      });
      expect(
        database
          .prepare(
            `SELECT status FROM llm_provider_steps WHERE status IN ('prepared', 'in_flight')`,
          )
          .get(),
      ).toEqual({ status: 'in_flight' });
      expect(
        database
          .prepare(
            `SELECT used_call_count FROM agent_tool_authorizations
             WHERE allowed_operation = 'library.search'`,
          )
          .get(),
      ).toEqual({ used_call_count: 2 });
    });
  });

  it('reuses the same research authorization across sequential Provider tool calls', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              Heading: 'Sequential source',
              AbstractURL: 'https://source.test/sequential',
              AbstractText: 'Sequential evidence.',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    const { conversation, generations, loop, project } = await setup('openai-responses', research);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Look up sequential evidence.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Look up sequential evidence.');
    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    loop.startProviderStep(prepared.stream);

    const first = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_research_search_1',
      calls: [
        {
          id: 'call_research_search_1',
          name: 'research.search',
          authorizationHandle: searchTool.authorizationHandle,
          argumentsJson: JSON.stringify({ query: 'sequential evidence', limit: 3 }),
        },
      ],
    });
    expect(
      (JSON.parse(first.continuation!.outputs[0]!.output) as { sources: unknown[] }).sources,
    ).toHaveLength(1);

    const second = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_research_search_2',
      calls: [
        {
          id: 'call_research_search_2',
          name: 'research.search',
          authorizationHandle: searchTool.authorizationHandle,
          argumentsJson: JSON.stringify({ query: 'sequential evidence', limit: 3 }),
        },
      ],
    });
    expect(
      (JSON.parse(second.continuation!.outputs[0]!.output) as { sources: unknown[] }).sources,
    ).toHaveLength(1);
    expect(second.tools?.find((tool) => tool.name === 'research.fetch')?.authorizationHandle).toBe(
      agent.tools.find((tool) => tool.name === 'research.fetch')?.authorizationHandle,
    );
    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_provider_steps').get()).toEqual({
        count: 1,
      });
    });
  });

  it('preserves the document call after research budget exhaustion', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        if (url.hostname === 'search.test') {
          const query = url.searchParams.get('q') ?? 'source';
          return Promise.resolve(
            new Response(
              JSON.stringify({
                Results: Array.from({ length: 3 }, (_, index) => ({
                  FirstURL: `https://source.test/${encodeURIComponent(query)}/${index}`,
                  Text: `${query} source ${index}`,
                })),
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(
          new Response(`<main><p>Fetched evidence from ${url.pathname}.</p></main>`, {
            headers: { 'content-type': 'text/html' },
          }),
        );
      },
    });
    const { conversation, generations, loop, project, workflow } = await setup(
      'openai-chat-completions',
      research,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Research several sources and create one cited draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Research several sources and create one draft.');
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT tool_call_limit, tool_call_count FROM agent_tasks WHERE id = ?')
          .get(agent.taskId),
      ),
    ).toEqual({ tool_call_limit: 16, tool_call_count: 0 });

    loop.startProviderStep(prepared.stream);
    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    const searched = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_search_budget',
      calls: ['alpha evidence', 'beta evidence', 'gamma evidence'].map((query, index) => ({
        id: `call_search_budget_${index}`,
        name: 'research.search',
        authorizationHandle: searchTool.authorizationHandle,
        argumentsJson: JSON.stringify({ query, limit: 3 }),
      })),
    });
    const sourceHandles = searched.continuation!.outputs.flatMap((output) => {
      const parsed = JSON.parse(output.output) as {
        sources: Array<{ sourceHandle: string }>;
      };
      return parsed.sources.map((source) => source.sourceHandle);
    });
    expect(sourceHandles).toHaveLength(9);
    expect(searched.tools?.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'library.search',
      'library.read',
      'research.fetch',
    ]);

    loop.startProviderStep(prepared.stream);
    const firstFetchTool = searched.tools?.find((tool) => tool.name === 'research.fetch');
    const firstFetch = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch_budget_1',
      calls: sourceHandles.slice(0, 2).map((sourceHandle, index) => ({
        id: `call_fetch_budget_first_${index}`,
        name: 'research.fetch',
        authorizationHandle: firstFetchTool?.authorizationHandle,
        argumentsJson: JSON.stringify({ sourceHandle }),
      })),
    });
    expect(firstFetch.continuation?.outputs).toHaveLength(2);
    expect(firstFetch.continuation?.outputs[0]?.output).toContain('Prefer creating');

    loop.startProviderStep(prepared.stream);
    const finalFetchTool = firstFetch.tools?.find((tool) => tool.name === 'research.fetch');
    const exhausted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch_budget_2',
      calls: Array.from({ length: 8 }, (_, index) => ({
        id: `call_fetch_budget_final_${index}`,
        name: 'research.fetch',
        authorizationHandle: finalFetchTool?.authorizationHandle,
        argumentsJson: JSON.stringify({
          sourceHandle: sourceHandles[(index + 2) % sourceHandles.length],
        }),
      })),
    });
    const finalFetchOutputs = exhausted.continuation!.outputs.map((output) => {
      return JSON.parse(output.output) as { status: string; errorCode?: string };
    });
    expect(finalFetchOutputs.filter((output) => output.status === 'fetched')).toHaveLength(6);
    expect(
      finalFetchOutputs.filter(
        (output) => output.status === 'failed' && output.errorCode === 'RESEARCH_BUDGET_EXCEEDED',
      ),
    ).toHaveLength(2);
    expect(exhausted.tools?.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'library.search',
      'library.read',
    ]);

    loop.startProviderStep(prepared.stream);
    const createTool = exhausted.tools?.[0];
    const drafted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_draft_after_budget',
      calls: [
        {
          id: 'call_draft_after_budget',
          name: 'document.create_draft',
          authorizationHandle: createTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Research budget draft',
            contentMarkdown:
              '# Research budget draft\n\nFetched evidence.\n\nSource: https://source.test/alpha%20evidence/0',
          }),
        },
      ],
    });
    expect(drafted.continuation?.outputs[0]?.output).toContain('draft_created');
    loop.startProviderStep(prepared.stream);
    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_final_after_budget',
      finishReason: 'completed',
    });

    const documents = workflow.listDocuments();
    expect(documents).toHaveLength(1);
    expect(workflow.getDocument(documents[0]!.id).currentVersion?.contentMarkdown).toContain(
      'https://source.test/',
    );
    project.access(false, (database) => {
      expect(
        database
          .prepare('SELECT status, phase, tool_call_limit, tool_call_count FROM agent_tasks')
          .get(),
      ).toEqual({
        status: 'waiting_review',
        phase: 'waiting_review',
        tool_call_limit: 16,
        tool_call_count: 12,
      });
      expect(
        database
          .prepare(
            `SELECT tool_name, error_code FROM agent_tool_calls
             ORDER BY provider_step_id, tool_ordinal`,
          )
          .all()
          .filter((row) => (row as { error_code: string | null }).error_code),
      ).toEqual([
        { tool_name: 'research.fetch', error_code: 'RESEARCH_BUDGET_EXCEEDED' },
        { tool_name: 'research.fetch', error_code: 'RESEARCH_BUDGET_EXCEEDED' },
      ]);
    });
  });

  it('does not authorize research tools in project-only mode', async () => {
    const { conversation, generations, loop } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Use project evidence only.',
      providerProfileId: 'profile',
      modelId: 'model',
    });

    const agent = loop.prepare(
      prepared.stream,
      'Use project evidence only.',
      undefined,
      { operation: 'document.create_draft' },
      'project_only',
    );

    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'library.search',
      'library.read',
    ]);
  });

  it('persists authorization, executes a restricted draft tool, and prepares continuation', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a production brief.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a production brief.', 'Production brief');
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(generations.runtime(prepared.stream).tools?.[0]?.name).toBe('document.create_draft');
    loop.startProviderStep(prepared.stream);

    const executed = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_tool',
      calls: [
        {
          id: 'call_1',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Production brief',
            contentMarkdown: '# Production brief\n\nApproved facts only.',
          }),
        },
      ],
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    generations.configureAgentTools(prepared.stream, [], executed.continuation);
    expect(generations.runtime(prepared.stream).continuation).toEqual(
      expect.objectContaining({
        protocol: 'openai-responses',
        previousResponseId: 'resp_tool',
      }),
    );
    loop.startProviderStep(prepared.stream);

    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_final',
      finishReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });

    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_provider_steps').get()).toEqual({
        count: 2,
      });
      expect(
        database
          .prepare(
            `SELECT status, tool_call_count, total_tokens,
                    continuation_manifest_json IS NOT NULL AS has_continuation
             FROM llm_provider_steps ORDER BY ordinal`,
          )
          .all(),
      ).toEqual([
        { status: 'complete', tool_call_count: 1, total_tokens: 10, has_continuation: 1 },
        { status: 'complete', tool_call_count: 0, total_tokens: 14, has_continuation: 0 },
      ]);
      expect(database.prepare('SELECT status FROM agent_tool_calls').get()).toEqual({
        status: 'succeeded',
      });
      expect(database.prepare('SELECT status, phase FROM agent_tasks').get()).toEqual({
        status: 'waiting_review',
        phase: 'waiting_review',
      });
      expect(
        database
          .prepare(
            `SELECT versions.content_markdown, versions.source_task_id
             FROM document_versions versions
             INNER JOIN agent_task_document_artifacts artifacts
               ON artifacts.document_version_id = versions.id`,
          )
          .get(),
      ).toMatchObject({
        content_markdown: '# Production brief\n\nApproved facts only.',
        source_task_id: agent.taskId,
      });
    });
    expect(workflow.getTask({ taskId: agent.taskId }).providerSteps).toEqual([
      expect.objectContaining({
        ordinal: 0,
        protocol: 'openai-responses',
        status: 'complete',
        toolCallCount: 1,
        finishReason: 'tool_calls',
        totalTokens: 10,
      }),
      expect.objectContaining({
        ordinal: 1,
        protocol: 'openai-responses',
        status: 'complete',
        toolCallCount: 0,
        finishReason: 'completed',
        totalTokens: 14,
      }),
    ]);
  });

  it('stores a novel reference only from the model supplied binding role', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成小说大纲',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '生成小说大纲');
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'novel-outline-response',
      calls: [
        {
          id: 'novel-outline-call',
          name: 'document.submit_draft',
          authorizationHandle: agent.tools.find((tool) => tool.name === 'document.submit_draft')
            ?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '都市小说大纲',
            documentKind: 'outline',
            bindingRole: 'work-outline',
            contentMarkdown: '# 都市小说大纲\n\n- 第一幕：相遇',
          }),
        },
      ],
    });
    project.access(false, (database) => {
      expect(database.prepare('SELECT domain_scope, role FROM document_bindings').get()).toEqual({
        domain_scope: 'novel',
        role: 'work-outline',
      });
      expect(database.prepare('SELECT kind FROM documents').get()).toEqual({ kind: 'outline' });
    });
  });

  it('prepares a Chat Completions tool-message continuation without the authorization handle', async () => {
    const { conversation, generations, loop } = await setup('openai-chat-completions');
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a production brief.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a production brief.', 'Production brief');
    const call = {
      id: 'call_chat_1',
      name: 'document.create_draft',
      authorizationHandle: agent.tools[0]?.authorizationHandle,
      argumentsJson: JSON.stringify({
        title: 'Production brief',
        contentMarkdown: '# Production brief',
      }),
    };
    const executed = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'chatcmpl_tool',
      calls: [call],
    });

    expect(executed.continuation).toEqual({
      protocol: 'openai-chat-completions',
      providerResponseId: 'chatcmpl_tool',
      calls: [
        {
          id: call.id,
          name: call.name,
          argumentsJson: call.argumentsJson,
        },
      ],
      outputs: [
        expect.objectContaining({
          callId: call.id,
        }),
      ],
    });
    expect(JSON.stringify(executed.continuation)).not.toContain(
      agent.tools[0]?.authorizationHandle,
    );
  });

  it('rejects extra tool fields before consuming authorization or writing a document', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a draft.');

    const corrected = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_tool',
      calls: [
        {
          id: 'call_1',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Draft',
            contentMarkdown: '# Draft',
            projectId: 'forged-project',
          }),
        },
      ],
    });
    expect(corrected.continuation?.outputs[0]?.output).toContain('unsupported fields');

    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'resp_tool',
        calls: [
          {
            id: 'call_2',
            name: 'document.create_draft',
            authorizationHandle: 'forged-handle',
            argumentsJson: JSON.stringify({ title: 'Draft', contentMarkdown: '# Draft' }),
          },
        ],
      }),
    ).rejects.toThrow('not authorized');

    project.access(false, (database) => {
      expect(
        database.prepare('SELECT used_call_count FROM agent_tool_authorizations').get(),
      ).toEqual({
        used_call_count: 0,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({
        count: 0,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM agent_tool_calls').get()).toEqual({
        count: 0,
      });
    });
    expect(policyRejectionCodes(project, agent.taskId)).toEqual(['AGENT_TOOL_UNAUTHORIZED']);
  });

  it('reads only the Worker-authorized document without persisting its body as evidence', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const document = workflow.saveDraft({
      title: 'Authorized',
      contentMarkdown: '# Internal body',
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Read the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Read the selected document.', undefined, {
      operation: 'document.read',
      documentId: document.id,
    });

    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_read',
      calls: [
        {
          id: 'call_read',
          name: 'document.read',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('# Internal body');
    project.access(false, (database) => {
      const row = database
        .prepare(
          'SELECT result_summary_json, continuation_manifest_json FROM agent_tool_calls, llm_provider_steps WHERE agent_tool_calls.provider_step_id = llm_provider_steps.id',
        )
        .get() as { result_summary_json: string; continuation_manifest_json: string };
      expect(row.result_summary_json).not.toContain('Internal body');
      expect(row.continuation_manifest_json).not.toContain('Internal body');
    });
  });

  it('truncates a large document result below 64 KiB without breaking UTF-8', async () => {
    const { conversation, generations, loop, workflow } = await setup();
    const contentMarkdown = `# Large\n\n${'"界\\'.repeat(30_000)}`;
    const document = workflow.saveDraft({ title: 'Large', contentMarkdown });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Read the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Read the selected document.', undefined, {
      operation: 'document.read',
      documentId: document.id,
    });
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'large-read-response',
      calls: [
        {
          id: 'large-read-call',
          name: 'document.read',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    const output = result.continuation!.outputs[0]!.output;
    const parsed = JSON.parse(output) as {
      contentMarkdown: string;
      truncated: boolean;
      originalTextBytes: number;
    };
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
      AGENT_TOOL_RESULT_LIMITS.maxJsonBytes,
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.originalTextBytes).toBe(Buffer.byteLength(contentMarkdown, 'utf8'));
    expect(parsed.contentMarkdown).not.toContain('\uFFFD');
  });

  it('updates only the frozen document target and base version', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const target = workflow.saveDraft({ title: 'Target', contentMarkdown: '# Before' });
    const other = workflow.saveDraft({ title: 'Other', contentMarkdown: '# Other' });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Update the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Update the selected document.', undefined, {
      operation: 'document.update_draft',
      documentId: target.id,
    });
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_update',
      calls: [
        {
          id: 'call_update',
          name: 'document.update_draft',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: JSON.stringify({ title: 'Target revised', contentMarkdown: '# After' }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('draft_updated');
    expect(workflow.getDocument(target.id).currentVersion?.contentMarkdown).toBe('# After');
    expect(workflow.getDocument(other.id).currentVersion?.contentMarkdown).toBe('# Other');
    project.access(false, (database) => {
      expect(
        database.prepare('SELECT target_document_id FROM agent_tool_authorizations').get(),
      ).toEqual({
        target_document_id: target.id,
      });
    });
  });

  it('requires one-time confirmation before archiving a document', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const document = workflow.saveDraft({ title: 'Archive me', contentMarkdown: '# Draft' });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Archive the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Archive the selected document.', undefined, {
      operation: 'document.archive',
      documentId: document.id,
    });
    const pending = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_archive',
      calls: [
        {
          id: 'call_archive',
          name: 'document.archive',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expect(pending.confirmation?.documentId).toBe(document.id);
    expect(workflow.getTask({ taskId: agent.taskId }).pendingConfirmation).toMatchObject({
      action: 'document.archive',
      documentId: document.id,
      documentTitle: 'Archive me',
      status: 'pending',
    });
    expect(workflow.getDocument(document.id).lifecycleStatus).toBe('active');
    const confirmed = loop.confirmTool({
      ...prepared.stream,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(confirmed.continuation?.outputs[0]?.output).toContain('archived');
    expect(confirmed.tools?.map((tool) => tool.name)).toEqual([
      'document.archive',
      'library.search',
      'library.read',
      'research.search',
      'research.fetch',
    ]);
    expect(workflow.getDocument(document.id).lifecycleStatus).toBe('archived');
    expect(workflow.getTask({ taskId: agent.taskId }).pendingConfirmation).toBeUndefined();
    expect(() =>
      loop.confirmTool({
        ...prepared.stream,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).toThrow('AGENT_TOOL_CONFIRMATION_REPLAYED');
    project.access(false, (database) => {
      expect(database.prepare('SELECT status FROM agent_tool_calls').get()).toEqual({
        status: 'succeeded',
      });
    });
    expect(policyRejectionCodes(project, agent.taskId)).toEqual([
      'AGENT_TOOL_CONFIRMATION_REPLAYED',
    ]);
  });

  it('rejects expired and revoked step-local handles before any side effect', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const first = loop.prepare(prepared.stream, 'Create a draft.');
    project.access(true, (database) => {
      database
        .prepare("UPDATE agent_tool_authorizations SET expires_at = '2000-01-01T00:00:00.000Z'")
        .run();
    });
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'expired',
        calls: [
          {
            id: 'expired_call',
            name: 'document.create_draft',
            authorizationHandle: first.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Nope', contentMarkdown: '# Nope' }),
          },
        ],
      }),
    ).rejects.toThrow('not authorized');

    const second = loop.prepare(prepared.stream, 'Create a draft.');
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'revoked',
        calls: [
          {
            id: 'revoked_call',
            name: 'document.create_draft',
            authorizationHandle: first.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Nope', contentMarkdown: '# Nope' }),
          },
        ],
      }),
    ).rejects.toThrow('AGENT_TOOL_AUTHORIZATION_REPLAYED');
    expect(second.tools[0]?.authorizationHandle).not.toBe(first.tools[0]?.authorizationHandle);
    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({
        count: 0,
      });
    });
    expect(policyRejectionCodes(project, second.taskId)).toEqual([
      'AGENT_TOOL_AUTHORIZATION_EXPIRED',
      'AGENT_TOOL_AUTHORIZATION_REPLAYED',
    ]);
  });

  it('blocks a late tool callback after cancellation and revokes its execution envelope', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a draft.');
    await generations.cancel(prepared.stream.generationId);

    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'late-response',
        calls: [
          {
            id: 'late-call',
            name: 'document.create_draft',
            authorizationHandle: agent.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Late', contentMarkdown: '# Late' }),
          },
        ],
      }),
    ).rejects.toThrow('no longer active');

    expect(loop.terminateGeneration(prepared.stream.generationId, 'cancelled')).toBe(1);
    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({
        count: 0,
      });
      expect(database.prepare('SELECT status FROM agent_tasks').get()).toEqual({
        status: 'cancelled',
      });
      expect(database.prepare('SELECT status FROM agent_tool_authorizations').get()).toEqual({
        status: 'revoked',
      });
      expect(database.prepare('SELECT status FROM llm_provider_steps').get()).toEqual({
        status: 'interrupted',
      });
    });
  });

  it('creates an episode overview draft with a short-drama screenplay binding', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '把前三章做成一集，生成本集整体把控',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '把前三章做成一集，生成本集整体把控',
      '第1集整体把控',
      { operation: 'novel.episode.submit_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'novel.episode.submit_draft',
      'library.search',
      'library.read',
    ]);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_episode_draft',
      calls: [
        {
          id: 'call_episode_draft',
          name: 'novel.episode.submit_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '第1集 · 第一卷 第1–3章 整体把控',
            contentMarkdown: '# 第1集整体把控\n\n- 集范围：第一卷 第1–3章',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('episode_draft_submitted');
    const parsed = JSON.parse(result.continuation!.outputs[0]!.output) as { documentId: string };
    const document = workflow.getDocument(parsed.documentId);
    expect(document.kind).toBe('plan');
    expect(document.title).toContain('第1集');
    const novel = new NovelService(project);
    expect(novel.listBindings()).toMatchObject([
      { documentId: parsed.documentId, role: 'screenplay', domainScope: 'short-drama' },
    ]);
  });

  it('turns an episode structure into a reviewable change set with shot prompts', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const character = workflow.saveDraft({
      kind: 'character',
      title: '角色提示词',
      contentMarkdown: '# 林澈\n24 岁，灯塔守望员。',
    });
    workflow.submitReview({
      documentId: character.id,
      documentVersionId: character.currentVersion!.id,
      expectedDocumentRowVersion: character.rowVersion,
    });
    workflow.publish({
      documentId: character.id,
      documentVersionId: character.currentVersion!.id,
      expectedDocumentRowVersion: character.rowVersion + 1,
    });
    const sceneDoc = workflow.saveDraft({
      kind: 'scene',
      title: '场景提示词',
      contentMarkdown: '# 旧码头\n海雾低垂的旧码头。',
    });
    workflow.submitReview({
      documentId: sceneDoc.id,
      documentVersionId: sceneDoc.currentVersion!.id,
      expectedDocumentRowVersion: sceneDoc.rowVersion,
    });
    workflow.publish({
      documentId: sceneDoc.id,
      documentVersionId: sceneDoc.currentVersion!.id,
      expectedDocumentRowVersion: sceneDoc.rowVersion + 1,
    });

    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成本集的场次和镜头提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成本集的场次和镜头提示词',
      '第1集场次与镜头',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'novel.episode.submit_structure',
      'library.search',
      'library.read',
    ]);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_structure',
      calls: [
        {
          id: 'call_structure',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            episodeTitle: '第1集 · 来信',
            scenes: [
              {
                title: '旧码头 · 台风前夜',
                shots: [
                  {
                    title: '海雾中的码头',
                    prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
                  },
                ],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'episode_structure_change_set_created',
    );
    const changeSets = new ChangeSetService(project);
    const proposed = changeSets.list({ includeTerminal: false });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.items).toMatchObject([
      { entityType: 'scene', title: '旧码头 · 台风前夜' },
      {
        entityType: 'shot',
        title: '海雾中的码头',
        prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
      },
    ]);
    const applied = changeSets.apply({
      changeSetId: proposed[0]!.id,
      expectedRowVersion: proposed[0]!.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const content = new ContentService(project);
    const scene = content.listScenes()[0]!;
    expect(content.listShots(scene.id)).toMatchObject([
      { title: '海雾中的码头', prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。' },
    ]);
  });

  it('feeds an unpublished character reference back to the model for correction', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成场次镜头',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成场次镜头',
      '第1集',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_structure_bad',
      calls: [
        {
          id: 'call_structure_bad',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            episodeTitle: '第1集',
            scenes: [
              {
                title: '场次 01',
                shots: [{ title: '镜头 01', prompt: '[角色:不存在的人物] 出现在画面中。' }],
              },
            ],
          }),
        },
      ],
    });
    const rejected = JSON.parse(result.continuation!.outputs[0]!.output) as {
      error: { code: string; message: string };
    };
    expect(rejected.error.code).toBe('AGENT_TOOL_ARGUMENTS_INVALID');
    expect(rejected.error.message).toContain('references unknown character "不存在的人物"');
    expect(new ChangeSetService(project).list({ includeTerminal: false })).toHaveLength(0);
  });

  it('feeds malformed tool arguments back to the model for correction', async () => {
    const { conversation, generations, loop } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Create a draft.',
      'Draft',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_bad_json',
      calls: [
        {
          id: 'call_bad_json',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{"title": "Draft", "contentMarkdown": "未闭合',
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'Tool arguments are not valid JSON for document.create_draft',
    );
    expect(result.continuation?.outputs[0]?.output).toContain('请修正后重新提交');
  });

  it('keeps malformed arguments out of the chat-completions continuation for self-correction', async () => {
    const { conversation, generations, loop } = await setup('openai-chat-completions');
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Create a draft.',
      'Draft',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_bad_json_chat',
      calls: [
        {
          id: 'call_bad_json_chat',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{"title": "Draft", "contentMarkdown": "未闭合',
        },
      ],
    });
    expect(result.continuation?.protocol).toBe('openai-chat-completions');
    const continuation = result.continuation as Extract<
      typeof result.continuation,
      { protocol: 'openai-chat-completions' }
    >;
    expect(continuation.calls[0]).toMatchObject({
      id: 'call_bad_json_chat',
      name: 'document.create_draft',
      argumentsJson: '{}',
    });
    expect(continuation.outputs[0]?.output).toContain('Tool arguments are not valid JSON');
  });

  it('feeds malformed episode structure arguments back without creating a change set', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成场次镜头',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成场次镜头',
      '第1集',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_structure_bad_json',
      calls: [
        {
          id: 'call_structure_bad_json',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{"episodeTitle": "第1集", "scenes": [',
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'Tool arguments are not valid JSON for novel.episode.submit_structure',
    );
    expect(new ChangeSetService(project).list({ includeTerminal: false })).toHaveLength(0);
  });

  it('lands the full episode flow: publish chapters and scene prompts, then generate and approve scenes/shots', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const content = new ContentService(project);
    const novel = new NovelService(project);
    const context = new NovelContextService(project);

    const publishDocument = (documentId: string) => {
      const current = workflow.getDocument(documentId);
      workflow.submitReview({
        documentId,
        expectedDocumentRowVersion: current.rowVersion,
      });
      const reviewed = workflow.getDocument(documentId);
      workflow.publish({
        documentId,
        expectedDocumentRowVersion: reviewed.rowVersion,
        expectedPublishedVersionId: reviewed.publishedVersionId,
      });
    };

    // 1. Upload and publish chapters.
    const chapters: string[] = [];
    for (const title of ['第一章', '第二章', '第三章']) {
      const chapter = novel.saveChapter({ title });
      const draft = workflow.saveDraft({
        documentId: chapter.documentId,
        title: chapter.title,
        contentMarkdown: `${title}正文，白家三房的日常。`,
        expectedDocumentRowVersion: chapter.documentRowVersion,
      });
      publishDocument(draft.id);
      chapters.push(chapter.id);
    }

    // 2. Publish a scene prompt document WITHOUT a document_bindings row.
    const scenePrompt = workflow.saveDraft({
      kind: 'scene',
      title: '本集场景提示词',
      contentMarkdown: '# 白家三房\n堂屋与两侧小房，年代农家。\n\n# 白家正屋\n待客与吃饭的主屋。',
    });
    publishDocument(scenePrompt.id);

    // 3. Short-drama context must expose the published scene prompt to the model.
    const compiled = context.compileShortDrama(conversation.id, undefined, chapters);
    expect(compiled.rendered).toContain('场景提示词：本集场景提示词');
    expect(compiled.rendered).toContain('# 白家三房');
    expect(compiled.rendered).toContain('# 白家正屋');

    // 4. Generate an episode structure that references the published scene names.
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成本集的场次和镜头提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成本集的场次和镜头提示词',
      '第1集',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_episode_flow',
      calls: [
        {
          id: 'call_episode_flow',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            episodeTitle: '第1集',
            scenes: [
              {
                title: '白家三房 · 午后',
                shots: [
                  {
                    title: '屋檐下全景',
                    prompt: '[场景:白家三房] 屋檐下全景，白小弟在学医。',
                  },
                ],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'episode_structure_change_set_created',
    );

    // 5. Approve the change set; prompts must land on shots.
    const changeSets = new ChangeSetService(project);
    const proposed = changeSets.list({ includeTerminal: false });
    expect(proposed).toHaveLength(1);
    const applied = changeSets.apply({
      changeSetId: proposed[0]!.id,
      expectedRowVersion: proposed[0]!.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const scene = content.listScenes()[0]!;
    expect(content.listShots(scene.id)).toMatchObject([
      { title: '屋檐下全景', prompt: '[场景:白家三房] 屋檐下全景，白小弟在学医。' },
    ]);
  });

  it('creates character and scene documents through document.create_draft documentKind', async () => {
    const { conversation, generations, loop, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '把前三章的人物做成提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '把前三章的人物做成提示词',
      '角色提示词',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_char_draft',
      calls: [
        {
          id: 'call_char_draft',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '前三章人物提示词',
            contentMarkdown: '# 林澈\n灯塔守望员。',
            documentKind: 'character',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('draft_created');
    const parsed = JSON.parse(result.continuation!.outputs[0]!.output) as { documentId: string };
    expect(workflow.getDocument(parsed.documentId).kind).toBe('character');
  });

  it('rejects a combined character bible and asks for one create_draft per character', async () => {
    const { conversation, generations, loop, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '把第一章人物做成提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '把第一章人物做成提示词',
      '角色提示词',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_combined_cast',
      calls: [
        {
          id: 'call_combined_cast',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '第一章 角色提示词',
            contentMarkdown: '## 角色：许大山\n肩宽背厚。\n\n## 角色：沈清禾\n温婉清雅。\n',
            documentKind: 'character',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('CHARACTER_PROMPT_NOT_SINGLE');
    expect(result.continuation?.outputs[0]?.output).toContain('许大山、沈清禾');
    expect(workflow.listDocuments().filter((row) => row.kind === 'character')).toHaveLength(0);
  });

  it('infers documentKind from the draft title when the model omits it', async () => {
    const { conversation, generations, loop, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '把前三章的人物做成提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '把前三章的人物做成提示词',
      '角色提示词',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_inferred_kind',
      calls: [
        {
          id: 'call_inferred_kind',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '前三章人物提示词',
            contentMarkdown: '# 林澈\n灯塔守望员。',
          }),
        },
      ],
    });
    const parsed = JSON.parse(result.continuation!.outputs[0]!.output) as { documentId: string };
    expect(workflow.getDocument(parsed.documentId).kind).toBe('character');
  });

  it.each([
    '保存',
    '保存吧',
    '请把上面的分镜保存为文档',
    '存为草稿',
    '存入项目',
    'save it',
    'can you save it',
  ])('authorizes document saving for %s', async (prompt) => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    expect(agent.tools.map((tool) => tool.name)).toContain('document.create_draft');
    expect(taskSnapshot(project, agent.taskId).documentOperation).toBe('document.create_draft');
  });

  it.each([
    '如何保存文档？',
    '不要保存',
    '先不保存',
    '查看资料',
    'how do I save it?',
    "don't save the draft",
    '怎么保存生成的文档？',
  ])('does not gate tool availability on declined or informational wording: %s', async (prompt) => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    expect(agent.tools.map((tool) => tool.name)).toContain('document.submit_draft');
    loop.startProviderStep(prepared.stream);
    expect(() =>
      loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
    ).not.toThrow();
  });

  it.each(['我想写一部小说', '帮我写个故事', '想创作一本小说'])(
    'allows clarifying an open-ended writing goal without aborting: %s',
    async (prompt) => {
      const { conversation, generations, project, workflow } = await setup();
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      loop.prepare(prepared.stream, prompt);
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
    },
  );

  it.each(['生成一份大纲', '写一份角色设定', '根据第一章生成剧本'])(
    'allows the model to answer or clarify a named write without Worker semantics: %s',
    async (prompt) => {
      const { conversation, generations, project, workflow } = await setup();
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      loop.prepare(prepared.stream, prompt);
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
    },
  );

  it.each(['document.create_draft', 'document.update_draft'] as const)(
    'records the actual version ownership when the model calls %s',
    async (operation) => {
      const { conversation, generations, project, workflow } = await setup();
      const loop = createSystemLoop(project, workflow);
      const previous = workflow.saveDraft({
        title: 'Existing draft',
        contentMarkdown: '# Old version',
      });
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '保存',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(
        prepared.stream,
        '保存',
        undefined,
        operation === 'document.update_draft'
          ? { operation, documentId: previous.id }
          : { operation },
      );
      loop.startProviderStep(prepared.stream);
      expect(
        project.access(false, (database) =>
          database.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(agent.taskId),
        ),
      ).toEqual({ status: 'running' });
      const tool = agent.tools.find((item) => item.name === operation)!;
      await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'write-response',
        calls: [
          {
            id: 'write',
            name: operation,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: '分镜文档',
              contentMarkdown: '# 第一章\n\n镜头一：青萝村。',
            }),
          },
        ],
      });
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
      const saved = workflow.listDocuments().find((doc) => doc.title === '分镜文档')!;
      expect(workflow.getDocument(saved.id).currentVersion?.contentMarkdown).toContain(
        '镜头一：青萝村',
      );
      expect(
        project.access(false, (database) =>
          database.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(agent.taskId),
        ),
      ).toEqual({ status: 'waiting_review' });
    },
  );

  it.each([true, false])(
    'Pi accepts model chosen text or writing and records only real artifacts (write=%s)',
    async (write) => {
      const { conversation, generations, project, workflow } = await setup();
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '保存',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '保存');
      generations.configureAgentTools(prepared.stream, agent.tools);
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses(
        write
          ? [
              fauxAssistantMessage(
                [
                  fauxToolCall(
                    'document.create_draft',
                    { title: '分镜草稿', contentMarkdown: '# 分镜\n镜头正文' },
                    { id: 'write' },
                  ),
                ],
                { stopReason: 'toolUse', responseId: 'written' },
              ),
              fauxAssistantMessage('已保存分镜草稿。'),
            ]
          : [fauxAssistantMessage('可以先讨论创作方向。')],
      );
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: {} as never,
        providerTools: loop,
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('Unexpected planner');
        },
      });
      await runtime.start({
        ...prepared.stream,
        identity: prepared.stream,
        taskId: agent.taskId,
        mode: 'document',
        prompt: '保存',
      });
      await runtime.wait(prepared.stream.generationId);
      const result = generations.get(prepared.stream.generationId);
      expect(result.status).toBe('complete');
      expect(workflow.listDocuments()).toHaveLength(write ? 1 : 0);
    },
  );

  it.each(['生成一张图片', '帮我生成视频'])(
    'does not require a text document for a media-only task: %s',
    async (prompt) => {
      const { conversation, generations, project, workflow } = await setup();
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      loop.prepare(prepared.stream, prompt);
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
    },
  );

  it('exposes available system tools and lets the model choose a reversible write', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prompt = '请把当前会话重命名为项目讨论';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    expect(agent.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'project.get_context',
        'project.structure.get',
        'conversation.rename',
        'assetGroup.list',
        'asset.update_alias',
        'document.submit_draft',
      ]),
    );

    loop.startProviderStep(prepared.stream);
    const rename = agent.tools.find((tool) => tool.name === 'conversation.rename')!;
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'system-rename-response',
      calls: [
        {
          id: 'system-rename-call',
          name: 'conversation.rename',
          authorizationHandle: rename.authorizationHandle,
          argumentsJson: JSON.stringify({ title: '项目讨论' }),
        },
      ],
    });
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'succeeded',
      conversation: { id: conversation.id, title: '项目讨论' },
    });
  });

  it('lists and confirms novel chapter archive with a current row version', async () => {
    const { conversation, generations, project, workflow, novels } = await setup();
    novels.getProfile({ createIfMissing: true });
    const chapter = novels.saveChapter({ title: '第一章 雾港' });
    const loop = createSystemLoop(project, workflow, novels);
    const prompt = `请查看小说章节列表，然后归档章节 ${chapter.id}`;
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    const list = agent.tools.find((tool) => tool.name === 'novel.chapter.list')!;
    const archive = agent.tools.find((tool) => tool.name === 'novel.chapter.archive')!;
    expect(list).toBeDefined();
    expect(archive).toBeDefined();
    loop.startProviderStep(prepared.stream);

    const listed = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'novel-list-response',
      calls: [
        {
          id: 'novel-list-call',
          name: 'novel.chapter.list',
          authorizationHandle: list.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expect(JSON.parse(listed.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'succeeded',
      chapters: [expect.objectContaining({ id: chapter.id, rowVersion: chapter.rowVersion })],
    });

    const pending = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'novel-archive-response',
      calls: [
        {
          id: 'novel-archive-call',
          name: 'novel.chapter.archive',
          authorizationHandle: archive.authorizationHandle,
          argumentsJson: JSON.stringify({
            chapterId: chapter.id,
            expectedRowVersion: chapter.rowVersion,
          }),
        },
      ],
    });
    expect(pending.confirmation).toMatchObject({
      operation: 'novel.chapter.archive',
      affectedEntities: [{ type: 'novel-chapter', id: chapter.id }],
    });
    expect(novels.listChapters({ includeArchived: true })[0]?.lifecycleStatus).toBe('active');

    const confirmed = loop.confirmTool({
      ...prepared.stream,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(JSON.parse(confirmed.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'archived',
      chapter: { id: chapter.id, lifecycleStatus: 'archived' },
    });
    expect(novels.listChapters({ includeArchived: true })[0]?.lifecycleStatus).toBe('archived');
    expect(() =>
      loop.confirmTool({
        ...prepared.stream,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).toThrow('AGENT_TOOL_CONFIRMATION_REPLAYED');
  });

  it('does not advertise unavailable novel lifecycle services regardless of wording', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prompt = '不要删除第一章';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);

    expect(agent.tools.map((tool) => tool.name)).not.toContain('novel.chapter.archive');
    expect(agent.tools.map((tool) => tool.name)).not.toContain('novel.chapter.restore');
  });

  it('keeps available catalog tools visible for a character prompt draft', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prompt = '把第一章人物做成角色提示词';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      prompt,
      '角色提示词',
      { operation: 'document.create_draft' },
      'project_only',
    );
    expect(agent.tools.map((tool) => tool.name)).toContain('document.create_draft');
    expect(agent.tools.map((tool) => tool.name)).toContain('asset.search');
    expect(agent.tools.map((tool) => tool.name)).toContain('tag.list');
    expect(agent.tools.map((tool) => tool.name)).toContain('assetGroup.list');
  });

  it('exposes the available asset catalog without keyword classification', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prompt = '列出素材库里的角色图';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    expect(agent.tools.map((tool) => tool.name)).toContain('asset.search');
    expect(agent.tools.map((tool) => tool.name)).toContain('assetGroup.list');
  });

  it('previews and executes a system R2 action exactly once with recoverable metadata', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prompt = `请归档会话 ${conversation.id}`;
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    const archive = agent.tools.find((tool) => tool.name === 'conversation.archive')!;
    expect(archive).toBeDefined();
    loop.startProviderStep(prepared.stream);

    const pending = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'conversation-archive-response',
      calls: [
        {
          id: 'conversation-archive-call',
          name: 'conversation.archive',
          authorizationHandle: archive.authorizationHandle,
          argumentsJson: JSON.stringify({ conversationId: conversation.id }),
        },
      ],
    });

    expect(pending.confirmation).toMatchObject({
      operation: 'conversation.archive',
      riskLevel: 'R2',
      affectedEntities: [{ type: 'conversation', id: conversation.id, label: conversation.title }],
    });
    expect(pending.confirmation?.summary).toContain(conversation.title);
    expect(
      new ContentService(project)
        .listConversations({ includeArchived: true })
        .items.find((item) => item.id === conversation.id)?.archivedAt,
    ).toBeUndefined();
    expect(workflow.getTask({ taskId: agent.taskId }).pendingConfirmation).toMatchObject({
      confirmationId: pending.confirmation!.confirmationId,
      operation: 'conversation.archive',
      riskLevel: 'R2',
      summary: pending.confirmation!.summary,
      status: 'pending',
    });

    const confirmed = loop.confirmTool({
      ...prepared.stream,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(JSON.parse(confirmed.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'archived',
      conversation: { id: conversation.id },
    });
    expect(
      new ContentService(project)
        .listConversations({ includeArchived: true })
        .items.find((item) => item.id === conversation.id)?.archivedAt,
    ).toBeDefined();
    expect(() =>
      loop.confirmTool({
        ...prepared.stream,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).toThrow('AGENT_TOOL_CONFIRMATION_REPLAYED');
  });

  it('returns an R3 project handoff without performing the protected operation', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prompt = '请备份项目';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    const backup = agent.tools.find((tool) => tool.name === 'project.backup.prepare')!;
    expect(backup).toBeDefined();
    loop.startProviderStep(prepared.stream);
    const pending = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'project-backup-response',
      calls: [
        {
          id: 'project-backup-call',
          name: 'project.backup.prepare',
          authorizationHandle: backup.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expect(pending.confirmation).toMatchObject({
      riskLevel: 'R3',
      protectedUi: { page: 'maintenance', focusId: 'backup' },
    });

    const confirmed = loop.confirmTool({
      ...prepared.stream,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(JSON.parse(confirmed.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'protected_ui_required',
      protectedUi: { page: 'maintenance', focusId: 'backup' },
    });
  });

  it('rejects and audits unknown tools, old authorization handles, and cross-project entities', async () => {
    const first = await setup();
    const prepared = first.generations.prepare({
      conversationId: first.conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = first.loop.prepare(prepared.stream, 'Create a draft.');
    await expect(
      first.loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'unknown-response',
        calls: [
          {
            id: 'unknown-call',
            name: 'unregistered.tool',
            authorizationHandle: agent.tools[0]!.authorizationHandle,
            argumentsJson: '{}',
          },
        ],
      }),
    ).rejects.toThrow('AGENT_TOOL_UNKNOWN');

    first.loop.startProviderStep(prepared.stream);
    await first.loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'create-response',
      calls: [
        {
          id: 'create-call',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({ title: 'Draft', contentMarkdown: '# Draft' }),
        },
      ],
    });
    await expect(
      first.loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'replay-response',
        calls: [
          {
            id: 'replay-call',
            name: 'document.create_draft',
            authorizationHandle: agent.tools[0]!.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Replay', contentMarkdown: '# Replay' }),
          },
        ],
      }),
    ).rejects.toThrow('AGENT_TOOL_AUTHORIZATION_REPLAYED');

    const second = await setup();
    const systemLoop = createSystemLoop(second.project, second.workflow);
    const aliasPrompt = '把素材 asset-from-other-project 的别名改为封面';
    const systemPrepared = second.generations.prepare({
      conversationId: second.conversation.id,
      prompt: aliasPrompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const systemAgent = systemLoop.prepare(systemPrepared.stream, aliasPrompt);
    const aliasTool = systemAgent.tools.find((tool) => tool.name === 'asset.update_alias')!;
    systemLoop.startProviderStep(systemPrepared.stream);
    await expect(
      systemLoop.executeTools({
        ...systemPrepared.stream,
        providerResponseId: 'cross-project-response',
        calls: [
          {
            id: 'cross-project-call',
            name: 'asset.update_alias',
            authorizationHandle: aliasTool.authorizationHandle,
            argumentsJson: JSON.stringify({ assetId: 'asset-from-other-project', alias: '封面' }),
          },
        ],
      }),
    ).rejects.toThrow('AGENT_TOOL_PROJECT_SCOPE');

    expect(policyRejectionCodes(first.project, agent.taskId)).toEqual([
      'AGENT_TOOL_UNKNOWN',
      'AGENT_TOOL_AUTHORIZATION_REPLAYED',
    ]);
    expect(policyRejectionCodes(second.project, systemAgent.taskId)).toEqual([
      'AGENT_TOOL_PROJECT_SCOPE',
    ]);
  });

  it('rejects and audits tampered and expired confirmation grants', async () => {
    const tampered = await setup();
    const tamperedDocument = tampered.workflow.saveDraft({
      title: 'Tampered',
      contentMarkdown: '# Draft',
    });
    const tamperedPrepared = tampered.generations.prepare({
      conversationId: tampered.conversation.id,
      prompt: 'Archive this document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const tamperedAgent = tampered.loop.prepare(
      tamperedPrepared.stream,
      'Archive this document.',
      undefined,
      { operation: 'document.archive', documentId: tamperedDocument.id },
    );
    tampered.loop.startProviderStep(tamperedPrepared.stream);
    const tamperedPending = await tampered.loop.executeTools({
      ...tamperedPrepared.stream,
      providerResponseId: 'tampered-pending',
      calls: [
        {
          id: 'tampered-call',
          name: 'document.archive',
          authorizationHandle: tamperedAgent.tools[0]!.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    tampered.project.access(true, (database) => {
      database
        .prepare("UPDATE agent_task_confirmations SET normalized_arguments_hash = 'tampered'")
        .run();
    });
    expect(() =>
      tampered.loop.confirmTool({
        ...tamperedPrepared.stream,
        confirmationToken: tamperedPending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).toThrow('AGENT_TOOL_ARGUMENTS_TAMPERED');
    expect(policyRejectionCodes(tampered.project, tamperedAgent.taskId)).toEqual([
      'AGENT_TOOL_ARGUMENTS_TAMPERED',
    ]);

    const expired = await setup();
    const expiredDocument = expired.workflow.saveDraft({
      title: 'Expired',
      contentMarkdown: '# Draft',
    });
    const expiredPrepared = expired.generations.prepare({
      conversationId: expired.conversation.id,
      prompt: 'Archive this document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const expiredAgent = expired.loop.prepare(
      expiredPrepared.stream,
      'Archive this document.',
      undefined,
      { operation: 'document.archive', documentId: expiredDocument.id },
    );
    expired.loop.startProviderStep(expiredPrepared.stream);
    const expiredPending = await expired.loop.executeTools({
      ...expiredPrepared.stream,
      providerResponseId: 'expired-pending',
      calls: [
        {
          id: 'expired-call',
          name: 'document.archive',
          authorizationHandle: expiredAgent.tools[0]!.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expired.project.access(true, (database) => {
      database
        .prepare("UPDATE agent_task_confirmations SET expires_at = '2000-01-01T00:00:00.000Z'")
        .run();
    });
    expect(() =>
      expired.loop.confirmTool({
        ...expiredPrepared.stream,
        confirmationToken: expiredPending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).toThrow('AGENT_TOOL_CONFIRMATION_EXPIRED');
    expect(policyRejectionCodes(expired.project, expiredAgent.taskId)).toEqual([
      'AGENT_TOOL_CONFIRMATION_EXPIRED',
    ]);
    expect(
      expired.project.access(false, (database) =>
        database.prepare('SELECT status FROM agent_task_confirmations').get(),
      ),
    ).toEqual({ status: 'expired' });
  });

  it('cleans up interrupted Agent runtime records after Worker recovery', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    loop.prepare(prepared.stream, 'Create a draft.');
    expect(generations.recoverInterrupted()).toBe(1);
    expect(loop.recoverInterrupted()).toBe(1);
    project.access(false, (database) => {
      expect(database.prepare('SELECT status, error_code FROM agent_tasks').get()).toEqual({
        status: 'failed',
        error_code: 'interrupted',
      });
      expect(database.prepare('SELECT retryable FROM agent_tasks').get()).toEqual({ retryable: 1 });
      expect(database.prepare('SELECT status FROM agent_tool_authorizations').get()).toEqual({
        status: 'revoked',
      });
      expect(database.prepare('SELECT status FROM llm_provider_steps').get()).toEqual({
        status: 'interrupted',
      });
    });
  });
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function policyRejectionCodes(project: ProjectService, taskId: string): string[] {
  return project.access(false, (database) =>
    (
      database
        .prepare(
          `SELECT payload_json FROM agent_task_events
           WHERE task_id = ? AND event_type = 'agent.policy.rejected' ORDER BY sequence`,
        )
        .all(taskId) as Array<{ payload_json: string }>
    ).map((row) => (JSON.parse(row.payload_json) as { code: string }).code),
  );
}
