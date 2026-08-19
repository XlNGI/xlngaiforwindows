import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchError, ResearchService } from './research-service.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('ResearchService', () => {
  it('fails closed instead of using Worker network access when the Native bridge is unavailable', async () => {
    vi.stubEnv('AI_VIDEO_RESEARCH_BRIDGE_URL', '');
    vi.stubEnv('AI_VIDEO_RESEARCH_BRIDGE_TOKEN', '');
    const service = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });

    await expect(
      service.search({ taskId: 'task-bridge', attemptId: 'attempt-bridge', query: 'source' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchError>>({ code: 'RESEARCH_SEARCH_FAILED' }),
    );
    vi.unstubAllEnvs();
  });

  it('searches, binds source handles, extracts text, and writes a local cache entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-service-'));
    directories.push(root);
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.startsWith('https://search.test/')) {
        return Promise.resolve(
          new Response(
            '<ol><li class="b_algo"><h2><a href="https://example.test/mao?utm_source=search">Mao Zedong</a></h2><p>Chinese historical figure.</p></li></ol>',
            { headers: { 'content-type': 'text/html' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          '<html><script>ignore()</script><h1>Mao Zedong</h1><p>Verified source text.</p></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
      );
    });
    const service = new ResearchService({
      fetch: fetcher,
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });

    const search = await service.search({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      query: 'Mao Zedong biography',
    });
    expect(search).toMatchObject({ status: 'searched', resultCount: 1 });
    expect(search.sources[0]?.canonicalUrl).toBe('https://example.test/mao');

    const fetched = await service.fetchSource({
      projectRoot: root,
      taskId: 'task-1',
      attemptId: 'attempt-1',
      sourceHandle: search.sources[0]!.sourceHandle,
    });
    expect(fetched).toMatchObject({
      status: 'fetched',
      untrusted: true,
      truncated: false,
    });
    expect(fetched.content).toContain('Verified source text.');
    expect(fetched.content).not.toContain('ignore()');
    expect(await readFile(join(root, fetched.cacheRelativePath), 'utf8')).toBe(fetched.content);
  });

  it('rejects handles outside their task and attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-service-'));
    directories.push(root);
    const service = new ResearchService({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ AbstractURL: 'https://example.test/source', Heading: 'Source' }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });
    const search = await service.search({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      query: 'source',
    });

    await expect(
      service.fetchSource({
        projectRoot: root,
        taskId: 'task-2',
        attemptId: 'attempt-1',
        sourceHandle: search.sources[0]!.sourceHandle,
      }),
    ).rejects.toMatchObject({ code: 'RESEARCH_FETCH_BLOCKED' });
  });

  it('allows reserved fake-IP DNS only after a public secondary resolution', async () => {
    const publicLookup = vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]));
    const service = new ResearchService({
      fetch: (input) =>
        Promise.resolve(
          new Response(
            requestUrl(input).startsWith('https://search.test/')
              ? JSON.stringify({
                  AbstractURL: 'https://example.test/source',
                  Heading: 'Source',
                })
              : '<main>Verified source.</main>',
            {
              headers: {
                'content-type': requestUrl(input).startsWith('https://search.test/')
                  ? 'application/json'
                  : 'text/html',
              },
            },
          ),
        ),
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '198.18.0.42', family: 4 }]),
      publicLookup,
    });

    const result = await service.search({
      taskId: 'task-fake-ip',
      attemptId: 'attempt-fake-ip',
      query: 'verified source',
    });

    expect(result).toMatchObject({ status: 'searched', resultCount: 1 });
    expect(publicLookup).toHaveBeenCalledTimes(2);
  });

  it('blocks reserved fake-IP DNS when secondary resolution is not public', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = new ResearchService({
      fetch: fetcher,
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '198.18.0.42', family: 4 }]),
      publicLookup: () => Promise.resolve([{ address: '10.0.0.42', family: 4 }]),
    });

    await expect(
      service.search({
        taskId: 'task-fake-ip',
        attemptId: 'attempt-fake-ip',
        query: 'blocked source',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchError>>({ code: 'RESEARCH_FETCH_BLOCKED' }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks search routes that resolve to private addresses', async () => {
    const service = new ResearchService({
      fetch: vi.fn<typeof fetch>(),
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });

    await expect(
      service.search({ taskId: 'task-1', attemptId: 'attempt-1', query: 'source' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchError>>({ code: 'RESEARCH_FETCH_BLOCKED' }),
    );
  });

  it('propagates caller cancellation through the bounded fetch request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const service = new ResearchService({
      fetch: fetcher,
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });
    const pending = service.search({
      taskId: 'task-cancel',
      attemptId: 'attempt-cancel',
      query: 'cancel me',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'RESEARCH_CANCELLED' });
  });
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
