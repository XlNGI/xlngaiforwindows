import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageGenerationService } from './image-generation-service.js';
import { ProjectService } from './project-service.js';

const roots: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const service of services.splice(0)) service.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'ai-video-image-'));
  roots.push(base);
  const project = new ProjectService({ recentProjectsPath: join(base, 'recent.json') });
  services.push(project);
  project.create(join(base, 'project'), 'Image Project');
  return { base, project, service: new ImageGenerationService(project) };
}

describe('ImageGenerationService', () => {
  it('saves a Base64 provider result as an asset and result manifest', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });
    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.asset?.relativePath).toMatch(/^assets[\\/]images[\\/].+\.png$/);
    expect(
      existsSync(join(project.current()!.rootPath, result.results[0]!.asset!.relativePath)),
    ).toBe(true);
  });

  it('marks invalid provider output failed without leaving an asset', async () => {
    const { service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [] },
    });
    expect(result.status).toBe('failed');
    expect(result.results).toHaveLength(0);
    expect(service.listAssets({})).toHaveLength(0);
  });

  it('maps provider HTTP errors to failed jobs', async () => {
    const { service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const result = await service.complete({ jobId: job.id, providerStatus: 403, providerBody: {} });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('403');
    expect(service.listAssets({})).toHaveLength(0);
  });

  it('explains that HTTP 401 may be caused by a region/key mismatch', async () => {
    const { service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const result = await service.complete({ jobId: job.id, providerStatus: 401, providerBody: {} });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('selected service region and API key');
  });

  it('marks a prepared job failed when the native transport fails', async () => {
    const { service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });

    const failed = service.failTransport(job.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('transport failed');
    expect(service.failTransport(job.id)).toEqual(failed);
    expect(service.listAssets({})).toHaveLength(0);
  });

  it('does not commit an image after the job is cancelled during download', async () => {
    const { service } = await setup();
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => fetchResponse);
    vi.stubGlobal('fetch', fetchMock);
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });

    const completion = service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { url: 'https://example.invalid/image.png' },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    service.cancel(job.id);
    resolveFetch(
      new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    await expect(completion).resolves.toMatchObject({ status: 'cancelled' });
    expect(service.listAssets({})).toHaveLength(0);
  });

  it('cancels active jobs before project close', async () => {
    const { service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });

    expect(service.cancelAll()).toBe(1);
    expect(service.get(job.id).status).toBe('cancelled');
    expect(service.cancelAll()).toBe(0);
  });

  it('recovers active jobs left by an interrupted Worker as failed', async () => {
    const { project, service } = await setup();
    const rootPath = project.current()!.rootPath;
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    project.close();
    project.open(rootPath);

    expect(service.recoverInterrupted()).toBe(1);
    expect(service.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'Generation was interrupted before completion.',
    });
    expect(service.recoverInterrupted()).toBe(0);
  });
});
