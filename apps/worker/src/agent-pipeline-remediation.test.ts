import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProductionAuthoringIR } from '@ai-video/contracts';
import {
  validateToolArguments,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { GenerationService } from './generation-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { AgentSystemToolService } from './agent-system-tool-service.js';
import { ProjectStructureCompiler } from './structure-compiler.js';
import { AgentProviderLoopService } from './agent-provider-loop-service.js';
import { ChangeSetService } from './change-set-service.js';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import { RepeatedReadResults } from './repeated-read-results.js';
import { parseEpisodeStructureArguments } from './episode-structure.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { splitConversationRequest } from './conversation-request.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
import { ProductionService } from './production-service.js';
import type { NativeProviderHostEvent, NativeProviderStreamStartParams } from '@ai-video/contracts';

function scriptedBridge(
  script: (params: NativeProviderStreamStartParams, index: number) => NativeProviderHostEvent[],
  reportUsage = false,
) {
  const requests: NativeProviderStreamStartParams[] = [];
  const bridge = new NativeProviderBridge({
    async send(envelope) {
      if (envelope.method !== 'provider.stream.start') return;
      const params = envelope.params as NativeProviderStreamStartParams;
      const index = requests.push(params) - 1;
      await Promise.resolve();
      const events: NativeProviderHostEvent[] = reportUsage
        ? [
            {
              type: 'usage',
              projectSessionId: params.projectSessionId,
              usage: {
                inputTokens: 1000 + index * 100,
                cachedInputTokens: index * 10,
                outputTokens: 10,
                totalTokens: 1010 + index * 100,
              },
            },
            ...script(params, index),
          ]
        : script(params, index);
      for (const [sequence, event] of events.entries())
        bridge.handleEnvelope({
          kind: 'host.event',
          requestId: envelope.requestId,
          sequence,
          event,
        });
    },
  });
  return { bridge, requests };
}

function lastOutput(params: NativeProviderStreamStartParams): Record<string, unknown> {
  return JSON.parse(params.continuation!.outputs[0]!.output) as Record<string, unknown>;
}

const fixtures: Array<{ project: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const { project, directory } of fixtures.splice(0)) {
    project.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function authoring(shot = false): ProductionAuthoringIR {
  return {
    schemaVersion: 1,
    kind: shot ? 'shot' : 'scene',
    prompt: '庭院清晨，人物停顿后转身。',
    ...(shot ? { timing: { estimatedDurationSeconds: 4, rationale: '停顿后转身' } } : {}),
  };
}

it.each(['begin', 'put_scene', 'put_shots', 'finalize', 'checkpoint'])(
  'declares operation-specific stage requirements (%s)',
  (operation) => {
    const definition = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.structure.stage')!;
    expect(() => {
      validateToolArguments(definition, {
        type: 'toolCall',
        id: 'missing',
        name: definition.name,
        arguments: { operation, resourceId: 'workspace:shots' },
      });
    }).toThrow();
  },
);

it('uses a trusted observed zero stage version when omitted and omits unknown optional dates', async () => {
  const f = await setup();
  const run = f.prepare('生成场次');
  const state = await run.invoke('scene.structure.stage', {
    operation: 'begin',
    resourceId: 'workspace:shots',
    executionKey: 'observed-zero',
    episodeTitle: '清晨',
    sceneShotCounts: [1],
  });
  const setupInstruction = authoring();
  const saved = await run.invoke('scene.structure.stage', {
    operation: 'put_scene',
    resourceId: 'workspace:shots',
    stageId: state.stageId,
    sceneIndex: 0,
    scene: {
      title: '庭院',
      sceneDocumentId: f.setting.id,
      characterDocumentIds: [],
      authoringIR: setupInstruction,
    },
  });
  expect(saved, JSON.stringify(saved)).toMatchObject({
    status: 'scene_structure_staging',
    rowVersion: 1,
  });
  const other = f.prepare('另一个独立请求');
  const result = await other.invoke('scene.structure.stage', {
    operation: 'put_shots',
    resourceId: 'workspace:shots',
    stageId: state.stageId,
    sceneIndex: 0,
    shotOffset: 0,
    shots: [{ title: '镜头', authoringIR: authoring(true) }],
  });
  expect(JSON.stringify(result)).toContain('STAGE_VERSION_REQUIRED');
  expect(f.content.listScenes()).toHaveLength(0);
});

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'compacts old versioned library text through Native/Pi and retains real SQLite sources (%s)',
  async (protocol) => {
    const f = await setup(protocol, 40000);
    const body = '长资料正文'.repeat(4000);
    const large = f.content.saveDocument({
      kind: 'note',
      title: '唯一长资料',
      contentMarkdown: body,
    });
    f.content.saveDocument({
      kind: 'note',
      title: '短资料甲',
      contentMarkdown: '用户手工修改：青色衣服',
    });
    f.content.saveDocument({
      kind: 'note',
      title: '短资料乙',
      contentMarkdown: '只核查，不改写。',
    });
    const run = f.prepare('核查三份资料，保留用户手工修改，不写入');
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `budget-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `budget-response-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      if (index % 2 === 0 && index < 6)
        return tool('library.search', {
          query: ['唯一长资料', '短资料甲', '短资料乙'][index / 2],
          sourceTypes: ['document'],
          limit: 1,
        });
      if (index < 6) {
        const result = lastOutput(params) as { sources: Array<{ sourceHandle: string }> };
        return tool('library.read', {
          sourceHandle: result.sources[0]!.sourceHandle,
          readMode: 'source',
          maxChars: 20000,
        });
      }
      expect(index).toBe(6);
      return [
        { ...common, type: 'text_delta', delta: '已核查，手工修改保留。' },
        { ...common, type: 'complete', providerResponseId: 'budget-final', finishReason: 'stop' },
      ];
    }, true);
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      bridge,
      plans: {} as never,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '核查三份资料',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status, result.error).toBe('complete');
    expect(requests).toHaveLength(7);
    expect(result.assistantMessage.attempt?.accounting).toMatchObject({
      requestCount: 7,
      completeRequests: 7,
      coverage: 'complete',
    });
    expect(
      result.assistantMessage.attempt?.accounting?.requests.some(
        (request) => request.context?.compactionCount === 1,
      ),
    ).toBe(true);
    const shortened = requests.find((params) => JSON.stringify(params).includes('reread_required'));
    expect(shortened).toBeDefined();
    expect(JSON.stringify(shortened)).toContain(large.id);
    expect(JSON.stringify(shortened)).toContain('draft');
    if (protocol === 'openai-responses') expect(shortened?.continuation).toBeUndefined();
    else expect(shortened?.continuation).toMatchObject({ protocol });
    expect(f.content.getDocument(large.id).currentVersion?.contentMarkdown).toBe(body);
  },
);

