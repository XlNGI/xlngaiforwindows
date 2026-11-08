import { AgentContextManager } from './agent-context-manager.js';
import { nativeRequestUserText } from './test-fixtures/native-request-text.js';
import { AgentContextStore, AgentExecutionStore } from '@ai-video/persistence';
import type { NativeProviderStreamStartParams, NativeProviderHostEvent } from '@ai-video/contracts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '@ai-video/llm';
import { AGENT_TOOL_RESULT_LIMITS, type ProjectStructureResult } from '@ai-video/contracts';
import type {
  AdapterParameters,
  ProductionAuthoringIR,
  ProductionShotAuthoringIR,
} from '@ai-video/contracts';
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
import {
  AgentProviderToolGateway,
  AgentTaskContinuationRequired,
} from './agent-provider-tool-gateway.js';
import { AdapterService } from './adapter-service.js';
import { AppSettingsService } from './app-settings-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { MediaPreparationService } from './media-preparation-service.js';
import { MediaOrchestrationService } from './media-orchestration-service.js';
import { MediaReviewService } from './media-review-service.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
import { VideoGenerationService } from './video-generation-service.js';
import { AgentOrchestrationService } from './agent-orchestration-service.js';
import { prepareAgentGeneration } from './agent-generation-preparation.js';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import { TaskPlanService } from './task-plan-service.js';
import { ProjectStructureCompiler } from './structure-compiler.js';
import { LibrarySearchService } from './library-search-service.js';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const directories: string[] = [];
const projects: ProjectService[] = [];
const settingsServices: AppSettingsService[] = [];

