import { randomUUID } from 'node:crypto';
import type { LlmToolDefinition } from '@ai-video/contracts';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';

// Reuse the durable working-result store, including calls rejected before execution.
export const PREPARED_ARGUMENT_TOOLS = new Set([
  'document.submit_draft',
  'scene.submit_structure',
  'scene.structure.stage',
  'scene.update_shot_prompts',
  'scene.update_shot_timings',
]);
export type PreparedArgumentsRef = { resultId: string; argumentsHash: string };

export function preparedArgumentsDefinition(definition: LlmToolDefinition): LlmToolDefinition {
  if (!PREPARED_ARGUMENT_TOOLS.has(definition.name)) return definition;
  const parameters = structuredClone(definition.parameters);
  const constraints: Record<string, unknown> = {};
  for (const key of Object.keys(parameters))
    if (!['type', 'additionalProperties', 'properties', 'description'].includes(key)) {
      constraints[key] = parameters[key];
      delete parameters[key];
    }
  parameters.anyOf = [constraints, { required: ['preparedArguments'] }];
  parameters.properties = {
    ...(parameters.properties as Record<string, unknown>),
    preparedArguments: {
      type: 'object',
      additionalProperties: false,
      required: ['resultId', 'argumentsHash'],
      properties: { resultId: { type: 'string' }, argumentsHash: { type: 'string' } },
      description:
        'Reuse same-task, same-tool stored arguments after a failure. Supply only corrected top-level fields alongside this reference. Merged arguments undergo full validation and original CAS; this does not refresh versions or prove a save.',
    },
  };
  return { ...definition, parameters };
}

export function preservePreparedArguments(
  store: AgentContextStore,
  projectId: string,
  taskId: string,
  tool: string,
  args: unknown,
  callId = `prepared:${randomUUID()}`,
): PreparedArgumentsRef {
  if (!PREPARED_ARGUMENT_TOOLS.has(tool))
    throw new Error('Tool does not support prepared arguments.');
  const argumentsHash = contextContentHash(JSON.stringify(args));
  const previous = store.resultForCall(projectId, taskId, callId);
  const result =
    previous &&
    previous.toolName === tool &&
    contextContentHash(JSON.stringify(previous.arguments)) === argumentsHash
      ? previous
      : store.putResult(
          projectId,
          taskId,
          callId,
          tool,
          JSON.stringify({ status: 'arguments_prepared', argumentsHash }),
          args,
          'pending',
        );
  return { resultId: result.id, argumentsHash };
}

export function resolvePreparedArguments(
  store: AgentContextStore,
  projectId: string,
  taskId: string,
  tool: string,
  input: unknown,
): unknown {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !('preparedArguments' in input)
  )
    return input;
  if (!PREPARED_ARGUMENT_TOOLS.has(tool))
    throw new Error('Tool does not support prepared arguments.');
  const { preparedArguments, ...corrections } = input as Record<string, unknown>;
  if (
    !preparedArguments ||
    typeof preparedArguments !== 'object' ||
    Array.isArray(preparedArguments)
  )
    throw new Error('Invalid preparedArguments reference.');
  const ref = preparedArguments as Record<string, unknown>;
  if (
    Object.keys(ref).some((key) => !['resultId', 'argumentsHash'].includes(key)) ||
    typeof ref.resultId !== 'string' ||
    typeof ref.argumentsHash !== 'string'
  )
    throw new Error('Invalid preparedArguments reference.');
  const result = store.result(projectId, taskId, ref.resultId);
  if (!result || result.toolName !== tool)
    throw new Error('Prepared arguments are outside this task/tool or unavailable.');
  if (contextContentHash(JSON.stringify(result.arguments)) !== ref.argumentsHash)
    throw new Error('PREPARED_ARGUMENTS_INTEGRITY_FAILED');
  if (!result.arguments || typeof result.arguments !== 'object' || Array.isArray(result.arguments))
    throw new Error('Stored arguments must be an object.');
  return { ...result.arguments, ...corrections };
}
