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
});
