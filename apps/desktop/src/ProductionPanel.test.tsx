import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AssetInfo,
  ImageGenerationJobInfo,
  ProviderModelInfo,
  ProviderProfileInfo,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import { officialVideoContracts } from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
const confirmDialog = vi.fn(() => true);
const providerProfile: ProviderProfileInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Vidu 中国站 A',
  category: 'multi',
  providerType: 'vidu',
  accessType: 'official',
  protocol: 'vidu-v2',
  baseUrl: 'https://api.vidu.cn',
  enabled: true,
  connectionStatus: 'ready',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const globalProviderProfile: ProviderProfileInfo = {
  ...providerProfile,
  id: '11111111-1111-4111-8111-111111111112',
  name: 'Vidu 国际站 B',
  baseUrl: 'https://api.vidu.com',
};

function providerModel(
  id: string,
  remoteModelId: string,
  displayName: string,
  kind: 'image' | 'video',
): ProviderModelInfo {
  return {
    id,
    providerProfileId: providerProfile.id,
    remoteModelId,
    displayName,
    capabilities: {
      text: false,
      vision: false,
      streaming: false,
      reasoning: false,
      tools: false,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: kind === 'image',
      videoGeneration: kind === 'video',
    },
    source: 'built-in',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const providerModels: ProviderModelInfo[] = [
  providerModel('21111111-1111-4111-8111-111111111111', 'viduq1', 'Vidu Q1', 'image'),
  providerModel('21111111-1111-4111-8111-111111111112', 'viduq2', 'Vidu Q2', 'image'),
  providerModel('21111111-1111-4111-8111-111111111113', 'viduq3', 'Vidu Q3', 'video'),
  providerModel('21111111-1111-4111-8111-111111111114', 'viduq3-pro', 'Vidu Q3 Pro', 'video'),
  providerModel('21111111-1111-4111-8111-111111111115', 'viduq3-drama', 'Vidu Q3-Drama', 'video'),
  providerModel('21111111-1111-4111-8111-111111111116', 'vidu2.0', 'Vidu 2.0', 'video'),
];

function mockWorker(
  implementation: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  unavailableMediaIds: string[] = [],
): void {
  vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
    if (method === 'production.compile' || method === 'production.read')
      return Promise.resolve({ target: params.target, rowVersion: 1, parameters: {}, issues: [] });
    if (method === 'provider.profile.list') return Promise.resolve([providerProfile]);
    if (method === 'provider.model.list') return Promise.resolve(providerModels);
    if (method === 'asset.mediaSource') {
      const assetId = params.assetId as string;
      if (unavailableMediaIds.includes(assetId)) return Promise.reject(new Error('File missing'));
      return Promise.resolve({
        assetId,
        path: `D:\\Project\\assets\\images\\${assetId}.png`,
        contentType: 'image/png',
      });
    }
    return implementation(method, params);
  }) as typeof callWorker);
}

/**
 * Paid submissions now await the shared confirmation card instead of a native
 * `window.confirm`, so every generate click needs an explicit approval.
 */
async function submitPaidGeneration(buttonName: '生成图片' | '提交视频任务'): Promise<void> {
  const button = screen.getByRole('button', { name: buttonName });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole('button', { name: '批准' }));
}

const descriptor: AdapterDescriptor = {
  key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
  capability: 'TEXT_TO_IMAGE',
  capabilityLabel: '文生图',
  provider: 'vidu',
  providerLabel: 'Vidu',
  model: 'viduq2',
  modelLabel: 'Vidu Q2',
  apiVersion: 'v2',
  schemaVersion: 1,
  endpoint: 'https://api.vidu.com/ent/v2/reference2image',
  documentationUrl: 'https://platform.vidu.com/docs/reference-to-image',
  credentialProvider: 'vidu',
  parameterSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['prompt', 'resolution'],
    properties: {
      prompt: { type: 'string', title: '画面提示词', minLength: 1, maxLength: 2000 },
      resolution: {
        type: 'string',
        title: '分辨率',
        enum: ['1080p', '2K'],
        default: '1080p',
      },
      seed: { type: 'integer', title: '随机种子', minimum: 0 },
    },
  },
  uiSchema: {
    fields: [
      { key: 'prompt', control: 'textarea', group: 'basic', order: 10 },
      { key: 'resolution', control: 'select', group: 'basic', order: 20 },
      { key: 'seed', control: 'number', group: 'advanced', order: 30 },
    ],
  },
};

const catalog: AdapterCatalogResult = {
  capabilities: [{ key: 'TEXT_TO_IMAGE', label: '文生图' }],
  providers: [{ key: 'vidu', label: 'Vidu' }],
  adapters: [descriptor],
};

const videoDescriptor: AdapterDescriptor = {
  key: 'START_END_TO_VIDEO:vidu:viduq3-pro:v2',
  capability: 'START_END_TO_VIDEO',
  capabilityLabel: '首尾帧生视频',
  provider: 'vidu',
  providerLabel: 'Vidu',
  model: 'viduq3-pro',
  modelLabel: 'Vidu Q3 Pro',
  apiVersion: 'v2',
  schemaVersion: 1,
  endpoint: 'https://api.vidu.com/ent/v2/start-end2video',
  documentationUrl: 'https://platform.vidu.com/docs/image-to-video',
  credentialProvider: 'vidu',
  parameterSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['images', 'duration', 'resolution', 'audio'],
    properties: {
      images: {
        type: 'array',
        title: '首帧与尾帧',
        minItems: 2,
        maxItems: 2,
        items: { type: 'string', format: 'uri' },
      },
      duration: { type: 'integer', title: '时长', minimum: 1, maximum: 16, default: 5 },
      resolution: {
        type: 'string',
        title: '分辨率',
        enum: ['720p'],
        default: '720p',
      },
      audio: { type: 'boolean', title: '声音', default: true },
    },
  },
  uiSchema: {
    fields: [
      { key: 'images', control: 'url-list', group: 'basic', order: 10 },
      { key: 'duration', control: 'number', group: 'basic', order: 20 },
      { key: 'resolution', control: 'select', group: 'basic', order: 30 },
      { key: 'audio', control: 'toggle', group: 'basic', order: 40 },
    ],
  },
};

const videoCatalog: AdapterCatalogResult = {
  capabilities: [{ key: 'START_END_TO_VIDEO', label: '首尾帧生视频' }],
  providers: [{ key: 'vidu', label: 'Vidu' }],
  adapters: [videoDescriptor],
};

const completeModeCatalog: AdapterCatalogResult = {
  capabilities: [
    { key: 'TEXT_TO_IMAGE', label: '文生图' },
    { key: 'REFERENCE_TO_IMAGE', label: '参考生图' },
    { key: 'TEXT_TO_VIDEO', label: '文生视频' },
    { key: 'IMAGE_TO_VIDEO', label: '图生视频' },
    { key: 'REFERENCE_TO_VIDEO', label: '参考生视频' },
    { key: 'START_END_TO_VIDEO', label: '首尾帧生视频' },
  ],
  providers: [{ key: 'vidu', label: 'Vidu' }],
  adapters: [
    descriptor,
    {
      ...descriptor,
      key: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      capability: 'REFERENCE_TO_IMAGE',
      capabilityLabel: '参考生图',
    },
    {
      ...videoDescriptor,
      key: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
      capability: 'TEXT_TO_VIDEO',
      capabilityLabel: '文生视频',
    },
    {
      ...videoDescriptor,
      key: 'REFERENCE_TO_VIDEO:vidu:viduq3:v2',
      capability: 'REFERENCE_TO_VIDEO',
      capabilityLabel: '参考生视频',
    },
    videoDescriptor,
    {
      ...videoDescriptor,
      key: 'IMAGE_TO_VIDEO:vidu:vidu2.0:v2',
      capability: 'IMAGE_TO_VIDEO',
      capabilityLabel: '图生视频',
    },
  ],
};

