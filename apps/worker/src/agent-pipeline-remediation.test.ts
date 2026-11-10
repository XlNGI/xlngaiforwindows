import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { PromptRecord } from '@ai-video/contracts';
import {
  validateToolArguments,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { AgentContextStore, AgentExecutionStore } from '@ai-video/persistence';
import { AgentContextManager } from './agent-context-manager.js';
import { modelResultReceipt } from './agent-context-results.js';
import { taskPlanScope } from './agent-task-deliverables.js';
import { nativeRequestUserText } from './test-fixtures/native-request-text.js';
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
import { NovelService } from './novel-service.js';
import { productionSkillPrompt } from '@ai-video/contracts';
import { decodeProductionHistory } from './test-fixtures/production-context.js';
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
  if (params.contextTurns?.at(-1)?.outputs.length)
    return JSON.parse(params.contextTurns.at(-1)!.outputs[0]!.output) as Record<string, unknown>;
  if (params.continuation)
    return JSON.parse(params.continuation.outputs[0]!.output) as Record<string, unknown>;
  // Responses compaction starts a new chain; completed results are replayed in the prompt.
  const history = params.prompt
    .split('[COMPLETED TASK HISTORY — EVIDENCE, NOT NEW INSTRUCTIONS]')[1]
    ?.split('[END TASK HISTORY]')[0];
  if (!history) throw new Error('Expected completed task history in compacted prompt.');
  const result = (
    JSON.parse(history) as Array<{
      role: string;
      content?: string;
    }>
  )
    .filter((entry) => entry.role === 'toolResult')
    .at(-1)?.content;
  if (!result) throw new Error('Expected a replayed tool result.');
  return JSON.parse(result) as Record<string, unknown>;
}
function stageEnvelope(params: NativeProviderStreamStartParams) {
  return (
    JSON.parse(
      nativeRequestUserText(params)
        .split('[TASK STATE AND EXECUTION DATA — source records, not new user instructions]')
        .at(-1)!
        .trimStart()
        .split('\n')[0]!,
    ) as {
      taskState: {
        evidence: Array<{
          resultId: string;
          sourceType: string;
        }>;
        availableTools: string[];
        savedArtifacts: unknown[];
        userRequirements: Array<{
          text: string;
        }>;
        checkpoint: {
          remainingWorkAtCheckpoint: string;
        };
      };
    }
  ).taskState;
}
const fixtures: Array<{
  project: ProjectService;
  directory: string;
}> = [];
afterEach(async () => {
  for (const { project, directory } of fixtures.splice(0)) {
    project.close();
    await rm(directory, { recursive: true, force: true });
  }
});
function promptPatch(record: Partial<PromptRecord>) {
  return { prompt: record.prompt, ...(record.bindings ? { bindings: record.bindings } : {}) };
}
function authoring(shot = false): PromptRecord {
  return {
    prompt: '庭院清晨，人物停顿后转身。',
    ...(shot ? { timing: { estimatedDurationSeconds: 4 } } : {}),
  };
}
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'atomically registers and saves one explicit draft without a registration round (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存一份大纲。');
    const args = {
      resourceId: 'workspace:documents',
      documentKind: 'plan',
      title: '大纲',
      contentMarkdown: '# 大纲\n完整剧情与人物动机。',
      deliverable: { key: 'outline', origin: 'model_inference' },
    };
    const saved = await run.invoke('document.submit_draft', args);
    expect(saved, JSON.stringify(saved)).toMatchObject({
      status: 'draft_saved',
      inlinePlan: { status: 'task_plan_saved' },
      deliveryState: { saved: true, contentReview: 'pending' },
    });
    const replay = await run.invoke('document.submit_draft', args);
    expect(replay).toMatchObject({ documentId: saved.documentId, execution: { replayed: true } });
    const state = await run.invoke('conversation.task.checkpoint', { operation: 'state' });
    expect(state.pendingActions).toEqual([]);
    expect(
      f.project.access(false, (db, p) =>
        taskPlanScope(db, p.id, run.prepared.stream.generationId, run.agent.taskId),
      ),
    ).toEqual([expect.objectContaining({ key: 'outline', targetIds: [saved.documentId] })]);
    const before = f.project.access(false, (db) =>
      db.prepare('SELECT count(*) n FROM agent_execution_outputs').get(),
    );
    const failed = await run.invoke('document.submit_draft', {
      ...args,
      resourceId: 'workspace:missing',
      deliverable: { key: 'rollback' },
    });
    expect(failed.status).not.toBe('draft_saved');
    expect(
      f.project.access(false, (db) =>
        db.prepare('SELECT count(*) n FROM agent_execution_outputs').get(),
      ),
    ).toEqual(before);
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'saves a chapter once, directly reads its current draft and preserves real CAS conflicts (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存第一章，并核对当前草稿。');
    const args = {
      resourceId: 'workspace:novel',
      action: 'create_chapter',
      title: '第一章',
      contentMarkdown: '甲收到信件，决定在清晨离开。',
      deliverable: { key: 'chapter' },
    };
    const saved = await run.invoke('novel.chapter.write_draft', args);
    expect(saved, JSON.stringify(saved)).toMatchObject({ status: 'draft_saved' });
    expect(typeof saved.chapterId).toBe('string');
    expect(await run.invoke('novel.chapter.write_draft', args)).toMatchObject({
      documentId: saved.documentId,
      execution: { replayed: true },
    });
    const read = await run.invoke('library.read', {
      artifact: { documentId: saved.documentId, expectedVersionId: saved.documentVersionId },
      readMode: 'source',
    });
    expect(read).toMatchObject({
      status: 'read',
      content: args.contentMarkdown,
      candidateNote: '未审核候选资料，不能当作已发布权威',
    });
    const row = f.project.access(false, (db) =>
      db.prepare('SELECT row_version FROM novel_chapters WHERE id=?').get(saved.chapterId),
    ) as {
      row_version: number;
    };
    const update = {
      resourceId: saved.resourceId,
      action: 'rewrite_chapter',
      chapterId: saved.chapterId,
      title: args.title,
      contentMarkdown: '完整新候选，不能因版本冲突覆盖用户修改。',
      expectedChapterRowVersion: row.row_version - 1,
      expectedDocumentRowVersion: saved.documentRowVersion,
      baseVersionId: saved.documentVersionId,
    };
    const stale = await run.invoke('novel.chapter.write_draft', update);
    expect(JSON.stringify(stale)).toContain('CHAPTER_CAS_CONFLICT');
    expect(f.workflow.getDocument(String(saved.documentId)).currentVersion?.contentMarkdown).toBe(
      args.contentMarkdown,
    );
    const corrected = await run.invoke('novel.chapter.write_draft', {
      ...update,
      expectedChapterRowVersion: row.row_version,
    });
    expect(JSON.stringify(corrected)).toContain('active writing task');
    expect(f.workflow.getDocument(String(saved.documentId)).currentVersion?.contentMarkdown).toBe(
      args.contentMarkdown,
    );
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'keeps one structure output identity when Runtime selects staged creation (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('创建一个场次和镜头。');
    const plan = await run.invoke('conversation.task.checkpoint', {
      operation: 'plan',
      deliverables: [{ key: 'episode', toolName: 'scene.submit_structure', minimumCount: 1 }],
    });
    const outputId = (
      plan.outputBindings as Array<{
        outputId: string;
      }>
    )[0]!.outputId;
    const args = {
      operation: 'begin',
      resourceId: 'workspace:shots',
      outputId,
      episodeTitle: '本集',
      sceneShotCounts: [1],
    };
    const begin = await run.invoke('scene.structure.stage', args);
    expect(begin.stageId, JSON.stringify(begin)).toEqual(expect.any(String));
    expect(await run.invoke('scene.structure.stage', args)).toMatchObject({
      stageId: begin.stageId,
      execution: { replayed: true },
    });
    const revised = await run.invoke('conversation.task.checkpoint', {
      operation: 'plan',
      deliverables: [
        {
          key: 'episode',
          toolName: 'scene.structure.stage',
          minimumCount: 1,
          revisionReason: 'Runtime选择分段工具，仍是同一场次交付。',
        },
      ],
    });
    expect(
      (
        revised.outputBindings as Array<{
          outputId: string;
        }>
      )[0]?.outputId,
      JSON.stringify(revised),
    ).toBe(outputId);
    expect(
      f.project.access(false, (db) =>
        db.prepare('SELECT COUNT(*) n FROM scene_structure_stages').get(),
      ),
    ).toEqual({ n: 1 });
    const conflict = await run.invoke('scene.submit_structure', {
      resourceId: 'workspace:shots',
      outputId,
      resolution: 'resolved',
      episodeTitle: '本集',
      scenes: [
        {
          title: '不得重复创建',
          ...authoring(),
          shots: [{ title: '镜头', ...authoring(true) }],
        },
      ],
    });
    expect(conflict).toMatchObject({
      status: 'rejected',
      error: { code: 'AGENT_BUSINESS_OPERATION_CONFLICT' },
      savedResult: { stageId: begin.stageId },
    });
    expect(f.content.listScenes()).toHaveLength(0);
  },
);
it.each(
  (['openai-responses', 'openai-chat-completions'] as const).flatMap((protocol) =>
    [false, true].map((planBeforeSave) => ({ protocol, planBeforeSave })),
  ),
)(
  'allocates an implicit analysis before another output is created ($protocol, planBeforeSave=$planBeforeSave)',
  async ({ protocol, planBeforeSave }) => {
    const f = await setup(protocol);
    const run = f.prepare('先保存分析，再保存分镜与提示词；恢复不得重复创建。');
    const analysisArgs = {
      resourceId: 'workspace:documents',
      documentKind: 'plan',
      title: '剧情分析',
      contentMarkdown: '# 分析\n蓝衣，保持原对白。',
    };
    const analysis = planBeforeSave
      ? undefined
      : await run.invoke('document.submit_draft', analysisArgs);
    if (analysis) expect(analysis.status).toBe('draft_saved');
    const plan = await run.invoke('conversation.task.checkpoint', {
      operation: 'plan',
      deliverables: [
        {
          key: 'analysis',
          toolName: 'document.submit_draft',
          documentKind: 'plan',
          minimumCount: 1,
          ...(analysis ? { targetIds: [analysis.documentId] } : {}),
        },
        {
          key: 'remaining-plans',
          toolName: 'document.submit_draft',
          documentKind: 'plan',
          minimumCount: 2,
        },
      ],
    });
    const savedAnalysis = analysis ?? (await run.invoke('document.submit_draft', analysisArgs));
    expect(savedAnalysis.status).toBe('draft_saved');
    const bindings = plan.outputBindings as Array<{
      key: string;
      outputId: string;
    }>;
    if (analysis) expect(bindings.find((b) => b.key === 'analysis')).toBeUndefined();
    // The completed output remains internally bound for replay compatibility;
    // it must not be offered as new creation work to the model.
    const analysisOutput = f.project.access(
      false,
      (db) =>
        (
          db
            .prepare('SELECT id FROM agent_execution_outputs WHERE task_id=? AND plan_key=?')
            .get(run.agent.taskId, 'analysis') as {
            id: string;
          }
        ).id,
    );
    const remainingOutput = bindings.find((b) => b.key === 'remaining-plans')!.outputId;
    const restored = new AgentContextManager(
      f.project,
      run.prepared.stream,
      run.agent.taskId,
      '继续',
    );
    expect(
      restored.prepare(f.generations.runtime(run.prepared.stream), { messages: [] }).request.prompt,
    ).toContain(remainingOutput);
    const storyboardArgs = {
      ...analysisArgs,
      title: '分镜',
      contentMarkdown: '# 分镜\n6镜，共60秒。',
      outputId: remainingOutput,
      outputIndex: 0,
    };
    const storyboard = await run.invoke('document.submit_draft', storyboardArgs);
    expect(storyboard, JSON.stringify(storyboard)).toMatchObject({ status: 'draft_saved' });
    expect(storyboard.documentId).not.toBe(savedAnalysis.documentId);
    expect(await run.invoke('document.submit_draft', storyboardArgs)).toMatchObject({
      documentId: storyboard.documentId,
      execution: { replayed: true },
    });
    expect(
      await run.invoke('document.submit_draft', { ...analysisArgs, outputId: analysisOutput }),
    ).toMatchObject({ documentId: savedAnalysis.documentId, execution: { replayed: true } });
    const docs = f.project.access(false, (db) =>
      db.prepare("SELECT id, title FROM documents WHERE kind='plan' ORDER BY rowid").all(),
    );
    expect(docs, JSON.stringify(docs)).toHaveLength(2);
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'creates the first scene in an empty short-drama workspace without an episode resource (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存第一场和镜头。');
    const context = await run.invoke('project.get_context', {});
    expect(
      (
        context.structure as {
          domains: {
            shortDrama: unknown;
          };
        }
      ).domains.shortDrama,
    ).toEqual({
      enabled: false,
      sceneCount: 0,
      shotCount: 0,
    });
    const submit = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.submit_structure')!;
    const args = {
      resourceId: 'workspace:shots',
      resolution: 'resolved',
      episodeTitle: '第一集',
      scenes: [
        {
          title: '第一场',
          ...authoring(),
          shots: [{ title: '第一镜', ...authoring(true) }],
        },
      ],
    };
    expect(() => {
      validateToolArguments(submit, {
        type: 'toolCall',
        id: 'invalid-episode',
        name: submit.name,
        arguments: { ...args, resourceId: 'shortDrama:episode:1' },
      });
    }).toThrow();
    const saved = await run.invoke('scene.submit_structure', args);
    expect(saved.status, JSON.stringify(saved)).toBe('scene_structure_saved');
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(f.content.listScenes()[0]!.id)).toHaveLength(1);
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'reuses an identical saved draft across new call IDs and persists only one artifact (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存角色设定，恢复后不重复创建。');
    const draft = {
      resourceId: 'workspace:characters',
      documentKind: 'character',
      title: '沈砚舟｜完整角色设定板提示词',
      contentMarkdown: '# 沈砚舟\n同一人物的完整角色设定板。',
      bindings: { schemaVersion: 1 as const },
    };
    const first = await run.invoke('document.submit_draft', draft);
    expect(first.status).toBe('draft_saved');
    const replay = await run.invoke('document.submit_draft', {
      ...draft,
      bindings: { schemaVersion: 1 as const },
    });
    expect(replay).toMatchObject({
      ...first,
      execution: { ...(first.execution as object), replayed: true },
    });
    f.project.close();
    f.project.open(join(f.directory, 'project'));
    f.project.access(false, (db) => {
      expect(db.prepare('SELECT COUNT(*) n FROM documents WHERE title=?').get(draft.title)).toEqual(
        {
          n: 1,
        },
      );
      expect(
        db
          .prepare('SELECT COUNT(*) n FROM document_versions WHERE document_id=?')
          .get(first.documentId),
      ).toEqual({ n: 1 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM agent_tasks WHERE json_extract(request_snapshot_json, '$.parentTaskId')=?",
          )
          .get(run.agent.taskId),
      ).toEqual({ n: 1 });
      const results = new AgentContextStore(db)
        .resultRefs(run.prepared.stream.projectId, run.agent.taskId)
        .filter((result) => result.toolName === 'document.submit_draft');
      expect(results).toHaveLength(2);
    });
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'requires CAS when a replay adds metadata and retains the complete rejected submission (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存角色，并登记来源；不新建相同正文的副本。');
    const draft = {
      resourceId: 'workspace:characters',
      documentKind: 'character',
      title: '沈砚舟',
      contentMarkdown: '# 沈砚舟\n完整角色正文。',
    };
    const first = await run.invoke('document.submit_draft', draft);
    const candidate = {
      ...draft,
      bindings: { schemaVersion: 1 as const },
    };
    const conflict = await run.invoke('document.submit_draft', candidate);
    expect(JSON.stringify(conflict)).toContain('AGENT_BUSINESS_OPERATION_CONFLICT');
    for (const value of [
      first.documentId,
      first.documentVersionId,
      `document:${String(first.documentId)}`,
    ])
      expect(JSON.stringify(conflict)).toContain(String(value));
    expect(
      f.workflow.getDocument(String(first.documentId)).currentVersion?.bindings,
    ).toBeUndefined();
    f.project.access(false, (db) => {
      const rejected = new AgentContextStore(db)
        .resultRefs(run.prepared.stream.projectId, run.agent.taskId)
        .filter((result) => result.toolName === 'document.submit_draft')
        .at(-1)!;
      expect(
        new AgentContextStore(db).result(
          run.prepared.stream.projectId,
          run.agent.taskId,
          rejected.resultId,
        )?.arguments,
      ).toEqual(candidate);
      expect(db.prepare('SELECT COUNT(*) n FROM documents WHERE title=?').get(draft.title)).toEqual(
        { n: 1 },
      );
    });
    const update = {
      ...candidate,
      resourceId: first.resourceId,
      documentId: first.documentId,
      expectedDocumentRowVersion: first.documentRowVersion,
      baseVersionId: first.documentVersionId,
    };
    const updated = await run.invoke('document.submit_draft', update);
    expect(updated).toMatchObject({ status: 'draft_saved', documentId: first.documentId });
    expect(updated.documentVersionId).not.toBe(first.documentVersionId);
    expect(f.workflow.getDocument(String(first.documentId)).currentVersion?.bindings).toEqual(
      candidate.bindings,
    );
    const replay = await run.invoke('document.submit_draft', candidate);
    expect(replay).toMatchObject({
      status: 'rejected',
      savedResult: { documentId: first.documentId },
    });
    const stale = await run.invoke('document.submit_draft', update);
    expect(stale).toMatchObject({ status: 'draft_saved', execution: { replayed: true } });
    f.project.access(false, (db) => {
      expect(db.prepare('SELECT COUNT(*) n FROM documents WHERE title=?').get(draft.title)).toEqual(
        { n: 1 },
      );
      expect(
        db
          .prepare('SELECT COUNT(*) n FROM document_versions WHERE document_id=?')
          .get(first.documentId),
      ).toEqual({ n: 2 });
    });
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'keeps draft validation and distinct content, titles and parent tasks independent (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存两个人物。');
    const draft = {
      resourceId: 'workspace:characters',
      documentKind: 'character',
      title: '人物甲',
      contentMarkdown: '# 角色\n蓝衣。',
    };
    const first = await run.invoke('document.submit_draft', draft);
    const invalid = await run.invoke('document.submit_draft', {
      ...draft,
      bindings: { schemaVersion: 1 as const },
    });
    expect(JSON.stringify(invalid)).toContain('AGENT_BUSINESS_OPERATION_CONFLICT');
    const otherBody = await run.invoke('document.submit_draft', {
      ...draft,
      contentMarkdown: '# 角色\n红衣。',
    });
    const otherTitle = await run.invoke('document.submit_draft', { ...draft, title: '人物乙' });
    const other = f.prepare('用户另一次任务明确保存另一份相同资料。');
    const otherTask = await other.invoke('document.submit_draft', draft);
    for (const result of [otherBody, otherTitle])
      expect(result).toMatchObject({ status: 'rejected', execution: { effect: 'conflict' } });
    expect(otherTask.status).toBe('draft_saved');
    expect(otherTask.documentId).not.toBe(first.documentId);
    const slot = f.project.access(true, (db, p) =>
      new AgentExecutionStore(db).registerOutput(
        p.id,
        run.agent.taskId,
        'characters',
        'document.submit_draft',
        2,
      ),
    );
    const independent = await run.invoke('document.submit_draft', {
      ...draft,
      outputId: slot,
      outputIndex: 1,
      title: '人物乙',
    });
    expect(independent.status).toBe('draft_saved');
    expect(independent.documentId).not.toBe(first.documentId);
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'delivers automatic completion repair instructions to the Native request through ContextManager (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const prompt = '保存一份角色草稿，保留蓝衣设定。';
    const run = f.prepare(prompt);
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `repair-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `repair-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      if (index === 0) return tool('tools.load', { names: ['document.submit_draft'] });
      if (index === 1)
        return tool('conversation.task.checkpoint', {
          operation: 'plan',
          deliverables: [
            {
              key: 'character',
              toolName: 'document.submit_draft',
              documentKind: 'character',
              minimumCount: 1,
            },
          ],
        });
      if (index === 3) {
        const state = stageEnvelope(params) as unknown as {
          executionDirective: {
            source: string;
            instruction: string;
          };
        };
        expect(state.executionDirective).toMatchObject({ source: 'runtime-continuation' });
        expect(state.executionDirective.instruction).toContain('character');
        expect(state.executionDirective.instruction).toContain('TASK_DELIVERABLES_PENDING');
        expect(params.prompt).toContain(prompt);
        return tool('document.submit_draft', {
          resourceId: 'workspace:characters',
          documentKind: 'character',
          title: '林澈角色',
          contentMarkdown: '# 林澈\n蓝衣青年。',
        });
      }
      if (index > 3) {
        expect(params.contextTurns?.at(-1)?.outputs[0]?.output).toContain('draft_saved');
        expect(stageEnvelope(params)).not.toHaveProperty('executionDirective');
      }
      return [
        {
          ...common,
          type: 'text_delta',
          delta: index === 2 ? '草稿已经完成。' : '角色草稿已保存。',
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `repair-${index}`,
          finishReason: 'stop',
        },
      ];
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      createContextManager: (identity, taskId, text) =>
        new AgentContextManager(f.project, identity, taskId, text),
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
      prompt,
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const generation = f.generations.get(run.prepared.stream.generationId);
    expect(generation.status, generation.error).toBe('complete');
    expect(requests).toHaveLength(5);
    expect(f.workflow.getTask({ taskId: run.agent.taskId }).documents).toHaveLength(1);
  },
);
it('keeps failed delivery checks visibly unfinished across history clearing and restart', async () => {
  const f = await setup();
  const prompt = '保存角色草稿，原文对白不得丢失。';
  const run = f.prepare(prompt);
  const manager = new AgentContextManager(f.project, run.prepared.stream, run.agent.taskId, prompt);
  const pending = {
    key: 'reference',
    toolName: 'document.submit_draft',
    documentKind: 'plan',
    minimumCount: 4,
    requiredTexts: ['原文对白。'],
  };
  await run.invoke('conversation.task.checkpoint', { operation: 'plan', deliverables: [pending] });
  const request = () => {
    const restored = new AgentContextManager(
      f.project,
      run.prepared.stream,
      run.agent.taskId,
      prompt,
    );
    return restored.prepare(f.generations.runtime(run.prepared.stream), { messages: [] }).request;
  };
  manager.observe({ messages: [] });
  expect(manager.taskState.recoveryState?.deliverablesVerified).toBe(false);
  expect(request().prompt).toContain('"deliverablesVerified":false');
  expect(request().prompt).toContain('Task is unfinished');
  await run.invoke('conversation.task.checkpoint', {
    operation: 'plan',
    deliverables: [
      {
        ...pending,
        minimumCount: 1,
        documentKind: 'character',
        revisionReason: '原任务只要一份角色草稿，四份plan是模型自己的错误估计。',
      },
    ],
  });
  expect(request().prompt).toContain('"deliverablesVerified":false');
  await run.invoke('document.submit_draft', {
    resourceId: 'workspace:characters',
    title: '角色参考',
    documentKind: 'character',
    contentMarkdown: '# 角色参考\n原文对白。',
  });
  const completed = request();
  expect(completed.prompt).toContain('"deliverablesVerified":true');
  expect(completed.prompt).toContain('"pendingSteps":[]');
  expect(completed.prompt).not.toContain('Task is unfinished');
});
it('externalizes a large task-state page and restores every requirement through authorized range reads', async () => {
  const f = await setup();
  const prompt = '完整原始要求，保留所有约束。'.repeat(2400);
  const run = f.prepare(prompt);
  const manager = new AgentContextManager(f.project, run.prepared.stream, run.agent.taskId, prompt);
  manager.recordUserRequirement('更早确认的重要决定。'.repeat(1000), 'earlier');
  const page = await run.invoke('conversation.task.checkpoint', { operation: 'state' });
  expect(page).toMatchObject({ status: 'task_state_read', externalized: true });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
  const read = page.read as Record<string, unknown>;
  expect(read).toMatchObject({
    tool: 'conversation.task.checkpoint',
    operation: 'result',
    resultId: page.resultId,
    expectedHash: page.contentHash,
  });
  let text = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const part = await run.invoke('conversation.task.checkpoint', {
      operation: 'result',
      resultId: page.resultId,
      expectedHash: page.contentHash,
      resultOffset: offset,
      resultLimit: 4096,
    });
    expect(part.status).toBe('task_result_read');
    expect(typeof part.content).toBe('string');
    text += part.content as string;
    offset = part.nextOffset as number | null;
  }
  const complete = JSON.parse(text) as {
    taskGoal: string;
    records: unknown[];
  };
  expect(complete.taskGoal).toBe(prompt);
  expect(complete.records).toContainEqual(
    expect.objectContaining({
      kind: 'userRequirement',
      id: 'original',
      text: prompt,
      source: 'current-user-request',
    }),
  );
  expect(complete.records).toContainEqual(
    expect.objectContaining({
      kind: 'userRequirement',
      id: 'earlier',
      text: '更早确认的重要决定。'.repeat(1000),
      source: 'user-supplement',
    }),
  );
  const restored = new AgentContextManager(
    f.project,
    run.prepared.stream,
    run.agent.taskId,
    prompt,
  );
  expect(restored.taskState.userRequirements).toEqual(manager.taskState.userRequirements);
  // A new task can inspect an earlier task in this conversation, and the receipt
  // must keep that scope when its snapshot is read through the same authorized tool.
  const followUp = f.prepare('核对先前任务的完整要求，不重新执行。');
  const archived = await followUp.invoke('conversation.task.checkpoint', {
    operation: 'state',
    targetGenerationId: run.prepared.stream.generationId,
  });
  expect(archived.read).toMatchObject({
    targetGenerationId: run.prepared.stream.generationId,
    resultId: archived.resultId,
  });
  const readArgs = { ...(archived.read as Record<string, unknown>) };
  delete readArgs.tool;
  const part = await followUp.invoke('conversation.task.checkpoint', readArgs);
  expect(part).toMatchObject({
    status: 'task_result_read',
    contentHash: archived.contentHash,
    offset: 0,
  });
  expect(part.content).toContain('"taskGoal":');
});
it('bounds serialized result ranges and exposes each page directly to the model', async () => {
  const f = await setup();
  const run = f.prepare('读取本任务保存的完整结果。');
  const content = '\u0000'.repeat(18000) + '完整结尾😀';
  const result = f.project.access(true, (db, p) =>
    new AgentContextStore(db).putResult(
      p.id,
      run.agent.taskId,
      'range-fixture',
      'fixture',
      content,
    ),
  );
  let restored = '',
    offset: number | null = 0;
  while (offset !== null) {
    const page = await run.invoke('conversation.task.checkpoint', {
      operation: 'result',
      resultId: result.id,
      expectedHash: result.contentHash,
      resultOffset: offset,
      resultLimit: 16384,
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024);
    expect(page.status).toBe('task_result_read');
    const receipt = modelResultReceipt({
      ...result,
      toolName: 'conversation.task.checkpoint',
      content: JSON.stringify(page),
    });
    expect(JSON.parse(receipt)).toEqual(page);
    restored += page.content as string;
    expect(page.endOffset).toBeGreaterThan(offset);
    offset = page.nextOffset as number | null;
  }
  expect(restored).toBe(content);
});
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
      ...setupInstruction,
      bindings: {
        schemaVersion: 1,
        sceneDocumentIds: [f.setting.id],
        characterDocumentIds: [],
      },
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
    shots: [{ title: '镜头', ...authoring(true) }],
  });
  expect(JSON.stringify(result)).toContain('STAGE_VERSION_REQUIRED');
  expect(f.content.listScenes()).toHaveLength(0);
});
it('paginates every resumable scene stage instead of truncating the list at twenty', async () => {
  const f = await setup();
  const run = f.prepare('生成大型场次计划');
  const outputId = f.project.access(true, (db, p) =>
    new AgentExecutionStore(db).registerOutput(
      p.id,
      run.agent.taskId,
      'pages',
      'scene.structure.stage',
      3,
    ),
  );
  for (let page = 0; page < 3; page++)
    await run.invoke('scene.structure.stage', {
      operation: 'begin',
      outputId,
      outputIndex: page,
      resourceId: 'workspace:shots',
      executionKey: `listed-page-${page + 1}`,
      episodeTitle: `页面 ${page + 1}`,
      sceneShotCounts: [1],
    });
  const first = await run.invoke('scene.structure.stage', {
    operation: 'get',
    resourceId: 'workspace:shots',
    pageSize: 1,
  });
  const second = await run.invoke('scene.structure.stage', {
    operation: 'get',
    resourceId: 'workspace:shots',
    pageSize: 1,
    pageOffset: first.nextPageOffset,
  });
  const third = await run.invoke('scene.structure.stage', {
    operation: 'get',
    resourceId: 'workspace:shots',
    pageSize: 1,
    pageOffset: second.nextPageOffset,
  });
  expect(first).toMatchObject({
    status: 'scene_structure_stages',
    totalStages: 3,
    nextPageOffset: 1,
  });
  expect(second).toMatchObject({
    status: 'scene_structure_stages',
    totalStages: 3,
    nextPageOffset: 2,
  });
  expect(third).toMatchObject({ status: 'scene_structure_stages', totalStages: 3 });
  expect(third.nextPageOffset).toBeUndefined();
  expect(
    new Set(
      [first, second, third].flatMap((page) =>
        (
          page.stages as Array<{
            stageId: string;
          }>
        ).map((stage) => stage.stageId),
      ),
    ).size,
  ).toBe(3);
  const firstStage = (
    first.stages as Array<{
      stageId: string;
    }>
  )[0]!;
  const secondStage = (
    second.stages as Array<{
      stageId: string;
    }>
  )[0]!;
  let state = await run.invoke('scene.structure.stage', {
    operation: 'get',
    resourceId: 'workspace:shots',
    stageId: firstStage.stageId,
  });
  state = await run.invoke('scene.structure.stage', {
    operation: 'put_scene',
    resourceId: 'workspace:shots',
    stageId: firstStage.stageId,
    expectedRowVersion: state.rowVersion,
    sceneIndex: 0,
    scene: {
      title: '已完成页场次',
      ...authoring(),
      bindings: {
        schemaVersion: 1,
        sceneDocumentIds: [f.setting.id],
        characterDocumentIds: [],
      },
    },
  });
  state = await run.invoke('scene.structure.stage', {
    operation: 'put_shots',
    resourceId: 'workspace:shots',
    stageId: firstStage.stageId,
    expectedRowVersion: state.rowVersion,
    sceneIndex: 0,
    shotOffset: 0,
    shots: [{ title: '已完成页镜头', ...authoring(true) }],
  });
  expect(state).toMatchObject({ status: 'scene_structure_saved', complete: true });
  const secondAfterCompletion = await run.invoke('scene.structure.stage', {
    operation: 'get',
    resourceId: 'workspace:shots',
    pageSize: 1,
    pageOffset: first.nextPageOffset,
  });
  expect(
    (
      secondAfterCompletion.stages as Array<{
        stageId: string;
      }>
    )[0]?.stageId,
  ).toBe(secondStage.stageId);
  expect(
    (
      secondAfterCompletion.stages as Array<{
        complete: boolean;
      }>
    )[0]?.complete,
  ).toBe(false);
});
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'continues paged structure lookup with real CAS through Native/Pi without replaying the user request (%s)',
  async (protocol) => {
    const f = await setup(protocol, 64000);
    const scene = f.content.saveScene({
      title: '目标场次',
      ...authoring(),
    });
    const shots = Array.from({ length: 25 }, (_, index) =>
      f.content.saveShot({
        sceneId: scene.id,
        title: `目标镜头${index}`,
        ...authoring(true),
      }),
    );
    const prompt =
      '【本会话要求约束】\n' +
      '保留所有用户要求。'.repeat(600) +
      '\n【用户本次请求】\n读取目标场次的全部镜头，仅核对，不修改。';
    const run = f.prepare(prompt);
    const retrieved: string[] = [];
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      let args: Record<string, unknown> = { kind: 'shot', parentId: `scene:${scene.id}`, limit: 7 };
      if (index > 0) {
        const map = lastOutput(params).resourceMap as {
          resources: Array<{
            id: string;
            rowVersion: number;
            locator: {
              sceneId: string;
            };
          }>;
          nextOffset?: number;
          revision: string;
        };
        for (const resource of map.resources) {
          expect(resource.locator.sceneId).toBe(scene.id);
          expect(resource.rowVersion).toBeTypeOf('number');
          retrieved.push(resource.id);
        }
        if (map.nextOffset === undefined)
          return [
            { ...common, type: 'text_delta', delta: '已核对全部镜头，未修改。' },
            {
              ...common,
              type: 'complete',
              providerResponseId: 'paged-final',
              finishReason: 'stop',
            },
          ];
        args = { ...args, offset: map.nextOffset, expectedRevision: map.revision };
      }
      return [
        {
          ...common,
          type: 'tool_call_end',
          call: {
            id: `page-${index}`,
            name: 'project.structure.get',
            argumentsJson: JSON.stringify(args),
          },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `page-response-${index}`,
          finishReason: 'tool_calls',
        },
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
      prompt,
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status, result.error).toBe('complete');
    expect(retrieved).toEqual(shots.map((shot) => `shot:${shot.id}`));
    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.prompt === prompt)).toBe(true);
    expect(f.content.listShots(scene.id).map((shot) => shot.id)).toEqual(
      shots.map((shot) => shot.id),
    );
  },
);
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
    // This regression specifically exercises the legacy budget fallback.
    f.generations.configureAgentTools(
      run.prepared.stream,
      run.agent.tools.filter((tool) => tool.name !== 'conversation.task.checkpoint'),
    );
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
        const result = lastOutput(params) as {
          sources: Array<{
            sourceHandle: string;
          }>;
        };
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
      createContextManager: (identity, taskId, prompt) =>
        new AgentContextManager(f.project, identity, taskId, prompt),
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
    const shortened = requests.find((params) => JSON.stringify(params).includes('externalized'));
    expect(shortened).toBeDefined();
    expect(JSON.stringify(shortened)).toContain(large.id);
    expect(JSON.stringify(shortened)).toContain('draft');
    const stored = f.project.access(false, (db) =>
      new AgentContextStore(db).resultForCall(
        run.prepared.stream.projectId,
        run.agent.taskId,
        'budget-1',
      ),
    );
    expect(stored?.content).toContain(body);
    expect(JSON.stringify(shortened)).not.toContain(body);
    expect(f.content.getDocument(large.id).currentVersion?.contentMarkdown).toBe(body);
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'stops an unchanged library read loop before another Native request and preserves its SQLite audit (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const document = f.content.saveDocument({
      kind: 'note',
      title: '重复读取证据',
      contentMarkdown: '完整且不截断的资料。'.repeat(350),
    });
    const run = f.prepare('读取重复读取证据，完成核查');
    let handle: string | undefined;
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      if (index === 1)
        handle = (
          lastOutput(params) as {
            sources: Array<{
              sourceHandle: string;
            }>;
          }
        ).sources[0]!.sourceHandle;
      // A broken model would keep reading forever; the fifth send must be the last.
      if (index > 4) throw new Error('Read loop reached another Provider request');
      const name = index === 0 ? 'library.search' : 'library.read';
      return [
        {
          ...common,
          type: 'tool_call_end',
          call: {
            id: `repeat-${index}`,
            name,
            argumentsJson: JSON.stringify(
              index === 0
                ? { query: '重复读取证据', sourceTypes: ['document'], limit: 1 }
                : { sourceHandle: handle, readMode: 'source', maxChars: 20000 },
            ),
          },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `repeat-response-${index}`,
          finishReason: 'tool_calls',
        },
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
      prompt: '核查资料',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('AGENT_REPEATED_READ_STALLED');
    expect(requests).toHaveLength(5);
    expect(f.content.getDocument(document.id).currentVersion?.contentMarkdown).toBe(
      document.currentVersion!.contentMarkdown,
    );
    expect(f.workflow.getTask({ taskId: run.agent.taskId }).librarySources).toHaveLength(1);
    expect(
      f.project.access(false, (database) =>
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_tool_calls WHERE task_id=? AND tool_name='library.read' AND status='succeeded'",
          )
          .get(run.agent.taskId),
      ),
    ).toEqual({ count: 4 });
  },
);
it('rejects retired creative fields in both tool schema and direct Worker parsing', () => {
  const tool = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'scene.submit_structure')!;
  const base = {
    resourceId: 'workspace:shots',
    resolution: 'resolved',
    episodeTitle: '测试',
    scenes: [
      {
        title: '场次',
        ...authoring(),
        shots: [{ title: '镜头', ...authoring(true) }],
        bindings: {
          schemaVersion: 1,
          sceneDocumentIds: ['setting'],
          characterDocumentIds: [],
        },
      },
    ],
  };
  for (const field of ['videoPrompt', 'camera']) {
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
  'keeps saved progress across reads, no-ops, loaders and repair beyond 24 requests (%s, stop=%s)',
  async (protocol, finalStop) => {
    const f = await setup(protocol);
    const scene = f.content.saveScene({ title: '已保存场次', sceneDocumentId: f.setting.id });
    const shots = Array.from({ length: 4 }, (_, i) =>
      f.content.saveShot({
        sceneId: scene.id,
        title: `镜头${i}`,
        prompt: '原文',
      }),
    );
    const discoveryShots = Array.from({ length: 16 }, (_, i) =>
      f.content.saveShot({ sceneId: scene.id, title: `待核对镜头${i}` }),
    );
    const targets = [
      { kind: 'scene' as const, id: scene.id },
      ...shots.map((shot) => ({ kind: 'shot' as const, id: shot.id })),
    ];
    const production = new ProductionService(f.project);
    const operations = () => ({
      shots: f.content
        .listShots(scene.id)
        .filter((shot) => shots.some((target) => target.id === shot.id))
        .map((shot) => ({
          shotId: shot.id,
          expectedRowVersion: shot.rowVersion,
          ...promptPatch(authoring(true)),
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
      if (index === 21)
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
      if (index === 23) expect(lastOutput(params)).toMatchObject({ status: 'shot_prompts_saved' });
      if (index === 24 && !finalStop)
        return [
          {
            ...common,
            type: 'failed',
            error: {
              code: 'PROVIDER_FAILED',
              retryable: false,
              message: 'Provider failed after 25 requests.',
            },
          },
        ];
      if (index === 24) {
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
      if (index > 24) throw new Error('Must not send request 26');
      if (index === 23)
        return tool('tools.load', { names: ['production.read', 'scene.update_shot_prompts'] });
      return tool('production.read', {
        target: { kind: 'shot', id: discoveryShots[index - 5]!.id },
        view: 'authoring',
      });
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
    if (!finalStop) expect(result.error).toContain('Provider failed after 25 requests');
    expect(requests).toHaveLength(25);
    expect(result.assistantMessage.attempt?.usage).toMatchObject({
      inputTokens: 55000,
      cachedInputTokens: 3000,
      outputTokens: 250,
      totalTokens: 55250,
    });
    // New targets keep the task moving beyond 24 requests before output repair;
    // their policies and frozen context must remain byte-identical.
    for (const request of requests.slice(0, 22))
      expect(request.systemInstruction).toBe(requests[0]!.systemInstruction);
    expect(requests[0]!.systemInstruction).not.toContain('# Agent document');
    expect(requests[1]!.continuation!.outputs[0]!.output).toContain(
      'For a single existing shot, load production.read',
    );
    expect(requests[0]!.tools!.some((tool) => tool.name === 'scene.update_shot_prompts')).toBe(
      false,
    );
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(scene.id)).toHaveLength(20);
    f.project.access(false, (db) => {
      // An unchanged retry is not a second committed business effect.
      expect(db.prepare('SELECT COUNT(*) n FROM agent_write_receipts').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get()).toEqual({ n: 0 });
    });
    f.project.close();
    f.project.open(join(f.directory, 'project'));
    for (const shot of shots) {
      expect(production.read({ kind: 'shot', id: shot.id })).toMatchObject({
        rowVersion: shot.rowVersion + 1,
        ...authoring(),
        timing: shot.timing,
        issues: [],
      });
    }
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'stops a provider repeating the same tool load without business writes (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('创建角色资料');
    const { bridge, requests } = scriptedBridge((params, index) => {
      if (index >= 4) throw new Error('Must stop before sending a fifth empty preparation turn.');
      return [
        {
          type: 'tool_call_end',
          projectSessionId: params.projectSessionId,
          call: {
            id: `load-${index}`,
            name: 'tools.load',
            argumentsJson: JSON.stringify({ names: ['document.submit_draft'] }),
          },
        },
        {
          type: 'complete',
          projectSessionId: params.projectSessionId,
          providerResponseId: `loop-${index}`,
          finishReason: 'tool_calls',
        },
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
      prompt: '创建角色资料',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    expect(requests).toHaveLength(4);
    expect(f.generations.get(run.prepared.stream.generationId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('AGENT_PREPARATION_STALLED') as unknown,
    });
    expect(f.workflow.getTask({ taskId: run.agent.taskId }).task.status).toBe('failed');
    f.project.access(false, (db) => {
      expect(db.prepare('SELECT COUNT(*) n FROM agent_write_receipts').get()).toEqual({ n: 0 });
    });
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
          ...authoring(),
          shots: [{ title: '镜头', ...authoring(true) }],
          bindings: {
            schemaVersion: 1,
            sceneDocumentIds: ['missing'],
            characterDocumentIds: [],
          },
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
  ).toThrow('原始请求仍未完成');
  expect(f.content.listScenes()).toHaveLength(0);
  const repaired = await run.invoke('scene.submit_structure', {
    resourceId: 'workspace:shots',
    resolution: 'resolved',
    episodeTitle: '修正',
    scenes: [
      {
        title: '场次',
        ...authoring(),
        shots: [{ title: '镜头', ...authoring(true) }],
        bindings: {
          schemaVersion: 1,
          sceneDocumentIds: [f.setting.id],
          characterDocumentIds: [],
        },
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
    if (kind === 'schema') {
      f.loop.recordValidationFailure(
        run.prepared.stream,
        'scene.submit_structure',
        100,
        'stillFrame is missing',
      );
      expect(
        f.project.access(false, (db) =>
          db
            .prepare(
              `SELECT usage.tool_call_count, tasks.quota_state
             FROM agent_tasks tasks JOIN agent_task_usage_counters usage ON usage.task_id=tasks.id
             WHERE tasks.id=?`,
            )
            .get(run.agent.taskId),
        ),
      ).toEqual({ tool_call_count: 0, quota_state: 'active' });
    } else
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
    ).toThrow('原始请求仍未完成');
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
  'retries the same task after an unresolved %s/%s write and stops only when there is no progress',
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
              ...authoring(),
              shots: [{ title: '镜头', ...shot }],
              bindings: {
                schemaVersion: 1,
                sceneDocumentIds: [kind === 'business' ? 'missing' : f.setting.id],
                characterDocumentIds: [],
              },
            },
          ],
        });
      }
      expect(index).toBeGreaterThanOrEqual(2);
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
    expect(result.error).toContain('AGENT_TASK_CONTINUATION_STALLED');
    expect(
      f.project.access(false, (db) =>
        db
          .prepare('SELECT COUNT(*) AS value FROM llm_provider_requests WHERE generation_id=?')
          .get(run.prepared.stream.generationId),
      ),
    ).toEqual({ value: 5 });
    const detail = f.workflow.getTask({ taskId: run.agent.taskId });
    expect(detail.task.status).toBe('failed');
    expect(detail.events.some((e) => e.eventType === 'agent.task.completed')).toBe(false);
    expect(f.content.listScenes()).toHaveLength(0);
  },
);
it('does not hide a second unfinished stage behind another saved stage in the same task', async () => {
  const f = await setup();
  const run = f.prepare('创建多个场次');
  const plan = await run.invoke('conversation.task.checkpoint', {
    operation: 'plan',
    deliverables: [{ key: 'scenes', toolName: 'scene.submit_structure', minimumCount: 2 }],
  });
  const outputId = (
    plan.outputBindings as Array<{
      outputId: string;
    }>
  )[0]!.outputId;
  await run.invoke('scene.structure.stage', {
    resourceId: 'workspace:shots',
    outputId,
    outputIndex: 1,
    operation: 'begin',
    executionKey: 'pending-second',
    episodeTitle: '第二场',
    sceneShotCounts: [1],
  });
  const saved = await run.invoke('scene.submit_structure', {
    resourceId: 'workspace:shots',
    outputId,
    outputIndex: 0,
    resolution: 'resolved',
    episodeTitle: '第一场',
    scenes: [
      {
        title: '第一场',
        ...authoring(),
        shots: [{ title: '镜头', ...authoring(true) }],
        bindings: {
          schemaVersion: 1,
          sceneDocumentIds: [f.setting.id],
          characterDocumentIds: [],
        },
      },
    ],
  });
  expect(saved.status).toBe('scene_structure_saved');
  f.loop.startProviderStep(run.prepared.stream);
  expect(() =>
    f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
  ).toThrow('TASK_DELIVERABLES_PENDING');
  expect(f.workflow.getTask({ taskId: run.agent.taskId }).task.status).toBe('running');
});
it('keeps an explicit checkpoint resumable until the full request is complete', async () => {
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
      ...authoring(),
      bindings: {
        schemaVersion: 1,
        sceneDocumentIds: [f.setting.id],
        characterDocumentIds: [],
      },
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
  expect(() =>
    f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' }),
  ).toThrow('原始请求仍未完成');
  const task = f.workflow.getTask({ taskId: run.agent.taskId }).task;
  expect(task.status).toBe('running');
  expect(task.completionState).toBeUndefined();
  expect(
    f.workflow
      .getTask({ taskId: run.agent.taskId })
      .events.some((e) => e.eventType === 'agent.task.completed'),
  ).toBe(false);
});
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'repairs saved scene text through the authorized tool under its original creation obligation (%s)',
  async (protocol) => {
    const f = await setup(protocol);
    const run = f.prepare('保存一个场次，逐字保留结尾对白。');
    const obligation = {
      key: 'episode',
      toolName: 'scene.submit_structure',
      minimumCount: 1,
      requiredTexts: ['结尾对白。'],
    };
    const plan = await run.invoke('conversation.task.checkpoint', {
      operation: 'plan',
      deliverables: [obligation],
    });
    const saved = await run.invoke('scene.submit_structure', {
      resourceId: 'workspace:shots',
      outputId: (
        plan.outputBindings as Array<{
          outputId: string;
        }>
      )[0]!.outputId,
      resolution: 'resolved',
      episodeTitle: '本集',
      scenes: [
        {
          title: '庭院',
          ...authoring(),
          shots: [{ title: '结尾', ...authoring(true) }],
          bindings: {
            schemaVersion: 1,
            sceneDocumentIds: [f.setting.id],
            characterDocumentIds: [],
          },
        },
      ],
    });
    expect(saved.status).toBe('scene_structure_saved');
    const [sceneId] = saved.sceneIds as string[];
    const [shotId] = saved.shotIds as string[];
    const state = await run.invoke('conversation.task.checkpoint', { operation: 'state' });
    const actions = state.pendingActions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      key: 'episode',
      missingTexts: ['结尾对白。'],
      nextAction: {
        kind: 'repair_outputs',
        obligationKey: 'episode',
        planChangeRequired: false,
        toolName: 'scene.update_shot_prompts',
        targetIds: [shotId],
      },
    });
    // Repairs must not rely on weakening or replacing the original obligation.
    const weakened = await run.invoke('conversation.task.checkpoint', {
      operation: 'plan',
      deliverables: [{ ...obligation, requiredTexts: undefined }],
    });
    expect(JSON.stringify(weakened)).toContain('weaken');
    const read = await run.invoke('production.read', {
      target: { kind: 'shot', id: shotId },
      view: 'authoring',
    });
    const repair = {
      shots: [
        {
          shotId,
          expectedRowVersion: read.rowVersion,
          ...promptPatch(read.authoring as PromptRecord),
          prompt: '结尾对白。',
        },
      ],
    };
    const repaired = await run.invoke('scene.update_shot_prompts', repair);
    expect(repaired, JSON.stringify(repaired)).toMatchObject({ status: 'shot_prompts_saved' });
    expect(await run.invoke('scene.update_shot_prompts', repair)).toMatchObject({
      status: 'shot_prompts_saved',
      execution: { replayed: true },
    });
    const checked = await run.invoke('conversation.task.checkpoint', { operation: 'state' });
    expect(checked.pendingActions).toEqual([]);
    expect(f.content.listScenes().map((s) => s.id)).toEqual([sceneId]);
    expect(f.content.listShots(sceneId!).map((s) => s.id)).toEqual([shotId]);
    expect(
      f.project.access(false, (db) =>
        db
          .prepare(
            "SELECT count(*) n FROM agent_tool_calls WHERE task_id=? AND json_extract(result_summary_json,'$.status')='task_plan_saved'",
          )
          .get(run.agent.taskId),
      ),
    ).toEqual({ n: 1 });
  },
);
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
  'corrects a rejected new script from its complete pending body after handoff without audit scanning (%s)',
  async (protocol) => {
    const f = await setup(protocol, 64000);
    const run = f.prepare('将已保存资料改编为剧本草稿，不发布。');
    const source = f.workflow.getDocument(f.setting.id).currentVersion!;
    const draft = {
      resourceId: 'workspace:documents',
      title: '潮路剧本',
      documentKind: 'plan',
      contentMarkdown: `# 潮路\n来源 ${f.setting.id}@${source.id} (draft)\n完整原创对白：潮退后再进港。\n结构与细节：阿宁在门边停顿，保留手写伏笔。`,
    };
    const rejected = {
      ...draft,
      baseVersionId: source.id,
      bindings: { schemaVersion: 1 as const },
    };
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `pending-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `pending-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      switch (index) {
        case 0:
          return tool('tools.load', { names: ['document.submit_draft'] });
        case 1:
          return tool('project.structure.get', {});
        case 2:
          return tool('conversation.task.checkpoint', {
            operation: 'plan',
            deliverables: [
              {
                key: 'script',
                toolName: 'document.submit_draft',
                documentKind: 'plan',
                minimumCount: 1,
              },
            ],
          });
        case 3:
          return tool('document.submit_draft', rejected);
        case 4:
          return tool('conversation.task.checkpoint', {
            operation: 'save',
            remainingWork: '修正新建参数并保存原剧本。',
            workingNotes: '原提交未保存，完整正文应继续保留。',
          });
        case 5: {
          expect(params.continuation).toBeUndefined();
          expect(params.systemInstruction).not.toContain(JSON.stringify(rejected));
          const result = f.project.access(false, (db) =>
            new AgentContextStore(db).resultForCall(
              run.prepared.stream.projectId,
              run.agent.taskId,
              'pending-3',
            ),
          )!;
          return tool('conversation.task.checkpoint', {
            operation: 'result',
            resultId: result.id,
            resultView: 'arguments',
          });
        }
        case 6:
          expect(JSON.parse(String(lastOutput(params).content))).toEqual(rejected);
          return tool('document.submit_draft', draft);
        default:
          return [
            { ...common, type: 'text_delta', delta: '剧本草稿已保存，未发布。' },
            {
              ...common,
              type: 'complete',
              providerResponseId: 'pending-done',
              finishReason: 'stop',
            },
          ];
      }
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      createContextManager: (identity, taskId, prompt) =>
        new AgentContextManager(f.project, identity, taskId, prompt),
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
      prompt: '将已保存资料改编为剧本草稿，不发布。',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const generation = f.generations.get(run.prepared.stream.generationId);
    expect(generation.status, generation.error).toBe('complete');
    expect(requests).toHaveLength(8);
    const task = f.workflow.getTask({ taskId: run.agent.taskId });
    expect(task.documents).toHaveLength(1);
    const saved = f.workflow.getDocument(task.documents[0]!.documentId);
    expect(saved.currentVersion?.contentMarkdown).toBe(draft.contentMarkdown);
    expect(saved.kind).toBe('plan');
    expect(saved.currentVersion?.state).toBe('draft');
    expect(
      f.project.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id=?').get(saved.id),
      ),
    ).toEqual({ n: 1 });
    expect(
      f.project.access(false, (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_tool_calls WHERE generation_id=? AND tool_name='conversation.task.checkpoint' AND json_extract(arguments_summary_json,'$.keys') LIKE '%evidenceOffset%'",
          )
          .get(run.prepared.stream.generationId),
      ),
    ).toEqual({ n: 0 });
  },
);
it.each([
  ['openai-responses', 'correct'],
  ['openai-chat-completions', 'correct'],
  ['openai-responses', 'partial'],
  ['openai-chat-completions', 'partial'],
] as const)(
  'repairs a failed chapter save and rejects unsupported partial completion under context pressure (%s, %s)',
  async (protocol, exit) => {
    const f = await setup(protocol, 32000);
    const chapter = new NovelService(f.project).saveChapter({
      title: '潮路',
      displayLabel: '第一章',
    });
    const sourceBody = '潮水退去，阿宁走入港口。'.repeat(120);
    const source = f.workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: sourceBody,
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    const prompt = productionSkillPrompt('chapters-to-script', [
      {
        id: chapter.id,
        documentId: chapter.documentId,
        title: chapter.title,
        kind: 'note',
        versionId: source.currentVersion!.id,
        state: 'draft',
      },
    ]);
    const run = f.prepare(prompt);
    const draft = {
      resourceId: 'workspace:documents',
      title: '第一集 潮路',
      documentKind: 'plan',
      contentMarkdown: `# 第一集 潮路\n来源：${chapter.documentId}@${source.currentVersion!.id} (draft)\n阿宁：潮退了，进港。`,
    };
    let step = 0;
    let repaired = false;
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `chapter-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `chapter-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      const partial = () =>
        tool('conversation.task.checkpoint', {
          operation: 'partial',
          reason: '保存参数失败；源章节已读，剧本尚未保存。',
        });
      if (step === 6 && lastOutput(params).externalized === true) {
        return tool('conversation.task.checkpoint', {
          operation: 'result',
          resultId: lastOutput(params).resultId,
          resultLimit: 16384,
        });
      }
      switch (step++) {
        case 0:
          return tool('tools.load', { names: ['document.submit_draft', 'production.skill.read'] });
        case 1:
          return tool('production.skill.read', { skillId: 'chapters-to-script' });
        case 2:
          return tool('project.structure.get', {});
        case 3:
          return tool('conversation.task.checkpoint', {
            operation: 'plan',
            deliverables: [
              {
                key: 'script',
                toolName: 'document.submit_draft',
                documentKind: 'plan',
                minimumCount: 1,
              },
            ],
          });
        case 4:
          return tool('library.search', {
            query: '潮路',
            sourceTypes: ['novel-chapter'],
            limit: 1,
          });
        case 5: {
          const sources = lastOutput(params).sources as Array<{
            sourceHandle: string;
          }>;
          return tool('library.read', {
            sourceHandle: sources[0]!.sourceHandle,
            readMode: 'source',
          });
        }
        case 6: {
          const value = lastOutput(params);
          expect(
            value.status === 'selected_source_included'
              ? nativeRequestUserText(params)
              : JSON.stringify(
                  value.status === 'task_result_read' ? JSON.parse(String(value.content)) : value,
                ),
          ).toContain(sourceBody);
          return tool('conversation.task.checkpoint', {
            operation: 'save',
            remainingWork: '仅保存一份剧本。',
            workingNotes: '使用已读取源正文及 plan 文档类型。',
          });
        }
        case 7:
          return tool('document.submit_draft', {
            ...draft,
            documentKind: 'script',
            contentMarkdown: 'unsaved-script '.repeat(1200),
          });
        case 8:
          expect(params.systemInstruction).not.toContain('[TASK STAGE HANDOFF REQUIRED]');
          expect(params.systemInstruction).not.toContain(sourceBody);
          expect(
            f.project.access(
              false,
              (db) =>
                new AgentContextStore(db).resultForCall(
                  run.prepared.stream.projectId,
                  run.agent.taskId,
                  'chapter-7',
                )?.arguments,
            ),
          ).toBeDefined();
          repaired = true;
          return exit === 'correct' ? tool('document.submit_draft', draft) : partial();
        case 9:
          if (exit !== 'correct') {
            expect(JSON.stringify(lastOutput(params))).toContain('TASK_REPAIR_REQUIRED');
            expect(
              f.project.access(false, (db) =>
                new AgentContextStore(db).loadTask(run.prepared.stream.projectId, run.agent.taskId),
              )?.executionStatus,
            ).not.toBe('partial');
            return tool('document.submit_draft', draft);
          }
          // The direct correction already saved its output.
          break;
        default:
          break;
      }
      return [
        {
          ...common,
          type: 'text_delta',
          delta: '剧本草稿已保存，未发布。',
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: 'chapter-done',
          finishReason: 'stop',
        },
      ];
    }, true);
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      createContextManager: (identity, taskId, prompt) =>
        new AgentContextManager(f.project, identity, taskId, prompt),
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
      prompt,
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const generation = f.generations.get(run.prepared.stream.generationId);
    expect(
      generation.status,
      JSON.stringify({
        error: generation.error,
        step,
        repaired,
        tools: requests.map((request) => request.tools?.length),
      }),
    ).toBe('complete');
    expect(repaired).toBe(true);
    expect(
      generation.assistantMessage.attempt!.accounting!.requests.every(
        ({ context }) =>
          !context || context.estimatedInputTokens <= context.maximumInputBudgetTokens!,
      ),
    ).toBe(true);
    expect(requests.length).toBeLessThan(13);
    const durableState = f.project.access(false, (db) =>
      new AgentContextStore(db).loadTask(run.prepared.stream.projectId, run.agent.taskId),
    )!;
    expect(durableState.executionStatus).toBe('completed');
    expect(durableState.pendingSteps).toEqual([]);
    const task = f.workflow.getTask({ taskId: run.agent.taskId });
    expect(task.documents).toHaveLength(1);
    const doc = f.workflow.getDocument(task.documents[0]!.documentId);
    expect(doc.kind).toBe('plan');
    expect(doc.currentVersion?.contentMarkdown).toBe(draft.contentMarkdown);
    expect(doc.currentVersion?.state).toBe('draft');
    expect(task.task.completionState).not.toBe('partial');
    expect(f.workflow.getDocument(chapter.documentId).currentVersion?.contentMarkdown).toBe(
      sourceBody,
    );
    const reads = f.project.access(false, (db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_tool_calls WHERE generation_id=? AND tool_name='library.read'",
        )
        .get(run.prepared.stream.generationId),
    );
    expect(reads).toEqual({ n: 1 });
  },
);
it.each([
  ['openai-responses', 'schema'],
  ['openai-chat-completions', 'schema'],
  ['openai-responses', 'business'],
  ['openai-chat-completions', 'business'],
] as const)(
  'stops repeated checkpoint error states despite rewritten prose before a fifth Native retry and retains saved drafts (%s, %s)',
  async (protocol, failure) => {
    const f = await setup(protocol);
    const run = f.prepare('保存剧本，核对剩余任务。');
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const item = {
        key: 'duplicate',
        toolName: 'document.submit_draft',
        documentKind: 'plan',
        minimumCount: 1,
      };
      const call =
        index === 0
          ? { name: 'tools.load', args: { names: ['document.submit_draft'] } }
          : index === 1
            ? { name: 'project.structure.get', args: {} }
            : index === 2
              ? {
                  name: 'document.submit_draft',
                  args: {
                    resourceId: 'workspace:documents',
                    title: '已完成剧本',
                    documentKind: 'plan',
                    contentMarkdown: '已保存的对白必须保留。',
                  },
                }
              : {
                  name: 'conversation.task.checkpoint',
                  args:
                    failure === 'schema'
                      ? { operation: 'save', remainingWork: `第${index}次重述剩余工作` }
                      : {
                          operation: 'plan',
                          deliverables: [item, { ...item, description: `第${index}次重述计划` }],
                        },
                };
      return [
        {
          ...common,
          type: 'tool_call_end',
          call: {
            id: `failure-${index}`,
            name: call.name,
            argumentsJson: JSON.stringify(call.args),
          },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `failure-${index}`,
          finishReason: 'tool_calls',
        },
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
      prompt: '保存剧本，核对剩余任务。',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('AGENT_TOOL_FAILURE_STALLED');
    expect(requests).toHaveLength(7);
    const task = f.workflow.getTask({ taskId: run.agent.taskId });
    expect(task.task.status).toBe('failed');
    expect(task.documents).toHaveLength(1);
    expect(
      f.workflow.getDocument(task.documents[0]!.documentId).currentVersion?.contentMarkdown,
    ).toBe('已保存的对白必须保留。');
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'finishes a long task across durable context stages without repeating saves (%s)',
  async (protocol) => {
    const f = await setup(protocol, 64000);
    const scene = f.content.saveScene({ title: '长任务', sceneDocumentId: f.setting.id });
    const shots = Array.from({ length: 30 }, (_, i) =>
      f.content.saveShot({
        sceneId: scene.id,
        title: `第${i + 1}镜`,
        prompt: `第${i + 1}镜独有的原始正文。${'转身后按原位停顿。'.repeat(240)}`,
        timing: { estimatedDurationSeconds: 8 },
        bindings: {
          schemaVersion: 1 as const,
          sceneDocumentIds: [f.setting.id],
        },
      }),
    );
    const originalRequest = '完成全部三十镜。保留时长、手动内容和全部原文，再增加衔接。';
    const run = f.prepare(originalRequest);
    let cursor = 0;
    let read = 0;
    let checkpoints = 0;
    let repaired = false;
    let expectFresh = false;
    const checkpointCursors: number[] = [];
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `stage-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `stage-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      expect(params.prompt).toContain(originalRequest);
      if (checkpoints > 0) {
        const requirements = stageEnvelope(params).userRequirements;
        expect(requirements.some((r) => r.text === '交接时补充：保持左手持杯')).toBe(true);
        expect(requirements.filter((r) => r.text === '重复补充：不改对白')).toHaveLength(2);
      }
      if (expectFresh) {
        expect(params.continuation).toBeUndefined();
        expect(stageEnvelope(params).checkpoint.remainingWorkAtCheckpoint).toContain(
          `从第${cursor + 1}镜继续`,
        );
        expect(nativeRequestUserText(params)).toContain('checkpointId');
        expect(stageEnvelope(params).savedArtifacts.length).toBeGreaterThan(0);
        // Bodies of completed shots leave the working stage; source audit stays intact.
        if (cursor > 10) expect(JSON.stringify(params)).not.toContain(shots[0]!.prompt);
        if (read) {
          expect(params.systemInstruction).not.toContain(shots[cursor]!.prompt);
          expect(stageEnvelope(params).evidence.length).toBeGreaterThan(0);
        }
        expectFresh = false;
      }
      if (
        cursor > 0 &&
        cursor < shots.length &&
        cursor % 6 === 0 &&
        read === 0 &&
        checkpointCursors.at(-1) !== cursor
      ) {
        checkpoints++;
        checkpointCursors.push(cursor);
        expectFresh = true;
        return tool('conversation.task.checkpoint', {
          operation: 'save',
          remainingWork: `从第${cursor + 1}镜继续直到30镜，nextShotId=${shots[cursor]?.id ?? 'done'}`,
          workingNotes:
            '前面镜头已保存，以回执为准。逐镜重新读取当前版本，保留完整原文、时长、手动内容后补衔接；不要重复已保存镜头。',
        });
      }
      if (index === 0)
        return tool('tools.load', { names: ['production.read', 'scene.update_shot_prompts'] });
      if (cursor < shots.length) {
        const shot = shots[cursor]!;
        if (read < 2) {
          const view = read++ === 0 ? 'authoring' : 'media';
          return tool('production.read', {
            target: { kind: 'shot', id: shot.id },
            view,
          });
        }
        if (cursor === 4 && !repaired) {
          repaired = true;
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
        }
        read = 0;
        cursor++;
        return tool('scene.update_shot_prompts', {
          shots: [
            {
              shotId: shot.id,
              expectedRowVersion: shot.rowVersion,
              ...promptPatch(shot),
              prompt: shot.prompt + '补充衔接。',
            },
          ],
        });
      }
      return [
        { ...common, type: 'text_delta', delta: '三十镜已全部保存。' },
        { ...common, type: 'complete', providerResponseId: 'done', finishReason: 'stop' },
      ];
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      createContextManager: (identity, taskId, prompt) =>
        new AgentContextManager(f.project, identity, taskId, prompt),
      bridge,
      plans: {} as never,
      onEvent: (event) => {
        if (
          event.type === 'tool_succeeded' &&
          event.toolName === 'conversation.task.checkpoint' &&
          checkpoints === 1
        ) {
          for (const [index, text] of [
            '交接时补充：保持左手持杯',
            '重复补充：不改对白',
            '重复补充：不改对白',
          ].entries())
            f.generations.supplement(
              run.prepared.stream.generationId,
              text,
              `handoff-supplement-${index}`,
            );
        }
      },
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: originalRequest,
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status, result.error).toBe('complete');
    expect(checkpoints).toBeGreaterThanOrEqual(3);
    expect(repaired).toBe(true);
    expect(
      checkpointCursors.every((value, i) => i === 0 || value > checkpointCursors[i - 1]!),
    ).toBe(true);
    expect(
      result.assistantMessage.attempt!.accounting!.requests.every(
        (request) => (request.context?.reservedOutputTokens ?? 16000) >= 8192,
      ),
    ).toBe(true);
    const audit = f.project.access(false, (db) =>
      db
        .prepare(
          'SELECT tool_name,status,result_summary_json FROM agent_tool_calls WHERE generation_id=? ORDER BY rowid',
        )
        .all(run.prepared.stream.generationId),
    ) as Array<{
      tool_name: string;
      status: string;
      result_summary_json: string;
    }>;
    expect(audit.filter((row) => row.status === 'failed')).toEqual([]);
    expect(audit.filter((row) => row.tool_name === 'scene.update_shot_prompts')).toHaveLength(30);
    expect(audit.filter((row) => row.tool_name === 'production.read')).toHaveLength(60);
    expect(audit.filter((row) => row.tool_name === 'conversation.task.checkpoint')).toHaveLength(
      checkpoints,
    );
    expect(audit.some((row) => row.result_summary_json.includes(shots[0]!.prompt!))).toBe(true);
    const current = new ProductionService(f.project);
    for (const shot of shots) {
      const saved = current.read({ kind: 'shot', id: shot.id });
      expect(saved.rowVersion).toBe(shot.rowVersion + 1);
      expect(saved).toMatchObject({
        bindings: shot.bindings,
        timing: shot.timing,
        prompt: shot.prompt + '补充衔接。',
      });
    }
    const recovery = f.prepare('只核对上次交接，不改写');
    const restored = await recovery.invoke('conversation.task.checkpoint', {
      operation: 'read',
      targetGenerationId: run.prepared.stream.generationId,
    });
    expect(restored.status).toBe('task_checkpoint_read');
    expect(restored.checkpoint).toMatchObject({
      generationId: run.prepared.stream.generationId,
      notesAreAssistantClaims: true,
    });
    const receipts = await recovery.invoke('conversation.task.checkpoint', {
      operation: 'read',
      targetGenerationId: run.prepared.stream.generationId,
      receiptOffset: 20,
    });
    expect(
      (
        receipts.savedProductionReceipts as {
          receipts: unknown[];
        }
      ).receipts,
    ).toHaveLength(10);
    expect(receipts.checkpoint).toBeUndefined();
    let evidenceContentOffset = 0;
    let evidenceJson = '';
    do {
      const page = await recovery.invoke('conversation.task.checkpoint', {
        operation: 'read',
        targetGenerationId: run.prepared.stream.generationId,
        evidenceOffset: 0,
        evidenceContentOffset,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
      const evidence = page.evidence as {
        resultJson: string;
        nextContentOffset?: number;
      };
      evidenceJson += evidence.resultJson;
      evidenceContentOffset = evidence.nextContentOffset ?? 0;
    } while (evidenceContentOffset);
    expect(evidenceJson).toBe(
      audit.find((row) => row.tool_name !== 'conversation.task.checkpoint')!.result_summary_json,
    );
    expect(requests.length).toBeGreaterThan(62);
  },
  30000,
);
it.each([
  ['openai-responses', false],
  ['openai-chat-completions', false],
  ['openai-responses', true],
  ['openai-chat-completions', true],
] as const)(
  'uses unfinished stage evidence to save, honors CAS conflicts and replays the same receipt (%s, conflict=%s)',
  async (protocol, conflict) => {
    const f = await setup(protocol, 64000);
    const scene = f.content.saveScene({ title: '交接中镜头', sceneDocumentId: f.setting.id });
    const shot = f.content.saveShot({
      sceneId: scene.id,
      title: '第11镜',
      prompt: '完整镜头正文'.repeat(100),
      bindings: {
        schemaVersion: 1 as const,
        sceneDocumentIds: [f.setting.id],
      },
      timing: { estimatedDurationSeconds: 8 },
    });
    const run = f.prepare('继续修第11镜，保留原文和手动设置。');
    let step = 0;
    let saveArgs: Record<string, unknown>;
    let current = shot;
    const { bridge } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `working-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `working-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      const read = (view: string) =>
        tool('production.read', { target: { kind: 'shot', id: shot.id }, view });
      const checkpoint = () =>
        tool('conversation.task.checkpoint', {
          operation: 'save',
          remainingWork: '保存未完成的第11镜，正文与媒体已读，不重启路由。',
          workingNotes: '基于Worker证据完成保存。',
        });
      const next = step++;
      if (next === 0)
        return tool('tools.load', { names: ['production.read', 'scene.update_shot_prompts'] });
      if (next === 1) return read('authoring');
      if (next === 2) return read('media');
      if (next === 3) return checkpoint();
      if (next === 4) {
        expect(params.continuation).toBeUndefined();
        const envelope = stageEnvelope(params);
        expect(envelope.evidence).toHaveLength(2);
        const stored = f.project.access(false, (db) =>
          new AgentContextStore(db).result(
            run.prepared.stream.projectId,
            run.agent.taskId,
            envelope.evidence[0]!.resultId,
          ),
        );
        expect(
          (
            JSON.parse(stored!.content) as {
              authoring: unknown;
            }
          ).authoring,
        ).toEqual({ prompt: shot.prompt, bindings: shot.bindings, timing: shot.timing });
        expect(params.systemInstruction).not.toContain(shot.prompt);
        expect(envelope.availableTools).toContain('scene.update_shot_prompts');
        saveArgs = {
          shots: [
            {
              shotId: shot.id,
              expectedRowVersion: shot.rowVersion,
              ...promptPatch(shot),
              prompt: shot.prompt + '剪辑接点。',
            },
          ],
        };
        if (conflict)
          current = f.content.saveShot({
            sceneId: shot.sceneId,
            title: shot.title,
            shotId: shot.id,
            expectedRowVersion: shot.rowVersion,
            ...promptPatch(shot),
            prompt: shot.prompt + '用户并发补充。',
          });
        return tool('scene.update_shot_prompts', saveArgs);
      }
      if (conflict && next === 5) {
        expect(JSON.stringify(lastOutput(params))).toContain('SHOT_ROW_VERSION_CONFLICT');
        return read('authoring');
      }
      if (conflict && next === 6) return read('media');
      if (conflict && next === 7) {
        saveArgs = {
          shots: [
            {
              shotId: shot.id,
              expectedRowVersion: current.rowVersion,
              ...promptPatch(current),
              prompt: current.prompt + '剪辑接点。',
            },
          ],
        };
        return tool('scene.update_shot_prompts', saveArgs);
      }
      const afterSave = conflict ? 8 : 5;
      if (next === afterSave) return checkpoint();
      if (next === afterSave + 1) {
        expect(params.continuation).toBeUndefined();
        const envelope = stageEnvelope(params);
        expect(envelope.savedArtifacts).toHaveLength(1);
        expect(params.systemInstruction).not.toContain(shot.prompt);
        return tool('scene.update_shot_prompts', saveArgs);
      }
      return [
        { ...common, type: 'text_delta', delta: '第11镜已保存。' },
        { ...common, type: 'complete', providerResponseId: 'done', finishReason: 'stop' },
      ];
    });
    const runtime = new PiConversationRuntime({
      generation: f.generations,
      providerTools: f.loop,
      createContextManager: (identity, taskId, prompt) =>
        new AgentContextManager(f.project, identity, taskId, prompt),
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
      prompt: '继续修第11镜，保留原文和手动设置。',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const generation = f.generations.get(run.prepared.stream.generationId);
    expect(generation.status, generation.error).toBe('complete');
    const saved = new ProductionService(f.project).read({ kind: 'shot', id: shot.id });
    expect(saved.rowVersion).toBe(current.rowVersion + 1);
    expect(saved).toMatchObject({
      bindings: current.bindings,
      timing: current.timing,
      prompt: current.prompt + '剪辑接点。',
    });
    const counts = f.project.access(false, (db) => ({
      receipts: db.prepare('SELECT COUNT(*) AS n FROM agent_write_receipts').get(),
      reads: db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_tool_calls WHERE generation_id=? AND tool_name='production.read'",
        )
        .get(run.prepared.stream.generationId),
    }));
    expect(counts.receipts).toEqual({ n: 1 });
    expect(counts.reads).toEqual({ n: conflict ? 4 : 2 });
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'keeps a committed checkpoint when cancelled before the next stage (%s)',
  async (protocol) => {
    const f = await setup(protocol, 64000);
    const run = f.prepare('核对目录后继续未完成工作');
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const name = ['tools.load', 'project.get_context', 'conversation.task.checkpoint'][index];
      if (!name) throw new Error('Cancelled task sent another model request.');
      const args =
        index === 0
          ? { names: ['project.get_context'] }
          : index === 1
            ? {}
            : {
                operation: 'save',
                remainingWork: '继续核对未完成部分',
                workingNotes: '目录已读取，正文仍按需获取',
              };
      return [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `cancel-stage-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `cancel-stage-${index}`,
          finishReason: 'tool_calls',
        },
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
      onEvent: (event) => {
        if (event.type === 'tool_succeeded' && event.toolName === 'conversation.task.checkpoint')
          runtime.cancel(run.prepared.stream.generationId);
      },
    });
    await runtime.start({
      ...run.prepared.stream,
      identity: run.prepared.stream,
      taskId: run.agent.taskId,
      prompt: '核对目录后继续未完成工作',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    expect(requests).toHaveLength(3);
    expect(f.generations.get(run.prepared.stream.generationId).status).toBe('cancelled');
    const recovery = f.prepare('核对已取消任务的交接');
    expect(
      await recovery.invoke('conversation.task.checkpoint', {
        operation: 'read',
        targetGenerationId: run.prepared.stream.generationId,
      }),
    ).toMatchObject({
      status: 'task_checkpoint_read',
      checkpoint: { remainingWork: '继续核对未完成部分' },
    });
  },
);
it('rejects checkpoint-only loops, cross-conversation recovery and saves into another generation', async () => {
  const f = await setup();
  const run = f.prepare('核对当前目录');
  expect(
    await run.invoke('conversation.task.checkpoint', {
      operation: 'save',
      remainingWork: '继续',
      workingNotes: '没有证据',
    }),
  ).toMatchObject({ status: 'rejected' });
  await run.invoke('project.get_context', {});
  expect(
    await run.invoke('conversation.task.checkpoint', {
      operation: 'save',
      remainingWork: '继续核对',
      workingNotes: '已经获取目录，正文仍按需读',
    }),
  ).toMatchObject({ status: 'task_checkpoint_saved' });
  expect(
    await run.invoke('conversation.task.checkpoint', {
      operation: 'save',
      remainingWork: '继续',
      workingNotes: '重复交接',
    }),
  ).toMatchObject({ status: 'rejected' });
  const other = f.prepare('独立任务');
  expect(
    await other.invoke('conversation.task.checkpoint', {
      operation: 'save',
      targetGenerationId: run.prepared.stream.generationId,
      remainingWork: '继续',
      workingNotes: '越界',
    }),
  ).toMatchObject({ status: 'rejected' });
  const conversation = f.content.createConversation({ scopeType: 'project' });
  f.project.access(true, (db) =>
    db
      .prepare('UPDATE llm_generations SET conversation_id=? WHERE id=?')
      .run(conversation.id, run.prepared.stream.generationId),
  );
  expect(
    await other.invoke('conversation.task.checkpoint', {
      operation: 'read',
      targetGenerationId: run.prepared.stream.generationId,
    }),
  ).toMatchObject({ status: 'rejected' });
});
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'saves every target once after many production reads without losing shared media evidence (%s)',
  async (protocol) => {
    const f = await setup(protocol, 64000);
    const documents = [
      f.content.saveDocument({
        kind: 'character',
        title: '角色甲完整设定板（草稿）',
        contentMarkdown: '按需资料甲',
      }),
      f.content.saveDocument({
        kind: 'character',
        title: '角色乙完整设定板（草稿）',
        contentMarkdown: '按需资料乙',
      }),
      f.setting,
      f.content.saveDocument({
        kind: 'prop',
        title: '道具完整设定板（草稿）',
        contentMarkdown: '按需道具资料',
      }),
    ];
    const root = f.project.access(false, (_db, project) => project.rootPath);
    await mkdir(join(root, 'assets', 'images'), { recursive: true });
    for (const document of documents) {
      const assetId = `image-${document.id}`;
      f.project.access(true, (db, project) => {
        db.prepare(
          'INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          assetId,
          project.id,
          document.kind,
          `assets/images/${assetId}.png`,
          'a'.repeat(64),
          1,
          '2026-11-02T00:00:00.000Z',
        );
        db.prepare(
          "INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES(?,?,'fixture','succeeded','{}',?,'now','now')",
        ).run(`job-${assetId}`, project.id, JSON.stringify({ sourceDocumentId: document.id }));
        db.prepare(
          "INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES(?,?,?,'now')",
        ).run(`result-${assetId}`, `job-${assetId}`, assetId);
      });
      await writeFile(
        join(root, 'assets', 'images', `${assetId}.png`),
        Buffer.from('fixture-image'),
      );
    }
    const scene = f.content.saveScene({ title: '连续七镜', sceneDocumentId: f.setting.id });
    const shots = Array.from({ length: 7 }, (_, i) =>
      f.content.saveShot({
        sceneId: scene.id,
        title: `第${i + 11}镜`,
        prompt: `镜头${i}原始完整要求。`.repeat(120),
        bindings: {
          schemaVersion: 1 as const,
          characterDocumentIds: documents.slice(0, 2).map((d) => d.id),
          sceneDocumentIds: [f.setting.id],
          propDocumentIds: [documents[3]!.id],
        },
        timing: { estimatedDurationSeconds: 8 },
      }),
    );
    const revised = shots.map((shot, i) => `${shot.prompt}第${i + 11}镜完成衔接修订。`);
    const run = f.prepare(
      `继续修订第11至17镜，完整保留引用、时长与手动内容。${'user requirement '.repeat(4900)}`,
    );
    // Exercise the lossless fallback independently of the new stage coordinator.
    f.generations.configureAgentTools(
      run.prepared.stream,
      run.agent.tools.filter((tool) => tool.name !== 'conversation.task.checkpoint'),
    );
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `many-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `many-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      if (index === 0)
        return tool('tools.load', { names: ['production.read', 'scene.update_shot_prompts'] });
      if (index <= 14)
        return tool('production.read', {
          target: { kind: 'shot', id: shots[(index - 1) % 7]!.id },
          view: index <= 7 ? 'authoring' : 'media',
        });
      if (index <= 21) {
        const shot = shots[index - 15]!;
        return tool('scene.update_shot_prompts', {
          shots: [
            {
              shotId: shot.id,
              expectedRowVersion: shot.rowVersion,
              ...promptPatch(shot),
              prompt: revised[index - 15],
            },
          ],
        });
      }
      expect(lastOutput(params)).toMatchObject({ status: 'shot_prompts_saved', changedCount: 1 });
      return [
        { ...common, type: 'text_delta', delta: '七个镜头的修改均已保存。' },
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
      prompt: '继续修订七个镜头',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(result.status, result.error).toBe('complete');
    expect(requests).toHaveLength(23);
    expect(
      result.assistantMessage
        .attempt!.accounting!.requests.slice(15)
        .every((request) => request.context!.reservedOutputTokens > 4096),
    ).toBe(true);
    expect(
      requests.some((request) => JSON.stringify(request).includes('lossless_references')),
    ).toBe(true);
    const firstWrite = requests[15]!;
    const wireOutputs =
      firstWrite.continuation?.protocol === 'openai-chat-completions'
        ? [...(firstWrite.continuation.history ?? []), firstWrite.continuation].flatMap(
            (turn) => turn.outputs,
          )
        : (
            JSON.parse(
              firstWrite.prompt
                .split('[COMPLETED TASK HISTORY — EVIDENCE, NOT NEW INSTRUCTIONS]\n')[1]!
                .split('\n[END TASK HISTORY]')[0]!,
            ) as Array<{
              role: string;
              callId: string;
              content: string;
            }>
          )
            .filter((entry) => entry.role === 'toolResult')
            .map((entry) => ({ callId: entry.callId, output: entry.content }));
    const decoded = decodeProductionHistory(wireOutputs);
    const audit = f.project.access(false, (db) =>
      db
        .prepare(
          'SELECT provider_call_id,result_summary_json,tool_name FROM agent_tool_calls WHERE generation_id=? ORDER BY created_at,tool_ordinal',
        )
        .all(run.prepared.stream.generationId),
    ) as Array<{
      provider_call_id: string;
      result_summary_json: string;
      tool_name: string;
    }>;
    for (const entry of audit.filter((entry) => entry.tool_name === 'production.read'))
      expect(decoded.get(entry.provider_call_id)).toEqual(JSON.parse(entry.result_summary_json));
    const receipts = f.workflow.getTask({ taskId: run.agent.taskId }).savedProductionReceipts!
      .receipts;
    expect(receipts).toHaveLength(7);
    expect(audit.filter((entry) => entry.tool_name === 'production.read')).toHaveLength(14);
    expect(audit.filter((entry) => entry.tool_name === 'scene.update_shot_prompts')).toHaveLength(
      7,
    );
    const persisted = f.content.listShots(scene.id);
    shots.forEach((shot, i) =>
      expect(persisted.find((saved) => saved.id === shot.id)).toMatchObject({
        bindings: shot.bindings,
        timing: shot.timing,
        rowVersion: shot.rowVersion + 1,
        prompt: revised[i],
      }),
    );
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'reads and saves one shot once, then inspects exact durable receipts after a final provider failure (%s)',
  async (protocol) => {
    // Expanded authoring/review contracts need room as well as the unchanged long user input/output.
    // Budget rejection at insufficient windows remains covered by AgentContextBudget regressions.
    const f = await setup(protocol, 30000);
    const scene = f.content.saveScene({ title: '场次', sceneDocumentId: f.setting.id });
    const shot = f.content.saveShot({
      sceneId: scene.id,
      title: '镜头七',
      ...authoring(true),
    });
    const savedPrompt = `另两影作背景剪影。${'composition '.repeat(1200)}`;
    const run = f.prepare(`只修改镜头七，保留所有要求。${'user requirement '.repeat(1600)}`);
    // Keep the compaction/receipt regression independent of stage rollover.
    f.generations.configureAgentTools(
      run.prepared.stream,
      run.agent.tools.filter((tool) => tool.name !== 'conversation.task.checkpoint'),
    );
    const { bridge, requests } = scriptedBridge((params, index) => {
      const common = { projectSessionId: params.projectSessionId };
      const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
        {
          ...common,
          type: 'tool_call_end',
          call: { id: `single-${index}`, name, argumentsJson: JSON.stringify(args) },
        },
        {
          ...common,
          type: 'complete',
          providerResponseId: `single-${index}`,
          finishReason: 'tool_calls',
        },
      ];
      if (index === 0)
        return tool('tools.load', { names: ['production.read', 'scene.update_shot_prompts'] });
      if (index === 1) return tool('production.read', { target: { kind: 'shot', id: shot.id } });
      if (index === 2) {
        expect(lastOutput(params)).toMatchObject({
          shotId: shot.id,
          sceneId: scene.id,
          rowVersion: shot.rowVersion,
          authoring: authoring(true),
        });
        return tool('scene.update_shot_prompts', {
          shots: [
            {
              shotId: shot.id,
              expectedRowVersion: shot.rowVersion,
              prompt: savedPrompt,
            },
          ],
        });
      }
      expect(lastOutput(params)).toMatchObject({
        status: 'shot_prompts_saved',
        changedCount: 1,
        executionId: expect.any(String) as unknown,
        shots: [
          { shotId: shot.id, sceneId: scene.id, rowVersion: shot.rowVersion + 1, changed: true },
        ],
      });
      return [
        {
          ...common,
          type: 'failed',
          error: {
            code: 'PROVIDER_FAILED',
            message: 'Provider HTTP 400: final response unavailable',
            retryable: false,
            providerStatus: 400,
          },
        },
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
      prompt: '只修改镜头七',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    expect(requests, f.generations.get(run.prepared.stream.generationId).error).toHaveLength(4);
    expect(
      requests.every(
        (request) => !request.tools?.some((tool) => tool.name === 'conversation.task.checkpoint'),
      ),
    ).toBe(true);
    expect(requests.every((request) => !request.systemInstruction.includes('operation=plan'))).toBe(
      true,
    );
    expect(f.generations.get(run.prepared.stream.generationId).status).toBe('failed');
    const task = f.workflow.getTask({ taskId: run.agent.taskId });
    expect(
      f.generations
        .get(run.prepared.stream.generationId)
        .assistantMessage.attempt?.accounting?.requests.some(
          (request) => (request.context?.compactionCount ?? 0) > 0,
        ),
    ).toBe(true);
    expect(task.task.completionState).toBe('partial');
    expect(task.savedProductionReceipts?.receipts).toEqual([
      expect.objectContaining({
        generationId: run.prepared.stream.generationId,
        result: expect.objectContaining({
          changedCount: 1,
          executionId: expect.any(String) as unknown,
          shots: [
            { shotId: shot.id, sceneId: scene.id, rowVersion: shot.rowVersion + 1, changed: true },
          ],
        }) as unknown,
      }),
    ]);
    const continuation = f.prepare('继续：先核对已保存结果');
    const inspected = await continuation.invoke('conversation.task.route', {
      decision: 'inspect',
      rationale: '核对指定任务的实际保存结果。',
      targetGenerationId: run.prepared.stream.generationId,
    });
    expect(inspected).toMatchObject({
      targetStatus: 'failed',
      savedProductionReceipts: task.savedProductionReceipts,
    });
    expect(f.content.listShots(scene.id)).toHaveLength(1);
    expect(f.content.listShots(scene.id)[0]).toMatchObject({
      rowVersion: shot.rowVersion + 1,
      prompt: savedPrompt,
    });
    expect(task.providerSteps.at(-1)?.status).toBe('failed');
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'persists local budget diagnostics without counting or sending a provider request (%s)',
  async (protocol) => {
    const f = await setup(protocol, 20000);
    const prompt = '完整用户要求。'.repeat(5000);
    const run = f.prepare(prompt);
    const { bridge, requests } = scriptedBridge(() => {
      throw new Error('Must not dispatch');
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
      prompt,
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const result = f.generations.get(run.prepared.stream.generationId);
    expect(requests).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.userMessage.content).toBe(prompt);
    expect(result.assistantMessage.attempt?.accounting).toMatchObject({
      requestCount: 0,
      requests: [
        {
          errorCode: 'CONTEXT_BUDGET_EXCEEDED',
          failureOrigin: 'local_context',
          dispatched: false,
          sent: false,
          context: {
            contextWindowTokens: 20000,
            safetyTokens: 1000,
            minimumOutputTokens: 2048,
            maximumInputBudgetTokens: 16952,
          },
        },
      ],
    });
    expect(f.workflow.getTask({ taskId: run.agent.taskId }).task.usage?.state).toBe(
      'context_exhausted',
    );
  },
);
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
        const sources = lastOutput(params).sources as Array<{
          sourceHandle: string;
        }>;
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
      if (index === 4 || index === 9) {
        expect(params.systemInstruction).toContain('[TOOL OUTPUT RECOVERY]');
        expect(params.prompt).toContain('固定清晨水墨风格');
        expect(params.tools!.some((item) => item.name === 'scene.structure.stage')).toBe(true);
        expect(params.tools!.some((item) => item.name === 'scene.submit_structure')).toBe(false);
        expect(params.continuation!.outputs[0]!.callId).toBe(index === 4 ? 'call-2' : 'call-6');
        if (index === 9) {
          expect(lastOutput(params).stageId).toBe(stageId);
          expect(lastOutput(params).rowVersion).toBe(savedVersion);
        }
        return tool('scene.structure.stage', {
          ...base,
          operation: 'get',
          ...(index === 9 ? { stageId } : {}),
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
            ...authoring(),
            bindings: {
              schemaVersion: 1,
              sceneDocumentIds: [f.setting.id],
              characterDocumentIds: [],
            },
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
      if (index === 8)
        return [
          {
            ...common,
            type: 'tool_call_end',
            call: {
              id: 'malformed-second',
              name: 'scene.structure.stage',
              argumentsJson: '{"invalid":',
            },
          },
          complete,
        ];
      if (index === 10)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'put_shots',
          stageId,
          expectedRowVersion: lastOutput(params).rowVersion,
          sceneIndex: 0,
          shotOffset: 0,
          shots: [{ title: '转身', ...authoring(true) }],
        });
      if (index === 11)
        return tool('scene.structure.stage', {
          ...base,
          operation: 'finalize',
          stageId,
          expectedRowVersion: lastOutput(params).rowVersion,
        });
      expect(index).toBe(12);
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
    expect(requests).toHaveLength(13);
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(f.content.listScenes()[0]!.id)).toHaveLength(1);
    expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(1);
    const detail = f.workflow.getTask({ taskId: run.agent.taskId });
    const failures = detail.events.filter((item) => item.eventType === 'tool_validation_failed');
    expect(failures).toHaveLength(3);
    expect(detail.events.filter((item) => item.eventType === 'scene.structure.saved')).toHaveLength(
      1,
    );
    expect(failures[0]!.summary).toContain('jsonError=syntax; line=10; column=42');
    expect(failures.every((item) => !item.summary.includes('PRIVATE_BODY'))).toBe(true);
    const tools = f.project.access(false, (db) =>
      db
        .prepare('SELECT tool_name FROM agent_tool_calls WHERE generation_id=?')
        .all(run.prepared.stream.generationId),
    ) as Array<{
      tool_name: string;
    }>;
    expect(tools.filter((item) => item.tool_name === 'library.read')).toHaveLength(1);
    expect(tools.some((item) => item.tool_name === 'scene.submit_structure')).toBe(false);
    const failedRequests = f.project.access(false, (db) =>
      db
        .prepare("SELECT id FROM llm_provider_requests WHERE generation_id=? AND stage='failed'")
        .all(run.prepared.stream.generationId),
    );
    expect(failedRequests).toHaveLength(3);
  },
);
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'recovers binding schema/JSON syntax failures without shrinking batches, preserving saved scenes and prompt text (%s)',
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
      prompt: prompts[index],
      bindings: {
        schemaVersion: 1 as const,
        characterDocumentIds: [actor.id],
        sceneDocumentIds: [f.setting.id],
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
            prompt: '完整场次提示词。',
            bindings: {
              schemaVersion: 1 as const,
              characterDocumentIds: [actor.id],
              sceneDocumentIds: [f.setting.id],
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
      const maxItems = (
        stage?.parameters.properties as Record<
          string,
          {
            maxItems: number;
          }
        >
      ).shots!.maxItems;
      if (index === 6) {
        const feedback = params.continuation!.outputs[0]!.output;
        expect(feedback).toContain('shots[0].camera');
        expect(feedback).toContain('prompt text, bindings and timing');
        expect(feedback).not.toContain('PRIVATE_BODY');
        expect(maxItems).toBe(4);
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
      expect(maxItems).toBe(4);
      if (index === 7) {
        expect(params.systemInstruction).toContain('at most 4 ordered shots');
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
    prompt: '保留原有提示词',
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
            shots: [],
            bindings: {
              schemaVersion: 1,
              sceneDocumentIds: [],
              characterDocumentIds: [],
            },
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
    expect.objectContaining({ id: scene.id, prompt: '保留原有提示词' }),
  ]);
});
it.each([
  [
    'INVALID_TOOL_ARGUMENTS: scene.submit_structure returned invalid object JSON (18610 bytes); finishReason=tool_calls. No tool was executed.',
    2,
  ],
  [
    'INCOMPLETE_PROVIDER_OUTPUT: finishReason=length; 1 tool calls, 18000 argument bytes. No tool was executed.',
    2,
  ],
  [
    'INCOMPLETE_TOOL_OUTPUT: finishReason=max_tokens. No tool was executed; use smaller staged submissions.',
    2,
  ],
  [
    'INCOMPLETE_PROVIDER_OUTPUT: finishReason=content_filter; 1 tool calls, 100 argument bytes. No tool was executed.',
    1,
  ],
  ['LLM stream ended before a protocol success event.', 1],
  ['Provider rejected the configured credential.', 1],
  ['STALE_SESSION: project switched.', 1],
] as const)(
  'stops repeated safe output failures and never retries other failures: %s',
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
    expect(failed.error).toContain(count === 2 ? 'AGENT_OUTPUT_REPAIR_STALLED' : message);
    expect(requests).toHaveLength(count);
    expect(f.content.listScenes()).toHaveLength(0);
    expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(0);
    const failures = f.workflow
      .getTask({ taskId: run.agent.taskId })
      .events.filter((item) => item.eventType === 'tool_validation_failed');
    expect(failures).toHaveLength(count === 2 ? 2 : 0);
  },
);
it('stops an identical malformed output while preserving the already saved scene stage', async () => {
  const f = await setup();
  const run = f.prepare('生成庭院镜头');
  const { bridge, requests } = scriptedBridge((params, index) => {
    const common = { projectSessionId: params.projectSessionId };
    const complete: NativeProviderHostEvent = {
      ...common,
      type: 'complete',
      providerResponseId: `repeat-${index}`,
      finishReason: 'tool_calls',
    };
    const tool = (name: string, args: Record<string, unknown>): NativeProviderHostEvent[] => [
      {
        ...common,
        type: 'tool_call_end',
        call: { id: `repeat-call-${index}`, name, argumentsJson: JSON.stringify(args) },
      },
      complete,
    ];
    if (index === 0) return tool('tools.load', { names: ['scene.structure.stage'] });
    if (index === 1)
      return tool('scene.structure.stage', {
        resourceId: 'workspace:shots',
        operation: 'begin',
        executionKey: 'repeat-output-stage',
        episodeTitle: '庭院',
        sceneShotCounts: [1],
      });
    if (index === 2) {
      const state = lastOutput(params);
      return tool('scene.structure.stage', {
        resourceId: 'workspace:shots',
        operation: 'put_scene',
        stageId: state.stageId,
        expectedRowVersion: state.rowVersion,
        sceneIndex: 0,
        scene: { title: '庭院', ...authoring() },
      });
    }
    if (index === 4)
      return tool('scene.structure.stage', {
        resourceId: 'workspace:shots',
        operation: 'get',
        stageId: lastOutput(params).stageId,
      });
    expect([3, 5]).toContain(index);
    return [
      {
        ...common,
        type: 'tool_call_end',
        call: {
          id: `repeat-malformed-${index}`,
          name: 'scene.structure.stage',
          argumentsJson: '{"operation":"put_shots","sceneIndex":0',
        },
      },
      complete,
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
  const failed = f.generations.get(run.prepared.stream.generationId);
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('AGENT_OUTPUT_REPAIR_STALLED');
  expect(failed.error).not.toContain('failureFingerprint=');
  expect(requests).toHaveLength(6);
  const stages = f.project.access(
    false,
    (db) =>
      db
        .prepare(
          'SELECT scenes_json FROM scene_structure_stages WHERE project_id=? AND conversation_id=?',
        )
        .all(run.prepared.stream.projectId, run.prepared.stream.conversationId) as Array<{
        scenes_json: string;
      }>,
  );
  expect(stages).toHaveLength(1);
  const [savedScene] = JSON.parse(stages[0]!.scenes_json) as Array<{
    scene?: {
      title?: string;
    };
    shots: Array<Record<string, unknown> | null>;
  }>;
  expect(savedScene!.scene?.title).toBe('庭院');
  expect(savedScene!.shots).toEqual([null]);
});
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
it.each([
  ['stage', false, false],
  ['submit', false, false],
  ['stage', true, false],
  ['submit', true, false],
  ['stage', true, true],
  ['submit', true, true],
] as const)(
  'saves ordinary scene text and explicit bindings without inheriting scene cast into shots (%s, %s, %s)',
  async (mode, withSceneBinding, explicitScopes) => {
    const f = await setup();
    const actor = f.content.saveDocument({
      kind: 'character',
      title: '演员',
      contentMarkdown: '角色资料',
    });
    const run = f.prepare('保存一场一镜，引用只绑定本镜出镜资料');
    const scene = {
      title: '庭院',
      ...authoring(),
      bindings: {
        schemaVersion: 1 as const,
        characterDocumentIds: explicitScopes ? [] : [actor.id],
        sceneDocumentIds: withSceneBinding && !explicitScopes ? [f.setting.id] : [],
      },
    };
    const bindings = {
      schemaVersion: 1 as const,
      characterDocumentIds: [actor.id],
      sceneDocumentIds: [f.setting.id],
      propDocumentIds: [],
    };
    const shots = [{ title: '一镜', ...authoring(true), bindings }];
    let result;
    if (mode === 'stage') {
      let state = await run.invoke('scene.structure.stage', {
        operation: 'begin',
        resourceId: 'workspace:shots',
        executionKey: 'modern',
        episodeTitle: '一场',
        sceneShotCounts: [1],
      });
      const base = { resourceId: 'workspace:shots', stageId: state.stageId, sceneIndex: 0 };
      state = await run.invoke('scene.structure.stage', { ...base, operation: 'put_scene', scene });
      result = await run.invoke('scene.structure.stage', {
        ...base,
        operation: 'put_shots',
        expectedRowVersion: state.rowVersion,
        shotOffset: 0,
        shots,
      });
    } else {
      result = await run.invoke('scene.submit_structure', {
        resourceId: 'workspace:shots',
        resolution: 'resolved',
        episodeTitle: '一场',
        scenes: [{ ...scene, shots }],
      });
    }
    expect(result.status, JSON.stringify(result)).toBe('scene_structure_saved');
    const savedScene = f.content.listScenes()[0]!;
    expect(f.content.listScenes()).toHaveLength(1);
    expect(f.content.listShots(savedScene.id)[0]?.bindings).toEqual(bindings);
    // Scene cast and shot cast are independently bound.
    expect(savedScene.characterBindings).toEqual(
      explicitScopes ? [] : [{ characterDocumentId: actor.id }],
    );
    f.project.access(false, (db) => {
      expect(
        db.prepare('SELECT scene_document_id FROM scenes WHERE id=?').get(savedScene.id),
      ).toEqual({ scene_document_id: withSceneBinding && !explicitScopes ? f.setting.id : null });
    });
  },
);
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
      ...authoring(),
      bindings: {
        schemaVersion: 1,
        sceneDocumentIds: [f.setting.id],
        characterDocumentIds: [],
      },
    },
  };
  state = await first.invoke('scene.structure.stage', setupArgs);
  expect(state.scenes).toEqual([
    expect.objectContaining({ setupSaved: true, setupStaged: true, saved: false }),
  ]);
  expect(f.content.listScenes()).toHaveLength(0);
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
    ...authoring(true),
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
  expect(state.scenes).toEqual([
    expect.objectContaining({
      setupStaged: true,
      saved: true,
      sceneId: state.sceneIds && (state.sceneIds as string[])[0],
    }),
  ]);
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
        ...authoring(),
        bindings: {
          schemaVersion: 1,
          sceneDocumentIds: [f.setting.id],
          characterDocumentIds: [],
        },
      },
    });
  };
  const putShot = async (sceneIndex: number, shotInstruction: PromptRecord) => {
    state = await run.invoke('scene.structure.stage', {
      ...base,
      operation: 'put_shots',
      stageId,
      expectedRowVersion: state.rowVersion,
      sceneIndex,
      shotOffset: 0,
      shots: [{ title: `镜头${sceneIndex + 1}`, ...shotInstruction }],
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
      shots: [{ title: '坏镜头', ...authoring(true), unknown: true }],
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
    shots: [{ title: '镜头2', ...authoring(true) }],
  });
  expect(state).toMatchObject({
    status: 'scene_structure_saved',
    complete: true,
    sceneIds: [firstSceneId, expect.any(String)],
  });
  expect(f.content.listScenes()).toHaveLength(2);
  expect(f.content.listShots(firstSceneId)).toHaveLength(1);
});
it('completes a request larger than one page in the same task without duplicates', async () => {
  const f = await setup();
  const counts = Array<number>(14).fill(8);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(112);
  const base = { resourceId: 'workspace:shots' };
  const run = f.prepare('生成 14 场 112 镜');
  const outputId = f.project.access(true, (db, p) =>
    new AgentExecutionStore(db).registerOutput(
      p.id,
      run.agent.taskId,
      'pages',
      'scene.structure.stage',
      14,
    ),
  );
  const allStageSceneIds: string[] = [];
  for (let page = 0; page < 2; page++) {
    const pageStart = page * 7;
    const pageCounts = counts.slice(pageStart, pageStart + 7);
    let state = await run.invoke('scene.structure.stage', {
      ...base,
      operation: 'begin',
      outputId,
      outputIndex: page,
      executionKey: `fourteen-scenes-page-${page + 1}`,
      episodeTitle: '14 场测试',
      sceneShotCounts: pageCounts,
    });
    const stageId = state.stageId as string;
    for (let sceneIndex = 0; sceneIndex < pageCounts.length; sceneIndex++) {
      const absoluteScene = pageStart + sceneIndex;
      state = await run.invoke('scene.structure.stage', {
        ...base,
        operation: 'put_scene',
        stageId,
        expectedRowVersion: state.rowVersion,
        sceneIndex,
        scene: {
          title: `场${absoluteScene + 1}`,
          ...authoring(),
          bindings: {
            schemaVersion: 1,
            sceneDocumentIds: [f.setting.id],
            characterDocumentIds: [],
          },
        },
      });
      for (let shotOffset = 0; shotOffset < pageCounts[sceneIndex]!; shotOffset += 4) {
        state = await run.invoke('scene.structure.stage', {
          ...base,
          operation: 'put_shots',
          stageId,
          expectedRowVersion: state.rowVersion,
          sceneIndex,
          shotOffset,
          shots: Array.from(
            { length: Math.min(4, pageCounts[sceneIndex]! - shotOffset) },
            (_, offset) => ({
              title: `场${absoluteScene + 1}镜${shotOffset + offset + 1}`,
              ...authoring(true),
            }),
          ),
        });
      }
    }
    expect(state).toMatchObject({ status: 'scene_structure_saved', complete: true });
    allStageSceneIds.push(...(state.sceneIds as string[]));
  }
  expect(allStageSceneIds).toHaveLength(14);
  f.loop.startProviderStep(run.prepared.stream);
  f.loop.completeProviderStep({ ...run.prepared.stream, finishReason: 'stop' });
  expect(f.workflow.getTask({ taskId: run.agent.taskId }).task.status).toBe('completed');
  const scenes = f.content.listScenes();
  expect(scenes).toHaveLength(14);
  expect(new Set(allStageSceneIds).size).toBe(14);
  expect(scenes.reduce((sum, scene) => sum + f.content.listShots(scene.id).length, 0)).toBe(112);
  expect(new ChangeSetService(f.project).list({ includeTerminal: true })).toHaveLength(14);
});
it('shares create/update validation, retains binding text, rejects conflicting text and preflights total/rendered limits', async () => {
  const f = await setup();
  const run = f.prepare('修订绑定');
  const current = f.content.saveScene({
    title: '旧场次',
    sceneDocumentId: f.setting.id,
    prompt: '手写原文标记',
    characterBindings: [],
  });
  const scene = {
    title: current.title,
    sceneId: current.id,
    expectedRowVersion: current.rowVersion,
    shots: [],
    bindings: {
      schemaVersion: 1,
      sceneDocumentIds: [f.setting.id],
      characterDocumentIds: [],
    },
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
  expect(f.content.listScenes()[0]!.prompt).toBe('手写原文标记');
  const shared = {
    title: '新场次',
    ...authoring(),
    shots: [{ title: '镜头', ...authoring(true) }],
  };
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '冲突',
        scenes: [{ ...shared, unexpectedCreativeField: '正文专属不可丢失' }],
      }),
    ),
  ).toThrow('unsupported field');
  const invalid = authoring(true);
  Reflect.deleteProperty(invalid, 'prompt');
  expect(() =>
    parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '漏字段',
        scenes: [{ ...shared, shots: [{ title: '镜头', ...invalid }] }],
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
        scenes: [{ ...shared, shots: [{ title: '镜头', ...huge }] }],
      }),
    ),
  ).toThrow('20000');
});
it.each(['document.submit_draft', 'tools.load'])(
  'allows distinct Pi argument repairs for %s and records them without charging tool calls',
  async (operation) => {
    const f = await setup();
    const run = f.prepare('检查项目文档');
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    const body = { contentMarkdown: 'PRIVATE_BODY'.repeat(10000) };
    const repairs =
      operation === 'document.submit_draft'
        ? [
            body,
            { ...body, title: '修正标题' },
            { ...body, title: '修正标题', resourceId: 'workspace:documents' },
            {
              ...body,
              title: '修正标题',
              resourceId: 'workspace:documents',
              documentKind: 'script',
            },
          ]
        : [
            body,
            { names: [] },
            { names: [42] },
            {
              names: [
                'conversation.ask',
                'conversation.task.route',
                'conversation.task.checkpoint',
                'project.structure.get',
                'library.search',
                'library.read',
                'document.submit_draft',
                'document.submit_draft',
              ],
            },
          ];
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['document.submit_draft'] }, { id: 'load' })],
        { stopReason: 'toolUse', responseId: 'load' },
      ),
      ...repairs.map((args, index) =>
        fauxAssistantMessage([fauxToolCall(operation, args, { id: `bad-${index}` })], {
          stopReason: 'toolUse',
          responseId: `bad-${index}`,
        }),
      ),
      fauxAssistantMessage('已检查，暂无需要更改。', {
        stopReason: 'stop',
        responseId: 'final',
      }),
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
      prompt: '检查项目文档',
      mode: 'document',
    });
    await runtime.wait(run.prepared.stream.generationId);
    const completed = f.generations.get(run.prepared.stream.generationId);
    expect(completed.status, completed.error).toBe('complete');
    const rows = f.project.access(false, (db) =>
      db
        .prepare(
          "SELECT summary FROM agent_task_events WHERE task_id=? AND event_type='tool_validation_failed'",
        )
        .all(run.agent.taskId),
    ) as Array<{
      summary: string;
    }>;
    expect(rows).toHaveLength(4);
    expect(
      rows.every((row) => row.summary.length < 2000 && !row.summary.includes('PRIVATE_BODY')),
    ).toBe(true);
    expect(
      (
        JSON.parse(rows[0]!.summary) as {
          argumentBytes: number;
        }
      ).argumentBytes,
    ).toBeGreaterThan(100000);
    expect(
      f.project.access(false, (db) =>
        db
          .prepare(
            `SELECT usage.tool_call_count, tasks.turn_count, tasks.quota_state
             FROM agent_tasks tasks JOIN agent_task_usage_counters usage ON usage.task_id=tasks.id
             WHERE tasks.id=?`,
          )
          .get(run.agent.taskId),
      ),
    ).toEqual({ tool_call_count: 0, turn_count: 6, quota_state: 'active' });
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
            .get(first.prepared.stream.generationId) as {
            version: number;
          }
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
    rationale: '核对指定任务的实际保存结果。',
    targetGenerationId: first.prepared.stream.generationId,
  });
  expect(result).toMatchObject({
    status: 'inspected',
    targetStatus: 'cancelled',
    targetRequest: '重新生成场次',
    inspectionSummary: {
      taskId: first.agent.taskId,
      status: 'cancelled',
      saved: { scenes: 0, shots: 0 },
    },
    historyPage: { offset: 0, complete: true },
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
  ) as {
    generation_id: string;
    stage: string;
    metadata_json: string;
  };
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
  ) as Array<{
    id: string;
    stage: string;
    metadata_json: string;
  }>;
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