function productionFixture(
  prompt: string,
  kind: 'scene' | 'shot' = 'scene',
): ProductionAuthoringIR {
  return {
    schemaVersion: 1,
    kind,
    prompt,
    ...(kind === 'shot'
      ? { timing: { estimatedDurationSeconds: 3, rationale: '动作与停顿' } }
      : {}),
  };
}

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
  kind: 'image' | 'video' = 'video',
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
      models: [{ id: kind === 'image' ? 'qwen-image-3.0' : 'vendor-hosted-video-model' }],
    });
    for (const model of settings.listModels(profile.id)) {
      settings.updateModel({
        profileId: profile.id,
        modelId: model.id,
        displayName: model.displayName,
        capabilities: {
          ...model.capabilities,
          imageGeneration: kind === 'image',
          videoGeneration: kind === 'video',
        },
        enabled: true,
        parameterTemplateKey:
          kind === 'image' ? model.parameterTemplateKey : 'openai-compatible-video',
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
  const nativeRequest = vi.fn<NativeProviderBridge['request']>().mockResolvedValue({
    status: 200,
    taskId: 'provider-task-private',
  });
  const mediaSubmission = new MediaOrchestrationService(base.project, settings, images, videos, {
    request: nativeRequest,
  } as unknown as NativeProviderBridge);
  return {
    ...base,
    profile,
    images,
    videos,
    media,
    settings,
    nativeRequest,
    mediaSubmission,
    loop: new AgentProviderLoopService(
      base.project,
      base.workflow,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      media,
      mediaSubmission,
    ),
  };
}

async function stageMediaForm(
  base: Awaited<ReturnType<typeof setupMedia>>,
  kind: 'image' | 'video' = 'video',
  imageArguments: Record<string, unknown> = {},
) {
  const prompt = 'Reviewed media prompt';
  const prepared = base.generations.prepare({
    conversationId: base.conversation.id,
    prompt,
    providerProfileId: 'agent-profile',
    modelId: 'agent-model',
  });
  const name = kind === 'image' ? 'media.image.prepare' : 'media.video.prepare';
  const tool = base.loop.prepare(prepared.stream, prompt).tools.find((tool) => tool.name === name)!;
  base.loop.startProviderStep(prepared.stream);
  const paused = await base.loop.executeTools({
    ...prepared.stream,
    providerResponseId: 'review-provider-response',
    calls: [
      {
        id: 'review-provider-call',
        name,
        authorizationHandle: tool.authorizationHandle,
        argumentsJson: JSON.stringify({ prompt, ...imageArguments }),
      },
    ],
  });
  const candidate = paused.mediaSelection!.candidates[0]!;
  return {
    ...prepared.stream,
    selectionToken: paused.mediaSelection!.selectionToken,
    selection: {
      providerProfileId: candidate.providerProfileId,
      modelId: candidate.modelId,
      adapterKey: candidate.adapters[0]!.key,
      parameters: { prompt: 'User edited prompt' },
    },
  };
}

function createSystemLoop(
  project: ProjectService,
  workflow: DocumentWorkflowService,
  novels?: NovelService,
  media?: MediaPreparationService,
  reviews?: MediaReviewService,
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
      media,
      workflow,
      undefined,
      new ProjectStructureCompiler(),
      novels,
      undefined,
      reviews,
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

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'persists targeted review and false-positive withdrawal through the authorized business loop (%s)',
  async (protocol) => {
    const base = await setup(protocol),
      content = new ContentService(base.project);
    const source = content.saveDocument({
      kind: 'note',
      title: '审查业务原文',
      contentMarkdown: '雨夜旧码头。林澈蓝衣，对周岚说：我回来了。',
    });
    const scene = content.saveScene({ title: '雨夜旧码头' });
    const ir = (prompt: string): ProductionShotAuthoringIR => ({
      schemaVersion: 1,
      kind: 'shot',
      prompt,
      references: { characterDocumentIds: [], sceneDocumentIds: [], propDocumentIds: [] },
      timing: {
        estimatedDurationSeconds: 10,
        rationale: '自然动作',
        beats: [{ kind: 'action', startSeconds: 0, endSeconds: 10, description: '走近灯塔' }],
      },
    });
    const shots = Array.from({ length: 6 }, (_, i) =>
      content.saveShot({
        sceneId: scene.id,
        title: `镜${i + 1}`,
        authoringIR: ir(i === 1 ? '林澈红衣走近灯塔。' : '林澈蓝衣走近灯塔。'),
      }),
    );
    const loop = createSystemLoop(base.project, base.workflow, base.novels);
    const prompt = '核对已保存的6镜60秒微短剧提示词，按原文修订错误，保留正确正文。';
    const prepared = base.generations.prepare({
      conversationId: base.conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      prompt,
      undefined,
      { operation: 'document.list' },
      'project_only',
      undefined,
      undefined,
      undefined,
      undefined,
      'script-to-media',
    );
    const contextManager = new AgentContextManager(
      base.project,
      prepared.stream,
      agent.taskId,
      prompt,
    );
    let tools = agent.tools,
      ordinal = 0;
    const execute = async (name: string, args: unknown) => {
      loop.startProviderStep(prepared.stream);
      const tool = tools.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      const id = `review-integration-${ordinal++}`;
      const result = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: `response-${id}`,
        calls: [
          {
            id,
            name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify(args),
          },
        ],
      });
      tools = result.tools ?? tools;
      contextManager.observe({
        messages: [
          fauxAssistantMessage([fauxToolCall(name, args as Record<string, unknown>, { id })], {
            stopReason: 'toolUse',
          }),
          {
            role: 'toolResult',
            toolName: name,
            toolCallId: id,
            isError: false,
            content: [{ type: 'text', text: result.continuation!.outputs[0]!.output }],
            timestamp: 2,
          },
        ],
      });
      return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
    };
    const search = await execute('library.search', { query: '审查业务原文' });
    const sources = search.sources as Array<{ sourceId: string; sourceHandle: string }>;
    await execute('library.read', {
      sourceHandle: sources.find((s) => s.sourceId === source.id)!.sourceHandle,
      readMode: 'source',
    });
    const contract = await execute('conversation.task.checkpoint', {
      operation: 'plan',
      deliverables: [
        {
          key: 'existing-episode',
          toolName: 'scene.update_shot_prompts',
          intent: 'verify',
          origin: 'model_inference',
          minimumCount: 6,
          targetIds: shots.map((s) => s.id),
        },
      ],
    });
    expect(contract.outputBindings).toEqual([]);
    const beforeReads = await execute('conversation.task.checkpoint', { operation: 'state' });
    expect(beforeReads.pendingActions).toMatchObject([
      {
        key: 'existing-episode',
        persistedCount: 6,
        nextAction: { kind: 'read_outputs' },
      },
    ]);
    for (const shot of shots)
      await execute('production.read', {
        target: { kind: 'shot', id: shot.id },
        view: 'authoring',
      });
    const restored = new AgentContextManager(base.project, prepared.stream, agent.taskId, prompt);
    const projected = restored.prepare(base.generations.runtime(prepared.stream), {
      messages: [],
    }).request;
    expect(projected.prompt).toContain('林澈红衣走近灯塔。');
    expect(projected.systemInstruction).not.toContain('林澈红衣走近灯塔。');
    expect(projected.prompt).toContain('taskContract');
    const reviewState = async () => {
      const result = await execute('conversation.task.checkpoint', { operation: 'state' });
      const actions = result.pendingActions as Array<{
        semanticReview: {
          reviewId: string;
          ready: boolean;
          issues: Array<{ issueId: string; targetId: string }>;
          reviewScope: string[];
        };
      }>;
      return actions[0]?.semanticReview;
    };
    const current = (await reviewState())!;
    expect(current.ready).toBe(true);
    const evidence = [{ referenceId: source.id, quote: '林澈蓝衣' }];
    const finding = await execute('conversation.task.checkpoint', {
      operation: 'review',
      reviewId: current.reviewId,
      reviewedTargetIds: [shots[1]!.id, shots[2]!.id],
      conclusion: 'needs_revision',
      summary: '镜2衣色错误，另记录一项待复核判断',
      issues: [
        {
          targetId: shots[1]!.id,
          category: 'consistency',
          description: '红衣与原文蓝衣冲突',
          evidence: [{ referenceId: 'invented-result-id', quote: '林澈蓝衣' }],
        },
        {
          targetId: shots[2]!.id,
          category: 'content',
          description: '误把刷新版本视为正文问题',
          evidence,
        },
      ],
    });
    expect(finding.status).toBe('task_review_recorded');
    const issues = (await reviewState())!.issues;
    expect(issues).toMatchObject([
      { targetId: shots[1]!.id, evidenceStatus: 'needs_correction' },
      { targetId: shots[2]!.id, evidenceStatus: 'verified' },
    ]);
    const rejectedPass = await execute('conversation.task.checkpoint', {
      operation: 'review',
      reviewId: current.reviewId,
      reviewedTargetIds: [shots[1]!.id, shots[2]!.id],
      conclusion: 'passed',
      summary: '引用失败后不能跳过',
      issues: [],
    });
    expect(JSON.stringify(rejectedPass)).toContain('TASK_REVIEW_UNRESOLVED');
    await execute('conversation.task.checkpoint', {
      operation: 'review',
      reviewId: current.reviewId,
      reviewedTargetIds: [shots[1]!.id],
      conclusion: 'needs_revision',
      summary: '用真实引用纠正',
      issues: [
        {
          issueId: issues[0]!.issueId,
          targetId: shots[1]!.id,
          category: 'consistency',
          description: '红衣与原文蓝衣冲突',
          evidence,
        },
      ],
    });
    expect((await reviewState())!.issues).toMatchObject([
      { issueId: issues[0]!.issueId, evidenceStatus: 'verified' },
      { issueId: issues[1]!.issueId, evidenceStatus: 'verified' },
    ]);
    content.saveShot({
      shotId: shots[1]!.id,
      sceneId: scene.id,
      title: shots[1]!.title,
      expectedRowVersion: shots[1]!.rowVersion,
      authoringIR: ir('林澈蓝衣走近灯塔。'),
    });
    const unread = (await reviewState())!;
    // Unified completion presents missing current readback before quality review.
    expect(unread).toBeUndefined();
    await execute('production.read', {
      target: { kind: 'shot', id: shots[1]!.id },
      view: 'authoring',
    });
    const updated = (await reviewState())!;
    expect(updated.reviewScope.sort()).toEqual(current.reviewScope.sort());
    const approved = await execute('conversation.task.checkpoint', {
      operation: 'review',
      reviewId: updated.reviewId,
      reviewedTargetIds: [shots[1]!.id, shots[2]!.id],
      conclusion: 'passed',
      summary: '逐项复核已修复与误报，其他镜头沿用有效审查',
      issues: [],
      resolutions: [
        {
          issueId: issues.find((i) => i.targetId === shots[1]!.id)!.issueId,
          disposition: 'resolved',
          reason: '镜2已改为蓝衣并读回',
          evidence: [{ referenceId: shots[1]!.id, quote: '林澈蓝衣走近灯塔。' }],
        },
        {
          issueId: issues.find((i) => i.targetId === shots[2]!.id)!.issueId,
          disposition: 'withdrawn',
          reason: '版本就绪是系统条件，原文和镜3均无内容错误',
          evidence,
        },
      ],
    });
    expect(approved.status).toBe('task_review_recorded');
    const remaining = (await reviewState())!;
    expect(remaining.issues).toEqual([]);
    expect(remaining.reviewScope.sort()).toEqual(
      current.reviewScope.filter((id) => ![shots[1]!.id, shots[2]!.id].includes(id)).sort(),
    );
    await execute('conversation.task.checkpoint', {
      operation: 'review',
      reviewId: remaining.reviewId,
      reviewedTargetIds: remaining.reviewScope,
      conclusion: 'passed',
      summary: '明确核对剩余四镜与制作资料',
      issues: [],
    });
    const final = await execute('conversation.task.checkpoint', { operation: 'state' });
    expect(final.pendingActions).toEqual([]);
    const stored = base.project.access(false, (db) =>
      new AgentContextStore(db)
        .resultRefs(base.project.current()!.id, agent.taskId)
        .filter((r) => r.toolName === 'conversation.task.checkpoint'),
    );
    expect(stored.length).toBeGreaterThan(2);
    expect(content.listShots(scene.id)).toHaveLength(6);
    expect(content.listShots(scene.id).find((s) => s.id === shots[2]!.id)!.rowVersion).toBe(
      shots[2]!.rowVersion,
    );
  },
  30000,
);

describe('AgentProviderLoopService', () => {
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'reuses durable failed content, preserves CAS conflicts and reads known artifacts directly (%s)',
    async (protocol) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '保存计划',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '保存计划', undefined, {
        operation: 'document.list',
      });
      let tools = agent.tools,
        ordinal = 0;
      const invoke = async (name: string, args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `r-${ordinal}`,
          calls: [
            {
              id: `c-${ordinal++}`,
              name,
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
            },
          ],
        });
        tools = result.tools!;
        return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
      };
      const args = {
        resourceId: 'workspace:documents',
        title: '原始完整候选',
        documentKind: 'plan',
        contentMarkdown: '逐镜完整正文'.repeat(1000),
        expectedRevision: 'stale',
      };
      expect(await invoke('document.submit_draft', args)).toMatchObject({ status: 'rejected' });
      const ref = loop.preserveToolArguments(prepared.stream, 'document.submit_draft', args, 'c-0');
      expect(workflow.listDocuments()).toHaveLength(0);
      // Reusing content alone must not refresh the stale CAS or create a document.
      expect(await invoke('document.submit_draft', { preparedArguments: ref })).toMatchObject({
        status: 'rejected',
      });
      const map = (await invoke('project.structure.get', {})).resourceMap as ProjectStructureResult;
      const saved = await invoke('document.submit_draft', {
        preparedArguments: ref,
        expectedRevision: map.revision,
      });
      expect(saved.status).toBe('draft_saved');
      expect(workflow.getDocument(saved.documentId as string).currentVersion?.contentMarkdown).toBe(
        args.contentMarkdown,
      );
      const artifact = { documentId: saved.documentId, expectedVersionId: saved.documentVersionId };
      const read = await invoke('library.read', { artifact, maxChars: 1000 });
      expect(read).toMatchObject({
        status: 'read',
        sourceStatus: 'draft',
        content: args.contentMarkdown.slice(0, 1000),
        nextOffset: 1000,
      });
      const next = await invoke('library.read', { artifact, offset: 1000, maxChars: 1000 });
      expect(next).toMatchObject({ status: 'read', startOffset: 1000 });
      expect(
        await invoke('library.read', { artifact: { ...artifact, expectedVersionId: 'old' } }),
      ).toMatchObject({ status: 'failed' });
      expect(
        await invoke('document.submit_draft', {
          preparedArguments: ref,
          expectedRevision: map.revision,
        }),
      ).toMatchObject({ status: 'draft_saved', execution: { replayed: true } });
      expect(workflow.listDocuments()).toHaveLength(1);
      const directRead = () =>
        new LibrarySearchService(project).readArtifact({
          taskId: agent.taskId,
          attemptId: prepared.stream.attemptId,
          documentId: saved.documentId as string,
          expectedVersionId: saved.documentVersionId as string,
        });
      const root = project.current()!.rootPath;
      project.close();
      project.open(root);
      expect(directRead()).toMatchObject({ content: args.contentMarkdown, sourceStatus: 'draft' });
      expect(() =>
        new LibrarySearchService(project).readArtifact({
          taskId: 'another-task',
          attemptId: prepared.stream.attemptId,
          documentId: saved.documentId as string,
          expectedVersionId: saved.documentVersionId as string,
        }),
      ).toThrow('outside');
      const content = new ContentService(project);
      const unregistered = content.saveDocument({
        kind: 'plan',
        title: '其他资料',
        contentMarkdown: '按需读取',
      });
      expect(
        await invoke('library.read', {
          artifact: {
            documentId: unregistered.id,
            expectedVersionId: unregistered.currentVersion!.id,
          },
        }),
      ).toMatchObject({ status: 'failed' });
      const found = await invoke('library.search', { query: '其他资料' });
      const sources = found.sources as Array<{ sourceId: string; sourceHandle: string }>;
      const source = sources.find((item) => item.sourceId === unregistered.id)!;
      expect(
        await invoke('library.read', { sourceHandle: source.sourceHandle, readMode: 'source' }),
      ).toMatchObject({ content: '按需读取' });
      expect(
        await invoke('library.read', {
          artifact: {
            documentId: unregistered.id,
            expectedVersionId: unregistered.currentVersion!.id,
          },
        }),
      ).toMatchObject({ content: '按需读取' });
      const current = content.getDocument(saved.documentId as string);
      content.saveDocument({
        documentId: current.id,
        kind: current.kind,
        title: current.title,
        expectedDocumentRowVersion: current.rowVersion,
        contentMarkdown: '用户修改的新版本',
      });
      expect(directRead).toThrow('stale');
      const other = await setup(protocol);
      expect(() =>
        new LibrarySearchService(other.project).readArtifact({
          taskId: agent.taskId,
          attemptId: prepared.stream.attemptId,
          documentId: saved.documentId as string,
          expectedVersionId: saved.documentVersionId as string,
        }),
      ).toThrow('outside');
    },
  );
  it.each(['consumed', 'rejected'] as const)(
    'guards repeated scene preparation after a %s selection',
    async (status) => {
      const base = await setupMedia(true, 'openai-responses', 'image');
      const doc = new ContentService(base.project).saveDocument({
        kind: 'scene',
        title: '旧码头',
        contentMarkdown: '灯塔与栈道',
        scopeType: 'project',
      });
      const params = await stageMediaForm(base, 'image', { sourceDocumentId: doc.id });
      base.nativeRequest.mockResolvedValue({
        status: 200,
        body: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
      });
      const next = await base.loop.selectMedia({
        ...params,
        selection: status === 'consumed' ? params.selection : undefined,
      });
      const tool = next.tools!.find((item) => item.name === 'media.image.prepare')!;
      base.loop.startProviderStep(params);
      const result = await base.loop.executeTools({
        ...params,
        providerResponseId: 'second-response',
        calls: [
          {
            id: 'second-call',
            name: tool.name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify({ prompt: '灯塔特写', sourceDocumentId: doc.id }),
          },
        ],
      });
      if (status === 'consumed') {
        expect(result.mediaSelection).toBeUndefined();
        expect(result.continuation!.outputs[0]!.output).toContain('不要拆分请求');
      } else expect(result.mediaSelection!.prompt).toContain('一张复合参考图');
      expect(base.nativeRequest).toHaveBeenCalledTimes(status === 'consumed' ? 1 : 0);
      expect(
        base.project.access(false, (db) =>
          db.prepare('SELECT count(*) AS count FROM agent_media_selections').get(),
        ),
      ).toEqual({ count: status === 'consumed' ? 1 : 2 });
    },
  );
  it('exposes question forms immediately and executes them through the ordinary authorized tool loop', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '帮我设计短剧',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '帮我设计短剧', undefined, {
      operation: 'document.list',
    });
    generations.configureAgentTools(prepared.stream, agent.tools);
    const gateway = new AgentProviderToolGateway(
      loop,
      prepared.stream,
      agent.tools,
      vi.fn(),
      vi.fn(),
    );
    expect(gateway.currentDefinitions().map((tool) => tool.name)).toContain('conversation.ask');
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'questions-response',
      calls: [
        {
          id: 'questions-call',
          name: 'conversation.ask',
          authorizationHandle: agent.tools.find((tool) => tool.name === 'conversation.ask')!
            .authorizationHandle,
          argumentsJson: JSON.stringify({
            key: 'direction',
            title: '确认方向',
            questions: [{ id: 'style', type: 'text', prompt: '希望采用什么画风？' }],
          }),
        },
      ],
    });
    const receipt = JSON.parse(result.continuation!.outputs[0]!.output) as {
      formId: string;
      status: string;
      presentation: string;
    };
    expect(receipt).toMatchObject({ status: 'pending', presentation: 'conversation-form' });
    const form = workflow
      .getTask({ taskId: agent.taskId })
      .events.find((event) => event.userInput)?.userInput;
    expect(form).toMatchObject({
      id: receipt.formId,
      conversationId: conversation.id,
      status: 'pending',
    });
    expect(result.confirmation).toBeUndefined();
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'preserves the optional next-step form after saving a chapter through %s',
    async (protocol) => {
      const { conversation, generations, project, workflow, novels } = await setup(protocol);
      const loop = createSystemLoop(project, workflow, novels);
      const prompt = '继续第三章';
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, prompt, undefined, {
        operation: 'document.list',
      });
      generations.configureAgentTools(prepared.stream, agent.tools);
      const nextStep = {
        key: 'chapter-three-next',
        title: '下一步',
        questions: [
          {
            id: 'next',
            prompt: '接下来希望怎么做？',
            type: 'single',
            options: [
              { id: 'continue', label: '继续第四章' },
              { id: 'revise', label: '审阅/调整第三章' },
            ],
          },
        ],
      };
      const summary = '第三章《剑意一现》草稿已保存。\n\n内容概览：主角初悟剑意。';
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              'tools.load',
              { names: ['novel.chapter.write_draft'] },
              { id: 'load-chapter-write' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'load-response' },
        ),
        fauxAssistantMessage(
          [
            fauxToolCall(
              'novel.chapter.write_draft',
              {
                resourceId: 'workspace:novel',
                action: 'create_chapter',
                title: '剑意一现',
                displayLabel: '第三章',
                contentMarkdown: '主角在雨夜中初悟剑意。',
              },
              { id: 'save-third-chapter' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'save-response' },
        ),
        fauxAssistantMessage(
          [{ type: 'text', text: summary }, fauxToolCall('conversation.ask', nextStep)],
          { stopReason: 'toolUse', responseId: 'next-step-response' },
        ),
        fauxAssistantMessage('请在表单中选择下一步。'),
      ]);
      const requests: Array<{ tools: string[]; systemPrompt: string }> = [];
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: {} as never,
        providerTools: loop,
        streamFn: (model, context, options) => {
          requests.push({
            tools: (context.tools ?? []).map((tool) => tool.name),
            systemPrompt: context.systemPrompt ?? '',
          });
          return faux.streamSimple(model, context, options);
        },
        createGateway: () => {
          throw new Error('Next-step forms must use the ordinary Agent runtime.');
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
      // Creating the question form is the user-review boundary. The Agent
      // loop must stop here instead of consuming a synthetic follow-up turn.
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(request.tools).toContain('conversation.ask');
        expect(request.systemPrompt).toContain('任务完成后的可选下一步也属于用户选择');
      }
      expect(novels.listChapters()).toHaveLength(1);
      expect(novels.listChapters()[0]?.displayLabel).toBe('第三章');
      const restored = new DocumentWorkflowService(project).getTask({ taskId: agent.taskId });
      expect(restored.task.status).toBe('waiting_review');
      expect(restored.documents).toHaveLength(1);
      const formEvents = restored.events.filter((event) => event.userInput);
      expect(formEvents).toHaveLength(1);
      expect(formEvents[0]?.userInput).toMatchObject({
        ...nextStep,
        conversationId: conversation.id,
        status: 'pending',
      });
      expect(restored.events.some((event) => event.eventType === 'agent.user_input.answered')).toBe(
        false,
      );
      expect(
        new ContentService(project)
          .listMessages({ conversationId: conversation.id })
          .items.find((message) => message.id === prepared.generation.assistantMessage.id)?.content,
      ).toContain(summary);
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'loads and edits chapter directory metadata without rewriting its body through %s',
    async (protocol) => {
      const { conversation, generations, project, workflow, novels } = await setup(protocol);
      const chapter = novels.importNovel({
        chapters: [
          {
            title: '第二章 深夜剑冢',
            displayLabel: '第二章 深夜剑冢',
            contentMarkdown: '# 第二章 深夜剑冢\n\n完整原文。',
          },
        ],
      }).chapters[0]!;
      const before = workflow.getDocument(chapter.documentId);
      const loop = createSystemLoop(project, workflow, novels);
      const prompt = '把第二章目录标签改为第 2 章，正文不变。';
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, prompt, undefined, {
        operation: 'document.list',
      });
      generations.configureAgentTools(prepared.stream, agent.tools);
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('tools.load', {
              names: ['novel.chapter.list', 'novel.chapter.update_metadata'],
            }),
          ],
          { stopReason: 'toolUse', responseId: 'load-metadata' },
        ),
        fauxAssistantMessage([fauxToolCall('novel.chapter.list', {})], {
          stopReason: 'toolUse',
          responseId: 'list-chapters',
        }),
        fauxAssistantMessage(
          [
            fauxToolCall('novel.chapter.update_metadata', {
              chapterId: chapter.id,
              expectedChapterRowVersion: chapter.rowVersion,
              expectedDocumentRowVersion: chapter.documentRowVersion,
              displayLabel: '第 2 章',
            }),
          ],
          { stopReason: 'toolUse', responseId: 'edit-label' },
        ),
        fauxAssistantMessage('第二章目录标签已更新，正文保持不变。'),
      ]);
      const requestedTools: string[][] = [];
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: {} as never,
        providerTools: loop,
        streamFn: (model, context, options) => {
          requestedTools.push((context.tools ?? []).map((tool) => tool.name));
          return faux.streamSimple(model, context, options);
        },
        createGateway: () => {
          throw new Error('Metadata edits use the ordinary Agent runtime.');
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
      expect(requestedTools).toHaveLength(4);
      expect(requestedTools[0]).not.toContain('novel.chapter.update_metadata');
      expect(requestedTools[1]).toContain('novel.chapter.update_metadata');
      expect(requestedTools.flat()).not.toContain('novel.chapter.write_draft');
      expect(novels.listChapters()).toEqual([
        expect.objectContaining({
          id: chapter.id,
          title: chapter.title,
          displayLabel: '第 2 章',
          position: chapter.position,
        }),
      ]);
      const after = workflow.getDocument(chapter.documentId);
      expect(after.currentVersion).toEqual(before.currentVersion);
      expect(after.publishedVersionId).toBe(before.publishedVersionId);
      expect(workflow.getTask({ taskId: agent.taskId }).documents).toHaveLength(0);
      expect(workflow.getTask({ taskId: agent.taskId }).novelMetadataUpdated).toBe(true);
      expect(workflow.getTask({ taskId: agent.taskId }).task.outcome).not.toBe('read-only');
      expect(
        project.access(false, (db) =>
          db
            .prepare(
              'SELECT tool_name, status FROM agent_tool_calls WHERE task_id = ? ORDER BY created_at, id',
            )
            .all(agent.taskId),
        ),
      ).toEqual([
        { tool_name: 'novel.chapter.list', status: 'succeeded' },
        { tool_name: 'novel.chapter.update_metadata', status: 'succeeded' },
      ]);
    },
  );

  it('persists assistant stage boundaries between tool batches and restores them without duplicating text', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '查看项目已有资料',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '查看项目已有资料', undefined, {
      operation: 'document.list',
    });
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const first = '我先查看项目里已有的文档。';
    generations.observe({ ...prepared.stream, content: first });
    generations.observe({ ...prepared.stream, content: first + '稍等。' });
    const firstText = first + '稍等。';
    await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'response-one',
      calls: [
        {
          id: 'call-one',
          name: 'document.list',
          argumentsJson: '{}',
          authorizationHandle: agent.tools.find((t) => t.name === 'document.list')!
            .authorizationHandle,
        },
      ],
    });
    const final = firstText + '\n\n项目中还没有文档，可以开始设计。';
    generations.observe({ ...prepared.stream, content: final });
    generations.observe({ ...prepared.stream, content: firstText });
    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'response-two',
      finishReason: 'stop',
    });
    generations.complete({ ...prepared.stream, content: final, finishReason: 'stop' });
    const detail = workflow.getTask({ taskId: agent.taskId });
    const boundaries = detail.events.filter((event) => event.messageBoundary);
    expect(boundaries.map((event) => event.messageBoundary)).toEqual([
      { messageId: prepared.generation.assistantMessage.id, startOffset: 0 },
      { messageId: prepared.generation.assistantMessage.id, startOffset: firstText.length },
    ]);
    const toolStart = detail.events.find((event) => event.eventType === 'agent.tool.started')!;
    expect(boundaries[0]!.sequence).toBeLessThan(toolStart.sequence);
    expect(boundaries[1]!.sequence).toBeGreaterThan(toolStart.sequence);
    const restored = new DocumentWorkflowService(project).getTask({ taskId: agent.taskId });
    expect(restored.events).toEqual(detail.events);
    expect(
      new ContentService(project)
        .listMessages({ conversationId: conversation.id })
        .items.find((message) => message.id === prepared.generation.assistantMessage.id)?.content,
    ).toBe(final);
    expect(JSON.stringify(boundaries)).not.toContain(first);
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'recovers exact staged identities without repeating saved work (%s)',
    async (protocol) => {
      const { conversation, generations, project, workflow, novels } = await setup(protocol);
      const loop = createSystemLoop(project, workflow, novels);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '保存一个简短场次',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '保存一个简短场次', undefined, {
        operation: 'document.list',
      });
      generations.configureAgentTools(prepared.stream, agent.tools);
      let tools = agent.tools;
      let ordinal = 0;
      const invoke = async (args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `ir-stage-${ordinal}`,
          calls: [
            {
              id: `ir-stage-call-${ordinal++}`,
              name: 'scene.structure.stage',
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((tool) => tool.name === 'scene.structure.stage')!
                .authorizationHandle,
            },
          ],
        });
        tools = result.tools!;
        return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
      };
      const prop = new ContentService(project).saveDocument({
        kind: 'prop',
        title: '酒葫芦',
        contentMarkdown: '# 酒葫芦',
      });
      const sceneIR = {
        schemaVersion: 1,
        kind: 'scene',
        prompt: '山村铁匠铺内，炉火映红墙面。',
        references: { propDocumentIds: [prop.id] },
        data: { location: '村庄边缘', lighting: '炉火' },
      };
      const shotIR = {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '老者用木杖探地，跛行走向门外。',
        timing: { estimatedDurationSeconds: 6.5, rationale: '探地、迈步和停顿' },
        references: { propDocumentIds: [prop.id] },
        data: { gait: ['杖尖点地', '左脚探步', '右足拖行'] },
      };

      const begun = await invoke({
        operation: 'begin',
        resourceId: 'workspace:shots',
        executionKey: 'ir-stage-sequence',
        episodeTitle: '雾中离去',
        sceneShotCounts: [1],
      });
      const sceneStaged = await invoke({
        operation: 'put_scene',
        resourceId: 'workspace:shots',
        stageId: begun.stageId,
        expectedRowVersion: begun.rowVersion,
        sceneIndex: 0,
        scene: { title: '离去', authoringIR: sceneIR },
      });
      const otherConversation = new ContentService(project).createConversation({
        scopeType: 'project',
      });
      project.access(true, (db) =>
        db
          .prepare(
            `INSERT INTO scene_structure_stages
      (id,project_id,conversation_id,execution_key,title,expected_scene_count,scenes_json,created_at,updated_at)
      SELECT 'other-stage',project_id,?,execution_key||'-other',title,expected_scene_count,scenes_json,created_at,updated_at
      FROM scene_structure_stages WHERE id=?`,
          )
          .run(otherConversation.id, begun.stageId),
      );
      const rejected = await invoke({
        operation: 'get',
        resourceId: 'workspace:shots',
        stageId: 'mistyped-stage',
      });
      expect(rejected).toMatchObject({
        status: 'rejected',
        error: { retryable: true },
        recovery: {
          stages: [{ stageId: begun.stageId, rowVersion: sceneStaged.rowVersion }],
          read: { arguments: { operation: 'get', resourceId: 'workspace:shots' } },
        },
      });
      expect(JSON.stringify(rejected)).not.toContain('other-stage');
      const replay = await invoke({
        operation: 'begin',
        resourceId: 'workspace:shots',
        executionKey: 'ir-stage-sequence',
        episodeTitle: '雾中离去',
        sceneShotCounts: [1],
      });
      expect(replay).toMatchObject({
        stageId: begun.stageId,
        rowVersion: 0,
        execution: { replayed: true, receiptScope: 'historical_commit' },
      });
      const recovered = await invoke({
        operation: 'get',
        resourceId: 'workspace:shots',
        stageId: begun.stageId,
      });
      expect(recovered).toMatchObject({
        rowVersion: sceneStaged.rowVersion,
        scenes: [{ setupStaged: true, missingShots: [0] }],
      });
      const saved = await invoke({
        operation: 'put_shots',
        resourceId: 'workspace:shots',
        stageId: begun.stageId,
        expectedRowVersion: sceneStaged.rowVersion,
        sceneIndex: 0,
        shotOffset: 0,
        shots: [{ title: '探路', authoringIR: shotIR }],
      });

      expect(saved).toMatchObject({
        status: 'scene_structure_saved',
        applied: true,
        complete: true,
      });
      const content = new ContentService(project);
      const scene = content.listScenes()[0]!;
      const shot = content.listShots(scene.id)[0]!;
      expect(scene.authoringIR).toEqual(sceneIR);
      expect(shot.authoringIR).toEqual(shotIR);
      for (const receipt of [sceneStaged, saved]) {
        expect(receipt).not.toHaveProperty('bindings');
        expect(receipt).toMatchObject({
          referenceScope: 'shot.authoringIR.references',
          sourcesScope: 'staged-scene-header',
        });
        expect(receipt.bindingInstruction).toContain('not evidence of missing shot references');
      }
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'resolves page IDs before saving and rejects incomplete or mismatched locators through %s',
    async (protocol) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '就按刚才的方向保存',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '就按刚才的方向保存', undefined, {
        operation: 'document.list',
      });
      let tools = agent.tools;
      let ordinal = 0;
      const invoke = async (name: string, args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `routing-${ordinal}`,
          calls: [
            {
              id: `routing-call-${ordinal++}`,
              name,
              authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
              argumentsJson: JSON.stringify(args),
            },
          ],
        });
        tools = result.tools!;
        return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
      };
      const context = await invoke('project.get_context', {});
      const map = context.resourceMap as ProjectStructureResult;
      expect(
        map.resources.filter((item) => item.kind === 'workspace').map((item) => item.id),
      ).toEqual([
        'workspace:novel',
        'workspace:documents',
        'workspace:characters',
        'workspace:shots',
        'workspace:assets',
        'workspace:tasks',
        'workspace:settings',
      ]);
      const draft = {
        title: '《剑开天门》玄幻短篇小说大纲',
        documentKind: 'outline',
        contentMarkdown: '# 大纲\n\n故事设定。',
      };
      // The actual screenshot call must now fail before any artifact is created.
      const missingPage = await invoke('document.submit_draft', draft);
      expect(missingPage.status).toBe('rejected');
      expect(JSON.stringify(missingPage)).toContain('resourceId is required');
      const missingRole = await invoke('document.submit_draft', {
        ...draft,
        resourceId: 'workspace:novel',
      });
      expect(missingRole.status).toBe('rejected');
      expect(JSON.stringify(missingRole)).toContain('bindingRole');
      expect(
        await invoke('document.submit_draft', {
          ...draft,
          resourceId: 'workspace:documents',
          bindingRole: 'work-outline',
        }),
      ).toMatchObject({ status: 'rejected' });
      expect(workflow.listDocuments()).toHaveLength(0);
      expect(workflow.listTasks()).toHaveLength(1);
      const novel = await invoke('document.submit_draft', {
        ...draft,
        resourceId: map.resources.find((item) => item.locator.workspace === 'novel')!.id,
        bindingRole: 'work-outline',
      });
      expect(novel).toMatchObject({
        status: 'draft_saved',
        domainScope: 'novel',
        bindingRole: 'work-outline',
        locator: {
          workspace: 'novel',
          documentId: novel.documentId,
          versionId: novel.documentVersionId,
          resourceId: `document:${String(novel.documentId)}`,
        },
      });
      expect(workflow.getDocument(novel.documentId as string).domainScope).toBe('novel');
      const script = await invoke('document.submit_draft', {
        ...draft,
        title: '短剧大纲',
        resourceId: 'workspace:documents',
      });
      expect(script).toMatchObject({ status: 'draft_saved', locator: { workspace: 'documents' } });
      expect(workflow.getDocument(script.documentId as string).domainScope).not.toBe('novel');
      const character = await invoke('document.submit_draft', {
        title: '陈缺',
        documentKind: 'character',
        contentMarkdown: '制作立绘提示词。',
        resourceId: 'workspace:characters',
      });
      expect(character).toMatchObject({
        status: 'draft_saved',
        locator: { workspace: 'characters' },
      });
      const current = (await invoke('project.structure.get', {}))
        .resourceMap as ProjectStructureResult;
      const node = current.resources.find(
        (item) => item.kind === 'structure-node' && item.documentId === novel.documentId,
      )!;
      const otherNode = current.resources.find(
        (item) => item.kind === 'structure-node' && item.documentId === script.documentId,
      )!;
      expect(node.locator.workspace).toBe('novel');
      expect(JSON.stringify(current)).not.toContain('故事设定。');
      const update = {
        ...draft,
        resourceId: node.id,
        documentId: node.documentId,
        structureNodeId: node.locator.structureNodeId,
        versionId: node.versionId,
        expectedRevision: current.revision,
        expectedRowVersion: node.rowVersion,
        expectedDocumentRowVersion: node.rowVersion,
        baseVersionId: node.versionId,
        contentMarkdown: '# 修订大纲\n\n新设定。',
      };
      expect(
        await invoke('document.submit_draft', {
          ...update,
          structureNodeId: otherNode.locator.structureNodeId,
        }),
      ).toMatchObject({ status: 'rejected' });
      const revised = await invoke('document.submit_draft', update);
      expect(revised).toMatchObject({
        status: 'draft_saved',
        documentId: novel.documentId,
        locator: { workspace: 'novel' },
      });
      expect(await invoke('document.submit_draft', update)).toMatchObject({
        status: 'draft_saved',
        execution: { replayed: true },
      });
      expect(workflow.listDocuments()).toHaveLength(3);
      expect(workflow.getTask({ taskId: agent.taskId }).documents).toHaveLength(4);
    },
  );
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
      expect(generations.runtime(prepared.stream).context).toContain('可选 UI 目标提示');
      expect(generations.runtime(prepared.stream).systemInstruction).not.toContain(
        '可选 UI 目标提示',
      );
      expect(novels.listChapters()).toHaveLength(0);
      expect(workflow.listDocuments()).toHaveLength(0);
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              'tools.load',
              { names: ['document.list', 'novel.chapter.list', 'novel.chapter.write_draft'] },
              { id: 'load-tools' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'load-response' },
        ),
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
                  resourceId: 'workspace:novel',
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

  it('does not accept repeated navigation or a failed call as checkpoint progress', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const content = new ContentService(project);
    const scene = content.saveScene({ title: '当前场次' });
    const shot = content.saveShot({ sceneId: scene.id, title: '当前镜头' });
    const loop = createSystemLoop(project, workflow);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '核对并处理镜头',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    loop.prepare(prepared.stream, '核对并处理镜头', undefined, { operation: 'document.list' });
    const identity = {
      ...prepared.stream,
      taskId: project.access(
        false,
        (db) =>
          (db.prepare('SELECT id FROM agent_tasks WHERE status=?').get('running') as { id: string })
            .id,
      ),
      toolCallId: 'test-checkpoint',
    };
    const { taskCheckpoint } = await import('./agent-task-checkpoints.js');
    const checkpointArgs = {
      operation: 'save',
      remainingWork: '处理镜头',
      workingNotes: '保持提示词',
    };
    project.access(true, (db, current) => {
      const add = (name: string, result: unknown, status = 'succeeded') =>
        db
          .prepare(
            `INSERT INTO agent_tool_calls
        (id,project_id,task_id,generation_id,tool_name,status,result_summary_json,created_at,normalized_arguments_hash,arguments_summary_json,redaction_state,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,'test','{}','legacy_redacted',?)`,
          )
          .run(
            `evidence-${Math.random()}`,
            current.id,
            identity.taskId,
            prepared.stream.generationId,
            name,
            status,
            JSON.stringify(result),
            new Date().toISOString(),
            `key-${Math.random()}`,
          );
      add('project.structure.get', { resourceMap: { revision: 'same', shots: [shot.id] } });
      const first = taskCheckpoint(db, current.id, checkpointArgs, identity);
      add('conversation.task.checkpoint', first);
      add('project.structure.get', { resourceMap: { revision: 'same', shots: [shot.id] } });
      add('conversation.task.route', { decision: 'independent' });
      add('scene.read', { error: 'bad target' }, 'failed');
      expect(() => taskCheckpoint(db, current.id, checkpointArgs, identity)).toThrow(
        'TASK_CHECKPOINT_NO_PROGRESS',
      );
      add('production.read', {
        status: 'read',
        target: { kind: 'shot', id: shot.id },
        version: 'a'.repeat(64),
        view: 'authoring',
        authoring: { prompt: '新证据' },
      });
      expect(taskCheckpoint(db, current.id, checkpointArgs, identity)).toMatchObject({
        status: 'task_checkpoint_saved',
        evidenceCount: 2,
      });
    });
    loop.terminateGeneration(prepared.stream.generationId, 'cancelled');
    project.access(false, (db, current) =>
      expect(() =>
        taskCheckpoint(
          db,
          current.id,
          {
            operation: 'plan',
            deliverables: [{ key: 'late', toolName: 'document.submit_draft', minimumCount: 1 }],
          },
          identity,
        ),
      ).toThrow('no longer active'),
    );
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'verifies three document kinds and all 16 saved shot bindings before completing (%s)',
    async (protocol) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const content = new ContentService(project);
      const scene = content.saveScene({ title: '已有场次' });
      const shots = Array.from({ length: 16 }, (_, i) =>
        content.saveShot({
          sceneId: scene.id,
          title: `镜${i + 1}`,
          authoringIR: { ...productionFixture('拿起钢笔', 'shot'), kind: 'shot' },
        }),
      );
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '根据镜头提示词创建角色、场景、道具并绑定全部镜头',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '创建资料并绑定全部镜头', undefined, {
        operation: 'document.list',
      });
      let tools = agent.tools;
      let ordinal = 0;
      const invoke = async (name: string, args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `delivery-${ordinal}`,
          calls: [
            {
              id: `delivery-${ordinal++}`,
              name,
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((t) => t.name === name)!.authorizationHandle,
            },
          ],
        });
        tools =
          name === 'production.read'
            ? loop.advanceTextTurn({
                ...prepared.stream,
                providerResponseId: `delivery-read-${ordinal}`,
                finishReason: 'tool_calls',
              })
            : result.tools!;
        return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
      };
      const docs = ['character', 'scene', 'prop'].map((kind) => ({
        key: kind,
        toolName: 'document.submit_draft',
        documentKind: kind,
        minimumCount: 1,
      }));
      expect(
        await invoke('conversation.task.checkpoint', {
          operation: 'plan',
          deliverables: [
            ...docs,
            {
              key: 'bindings',
              toolName: 'scene.update_shot_prompts',
              minimumCount: 16,
              targetIds: shots.map((s) => s.id),
              requireReferences: true,
            },
          ],
        }),
      ).toMatchObject({ status: 'task_plan_saved' });
      loop.startProviderStep(prepared.stream);
      expect(() => loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' })).toThrow(
        'TASK_DELIVERABLES_PENDING',
      );
      const saved: Record<string, unknown>[] = [];
      for (const kind of ['character', 'scene', 'prop'])
        saved.push(
          await invoke('document.submit_draft', {
            resourceId: 'workspace:characters',
            documentKind: kind,
            title: kind,
            contentMarkdown: `# ${kind}\n镜头中的对应资料`,
          }),
        );
      const versions: number[] = [];
      for (const shot of shots) {
        const read = await invoke('production.read', {
          target: { kind: 'shot', id: shot.id },
          view: 'authoring',
        });
        versions.push(read.rowVersion as number);
      }
      const patch = (index: number) => ({
        shotId: shots[index]!.id,
        expectedRowVersion: versions[index],
        authoringIR: {
          ...productionFixture('拿起钢笔', 'shot'),
          references: {
            characterDocumentIds: [saved[0]!.documentId],
            sceneDocumentIds: [saved[1]!.documentId],
            propDocumentIds: [saved[2]!.documentId],
          },
        },
      });
      for (let i = 0; i < 15; i += 5)
        expect(
          await invoke('scene.update_shot_prompts', {
            shots: Array.from({ length: 5 }, (_, j) => patch(i + j)),
          }),
        ).toMatchObject({ status: 'shot_prompts_saved' });
      loop.startProviderStep(prepared.stream);
      expect(() => loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' })).toThrow(
        'TASK_DELIVERABLES_PENDING',
      );
      expect(await invoke('scene.update_shot_prompts', { shots: [patch(15)] })).toMatchObject({
        status: 'shot_prompts_saved',
      });
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
      expect(workflow.getTask({ taskId: agent.taskId }).task).toMatchObject({
        status: 'completed',
      });
      project.access(false, (db) => {
        const actual = db
          .prepare('SELECT authoring_ir_json FROM shots ORDER BY position')
          .all() as Array<{ authoring_ir_json: string }>;
        expect(actual).toHaveLength(16);
        for (const row of actual)
          expect(JSON.parse(row.authoring_ir_json)).toMatchObject({
            prompt: '拿起钢笔',
            timing: { estimatedDurationSeconds: 3 },
            references: {
              characterDocumentIds: [saved[0]!.documentId],
              sceneDocumentIds: [saved[1]!.documentId],
              propDocumentIds: [saved[2]!.documentId],
            },
          });
      });
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'requires verified blockers before ending missing outputs as partial (%s)',
    async (protocol) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '创建角色资料',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '创建角色资料', undefined, {
        operation: 'document.list',
      });
      let tools = agent.tools;
      project.access(true, (db, p) => {
        const store = new AgentContextStore(db);
        for (const retryable of [true, false])
          store.putResult(
            p.id,
            agent.taskId,
            `blocker-${retryable}`,
            'document.submit_draft',
            JSON.stringify({ status: 'rejected', error: { retryable } }),
            {},
            'failed',
          );
        store.putResult(
          p.id,
          'other-task',
          'other-blocker',
          'document.submit_draft',
          JSON.stringify({ status: 'rejected', error: { retryable: false } }),
          {},
          'failed',
        );
      });
      for (const [i, args] of [
        {
          operation: 'plan',
          deliverables: [
            {
              key: 'actor',
              toolName: 'document.submit_draft',
              documentKind: 'character',
              minimumCount: 1,
            },
          ],
        },
        { operation: 'partial', reason: '模型声称不可写' },
        { operation: 'partial', reason: '参数错误', blockedByCallId: 'blocker-true' },
        { operation: 'partial', reason: '其他任务的错误', blockedByCallId: 'other-blocker' },
        {
          operation: 'partial',
          reason: '当前资料目标不可写，需要先解除发布状态',
          blockedByCallId: 'blocker-false',
        },
      ].entries()) {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `partial-${i}`,
          calls: [
            {
              id: `partial-${i}`,
              name: 'conversation.task.checkpoint',
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((t) => t.name === 'conversation.task.checkpoint')!
                .authorizationHandle,
            },
          ],
        });
        tools = result.tools!;
        expect(result.continuation!.outputs[0]!.output).toContain(
          i === 0 ? 'task_plan_saved' : i === 4 ? 'task_partial_reported' : 'TASK_REPAIR_REQUIRED',
        );
        if (i === 1) {
          // Historical accepted reports are audit evidence, not permission to stop now.
          loop.startProviderStep(prepared.stream);
          const historical = await loop.executeTools({
            ...prepared.stream,
            providerResponseId: 'legacy-partial-source',
            calls: [
              {
                id: 'legacy-partial-source',
                name: 'conversation.task.checkpoint',
                argumentsJson: JSON.stringify({ operation: 'state' }),
                authorizationHandle: tools.find((t) => t.name === 'conversation.task.checkpoint')!
                  .authorizationHandle,
              },
            ],
          });
          tools = historical.tools!;
          project.access(true, (db) =>
            db
              .prepare(
                'UPDATE agent_tool_calls SET result_summary_json=? WHERE task_id=? AND provider_call_id=?',
              )
              .run(
                JSON.stringify({ status: 'task_partial_reported', reason: '旧版本声称受阻' }),
                agent.taskId,
                'legacy-partial-source',
              ),
          );
          loop.startProviderStep(prepared.stream);
          expect(() =>
            loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
          ).toThrow('TASK_DELIVERABLES_PENDING');
        }
      }
      loop.startProviderStep(prepared.stream);
      loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' });
      expect(workflow.getTask({ taskId: agent.taskId }).task).toMatchObject({
        status: 'completed',
        completionState: 'partial',
        outcome: 'read-only',
        errorMessage: '当前资料目标不可写，需要先解除发布状态',
      });
      expect(workflow.listDocuments()).toHaveLength(0);
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

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'saves ordinary scene submissions as editable drafts without approval through %s',
    async (protocol) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '按刚才商量的保存',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, '按刚才商量的保存', undefined, {
        operation: 'document.list',
      });
      // This scenario also exercises failed proposals and the new on-demand reads.
      let tools = agent.tools;
      let ordinal = 0;
      const invoke = async (name: string, args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `scene-response-${ordinal}`,
          calls: [
            {
              id: `scene-call-${ordinal++}`,
              name,
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
            },
          ],
        });
        expect(result.confirmation).toBeUndefined();
        tools = result.tools!;
        return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
      };
      const slots = project.access(true, (db, p) => {
        const store = new AgentExecutionStore(db);
        return Object.fromEntries(
          ['scene', 'prop', 'character'].map((kind) => [
            kind,
            store.registerOutput(p.id, agent.taskId, kind, 'document.submit_draft', 2),
          ]),
        );
      });
      const courtyard = await invoke('document.submit_draft', {
        resourceId: 'workspace:characters',
        documentKind: 'scene',
        outputKey: 'scene',
        outputIndex: 0,
        title: '庭院',
        contentMarkdown: '# 庭院\n清晨或夜间的院落',
      });
      const study = await invoke('document.submit_draft', {
        resourceId: 'workspace:characters',
        documentKind: 'scene',
        outputKey: 'scene',
        outputIndex: 1,
        title: '书房',
        contentMarkdown: '# 书房\n木桌和信件',
      });
      const walkingStick = await invoke('document.submit_draft', {
        resourceId: 'workspace:characters',
        documentKind: 'prop',
        outputId: slots.prop,
        outputIndex: 0,
        title: '铁木杖道具设定',
        contentMarkdown: '# 铁木杖\n杖尖包有铁箍。',
        contentIR: {
          schemaVersion: 1,
          kind: 'prop',
          data: { material: '铁木', tip: '铁箍' },
        },
      });
      const driver = await invoke('document.submit_draft', {
        resourceId: 'workspace:characters',
        documentKind: 'character',
        outputId: slots.character,
        outputIndex: 0,
        title: '角色：老周（司机）',
        contentMarkdown: '# 老周\n熟悉旧事的司机。',
      });
      const colleague = await invoke('document.submit_draft', {
        resourceId: 'workspace:characters',
        documentKind: 'character',
        outputId: slots.character,
        outputIndex: 1,
        title: '角色：张明（前同事）',
        contentMarkdown: '# 张明\n揭露真相的人。',
      });
      const structure = await invoke('project.structure.get', {});
      const map = structure.resourceMap as ProjectStructureResult;
      expect(map.resources.find((item) => item.id === 'workspace:shots')?.writeTool).toBe(
        'scene.submit_structure',
      );
      const scenes = [
        {
          title: '庭院',
          authoringIR: {
            schemaVersion: 1,
            kind: 'scene',
            prompt: '他走过院落。',
            references: {
              characterDocumentIds: [driver.documentId, colleague.documentId],
              sceneDocumentIds: [courtyard.documentId],
              propDocumentIds: [walkingStick.documentId],
            },
            data: { blocking: '门外的身影由近至远' },
          },
          characterDocumentIds: [driver.documentId, colleague.documentId],
          sceneDocumentId: courtyard.documentId,
          shots: [
            {
              title: '远景',
              authoringIR: {
                schemaVersion: 1,
                kind: 'shot',
                prompt: '清晨的庭院，人物从门外走入。',
                references: {
                  characterDocumentIds: [driver.documentId],
                  propDocumentIds: [walkingStick.documentId],
                },
                data: { camera: '固定中远景' },
              },
            },
            {
              title: '近景',
              authoringIR: productionFixture('门上的霜', 'shot'),
            },
          ],
        },
        {
          title: '书房',
          authoringIR: productionFixture('书桌上的信。'),
          characterDocumentIds: [],
          sceneDocumentId: study.documentId,
          shots: [
            {
              title: '特写',
              authoringIR: productionFixture('桌上的信', 'shot'),
            },
          ],
        },
      ];
      expect(await invoke('production.defaults.get', {})).toMatchObject({
        rowVersion: 0,
        settings: {},
      });
      expect(
        await invoke('scene.submit_structure', {
          resourceId: 'workspace:shots',
          resolution: 'resolved',
          episodeTitle: '缺少详细结构',
          scenes: [
            {
              ...scenes[0],
              authoringIR: undefined,
            },
          ],
        }),
      ).toMatchObject({ status: 'rejected' });
      for (const args of [
        { resolution: 'resolved', episodeTitle: '第1集', scenes },
        { resourceId: 'workspace:novel', episodeTitle: '第1集', scenes },
        { resourceId: 'workspace:shots', episodeTitle: '第1集', scenes, expectedRevision: 'stale' },
        {
          resourceId: 'workspace:shots',
          episodeTitle: '第1集',
          scenes: [{ title: '未绑定', shots: [{ title: '远景', prompt: '院落' }] }],
        },
        {
          resourceId: 'workspace:shots',
          episodeTitle: '第1集',
          scenes: [{ title: '空场次', shots: [] }],
        },
      ])
        expect(await invoke('scene.submit_structure', args)).toMatchObject({ status: 'rejected' });
      expect(new ChangeSetService(project).list()).toHaveLength(0);
      expect(
        await invoke('document.submit_draft', {
          resourceId: 'workspace:shots',
          title: '不可见的分镜',
          documentKind: 'storyboard',
          contentMarkdown: '# 场次\n## 镜头',
        }),
      ).toMatchObject({ status: 'rejected' });
      expect(workflow.listDocuments()).toHaveLength(5);
      expect(
        workflow.getDocument(walkingStick.documentId as string).currentVersion?.contentIR,
      ).toEqual({
        schemaVersion: 1,
        kind: 'prop',
        data: { material: '铁木', tip: '铁箍' },
      });
      const clarified = await invoke('scene.submit_structure', {
        resourceId: 'workspace:shots',
        resolution: 'needs_clarification',
        episodeTitle: '人物待确认',
        scenes: [],
        feedback: '“他”指的是司机还是前同事？',
      });
      expect(clarified).toMatchObject({
        status: 'scene_bindings_need_clarification',
        applied: false,
        feedback: '“他”指的是司机还是前同事？',
      });
      expect(new ChangeSetService(project).list()).toHaveLength(0);
      const saved = await invoke('scene.submit_structure', {
        resourceId: 'workspace:shots',
        resolution: 'resolved',
        expectedRevision: map.revision,
        episodeTitle: '第1集',
        scenes,
      });
      expect(saved).toMatchObject({
        status: 'scene_structure_saved',
        reviewRequired: false,
        applied: true,
        locator: { workspace: 'shots', changeSetId: saved.changeSetId },
      });
      const content = new ContentService(project);
      expect(content.listScenes()).toHaveLength(2);
      expect(new ChangeSetService(project).list()).toHaveLength(0);
      const proposal = new ChangeSetService(project).list({ includeTerminal: true })[0]!;
      expect(workflow.getTask({ taskId: agent.taskId }).changeSets).toEqual([
        expect.objectContaining({ changeSetId: proposal.id, status: 'applied' }),
      ]);
      expect(proposal.status).toBe('applied');
      const parents = content.listScenes();
      expect(parents.find((item) => item.title === '庭院')?.sceneDocumentId).toBe(
        courtyard.documentId,
      );
      expect(parents.find((item) => item.title === '书房')?.sceneDocumentId).toBe(study.documentId);
      const courtyardScene = parents.find((item) => item.title === '庭院')!;
      const production = await invoke('production.read', {
        target: { kind: 'scene', id: courtyardScene.id },
      });
      expect(production.authoring).toMatchObject({
        schemaVersion: 1,
        kind: 'scene',
        prompt: '他走过院落。',
      });
      expect(production.source).toBeUndefined();
      expect(courtyardScene.videoPrompt).toContain('他走过院落。');
      expect(courtyardScene.characterBindings).toEqual([
        { characterDocumentId: driver.documentId },
        { characterDocumentId: colleague.documentId },
      ]);
      expect(await invoke('scene.read', { sceneId: courtyardScene.id })).toMatchObject({
        scene: {
          id: courtyardScene.id,
          hasPrompt: true,
          characterBindings: courtyardScene.characterBindings,
        },
      });
      expect(
        content
          .listShots(parents.find((item) => item.title === '庭院')!.id)
          .map((item) => item.prompt?.split('\n')[0]),
      ).toEqual(['清晨的庭院，人物从门外走入。', '门上的霜']);
      expect(
        content
          .listShots(parents.find((item) => item.title === '书房')!.id)
          .map((item) => item.prompt?.split('\n')[0]),
      ).toEqual(['桌上的信']);
      const revision = {
        resourceId: 'workspace:shots',
        resolution: 'resolved',
        episodeTitle: '调整本场',
        scenes: [
          {
            sceneId: courtyardScene.id,
            expectedRowVersion: courtyardScene.rowVersion,
            title: courtyardScene.title,
            authoringIR: productionFixture('前同事独自留下。'),
            sceneDocumentId: study.documentId,
            characterDocumentIds: [colleague.documentId],
            shots: [],
          },
        ],
      };
      const updated = await invoke('scene.submit_structure', revision);
      expect(updated).toMatchObject({
        status: 'scene_structure_saved',
        applied: true,
        reviewRequired: false,
      });
      expect(new ChangeSetService(project).list()).toHaveLength(0);
      expect(content.listScenes()).toHaveLength(2);
      expect(content.listScenes().find((item) => item.id === courtyardScene.id)).toMatchObject({
        sceneDocumentId: study.documentId,
        characterBindings: [{ characterDocumentId: colleague.documentId }],
      });
      expect(content.listShots(courtyardScene.id)).toHaveLength(2);
      expect(await invoke('scene.submit_structure', revision)).toMatchObject({
        status: 'scene_structure_saved',
        execution: { replayed: true },
      });
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
      expect(content.listScenes()).toHaveLength(2);
      expect(workflow.getTask({ taskId: agent.taskId }).task.outcome).not.toBe('read-only');
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
    const common = {
      resourceId: `document:${chapter.documentId}`,
      title: '不要归档的雾港',
      contentMarkdown: '修订正文',
    };
    for (const args of [
      {
        ...common,
        resourceId: 'workspace:novel',
        action: 'create_chapter',
        volumeId: 'foreign-or-missing-volume',
      },
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
      { ...common, resourceId: 'workspace:novel', action: 'create_chapter', unexpectedField: true },
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
              resourceId: i === 0 ? 'workspace:novel' : 'workspace:characters',
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
            resourceId: `document:${existing.id}`,
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
              resourceId: `document:${chapter.documentId}`,
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

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'reads multiple scenes and instructions before a batch revision beyond sixteen calls (%s)',
    async (protocol) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const content = new ContentService(project);
      const scenes = Array.from({ length: 3 }, (_, i) =>
        content.saveScene({ title: `场 ${i + 1}` }),
      );
      const shots = scenes.flatMap((scene) =>
        Array.from({ length: 4 }, (_, i) =>
          content.saveShot({ sceneId: scene.id, title: `镜 ${i + 1}` }),
        ),
      );
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '更新已有场镜',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      let tools = loop.prepare(prepared.stream, '更新已有场镜', undefined, {
        operation: 'document.list',
      }).tools;
      let ordinal = 0;
      const invoke = async (name: string, argumentsList: unknown[]) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `revision-${ordinal}`,
          calls: argumentsList.map((args) => ({
            id: `revision-${ordinal++}`,
            name,
            argumentsJson: JSON.stringify(args),
            authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
          })),
        });
        tools =
          name === 'scene.read' || name === 'production.read'
            ? loop.advanceTextTurn({
                ...prepared.stream,
                providerResponseId: `read-response-${ordinal}`,
                finishReason: 'tool_calls',
              })
            : result.tools!;
        return result.continuation!.outputs.map(
          (entry) => JSON.parse(entry.output) as Record<string, unknown>,
        );
      };
      expect(
        await invoke(
          'scene.read',
          scenes.slice(0, 2).map((scene) => ({ sceneId: scene.id })),
        ),
      ).toHaveLength(2);
      expect(await invoke('scene.read', [{ sceneId: scenes[2]!.id }])).toHaveLength(1);
      const targets = [
        ...scenes.map((scene) => ({ kind: 'scene' as const, id: scene.id })),
        ...shots.map((shot) => ({ kind: 'shot' as const, id: shot.id })),
      ];
      const versions: number[] = [];
      for (let offset = 0; offset < targets.length; offset += 6) {
        const read = await invoke(
          'production.read',
          targets.slice(offset, offset + 6).map((target) => ({ target })),
        );
        versions.push(...read.map((entry) => entry.rowVersion as number));
      }
      const sceneResult = await invoke('scene.submit_structure', [
        {
          resourceId: 'workspace:shots',
          resolution: 'resolved',
          episodeTitle: '修订',
          scenes: scenes.map((scene, i) => ({
            sceneId: scene.id,
            title: scene.title,
            expectedRowVersion: versions[i],
            authoringIR: productionFixture('保持已有剧情与对白'),
            shots: [],
          })),
        },
      ]);
      expect(sceneResult[0]).toMatchObject({ status: 'scene_structure_saved' });
      const saved = await invoke('scene.update_shot_prompts', [
        {
          shots: shots.map((shot, i) => ({
            shotId: shot.id,
            expectedRowVersion: versions[i + scenes.length],
            authoringIR: productionFixture('保持已有剧情与对白', 'shot'),
          })),
        },
      ]);
      expect(saved[0]).toMatchObject({ status: 'shot_prompts_saved', changedCount: 12 });
      expect(content.listScenes()).toHaveLength(3);
      expect(content.listScenes().flatMap((scene) => content.listShots(scene.id))).toHaveLength(12);
      project.access(false, (db) => {
        expect(
          db
            .prepare(
              `SELECT tool_call_count FROM agent_task_usage_counters
               WHERE task_id=(SELECT id FROM agent_tasks WHERE status='running')`,
            )
            .get(),
        ).toEqual({ tool_call_count: 20 });
        expect(
          db.prepare('SELECT COUNT(*) AS n FROM shots WHERE authoring_ir_json IS NOT NULL').get(),
        ).toEqual({ n: 12 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_task_events WHERE event_type='agent.policy.rejected'",
            )
            .get(),
        ).toEqual({ n: 0 });
      });
    },
  );

  it.each(
    (['openai-responses', 'openai-chat-completions'] as const).flatMap((protocol) =>
      (['scene.update_shot_timings', 'scene.update_shot_prompts'] as const).map((operation) => ({
        protocol,
        operation,
      })),
    ),
  )(
    'patches 15 existing shots with CAS, failure recovery and a refresh event ($protocol, $operation)',
    async ({ protocol, operation }) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const content = new ContentService(project);
      const scenes = Array.from({ length: 4 }, (_, i) => content.saveScene({ title: `场次${i}` }));
      const shots = scenes.flatMap((scene, i) =>
        Array.from({ length: i === 3 ? 3 : 4 }, (_, j) =>
          content.saveShot({
            sceneId: scene.id,
            title: `镜头${i}-${j}`,
            authoringIR: {
              schemaVersion: 1,
              kind: 'shot',
              prompt: `人物动作${i}-${j}`,
              data: { custom: '保留内容' },
            },
          }),
        ),
      );
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '每个镜头应该设置时间',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const task = loop.prepare(prepared.stream, '每个镜头应该设置时间', undefined, {
        operation: 'document.list',
      });
      let tools = task.tools;
      let ordinal = 0;
      const invoke = async (name: string, args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const responseId = `timing-response-${ordinal}`;
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: responseId,
          calls: [
            {
              id: `timing-${ordinal++}`,
              name,
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
            },
          ],
        });
        expect(result.confirmation).toBeUndefined();
        tools =
          name === 'scene.read'
            ? loop.advanceTextTurn({
                ...prepared.stream,
                providerResponseId: responseId,
                finishReason: 'tool_calls',
              })
            : result.tools!;
        return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
      };
      const versions = new Map<string, number>();
      for (const scene of scenes) {
        const structure = await invoke('scene.read', { sceneId: scene.id });
        expect(structure.complete).toBe(true);
        for (const shot of structure.shots as Array<{ id: string; rowVersion: number }>)
          versions.set(shot.id, shot.rowVersion);
      }
      const updates = shots.map((shot) => ({
        shotId: shot.id,
        expectedRowVersion: versions.get(shot.id),
        ...(operation === 'scene.update_shot_timings'
          ? { estimatedDurationSeconds: 5, rationale: '动作及反应停顿' }
          : {
              authoringIR: {
                schemaVersion: 1,
                kind: 'shot',
                prompt: `${shot.prompt}，固定机位，无配乐。`,
              },
            }),
      }));
      const failed = await invoke(operation, {
        shots: updates.map((shot, i) => (i === 14 ? { ...shot, expectedRowVersion: 999 } : shot)),
      });
      expect(failed.status).toBe('rejected');
      expect(scenes.flatMap((scene) => content.listShots(scene.id))).toEqual(shots);
      loop.startProviderStep(prepared.stream);
      expect(() => loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' })).toThrow(
        AgentTaskContinuationRequired,
      );
      const saved = await invoke(operation, { shots: updates });
      expect(saved).toMatchObject({
        status:
          operation === 'scene.update_shot_prompts' ? 'shot_prompts_saved' : 'shot_timings_saved',
        changedCount: 15,
      });
      loop.startProviderStep(prepared.stream);
      expect(() =>
        loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' }),
      ).not.toThrow();
      project.access(false, (db) => {
        expect(
          db.prepare('SELECT status,outcome FROM agent_tasks WHERE id=?').get(task.taskId),
        ).toEqual({ status: 'completed', outcome: null });
        expect(
          db
            .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id=?')
            .get(task.taskId),
        ).toEqual({ tool_call_count: 6 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_task_events WHERE task_id=? AND event_type='scene.structure.saved'",
            )
            .get(task.taskId),
        ).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toEqual({ n: 15 });
      });
    },
  );

  it('ignores the legacy task quota while still rejecting handles from an earlier Provider step', async () => {
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
      database
        .prepare(
          `UPDATE agent_tasks SET tool_call_limit=1, quota_state='paused_budget',
           quota_error_code='AGENT_TOOL_QUOTA_EXHAUSTED' WHERE id=?`,
        )
        .run(agent.taskId),
    );
    loop.reserveTurn(prepared.stream);
    const old = agent.tools.find((tool) => tool.name === 'document.submit_draft')!;
    const slot = project.access(true, (db, p) =>
      new AgentExecutionStore(db).registerOutput(
        p.id,
        agent.taskId,
        'notes',
        'document.submit_draft',
        2,
      ),
    );
    const args = JSON.stringify({
      resourceId: 'workspace:documents',
      title: '已授权草稿',
      outputId: slot,
      outputIndex: 0,
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
    const second = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'quota-new',
      calls: [
        {
          id: 'quota-second',
          name: fresh.name,
          authorizationHandle: fresh.authorizationHandle,
          argumentsJson: JSON.stringify({
            resourceId: 'workspace:documents',
            title: '第二份已授权草稿',
            outputId: slot,
            outputIndex: 1,
            contentMarkdown: '第二份独立完整内容',
            documentKind: 'note',
          }),
        },
      ],
    });
    expect(second.continuation!.outputs[0]!.output).toContain('draft_saved');
    expect(workflow.listDocuments()).toHaveLength(2);
    expect(
      project.access(false, (db) =>
        db
          .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id=?')
          .get(agent.taskId),
      ),
    ).toEqual({ tool_call_count: 2 });
    expect(
      project.access(false, (db) =>
        db
          .prepare('SELECT quota_state, quota_error_code FROM agent_tasks WHERE id=?')
          .get(agent.taskId),
      ),
    ).toEqual({ quota_state: 'active', quota_error_code: null });
    expect(workflow.listTasks()).toHaveLength(3);
  });

  it('persists Agent usage beyond the former turn cap and de-duplicates Provider usage by request', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '保存一份草稿',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '保存一份草稿');
    const identity = prepared.stream;

    for (let index = 0; index < 30; index += 1) loop.reserveTurn(identity);

    const usage = {
      inputTokens: 12,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 19,
      providerReportedCost: { amount: '0.125', currency: 'USD' },
    };
    loop.recordProviderUsage(identity, 'request-1', usage);
    loop.recordProviderUsage(identity, 'request-1', usage);
    const row = project.access(false, (database) =>
      database
        .prepare(
          `SELECT tasks.turn_count,tasks.input_tokens,tasks.output_tokens,tasks.reasoning_tokens,
                  tasks.total_tokens,tasks.provider_reported_cost,tasks.quota_state,
                  tasks.quota_error_code,COUNT(usage.request_id) AS requests
           FROM agent_tasks tasks LEFT JOIN agent_task_usage usage ON usage.task_id=tasks.id
           WHERE tasks.id=? GROUP BY tasks.id`,
        )
        .get(agent.taskId),
    ) as {
      turn_count: number;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
      provider_reported_cost: string;
      quota_state: string;
      quota_error_code: string | null;
      requests: number;
    };
    expect(row).toMatchObject({
      turn_count: 30,
      input_tokens: 12,
      output_tokens: 5,
      reasoning_tokens: 2,
      total_tokens: 19,
      provider_reported_cost: '0.125',
      quota_state: 'active',
      quota_error_code: null,
      requests: 1,
    });
    expect(
      new DocumentWorkflowService(project).getTask({ taskId: agent.taskId }).task.usage,
    ).toEqual({
      providerRequestsUsed: 30,
      toolCallsUsed: 0,
      state: 'active',
    });
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

  it('submits a reviewed generation form once with the exact edited parameters', async () => {
    const { conversation, generations, loop, project, nativeRequest } = await setupMedia();
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
    await expect(
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
    ).rejects.toThrow('current project session');
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
    const resumed = await loop.selectMedia({
      ...prepared.stream,
      selectionToken: paused.mediaSelection!.selectionToken,
      selection: {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: { prompt: '用户审核后修改的电影感龙飞行镜头' },
      },
    });
    const output = resumed.continuation!.outputs[0]!.output;

    expect(JSON.parse(output)).toEqual({
      version: 1,
      status: 'polling',
      taskId: expect.any(String) as string,
      resultAssetIds: [],
    });
    expect(resumed.mediaSubmission).toBeUndefined();
    expect(nativeRequest).toHaveBeenCalledExactlyOnceWith(
      'provider.media.submit',
      expect.objectContaining({
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        remoteModelId: candidate.remoteModelId,
        adapterKey: adapter.key,
        parameters: expect.objectContaining({
          prompt: '用户审核后修改的电影感龙飞行镜头',
        }) as AdapterParameters,
      }),
      10 * 60 * 1000,
    );
    expect(output).not.toMatch(/data:image|base64|[A-Z]:\\|credential|api[_-]?key/iu);
    expect(
      project.access(false, (database) =>
        database
          .prepare(
            'SELECT status, media_state, provider_task_id, task_snapshot_json FROM generation_jobs',
          )
          .get(),
      ),
    ).toMatchObject({
      status: 'polling',
      media_state: 'polling',
      provider_task_id: 'provider-task-private',
    });
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status FROM agent_media_selections').get(),
      ),
    ).toEqual({ status: 'consumed' });
    await expect(
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
    ).rejects.toThrow('already been resolved');
    expect(nativeRequest).toHaveBeenCalledOnce();
    const submitTool = resumed.tools!.find((tool) => tool.name === 'media.generation.submit')!;
    const duplicate = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'duplicate-submission-response',
      calls: [
        {
          id: 'duplicate-submission-call',
          name: 'media.generation.submit',
          authorizationHandle: submitTool.authorizationHandle,
          argumentsJson: JSON.stringify({
            taskId: (JSON.parse(output) as { taskId: string }).taskId,
          }),
        },
      ],
    });
    expect(duplicate.mediaSubmission).toBeUndefined();
    expect(JSON.parse(duplicate.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'polling',
    });
    expect(nativeRequest).toHaveBeenCalledOnce();
  });

  it('claims the reviewed selection before waiting for the Provider and rejects concurrent replay', async () => {
    const base = await setupMedia(true, 'openai-chat-completions');
    const params = await stageMediaForm(base);
    let release!: (response: unknown) => void;
    base.nativeRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = base.loop.selectMedia(params);
    await vi.waitFor(() => expect(base.nativeRequest).toHaveBeenCalledOnce());
    await expect(base.loop.selectMedia(params)).rejects.toThrow('already been resolved');
    const job = base.project.access(false, (db) =>
      db
        .prepare(
          'SELECT id, media_state, submission_idempotency_key, submission_confirmation_consumed_at FROM generation_jobs',
        )
        .get(),
    ) as {
      id: string;
      media_state: string;
      submission_idempotency_key: string;
      submission_confirmation_consumed_at: string;
    };
    expect(job).toMatchObject({
      media_state: 'submitting',
      submission_idempotency_key: `media-submit:${job.id}`,
      submission_confirmation_consumed_at: expect.any(String) as string,
    });
    release({ status: 200, taskId: 'provider-task-private' });
    const result = await running;
    expect(result.mediaSubmission).toBeUndefined();
    expect(result.continuation?.protocol).toBe('openai-chat-completions');
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'polling',
    });
    expect(base.nativeRequest).toHaveBeenCalledOnce();
    expect(
      base.project.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 1 });
  });

  it('does not submit or create a job when the user cancels the form', async () => {
    const base = await setupMedia();
    const params = await stageMediaForm(base);
    const result = await base.loop.selectMedia({ ...params, selection: undefined });
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'cancelled',
    });
    expect(base.nativeRequest).not.toHaveBeenCalled();
    expect(
      base.project.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('rejects invalid reviewed parameters without submitting or leaving an orphan draft', async () => {
    const base = await setupMedia();
    const params = await stageMediaForm(base);
    const result = await base.loop.selectMedia({
      ...params,
      selection: { ...params.selection, parameters: { duration: -100 } },
    });
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'rejected',
    });
    expect(base.nativeRequest).not.toHaveBeenCalled();
    expect(
      base.project.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('rolls back job preparation if the existing submission service refuses admission', async () => {
    const base = await setupMedia();
    const params = await stageMediaForm(base);
    vi.spyOn(base.mediaSubmission, 'requestSubmission').mockImplementation(() => {
      throw new Error('Submission admission rejected');
    });
    const result = await base.loop.selectMedia(params);
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'rejected',
    });
    expect(base.nativeRequest).not.toHaveBeenCalled();
    expect(
      base.project.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('returns submission_unknown after a lost response without retrying the reviewed task', async () => {
    const base = await setupMedia();
    const params = await stageMediaForm(base);
    base.nativeRequest.mockRejectedValue(new Error('Connection lost after request'));
    const result = await base.loop.selectMedia(params);
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'submission_unknown',
    });
    expect(result.mediaSubmission).toBeUndefined();
    await expect(base.loop.selectMedia(params)).rejects.toThrow('already been resolved');
    expect(base.nativeRequest).toHaveBeenCalledOnce();
  });

  it('reports a submission exception with the persisted task state and no extra confirmation', async () => {
    const base = await setupMedia();
    const params = await stageMediaForm(base);
    vi.spyOn(base.mediaSubmission, 'confirmSubmission').mockRejectedValue(
      new Error('Frozen source changed'),
    );
    const result = await base.loop.selectMedia(params);
    expect(JSON.parse(result.continuation!.outputs[0]!.output)).toMatchObject({
      status: 'awaiting_confirmation',
      error: { code: 'MEDIA_SUBMISSION_FAILED', message: 'Frozen source changed' },
    });
    expect(result.mediaSubmission).toBeUndefined();
    expect(base.nativeRequest).not.toHaveBeenCalled();
    await expect(base.loop.selectMedia(params)).rejects.toThrow('already been resolved');
  });

  it.each([
    {
      state: 'failed',
      response: { status: 400, body: { error: { message: 'Provider rejected image' } } },
    },
    {
      state: 'succeeded',
      response: { status: 200, body: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] } },
    },
  ])(
    'submits a reviewed image and reports $state without another form',
    async ({ state, response }) => {
      const base = await setupMedia(true, 'openai-responses', 'image');
      const params = await stageMediaForm(base, 'image');
      base.nativeRequest.mockResolvedValue(response);
      const result = await base.loop.selectMedia(params);
      const output = JSON.parse(result.continuation!.outputs[0]!.output) as {
        status: string;
        resultAssetIds: string[];
      };
      expect(output).toMatchObject({ status: state });
      expect(output.resultAssetIds).toHaveLength(state === 'succeeded' ? 1 : 0);
      expect(result.mediaSubmission).toBeUndefined();
      expect(base.nativeRequest).toHaveBeenCalledExactlyOnceWith(
        'provider.media.submit',
        expect.objectContaining({
          kind: 'image',
          parameters: expect.objectContaining({
            prompt: 'User edited prompt',
          }) as AdapterParameters,
        }),
        10 * 60 * 1000,
      );
    },
  );

  it.each(['another-project', 'reopened-session'] as const)(
    'does not continue the old Agent task after $0 during submission',
    async (change) => {
      const base = await setupMedia();
      const params = await stageMediaForm(base);
      let release!: (response: unknown) => void;
      base.nativeRequest.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const running = base.loop.selectMedia(params);
      await vi.waitFor(() => expect(base.nativeRequest).toHaveBeenCalledOnce());
      if (change === 'another-project') {
        const otherDirectory = await mkdtemp(join(tmpdir(), 'media-other-project-'));
        directories.push(otherDirectory);
        base.project.create(join(otherDirectory, 'project'), 'Another project');
      } else {
        base.project.open(base.project.current()!.rootPath);
      }
      release({ status: 200, taskId: 'provider-task-private' });
      await expect(running).rejects.toThrow('Project session changed');
      expect(
        base.project.access(false, (db) =>
          db.prepare('SELECT COUNT(*) AS count FROM generation_jobs').get(),
        ),
      ).toEqual({ count: change === 'another-project' ? 0 : 1 });
      expect(
        base.project.access(false, (db) =>
          db.prepare('SELECT COUNT(*) AS count FROM llm_provider_steps').get(),
        ),
      ).toEqual({ count: change === 'another-project' ? 0 : 1 });
    },
  );

  it('still requires approval when the Agent submits an existing unreviewed draft', async () => {
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
    const context = base.media.selectionContext('video', { prompt }, prepared.stream);
    const candidate = context.candidates[0]!;
    const adapter = candidate.adapters[0]!;
    const draft = base.media.prepareSelected(
      context,
      {
        providerProfileId: candidate.providerProfileId,
        modelId: candidate.modelId,
        adapterKey: adapter.key,
        parameters: {},
      },
      prepared.stream,
    );
    const submitTool = agent.tools.find((tool) => tool.name === 'media.generation.submit')!;
    loop.startProviderStep(prepared.stream);
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
          argumentsJson: JSON.stringify({ taskId: draft.draftId }),
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
      jobId: draft.draftId,
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
      taskId: draft.draftId,
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
        jobId: draft.draftId,
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
          argumentsJson: JSON.stringify({ taskId: draft.draftId }),
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
      taskId: draft.draftId,
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

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'opens image selection on the first call for a compressed attachment with a legacy MIME label (%s)',
    async (protocol) => {
      const base = await setupMedia(true, protocol, 'image');
      const prompt = '保留全部用户要求和参考图；生成抽出短刀时的定格画面。';
      const dataUrl = 'data:image/jpeg;base64,/9j/4AAB';
      const prepared = base.generations.prepare({
        conversationId: base.conversation.id,
        prompt,
        providerProfileId: 'agent-profile',
        modelId: 'agent-model',
        attachments: [{ name: 'reference.png', mimeType: 'image/png', dataUrl }],
      });
      const tool = base.loop
        .prepare(prepared.stream, prompt)
        .tools.find((tool) => tool.name === 'media.image.prepare')!;
      base.loop.startProviderStep(prepared.stream);
      const result = await base.loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'first-response',
        calls: [
          {
            id: 'first-prepare',
            name: tool.name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify({ prompt }),
          },
        ],
      });
      expect(result.mediaSelection).toMatchObject({ prompt, inputAttachmentCount: 1 });
      expect(result.mediaSelection!.candidates.length).toBeGreaterThan(0);
      expect(base.generations.runtime(prepared.stream).attachments).toEqual([
        { name: 'reference.png', mimeType: 'image/png', dataUrl },
      ]);
      expect(
        base.project.access(false, (db) => ({
          selections: db.prepare('SELECT count(*) AS count FROM agent_media_selections').get(),
          calls: db.prepare('SELECT count(*) AS count FROM agent_tool_calls').get(),
          jobs: db.prepare('SELECT count(*) AS count FROM generation_jobs').get(),
          rejections: db
            .prepare(
              "SELECT count(*) AS count FROM agent_task_events WHERE event_type='agent.policy.rejected'",
            )
            .get(),
        })),
      ).toEqual({
        selections: { count: 1 },
        calls: { count: 1 },
        jobs: { count: 0 },
        rejections: { count: 0 },
      });
      expect(base.nativeRequest).not.toHaveBeenCalled();
    },
  );

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

    await expect(
      loop.selectMedia({
        ...prepared.stream,
        conversationId: anotherConversation.id,
        selectionToken: paused.mediaSelection!.selectionToken,
        selection: undefined,
      }),
    ).rejects.toThrow('current project session');
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

    await expect(
      loop.selectMedia({
        ...prepared.stream,
        selectionToken: paused.mediaSelection!.selectionToken,
        selection: undefined,
      }),
    ).rejects.toThrow('expired');
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
        AgentTaskContinuationRequired,
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
        AgentTaskContinuationRequired,
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
          [
            fauxToolCall(
              'tools.load',
              { names: ['novel.chapter.submit_draft'] },
              { id: 'load-tools' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'load-response' },
        ),
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
          : [
              fauxAssistantMessage('已了解背景。你想续写还是重写？'),
              fauxAssistantMessage(
                [fauxToolCall('library.search', { query: '已有故事设定' }, { id: 'lookup-again' })],
                { stopReason: 'toolUse', responseId: 'lookup-again-response' },
              ),
              fauxAssistantMessage('仍未提交章节正文。'),
            ]),
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
        expect(result.error).toContain('AGENT_TASK_CONTINUATION_STALLED');
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
          : [
              { tool_name: 'library.search', status: 'succeeded' },
              { tool_name: 'library.search', status: 'succeeded' },
            ],
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
        fauxAssistantMessage(
          [
            fauxToolCall(
              'tools.load',
              { names: ['novel.chapter.submit_draft', 'project.get_context'] },
              { id: 'load-tools' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'load-response' },
        ),
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
      expect(
        generations.get(prepared.stream.generationId).status,
        generations.get(prepared.stream.generationId).error,
      ).toBe('complete');
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

  it('returns corrective retrieval guidance without a cumulative retrieval budget', async () => {
    const { conversation, generations, loop, project, novels } = await setup();
    const document = new ContentService(project).saveDocument({
      kind: 'outline',
      title: '清风',
      contentMarkdown: '# 旧设定\n应先读取的现有正文',
    });
    novels.saveBinding({ documentId: document.id, role: 'work-outline', domainScope: 'novel' });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '修改清风设定',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '修改清风设定');
    loop.startProviderStep(prepared.stream);
    const execute = async (id: string, name: string, args: Record<string, unknown>) => {
      const result = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'response',
        calls: [
          {
            id,
            name,
            authorizationHandle: agent.tools.find((tool) => tool.name === name)
              ?.authorizationHandle,
            argumentsJson: JSON.stringify(args),
          },
        ],
      });
      return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
    };
    const empty = await execute('empty', 'library.search', {
      query: '清风',
      sourceTypes: ['document'],
    });
    expect(empty).toMatchObject({
      status: 'searched',
      resultCount: 0,
    });
    expect(empty).not.toHaveProperty('budget');
    expect(empty.guidance).toContain('novel-reference');
    const invalid = await execute('invalid', 'library.read', { sourceHandle: document.id });
    expect(invalid).toMatchObject({ status: 'failed', errorCode: 'LIBRARY_HANDLE_INVALID' });
    expect(invalid.message).toContain('document IDs');
    const corrected = await execute('corrected', 'library.search', {
      query: '清风',
      sourceTypes: ['novel-reference'],
    });
    const sources = corrected.sources as Array<{ sourceHandle: string }>;
    const read = await execute('read', 'library.read', {
      sourceHandle: sources[0]!.sourceHandle,
      readMode: 'source',
    });
    expect(read).toMatchObject({
      status: 'read',
      sourceStatus: 'draft',
      content: '# 旧设定\n应先读取的现有正文',
    });
    expect(read).not.toHaveProperty('budget');
    const audit = project.access(false, (db) =>
      db.prepare('SELECT result_summary_json FROM agent_tool_calls').all(),
    );
    expect(JSON.stringify(audit)).not.toContain('应先读取的现有正文');
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

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'reads more than the former task cap across bounded batches and preserves the final document call (%s)',
    async (protocol) => {
      const { conversation, generations, loop, project } = await setup(protocol);
      const content = new ContentService(project);
      for (let index = 0; index < 15; index += 1) {
        content.saveDocument({
          kind: 'character',
          title: `Production source ${index}`,
          contentMarkdown: `Verified appearance details for character ${index}.`,
        });
      }
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: 'Read the production sources before writing the shot plan.',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, 'Read the production sources.');
      loop.startProviderStep(prepared.stream);
      const searched = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'source_lookup',
        calls: [
          {
            id: 'source_lookup',
            name: 'library.search',
            authorizationHandle: agent.tools.find((tool) => tool.name === 'library.search')!
              .authorizationHandle,
            argumentsJson: JSON.stringify({ query: 'Production source', limit: 20 }),
          },
        ],
      });
      const { sources } = JSON.parse(searched.continuation!.outputs[0]!.output) as {
        sources: Array<{ sourceHandle: string }>;
      };
      expect(sources).toHaveLength(15);
      const outputs: Array<{
        status: string;
        errorCode?: string;
        message?: string;
      }> = [];
      let offset = 0;
      let tools = searched.tools ?? agent.tools;
      let remainingTools = tools;
      for (const [batchIndex, size] of [6, 6, 3].entries()) {
        if (batchIndex > 0) {
          tools = loop.advanceTextTurn({
            ...prepared.stream,
            providerResponseId: `source_reads_turn_${batchIndex}`,
            finishReason: 'completed',
          });
          loop.startProviderStep(prepared.stream);
        }
        const readTool = tools.find((tool) => tool.name === 'library.read')!;
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `source_reads_${offset}`,
          calls: sources.slice(offset, offset + size).map((source, index) => ({
            id: `source_read_${offset + index}`,
            name: 'library.read',
            authorizationHandle: readTool.authorizationHandle,
            argumentsJson: JSON.stringify({
              sourceHandle: source.sourceHandle,
              readMode: 'source',
            }),
          })),
        });
        outputs.push(
          ...result.continuation!.outputs.map(
            (output) => JSON.parse(output.output) as (typeof outputs)[number],
          ),
        );
        if (!result.tools)
          throw new Error('Expected renewed tool authorizations after the read batch.');
        remainingTools = result.tools;
        offset += size;
      }
      expect(outputs.map((output) => output.status)).toEqual(Array(15).fill('read'));
      const drafted = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'sourced_draft',
        calls: [
          {
            id: 'sourced_draft',
            name: 'document.create_draft',
            authorizationHandle: remainingTools.find(
              (tool) => tool.name === 'document.create_draft',
            )!.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: 'Shot plan',
              contentMarkdown: 'Plan based on verified appearance details.',
            }),
          },
        ],
      });
      expect(drafted.continuation!.outputs[0]!.output).toContain('draft_created');
      expect(
        project.access(false, (db) =>
          db
            .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id = ?')
            .get(agent.taskId),
        ),
      ).toEqual({ tool_call_count: 17 });
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'continues searches beyond the per-step batch cap after authorization renewal (%s)',
    async (protocol) => {
      const { conversation, generations, loop, project } = await setup(protocol);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: 'Locate several project sources.',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, 'Locate several project sources.');
      loop.startProviderStep(prepared.stream);
      let tools = agent.tools;
      const outputs: Array<{ status: string; errorCode?: string }> = [];
      for (let index = 0; index < 13; index += 1) {
        if (index > 0 && index % 6 === 0) {
          tools = loop.advanceTextTurn({
            ...prepared.stream,
            providerResponseId: `lookup_turn_${index}`,
            finishReason: 'completed',
          });
          loop.startProviderStep(prepared.stream);
        }
        const searchTool = tools.find((tool) => tool.name === 'library.search')!;
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `lookup_${index}`,
          calls: [
            {
              id: `lookup_${index}`,
              name: 'library.search',
              authorizationHandle: searchTool.authorizationHandle,
              argumentsJson: JSON.stringify({ query: `Source ${index}` }),
            },
          ],
        });
        outputs.push(
          JSON.parse(result.continuation!.outputs[0]!.output) as (typeof outputs)[number],
        );
      }
      expect(outputs.map((output) => output.status)).toEqual(Array(13).fill('searched'));
      expect(
        project.access(false, (db) =>
          db
            .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id = ?')
            .get(agent.taskId),
        ),
      ).toEqual({ tool_call_count: 13 });
    },
  );

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'continues paged reads beyond the former task cap across authorization renewals (%s)',
    async (protocol) => {
      const { conversation, generations, loop, project } = await setup(protocol);
      const body = 'Current source appearance details. '.repeat(100);
      new ContentService(project).saveDocument({
        kind: 'character',
        title: 'Paged source',
        contentMarkdown: body,
      });
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: 'Read a long source in pages.',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, 'Read a long source in pages.');
      loop.startProviderStep(prepared.stream);
      let tools = agent.tools;
      const searched = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'page_lookup',
        calls: [
          {
            id: 'page_lookup',
            name: 'library.search',
            authorizationHandle: tools.find((tool) => tool.name === 'library.search')!
              .authorizationHandle,
            argumentsJson: JSON.stringify({ query: 'Paged source' }),
          },
        ],
      });
      const { sources } = JSON.parse(searched.continuation!.outputs[0]!.output) as {
        sources: Array<{ sourceHandle: string }>;
      };
      let offset = 0;
      let reconstructed = '';
      for (let index = 0; index < 17; index += 1) {
        if (index > 0 && index % 6 === 0) {
          tools = loop.advanceTextTurn({
            ...prepared.stream,
            providerResponseId: `renewal_${index}`,
            finishReason: 'completed',
          });
          loop.startProviderStep(prepared.stream);
        }
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `page_${index}`,
          calls: [
            {
              id: `page_${index}`,
              name: 'library.read',
              authorizationHandle: tools.find((tool) => tool.name === 'library.read')!
                .authorizationHandle,
              argumentsJson: JSON.stringify({
                sourceHandle: sources[0]!.sourceHandle,
                readMode: 'source',
                offset,
                maxChars: 100,
              }),
            },
          ],
        });
        const output = JSON.parse(result.continuation!.outputs[0]!.output) as {
          status: string;
          content: string;
          nextOffset: number;
        };
        expect(output.status).toBe('read');
        reconstructed += output.content;
        offset = output.nextOffset;
      }
      expect(reconstructed).toBe(body.slice(0, 1700));
      expect(
        project.access(false, (db) =>
          db
            .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id = ?')
            .get(agent.taskId),
        ),
      ).toEqual({ tool_call_count: 18 });
    },
  );

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

  it('preserves document and research calls after a full research batch', async () => {
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
          .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id = ?')
          .get(agent.taskId),
      ),
    ).toEqual({ tool_call_count: 0 });

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
      'research.search',
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
    const finalFetch = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch_budget_2',
      calls: Array.from({ length: 6 }, (_, index) => ({
        id: `call_fetch_budget_final_${index}`,
        name: 'research.fetch',
        authorizationHandle: finalFetchTool?.authorizationHandle,
        argumentsJson: JSON.stringify({
          sourceHandle: sourceHandles[(index + 2) % sourceHandles.length],
        }),
      })),
    });
    const finalFetchOutputs = finalFetch.continuation!.outputs.map((output) => {
      return JSON.parse(output.output) as { status: string; errorCode?: string };
    });
    expect(finalFetchOutputs.filter((output) => output.status === 'fetched')).toHaveLength(6);
    expect(finalFetchOutputs.filter((output) => output.status === 'failed')).toHaveLength(0);
    expect(finalFetch.tools?.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'library.search',
      'library.read',
      'research.search',
    ]);

    loop.startProviderStep(prepared.stream);
    const createTool = finalFetch.tools?.[0];
    const drafted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_draft_after_batch',
      calls: [
        {
          id: 'call_draft_after_budget',
          name: 'document.create_draft',
          authorizationHandle: createTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Research batch draft',
            contentMarkdown:
              '# Research batch draft\n\nFetched evidence.\n\nSource: https://source.test/alpha%20evidence/0',
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
      expect(database.prepare('SELECT status, phase FROM agent_tasks').get()).toEqual({
        status: 'waiting_review',
        phase: 'waiting_review',
      });
      expect(
        database
          .prepare('SELECT tool_call_count FROM agent_task_usage_counters WHERE task_id=?')
          .get(agent.taskId),
      ).toEqual({ tool_call_count: 12 });
      expect(
        database
          .prepare(
            `SELECT tool_name, error_code FROM agent_tool_calls
             ORDER BY provider_step_id, tool_ordinal`,
          )
          .all()
          .filter((row) => (row as { error_code: string | null }).error_code),
      ).toEqual([]);
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

  it.each([
    ['openai-responses', 'document.create_draft'],
    ['openai-responses', 'document.submit_draft'],
    ['openai-chat-completions', 'document.create_draft'],
    ['openai-chat-completions', 'document.submit_draft'],
  ] as const)(
    'shares document commits across legacy/current entry points: %s / %s',
    async (protocol, first) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '保存一份分析',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      let tools = loop.prepare(prepared.stream, '保存一份分析').tools;
      let ordinal = 0;
      const args = {
        resourceId: 'workspace:documents',
        title: '分析',
        documentKind: 'note',
        contentMarkdown: '完整正文',
      };
      const execute = async (name: string, input = args) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: 'response-' + ordinal,
          calls: [
            {
              id: 'call-' + ordinal++,
              name,
              argumentsJson: JSON.stringify(input),
              authorizationHandle: tools.find((t) => t.name === name)!.authorizationHandle,
            },
          ],
        });
        tools = result.tools ?? tools;
        return JSON.parse(result.continuation!.outputs[0]!.output) as {
          documentId?: string;
          status: string;
          execution: { replayed: boolean };
          error: { code: string };
        };
      };
      const saved = await execute(first);
      const second =
        first === 'document.create_draft' ? 'document.submit_draft' : 'document.create_draft';
      const replay = await execute(second);
      expect(replay.documentId).toBe(saved.documentId);
      expect(replay.execution.replayed).toBe(true);
      const conflict = await execute(second, { ...args, contentMarkdown: '模型重试时改写的正文' });
      expect(conflict.status).toBe('rejected');
      expect(conflict.error.code).toBe('AGENT_BUSINESS_OPERATION_CONFLICT');
      project.access(false, (db) => {
        expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM document_versions').get()).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_execution_commits').get()).toEqual({
          n: 1,
        });
        expect(db.prepare('SELECT content_markdown FROM document_versions').get()).toEqual({
          content_markdown: args.contentMarkdown,
        });
      });
    },
  );

  it.each([
    ['openai-responses', 'document.update_draft'],
    ['openai-responses', 'document.submit_draft'],
    ['openai-chat-completions', 'document.update_draft'],
    ['openai-chat-completions', 'document.submit_draft'],
  ] as const)(
    'shares update CAS receipts across entry points: %s / %s',
    async (protocol, first) => {
      const { conversation, generations, project, workflow } = await setup(protocol);
      const target = workflow.saveDraft({
        title: 'Target',
        kind: 'note',
        contentMarkdown: 'Original',
      });
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: 'Update target',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      let tools = loop.prepare(prepared.stream, 'Update target', undefined, {
        operation: 'document.update_draft',
        documentId: target.id,
      }).tools;
      let n = 0;
      const input = {
        resourceId: 'document:' + target.id,
        documentId: target.id,
        documentKind: 'note',
        title: 'Target',
        contentMarkdown: 'Revised',
        baseVersionId: target.currentVersionId,
        expectedDocumentRowVersion: target.rowVersion,
      };
      const execute = async (name: string, contentMarkdown = 'Revised') => {
        loop.startProviderStep(prepared.stream);
        const args =
          name === 'document.update_draft'
            ? { title: input.title, contentMarkdown }
            : { ...input, contentMarkdown };
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: 'update-response-' + n,
          calls: [
            {
              id: 'update-call-' + n++,
              name,
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((t) => t.name === name)!.authorizationHandle,
            },
          ],
        });
        tools = result.tools ?? tools;
        return JSON.parse(result.continuation!.outputs[0]!.output) as {
          status: string;
          documentId?: string;
          documentVersionId?: string;
          execution: { replayed?: boolean };
        };
      };
      const saved = await execute(first);
      expect(saved.documentId).toBe(target.id);
      const second =
        first === 'document.update_draft' ? 'document.submit_draft' : 'document.update_draft';
      const replay = await execute(second);
      expect(replay.documentVersionId).toBe(saved.documentVersionId);
      expect(replay.execution.replayed).toBe(true);
      expect(await execute(second, 'Changed on retry')).toMatchObject({
        status: 'rejected',
        error: { code: 'AGENT_BUSINESS_OPERATION_CONFLICT' },
      });
      expect(workflow.getDocument(target.id).currentVersion?.contentMarkdown).toBe('Revised');
      project.access(false, (db) => {
        expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM document_versions').get()).toEqual({ n: 2 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_execution_commits').get()).toEqual({
          n: 1,
        });
        expect(
          db.prepare('SELECT status FROM agent_tool_calls ORDER BY rowid DESC LIMIT 1').get(),
        ).toEqual({ status: 'failed' });
      });
    },
  );

  it.each(['document.update_draft', 'document.submit_draft'] as const)(
    'preserves concurrent user edits against stale %s',
    async (name) => {
      const { conversation, generations, project, workflow } = await setup();
      const target = workflow.saveDraft({
        title: 'Target',
        kind: 'note',
        contentMarkdown: 'Original',
      });
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: 'Update',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const tools = loop.prepare(prepared.stream, 'Update', undefined, {
        operation: 'document.update_draft',
        documentId: target.id,
      }).tools;
      workflow.saveDraft({
        documentId: target.id,
        title: 'User title',
        contentMarkdown: 'User edit',
        expectedDocumentRowVersion: target.rowVersion,
      });
      loop.startProviderStep(prepared.stream);
      const args = {
        title: 'Target',
        contentMarkdown: 'Agent stale',
        ...(name === 'document.submit_draft'
          ? {
              documentId: target.id,
              resourceId: 'document:' + target.id,
              documentKind: 'note',
              baseVersionId: target.currentVersionId,
              expectedDocumentRowVersion: target.rowVersion,
            }
          : {}),
      };
      const invoke = loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'stale',
        calls: [
          {
            id: 'stale',
            name,
            argumentsJson: JSON.stringify(args),
            authorizationHandle: tools.find((t) => t.name === name)!.authorizationHandle,
          },
        ],
      });
      if (name === 'document.update_draft')
        await expect(invoke).rejects.toThrow('Document was changed');
      else
        expect(JSON.parse((await invoke).continuation!.outputs[0]!.output)).toMatchObject({
          status: 'rejected',
        });
      expect(workflow.getDocument(target.id).currentVersion?.contentMarkdown).toBe('User edit');
      project.access(false, (db) =>
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_execution_commits').get()).toEqual({
          n: 0,
        }),
      );
    },
  );

  it.each([
    ['document.create_draft', false],
    ['document.submit_draft', false],
    ['document.create_draft', true],
    ['document.submit_draft', true],
  ] as const)(
    'preserves historical artifacts without guessing a new identity: %s / child=%s',
    async (name, child) => {
      const { conversation, generations, project, workflow } = await setup();
      const loop = createSystemLoop(project, workflow);
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: 'Continue saved analysis',
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const agent = loop.prepare(prepared.stream, 'Continue saved analysis');
      const historicalTask = child ? 'historical-child' : agent.taskId;
      if (child)
        project.access(true, (db) =>
          db
            .prepare(
              "INSERT INTO agent_tasks(id,project_id,project_session_id,conversation_id,task_type,scope_type,title,request_snapshot_json,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,'document-create','project','Historical',?,'hash','waiting_review','now','now')",
            )
            .run(
              historicalTask,
              prepared.stream.projectId,
              prepared.stream.projectSessionId,
              conversation.id,
              JSON.stringify({ parentTaskId: agent.taskId }),
            ),
        );
      const historical = workflow.saveDraft({
        title: 'Historical analysis',
        kind: 'note',
        contentMarkdown: 'Historical full result',
        sourceTaskId: historicalTask,
        authorType: 'agent',
      });
      project.access(true, (db) => {
        db.prepare(
          "INSERT INTO agent_task_document_artifacts(id,project_id,task_id,document_id,document_version_id,artifact_role,disposition,row_version,created_at,updated_at) VALUES('historical',?,?,?,?,'primary','draft',0,'now','now')",
        ).run(
          prepared.stream.projectId,
          historicalTask,
          historical.id,
          historical.currentVersionId,
        );
        db.prepare('DELETE FROM agent_resource_changes WHERE task_id=?').run(agent.taskId);
      });
      loop.startProviderStep(prepared.stream);
      const output = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'legacy',
        calls: [
          {
            id: 'legacy',
            name,
            argumentsJson: JSON.stringify({
              resourceId: 'workspace:documents',
              documentKind: 'note',
              title: 'Historical analysis',
              contentMarkdown: 'New content',
            }),
            authorizationHandle: agent.tools.find((t) => t.name === name)!.authorizationHandle,
          },
        ],
      });
      expect(JSON.parse(output.continuation!.outputs[0]!.output)).toMatchObject({
        status: 'execution_conflict',
        legacyOutputs: [expect.objectContaining({ id: historical.id })],
      });
      project.access(false, (db) => {
        expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_execution_commits').get()).toEqual({
          n: 0,
        });
        expect(
          db.prepare('SELECT status FROM agent_tool_calls ORDER BY rowid DESC LIMIT 1').get(),
        ).toEqual({ status: 'failed' });
      });
      expect(workflow.getDocument(historical.id).currentVersion?.contentMarkdown).toBe(
        'Historical full result',
      );
    },
  );

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
            resourceId: 'workspace:novel',
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
    const manager = new AgentContextManager(
      project,
      prepared.stream,
      agent.taskId,
      'Create a draft.',
    );
    manager.snapshot(generations.runtime(prepared.stream), { messages: [] }, 'document');
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
      expect(database.prepare('SELECT phase FROM agent_tasks').get()).not.toEqual({
        phase: 'recovering',
      });
      const store = new AgentContextStore(database);
      expect(store.loadTask(prepared.stream.projectId, agent.taskId)).toMatchObject({
        executionStatus: 'cancelled',
        recoveryState: { termination: { reason: 'cancelled' } },
      });
      expect(store.loadRuntime(prepared.stream.projectId, agent.taskId)).toBeDefined();
      expect(database.prepare('SELECT status FROM agent_tool_authorizations').get()).toEqual({
        status: 'revoked',
      });
      expect(database.prepare('SELECT status FROM llm_provider_steps').get()).toEqual({
        status: 'interrupted',
      });
    });
  });

  it('retains specific local supervision failure codes on terminal tasks', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '检查本地监督错误',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, '检查本地监督错误');
    loop.terminateGeneration(
      prepared.stream.generationId,
      'failed',
      'AGENT_REPEATED_READ_STALLED: same version repeated',
    );
    project.access(false, (db) =>
      expect(
        db.prepare('SELECT status,error_code FROM agent_tasks WHERE id=?').get(agent.taskId),
      ).toEqual({ status: 'failed', error_code: 'AGENT_REPEATED_READ_STALLED' }),
    );
  });

  it('persists Provider failure diagnostics on the request, Provider step, and task', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prompt = '检查一次 Provider 失败';
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    const message = 'Provider HTTP 429 (rate_limit_exceeded): Too many requests.';
    loop.startProviderStep(prepared.stream);
    loop.recordProviderRequest(prepared.stream, 'provider-request', 'failed', {
      errorCode: 'PROVIDER_FAILED',
      providerStatus: 429,
      providerErrorCode: 'rate_limit_exceeded',
      providerErrorMessage: message,
    });

    expect(
      loop.terminateGeneration(
        prepared.stream.generationId,
        'failed',
        message,
        'rate_limit_exceeded',
      ),
    ).toBe(1);

    project.access(false, (database) => {
      expect(
        database.prepare('SELECT status,error_code,error_message FROM llm_provider_steps').get(),
      ).toEqual({
        status: 'failed',
        error_code: 'rate_limit_exceeded',
        error_message: message,
      });
      expect(
        database
          .prepare('SELECT status,error_code,error_message FROM agent_tasks WHERE id=?')
          .get(agent.taskId),
      ).toEqual({
        status: 'failed',
        error_code: 'PROVIDER_RATE_LIMITED',
        error_message: message,
      });
      const request = database
        .prepare('SELECT stage,metadata_json FROM llm_provider_requests WHERE id=?')
        .get('provider-request') as { stage: string; metadata_json: string };
      expect(request.stage).toBe('failed');
      expect(JSON.parse(request.metadata_json)).toMatchObject({
        errorCode: 'PROVIDER_FAILED',
        providerStatus: 429,
        providerErrorCode: 'rate_limit_exceeded',
        providerErrorMessage: message,
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
                sceneDocumentId: sceneDoc.id,
                authoringIR: productionFixture('林澈站在旧码头。'),
                characterDocumentIds: [character.id],
                shots: [
                  {
                    title: '海雾中的码头',
                    authoringIR: productionFixture(
                      '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
                      'shot',
                    ),
                  },
                ],
              },
              {
                title: '街道',
                sceneDocumentId: sceneDoc.id,
                authoringIR: productionFixture('雨中的街道。'),
                characterDocumentIds: [],
                shots: [
                  {
                    title: '雨中街道',
                    authoringIR: productionFixture('街道上的雨。', 'shot'),
                  },
                ],
              },
              {
                title: '房间',
                sceneDocumentId: sceneDoc.id,
                authoringIR: productionFixture('房间内的信件。'),
                characterDocumentIds: [],
                shots: [
                  {
                    title: '信件特写',
                    authoringIR: productionFixture('桌上的信件。', 'shot'),
                  },
                ],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('episode_structure_saved');
    const changeSets = new ChangeSetService(project);
    expect(changeSets.list({ includeTerminal: false })).toHaveLength(0);
    const proposed = changeSets.list({ includeTerminal: true });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.items).toMatchObject([
      { entityType: 'scene', title: '旧码头 · 台风前夜' },
      {
        entityType: 'shot',
        title: '海雾中的码头',
        parentItemOrdinal: 0,
      },
      { entityType: 'scene', title: '街道' },
      { entityType: 'shot', title: '雨中街道', parentItemOrdinal: 2 },
      { entityType: 'scene', title: '房间' },
      { entityType: 'shot', title: '信件特写', parentItemOrdinal: 4 },
    ]);
    expect(proposed[0]!.status).toBe('applied');
    const content = new ContentService(project);
    for (const [title, shotTitle] of [
      ['街道', '雨中街道'],
      ['房间', '信件特写'],
    ]) {
      const parent = content.listScenes().find((item) => item.title === title)!;
      expect(content.listShots(parent.id).map((item) => item.title)).toEqual([shotTitle]);
    }
    const scene = content.listScenes()[0]!;
    expect(content.listShots(scene.id)[0]?.prompt).toContain(
      '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
    );
  });

  it('feeds an invalid structured character ID back to the model without guessing from prompt names', async () => {
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
                sceneDocumentId: 'missing-scene-id',
                authoringIR: productionFixture('他转身。'),
                characterDocumentIds: ['missing-character-id'],
                shots: [
                  {
                    title: '镜头 01',
                    authoringIR: productionFixture('[角色:不存在的人物] 出现在画面中。', 'shot'),
                  },
                ],
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
    expect(rejected.error.message).toContain('有效的制作场景');
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
                sceneDocumentId: scenePrompt.id,
                authoringIR: productionFixture('午后的白家三房。'),
                characterDocumentIds: [],
                shots: [
                  {
                    title: '屋檐下全景',
                    authoringIR: productionFixture(
                      '[场景:白家三房] 屋檐下全景，白小弟在学医。',
                      'shot',
                    ),
                  },
                ],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('episode_structure_saved');

    // 5. Generated drafts are already saved; prompts must land on shots.
    const changeSets = new ChangeSetService(project);
    expect(changeSets.list({ includeTerminal: false })).toHaveLength(0);
    const proposed = changeSets.list({ includeTerminal: true });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.status).toBe('applied');
    const scene = content.listScenes()[0]!;
    expect(content.listShots(scene.id)[0]?.prompt).toContain(
      '[场景:白家三房] 屋檐下全景，白小弟在学医。',
    );
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

  it('saves plot constraints as constraint-kind documents through the Agent tool loop', async () => {
    const { conversation, generations, loop, workflow, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '创建剧情约束文档',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '创建剧情约束文档',
      '剧情约束',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);

    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_plot_constraint_draft',
      calls: [
        {
          id: 'call_plot_constraint_draft',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '剧情约束',
            contentMarkdown: '林澈不得在第一幕得知灯塔秘密。',
            documentKind: 'constraint',
          }),
        },
      ],
    });
    const parsed = JSON.parse(result.continuation!.outputs[0]!.output) as { documentId: string };

    expect(workflow.getDocument(parsed.documentId)).toMatchObject({
      kind: 'constraint',
      title: '剧情约束',
    });
    expect(new ContentService(project).listConstraints()).toEqual([]);
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
              ...(operation === 'document.create_draft'
                ? { resourceId: 'workspace:documents', documentKind: 'note' }
                : {
                    resourceId: `document:${previous.id}`,
                    documentId: previous.id,
                    versionId: previous.currentVersionId,
                    expectedRowVersion: previous.rowVersion,
                  }),
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
      ).toEqual({ status: 'completed' });
      expect(
        project.access(false, (db) =>
          db
            .prepare(
              'SELECT status FROM agent_tasks WHERE id=(SELECT source_task_id FROM document_versions WHERE id=?)',
            )
            .get(saved.currentVersionId),
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
                    'tools.load',
                    { names: ['document.create_draft'] },
                    { id: 'load-tools' },
                  ),
                ],
                { stopReason: 'toolUse', responseId: 'load-response' },
              ),
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

  it('prepares deferred media review forms through the generic Agent loop without paid jobs', async () => {
    const base = await setupMedia();
    const reviews = new MediaReviewService(base.project, base.media, base.mediaSubmission, {
      scene: vi.fn(() => ({ sceneId: 'unused', voices: [], cues: [], audioFiles: [], jobs: [] })),
      listVoices: vi.fn(() => []),
      saveCue: vi.fn(),
      generateTake: vi.fn(),
    });
    const loop = createSystemLoop(base.project, base.workflow, base.novels, base.media, reviews);
    const prompt = '根据剧本准备所有媒体审核表单，不提交生成';
    const prepared = base.generations.prepare({
      conversationId: base.conversation.id,
      prompt,
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    let tools = agent.tools;
    const execute = async (name: string, args: Record<string, unknown>, id: string) => {
      const tool = tools.find((item) => item.name === name)!;
      expect(tool).toBeDefined();
      loop.startProviderStep(prepared.stream);
      const result = await loop.executeTools({
        ...prepared.stream,
        providerResponseId: `response-${id}`,
        calls: [
          {
            id,
            name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify(args),
          },
        ],
      });
      tools = result.tools ?? tools;
      return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
    };
    const draft = { key: 'scene', label: '场景图', kind: 'image', prompt: '雨夜客栈，无人场景图' };
    const first = await execute('media.review.prepare', draft, 'prepare');
    expect(first).toMatchObject({ form: { status: 'pending', key: 'scene' } });
    expect(JSON.stringify(first)).not.toMatch(/selectionToken|reviewToken|baseUrl|relativePath/u);
    await execute('media.review.prepare', { ...draft, key: 'scene-2' }, 'prepare-2');
    const page = await execute('media.review.list', { limit: 1 }, 'list');
    expect(page).toMatchObject({ total: 2, nextOffset: 1, truncated: true });
    expect(page.forms).toHaveLength(1);
    expect(await execute('media.review.list', { offset: 1, limit: 1 }, 'list-2')).toMatchObject({
      total: 2,
      truncated: false,
    });
    expect(reviews.list(base.conversation.id)).toHaveLength(2);
    expect(base.nativeRequest).not.toHaveBeenCalled();
    expect(
      base.project.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('saves production-skill artifacts as completed drafts and denies media and review tools', async () => {
    const base = await setupMedia(false);
    const reviews = new MediaReviewService(base.project, base.media, base.mediaSubmission, {
      scene: vi.fn(() => ({ sceneId: 'unused', voices: [], cues: [], audioFiles: [], jobs: [] })),
      listVoices: vi.fn(() => []),
      saveCue: vi.fn(),
      generateTake: vi.fn(),
    });
    const loop = createSystemLoop(base.project, base.workflow, base.novels, base.media, reviews);
    const prompt = '根据已选剧本直接生成制作资料草稿';
    const prepared = base.generations.prepare({
      conversationId: base.conversation.id,
      prompt,
      providerProfileId: 'agent-profile',
      modelId: 'agent-model',
    });
    const agent = loop.prepare(
      prepared.stream,
      prompt,
      undefined,
      { operation: 'document.list' },
      'project_only',
      undefined,
      undefined,
      undefined,
      undefined,
      'script-to-media',
    );
    const names = agent.tools.map((tool) => tool.name);
    expect(taskSnapshot(base.project, agent.taskId).productionSkillId).toBe('script-to-media');
    expect(names).toContain('production.skill.read');
    expect(names).toContain('document.submit_draft');
    expect(names).toContain('scene.submit_structure');
    expect(names).not.toContain('conversation.ask');
    expect(names).not.toContain('conversation.task.route');
    expect(names).not.toContain('media.review.prepare');
    expect(names).not.toContain('media.image.prepare');
    expect(names).not.toContain('media.video.prepare');
    expect(names).not.toContain('media.generation.submit');

    loop.startProviderStep(prepared.stream);
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'production-forbidden-review',
        calls: [
          {
            id: 'production-forbidden-review-call',
            name: 'media.review.prepare',
            argumentsJson: JSON.stringify({
              key: 'scene-image',
              label: '场景图',
              kind: 'image',
              prompt: '雨夜客栈',
            }),
          },
        ],
      }),
    ).rejects.toThrow('AGENT_TOOL_UNAUTHORIZED');

    const documentTool = agent.tools.find((tool) => tool.name === 'document.submit_draft')!;
    const saved = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'production-draft-saved',
      calls: [
        {
          id: 'production-draft-saved-call',
          name: 'document.submit_draft',
          authorizationHandle: documentTool.authorizationHandle,
          argumentsJson: JSON.stringify({
            resourceId: 'workspace:characters',
            documentKind: 'character',
            title: '角色：周岚',
            contentMarkdown: '# 周岚\n雨夜客栈的掌柜。',
          }),
        },
      ],
    });
    const artifact = JSON.parse(saved.continuation!.outputs[0]!.output) as {
      status: string;
      taskId: string;
      documentId: string;
      reviewRequired: boolean;
    };
    expect(artifact.status).toBe('draft_saved');
    expect(artifact.reviewRequired).toBe(false);
    expect(base.workflow.getDocument(artifact.documentId).currentVersion?.state).toBe('draft');
    expect(base.workflow.getTask({ taskId: artifact.taskId }).task.status).toBe('completed');
    expect(reviews.list(base.conversation.id)).toHaveLength(0);
    expect(base.nativeRequest).not.toHaveBeenCalled();
    expect(base.workflow.getTask({ taskId: agent.taskId }).task.status).toBe('running');
    loop.startProviderStep(prepared.stream);
    expect(() =>
      loop.completeProviderStep({
        ...prepared.stream,
        providerResponseId: 'production-draft-finished',
        finishReason: 'stop',
      }),
    ).toThrow('TASK_DELIVERABLES_PENDING');
    // A material child task saved successfully. The full workflow still owes
    // shot structure and readback even when the model registered no plan.
    expect(base.workflow.getTask({ taskId: agent.taskId }).task.status).toBe('running');
  });

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

  it.each(['current', 'foreign', 'missing'] as const)(
    'loads and authorizes media task inspection through the lazy tool catalog (%s task)',
    async (scope) => {
      const base = await setupMedia();
      const owner = scope === 'foreign' ? await setupMedia() : base;
      const prompt = '只查询已有视频任务，不重新生成';
      const prepared = base.generations.prepare({
        conversationId: base.conversation.id,
        prompt,
        providerProfileId: 'agent-profile',
        modelId: 'agent-model',
      });
      const ownerIdentity =
        scope === 'foreign'
          ? owner.generations.prepare({
              conversationId: owner.conversation.id,
              prompt,
              providerProfileId: 'agent-profile',
              modelId: 'agent-model',
            }).stream
          : prepared.stream;
      const context = owner.media.selectionContext(
        'video',
        { prompt: '已审核的视频正文' },
        ownerIdentity,
      );
      const candidate = context.candidates[0]!;
      const draft = owner.media.prepareSelected(
        context,
        {
          providerProfileId: candidate.providerProfileId,
          modelId: candidate.modelId,
          adapterKey: candidate.adapters[0]!.key,
          parameters: {},
        },
        ownerIdentity,
      );
      owner.project.access(true, (db) =>
        db
          .prepare('UPDATE generation_jobs SET media_state = ? WHERE id = ?')
          .run('polling', draft.draftId),
      );
      const taskId = scope === 'missing' ? 'missing-media-task' : draft.draftId;
      const before = base.project.access(false, (db) =>
        db.prepare('SELECT * FROM generation_jobs ORDER BY id').all(),
      );
      const loop = createSystemLoop(base.project, base.workflow, base.novels, base.media);
      const agent = loop.prepare(prepared.stream, prompt);
      base.generations.configureAgentTools(prepared.stream, agent.tools);
      const confirmation = vi.fn().mockResolvedValue(false);
      const selection = vi.fn().mockResolvedValue(undefined);
      const gateway = new AgentProviderToolGateway(
        loop,
        prepared.stream,
        agent.tools,
        confirmation,
        selection,
        undefined,
        undefined,
        true,
      );
      const loader = gateway.tools().find((tool) => tool.name === 'tools.load')!;
      expect(loader.description).toContain('media.task.get');
      const args = loader.prepareArguments!({ names: ['media.task.get'] });
      await loader.execute('load-media-task', args);
      const query = gateway.tools().find((tool) => tool.name === 'media.task.get')!;
      expect(query.executionMode).toBe('parallel');
      gateway.startProviderStep();
      gateway.captureProviderCall('inspect-media-task', 'media-inspection-response');
      const read = query.execute('inspect-media-task', query.prepareArguments!({ taskId }));
      if (scope === 'current') {
        const result = await read;
        expect(JSON.parse(result.content.find((item) => item.type === 'text')!.text)).toMatchObject(
          {
            status: 'succeeded',
            task: { taskId, kind: 'video', state: 'polling', resultAssetIds: [] },
          },
        );
        expect(JSON.stringify(result)).not.toMatch(
          /rootPath|relativePath|requestJson|taskSnapshotJson/u,
        );
      } else {
        await expect(read).rejects.toThrow('AGENT_TOOL_PROJECT_SCOPE');
      }
      expect(confirmation).not.toHaveBeenCalled();
      expect(selection).not.toHaveBeenCalled();
      expect(base.nativeRequest).not.toHaveBeenCalled();
      expect(owner.nativeRequest).not.toHaveBeenCalled();
      expect(
        base.project.access(false, (db) =>
          db.prepare('SELECT * FROM generation_jobs ORDER BY id').all(),
        ),
      ).toEqual(before);
    },
  );

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

