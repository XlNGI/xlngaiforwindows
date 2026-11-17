import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  GenerationCapability,
  ProviderModelCapabilities,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

const noCapabilities: ProviderModelCapabilities = {
  text: false,
  vision: false,
  tools: false,
  streaming: false,
  reasoning: false,
  structuredOutput: false,
  embeddings: false,
  imageGeneration: false,
  imageEditing: false,
  videoGeneration: false,
  speechSynthesis: false,
};
function profile(id: string, overrides: Partial<ProviderProfileInfo> = {}): ProviderProfileInfo {
  return {
    id,
    name: id,
    category: 'multi',
    providerType: 'custom',
    accessType: 'custom',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://example.com/v1',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}
function model(
  profileId: string,
  id: string,
  caps: Partial<ProviderModelCapabilities>,
  overrides: Partial<ProviderModelInfo> = {},
): ProviderModelInfo {
  return {
    id: `${profileId}-${id}`,
    providerProfileId: profileId,
    remoteModelId: id,
    displayName: id,
    capabilities: { ...noCapabilities, ...caps },
    enabled: true,
    source: 'manual',
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}
function adapter(
  capability: GenerationCapability,
  provider: string,
  modelId: string,
): AdapterDescriptor {
  return {
    key: `${capability}:${provider}:${modelId}:v1`,
    capability,
    capabilityLabel: capability,
    provider,
    providerLabel: provider,
    model: modelId,
    modelLabel: modelId,
    apiVersion: 'v1',
    schemaVersion: 1,
    credentialProvider: provider,
    endpoint: 'https://example.com/v1/generate',
    documentationUrl: 'https://example.com/docs',
    parameterSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: { prompt: { type: 'string', title: '提示词' } },
    },
    uiSchema: { fields: [{ key: 'prompt', control: 'textarea', group: 'basic', order: 10 }] },
  };
}
function setup() {
  const profiles = [
    profile('chat'),
    profile('gpt-images', { category: 'llm' }),
    profile('mixed'),
    profile('wan', {
      providerType: 'wan-video',
      accessType: 'official',
      protocol: 'dashscope-video',
      baseUrl: 'https://dashscope.aliyuncs.com',
    }),
    profile('speech', {
      providerType: 'minimax-speech',
      accessType: 'official',
      protocol: 'minimax-speech',
      baseUrl: 'https://api.minimax.cn',
    }),
    profile('disabled'),
    profile('unavailable'),
    profile('empty'),
    profile('no-adapter', {
      providerType: 'vidu',
      accessType: 'official',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.com',
    }),
    profile('not-ready', { connectionStatus: 'network-failed' }),
    profile('profile-disabled', { enabled: false }),
  ];
  const models: Record<string, ProviderModelInfo[]> = {
    chat: [
      model('chat', 'chat-with-vision', { text: true, vision: true, tools: true, streaming: true }),
    ],
    'gpt-images': [
      model('gpt-images', 'gpt-image-2', { imageGeneration: true, imageEditing: true }),
    ],
    mixed: [
      model('mixed', 'mixed-chat', { text: true, vision: true }),
      model('mixed', 'mixed-generate', { imageGeneration: true }),
      model('mixed', 'mixed-edit', { imageEditing: true }),
      model('mixed', 'mixed-video', { videoGeneration: true }),
    ],
    wan: [model('wan', 'wan-video-model', { videoGeneration: true })],
    speech: [model('speech', 'speech-model', { speechSynthesis: true })],
    disabled: [model('disabled', 'disabled-image', { imageGeneration: true }, { enabled: false })],
    unavailable: [
      model(
        'unavailable',
        'unavailable-image',
        { imageGeneration: true },
        { unavailableAt: 'yesterday' },
      ),
    ],
    empty: [],
    'no-adapter': [model('no-adapter', 'unbound-image', { imageGeneration: true })],
    'not-ready': [model('not-ready', 'not-ready-image', { imageGeneration: true })],
    'profile-disabled': [
      model('profile-disabled', 'profile-disabled-image', { imageGeneration: true }),
    ],
  };
  const adapters = [
    adapter('TEXT_TO_IMAGE', 'custom', 'openai-images'),
    adapter('REFERENCE_TO_IMAGE', 'custom', 'openai-images'),
    adapter('TEXT_TO_VIDEO', 'custom', 'openai-compatible-video'),
    adapter('TEXT_TO_VIDEO', 'wan-video', 'wan-video-model'),
    adapter('TEXT_TO_AUDIO', 'minimax-speech', 'speech-model'),
  ];
  const catalog: AdapterCatalogResult = {
    adapters,
    providers: [],
    capabilities: adapters.map((a) => ({ key: a.capability, label: a.capability })),
  };
  const listModels = vi.fn((id: string): Promise<ProviderModelInfo[]> =>
    Promise.resolve(models[id] ?? []),
  );
  vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
    if (method === 'adapter.catalog') return Promise.resolve(catalog);
    if (method === 'provider.profile.list') return Promise.resolve(profiles);
    if (method === 'provider.model.list') return listModels(params.profileId as string);
    if (method === 'adapter.resolve')
      return Promise.resolve(
        adapters.find(
          (a) =>
            a.capability === params.capability &&
            a.provider === params.provider &&
            a.model === params.model,
        ),
      );
    if (method === 'generation.draft.get') return Promise.resolve(null);
    return Promise.resolve([]);
  }) as typeof callWorker);
  const visibleConnections = () =>
    within(screen.getByLabelText('供应商连接'))
      .queryAllByRole<HTMLOptionElement>('option')
      .map((o) => o.value);
  return { profiles, models, adapters, listModels, visibleConnections };
}

