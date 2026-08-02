import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterCatalogResult, AdapterDescriptor, AssetInfo } from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { submitProviderRequest } from './provider-client';
import { callWorker } from './worker-client';
import { canUseSecureCredentials, getCredentialStatus } from './credential-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./provider-client', () => ({ submitProviderRequest: vi.fn() }));
vi.mock('./credential-client', () => ({
  canUseSecureCredentials: vi.fn(() => false),
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
    vi.mocked(canUseSecureCredentials).mockReturnValue(false);
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
      throw new Error(`Unexpected method ${method}`);
    });
  });

  it('renders schema fields and saves a validated per-shot draft', async () => {
    render(<ProductionPanel shotId="shot" writable />);
    const prompt = await screen.findByLabelText(/画面提示词/);
    expect(screen.getByLabelText('Vidu 服务区域')).toHaveValue('cn');
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
    expect(screen.getByRole('option', { name: '普通素材' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '角色' })).toBeInTheDocument();
    expect(screen.getByLabelText('自动保存到本地素材库')).toBeChecked();
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

  it('does not create a generation job until the selected region credential is configured', async () => {
    vi.mocked(canUseSecureCredentials).mockReturnValue(true);
    vi.mocked(getCredentialStatus).mockResolvedValue({ provider: 'vidu-cn', configured: false });
    render(<ProductionPanel writable />);

    expect(await screen.findByText('未配置')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    await waitFor(() =>
      expect(screen.getByText(/Vidu 服务区域.*凭据|API Key/)).toBeInTheDocument(),
    );
    expect(callWorker).not.toHaveBeenCalledWith('image.generate.prepare', expect.anything());
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

  it('loads persisted assets when a project opens', async () => {
    vi.mocked(callWorker).mockImplementation((method) => {
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
    vi.mocked(callWorker).mockImplementation((method, params) => {
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
        expect.objectContaining({ jobId: 'job', assetKind: 'generated-image', saveAsset: true }),
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

  it('can generate a preview without saving to the local asset library', async () => {
    vi.mocked(submitProviderRequest).mockResolvedValueOnce({
      status: 200,
      body: { images: [{ url: 'https://example.test/generated.png' }] },
    });
    vi.mocked(callWorker).mockImplementation((method, params) => {
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
          results: [],
          preview: {
            jobId: 'job',
            dataUrl: 'data:image/png;base64,preview-only',
            contentType: 'image/png',
          },
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:01.000Z',
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    render(<ProductionPanel projectId="project" shotId="shot" writable assets={[]} />);
    fireEvent.change(await screen.findByLabelText(/画面提示词/), {
      target: { value: '电影画面' },
    });
    fireEvent.click(screen.getByLabelText('自动保存到本地素材库'));
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'image.generate.complete',
        expect.objectContaining({ jobId: 'job', saveAsset: false }),
      ),
    );
    expect(await screen.findByText('图片已生成，仅预览，未保存到素材库。')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '生成图片预览' })).toHaveAttribute(
      'src',
      'data:image/png;base64,preview-only',
    );
    expect(screen.queryByText(savedAsset.relativePath)).not.toBeInTheDocument();
  });

  it('terminalizes a prepared job when the native provider transport fails', async () => {
    vi.mocked(submitProviderRequest).mockRejectedValueOnce('Provider credential is not configured');
    vi.mocked(callWorker).mockImplementation((method, params) => {
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
});
