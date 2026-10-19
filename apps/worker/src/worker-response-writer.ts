import { IPC_PROTOCOL_VERSION, type WorkerResponse } from '@ai-video/contracts';
import { JsonLineWriter, SidecarEnvelopeSizeError } from './native-provider-bridge.js';

/** Oversized results must settle their caller instead of triggering a Worker restart. */
export async function writeWorkerResponse<T extends { id: string }>(
  writer: JsonLineWriter,
  response: T,
): Promise<void> {
  try {
    await writer.write(response);
  } catch (error) {
    if (!(error instanceof SidecarEnvelopeSizeError)) throw error;
    await writer.write({
      id: response.id,
      protocolVersion: IPC_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message:
          'Worker reply exceeds the 2 MiB IPC limit. Use local media references instead of inline file data.',
        retryable: false,
        operation: 'ipc.write',
      },
    } satisfies WorkerResponse);
  }
}
