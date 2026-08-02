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
    expect(result.preview?.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('previews and reveals only registered local assets', async () => {
    const { project } = await setup();
    const opened: string[] = [];
    const service = new ImageGenerationService(project, (path) => opened.push(path));
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });
    const asset = result.results[0]!.asset!;

    expect(service.previewAsset({ assetId: asset.id })).toMatchObject({
      assetId: asset.id,
      contentType: 'image/png',
    });
    expect(service.previewAsset({ assetId: asset.id }).dataUrl).toMatch(/^data:image\/png;base64,/);

    const revealed = service.revealAsset({ assetId: asset.id });

    expect(revealed.path).toBe(join(project.current()!.rootPath, asset.relativePath));
    expect(opened).toEqual([revealed.path]);
    expect(() => service.revealAsset({ assetId: '../outside' })).toThrow('Asset was not found.');
  });

  it('can return a preview without saving a local asset', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });

    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
      saveAsset: false,
    });

    expect(result.status).toBe('succeeded');
    expect(result.results).toHaveLength(0);
    expect(result.preview).toMatchObject({ jobId: job.id, contentType: 'image/png' });
    expect(service.listAssets({})).toHaveLength(0);

    const saved = service.savePreview({
      jobId: job.id,
      dataUrl: result.preview!.dataUrl,
      contentType: result.preview!.contentType,
      assetKind: 'character',
    });

    expect(saved.results).toHaveLength(1);
    expect(saved.results[0]?.asset).toMatchObject({ kind: 'character' });
    expect(service.listAssets({ kind: 'character' })).toHaveLength(1);
    expect(
      existsSync(join(project.current()!.rootPath, saved.results[0]!.asset!.relativePath)),
    ).toBe(true);
  });

  it('prefers Vidu creation output URLs over echoed input URLs', async () => {
    const { service } = await setup();
    const outputUrl = 'https://example.invalid/output.png?signature=kept-in-manifest';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const job = service.prepare({
      adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      parameters: {
        images: ['https://example.invalid/input.png'],
        prompt: 'frame',
        aspect_ratio: '16:9',
        resolution: '1080p',
      },
    });

    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: {
        input: { images: ['https://example.invalid/input.png'] },
        creations: [{ url: outputUrl }],
      },
    });

    expect(result.status).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledWith(outputUrl, expect.anything());
    expect(result.results[0]?.asset?.sourceUrl).toBe(outputUrl);
  });

  it('keeps remote image download failures actionable without storing signed URLs', async () => {
    const { service } = await setup();
    const signedUrl =
      'https://prod-ss-vidu.s3.cn-northwest-1.amazonaws.com.cn/output.png?X-Amz-Signature=secret';
    const failure = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(failure)),
    );
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });

    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { creations: [{ url: signedUrl }] },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('prod-ss-vidu.s3.cn-northwest-1.amazonaws.com.cn');
    expect(result.error).toContain('ECONNRESET');
    expect(result.error).not.toContain('X-Amz-Signature');
    expect(service.listAssets({})).toHaveLength(0);
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
