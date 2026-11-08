import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssetInfo, ShotContinuityContext } from '@ai-video/contracts';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import { ContinuitySourceSelector } from './ContinuitySourceSelector';
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
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./dubbing/media', () => ({ useDubbingMedia: () => ({ src: '/fixture.mp4' }) }));
vi.mock('./AssetImagePreview', () => ({
  AssetImagePreview: ({ asset }: { asset: AssetInfo }) => <span>{asset.id}</span>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  native.listener = undefined;
});

const assets: AssetInfo[] = ['image-a', 'image-b', 'video-a', 'video-b'].map((id) => ({
  id,
  alias: id,
  projectId: 'project',
  relativePath: `${id}.png`,
  kind: id.startsWith('video') ? 'generated-video' : 'reference-image',
  contentHash: 'hash',
  sizeBytes: 100,
  createdAt: '2026-11-04T00:00:00Z',
}));
const context: ShotContinuityContext = {
  shotId: 'first',
  rowVersion: 0,
  images: [],
  videos: [],
  stale: false,
};
function fixture() {
  vi.mocked(callWorker).mockImplementation(async (method, params) => {
    await Promise.resolve();
    if (method === 'asset.list') return assets;
    if (method === 'shot.continuity.import') return assets.slice(0, 2);
    if (method === 'shot.continuity.probe')
      return { durationMs: 2000, fps: 25, sourceToken: 'a'.repeat(64) };
    if (method === 'shot.continuity.preview')
      return {
        dataUrl: 'data:image/jpeg;base64,/9j/',
        timeMs: (params as { timeMs: number }).timeMs,
        durationMs: 2000,
        fps: 25,
        sourceToken: 'a'.repeat(64),
      };
    if (method === 'shot.continuity.selection.confirm') return { ...context, rowVersion: 1 };
    if (method === 'asset.mediaSource')
      return { assetId: 'image-a', path: 'E:/image.png', contentType: 'image/png' };
    if (method === 'shot.continuity.assets') return assets.slice(0, 2);
    throw new Error(`Unexpected ${method}`);
  });
  const props = {
    projectId: 'project',
    shotId: 'first',
    context,
    writable: true,
    notes: '',
    onConfirm: vi.fn(),
    onPending: vi.fn(),
  };
  const view = render(<ContinuitySourceSelector {...props} />);
  const open = async () => {
    fireEvent.click(screen.getByText('从项目素材选择'));
    await screen.findByLabelText('image-a');
  };
  return { ...view, props, open };
}

it('selects project images on the first shot without a video and requires an explicit anchor', async () => {
  const f = fixture();
  await f.open();
  fireEvent.click(screen.getByLabelText('image-a'));
  fireEvent.click(screen.getByLabelText('image-b'));
  expect(screen.getByText('确认所选画面')).toBeDisabled();
  fireEvent.click(screen.getAllByRole('radio')[1]!);
  fireEvent.click(screen.getByText('确认所选画面'));
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith('shot.continuity.selection.confirm', {
      shotId: 'first',
      expectedRowVersion: 0,
      frames: [],
      imageAssetIds: ['image-a', 'image-b'],
      anchor: { assetId: 'image-b' },
      notes: '',
    }),
  );
  expect(f.props.onConfirm).toHaveBeenCalledOnce();
});

