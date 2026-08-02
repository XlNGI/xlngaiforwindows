import { describe, expect, it } from 'vitest';
import { authorizeDevHttpRequest, createDevHttpToken } from './dev-http-security.js';

describe('development HTTP Worker security', () => {
  it('creates independent 256-bit session tokens', () => {
    const first = createDevHttpToken();
    const second = createDevHttpToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
  });

  it('accepts only an allowed Vite origin with JSON and the current token', () => {
    const token = createDevHttpToken();
    expect(
      authorizeDevHttpRequest(
        {
          origin: 'http://127.0.0.1:1420',
          contentType: 'application/json; charset=utf-8',
          token,
        },
        token,
      ),
    ).toEqual({ ok: true, status: 200 });
  });

  it('rejects untrusted origins even when they know the token', () => {
    const token = createDevHttpToken();
    expect(
      authorizeDevHttpRequest(
        { origin: 'https://malicious.example', contentType: 'application/json', token },
        token,
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects simple cross-origin content types and missing session tokens', () => {
    const token = createDevHttpToken();
    expect(
      authorizeDevHttpRequest(
        { origin: 'http://127.0.0.1:1420', contentType: 'text/plain', token },
        token,
      ),
    ).toMatchObject({ ok: false, status: 415 });
    expect(
      authorizeDevHttpRequest(
        { origin: 'http://127.0.0.1:1420', contentType: 'application/json' },
        token,
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });
});
