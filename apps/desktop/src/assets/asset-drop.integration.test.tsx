import { useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdapterParameterValue, AssetInfo } from '@ai-video/contracts';
import { AssetLibraryView } from './AssetLibraryView';
import { ImageListParameterField } from '../ImageListParameterField';
import { StructuredParameterField } from '../StructuredParameterField';
import { ChatPanel } from '../ChatPanel';
import { ReferenceCard } from '../ReferenceCard';
import { callWorker } from '../worker-client';
import { forgetWorkerScope, selectWorkerScope } from '../worker-scope';

vi.mock('../worker-client', () => ({ callWorker: vi.fn() }));
const scope = { projectId: 'project', projectSessionId: 'epoch' };
const assets: AssetInfo[] = ['new', 'old', 'video'].map((id, index) => ({
  id,
  projectId: 'project',
  alias: id,
  kind: id === 'video' ? 'scene-video' : 'scene',
  relativePath: `assets/${id}.${id === 'video' ? 'mp4' : 'png'}`,
  contentHash: id,
  sizeBytes: 10,
  createdAt: `2026-10-0${index === 0 ? 2 : 1}T00:00:00Z`,
}));
const chatProps: ComponentProps<typeof ChatPanel> = {
  scopeType: 'project',
  scopeAvailable: true,
  writable: true,
  conversations: [],
  conversation: {
    id: 'chat',
    projectId: 'project',
    scopeType: 'project',
    title: '会话',
    createdAt: '',
    updatedAt: '',
  },
  messages: [],
  composer: '保留这些文字',
  statusMessage: '',
  legacyLlmConfigured: false,
  llmProfiles: [],
  llmModels: [],
  selectedLlmProfileId: '',
  selectedLlmModelId: '',
  onSelectConversation: vi.fn(),
  onCreateConversation: vi.fn(),
  onRetryGeneration: vi.fn(),
  onLlmProfileChange: vi.fn(),
  onLlmModelChange: vi.fn(),
  onOpenProviderSettings: vi.fn(),
  onComposerChange: vi.fn(),
  onCancelGeneration: vi.fn(),
  onSendMessage: vi.fn(),
};
const mediaSchema = {
  type: 'array',
  maxItems: 3,
  items: {
    oneOf: [
      {
        type: 'object',
        properties: {
          type: { const: 'image_url' },
          image_url: { type: 'object', properties: { url: { type: 'string' } } },
          role: { type: 'string', enum: ['reference_image', 'first_frame'] },
        },
      },
      {
        type: 'object',
        properties: {
          type: { const: 'video_url' },
          video_url: { type: 'object', properties: { url: { type: 'string' } } },
        },
      },
    ],
  },
};
function Fixture({
  onChat = vi.fn(),
  readonly = false,
}: {
  onChat?: (raw: string) => void;
  readonly?: boolean;
}) {
  const [images, setImages] = useState<AdapterParameterValue>(['keep', 'replace']);
  const [media, setMedia] = useState<AdapterParameterValue>([]);
  return (
    <>
      <AssetLibraryView writable />
      <ImageListParameterField
        field={{ key: 'images' }}
        property={{ type: 'array', title: '参考图', maxItems: 3 }}
        value={images}
        onChange={(next) => setImages(next ?? [])}
        projectId="project"
        inputId="images"
        label={<label htmlFor="images">参考图</label>}
        description={null}
      />
      <StructuredParameterField
        schema={mediaSchema}
        value={media}
        onChange={(next) => setMedia(next ?? [])}
        label="媒体"
        projectId="project"
      />
      <ReferenceCard
        label="首帧"
        projectId="project"
        writable={!readonly}
        onDropAsset={(asset) => setImages([`reference://${asset.id}`])}
        selector={null}
      />
      <ChatPanel {...chatProps} writable={!readonly} onAddAssetAttachments={onChat} />
      <output data-testid="images">{JSON.stringify(images)}</output>
      <output data-testid="media">{JSON.stringify(media)}</output>
    </>
  );
}
let hit: Element | null;
beforeEach(() => {
  vi.clearAllMocks();
  selectWorkerScope(scope);
  hit = null;
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => hit),
  });
  vi.mocked(callWorker).mockImplementation((method, params) => {
    if (method === 'asset.list') return Promise.resolve(assets);
    if (method === 'scene.media.resolve')
      return Promise.resolve({ assets, voices: [], characters: [] });
    if (method === 'asset.mediaSource' || method === 'asset.thumbnail') {
      const id = (params as { assetId: string }).assetId;
      return Promise.resolve({
        assetId: id,
        path: `/assets/${id}.png`,
        contentType: id === 'video' ? 'video/mp4' : 'image/png',
      });
    }
    return Promise.resolve([]);
  });
});
afterEach(() => {
  cleanup();
  forgetWorkerScope('project');
  selectWorkerScope(undefined);
  vi.restoreAllMocks();
});
async function card(name: string) {
  return within(await screen.findByRole('listbox', { name: '素材' })).findByRole('option', {
    name,
  });
}
function move(source: Element, target: Element) {
  hit = target;
  fireEvent.pointerDown(source, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(source, { pointerId: 1, clientX: 200, clientY: 100 });
}
function release(source: Element) {
  fireEvent.pointerUp(source, { pointerId: 1, clientX: 200, clientY: 100 });
}

it('drags images into an individual form row and a reference card without losing other inputs', async () => {
  render(<Fixture />);
  const source = await card('new');
  const target = screen.getByDisplayValue('replace');
  move(source, target);
  expect(target.closest('.asset-drop-target')).toHaveClass('is-asset-drag-over');
  release(source);
  await waitFor(() =>
    expect(screen.getByTestId('images')).toHaveTextContent('["keep","asset://new"]'),
  );
  expect(callWorker).toHaveBeenCalledWith('asset.mediaSource', { assetId: 'new' }, scope);
  move(source, screen.getByLabelText('首帧卡片'));
  release(source);
  await waitFor(() =>
    expect(screen.getByTestId('images')).toHaveTextContent('["reference://new"]'),
  );
});

it('drags selected media chronologically into a structured list and replaces only the hovered media slot', async () => {
  render(<Fixture />);
  const newer = await card('new');
  const older = await card('old');
  for (const source of [newer, older]) {
    const toggle = within(source).getByRole('button', { name: /^(选择|取消选择)$/ });
    if (toggle.getAttribute('aria-pressed') !== 'true') fireEvent.click(toggle);
  }
  move(newer, screen.getByLabelText('媒体'));
  release(newer);
  await waitFor(() =>
    expect(JSON.parse(screen.getByTestId('media').textContent)).toEqual([
      { type: 'image_url', image_url: { url: 'asset://old' } },
      { type: 'image_url', image_url: { url: 'asset://new' } },
    ]),
  );
  const video = await card('video');
  move(video, screen.getByLabelText('媒体'));
  release(video);
  await waitFor(() =>
    expect(screen.getByTestId('media')).toHaveTextContent('"video_url":{"url":"asset://video"}'),
  );
  // Native text/plain fallback targets the inner slot, rather than appending to its parent list.
  const slot = screen.getByRole('group', { name: '媒体 1' });
  fireEvent.drop(slot, {
    dataTransfer: {
      getData: (type: string) =>
        type === 'text/plain'
          ? JSON.stringify({
              version: 1,
              projectId: 'project',
              assets: [{ id: 'new', kind: 'scene' }],
            })
          : '',
    },
  });
  await waitFor(() =>
    expect(
      (JSON.parse(screen.getByTestId('media').textContent) as AdapterParameterValue[])[0],
    ).toMatchObject({
      image_url: { url: 'asset://new' },
    }),
  );
  expect(JSON.parse(screen.getByTestId('media').textContent)).toHaveLength(3);
});

it('adds video to chat through pointer dragging, preserves text and cancels Escape or occluded drops', async () => {
  const onChat = vi.fn<(raw: string) => void>();
  render(<Fixture onChat={onChat} />);
  const source = await card('video');
  const target = screen.getByLabelText('会话消息');
  move(source, target);
  expect(target.closest('.composer')).toHaveClass('is-asset-drag-over');
  fireEvent.keyDown(document, { key: 'Escape' });
  release(source);
  expect(onChat).not.toHaveBeenCalled();
  move(source, target);
  hit = document.body; // A floating panel or modal covers the target.
  release(source);
  expect(onChat).not.toHaveBeenCalled();
  move(source, target);
  release(source);
  expect(JSON.parse(onChat.mock.calls[0]![0])).toMatchObject({ assets: [{ id: 'video' }] });
  expect(target).toHaveValue('保留这些文字');
  expect(chatProps.onSendMessage).not.toHaveBeenCalled();
});

it('rejects video, cross-project and unavailable files and leaves the existing form intact', async () => {
  render(<Fixture />);
  const source = await card('video');
  const target = screen.getByLabelText('参考图');
  move(source, target);
  release(source);
  expect(await screen.findByText('此参数只接受图片素材。')).toBeInTheDocument();
  const raw = (projectId: string) =>
    JSON.stringify({ version: 1, projectId, assets: [{ id: 'missing', kind: 'scene' }] });
  fireEvent.drop(target, { dataTransfer: { getData: () => raw('other') } });
  expect(await screen.findByText('只能拖入当前项目的素材。')).toBeInTheDocument();
  vi.mocked(callWorker).mockRejectedValue(new Error('素材文件不可用'));
  fireEvent.drop(target, { dataTransfer: { getData: () => raw('project') } });
  expect(await screen.findByText('素材文件不可用')).toBeInTheDocument();
  expect(screen.getByTestId('images')).toHaveTextContent('["keep","replace"]');
});

it('does not accept library drops into archived or read-only chat and reference cards', async () => {
  const onChat = vi.fn();
  render(<Fixture readonly onChat={onChat} />);
  const source = await card('new');
  move(source, screen.getByLabelText('会话消息'));
  release(source);
  move(source, screen.getByLabelText('首帧卡片'));
  release(source);
  expect(onChat).not.toHaveBeenCalled();
  expect(screen.getByTestId('images')).toHaveTextContent('["keep","replace"]');
});

it('drags an entire asset group through the same pointer transport as individual files', async () => {
  const baseline = vi.mocked(callWorker).getMockImplementation()!;
  vi.mocked(callWorker).mockImplementation((method, params) => {
    if (method === 'assetGroup.list')
      return Promise.resolve([
        {
          id: 'group',
          projectId: 'project',
          name: '镜头组',
          tagIds: [],
          createdBy: 'user',
          assetIds: ['new', 'old'],
          assetCount: 2,
          createdAt: '',
          updatedAt: '',
        },
      ]);
    if (method === 'assetGroup.resolve') return Promise.resolve(assets.slice(0, 2));
    return baseline(method, params);
  });
  const onChat = vi.fn<(raw: string) => void>();
  render(<Fixture onChat={onChat} />);
  await card('new');
  fireEvent.click(screen.getByText('筛选'));
  const source = (await screen.findByRole('button', { name: '镜头组 2' })).closest(
    '.asset-filter-option',
  )!;
  move(source, screen.getByLabelText('会话消息'));
  release(source);
  expect(JSON.parse(onChat.mock.calls[0]![0])).toMatchObject({
    sourceType: 'asset-group',
    sourceId: 'group',
    assets: [{ id: 'old' }, { id: 'new' }],
  });
});
