import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetImagePreview } from './AssetImagePreview';
import type { AssetMediaSourceInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { forgetWorkerScope, selectWorkerScope } from './worker-scope';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const id of ['A', 'B']) forgetWorkerScope(id);
  selectWorkerScope(undefined);
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

it('keeps thumbnail and full-image requests owned by A while B is selected', async () => {
  const a = { projectId: 'A', projectSessionId: 'a-1' };
  selectWorkerScope(a);
  selectWorkerScope({ projectId: 'B', projectSessionId: 'b-1' });
  vi.mocked(callWorker).mockResolvedValue({
    assetId: 'image',
    path: 'D:/image.png',
    contentType: 'image/png',
  });
  render(<AssetImagePreview projectId="A" assetId="image" alt="A角色" />);
  expect(await screen.findByRole('img')).toHaveAttribute(
    'src',
    '/worker-media/image?projectId=A&projectSessionId=a-1&thumbnail=1',
  );
  expect(callWorker).toHaveBeenCalledWith('asset.thumbnail', { assetId: 'image' }, a);
  fireEvent.click(screen.getByRole('button', { name: '放大查看A角色' }));
  expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
    'src',
    '/worker-media/image?projectId=A&projectSessionId=a-1',
  );
  expect(callWorker).toHaveBeenCalledWith('asset.mediaSource', { assetId: 'image' }, a);
});

it('does not reuse an old pending thumbnail after reopening the same project', async () => {
  selectWorkerScope({ projectId: 'A', projectSessionId: 'a-old' });
  let finishOld!: (value: AssetMediaSourceInfo) => void;
  vi.mocked(callWorker).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const view = render(<AssetImagePreview projectId="A" assetId="image" alt="角色" />);
  await waitFor(() => expect(callWorker).toHaveBeenCalledTimes(1));
  const current = { projectId: 'A', projectSessionId: 'a-new' };
  selectWorkerScope(current);
  vi.mocked(callWorker).mockResolvedValue({
    assetId: 'image',
    path: 'D:/new.png',
    contentType: 'image/png',
  });
  view.rerender(<AssetImagePreview projectId="A" assetId="image" alt="角色" />);
  expect(await screen.findByRole('img')).toHaveAttribute(
    'src',
    '/worker-media/image?projectId=A&projectSessionId=a-new&thumbnail=1',
  );
  expect(callWorker).toHaveBeenLastCalledWith('asset.thumbnail', { assetId: 'image' }, current);
  await act(() =>
    Promise.resolve(finishOld({ assetId: 'image', path: 'D:/old.png', contentType: 'image/png' })),
  );
  expect(screen.getByRole('img')).toHaveAttribute(
    'src',
    '/worker-media/image?projectId=A&projectSessionId=a-new&thumbnail=1',
  );
});

it('rejects an unattached owner instead of looking up its asset in the selected project', async () => {
  selectWorkerScope({ projectId: 'B', projectSessionId: 'b-1' });
  render(<AssetImagePreview projectId="A" assetId="image" alt="A角色" />);
  expect(await screen.findByRole('button', { name: '重试图片' })).toBeInTheDocument();
  expect(callWorker).not.toHaveBeenCalled();
});
