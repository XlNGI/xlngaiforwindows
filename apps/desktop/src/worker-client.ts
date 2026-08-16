import { invoke } from '@tauri-apps/api/core';
import {
  IPC_PROTOCOL_VERSION,
  type WorkerError,
  type WorkerMethod,
  type WorkerMethodMap,
  type WorkerRequest,
  type WorkerResponse,
} from '@ai-video/contracts';

export class WorkerClientError extends Error {
  constructor(readonly workerError: WorkerError) {
    super(workerError.message);
    this.name = 'WorkerClientError';
  }
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export async function callWorker<M extends WorkerMethod>(
  method: M,
  params: WorkerMethodMap[M]['params'],
): Promise<WorkerMethodMap[M]['result']> {
  const request: WorkerRequest<M> = {
    id: crypto.randomUUID(),
    protocolVersion: IPC_PROTOCOL_VERSION,
    method,
    params,
  };

  const response = isTauri()
    ? await invoke<WorkerResponse<M>>('worker_request', { request })
    : await fetch('/worker-rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }).then(async (result) => {
        if (!result.ok) throw new Error(`Worker HTTP request failed (${result.status}).`);
        return (await result.json()) as WorkerResponse<M>;
      });

  if (!response.ok) throw new WorkerClientError(response.error);
  return response.result;
}
