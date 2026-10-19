import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetInfo, SceneMediaResolveResult } from '@ai-video/contracts';
import { ReferenceCard } from './ReferenceCard';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const image: AssetInfo = {
  id: 'outside-page',
  projectId: 'project',
  kind: 'generated-image',
  relativePath: 'assets/ref.png',
  contentHash: 'h',
  sizeBytes: 12,
  createdAt: 'now',
};
const drop = (projectId = 'project', count = 1) => ({
  dataTransfer: {
    getData: () =>
      JSON.stringify({
        version: 1,
        projectId,
        assets: Array.from({ length: count }, () => ({ id: image.id, kind: 'character' })),
      }),
  },
});
function mount(writable = true) {
  const onDropAsset = vi.fn();
  const view = render(
    <ReferenceCard
      label="角色参考"
      projectId="project"
      writable={writable}
      onDropAsset={onDropAsset}
      selector={
        <select aria-label="选择图片">
          <option>未选择</option>
        </select>
      }
    />,
  );
  return { ...view, onDropAsset };
}

describe('reference cards', () => {
  it('resolves a dropped image outside the library page and validates readability before binding', async () => {
    vi.mocked(callWorker).mockImplementation((method) =>
      Promise.resolve(
        method === 'scene.media.resolve'
          ? { characters: [], voices: [], assets: [image] }
          : { assetId: image.id, path: 'D:/ref.png', contentType: 'image/png' },
      ),
    );
    const { onDropAsset } = mount();
    fireEvent.drop(screen.getByLabelText('角色参考卡片'), drop());
    await waitFor(() => expect(onDropAsset).toHaveBeenCalledWith(image));
    expect(callWorker).toHaveBeenCalledWith('asset.mediaSource', { assetId: image.id });
  });
  it('rejects cross-project and multi-image payloads and ignores drops in read-only views', () => {
    const { onDropAsset, unmount } = mount();
    fireEvent.drop(screen.getByLabelText('角色参考卡片'), drop('other'));
    expect(screen.getByRole('status')).toHaveTextContent('当前项目');
    fireEvent.drop(screen.getByLabelText('角色参考卡片'), drop('project', 2));
    expect(screen.getByRole('status')).toHaveTextContent('一张图片');
    expect(callWorker).not.toHaveBeenCalled();
    expect(onDropAsset).not.toHaveBeenCalled();
    unmount();
    mount(false);
    fireEvent.drop(screen.getByLabelText('角色参考卡片'), drop());
    expect(callWorker).not.toHaveBeenCalled();
  });
  it.each(['video', 'deleted', 'missing', 'unreadable'])(
    'rejects an unavailable %s even when payload claims an image',
    async (kind) => {
      vi.mocked(callWorker).mockImplementation((method) =>
        method === 'scene.media.resolve'
          ? Promise.resolve({
              characters: [],
              voices: [],
              assets:
                kind === 'missing'
                  ? []
                  : [
                      {
                        ...image,
                        ...(kind === 'video'
                          ? { kind: 'generated-video' }
                          : kind === 'deleted'
                            ? { deletedAt: 'now' }
                            : {}),
                      },
                    ],
            })
          : Promise.reject(new Error('文件不可读')),
      );
      const { onDropAsset } = mount();
      fireEvent.drop(screen.getByLabelText('角色参考卡片'), drop());
      await screen.findByRole('status');
      expect(onDropAsset).not.toHaveBeenCalled();
    },
  );
  it('discards a drop response after the target is unmounted', async () => {
    let resolve!: (value: SceneMediaResolveResult) => void;
    vi.mocked(callWorker).mockImplementation(
      () =>
        new Promise<SceneMediaResolveResult>((r) => {
          resolve = r;
        }),
    );
    const { onDropAsset, unmount } = mount();
    fireEvent.drop(screen.getByLabelText('角色参考卡片'), drop());
    unmount();
    await act(() => Promise.resolve(resolve({ characters: [], voices: [], assets: [] })));
    expect(onDropAsset).not.toHaveBeenCalled();
  });
});