// Scripted provider, real Registry/authorization/SQLite writes/Runtime/request builder.
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'resumes an episode storyboard task after durable handoff without repeating saved work (%s)',
  async (protocol) => {
    const base = await setup(protocol),
      { project, conversation, novels } = base;
    const root = project.current()!.rootPath;
    const content = new ContentService(project);
    novels.importNovel({
      chapters: [
        {
          title: '雨夜重逢',
          displayLabel: '第一章',
          contentMarkdown: '雨夜，林澈身穿蓝衣，在旧码头对周岚说：“我回来了。”'.repeat(250),
        },
      ],
    });
    content.saveDocument({
      kind: 'character',
      title: '林澈人物资料',
      contentMarkdown: '林澈始终穿蓝衣，外表沉静，保留对白。'.repeat(400),
    });
    content.saveDocument({
      kind: 'scene',
      title: '旧码头场景资料',
      contentMarkdown: '旧码头，雨夜，湿润木板，背景灯塔。'.repeat(400),
    });
    const prompt =
      '生成一整集短剧所需的全部分镜提示词：读取小说、人物和场景，分析剧情、生成分镜和提示词、检查并保存。保留原文对白，林澈始终穿蓝衣。';
    let generations = base.generations,
      workflow = base.workflow,
      loop = createSystemLoop(project, workflow, novels);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, prompt);
    generations.configureAgentTools(prepared.stream, agent.tools);
    const bodies: NativeProviderStreamStartParams[] = [];
    let phase = 0,
      crashReached = false;
    const store = <T>(fn: (store: AgentContextStore) => T) =>
      project.access(true, (db) => fn(new AgentContextStore(db)));
    const call = (id: string, name: string, args: unknown) => ({
      id,
      name,
      argumentsJson: JSON.stringify(args),
    });
    const full = (id: string) =>
      JSON.parse(
        store((s) => s.resultForCall(project.current()!.id, agent.taskId, id))!.content,
      ) as Record<string, unknown>;
    const makeBridge = (resumed: boolean) => {
      const ownBridge = new NativeProviderBridge({
        send(envelope) {
          if (envelope.method !== 'provider.stream.start') return Promise.resolve();
          const params = envelope.params as NativeProviderStreamStartParams;
          bodies.push(structuredClone(params));
          let calls: ReturnType<typeof call>[] = [];
          if (!resumed) {
            switch (phase++) {
              case 0:
                calls = [
                  call('load', 'tools.load', {
                    names: ['conversation.task.checkpoint', 'document.submit_draft'],
                    workflow: 'video-prompt',
                  }),
                ];
                break;
              case 1:
                calls = [
                  call('plan', 'conversation.task.checkpoint', {
                    operation: 'plan',
                    deliverables: [
                      {
                        key: 'episode',
                        toolName: 'document.submit_draft',
                        documentKind: 'plan',
                        minimumCount: 3,
                      },
                    ],
                  }),
                ];
                break;
              case 2:
                calls = [call('search', 'library.search', { query: '*', searchMode: 'structure' })];
                break;
              case 3: {
                const sources = full('search').sources as Array<{
                  title: string;
                  sourceHandle: string;
                }>;
                for (const [id, title] of [
                  ['chapter', '雨夜重逢'],
                  ['character', '林澈人物资料'],
                  ['scene', '旧码头场景资料'],
                ]) {
                  const source = sources.find((s) => s.title.includes(title!));
                  expect(source, title).toBeDefined();
                  calls.push(
                    call(id!, 'library.read', {
                      sourceHandle: source!.sourceHandle,
                      readMode: 'source',
                    }),
                  );
                }
                break;
              }
              case 4:
              case 5:
              case 6: {
                const id = ['chapter', 'character', 'scene'][phase - 5]!;
                const result = store((s) => s.resultForCall(params.projectId, agent.taskId, id))!;
                expect(result.content.length).toBeGreaterThan(6000);
                calls = [
                  call('page-' + id, 'conversation.task.checkpoint', {
                    operation: 'result',
                    resultId: result.id,
                    resultLimit: 16384,
                    expectedHash: result.contentHash,
                  }),
                ];
                break;
              }
              case 7:
                calls = [
                  call('analysis', 'document.submit_draft', {
                    resourceId: 'workspace:documents',
                    documentKind: 'plan',
                    title: '第1集剧情分析',
                    outputId: (full('plan').outputBindings as Array<{ outputId: string }>)[0]!
                      .outputId,
                    outputIndex: 0,
                    contentMarkdown:
                      '# 剧情分析\n雨夜重逢，保留“我回来了。”，林澈蓝衣，旧码头灯塔。',
                  }),
                ];
                break;
              case 8:
                calls = [
                  call('handoff', 'conversation.task.checkpoint', {
                    operation: 'save',
                    remainingWork:
                      '剧情分析已保存；继续生成分镜、完整提示词，检查并保存，禁止重复保存剧情分析。',
                    workingNotes: '蓝衣、原文对白、雨夜旧码头。资料完整结果已外置，沿用有效版本。',
                  }),
                ];
                break;
              default:
                crashReached = true;
                return Promise.resolve();
            }
          } else {
            expect(params.prompt).toContain('林澈始终穿蓝衣');
            expect(nativeRequestUserText(params)).toContain('analysis');
            expect(params.continuation).toBeUndefined();
            switch (phase++) {
              case 0:
                calls = [
                  call('storyboard', 'document.submit_draft', {
                    resourceId: 'workspace:documents',
                    documentKind: 'plan',
                    title: '第1集分镜',
                    outputId: (full('plan').outputBindings as Array<{ outputId: string }>)[0]!
                      .outputId,
                    outputIndex: 1,
                    contentMarkdown:
                      '# 第1集分镜\n1. 全景：雨夜旧码头、灯塔。2. 中景：蓝衣林澈走向周岚。3. 特写：林澈说“我回来了。”',
                  }),
                ];
                break;
              case 1:
                calls = [
                  call('prompts', 'document.submit_draft', {
                    resourceId: 'workspace:documents',
                    documentKind: 'plan',
                    title: '第1集完整分镜提示词',
                    outputId: (full('plan').outputBindings as Array<{ outputId: string }>)[0]!
                      .outputId,
                    outputIndex: 2,
                    contentMarkdown:
                      '# 完整分镜提示词\n镜头1，全景，雨夜旧码头与灯塔，湿润木板。\n镜头2，中景，蓝衣林澈迎面走向周岚，慢推。\n镜头3，特写，林澈沉静地说：“我回来了。”，保留原文对白。',
                  }),
                ];
                break;
              case 2:
                calls = [call('check', 'conversation.task.checkpoint', { operation: 'state' })];
                break;
            }
          }
          const events: NativeProviderHostEvent[] = calls.length
            ? [
                ...calls.map((c) => ({
                  type: 'tool_call_end' as const,
                  projectSessionId: params.projectSessionId,
                  call: c,
                })),
                {
                  type: 'usage',
                  projectSessionId: params.projectSessionId,
                  usage: { inputTokens: 100, outputTokens: 20 },
                },
                {
                  type: 'complete',
                  projectSessionId: params.projectSessionId,
                  providerResponseId: 'response-' + bodies.length,
                  finishReason: 'tool_calls',
                },
              ]
            : [
                {
                  type: 'text_delta',
                  projectSessionId: params.projectSessionId,
                  delta: '已完成检查，整集分镜和提示词已完整保存。',
                },
                {
                  type: 'complete',
                  projectSessionId: params.projectSessionId,
                  providerResponseId: 'final',
                  finishReason: 'stop',
                },
              ];
          queueMicrotask(() =>
            events.forEach((event, sequence) =>
              ownBridge.handleEnvelope({
                kind: 'host.event',
                requestId: envelope.requestId,
                sequence,
                event,
              }),
            ),
          );
          return Promise.resolve();
        },
      });
      return ownBridge;
    };
    let bridge = makeBridge(false);
    const runtime = (
      service: GenerationService,
      executor: AgentProviderLoopService,
      native: NativeProviderBridge,
    ) =>
      new PiConversationRuntime({
        generation: service,
        plans: {} as never,
        providerTools: executor,
        bridge: native,
        createGateway: () => {
          throw new Error('ordinary runtime');
        },
        createContextManager: (identity, taskId, goal) =>
          new AgentContextManager(project, identity, taskId, goal),
      });
    const first = runtime(generations, loop, bridge);
    await first.start({
      ...prepared.stream,
      identity: prepared.stream,
      taskId: agent.taskId,
      mode: 'document',
      prompt,
    });
    await vi.waitFor(
      () => {
        if (generations.get(prepared.stream.generationId).status === 'failed')
          throw new Error(
            JSON.stringify({ phase, error: generations.get(prepared.stream.generationId).error }),
          );
        expect(crashReached).toBe(true);
      },
      { timeout: 2000, interval: 20 },
    );
    expect(
      store((s) => s.loadTask(prepared.stream.projectId, agent.taskId))?.generatedArtifacts.some(
        (a) => a.callId === 'analysis',
      ),
    ).toBe(true);
    first.suspendAll('worker_restart');
    bridge.interruptAll({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Isolated Worker restart.',
      retryable: true,
    });
    await first.drain();
    expect(['prepared', 'streaming']).toContain(
      generations.get(prepared.stream.generationId).status,
    );
    // Discovery must use the same coherent fallback as actual restoration.
    // Simulate a damaged latest mutable projection; immutable checkpoints survive.
    project.access(true, (db) =>
      db
        .prepare("UPDATE agent_context_tasks SET state_json='{}',runtime_json='{}' WHERE task_id=?")
        .run(agent.taskId),
    );
    const oldSession = project.currentSessionId();
    project.close();
    project.open(root);
    expect(project.currentSessionId()).not.toBe(oldSession);
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: 'profile',
        modelId: 'model',
        providerName: 'Resumed',
        modelName: '1M model',
        remoteModelId: 'resumed-1m',
        protocol,
        baseUrl: 'https://mock.invalid/v1',
        modelCapabilities: {
          modelId: 'model',
          contextWindow: 1000000,
          maxOutputTokens: 4096,
          capabilitySource: 'manual_config',
        },
      }),
    };
    generations = new GenerationService(
      project,
      new ContentService(project),
      new ContextService(project),
      {
        status: () => ({ key: 'unused', name: 'Unused', model: 'unused', configured: false }),
        stream: () => Promise.reject(new Error('native only')),
      },
      { selectionResolver },
    );
    expect(generations.recoverableContextTasks().map((t) => t.taskId)).toContain(agent.taskId);
    generations.recoverInterrupted();
    workflow = new DocumentWorkflowService(project);
    loop = createSystemLoop(project, workflow, new NovelService(project));
    loop.recoverInterrupted();
    const resumed = generations.resumeContextTask(agent.taskId);
    const next = loop.prepare(resumed.identity, prompt);
    expect(next.taskId).toBe(agent.taskId);
    generations.configureAgentTools(resumed.identity, next.tools);
    phase = 0;
    bridge = makeBridge(true);
    const second = runtime(generations, loop, bridge);
    await second.start({
      ...resumed.identity,
      identity: resumed.identity,
      taskId: agent.taskId,
      mode: 'document',
      prompt,
    });
    await second.wait(resumed.identity.generationId);
    expect(generations.get(resumed.identity.generationId).status).toBe('complete');
    const saved = store((s) => s.loadTask(prepared.stream.projectId, agent.taskId))!;
    expect(saved.executionStatus).toBe('completed');
    for (const id of ['analysis', 'storyboard', 'prompts'])
      expect(saved.generatedArtifacts.filter((a) => a.callId === id)).toHaveLength(1);
    const final = full('prompts');
    expect(
      workflow.getDocument(String(final.documentId)).currentVersion?.contentMarkdown,
    ).toContain('我回来了。');
    const counts = project.access(false, (db) =>
      db
        .prepare(
          "SELECT provider_call_id,count(*) n FROM agent_tool_calls WHERE tool_name='document.submit_draft' AND status='succeeded' GROUP BY provider_call_id",
        )
        .all(),
    );
    expect(counts).toEqual(
      expect.arrayContaining(
        ['analysis', 'storyboard', 'prompts'].map((provider_call_id) => ({
          provider_call_id,
          n: 1,
        })),
      ),
    );
    expect(bodies.at(-1)?.modelCapabilities?.contextWindow).toBe(1000000);
    expect(
      bodies
        .slice(5)
        .every((b) => !b.systemInstruction.includes('湿润木板，背景灯塔。'.repeat(10))),
    ).toBe(true);
    expect(
      generations.get(resumed.identity.generationId).assistantMessage.attempt?.usage?.inputTokens,
    ).toBe(1200);
  },
  30000,
);

