import { expect, it } from 'vitest';
import type { Context, AssistantMessage } from '@earendil-works/pi-ai';
import { contextWorkingSet } from './agent-context-working-set.js';

it('retains complete eight-tool batches instead of leaving orphan results at the boundary', () => {
  const messages: Context['messages'] = [];
  for (let group = 0; group < 10; group++) {
    messages.push({
      role: 'assistant',
      content: Array.from({ length: 8 }, (_, i) => ({
        type: 'toolCall',
        id: `${group}:${i}`,
        name: 'read',
        arguments: {},
      })),
      timestamp: group,
    } as AssistantMessage);
    for (let i = 0; i < 8; i++)
      messages.push({
        role: 'toolResult',
        toolCallId: `${group}:${i}`,
        toolName: 'read',
        content: [{ type: 'text', text: 'saved' }],
        isError: false,
        timestamp: group,
      });
  }
  const working = contextWorkingSet(messages);
  expect(working).toHaveLength(27);
  expect(working[0]?.role).toBe('assistant');
  const calls = new Set(
    working.flatMap((m) =>
      m.role === 'assistant' ? m.content.filter((p) => p.type === 'toolCall').map((p) => p.id) : [],
    ),
  );
  for (const m of working) if (m.role === 'toolResult') expect(calls.has(m.toolCallId)).toBe(true);
  expect(contextWorkingSet(messages.slice(-9), 2)).toHaveLength(9);
});
