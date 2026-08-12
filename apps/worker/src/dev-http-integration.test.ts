import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { IPC_PROTOCOL_VERSION } from '@ai-video/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_HTTP_TOKEN_HEADER, devHttpTokenPath } from './dev-http-security.js';

const children: ChildProcess[] = [];
const tokenPaths: string[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  await Promise.all(tokenPaths.splice(0).map((path) => rm(path, { force: true })));
});

describe('development HTTP Worker endpoint', () => {
  it('enforces origin, JSON content, and the per-process session token', async () => {
    const port = await availablePort();
    const tokenPath = devHttpTokenPath(port);
    tokenPaths.push(tokenPath);
    const workerEntry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', workerEntry, '--http', String(port), '--dev-http'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    children.push(child);
    child.stderr?.resume();
    await expect
      .poll(() => existsSync(tokenPath), {
        timeout: 10_000,
        message: 'Development Worker did not publish its token.',
      })
      .toBe(true);
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const endpoint = `http://127.0.0.1:${port}/rpc`;
    const requestBody = JSON.stringify({
      id: 'dev-http-health',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'health',
      params: {},
    });

    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { origin: 'https://malicious.example', 'content-type': 'application/json' },
          body: requestBody,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:1420',
            'content-type': 'text/plain',
            [DEV_HTTP_TOKEN_HEADER]: token,
          },
          body: requestBody,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:1420', 'content-type': 'application/json' },
          body: requestBody,
        })
      ).status,
    ).toBe(403);

    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:1420',
        'content-type': 'application/json',
        [DEV_HTTP_TOKEN_HEADER]: token,
      },
      body: requestBody,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, result: { protocolVersion: 1 } });

    expect((await fetch(`http://127.0.0.1:${port}/media/missing`)).status).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/media/missing`, {
          headers: {
            origin: 'http://127.0.0.1:1420',
            [DEV_HTTP_TOKEN_HEADER]: token,
          },
        })
      ).status,
    ).toBe(404);
  });
});

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a development Worker test port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    timeout.unref();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('Development Worker test process did not exit.');
  }
}
