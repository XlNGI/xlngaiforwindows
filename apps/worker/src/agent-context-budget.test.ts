import { describe, expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { LlmGenerationRuntimeRequest } from '@ai-video/contracts';
import { AgentContextBudget, assertNoReadLoop, isWorkBoundary } from './agent-context-budget.js';
import { conservativeModelCapabilities } from './model-context-policy.js';
import { RepeatedReadResults } from './repeated-read-results.js';
import {
  decodeProductionHistory,
  productionContextResults,
} from './test-fixtures/production-context.js';
it('counts new review coverage and issue closure once, independent of assessment prose', () => {
  const seen = new Set<string>();
  const entry = (result: unknown) => ({
    role: 'toolResult',
    toolName: 'conversation.task.checkpoint',
    content: JSON.stringify(result),
  });
  const review = {
    status: 'task_review_recorded',
    protocolVersion: 3,
    coverage: [{ id: 'shot', key: 'v1', dependencyHash: 'd1' }],
    resolutions: [],
  };
  expect(isWorkBoundary(entry(review), seen)).toBe(true);
  expect(
    isWorkBoundary(entry({ ...review, summary: 'another wording', assessmentId: 'new' }), seen),
  ).toBe(false);
  expect(
    isWorkBoundary(
      entry({ ...review, coverage: [{ id: 'shot2', key: 'v1', dependencyHash: 'd1' }] }),
      seen,
    ),
  ).toBe(true);
  const closed = { ...review, resolutions: [{ issueId: 'issue', disposition: 'withdrawn' }] };
  expect(isWorkBoundary(entry(closed), seen)).toBe(true);
  expect(isWorkBoundary(entry({ ...closed, summary: 'repeat' }), seen)).toBe(false);
  expect(isWorkBoundary(entry({ status: 'task_plan_saved', contractHash: 'same' }), seen)).toBe(
    true,
  );
  expect(
    isWorkBoundary(
      entry({ status: 'task_plan_saved', contractHash: 'same', revisionReason: 'new prose' }),
      seen,
    ),
  ).toBe(false);
  expect(
    isWorkBoundary(entry({ status: 'task_checkpoint_saved', checkpointId: 'arbitrary' }), seen),
  ).toBe(false);
});
it.each([4, 5])(
  'recognizes durable v%s review coverage but never counts citation errors as saved work',
  (protocolVersion) => {
    const entry = (result: unknown) => ({
      role: 'toolResult',
      toolName: 'conversation.task.checkpoint',
      content: JSON.stringify(result),
    });
    const result = {
      status: 'task_review_recorded',
      protocolVersion,
      coverage: [],
      resolutions: [],
      issues: [{ evidenceStatus: 'needs_correction' }],
    };
    const seen = new Set<string>();
    expect(isWorkBoundary(entry(result), seen)).toBe(false);
    const approved = {
      ...result,
      issues: [],
      coverage: [{ id: 'shot', key: 'v1', dependencyHash: 'd1' }],
    };
    expect(isWorkBoundary(entry(approved), seen)).toBe(true);
    expect(isWorkBoundary(entry(approved), seen)).toBe(false);
  },
);
it('groups the same chapter parameter failure even when candidate prose changes', () => {
  const fail = (i: number): Context['messages'] => [
    fauxAssistantMessage(
      [
        fauxToolCall(
          'novel.chapter.write_draft',
          {
            action: 'create_chapter',
            resourceId: 'workspace:novel',
            baseVersionId: null,
            title: `标题${i}`,
            contentMarkdown: `不同的完整候选${i}`,
          },
          { id: `c${i}` },
        ),
      ],
      { stopReason: 'toolUse' },
    ),
    {
      role: 'toolResult',
      toolName: 'novel.chapter.write_draft',
      toolCallId: `c${i}`,
      content: [
        {
          type: 'text',
          text: 'CHAPTER_ARGUMENT_INVALID: action=create_chapter field=baseVersionId forbidden',
        },
      ],
      isError: true,
      timestamp: 1,
    },
  ];
  expect(() => assertNoReadLoop({ messages: [0, 1, 2].flatMap(fail) })).not.toThrow();
  expect(() => assertNoReadLoop({ messages: [0, 1, 2, 3].flatMap(fail) })).toThrow(
    'AGENT_TOOL_FAILURE_STALLED',
  );
});
it('stops identical failed calls but allows corrections, new evidence, user steering and saved progress', () => {
  const failed = (id: string, args = { operation: 'save' }): Context['messages'] => [
    fauxAssistantMessage([fauxToolCall('conversation.task.checkpoint', args, { id })], {
      stopReason: 'toolUse',
    }),
    {
      role: 'toolResult',
      toolName: 'conversation.task.checkpoint',
      toolCallId: id,
      content: [{ type: 'text', text: 'workingNotes is required' }],
      isError: true,
      timestamp: 1,
    },
  ];
  const context: Context = {
    messages: [
      { role: 'user', content: '保存剧本', timestamp: 0 },
      ...[0, 1, 2].flatMap((i) => failed(String(i))),
    ],
  };
  expect(() => assertNoReadLoop(context)).not.toThrow();
  expect(() => assertNoReadLoop({ messages: [...context.messages, ...failed('four')] })).toThrow(
    'AGENT_TOOL_FAILURE_STALLED',
  );
  expect(() =>
    assertNoReadLoop({
      messages: [...context.messages, ...failed('repair', { operation: 'partial' })],
    }),
  ).not.toThrow();
  for (const progress of [
    { role: 'user', content: '请保留对白', timestamp: 2 },
    {
      role: 'toolResult',
      toolName: 'document.submit_draft',
      toolCallId: 'saved',
      content: [
        {
          type: 'text',
          text: '{"status":"draft_saved","documentId":"actual","documentVersionId":"v2"}',
        },
      ],
      isError: false,
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolName: 'library.read',
      toolCallId: 'read',
      content: [
        {
          type: 'text',
          text: '{"status":"read","sourceType":"document","sourceId":"new","versionId":"v2","sourceStatus":"draft","content":"新证据"}',
        },
      ],
      isError: false,
      timestamp: 2,
    },
  ] satisfies Context['messages']) {
    expect(() =>
      assertNoReadLoop({ messages: [...context.messages, progress, ...failed('after')] }),
    ).not.toThrow();
  }
});
it('does not mistake rewritten checkpoint prose for fixing the same missing field', () => {
  const context: Context = { messages: [{ role: 'user', content: '保存剧本', timestamp: 0 }] };
  for (let i = 0; i < 4; i++)
    context.messages.push(
      fauxAssistantMessage(
        [
          fauxToolCall(
            'conversation.task.checkpoint',
            { operation: 'save', remainingWork: `第${i}次重新说明剩余工作` },
            { id: `bad-${i}` },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      {
        role: 'toolResult',
        toolName: 'conversation.task.checkpoint',
        toolCallId: `bad-${i}`,
        content: [{ type: 'text', text: 'workingNotes is required' }],
        isError: true,
        timestamp: i + 1,
      },
    );
  expect(() => assertNoReadLoop(context)).toThrow('AGENT_TOOL_FAILURE_STALLED');
});
it.each([
  {
    name: 'missing notes',
    tool: 'conversation.task.checkpoint',
    before: { operation: 'save', remainingWork: '完成剧本' },
    after: { operation: 'save', remainingWork: '完成剧本', workingNotes: '源版本 v1' },
  },
  {
    name: 'oversized notes',
    tool: 'conversation.task.checkpoint',
    before: { operation: 'save', remainingWork: '完成剧本', workingNotes: 'x'.repeat(6001) },
    after: { operation: 'save', remainingWork: '完成剧本', workingNotes: '源版本 v1' },
  },
  {
    name: 'new target',
    tool: 'conversation.task.checkpoint',
    before: { operation: 'plan', deliverables: [{ targetIds: ['doc-a'] }] },
    after: { operation: 'plan', deliverables: [{ targetIds: ['doc-b'] }] },
  },
  {
    name: 'fresh version',
    tool: 'scene.update_shot_prompts',
    before: { shots: [{ shotId: 'shot-a', expectedRowVersion: 1 }] },
    after: { shots: [{ shotId: 'shot-a', expectedRowVersion: 2 }] },
  },
  {
    name: 'corrected business body',
    tool: 'document.submit_draft',
    before: { contentMarkdown: '旧正文' },
    after: { contentMarkdown: '修正后的正文' },
  },
])('preserves a repair opportunity for $name', ({ tool, before, after }) => {
  const context: Context = { messages: [] };
  for (let i = 0; i < 4; i++)
    context.messages.push(
      fauxAssistantMessage([fauxToolCall(tool, i < 3 ? before : after, { id: String(i) })], {
        stopReason: 'toolUse',
      }),
      {
        role: 'toolResult',
        toolName: tool,
        toolCallId: String(i),
        content: [{ type: 'text', text: 'the same failure' }],
        isError: true,
        timestamp: i,
      },
    );
  expect(() => assertNoReadLoop(context)).not.toThrow();
});
function fixture(protocol: LlmGenerationRuntimeRequest['protocol']) {
  const original = JSON.stringify({
    status: 'read',
    sourceId: 'doc',
    versionId: 'v1',
    sourceStatus: 'draft',
    sourceType: 'document',
    contentHash: 'saved-hash',
    startOffset: 0,
    endOffset: 12000,
    locked: { content: '锁定的约束完整保留'.repeat(250) },
    content: '已读取正文'.repeat(2400),
  });
  const outputs = [
    { callId: 'old', output: original },
    { callId: 'middle', output: '{"manualEdit":"蓝色衣服"}' },
    { callId: 'last', output: '{"savedId":"real-shot","rowVersion":7}' },
  ];
  const messages: Context['messages'] = [
    { role: 'user', content: '手动修改必须保留，继续未完成工作', timestamp: 0 },
  ];
  for (const output of outputs)
    messages.push(
      fauxAssistantMessage(
        [fauxToolCall('library.read', { sourceHandle: 'real-handle' }, { id: output.callId })],
        { stopReason: 'toolUse' },
      ),
      {
        role: 'toolResult',
        toolCallId: output.callId,
        toolName: 'library.read',
        content: [{ type: 'text', text: output.output }],
        isError: false,
        timestamp: 0,
      },
    );
  const runtime: LlmGenerationRuntimeRequest = {
    generationId: 'g',
    attemptId: 'a',
    projectId: 'p',
    projectSessionId: 's',
    conversationId: 'c',
    providerProfileId: 'provider',
    modelId: 'm',
    remoteModelId: 'm',
    protocol,
    baseUrl: 'https://mock.invalid',
    systemInstruction: 'Respect user edits and actual tool results.',
    context: '',
    prompt: '用户要求完整保留',
    contextWindowTokens: 10000,
    contextWindowSource: 'contract',
    continuation:
      protocol === 'openai-responses'
        ? { protocol, previousResponseId: 'old-chain', outputs: [outputs[2]!] }
        : {
            protocol,
            providerResponseId: 'response',
            history: [
              {
                calls: [{ id: 'old', name: 'library.read', argumentsJson: '{}' }],
                outputs: [outputs[0]!],
              },
              {
                calls: [{ id: 'middle', name: 'library.read', argumentsJson: '{}' }],
                outputs: [outputs[1]!],
              },
            ],
            calls: [{ id: 'last', name: 'library.read', argumentsJson: '{}' }],
            outputs: [outputs[2]!],
          },
  };
  return {
    runtime,
    context: { systemPrompt: runtime.systemInstruction, messages } satisfies Context,
    original,
    outputs,
  };
}
describe('AgentContextBudget', () => {
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'preserves the requested output allowance for unknown %s models, including legacy fallback metadata',
    (protocol) => {
      const f = fixture(protocol);
      const capabilities = conservativeModelCapabilities('unknown');
      expect(capabilities.maxOutputTokens).toBeUndefined();
      f.runtime.modelCapabilities = { ...capabilities, maxOutputTokens: 16000 };
      f.runtime.contextWindowSource = 'fallback';
      f.runtime.contextWindowTokens = capabilities.contextWindow;
      f.runtime.inferenceSettings = {
        maxOutputTokens: 80000,
        outputTokenParameter: protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
        reasoning: 'provider_default',
      };
      const budget = new AgentContextBudget();
      expect(budget.inspect(f.runtime, f.context).reservedOutputTokens).toBe(80000);
      expect(budget.prepare(f.runtime, f.context).request.inferenceSettings?.maxOutputTokens).toBe(
        80000,
      );
      expect(budget.lastInfo?.limitEnforcement).toBe('advisory_fallback');
      f.runtime.modelCapabilities.capabilitySource = 'manual_config';
      expect(
        new AgentContextBudget().prepare(f.runtime, f.context).request.inferenceSettings
          ?.maxOutputTokens,
      ).toBeLessThanOrEqual(16000);
    },
  );
  it.each([
    'values',
    'large-anchor',
    'error',
    'reference-collision',
    'fragment',
    'call-id-collision',
  ] as const)('retains exact production values and safe reference targets (%s)', (variant) => {
    const f = fixture('openai-chat-completions');
    const asset = { assetId: 'selected', label: '完整的相同资料说明'.repeat(50), missing: null };
    const root = {
      status: 'read',
      target: { kind: 'shot', id: 'shot-a' },
      version: 'a'.repeat(64),
      rowVersion: 1,
      view: 'media',
      media: {
        ...(variant === 'large-anchor' ? { facts: { content: 'x'.repeat(40000) } } : {}),
        'bindings/~original': {
          selectedAsset: asset,
          candidateAssets: [asset, { ...asset, assetId: 'candidate' }],
        },
        order: [2, 1, 2],
      },
    };
    const altered = {
      ...root,
      target: { kind: 'shot', id: 'shot-b' },
      rowVersion: 2,
      media: { ...root.media, order: [1, 2, 1] },
      ...(variant === 'reference-collision' ? { opaque: { $ref: 'source-data' } } : {}),
      ...(variant === 'fragment'
        ? { contentPage: { format: 'json', text: JSON.stringify(root.media).slice(0, 200) } }
        : {}),
    };
    const outputs = [root, altered, { status: 'ready' }, { status: 'ready' }].map((result, i) => ({
      callId: variant === 'call-id-collision' && i === 0 ? 'first#ambiguous' : `call-${i}`,
      output: JSON.stringify(result),
    }));
    f.runtime.contextWindowTokens = 64000;
    f.runtime.systemInstruction = 's'.repeat(160000);
    f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
    for (const [i, output] of outputs.entries())
      f.context.messages.push(
        fauxAssistantMessage([fauxToolCall('production.read', {}, { id: output.callId })], {
          stopReason: 'toolUse',
        }),
        {
          role: 'toolResult',
          toolCallId: output.callId,
          toolName: 'production.read',
          content: [{ type: 'text', text: output.output }],
          isError: variant === 'error' && i === 0,
          timestamp: i,
        },
      );
    f.runtime.continuation = {
      protocol: 'openai-chat-completions',
      providerResponseId: 'chain',
      calls: [],
      outputs: [],
      history: outputs.map((output) => ({
        calls: [{ id: output.callId, name: 'production.read', argumentsJson: '{}' }],
        outputs: [output],
      })),
    };
    const original = structuredClone(f);
    const prepared = new AgentContextBudget().prepare(f.runtime, f.context);
    if (prepared.request.continuation?.protocol !== 'openai-chat-completions')
      throw new Error('fixture');
    const sent = [...prepared.request.continuation.history!, prepared.request.continuation].flatMap(
      (turn) => turn.outputs,
    );
    expect([...decodeProductionHistory(sent).values()]).toEqual([
      root,
      altered,
      { status: 'ready' },
      { status: 'ready' },
    ]);
    if (variant === 'values' || variant === 'large-anchor') {
      expect(sent[1]!.output).toContain('lossless_references');
      expect(sent[1]!.output).toContain('bindings~1~0original');
    } else expect(sent[1]!.output).not.toContain('lossless_references');
    expect(f).toEqual(original);
  });
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'losslessly reuses production metadata across %s reads before sacrificing write output',
    (protocol) => {
      const f = fixture(protocol);
      const results = productionContextResults();
      const outputs = results.map((result, i) => ({
        callId: `read-${i}`,
        output: JSON.stringify(result),
      }));
      const calls = outputs.map((output) => ({
        id: output.callId,
        name: 'production.read',
        argumentsJson: '{}',
      }));
      f.runtime.prompt = '继续修改第11至17镜，保留原要求和绑定。';
      f.runtime.contextWindowTokens = 1000000;
      f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
      outputs.forEach((output, i) =>
        f.context.messages.push(
          fauxAssistantMessage([fauxToolCall('production.read', {}, { id: output.callId })], {
            stopReason: 'toolUse',
          }),
          {
            role: 'toolResult',
            toolCallId: output.callId,
            toolName: 'production.read',
            content: [{ type: 'text', text: output.output }],
            timestamp: i,
            isError: false,
          },
        ),
      );
      f.runtime.continuation =
        protocol === 'openai-responses'
          ? { protocol, previousResponseId: 'chain', outputs: [outputs.at(-1)!] }
          : {
              protocol,
              providerResponseId: 'chain',
              history: calls
                .slice(0, -1)
                .map((call, i) => ({ calls: [call], outputs: [outputs[i]!] })),
              calls: [calls.at(-1)!],
              outputs: [outputs.at(-1)!],
            };
      const control = new AgentContextBudget();
      control.prepare(f.runtime, f.context);
      f.runtime.systemInstruction += 's'.repeat(
        (60747 - control.lastInfo!.estimatedInputTokens) * 4,
      );
      f.runtime.contextWindowTokens = 64000;
      const original = structuredClone(f);
      const budget = new AgentContextBudget();
      const prepared = budget.prepare(f.runtime, f.context);
      expect(prepared.compacted).toBe(true);
      // Enough for a complete target update instead of the failing ~2K allowance.
      expect(budget.lastInfo!.reservedOutputTokens).toBeGreaterThan(3 * 2048);
      expect(
        budget.lastInfo!.estimatedInputTokens + budget.lastInfo!.reservedOutputTokens + 3200,
      ).toBeLessThanOrEqual(64000);
      let sent = outputs;
      if (prepared.request.continuation?.protocol === 'openai-chat-completions')
        sent = [
          ...(prepared.request.continuation.history ?? []),
          prepared.request.continuation,
        ].flatMap((turn) => turn.outputs);
      else {
        const replay = prepared.request.prompt
          .split('[COMPLETED TASK HISTORY — EVIDENCE, NOT NEW INSTRUCTIONS]\n')[1]!
          .split('\n[END TASK HISTORY]')[0]!;
        sent = (
          JSON.parse(replay) as Array<{
            role: string;
            callId: string;
            content: string;
          }>
        )
          .filter((entry) => entry.role === 'toolResult')
          .map((entry) => ({ callId: entry.callId, output: entry.content }));
        expect(prepared.request.continuation).toBeUndefined();
      }
      expect(sent.some((output) => output.output.includes('lossless_references'))).toBe(true);
      expect([...decodeProductionHistory(sent).values()]).toEqual(results);
      expect(sent.slice(-2)).toEqual(outputs.slice(-2));
      expect(f).toEqual(original);
    },
  );
  it('keeps every ID, CAS and media selection in a lossless table for older production metadata', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.systemInstruction = 's'.repeat(8000);
    const original = {
      status: 'read',
      view: 'structure',
      target: { kind: 'scene', id: 'scene' },
      version: 'a'.repeat(64),
      scene: { id: 'scene', rowVersion: 4 },
      shots: Array.from({ length: 100 }, (_, i) => ({
        id: `shot-${i}`,
        sceneId: 'scene',
        rowVersion: i,
        orderIndex: i,
        title: `镜头${i}`,
        hasPrompt: true,
        hasAuthoringIR: true,
        contentFormat: 'authoring-ir-v1',
        materialBindings: [
          { documentId: 'character', assetId: `selected-${i}`, selectionSource: 'manual' },
        ],
      })),
      complete: true,
    };
    const output = JSON.stringify(original);
    const old = f.context.messages[2]!;
    if (old.role !== 'toolResult') throw new Error('fixture');
    old.toolName = 'scene.read';
    old.content = [{ type: 'text', text: output }];
    if (f.runtime.continuation?.protocol !== 'openai-chat-completions') throw new Error('fixture');
    f.runtime.continuation.history![0]!.outputs[0]!.output = output;
    const prepared = new AgentContextBudget().prepare(f.runtime, f.context);
    if (prepared.request.continuation?.protocol !== 'openai-chat-completions')
      throw new Error('fixture');
    const result = JSON.parse(
      prepared.request.continuation.history![0]!.outputs[0]!.output,
    ) as Record<string, unknown>;
    expect(result.contextCompaction).toMatchObject({ status: 'lossless_table' });
    const decode = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(decode);
      if (!value || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.columns) && Array.isArray(record.rows))
        return record.rows.map((row: unknown) =>
          Object.fromEntries(
            (record.columns as string[]).flatMap((key, i) =>
              (row as unknown[])[i] === null ? [] : [[key, decode((row as unknown[])[i])]],
            ),
          ),
        );
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decode(child)]));
    };
    delete result.contextCompaction;
    expect(decode(result)).toEqual(original);
  });
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'recovers old versioned production bodies safely in %s without dropping CAS or locked data',
    (protocol) => {
      const f = fixture(protocol);
      const old = f.context.messages[2]!;
      if (old.role !== 'toolResult') throw new Error('fixture');
      old.toolName = 'production.read';
      const output = JSON.stringify({
        status: 'read',
        view: 'authoring',
        target: { kind: 'shot', id: 'real-shot' },
        sceneId: 'real-scene',
        shotId: 'real-shot',
        rowVersion: 2,
        version: 'a'.repeat(64),
        authoring: {
          prompt: '用户锁定事实'.repeat(400) + '已读镜头正文'.repeat(3500),
        },
        complete: true,
      });
      old.content = [{ type: 'text', text: output }];
      if (f.runtime.continuation?.protocol === 'openai-chat-completions')
        f.runtime.continuation.history![0]!.outputs[0]!.output = output;
      const budget = new AgentContextBudget();
      const prepared = budget.prepare(f.runtime, f.context);
      const text = JSON.stringify(prepared.request);
      expect(text).toContain('reread_required');
      expect(text).toContain('real-shot');
      expect(text).toContain('real-scene');
      expect(text).toContain('a'.repeat(64));
      expect(text).toContain('reread_required');
      expect(text).not.toContain('已读镜头正文'.repeat(100));
      expect(old.content[0]).toEqual({ type: 'text', text: output });
    },
  );
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'preserves exact saved shot receipts and recent results when compacting %s write arguments',
    (protocol) => {
      const f = fixture(protocol);
      f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
      const calls = Array.from({ length: 4 }, (_, i) => ({
        id: `save-${i}`,
        name: 'scene.update_shot_prompts',
        argumentsJson: JSON.stringify({
          shots: [
            {
              shotId: `shot-${i}`,
              expectedRowVersion: 1,
              ...{ prompt: '完整镜头要求'.repeat(1800) },
            },
          ],
        }),
      }));
      const outputs = calls.map((call, i) => ({
        callId: call.id,
        output: JSON.stringify({
          status: 'shot_prompts_saved',
          executionId: `execution-${i}`,
          changedCount: 1,
          unchangedCount: 0,
          sceneIds: ['real-scene'],
          shots: [{ shotId: `shot-${i}`, sceneId: 'real-scene', rowVersion: 2, changed: true }],
          paidRequests: 0,
          ...(i < 2 ? { verbose: '已经保存的重复内容'.repeat(600) } : {}),
        }),
      }));
      calls.forEach((call, i) =>
        f.context.messages.push(
          fauxAssistantMessage(
            [
              fauxToolCall(call.name, JSON.parse(call.argumentsJson) as Record<string, unknown>, {
                id: call.id,
              }),
            ],
            { stopReason: 'toolUse' },
          ),
          {
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: outputs[i]!.output }],
            isError: false,
            timestamp: i,
          },
        ),
      );
      f.runtime.continuation =
        protocol === 'openai-responses'
          ? { protocol, previousResponseId: 'chain', outputs: [outputs[3]!] }
          : {
              protocol,
              providerResponseId: 'chain',
              history: calls
                .slice(0, -1)
                .map((call, i) => ({ calls: [call], outputs: [outputs[i]!] })),
              calls: [calls[3]!],
              outputs: [outputs[3]!],
            };
      const original = structuredClone(f.context);
      const prepared = new AgentContextBudget().prepare(f.runtime, f.context);
      const serialized = JSON.stringify(prepared.request);
      for (let i = 0; i < 4; i++) {
        expect(serialized).toContain(`execution-${i}`);
        expect(serialized).toContain(`shot-${i}`);
      }
      if (prepared.request.continuation?.protocol === 'openai-chat-completions') {
        const result = prepared.request.continuation;
        const received = [
          ...(result.history ?? []).flatMap((turn) => turn.outputs),
          ...result.outputs,
        ];
        expect(received.slice(-2)).toEqual(outputs.slice(-2));
        expect(JSON.parse(received[0]!.output)).toMatchObject({
          persisted: {
            executionId: 'execution-0',
            changedCount: 1,
            unchangedCount: 0,
            paidRequests: 0,
            shots: [{ shotId: 'shot-0', sceneId: 'real-scene', rowVersion: 2, changed: true }],
          },
        });
      } else {
        expect(prepared.request.prompt).toContain(outputs[3]!.output.replaceAll('"', '\\"'));
      }
      expect(serialized).not.toContain('完整镜头要求'.repeat(50));
      expect(f.context).toEqual(original);
    },
  );
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'keeps three needed %s source bodies that fit instead of rotating the oldest out at the soft threshold',
    (protocol) => {
      const f = fixture(protocol);
      const bodies = [5918, 6109, 4703].map((length, i) =>
        `提示词${i}`.repeat(length).slice(0, length),
      );
      const outputs = bodies.map((content, i) => ({
        callId: `source-${i}`,
        output: JSON.stringify({
          status: 'read',
          sourceId: `doc-${i}`,
          versionId: 'v1',
          sourceType: 'document',
          sourceStatus: 'draft',
          readMode: 'source',
          startOffset: 0,
          endOffset: content.length,
          truncated: false,
          content,
        }),
      }));
      f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
      const calls = outputs.map((output) => ({
        id: output.callId,
        name: 'library.read',
        argumentsJson: '{}',
      }));
      for (const output of outputs)
        f.context.messages.push(
          fauxAssistantMessage([fauxToolCall('library.read', {}, { id: output.callId })], {
            stopReason: 'toolUse',
          }),
          {
            role: 'toolResult',
            toolName: 'library.read',
            toolCallId: output.callId,
            content: [{ type: 'text', text: output.output }],
            isError: false,
            timestamp: 0,
          },
        );
      f.runtime.contextWindowTokens = 100000;
      const control = new AgentContextBudget();
      control.prepare(f.runtime, f.context);
      f.runtime.systemInstruction += 's'.repeat(
        (40000 - control.lastInfo!.estimatedInputTokens) * 4,
      );
      f.runtime.contextWindowTokens = 64000;
      f.runtime.continuation =
        protocol === 'openai-responses'
          ? { protocol, previousResponseId: 'three-read', outputs }
          : { protocol, providerResponseId: 'three-read', calls, outputs };
      const budget = new AgentContextBudget();
      const original = structuredClone(f);
      expect(budget.prepare(f.runtime, f.context).compacted).toBe(false);
      expect(budget.lastInfo!.compactionCount).toBe(0);
      expect(f).toEqual(original);
      expect(budget.prepare(f.runtime, f.context).request.continuation).toEqual(
        f.runtime.continuation,
      );
    },
  );
  it('stops unchanged repeated reads before dispatch, but allows pagination, version changes and explicit new work', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = 100000;
    f.runtime.continuation = undefined;
    f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
    const append = (i: number, version = 'v1', offset = 0) =>
      f.context.messages.push({
        role: 'toolResult',
        toolName: 'library.read',
        toolCallId: `read-${i}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'read',
              sourceId: 'doc',
              versionId: version,
              sourceType: 'document',
              sourceStatus: 'draft',
              sourceHandle: `new-${i}`,
              citationLabel: `L${i}`,
              startOffset: offset,
              endOffset: offset + 3000,
              content: '正文'.repeat(1500),
            }),
          },
        ],
        isError: false,
        timestamp: i,
      });
    for (let i = 0; i < 3; i++) append(i);
    const budget = new AgentContextBudget();
    expect(() => budget.prepare(f.runtime, f.context)).not.toThrow();
    append(3);
    expect(() => budget.prepare(f.runtime, f.context)).toThrow('AGENT_REPEATED_READ_STALLED');
    f.context.messages.push({ role: 'user', content: '请再核对同一份原文', timestamp: 4 });
    append(4);
    expect(() => budget.prepare(f.runtime, f.context)).not.toThrow();
    for (let i = 5; i < 15; i++) append(i, i % 2 ? 'v2' : 'v1', i * 3000);
    expect(() => budget.prepare(f.runtime, f.context)).not.toThrow();
  });
  it.each([false, true])(
    'counts short duplicate references and resets only on successful saved progress (saved=%s)',
    (saved) => {
      const f = fixture('openai-chat-completions');
      f.runtime.contextWindowTokens = 100000;
      f.runtime.continuation = undefined;
      f.context.messages = [];
      const reuse = new RepeatedReadResults();
      const add = (id: string, toolName: string, output: string, isError = false) =>
        f.context.messages.push({
          role: 'toolResult',
          toolCallId: id,
          toolName,
          content: [{ type: 'text', text: output }],
          isError,
          timestamp: 0,
        });
      for (let i = 0; i < 3; i++) add(`r${i}`, 'library.read', reuse.use(`r${i}`, f.original));
      add('load', 'tools.load', '{"status":"tools_loaded"}');
      add('save', 'document.submit_draft', '{"status":"draft_saved","documentId":"saved"}', !saved);
      add('r3', 'library.read', reuse.use('r3', f.original));
      const run = () => new AgentContextBudget().prepare(f.runtime, f.context);
      if (saved) expect(run).not.toThrow();
      else expect(run).toThrow('AGENT_REPEATED_READ_STALLED');
    },
  );
  it.each([
    { name: 'document.update_draft', result: { status: 'draft_saved', documentId: 'doc' } },
    {
      name: 'scene.structure.stage',
      result: {
        status: 'scene_structure_staging',
        stageId: 'stage',
        rowVersion: 2,
        stageOperation: 'put_shots',
      },
    },
    {
      name: 'media.image.prepare',
      result: { status: 'succeeded', taskId: 'image-job', resultAssetIds: ['asset'] },
    },
  ])(
    'recognizes real $name progress but does not reset for an identical repeated receipt',
    ({ name, result }) => {
      const f = fixture('openai-chat-completions');
      f.runtime.contextWindowTokens = 100000;
      f.runtime.continuation = undefined;
      f.context.messages = [];
      let ordinal = 0;
      const add = (toolName: string, value: unknown) =>
        f.context.messages.push({
          role: 'toolResult',
          toolCallId: `progress-${ordinal++}`,
          toolName,
          content: [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
          ],
          isError: false,
          timestamp: 0,
        });
      add(name, result);
      for (let i = 0; i < 3; i++) add('library.read', f.original);
      const budget = new AgentContextBudget();
      expect(() => budget.prepare(f.runtime, f.context)).not.toThrow();
      add(name, result);
      add('library.read', f.original);
      expect(() => budget.prepare(f.runtime, f.context)).toThrow('AGENT_REPEATED_READ_STALLED');
      add(name, { ...result, rowVersion: 3, taskId: 'new-job', documentVersionId: 'new-version' });
      expect(() => budget.prepare(f.runtime, f.context)).not.toThrow();
    },
  );
  it('does not count a repeated stage get as saved progress', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = 100000;
    f.runtime.continuation = undefined;
    f.context.messages = [];
    for (let i = 0; i < 4; i++)
      f.context.messages.push({
        role: 'toolResult',
        toolCallId: `r${i}`,
        toolName: 'library.read',
        content: [{ type: 'text', text: f.original }],
        isError: false,
        timestamp: 0,
      });
    f.context.messages.push({
      role: 'toolResult',
      toolCallId: 'stage-get',
      toolName: 'scene.structure.stage',
      content: [
        {
          type: 'text',
          text: '{"status":"scene_structure_saved","stageId":"saved","rowVersion":9,"stageOperation":"get"}',
        },
      ],
      isError: false,
      timestamp: 0,
    });
    expect(() => new AgentContextBudget().prepare(f.runtime, f.context)).toThrow(
      'AGENT_REPEATED_READ_STALLED',
    );
  });
  it('uses nested saved shot versions as progress and ignores a new execution ID for the same receipt', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = 100000;
    f.runtime.continuation = undefined;
    f.context.messages = [];
    const add = (toolName: string, output: string) =>
      f.context.messages.push({
        role: 'toolResult',
        toolName,
        toolCallId: `progress-${f.context.messages.length}`,
        content: [{ type: 'text', text: output }],
        isError: false,
        timestamp: 0,
      });
    const save = (version: number, executionId: string) =>
      add(
        'scene.update_shot_prompts',
        JSON.stringify({
          status: 'shot_prompts_saved',
          executionId,
          sceneIds: ['scene'],
          shots: [{ shotId: 'shot', sceneId: 'scene', rowVersion: version, changed: true }],
        }),
      );
    for (const version of [2, 3]) {
      save(version, `execution-${version}`);
      for (let i = 0; i < 3; i++) add('library.read', f.original);
    }
    const budget = new AgentContextBudget();
    expect(() => budget.prepare(f.runtime, f.context)).not.toThrow();
    save(3, 'different-execution-same-saved-version');
    add('library.read', f.original);
    expect(() => budget.prepare(f.runtime, f.context)).toThrow('AGENT_REPEATED_READ_STALLED');
  });
  it.each(['project.get_context', 'project.structure.get', 'tools.load'])(
    'stops repeated preparation through %s even across checkpoint turns',
    (toolName) => {
      const f = fixture('openai-chat-completions');
      f.runtime.contextWindowTokens = 100000;
      f.context.messages = [];
      for (let i = 0; i < 4; i++) {
        f.context.messages.push(
          {
            role: 'toolResult',
            toolName,
            toolCallId: `nav-${i}`,
            isError: false,
            timestamp: i,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  toolName === 'tools.load'
                    ? {
                        status: 'tools_loaded',
                        loaded: ['document.submit_draft'],
                        newlyLoaded: i ? [] : ['document.submit_draft'],
                      }
                    : { status: 'read', resourceMap: { revision: 'r1', shots: ['s1', 's2'] } },
                ),
              },
            ],
          },
          {
            role: 'toolResult',
            toolName: 'conversation.task.checkpoint',
            toolCallId: `cp-${i}`,
            isError: false,
            timestamp: i,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'task_checkpoint_saved', checkpointId: `cp-${i}` }),
              },
            ],
          },
        );
      }
      expect(() => new AgentContextBudget().prepare(f.runtime, f.context)).toThrow(
        'AGENT_PREPARATION_STALLED',
      );
    },
  );
  it('allows new navigation pages and revisions without a total call cap', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = 100000;
    f.context.messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'toolResult' as const,
      toolName: 'project.structure.get',
      toolCallId: `page-${i}`,
      isError: false,
      timestamp: i,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            resourceMap: { revision: `r${i % 2}`, offset: i, shots: [`s${i}`] },
          }),
        },
      ],
    }));
    expect(() => new AgentContextBudget().prepare(f.runtime, f.context)).not.toThrow();
  });
  it.each(['target', 'version', 'page', 'unchanged', 'failed'])(
    'resets preparation only for new successful read evidence (%s)',
    (variant) => {
      const f = fixture('openai-chat-completions');
      f.runtime.contextWindowTokens = 100000;
      f.runtime.continuation = undefined;
      f.context.messages = [];
      const add = (toolName: string, result: unknown, isError = false) =>
        f.context.messages.push({
          role: 'toolResult',
          toolCallId: `discovery-${f.context.messages.length}`,
          toolName,
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError,
          timestamp: 0,
        });
      for (let i = 0; i < 4; i++) {
        add(
          'library.read',
          {
            status: 'read',
            sourceId: variant === 'target' ? `doc-${i}` : 'doc',
            versionId: variant === 'version' ? `v${i}` : 'v1',
            startOffset: variant === 'page' ? i * 10 : 0,
            content: '精确正文',
            sourceHandle: `temporary-${i}`,
          },
          variant === 'failed',
        );
        add('tools.load', { status: 'tools_loaded', loaded: ['library.read'] });
      }
      const run = () => new AgentContextBudget().prepare(f.runtime, f.context);
      if (variant === 'unchanged' || variant === 'failed')
        expect(run).toThrow('AGENT_PREPARATION_STALLED');
      else expect(run).not.toThrow();
    },
  );
  it('keeps a full body required by a recent duplicate reference', () => {
    const f = fixture('openai-chat-completions');
    f.context.messages.push({
      role: 'toolResult',
      toolCallId: 'ref',
      toolName: 'library.read',
      content: [{ type: 'text', text: '{"status":"identical_result","fullResultCallId":"old"}' }],
      isError: false,
      timestamp: 0,
    });
    const budget = new AgentContextBudget();
    expect(() => budget.prepare(f.runtime, f.context)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(budget.replacedResultIds.has('old')).toBe(false);
  });
  it('replaces older duplicate references when their full target is omitted and protects its reacquired body', () => {
    const f = fixture('openai-chat-completions');
    f.context.messages.splice(3, 0, {
      role: 'toolResult',
      toolCallId: 'ref',
      toolName: 'library.read',
      content: [{ type: 'text', text: '{"status":"identical_result","fullResultCallId":"old"}' }],
      isError: false,
      timestamp: 0,
    });
    const budget = new AgentContextBudget();
    const prepared = budget.prepare(f.runtime, f.context);
    expect(prepared.compacted).toBe(true);
    expect(budget.replacedResultIds).toEqual(new Set(['old', 'ref']));
    expect(JSON.stringify(prepared.request)).not.toContain('identical_result');
    f.context.messages.push({
      role: 'toolResult',
      toolCallId: 'reacquired',
      toolName: 'library.read',
      content: [{ type: 'text', text: f.original }],
      isError: false,
      timestamp: 0,
    });
    for (const id of ['next', 'last-next'])
      f.context.messages.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: 'library.read',
        content: [{ type: 'text', text: '{}' }],
        isError: false,
        timestamp: 0,
      });
    expect(() => budget.prepare(f.runtime, f.context)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(budget.replacedResultIds.has('reacquired')).toBe(false);
  });
  it('compacts navigation before evicting source bodies to satisfy actual capacity', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = 30000;
    f.context.messages.splice(3, 0, {
      role: 'toolResult',
      toolCallId: 'navigation',
      toolName: 'library.search',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'searched',
            sources: [
              {
                sourceId: 'doc',
                versionId: 'v1',
                sourceType: 'document',
                sourceStatus: 'draft',
                sourceHandle: 'handle',
                snippet: 's'.repeat(100000),
              },
            ],
          }),
        },
      ],
      isError: false,
      timestamp: 0,
    });
    const budget = new AgentContextBudget();
    expect(budget.prepare(f.runtime, f.context).compacted).toBe(true);
    expect(budget.replacedResultIds.has('navigation')).toBe(true);
    expect(budget.replacedResultIds.has('old')).toBe(false);
  });
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'fits the 51,502-token %s verified request using an explicit protocol output limit',
    (protocol) => {
      const f = fixture(protocol);
      f.runtime.contextWindowTokens = 64000;
      f.runtime.contextWindowSource = 'contract';
      f.runtime.inferenceSettings = undefined;
      f.runtime.prompt = '继续';
      f.runtime.systemInstruction = 's'.repeat(31540);
      f.runtime.tools = [{ name: 'library.read', description: 't'.repeat(25000), parameters: {} }];
      f.runtime.continuation = undefined;
      const assistant = fauxAssistantMessage([{ type: 'text', text: '' }]);
      f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }, assistant];
      const budget = new AgentContextBudget();
      expect(budget.prepare(f.runtime, f.context).request.inferenceSettings?.maxOutputTokens).toBe(
        16000,
      );
      const required = 51502;
      const history = 'h'.repeat((required - budget.lastInfo!.estimatedInputTokens) * 4);
      assistant.content = [{ type: 'text', text: history }];
      const original = structuredClone(f);
      const prepared = budget.prepare(f.runtime, f.context);
      expect(budget.lastInfo).toMatchObject({
        estimatedInputTokens: required,
        contextWindowTokens: 64000,
        windowSource: 'contract',
        reservedOutputTokens: 9298,
      });
      expect(prepared.request.inferenceSettings).toEqual({
        maxOutputTokens: 9298,
        outputTokenParameter: protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
        reasoning: 'provider_default',
      });
      expect(prepared.request.prompt).toBe(original.runtime.prompt);
      expect(prepared.request.tools).toEqual(original.runtime.tools);
      expect(f).toEqual(original);
      assistant.content = [
        { type: 'text', text: `${history}${'h'.repeat((58753 - required) * 4)}` },
      ];
      const oversized = structuredClone(f);
      expect(() => budget.prepare(f.runtime, f.context)).toThrow('CONTEXT_BUDGET_EXCEEDED');
      expect(f).toEqual(oversized);
      assistant.content = [
        { type: 'text', text: `${history}${'h'.repeat((59300 - required) * 4)}` },
      ];
      expect(() => budget.prepare(f.runtime, f.context)).toThrow('输入上限 58752');
      expect(budget.lastInfo).toMatchObject({
        estimatedInputTokens: 59300,
        initialInputBudgetTokens: 44800,
        maximumInputBudgetTokens: 58752,
        safetyTokens: 3200,
        minimumOutputTokens: 2048,
        deficitTokens: 548,
      });
    },
  );
  it.each(['constraint', 'unlocated', 'latest', 'error'] as const)(
    'keeps %s search evidence intact when no safe compaction is possible',
    (kind) => {
      const f = fixture('openai-chat-completions');
      const result = f.context.messages[kind === 'latest' ? f.context.messages.length - 1 : 2]!;
      if (result.role !== 'toolResult') throw new Error('fixture');
      result.toolName = 'library.search';
      result.isError = kind === 'error';
      result.content = [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'searched',
            sources: [
              {
                sourceId: 'real-source',
                ...(kind === 'unlocated' ? {} : { sourceHandle: 'real-handle' }),
                sourceType: kind === 'constraint' ? 'constraint' : 'document',
                snippet: '完整保护的唯一证据'.repeat(4000),
              },
            ],
          }),
        },
      ];
      const original = structuredClone(f);
      expect(() => new AgentContextBudget().prepare(f.runtime, f.context)).toThrow(
        'CONTEXT_BUDGET_EXCEEDED',
      );
      expect(f).toEqual(original);
    },
  );
  it.each([
    { protocol: 'openai-responses', parameter: 'max_output_tokens' },
    { protocol: 'openai-chat-completions', parameter: 'max_tokens' },
    { protocol: 'openai-chat-completions', parameter: 'max_completion_tokens' },
  ] as const)(
    'adapts $protocol output space using $parameter without truncation or changing the model window',
    ({ protocol, parameter }) => {
      const f = fixture(protocol);
      f.runtime.contextWindowTokens = 64000;
      f.runtime.contextWindowSource = 'contract';
      f.runtime.inferenceSettings = {
        maxOutputTokens: 16000,
        outputTokenParameter: parameter,
        reasoning: 'provider_default',
      };
      f.runtime.prompt = '原始用户要求'.repeat(8500);
      f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
      f.runtime.continuation = undefined;
      const original = structuredClone(f);
      const budget = new AgentContextBudget();
      const prepared = budget.prepare(f.runtime, f.context);
      expect(prepared.request.prompt).toBe(original.runtime.prompt);
      expect(f).toEqual(original);
      expect(prepared.request.contextWindowTokens).toBe(64000);
      expect(prepared.request.inferenceSettings!.outputTokenParameter).toBe(parameter);
      expect(prepared.request.inferenceSettings!.maxOutputTokens).toBeLessThan(16000);
      expect(prepared.request.inferenceSettings!.maxOutputTokens).toBeGreaterThanOrEqual(2048);
      expect(
        budget.lastInfo!.estimatedInputTokens + budget.lastInfo!.reservedOutputTokens + 3200,
      ).toBeLessThanOrEqual(64000);
      expect(budget.lastInfo!.reservedOutputTokens).toBe(
        prepared.request.inferenceSettings!.maxOutputTokens,
      );
    },
  );
  it('keeps the protocol output limit synchronized after rebuilding the Responses replay envelope', () => {
    const f = fixture('openai-responses');
    // Force a real capacity shortage: fitting evidence is now retained at soft thresholds.
    const large = JSON.parse(f.original) as Record<string, unknown>;
    large.content = 'x'.repeat(100000);
    const read = f.context.messages.find((message) => message.role === 'toolResult')!;
    if (read.role === 'toolResult') read.content = [{ type: 'text', text: JSON.stringify(large) }];
    const control = new AgentContextBudget();
    expect(control.prepare(f.runtime, f.context).compacted).toBe(true);
    const target = 44820;
    f.runtime.contextWindowTokens = 64000;
    f.runtime.contextWindowSource = 'contract';
    f.runtime.systemInstruction += 's'.repeat(
      (target - control.lastInfo!.estimatedInputTokens) * 4,
    );
    const original = structuredClone(f);
    const budget = new AgentContextBudget();
    const prepared = budget.prepare(f.runtime, f.context);
    expect(prepared.compacted).toBe(true);
    expect(prepared.request.continuation).toBeUndefined();
    expect(prepared.request.prompt).toContain(f.runtime.prompt);
    expect(prepared.request.prompt).toContain('reread_required');
    expect(budget.lastInfo).toMatchObject({
      estimatedInputTokens: target,
      contextWindowTokens: 64000,
      windowSource: 'contract',
    });
    expect(prepared.request.inferenceSettings).toMatchObject({
      maxOutputTokens: budget.lastInfo!.reservedOutputTokens,
      outputTokenParameter: 'max_output_tokens',
      reasoning: 'provider_default',
    });
    expect(budget.lastInfo!.reservedOutputTokens).toBeGreaterThanOrEqual(2048);
    expect(target + budget.lastInfo!.reservedOutputTokens + 3200).toBeLessThanOrEqual(64000);
    expect(f).toEqual(original);
  });
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'compacts old %s search snippets and losslessly packs directory metadata while preserving recent results',
    (protocol) => {
      const f = fixture(protocol);
      const sources = Array.from({ length: 8 }, (_, i) => ({
        sourceHandle: `handle-${i}`,
        sourceId: `source-${i}`,
        versionId: `version-${i}`,
        sourceType: 'document',
        status: i % 2 ? 'draft' : 'published',
        startOffset: 0,
        endOffset: 1200,
        snippet: '可按来源重新读取的旧摘要'.repeat(50),
      }));
      const resources = Array.from({ length: 60 }, (_, i) => ({
        id: `shot-${i}`,
        kind: 'shot',
        title: `镜头${i}`,
        rowVersion: i,
        parentId: 'scene-real',
        locator: { workspace: 'shots', shotId: `shot-${i}`, sceneId: 'scene-real' },
      }));
      const outputs = [
        {
          callId: 'search',
          output: JSON.stringify({
            status: 'searched',
            sources: [
              ...sources,
              { sourceType: 'constraint', kind: 'constraint', snippet: '不可省略的剧情约束' },
            ],
          }),
        },
        {
          callId: 'directory',
          output: JSON.stringify({
            status: 'succeeded',
            resourceMap: { revision: 'original-revision', resources },
          }),
        },
        { callId: 'recent-1', output: '{"content":"最近正文完整保留"}' },
        { callId: 'recent-2', output: '{"savedId":"saved-shot","rowVersion":9}' },
      ];
      const names = ['library.search', 'project.structure.get', 'library.read', 'library.read'];
      const calls = outputs.map((o, i) => ({
        id: o.callId,
        name: names[i]!,
        argumentsJson: JSON.stringify({ query: '原查询' }),
      }));
      f.runtime.systemInstruction = 's'.repeat(12000);
      f.context.messages = [{ role: 'user', content: f.runtime.prompt, timestamp: 0 }];
      for (const [i, output] of outputs.entries())
        f.context.messages.push(
          fauxAssistantMessage(
            [fauxToolCall(names[i]!, { query: '原查询' }, { id: output.callId })],
            { stopReason: 'toolUse' },
          ),
          {
            role: 'toolResult',
            toolCallId: output.callId,
            toolName: names[i]!,
            content: [{ type: 'text', text: output.output }],
            isError: false,
            timestamp: i,
          },
        );
      f.runtime.contextWindowTokens = 14000;
      f.runtime.continuation =
        protocol === 'openai-responses'
          ? { protocol, previousResponseId: 'previous', outputs: [outputs[3]!] }
          : {
              protocol,
              providerResponseId: 'previous',
              history: calls
                .slice(0, 3)
                .map((call, i) => ({ calls: [call], outputs: [outputs[i]!] })),
              calls: [calls[3]!],
              outputs: [outputs[3]!],
            };
      const original = structuredClone(f);
      const prepared = new AgentContextBudget().prepare(f.runtime, f.context);
      expect(prepared.compacted).toBe(true);
      expect(f).toEqual(original);
      const serialized = JSON.stringify(prepared.request);
      expect(serialized).not.toContain(sources[0]!.snippet);
      for (const source of sources)
        for (const key of ['sourceHandle', 'sourceId', 'versionId', 'status'] as const)
          expect(serialized).toContain(source[key]);
      expect(serialized).toContain('不可省略的剧情约束');
      expect(serialized).toContain('最近正文完整保留');
      expect(serialized).toContain('saved-shot');
      expect(serialized).toContain('original-revision');
      if (prepared.request.continuation?.protocol === 'openai-chat-completions') {
        const packed = JSON.parse(
          prepared.request.continuation.history![1]!.outputs[0]!.output,
        ) as {
          resourceMap: {
            resourcesTable: {
              columns: string[];
              rows: unknown[][];
            };
          };
        };
        const { columns, rows } = packed.resourceMap.resourcesTable;
        expect(
          rows.map((row) =>
            Object.fromEntries(
              columns.flatMap((key, i) => (row[i] === null ? [] : [[key, row[i]]])),
            ),
          ),
        ).toEqual(resources);
        expect(prepared.request.continuation.outputs[0]).toEqual(outputs[3]);
      } else expect(prepared.request.continuation).toBeUndefined();
    },
  );
  it.each(
    (['openai-responses', 'openai-chat-completions'] as const).flatMap((protocol) => [
      { protocol, structured: false },
      { protocol, structured: true },
    ]),
  )(
    'admits a $protocol three-image continuation without counting the original user input twice (structured=$structured)',
    ({ protocol, structured }) => {
      const f = fixture(protocol);
      f.runtime.contextWindowTokens = 64000;
      f.runtime.contextWindowSource = 'fallback';
      f.runtime.prompt = 'u'.repeat(26544);
      f.runtime.systemInstruction = 's'.repeat(34896);
      f.runtime.tools = [
        { name: 'shot.continuity.read', description: 't'.repeat(17900), parameters: {} },
      ];
      const images = Array.from({ length: 3 }, () => ({
        type: 'image' as const,
        mimeType: 'image/jpeg',
        data: 'cGl4ZWxz',
      }));
      const call = { id: 'continuity', name: 'shot.continuity.read', argumentsJson: '{}' };
      const output = { callId: call.id, output: 'r'.repeat(29000), images };
      f.runtime.continuation =
        protocol === 'openai-responses'
          ? { protocol, previousResponseId: 'previous', outputs: [output] }
          : { protocol, providerResponseId: 'previous', calls: [call], outputs: [output] };
      f.context.messages = [
        {
          role: 'user',
          content: structured ? [{ type: 'text', text: f.runtime.prompt }] : f.runtime.prompt,
          timestamp: 0,
        },
        fauxAssistantMessage([fauxToolCall(call.name, {}, { id: call.id })], {
          stopReason: 'toolUse',
        }),
        {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: output.output }, ...images],
          isError: false,
          timestamp: 0,
        },
      ];
      const original = structuredClone(f);
      const budget = new AgentContextBudget();
      const prepared = budget.prepare(f.runtime, f.context);
      expect(prepared).toEqual({
        request: {
          ...original.runtime,
          inferenceSettings: {
            reasoning: 'provider_default',
            maxOutputTokens: 16000,
            outputTokenParameter:
              protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
          },
        },
        compacted: false,
      });
      expect(f).toEqual(original);
      expect(budget.lastInfo).toMatchObject({
        contextWindowTokens: 64000,
        windowSource: 'fallback',
        reservedOutputTokens: 16000,
        compactionCount: 0,
      });
      expect(budget.lastInfo!.estimatedInputTokens).toBeLessThan(44800);
      expect(budget.lastInfo!.estimatedInputTokens).toBeGreaterThan(39000);
      expect(budget.lastInfo!.sections.user!.estimatedTokens).toBe(6636);
      expect(budget.lastInfo!.sections.history!.estimatedTokens).toBeLessThan(8000);
      const withOversizedUser = { ...f.runtime, prompt: f.runtime.prompt.repeat(3) };
      expect(new AgentContextBudget().prepare(withOversizedUser, f.context).request.prompt).toBe(
        withOversizedUser.prompt,
      );
    },
  );
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'counts each %s user supplement once while preserving identical messages as distinct inputs',
    (protocol) => {
      const f = fixture(protocol);
      f.runtime.contextWindowTokens = 100000;
      const supplement = '保留所有参考图与用户要求'.repeat(300);
      f.context.messages.push(
        { role: 'user', content: supplement, timestamp: 1 },
        { role: 'user', content: supplement, timestamp: 2 },
      );
      const original = structuredClone(f);
      const historyOnly = new AgentContextBudget();
      historyOnly.prepare(f.runtime, f.context);
      f.runtime.continuation!.userMessages = [supplement, supplement];
      const mirrored = new AgentContextBudget();
      expect(mirrored.prepare(f.runtime, f.context).request).toMatchObject(f.runtime);
      expect(mirrored.lastInfo!.estimatedInputTokens).toBe(
        historyOnly.lastInfo!.estimatedInputTokens,
      );
      expect(f.context).toEqual(original.context);
      f.context.messages.pop();
      f.runtime.continuation!.userMessages = undefined;
      const oneSupplement = new AgentContextBudget();
      oneSupplement.prepare(f.runtime, f.context);
      expect(historyOnly.lastInfo!.estimatedInputTokens).toBeGreaterThan(
        oneSupplement.lastInfo!.estimatedInputTokens + 1000,
      );
      f.runtime.continuation!.userMessages = [supplement, supplement];
      const notFullyMirrored = new AgentContextBudget();
      notFullyMirrored.prepare(f.runtime, f.context);
      expect(notFullyMirrored.lastInfo!.sections.supplements!.estimatedTokens).toBeGreaterThan(
        2000,
      );
      const pendingOnly = new AgentContextBudget();
      pendingOnly.prepare(f.runtime, { messages: [] });
      const withoutPending = new AgentContextBudget();
      withoutPending.prepare(
        { ...f.runtime, continuation: { ...f.runtime.continuation!, userMessages: [] } },
        { messages: [] },
      );
      expect(pendingOnly.lastInfo!.estimatedInputTokens).toBeGreaterThan(
        withoutPending.lastInfo!.estimatedInputTokens + 2000,
      );
    },
  );
  it('continues compacting newly added old reads without a task-wide compaction cap', () => {
    const f = fixture('openai-chat-completions');
    const budget = new AgentContextBudget();
    const repeatedRead = JSON.stringify({
      status: 'read',
      sourceId: 'doc',
      versionId: 'v1',
      sourceStatus: 'draft',
      contentHash: 'saved-hash',
      content: '较长但可按版本重新读取的正文'.repeat(2400),
    });
    budget.prepare(f.runtime, f.context);
    for (let pass = 1; pass <= 2; pass++) {
      f.context.messages.splice(
        1,
        0,
        fauxAssistantMessage([fauxToolCall('library.read', {}, { id: `extra-${pass}` })], {
          stopReason: 'toolUse',
        }),
        {
          role: 'toolResult',
          toolName: 'library.read',
          toolCallId: `extra-${pass}`,
          content: [{ type: 'text', text: repeatedRead }],
          isError: false,
          timestamp: 0,
        },
      );
      if (pass === 1) {
        expect(budget.prepare(f.runtime, f.context).compacted).toBe(true);
        expect(budget.lastInfo?.compactionCount).toBe(2);
      } else {
        expect(budget.prepare(f.runtime, f.context).compacted).toBe(true);
        expect(budget.lastInfo?.compactionCount).toBe(3);
      }
    }
  });
  it('compacts completed stage-page calls and receipts while retaining resumable IDs', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = 10000;
    const calls = Array.from({ length: 8 }, (_, index) => ({
      id: `stage-${index}`,
      name: 'scene.structure.stage',
      argumentsJson: JSON.stringify({
        operation: 'put_shots',
        stageId: 'saved-page',
        sceneIndex: 0,
        shotOffset: index * 4,
        shots: [{ ...{ prompt: `长镜头提示词${index}`.repeat(1200) } }],
      }),
    }));
    const outputs = calls.map((call, index) => ({
      callId: call.id,
      output: JSON.stringify({
        status: index === calls.length - 1 ? 'scene_structure_saved' : 'scene_structure_staging',
        complete: index === calls.length - 1,
        stageId: 'saved-page',
        executionKey: 'episode-page-1',
        rowVersion: index + 1,
        sceneIds: index === calls.length - 1 ? ['saved-scene'] : [],
      }),
    }));
    for (let index = 0; index < calls.length; index++)
      f.context.messages.push(
        fauxAssistantMessage(
          [
            fauxToolCall(
              calls[index]!.name,
              JSON.parse(calls[index]!.argumentsJson) as Record<string, unknown>,
              { id: calls[index]!.id },
            ),
          ],
          { stopReason: 'toolUse' },
        ),
        {
          role: 'toolResult',
          toolCallId: calls[index]!.id,
          toolName: calls[index]!.name,
          content: [{ type: 'text', text: outputs[index]!.output }],
          isError: false,
          timestamp: index + 1,
        },
      );
    f.runtime.continuation = {
      protocol: 'openai-chat-completions',
      providerResponseId: 'latest',
      history: calls.slice(0, -1).map((call, index) => ({
        content: '',
        calls: [call],
        outputs: [outputs[index]!],
      })),
      calls: [calls.at(-1)!],
      outputs: [outputs.at(-1)!],
    };
    const budget = new AgentContextBudget();
    const prepared = budget.prepare(f.runtime, f.context);
    const continuation = prepared.request.continuation;
    expect(continuation?.protocol).toBe('openai-chat-completions');
    if (continuation?.protocol !== 'openai-chat-completions')
      throw new Error('Expected a chat-completions continuation.');
    const compactedCalls = [
      ...(continuation.history ?? []).flatMap((turn) => turn.calls),
      ...continuation.calls,
    ];
    expect(prepared.compacted).toBe(true);
    expect(
      compactedCalls.every(
        (call) =>
          (
            JSON.parse(call.argumentsJson) as {
              historyCompacted?: unknown;
            }
          ).historyCompacted === true,
      ),
    ).toBe(true);
    expect(JSON.stringify(prepared.request.continuation)).toContain('saved-page');
    expect(JSON.stringify(prepared.request.continuation)).toContain('saved-scene');
    expect(JSON.stringify(prepared.request.continuation)).not.toContain('长镜头提示词0'.repeat(50));
  });
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'bounds %s while preserving locators, constraints, recent work and user text',
    (protocol) => {
      const f = fixture(protocol);
      const budget = new AgentContextBudget();
      const prepared = budget.prepare(f.runtime, f.context);
      expect(prepared.compacted).toBe(true);
      expect(budget.lastInfo).toMatchObject({
        contextWindowTokens: 10000,
        windowSource: 'contract',
        reservedOutputTokens: 2500,
        compactionCount: 1,
      });
      expect(budget.lastInfo!.estimatedInputTokens).toBeLessThan(7000);
      const serialized = JSON.stringify(prepared.request);
      expect(serialized).toContain('reread_required');
      expect(serialized).toContain('real-shot');
      expect(serialized).toContain('蓝色衣服');
      expect(serialized).toContain('用户要求完整保留');
      expect(serialized).toContain('v1');
      expect(serialized).toContain('draft');
      expect(serialized).toContain('锁定的约束完整保留'.repeat(250));
      expect(JSON.stringify(budget.lastInfo)).not.toContain('已读取正文');
      expect(JSON.stringify(f.context)).toContain(f.original.replaceAll('"', '\\"'));
      if (protocol === 'openai-responses') {
        expect(prepared.request.continuation).toBeUndefined();
        expect(prepared.request.prompt).toContain('do not execute them again');
        const next = budget.prepare(
          {
            ...f.runtime,
            continuation: { protocol, previousResponseId: 'new-chain', outputs: [f.outputs[2]!] },
          },
          f.context,
        );
        expect(next.compacted).toBe(false);
        expect(next.request.continuation).toMatchObject({ previousResponseId: 'new-chain' });
      } else {
        expect(prepared.request.continuation).toMatchObject({
          history: [
            { outputs: [{ output: expect.stringContaining('reread_required') as unknown }] },
            { outputs: [f.outputs[1]!] },
          ],
          outputs: [f.outputs[2]!],
        });
      }
    },
  );
  it.each(['constraint', 'unversioned', 'latest', 'user'] as const)(
    'rejects an unsafe oversized %s before dispatch without silently truncating it',
    (kind) => {
      const f = fixture('openai-chat-completions');
      if (kind === 'user') f.runtime.prompt = '完整用户要求'.repeat(4000);
      else {
        const item = f.context.messages[kind === 'latest' ? f.context.messages.length - 1 : 2]!;
        if (item.role !== 'toolResult') throw new Error('fixture');
        item.content = [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'read',
              sourceType: kind === 'constraint' ? 'constraint' : 'document',
              sourceId: 'doc',
              ...(kind === 'unversioned' ? {} : { versionId: 'v1' }),
              content: '不可静默删除'.repeat(4000),
            }),
          },
        ];
      }
      const original = structuredClone(f);
      expect(() => new AgentContextBudget().prepare(f.runtime, f.context)).toThrow(
        'CONTEXT_BUDGET_EXCEEDED',
      );
      expect(f).toEqual(original);
    },
  );
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'preserves the original %s request prefix and sends supplements separately',
    (protocol) => {
      const f = fixture(protocol);
      f.runtime.contextWindowTokens = 100000;
      const budget = new AgentContextBudget();
      budget.prepare(f.runtime, f.context);
      const next = budget.prepare(
        {
          ...f.runtime,
          continuation:
            f.runtime.continuation?.protocol === 'openai-responses'
              ? {
                  ...f.runtime.continuation,
                  userMessages: ['保留旧版本，不重复保存'],
                }
              : {
                  ...f.runtime.continuation!,
                  userMessages: ['保留旧版本，不重复保存'],
                },
        },
        f.context,
      );
      expect(next.request.prompt).toBe(f.runtime.prompt);
      expect(next.request.systemInstruction).toBe(f.runtime.systemInstruction);
      expect(next.request.continuation?.userMessages).toEqual(['保留旧版本，不重复保存']);
      if (protocol === 'openai-responses')
        expect(next.request.continuation).toMatchObject({ previousResponseId: 'old-chain' });
      else expect(next.request.continuation).toMatchObject({ providerResponseId: 'response' });
    },
  );
  it('uses a labelled fallback and counts tools and attachments without treating base64 bytes as text tokens', () => {
    const f = fixture('openai-chat-completions');
    f.runtime.contextWindowTokens = undefined;
    f.runtime.contextWindowSource = undefined;
    f.runtime.tools = [
      {
        name: 'library.read',
        description: 'Read',
        parameters: { type: 'object' },
        authorizationHandle: 'private-capability',
      },
    ];
    f.runtime.attachments = [
      {
        name: 'image.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${'a'.repeat(200000)}`,
      },
    ];
    const budget = new AgentContextBudget();
    budget.prepare(f.runtime, f.context);
    expect(budget.lastInfo).toMatchObject({
      contextWindowTokens: 512000,
      windowSource: 'fallback',
    });
    expect(budget.lastInfo!.sections.tools!.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(budget.lastInfo)).not.toContain('private-capability');
    expect(budget.lastInfo!.estimatedInputTokens).toBeLessThan(40000);
  });
  it('retains supplements exactly once through Responses compaction and the following chain', () => {
    const f = fixture('openai-responses');
    const content = '保留蓝色衣服，已保存的镜头不要再次写入';
    f.context.messages.push({ role: 'user', content, timestamp: 1 });
    f.runtime.continuation!.userMessages = [content];
    const budget = new AgentContextBudget();
    const prepared = budget.prepare(f.runtime, f.context);
    expect(prepared.compacted).toBe(true);
    expect(prepared.request.prompt.split(content)).toHaveLength(2);
    expect(prepared.request.prompt).toContain('[USER SUPPLEMENTS — IN ORDER]');
    expect(prepared.request.prompt).toContain('real-shot');
    expect(prepared.request.continuation).toBeUndefined();
    f.runtime.continuation = {
      protocol: 'openai-responses',
      previousResponseId: 'after-compaction',
      outputs: [f.outputs[2]!],
    };
    const next = budget.prepare(f.runtime, f.context);
    expect(next.request.prompt).toBe(f.runtime.prompt);
    expect(next.request.continuation).toEqual(f.runtime.continuation);
    expect(next.compacted).toBe(false);
  });
  it('replays actual tool images when compaction starts a new Responses chain', () => {
    const f = fixture('openai-responses');
    f.runtime.contextWindowTokens = 16000;
    const result = f.context.messages.at(-1)!;
    if (result.role !== 'toolResult') throw new Error('fixture');
    const image = { type: 'image' as const, mimeType: 'image/jpeg', data: 'cGl4ZWxz' };
    result.content.push(image);
    f.runtime.continuation!.outputs[0]!.images = [image];
    const budget = new AgentContextBudget();
    const prepared = budget.prepare(f.runtime, f.context);
    expect(prepared.compacted).toBe(true);
    expect(prepared.request.continuation).toBeUndefined();
    expect(prepared.request.attachments).toEqual([
      {
        name: 'last-image-1',
        mimeType: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,cGl4ZWxz',
        text: expect.stringContaining('completed tool call last') as unknown,
      },
    ]);
    expect(budget.lastInfo!.estimatedInputTokens).toBeGreaterThan(4096);
    expect(JSON.stringify(budget.lastInfo)).not.toContain(image.data);
    expect(prepared.request.prompt).not.toContain(image.data);
  });
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'counts visual %s continuation input once without counting base64 as text',
    (protocol) => {
      const f = fixture(protocol);
      f.runtime.contextWindowTokens = 100000;
      const baseline = new AgentContextBudget();
      baseline.prepare(f.runtime, f.context);
      const image = { type: 'image' as const, mimeType: 'image/jpeg', data: 'a'.repeat(200000) };
      f.runtime.continuation!.outputs[0]!.images = [image];
      const continuationOnly = new AgentContextBudget();
      continuationOnly.prepare(f.runtime, { ...f.context, messages: [] });
      const withoutImages = structuredClone(f.runtime);
      withoutImages.continuation!.outputs[0]!.images = undefined;
      const noHistory = new AgentContextBudget();
      noHistory.prepare(withoutImages, { ...f.context, messages: [] });
      expect(
        continuationOnly.lastInfo!.estimatedInputTokens - noHistory.lastInfo!.estimatedInputTokens,
      ).toBe(4096);
      const result = f.context.messages.at(-1)!;
      if (result.role !== 'toolResult') throw new Error('fixture');
      result.content.push(image);
      const budget = new AgentContextBudget();
      budget.prepare(f.runtime, f.context);
      const difference =
        budget.lastInfo!.estimatedInputTokens - baseline.lastInfo!.estimatedInputTokens;
      expect(difference).toBeGreaterThanOrEqual(4096);
      expect(difference).toBeLessThan(4200);
      expect(JSON.stringify(budget.lastInfo)).not.toContain(image.data);
    },
  );
});
