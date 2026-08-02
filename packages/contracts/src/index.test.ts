import { describe, expect, it } from 'vitest';
import { IPC_PROTOCOL_VERSION, type WorkerRequest } from './index.js';

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
