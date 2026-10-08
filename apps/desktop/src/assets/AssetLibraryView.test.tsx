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

describe('AssetLibraryView', () => {
  beforeEach(() => {
    cleanup();
    callWorker.mockReset();
    callWorker.mockResolvedValue([]);
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

  it('renders complete image previews and inline video playback', async () => {
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
    await waitFor(() =>
      expect(container.querySelector('.asset-thumb video')).toHaveAttribute('controls'),
    );
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
  });
});
