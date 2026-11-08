import type { LlmToolDefinition } from '@ai-video/contracts';

const OPERATIONS = {
  decision: { required: ['sourceRequirementId', 'decision'], optional: [] },
  review: {
    required: ['reviewId', 'reviewedTargetIds', 'conclusion', 'summary', 'issues'],
    optional: ['resolutions'],
  },
  state: { required: [], optional: ['stateOffset', 'targetGenerationId'] },
  result: {
    required: ['resultId'],
    optional: ['resultOffset', 'resultLimit', 'resultView', 'expectedHash', 'targetGenerationId'],
  },
  save: { required: ['remainingWork', 'workingNotes'], optional: [] },
  read: {
    required: [],
    optional: ['targetGenerationId', 'evidenceOffset', 'evidenceContentOffset', 'receiptOffset'],
  },
  plan: { required: ['deliverables'], optional: [] },
  partial: { required: ['reason'], optional: ['blockedByCallId'] },
} as const;

const REVIEW_EVIDENCE = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['referenceId', 'quote'],
    properties: {
      referenceId: { type: 'string', minLength: 1, maxLength: 256 },
      quote: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
};
export const TASK_REVIEW_PROPERTIES = {
  reviewedTargetIds: {
    type: 'array',
    minItems: 1,
    maxItems: 1000,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 256 },
    description:
      'Exact artifact IDs from reviewScope actually assessed in this call. Partial assessments are allowed; omitted targets remain pending. passed applies only to these targets, not automatically to the whole task.',
  },
  reviewId: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    description:
      'Opaque Worker snapshot ID from current state.pendingActions. Versions and hashes are managed by Worker.',
  },
  conclusion: { type: 'string', enum: ['passed', 'needs_revision'] },
  summary: { type: 'string', minLength: 1, maxLength: 4000 },
  issues: {
    type: 'array',
    maxItems: 100,
    description:
      'Content findings only. Invalid citations are retained as needs_correction, not confirmed defects. Correct one by supplying its issueId and valid current evidence, or explicitly withdraw a false positive through resolutions. Missing reads and stale versions are Worker readiness states, never content findings.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['targetId', 'category', 'description', 'evidence'],
      properties: {
        issueId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description:
            'Only for correcting an existing needs_correction finding on the same target. Omit for new findings.',
        },
        targetId: { type: 'string', minLength: 1, maxLength: 256 },
        category: { type: 'string', enum: ['content', 'consistency', 'requirement'] },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
        evidence: REVIEW_EVIDENCE,
      },
    },
  },
  resolutions: {
    type: 'array',
    maxItems: 100,
    description:
      'Close existing issueIds: resolved requires the affected target to change and be fully read; withdrawn requires an evidence-backed false-positive reassessment, without unnecessary content edits.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['issueId', 'disposition', 'reason', 'evidence'],
      properties: {
        issueId: { type: 'string', minLength: 1, maxLength: 256 },
        disposition: { type: 'string', enum: ['resolved', 'withdrawn'] },
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        evidence: REVIEW_EVIDENCE,
      },
    },
  },
};

export function taskCheckpointParameters(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operation'],
    properties,
    anyOf: Object.entries(OPERATIONS).map(([operation, fields]) => ({
      type: 'object',
      additionalProperties: false,
      required: ['operation', ...fields.required],
      properties: {
        operation: { const: operation },
        ...Object.fromEntries([...fields.required, ...fields.optional].map((key) => [key, {}])),
      },
    })),
  };
}

/** Validate the selected branch so errors cannot mention unrelated operations or echo bodies. */
export function taskCheckpointValidationDefinition(
  definition: LlmToolDefinition,
  args: unknown,
): LlmToolDefinition {
  if (definition.name !== 'conversation.task.checkpoint' || !args || typeof args !== 'object')
    return definition;
  const operation = (args as Record<string, unknown>).operation;
  const branches = definition.parameters.anyOf;
  let branch: Record<string, unknown> | undefined;
  if (Array.isArray(branches))
    for (const value of branches as unknown[]) {
      const item = value as { properties?: { operation?: { const?: unknown } } };
      if (item?.properties?.operation?.const === operation) {
        branch = value as Record<string, unknown>;
        break;
      }
    }
  if (!branch) return definition;
  const selected = branch as { properties: Record<string, unknown> };
  const properties = definition.parameters.properties as Record<string, unknown>;
  return {
    ...definition,
    parameters: {
      ...branch,
      properties: Object.fromEntries(
        Object.keys(selected.properties).map((key) => [
          key,
          key === 'operation' ? selected.properties[key] : properties[key],
        ]),
      ),
    },
  };
}