it('batch extracts multiple videos with independent timestamps and waits for explicit picture selection', async () => {
  const f = fixture();
  await f.open();
  fireEvent.click(screen.getByLabelText('video-a'));
  fireEvent.click(screen.getByLabelText('video-b'));
  fireEvent.change(screen.getByLabelText('抽帧范围'), { target: { value: 'all' } });
  fireEvent.change(screen.getByLabelText('每段抽帧数'), { target: { value: 3 } });
  await waitFor(() => expect(screen.getByText('批量抽帧')).toBeEnabled());
  fireEvent.click(screen.getByText('批量抽帧'));
  await screen.findByText('已抽取 6 张候选画面，请勾选并指定衔接基准。');
  expect(screen.getByText('已选 0/12 张参考画面')).toBeVisible();
  expect(screen.getByText('确认所选画面')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '全选候选画面' }));
  fireEvent.click(screen.getAllByRole('radio')[3]!);
  fireEvent.click(screen.getByText('确认所选画面'));
  await waitFor(() => expect(f.props.onConfirm).toHaveBeenCalledOnce());
  const request = vi
    .mocked(callWorker)
    .mock.calls.find(([method]) => method === 'shot.continuity.selection.confirm')![1];
  expect(request).toMatchObject({
    frames: [
      { videoAssetId: 'video-a', timeMs: 0 },
      { videoAssetId: 'video-a', timeMs: 1000 },
      { videoAssetId: 'video-a', timeMs: 1999 },
      { videoAssetId: 'video-b', timeMs: 0 },
      { videoAssetId: 'video-b', timeMs: 1000 },
      { videoAssetId: 'video-b', timeMs: 1999 },
    ],
    anchor: { videoAssetId: 'video-b', timeMs: 0 },
  });
});

it('stops subsequent batch requests and retains completed candidates', async () => {
  const f = fixture();
  await f.open();
  fireEvent.click(screen.getByLabelText('video-a'));
  await waitFor(() => expect(screen.getByText('批量抽帧')).toBeEnabled());
  const implementation = vi.mocked(callWorker).getMockImplementation()!;
  let finish: (() => void) | undefined;
  let reads = 0;
  vi.mocked(callWorker).mockImplementation(async (method, params, scope) => {
    if (method === 'shot.continuity.preview' && ++reads === 2)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return implementation(method, params, scope);
  });
  fireEvent.click(screen.getByText('批量抽帧'));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByText('停止抽帧'));
  await act(async () => {
    finish!();
    await Promise.resolve();
  });
  await screen.findByText('已停止后续抽帧，保留已完成的 1 张候选画面。');
  expect(reads).toBe(2);
  expect(screen.getAllByRole('radio')).toHaveLength(1);
});

it('accepts native Windows multi-file drops at the visible target and removes its listener on unmount', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const f = fixture();
  const zone = f.container.querySelector('[data-continuity-file-drop]')!;
  vi.stubGlobal('devicePixelRatio', 2);
  const hit = vi.fn(() => zone);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  await waitFor(() => expect(native.listener).toBeDefined());
  await act(async () => {
    native.listener!({
      payload: {
        type: 'drop',
        paths: ['E:/a.png', 'E:/b.jpg'],
        position: { x: 40, y: 80 },
      } as DragDropEvent,
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith('shot.continuity.import', {
      shotId: 'first',
      sourcePaths: ['E:/a.png', 'E:/b.jpg'],
    }),
  );
  expect(hit).toHaveBeenCalledWith(20, 40);
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  expect(f.props.onConfirm).not.toHaveBeenCalled();
  f.unmount();
  expect(native.unlisten).toHaveBeenCalledOnce();
});

it('rejects cross-project asset drops and blocks source writes in read-only mode', async () => {
  const f = fixture();
  const zone = f.container.querySelector('[data-asset-drop-zone]')!;
  fireEvent.drop(zone, {
    dataTransfer: {
      types: ['text/plain'],
      getData: () =>
        JSON.stringify({ version: 1, projectId: 'foreign', assets: [{ id: 'x', kind: 'scene' }] }),
    },
  });
  await screen.findByText('只能拖入当前项目的素材。');
  expect(callWorker).not.toHaveBeenCalledWith('shot.continuity.assets', expect.anything());
  f.rerender(<ContinuitySourceSelector {...f.props} writable={false} />);
  expect(screen.getByText('选择电脑文件')).toBeDisabled();
  expect(screen.getByText('从项目素材选择')).toBeDisabled();
});
