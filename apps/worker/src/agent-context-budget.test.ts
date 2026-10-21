import { describe, expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { LlmGenerationRuntimeRequest } from '@ai-video/contracts';
import { AgentContextBudget } from './agent-context-budget.js';

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
  it('bounds repeated compaction instead of looping through summaries indefinitely', () => {
    const f = fixture('openai-chat-completions');
    const budget = new AgentContextBudget();
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
          content: [{ type: 'text', text: f.original }],
          isError: false,
          timestamp: 0,
        },
      );
      if (pass === 1) {
        expect(budget.prepare(f.runtime, f.context).compacted).toBe(true);
        expect(budget.lastInfo?.compactionCount).toBe(2);
      } else expect(() => budget.prepare(f.runtime, f.context)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    }
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
    expect(budget.lastInfo).toMatchObject({ contextWindowTokens: 64000, windowSource: 'fallback' });
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
});