it('rejects duplicate authored text in both tool Schema and direct Worker parsing', () => {
  const tool = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'scene.submit_structure')!;
  const base = {
    resourceId: 'workspace:shots',
    resolution: 'resolved',
    episodeTitle: '测试',
    scenes: [
      {
        title: '场次',
        sceneDocumentId: 'setting',
        characterDocumentIds: [],
        authoringIR: authoring(),
        shots: [{ title: '镜头', authoringIR: authoring(true) }],
      },
    ],
  };
  for (const field of ['videoPrompt', 'prompt']) {
    const args = structuredClone(base);
    if (field === 'videoPrompt') Reflect.set(args.scenes[0]!, field, '重复正文');
    else Reflect.set(args.scenes[0]!.shots[0]!, field, '重复正文');
    expect(() => {
      validateToolArguments(tool, {
        type: 'toolCall',
        id: 'schema',
        name: tool.name,
        arguments: args,
      });
    }).toThrow();
    expect(() =>
      parseEpisodeStructureArguments(
        JSON.stringify({ episodeTitle: args.episodeTitle, scenes: args.scenes }),
      ),
    ).toThrow('unsupported field');
  }
});

it.each([
  ['openai-responses', true],
  ['openai-responses', false],
  ['openai-chat-completions', true],
  ['openai-chat-completions', false],
] as const)(
  'keeps saved progress and one shared 24-request budget across reads, no-ops, loaders and repair (%s, stop=%s)',
  async (protocol, finalStop) => {
    const f = await setup(protocol);
    const scene = f.content.saveScene({ title: '已保存场次', sceneDocumentId: f.setting.id });
    const shots = Array.from({ length: 4 }, (_, i) =>
      f.content.saveShot({
        sceneId: scene.id,
        title: `镜头${i}`,
        authoringIR: { schemaVersion: 1, kind: 'shot', prompt: '原文' },
      }),
    );
    const targets = [
      { kind: 'scene' as const, id: scene.id },
      ...shots.map((shot) => ({ kind: 'shot' as const, id: shot.id })),
    ];
    const production = new ProductionService(f.project);
    const operations = () => ({
      shots: f.content.listShots(scene.id).map((shot) => ({
        shotId: shot.id,
        expectedRowVersion: shot.rowVersion,
        authoringIR: authoring(true),
      })),
    });
    const run = f.prepare('更新已有镜头的制作提示词');
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `boundary-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `boundary-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      if (index === 0)
        return tool('tools.load', {
          names: ['scene.read', 'production.read', 'scene.update_shot_prompts'],
        });
      if (index === 1 || index === 4 || index === 22)
        return tool('scene.update_shot_prompts', operations());
      if (index === 2) return tool('scene.read', { sceneId: scene.id });
      if (index === 3) return tool('production.read', { target: targets[1] });
      if (index === 5)
        expect(lastOutput(params)).toMatchObject({
          status: 'shot_prompts_saved',
          changedCount: 0,
          unchangedCount: 4,
        });
      if (index === 21 || (index === 23 && !finalStop))
        return [
          {
            ...common,
            type: 'failed',
            error: {
              code: 'PROVIDER_FAILED',
              retryable: false,
              message:
                'INVALID_TOOL_ARGUMENTS: scene.update_shot_prompts returned invalid object JSON (100 bytes); finishReason=tool_calls. No tool was executed.',
            },
          },
        ];
      if (index === 23) {
        expect(lastOutput(params)).toMatchObject({ status: 'shot_prompts_saved' });
        return [
          { ...common, type: 'text_delta', delta: '制作提示词已保存。' },
          {
            ...common,
            type: 'complete',
            providerResponseId: 'boundary-final',
            finishReason: 'stop',
          },
        ];
      }
      if (index > 23) throw new Error('Must not send request 25');
      return tool('tools.load', { names: ['production.read', 'scene.update_shot_prompts'] });
    }, true);
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      bridge,
      plans: {} as never,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '更新已有镜头的制作提示词',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status, result.error).toBe(finalStop ? 'complete' : 'failed');
    if (!finalStop) expect(result.error).toContain('24-turn limit');
    expect(requests).toHaveLength(24);
    expect(result.assistantMessage.attempt?.usage).toMatchObject({
      inputTokens: 51_600,
      cachedInputTokens: 2_760,
      outputTokens: 240,
      totalTokens: 51_840,
    });
    // Tool selections change repeatedly before the first output repair;
    // their policies and frozen context must remain byte-identical.
    for (const request of requests.slice(0, 22))
      expect(request.systemInstruction).toBe(requests[0]!.systemInstruction);
    expect(requests[0]!.systemInstruction).not.toContain('# Agent document');
    expect(requests[1]!.continuation!.outputs[0]!.output).toContain(
      'Production reads use bounded views',
    );
    expect(requests[0]!.tools!.some((tool) => tool.name === 'scene.update_shot_prompts')).toBe(
      false,
    );
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(scene.id)).toHaveLength(4);
    f.project.access(false, (db) => {
      expect(db.prepare('SELECT COUNT(*) n FROM agent_write_receipts').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get()).toEqual({ n: 0 });
    });
    f.project.close();
    f.project.open(join(f.directory, 'project'));
    for (const shot of shots) {
      expect(production.read({ kind: 'shot', id: shot.id })).toMatchObject({
        rowVersion: shot.rowVersion + 1,
        authoringIR: authoring(true),
        issues: [],
      });
    }
  },
);

it('does not complete a rejected scene write, and records failure instead of tool success', async () => {
  const f = await setup();
  const run = f.prepare('创建场次');
  expect(
    await run.invoke('scene.submit_structure', {
      resourceId: 'workspace:shots',
      resolution: 'resolved',
      episodeTitle: '失败',
      scenes: [
        {
          title: '场次',
          sceneDocumentId: 'missing',
          characterDocumentIds: [],
          authoringIR: authoring(),
          shots: [{ title: '镜头', authoringIR: authoring(true) }],
        },
      ],
    }),
  ).toMatchObject({ status: 'rejected' });
  const events = f.workflow.getTask({ taskId: run.agent.taskId }).events;
  expect(
    events.some(
      (e) => e.eventType === 'agent.tool.failed' && e.summary.includes('scene.submit_structure'),
    ),
  ).toBe(true);
  expect(
    events.some(
      (e) => e.eventType === 'agent.tool.succeeded' && e.summary.includes('scene.submit_structure'),
    ),
  ).toBe(false);
  f.loop.startProviderStep(run.prepared.stream);
  expect(() =>
    f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
  ).toThrow('AGENT_SCENE_NOT_SAVED');
  expect(f.content.listScenes()).toHaveLength(0);
  const repaired = await run.invoke('scene.submit_structure', {
    resourceId: 'workspace:shots',
    resolution: 'resolved',
    episodeTitle: '修正',
    scenes: [
      {
        title: '场次',
        sceneDocumentId: f.setting.id,
        characterDocumentIds: [],
        authoringIR: authoring(),
        shots: [{ title: '镜头', authoringIR: authoring(true) }],
      },
    ],
  });
  expect(repaired.status).toBe('scene_structure_saved');
  f.loop.startProviderStep(run.prepared.stream);
  expect(() =>
    f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
  ).not.toThrow();
});

