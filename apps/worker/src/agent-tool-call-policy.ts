import type { LlmToolDefinition } from '@ai-video/contracts';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

/** Provider scheduling hint only; Worker preflight still validates every response. */
export function agentToolCallMode(
  tools: LlmToolDefinition[],
  pending: unknown[],
): 'single' | 'parallel-readonly' {
  if (pending.length)
    return pending.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        ['read_outputs', 'review_outputs'].includes(
          String((item as { nextAction?: { kind?: string } }).nextAction?.kind),
        ),
    )
      ? 'parallel-readonly'
      : 'single';
  const controls = new Set([
    'conversation.ask',
    'conversation.task.route',
    'conversation.task.checkpoint',
    'tools.load',
  ]);
  return tools.some(
    (tool) =>
      !controls.has(tool.name) &&
      (!unifiedAgentToolRegistry.has(tool.name) ||
        unifiedAgentToolRegistry.executionMode(tool.name) !== 'parallel'),
  )
    ? 'single'
    : 'parallel-readonly';
}
