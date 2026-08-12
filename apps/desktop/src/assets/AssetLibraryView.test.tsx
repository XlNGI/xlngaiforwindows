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

  it('opens all assets by default and applies image and video presets', async () => {
    render(<AssetLibraryView writable />);
    expect(screen.queryByRole('navigation', { name: '素材库导航' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ deleted: 'active', kind: undefined }),
      ),
    );
    fireEvent.click(within(screen.getByRole('group', { name: '素材类型' })).getByText('图片'));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ kind: 'image' }),
      ),
    );
    fireEvent.click(within(screen.getByRole('group', { name: '素材类型' })).getByText('视频'));
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
    expect(container.querySelector('.asset-manager-menu summary')).toHaveTextContent('素材组');
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
      if (method === 'asset.preview') return Promise.reject(new Error('fixture image unavailable'));
      if (method === 'asset.tags.add') return Promise.resolve(assets);
      return Promise.resolve([]);
    });
    render(<AssetLibraryView writable />);
    const options = await within(
      await screen.findByRole('listbox', { name: '素材' }),
    ).findAllByRole('option');
    fireEvent.click(options[0]!);
    fireEvent.click(options[1]!, { ctrlKey: true });
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();
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
      if (method === 'asset.preview')
        return Promise.resolve({
          assetId: params.assetId,
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          contentType: 'image/png',
        });
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: params.assetId,
          path: 'C:\\project\\assets\\video.mp4',
          contentType: 'video/mp4',
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
    await waitFor(() =>
      expect(container.querySelector('.asset-inspector-preview video')).toHaveAttribute('controls'),
    );
  });
});
