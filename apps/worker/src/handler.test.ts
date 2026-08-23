import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IPC_PROTOCOL_VERSION,
  type SceneInfo,
  type ShotInfo,
  type WorkerMetricsSnapshot,
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

  it('exposes accumulated worker metrics after handling requests', async () => {
    await handleRequest({
      id: 'health-before-metrics',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'health',
      params: {},
    });
    const response = await handleRequest({
      id: 'worker-metrics',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'maintenance.metrics',
      params: {},
    } as unknown as WorkerRequest);

    expect(response.ok).toBe(true);
    if (response.ok) {
      const metrics = response.result as WorkerMetricsSnapshot;
      expect(metrics.totals.requests).toBeGreaterThanOrEqual(2);
    }
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

  it('rejects unknown conversation parameters before entering the service layer', async () => {
    const response = await handleRequest({
      id: 'conversation-unknown-param',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'conversation.list',
      params: { unexpected: true },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'conversation-unknown-param',
        retryable: false,
        operation: 'conversation.list',
      },
    });
  });

  it('validates novel import payloads at the IPC boundary', async () => {
    const response = await handleRequest({
      id: 'novel-import-invalid',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'novel.import',
      params: {
        chapters: [{ title: '第一章', contentMarkdown: '正文', forged: true }],
      },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'novel-import-invalid',
        retryable: false,
        operation: 'novel.import',
      },
    });
  });

  it('recognizes novel import as a registered Worker method', async () => {
    const response = await handleRequest({
      id: 'novel-import-registered',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'novel.import',
      params: { chapters: [{ title: '第一章', contentMarkdown: '正文' }] },
    } as unknown as WorkerRequest);

    expect(response).not.toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' },
    });
  });

  it('rejects untrusted fields on Agent prepare requests at the IPC boundary', async () => {
    const response = await handleRequest({
      id: 'agent-prepare-unknown-param',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'agent.generation.prepare',
      params: {
        conversationId: 'conversation',
        prompt: 'Draft a project brief',
        providerProfileId: 'profile',
        modelId: 'model',
        agentMode: 'document',
        documentIntent: { operation: 'document.create_draft' },
        forgedAuthorizationHandle: 'must-not-reach-agent-loop',
      },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'agent-prepare-unknown-param',
        retryable: false,
        operation: 'agent.generation.prepare',
      },
    });
  });

  it('reports a missing Agent provider profile as invalid parameters', async () => {
    const response = await handleRequest({
      id: 'agent-prepare-missing-profile',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'agent.generation.prepare',
      params: {
        conversationId: 'conversation',
        prompt: 'Draft a project brief',
        providerProfileId: '11111111-1111-4111-8111-111111111111',
        modelId: '22222222-2222-4222-8222-222222222222',
        agentMode: 'document',
        documentIntent: { operation: 'document.create_draft' },
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMETERS',
        message: 'Provider profile was not found.',
        requestId: 'agent-prepare-missing-profile',
        retryable: false,
        operation: 'agent.generation.prepare',
      },
    });
  });

  it('rejects conversation lifecycle requests without a conversation id', async () => {
    const response = await handleRequest({
      id: 'conversation-archive-missing-id',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'conversation.archive',
      params: {},
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'conversation-archive-missing-id',
        retryable: false,
        operation: 'conversation.archive',
      },
    });
  });

  it('rejects context snapshot cleanup with an invalid retention period', async () => {
    const response = await handleRequest({
      id: 'context-cleanup-invalid-retention',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'maintenance.contextSnapshots.cleanup',
      params: { olderThanDays: 0 },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'context-cleanup-invalid-retention',
        retryable: false,
        operation: 'maintenance.contextSnapshots.cleanup',
      },
    });
  });

  it('rejects unknown document list parameters at the IPC boundary', async () => {
    const response = await handleRequest({
      id: 'document-list-unknown-param',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'document.list',
      params: { unexpected: true },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'document-list-unknown-param',
        retryable: false,
        operation: 'document.list',
      },
    });
  });

  it('rejects unknown change-set fields and malformed nested items at the IPC boundary', async () => {
    const unknown = await handleRequest({
      id: 'change-set-unknown-param',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'agent.changeSet.create',
      params: { title: 'Proposal', items: [], forged: true },
    } as unknown as WorkerRequest);
    const malformed = await handleRequest({
      id: 'change-set-malformed-item',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'agent.changeSet.create',
      params: {
        title: 'Proposal',
        items: [{ entityType: 'scene', action: 'create', title: 'Scene', forged: true }],
      },
    } as unknown as WorkerRequest);

    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects oversized prompts and invalid message role/status combinations', async () => {
    const oversized = await handleRequest({
      id: 'oversized-prompt',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'llm.generate',
      params: { conversationId: 'conversation', prompt: 'x'.repeat(100_001) },
    });
    const invalidMessage = await handleRequest({
      id: 'invalid-message-state',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'chat.message.save',
      params: {
        conversationId: 'conversation',
        role: 'user',
        content: 'Pending',
        status: 'streaming',
      },
    });

    expect(oversized).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(invalidMessage).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
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

    const scopedA = {
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      modelId: 'viduq2',
    };
    const scopedB = {
      providerProfileId: '22222222-2222-4222-8222-222222222222',
      modelId: 'viduq2',
    };
    await handleRequest({
      id: 'scoped-draft-a',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.save',
      params: {
        shotId: createdShot.id,
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        ...scopedA,
        parameters: { prompt: 'Profile A', aspect_ratio: '16:9', resolution: '2K' },
      },
    });
    await handleRequest({
      id: 'scoped-draft-b',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.save',
      params: {
        shotId: createdShot.id,
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        ...scopedB,
        parameters: { prompt: 'Profile B', aspect_ratio: '16:9', resolution: '2K' },
      },
    });
    const loadedScopedA = await handleRequest({
      id: 'load-scoped-draft-a',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.get',
      params: {
        shotId: createdShot.id,
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        ...scopedA,
      },
    });
    const loadedScopedB = await handleRequest({
      id: 'load-scoped-draft-b',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'generation.draft.get',
      params: {
        shotId: createdShot.id,
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        ...scopedB,
      },
    });
    expect(loadedScopedA).toMatchObject({
      ok: true,
      result: { parameters: { prompt: 'Profile A' } },
    });
    expect(loadedScopedB).toMatchObject({
      ok: true,
      result: { parameters: { prompt: 'Profile B' } },
    });
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