function videoJob(status: VideoGenerationJobInfo['status']): VideoGenerationJobInfo {
  return {
    id: 'video-job',
    projectId: 'project',
    shotId: 'shot',
    adapterKey: videoDescriptor.key,
    assetKind: 'shot-video',
    providerTaskId: status === 'pending' ? undefined : 'provider-task',
    status,
    request: {
      images: ['https://example.invalid/start.png', 'https://example.invalid/end.png'],
      duration: 5,
      resolution: '720p',
      audio: true,
    },
    metadata: {
      providerRegion: 'cn',
      providerProfileId: providerProfile.id,
      modelId: 'viduq3-pro',
      pollAttempts: 0,
      pollDeadlineAt: '2099-01-01T00:00:00.000Z',
    },
    results: [],
    elapsedMs: 1_000,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:01.000Z',
  };
}

function imageJob(
  status: ImageGenerationJobInfo['status'],
  options: { withPreview?: boolean } = {},
): ImageGenerationJobInfo {
  return {
    id: 'job',
    shotId: 'shot',
    adapterKey: descriptor.key,
    status,
    request: { prompt: '电影画面', resolution: '1080p' },
    results:
      status === 'succeeded'
        ? [
            {
              id: 'result',
              jobId: 'job',
              asset: savedAsset,
              createdAt: '2026-08-02T00:00:01.000Z',
            },
          ]
        : [],
    preview:
      status === 'succeeded' && options.withPreview
        ? {
            jobId: 'job',
            assetId: savedAsset.id,
            dataUrl: 'data:image/png;base64,generated',
            contentType: 'image/png',
          }
        : undefined,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:01.000Z',
  };
}