describe('production connection capability selection', () => {
  it.each([
    ['TEXT_TO_IMAGE', ['gpt-images', 'mixed']],
    ['REFERENCE_TO_IMAGE', ['gpt-images', 'mixed']],
    ['TEXT_TO_VIDEO', ['mixed', 'wan']],
    ['TEXT_TO_AUDIO', ['speech']],
  ] as const)(
    'shows only connections with executable models for %s',
    async (capability, expected) => {
      const f = setup();
      render(<ProductionPanel capability={capability} writable />);
      await waitFor(() => expect(f.visibleConnections()).toEqual(expected));
      if (capability !== 'TEXT_TO_AUDIO')
        expect(screen.queryByRole('option', { name: /chat-with-vision/ })).not.toBeInTheDocument();
      if (capability === 'TEXT_TO_IMAGE' || capability === 'REFERENCE_TO_IMAGE') {
        expect(screen.getByLabelText('供应商连接')).toHaveValue('gpt-images');
        fireEvent.change(screen.getByLabelText('供应商连接'), { target: { value: 'mixed' } });
        expect(
          await screen.findByRole('option', {
            name: capability === 'TEXT_TO_IMAGE' ? 'mixed-generate' : 'mixed-edit',
          }),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole('option', {
            name: capability === 'TEXT_TO_IMAGE' ? 'mixed-edit' : 'mixed-generate',
          }),
        ).not.toBeInTheDocument();
        expect(screen.queryByRole('option', { name: 'mixed-video' })).not.toBeInTheDocument();
      }
      expect(callWorker).not.toHaveBeenCalledWith('image.generate.prepare', expect.anything());
    },
  );

  it('updates both selectors when the mode changes and skips stored ineligible connections', async () => {
    const f = setup();
    window.localStorage.setItem(
      'ai-video.production-provider-profiles',
      JSON.stringify({ TEXT_TO_IMAGE: 'chat' }),
    );
    const view = render(<ProductionPanel capability="TEXT_TO_IMAGE" writable />);
    await waitFor(() => expect(f.visibleConnections()).toEqual(['gpt-images', 'mixed']));
    view.rerender(<ProductionPanel capability="TEXT_TO_VIDEO" writable />);
    await waitFor(() => expect(f.visibleConnections()).toEqual(['mixed', 'wan']));
    expect(await screen.findByRole('option', { name: 'mixed-video' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'gpt-image-2' })).not.toBeInTheDocument();
    expect(f.listModels).toHaveBeenCalledTimes(f.profiles.length);
  });

  it('refreshes model capability changes, falls back to a compatible connection, then shows an empty state', async () => {
    const f = setup();
    const view = render(
      <ProductionPanel capability="TEXT_TO_IMAGE" writable providerSettingsRevision={0} />,
    );
    expect(await screen.findByRole('option', { name: 'gpt-image-2' })).toBeInTheDocument();
    f.models['gpt-images'] = f.models['gpt-images']!.map((m) => ({
      ...m,
      capabilities: { ...m.capabilities, imageGeneration: false },
    }));
    view.rerender(
      <ProductionPanel capability="TEXT_TO_IMAGE" writable providerSettingsRevision={1} />,
    );
    await waitFor(() => expect(f.visibleConnections()).toEqual(['mixed']));
    expect(await screen.findByRole('option', { name: 'mixed-generate' })).toBeInTheDocument();
    f.models.mixed = f.models.mixed!.map((m) => ({ ...m, enabled: false }));
    view.rerender(
      <ProductionPanel capability="TEXT_TO_IMAGE" writable providerSettingsRevision={2} />,
    );
    await waitFor(() => expect(f.visibleConnections()).toEqual(['']));
    expect(screen.getByRole('option', { name: '没有可用连接' })).toBeInTheDocument();
    expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
  });

  it('isolates failed model reads and ignores a late response from superseded settings', async () => {
    const f = setup();
    let finishOld!: (models: ProviderModelInfo[]) => void;
    f.listModels.mockImplementation((id) =>
      id === 'gpt-images'
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve(f.models[id] ?? []),
    );
    const view = render(
      <ProductionPanel capability="TEXT_TO_IMAGE" writable providerSettingsRevision={0} />,
    );
    await waitFor(() => expect(finishOld).toBeDefined());
    f.listModels.mockImplementation((id) =>
      id === 'gpt-images'
        ? Promise.reject(new Error('cannot read models'))
        : Promise.resolve(f.models[id] ?? []),
    );
    view.rerender(
      <ProductionPanel capability="TEXT_TO_IMAGE" writable providerSettingsRevision={1} />,
    );
    await waitFor(() => expect(f.visibleConnections()).toEqual(['mixed']));
    await act(async () => {
      finishOld(f.models['gpt-images']!);
      await Promise.resolve();
    });
    expect(f.visibleConnections()).toEqual(['mixed']);
    expect(screen.queryByRole('option', { name: 'gpt-image-2' })).not.toBeInTheDocument();
  });
});
