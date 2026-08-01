import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageGenerationService } from './image-generation-service.js';
import { ProjectService } from './project-service.js';

const roots: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
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
});