function pendingSubmission(
  kind: 'image' | 'video',
  job: ImageGenerationJobInfo | VideoGenerationJobInfo,
) {
  return {
    kind,
    job: { ...job, mediaState: 'awaiting_confirmation' as const },
    confirmation: {
      confirmationToken: `confirmation-${job.id}`,
      jobId: job.id,
      kind,
      draftVersion: 1,
      providerName: providerProfile.name,
      modelName: kind === 'image' ? 'Vidu Q2' : 'Vidu Q3 Pro',
      adapterKey: job.adapterKey,
      parameterSummary: [{ key: 'prompt', value: kind === 'image' ? '电影画面' : '镜头运动' }],
      costNotice: { required: true as const, summary: '本次操作可能产生费用。' },
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
}

const savedAsset: AssetInfo = {
  id: 'asset-generated',
  projectId: 'project',
  kind: 'generated-image',
  relativePath: 'assets/images/generated.png',
  contentHash: 'hash',
  sizeBytes: 8192,
  createdAt: '2026-08-02T00:00:00.000Z',
};

const savedVideoAsset: AssetInfo = {
  id: 'video-asset-generated',
  projectId: 'project',
  kind: 'shot-video',
  relativePath: 'assets/videos/generated.mp4',
  contentHash: 'video-hash',
  sizeBytes: 102_400,
  createdAt: '2026-08-02T00:05:00.000Z',
};

describe('ProductionPanel', () => {
  it('fills the full narrative scene and allows a model-sized production segment without changing scene order', async () => {
    const model: AdapterDescriptor = {
      ...videoDescriptor,
      key: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
      capability: 'TEXT_TO_VIDEO',
      capabilityLabel: '文生视频',
      parameterSchema: {
        ...videoDescriptor.parameterSchema,
        required: ['prompt', 'duration', 'resolution', 'audio'],
        properties: {
          ...videoDescriptor.parameterSchema.properties,
          prompt: { type: 'string', title: '完整场次提示词' },
        },
      },
      uiSchema: {
        fields: [
          { key: 'prompt', control: 'textarea', group: 'basic', order: 0 },
          ...videoDescriptor.uiSchema.fields.filter((field) => field.key !== 'images'),
        ],
      },
    };
    const target = { kind: 'scene' as const, id: 'scene' };
    const scene = {
      id: 'scene',
      projectId: 'project',
      title: '剧情自然发展',
      position: 0,
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
      characterBindings: [],
    };
    const complete = '镜头01：观察线索 0—8秒\n镜头02：确认后离开 8—23秒';
    const timeline = [
      {
        shotId: 's1',
        title: '观察线索',
        startSeconds: 0,
        endSeconds: 8,
        estimatedDurationSeconds: 8,
        prompt: '观察线索',
      },
      {
        shotId: 's2',
        title: '确认后离开',
        startSeconds: 8,
        endSeconds: 23,
        estimatedDurationSeconds: 15,
        prompt: '确认后离开',
      },
    ];
    mockWorker((method) => {
      if (method === 'adapter.catalog')
        return Promise.resolve({
          capabilities: [{ key: 'TEXT_TO_VIDEO', label: '文生视频' }],
          providers: videoCatalog.providers,
          adapters: [model],
        });
      if (method === 'adapter.resolve') return Promise.resolve(model);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'scene.list') return Promise.resolve([scene]);
      if (method === 'characterVoiceReference.list') return Promise.resolve([]);
      if (method === 'asset.list' || method === 'video.job.list') return Promise.resolve([]);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'video.generate.prepare') return Promise.resolve(videoJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('video', videoJob('pending')));
      if (method === 'media.task.cancel') return Promise.resolve({});
      throw new Error(`Unexpected ${method}`);
    });
    const previous = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
      if (method === 'production.compile' || method === 'production.read') {
        const ranged = Array.isArray(params.shotIds);
        return Promise.resolve({
          target,
          rowVersion: 1,
          source: {
            target,
            instructionId: 'instruction',
            revision: 1,
            token: 'a'.repeat(64),
            ...(ranged ? { shotIds: params.shotIds } : {}),
          },
          compiledPrompt: ranged ? '镜头01：观察线索' : complete,
          estimatedDurationSeconds: ranged ? 8 : 23,
          requestedDurationSeconds: ranged ? 8 : undefined,
          timeline: ranged ? timeline.slice(0, 1) : timeline,
          parameters: {
            prompt: ranged ? '镜头01：观察线索' : complete,
            ...(ranged ? { duration: 8 } : {}),
            resolution: '720p',
            audio: false,
          },
          issues: ranged
            ? []
            : [{ code: 'SCENE_REQUIRES_SEGMENTS', message: '完整剧情超过单次时长' }],
          segments: [
            { shotIds: ['s1'], estimatedDurationSeconds: 8, requestedDurationSeconds: 8 },
            { shotIds: ['s2'], estimatedDurationSeconds: 15, requestedDurationSeconds: 15 },
          ],
        });
      }
      return previous(method as never, params);
    }) as typeof callWorker);
    render(
      <ProductionPanel
        projectId="project"
        sceneId="scene"
        capability="TEXT_TO_VIDEO"
        writable
        onRequestSubmissionApproval={() => Promise.resolve(false)}
      />,
    );
    const prompt = await screen.findByLabelText(/完整场次提示词/);
    await waitFor(() => expect(prompt).toHaveValue(complete));
    expect(screen.getByText('完整剧情超过单次时长')).toBeInTheDocument();
    const range = await screen.findByLabelText('本次制作范围');
    await waitFor(() => expect(range).toBeEnabled());
    fireEvent.change(range, { target: { value: '0' } });
    await waitFor(() => expect(prompt).toHaveValue('镜头01：观察线索'));
    expect(screen.getByText('查看完整场次方案')).toBeInTheDocument();
    expect(screen.getByLabelText(/时长/)).toHaveValue(8);
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.find(([method]) => method === 'video.generate.prepare')?.[1],
      ).toMatchObject({
        sceneId: 'scene',
        productionSource: { shotIds: ['s1'] },
        parameters: { duration: 8, prompt: '镜头01：观察线索' },
      }),
    );
  });
  it.each([
    { name: 'project', next: { projectId: 'next-project' } },
    { name: 'shot', next: { shotId: 'next-shot' } },
    { name: 'scene', next: { sceneId: 'next-scene' } },
    { name: 'same project session', next: { projectSessionId: 'session-2' } },
    { name: 'reopened project view', next: { projectViewEpoch: {} } },
    { name: 'project A to B to A', next: { projectId: 'next-project' }, returnToOriginal: true },
  ])('ignores a late image response after switching $name', async ({ next, returnToOriginal }) => {
    const onAssetsChanged = vi.fn();
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission') return pending;
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'characterVoiceReference.list' || method === 'scene.list')
        return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    const props = {
      projectId: 'project',
      projectSessionId: 'session-1',
      shotId: 'shot',
      writable: true,
      onAssetsChanged,
    };
    const view = render(<ProductionPanel {...props} />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '旧目标图片' },
    });
    await submitPaidGeneration('生成图片');
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'media.generation.confirmSubmission',
        expect.anything(),
      ),
    );
    view.rerender(<ProductionPanel {...props} {...next} />);
    if (returnToOriginal) view.rerender(<ProductionPanel {...props} />);
    await act(async () => {
      finish({ kind: 'image', job: imageJob('succeeded', { withPreview: true }) });
      await pending;
    });
    expect(onAssetsChanged).not.toHaveBeenCalled();
    expect(screen.queryByText('图片已保存到本地素材库。')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: savedAsset.relativePath })).not.toBeInTheDocument();
  });

  it('does not let an old image finally clear a newer submission', async () => {
    const completions: Array<(value: unknown) => void> = [];
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return new Promise((resolve) => {
          completions.push(resolve);
        });
      if (method === 'asset.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    const props = { projectId: 'project', shotId: 'shot', writable: true };
    const view = render(<ProductionPanel {...props} projectSessionId="first" />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), { target: { value: '图片' } });
    await submitPaidGeneration('生成图片');
    await waitFor(() => expect(completions).toHaveLength(1));
    view.rerender(<ProductionPanel {...props} projectSessionId="second" />);
    await waitFor(() => expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    const secondApproval = await screen.findByRole('button', { name: '批准' });
    await act(async () => {
      completions[0]!({ kind: 'image', job: imageJob('failed') });
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: '生成图片' })).toBeDisabled();
    expect(secondApproval).toBeEnabled();
    fireEvent.click(secondApproval);
    await waitFor(() => expect(completions).toHaveLength(2));
    await act(async () => {
      completions[1]!({ kind: 'image', job: imageJob('cancelled') });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled());
  });

  it('selects HappyHorse by official contract without a parameter-template selection', async () => {
    const contract = officialVideoContracts.find(
      (item) => item.officialModelName === 'happyhorse-1.1-t2v',
    )!;
    const profile: ProviderProfileInfo = {
      ...providerProfile,
      providerType: 'unicompapi',
      name: 'UniCompAPI',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    };
    const adapter: AdapterDescriptor = {
      ...descriptor,
      key: 'TEXT_TO_VIDEO:unicompapi:cn.happyhorse.1.1.t2v:contract-1',
      capability: 'TEXT_TO_VIDEO',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      model: contract.contractId,
      modelLabel: contract.officialModelName,
      contractId: contract.contractId,
      apiVersion: 'contract-1',
      parameterSchema: {
        ...descriptor.parameterSchema,
        required: ['prompt'],
        properties: contract.parameterSchema
          .properties as AdapterDescriptor['parameterSchema']['properties'],
      },
      uiSchema: { fields: [] },
    };
    const model: ProviderModelInfo = {
      ...providerModels[0]!,
      remoteModelId: contract.officialModelName,
      displayName: 'HappyHorse 1.1',
      contractId: contract.contractId,
      contractStatus: 'enabled',
      capabilities: {
        ...providerModels[0]!.capabilities,
        imageGeneration: false,
        videoGeneration: true,
      },
    };
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'adapter.catalog')
        return Promise.resolve({
          ...catalog,
          capabilities: [{ key: 'TEXT_TO_VIDEO', label: '文生视频' }],
          adapters: [adapter],
        });
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'adapter.resolve') return Promise.resolve(adapter);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel capability="TEXT_TO_VIDEO" writable />);
    expect(await screen.findByRole('option', { name: 'HappyHorse 1.1' })).toBeInTheDocument();
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('adapter.resolve', {
        capability: 'TEXT_TO_VIDEO',
        provider: 'unicompapi',
        model: contract.contractId,
        apiVersion: 'contract-1',
      }),
    );
    expect(await screen.findByLabelText(/分辨率/)).toHaveValue('1080P');
    expect(screen.getByLabelText(/时长（秒）/)).toHaveValue(5);
    expect(screen.queryByLabelText(/生成音频/)).not.toBeInTheDocument();
  });

  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    vi.resetAllMocks();
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: confirmDialog,
    });
    confirmDialog.mockReturnValue(true);
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'generation.draft.save') {
        return Promise.resolve({
          id: 'draft',
          shotId: 'shot',
          adapterKey: descriptor.key,
          parameters: { prompt: '电影画面', resolution: '1080p' },
          updatedAt: '2026-08-01T12:00:00.000Z',
        });
      }
      if (method === 'asset.preview') {
        return Promise.resolve({
          assetId: 'asset-generated',
          dataUrl: 'data:image/png;base64,asset',
          contentType: 'image/png',
        });
      }
      if (method === 'asset.reveal') {
        return Promise.resolve({ path: 'D:\\Project\\assets\\images\\generated.png' });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
  });

  it('seeds reference images from a shot workspace', async () => {
    render(
      <ProductionPanel
        writable
        capability="TEXT_TO_IMAGE"
        shotId="shot-1"
        seedPrompt="雨夜里林澈回头"
        seedImages={['asset://character-1', 'asset://scene-1']}
        preferredAssetKind="first-frame"
      />,
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('雨夜里林澈回头');
    expect(screen.getByLabelText('保存为')).toHaveValue('first-frame');
  });

  it('keeps seeded shot parameters when the project draft cannot be loaded', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.reject(new Error('draft missing'));
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    render(
      <ProductionPanel
        writable
        shotId="shot"
        seedPrompt="雨夜里林澈回头"
        preferredAssetKind="first-frame"
      />,
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('雨夜里林澈回头');
    expect(screen.getByLabelText('保存为')).toHaveValue('first-frame');
    expect(screen.queryByText(/适配器解析失败/)).not.toBeInTheDocument();
  });

  it('seeds the image prompt and asset kind from a character document', async () => {
    render(
      <ProductionPanel
        writable
        capability="TEXT_TO_IMAGE"
        sourceDocumentId="character-doc"
        seedPrompt="林澈，灯塔守望员"
        preferredAssetKind="character"
      />,
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('林澈，灯塔守望员');
    expect(screen.getByLabelText('保存为')).toHaveValue('character');
  });

  it('renders schema fields and saves a validated per-shot draft', async () => {
    render(<ProductionPanel shotId="shot" writable />);
    const prompt = await screen.findByLabelText(/画面提示词/);
    expect(screen.getByLabelText('供应商连接')).toHaveValue(providerProfile.id);
    expect(screen.getByLabelText('分辨率*')).toBeInTheDocument();
    expect(screen.getByText('专业参数')).toBeInTheDocument();

    fireEvent.change(prompt, { target: { value: '电影画面' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('generation.draft.save', {
        shotId: 'shot',
        adapterKey: descriptor.key,
        providerProfileId: providerProfile.id,
        modelId: 'viduq2',
        parameters: { prompt: '电影画面', resolution: '1080p' },
      }),
    );
    expect(await screen.findByText(/草稿已保存/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '普通素材' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '角色' })).toBeInTheDocument();
    expect(screen.queryByLabelText('自动保存到本地素材库')).not.toBeInTheDocument();
  });

  it('merges current schema defaults into an older saved draft', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') {
        return Promise.resolve({
          id: 'legacy-draft',
          shotId: 'shot',
          adapterKey: descriptor.key,
          parameters: { prompt: '旧草稿' },
          updatedAt: '2026-08-01T12:00:00.000Z',
        });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel shotId="shot" writable />);
    expect(await screen.findByLabelText('分辨率*')).toHaveValue('1080p');
  });

  it('remembers parameter values per adapter so switching models keeps the form', async () => {
    window.localStorage.clear();
    const { unmount } = render(<ProductionPanel shotId="shot" writable />);
    const prompt = await screen.findByLabelText(/画面提示词/);
    fireEvent.change(prompt, { target: { value: '记住这段提示词' } });
    unmount();

    // A fresh panel for the same adapter restores the remembered value.
    render(<ProductionPanel shotId="shot" writable />);
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('记住这段提示词');
  });

  it('never persists local image data URLs in the parameter memory', async () => {
    window.localStorage.clear();
    render(<ProductionPanel shotId="shot" writable />);
    const prompt = await screen.findByLabelText(/画面提示词/);
    fireEvent.change(prompt, {
      target: { value: 'data:image/png;base64,iVBORw0KGgo=' },
    });

    expect(
      window.localStorage.getItem('ai-video.production-adapter-parameters') ?? '',
    ).not.toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('uses the controlled production capability and removes the right-side mode selector', async () => {
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(completeModeCatalog);
      if (method === 'adapter.resolve') {
        const selection = params as { capability: string; model: string; apiVersion?: string };
        return Promise.resolve(
          completeModeCatalog.adapters.find(
            (item) =>
              item.capability === selection.capability &&
              item.model === selection.model &&
              item.apiVersion === selection.apiVersion,
          ) ?? descriptor,
        );
      }
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel capability="REFERENCE_TO_VIDEO" shotId="shot" writable />);

    expect(screen.queryByLabelText('生产方式')).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Vidu Q3 Pro' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Vidu Q2' })).not.toBeInTheDocument();
  });

  it('does not persist a draft when adapter validation fails', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') {
        return Promise.resolve({
          valid: false,
          errors: [{ path: 'prompt', message: 'must have required property prompt' }],
        });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel shotId="shot" writable />);
    fireEvent.click(await screen.findByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('1 项参数需要修正')).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('generation.draft.save', expect.anything());
  });

  it('shows an actionable settings entry when no media profile is ready', async () => {
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    const onOpenProviderSettings = vi.fn();
    render(<ProductionPanel writable onOpenProviderSettings={onOpenProviderSettings} />);

    expect(await screen.findByText('还没有可用于制作的供应商连接')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前往供应商与模型' }));
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
    expect(callWorker).not.toHaveBeenCalledWith('image.generate.prepare', expect.anything());
  });

  it('keeps multiple Vidu connections independently selectable', async () => {
    const globalModel = {
      ...providerModels.find((model) => model.remoteModelId === 'viduq2')!,
      id: '31111111-1111-4111-8111-111111111111',
      providerProfileId: globalProviderProfile.id,
    };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'provider.profile.list') {
        return Promise.resolve([providerProfile, globalProviderProfile]);
      }
      if (method === 'provider.model.list') {
        return Promise.resolve(
          (params as { profileId: string }).profileId === globalProviderProfile.id
            ? [globalModel]
            : providerModels,
        );
      }
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel shotId="shot" writable />);
    const profileSelect = await screen.findByLabelText('供应商连接');
    expect(screen.getByRole('option', { name: /Vidu 中国站 A/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Vidu 国际站 B/ })).toBeInTheDocument();

    fireEvent.change(profileSelect, { target: { value: globalProviderProfile.id } });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('provider.model.list', {
        profileId: globalProviderProfile.id,
      }),
    );
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('generation.draft.get', {
        shotId: 'shot',
        adapterKey: descriptor.key,
        providerProfileId: globalProviderProfile.id,
        modelId: 'viduq2',
      }),
    );
    expect(profileSelect).toHaveValue(globalProviderProfile.id);
  });

  it('selects UniCompAPI media models without mixing Vidu adapters', async () => {
    const unicompProfile: ProviderProfileInfo = {
      ...providerProfile,
      id: '11111111-1111-4111-8111-111111111113',
      name: 'UniCompAPI A',
      providerType: 'unicompapi',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    };
    const unicompDescriptor: AdapterDescriptor = {
      ...descriptor,
      key: 'TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      model: 'openai-compatible-image',
      modelLabel: 'OpenAI 兼容生图',
      apiVersion: 'v1',
      endpoint: 'https://unicompapi.com/v1/images/generations',
      credentialProvider: 'unicompapi',
    };
    const unicompModel: ProviderModelInfo = {
      ...providerModels[0]!,
      id: '31111111-1111-4111-8111-111111111113',
      providerProfileId: unicompProfile.id,
      remoteModelId: 'qwen-image',
      displayName: 'Qwen Image',
      parameterTemplateKey: 'openai-compatible-image',
    };
    const mixedCatalog: AdapterCatalogResult = {
      ...catalog,
      providers: [...catalog.providers, { key: 'unicompapi', label: 'UniCompAPI' }],
      adapters: [descriptor, unicompDescriptor],
    };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(mixedCatalog);
      if (method === 'provider.profile.list') {
        return Promise.resolve([providerProfile, unicompProfile]);
      }
      if (method === 'provider.model.list') {
        return Promise.resolve(
          (params as { profileId: string }).profileId === unicompProfile.id
            ? [unicompModel]
            : providerModels,
        );
      }
      if (method === 'adapter.resolve') {
        return Promise.resolve(
          (params as { provider: string }).provider === 'unicompapi'
            ? unicompDescriptor
            : descriptor,
        );
      }
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel shotId="shot" writable />);
    const profileSelect = await screen.findByLabelText('供应商连接');
    expect(screen.getByRole('option', { name: 'UniCompAPI A · UniCompAPI' })).toBeInTheDocument();

    fireEvent.change(profileSelect, { target: { value: unicompProfile.id } });
    expect(await screen.findByRole('option', { name: 'Qwen Image' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Vidu Q2' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('adapter.resolve', {
        capability: 'TEXT_TO_IMAGE',
        provider: 'unicompapi',
        model: 'openai-compatible-image',
        apiVersion: 'v1',
      }),
    );
    expect(await screen.findByText('UniCompAPI A · UniCompAPI · API v1')).toBeInTheDocument();
  });

  it('refreshes provider connections after settings changes without remounting', async () => {
    const unicompProfile: ProviderProfileInfo = {
      ...providerProfile,
      id: '11111111-1111-4111-8111-111111111114',
      name: 'UniCompAPI A',
      providerType: 'unicompapi',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    };
    const unicompDescriptor: AdapterDescriptor = {
      ...descriptor,
      key: 'TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      model: 'openai-compatible-image',
      modelLabel: 'OpenAI 兼容生图',
      apiVersion: 'v1',
      endpoint: 'https://unicompapi.com/v1/images/generations',
      credentialProvider: 'unicompapi',
    };
    const unicompModel: ProviderModelInfo = {
      ...providerModels[0]!,
      id: '21111111-1111-4111-8111-111111111117',
      providerProfileId: unicompProfile.id,
      remoteModelId: 'qwen-image',
      displayName: 'qwen-image',
      parameterTemplateKey: 'openai-compatible-image',
    };
    const mixedCatalog: AdapterCatalogResult = {
      ...catalog,
      providers: [...catalog.providers, { key: 'unicompapi', label: 'UniCompAPI' }],
      adapters: [descriptor, unicompDescriptor],
    };
    let profileListCalls = 0;
    let modelListCalls = 0;
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(mixedCatalog);
      if (method === 'provider.profile.list') {
        profileListCalls += 1;
        return Promise.resolve(profileListCalls === 1 ? [] : [unicompProfile]);
      }
      if (method === 'provider.model.list') {
        modelListCalls += 1;
        return Promise.resolve(
          (params as { profileId: string }).profileId === unicompProfile.id && modelListCalls > 1
            ? [unicompModel]
            : [],
        );
      }
      if (method === 'adapter.resolve') return Promise.resolve(unicompDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    const { rerender } = render(
      <ProductionPanel capability="TEXT_TO_IMAGE" providerSettingsRevision={0} writable />,
    );
    expect(await screen.findByRole('option', { name: '没有可用连接' })).toBeInTheDocument();

    rerender(<ProductionPanel capability="TEXT_TO_IMAGE" providerSettingsRevision={1} writable />);
    const profileSelect = await screen.findByLabelText('供应商连接');
    expect(
      await screen.findByRole('option', { name: 'UniCompAPI A · UniCompAPI' }),
    ).toBeInTheDocument();
    fireEvent.change(profileSelect, { target: { value: unicompProfile.id } });

    expect(await screen.findByText('当前连接没有兼容模型')).toBeInTheDocument();
    rerender(<ProductionPanel capability="TEXT_TO_IMAGE" providerSettingsRevision={2} writable />);
    expect(await screen.findByRole('option', { name: 'qwen-image' })).toBeInTheDocument();
  });

  it('uses the full adapter key and locks the API version during resolution', async () => {
    const v3 = { ...descriptor, key: 'TEXT_TO_IMAGE:vidu:viduq2:v3', apiVersion: 'v3' };
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') {
        return Promise.resolve({ ...catalog, adapters: [descriptor, v3] });
      }
      if (method === 'adapter.resolve') {
        return Promise.resolve(
          (params as { apiVersion?: string }).apiVersion === 'v3' ? v3 : descriptor,
        );
      }
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel shotId="shot" writable />);
    const model = await screen.findByLabelText('模型');

    await waitFor(() =>
      expect(Array.from((model as HTMLSelectElement).options).map((option) => option.text)).toEqual(
        ['Vidu Q2', 'Vidu Q2'],
      ),
    );
    expect(await screen.findByText(`${providerProfile.name} · Vidu · API v2`)).toBeInTheDocument();

    const v3OptionKey = '21111111-1111-4111-8111-111111111112::' + v3.key;
    fireEvent.change(model, { target: { value: v3OptionKey } });

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('adapter.resolve', {
        capability: v3.capability,
        provider: v3.provider,
        model: v3.model,
        apiVersion: 'v3',
      }),
    );
    expect(model).toHaveValue(v3OptionKey);
    expect(await screen.findByText(`${providerProfile.name} · Vidu · API v3`)).toBeInTheDocument();
  });

  it('loads persisted assets when a project opens', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list') {
        return Promise.resolve([
          {
            id: 'asset',
            projectId: 'project',
            kind: 'generated-image',
            relativePath: 'assets/images/persisted.png',
            contentHash: 'hash',
            sizeBytes: 8192,
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        ]);
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable />);

    expect(await screen.findByText('assets/images/persisted.png')).toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('asset.list', {});
    expect(screen.getByTitle('重命名素材')).toBeInTheDocument();
    expect(screen.getByTitle('删除素材')).toBeInTheDocument();
  });

  it('saves a generated image locally by default and exposes preview, reveal, and library actions', async () => {
    const onAssetsChanged = vi.fn();
    const onOpenAssetLibrary = vi.fn();
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({
          kind: 'image',
          job: imageJob('succeeded', { withPreview: true }),
        });
      if (method === 'asset.list') return Promise.resolve([savedAsset]);
      if (method === 'asset.preview') {
        return Promise.resolve({
          assetId: savedAsset.id,
          dataUrl: 'data:image/png;base64,asset',
          contentType: 'image/png',
        });
      }
      if (method === 'asset.reveal') {
        return Promise.resolve({ path: 'D:\\Project\\assets\\images\\generated.png' });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(
      <ProductionPanel
        projectId="project"
        projectRootPath="D:\\Project"
        shotId="shot"
        writable
        onAssetsChanged={onAssetsChanged}
        onOpenAssetLibrary={onOpenAssetLibrary}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '电影画面' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    // The frozen draft is reviewed on the shared card, not a native dialog.
    expect(await screen.findByText(`${providerProfile.name} / Vidu Q2`)).toBeInTheDocument();
    expect(screen.getByText('草稿版本 v1')).toBeInTheDocument();
    expect(screen.getByText('prompt')).toBeInTheDocument();
    expect(screen.getByText('本次操作可能产生费用。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('media.generation.confirmSubmission', {
        jobId: 'job',
        confirmationToken: 'confirmation-job',
        approved: true,
      }),
    );
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
    expect((await screen.findAllByText(savedAsset.relativePath)).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: savedAsset.relativePath })).toHaveAttribute(
      'src',
      `/worker-media/${savedAsset.id}`,
    );
    expect(onAssetsChanged).toHaveBeenCalledWith([savedAsset], savedAsset.id);
    fireEvent.click(screen.getByRole('button', { name: `放大查看${savedAsset.relativePath}` }));
    expect(
      screen.getByRole('dialog', { name: `图片预览：${savedAsset.relativePath}` }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));

    fireEvent.click(screen.getAllByRole('button', { name: '打开位置' })[0]!);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('asset.reveal', { assetId: savedAsset.id }),
    );
    fireEvent.click(screen.getByRole('button', { name: '查看素材库' }));
    expect(onOpenAssetLibrary).toHaveBeenCalledWith(savedAsset.id);
  });

  it('previews every image returned by one generation and enlarges each independently', async () => {
    const generated = [
      savedAsset,
      { ...savedAsset, id: 'second-image', relativePath: 'assets/images/second.png' },
    ];
    const completed = {
      ...imageJob('succeeded'),
      results: generated.map((asset, index) => ({
        id: `result-${index}`,
        jobId: 'job',
        asset,
        createdAt: 'now',
      })),
    };
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({ kind: 'image', job: completed });
      if (method === 'asset.list') return Promise.resolve(generated);
      if (method === 'video.generate.list') return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    render(<ProductionPanel projectId="project" shotId="shot" writable />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), { target: { value: '电影画面' } });
    await submitPaidGeneration('生成图片');
    const results = await screen.findByLabelText('本次生成的全部图片');
    expect(await within(results).findByRole('img', { name: 'second.png' })).toHaveAttribute(
      'src',
      '/worker-media/second-image',
    );
    expect(within(results).getAllByRole('img')).toHaveLength(2);
    fireEvent.click(within(results).getByRole('button', { name: '放大查看second.png' }));
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
      'src',
      '/worker-media/second-image',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
  });

  it('selects the automatically saved result after clearing a previously selected asset', async () => {
    const priorAsset: AssetInfo = {
      ...savedAsset,
      id: 'asset-prior',
      relativePath: 'assets/images/prior.png',
    };
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({
          kind: 'image',
          job: imageJob('succeeded', { withPreview: true }),
        });
      if (method === 'asset.list') return Promise.resolve([priorAsset, savedAsset]);
      if (method === 'asset.preview') {
        const assetId = (params as { assetId: string }).assetId;
        return Promise.resolve({
          assetId,
          dataUrl:
            assetId === priorAsset.id
              ? 'data:image/png;base64,prior'
              : 'data:image/png;base64,asset',
          contentType: 'image/png',
        });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[priorAsset]} />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '电影画面' },
    });
    fireEvent.click(await screen.findByText(priorAsset.relativePath));
    expect(await screen.findByRole('img', { name: priorAsset.relativePath })).toBeInTheDocument();

    await submitPaidGeneration('生成图片');

    expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '生成图片预览' })).toHaveAttribute(
        'src',
        `/worker-media/${savedAsset.id}`,
      ),
    );
    expect(screen.queryByRole('button', { name: '保存到素材库' })).not.toBeInTheDocument();
  });

  it('explains why draft save is blocked when no shot is selected', async () => {
    render(<ProductionPanel writable />);
    fireEvent.click(await screen.findByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('请先在左侧选择镜头后再保存草稿。')).toBeInTheDocument();
  });

  it('always saves generated images to the local asset library', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({ kind: 'image', job: imageJob('succeeded') });
      if (method === 'asset.list') return Promise.resolve([savedAsset]);
      if (method === 'asset.preview') {
        return Promise.resolve({
          assetId: savedAsset.id,
          dataUrl: 'data:image/png;base64,asset',
          contentType: 'image/png',
        });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '电影画面' },
    });
    await submitPaidGeneration('生成图片');

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'media.generation.confirmSubmission',
        expect.objectContaining({ jobId: 'job', approved: true }),
      ),
    );
    expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: savedAsset.relativePath })).toHaveAttribute(
      'src',
      `/worker-media/${savedAsset.id}`,
    );
    expect(screen.getAllByText(savedAsset.relativePath).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(savedAsset.relativePath)).length).toBeGreaterThan(0);
  });

  it('keeps a prepared image job in submission_unknown when Provider acceptance is ambiguous', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') return Promise.resolve(imageJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', imageJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({
          kind: 'image',
          job: {
            ...imageJob('running'),
            mediaState: 'submission_unknown',
            error: 'Submission status is unknown: connection closed after request write',
          },
        });
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel shotId="shot" writable />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '电影画面' },
    });

    await submitPaidGeneration('生成图片');

    expect(
      await screen.findAllByText(
        '提交结果未知。为避免重复扣费，系统不会自动重试，请先到 Provider 后台核对。',
      ),
    ).not.toHaveLength(0);
    expect(callWorker).not.toHaveBeenCalledWith('image.generate.fail', expect.anything());
    expect(screen.queryByTitle('取消生成')).not.toBeInTheDocument();
  });

  it('submits a video task once and persists its provider task association', async () => {
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'video.generate.prepare') {
        return Promise.resolve({
          ...videoJob('pending'),
          request: (params as { parameters: VideoGenerationJobInfo['request'] }).parameters,
        });
      }
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('video', videoJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({ kind: 'video', job: videoJob('polling') });
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    fireEvent.change(await screen.findByLabelText('首帧 URL'), {
      target: { value: 'https://example.invalid/start.png' },
    });
    fireEvent.change(screen.getByLabelText('尾帧 URL'), {
      target: { value: 'https://example.invalid/end.png' },
    });
    await submitPaidGeneration('提交视频任务');

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'video.generate.prepare',
        expect.objectContaining({
          shotId: 'shot',
          adapterKey: videoDescriptor.key,
          providerRegion: 'cn',
          providerProfileId: providerProfile.id,
          modelId: 'viduq3-pro',
          assetKind: 'shot-video',
        }),
      ),
    );
    expect(callWorker).toHaveBeenCalledWith('media.generation.requestSubmission', {
      jobId: 'video-job',
    });
    expect(callWorker).toHaveBeenCalledWith('media.generation.confirmSubmission', {
      jobId: 'video-job',
      confirmationToken: 'confirmation-video-job',
      approved: true,
    });
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(await screen.findByText('视频任务已提交，项目后台正在处理。')).toBeInTheDocument();
  });

  it('persists the bounded provider detail when video submission is rejected', async () => {
    const message =
      'Provider 视频任务提交失败，HTTP 400：invalid_request：input_reference is required。';
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'video.generate.prepare') return Promise.resolve(videoJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('video', videoJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({
          kind: 'video',
          job: {
            ...videoJob('failed'),
            providerTaskId: undefined,
            mediaState: 'failed',
            error: message,
          },
        });
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    fireEvent.change(await screen.findByLabelText('首帧 URL'), {
      target: { value: 'https://example.invalid/start.png' },
    });
    fireEvent.change(screen.getByLabelText('尾帧 URL'), {
      target: { value: 'https://example.invalid/end.png' },
    });
    await submitPaidGeneration('提交视频任务');

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('media.generation.confirmSubmission', {
        jobId: 'video-job',
        confirmationToken: 'confirmation-video-job',
        approved: true,
      }),
    );
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.fail', expect.anything());
    expect(
      await screen.findAllByText(
        '当前模型不接受这组参数。请检查必填项；如果界面参数与官方文档不一致，请更新模型 Schema 或更换模型。',
      ),
    ).not.toHaveLength(0);
  });

  it('keeps a prepared video job in submission_unknown when Provider acceptance is ambiguous', async () => {
    const unknown: VideoGenerationJobInfo = {
      ...videoJob('pending'),
      mediaState: 'submission_unknown',
      error: 'Submission status is unknown: network disconnected',
    };
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'video.generate.prepare') return Promise.resolve(videoJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('video', videoJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({
          kind: 'video',
          job: unknown,
        });
      throw new Error(`Unexpected method ${method}`);
    });

    const view = render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    fireEvent.change(await screen.findByLabelText('首帧 URL'), {
      target: { value: 'https://example.invalid/start.png' },
    });
    fireEvent.change(screen.getByLabelText('尾帧 URL'), {
      target: { value: 'https://example.invalid/end.png' },
    });
    await submitPaidGeneration('提交视频任务');

    expect(
      await screen.findAllByText(
        '提交结果未知。为避免重复扣费，系统不会自动重试，请先到 Provider 后台核对。',
      ),
    ).not.toHaveLength(0);
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.fail', expect.anything());
    expect(screen.queryByText('视频任务已提交，正在本地查询。')).not.toBeInTheDocument();
    view.rerender(
      <ProductionPanel
        projectId="project"
        shotId="shot"
        writable
        assets={[]}
        videoJobs={[unknown]}
      />,
    );
    const tasks = screen.getByRole('region', { name: '视频任务' });
    expect(within(tasks).getByText('提交结果未知', { exact: true })).toBeInTheDocument();
    expect(within(tasks).queryByText('正在提交', { exact: true })).not.toBeInTheDocument();
    expect(within(tasks).getByText(/生成服务未返回任务编号/)).toBeInTheDocument();
  });

  it('keeps dropped asset references bounded through drafts and submission', async () => {
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'generation.draft.save')
        return Promise.resolve({
          id: 'draft',
          shotId: 'shot',
          adapterKey: videoDescriptor.key,
          parameters: (params as { parameters: object }).parameters,
          updatedAt: '2026-08-01T12:00:00.000Z',
        });
      if (method === 'asset.preview') {
        const id = (params as { assetId: string }).assetId;
        return Promise.resolve({
          assetId: id,
          dataUrl: `data:image/png;base64,${id}`,
          contentType: 'image/png',
        });
      }
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'video.generate.prepare') return Promise.resolve(videoJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('video', videoJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({ kind: 'video', job: videoJob('polling') });
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    const target = (await screen.findByLabelText(/首帧与尾帧/)).closest('.asset-drop-target')!;
    const payload = JSON.stringify({
      version: 1,
      projectId: 'project',
      assets: [
        { id: 'asset-start', kind: 'generated-image' },
        { id: 'asset-end', kind: 'generated-image' },
      ],
    });
    fireEvent.drop(target, {
      dataTransfer: {
        getData: (type: string) => (type === 'application/x-ai-video-asset+json' ? payload : ''),
      },
    });
    expect(await screen.findAllByText('素材库图片')).toHaveLength(2);
    const startPreview = await screen.findByRole('button', { name: '放大查看首帧：素材库图片' });
    expect(within(startPreview).getByRole('img')).toHaveAttribute(
      'src',
      '/worker-media/asset-start',
    );
    expect(
      within(screen.getByRole('button', { name: '放大查看尾帧：素材库图片' })).getByRole('img'),
    ).toHaveAttribute('src', '/worker-media/asset-end');
    fireEvent.click(startPreview);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
      'src',
      '/worker-media/asset-start',
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => {
      const saveCall = vi
        .mocked(callWorker)
        .mock.calls.find(([method]) => method === 'generation.draft.save');
      expect(saveCall?.[1]).toMatchObject({
        parameters: { images: ['asset://asset-start', 'asset://asset-end'] },
      });
    });
    await submitPaidGeneration('提交视频任务');
    await waitFor(() => {
      const prepareCall = vi
        .mocked(callWorker)
        .mock.calls.find(([method]) => method === 'video.generate.prepare');
      expect(prepareCall?.[1]).toMatchObject({
        parameters: {
          images: ['asset://asset-start', 'asset://asset-end'],
        },
      });
    });
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'asset.preview'),
    ).toHaveLength(0);
  });

  it('previews and reorders local start and end frames and submits Data URLs once', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'video.generate.prepare') return Promise.resolve(videoJob('pending'));
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('video', videoJob('pending')));
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({ kind: 'video', job: videoJob('polling') });
      throw new Error(`Unexpected method ${method}`);
    });

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const jpeg = new Uint8Array([255, 216, 255, 224]);
    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);

    fireEvent.change(await screen.findByLabelText('为首帧选择本地图片'), {
      target: { files: [new File([png], 'start.png', { type: 'image/png' })] },
    });
    expect(await screen.findByText('start.png')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('为尾帧选择本地图片'), {
      target: { files: [new File([jpeg], 'end.jpg', { type: 'image/jpeg' })] },
    });
    expect(await screen.findByText('end.jpg')).toBeInTheDocument();

    const startPreview = screen.getByRole('button', { name: '放大查看首帧：start.png' });
    const startSource = within(startPreview).getByRole('img').getAttribute('src');
    const endPreview = screen.getByRole('button', { name: '放大查看尾帧：end.jpg' });
    const endSource = within(endPreview).getByRole('img').getAttribute('src');
    startPreview.focus();
    fireEvent.click(startPreview);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', startSource);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startPreview).toHaveFocus();

    const firstRow = startPreview.closest('.url-list-item')!;
    fireEvent.click(within(firstRow as HTMLElement).getByRole('button', { name: '下移' }));
    const reorderedStart = screen.getByRole('button', { name: '放大查看首帧：end.jpg' });
    const reorderedEnd = screen.getByRole('button', { name: '放大查看尾帧：start.png' });
    expect(within(reorderedStart).getByRole('img')).toHaveAttribute('src', endSource);
    expect(within(reorderedEnd).getByRole('img')).toHaveAttribute('src', startSource);
    expect(reorderedStart.closest('.url-list-item')).toHaveTextContent('end.jpg');
    expect(reorderedEnd.closest('.url-list-item')).toHaveTextContent('start.png');
    fireEvent.click(reorderedStart);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', endSource);
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));

    await submitPaidGeneration('提交视频任务');

    await waitFor(() => {
      const prepareCall = vi
        .mocked(callWorker)
        .mock.calls.find(([method]) => method === 'video.generate.prepare');
      const images = (prepareCall?.[1] as { parameters?: { images?: unknown[] } } | undefined)
        ?.parameters?.images;
      expect(images).toHaveLength(2);
      expect(images?.[0]).toEqual(expect.stringMatching(/^data:image\/jpeg;base64,/));
      expect(images?.[1]).toEqual(expect.stringMatching(/^data:image\/png;base64,/));
    });
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'video.generate.prepare'),
    ).toHaveLength(1);
  });

  it('replaces and clears a selected image without retaining its open preview', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    const picker = await screen.findByLabelText('为首帧选择本地图片');
    fireEvent.change(picker, {
      target: { files: [new File([png], 'first.png', { type: 'image/png' })] },
    });
    const firstPreview = await screen.findByRole('button', { name: '放大查看首帧：first.png' });
    const firstSource = within(firstPreview).getByRole('img').getAttribute('src');
    fireEvent.click(firstPreview);

    fireEvent.change(picker, {
      target: {
        files: [new File([png, new Uint8Array([1])], 'replacement.png', { type: 'image/png' })],
      },
    });
    const replacement = await screen.findByRole('button', {
      name: '放大查看首帧：replacement.png',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '首帧：first.png' })).not.toBeInTheDocument();
    expect(within(replacement).getByRole('img')).not.toHaveAttribute('src', firstSource);
    fireEvent.click(replacement);
    fireEvent.click(
      within(replacement.closest('.url-list-item') as HTMLElement).getByRole('button', {
        name: '清除此图片输入',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '首帧：replacement.png' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('首帧 URL')).toHaveValue('');
  });

  it('keeps unavailable asset inputs editable when their preview cannot be read', async () => {
    mockWorker(
      (method) => {
        if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
        if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
        if (method === 'generation.draft.get')
          return Promise.resolve({
            id: 'draft',
            shotId: 'shot',
            adapterKey: videoDescriptor.key,
            parameters: { images: ['asset://missing-frame', ''] },
            updatedAt: '2026-08-01T12:00:00.000Z',
          });
        if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
        throw new Error(`Unexpected method ${method}`);
      },
      ['missing-frame'],
    );
    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    const error = await screen.findByText('图片暂时无法预览');
    expect(
      screen.queryByRole('button', { name: '放大查看首帧：素材库图片' }),
    ).not.toBeInTheDocument();
    const row = error.closest('.url-list-item') as HTMLElement;
    expect(within(row).getByLabelText('为首帧选择本地图片')).toBeEnabled();
    fireEvent.click(within(row).getByRole('button', { name: '清除此图片输入' }));
    expect(screen.queryByText('图片暂时无法预览')).not.toBeInTheDocument();
    expect(screen.getByLabelText('首帧 URL')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('首帧 URL'), {
      target: { value: 'https://example.invalid/replacement.png' },
    });
    expect(screen.getByLabelText('首帧 URL')).toHaveValue(
      'https://example.invalid/replacement.png',
    );
  });

  it('keeps the existing URL after cancellation or an invalid local file selection', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    const startUrl = await screen.findByLabelText('首帧 URL');
    fireEvent.change(startUrl, { target: { value: 'https://example.invalid/start.png' } });
    const picker = screen.getByLabelText('为首帧选择本地图片');

    fireEvent.change(picker, { target: { files: [] } });
    expect(startUrl).toHaveValue('https://example.invalid/start.png');
    fireEvent.change(picker, {
      target: { files: [new File(['gif'], 'bad.gif', { type: 'image/gif' })] },
    });

    expect(await screen.findByText('仅支持 PNG、JPEG/JPG 和 WebP 图片。')).toBeInTheDocument();
    expect(startUrl).toHaveValue('https://example.invalid/start.png');
  });

  it('does not persist a draft containing a selected local image', async () => {
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    fireEvent.change(await screen.findByLabelText('为首帧选择本地图片'), {
      target: { files: [new File([png], 'start.png', { type: 'image/png' })] },
    });
    expect(await screen.findByText('start.png')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    expect(
      await screen.findByText('本地图片不会写入草稿，请改用公开 URL 后保存。'),
    ).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('generation.draft.save', expect.anything());
  });

  it('resumes without resubmission and keeps local cancellation when remote cancellation fails', async () => {
    const polling = videoJob('polling');
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'media.task.cancel')
        return Promise.resolve({
          kind: 'video',
          job: { ...polling, status: 'cancelled' as const, mediaState: 'cancelled' as const },
          cancellation: { localCancelled: true as const, provider: 'unknown' as const },
        });
      throw new Error(`Unexpected method ${method}`);
    });

    render(
      <ProductionPanel
        projectId="project"
        shotId="shot"
        writable
        assets={[]}
        videoJobs={[polling]}
      />,
    );
    expect(await screen.findByText('生成中')).toBeInTheDocument();
    expect(screen.getByText(/视频通常需要几分钟生成/)).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.observe', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.requestSubmission',
      expect.anything(),
    );

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));

    expect(
      await screen.findByText(
        '视频任务已取消，仅停止本地轮询；远端取消结果未知，Provider 任务可能仍会继续。',
      ),
    ).toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('media.task.cancel', { jobId: 'video-job' });
  });

  it('offers a primary material action when a video task completes', async () => {
    const completed = {
      ...videoJob('succeeded'),
      results: [
        {
          id: 'video-result',
          jobId: 'video-job',
          asset: savedVideoAsset,
          createdAt: '2026-08-02T00:05:00.000Z',
        },
      ],
    };
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list') return Promise.resolve([savedVideoAsset]);
      if (method === 'video.generate.list') return Promise.resolve([completed]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(
      <ProductionPanel
        projectId="project"
        shotId="shot"
        writable
        assets={[savedVideoAsset]}
        videoJobs={[completed]}
      />,
    );

    expect(await screen.findByText(/结果已进入素材库/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看素材' }));
    expect(await screen.findByText('视频已就绪')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '播放视频' })).toBeInTheDocument();
  });

  it('renders Worker-owned task snapshots without polling or observing the Provider', async () => {
    const polling = videoJob('polling');
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(
      <ProductionPanel
        projectId="project"
        shotId="shot"
        writable
        assets={[]}
        videoJobs={[polling]}
      />,
    );

    expect(await screen.findByText('生成中')).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.list', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.observe', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.timeout', expect.anything());
  });
  it('submits two image jobs from one panel and cancels the chosen job while the other keeps its own result', async () => {
    const jobs = new Map<string, ImageGenerationJobInfo>();
    const completions = new Map<string, (value: unknown) => void>();
    const onAssetsChanged = vi.fn(),
      approve = vi.fn(() => Promise.resolve(true));
    const otherAsset = {
      ...savedAsset,
      id: 'asset-second',
      relativePath: 'assets/images/second.png',
    };
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') {
        const job = {
          ...imageJob('running'),
          id: 'image-' + (jobs.size + 1),
          mediaState: 'draft' as const,
          request: params.parameters as ImageGenerationJobInfo['request'],
        };
        jobs.set(job.id, job);
        return Promise.resolve(job);
      }
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve(pendingSubmission('image', jobs.get(params.jobId as string)!));
      if (method === 'media.generation.confirmSubmission')
        return new Promise((resolve) => completions.set(params.jobId as string, resolve));
      if (method === 'media.task.cancel')
        return Promise.resolve({
          kind: 'image',
          job: {
            ...jobs.get(params.jobId as string)!,
            status: 'cancelled',
            mediaState: 'cancelled',
          },
        });
      if (method === 'asset.list') return Promise.resolve([otherAsset]);
      return Promise.resolve([]);
    });
    const props = {
      projectId: 'project',
      shotId: 'shot',
      writable: true,
      onAssetsChanged,
      onRequestSubmissionApproval: approve,
    };
    const view = render(<ProductionPanel {...props} />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: 'First independent image' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    await waitFor(() => expect(completions.size).toBe(1));
    expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/画面提示词/), {
      target: { value: 'Second independent image' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    await waitFor(() => expect(completions.size).toBe(2));
    const active = [...jobs.values()].map((job) => ({ ...job, mediaState: 'submitting' as const }));
    view.rerender(<ProductionPanel {...props} imageJobs={active} />);
    const background = screen.getByRole('region', { name: '图片后台任务' });
    fireEvent.click(within(background).getAllByRole('button', { name: '取消此图片任务' })[0]!);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('media.task.cancel', { jobId: 'image-1' }),
    );
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'media.task.cancel'),
    ).toHaveLength(1);
    await act(async () => {
      completions.get('image-1')!({
        kind: 'image',
        job: { ...jobs.get('image-1')!, status: 'cancelled', mediaState: 'cancelled' },
      });
      await Promise.resolve();
    });
    expect(onAssetsChanged).not.toHaveBeenCalled();
    await act(async () => {
      completions.get('image-2')!({
        kind: 'image',
        job: {
          ...imageJob('succeeded'),
          id: 'image-2',
          results: [{ id: 'result-2', jobId: 'image-2', asset: otherAsset, createdAt: 'now' }],
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(onAssetsChanged).toHaveBeenCalledWith([otherAsset], otherAsset.id));
    expect(approve).toHaveBeenCalledTimes(2);
  });
});
