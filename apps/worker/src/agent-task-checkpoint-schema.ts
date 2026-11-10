import type { LlmToolDefinition } from '@ai-video/contracts';

const OPERATIONS = {
  decision: { required: ['sourceRequirementId', 'decision'], optional: [] },
  review: {
    required: ['reviewId', 'reviewedTargetIds', 'conclusion', 'summary', 'issues'],
    optional: ['resolutions', 'requirementAssessments'],
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
      referenceId: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description:
          'Use candidate:key for actual candidate fields; use an original requirement ID for field=requirement. A candidate ID never identifies requirement text. Skill instructions are not snapshot requirement IDs.',
      },
      quote: { type: 'string', minLength: 1, maxLength: 2000 },
      version: {
        description:
          'Optional echoed snapshot version, verified against Worker state. Prefer omitting it.',
      },
      field: {
        type: 'string',
        enum: ['prompt', 'contentMarkdown', 'timing', 'bindings', 'requirement', 'sampleText'],
        description:
          'The field of referenceId itself. Candidate prose uses prompt; original requirement text uses requirement with its exact requirement ID. Do not attach field=requirement to candidate:key.',
      },
    },
  },
};
export const TASK_REVIEW_PROPERTIES = {
  requirementAssessments: {
    type: 'array',
    maxItems: 1000,
    description:
      'Assess every original requirement for every reviewed target. Group Worker unit IDs in requirementIds only when the verdict, reason and evidence apply to every listed unit; Worker expands and validates every pair. satisfied cites actual target prompt/contentMarkdown. not_applicable needs source/requirement evidence and a concrete scope reason. Missing/conflicting/uncertain checks require an open issue. Read the full original text to catch omitted checks; a model checklist is not the source of truth.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'reason'],
      allOf: [
        {
          oneOf: [
            { required: ['requirementId'], not: { required: ['requirementIds'] } },
            { required: ['requirementIds'], not: { required: ['requirementId'] } },
          ],
        },
        {
          oneOf: [
            { required: ['targetId'], not: { required: ['targetIds'] } },
            {
              required: ['targetIds'],
              not: { required: ['targetId'] },
              properties: { verdict: { const: 'not_applicable' } },
            },
          ],
        },
      ],
      properties: {
        requirementId: { type: 'string', minLength: 1, maxLength: 256 },
        requirementIds: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 256 },
          description:
            'Compact alternative to requirementId for current Worker units sharing the same verdict, reason and evidence. Omit requirementQuote. Every expanded requirement/target pair is still checked; keep each batch within 1000 pairs.',
        },
        requirementQuote: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description:
            'May be omitted only for Worker-generated requirement units; their ID selects the complete original slice. Legacy requirements still require an exact quote.',
        },
        targetId: { type: 'string', minLength: 1, maxLength: 256 },
        targetIds: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 256 },
          description:
            'Only for Worker requirement units judged not_applicable to every explicitly listed target with the same scope reason. Worker expands and validates each target. satisfied always needs individual target body evidence.',
        },
        verdict: { enum: ['satisfied', 'missing', 'conflict', 'uncertain', 'not_applicable'] },
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        evidence: {
          ...REVIEW_EVIDENCE,
          description:
            'Required for satisfied/missing/conflict/uncertain and legacy requirements. For a Worker unit judged not_applicable, may be omitted: Worker cites that exact original unit; your concrete scope reason is still required.',
        },
      },
    },
  },
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
  conclusion: {
    type: 'string',
    enum: ['passed', 'needs_revision'],
    description:
      'Verdict only for reviewedTargetIds. Partial batches use that target list, never conclusion=partial. passed does not approve omitted targets.',
  },
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
      'Close existing issueIds on this batch only: resolved requires the affected target to change and be fully read and evidence must cite that target ID, not a parent scene. withdrawn requires an evidence-backed false-positive reassessment citing that target or its original references, without unnecessary content edits. Issues on omitted targets remain open and block stage completion, not unrelated target assessments.',
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

/** Bundle begin owns its delivery contract; bundle tasks use structural checks only. */
export function bundleCheckpointDefinition(definition: LlmToolDefinition): LlmToolDefinition {
  if (definition.name !== 'conversation.task.checkpoint') return definition;
  const operations = ['result', 'state', 'partial'];
  const branches = (definition.parameters.anyOf as Array<Record<string, unknown>>).filter(
    (branch) =>
      operations.includes((branch.properties as { operation: { const: string } }).operation.const),
  );
  const keys = new Set(
    branches.flatMap((branch) => Object.keys(branch.properties as Record<string, unknown>)),
  );
  const properties = definition.parameters.properties as Record<string, unknown>;
  return {
    ...definition,
    description:
      'Bundle delivery uses structured validation and independent database readback; it does not use semantic review. state pages task metadata and result pages immutable execution-log content or arguments when needed. Current taskState already contains the active Skill and pending action; use those directly. begin already registered the delivery contract. partial requires a concrete blocker and never proves completion.',
    parameters: {
      ...definition.parameters,
      properties: {
        ...Object.fromEntries([...keys].map((key) => [key, properties[key]])),
        operation: { type: 'string', enum: operations },
      },
      anyOf: branches,
    },
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