it.each(['schema', 'stage'] as const)(
  'keeps an unfinished %s submission from becoming read-only completion',
  async (kind) => {
    const f = await setup();
    const run = f.prepare('创建场次');
    if (kind === 'schema')
      f.loop.recordValidationFailure(
        run.prepared.stream,
        'scene.submit_structure',
        100,
        'stillFrame is missing',
      );
    else
      await run.invoke('scene.structure.stage', {
        resourceId: 'workspace:shots',
        operation: 'begin',
        executionKey: 'unfinished',
        episodeTitle: '未完成',
        sceneShotCounts: [1],
      });
    f.loop.startProviderStep(run.prepared.stream);
    expect(() =>
      f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
    ).toThrow('AGENT_SCENE_NOT_SAVED');
  },
);

it.each([
  ['openai-responses', 'schema'],
  ['openai-responses', 'business'],
  ['openai-responses', 'stage'],
  ['openai-chat-completions', 'schema'],
  ['openai-chat-completions', 'business'],
  ['openai-chat-completions', 'stage'],
] as const)(
  'ends the generation as failed after an unresolved %s/%s write',
  async (protocol, kind) => {
    const f = await setup(protocol);
    const run = f.prepare('生成场次');
    const { bridge } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const complete: NativeProviderHostEvent = {
        ...common,
        type: 'complete',
        providerResponseId: `unfinished-${index}`,
        finishReason: 'tool_calls',
      };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `unfinished-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        complete,
      ];
      if (index === 0)
        return tool('tools.load', {
          names: [kind === 'stage' ? 'scene.structure.stage' : 'scene.submit_structure'],
        });
      if (index === 1) {
        if (kind === 'stage')
          return tool('scene.structure.stage', {
            resourceId: 'workspace:shots',
            operation: 'begin',
            executionKey: 'abandoned',
            episodeTitle: '未完成',
            sceneShotCounts: [1],
          });
        const shot = authoring(true);
        if (kind === 'schema') Reflect.deleteProperty(shot, 'prompt');
        return tool('scene.submit_structure', {
          resourceId: 'workspace:shots',
          resolution: 'resolved',
          episodeTitle: '未完成',
          scenes: [
            {
              title: '场次',
              sceneDocumentId: kind === 'business' ? 'missing' : f.setting.id,
              characterDocumentIds: [],
              authoringIR: authoring(),
              shots: [{ title: '镜头', authoringIR: shot }],
            },
          ],
        });
      }
      expect(index).toBe(2);
      return [
        { ...common, type: 'text_delta', delta: '本次尚未生成场次。' },
        { ...complete, finishReason: 'stop' },
      ];
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      bridge,
      plans: {} as never,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '生成场次',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('AGENT_SCENE_NOT_SAVED');
    const detail = f.workflow.getTask({ taskId: run.agent.taskId });
    expect(detail.task.status).toBe('failed');
    expect(detail.events.some((e) => e.eventType === 'agent.task.completed')).toBe(false);
    expect(f.content.listScenes()).toHaveLength(0);
  },
);

it('does not hide a second unfinished stage behind another saved stage in the same task', async () => {
  const f = await setup();
  const run = f.prepare('创建多个场次');
  await run.invoke('scene.structure.stage', {
    resourceId: 'workspace:shots',
    operation: 'begin',
    executionKey: 'pending-second',
    episodeTitle: '第二场',
    sceneShotCounts: [1],
  });
  const saved = await run.invoke('scene.submit_structure', {
    resourceId: 'workspace:shots',
    resolution: 'resolved',
    episodeTitle: '第一场',
    scenes: [
      {
        title: '第一场',
        sceneDocumentId: f.setting.id,
        characterDocumentIds: [],
        authoringIR: authoring(),
        shots: [{ title: '镜头', authoringIR: authoring(true) }],
      },
    ],
  });
  expect(saved.status).toBe('scene_structure_saved');
  f.loop.startProviderStep(run.prepared.stream);
  expect(() =>
    f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
  ).toThrow('尚未保存为完整场次');
});

it('ends an explicit non-empty checkpoint as visibly partial and keeps normal incomplete tasks unresolved', async () => {
  const f = await setup();
  const run = f.prepare('创作第一场并保留续作进度');
  const base = { resourceId: 'workspace:shots' };
  let state = await run.invoke('scene.structure.stage', {
    ...base,
    operation: 'begin',
    executionKey: 'explicit-partial-checkpoint',
    episodeTitle: '第一集',
    sceneShotCounts: [2],
  });
  state = await run.invoke('scene.structure.stage', {
    ...base,
    operation: 'put_scene',
    stageId: state.stageId,
    expectedRowVersion: state.rowVersion,
    sceneIndex: 0,
    scene: {
      title: '村口',
      sceneDocumentId: f.setting.id,
      characterDocumentIds: [],
      authoringIR: authoring(),
    },
  });
  const checkpoint = await run.invoke('scene.structure.stage', {
    ...base,
    operation: 'checkpoint',
    stageId: state.stageId,
    expectedRowVersion: state.rowVersion,
  });
  expect(checkpoint).toMatchObject({
    status: 'scene_structure_checkpointed',
    checkpointed: true,
    complete: false,
  });
  f.loop.startProviderStep(run.prepared.stream);
  f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' });
  const task = f.workflow.getTask({ taskId: run.agent.taskId }).task;
  expect(task).toMatchObject({ status: 'completed', completionState: 'partial' });
  expect(task.outcome).toBeUndefined();
});

async function setup(
  protocol: NativeProviderStreamStartParams['protocol'] = 'openai-chat-completions',
  contextWindowTokens?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-pipeline-remediation-'));
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  project.create(join(directory, 'project'), '隔离回归');
  fixtures.push({ project, directory });
  const content = new ContentService(project);
  const conversation = content.createConversation({ scopeType: 'project' });
  const setting = content.saveDocument({
    kind: 'scene',
    title: '庭院',
    contentMarkdown: '设定正文不自动注入',
  });
  const workflow = new DocumentWorkflowService(project);
  const system = new AgentSystemToolService(
    project,
    content,
    {} as never,
    { listProfiles: () => [], listModels: () => [] },
    undefined,
    workflow,
    undefined,
    new ProjectStructureCompiler(),
  );
  const loop = new AgentProviderLoopService(
    project,
    workflow,
    undefined,
    undefined,
    undefined,
    undefined,
    system,
  );
  const generations = new GenerationService(
    project,
    content,
    new ContextService(project),
    {
      status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: false }),
      stream: () => Promise.reject(new Error('No network')),
    },
    {
      selectionResolver: {
        resolveLlmSelection: () => ({
          providerProfileId: 'profile',
          providerName: 'Mock',
          modelId: 'model',
          modelName: 'Mock',
          remoteModelId: 'mock',
          protocol,
          contextWindowTokens,
          baseUrl: 'https://mock.invalid',
        }),
      },
    },
  );
  const prepare = (prompt: string) => {
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt,
      providerProfileId: 'profile',
      modelId: 'model',
      taskExecution: 'parallel',
    });
    const agent = loop.prepare(prepared.stream, prompt, undefined, { operation: 'document.list' });
    generations.configureAgentTools(prepared.stream, agent.tools);
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
            authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
            argumentsJson: JSON.stringify(args),
          },
        ],
      });
      if (result.tools) tools = result.tools;
      return JSON.parse(result.continuation!.outputs[0]!.output) as Record<string, unknown>;
    };
    return { prepared, agent, invoke };
  };
  return {
    project,
    directory,
    content,
    conversation,
    setting,
    workflow,
    loop,
    generations,
    prepare,
  };
}

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'recovers Native and bridge JSON failures into one saved scene without repeating reads or saved parts (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('【本会话要求约束】\n固定清晨水墨风格\n\n【用户本次请求】\n生成庭院镜头');
    let stageId: unknown;
    let savedVersion: unknown;
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const complete: NativeProviderHostEvent = {
        ...common,
        type: 'complete',
        providerResponseId: `response-${index}`,
        finishReason: 'tool_calls',
      };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `call-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        complete,
      ];
      const base = { resourceId: 'workspace:shots' };
      if (index === 0) return tool('library.search', { query: '庭院', sourceTypes: ['document'] });
      if (index === 1) {
        const sources = lastOutput(params).sources as Array<{ sourceHandle: string }>;
        return tool('library.read', { sourceHandle: sources[0]!.sourceHandle, readMode: 'source' });
      }
      if (index === 2) return tool('tools.load', { names: ['scene.submit_structure'] });
      if (index === 3)
        return [
          {
            ...common,
            type: 'failed',
            error: {
              code: 'PROVIDER_FAILED',
              retryable: false,
              message:
                'INVALID_TOOL_ARGUMENTS: scene.submit_structure returned invalid object JSON (18610 bytes); finishReason=tool_calls. No tool was executed. jsonError=syntax; line=10; column=42',
            },
          },
        ];
      if (index === 4 || index === 8) {
        expect(params.systemInstruction).toContain('[TOOL OUTPUT RECOVERY]');
        expect(params.prompt).toContain('固定清晨水墨风格');
        expect(params.tools!.some((item) => item.name === 'scene.structure.stage')).toBe(true);
        expect(params.tools!.some((item) => item.name === 'scene.submit_structure')).toBe(false);
        expect(params.continuation!.outputs[0]!.callId).toBe(index === 4 ? 'call-2' : 'call-6');
        if (index === 8) {
          expect(lastOutput(params).stageId).toBe(stageId);
          expect(lastOutput(params).rowVersion).toBe(savedVersion);
        }
        return tool('scene.structure.stage', {
          ...base,
          operation: 'get',
          ...(index === 8 ? { stageId } : {}),
        });
      }
      if (index === 5)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'begin',
          executionKey: 'recovery-scene',
          episodeTitle: '庭院',
          sceneShotCounts: [1],
        });
      if (index === 6) {
        const state = lastOutput(params);
        stageId = state.stageId;
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_scene',
          stageId,
          expectedRowVersion: state.rowVersion,
          sceneIndex: 0,
          scene: {
            title: '庭院',
            sceneDocumentId: f.setting.id,
            characterDocumentIds: [],
            authoringIR: authoring(),
          },
        });
      }
      if (index === 7) {
        savedVersion = lastOutput(params).rowVersion;
        return [
          {
            ...common,
            type: 'tool_call_end',
            call: {
              id: 'malformed',
              name: 'scene.structure.stage',
              argumentsJson: '{"PRIVATE_BODY":',
            },
          },
          complete,
        ];
      }
      if (index === 9)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_shots',
          stageId,
          expectedRowVersion: lastOutput(params).rowVersion,
          sceneIndex: 0,
          shotOffset: 0,
          shots: [{ title: '转身', authoringIR: authoring(true) }],
        });
      if (index === 10)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'finalize',
          stageId,
          expectedRowVersion: lastOutput(params).rowVersion,
        });
      expect(index).toBe(11);
      expect(lastOutput(params)).toMatchObject({ status: 'scene_structure_saved', applied: true });
      return [
        { ...common, type: 'text_delta', delta: '场次和镜头已保存。' },
        { ...complete, finishReason: 'stop' },
      ];
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      bridge,
      plans: {} as never,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '生成庭院镜头',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(requests).toHaveLength(12);
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(f.content.listScenes()[0]!.id)).toHaveLength(1);
    expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(1);
    const detail = f.workflow.getTask({ taskId: run.agent.taskId });
    const failures = detail.events.filter((item) => item.eventType === 'tool_validation_failed');
    expect(failures).toHaveLength(2);
    expect(detail.events.filter((item) => item.eventType === 'scene.structure.saved')).toHaveLength(
      1,
    );
    expect(failures[0]!.summary).toContain('jsonError=syntax; line=10; column=42');
    expect(failures.every((item) => !item.summary.includes('PRIVATE_BODY'))).toBe(true);
    const tools = f.project.access(false, (db) =>
      db
        .prepare('SELECT tool_name FROM agent_tool_calls WHERE generation_id=?')
        .all(run.prepared.stream.generationId),
    ) as Array<{ tool_name: string }>;
    expect(tools.filter((item) => item.tool_name === 'library.read')).toHaveLength(1);
    expect(tools.some((item) => item.tool_name === 'scene.submit_structure')).toBe(false);
    const failedRequests = f.project.access(false, (db) =>
      db
        .prepare("SELECT id FROM llm_provider_requests WHERE generation_id=? AND stage='failed'")
        .all(run.prepared.stream.generationId),
    );
    expect(failedRequests).toHaveLength(2);
  },
);

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'recovers mixed IR schema/JSON failures with smaller batches, preserving saved scenes and prompt text (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('生成原创短剧场次，保留提示词全文');
    const actor = f.content.saveDocument({
      kind: 'character',
      title: '司机',
      contentMarkdown: '司机资料',
    });
    const prompts = ['抬头说："谁在那里？"\n门外没有回答。', '推门，停顿。', '回望走廊。'];
    const shot = (index: number) => ({
      title: `镜头${index + 1}`,
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: prompts[index],
        references: { characterDocumentIds: [actor.id], sceneDocumentIds: [f.setting.id] },
        data: { camera: { movement: '自由扩展字段' } },
      },
    });
    let stageId: unknown;
    let rowVersion: unknown;
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const complete: NativeProviderHostEvent = {
        ...common,
        type: 'complete',
        providerResponseId: `ir-recovery-${index}`,
        finishReason: 'tool_calls',
      };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `ir-call-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        complete,
      ];
      if (index === 0) return tool('tools.load', { names: ['scene.structure.stage'] });
      if (index === 1)
        return tool('scene.structure.stage', {
          resourceId: 'workspace:shots',
          operation: 'begin',
          executionKey: 'mixed-ir-recovery',
          episodeTitle: '原创测试',
          sceneShotCounts: [1, 3],
        });
      const base = { resourceId: 'workspace:shots', stageId, expectedRowVersion: rowVersion };
      if ([2, 3, 4, 8, 9, 10, 11, 12].includes(index)) {
        const state = lastOutput(params);
        stageId = state.stageId;
        rowVersion = state.rowVersion;
        base.stageId = stageId;
        base.expectedRowVersion = rowVersion;
      }
      if (index === 2 || index === 4)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_scene',
          sceneIndex: index === 2 ? 0 : 1,
          scene: {
            title: index === 2 ? '已完成的第一场' : '第二场',
            authoringIR: {
              schemaVersion: 1,
              kind: 'scene',
              prompt: '完整场次提示词。',
              references: { characterDocumentIds: [actor.id], sceneDocumentIds: [f.setting.id] },
            },
          },
        });
      if (index === 3)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_shots',
          sceneIndex: 0,
          shotOffset: 0,
          shots: [shot(0)],
        });
      if (index === 5) {
        const state = lastOutput(params);
        rowVersion = state.rowVersion;
        return tool('scene.structure.stage', {
          ...base,
          expectedRowVersion: rowVersion,
          operation: 'put_shots',
          sceneIndex: 1,
          shotOffset: 0,
          shots: [{ ...shot(0), camera: 'PRIVATE_BODY' }],
        });
      }
      const stage = params.tools?.find((entry) => entry.name === 'scene.structure.stage');
      const maxItems = (stage?.parameters.properties as Record<string, { maxItems: number }>).shots!
        .maxItems;
      if (index === 6) {
        const feedback = params.continuation!.outputs[0]!.output;
        expect(feedback).toContain('shots[0].camera');
        expect(feedback).toContain('authoringIR.data');
        expect(feedback).not.toContain('PRIVATE_BODY');
        expect(maxItems).toBe(2);
        return [
          {
            ...common,
            type: 'failed',
            error: {
              code: 'PROVIDER_FAILED',
              retryable: false,
              message:
                'INVALID_TOOL_ARGUMENTS: scene.structure.stage returned invalid object JSON (2375 bytes); finishReason=tool_calls. No tool was executed. jsonError=syntax; line=1; column=1752',
            },
          },
        ];
      }
      expect(maxItems).toBe(1);
      if (index === 7) {
        expect(params.systemInstruction).toContain('at most 1 ordered shots');
        return tool('scene.structure.stage', {
          resourceId: 'workspace:shots',
          operation: 'get',
          stageId,
        });
      }
      if (index >= 8 && index <= 10) {
        const state = lastOutput(params);
        expect(state.sceneIds).toHaveLength(1);
        if (index === 8)
          expect(state.scenes).toMatchObject([
            { index: 0, missingShots: [] },
            { index: 1, missingShots: [0, 1, 2] },
          ]);
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_shots',
          sceneIndex: 1,
          shotOffset: index - 8,
          shots: [shot(index - 8)],
        });
      }
      if (index === 11) return tool('scene.structure.stage', { ...base, operation: 'finalize' });
      expect(index).toBe(12);
      expect(lastOutput(params)).toMatchObject({ complete: true, status: 'scene_structure_saved' });
      return [
        { ...common, type: 'text_delta', delta: '两场及全部镜头已保存。' },
        { ...complete, finishReason: 'stop' },
      ];
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      bridge,
      plans: {} as never,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '生成原创短剧场次，保留提示词全文',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    expect(f.generations.get(run.prepared.stream.generationId)).toMatchObject({
      status: 'complete',
    });
    expect(requests).toHaveLength(13);
    const scenes = f.content.listScenes();
    expect(scenes).toHaveLength(2);
    for (const scene of scenes) {
      expect(scene.sceneDocumentId).toBe(f.setting.id);
      expect(scene.characterBindings).toEqual([{ characterDocumentId: actor.id }]);
    }
    expect(f.content.listShots(scenes[0]!.id)).toHaveLength(1);
    expect(f.content.listShots(scenes[1]!.id).map((entry) => entry.prompt)).toEqual(prompts);
    expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(2);
    const failures = f.workflow
      .getTask({ taskId: run.agent.taskId })
      .events.filter((event) => event.eventType === 'tool_validation_failed');
    expect(failures).toHaveLength(2);
    expect(failures[0]!.summary).toContain('shots[0].camera');
    expect(JSON.stringify(failures)).not.toContain('PRIVATE_BODY');
  },
);

it('preserves existing scene identity and prompt when a binding update needs output recovery', async () => {
  const f = await setup();
  const scene = f.content.saveScene({
    title: '已有场次',
    sceneDocumentId: f.setting.id,
    videoPrompt: '保留原有提示词',
    characterBindings: [],
  });
  const run = f.prepare('修订已有场次的绑定');
  const { bridge, requests } = scriptedBridge((params, index) => {
    const common = { projectSessionId: params.projectSessionId };
    const complete: NativeProviderHostEvent = {
      ...common,
      type: 'complete',
      providerResponseId: `update-${index}`,
      finishReason: 'tool_calls',
    };
    const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
      {
        ...common,
        type: 'tool_call_end',
        call: { id: `update-call-${index}`, name, argumentsJson: JSON.stringify(args) },
      },
      complete,
    ];
    if (index === 0) return tool('tools.load', { names: ['scene.submit_structure'] });
    if (index === 1)
      return [
        {
          ...common,
          type: 'failed',
          error: {
            code: 'PROVIDER_FAILED',
            retryable: false,
            message:
              'INVALID_TOOL_ARGUMENTS: scene.submit_structure returned invalid object JSON (100 bytes); finishReason=tool_calls. No tool was executed.',
          },
        },
      ];
    if (index === 2) {
      expect(params.systemInstruction).toContain('For EXISTING scene revisions');
      return tool('tools.load', { names: ['scene.read', 'scene.submit_structure'] });
    }
    if (index === 3) return tool('scene.read', { sceneId: scene.id });
    if (index === 4)
      return tool('scene.submit_structure', {
        resourceId: 'workspace:shots',
        resolution: 'resolved',
        episodeTitle: '已有场次',
        scenes: [
          {
            sceneId: scene.id,
            expectedRowVersion: scene.rowVersion,
            title: scene.title,
            sceneDocumentId: null,
            characterDocumentIds: [],
            shots: [],
          },
        ],
      });
    expect(index).toBe(5);
    expect(lastOutput(params).status).toBe('scene_structure_saved');
    return [
      { ...common, type: 'text_delta', delta: '绑定已更新。' },
      { ...complete, finishReason: 'stop' },
    ];
  });
  const runtime = new PiConversationRuntime({
    generation: f.generations,
    providerTools: f.loop,
    bridge,
    plans: {} as never,
    createGateway: () => {
      throw new Error('No planning');
    },
  });
  await runtime.start({
    ...run.prepared.stream,
    identity: run.prepared.stream,
    taskId: run.agent.taskId,
    prompt: '修订已有场次的绑定',
    mode: 'document',
  });
  await runtime.wait(run.prepared.stream.generationId);
  const result = f.generations.get(run.prepared.stream.generationId);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('complete');
  expect(requests).toHaveLength(6);
  expect(f.content.listScenes()).toEqual([
    expect.objectContaining({ id: scene.id, videoPrompt: '保留原有提示词' }),
  ]);
});

it.each([
  [
    'INVALID_TOOL_ARGUMENTS: scene.submit_structure returned invalid object JSON (18610 bytes); finishReason=tool_calls. No tool was executed.',
    3,
  ],
  [
    'INCOMPLETE_PROVIDER_OUTPUT: finishReason=length; 1 tool calls, 18000 argument bytes. No tool was executed.',
    3,
  ],
  [
    'INCOMPLETE_TOOL_OUTPUT: finishReason=max_tokens. No tool was executed; use smaller staged submissions.',
    3,
  ],
  [
    'INCOMPLETE_PROVIDER_OUTPUT: finishReason=content_filter; 1 tool calls, 100 argument bytes. No tool was executed.',
    1,
  ],
  ['LLM stream ended before a protocol success event.', 1],
  ['Provider rejected the configured credential.', 1],
  ['STALE_SESSION: project switched.', 1],
] as const)(
  'bounds safe output repair and never retries other failures: %s',
  async (message, count) => {
    const f = await setup();
    const run = f.prepare('生成庭院镜头');
    const { bridge, requests } = scriptedBridge((params) => [
      {
        type: 'failed',
        projectSessionId: params.projectSessionId,
        error: { code: 'PROVIDER_FAILED', retryable: false, message },
      },
    ]);
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      bridge,
      plans: {} as never,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '生成庭院镜头',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const failed = f.generations.get(run.prepared.stream.generationId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain(count === 3 ? 'TOOL_OUTPUT_REPAIR_LIMIT' : message);
    expect(requests).toHaveLength(count);
    expect(f.content.listScenes()).toHaveLength(0);
    expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(0);
    const failures = f.workflow
      .getTask({ taskId: run.agent.taskId })
      .events.filter((item) => item.eventType === 'tool_validation_failed');
    expect(failures).toHaveLength(count === 3 ? 3 : 0);
  },
);

it('stops output recovery before sending another request when cancelled at the repair boundary', async () => {
  const f = await setup();
  const run = f.prepare('生成庭院镜头');
  const { bridge, requests } = scriptedBridge((params) => [
    {
      type: 'failed',
      projectSessionId: params.projectSessionId,
      error: {
        code: 'PROVIDER_FAILED',
        retryable: false,
        message:
          'INVALID_TOOL_ARGUMENTS: scene.submit_structure returned invalid object JSON (100 bytes); finishReason=tool_calls. No tool was executed.',
      },
    },
  ]);
  const runtime = new PiConversationRuntime({
    generation: f.generations,
    providerTools: f.loop,
    bridge,
    plans: {} as never,
    createGateway: () => {
      throw new Error('No planning');
    },
    onEvent: (event) => {
      if (event.type === 'turn_started' && event.turn === 2)
        runtime.cancel(run.prepared.stream.generationId);
    },
  });
  await runtime.start({
    ...run.prepared.stream,
    identity: run.prepared.stream,
    taskId: run.agent.taskId,
    prompt: '生成庭院镜头',
    mode: 'document',
  });
  await runtime.wait(run.prepared.stream.generationId);
  expect(f.generations.get(run.prepared.stream.generationId).status).toBe('cancelled');
  expect(requests).toHaveLength(1);
  expect(f.content.listScenes()).toHaveLength(0);
});

it('resumes staged authoring across a cancelled task and saves one editable draft with real IDs without approval', async () => {
  const f = await setup();
  const first = f.prepare('生成两镜');
  const base = { resourceId: 'workspace:shots' };
  let state = await first.invoke('scene.structure.stage', {
    ...base,
    operation: 'begin',
    executionKey: 'episode-1',
    episodeTitle: '第一集',
    sceneShotCounts: [2],
  });
  expect(state.status, JSON.stringify(state)).toBe('scene_structure_staging');
  const stageId = state.stageId;
  const setupArgs = {
    ...base,
    operation: 'put_scene',
    stageId,
    expectedRowVersion: state.rowVersion,
    sceneIndex: 0,
    scene: {
      title: '庭院',
      sceneDocumentId: f.setting.id,
      characterDocumentIds: [],
      authoringIR: authoring(),
    },
  };
  state = await first.invoke('scene.structure.stage', setupArgs);
  const version = state.rowVersion;
  expect((await first.invoke('scene.structure.stage', setupArgs)).rowVersion).toBe(version);
  expect(
    await first.invoke('scene.structure.stage', {
      ...base,
      operation: 'finalize',
      stageId,
      expectedRowVersion: version,
    }),
  ).toMatchObject({ status: 'scene_structure_staging', complete: false });
  expect(new ChangeSetService(f.project).list()).toHaveLength(0);
  await f.generations.cancel(first.prepared.stream.generationId);
  f.loop.terminateGeneration(first.prepared.stream.generationId, 'cancelled');
  f.project.close();
  f.project.open(join(f.directory, 'project'));
  const second = f.prepare('继续未完成的分镜');
  const unfinished = await second.invoke('scene.structure.stage', { ...base, operation: 'get' });
  expect(unfinished.stages).toEqual([expect.objectContaining({ stageId })]);
  state = await second.invoke('scene.structure.stage', { ...base, operation: 'get', stageId });
  const shots = [0, 1].map((index) => ({
    title: `镜头${index + 1}`,
    authoringIR: authoring(true),
  }));
  state = await second.invoke('scene.structure.stage', {
    ...base,
    operation: 'put_shots',
    stageId,
    expectedRowVersion: state.rowVersion,
    sceneIndex: 0,
    shotOffset: 0,
    shots,
  });
  state = await second.invoke('scene.structure.stage', {
    ...base,
    operation: 'finalize',
    stageId,
    expectedRowVersion: state.rowVersion,
  });
  expect(state.status).toBe('scene_structure_saved');
  expect(f.content.listScenes()).toHaveLength(1);
  expect(
    (await second.invoke('scene.structure.stage', { ...base, operation: 'finalize', stageId }))
      .changeSetId,
  ).toBe(state.changeSetId);
  const changes = new ChangeSetService(f.project);
  expect(changes.list()).toHaveLength(0);
  expect(changes.list({ includeTerminal: true })).toHaveLength(1);
  expect(state).toMatchObject({ applied: true, reviewRequired: false });
  expect(f.content.listScenes()).toHaveLength(1);
  expect(f.content.listShots(f.content.listScenes()[0]!.id)).toHaveLength(2);
  f.loop.startProviderStep(second.prepared.stream);
  f.loop.completeProviderStep({ ...second.prepared.stream, finishReason: 'stop' });
  expect(f.workflow.getTask({ taskId: second.agent.taskId }).task.outcome).not.toBe('read-only');
});

it('keeps an earlier scene saved when a later staged scene is incomplete or fails', async () => {
  const f = await setup();
  const run = f.prepare('依次生成两场');
  const base = { resourceId: 'workspace:shots' };
  let state = await run.invoke('scene.structure.stage', {
    ...base,
    operation: 'begin',
    executionKey: 'two-scene-atomicity',
    episodeTitle: '两场',
    sceneShotCounts: [1, 1],
  });
  const stageId = state.stageId;
  const putScene = async (sceneIndex: number) => {
    state = await run.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_scene',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      scene: {
        title: `场次${sceneIndex + 1}`,
        sceneDocumentId: f.setting.id,
        characterDocumentIds: [],
        authoringIR: authoring(),
      },
    });
  };
  const putShot = async (sceneIndex: number, shotInstruction: ProductionAuthoringIR) => {
    state = await run.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_shots',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      shotOffset: 0,
      shots: [{ title: `镜头${sceneIndex + 1}`, authoringIR: shotInstruction }],
    });
  };

  await putScene(0);
  await putShot(0, authoring(true));
  expect(state).toMatchObject({
    status: 'scene_structure_partially_saved',
    complete: false,
    sceneIds: [expect.any(String)],
  });
  const firstSceneId = (state.sceneIds as string[])[0]!;
  expect(f.content.listScenes()).toHaveLength(1);
  await putScene(1);
  const checkpoint = await run.invoke('scene.structure.stage', {
    ...base,
    operation: 'finalize',
    stageId,
    expectedRowVersion: state.rowVersion,
  });
  expect(checkpoint).toMatchObject({
    status: 'scene_structure_partially_saved',
    complete: false,
    sceneIds: [firstSceneId],
  });
  expect(f.content.listScenes()).toHaveLength(1);

  await expect(
    run.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_shots',
      stageId,
      expectedRowVersion: checkpoint.rowVersion,
      sceneIndex: 1,
      shotOffset: 0,
      shots: [{ title: '坏镜头', authoringIR: { ...authoring(true), unknown: true } }],
    }),
  ).resolves.toMatchObject({ status: 'rejected' });
  expect(f.content.listScenes()).toHaveLength(1);
  expect(f.content.listShots(firstSceneId)).toHaveLength(1);

  state = await run.invoke('scene.structure.stage', {
    ...base,
    operation: 'put_shots',
    stageId,
    expectedRowVersion: checkpoint.rowVersion,
    sceneIndex: 1,
    shotOffset: 0,
    shots: [{ title: '镜头2', authoringIR: authoring(true) }],
  });
  expect(state).toMatchObject({
    status: 'scene_structure_saved',
    complete: true,
    sceneIds: [firstSceneId, expect.any(String)],
  });
  expect(f.content.listScenes()).toHaveLength(2);
  expect(f.content.listShots(firstSceneId)).toHaveLength(1);
});

it('continues a 17-scene, 47-shot manifest across a real tool-budget checkpoint without duplicates', async () => {
  const f = await setup();
  const counts = [...Array<number>(13).fill(3), ...Array<number>(4).fill(2)];
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(47);
  const base = { resourceId: 'workspace:shots' };
  const first = f.prepare('生成 17 场 47 镜');
  let state = await first.invoke('scene.structure.stage', {
    ...base,
    operation: 'begin',
    executionKey: 'seventeen-scenes-forty-seven-shots',
    episodeTitle: '17 场测试',
    sceneShotCounts: counts,
  });
  const stageId = state.stageId;
  for (let sceneIndex = 0; sceneIndex < 15; sceneIndex++) {
    state = await first.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_scene',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      scene: {
        title: `场${sceneIndex + 1}`,
        sceneDocumentId: f.setting.id,
        characterDocumentIds: [],
        authoringIR: authoring(),
      },
    });
    state = await first.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_shots',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      shotOffset: 0,
      shots: Array.from({ length: counts[sceneIndex]! }, (_, offset) => ({
        title: `场${sceneIndex + 1}镜${offset + 1}`,
        authoringIR: authoring(true),
      })),
    });
  }
  expect(f.content.listScenes()).toHaveLength(15);
  expect(state.businessCallsRemaining).toBe(1);
  expect(state.minimumRemainingWrites).toBe(4);
  const partial = await first.invoke('scene.structure.stage', {
    ...base,
    operation: 'checkpoint',
    stageId,
    expectedRowVersion: state.rowVersion,
  });
  expect(partial).toMatchObject({ status: 'scene_structure_checkpointed', complete: false });
  expect((partial.sceneIds as string[]).length).toBeGreaterThan(0);
  f.loop.startProviderStep(first.prepared.stream);
  f.loop.completeProviderStep({ ...first.prepared.stream, finishReason: 'stop' });
  expect(f.workflow.getTask({ taskId: first.agent.taskId }).task.completionState).toBe('partial');

  const second = f.prepare('继续 17 场测试');
  state = await second.invoke('scene.structure.stage', { ...base, operation: 'get', stageId });
  expect(state.nextSceneIndex).toBe(15);
  for (let sceneIndex = 15; sceneIndex < counts.length; sceneIndex++) {
    state = await second.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_scene',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      scene: {
        title: `场${sceneIndex + 1}`,
        sceneDocumentId: f.setting.id,
        characterDocumentIds: [],
        authoringIR: authoring(),
      },
    });
    state = await second.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_shots',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      shotOffset: 0,
      shots: Array.from({ length: counts[sceneIndex]! }, (_, offset) => ({
        title: `场${sceneIndex + 1}镜${offset + 1}`,
        authoringIR: authoring(true),
      })),
    });
  }
  expect(state).toMatchObject({ status: 'scene_structure_saved', complete: true });
  f.loop.startProviderStep(second.prepared.stream);
  f.loop.completeProviderStep({ ...second.prepared.stream, finishReason: 'stop' });
  const scenes = f.content.listScenes();
  expect(scenes).toHaveLength(17);
  expect(new Set(state.sceneIds as string[]).size).toBe(17);
  expect(scenes.reduce((sum, scene) => sum + f.content.listShots(scene.id).length, 0)).toBe(47);
  expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(17);
});

it('shares create/update validation, retains binding text, rejects conflicting text and preflights total/rendered limits', async () => {
  const f = await setup();
  const run = f.prepare('修订绑定');
  const current = f.content.saveScene({
    title: '旧场次',
    sceneDocumentId: f.setting.id,
    videoPrompt: '手写原文标记',
    characterBindings: [],
  });
  const scene = {
    title: current.title,
    sceneId: current.id,
    expectedRowVersion: current.rowVersion,
    sceneDocumentId: f.setting.id,
    characterDocumentIds: [],
    shots: [],
  };
  const args = {
    resourceId: 'workspace:shots',
    resolution: 'resolved',
    episodeTitle: '绑定',
    scenes: [scene],
  };
  const tool = SYSTEM_AGENT_TOOLS.find((candidate) => candidate.name === 'scene.submit_structure')!;
  expect(() => {
    validateToolArguments(tool, {
      type: 'toolCall',
      id: 'test',
      name: tool.name,
      arguments: args,
    });
  }).not.toThrow();
  const result = await run.invoke(tool.name, args);
  expect(result.status).toBe('scene_structure_saved');
  expect(result).toMatchObject({ applied: true, reviewRequired: false });
  expect(f.content.listScenes()[0]!.videoPrompt).toBe('手写原文标记');
  const shared = {
    title: '新场次',
    authoringIR: authoring(),
    shots: [{ title: '镜头', authoringIR: authoring(true) }],
  };
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '冲突',
        scenes: [{ ...shared, videoPrompt: '正文专属不可丢失' }],
      }),
    ),
  ).toThrow('unsupported field');
  const invalid = authoring(true);
  Reflect.deleteProperty(invalid, 'prompt');
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '漏字段',
        scenes: [{ ...shared, shots: [{ title: '镜头', authoringIR: invalid }] }],
      }),
    ),
  ).toThrow('prompt');
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '超量',
        scenes: Array.from({ length: 4 }, () => ({
          ...shared,
          shots: Array.from({ length: 26 }, () => shared.shots[0]),
        })),
      }),
    ),
  ).toThrow('100');
  const huge = { ...authoring(true), prompt: '字'.repeat(20001) };
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '超长',
        scenes: [{ ...shared, shots: [{ title: '镜头', authoringIR: huge }] }],
      }),
    ),
  ).toThrow('20000');
});

it.each(['document.submit_draft', 'tools.load'])(
  'bounds Pi validation failures for %s before execution and persists sizes without bodies',
  async (operation) => {
    const f = await setup();
    const run = f.prepare('保存文档');
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['document.submit_draft'] }, { id: 'load' })],
        { stopReason: 'toolUse', responseId: 'load' },
      ),
      ...[1, 2, 3, 4].map((index) =>
        fauxAssistantMessage(
          [
            fauxToolCall(
              operation,
              { contentMarkdown: 'PRIVATE_BODY'.repeat(10000) },
              { id: `bad-${index}` },
            ),
          ],
          { stopReason: 'toolUse', responseId: `bad-${index}` },
        ),
      ),
    ]);
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      plans: {} as never,
      streamFn: faux.streamSimple,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '保存文档',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const failed = f.generations.get(run.prepared.stream.generationId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('TOOL_REPAIR_LIMIT');
    const rows = f.project.access(false, (db) =>
      db
        .prepare(
          "SELECT summary FROM agent_task_events WHERE task_id=? AND event_type='tool_validation_failed'",
        )
        .all(run.agent.taskId),
    ) as Array<{ summary: string }>;
    expect(rows).toHaveLength(3);
    expect(
      rows.every((row) => row.summary.length < 2000 && !row.summary.includes('PRIVATE_BODY')),
    ).toBe(true);
    expect(
      (JSON.parse(rows[0]!.summary) as { argumentBytes: number }).argumentBytes,
    ).toBeGreaterThan(100000);
    expect(f.workflow.listDocuments()).toHaveLength(1); // Only the fixture setting.
  },
);

it('shows actual request/status candidates, inspects cancelled artifacts without a success dependency and deduplicates snapshots', async () => {
  const f = await setup();
  const prompt = `【本会话要求约束】\n${'固定约束'.repeat(1000)}\n\n【用户本次请求】\n重新生成场次`;
  const first = f.prepare(prompt);
  f.generations.observe({ ...first.prepared.stream, content: '部分回复' });
  const readVersion = () =>
    f.project.access(
      false,
      (db) =>
        (
          db
            .prepare('SELECT version FROM llm_generations WHERE id=?')
            .get(first.prepared.stream.generationId) as { version: number }
        ).version,
    );
  const version = readVersion();
  for (let index = 0; index < 100; index++)
    f.generations.observe({ ...first.prepared.stream, content: '部分回复' });
  expect(readVersion()).toBe(version);
  await f.generations.cancel(first.prepared.stream.generationId);
  f.loop.terminateGeneration(first.prepared.stream.generationId, 'cancelled');
  const second = f.prepare('没有生成成功吗');
  expect(f.generations.runtime(second.prepared.stream).context).toContain('重新生成场次');
  expect(f.generations.runtime(second.prepared.stream).context).toContain('cancelled');
  const result = await second.invoke('conversation.task.route', {
    decision: 'inspect',
    targetGenerationId: first.prepared.stream.generationId,
    rationale: '查询上一轮取消结果',
  });
  expect(result).toMatchObject({
    status: 'inspected',
    targetStatus: 'cancelled',
    targetRequest: '重新生成场次',
    dependencyEstablished: false,
    artifacts: [],
  });
  expect(splitConversationRequest(prompt).request).toBe('重新生成场次');
});

it('records distinct real requests under one authorization step, excludes raw data and fences cancellation/session changes', async () => {
  const f = await setup();
  const run = f.prepare('检查请求');
  const identity = run.prepared.stream;
  f.loop.startProviderStep(identity);
  f.loop.recordProviderRequest(identity, 'request-1', 'native_queued', {
    requestBodyHash: 'a'.repeat(64),
    requestBodyBytes: 1024,
    prompt: 'PRIVATE_PROMPT',
  });
  f.loop.recordProviderRequest(identity, 'request-1', 'tool_arguments', {
    toolName: 'scene.structure.stage',
    argumentBytes: 12345,
  });
  f.loop.recordProviderRequest(identity, 'request-1', 'complete', { finishReason: 'tool_calls' });
  f.loop.recordProviderRequest(identity, 'request-2', 'sent', {});
  const other = f.prepare('另一个任务');
  f.loop.recordProviderRequest(other.prepared.stream, 'request-2', 'failed', {
    argumentBytes: 999,
  });
  const owned = f.project.access(false, (db) =>
    db
      .prepare('SELECT generation_id,stage,metadata_json FROM llm_provider_requests WHERE id=?')
      .get('request-2'),
  ) as { generation_id: string; stage: string; metadata_json: string };
  expect(owned.generation_id).toBe(identity.generationId);
  expect(owned.stage).toBe('sent');
  expect(owned.metadata_json).not.toContain('999');
  await f.generations.cancel(identity.generationId);
  f.loop.terminateGeneration(identity.generationId, 'cancelled');
  f.loop.recordProviderRequest(identity, 'request-2', 'complete', {});
  f.loop.recordProviderRequest(identity, 'late-after-cancel', 'sent', {});
  f.loop.recordProviderRequest(
    { ...identity, projectSessionId: 'old-session' },
    'stale',
    'sent',
    {},
  );
  const rows = f.project.access(false, (db) =>
    db.prepare('SELECT id,stage,metadata_json FROM llm_provider_requests ORDER BY id').all(),
  ) as Array<{ id: string; stage: string; metadata_json: string }>;
  expect(rows.map((row) => [row.id, row.stage])).toEqual([
    ['request-1', 'complete'],
    ['request-2', 'cancelled'],
  ]);
  expect(rows[0]!.metadata_json).not.toContain('PRIVATE_PROMPT');
  const metadata = JSON.parse(rows[0]!.metadata_json) as {
    requestBodyBytes: number;
    argumentBytes: number;
    firstSeen: Record<string, string>;
  };
  expect(metadata.requestBodyBytes).toBe(1024);
  expect(metadata.argumentBytes).toBe(12345);
  for (const stage of ['native_queued', 'tool_arguments', 'complete'])
    expect(metadata.firstSeen[stage]).toEqual(expect.any(String));
});

it('keeps the old prefix and unique constraints intact while shortening later repeated reads', () => {
  const body = JSON.stringify(authoring()).repeat(100);
  const history = [
    {
      calls: [],
      outputs: [
        { callId: 'old', output: body },
        { callId: 'unique', output: '生产约束必须保留' },
      ],
    },
  ];
  const reuse = new RepeatedReadResults();
  expect(reuse.use('old', body)).toBe(body);
  expect(reuse.use('latest', body)).toContain('"fullResultCallId":"old"');
  expect(reuse.use('unique', '生产约束必须保留')).toBe('生产约束必须保留');
  expect(history[0]!.outputs[0]!.output).toBe(body);
  reuse.clear();
  expect(reuse.use('after-compaction', body)).toBe(body);
});
