import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetImagePreview } from './AssetImagePreview';
import type { AssetMediaSourceInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('loads only a visible thumbnail, merges duplicate requests and fetches the full image on expansion', async () => {
  let visible: IntersectionObserverCallback = () => undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        visible = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(callWorker).mockResolvedValue({
    assetId: 'image',
    path: 'D:/image.png',
    contentType: 'image/png',
  });
  render(<AssetImagePreview projectId="one" assetId="image" alt="角色" />);
  expect(callWorker).not.toHaveBeenCalled();
  act(() =>
    visible([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver),
  );
  expect(await screen.findByRole('img')).toHaveAttribute('src', '/worker-media/image?thumbnail=1');
  expect(callWorker).toHaveBeenCalledTimes(1);
  expect(callWorker).toHaveBeenCalledWith('asset.thumbnail', { assetId: 'image' });
  fireEvent.click(screen.getByRole('button', { name: '放大查看角色' }));
  expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
    'src',
    '/worker-media/image',
  );
  expect(callWorker).toHaveBeenCalledWith('asset.mediaSource', { assetId: 'image' });
});

it('shares pending thumbnail requests and discards responses after changing project', async () => {
  let resolveOld: (value: AssetMediaSourceInfo) => void = () => undefined;
  vi.mocked(callWorker).mockImplementation(
    () =>
      new Promise<AssetMediaSourceInfo>((resolve) => {
        resolveOld = resolve;
      }),
  );
  const view = render(
    <>
      <AssetImagePreview projectId="old" assetId="same" alt="旧角色" />
      <AssetImagePreview projectId="old" assetId="same" alt="旧角色副本" />
    </>,
  );
  await waitFor(() => expect(callWorker).toHaveBeenCalledTimes(1));
  const finishOld = resolveOld;
  view.rerender(<AssetImagePreview projectId="new" assetId="same" alt="新角色" />);
  await waitFor(() => expect(callWorker).toHaveBeenCalledTimes(2));
  await act(() =>
    Promise.resolve(finishOld({ assetId: 'same', path: 'D:/old.png', contentType: 'image/png' })),
  );
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
