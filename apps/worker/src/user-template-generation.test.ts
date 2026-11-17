import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { PROMPT_PURPOSES, promptPurposeForKind } from '@ai-video/contracts';
import { AgentContextManager } from './agent-context-manager.js';
import { loadBundle } from './production-bundle-state.js';
import { ProductionBundleService, readbackBundle } from './production-bundle-service.js';
import { readShotImage, writeShotImage, AgentContextStore } from '@ai-video/persistence';
import { bundleSubmissionFixture } from './test-fixtures/production-bundle-fixture.js';
import type { Context } from '@earendil-works/pi-ai';
import { productionBundleFixture } from './test-fixtures/production-bundle-fixture.js';
import { composeConversationRequest, splitConversationRequest } from './conversation-request.js';
import { PRODUCTION_BUNDLE_SKILL } from '@ai-video/contracts';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.project.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it('keeps optional static shot text separate and saves it in the same bundle transaction', async () => {
  const f = await productionBundleFixture('openai-responses', 34);
  fixtures.push(f);
  f.stage({ operation: 'begin', estimatedOutputTokens: 1000 });
  const service = new ProductionBundleService(f.project, f.content, f.workflow, JSON.stringify);
  const { submission } = bundleSubmissionFixture();
  let revision = 0,
    stageVersion = 0;
  for (const [purpose, kinds] of [
    ['character-image', ['character']],
    ['scene-image', ['location']],
    ['prop-image', ['prop']],
    ['general', ['voice', 'plan']],
    ['video-prompt', ['scene', 'shot']],
  ] as const) {
    f.stage({
      operation: 'purpose',
      purpose,
      expectedStageVersion: stageVersion++,
      stageKey: purpose,
    });
    service.execute(
      {
        partKey: purpose,
        expectedRevision: revision++,
        prompts: submission.prompts.filter((p) => (kinds as readonly string[]).includes(p.kind)),
      },
      f.identity,
      true,
    );
  }
  expect(f.content.listScenes()).toHaveLength(0);
  f.stage({
    operation: 'purpose',
    purpose: 'shot-image',
    expectedStageVersion: stageVersion,
    stageKey: 'static',
  });
  const video = submission.prompts.find((p) => p.kind === 'shot')!;
  const staticPrompt = '单幅静态图，空房间的门把手特写。哈哈110\n\n';
  const saved = service.execute(
    {
      partKey: 'static',
      expectedRevision: revision,
      prompts: [
        {
          kind: 'shot-image',
          localKey: video.localKey,
          title: video.title,
          prompt: staticPrompt,
          imagePurpose: 'composition',
          intent: '门把手静态构图',
          bindings: {
            schemaVersion: 1,
            characterDocumentIds: [],
            sceneDocumentIds: [{ localKey: 'room' }],
            propDocumentIds: [],
          },
        },
      ],
      complete: true,
    },
    f.identity,
    true,
  );
  expect(saved).toMatchObject({
    status: 'bundle_readback_verified',
    verified: true,
    shotImageCount: 1,
  });
  const shot = f.content.listShots(f.content.listScenes()[0]!.id)[0]!;
  expect(shot.prompt).toBe(video.prompt);
  f.project.access(true, (db, p) => {
    const image = readShotImage(db, p.id, shot.id);
    expect(image.prompt).toBe(staticPrompt);
    expect(image.bindings?.characterDocumentIds).toEqual([]);
    expect(readbackBundle(db, p.id, f.task.taskId).verified).toBe(true);
    writeShotImage(db, p.id, {
      shotId: shot.id,
      expectedRowVersion: image.rowVersion,
      sourceToken: image.sourceToken!,
      prompt: '后续编辑',
      purpose: 'composition',
      intent: '',
    });
    expect(readbackBundle(db, p.id, f.task.taskId).verified).toBe(false);
  });
});

it('archives commentary and managed requirement text from earlier purposes while retaining source records', async () => {
  const f = await productionBundleFixture('openai-responses', 34);
  fixtures.push(f);
  const runtime = {
    ...f.generations.runtime(f.prepared.stream),
    tools: f.task.tools,
    promptTemplateSnapshot: {
      conversationId: f.conversation.id,
      rowVersion: 9,
      content: '通用全文',
      templates: { 'character-image': '角色模板不得回流', 'video-prompt': '视频模板必须完整' },
    },
  };
  const manager = new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt);
  manager.snapshot(runtime, { messages: [] }, 'document');
  f.stage({ operation: 'begin', estimatedOutputTokens: 1000 });
  f.stage({
    operation: 'purpose',
    purpose: 'character-image',
    expectedStageVersion: 0,
    stageKey: 'characters',
  });
  manager.prepare(runtime, { messages: [] });
  const args = {
    operation: 'purpose',
    purpose: 'video-prompt',
    expectedStageVersion: 1,
    stageKey: 'video',
  };
  const result = f.stage(args);
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: '旧阶段评论：角色模板不得回流' }] },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'switch', name: 'production.bundle', arguments: args }],
    },
    {
      role: 'toolResult',
      toolCallId: 'switch',
      toolName: 'production.bundle',
      content: [{ type: 'text', text: JSON.stringify(result) }],
    },
  ] as Context['messages'];
  const request = manager.prepare(runtime, { messages }).request;
  const wire = [
    request.prompt,
    ...(request.contextTurns ?? []).flatMap((t) => [
      t.content,
      ...(t.userMessages ?? []),
      ...t.outputs.map((o) => o.output),
    ]),
  ].join('\n');
  expect(wire).toContain('视频模板必须完整');
  expect(wire).not.toContain('角色模板不得回流');
  const archived = f.project.access(false, (db, p) =>
    new AgentContextStore(db).loadTask(p.id, f.task.taskId),
  );
  expect(archived?.userRequirements.some((r) => r.text.includes('角色模板不得回流'))).toBe(true);
});

