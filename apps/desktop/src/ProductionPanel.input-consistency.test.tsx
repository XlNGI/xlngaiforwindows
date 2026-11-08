import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
  GenerationCapability,
  ProductionCompileResult,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));

function adapter(capability: GenerationCapability): AdapterDescriptor {
  return {
    key: `${capability}:vidu:viduq2:v2`,
    capability,
    capabilityLabel: capability,
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq2',
    modelLabel: 'Vidu Q2',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://example.test',
    documentationUrl: 'https://example.test',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['prompt'],
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', title: '画面提示词' },
        images: { type: 'array', title: '输入图片', items: { type: 'string' }, maxItems: 1 },
        n: { type: 'integer', title: '数量', default: 4 },
      },
    },
    uiSchema: {
      fields: [
        { key: 'prompt', control: 'textarea', group: 'basic', order: 1 },
        { key: 'images', control: 'url-list', group: 'basic', order: 2 },
        { key: 'n', control: 'number', group: 'basic', order: 3 },
      ],
    },
  };
}

function mockAdapters(
  resolve = (capability: GenerationCapability) => Promise.resolve(adapter(capability)),
  compile?: Promise<ProductionCompileResult>,
) {
  vi.mocked(callWorker).mockImplementation((async (
    method: string,
    params: Record<string, unknown>,
  ) => {
    if (method === 'adapter.catalog')
      return {
        capabilities: [
          { key: 'TEXT_TO_IMAGE', label: '文生图' },
          { key: 'IMAGE_TO_VIDEO', label: '图生视频' },
        ],
        providers: [{ key: 'vidu', label: 'Vidu' }],
        adapters: [adapter('TEXT_TO_IMAGE'), adapter('IMAGE_TO_VIDEO')],
      };
    if (method === 'provider.profile.list')
      return [
        {
          id: 'profile',
          name: 'Vidu',
          providerType: 'vidu',
          accessType: 'official',
          category: 'multi',
          protocol: 'vidu-v2',
          enabled: true,
          connectionStatus: 'ready',
          baseUrl: 'https://api.vidu.cn',
        },
      ];
    if (method === 'provider.model.list')
      return [
        {
          id: 'model',
          remoteModelId: 'viduq2',
          displayName: 'Vidu Q2',
          enabled: true,
          capabilities: { imageGeneration: true, videoGeneration: true },
        },
      ];
    if (method === 'adapter.resolve') return resolve(params.capability as GenerationCapability);
    if (method === 'asset.mediaSource' || method === 'asset.thumbnail')
      return { assetId: params.assetId, path: 'D:/image.png', contentType: 'image/png' };
    if (method === 'video.generate.list') return [];
    if (method === 'generation.draft.get') return null;
    if (method === 'production.compile' || method === 'production.read')
      return compile ?? { target: params.target, rowVersion: 1, parameters: { n: 4 }, issues: [] };
    throw new Error(`Unexpected ${method}`);
  }) as typeof callWorker);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it('seeds scene count to one and preserves a subsequent manual count edit', async () => {
  mockAdapters();
  const props = {
    writable: true,
    projectId: 'project',
    sourceDocumentId: 'scene-doc',
    preferredAssetKind: 'scene' as const,
    seedPrompt: '场景全景与特写',
    seedImageBindings: [],
  };
  const view = render(<ProductionPanel {...props} />);
  const count = await screen.findByLabelText(/数量/);
  expect(count).toHaveValue(1);
  fireEvent.change(count, { target: { value: '2' } });
  view.rerender(<ProductionPanel {...props} expanded />);
  expect(screen.getByLabelText(/数量/)).toHaveValue(2);
});

it('shows rejected frame filling and lets a manual image correction recover without submitting', async () => {
  mockAdapters();
  render(
    <ProductionPanel
      writable
      capability="IMAGE_TO_VIDEO"
      seedEventKey={{}}
      seedPrompt="镜头运动"
      seedImageBindings={[{ assetId: 'scene', role: 'scene' }]}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('角色与场景参考图不能自动当作首帧');
  expect(screen.getByRole('button', { name: '提交视频任务' })).toBeDisabled();
  expect(screen.getByRole('region', { name: '提交前检查' })).toHaveTextContent(
    '角色与场景参考图不能自动当作首帧',
  );
  expect(screen.getByRole('button', { name: '提交视频任务' })).toHaveAccessibleDescription(
    /填充失败.*修正图片输入/,
  );
  fireEvent.change(screen.getByRole('textbox', { name: /输入图片/ }), {
    target: { value: 'https://example.test/frame.png' },
  });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: '提交视频任务' })).toBeEnabled();
  expect(screen.queryByRole('region', { name: '提交前检查' })).not.toBeInTheDocument();
  expect(callWorker).not.toHaveBeenCalledWith('video.generate.prepare', expect.anything());
});

