import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  officialImageContracts,
  type AdapterDescriptor,
  type ProviderProfileInfo,
  type ProviderModelInfo,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

it('renders current Qwen image reference inputs, keeps their order and limits the form to three images', async () => {
  const contract = officialImageContracts.find(
    (c) => c.officialModelName === 'qwen-image-3.0' && c.contractRevision === 2,
  )!;
  const adapter: AdapterDescriptor = {
    key: `REFERENCE_TO_IMAGE:unicompapi:${contract.contractId}:contract-2`,
    capability: 'REFERENCE_TO_IMAGE',
    capabilityLabel: '参考生图',
    provider: 'unicompapi',
    providerLabel: 'UniCompAPI',
    model: contract.contractId,
    modelLabel: contract.officialModelName,
    apiVersion: 'contract-2',
    schemaVersion: 2,
    endpoint: 'https://unicompapi.com/v1/images/generations',
    documentationUrl: contract.source.url,
    credentialProvider: 'unicompapi',
    contractId: contract.contractId,
    contractRevision: 2,
    parameterSchema: {
      ...structuredClone(contract.parameterSchema),
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      required: ['prompt', 'images'],
    } as AdapterDescriptor['parameterSchema'],
    uiSchema: { fields: [] },
  };
  const profile: ProviderProfileInfo = {
    id: 'profile',
    name: 'UniCompAPI',
    category: 'multi',
    providerType: 'unicompapi',
    accessType: 'official',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://unicompapi.com/v1',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: 'now',
    updatedAt: 'now',
  };
  const model: ProviderModelInfo = {
    id: 'qwen',
    providerProfileId: profile.id,
    remoteModelId: 'qwen-image-3.0',
    displayName: 'Qwen Image 3.0',
    capabilities: {
      text: false,
      vision: false,
      streaming: false,
      reasoning: false,
      tools: false,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: true,
      imageEditing: true,
      videoGeneration: false,
    },
    enabled: true,
    source: 'remote',
    contractId: contract.contractId,
    contractRevision: 2,
    contractStatus: 'enabled',
    createdAt: 'now',
    updatedAt: 'now',
  };
  vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
    if (method === 'provider.profile.list') return Promise.resolve([profile]);
    if (method === 'provider.model.list') return Promise.resolve([model]);
    if (method === 'adapter.catalog')
      return Promise.resolve({
        capabilities: [{ key: 'REFERENCE_TO_IMAGE', label: '参考生图' }],
        providers: [{ key: 'unicompapi', label: 'UniCompAPI' }],
        adapters: [adapter],
      });
    if (method === 'adapter.resolve') return Promise.resolve(adapter);
    if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
    if (method === 'production.compile' || method === 'production.read')
      return Promise.resolve({ target: params.target, rowVersion: 1, parameters: {}, issues: [] });
    if (method === 'generation.draft.get') return Promise.resolve(null);
    if (method === 'generation.draft.save') return Promise.resolve(params);
    if (
      method === 'video.generate.list' ||
      method === 'image.generate.list' ||
      method === 'asset.list'
    )
      return Promise.resolve([]);
    return Promise.reject(new Error('Unexpected method ' + method));
  }) as typeof callWorker);
  render(
    <ProductionPanel
      projectId="project"
      shotId="shot"
      writable
      capability="REFERENCE_TO_IMAGE"
      seedPrompt="保留人物，融合场景"
      seedImages={['https://example.com/actor.png', 'https://example.com/scene.png']}
    />,
  );
  await screen.findByDisplayValue('https://example.com/actor.png');
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  const inputs = screen.getAllByRole('textbox').filter((input) => input.tagName === 'INPUT');
  fireEvent.change(inputs[2]!, { target: { value: 'https://example.com/prop.png' } });
  expect(screen.queryByRole('button', { name: '添加图片' })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0]!);
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => {
    const saved = vi
      .mocked(callWorker)
      .mock.calls.find(([method]) => method === 'generation.draft.save')?.[1] as unknown;
    expect(saved).toMatchObject({
      adapterKey: adapter.key,
      parameters: {
        images: [
          'https://example.com/scene.png',
          'https://example.com/actor.png',
          'https://example.com/prop.png',
        ],
      },
    });
  });
});
