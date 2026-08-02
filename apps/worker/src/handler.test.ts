import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IPC_PROTOCOL_VERSION,
  type SceneInfo,
  type ShotInfo,
  type WorkerRequest,
} from '@ai-video/contracts';
import { handleRequest, parseRequest } from './handler.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('worker handler', () => {
  it('reports its health using protocol v1', async () => {
    const response = await handleRequest({
      id: 'health-1',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'health',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toMatchObject({ protocolVersion: 1 });
  });

  it('creates and writes the SQLite probe database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-worker-'));
    temporaryDirectories.push(directory);
    const request: WorkerRequest<'sqlite.probe'> = {
      id: 'sqlite-1',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'sqlite.probe',
      params: { databasePath: join(directory, 'probe.sqlite') },
    };

    const response = await handleRequest(request);
    expect(response.ok).toBe(true);
    if (response.ok)
      expect(response.result).toMatchObject({ writeVerified: true, journalMode: 'wal' });
  });

  it('rejects incompatible protocol versions', () => {
    const response = parseRequest({ id: 'old', protocolVersion: 0, method: 'health' });
    expect('ok' in response && response.ok).toBe(false);
  });

  it('returns a dedicated error when the LLM provider is not configured', async () => {
    const response = await handleRequest({
      id: 'llm-unconfigured',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'llm.generate',
      params: { conversationId: 'conversation', prompt: 'Hello' },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'LLM_NOT_CONFIGURED' },
    });
  });

  it('rejects asset preview requests without a valid asset id', async () => {
    const response = await handleRequest({
      id: 'asset-preview-invalid',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'asset.preview',
      params: {},
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'assetId must be a string.' },
    });
  });

  it('rejects asset open requests without a valid asset id', async () => {
    const response = await handleRequest({
      id: 'asset-open-invalid',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'asset.open',
      params: {},
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'assetId must be a string.' },
    });
  });

  it('rejects unknown image asset kinds at the IPC boundary', async () => {
    const response = await handleRequest({
      id: 'image-save-preview-invalid-kind',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'image.generate.savePreview',
      params: {
        jobId: 'job',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        contentType: 'image/png',
        assetKind: 'unknown',
      },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'assetKind must be a valid image asset kind.' },
    });
  });

  it('resolves adapters and persists only validated per-shot parameter drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-video-adapter-worker-'));
    temporaryDirectories.push(root);
    const project = await handleRequest({
      id: 'project',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'project.create',
      params: { name: 'Adapter Test', rootPath: root },
    });
    expect(project.ok).toBe(true);

    const scene = await handleRequest({
      id: 'scene',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'scene.save',
      params: { title: 'Scene' },
    });
    expect(scene.ok).toBe(true);
    if (!scene.ok) return;
    const createdScene = scene.result as SceneInfo;
    const shot = await handleRequest({
      id: 'shot',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'shot.save',
      params: { sceneId: createdScene.id, title: 'Shot' },
    });
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    const createdShot = shot.result as ShotInfo;

    const resolved = await handleRequest({
      id: 'resolve',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'adapter.resolve',
      params: { capability: 'TEXT_TO_IMAGE', provider: 'vidu', model: 'viduq2' },
    });
    expect(resolved).toMatchObject({
      ok: true,
      result: { key: 'TEXT_TO_IMAGE:vidu:viduq2:v2' },
    });

    const invalid = await handleRequest({
      id: 'invalid-draft',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.save',
      params: {
        shotId: createdShot.id,
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        parameters: { prompt: 'Frame', aspect_ratio: '16:9', resolution: '2K', apiKey: 'secret' },
      },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });

    const localImageDraft = await handleRequest({
      id: 'local-image-draft',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.save',
      params: {
        shotId: createdShot.id,
        adapterKey: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
        parameters: {
          images: ['DATA:image/png;base64,bXVzdC1ub3QtcGVyc2lzdA=='],
          prompt: 'Frame',
          aspect_ratio: '16:9',
          resolution: '1080p',
        },
      },
    });
    expect(localImageDraft).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMETERS',
      },
    });
    expect(JSON.stringify(localImageDraft)).toContain('不能写入项目草稿');

    const parameters = { prompt: 'Frame', aspect_ratio: '16:9', resolution: '2K' };
    const saved = await handleRequest({
      id: 'valid-draft',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.save',
      params: {
        shotId: createdShot.id,
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        parameters,
      },
    });
    expect(saved).toMatchObject({ ok: true, result: { parameters } });

    const loaded = await handleRequest({
      id: 'load-draft',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.get',
      params: { shotId: createdShot.id, adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2' },
    });
    expect(loaded).toMatchObject({ ok: true, result: { parameters } });
    await handleRequest({
      id: 'close',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'project.close',
      params: {},
    });
    const databaseBytes = await readFile(join(root, 'project.sqlite'));
    expect(databaseBytes.includes(Buffer.from('must-not-persist'))).toBe(false);
    expect(databaseBytes.includes(Buffer.from('bXVzdC1ub3QtcGVyc2lzdA=='))).toBe(false);
  });
});
