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

async function setup() {
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
          protocol: 'openai-chat-completions',
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

it('resumes staged authoring across a cancelled task and creates one review proposal before applying real IDs', async () => {
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
  expect(state.status).toBe('scene_structure_proposed');
  expect(f.content.listScenes()).toHaveLength(0);
  expect(
    (await second.invoke('scene.structure.stage', { ...base, operation: 'finalize', stageId }))
      .changeSetId,
  ).toBe(state.changeSetId);
  const changes = new ChangeSetService(f.project);
  expect(changes.list()).toHaveLength(1);
  changes.apply({ changeSetId: state.changeSetId as string, expectedRowVersion: 0 });
  expect(f.content.listScenes()).toHaveLength(1);
  expect(f.content.listShots(f.content.listScenes()[0]!.id)).toHaveLength(2);
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
  expect(result.status).toBe('scene_structure_proposed');
  const changes = new ChangeSetService(f.project);
  changes.apply({ changeSetId: result.changeSetId as string, expectedRowVersion: 0 });
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
      '字'.repeat(4000),
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
    ).toThrow('instruction renders beyond');
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
  expect(f.generations.runtime(second.prepared.stream).systemInstruction).toContain('重新生成场次');
  expect(f.generations.runtime(second.prepared.stream).systemInstruction).toContain('cancelled');
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
