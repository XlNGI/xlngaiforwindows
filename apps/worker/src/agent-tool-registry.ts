import { createHash } from 'node:crypto';
import {
  AGENT_TOOL_RESULT_FORBIDDEN_FIELDS,
  AGENT_TOOL_RESULT_LIMITS,
  AGENT_TOOL_RISK_POLICIES,
  type AgentToolConfirmationPolicy,
  type AgentToolExecutionLane,
  type AgentToolPolicyErrorCode,
  type AgentToolPolicyErrorV1,
  type AgentToolRegistryEntryV1,
  type AgentToolRegistryV1,
  type AgentToolRiskLevel,
  type LlmToolDefinition,
} from '@ai-video/contracts';
import { AGENT_TOOL_POLICIES, ALL_AGENT_TOOL_DEFINITIONS } from './agent-tool-definitions.js';

export interface AgentToolRegistration {
  definition: LlmToolDefinition;
  riskLevel: AgentToolRiskLevel;
  confirmationPolicy?: AgentToolConfirmationPolicy;
  executionLane: AgentToolExecutionLane;
  resultSchema?: Record<string, unknown>;
}

const CONFIRMATION_STRENGTH: Record<AgentToolConfirmationPolicy, number> = {
  none: 0,
  'explicit-user-intent': 1,
  always: 2,
  'protected-ui': 3,
};

