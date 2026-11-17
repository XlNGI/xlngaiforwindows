import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { AgentContextStore, readShotImage } from '@ai-video/persistence';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import type { TaskPlanService } from './task-plan-service.js';
import { AgentContextManager } from './agent-context-manager.js';
import { PromptGenerationService } from './prompt-generation-service.js';
import {
  ensurePromptGeneration,
  loadPromptGeneration,
  preparePromptGeneration,
} from './prompt-generation-state.js';
import { loadBundle } from './production-bundle-state.js';
import { PROMPT_GENERATION_SUBMIT_SCHEMA } from './prompt-generation-schema.js';
import {
  bundleSubmissionFixture,
  productionBundleFixture,
} from './test-fixtures/production-bundle-fixture.js';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.project.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function fixture(
  protocol: 'openai-responses' | 'openai-chat-completions' = 'openai-responses',
) {
  const f = await productionBundleFixture(protocol, 34);
  fixtures.push(f);
  const runtime = f.generations.runtime(f.prepared.stream);
  const prepare = (
    purposes = ['general', 'character-image', 'scene-image', 'prop-image', 'video-prompt'],
  ) =>
    f.project.access(true, (db, p) =>
      db.transaction(() =>
        preparePromptGeneration(
          db,
          p.id,
          f.task.taskId,
          {
            sources: [{ documentId: f.source.id, versionId: f.source.currentVersion!.id }],
            purposes,
          },
          runtime,
        ),
      )(),
    );
  const service = new PromptGenerationService(f.project, f.content, f.workflow, JSON.stringify);
  return { ...f, runtime, prepare, service };
}

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'freezes full selected bodies and exact scoped templates for %s without unrelated context',
  async (protocol) => {
    const f = await fixture(protocol);
    f.runtime.promptTemplateSnapshot = {
      conversationId: f.conversation.id,
      rowVersion: 7,
      content: '通用\n哈哈110',
      templates: { 'character-image': '角色专项', 'video-prompt': '不适用视频模板' },
      updatedAt: new Date().toISOString(),
    };
    f.runtime.context = '旧系统目录和旧正文';
    f.runtime.tools = [
      {
        name: 'prompt.generation.submit',
        description: 'Submit complete prompts',
        parameters: PROMPT_GENERATION_SUBMIT_SCHEMA,
      },
    ];
    const input = f.prepare(['character-image']);
    const parsed = JSON.parse(input.input) as {
      sources: Array<{ contentMarkdown: string }>;
      purposeTemplates: Array<{ content: string }>;
      generalTemplate: string;
    };
    expect(parsed.sources[0]!.contentMarkdown).toBe(f.source.currentVersion!.contentMarkdown);
    expect(parsed.generalTemplate).toBe('通用\n哈哈110');
    expect(parsed.purposeTemplates).toEqual([
      { purpose: 'character-image', label: '角色图片提示词', content: '角色专项' },
    ]);
    const manager = new AgentContextManager(
      f.project,
      f.prepared.stream,
      f.task.taskId,
      f.runtime.prompt,
    );
    const projected = manager.prepare(f.runtime, {
      messages: [{ role: 'user', content: '无关聊天', timestamp: 1 }],
    }).request;
    expect(projected.requiredTool).toBe('prompt.generation.submit');
    const schema = projected.tools![0]!.parameters as {
      properties: {
        requestHash: { const: string };
        prompts: { items: { properties: { kind: { enum: string[] } } } };
      };
    };
    expect(schema.properties.requestHash.const).toBe(input.requestHash);
    expect(schema.properties.prompts.items.properties.kind.enum).toEqual(['character']);
    expect(projected.prompt).toContain(input.requestHash);
    expect(projected.prompt).not.toContain('无关聊天');
    expect(projected.context).toBe('');
    expect(projected.continuation).toBeUndefined();
  },
);

