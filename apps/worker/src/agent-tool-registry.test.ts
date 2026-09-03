import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_RESULT_LIMITS, type LlmToolDefinition } from '@ai-video/contracts';
import {
  AgentToolPolicyError,
  AgentToolRegistry,
  hashAgentToolArguments,
} from './agent-tool-registry.js';

function definition(name = 'test.read'): LlmToolDefinition {
  return {
    name,
    description: `Execute ${name}.`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  };
}

describe('AgentToolRegistry', () => {
  it('accepts an identical registration and rejects a conflicting one', () => {
    const registry = new AgentToolRegistry();
    registry.register([
      { definition: definition(), riskLevel: 'R0', executionLane: 'parallel-readonly' },
    ]);
    registry.register([
      { definition: definition(), riskLevel: 'R0', executionLane: 'parallel-readonly' },
    ]);

    expect(() =>
      registry.register([{ definition: definition(), riskLevel: 'R1', executionLane: 'serial' }]),
    ).toThrow('already registered with a different policy');
  });

  it.each([
    ['R2', 'explicit-user-intent'],
    ['R3', 'always'],
  ] as const)('does not allow %s confirmation policy to be weakened', (riskLevel, policy) => {
    const registry = new AgentToolRegistry();
    expect(() =>
      registry.register([
        {
          definition: definition(),
          riskLevel,
          confirmationPolicy: policy,
          executionLane: 'serial',
        },
      ]),
    ).toThrow(`weakens the ${riskLevel} confirmation policy`);
  });

  it('rejects unknown tools with the stable policy error contract', () => {
    const registry = new AgentToolRegistry();
    expect(() => registry.require('missing.tool')).toThrow('AGENT_TOOL_UNKNOWN');
    try {
      registry.require('missing.tool');
    } catch (error) {
      expect((error as AgentToolPolicyError).result()).toEqual({
        version: 1,
        status: 'rejected',
        error: {
          code: 'AGENT_TOOL_UNKNOWN',
          message: 'Tool missing.tool is not registered.',
          retryable: false,
        },
      });
    }
  });

  it('produces a stable nested argument hash without changing array order', () => {
    expect(hashAgentToolArguments({ z: 1, nested: { b: 2, a: 1 }, list: [2, 1] })).toBe(
      hashAgentToolArguments({ list: [2, 1], nested: { a: 1, b: 2 }, z: 1 }),
    );
    expect(hashAgentToolArguments({ list: [2, 1] })).not.toBe(
      hashAgentToolArguments({ list: [1, 2] }),
    );
  });

  it.each([
    { value: { api_key: 'secret' }, code: 'AGENT_TOOL_RESULT_FORBIDDEN' },
    {
      value: { nested: { dataUrl: 'data:image/png;base64,AAAA' } },
      code: 'AGENT_TOOL_RESULT_FORBIDDEN',
    },
    {
      value: { body: `data:image/png;base64,${'A'.repeat(512)}` },
      code: 'AGENT_TOOL_RESULT_FORBIDDEN',
    },
    { value: { body: 'A'.repeat(512) }, code: 'AGENT_TOOL_RESULT_FORBIDDEN' },
    {
      value: Array.from({ length: 101 }, (_, index) => index),
      code: 'AGENT_TOOL_RESULT_TOO_LARGE',
    },
    { value: { count: Number.NaN }, code: 'AGENT_TOOL_RESULT_INVALID' },
  ])('rejects unsafe Tool Result payloads ($code)', ({ value, code }) => {
    const registry = new AgentToolRegistry();
    expect(() => registry.serializeResult(value)).toThrow(code);
  });

  it('enforces the UTF-8 byte limit and accepts a bounded result', () => {
    const registry = new AgentToolRegistry();
    expect(() =>
      registry.serializeResult({ text: '界'.repeat(AGENT_TOOL_RESULT_LIMITS.maxJsonBytes) }),
    ).toThrow('AGENT_TOOL_RESULT_TOO_LARGE');
    expect(registry.serializeResult({ status: 'ok', items: [1, 2, 3] })).toBe(
      '{"status":"ok","items":[1,2,3]}',
    );
  });

  it('truncates model-visible text on a UTF-8 boundary below the result limit', () => {
    const registry = new AgentToolRegistry();
    const output = registry.serializeResultWithBoundedText(
      { version: 1, status: 'ok' },
      'content',
      `开头${'界'.repeat(30_000)}结尾`,
    );
    const parsed = JSON.parse(output) as {
      content: string;
      truncated: boolean;
      originalTextBytes: number;
    };
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
      AGENT_TOOL_RESULT_LIMITS.maxJsonBytes,
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.originalTextBytes).toBeGreaterThan(Buffer.byteLength(parsed.content, 'utf8'));
    expect(parsed.content).not.toContain('\uFFFD');
  });

  it('returns task-scoped snapshots and execution lanes without mutable definitions', () => {
    const registry = new AgentToolRegistry();
    registry.register([
      { definition: definition('read'), riskLevel: 'R0', executionLane: 'parallel-readonly' },
      { definition: definition('write'), riskLevel: 'R1', executionLane: 'serial' },
    ]);
    const snapshot = registry.snapshot('task', 'session', ['read', 'write', 'read']);

    expect(snapshot).toMatchObject({ taskId: 'task', projectSessionId: 'session' });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(['read', 'write']);
    expect(registry.executionMode('read')).toBe('parallel');
    expect(registry.executionMode('write')).toBe('sequential');
  });
});
