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
import {
  handleRequest,
  inferAgentDocumentIntent,
  inferUnifiedAgentCapability,
  modelMatchesUnifiedAgentRequest,
  parseRequest,
  resolveMediaProviderRegion,
} from './handler.js';

const temporaryDirectories: string[] = [];

describe('inferUnifiedAgentCapability', () => {
  it('does not confuse media prompt writing with media generation', () => {
    expect(inferUnifiedAgentCapability('改写为 AI 视频生成提示词')).toBe('document');
    expect(inferUnifiedAgentCapability('分析这个视频附件')).toBe('document');
    expect(inferUnifiedAgentCapability('制作一个视频')).toBe('video');
    expect(inferUnifiedAgentCapability('能直接帮我生成角色三视图吗？')).toBe('image');
    expect(inferUnifiedAgentCapability('生成角色三视图提示词')).toBe('document');
  });
});

describe('inferAgentDocumentIntent', () => {
  it('routes explicit adapter parameter questions to the read-only schema tool', () => {
    expect(inferAgentDocumentIntent('查看当前视频模型支持哪些参数')).toEqual({
      operation: 'adapter.schema.get',
    });
    expect(inferAgentDocumentIntent('What fields does this adapter schema expose?')).toEqual({
      operation: 'adapter.schema.get',
    });
    expect(inferAgentDocumentIntent('修改这个模型的参数 Schema')).toEqual({
      operation: 'adapter.schema.propose',
    });
    expect(inferAgentDocumentIntent('查看这个适配器的 Schema 修改历史')).toEqual({
      operation: 'adapter.schema.audit.list',
    });
  });

  it('keeps ordinary drafting prompts on the document tool', () => {
    expect(inferAgentDocumentIntent('根据这些参数写一份视频分镜文档')).toEqual({
      operation: 'document.create_draft',
    });
  });
});

describe('resolveMediaProviderRegion', () => {
  it('derives the Provider route from the selected connection profile', () => {
    expect(
      resolveMediaProviderRegion({ providerType: 'unicompapi', baseUrl: 'https://example.com' }),
    ).toBe('unicompapi');
    expect(
      resolveMediaProviderRegion({ providerType: 'vidu', baseUrl: 'https://api.vidu.cn' }),
    ).toBe('cn');
    expect(
      resolveMediaProviderRegion({ providerType: 'vidu', baseUrl: 'https://api.vidu.com' }),
    ).toBe('global');
  });
});

