import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLibraryView } from './AssetLibraryView';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const callWorker = vi.fn();
vi.mock('../worker-client', () => ({
  callWorker: (...args: unknown[]): unknown => callWorker(...args) as unknown,
}));

async function selectableMedia() {
  const assets = [0, 1, 2, 3].map((index) => ({
    id: `media-${index}`,
    projectId: 'project',
    kind: index === 0 ? 'generated-image' : 'scene-video',
    alias: `素材 ${index}`,
    relativePath: `assets/${index}.${index === 0 ? 'png' : 'mp4'}`,
    contentHash: `hash-${index}`,
    sizeBytes: 100,
    createdAt: '2026-10-28T00:00:00Z',
  }));
  callWorker.mockImplementation((method: string, params: { assetId?: string }) => {
    if (method === 'asset.list') return Promise.resolve(assets);
    if (method === 'asset.mediaSource')
      return Promise.resolve({ assetId: params.assetId, path: '/fixture.mp4' });
    return Promise.resolve([]);
  });
  render(<AssetLibraryView writable />);
  const cards = await within(await screen.findByRole('listbox', { name: '素材' })).findAllByRole(
    'option',
  );
  await waitFor(() => expect(cards[3]!.querySelector('video')).toBeInTheDocument());
  const selected = () => cards.map((card) => card.getAttribute('aria-selected') === 'true');
  return { cards, selected };
}