it('waits for the new adapter before consuming a fill event during an image-to-video mode switch', async () => {
  let resolveVideo: (value: AdapterDescriptor) => void = () => {};
  const video = new Promise<AdapterDescriptor>((resolve) => {
    resolveVideo = resolve;
  });
  mockAdapters((capability) =>
    capability === 'IMAGE_TO_VIDEO' ? video : Promise.resolve(adapter(capability)),
  );
  const view = render(<ProductionPanel writable capability="TEXT_TO_IMAGE" seedPrompt="旧图片" />);
  await screen.findByRole('textbox', { name: /画面提示词/ });
  expect(screen.getByLabelText('当前制作模式')).toHaveTextContent('文生图');
  view.rerender(
    <ProductionPanel
      writable
      capability="IMAGE_TO_VIDEO"
      seedPrompt="新的首帧视频"
      seedEventKey={{}}
      seedImageBindings={[{ assetId: 'frame', role: 'first-frame' }]}
    />,
  );
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith(
      'adapter.resolve',
      expect.objectContaining({ capability: 'IMAGE_TO_VIDEO' }),
    ),
  );
  expect(screen.getByRole('textbox', { name: /画面提示词/ })).toHaveTextContent('旧图片');
  expect(screen.getByRole('button', { name: '生成图片' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '生成图片' })).toHaveAccessibleDescription(
    /正在准备模型表单/,
  );
  resolveVideo(adapter('IMAGE_TO_VIDEO'));
  await screen.findByRole('button', { name: '放大查看输入图片：素材库图片' });
  expect(screen.getByLabelText('当前制作模式')).toHaveTextContent('图生视频');
  expect(callWorker).toHaveBeenCalledWith(
    'asset.thumbnail',
    expect.objectContaining({ assetId: 'frame' }),
  );
  expect(screen.getByRole('textbox', { name: /画面提示词/ })).toHaveTextContent('新的首帧视频');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('explains pending compilation beside submit and recovers while draft saving stays available', async () => {
  let finishCompile: (result: ProductionCompileResult) => void = () => {};
  const compile = new Promise<ProductionCompileResult>((resolve) => {
    finishCompile = resolve;
  });
  mockAdapters(undefined, compile);
  render(<ProductionPanel writable projectId="project" shotId="shot" seedPrompt="镜头画面" />);
  await waitFor(() => expect(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled());
  const submit = screen.getByRole('button', { name: '生成图片' });
  await waitFor(() => expect(submit).toHaveAccessibleDescription(/正在读取制作内容/));
  expect(submit).toBeDisabled();
  expect(submit).toHaveAccessibleDescription(/正在读取制作内容/);
  expect(screen.getByRole('region', { name: '提交前检查' })).toHaveTextContent('正在读取制作内容');
  finishCompile({
    target: { kind: 'shot', id: 'shot' },
    rowVersion: 1,
    parameters: { prompt: '镜头画面' },
    issues: [],
  });
  await waitFor(() => expect(submit).toBeEnabled());
  expect(screen.queryByRole('region', { name: '提交前检查' })).not.toBeInTheDocument();
  expect(callWorker).not.toHaveBeenCalledWith('image.generate', expect.anything());
});
