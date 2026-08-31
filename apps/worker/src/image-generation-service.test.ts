import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  it('rejects video adapters at the image service boundary', async () => {
    const { service } = await setup();
    expect(() =>
      service.prepare({
        adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
        parameters: {
          prompt: 'camera move',
          duration: 5,
          aspect_ratio: '16:9',
          resolution: '720p',
          audio: true,
        },
      }),
    ).toThrow('Image generation adapter was not found.');
  });

  it('redacts local image Data URLs from the persisted request snapshot', async () => {
    const { project, service } = await setup();
    const localImage = 'DATA:image/png;base64,iVBORw0KGgo=';
    const job = service.prepare({
      adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      parameters: {
        images: [localImage],
        prompt: 'frame',
        aspect_ratio: '16:9',
        resolution: '1080p',
      },
    });

    expect(job.request.images).toEqual([localImage]);
    project.access(false, (database) => {
      const row = database
        .prepare('SELECT request_json FROM generation_jobs WHERE id = ?')
        .get(job.id) as { request_json: string };
      expect(row.request_json).toContain('local-image://omitted');
      expect(row.request_json).not.toContain('iVBORw0KGgo=');
    });
  });

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
    const played: string[] = [];
    const service = new ImageGenerationService(
      project,
      (path) => opened.push(path),
      (path) => played.push(path),
    );
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
    expect(service.assetMediaSource({ assetId: asset.id })).toMatchObject({
      assetId: asset.id,
      contentType: 'image/png',
      path: join(project.current()!.rootPath, asset.relativePath),
    });

    const revealed = service.revealAsset({ assetId: asset.id });

    expect(revealed.path).toBe(join(project.current()!.rootPath, asset.relativePath));
    expect(opened).toEqual([revealed.path]);
    expect(service.openAsset({ assetId: asset.id })).toEqual(revealed);
    expect(played).toEqual([revealed.path]);
    expect(() => service.renameAsset({ assetId: asset.id, name: 'unsafe.exe' })).toThrow(
      'extension must be preserved',
    );
    expect(() => service.revealAsset({ assetId: '../outside' })).toThrow('Asset was not found.');
  });

  it('creates a rebuildable hash-keyed preview cache', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const asset = (
      await service.complete({
        jobId: job.id,
        providerStatus: 200,
        providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
      })
    ).results[0]!.asset!;
    service.previewAsset({ assetId: asset.id });
    const cachePath = join(
      project.current()!.rootPath,
      'cache',
      'thumbnails',
      `${asset.contentHash}.png`,
    );
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath)).toEqual(
      readFileSync(join(project.current()!.rootPath, asset.relativePath)),
    );
  });

  it('returns a validated local media source for video preview', async () => {
    const { project, service } = await setup();
    const current = project.current()!;
    const relativePath = join('assets', 'videos', 'preview.mp4');
    const absolutePath = join(current.rootPath, relativePath);
    writeFileSync(absolutePath, Buffer.from('video fixture'));
    project.access(true, (database) => {
      database
        .prepare(
          `INSERT INTO assets
             (id, project_id, kind, relative_path, content_hash, size_bytes, created_at,
              alias, updated_at, deleted_at, trash_relative_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          'video-preview',
          current.id,
          'generated-video',
          relativePath,
          'video-hash',
          13,
          current.createdAt,
          '',
          current.createdAt,
        );
    });

    expect(service.assetMediaSource({ assetId: 'video-preview' })).toEqual({
      assetId: 'video-preview',
      path: absolutePath,
      contentType: 'video/mp4',
    });
  });

  it('always saves successful generated images to the local asset library', async () => {
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
    expect(result.results[0]?.asset).toBeDefined();
    expect(result.preview).toMatchObject({
      assetId: result.results[0]?.asset?.id,
      contentType: 'image/png',
    });
    expect(service.listAssets({})).toHaveLength(1);
    expect(
      existsSync(join(project.current()!.rootPath, result.results[0]!.asset!.relativePath)),
    ).toBe(true);
  });

  it('downloads the full signed output URL but strips credentials before persistence', async () => {
    const { project, service } = await setup();
    const outputUrl =
      'https://example.invalid/output.png?X-Amz-Credential=temporary&X-Amz-Signature=secret#fragment';
    const persistedUrl = 'https://example.invalid/output.png';
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
    expect(result.results[0]?.providerUrl).toBe(persistedUrl);
    expect(result.results[0]?.asset?.sourceUrl).toBe(persistedUrl);
    project.access(false, (database) => {
      expect(
        database
          .prepare(
            `SELECT generation_results.provider_url AS providerUrl, assets.source_url AS sourceUrl
             FROM generation_results
             JOIN assets ON assets.id = generation_results.asset_id
             WHERE generation_results.job_id = ?`,
          )
          .get(job.id),
      ).toEqual({ providerUrl: persistedUrl, sourceUrl: persistedUrl });
    });
    const backup = await project.backup();
    expect(readFileSync(backup).includes(Buffer.from('X-Amz-Signature'))).toBe(false);
    expect(readFileSync(backup).includes(Buffer.from('secret'))).toBe(false);
  });

  it('does not mistake an echoed local Base64 input for the generated image', async () => {
    const { service } = await setup();
    const outputUrl = 'https://example.invalid/generated.png';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const localInput = 'data:image/png;base64,iVBORw0KGgo=';
    const job = service.prepare({
      adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      parameters: {
        images: [localInput],
        prompt: 'frame',
        aspect_ratio: '16:9',
        resolution: '1080p',
      },
    });

    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: {
        input: { images: [localInput] },
        creations: [{ url: outputUrl }],
      },
    });

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

  it('rejects an oversized image before registering an asset', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'image/png' }),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(25 * 1024 * 1024 + 1)),
        } as Response),
      ),
    );

    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'https://example.com/oversized.png' }] },
    });

    expect(result).toMatchObject({ status: 'failed', results: [] });
    project.access(false, (database, activeProject) => {
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM assets WHERE project_id = ?')
          .get(activeProject.id),
      ).toEqual({ count: 0 });
    });
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

  it('removes a downloaded image and terminates the job when asset registration fails', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    project.access(true, (database) => {
      database.exec(`
        CREATE TRIGGER reject_generated_asset_insert
        BEFORE INSERT ON assets
        BEGIN
          SELECT RAISE(ABORT, 'injected asset insert failure');
        END;
      `);
    });

    const result = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('injected asset insert failure');
    expect(service.listAssets({})).toHaveLength(0);
    expect(readdirSync(join(project.current()!.rootPath, 'assets', 'images'))).toEqual([]);
  });

  it('restores an asset file when its database deletion is rejected', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const completed = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });
    const asset = completed.results[0]!.asset!;
    const assetPath = join(project.current()!.rootPath, asset.relativePath);
    project.access(true, (database) => {
      database.exec(`
        CREATE TRIGGER reject_generated_asset_update
        BEFORE UPDATE OF deleted_at ON assets
        BEGIN
          SELECT RAISE(ABORT, 'injected asset delete failure');
        END;
      `);
    });

    expect(() => service.deleteAsset(asset.id)).toThrow('injected asset delete failure');
    expect(existsSync(assetPath)).toBe(true);
    expect(service.listAssets({}).map((item) => item.id)).toContain(asset.id);
  });

  it('updates an alias without renaming the file and restores trashed assets', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const completed = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });
    const asset = completed.results[0]!.asset!;
    const originalPath = asset.relativePath;
    expect(service.updateAssetAlias({ assetId: asset.id, alias: '  Hero Frame  ' })).toMatchObject({
      alias: 'Hero Frame',
      relativePath: originalPath,
    });
    service.deleteAsset(asset.id);
    expect(service.listAssets({ deleted: 'active' })).toHaveLength(0);
    expect(service.listAssets({ deleted: 'trash' })).toHaveLength(1);
    expect(service.restoreAsset(asset.id)).toMatchObject({
      relativePath: originalPath,
      deletedAt: undefined,
    });
    expect(existsSync(join(project.current()!.rootPath, originalPath))).toBe(true);
  });

  it('resolves dynamic asset groups with AND tag semantics', async () => {
    const { service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const completed = await service.complete({
      jobId: job.id,
      providerStatus: 200,
      providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    });
    const asset = completed.results[0]!.asset!;
    const character = service.createTag('Character');
    const hero = service.createTag('Hero');
    service.replaceAssetTags([asset.id], [character.id, hero.id]);
    const group = service.createGroup('Hero characters', [character.id, hero.id]);
    expect(service.resolveGroup(group.id).map((item) => item.id)).toEqual([asset.id]);
    service.replaceAssetTags([asset.id], [character.id]);
    expect(service.resolveGroup(group.id)).toHaveLength(0);
  });

  it('returns tag metadata and stable cursor pages with accurate entity counts', async () => {
    const { project, service } = await setup();
    const createAsset = async (prompt: string) => {
      const job = service.prepare({
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        parameters: { prompt, aspect_ratio: '16:9', resolution: '1080p' },
      });
      return (
        await service.complete({
          jobId: job.id,
          providerStatus: 200,
          providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
        })
      ).results[0]!.asset!;
    };
    const first = await createAsset('first');
    const second = await createAsset('second');
    project.access(true, (database) => {
      database
        .prepare('UPDATE assets SET created_at = ? WHERE id = ?')
        .run('2026-08-01T00:00:00.000Z', first.id);
      database
        .prepare('UPDATE assets SET created_at = ? WHERE id = ?')
        .run('2026-08-02T00:00:00.000Z', second.id);
    });
    const hero = service.createTag('Hero');
    service.replaceAssetTags([first.id], [hero.id]);
    const group = service.createGroup('Heroes', [hero.id]);

    expect(service.listTags()[0]).toMatchObject({ id: hero.id, assetCount: 1 });
    expect(service.listGroups()[0]).toMatchObject({ id: group.id, assetCount: 1 });
    expect(service.listAssets({ tagIds: [hero.id] })[0]?.tags?.map((tag) => tag.id)).toEqual([
      hero.id,
    ]);
    expect(
      service
        .listAssets({
          cursor: `2026-08-01T00:00:00.000Z|${first.id}`,
          sort: 'created-asc',
        })
        .map((asset) => asset.id),
    ).toEqual([second.id]);
    expect(() => service.listAssets({ cursor: 'invalid' })).toThrow('Asset cursor is invalid.');
  });

  it('requires confirmation for referenced assets and permanently purges trash', async () => {
    const { project, service } = await setup();
    const job = service.prepare({
      adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      parameters: { prompt: 'frame', aspect_ratio: '16:9', resolution: '1080p' },
    });
    const asset = (
      await service.complete({
        jobId: job.id,
        providerStatus: 200,
        providerBody: { data: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] },
      })
    ).results[0]!.asset!;
    project.access(true, (database) => {
      const shotId = 'shot-for-reference';
      database
        .prepare(
          `INSERT INTO scenes (id, project_id, title, position, created_at, updated_at)
           VALUES ('scene-for-reference', ?, 'Scene', 0, ?, ?)`,
        )
        .run(project.current()!.id, asset.createdAt, asset.createdAt);
      database
        .prepare(
          `INSERT INTO shots (id, scene_id, title, position, status, created_at, updated_at)
           VALUES (?, 'scene-for-reference', 'Shot', 0, 'draft', ?, ?)`,
        )
        .run(shotId, asset.createdAt, asset.createdAt);
      database
        .prepare(
          `INSERT INTO generation_drafts (id, shot_id, adapter_key, parameters_json, updated_at)
           VALUES ('draft-reference', ?, 'adapter', ?, ?)`,
        )
        .run(shotId, JSON.stringify({ assetId: asset.id }), asset.createdAt);
    });

    expect(() => service.deleteAsset(asset.id)).toThrow('referenced by 1 production draft');
    expect(service.deleteAsset(asset.id, true)).toEqual({ deleted: true, referenceCount: 1 });
    const trash = service.listAssets({ deleted: 'trash' })[0]!;
    const trashPath = join(project.current()!.rootPath, trash.trashRelativePath!);
    expect(existsSync(trashPath)).toBe(true);
    expect(() => service.purgeAsset(asset.id, false)).toThrow('requires confirmation');
    expect(service.purgeAsset(asset.id, true)).toEqual({ purged: true });
    expect(existsSync(trashPath)).toBe(false);
    expect(service.listAssets({ deleted: 'trash' })).toHaveLength(0);
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