it('rejects an out-of-scope kind with an actionable error and no partial writes', async () => {
  const f = await fixture();
  const input = f.prepare(['character-image']);
  expect(() =>
    f.service.execute(
      'submit',
      {
        requestHash: input.requestHash,
        prompts: [
          {
            kind: 'shot-image',
            localKey: 'unexpected-image',
            title: '越界静态图',
            prompt: '不能落库',
            bindings: { schemaVersion: 1 },
          },
        ],
      },
      f.identity,
    ),
  ).toThrow('PROMPT_GENERATION_PURPOSE_INVALID: unexpected-image kind=shot-image');
  expect(f.content.listScenes()).toHaveLength(0);
  f.project.access(false, (db, p) =>
    expect(loadBundle(db, p.id, f.task.taskId)?.entries).toHaveLength(0),
  );
});

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'uses only selected purpose templates on new tasks and preserves empty user edits (%s)',
  async (protocol) => {
    const f = await fixture(protocol);
    f.runtime.promptTemplateSnapshot = {
      conversationId: f.conversation.id,
      rowVersion: 9,
      policyVersion: 2,
      content: '历史通用要求不得注入',
      templates: {
        'character-image': '用户修改的角色约束',
        'scene-image': '',
        'video-prompt': '本次没有生成视频',
      },
    };
    const input = f.prepare(['character-image', 'scene-image']);
    const frozen = JSON.parse(input.input) as Record<string, unknown>;
    expect(frozen).not.toHaveProperty('generalTemplate');
    expect(frozen.purposeTemplates).toEqual([
      { purpose: 'character-image', label: '角色图片提示词', content: '用户修改的角色约束' },
      { purpose: 'scene-image', label: '场景图片提示词', content: '' },
    ]);
    expect(input.input).not.toContain('历史通用要求不得注入');
    expect(input.input).not.toContain('本次没有生成视频');
    f.runtime.promptTemplateSnapshot.templates!['character-image'] = '执行中修改只影响下一任务';
    f.project.access(false, (db, p) =>
      expect(loadPromptGeneration(db, p.id, f.task.taskId)).toEqual(input),
    );
    expect(
      f.service.execute(
        'submit',
        {
          requestHash: input.requestHash,
          prompts: [
            {
              kind: 'character',
              localKey: 'hero',
              title: '主角',
              prompt: '按修改后角色约束创作的正文',
              bindings: { schemaVersion: 1 },
            },
            {
              kind: 'location',
              localKey: 'room',
              title: '房间',
              prompt: '用户清空场景模板后创作的正文',
              bindings: { schemaVersion: 1 },
            },
          ],
        },
        f.identity,
      ),
    ).toMatchObject({ businessSaved: true, readbackVerified: true });
  },
);

it('rejects stale or foreign sources without initializing a partial bundle', async () => {
  const f = await fixture();
  expect(() =>
    f.project.access(true, (db, p) =>
      db.transaction(() =>
        preparePromptGeneration(
          db,
          p.id,
          f.task.taskId,
          {
            sources: [{ documentId: f.source.id, versionId: 'foreign' }],
            purposes: ['character-image'],
          },
          f.runtime,
        ),
      )(),
    ),
  ).toThrow('BUNDLE_SOURCE_CONFLICT');
  f.project.access(false, (db, p) => {
    expect(loadBundle(db, p.id, f.task.taskId)).toBeUndefined();
    expect(loadPromptGeneration(db, p.id, f.task.taskId)).toBeUndefined();
  });
});

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'saves one complete response with references through the existing atomic boundary for %s',
  async (protocol) => {
    const f = await fixture(protocol);
    const input = f.prepare();
    const { submission } = bundleSubmissionFixture();
    const prompts = submission.prompts.map((p) => ({
      ...p,
      bindings: p.bindings ?? { schemaVersion: 1 },
    }));
    const result = f.service.execute(
      'submit',
      { requestHash: input.requestHash, prompts },
      f.identity,
    );
    expect(result).toMatchObject({
      businessSaved: true,
      readbackVerified: true,
      status: 'bundle_readback_verified',
    });
    const docs = f.content.listDocuments();
    expect(
      f.content.getDocument(docs.find((d) => d.title === prompts[0]!.title)!.id).currentVersion
        ?.contentMarkdown,
    ).toBe(prompts[0]!.prompt);
    expect(f.content.listScenes()).toHaveLength(1);
    const shot = f.content.listShots(f.content.listScenes()[0]!.id)[0]!;
    expect(shot.prompt).toBe(prompts.find((p) => p.kind === 'shot')!.prompt);
    expect(shot.bindings?.characterDocumentIds).toHaveLength(1);
    expect(
      f.service.execute('submit', { requestHash: input.requestHash, prompts }, f.identity),
    ).toMatchObject({ replayed: true });
    expect(f.content.listScenes()).toHaveLength(1);
  },
);

