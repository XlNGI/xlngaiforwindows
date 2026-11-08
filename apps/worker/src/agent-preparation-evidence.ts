import { createHash } from 'node:crypto';
import { readEvidenceKey } from './repeated-read-results.js';

export const NAVIGATION_TOOLS = new Set([
  'project.get_context',
  'project.structure.get',
  'novel.structure.get',
]);

/** Loading tools, routing and assistant checkpoints cannot make another handoff useful. */
export function isTaskHandoffEvidence(toolName: string, result: Record<string, unknown>): boolean {
  return (
    !['conversation.task.checkpoint', 'conversation.task.route', 'tools.load'].includes(toolName) &&
    !result.error &&
    result.status !== 'rejected'
  );
}

/** Identity of successful evidence, independent of temporary handles or loading prose. */
export function taskEvidenceKey(toolName: string, result: Record<string, unknown>): string {
  const read = readEvidenceKey(result);
  if (read) return `${toolName}:${read}`;
  if (result.status === 'identical_result' && typeof result.contentHash === 'string')
    return `${toolName}:${result.contentHash}`;
  const value: Record<string, unknown> =
    toolName === 'tools.load'
      ? { loaded: Array.isArray(result.loaded) ? [...(result.loaded as unknown[])].sort() : [] }
      : { ...result };
  if (typeof result.status === 'string' && result.status.endsWith('_saved')) {
    delete value.executionId;
    delete value.executionKey;
  }
  return `${toolName}:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['sourceHandle', 'citationLabel'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
}
