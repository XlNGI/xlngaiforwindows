import type { LlmToolDefinition } from '@ai-video/contracts';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import { PREPARED_DELIVERY_TOOLS, preparedDeletableFields } from './agent-delivery-capabilities.js';
// Reuse the durable working-result store, including calls rejected before execution.
export const PREPARED_ARGUMENT_TOOLS: ReadonlySet<string> = new Set([
  ...PREPARED_DELIVERY_TOOLS,
  'production.bundle',
  'production.bundle.submit',
]);
export type PreparedArgumentsRef = {
  resultId: string;
  /** Accepted for older model turns; the task-scoped result ID is authoritative. */
  argumentsHash?: string;
  deleteFields?: string[];
  setFields?: {
    'scene.title': string;
  };
  patches?: Array<{
    op: 'set' | 'remove';
    path: string;
    value?: unknown;
  }>;
};
export function preparedArgumentsDefinition(definition: LlmToolDefinition): LlmToolDefinition {
  if (!PREPARED_ARGUMENT_TOOLS.has(definition.name)) return definition;
  const deletableFields = preparedDeletableFields(definition.name);
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
      required: ['resultId'],
      properties: {
        resultId: { type: 'string' },
        argumentsHash: {
          type: 'string',
          description:
            'Legacy compatibility field. Omit; resultId identifies the immutable stored arguments.',
        },
        ...(['production.bundle', 'production.bundle.submit'].includes(definition.name)
          ? {
              patches: {
                type: 'array',
                minItems: 1,
                maxItems: 32,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['op', 'path'],
                  properties: {
                    op: { enum: ['set', 'remove'] },
                    path: { type: 'string', maxLength: 1000 },
                    value: {},
                  },
                },
                description:
                  'Explicit JSON pointer corrections. put uses /part/documents, /part/scenes or /part/shots; submit uses /prompts or /complete. remove may also delete an unknown submit root field. Never change partKey, expectedRevision or operation. Do not override patched lists. Original schema, CAS and domain checks still apply.',
              },
            }
          : {}),
        deleteFields: {
          type: 'array',
          maxItems: deletableFields.size,
          uniqueItems: true,
          items: {
            type: 'string',
            ...(deletableFields.size ? { enum: [...deletableFields] } : {}),
          },
        },
        ...(definition.name === 'scene.structure.stage'
          ? {
              setFields: {
                type: 'object',
                additionalProperties: false,
                required: ['scene.title'],
                properties: { 'scene.title': { type: 'string', minLength: 1, maxLength: 200 } },
                description:
                  'put_scene only: explicitly correct the staged scene title while retaining the complete scene prompt, bindings and timing. This is the only supported nested field; do not also override scene.',
              },
            }
          : {}),
      },
      description:
        'Reuse same-task, same-tool stored arguments after a failure using resultId. Do not copy a hash. Supply corrected top-level fields alongside this reference; deleteFields explicitly removes permitted optional fields before applying corrections. Do not delete and override the same field. Full action/authorization/CAS validation still applies; this never refreshes versions or proves a save.',
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
): PreparedArgumentsRef {
  if (!PREPARED_ARGUMENT_TOOLS.has(tool))
    throw new Error('Tool does not support prepared arguments.');
  const argumentsHash = contextContentHash(JSON.stringify(args));
  const callId = `prepared:${tool}:${argumentsHash}`;
  const result = store.putResult(
    projectId,
    taskId,
    callId,
    tool,
    JSON.stringify({ status: 'arguments_prepared', argumentsHash }),
    args,
    'pending',
  );
  return { resultId: result.id };
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
    Object.keys(ref).some(
      (key) => !['resultId', 'argumentsHash', 'deleteFields', 'setFields', 'patches'].includes(key),
    ) ||
    typeof ref.resultId !== 'string' ||
    (ref.argumentsHash !== undefined && typeof ref.argumentsHash !== 'string')
  )
    throw new Error('Invalid preparedArguments reference.');
  const result = store.result(projectId, taskId, ref.resultId);
  if (!result || result.toolName !== tool)
    throw new Error('Prepared arguments are outside this task/tool or unavailable.');
  let storedMetadata: unknown;
  try {
    storedMetadata = JSON.parse(result.content);
  } catch {
    storedMetadata = undefined;
  }
  if (
    storedMetadata &&
    typeof storedMetadata === 'object' &&
    !Array.isArray(storedMetadata) &&
    (storedMetadata as Record<string, unknown>).status === 'arguments_prepared' &&
    contextContentHash(JSON.stringify(result.arguments)) !==
      (storedMetadata as Record<string, unknown>).argumentsHash
  )
    throw new Error('PREPARED_ARGUMENTS_INTEGRITY_FAILED');
  if (!result.arguments || typeof result.arguments !== 'object' || Array.isArray(result.arguments))
    throw new Error('Stored arguments must be an object.');
  const merged = structuredClone(result.arguments) as Record<string, unknown>;
  if (
    tool === 'production.bundle.submit' &&
    ['partKey', 'expectedRevision', 'operation'].some(
      (key) => Object.hasOwn(corrections, key) && corrections[key] !== merged[key],
    )
  )
    throw new Error(
      'PREPARED_ARGUMENTS_PATCH_INVALID: Keep original submit partKey and expectedRevision; a stale revision requires a new explicitly submitted part, not changing prepared CAS.',
    );
  if (tool === 'production.bundle.submit')
    for (const key of ['partKey', 'expectedRevision', 'operation']) delete corrections[key];
  const deletableFields = preparedDeletableFields(tool);
  if (ref.deleteFields !== undefined) {
    if (
      !Array.isArray(ref.deleteFields) ||
      ref.deleteFields.length > deletableFields.size ||
      new Set(ref.deleteFields).size !== ref.deleteFields.length
    )
      throw new Error(
        'PREPARED_ARGUMENTS_DELETE_INVALID: Provide distinct permitted top-level fields.',
      );
    for (const key of ref.deleteFields) {
      if (
        typeof key !== 'string' ||
        !deletableFields.has(key) ||
        !Object.hasOwn(merged, key) ||
        Object.hasOwn(corrections, key)
      )
        throw new Error(
          `PREPARED_ARGUMENTS_DELETE_INVALID: ${String(key)} is absent, protected, or also overridden.`,
        );
      delete merged[key];
    }
  }
  if (ref.setFields !== undefined) {
    const fields = ref.setFields;
    if (
      tool !== 'scene.structure.stage' ||
      merged.operation !== 'put_scene' ||
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      Object.keys(fields).length !== 1 ||
      !Object.hasOwn(fields, 'scene.title') ||
      typeof (fields as Record<string, unknown>)['scene.title'] !== 'string' ||
      !(fields as Record<string, string>)['scene.title']!.trim() ||
      (fields as Record<string, string>)['scene.title']!.length > 200 ||
      !merged.scene ||
      typeof merged.scene !== 'object' ||
      Array.isArray(merged.scene) ||
      Object.hasOwn(corrections, 'scene') ||
      (corrections.operation !== undefined && corrections.operation !== 'put_scene')
    )
      throw new Error(
        'PREPARED_ARGUMENTS_SET_INVALID: Only scene.title may be corrected for stored put_scene arguments; do not also override scene or change operation.',
      );
    merged.scene = {
      ...merged.scene,
      title: (fields as Record<string, string>)['scene.title'],
    };
  }
  if (ref.patches !== undefined) {
    const submission = tool === 'production.bundle.submit';
    if (
      submission
        ? Object.keys(corrections).length > 0
        : tool !== 'production.bundle' ||
          merged.operation !== 'put' ||
          (corrections.operation !== undefined && corrections.operation !== 'put') ||
          Object.hasOwn(corrections, 'part')
    )
      throw new Error(
        'PREPARED_ARGUMENTS_PATCH_INVALID: patch stored bundle put only; do not override part or operation.',
      );
    patchBundleArguments(merged, ref.patches, submission);
  }
  return { ...merged, ...corrections };
}
/** Apply only model-supplied corrections, never infer missing creative content. */
function patchBundleArguments(
  root: Record<string, unknown>,
  patches: unknown,
  submission = false,
): void {
  const invalid = (detail: string): never => {
    throw new Error(`PREPARED_ARGUMENTS_PATCH_INVALID: ${detail}`);
  };
  if (!Array.isArray(patches) || !patches.length || patches.length > 32)
    invalid('Provide 1–32 explicit patches.');
  for (const raw of patches as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Patch must be an object.');
    const patch = raw as Record<string, unknown>;
    if (
      Object.keys(patch).some((k) => !['op', 'path', 'value'].includes(k)) ||
      !['set', 'remove'].includes(String(patch.op)) ||
      typeof patch.path !== 'string' ||
      patch.path.length > 1000 ||
      (patch.op === 'set' ? !Object.hasOwn(patch, 'value') : Object.hasOwn(patch, 'value'))
    )
      invalid('set requires value; remove accepts only op and path.');
    const path = patch.path as string;
    if (!path.startsWith('/') || /~(?![01])/u.test(path)) invalid('Use a valid JSON pointer.');
    const keys = path
      .slice(1)
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    const submissionPath =
      ['prompts', 'complete'].includes(keys[0]!) ||
      (keys.length === 1 &&
        patch.op === 'remove' &&
        Object.hasOwn(root, keys[0]!) &&
        !['partKey', 'expectedRevision', 'operation'].includes(keys[0]!));
    if (
      keys.some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)) ||
      (submission
        ? !submissionPath
        : keys.length < 2 ||
          keys[0] !== 'part' ||
          !['documents', 'scenes', 'shots'].includes(keys[1]!))
    )
      invalid(
        submission
          ? 'Only prompts/complete or an unsupported root field may be patched.'
          : 'Only fields under part.documents/scenes/shots may be patched.',
      );
    let parent: unknown = root;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key))
        invalid(`Missing parent in ${path}.`);
      if (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= parent.length))
        invalid(`Invalid array index in ${path}.`);
      parent = (parent as Record<string, unknown>)[key];
    }
    const key = keys.at(-1)!;
    if (!parent || typeof parent !== 'object') invalid(`Missing parent in ${path}.`);
    if (
      Array.isArray(parent) &&
      (patch.op === 'remove' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= parent.length)
    )
      invalid(`Only existing array elements may be set in ${path}; replace the array to resize.`);
    const target = parent as Record<string, unknown>;
    if (patch.op === 'remove') {
      if (!Object.hasOwn(target, key)) invalid(`Absent field ${path}.`);
      delete target[key];
    } else target[key] = structuredClone(patch.value);
  }
}