it('rolls back all candidates and business objects for invalid references, then accepts a complete correction', async () => {
  const f = await fixture();
  const input = f.prepare();
  const { submission } = bundleSubmissionFixture();
  const prompts = submission.prompts.map((p) => ({
    ...p,
    bindings: p.bindings ?? { schemaVersion: 1 },
  }));
  const invalid = structuredClone(prompts);
  invalid.find((p) => p.kind === 'shot')!.bindings = {
    schemaVersion: 1,
    characterDocumentIds: [{ localKey: 'missing' }],
    sceneDocumentIds: [],
    propDocumentIds: [],
  };
  expect(() =>
    f.service.execute('submit', { requestHash: input.requestHash, prompts: invalid }, f.identity),
  ).toThrow('PROMPT_GENERATION_STRUCTURE_REQUIRED');
  expect(f.content.listScenes()).toHaveLength(0);
  f.project.access(false, (db, p) =>
    expect(loadBundle(db, p.id, f.task.taskId)?.entries).toHaveLength(0),
  );
  expect(
    f.service.execute('submit', { requestHash: input.requestHash, prompts }, f.identity)
      .businessSaved,
  ).toBe(true);
});

it('saves optional static shot text after its video candidate without another model request', async () => {
  const f = await fixture();
  const input = f.prepare([
    'general',
    'character-image',
    'scene-image',
    'prop-image',
    'video-prompt',
    'shot-image',
  ]);
  const prompts = bundleSubmissionFixture().submission.prompts.map((p) => ({
    ...p,
    bindings: p.bindings ?? { schemaVersion: 1 },
  }));
  const video = prompts.find((p) => p.kind === 'shot')!;
  const imagePrompt = '独立静态构图\n哈哈110';
  const result = f.service.execute(
    'submit',
    {
      requestHash: input.requestHash,
      prompts: [
        ...prompts,
        {
          kind: 'shot-image',
          localKey: video.localKey,
          title: video.title,
          prompt: imagePrompt,
          imagePurpose: 'composition',
          intent: '构图参考',
          bindings: {
            schemaVersion: 1,
            characterDocumentIds: [],
            sceneDocumentIds: [{ localKey: 'room' }],
            propDocumentIds: [],
          },
        },
      ],
    },
    f.identity,
  );
  expect(result).toMatchObject({ businessSaved: true, readbackVerified: true, shotImageCount: 1 });
  const shot = f.content.listShots(f.content.listScenes()[0]!.id)[0]!;
  expect(shot.prompt).toBe(video.prompt);
  f.project.access(false, (db, p) =>
    expect(readShotImage(db, p.id, shot.id).prompt).toBe(imagePrompt),
  );
});