describe('AssetLibraryView', () => {
  beforeEach(() => {
    cleanup();
    callWorker.mockReset();
    callWorker.mockResolvedValue([]);
  });

  it('sends selected videos to rough cut or directly exports an XML package', async () => {
    const video = {
      id: 'video',
      projectId: 'p',
      kind: 'scene-video',
      alias: '本集视频',
      relativePath: 'assets/video.mp4',
      contentHash: 'fixture',
      sizeBytes: 100,
      createdAt: '2026-10-28T00:00:00Z',
    };
    const job = {
      id: 'export',
      status: 'succeeded',
      format: 'xml',
      completedClips: 1,
      totalClips: 1,
      sequenceVersion: 0,
    };
    callWorker.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'asset.list'
          ? [video]
          : method.startsWith('roughCut.export.')
            ? job
            : method === 'asset.mediaSource'
              ? { path: '/video.mp4', assetId: 'video', contentType: 'video/mp4' }
              : [],
      ),
    );
    const add = vi.fn();
    render(<AssetLibraryView writable onAddToRoughCut={add} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '加入粗剪' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '加入粗剪' }));
    expect(add).toHaveBeenCalledWith(['video']);
    fireEvent.click(screen.getByRole('button', { name: '导出到剪辑软件' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('roughCut.export.assets', { assetIds: ['video'] }),
    );
    expect(await screen.findByText('XML 剪辑包 · 导出完成')).toBeInTheDocument();
  });

  it('opens all assets by default anpnd applies image and video presets', async () => {
    render(<AssetLibraryView writable />);
    expect(screen.queryByRole('navigation', { name: '素材库导航' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ deleted: 'active', kind: undefined }),
      ),
    );
    fireEvent.change(screen.getByRole('combobox', { name: '素材类型' }), {
      target: { value: 'image' },
    });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ kind: 'image' }),
      ),
    );
    fireEvent.change(screen.getByRole('combobox', { name: '素材类型' }), {
      target: { value: 'video' },
    });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ kind: 'video' }),
      ),
    );
  });

  it('removes the tag filter menu and searches assets by the entered keyword', async () => {
    const { container } = render(<AssetLibraryView writable />);
    expect(container.querySelectorAll('.asset-manager-menu')).toHaveLength(1);
    expect(container.querySelector('.asset-manager-menu summary')).toHaveTextContent('筛选');
    expect(
      container.querySelectorAll('.opt-filter-dropdown input[aria-label="起始日期"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('.opt-filter-dropdown input[aria-label="结束日期"]'),
    ).toHaveLength(1);
    expect(container.querySelectorAll('input[aria-label="起始日期"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[aria-label="结束日期"]')).toHaveLength(1);
    expect(screen.getByPlaceholderText('搜索别名、文件名或标签')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'Hero' } });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ keyword: 'Hero', tagIds: [] }),
      ),
    );
  });

  it('focuses an asset from another pane even when the library is already filtered', async () => {
    const asset = {
      id: 'focused-image',
      projectId: 'project',
      kind: 'generated-image',
      alias: '指定镜头图片',
      relativePath: 'assets/image.png',
      contentHash: 'image',
      sizeBytes: 10,
      createdAt: '2026-10-13T00:00:00.000Z',
      tags: [],
    };
    callWorker.mockImplementation(
      (method: string, params: { keyword?: string; kind?: string; deleted?: string }) => {
        if (method === 'asset.list')
          return Promise.resolve(
            params.keyword || params.kind === 'video' || params.deleted === 'trash' ? [] : [asset],
          );
        if (method === 'asset.mediaSource') return Promise.reject(new Error('no preview'));
        return Promise.resolve([]);
      },
    );
    const { rerender } = render(<AssetLibraryView writable selectedAssetId={asset.id} />);
    await screen.findByDisplayValue(asset.alias);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '另一个素材' } });
    fireEvent.change(screen.getByLabelText('素材类型'), { target: { value: 'video' } });
    fireEvent.click(screen.getByLabelText('打开回收站'));
    await waitFor(() => expect(screen.queryByDisplayValue(asset.alias)).not.toBeInTheDocument());

    rerender(<AssetLibraryView writable selectedAssetId={asset.id} selectedAssetRevision={1} />);
    expect(screen.getByLabelText('搜索')).toHaveValue('');
    expect(screen.getByLabelText('素材类型')).toHaveValue('all');
    expect(screen.getByLabelText('打开回收站')).toBeInTheDocument();
    expect(await screen.findByDisplayValue(asset.alias)).toBeInTheDocument();
  });

  it('reloads all assets and selects a deep link outside the active asset group', async () => {
    const groupedAsset = {
      id: 'grouped-asset',
      projectId: 'project',
      kind: 'generated-image',
      alias: '组内角色',
      relativePath: 'assets/character.png',
      contentHash: 'character',
      sizeBytes: 10,
      createdAt: '2026-10-12T00:00:00.000Z',
      tags: [],
    };
    const outsideAsset = {
      ...groupedAsset,
      id: 'outside-asset',
      alias: '组外镜头',
      relativePath: 'assets/shot.png',
      contentHash: 'shot',
    };
    const group = {
      id: 'character-group',
      projectId: 'project',
      name: '角色组',
      assetIds: [groupedAsset.id],
      assetCount: 1,
      tagIds: [],
      createdBy: 'local-user',
      createdAt: 'now',
      updatedAt: 'now',
    };
    callWorker.mockImplementation((method: string) => {
      if (method === 'asset.list') return Promise.resolve([groupedAsset, outsideAsset]);
      if (method === 'assetGroup.list') return Promise.resolve([group]);
      if (method === 'assetGroup.resolve') return Promise.resolve([groupedAsset]);
      if (method === 'asset.mediaSource') return Promise.reject(new Error('No fixture media'));
      return Promise.resolve([]);
    });
    const { rerender } = render(
      <AssetLibraryView writable selectedAssetId={outsideAsset.id} selectedAssetRevision={1} />,
    );
    const grid = screen.getByRole('listbox', { name: '素材' });
    await within(grid).findByRole('option', { name: /组外镜头/ });
    fireEvent.click(screen.getByText('筛选'));
    fireEvent.click(await screen.findByRole('button', { name: /角色组/ }));
    await waitFor(() => expect(within(grid).getAllByRole('option')).toHaveLength(1));
    expect(within(grid).queryByRole('option', { name: /组外镜头/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('搜索')).toHaveValue('');
    expect(screen.getByLabelText('素材类型')).toHaveValue('all');
    const queriesBeforeDeepLink = callWorker.mock.calls.filter(
      ([method]) => method === 'asset.list',
    ).length;

    rerender(
      <AssetLibraryView writable selectedAssetId={outsideAsset.id} selectedAssetRevision={2} />,
    );

    expect(await within(grid).findByRole('option', { name: /组外镜头/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByLabelText('素材别名 (可检索)')).toHaveValue(outsideAsset.alias);
    expect(
      callWorker.mock.calls.filter(([method]) => method === 'asset.list').length,
    ).toBeGreaterThan(queriesBeforeDeepLink);
  });

  it('applies a tag to a ctrl selection', async () => {
    const assets = [
      {
        id: 'asset-1',
        projectId: 'project',
        kind: 'generated-image',
        relativePath: 'assets/1.png',
        contentHash: 'one',
        sizeBytes: 10,
        createdAt: '2026-08-01T00:00:00.000Z',
        tags: [],
      },
      {
        id: 'asset-2',
        projectId: 'project',
        kind: 'generated-image',
        relativePath: 'assets/2.png',
        contentHash: 'two',
        sizeBytes: 10,
        createdAt: '2026-08-02T00:00:00.000Z',
        tags: [],
      },
    ];
    const tag = {
      id: 'tag-1',
      projectId: 'project',
      name: 'Hero',
      createdBy: 'local-user',
      createdAt: 'now',
      updatedAt: 'now',
    };
    callWorker.mockImplementation((method: string) => {
      if (method === 'asset.list') return Promise.resolve(assets);
      if (method === 'tag.list') return Promise.resolve([tag]);
      if (method === 'asset.mediaSource')
        return Promise.reject(new Error('fixture image unavailable'));
      if (method === 'asset.tags.add') return Promise.resolve(assets);
      return Promise.resolve([]);
    });
    render(<AssetLibraryView writable />);
    const options = await within(
      await screen.findByRole('listbox', { name: '素材' }),
    ).findAllByRole('option');
    fireEvent.click(options[0]!);
    expect(screen.queryByText('批量操作')).not.toBeInTheDocument();
    fireEvent.click(options[1]!, { ctrlKey: true });
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();
    fireEvent.click(screen.getByText('批量操作'));
    fireEvent.change(screen.getByLabelText('批量标签'), { target: { value: tag.id } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('asset.tags.add', {
        assetIds: ['asset-1', 'asset-2'],
        tagIds: [tag.id],
      }),
    );

    fireEvent.click(screen.getByTitle('管理标签'));
    fireEvent.change(screen.getByLabelText('标签名称'), { target: { value: 'Portrait' } });
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('tag.create', { name: 'Portrait' }),
    );
  });

  it.each(['altKey', 'ctrlKey', 'metaKey'] as const)(
    'toggles video and image selection with %s on the thumbnail',
    async (modifier) => {
      const { cards, selected } = await selectableMedia();
      const video = cards[1]!.querySelector('video')!;
      expect(fireEvent.click(video, { [modifier]: true })).toBe(false);
      expect(selected()).toEqual([true, true, false, false]);
      fireEvent.click(video, { [modifier]: true });
      expect(selected()).toEqual([true, false, false, false]);
      fireEvent.click(cards[2]!.querySelector('video')!);
      expect(selected()).toEqual([false, false, true, false]);
      fireEvent.click(cards[0]!.querySelector('img')!, { [modifier]: true });
      expect(selected()).toEqual([true, false, true, false]);
    },
  );

  it('extends and shrinks a video range from the initial selection and checkbox anchor', async () => {
    const { cards, selected } = await selectableMedia();
    fireEvent.click(cards[3]!.querySelector('video')!, { shiftKey: true });
    expect(selected()).toEqual([true, true, true, true]);
    fireEvent.click(cards[1]!.querySelector('video')!, { shiftKey: true });
    expect(selected()).toEqual([true, true, false, false]);

    fireEvent.click(cards[3]!.querySelector('video')!);
    fireEvent.click(cards[1]!.querySelector('video')!, { shiftKey: true });
    expect(selected()).toEqual([false, true, true, true]);
    fireEvent.click(cards[0]!.querySelector('img')!, { shiftKey: true, ctrlKey: true });
    expect(selected()).toEqual([true, true, true, true]);

    fireEvent.click(cards[0]!);
    fireEvent.click(within(cards[2]!).getByRole('button', { name: '选择' }));
    fireEvent.click(within(cards[3]!).getByRole('button', { name: '选择' }), { shiftKey: true });
    expect(selected()).toEqual([false, false, true, true]);
    fireEvent.click(cards[0]!.querySelector('img')!, { shiftKey: true });
    expect(selected()).toEqual([true, true, true, false]);
  });

  it('reserves the native control strip for playback while the video picture selects', async () => {
    const { cards, selected } = await selectableMedia();
    const video = cards[2]!.querySelector('video')!;
    fireEvent.mouseEnter(cards[2]!);
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 150,
      width: 200,
      height: 150,
      toJSON: () => ({}),
    });
    expect(fireEvent.click(video, { clientX: 20, clientY: 140 })).toBe(true);
    expect(selected()).toEqual([true, false, false, false]);
    expect(fireEvent.click(video, { clientX: 20, clientY: 140, altKey: true })).toBe(true);
    expect(selected()).toEqual([true, false, false, false]);
    expect(fireEvent.click(video, { clientX: 20, clientY: 30, altKey: true })).toBe(false);
    expect(selected()).toEqual([true, false, true, false]);
    fireEvent.click(cards[3]!.querySelector('video')!, { shiftKey: true });
    expect(selected()).toEqual([false, false, true, true]);
  });

  it('creates and assigns a tag from the selected asset inspector input', async () => {
    const asset = {
      id: 'asset-1',
      projectId: 'project',
      kind: 'generated-image',
      relativePath: 'assets/1.png',
      contentHash: 'one',
      sizeBytes: 10,
      createdAt: '2026-08-01T00:00:00.000Z',
      tags: [],
    };
    const tag = {
      id: 'tag-dragon',
      projectId: 'project',
      name: 'Dragon',
      createdBy: 'local-user',
      createdAt: 'now',
      updatedAt: 'now',
    };
    callWorker.mockImplementation((method: string) => {
      if (method === 'asset.list') return Promise.resolve([asset]);
      if (method === 'tag.list') return Promise.resolve([]);
      if (method === 'asset.mediaSource')
        return Promise.reject(new Error('fixture image unavailable'));
      if (method === 'tag.create') return Promise.resolve(tag);
      if (method === 'asset.tags.add') return Promise.resolve([asset]);
      return Promise.resolve([]);
    });
    render(<AssetLibraryView writable />);

    const input = await screen.findByLabelText('添加标签');
    fireEvent.change(input, { target: { value: '  Dragon  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(callWorker).toHaveBeenCalledWith('tag.create', { name: 'Dragon' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('asset.tags.add', {
        assetIds: ['asset-1'],
        tagIds: ['tag-dragon'],
      }),
    );
  });

  it('creates a manual asset group from the selected assets', async () => {
    const assets = ['asset-1', 'asset-2'].map((id, index) => ({
      id,
      projectId: 'project',
      kind: 'generated-image',
      relativePath: `assets/${id}.png`,
      contentHash: id,
      sizeBytes: 10,
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      tags: [],
    }));
    callWorker.mockImplementation((method: string) => {
      if (method === 'asset.list') return Promise.resolve(assets);
      if (method === 'asset.mediaSource') return Promise.reject(new Error('fixture unavailable'));
      if (method === 'assetGroup.list') return Promise.resolve([]);
      if (method === 'tag.list') return Promise.resolve([]);
      if (method === 'assetGroup.create') return Promise.resolve({});
      return Promise.resolve([]);
    });
    render(<AssetLibraryView writable />);
    const options = await within(
      await screen.findByRole('listbox', { name: '素材' }),
    ).findAllByRole('option');
    fireEvent.click(options[0]!);
    fireEvent.click(options[1]!, { ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: '新建素材组' }));
    fireEvent.change(screen.getByLabelText('素材组名称'), { target: { value: '龙素材' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('assetGroup.create', {
        name: '龙素材',
        assetIds: ['asset-1', 'asset-2'],
      }),
    );
  });

  it('drops a material card into the asset group editor with the text fallback', async () => {
    const assets = ['asset-1', 'asset-2'].map((id, index) => ({
      id,
      projectId: 'project',
      kind: 'generated-image',
      relativePath: `assets/${id}.png`,
      contentHash: id,
      sizeBytes: 10,
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      tags: [],
    }));
    callWorker.mockImplementation((method: string) => {
      if (method === 'asset.list') return Promise.resolve(assets);
      if (method === 'asset.mediaSource') return Promise.reject(new Error('fixture unavailable'));
      return Promise.resolve([]);
    });
    render(<AssetLibraryView writable />);
    const options = await within(
      await screen.findByRole('listbox', { name: '素材' }),
    ).findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: '新建素材组' }));

    const dragData = new Map<string, string>();
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: (type: string, value: string) => dragData.set(type, value),
      getData: (type: string) => (type === 'text/plain' ? (dragData.get(type) ?? '') : ''),
    };
    fireEvent.dragStart(options[1]!, { dataTransfer });
    const dropZone = screen.getByRole('group', { name: '素材成员' });
    fireEvent.dragOver(dropZone, { dataTransfer });
    fireEvent.drop(dropZone, { dataTransfer });

    expect(within(dropZone).getByText('asset-2.png')).toBeInTheDocument();
  });

  it('uses pointer dragging when the WebView does not dispatch native drop events', async () => {
    const assets = ['asset-1', 'asset-2'].map((id, index) => ({
      id,
      projectId: 'project',
      kind: 'generated-image',
      relativePath: `assets/${id}.png`,
      contentHash: id,
      sizeBytes: 10,
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      tags: [],
    }));
    callWorker.mockImplementation((method: string) => {
      if (method === 'asset.list') return Promise.resolve(assets);
      if (method === 'asset.mediaSource') return Promise.reject(new Error('fixture unavailable'));
      return Promise.resolve([]);
    });
    render(<AssetLibraryView writable />);
    const options = await within(
      await screen.findByRole('listbox', { name: '素材' }),
    ).findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: '新建素材组' }));
    const dropZone = screen.getByRole('group', { name: '素材成员' });
    vi.spyOn(dropZone, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 20,
      left: 20,
      top: 20,
      right: 420,
      bottom: 220,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(options[1]!, { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(options[1]!, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(dropZone).toHaveClass('is-drag-over');
    fireEvent.pointerUp(options[1]!, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(within(dropZone).getByText('asset-2.png')).toBeInTheDocument();
  });

  it('renders complete image previews and reveals inline video controls on interaction', async () => {
    const assets = [
      {
        id: 'image-1',
        projectId: 'project',
        kind: 'generated-image',
        relativePath: 'assets/image.png',
        contentHash: 'image',
        sizeBytes: 10,
        createdAt: '2026-08-01T00:00:00.000Z',
        tags: [],
      },
      {
        id: 'video-1',
        projectId: 'project',
        kind: 'generated-video',
        relativePath: 'assets/video.mp4',
        contentHash: 'video',
        sizeBytes: 20,
        createdAt: '2026-08-02T00:00:00.000Z',
        tags: [],
      },
    ];
    callWorker.mockImplementation((method: string, params: { assetId?: string }) => {
      if (method === 'asset.list') return Promise.resolve(assets);
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: params.assetId,
          path:
            params.assetId === 'image-1'
              ? 'C:\\project\\assets\\image.png'
              : 'C:\\project\\assets\\video.mp4',
          contentType: params.assetId === 'image-1' ? 'image/png' : 'video/mp4',
        });
      return Promise.resolve([]);
    });
    const { container } = render(<AssetLibraryView writable selectedAssetId="video-1" />);
    await waitFor(() => expect(container.querySelector('.asset-thumb img')).toBeInTheDocument());
    const videoCard = screen.getByRole('option', { name: '视频素材 2' });
    const cardVideo = videoCard.querySelector('video');
    expect(cardVideo).not.toHaveAttribute('controls');
    Object.defineProperty(cardVideo!, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(cardVideo!);
    expect(cardVideo).toHaveProperty('currentTime', 1 / 30);
    fireEvent.mouseEnter(videoCard);
    expect(cardVideo).toHaveAttribute('controls');
    fireEvent.mouseLeave(videoCard);
    expect(cardVideo).not.toHaveAttribute('controls');
    fireEvent.focus(videoCard);
    expect(cardVideo).toHaveAttribute('controls');
    fireEvent.blur(videoCard, { relatedTarget: document.body });
    expect(cardVideo).not.toHaveAttribute('controls');
    fireEvent.touchStart(videoCard);
    expect(cardVideo).toHaveAttribute('controls');
    expect(container.querySelector('.asset-thumb video')).toHaveAttribute(
      'src',
      '/worker-media/video-1',
    );
    expect(container.querySelector('.asset-thumb img')).toBeInTheDocument();
    expect(container.querySelector('.asset-thumb img')).toHaveAttribute(
      'src',
      '/worker-media/image-1',
    );
    await waitFor(() =>
      expect(container.querySelector('.asset-inspector-preview video')).toHaveAttribute('controls'),
    );
    const imageCard = screen.getByRole('option', { name: '图片素材 1' });
    fireEvent.click(imageCard);
    const trigger = await screen.findByRole('button', { name: '放大查看image.png' });
    fireEvent.click(trigger);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
      'src',
      '/worker-media/image-1',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
  });
});
