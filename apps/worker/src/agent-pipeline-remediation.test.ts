import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { renderProductionInstruction, type ProductionInstruction } from '@ai-video/contracts';
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
import { PiConversationRuntime, compactRepeatedResults } from './pi-conversation-runtime.js';
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

function instruction(shot = false): ProductionInstruction {
  return {
    version: 2,
    summary: '庭院清晨',
    narrative: { purpose: '发现线索' },
    storyTime: { timeOfDay: '清晨' },
    location: { description: '庭院' },
    visual: { style: '水墨' },
    subjects: [],
    camera: { framing: '中景' },
    ...(shot
      ? {
          stillFrame: '门前静止画面',
          timing: { estimatedDurationSeconds: 4, rationale: '停顿后转身' },
        }
      : {}),
    beats: shot ? [{ id: 'beat', action: '转身', dialogue: [], characterDocumentIds: [] }] : [],
    audio: { mode: 'silent' },
    generation: {},
    resources: [],
    continuity: {
      predecessors: [],
      before: [],
      after: [{ key: 'door', value: 'open' }],
      locked: [],
      constraints: [],
    },
  };
}

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
      f.content.saveShot({ sceneId: scene.id, title: `镜头${i}` }),
    );
    const targets = [
      { kind: 'scene' as const, id: scene.id },
      ...shots.map((shot) => ({ kind: 'shot' as const, id: shot.id })),
    ];
    const production = new ProductionService(f.project);
    const operations = () =>
      targets.map((target) => ({
        action: 'set_prompt',
        target,
        expectedRowVersion: production.read(target).rowVersion,
        instruction: instruction(target.kind === 'shot'),
      }));
    const run = f.prepare('更新已有场次的制作指令');
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
          names: ['scene.read', 'production.read', 'production.execute'],
        });
      if (index === 1 || index === 4 || index === 22)
        return tool('production.execute', { operations: operations() });
      if (index === 2) return tool('scene.read', { sceneId: scene.id });
      if (index === 3) return tool('production.read', { target: targets[1] });
      if (index === 5)
        expect(lastOutput(params)).toMatchObject({
          status: 'applied',
          changedCount: 0,
          unchangedCount: 5,
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
                'INVALID_TOOL_ARGUMENTS: production.execute returned invalid object JSON (100 bytes); finishReason=tool_calls. No tool was executed.',
            },
          },
        ];
      if (index === 23) {
        expect(lastOutput(params)).toMatchObject({ status: 'applied' });
        return [
          { ...common, type: 'text_delta', delta: '制作指令已保存。' },
          {
            ...common,
            type: 'complete',
            providerResponseId: 'boundary-final',
            finishReason: 'stop',
          },
        ];
      }
      if (index > 23) throw new Error('Must not send request 25');
      return tool('tools.load', { names: ['production.read', 'production.execute'] });
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
      prompt: '更新已有场次的制作指令',
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
    expect(requests[0]!.systemInstruction).toContain('# Agent document');
    expect(requests[0]!.tools!.some((tool) => tool.name === 'production.execute')).toBe(false);
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(scene.id)).toHaveLength(4);
    f.project.access(false, (db) => {
      expect(db.prepare('SELECT COUNT(*) n FROM production_instruction_versions').get()).toEqual({
        n: 5,
      });
      expect(db.prepare('SELECT COUNT(*) n FROM production_execution_lists').get()).toEqual({
        n: 2,
      });
      expect(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get()).toEqual({ n: 0 });
    });
    f.project.close();
    f.project.open(join(f.directory, 'project'));
    for (const target of targets)
      expect(production.read(target)).toMatchObject({ source: { revision: 1 }, issues: [] });
  },
);

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'renews read batches across Native/Pi and updates existing scenes and shots in one production task (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const scenes = Array.from({ length: 3 }, (_, i) =>
      f.content.saveScene({ title: `已有场 ${i + 1}`, sceneDocumentId: f.setting.id }),
    );
    const shots = scenes.flatMap((scene) =>
      Array.from({ length: 4 }, (_, i) =>
        f.content.saveShot({ sceneId: scene.id, title: `已有镜 ${i + 1}` }),
      ),
    );
    const targets = [
      ...scenes.map((scene) => ({ kind: 'scene' as const, id: scene.id })),
      ...shots.map((shot) => ({ kind: 'shot' as const, id: shot.id })),
    ];
    const run = f.prepare('更新已有场次和镜头的制作指令');
    const reads = new Map<string, number>();
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>[]) => [
        ...args.map((args, i): NativeProviderHostEvent => ({
          ...common,
          type: 'tool_call_end',
          call: { id: `read-${index}-${i}`, name, argumentsJson: JSON.stringify(args) },
        })),
        {
          ...common,
          type: 'complete',
          providerResponseId: `batch-${index}`,
          finishReason: 'tool_calls',
        } as NativeProviderHostEvent,
      ];
      if (index === 0)
        return tool('tools.load', [
          { names: ['scene.read', 'production.read', 'production.execute'] },
        ]);
      if (index === 1)
        return tool(
          'scene.read',
          scenes.map((scene) => ({ sceneId: scene.id })),
        );
      if (index > 2 && index <= 4)
        for (const output of params.continuation!.outputs) {
          const result = JSON.parse(output.output) as {
            target: { kind: string; id: string };
            rowVersion: number;
          };
          reads.set(`${result.target.kind}:${result.target.id}`, result.rowVersion);
        }
      if (index === 2)
        return tool(
          'production.read',
          targets.slice(0, 8).map((target) => ({ target })),
        );
      if (index === 3)
        return tool(
          'production.read',
          targets.slice(8).map((target) => ({ target })),
        );
      if (index === 4) {
        expect(reads.size).toBe(15);
        return tool('production.execute', [
          {
            executionKey: 'existing-revision',
            operations: targets.map((target) => ({
              action: 'set_prompt',
              target,
              expectedRowVersion: reads.get(`${target.kind}:${target.id}`),
              instruction: instruction(target.kind === 'shot'),
            })),
          },
        ]);
      }
      expect(index).toBe(5);
      expect(lastOutput(params)).toMatchObject({ status: 'applied', readiness: 'ready' });
      return [
        { ...common, type: 'text_delta', delta: '已有场次与镜头已更新。' },
        { ...common, type: 'complete', providerResponseId: 'done', finishReason: 'stop' },
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
      prompt: '更新已有场次和镜头的制作指令',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    expect(f.generations.get(run.prepared.stream.generationId)).toMatchObject({
      status: 'complete',
    });
    expect(requests).toHaveLength(6);
    expect(f.content.listScenes()).toHaveLength(3);
    expect(f.content.listScenes().flatMap((scene) => f.content.listShots(scene.id))).toHaveLength(
      12,
    );
    f.project.access(false, (db) => {
      expect(
        db
          .prepare('SELECT tool_call_count,tool_call_limit FROM agent_tasks WHERE id=?')
          .get(run.agent.taskId),
      ).toEqual({ tool_call_count: 19, tool_call_limit: 32 });
      expect(db.prepare('SELECT COUNT(*) n FROM production_instruction_versions').get()).toEqual({
        n: 15,
      });
      expect(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get()).toEqual({ n: 0 });
    });
  },
);

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'repairs a reference-as-predecessor error through staged authoring with ordinary reference documents (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const actor = f.content.saveDocument({
      kind: 'character',
      title: '角色',
      contentMarkdown: '普通角色资料',
    });
    const sceneInstruction = instruction();
    sceneInstruction.subjects = [{ documentId: actor.id }];
    sceneInstruction.continuity.before = [
      {
        key: 'door',
        value: 'closed',
        comparison: {
          entity: { kind: 'setting', id: f.setting.id },
          attribute: 'door.state',
          state: 'closed',
        },
      },
    ];
    const scene = {
      title: '测试场次',
      sceneDocumentId: f.setting.id,
      characterDocumentIds: [actor.id],
      instruction: sceneInstruction,
    };
    const shot = instruction(true);
    shot.subjects = [{ documentId: actor.id }];
    shot.beats[0]!.characterDocumentIds = [actor.id];
    shot.continuity.before = [
      {
        key: 'door',
        value: 'open',
        comparison: {
          entity: { kind: 'setting', id: f.setting.id },
          attribute: 'door.state',
          state: 'open',
        },
      },
    ];
    const run = f.prepare('按资料生成场次');
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const complete: NativeProviderHostEvent = {
        ...common,
        type: 'complete',
        providerResponseId: `reference-${index}`,
        finishReason: 'tool_calls',
      };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `reference-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        complete,
      ];
      if (index === 0) return tool('tools.load', { names: ['scene.submit_structure'] });
      if (index === 1) {
        const invalid = structuredClone(scene);
        Reflect.set(invalid.instruction.continuity, 'predecessors', [
          { kind: 'setting', id: f.setting.id },
        ]);
        return tool('scene.submit_structure', {
          resourceId: 'workspace:shots',
          resolution: 'resolved',
          episodeTitle: '测试',
          scenes: [{ ...invalid, shots: [{ title: '镜头', instruction: shot }] }],
        });
      }
      if (index === 2) {
        expect(params.tools?.map((t) => t.name)).toContain('scene.structure.stage');
        expect(params.tools?.map((t) => t.name)).not.toContain('scene.submit_structure');
        return tool('scene.structure.stage', {
          resourceId: 'workspace:shots',
          operation: 'begin',
          executionKey: 'reference-repair',
          episodeTitle: '测试',
          sceneShotCounts: [1],
        });
      }
      const previous = lastOutput(params);
      const base = {
        resourceId: 'workspace:shots',
        stageId: previous.stageId,
        expectedRowVersion: previous.rowVersion,
      };
      if (index === 3)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_scene',
          sceneIndex: 0,
          scene,
        });
      if (index === 4)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_shots',
          sceneIndex: 0,
          shotOffset: 0,
          shots: [{ title: '镜头', instruction: shot }],
        });
      if (index === 5) return tool('scene.structure.stage', { ...base, operation: 'finalize' });
      expect(index).toBe(6);
      expect(previous).toMatchObject({
        status: 'scene_structure_saved',
        applied: true,
        readiness: 'needs_attention',
      });
      expect(previous.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'CONTINUITY_CONFLICT' })]),
      );
      return [
        { ...common, type: 'text_delta', delta: '已保存草稿，连续性问题待处理。' },
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
      prompt: '按资料生成场次',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    expect(f.generations.get(run.prepared.stream.generationId)).toMatchObject({
      status: 'complete',
    });
    expect(requests).toHaveLength(7);
    const saved = f.content.listScenes()[0]!;
    expect(f.content.listShots(saved.id)).toHaveLength(1);
    expect(saved.characterBindings?.map((c) => c.characterDocumentId)).toEqual([actor.id]);
    const production = new ProductionService(f.project);
    const read = production.read({ kind: 'scene', id: saved.id });
    expect(read.issues.map((i) => i.code)).toContain('CONTINUITY_CONFLICT');
    expect(() => production.assertSource(read.source, read.target)).toThrow('矛盾');
    expect(
      f.project.access(
        false,
        (db) =>
          db
            .prepare(
              "SELECT COUNT(*) n FROM production_instruction_versions WHERE target_kind IN ('character','setting')",
            )
            .get() as { n: number },
      ),
    ).toEqual({ n: 0 });
    const root = join(f.directory, 'project');
    f.project.close();
    f.project.open(root);
    expect(production.read(read.target).issues.map((i) => i.code)).toContain('CONTINUITY_CONFLICT');
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
        instruction: instruction(),
        shots: [{ title: '镜头', instruction: instruction(true) }],
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
        true,
      ),
    ).toThrow('instruction only');
  }
});

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
          instruction: instruction(),
          shots: [{ title: '镜头', instruction: instruction(true) }],
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
        instruction: instruction(),
        shots: [{ title: '镜头', instruction: instruction(true) }],
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
        const shot = instruction(true);
        if (kind === 'schema') delete shot.stillFrame;
        return tool('scene.submit_structure', {
          resourceId: 'workspace:shots',
          resolution: 'resolved',
          episodeTitle: '未完成',
          scenes: [
            {
              title: '场次',
              sceneDocumentId: kind === 'business' ? 'missing' : f.setting.id,
              characterDocumentIds: [],
              instruction: instruction(),
              shots: [{ title: '镜头', instruction: shot }],
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
        instruction: instruction(),
        shots: [{ title: '镜头', instruction: instruction(true) }],
      },
    ],
  });
  expect(saved.status).toBe('scene_structure_saved');
  f.loop.startProviderStep(run.prepared.stream);
  expect(() =>
    f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
  ).toThrow('尚未 finalize');
});

async function setup(
  protocol: NativeProviderStreamStartParams['protocol'] = 'openai-chat-completions',
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
            instruction: instruction(),
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
          shots: [{ title: '转身', instruction: instruction(true) }],
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
      instruction: instruction(),
    },
  };
  state = await first.invoke('scene.structure.stage', setupArgs);
  const version = state.rowVersion;
  expect((await first.invoke('scene.structure.stage', setupArgs)).rowVersion).toBe(version);
  expect(
    (
      await first.invoke('scene.structure.stage', {
        ...base,
        operation: 'finalize',
        stageId,
        expectedRowVersion: version,
      })
    ).status,
  ).toBe('rejected');
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
    instruction: instruction(true),
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
    instruction: instruction(),
    shots: [{ title: '镜头', instruction: instruction(true) }],
  };
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '冲突',
        scenes: [{ ...shared, videoPrompt: '正文专属不可丢失' }],
      }),
      true,
    ),
  ).toThrow('conflicts');
  const invalid = instruction(true);
  delete invalid.stillFrame;
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '漏字段',
        scenes: [{ ...shared, shots: [{ title: '镜头', instruction: invalid }] }],
      }),
      true,
    ),
  ).toThrow('stillFrame');
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '超量',
        scenes: Array.from({ length: 4 }, () => ({
          ...shared,
          shots: Array.from({ length: 26 }, () => shared.shots[0]),
        })),
      }),
      true,
    ),
  ).toThrow('100');
  const huge = instruction(true);
  huge.visual = Object.fromEntries(
    ['environment', 'lighting', 'palette', 'lens', 'negative', 'composition'].map((key) => [
      key,
      key + '字'.repeat(4000 - key.length),
    ]),
  );
  for (const prompt of [undefined, huge.summary]) {
    expect(() =>
      parseEpisodeStructureArguments(
        JSON.stringify({
          episodeTitle: '超长',
          scenes: [{ ...shared, shots: [{ title: '镜头', prompt, instruction: huge }] }],
        }),
        true,
      ),
    ).toThrow(prompt === undefined ? 'instruction renders beyond' : 'instruction only');
  }
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

it('keeps unique constraint results intact while deduplicating repeated history results', () => {
  const body = renderProductionInstruction(instruction()).repeat(100);
  const history = [
    {
      calls: [],
      outputs: [
        { callId: 'old', output: body },
        { callId: 'unique', output: '生产约束必须保留' },
      ],
    },
  ];
  const compacted = compactRepeatedResults(history, [{ callId: 'latest', output: body }]);
  expect(compacted[0]!.outputs[0]!.output).toContain('latest');
  expect(compacted[0]!.outputs[1]!.output).toBe('生产约束必须保留');
  expect(history[0]!.outputs[0]!.output).toBe(body);
});