it('records confirmed decisions only from persisted user requirements in the active task', async () => {
  const { conversation, generations, project, workflow } = await setup();
  const loop = createSystemLoop(project, workflow);
  const prepared = generations.prepare({
    conversationId: conversation.id,
    prompt: '保持蓝衣和原文对白',
    providerProfileId: 'profile',
    modelId: 'model',
  });
  const agent = loop.prepare(prepared.stream, '保持蓝衣和原文对白');
  const manager = new AgentContextManager(
    project,
    prepared.stream,
    agent.taskId,
    '保持蓝衣和原文对白',
  );
  const { taskCheckpoint } = await import('./agent-task-checkpoints.js');
  project.access(true, (db, current) => {
    const identity = { ...prepared.stream, taskId: agent.taskId, toolCallId: 'decision' };
    expect(() =>
      taskCheckpoint(
        db,
        current.id,
        { operation: 'decision', sourceRequirementId: 'original', decision: '删除人物' },
        identity,
      ),
    ).toThrow('quote');
    const args = { operation: 'decision', sourceRequirementId: 'original', decision: '原文对白' };
    expect(taskCheckpoint(db, current.id, args, identity)).toMatchObject({
      status: 'task_decision_recorded',
      text: '原文对白',
    });
    taskCheckpoint(db, current.id, args, identity);
    expect(
      new AgentContextStore(db).loadTask(current.id, agent.taskId)?.confirmedDecisions,
    ).toHaveLength(1);
    expect(() => taskCheckpoint(db, current.id, args, { ...identity, taskId: 'other' })).toThrow(
      'active',
    );
  });
  manager.finish('completed');
});