it('partitions more than twelve objects locally and preserves every prompt byte', async () => {
  const f = await fixture();
  const input = f.prepare(['character-image']);
  const prompts = Array.from({ length: 25 }, (_, i) => ({
    kind: 'character',
    localKey: `c${i}`,
    title: `角色${i}`,
    prompt: `哈哈110\n\n${i}\n`,
    bindings: { schemaVersion: 1 },
  }));
  expect(
    f.service.execute('submit', { requestHash: input.requestHash, prompts }, f.identity)
      .businessSaved,
  ).toBe(true);
  for (const prompt of prompts)
    expect(
      f.content.getDocument(f.content.listDocuments().find((d) => d.title === prompt.title)!.id)
        .currentVersion?.contentMarkdown,
    ).toBe(prompt.prompt);
  f.project.access(false, (db, p) => expect(loadBundle(db, p.id, f.task.taskId)?.revision).toBe(3));
});

it('partitions by UTF-8 bytes even below the twelve-object limit', async () => {
  const f = await fixture();
  const input = f.prepare(['character-image']);
  const prompts = Array.from({ length: 6 }, (_, i) => ({
    kind: 'character',
    localKey: `large${i}`,
    title: `大稿${i}`,
    prompt: '字'.repeat(30000) + `\n${i}`,
    bindings: { schemaVersion: 1 },
  }));
  expect(
    f.service.execute('submit', { requestHash: input.requestHash, prompts }, f.identity)
      .businessSaved,
  ).toBe(true);
  f.project.access(false, (db, p) => expect(loadBundle(db, p.id, f.task.taskId)?.revision).toBe(3));
  expect(
    f.content.getDocument(f.content.listDocuments().find((d) => d.title === prompts[5]!.title)!.id)
      .currentVersion?.contentMarkdown,
  ).toBe(prompts[5]!.prompt);
});

it('restores complete failed candidates and exact errors for bounded repair after history projection', async () => {
  const f = await fixture();
  const input = f.prepare(['character-image']);
  const candidate = {
    requestHash: input.requestHash,
    prompts: [
      {
        localKey: 'stable',
        kind: 'character',
        title: '角色',
        prompt: '保持既有完整设计'.repeat(1000),
        bindings: { schemaVersion: 1 },
      },
    ],
  };
  const manager = new AgentContextManager(
    f.project,
    f.prepared.stream,
    f.task.taskId,
    f.runtime.prompt,
  );
  const context = {
    messages: [
      fauxAssistantMessage(
        [fauxToolCall('prompt.generation.submit', candidate, { id: 'failed-submit' })],
        { stopReason: 'toolUse' },
      ),
      {
        role: 'toolResult' as const,
        toolCallId: 'failed-submit',
        toolName: 'prompt.generation.submit',
        content: [{ type: 'text' as const, text: '真实结构错误：引用位置不存在' }],
        isError: true,
        timestamp: 1,
      },
    ],
  };
  manager.snapshot(f.runtime, context, 'document');
  const request = manager.prepare(f.runtime, { messages: manager.compactHistory(context) }).request;
  expect(request.prompt).toContain(candidate.prompts[0]!.prompt);
  expect(request.prompt).toContain('真实结构错误：引用位置不存在');
  expect(request.prompt).not.toContain('archivedArguments');
});

it('prepares an explicitly marked one-click task automatically and restores the same frozen input', async () => {
  const f = await fixture();
  f.project.access(true, (db, p) => {
    const row = db
      .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id=?')
      .get(f.task.taskId) as { request_snapshot_json: string };
    db.prepare('UPDATE agent_tasks SET request_snapshot_json=? WHERE id=?').run(
      JSON.stringify({
        ...(JSON.parse(row.request_snapshot_json) as object),
        promptGenerationVersion: 1,
      }),
      f.task.taskId,
    );
    const input = ensurePromptGeneration(db, p.id, f.task.taskId, f.runtime)!;
    expect(input.input).toContain(f.source.currentVersion!.contentMarkdown);
    expect(ensurePromptGeneration(db, p.id, f.task.taskId, f.runtime)).toEqual(input);
    expect(
      new AgentContextStore(db).resultForCall(p.id, f.task.taskId, 'prompt-generation:input'),
    ).toBeDefined();
  });
});

