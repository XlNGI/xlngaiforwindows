import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssetInfo } from '@ai-video/contracts';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { DocumentImageGallery } from './DocumentImageGallery';
import { callWorker } from './worker-client';

const native = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: DragDropEvent }) => void) | undefined,
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (listener: typeof native.listener) => {
      await Promise.resolve();
      native.listener = listener;
      return native.unlisten;
    },
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./AssetImagePreview', () => ({
  AssetImagePreview: ({ asset }: { asset: AssetInfo }) => <span>{asset.alias}</span>,
}));

const image: AssetInfo = {
  id: 'custom-image',
  projectId: 'project',
  kind: 'character-image',
  alias: '电脑图片',
  relativePath: 'assets/images/custom.png',
  contentHash: 'hash',
  sizeBytes: 100,
  createdAt: '2026-11-11T00:00:00Z',
};
function fixture() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const props = {
    projectId: 'project',
    documentId: 'document',
    writable: true,
    assets: [] as AssetInfo[],
    onImported: vi.fn(),
    onRemoved: vi.fn(),
  };
  vi.mocked(callWorker).mockResolvedValue([image]);
  vi.mocked(openDialog).mockResolvedValue(['E:/自定义图片.png']);
  const view = render(<DocumentImageGallery {...props} />);
  return { ...view, props };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  native.listener = undefined;
});

it('selects multiple local images and binds them to the current document with immediate deduplicated previews', async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  expect(await screen.findByText('已添加并绑定 1 张图片。')).toBeInTheDocument();
  expect(openDialog).toHaveBeenCalledWith({
    multiple: true,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  expect(callWorker).toHaveBeenCalledWith('document.images.import', {
    documentId: 'document',
    sourcePaths: ['E:/自定义图片.png'],
  });
  expect(f.props.onImported).toHaveBeenCalledWith([image]);
  expect(screen.getByText('电脑图片')).toBeInTheDocument();
  f.rerender(<DocumentImageGallery {...f.props} assets={[image]} />);
  expect(screen.getAllByText('电脑图片')).toHaveLength(1);
  f.rerender(<DocumentImageGallery {...f.props} assets={[]} />);
  expect(screen.queryByText('电脑图片')).not.toBeInTheDocument();
});
it('accepts native Windows drops only inside the visible gallery and disposes the listener', async () => {
  const f = fixture();
  await waitFor(() => expect(native.listener).toBeTypeOf('function'));
  const zone = f.container.querySelector('[data-document-image-drop]')!;
  const hit = vi.fn(() => zone);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  act(() =>
    native.listener?.({
      payload: { type: 'enter', paths: ['E:/角色.png'], position: new PhysicalPosition(200, 100) },
    }),
  );
  expect(hit).toHaveBeenCalledWith(100, 50);
  expect(zone).toHaveClass('is-file-drag-over');
  act(() =>
    native.listener?.({
      payload: {
        type: 'drop',
        paths: ['E:/角色.png', 'E:/场景.webp'],
        position: new PhysicalPosition(200, 100),
      },
    }),
  );
  await screen.findByText('已添加并绑定 1 张图片。');
  expect(callWorker).toHaveBeenCalledWith('document.images.import', {
    documentId: 'document',
    sourcePaths: ['E:/角色.png', 'E:/场景.webp'],
  });
  expect(zone).not.toHaveClass('is-file-drag-over');
  hit.mockReturnValue(document.body);
  act(() =>
    native.listener?.({
      payload: {
        type: 'drop',
        paths: ['E:/无效位置.png'],
        position: new PhysicalPosition(500, 300),
      },
    }),
  );
  expect(callWorker).toHaveBeenCalledTimes(1);
  f.unmount();
  expect(native.unlisten).toHaveBeenCalledOnce();
});
it('rejects videos and too many images before importing, and treats dialog cancellation as no change', async () => {
  fixture();
  vi.mocked(openDialog).mockResolvedValueOnce(['E:/视频.mp4']);
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await screen.findByText('仅支持 PNG、JPEG、WebP 图片。');
  vi.mocked(openDialog).mockResolvedValueOnce(Array.from({ length: 13 }, (_, i) => `E:/${i}.png`));
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await screen.findByText('每次最多添加 12 张图片。');
  vi.mocked(openDialog).mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '添加图片' })).toBeEnabled());
  expect(callWorker).not.toHaveBeenCalled();
});
it('keeps read-only and unsaved documents from importing', async () => {
  const f = fixture();
  await waitFor(() => expect(native.listener).toBeTypeOf('function'));
  f.rerender(<DocumentImageGallery {...f.props} writable={false} />);
  expect(screen.getByRole('button', { name: '添加图片' })).toBeDisabled();
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => f.container.querySelector('[data-document-image-drop]'),
  });
  act(() =>
    native.listener?.({
      payload: { type: 'drop', paths: ['E:/角色.png'], position: new PhysicalPosition(10, 10) },
    }),
  );
  f.rerender(<DocumentImageGallery {...f.props} documentId={undefined} />);
  expect(screen.getByRole('button', { name: '添加图片' })).toBeDisabled();
  expect(screen.getByText('请先保存资料，再添加或拖入电脑图片。')).toBeInTheDocument();
  expect(callWorker).not.toHaveBeenCalled();
});
it('does not bind a late dialog selection or import result to a newly selected document', async () => {
  const f = fixture();
  let select!: (value: string[]) => void;
  vi.mocked(openDialog).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        select = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  f.rerender(<DocumentImageGallery {...f.props} documentId="second" />);
  await act(async () => {
    select(['E:/旧角色.png']);
    await Promise.resolve();
  });
  expect(callWorker).not.toHaveBeenCalled();
  let finish!: (value: AssetInfo[]) => void;
  vi.mocked(callWorker).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await waitFor(() => expect(callWorker).toHaveBeenCalledOnce());
  f.rerender(<DocumentImageGallery {...f.props} projectId="different" documentId="third" />);
  await act(async () => {
    finish([image]);
    await Promise.resolve();
  });
  expect(f.props.onImported).not.toHaveBeenCalled();
  expect(screen.queryByText('电脑图片')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '添加图片' })).toBeEnabled();
});
it('shows backend import failures and allows retry', async () => {
  fixture();
  vi.mocked(callWorker).mockRejectedValueOnce(new Error('磁盘空间不足'));
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await screen.findByText('磁盘空间不足');
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await screen.findByText('已添加并绑定 1 张图片。');
});