describe('modelMatchesUnifiedAgentRequest', () => {
  const baseModel = {
    enabled: true,
    unavailableAt: null,
    remoteModelId: 'qwen-image-edit-2509',
    capabilities: {
      text: false,
      streaming: false,
      tools: false,
      vision: false,
      imageGeneration: false,
      imageEditing: true,
      videoGeneration: false,
    },
  };

  it('allows reference-image generation without generic vision capability', () => {
    expect(
      modelMatchesUnifiedAgentRequest(
        'image',
        baseModel,
        'unicompapi',
        [
          {
            provider: 'unicompapi',
            model: baseModel.remoteModelId,
            capability: 'REFERENCE_TO_IMAGE',
          },
        ],
        true,
      ),
    ).toBe(true);
  });

  it('does not offer text-to-image models for a request with a reference image', () => {
    expect(
      modelMatchesUnifiedAgentRequest(
        'image',
        {
          ...baseModel,
          remoteModelId: 'qwen-image',
          capabilities: { ...baseModel.capabilities, imageEditing: false, imageGeneration: true },
        },
        'unicompapi',
        [{ provider: 'unicompapi', model: 'qwen-image', capability: 'TEXT_TO_IMAGE' }],
        true,
      ),
    ).toBe(false);
  });

  it('still requires vision for document/image-understanding tasks', () => {
    expect(
      modelMatchesUnifiedAgentRequest(
        'document',
        {
          ...baseModel,
          capabilities: { ...baseModel.capabilities, text: true, streaming: true, tools: true },
        },
        'unicompapi',
        [],
        true,
      ),
    ).toBe(false);
  });
});

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

  it('accepts the unified Agent request contract and rejects partial model selection', async () => {
    const response = await handleRequest({
      id: 'agent-run-partial-model',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'agent.run',
      params: {
        conversationId: 'conversation',
        prompt: '生成一张角色图',
        providerProfileId: '11111111-1111-4111-8111-111111111111',
      },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'agent-run-partial-model',
        operation: 'agent.run',
      },
    });
  });

  it('accepts image/video parameter payloads at the unified Agent boundary', async () => {
    const response = await handleRequest({
      id: 'agent-run-parameters',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'agent.run',
      params: {
        conversationId: 'conversation',
        prompt: '生成一张海报',
        capability: 'image',
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        parameters: { prompt: '海边日落', aspect_ratio: '16:9' },
      },
    } as unknown as WorkerRequest);

    expect(response).toMatchObject({ ok: true });
    if (response.ok) {
      expect(response.result).toMatchObject({
        status: 'needs_model_selection',
        capability: 'image',
      });
      expect(response.result).not.toMatchObject({ status: 'image_prepared' });
    }
  });

  it('requires an explicit media Provider and model for direct image/video preparation', async () => {
    const imageResponse = await handleRequest({
      id: 'image-prepare-missing-selection',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'image.generate.prepare',
      params: {
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        parameters: { prompt: '海报' },
      },
    } as unknown as WorkerRequest);
    expect(imageResponse).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'image-prepare-missing-selection',
        operation: 'image.generate.prepare',
      },
    });

    const videoResponse = await handleRequest({
      id: 'video-prepare-missing-selection',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'video.generate.prepare',
      params: {
        adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
        parameters: { prompt: '天空' },
        providerRegion: 'cn',
        providerProfileId: 'profile-only',
      },
    } as unknown as WorkerRequest);
    expect(videoResponse).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        requestId: 'video-prepare-missing-selection',
        operation: 'video.generate.prepare',
      },
    });
  });

  it('exposes read-only model and adapter schema catalog queries', async () => {
    const models = await handleRequest({
      id: 'model-catalog-list',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'model.catalog.list',
      params: { capability: 'image' },
    } as unknown as WorkerRequest);
    expect(models).toMatchObject({ ok: true });

    const schema = await handleRequest({
      id: 'adapter-schema-get',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'adapter.schema.get',
      params: { adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2' },
    } as unknown as WorkerRequest);
    expect(schema).toMatchObject({ ok: true });
    if (schema.ok) expect(schema.result).toMatchObject({ key: 'TEXT_TO_IMAGE:vidu:viduq2:v2' });
  });

  it('rejects malformed adapter schema proposals before persistence', async () => {
    const response = await handleRequest({
      id: 'adapter-schema-propose-invalid',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'adapter.schema.propose',
      params: {
        adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
        descriptor: { key: 'TEXT_TO_IMAGE:vidu:viduq2:v2' },
      },
    } as unknown as WorkerRequest);
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', operation: 'adapter.schema.propose' },
    });
  });

  it('requires a supported target platform only for short-drama Agent requests', async () => {
    const base = {
      conversationId: 'conversation',
      prompt: 'Generate an AI short drama',
      providerProfileId: 'profile',
      modelId: 'model',
      agentMode: 'short-drama' as const,
      documentIntent: { operation: 'novel.episode.submit_draft' as const },
      selectedChapterIds: ['chapter-1'],
    };
    for (const [id, params] of [
      ['missing', base],
      ['invalid', { ...base, targetPlatform: 'untrusted-platform' }],
      [
        'document-mode',
        {
          ...base,
          agentMode: 'document',
          targetPlatform: 'seedance',
          selectedChapterIds: undefined,
        },
      ],
    ] as const) {
      const response = await handleRequest({
        id: `agent-platform-${id}`,
        protocolVersion: IPC_PROTOCOL_VERSION,
        method: 'agent.generation.prepare',
        params,
      } as unknown as WorkerRequest);
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          requestId: `agent-platform-${id}`,
          operation: 'agent.generation.prepare',
        },
      });
    }
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
