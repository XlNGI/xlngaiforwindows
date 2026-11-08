import { expect, it } from 'vitest';
import type { WorkerMethod } from '@ai-video/contracts';
import { validateSessionRequestParams } from './request-validation.js';

const text = '完整保留用户输入。'.repeat(15000);
const identity = {
  generationId: 'generation',
  attemptId: 'attempt',
  conversationId: 'conversation',
  projectId: 'project',
  projectSessionId: 'session',
};
it.each([
  ['llm.generate', { conversationId: 'conversation', prompt: text }],
  [
    'llm.generation.prepare',
    {
      conversationId: 'conversation',
      providerProfileId: 'profile',
      modelId: 'model',
      prompt: text,
    },
  ],
  [
    'agent.generation.prepare',
    {
      conversationId: 'conversation',
      providerProfileId: 'profile',
      modelId: 'model',
      agentMode: 'document',
      prompt: text,
    },
  ],
  ['agent.run', { conversationId: 'conversation', prompt: text }],
  ['conversation.runtime.start', { ...identity, taskId: 'task', mode: 'document', prompt: text }],
  [
    'conversation.promptTemplate.save',
    { conversationId: 'conversation', content: text, expectedRowVersion: 0 },
  ],
  [
    'conversation.runtime.supplement',
    { generationId: 'generation', content: text, idempotencyKey: 'supplement' },
  ],
  [
    'chat.message.save',
    { conversationId: 'conversation', role: 'user', content: 'x'.repeat(1_000_001) },
  ],
] as Array<[WorkerMethod, Record<string, unknown>]>)(
  'accepts complete user text beyond previous character caps for %s',
  (method, params) => {
    const original = structuredClone(params);
    expect(() => validateSessionRequestParams(method, params)).not.toThrow();
    expect(params).toEqual(original);
    expect(() =>
      validateSessionRequestParams(method, {
        ...params,
        ...(params.prompt ? { prompt: 42 } : { content: 42 }),
      }),
    ).toThrow();
  },
);
