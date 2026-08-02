import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEV_HTTP_TOKEN_HEADER = 'x-ai-video-dev-token';

const ALLOWED_DEV_ORIGINS = new Set(['http://127.0.0.1:1420', 'http://localhost:1420']);

export interface DevHttpAuthorization {
  ok: boolean;
  status: number;
  message?: string;
}

export function createDevHttpToken(): string {
  return randomBytes(32).toString('hex');
}

export function devHttpTokenPath(port: number): string {
  return join(tmpdir(), `ai-video-worker-${port}.token`);
}

export function publishDevHttpToken(port: number, token: string): string {
  const path = devHttpTokenPath(port);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    rmSync(path, { force: true });
    renameSync(temporaryPath, path);
    return path;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function removeDevHttpToken(path: string, token: string): void {
  try {
    const current = readFileSync(path, 'utf8').trim();
    if (tokensMatch(current, token)) rmSync(path, { force: true });
  } catch {
    // Missing or replaced token files belong to another lifecycle and must be left alone.
  }
}

export function authorizeDevHttpRequest(
  headers: {
    origin?: string;
    contentType?: string;
    token?: string;
  },
  expectedToken: string,
): DevHttpAuthorization {
  if (!headers.origin || !ALLOWED_DEV_ORIGINS.has(headers.origin)) {
    return { ok: false, status: 403, message: 'Development Worker origin was rejected.' };
  }
  const mediaType = headers.contentType?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return { ok: false, status: 415, message: 'Development Worker requires application/json.' };
  }
  if (!headers.token || !tokensMatch(headers.token, expectedToken)) {
    return { ok: false, status: 403, message: 'Development Worker session was rejected.' };
  }
  return { ok: true, status: 200 };
}

function tokensMatch(value: string, expected: string): boolean {
  const receivedBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}