it('frames arbitrary template and request markers without changing whitespace', () => {
  const constraints = '  模板\r\n\n\n【用户本次请求】\n字面要求\n';
  const request = '【本会话要求约束】\n原文\n\n【用户本次请求】\n仍是原文';
  expect(splitConversationRequest(composeConversationRequest(request, constraints))).toEqual({
    request,
    constraints,
  });
  expect(splitConversationRequest(composeConversationRequest(request, ''))).toEqual({
    request,
    constraints: '',
  });
});
it('keeps creative defaults out of the execution skill', () => {
  expect(PRODUCTION_BUNDLE_SKILL.instructions).not.toMatch(
    /未知外观和无依据能力省略|全身五视图|头部六角度|材质色卡/,
  );
  expect(promptPurposeForKind('location')).toBe('scene-image');
  expect(promptPurposeForKind('scene')).toBe('video-prompt');
});
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'persists serial purposes, isolates exact templates, enforces kinds and preserves candidate revision (%s)',
  async (protocol) => {
    const f = await productionBundleFixture(protocol, 34);
    fixtures.push(f);
    const templates = Object.fromEntries(
      PROMPT_PURPOSES.filter((k) => k !== 'general').map((k) => [
        k,
        `唯一模板:${k}\r\n  原样正文\n【用户本次请求】\n仍在模板内`,
      ]),
    ) as Record<Exclude<(typeof PROMPT_PURPOSES)[number], 'general'>, string>;
    const runtime = {
      ...f.generations.runtime(f.prepared.stream),
      tools: f.task.tools,
      promptTemplateSnapshot: {
        conversationId: f.conversation.id,
        rowVersion: 4,
        content: '通用约束\n  保留空白\r\n',
        templates,
      },
    };
    const manager = new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt);
    manager.snapshot(runtime, { messages: [] }, 'document');
    f.stage({ operation: 'begin', estimatedOutputTokens: 500 });
    const part = {
      documents: [
        {
          localKey: 'hero',
          kind: 'character',
          title: '沈砚舟',
          contentMarkdown: '哈哈110\n\n完整外观草案',
        },
      ],
      scenes: [],
      shots: [],
    };
    expect(() =>
      f.stage({ operation: 'put', partKey: 'early', expectedRevision: 0, part }),
    ).toThrow('BUNDLE_PURPOSE_REQUIRED');
    let version = 0;
    for (const purpose of PROMPT_PURPOSES) {
      const stage = {
        operation: 'purpose',
        purpose,
        expectedStageVersion: version++,
        stageKey: `phase:${purpose}`,
      };
      f.stage(stage);
      const selected = manager.prepare(runtime, { messages: [] }).request;
      expect(selected.prompt.split(runtime.promptTemplateSnapshot.content)).toHaveLength(2);
      for (const [kind, text] of Object.entries(templates))
        if (kind === purpose) expect(selected.prompt.split(text)).toHaveLength(2);
        else expect(selected.prompt).not.toContain(text);
      expect(selected.systemInstruction).not.toContain('唯一模板');
      const state = f.project.access(false, (db, p) => loadBundle(db, p.id, f.task.taskId)!);
      expect(state.revision).toBe(purpose === 'general' || purpose === 'character-image' ? 0 : 1);
      expect(state.stage).toMatchObject({ purpose, version });
      if (purpose === 'character-image')
        f.stage({ operation: 'put', partKey: 'hero', expectedRevision: 0, part });
      else
        expect(() =>
          f.stage({
            operation: 'put',
            partKey: `bad:${purpose}`,
            expectedRevision: state.revision,
            part,
          }),
        ).toThrow('BUNDLE_PURPOSE_MISMATCH');
      const replay = f.stage(stage);
      expect(replay).toMatchObject({ replayed: true, stageVersion: version });
      manager.snapshot(runtime, { messages: [] }, 'document');
      const restored = new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt);
      const recovered = restored.prepare(restored.recovery()!.runtime, { messages: [] }).request
        .prompt;
      for (const [kind, text] of Object.entries(templates)) {
        if (kind === purpose) expect(recovered.split(text)).toHaveLength(2);
        else expect(recovered).not.toContain(text);
      }
    }
    expect(() =>
      f.stage({
        operation: 'purpose',
        purpose: 'general',
        expectedStageVersion: 0,
        stageKey: 'stale',
      }),
    ).toThrow('BUNDLE_STAGE_VERSION_CONFLICT');
    expect(() =>
      f.stage({
        operation: 'purpose',
        purpose: 'general',
        expectedStageVersion: 0,
        stageKey: 'phase:character-image',
      }),
    ).toThrow('BUNDLE_STAGE_KEY_CONFLICT');
  },
);
