import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AssetInfo,
  ProviderModelInfo,
  ProviderProfileInfo,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import {
  cancelVideoProviderTask,
  downloadVideoProviderTask,
  pollVideoProviderTask,
  submitProviderRequest,
  submitVideoProviderTask,
} from './provider-client';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./provider-client', () => ({
  submitProviderRequest: vi.fn(),
  submitVideoProviderTask: vi.fn(),
  pollVideoProviderTask: vi.fn(),
  cancelVideoProviderTask: vi.fn(),
  downloadVideoProviderTask: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
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
): void {
  vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
    if (method === 'provider.profile.list') return Promise.resolve([providerProfile]);
    if (method === 'provider.model.list') return Promise.resolve(providerModels);
    return implementation(method, params);
  }) as typeof callWorker);
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

const savedAsset: AssetInfo = {
  id: 'asset-generated',
  projectId: 'project',
  kind: 'generated-image',
  relativePath: 'assets/images/generated.png',
  contentHash: 'hash',
  sizeBytes: 8192,
  createdAt: '2026-08-02T00:00:00.000Z',
};

describe('ProductionPanel', () => {
  beforeEach(() => {
    cleanup();
    vi.resetAllMocks();
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
      key: 'TEXT_TO_IMAGE:unicompapi:qwen-image:v1',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      model: 'qwen-image',
      modelLabel: 'qwen-image',
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
    expect(await screen.findByRole('option', { name: 'qwen-image' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Vidu Q2' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('adapter.resolve', {
        capability: 'TEXT_TO_IMAGE',
        provider: 'unicompapi',
        model: 'qwen-image',
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
      key: 'TEXT_TO_IMAGE:unicompapi:qwen-image:v1',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      model: 'qwen-image',
      modelLabel: 'qwen-image',
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

    fireEvent.change(model, { target: { value: v3.key } });

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('adapter.resolve', {
        capability: v3.capability,
        provider: v3.provider,
        model: v3.model,
        apiVersion: 'v3',
      }),
    );
    expect(model).toHaveValue(v3.key);
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
    vi.mocked(submitProviderRequest).mockResolvedValueOnce({
      status: 200,
      body: { images: [{ url: 'https://example.test/generated.png' }] },
    });
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'running',
          request: (params as { parameters: Record<string, unknown> }).parameters,
          results: [],
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        });
      }
      if (method === 'image.generate.complete') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'succeeded',
          request: { prompt: '电影画面', resolution: '1080p' },
          results: [
            {
              id: 'result',
              jobId: 'job',
              asset: savedAsset,
              createdAt: '2026-08-02T00:00:01.000Z',
            },
          ],
          preview: {
            jobId: 'job',
            assetId: savedAsset.id,
            dataUrl: 'data:image/png;base64,generated',
            contentType: 'image/png',
          },
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:01.000Z',
        });
      }
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
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'image.generate.complete',
        expect.objectContaining({ jobId: 'job', assetKind: 'generated-image' }),
      ),
    );
    expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
    expect((await screen.findAllByText(savedAsset.relativePath)).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: savedAsset.relativePath })).toHaveAttribute(
      'src',
      'data:image/png;base64,asset',
    );
    expect(onAssetsChanged).toHaveBeenCalledWith([savedAsset], savedAsset.id);

    fireEvent.click(screen.getAllByRole('button', { name: '打开位置' })[0]!);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('asset.reveal', { assetId: savedAsset.id }),
    );
    fireEvent.click(screen.getByRole('button', { name: '查看素材库' }));
    expect(onOpenAssetLibrary).toHaveBeenCalledWith(savedAsset.id);
  });

  it('selects the automatically saved result after clearing a previously selected asset', async () => {
    const priorAsset: AssetInfo = {
      ...savedAsset,
      id: 'asset-prior',
      relativePath: 'assets/images/prior.png',
    };
    vi.mocked(submitProviderRequest).mockResolvedValueOnce({
      status: 200,
      body: { images: [{ url: 'https://example.test/generated.png' }] },
    });
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'running',
          request: (params as { parameters: Record<string, unknown> }).parameters,
          results: [],
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        });
      }
      if (method === 'image.generate.complete') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'succeeded',
          request: { prompt: '电影画面', resolution: '1080p' },
          results: [
            {
              id: 'result',
              jobId: 'job',
              asset: savedAsset,
              createdAt: '2026-08-02T00:00:01.000Z',
            },
          ],
          preview: {
            jobId: 'job',
            assetId: savedAsset.id,
            dataUrl: 'data:image/png;base64,asset',
            contentType: 'image/png',
          },
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:01.000Z',
        });
      }
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

    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '生成图片预览' })).toHaveAttribute(
      'src',
      'data:image/png;base64,asset',
    );
    expect(screen.queryByRole('button', { name: '保存到素材库' })).not.toBeInTheDocument();
  });

  it('explains why draft save is blocked when no shot is selected', async () => {
    render(<ProductionPanel writable />);
    fireEvent.click(await screen.findByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('请先在左侧选择镜头后再保存草稿。')).toBeInTheDocument();
  });

  it('always saves generated images to the local asset library', async () => {
    vi.mocked(submitProviderRequest).mockResolvedValueOnce({
      status: 200,
      body: { images: [{ url: 'https://example.test/generated.png' }] },
    });
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'running',
          request: (params as { parameters: Record<string, unknown> }).parameters,
          results: [],
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        });
      }
      if (method === 'image.generate.complete') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'succeeded',
          request: { prompt: '电影画面', resolution: '1080p' },
          results: [
            {
              id: 'result',
              jobId: 'job',
              asset: savedAsset,
              createdAt: '2026-08-02T00:00:01.000Z',
            },
          ],
          preview: {
            jobId: 'job',
            assetId: savedAsset.id,
            dataUrl: 'data:image/png;base64,asset',
            contentType: 'image/png',
          },
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:01.000Z',
        });
      }
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
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'image.generate.complete',
        expect.objectContaining({ jobId: 'job' }),
      ),
    );
    expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: savedAsset.relativePath })).toHaveAttribute(
      'src',
      'data:image/png;base64,asset',
    );
    expect(screen.getAllByText(savedAsset.relativePath).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(savedAsset.relativePath)).length).toBeGreaterThan(0);
  });

  it('terminalizes a prepared job when the native provider transport fails', async () => {
    vi.mocked(submitProviderRequest).mockRejectedValueOnce('Provider credential is not configured');
    mockWorker((method, params) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'image.generate.prepare') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'running',
          request: (params as { parameters: Record<string, unknown> }).parameters,
          results: [],
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        });
      }
      if (method === 'image.generate.fail') {
        return Promise.resolve({
          id: 'job',
          shotId: 'shot',
          adapterKey: descriptor.key,
          status: 'failed',
          request: { prompt: '电影画面', resolution: '1080p' },
          results: [],
          error: 'Provider transport failed before completion.',
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:01.000Z',
        });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel shotId="shot" writable />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '电影画面' },
    });

    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    expect(await screen.findByText('Provider credential is not configured')).toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('image.generate.fail', { jobId: 'job' });
    expect(screen.queryByTitle('取消生成')).not.toBeInTheDocument();
  });

  it('submits a video task once and persists its provider task association', async () => {
    vi.mocked(submitVideoProviderTask).mockResolvedValue({
      status: 200,
      taskId: 'provider-task',
      state: 'created',
    });
    vi.mocked(pollVideoProviderTask).mockReturnValue(new Promise(() => undefined));
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
      if (method === 'video.generate.attachTask') return Promise.resolve(videoJob('polling'));
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    fireEvent.change(await screen.findByLabelText('首帧 URL'), {
      target: { value: 'https://example.invalid/start.png' },
    });
    fireEvent.change(screen.getByLabelText('尾帧 URL'), {
      target: { value: 'https://example.invalid/end.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));

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
    expect(submitVideoProviderTask).toHaveBeenCalledWith(
      videoDescriptor.key,
      expect.objectContaining({
        images: ['https://example.invalid/start.png', 'https://example.invalid/end.png'],
      }),
      providerProfile.id,
      'cn',
    );
    expect(submitVideoProviderTask).toHaveBeenCalledTimes(1);
    expect(callWorker).toHaveBeenCalledWith('video.generate.attachTask', {
      jobId: 'video-job',
      providerTaskId: 'provider-task',
    });
    expect(await screen.findByText('视频任务已提交，正在本地查询。')).toBeInTheDocument();
  });

  it('stores dropped asset references in the draft and resolves them for submission', async () => {
    vi.mocked(submitVideoProviderTask).mockResolvedValue({
      status: 200,
      taskId: 'provider-task',
      state: 'created',
    });
    vi.mocked(pollVideoProviderTask).mockReturnValue(new Promise(() => undefined));
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
      if (method === 'video.generate.attachTask') return Promise.resolve(videoJob('polling'));
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
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => {
      const saveCall = vi
        .mocked(callWorker)
        .mock.calls.find(([method]) => method === 'generation.draft.save');
      expect(saveCall?.[1]).toMatchObject({
        parameters: { images: ['asset://asset-start', 'asset://asset-end'] },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(submitVideoProviderTask).toHaveBeenCalledWith(
        videoDescriptor.key,
        expect.objectContaining({
          images: ['data:image/png;base64,asset-start', 'data:image/png;base64,asset-end'],
        }),
        providerProfile.id,
        'cn',
      ),
    );
  });

  it('selects ordered local start and end frames and submits Data URLs once', async () => {
    vi.mocked(submitVideoProviderTask).mockResolvedValue({
      status: 200,
      taskId: 'provider-task',
      state: 'created',
    });
    vi.mocked(pollVideoProviderTask).mockReturnValue(new Promise(() => undefined));
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'video.generate.prepare') return Promise.resolve(videoJob('pending'));
      if (method === 'video.generate.attachTask') return Promise.resolve(videoJob('polling'));
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

    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));

    await waitFor(() => expect(submitVideoProviderTask).toHaveBeenCalledTimes(1));
    expect(submitVideoProviderTask).toHaveBeenCalledWith(
      videoDescriptor.key,
      expect.objectContaining({
        images: [
          expect.stringMatching(/^data:image\/png;base64,/),
          expect.stringMatching(/^data:image\/jpeg;base64,/),
        ],
      }),
      providerProfile.id,
      'cn',
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
    vi.mocked(pollVideoProviderTask).mockReturnValue(new Promise(() => undefined));
    vi.mocked(cancelVideoProviderTask).mockRejectedValue(new Error('offline'));
    mockWorker((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(videoCatalog);
      if (method === 'adapter.resolve') return Promise.resolve(videoDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([polling]);
      if (method === 'video.generate.cancel') {
        return Promise.resolve({ ...polling, status: 'cancelled' as const });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    expect(await screen.findByText('生成中')).toBeInTheDocument();
    await waitFor(() =>
      expect(pollVideoProviderTask).toHaveBeenCalledWith(
        videoDescriptor.key,
        providerProfile.id,
        'provider-task',
        'cn',
      ),
    );
    expect(submitVideoProviderTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));

    expect(await screen.findByText('视频任务已取消，本地轮询已停止。')).toBeInTheDocument();
    expect(cancelVideoProviderTask).toHaveBeenCalledWith(
      videoDescriptor.key,
      providerProfile.id,
      'provider-task',
      'cn',
    );
  });

  it('downloads completed UniCompAPI video content through the native credential bridge', async () => {
    const unicompProfile: ProviderProfileInfo = {
      ...providerProfile,
      id: '11111111-1111-4111-8111-111111111113',
      name: 'UniCompAPI A',
      providerType: 'unicompapi',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    };
    const unicompDescriptor: AdapterDescriptor = {
      ...videoDescriptor,
      key: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
      capability: 'TEXT_TO_VIDEO',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      model: 'kling-v3-turbo',
      modelLabel: 'kling-v3-turbo',
      apiVersion: 'v1',
      endpoint: 'https://unicompapi.com/v1/videos',
      credentialProvider: 'unicompapi',
    };
    const unicompModel: ProviderModelInfo = {
      ...providerModels[2]!,
      id: '31111111-1111-4111-8111-111111111113',
      providerProfileId: unicompProfile.id,
      remoteModelId: 'kling-v3-turbo',
      displayName: 'Kling v3 Turbo',
    };
    const polling: VideoGenerationJobInfo = {
      ...videoJob('polling'),
      adapterKey: unicompDescriptor.key,
      metadata: {
        ...videoJob('polling').metadata,
        providerRegion: 'unicompapi',
        providerProfileId: unicompProfile.id,
        modelId: 'kling-v3-turbo',
      },
    };
    vi.mocked(pollVideoProviderTask).mockResolvedValue({
      status: 200,
      body: { id: 'provider-task', status: 'completed' },
    });
    vi.mocked(downloadVideoProviderTask).mockResolvedValue({
      path: 'C:\\Temp\\ai-video-workspace-unicompapi\\video.mp4',
      contentType: 'video/mp4',
    });
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'adapter.catalog') {
        return Promise.resolve({
          capabilities: [{ key: 'TEXT_TO_VIDEO', label: '文生视频' }],
          providers: [{ key: 'unicompapi', label: 'UniCompAPI' }],
          adapters: [unicompDescriptor],
        });
      }
      if (method === 'provider.profile.list') return Promise.resolve([unicompProfile]);
      if (method === 'provider.model.list') return Promise.resolve([unicompModel]);
      if (method === 'adapter.resolve') return Promise.resolve(unicompDescriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([polling]);
      if (method === 'video.generate.observe') {
        return Promise.resolve({
          ...polling,
          status: 'failed' as const,
          error: 'fixture terminal',
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);

    await waitFor(() =>
      expect(downloadVideoProviderTask).toHaveBeenCalledWith(
        unicompDescriptor.key,
        unicompProfile.id,
        'provider-task',
        'unicompapi',
      ),
    );
    expect(callWorker).toHaveBeenCalledWith('video.generate.observe', {
      jobId: polling.id,
      providerTaskId: 'provider-task',
      providerStatus: 200,
      providerBody: {
        status: 'completed',
        data: { id: 'provider-task', status: 'completed' },
        nativeVideoFilePath: 'C:\\Temp\\ai-video-workspace-unicompapi\\video.mp4',
        contentType: 'video/mp4',
      },
    });
  });
});
