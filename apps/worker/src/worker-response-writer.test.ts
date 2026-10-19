import { expect, it } from 'vitest';
import { JsonLineWriter } from './native-provider-bridge.js';
import { writeWorkerResponse } from './worker-response-writer.js';
import type { WorkerResponse } from '@ai-video/contracts';

it('settles oversized results by correlation ID and keeps concurrent replies usable', async () => {
  const lines: string[] = [];
  const writer = new JsonLineWriter({
    write(line, done) {
      lines.push(line);
      done();
      return true;
    },
  });
  await Promise.all([
    writeWorkerResponse(writer, {
      id: 'large-preview',
      protocolVersion: 1,
      ok: true,
      result: 'x'.repeat(3 * 1024 * 1024),
    }),
    writeWorkerResponse(writer, {
      id: 'health',
      protocolVersion: 1,
      ok: true,
      result: { pid: 1 },
    }),
  ]);
  const replies = lines.map((line) => JSON.parse(line) as WorkerResponse);
  expect(replies.find((reply) => reply.id === 'large-preview')).toMatchObject({
    ok: false,
    error: { code: 'INTERNAL_ERROR', retryable: false, operation: 'ipc.write' },
  });
  const preview = replies.find((reply) => reply.id === 'large-preview');
  if (!preview || preview.ok) throw new Error('Expected an oversized reply error.');
  expect(preview.error.message).toContain('2 MiB');
  expect(replies.find((reply) => reply.id === 'health')).toMatchObject({
    ok: true,
    result: { pid: 1 },
  });
  expect(lines.every((line) => Buffer.byteLength(line) < 2 * 1024 * 1024)).toBe(true);
});
