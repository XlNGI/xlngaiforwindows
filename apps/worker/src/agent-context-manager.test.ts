import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import type { LlmGenerationRuntimeRequest } from '@ai-video/contracts';
import { AgentContextStore } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { NovelService } from './novel-service.js';
import { ContextService } from './context-service.js';
import { GenerationService } from './generation-service.js';
import { ContentService } from './content-service.js';
import { AgentProductionQueryService } from './agent-production-query-service.js';
import { ProductionService } from './production-service.js';
import { AgentContextManager } from './agent-context-manager.js';
import { AgentContextBudget } from './agent-context-budget.js';
import { readProductionSkill } from './production-skill-service.js';
import { modelResultReceipt, projectTaskStateResult } from './agent-context-results.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
const cleanup: Array<() => Promise<void>> = [];
it('keeps short loader validation errors inline so repairs do not need a result read', async () => {
  const f = await fixture();
  const error = 'Validation failed for tool tools.load: names must be authorized';
  const stored = f.store((s) =>
    s.putResult(f.project.id, 'task', 'bad-load', 'tools.load', error, {}, 'failed'),
  );
  expect(modelResultReceipt(stored)).toBe(error);
});
it.each([
  'opaque state failure',
  'null',
  '[]',
  '"text"',
  '{"status":"failed"}',
  '{"status":"task_state_read","records":null}',
])('preserves a non-state receipt without projecting it: %s', async (content) => {
  const f = await fixture();
  const result = f.store((store) =>
    store.putResult(f.project.id, 'task', 'state', 'conversation.task.checkpoint', content, {
      operation: 'state',
    }),
  );
  expect(projectTaskStateResult(result, f.runtime.prompt)).toBe(content);
});
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
it('retains repeated-read supervision after manager reconstruction and runtime instructions', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) f.manager.observe(tool('read-' + i, 'v1', '完整正文'));
  const recovered = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
  recovered.observe({
    messages: [
      Object.assign(
        { role: 'user' as const, content: '换措辞继续', timestamp: 2 },
        { source: 'runtime-continuation' },
      ),
    ],
  });
  expect(() => recovered.observe(tool('read-4', 'v1', '完整正文'))).toThrow(
    'AGENT_REPEATED_READ_STALLED',
  );
  const again = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
  expect(() => again.observe({ messages: [] })).toThrow('AGENT_REPEATED_READ_STALLED');
  again.recordUserRequirement('用户确认重新读取', 'user-2');
  expect(() => again.observe(tool('read-5', 'v1', '完整正文'))).not.toThrow();
});
it('uses persisted progress/evidence to supervise continuation, regardless of instruction wording', async () => {
  const f = await fixture();
  f.manager.recordExecutionDirective('先继续未完成项');
  const recovered = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
  expect(() => recovered.recordExecutionDirective('另一段完全不同的继续话术')).toThrow(
    'AGENT_TASK_CONTINUATION_STALLED',
  );
  recovered.observe(tool('new-source', 'v2', '新的有效资料'));
  expect(() => recovered.recordExecutionDirective('按新版本继续')).not.toThrow();
});
it('retains read supervision while recognizing distinct accepted review progress across reconstruction', async () => {
  const f = await fixture();
  f.manager.recordExecutionDirective('核对剩余镜头');
  for (let n = 0; n < 3; n++) {
    f.manager.observe(tool(`source-${n}`, 'v1', '共同原文'));
    const message = tool(
      `review-${n}`,
      'unused',
      'unused',
      'unused',
      'conversation.task.checkpoint',
      { operation: 'review' },
    );
    const result = message.messages[1]!;
    if (result.role === 'toolResult')
      result.content = [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'task_review_recorded',
            protocolVersion: 3,
            coverage: [{ id: `shot-${n}`, key: 'v1', dependencyHash: 'd1' }],
            resolutions: [],
          }),
        },
      ];
    f.manager.observe(message);
  }
  const recovered = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
  expect(() => recovered.recordExecutionDirective('继续未审查目标')).not.toThrow();
  expect(() => recovered.observe(tool('source-after-review', 'v1', '共同原文'))).not.toThrow();
  expect(() => recovered.recordExecutionDirective('没有新增事实')).toThrow('CONTINUATION_STALLED');
});
async function fixture(window = 64000) {
  const directory = await mkdtemp(join(tmpdir(), 'context-manager-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  const project = projects.create(join(directory, 'project'), 'Context lifecycle');
  cleanup.push(async () => {
    projects.close();
    await rm(directory, { recursive: true });
  });
  const runtime: LlmGenerationRuntimeRequest = {
    generationId: 'g',
    attemptId: 'a',
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    conversationId: 'c',
    providerProfileId: 'p',
    modelId: 'm',
    remoteModelId: 'remote',
    protocol: 'openai-responses',
    baseUrl: 'https://example.invalid/v1',
    systemInstruction: 'System policy',
    context: 'Metadata only',
    prompt: '生成整集分镜，保留对白和蓝衣设定',
    modelCapabilities: {
      modelId: 'm',
      contextWindow: window,
      maxOutputTokens: 4096,
      capabilitySource: 'manual_config',
    },
    inferenceSettings: {
      maxOutputTokens: 4096,
      outputTokenParameter: 'max_output_tokens',
      reasoning: 'provider_default',
    },
  };
  const manager = new AgentContextManager(projects, runtime, 'task', runtime.prompt);
  return {
    projects,
    project,
    runtime,
    manager,
    store: <T>(fn: (store: AgentContextStore) => T) =>
      projects.access(true, (db) => fn(new AgentContextStore(db))),
  };
}
function tool(
  callId: string,
  version: string,
  body: string,
  sourceId = 'chapter',
  name = 'library.read',
  args: unknown = {},
): Context {
  return {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: callId, name, arguments: args }],
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName: name,
        isError: false,
        timestamp: 2,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'read',
              sourceId,
              sourceType: 'document',
              sourceStatus: 'draft',
              versionId: version,
              content: body,
            }),
          },
        ],
      },
    ],
  } as Context;
}
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'archives older turns for latency while preserving the latest batch and unlimited input (%s)',
  async (protocol) => {
    const f = await fixture(512000);
    f.runtime.protocol = protocol;
    f.runtime.modelCapabilities!.capabilitySource = 'fallback';
    const messages = Array.from({ length: 10 }, (_, i) => {
      const batch = tool(`history-${i}`, `v${i}`, `完整源稿${i}`, `source-${i}`);
      const assistant = batch.messages[0]!;
      if (assistant.role === 'assistant')
        assistant.content.unshift({ type: 'text', text: `历史说明${i}`.repeat(10000) });
      return batch.messages;
    }).flat();
    const projected = f.manager.prepare(f.runtime, { messages }).request;
    expect(projected.contextTurns!.length).toBeLessThan(10);
    expect(projected.contextTurns!.at(-1)!.calls[0]!.id).toBe('history-9');
    expect(projected.contextTurns!.at(-1)!.outputs[0]!.output).toContain('完整源稿9');
    expect(f.manager.lastInfo?.limitEnforcement).toBe('advisory_fallback');
    const first = f.store((s) => s.resultForCall(f.project.id, 'task', 'history-0'))!;
    expect(first.content).toContain('完整源稿0');
    const largeInput = { ...f.runtime, prompt: '完整用户要求'.repeat(20000) };
    const large = f.manager.prepare(largeInput, { messages }).request;
    expect(large.prompt).toBe(largeInput.prompt);
    expect(large.contextTurns!.at(-1)!.calls[0]!.id).toBe('history-9');
    expect(large.inferenceSettings!.maxOutputTokens).toBe(4096);
  },
);

