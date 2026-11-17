import { expect, it } from 'vitest';
import { agentToolCallMode } from './agent-tool-call-policy.js';
import type { LlmToolDefinition } from '@ai-video/contracts';
const tools = ['library.read', 'conversation.ask', 'document.submit_draft'].map((name) => ({
  name,
  description: '',
  parameters: {},
})) as LlmToolDefinition[];
it('uses single writes while retaining read batches for verification and read-only work', () => {
  expect(agentToolCallMode(tools, [])).toBe('single');
  expect(agentToolCallMode(tools, [{ nextAction: { kind: 'continue_outputs' } }])).toBe('single');
  expect(agentToolCallMode(tools, [{ nextAction: { kind: 'review_outputs' } }])).toBe(
    'parallel-readonly',
  );
  expect(agentToolCallMode(tools.slice(0, 2), [])).toBe('parallel-readonly');
});
