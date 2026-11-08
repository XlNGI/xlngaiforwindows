import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLibraryView } from '../assets/AssetLibraryView';
import { RoughCutWorkspace } from './RoughCutWorkspace';
import { selectWorkerScope } from '../worker-scope';

const call = vi.fn();
vi.mock('../worker-client', () => ({
  callWorker: (...args: unknown[]): unknown => call(...args) as unknown,
}));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
const assets = ['one', 'two', 'image'].map((id, index) => ({
  id,
  projectId: 'p',
  kind: index === 2 ? 'generated-image' : 'scene-video',
  alias: id,
  relativePath: `assets/${id}.mp4`,
  contentHash: id,
  sizeBytes: 10,
  createdAt: `2026-10-2${index}T00:00:00Z`,
}));
beforeEach(() => {
  selectWorkerScope({ projectId: 'p', projectSessionId: crypto.randomUUID() });
  call.mockReset();
  call.mockImplementation((method: string, params: Record<string, unknown>) => {
    if (method === 'asset.list') return Promise.resolve(assets);
    if (method === 'asset.mediaSource') return Promise.resolve({ path: '/fixture.mp4' });
    if (method === 'roughCut.prepare')
      return Promise.resolve({
        clips: (params.assetIds as string[]).map((assetId) => ({
          id: crypto.randomUUID(),
          assetId,
          contentHash: assetId,
          name: assetId,
          durationMs: 1000,
          width: 100,
          height: 100,
          hasAudio: false,
          inMs: 0,
          outMs: 1000,
          muted: false,
          fit: 'contain',
        })),
        missingSceneIds: [],
      });
    if (method === 'roughCut.save')
      return Promise.resolve({
        sequence: { ...params, projectId: 'p', rowVersion: 1 },
        unavailableClipIds: [],
      });
    return Promise.resolve([]);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const box = {
  x: 500,
  y: 100,
  left: 500,
  right: 1000,
  top: 100,
  bottom: 500,
  width: 500,
  height: 400,
  toJSON: () => ({}),
};
async function setup(writable = true) {
  const view = render(
    <>
      <AssetLibraryView writable onAddToRoughCut={() => undefined} />
      <RoughCutWorkspace
        projectId="p"
        writable={writable}
        scenes={[]}
        onImportHandled={() => undefined}
      />
    </>,
  );
  await screen.findByRole('option', { name: 'one' });
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'two' }).querySelector('video')).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '按集导入' }))[
      writable ? 'toBeEnabled' : 'toBeDisabled'
    ](),
  );
  const timeline = view.container.querySelector('.rough-cut-timeline')!;
  vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue(box);
  return { timeline };
}
describe('library to rough cut pointer dragging', () => {
  it('drags multiple selected videos without native drag events and preserves selection', async () => {
    const { timeline } = await setup();
    fireEvent.click(
      within(screen.getByRole('option', { name: 'two' })).getByRole('button', { name: '选择' }),
    );
    expect(screen.getAllByRole('button', { name: '取消选择', pressed: true })).toHaveLength(2);
    const card = screen.getByRole('option', { name: 'two' });
    const handle = card.querySelector('.asset-video-drag-surface')!;
    expect(card).toHaveAttribute('draggable', 'true');
    expect(handle).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拖动素材/ })).not.toBeInTheDocument();
    fireEvent.pointerDown(handle, { pointerId: 5, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientX: 600, clientY: 200 });
    expect(timeline).toHaveClass('is-drag-over');
    expect(screen.getByText(/松开导入 2 个视频/)).toBeInTheDocument();
    fireEvent.pointerUp(handle, { pointerId: 5, clientX: 600, clientY: 200 });
    fireEvent.click(screen.getByRole('option', { name: 'two' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'roughCut.prepare',
        { assetIds: ['one', 'two'] },
        expect.anything(),
      ),
    );
    expect(await screen.findByRole('button', { name: '选择片段 2 two' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '取消选择', pressed: true })).toHaveLength(2);
    expect(screen.queryByLabelText('片段属性')).not.toBeInTheDocument();
    expect(timeline).not.toHaveClass('is-drag-over');
  });
  it('cancels on Escape or outside drop and excludes images', async () => {
    const { timeline } = await setup();
    const handle = screen
      .getByRole('option', { name: 'two' })
      .querySelector('.asset-video-drag-surface')!;
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600, clientY: 200 });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 600, clientY: 200 });
    expect(timeline).not.toHaveClass('is-drag-over');
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 300, clientY: 200 });
    const image = screen.getByRole('option', { name: 'image' });
    fireEvent.pointerDown(image, { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(image, { pointerId: 3, clientX: 600, clientY: 200 });
    fireEvent.pointerUp(image, { pointerId: 3, clientX: 600, clientY: 200 });
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.prepare')).toHaveLength(0);
  });
  it('does not accept pointer imports into read-only projects', async () => {
    await setup(false);
    const handle = screen
      .getByRole('option', { name: 'two' })
      .querySelector('.asset-video-drag-surface')!;
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 600, clientY: 200 });
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.prepare')).toHaveLength(0);
  });
  it('keeps the video control strip free of pointer import gestures', async () => {
    const { timeline } = await setup();
    const video = screen.getByRole('option', { name: 'two' }).querySelector('video')!;
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
      ...box,
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 150,
      width: 200,
      height: 150,
    });
    fireEvent.mouseEnter(video.closest('[role="option"]')!);
    fireEvent.pointerDown(video, { pointerId: 1, button: 0, clientX: 20, clientY: 140 });
    fireEvent.pointerMove(video, { pointerId: 1, clientX: 600, clientY: 200 });
    fireEvent.pointerUp(video, { pointerId: 1, clientX: 600, clientY: 200 });
    expect(timeline).not.toHaveClass('is-drag-over');
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.prepare')).toHaveLength(0);
  });

  it('does not turn modified video selection clicks into pointer imports', async () => {
    const { timeline } = await setup();
    const card = screen.getByRole('option', { name: 'two' });
    const video = card.querySelector('video')!;
    for (const modifier of ['altKey', 'ctrlKey', 'shiftKey']) {
      fireEvent.pointerDown(video, {
        pointerId: 2,
        button: 0,
        clientX: 100,
        clientY: 100,
        [modifier]: true,
      });
      fireEvent.pointerMove(video, { pointerId: 2, clientX: 600, clientY: 200 });
      expect(timeline).not.toHaveClass('is-drag-over');
      fireEvent.pointerUp(video, { pointerId: 2, clientX: 600, clientY: 200 });
    }
    fireEvent.click(screen.getByRole('option', { name: 'one' }));
    fireEvent.click(video, { altKey: true });
    expect(screen.getAllByRole('button', { name: '取消选择', pressed: true })).toHaveLength(2);
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.prepare')).toHaveLength(0);
  });
});