const FORBIDDEN_RESULT_FIELDS = new Set(AGENT_TOOL_RESULT_FORBIDDEN_FIELDS.map(normalizeFieldName));
const INLINE_DATA_URL = /data:[^;,\s]+;base64,/iu;
const INLINE_BASE64 = /(?:^|["':\s])(?:[A-Za-z0-9+/]{512,}={0,2})(?:$|["',}\s])/u;

export class AgentToolPolicyError extends Error {
  constructor(
    readonly code: AgentToolPolicyErrorCode,
    readonly policyMessage: string,
    readonly retryable = false,
  ) {
    super(`${code}: ${policyMessage}`);
    this.name = 'AgentToolPolicyError';
  }

  result(): AgentToolPolicyErrorV1 {
    return {
      version: 1,
      status: 'rejected',
      error: { code: this.code, message: this.policyMessage, retryable: this.retryable },
    };
  }
}

/** Worker-owned catalog and policy authority for every model-visible business tool. */
export class AgentToolRegistry {
  private readonly registrations = new Map<
    string,
    AgentToolRegistryEntryV1 & {
      definition: LlmToolDefinition;
    }
  >();

  register(registrations: readonly AgentToolRegistration[]): void {
    for (const registration of registrations) {
      const name = registration.definition.name.trim();
      if (!name) throw new Error('Agent tool name is required.');
      const baseline = AGENT_TOOL_RISK_POLICIES[registration.riskLevel].confirmationPolicy;
      const confirmationPolicy = registration.confirmationPolicy ?? baseline;
      if (CONFIRMATION_STRENGTH[confirmationPolicy] < CONFIRMATION_STRENGTH[baseline]) {
        throw new Error(
          `Agent tool ${name} weakens the ${registration.riskLevel} confirmation policy.`,
        );
      }
      const entry = {
        version: 1 as const,
        name,
        riskLevel: registration.riskLevel,
        confirmationPolicy,
        executionLane: registration.executionLane,
        inputSchema: structuredClone(registration.definition.parameters),
        resultSchema: structuredClone(registration.resultSchema ?? { type: 'object' }),
        definition: cloneDefinition(registration.definition),
      };
      const existing = this.registrations.get(name);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(entry)) {
          throw new Error(`Agent tool ${name} is already registered with a different policy.`);
        }
        continue;
      }
      this.registrations.set(name, entry);
    }
  }

  has(name: string): boolean {
    return this.registrations.has(name);
  }

  require(name: string): AgentToolRegistryEntryV1 {
    const registration = this.registrations.get(name);
    if (!registration) {
      throw new AgentToolPolicyError('AGENT_TOOL_UNKNOWN', `Tool ${name} is not registered.`);
    }
    return toEntry(registration);
  }

  definition(name: string): LlmToolDefinition {
    const registration = this.registrations.get(name);
    if (!registration) {
      throw new AgentToolPolicyError('AGENT_TOOL_UNKNOWN', `Tool ${name} is not registered.`);
    }
    return cloneDefinition(registration.definition);
  }

  authorizedDefinitions(handles: ReadonlyMap<string, string>): LlmToolDefinition[] {
    return [...handles.entries()].map(([name, authorizationHandle]) => ({
      ...this.definition(name),
      authorizationHandle,
    }));
  }

  snapshot(
    taskId: string,
    projectSessionId: string,
    names: readonly string[],
  ): AgentToolRegistryV1 {
    return {
      version: 1,
      taskId,
      projectSessionId,
      tools: [...new Set(names)].map((name) => this.require(name)),
      createdAt: new Date().toISOString(),
    };
  }

  executionMode(name: string): 'parallel' | 'sequential' {
    return this.require(name).executionLane === 'parallel-readonly' ? 'parallel' : 'sequential';
  }

  assertResultText(text: string): void {
    if (Buffer.byteLength(text, 'utf8') > AGENT_TOOL_RESULT_LIMITS.maxJsonBytes) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_TOO_LARGE',
        `Tool Result exceeds ${AGENT_TOOL_RESULT_LIMITS.maxJsonBytes} bytes.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_INVALID',
        'Tool Result must be a JSON value.',
      );
    }
    this.assertResultValue(parsed);
  }

  assertResultValue(value: unknown): void {
    inspectResultValue(value, '$', new WeakSet<object>());
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_INVALID',
        'Tool Result must be JSON serializable.',
      );
    }
    if (serialized === undefined) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_INVALID',
        'Tool Result is not serializable.',
      );
    }
    if (Buffer.byteLength(serialized, 'utf8') > AGENT_TOOL_RESULT_LIMITS.maxJsonBytes) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_TOO_LARGE',
        `Tool Result exceeds ${AGENT_TOOL_RESULT_LIMITS.maxJsonBytes} bytes.`,
      );
    }
  }

  serializeResult(value: unknown): string {
    this.assertResultValue(value);
    return JSON.stringify(value);
  }

  serializeResultWithBoundedText(value: object, field: string, text: string): string {
    const originalTextBytes = Buffer.byteLength(text, 'utf8');
    let textBudget = Math.min(
      originalTextBytes,
      AGENT_TOOL_RESULT_LIMITS.maxJsonBytes - AGENT_TOOL_RESULT_LIMITS.maxSummaryCharacters,
    );
    while (textBudget >= 0) {
      const bounded = truncateUtf8Text(text, textBudget);
      try {
        return this.serializeResult({
          ...value,
          [field]: bounded,
          truncated: bounded !== text,
          originalTextBytes,
        });
      } catch (error) {
        if (
          !(error instanceof AgentToolPolicyError) ||
          error.code !== 'AGENT_TOOL_RESULT_TOO_LARGE' ||
          textBudget === 0
        ) {
          throw error;
        }
        textBudget = Math.max(0, textBudget - Math.max(1024, Math.ceil(textBudget / 4)));
      }
    }
    throw new AgentToolPolicyError(
      'AGENT_TOOL_RESULT_TOO_LARGE',
      'Tool Result metadata exceeds the maximum size.',
    );
  }
}

export const unifiedAgentToolRegistry = new AgentToolRegistry();
unifiedAgentToolRegistry.register(
  ALL_AGENT_TOOL_DEFINITIONS.map((definition) => {
    const policy = AGENT_TOOL_POLICIES[definition.name];
    if (!policy) throw new Error(`Agent tool ${definition.name} is missing its policy.`);
    return { definition, ...policy };
  }),
);

export function hashAgentToolArguments(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeValue(value)))
    .digest('hex');
}

export function truncateUtf8Text(value: string, maximumBytes: number): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('maximumBytes must be a non-negative integer.');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = Math.min(maximumBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function inspectResultValue(value: unknown, path: string, ancestors: WeakSet<object>): void {
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_RESULT_INVALID',
      `Tool Result contains a non-JSON value at ${path}.`,
    );
  }
  if (typeof value === 'string') {
    if (INLINE_DATA_URL.test(value) || INLINE_BASE64.test(value)) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_FORBIDDEN',
        `Tool Result contains inline binary data at ${path}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > AGENT_TOOL_RESULT_LIMITS.maxCollectionItems) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_TOO_LARGE',
        `Tool Result collection at ${path} exceeds ${AGENT_TOOL_RESULT_LIMITS.maxCollectionItems} items.`,
      );
    }
    assertNotCircular(value, path, ancestors);
    value.forEach((item, index) => inspectResultValue(item, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_RESULT_INVALID',
      `Tool Result contains a non-plain object at ${path}.`,
    );
  }
  assertNotCircular(value, path, ancestors);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RESULT_FIELDS.has(normalizeFieldName(key))) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_RESULT_FORBIDDEN',
        `Tool Result field ${path}.${key} is forbidden.`,
      );
    }
    if (item === undefined) continue;
    inspectResultValue(item, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeValue(item)]),
  );
}

function cloneDefinition(definition: LlmToolDefinition): LlmToolDefinition {
  return { ...definition, parameters: structuredClone(definition.parameters) };
}

function toEntry(
  registration: AgentToolRegistryEntryV1 & { definition: LlmToolDefinition },
): AgentToolRegistryEntryV1 {
  return structuredClone({
    version: registration.version,
    name: registration.name,
    riskLevel: registration.riskLevel,
    confirmationPolicy: registration.confirmationPolicy,
    executionLane: registration.executionLane,
    inputSchema: registration.inputSchema,
    resultSchema: registration.resultSchema,
  });
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function assertNotCircular(value: object, path: string, ancestors: WeakSet<object>): void {
  if (ancestors.has(value)) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_RESULT_INVALID',
      `Tool Result contains a circular value at ${path}.`,
    );
  }
  ancestors.add(value);
}
