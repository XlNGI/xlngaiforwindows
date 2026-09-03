import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_RESULT_FORBIDDEN_FIELDS,
  AGENT_TOOL_RESULT_LIMITS,
  AGENT_TOOL_RISK_LEVELS,
  AGENT_TOOL_RISK_POLICIES,
  IPC_PROTOCOL_VERSION,
  MEDIA_GENERATION_ALLOWED_TRANSITIONS,
  MEDIA_GENERATION_TERMINAL_STATES,
  type WorkerRequest,
} from './index.js';

describe('IPC protocol', () => {
  it('keeps the health request on protocol v1', () => {
    const request: WorkerRequest<'health'> = {
      id: 'test',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'health',
      params: {},
    };

    expect(request.protocolVersion).toBe(1);
  });

  it('types M7 maintenance requests without accepting payload data for cache operations', () => {
    const cacheRequest: WorkerRequest<'maintenance.cache.inspect'> = {
      id: 'cache',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'maintenance.cache.inspect',
      params: {},
    };
    const diagnosticRequest: WorkerRequest<'maintenance.diagnostics.export'> = {
      id: 'diagnostics',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'maintenance.diagnostics.export',
      params: { destinationRoot: 'D:\\Support' },
    };

    expect(cacheRequest.params).toEqual({});
    expect(diagnosticRequest.params.destinationRoot).toBe('D:\\Support');
  });
});

describe('P0 Agent orchestration contracts', () => {
  it('freezes all risk levels and requires confirmation for paid or protected operations', () => {
    expect(AGENT_TOOL_RISK_LEVELS).toEqual(['R0', 'R1', 'R2', 'R3']);
    expect(AGENT_TOOL_RISK_POLICIES.R2.confirmationPolicy).toBe('always');
    expect(AGENT_TOOL_RISK_POLICIES.R3.confirmationPolicy).toBe('protected-ui');
  });

  it('keeps media terminal states monotonic and models uncertain submission explicitly', () => {
    expect(MEDIA_GENERATION_ALLOWED_TRANSITIONS.submitting).toContain('submission_unknown');
    for (const state of MEDIA_GENERATION_TERMINAL_STATES) {
      expect(MEDIA_GENERATION_ALLOWED_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('sets a bounded Tool Result contract that excludes secrets and inline media', () => {
    expect(AGENT_TOOL_RESULT_LIMITS.maxJsonBytes).toBeLessThan(2 * 1024 * 1024);
    expect(AGENT_TOOL_RESULT_FORBIDDEN_FIELDS).toEqual(
      expect.arrayContaining([
        'authorizationHandle',
        'secret',
        'absolutePath',
        'base64',
        'dataUrl',
      ]),
    );
  });
});