it('keeps an explicitly read frozen bundle source after tool history is archived and after restart', async () => {
  const f = await fixture();
  const runtime = { ...f.runtime, prompt: '根据选中的 selected-script 生成制作资料' };
  const manager = new AgentContextManager(
    f.projects,
    runtime,
    'bundle-source-task',
    runtime.prompt,
  );
  const context = tool('bundle-source', 'v1', '', 'selected-script', 'production.bundle', {
    operation: 'source',
    documentId: 'selected-script',
  });
  const page = {
    status: 'bundle_source_read',
    view: 'ordinary-source-text-v1',
    documentId: 'selected-script',
    versionId: 'frozen-v1',
    hash: 'source-hash',
    state: 'draft',
    contentPage: {
      offset: 0,
      text: '冻结源稿完整正文，不能在整理旧历史时消失。',
      totalCharacters: 24,
    },
  };
  const result = context.messages[1]!;
  if (result.role !== 'toolResult') throw new Error('fixture');
  result.content = [{ type: 'text', text: JSON.stringify(page) }];
  manager.snapshot(runtime, context, 'document');
  const restarted = new AgentContextManager(
    f.projects,
    runtime,
    'bundle-source-task',
    runtime.prompt,
  );
  const request = restarted.prepare(runtime, { messages: [] }).request;
  expect(request.prompt).toContain(page.contentPage.text);
  expect(request.prompt).toContain('frozen-v1');
  expect(request.prompt.split(page.contentPage.text)).toHaveLength(2);
  expect(request.prompt).toContain('workingData');
});