it.each([
  ['openai-responses', true],
  ['openai-responses', false],
  ['openai-chat-completions', true],
  ['openai-chat-completions', false],
] as const)(
  'runs real authorization, context and atomic save with no model finalization request (%s, oneClick=%s)',
  async (protocol, oneClick) => {
    const f = await fixture(protocol);
    const prompt = '根据所选剧本生成完整提示词和绑定';
    const conversation = f.content.createConversation({ scopeType: 'project' });
    f.content.saveConversationPromptTemplate({
      conversationId: conversation.id,
      content: '历史通用标记不得注入',
      templates: { 'character-image': '用户当前自定义角色约束', 'scene-image': '' },
      expectedRowVersion: 0,
    });
    const prepared = f.generations.prepare(
      {
        conversationId: conversation.id,
        prompt,
        promptTemplateVersion: 1,
        providerProfileId: f.runtime.providerProfileId,
        modelId: f.runtime.modelId,
      },
      'agent',
    );
    const task = f.loop.prepare(
      prepared.stream,
      prompt,
      undefined,
      { operation: 'document.list' },
      'project_only',
      undefined,
      undefined,
      undefined,
      undefined,
      oneClick ? 'script-to-media' : undefined,
      oneClick
        ? {
            version: 2,
            sources: [{ documentId: f.source.id, versionId: f.source.currentVersion!.id }],
            requestedAt: new Date().toISOString(),
          }
        : undefined,
      oneClick,
    );
    f.generations.configureAgentTools(prepared.stream, task.tools);
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    const requestedTools: string[][] = [];
    let calls = 0;
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      plans: {} as TaskPlanService,
      providerTools: f.loop,
      createGateway: () => {
        throw new Error('Prompt generation must use the existing Provider gateway.');
      },
      createContextManager: (identity, taskId, userPrompt) =>
        new AgentContextManager(f.project, identity, taskId, userPrompt),
      streamFn: (model, context, options) => {
        calls++;
        if (calls > 2) throw new Error('Unexpected extra model request after complete save.');
        requestedTools.push(context.tools?.map((tool) => tool.name) ?? []);
        const input = f.project.access(false, (db, p) =>
          loadPromptGeneration(db, p.id, task.taskId),
        );
        const { submission } = bundleSubmissionFixture();
        const name = input ? 'prompt.generation.submit' : 'prompt.generation.request';
        const args = input
          ? {
              requestHash: input.requestHash,
              prompts: submission.prompts.map((p) => ({
                ...p,
                bindings: p.bindings ?? { schemaVersion: 1 },
              })),
            }
          : {
              sources: [{ documentId: f.source.id, versionId: f.source.currentVersion!.id }],
              purposes: ['general', 'character-image', 'scene-image', 'prop-image', 'video-prompt'],
            };
        if (input) {
          expect(input.input).not.toContain('历史通用标记不得注入');
          expect(input.input).toContain('用户当前自定义角色约束');
          expect(JSON.parse(input.input)).not.toHaveProperty('generalTemplate');
          expect(
            (
              JSON.parse(input.input) as { purposeTemplates: Array<{ purpose: string }> }
            ).purposeTemplates.map((t) => t.purpose),
          ).not.toContain('general');
          expect(context.systemPrompt).not.toContain('unified project Agent');
          expect(JSON.stringify(context.messages)).toContain(
            f.source.currentVersion!.contentMarkdown,
          );
          expect(context.tools?.map((tool) => tool.name)).toEqual(['prompt.generation.submit']);
        }
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${calls}` })], {
            stopReason: 'toolUse',
            responseId: `response-${calls}`,
          }),
        ]);
        return faux.streamSimple(model, context, options);
      },
    });
    await runtime.start({
      ...prepared.stream,
      identity: prepared.stream,
      taskId: task.taskId,
      mode: 'document',
      prompt,
    });
    await runtime.wait(prepared.stream.generationId);
    expect(calls).toBe(oneClick ? 1 : 2);
    f.project.access(false, (db) => {
      const state = db
        .prepare('SELECT status,outcome,error_message FROM agent_tasks WHERE id=?')
        .get(task.taskId);
      expect(state).toMatchObject({ status: 'completed', outcome: null, error_message: null });
    });
    expect(f.content.listScenes()).toHaveLength(1);
    if (!oneClick) expect(requestedTools[0]).toContain('prompt.generation.request');
  },
);

it('follows explicit source bindings and excludes unrelated document bodies', async () => {
  const f = await fixture();
  const character = f.content.saveDocument({
    kind: 'character',
    title: '已确认角色',
    contentMarkdown: '深蓝外套的具体既有设计',
  });
  f.content.saveDocument({
    kind: 'character',
    title: '无关角色',
    contentMarkdown: '不应该出站的正文',
  });
  const source = f.content.saveDocument({
    documentId: f.source.id,
    title: f.source.title,
    contentMarkdown: f.source.currentVersion!.contentMarkdown,
    bindings: { schemaVersion: 1, characterDocumentIds: [character.id] },
  });
  const input = f.project.access(true, (db, p) =>
    db.transaction(() =>
      preparePromptGeneration(
        db,
        p.id,
        f.task.taskId,
        {
          sources: [{ documentId: source.id, versionId: source.currentVersion!.id }],
          purposes: ['character-image'],
        },
        f.runtime,
      ),
    )(),
  );
  expect(input.input).toContain('深蓝外套的具体既有设计');
  expect(input.input).not.toContain('不应该出站的正文');
  f.project.access(false, (db, p) =>
    expect(loadBundle(db, p.id, f.task.taskId)?.reused.map((s) => s.documentId)).toContain(
      character.id,
    ),
  );
});

it('rejects changed sources after freezing instead of generating from a silent replacement', async () => {
  const f = await fixture();
  f.prepare();
  f.content.saveDocument({
    documentId: f.source.id,
    title: f.source.title,
    contentMarkdown: '外部改写的新版正文',
  });
  expect(() =>
    f.project.access(true, (db, p) => ensurePromptGeneration(db, p.id, f.task.taskId, f.runtime)),
  ).toThrow('BUNDLE_SOURCE_CONFLICT');
  expect(f.content.listScenes()).toHaveLength(0);
});

it('bounds failed authoring requests durably across context reconstruction', async () => {
  const f = await fixture();
  f.prepare();
  for (let i = 0; i < 3; i++) f.loop.reserveTurn(f.prepared.stream);
  new AgentContextManager(f.project, f.prepared.stream, f.task.taskId, f.runtime.prompt);
  expect(() => f.loop.reserveTurn(f.prepared.stream)).toThrow('PROMPT_GENERATION_ATTEMPT_LIMIT');
});

it('cannot complete or retry indefinitely after a rejected general generation request', async () => {
  const f = await fixture();
  const conversation = f.content.createConversation({ scopeType: 'project' });
  const prepared = f.generations.prepare({
    conversationId: conversation.id,
    prompt: '生成角色提示词',
    providerProfileId: f.runtime.providerProfileId,
    modelId: f.runtime.modelId,
  });
  const task = f.loop.prepare(
    prepared.stream,
    '生成角色提示词',
    undefined,
    { operation: 'document.list' },
    'project_only',
  );
  const manager = new AgentContextManager(
    f.project,
    prepared.stream,
    task.taskId,
    '生成角色提示词',
  );
  const runtime = f.generations.runtime(prepared.stream);
  for (let i = 0; i < 3; i++) {
    const id = `rejected-${i}`;
    manager.snapshot(
      runtime,
      {
        messages: [
          fauxAssistantMessage(
            [
              fauxToolCall(
                'prompt.generation.request',
                { sources: [], purposes: ['character-image'] },
                { id },
              ),
            ],
            { stopReason: 'toolUse' },
          ),
          {
            role: 'toolResult',
            toolCallId: id,
            toolName: 'prompt.generation.request',
            content: [{ type: 'text', text: 'sources requires actual selected versions' }],
            isError: true,
            timestamp: i,
          },
        ],
      },
      'document',
    );
  }
  f.loop.startProviderStep(prepared.stream);
  expect(() => f.loop.completeProviderStep({ ...prepared.stream, finishReason: 'stop' })).toThrow(
    'prompt_generation_not_prepared',
  );
  expect(() => f.loop.reserveTurn(prepared.stream)).toThrow('PROMPT_GENERATION_REQUEST_LIMIT');
  expect(f.content.listScenes()).toHaveLength(0);
});

it('keeps empty user templates empty and rejects verified context overflow without truncating sources', async () => {
  const f = await fixture();
  f.runtime.promptTemplateSnapshot = {
    conversationId: f.conversation.id,
    rowVersion: 8,
    content: '',
    templates: { 'character-image': '' },
    updatedAt: new Date().toISOString(),
  };
  const input = f.prepare(['character-image']);
  expect(JSON.parse(input.input)).toMatchObject({
    generalTemplate: '',
    purposeTemplates: [{ content: '' }],
  });
  const manager = new AgentContextManager(
    f.project,
    f.prepared.stream,
    f.task.taskId,
    f.runtime.prompt,
  );
  const runtime = {
    ...f.runtime,
    contextWindowTokens: 200,
    contextWindowSource: 'contract' as const,
    modelCapabilities: {
      modelId: 'verified',
      contextWindow: 4096,
      maxInputTokens: 1,
      maxOutputTokens: 128,
      capabilitySource: 'manual_config' as const,
    },
  };
  expect(() => manager.prepare(runtime, { messages: [] })).toThrow(
    /CONTEXT_(LIMIT|BUDGET_EXCEEDED)/,
  );
  f.project.access(false, (db, p) =>
    expect(loadPromptGeneration(db, p.id, f.task.taskId)).toEqual(input),
  );
});

it('finishes from a durable saved receipt without another model call after runtime reconstruction', async () => {
  const f = await fixture();
  const input = f.prepare();
  const prompts = bundleSubmissionFixture().submission.prompts.map((p) => ({
    ...p,
    bindings: p.bindings ?? { schemaVersion: 1 },
  }));
  expect(
    f.service.execute('submit', { requestHash: input.requestHash, prompts }, f.identity)
      .readbackVerified,
  ).toBe(true);
  f.generations.configureAgentTools(
    f.prepared.stream,
    f.loop.advanceTextTurn({ ...f.prepared.stream, finishReason: 'tool_calls' }),
  );
  let requests = 0;
  const runtime = new PiConversationRuntime({
    generation: f.generations,
    plans: {} as TaskPlanService,
    providerTools: f.loop,
    createGateway: () => {
      throw new Error('No alternate runtime.');
    },
    createContextManager: (identity, taskId, prompt) =>
      new AgentContextManager(f.project, identity, taskId, prompt),
    streamFn: () => {
      requests++;
      throw new Error('Saved receipt must finish locally.');
    },
  });
  await runtime.start({
    ...f.prepared.stream,
    identity: f.prepared.stream,
    taskId: f.task.taskId,
    mode: 'document',
    prompt: f.runtime.prompt,
  });
  await runtime.wait(f.prepared.stream.generationId);
  expect(requests).toBe(0);
  f.project.access(false, (db) =>
    expect(
      db.prepare('SELECT status,error_message FROM agent_tasks WHERE id=?').get(f.task.taskId),
    ).toMatchObject({ status: 'completed', error_message: null }),
  );
  expect(f.content.listScenes()).toHaveLength(1);
});
