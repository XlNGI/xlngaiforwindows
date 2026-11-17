import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
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

it.each(['custom', 'openai'] as const)(
  'offers the enabled GPT image editing model and preserves reference order (%s)',
  async (provider) => {
    const profile: ProviderProfileInfo = {
      id: 'profile',
      name: 'gpt-image',
      category: 'llm',
      providerType: provider,
      accessType: provider === 'custom' ? 'custom' : 'official',
      protocol: 'openai-responses',
      baseUrl: provider === 'custom' ? 'https://images.example/v1' : 'https://api.openai.com/v1',
      enabled: true,
      connectionStatus: 'ready',
      createdAt: 'now',
      updatedAt: 'now',
    };
    const model: ProviderModelInfo = {
      id: 'editing',
      providerProfileId: profile.id,
      remoteModelId: 'gpt-image-2',
      displayName: 'gpt-image-2',
      enabled: true,
      source: 'remote',
      createdAt: 'now',
      updatedAt: 'now',
      capabilities: {
        text: false,
        vision: false,
        tools: false,
        streaming: false,
        reasoning: false,
        structuredOutput: false,
        embeddings: false,
        imageGeneration: true,
        imageEditing: true,
        videoGeneration: false,
      },
    };
    const adapter: AdapterDescriptor = {
      key: `REFERENCE_TO_IMAGE:${provider}:openai-images:v1`,
      capability: 'REFERENCE_TO_IMAGE',
      capabilityLabel: '参考生图',
      provider,
      providerLabel: provider,
      model: 'openai-images',
      modelLabel: 'Images API',
      apiVersion: 'v1',
      schemaVersion: 1,
      credentialProvider: provider,
      endpoint: 'https://api.openai.com/v1/images/edits',
      documentationUrl: 'https://developers.openai.com/api/reference/resources/images/methods/edit',
      parameterSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'images'],
        properties: {
          prompt: { type: 'string', title: '提示词' },
          images: {
            type: 'array',
            title: '参考图片',
            minItems: 1,
            maxItems: 16,
            items: { type: 'string', format: 'uri' },
          },
        },
      },
      uiSchema: {
        fields: [
          { key: 'prompt', control: 'textarea', group: 'basic', order: 10 },
          { key: 'images', control: 'url-list', group: 'basic', order: 15 },
        ],
      },
    };
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list')
        return Promise.resolve([
          model,
          { ...model, id: 'disabled', displayName: 'disabled GPT', enabled: false },
          {
            ...model,
            id: 'generation-only',
            displayName: 'generation-only GPT',
            capabilities: { ...model.capabilities, imageEditing: false },
          },
        ]);
      if (method === 'adapter.catalog')
        return Promise.resolve({
          capabilities: [{ key: 'REFERENCE_TO_IMAGE', label: '参考生图' }],
          providers: [{ key: provider, label: provider }],
          adapters: [adapter],
        });
      if (method === 'adapter.resolve') return Promise.resolve(adapter);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'generation.draft.save') return Promise.resolve(params);
      if (method === 'production.read' || method === 'production.compile')
        return Promise.resolve({
          target: params.target,
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'image.generate.prepare')
        return Promise.reject(new Error('stop before paid submission'));
      return Promise.resolve([]);
    }) as typeof callWorker);
    render(
      <ProductionPanel
        capability="REFERENCE_TO_IMAGE"
        shotId="shot"
        writable
        seedPrompt="保留蓝衣服，融合场景"
        seedImages={['https://example.com/actor.png', 'https://example.com/scene.png']}
      />,
    );
    expect(await screen.findByRole('option', { name: 'gpt-image-2' })).toBeInTheDocument();
    expect(screen.getByLabelText('供应商连接')).toHaveValue(profile.id);
    expect(screen.queryByRole('option', { name: 'disabled GPT' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'generation-only GPT' })).not.toBeInTheDocument();
    await screen.findByDisplayValue('https://example.com/actor.png');
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.find(([method]) => method === 'image.generate.prepare')?.[1],
      ).toMatchObject({
        adapterKey: adapter.key,
        providerProfileId: profile.id,
        modelId: model.remoteModelId,
        parameters: {
          images: ['https://example.com/actor.png', 'https://example.com/scene.png'],
        },
      }),
    );
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.confirmSubmission',
      expect.anything(),
    );
    await screen.findByText('stop before paid submission');
  },
);
