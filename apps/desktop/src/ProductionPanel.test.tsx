import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterCatalogResult, AdapterDescriptor } from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./credential-client', () => ({
  canUseSecureCredentials: () => false,
  getCredentialStatus: vi.fn(),
  setCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

const descriptor: AdapterDescriptor = {
  key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
  capability: 'TEXT_TO_IMAGE',
  capabilityLabel: '文生图',
  provider: 'vidu',
  providerLabel: 'Vidu',
  model: 'viduq2',
  modelLabel: 'Vidu Q2 Image',
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

describe('ProductionPanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(callWorker).mockImplementation((method) => {
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
      throw new Error(`Unexpected method ${method}`);
    });
  });

  it('renders schema fields and saves a validated per-shot draft', async () => {
    render(<ProductionPanel shotId="shot" writable />);
    const prompt = await screen.findByLabelText(/画面提示词/);
    expect(screen.getByLabelText('分辨率*')).toBeInTheDocument();
    expect(screen.getByText('专业参数')).toBeInTheDocument();

    fireEvent.change(prompt, { target: { value: '电影画面' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('generation.draft.save', {
        shotId: 'shot',
        adapterKey: descriptor.key,
        parameters: { prompt: '电影画面', resolution: '1080p' },
      }),
    );
    expect(await screen.findByText(/草稿已保存/)).toBeInTheDocument();
  });

  it('does not persist a draft when adapter validation fails', async () => {
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'adapter.resolve') return Promise.resolve(descriptor);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'adapter.validate') {
        return Promise.resolve({
          valid: false,
          errors: [{ path: 'prompt', message: 'must have required property prompt' }],
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel shotId="shot" writable />);
    fireEvent.click(await screen.findByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('1 项参数需要修正')).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('generation.draft.save', expect.anything());
  });

  it('uses the full adapter key and locks the API version during resolution', async () => {
    const v3 = { ...descriptor, key: 'TEXT_TO_IMAGE:vidu:viduq2:v3', apiVersion: 'v3' };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'adapter.catalog') {
        return Promise.resolve({ ...catalog, adapters: [descriptor, v3] });
      }
      if (method === 'adapter.resolve') {
        return Promise.resolve(
          (params as { apiVersion?: string }).apiVersion === 'v3' ? v3 : descriptor,
        );
      }
      if (method === 'generation.draft.get') return Promise.resolve(null);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<ProductionPanel shotId="shot" writable />);
    const model = await screen.findByLabelText('模型');

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
  });
});
