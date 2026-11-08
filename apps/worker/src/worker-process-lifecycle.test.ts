import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { IPC_PROTOCOL_VERSION } from '@ai-video/contracts';

it.each(['control', 'eof'] as const)(
  'stops an isolated production Worker cleanly on %s',
  async (method) => {
    const directory = await mkdtemp(join(tmpdir(), 'worker-host-lifecycle-'));
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        fileURLToPath(new URL('index.ts', import.meta.url)),
      ],
      {
        env: { ...process.env, AI_VIDEO_APP_DATA_DIR: directory },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const replies = new Map<string, Record<string, unknown>>();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id === 'string') replies.set(value.id, value);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      child.stdin.write(
        JSON.stringify({
          id: 'health',
          protocolVersion: IPC_PROTOCOL_VERSION,
          method: 'health',
          params: {},
        }) + '\n',
      );
      await expect
        .poll(
          () => {
            if (child.exitCode !== null) throw new Error(stderr);
            return replies.get('health');
          },
          { timeout: 10000 },
        )
        .toMatchObject({ ok: true });
      if (method === 'eof') child.stdin.end();
      else
        child.stdin.write(
          JSON.stringify({
            id: 'shutdown',
            kind: 'host.control',
            version: 1,
            method: 'worker.shutdown',
            reason: 'host_shutdown',
          }) + '\n',
        );
      await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
      expect(await exited, stderr).toBe(0);
      if (method === 'control')
        expect(replies.get('shutdown')).toMatchObject({
          ok: true,
          result: { stopped: true, reason: 'host_shutdown' },
        });
      expect(stderr).not.toContain('worker.shutdown');
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
      lines.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  25000,
);