it('unbinds only the current document, hides the image immediately and allows reimporting it', async () => {
  const f = fixture();
  f.rerender(<DocumentImageGallery {...f.props} assets={[image]} />);
  vi.mocked(callWorker).mockResolvedValueOnce({ removed: true });
  fireEvent.click(screen.getByRole('button', { name: '移除图片：电脑图片' }));
  await screen.findByText('已解除图片绑定，素材保留在素材库。');
  expect(callWorker).toHaveBeenCalledWith('document.images.unbind', {
    documentId: 'document',
    assetId: image.id,
  });
  expect(f.props.onRemoved).toHaveBeenCalledWith(image.id);
  expect(screen.queryByText('电脑图片')).not.toBeInTheDocument();
  f.rerender(<DocumentImageGallery {...f.props} assets={[]} />);
  fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
  await screen.findByText('已添加并绑定 1 张图片。');
  expect(screen.getByText('电脑图片')).toBeInTheDocument();
});

it('keeps the image on unbind failure and retries without allowing a duplicate request', async () => {
  const f = fixture();
  f.rerender(<DocumentImageGallery {...f.props} assets={[image]} />);
  vi.mocked(callWorker).mockRejectedValueOnce(new Error('暂时无法保存绑定'));
  fireEvent.click(screen.getByRole('button', { name: '移除图片：电脑图片' }));
  await screen.findByText('暂时无法保存绑定');
  expect(screen.getByText('电脑图片')).toBeInTheDocument();
  expect(f.props.onRemoved).not.toHaveBeenCalled();
  let finish!: (value: { removed: true }) => void;
  vi.mocked(callWorker).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const button = screen.getByRole('button', { name: '移除图片：电脑图片' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(screen.getByRole('button', { name: '添加图片' })).toBeDisabled();
  expect(callWorker).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish({ removed: true });
    await Promise.resolve();
  });
  expect(screen.queryByText('电脑图片')).not.toBeInTheDocument();
});

it('disables unbinding for read-only or unsaved documents', () => {
  const f = fixture();
  f.rerender(<DocumentImageGallery {...f.props} assets={[image]} writable={false} />);
  expect(screen.getByRole('button', { name: '移除图片：电脑图片' })).toBeDisabled();
  f.rerender(<DocumentImageGallery {...f.props} assets={[image]} documentId={undefined} />);
  expect(screen.getByRole('button', { name: '移除图片：电脑图片' })).toBeDisabled();
  expect(callWorker).not.toHaveBeenCalled();
});

it('discards a late unbind response after switching projects and documents', async () => {
  const f = fixture();
  f.rerender(<DocumentImageGallery {...f.props} assets={[image]} />);
  let finish!: (value: { removed: true }) => void;
  vi.mocked(callWorker).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '移除图片：电脑图片' }));
  f.rerender(
    <DocumentImageGallery {...f.props} projectId="other" documentId="second" assets={[image]} />,
  );
  await act(async () => {
    finish({ removed: true });
    await Promise.resolve();
  });
  expect(f.props.onRemoved).not.toHaveBeenCalled();
  expect(screen.getByText('电脑图片')).toBeInTheDocument();
  expect(screen.queryByText('已解除图片绑定，素材保留在素材库。')).not.toBeInTheDocument();
});