describe('AgentContextManager durable lifecycle', () => {
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'places current durable state after historical outputs without accumulating it (%s)',
    async (protocol) => {
      const f = await fixture();
      const runtime = { ...f.runtime, protocol };
      const context = tool('old-read', 'v1', '较早的工具事实');
      context.messages.push({ role: 'user', content: '较早的补充要求', timestamp: 3 });
      const originalMessages = structuredClone(context.messages);
      f.manager.recordUserRequirement('较早的补充要求', 'earlier-supplement');
      f.manager.recordExecutionDirective('当前应修复第三镜，已经保存的第一镜不要重建');
      const first = f.manager.prepare(runtime, context).request;
      expect(first.prompt).toBe(runtime.prompt);
      const users = first.contextTurns!.at(-1)!.userMessages!;
      expect(users.at(-1)).toContain('较早的补充要求');
      expect(users.at(-1)).toContain('[TASK STATE AND EXECUTION DATA');
      expect(users.at(-1)).toContain('当前应修复第三镜');
      expect(JSON.stringify(first).split('[TASK STATE AND EXECUTION DATA')).toHaveLength(2);
      expect(f.manager.prepare(runtime, context).request).toEqual(first);
      expect(context.messages).toEqual(originalMessages);
      const sections = f.manager.lastInfo!.sections;
      expect(sections.taskState!.estimatedTokens).toBeGreaterThan(0);
      expect(Object.values(sections).reduce((n, part) => n + part.estimatedTokens, 0)).toBe(
        f.manager.lastInfo!.estimatedInputTokens,
      );
      f.manager.snapshot(runtime, context, 'document');
      const recovered = new AgentContextManager(f.projects, runtime, 'task', runtime.prompt);
      const afterRestart = recovered.prepare(runtime, recovered.recovery()!).request;
      expect(afterRestart.prompt).toBe(runtime.prompt);
      expect(afterRestart.contextTurns!.at(-1)!.userMessages!.at(-1)).toContain('当前应修复第三镜');
      expect(JSON.stringify(afterRestart).split('[TASK STATE AND EXECUTION DATA')).toHaveLength(2);
      const empty = recovered.prepare(runtime, { messages: [] }).request;
      expect(empty.prompt).toContain('[TASK STATE AND EXECUTION DATA');
      expect(empty.contextTurns).toEqual([]);
    },
  );
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'transports long budgeted history after checkpoint reconstruction (%s)',
    async (protocol) => {
      const f = await fixture(128000);
      const runtime = {
        ...f.runtime,
        protocol,
        inferenceSettings: {
          ...f.runtime.inferenceSettings!,
          outputTokenParameter:
            protocol === 'openai-responses'
              ? ('max_output_tokens' as const)
              : ('max_tokens' as const),
        },
      };
      const context: Context = {
        messages: Array.from({ length: 40 }, (_, index) =>
          tool(`call-${index}`, 'v1', `完整正文${index}`, `source-${index}`),
        ).flatMap((entry) => entry.messages),
      };
      const live = f.manager.prepare(runtime, context).request;
      expect(live.contextTurns).toHaveLength(40);
      f.manager.snapshot(runtime, context, 'document');
      const restored = new AgentContextManager(f.projects, runtime, 'task', runtime.prompt);
      const recovery = restored.recovery()!;
      const { request } = restored.prepare(runtime, {
        messages: [
          ...recovery.messages,
          ...tool('call-40', 'v1', '新增读回结果', 'source-40').messages,
        ],
      });
      expect(request.contextTurns).toHaveLength(17);
      expect(restored.lastInfo!.deficitTokens).toBe(0);
      const sent: unknown[] = [];
      const bridge = new NativeProviderBridge({
        send(envelope) {
          sent.push(envelope);
          return Promise.resolve();
        },
      });
      expect(request.contextTurns!.flatMap((turn) => turn.calls.map((call) => call.id))).toEqual(
        Array.from({ length: 17 }, (_, index) => `call-${index + 24}`),
      );
      for (const [index, turn] of request.contextTurns!.entries())
        expect(turn.outputs).toEqual([expect.objectContaining({ callId: `call-${index + 24}` })]);
      expect(request.prompt).toContain(runtime.prompt);
      expect(
        f.store((store) => store.resultForCall(f.project.id, 'task', 'call-0'))!.content,
      ).toContain('完整正文0');
      for (const prepared of [live, request]) {
        const handle = bridge.start(prepared, { onEvent() {} });
        expect(sent.at(-1)).toMatchObject({ params: prepared });
        bridge.handleEnvelope({
          kind: 'host.event',
          requestId: handle.requestId,
          sequence: 0,
          event: { type: 'complete', projectSessionId: runtime.projectSessionId },
        });
        await expect(handle.done).resolves.toMatchObject({ type: 'complete' });
      }
    },
  );
  it('keeps read evidence active when a saved draft receipt is reused without a write', async () => {
    const f = await fixture();
    f.manager.observe(tool('read', 'v1', '完整已保存正文', 'artifact'));
    const active = f.store((store) => store.evidence(f.project.id, 'task'));
    const reuse = tool('reuse', 'v1', '', 'artifact', 'document.submit_draft');
    if (reuse.messages[1]!.role !== 'toolResult') throw new Error('fixture');
    reuse.messages[1]!.content = [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'draft_saved',
          reused: true,
          documentId: 'artifact',
          documentVersionId: 'v1',
        }),
      },
    ];
    f.manager.observe(reuse);
    expect(
      f
        .store((store) => store.evidence(f.project.id, 'task'))
        .filter((ref) => ref.sourceKey.startsWith('document:artifact:')),
    ).toEqual(active);
  });
  it('persists runtime repair directives separately from user requirements until a model response completes', async () => {
    const f = await fixture();
    const instruction = 'Repair the unsaved second scene; keep the first scene unchanged.';
    f.manager.recordExecutionDirective(instruction);
    f.manager.snapshot(f.runtime, { messages: [] }, 'document');
    const restored = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    expect(restored.prepare(f.runtime, { messages: [] }).request.prompt).toContain(instruction);
    expect(restored.taskState.userRequirements).toEqual(f.manager.taskState.userRequirements);
    expect(restored.taskState.userRequirements.some((item) => item.text === instruction)).toBe(
      false,
    );
    expect(restored.taskState.confirmedDecisions).toEqual([]);
    // Preparing/retrying does not consume the instruction.
    expect(restored.prepare(f.runtime, { messages: [] }).request.prompt).toContain(instruction);
    restored.modelRequestCompleted();
    const acknowledged = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    expect(acknowledged.prepare(f.runtime, { messages: [] }).request.prompt).not.toContain(
      instruction,
    );
  });
  it('keeps partial staging progress durable without advertising unsaved parts as generated artifacts', async () => {
    const f = await fixture();
    const result = (id: string, savedSceneThisCall: boolean) => {
      const context = tool(id, 'v1', '', 'none', 'scene.structure.stage');
      (
        context.messages[1] as {
          content: unknown;
        }
      ).content = [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'scene_structure_partially_saved',
            savedSceneThisCall,
            sceneIds: ['already-saved'],
            nextSceneIndex: 1,
          }),
        },
      ];
      return context;
    };
    const staging = result('staging', false),
      committed = result('committed', true);
    f.manager.snapshot(
      f.runtime,
      { messages: [...staging.messages, ...committed.messages] },
      'document',
    );
    expect(f.manager.taskState.generatedArtifacts.map((a) => a.callId)).toEqual(['committed']);
    expect(f.store((s) => s.resultForCall(f.project.id, 'task', 'staging'))?.status).toBe(
      'completed',
    );
    const restored = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    expect(restored.taskState.generatedArtifacts.map((a) => a.callId)).toEqual(['committed']);
  });
  it('retains explicitly selected source content once across cleared history and restart without injecting unrelated sources', async () => {
    const f = await fixture();
    const runtime = { ...f.runtime, prompt: '依据 document-selected 完成所有制作草稿' };
    const manager = new AgentContextManager(f.projects, runtime, 'selected-task', runtime.prompt);
    const source = tool('selected', 'v1', '当前选择的原始剧情事实', 'document-selected');
    const other = tool('other', 'v1', '其他资料仅按需读取', 'unrelated');
    manager.snapshot(runtime, { messages: [...source.messages, ...other.messages] }, 'document');
    const projected = manager.prepare(runtime, {
      messages: [...source.messages, ...other.messages],
    }).request;
    expect(JSON.stringify(projected).split('当前选择的原始剧情事实')).toHaveLength(2);
    const restarted = new AgentContextManager(f.projects, runtime, 'selected-task', runtime.prompt);
    const restored = restarted.prepare(runtime, { messages: [] }).request;
    expect(restored.prompt).toContain('当前选择的原始剧情事实');
    expect(restored.prompt).not.toContain('其他资料仅按需读取');
    expect(restored.systemInstruction).not.toContain('当前选择的原始剧情事实');
    const updated = tool('updated', 'v2', '当前选择的新版本剧情事实', 'document-selected');
    const latest = restarted.prepare(runtime, updated).request;
    expect(JSON.stringify(latest)).not.toContain('当前选择的原始剧情事实');
    expect(JSON.stringify(latest).split('当前选择的新版本剧情事实')).toHaveLength(2);
  });
  it('excludes document bodies changed outside the Agent without losing their immutable results', async () => {
    const f = await fixture();
    const content = new ContentService(f.projects);
    const saved = content.saveDocument({ title: '原文', contentMarkdown: '旧正文不得继续注入' });
    const body = saved.currentVersion!.contentMarkdown;
    const runtime = { ...f.runtime, prompt: `根据 ${saved.id} 继续任务` };
    const manager = new AgentContextManager(
      f.projects,
      runtime,
      'external-document',
      runtime.prompt,
    );
    const history = tool('read-source', saved.currentVersionId!, body, saved.id);
    manager.snapshot(runtime, history, 'document');
    expect(manager.prepare(runtime, { messages: [] }).request.prompt).toContain(body);
    content.saveDocument({
      documentId: saved.id,
      title: saved.title,
      contentMarkdown: '新正文仍需按需读取',
    });
    const restarted = new AgentContextManager(
      f.projects,
      runtime,
      'external-document',
      runtime.prompt,
    );
    const request = restarted.prepare(runtime, history).request;
    expect(JSON.stringify(request)).not.toContain(body);
    expect(JSON.stringify(request)).not.toContain('新正文仍需按需读取');
    expect(JSON.stringify(request)).toContain('Superseded evidence');
    expect(
      f.store((s) => s.resultForCall(f.project.id, 'external-document', 'read-source'))?.content,
    ).toContain(body);
  });
  it('excludes externally revised shot evidence while retaining full results for recovery', async () => {
    const f = await fixture();
    const content = new ContentService(f.projects);
    const scene = content.saveScene({ title: '场次' });
    const shot = content.saveShot({
      sceneId: scene.id,
      title: '镜头',
      ...{
        prompt: '原镜头正文不得再作为当前状态',
      },
    });
    const runtime = { ...f.runtime, prompt: `继续核对 ${shot.id}` };
    const manager = new AgentContextManager(f.projects, runtime, 'external-shot', runtime.prompt);
    const history = tool('read-shot', 'unused', '', shot.id, 'production.read');
    const message = history.messages[1]!;
    if (message.role !== 'toolResult') throw new Error('fixture');
    message.content = [
      {
        type: 'text',
        text: JSON.stringify(
          new AgentProductionQueryService(new ProductionService(f.projects)).read(
            { kind: 'shot', id: shot.id },
            { view: 'authoring' },
            {
              ...f.runtime,
              taskId: 'task',
              toolCallId: 'read-shot',
            },
            'authoring',
          ),
        ),
      },
    ];
    manager.snapshot(runtime, history, 'document');
    expect(manager.prepare(runtime, { messages: [] }).request.prompt).toContain(shot.prompt);
    const sibling = content.saveShot({ sceneId: scene.id, title: '另一个镜头', prompt: '待修改' });
    content.saveShot({
      shotId: sibling.id,
      sceneId: scene.id,
      title: sibling.title,
      expectedRowVersion: sibling.rowVersion,
      ...{ prompt: '只修改其他镜头' },
    });
    expect(manager.prepare(runtime, { messages: [] }).request.prompt).toContain(shot.prompt);
    content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: shot.title,
      expectedRowVersion: shot.rowVersion,
      ...{
        prompt: '外部修订后正文按需读取',
      },
    });
    const restarted = new AgentContextManager(f.projects, runtime, 'external-shot', runtime.prompt);
    expect(JSON.stringify(restarted.prepare(runtime, history).request)).not.toContain(shot.prompt);
    expect(
      f.store((s) => s.resultForCall(f.project.id, 'external-shot', 'read-shot'))?.content,
    ).toContain(shot.prompt);
  });
  it('retains a selected chapter by its canonical title when retrieval adds a display label', async () => {
    const f = await fixture();
    const chapter = new NovelService(f.projects).saveChapter({
      title: '雨夜重逢',
      displayLabel: '第一章',
    });
    const runtime = { ...f.runtime, prompt: '读取《雨夜重逢》，完成整集分镜。' };
    const source = tool('labelled-source', 'v1', '经过验证的原始剧情正文', chapter.id);
    const result = source.messages[1]!;
    if (result.role !== 'toolResult' || result.content[0]?.type !== 'text')
      throw new Error('fixture');
    result.content[0].text = JSON.stringify({
      ...JSON.parse(result.content[0].text),
      sourceType: 'novel-chapter',
      title: '第一章 雨夜重逢',
    });
    const manager = new AgentContextManager(f.projects, runtime, 'labelled-task', runtime.prompt);
    manager.snapshot(runtime, source, 'document');
    const restarted = new AgentContextManager(f.projects, runtime, 'labelled-task', runtime.prompt);
    expect(restarted.prepare(runtime, { messages: [] }).request.prompt).toContain(
      '经过验证的原始剧情正文',
    );
  });
  it('does not discard active history or requested schemas merely to fit an unverified fallback', async () => {
    const f = await fixture();
    const runtime = {
      ...f.runtime,
      modelCapabilities: { ...f.runtime.modelCapabilities!, capabilitySource: 'fallback' as const },
      prompt: '必须完整保留的要求'.repeat(12000),
      tools: [{ name: 'current.write', description: 'requested schema', parameters: {} }],
    };
    const context = {
      messages: [
        ...tool('a', 'v1', '当前完整正文甲').messages,
        ...tool('b', 'v1', '当前完整正文乙', 'other').messages,
      ],
    };
    const request = f.manager.prepare(runtime, context).request;
    expect(request.prompt).toContain(runtime.prompt);
    expect(request.contextTurns).toHaveLength(2);
    expect(request.tools).toEqual(runtime.tools);
    expect(request.inferenceSettings!.maxOutputTokens).toBe(4096);
    expect(f.manager.lastInfo).toMatchObject({
      limitEnforcement: 'advisory_fallback',
      contextWindowTokens: 64000,
    });
    expect(() =>
      f.manager.prepare(
        {
          ...runtime,
          modelCapabilities: { ...runtime.modelCapabilities, capabilitySource: 'manual_config' },
        },
        context,
      ),
    ).toThrow('CONTEXT_BUDGET_EXCEEDED');
  });
  it('defers unused schema under pressure, retains explicit working data and restores tools on demand', async () => {
    const f = await fixture(10000);
    const runtime = {
      ...f.runtime,
      tools: [
        {
          name: 'tools.load',
          description: 'Load exact tool schemas',
          parameters: { type: 'object' },
        },
        {
          name: 'unused.write',
          description: 'large schema '.repeat(6000),
          parameters: { type: 'object' },
        },
      ],
    };
    const context = tool('page', 'v1', '', 'none', 'conversation.task.checkpoint', {
      operation: 'result',
    });
    (
      context.messages[1] as {
        content: unknown;
      }
    ).content = [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'task_result_read',
          content: '需要完整读取的正文'.repeat(100),
        }),
      },
    ];
    const prepared = f.manager.prepare(runtime, context).request;
    expect(prepared.tools?.map((t) => t.name)).toEqual(['tools.load']);
    expect(JSON.stringify(prepared.contextTurns)).toContain('需要完整读取的正文');
    expect(prepared.contextTurns!.at(-1)!.userMessages!.at(-1)).toContain(
      '"deferredTools":["unused.write"]',
    );
    const load = tool('load', 'v1', '', 'none', 'tools.load', { names: ['unused.write'] });
    (
      load.messages[1] as {
        content: unknown;
      }
    ).content = [
      { type: 'text', text: JSON.stringify({ status: 'tools_loaded', names: ['unused.write'] }) },
    ];
    const larger = {
      ...runtime,
      modelCapabilities: { ...runtime.modelCapabilities!, contextWindow: 128000 },
    };
    expect(f.manager.prepare(larger, load).request.tools?.map((t) => t.name)).toContain(
      'unused.write',
    );
  });
  it('projects long current requirements once without changing complete state reads or older requirements', async () => {
    const f = await fixture();
    const prompt = '本轮重要约束'.repeat(1500);
    const runtime = { ...f.runtime, prompt };
    const manager = new AgentContextManager(f.projects, runtime, 'long-task', prompt);
    const context = tool('state', 'v1', '', 'none', 'conversation.task.checkpoint', {
      operation: 'state',
    });
    const content = JSON.stringify({
      status: 'task_state_read',
      taskGoal: prompt,
      records: [
        { kind: 'userRequirement', id: 'original', text: prompt },
        { kind: 'userRequirement', id: 'parent', text: '早期确认的要求必须保留' },
      ],
    });
    (
      context.messages[1] as {
        content: unknown;
      }
    ).content = [{ type: 'text', text: content }];
    manager.snapshot(runtime, context, 'document');
    const request = manager.prepare(runtime, { messages: manager.compactHistory(context) }).request;
    expect(JSON.stringify(request).split(prompt)).toHaveLength(2);
    expect(JSON.stringify(request)).toContain('早期确认的要求必须保留');
    const projected = JSON.stringify(request.contextTurns);
    expect(projected).toContain('Archive reference only');
    expect(projected).not.toContain('"operation":"result"');
    const stored = f.store((s) => s.resultForCall(f.project.id, 'long-task', 'state'))!;
    expect(stored.content).toBe(content);
    expect(manager.taskState.taskGoal).toBe(prompt);
  });
  it('preserves opaque failed state reads through projection and restart without parsing them as JSON', async () => {
    const f = await fixture();
    const context = tool('failed-state', 'v1', '', 'none', 'conversation.task.checkpoint', {
      operation: 'state',
    });
    const failure = 'AGENT_TOOL_RESULT_TOO_LARGE: Tool Result exceeds 65536 bytes.';
    Object.assign(context.messages[1]!, {
      isError: true,
      content: [{ type: 'text', text: failure }],
    });
    f.manager.snapshot(f.runtime, context, 'document');
    const restored = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    const request = restored.prepare(f.runtime, { messages: restored.compactHistory(context) });
    expect(JSON.stringify(request.request.contextTurns)).toContain(failure);
    expect(f.store((s) => s.resultForCall(f.project.id, 'task', 'failed-state'))).toMatchObject({
      status: 'failed',
      content: failure,
    });
    expect(restored.taskState.taskGoal).toBe(f.runtime.prompt);
  });
  it('keeps an explicitly read skill once after clearing history, compaction and restart', async () => {
    const f = await fixture();
    const context = tool('skill', 'v1', '', 'none', 'production.skill.read', {
      skillId: 'script-to-media',
    });
    const declaration = readProductionSkill({ skillId: 'script-to-media' });
    (
      context.messages[1] as {
        content: unknown;
      }
    ).content = [{ type: 'text', text: JSON.stringify(declaration) }];
    f.manager.snapshot(f.runtime, context, 'document');
    const request = f.manager.prepare(f.runtime, context).request;
    expect(JSON.stringify(request).split(declaration.instructions.split('。')[0]!)).toHaveLength(1);
    const restarted = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    const cleared = restarted.prepare(f.runtime, { messages: [] }).request;
    expect(cleared.prompt).not.toContain(JSON.stringify(declaration.instructions).slice(1, -1));
    expect(cleared.prompt).toContain('"skillId":"script-to-media"');
    const skillResultId = f.store((s) => s.resultForCall(f.project.id, 'task', 'skill')?.id);
    expect(skillResultId).toBeDefined();
    expect(cleared.prompt).toContain(`"resultId":"${skillResultId}"`);
    expect(cleared.systemInstruction).not.toContain(declaration.instructions);
    expect(f.store((s) => s.evidence(f.project.id, 'task'))).toEqual([
      expect.objectContaining({
        sourceKey: 'skill:script-to-media',
        sourceVersion: String(declaration.revision),
      }),
    ]);
    expect(f.store((s) => s.resultForCall(f.project.id, 'task', 'skill'))?.content).toBe(
      JSON.stringify(declaration),
    );
    const update = tool('skill-update', 'v2', '', 'none', 'production.skill.read');
    (
      update.messages[1] as {
        content: unknown;
      }
    ).content = [
      {
        type: 'text',
        text: JSON.stringify({
          ...declaration,
          revision: String(declaration.revision + 1),
          instructions: '新的有效任务声明',
        }),
      },
    ];
    restarted.observe(update);
    const latest = restarted.prepare(f.runtime, {
      messages: [...context.messages, ...update.messages],
    }).request;
    const updatedSkillId = f.store(
      (s) => s.resultForCall(f.project.id, 'task', 'skill-update')?.id,
    );
    expect(updatedSkillId).toBeDefined();
    expect(f.store((s) => s.evidence(f.project.id, 'task'))).toEqual([
      expect.objectContaining({
        sourceVersion: String(declaration.revision + 1),
        resultId: updatedSkillId,
      }),
    ]);
    expect(JSON.stringify(latest.contextTurns)).toContain(updatedSkillId!);
    expect(JSON.stringify(latest)).not.toContain('新的有效任务声明');
    expect(JSON.stringify(latest)).not.toContain(declaration.instructions);
    expect(f.store((s) => s.resultForCall(f.project.id, 'task', 'skill'))!.content).toBe(
      JSON.stringify(declaration),
    );
  });
  it('uses native segment feedback for planning, resets recovery after success and recalculates on model switch', async () => {
    const f = await fixture();
    const runtime = { ...f.runtime, systemInstruction: '策略'.repeat(3000) };
    f.manager.prepare(runtime, { messages: [] });
    f.manager.observeNativeContext({
      estimatedInputTokens: 54000,
      systemTokens: 53000,
      toolSchemaTokens: 0,
      messageTokens: 1000,
      imageTokens: 0,
      reservedOutputTokens: 4096,
      requestBodyBytes: 100000,
      protocol: runtime.protocol,
      meter: 'local_heuristic_estimate',
      capabilitySource: 'manual_config',
    });
    const context = {
      messages: [
        ...tool('a', 'v1', '甲'.repeat(1400)).messages,
        ...tool('b', 'v1', '乙'.repeat(1400), 'other').messages,
      ],
    };
    const projected = f.manager.prepare(runtime, context).request;
    expect(projected.contextTurns!.length).toBeLessThanOrEqual(2);
    expect(f.manager.lastInfo?.nativeWire).toBeUndefined();
    expect(f.manager.recoverContextOverflow()).toBe(true);
    expect(f.manager.recoverContextOverflow()).toBe(true);
    expect(f.manager.recoverContextOverflow()).toBe(false);
    f.manager.modelRequestCompleted();
    expect(f.manager.recoverContextOverflow()).toBe(true);
    const large = {
      ...runtime,
      modelId: 'larger',
      modelCapabilities: { ...runtime.modelCapabilities!, contextWindow: 1000000 },
    };
    expect(f.manager.prepare(large, context).request.contextTurns).toHaveLength(2);
  });
  it('preserves valid small tool arguments across snapshots and canonical request rebuilding', async () => {
    const f = await fixture();
    const args = { sourceHandle: 'source', readMode: 'source' };
    const context = tool('small', 'v1', '正文', 'chapter', 'library.read', args);
    f.manager.snapshot(f.runtime, context, 'document');
    const restored = f.manager.compactHistory(context);
    f.manager.snapshot(f.runtime, { messages: restored }, 'document');
    const request = f.manager.prepare(f.runtime, {
      messages: f.manager.compactHistory(context),
    }).request;
    expect(JSON.parse(request.contextTurns![0]!.calls[0]!.argumentsJson)).toEqual(args);
    expect(JSON.stringify(request.contextTurns)).not.toContain('archivedArguments');
    expect(f.manager.lastInfo!.sections.toolResults!.estimatedTokens).toBeGreaterThan(0);
    expect(
      Object.values(f.manager.lastInfo!.sections).reduce(
        (n, section) => n + section.estimatedTokens,
        0,
      ),
    ).toBe(f.manager.lastInfo!.estimatedInputTokens);
  });
  it('retains readable complete failed draft arguments after repeated snapshot projection', async () => {
    const f = await fixture();
    const args = { kind: 'plan', content: '未保存全文'.repeat(10000) };
    const context = tool(
      'failed',
      'v1',
      'validation failed',
      'draft',
      'document.submit_draft',
      args,
    );
    f.manager.snapshot(f.runtime, context, 'document');
    const restored = { messages: f.manager.compactHistory(context) };
    f.manager.snapshot(f.runtime, restored, 'document');
    const request = f.manager.prepare(f.runtime, restored).request;
    const archived = JSON.parse(request.contextTurns![0]!.calls[0]!.argumentsJson) as {
      resultId: string;
      read: {
        resultView: string;
        expectedHash: string;
      };
    };
    expect(archived.read.resultView).toBe('arguments');
    let body = '',
      offset: number | null = 0;
    while (offset !== null) {
      const page = f.store((s) =>
        s.readResult(
          f.project.id,
          'task',
          archived.resultId,
          offset!,
          4096,
          archived.read.expectedHash,
          'arguments',
        ),
      );
      body += page.content;
      offset = page.nextOffset;
    }
    expect(JSON.parse(body)).toEqual(args);
  });
  it('tracks real navigation revisions across three updates instead of schema version 1', async () => {
    const f = await fixture();
    const history: Context = { messages: [] };
    for (const revision of ['r1', 'r2', 'r3']) {
      const context = tool(revision, 'unused', 'catalog', 'ignored', 'project.structure.get', {
        detail: 'compact',
      });
      const output = context.messages[1]!;
      if (output.role !== 'toolResult') throw new Error('fixture');
      output.content = [
        {
          type: 'text',
          text: JSON.stringify({
            version: 1,
            status: 'succeeded',
            resourceMap: { revision, resources: [] },
          }),
        },
      ];
      history.messages.push(...context.messages);
      f.manager.observe(context);
    }
    const active = f.store((s) => s.evidence(f.project.id, 'task'));
    expect(active).toHaveLength(1);
    expect(active[0]!.sourceVersion).toBe('r3');
    const request = f.manager.prepare(f.runtime, history).request;
    expect(JSON.stringify(request.contextTurns)).toContain('r3');
    expect(JSON.stringify(request.contextTurns)).not.toContain('"revision":"r1"');
  });
  it('keeps system stable after history clearing and never copies full evidence into handoff', async () => {
    const f = await fixture();
    const context = tool('read', 'v1', '原文'.repeat(40000));
    f.manager.recordUserRequirement('镜头必须保留原文对白', 'supplement');
    f.manager.snapshot(f.runtime, context, 'document');
    const before = f.manager.prepare(f.runtime, context).request;
    const after = f.manager.prepare(f.runtime, { messages: [] }).request;
    expect(after.systemInstruction).toBe(before.systemInstruction);
    expect(after.systemInstruction).not.toContain('原文原文');
    expect(after.prompt).toContain('镜头必须保留原文对白');
    expect(after.prompt).toContain('resultId');
    expect(after.prompt.length).toBeLessThan(10000);
    expect(f.store((s) => s.resultForCall(f.project.id, 'task', 'read')?.content)).toContain(
      '原文'.repeat(40000),
    );
  });
  it('retires all navigation views on revision change and preserves later data when recovery reobserves writes', async () => {
    const f = await fixture();
    const navigation = (id: string, revision: string, detail: string) => {
      const context = tool(id, 'unused', '', 'ignored', 'project.structure.get', { detail });
      const output = context.messages[1]!;
      if (output.role !== 'toolResult') throw new Error('fixture');
      output.content = [
        {
          type: 'text',
          text: JSON.stringify({ version: 1, resourceMap: { revision, resources: [] } }),
        },
      ];
      return context;
    };
    const compact = navigation('compact', 'r1', 'compact'),
      full = navigation('full', 'r1', 'full');
    f.manager.observe({ messages: [...compact.messages, ...full.messages] });
    expect(f.store((s) => s.evidence(f.project.id, 'task'))).toHaveLength(2);
    const read = tool('read-before', 'v1', '旧正文', 'd');
    const write = tool('write', 'v2', '', 'd', 'document.submit_draft');
    const output = write.messages[1]!;
    if (output.role !== 'toolResult') throw new Error('fixture');
    output.content = [
      {
        type: 'text',
        text: JSON.stringify({ status: 'draft_saved', documentId: 'd', documentVersionId: 'v2' }),
      },
    ];
    const refreshed = navigation('refreshed', 'r2', 'compact');
    const current = tool('read-after', 'v2', '新正文', 'd');
    const history = {
      messages: [...read.messages, ...write.messages, ...refreshed.messages, ...current.messages],
    };
    f.manager.snapshot(f.runtime, history, 'document');
    const active = f.store((s) => s.evidence(f.project.id, 'task'));
    expect(active.filter((r) => r.sourceType === 'navigation').map((r) => r.sourceVersion)).toEqual(
      ['r2'],
    );
    expect(active.some((r) => r.sourceVersion === 'v1')).toBe(false);
    const restarted = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    restarted.recovery();
    expect(f.store((s) => s.evidence(f.project.id, 'task'))).toEqual(active);
    const request = restarted.prepare(f.runtime, history).request;
    expect(JSON.stringify(request.contextTurns)).not.toContain('旧正文');
    expect(JSON.stringify(request.contextTurns)).toContain('新正文');
  });
  it('deduplicates evidence, retires stale versions and cannot reactivate an archived reread', async () => {
    const f = await fixture();
    const old = tool('read-old', 'v1', '旧版本'),
      current = tool('read-new', 'v2', '新版本');
    f.manager.observe(old);
    f.manager.observe(old);
    f.manager.observe(current);
    const restarted = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    restarted.observe(old);
    const refs = f.store((s) => s.evidence(f.project.id, 'task'));
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sourceVersion).toBe('v2');
    const request = restarted.prepare(f.runtime, {
      messages: [...old.messages, ...current.messages],
    }).request;
    expect(JSON.stringify(request)).not.toContain('旧版本');
    expect(JSON.stringify(request)).toContain('新版本');
    expect(f.store((s) => s.evidence(f.project.id, 'task', true))).toHaveLength(2);
  });
  it('retains distinct production pages under the provider read version', async () => {
    const f = await fixture();
    for (let n = 0; n < 2; n++) {
      const history = tool(`page-${n}`, 'unused', '', 'shot', 'production.read');
      const result = history.messages[1]!;
      if (result.role !== 'toolResult') throw new Error('fixture');
      result.content = [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'read',
            target: { kind: 'shot', id: 'shot' },
            view: 'authoring',
            rowVersion: 3,
            version: 'query-version',
            contentPage: { offset: n * 100, nextOffset: (n + 1) * 100, text: `第${n}页` },
          }),
        },
      ];
      f.manager.observe(history);
    }
    const refs = f.store((store) => store.evidence(f.project.id, 'task'));
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map((ref) => ref.rangeKey)).size).toBe(2);
    expect(refs.map((ref) => ref.sourceVersion)).toEqual(['query-version', 'query-version']);
  });
  it('externalizes large results, keeps exact contents by ID and sends explicit pages inline', async () => {
    const f = await fixture();
    const context = tool('large', 'v1', '不可丢失'.repeat(20000));
    const first = f.manager.prepare(f.runtime, context).request;
    const result = f.store((s) => s.resultForCall(f.project.id, 'task', 'large'))!;
    expect(first.prompt).not.toContain('不可丢失'.repeat(100));
    let restored = '',
      offset: number | null = 0;
    while (offset !== null) {
      const page = f.store((s) =>
        s.readResult(f.project.id, 'task', result.id, offset!, 4096, result.contentHash),
      );
      restored += page.content;
      offset = page.nextOffset;
    }
    expect(restored).toBe(result.content);
    const page = f.store((s) =>
      s.readResult(f.project.id, 'task', result.id, 0, 4096, result.contentHash),
    );
    const read = tool('page', 'v1', 'unused', 'none', 'conversation.task.checkpoint', {
      operation: 'result',
      resultId: result.id,
    });
    (
      read.messages[1] as {
        content: unknown;
      }
    ).content = [{ type: 'text', text: JSON.stringify(page) }];
    const next = f.manager.prepare(f.runtime, read).request;
    expect(JSON.stringify(next)).toContain('不可丢失');
  });
  it('restores task state and reconciles a committed write missing from the Pi snapshot', async () => {
    const f = await fixture();
    f.manager.recordUserRequirement('每镜标明景别', 'user-2');
    const context = tool('write', 'v1', '完整产物', 'artifact', 'document.submit_draft', {
      contentMarkdown: '原始完整草稿'.repeat(10000),
    });
    f.manager.snapshot(f.runtime, { messages: context.messages.slice(0, 1) }, 'document');
    f.store((s) =>
      s.putResult(
        f.project.id,
        'task',
        'write',
        'document.submit_draft',
        JSON.stringify({ status: 'draft_saved', documentId: 'artifact' }),
        { contentMarkdown: '原始完整草稿'.repeat(10000) },
      ),
    );
    const recovered = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    const snapshot = recovered.recovery()!;
    expect(snapshot.messages.some((m) => m.role === 'toolResult' && m.toolCallId === 'write')).toBe(
      true,
    );
    expect(recovered.taskState.completedSteps).toContain('write');
    expect(recovered.taskState.userRequirements.map((r) => r.text)).toContain('每镜标明景别');
    expect(
      recovered.prepare(f.runtime, snapshot).request.contextTurns!.at(-1)!.userMessages!.at(-1),
    ).toContain('artifact');
  });
  it('marks unknown external calls for inspection without replaying them', async () => {
    const f = await fixture();
    const context = tool('paid', 'v1', 'pending', 'job', 'media.video.submit');
    f.manager.snapshot(f.runtime, { messages: context.messages.slice(0, 1) }, 'video');
    const snapshot = new AgentContextManager(
      f.projects,
      f.runtime,
      'task',
      f.runtime.prompt,
    ).recovery()!;
    const last = snapshot.messages.at(-1);
    expect(last?.role).toBe('toolResult');
    expect(JSON.stringify(last)).toContain('interrupted_execution');
  });
  it('projects durable saved output IDs after recent history is cleared and the Worker is recreated', async () => {
    const f = await fixture();
    const context = tool('saved', 'v1', '', 'artifact', 'document.submit_draft', {
      title: '已保存角色',
      documentKind: 'character',
    });
    if (context.messages[1]!.role !== 'toolResult') throw new Error('fixture');
    context.messages[1]!.content = [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'draft_saved',
          documentId: 'saved-character',
          documentVersionId: 'saved-version',
          documentRowVersion: 2,
        }),
      },
    ];
    f.manager.snapshot(f.runtime, context, 'document');
    const restarted = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
    const request = restarted.prepare(f.runtime, { messages: [] }).request;
    expect(request.prompt).toContain(
      '"receipt":{"status":"draft_saved","documentId":"saved-character","documentVersionId":"saved-version","documentRowVersion":2}',
    );
    expect(request.contextTurns).toEqual([]);
    expect(request.prompt).toContain('"title":"已保存角色","documentKind":"character"');
  });
  it('bounds recovery and preserves working data/checkpoints when compaction cannot fit', async () => {
    const f = await fixture();
    const context = tool('large', 'v1', '完整原文'.repeat(20000));
    f.manager.snapshot(f.runtime, context, 'document');
    const impossible = { ...f.runtime, prompt: '必需用户原文'.repeat(30000) };
    expect(() => f.manager.prepare(impossible, context)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(f.manager.recoverContextOverflow()).toBe(true);
    expect(f.manager.recoverContextOverflow()).toBe(true);
    expect(f.manager.recoverContextOverflow()).toBe(false);
    expect(f.store((s) => s.loadRuntime(f.project.id, 'task'))).toBeDefined();
    expect(
      f.store((s) => s.resultForCall(f.project.id, 'task', 'large')?.content.length),
    ).toBeGreaterThan(80000);
  });
  it.each([128000, 1000000])(
    'uses model window %i above 64K and recalculates after model switching',
    async (window) => {
      const f = await fixture(window);
      const large = { ...f.runtime, prompt: '文'.repeat(70000) };
      expect(f.manager.prepare(large, { messages: [] }).request.prompt.length).toBeGreaterThan(
        64000,
      );
      expect(f.manager.lastInfo?.contextWindowTokens).toBe(window);
      const smaller = {
        ...large,
        modelCapabilities: { ...large.modelCapabilities!, contextWindow: 64000 },
      };
      expect(() => f.manager.prepare(smaller, { messages: [] })).toThrow('CONTEXT_BUDGET_EXCEEDED');
      expect(f.manager.taskState.taskGoal).toBe(f.runtime.prompt);
    },
  );
  it('respects independent max input and max output settings', async () => {
    const f = await fixture(128000);
    const budget = new AgentContextBudget();
    const runtime = {
      ...f.runtime,
      modelCapabilities: {
        ...f.runtime.modelCapabilities!,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
      },
    };
    expect(() =>
      budget.prepare({ ...runtime, prompt: '文'.repeat(2000) }, { messages: [] }),
    ).toThrow();
    expect(
      budget.prepare(runtime, { messages: [] }).request.inferenceSettings?.maxOutputTokens,
    ).toBe(1000);
  });
});
it('projects identical small evidence once and excludes every stale duplicate call', async () => {
  const f = await fixture();
  const first = tool('one', 'v1', '独一份旧正文'),
    second = tool('two', 'v1', '独一份旧正文');
  const context = { messages: [...first.messages, ...second.messages] };
  const before = f.manager.prepare(f.runtime, context).request;
  expect(JSON.stringify(before).split('独一份旧正文')).toHaveLength(2);
  const current = tool('new', 'v2', '有效新正文');
  const after = f.manager.prepare(f.runtime, {
    messages: [...context.messages, ...current.messages],
  }).request;
  expect(JSON.stringify(after)).not.toContain('独一份旧正文');
  expect(JSON.stringify(after)).toContain('有效新正文');
});
it('restores the latest visual working set after snapshot projection and restart', async () => {
  const f = await fixture();
  const context = tool('visual', 'v1', '视觉回执');
  const message = context.messages[1]!;
  if (message.role !== 'toolResult') throw new Error('fixture');
  message.content.push({ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
  f.manager.snapshot(f.runtime, context, 'document');
  const restarted = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt);
  const recovered = restarted.recovery()!;
  expect(JSON.stringify(recovered.messages)).not.toContain('aW1hZ2U=');
  const request = restarted.prepare(f.runtime, recovered).request;
  expect(request.attachments).toEqual([
    expect.objectContaining({ dataUrl: 'data:image/png;base64,aW1hZ2U=' }),
  ]);
  expect(f.runtime.attachments).toBeUndefined();
});
it('inherits earlier user requirements only through an explicit successful follow-up route', async () => {
  const f = await fixture();
  f.manager.recordUserRequirement('必须使用原文对白', 'confirmed');
  f.manager.finish('completed');
  const nextRuntime = { ...f.runtime, generationId: 'next' };
  const next = new AgentContextManager(f.projects, nextRuntime, 'next-task', '继续完成下一集');
  expect(next.taskState.userRequirements).toHaveLength(1);
  const route = tool('route', 'v1', '', 'none', 'conversation.task.route');
  const result = route.messages[1]!;
  if (result.role !== 'toolResult') throw new Error('fixture');
  result.content = [
    {
      type: 'text',
      text: JSON.stringify({ status: 'routed', decision: 'follow_up', targetGenerationId: 'g' }),
    },
  ];
  next.observe(route);
  expect(next.taskState.userRequirements.map((r) => r.text)).toContain('必须使用原文对白');
  const prepared = next.prepare(nextRuntime, { messages: [] }).request;
  expect(prepared.prompt).toContain('必须使用原文对白');
});
it('keeps one exact same-source constraint across ten follow-ups and restart without losing repeated supplements', async () => {
  const f = await fixture();
  const constraints = '每镜正文必须写明相对秒数与说话者。'.repeat(40);
  const prompt = (request: string, rules = constraints) =>
    `【本会话要求约束】\n${rules}\n\n【用户本次请求】\n${request}`;
  let generationId = 'chain-0';
  let manager = new AgentContextManager(
    f.projects,
    { ...f.runtime, generationId },
    'chain-task-0',
    prompt('创作大纲'),
  );
  manager.recordUserRequirement('保留原对白', 'supplement-1');
  manager.recordUserRequirement('保留原对白', 'supplement-2');
  for (let i = 1; i <= 10; i++) {
    manager.finish('completed');
    const runtime = { ...f.runtime, generationId: `chain-${i}`, prompt: prompt(`继续第${i}章`) };
    const next = new AgentContextManager(f.projects, runtime, `chain-task-${i}`, runtime.prompt);
    const route = tool(`route-${i}`, 'v1', '', 'none', 'conversation.task.route');
    const result = route.messages[1]!;
    if (result.role !== 'toolResult') throw new Error('fixture');
    result.content = [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'routed',
          decision: 'follow_up',
          targetGenerationId: generationId,
        }),
      },
    ];
    next.observe(route);
    manager = new AgentContextManager(f.projects, runtime, `chain-task-${i}`, runtime.prompt);
    expect(
      manager.taskState.userRequirements.filter(
        (r) => r.source === 'session-constraints' || r.source.endsWith(':session-constraints'),
      ),
    ).toHaveLength(1);
    const request = manager.prepare(runtime, { messages: [] }).request;
    expect(JSON.stringify(request).split(constraints)).toHaveLength(2);
    expect(manager.taskState.userRequirements.filter((r) => r.text === '保留原对白')).toHaveLength(
      2,
    );
    generationId = runtime.generationId;
  }
  manager.recordUserRequirement('明确修正：本章不使用旁白。', 'correction');
  expect(manager.taskState.userRequirements.at(-1)?.text).toContain('本章不使用旁白');
  expect(manager.taskState.taskGoal).toBe(prompt('继续第10章'));
});
it('retains task routing and useful execution references after clearing recent history', async () => {
  const f = await fixture();
  const route = tool('route', 'v1', '', 'none', 'conversation.task.route');
  const result = route.messages[1]!;
  if (result.role !== 'toolResult') throw new Error('fixture');
  result.content = [
    {
      type: 'text',
      text: JSON.stringify({ status: 'routed', decision: 'independent', generationId: 'g' }),
    },
  ];
  f.manager.observe(route);
  f.manager.snapshot(f.runtime, tool('read', 'v1', '原文'), 'document');
  const request = new AgentContextManager(f.projects, f.runtime, 'task', f.runtime.prompt).prepare(
    f.runtime,
    { messages: [] },
  ).request;
  expect(request.prompt).toContain('"routing":{"decision":"independent"');
  expect(request.prompt).toContain('library.read');
  expect(request.systemInstruction).toContain('without routing this same task again');
  expect(
    f
      .store((s) => s.resultRefs(f.project.id, 'task'))
      .every((r) => r.toolName !== 'runtime.assistant'),
  ).toBe(true);
});
it('archives long tool histories while restoring only complete recent batches', async () => {
  const f = await fixture();
  const messages = Array.from(
    { length: 80 },
    (_, i) => tool(`long-${i}`, `v${i}`, `完整工作资料${i}`, `source-${i}`).messages,
  ).flat();
  f.manager.snapshot(f.runtime, { messages }, 'document');
  const projected = f.manager.recovery()!;
  expect(projected.messages.length).toBeLessThanOrEqual(32);
  expect(
    f.store((s) => s.resultRefs(f.project.id, 'task')).filter((r) => r.toolName === 'library.read'),
  ).toHaveLength(80);
  const recovered = new AgentContextManager(
    f.projects,
    f.runtime,
    'task',
    f.runtime.prompt,
  ).recovery()!;
  expect(recovered.messages.length).toBeLessThanOrEqual(32);
  for (let index = 0; index < recovered.messages.length; index++) {
    const result = recovered.messages[index]!;
    if (result.role !== 'toolResult') continue;
    const assistant = recovered.messages[index - 1]!;
    expect(assistant.role).toBe('assistant');
    if (assistant.role === 'assistant')
      expect(
        assistant.content.some((p) => p.type === 'toolCall' && p.id === result.toolCallId),
      ).toBe(true);
  }
  const first = f
    .store((s) => s.resultRefs(f.project.id, 'task'))
    .find((r) => r.callId === 'long-0')!;
  expect(f.store((s) => s.result(f.project.id, 'task', first.resultId))?.content).toContain(
    '完整工作资料0',
  );
});
it('builds Agent context at request time, refreshes metadata and respects the frozen history boundary', async () => {
  const f = await fixture();
  const content = new ContentService(f.projects);
  const contexts = new ContextService(f.projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  const document = content.saveDocument({
    title: 'Old catalog title',
    contentMarkdown: 'BODY_MUST_BE_RETRIEVED',
  });
  const generations = new GenerationService(
    f.projects,
    content,
    contexts,
    {
      status: () => ({ key: 'unused', name: 'Unused', model: 'unused', configured: false }),
      stream: () => Promise.reject(new Error('No provider call')),
    },
    {
      selectionResolver: {
        resolveLlmSelection: () => ({
          providerProfileId: 'p',
          providerName: 'Mock',
          modelId: 'm',
          modelName: 'Mock',
          remoteModelId: 'm',
          protocol: 'openai-responses',
          baseUrl: 'https://example.invalid/v1',
        }),
      },
    },
  );
  const params = {
    conversationId: conversation.id,
    providerProfileId: 'p',
    modelId: 'm',
    taskExecution: 'parallel' as const,
  };
  const previous = generations.prepare({
    ...params,
    prompt: 'Earlier explicit conversation request',
  });
  generations.complete({ ...previous.stream, content: 'Earlier assistant response' });
  const prepared = generations.prepare({ ...params, prompt: 'Current user task' }, 'agent');
  const runtime = {
    ...generations.runtime(prepared.stream),
    modelCapabilities: f.runtime.modelCapabilities,
  };
  expect(runtime.context).toBe('');
  expect(runtime.systemInstruction).not.toContain('Old catalog title');
  const manager = new AgentContextManager(f.projects, runtime, 'dynamic', runtime.prompt, contexts);
  const first = manager.prepare(runtime, { messages: [] }).request;
  expect(first.context).toContain('Old catalog title');
  expect(first.context).toContain('Earlier assistant response');
  expect(first.context).not.toContain('BODY_MUST_BE_RETRIEVED');
  expect(first.systemInstruction).not.toContain('Earlier assistant response');
  content.saveDocument({
    documentId: document.id,
    title: 'Current catalog title',
    contentMarkdown: 'NEW_BODY_STAYS_ON_DEMAND',
  });
  const foreign = generations.prepare({ ...params, prompt: 'Later parallel task' });
  generations.complete({ ...foreign.stream, content: 'FUTURE_BRANCH_OUTPUT' });
  const compatibilityRuntime = {
    ...runtime,
    context: first.context + '\nSTALE_SNAPSHOT_METADATA\n可选 UI 目标提示：document:' + document.id,
  };
  manager.snapshot(compatibilityRuntime, { messages: [] }, 'document');
  const restored = new AgentContextManager(
    f.projects,
    runtime,
    'dynamic',
    runtime.prompt,
    contexts,
  );
  const second = restored.prepare(compatibilityRuntime, { messages: [] }).request;
  expect(second.context).toContain('Current catalog title');
  expect(second.context).not.toContain('Old catalog title');
  expect(second.context).not.toContain('STALE_SNAPSHOT_METADATA');
  expect(second.context).not.toContain('FUTURE_BRANCH_OUTPUT');
  expect(second.context).not.toContain('NEW_BODY_STAYS_ON_DEMAND');
  expect(second.context).toContain('可选 UI 目标提示');
  expect(second.context.split('Earlier assistant response')).toHaveLength(2);
  expect(second.context.split('## 资料目录')).toHaveLength(2);
  expect(second.prompt).toContain('Current user task');
});
