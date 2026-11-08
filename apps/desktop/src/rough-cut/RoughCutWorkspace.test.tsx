import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoughCutSequence } from '@ai-video/contracts';
import { RoughCutWorkspace } from './RoughCutWorkspace';
import { selectWorkerScope } from '../worker-scope';

const call = vi.fn();
vi.mock('../worker-client', () => ({
  callWorker: (...args: unknown[]): unknown => call(...args) as unknown,
}));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
const initial: RoughCutSequence = {
  id: 'sequence',
  projectId: 'p',
  name: '第一集',
  sceneIds: [],
  rowVersion: 1,
  createdAt: 'now',
  updatedAt: 'now',
  clips: [
    {
      id: 'one',
      assetId: 'video-a',
      contentHash: 'hash-a',
      name: '第一镜',
      durationMs: 4000,
      width: 1920,
      height: 1080,
      hasAudio: true,
      inMs: 0,
      outMs: 4000,
      muted: false,
      fit: 'contain',
    },
    {
      id: 'two',
      assetId: 'video-b',
      contentHash: 'hash-b',
      name: '第二镜',
      durationMs: 4000,
      width: 1920,
      height: 1080,
      hasAudio: false,
      inMs: 0,
      outMs: 4000,
      muted: false,
      fit: 'contain',
    },
  ],
};
let stored: RoughCutSequence;
beforeEach(() => {
  selectWorkerScope({ projectId: 'p', projectSessionId: crypto.randomUUID() });
  stored = structuredClone(initial);
  call.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  call.mockImplementation((method: string, params: Record<string, unknown>) => {
    if (method === 'roughCut.list') return Promise.resolve([stored]);
    if (method === 'roughCut.episodes')
      return Promise.resolve([
        { number: 2, title: '第2集', sceneIds: ['s2'], source: 'structure' },
      ]);
    if (method === 'roughCut.get')
      return Promise.resolve({ sequence: stored, unavailableClipIds: [] });
    if (method === 'roughCut.save') {
      stored = { ...stored, ...params, rowVersion: stored.rowVersion + 1 };
      return Promise.resolve({ sequence: stored, unavailableClipIds: [] });
    }
    if (method === 'asset.mediaSource') return Promise.resolve({ path: '/fixture.mp4' });
    if (method === 'asset.list') return Promise.resolve([]);
    if (method === 'roughCut.prepare')
      return Promise.resolve({
        clips: [{ ...initial.clips[0], id: 'new', assetId: 'new-asset' }],
        missingSceneIds: [],
      });
    return Promise.resolve(undefined);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RoughCutWorkspace', () => {
  it('keeps the displayed source while the next clip has no decoded frame', async () => {
    const { container } = render(
      <RoughCutWorkspace projectId="p" writable scenes={[]} onImportHandled={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    await waitFor(() => expect(container.querySelector('.rough-cut-frame video')).toBeTruthy());
    const first = container.querySelector<HTMLVideoElement>('.rough-cut-frame video')!;
    await waitFor(() => expect(first.getAttribute('src')).toContain('video-a'));
    Object.defineProperty(first, 'readyState', { configurable: true, value: 2 });
    fireEvent.loadedMetadata(first);
    fireEvent.loadedData(first);
    const original = first.getAttribute('src');
    fireEvent.change(screen.getByLabelText('序列播放位置'), { target: { value: '4000' } });
    const displayed = [
      ...container.querySelectorAll<HTMLVideoElement>('.rough-cut-frame video'),
    ].find((element) => element.getAttribute('aria-hidden') !== 'true');
    expect(displayed?.getAttribute('src')).toBe(original);
  });

  it('does not rewind a continuous source when crossing a split', async () => {
    stored.clips = [
      { ...stored.clips[0]!, outMs: 2000 },
      { ...stored.clips[0]!, id: 'split-tail', inMs: 2000 },
    ];
    const { container } = render(
      <RoughCutWorkspace projectId="p" writable scenes={[]} onImportHandled={() => undefined} />,
    );
    await waitFor(() => expect(container.querySelector('.rough-cut-frame video')).toBeTruthy());
    const element = container.querySelector<HTMLVideoElement>('.rough-cut-frame video')!;
    await waitFor(() => expect(element.getAttribute('src')).toContain('video-a'));
    Object.defineProperty(element, 'readyState', { configurable: true, value: 2 });
    fireEvent.loadedMetadata(element);
    fireEvent.loadedData(element);
    fireEvent.click(screen.getByRole('button', { name: '播放序列' }));
    await act(async () => {
      await Promise.resolve();
    });
    element.currentTime = 2.1;
    fireEvent.timeUpdate(element);
    expect(element.currentTime).toBe(2.1);
    expect(screen.getByLabelText('序列播放位置')).toHaveValue('2100');
  });

  it('shows MP4 preparation immediately, waits for saving, and retains the output after docking remounts', async () => {
    const base = call.getMockImplementation()!;
    let accept!: () => void;
    const job = {
      id: 'mp4-export',
      format: 'mp4',
      status: 'running',
      completedClips: 0,
      totalClips: 2,
      sequenceVersion: 2,
    };
    const path = 'C:\\Synthetic Project\\exports\\rough-cut-mp4-export';
    call.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'roughCut.export.start')
        return new Promise((resolve) => {
          accept = () => resolve(job);
        });
      if (method === 'roughCut.export.get')
        return Promise.resolve({ ...job, status: 'succeeded', completedClips: 2, path });
      if (method === 'roughCut.export.reveal') return Promise.resolve({ path });
      return base(method, params) as unknown;
    });
    const props = { projectId: 'p', writable: true, scenes: [], onImportHandled: () => undefined };
    const first = render(<RoughCutWorkspace {...props} />);
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    fireEvent.change(screen.getByLabelText('粗剪序列名称'), { target: { value: '成片验证' } });
    fireEvent.click(screen.getByRole('button', { name: '导出 MP4' }));
    expect(screen.getByText('正在保存剪辑并准备 MP4导出…')).toBeInTheDocument();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'roughCut.export.start',
        { sequenceId: 'sequence', expectedRowVersion: 2, format: 'mp4' },
        expect.anything(),
      ),
    );
    expect(call.mock.calls.findIndex(([method]) => method === 'roughCut.save')).toBeLessThan(
      call.mock.calls.findIndex(([method]) => method === 'roughCut.export.start'),
    );
    accept();
    expect(await screen.findByText(`${path}\\rough-cut.mp4`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 MP4' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '打开导出文件夹' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'roughCut.export.reveal',
        { id: 'mp4-export' },
        expect.anything(),
      ),
    );
    first.unmount();
    render(<RoughCutWorkspace {...props} />);
    expect(await screen.findByText(`${path}\\rough-cut.mp4`)).toBeInTheDocument();
  });
  it('imports a numbered episode into a new sequence and preserves the previous edit', async () => {
    render(
      <RoughCutWorkspace
        projectId="p"
        writable
        scenes={[
          {
            id: 's2',
            projectId: 'p',
            title: '第二集第一场',
            position: 0,
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]}
        onImportHandled={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    fireEvent.click(screen.getByRole('button', { name: '按集导入' }));
    await waitFor(() => expect(screen.getByLabelText('选择集数')).toHaveValue('2'));
    expect(screen.getByRole('checkbox', { name: '第二集第一场' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '导入到新序列，保留当前剪辑' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '一键导入本集' }));
    await waitFor(() =>
      expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第 2 集 · 粗剪'),
    );
    expect(call).toHaveBeenCalledWith('roughCut.prepare', { sceneIds: ['s2'] }, expect.anything());
    expect(screen.getAllByRole('button', { name: /选择片段/ })).toHaveLength(1);
    expect(screen.queryByLabelText('片段属性')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'roughCut.save',
        expect.objectContaining({ name: '第 2 集 · 粗剪', sceneIds: ['s2'] }),
        expect.anything(),
      ),
    );
  });
  it('keeps episode import idempotent and lets legacy projects save an explicit numbered grouping', async () => {
    stored.sceneIds = ['s2', 'legacy-scene'];
    const props = {
      projectId: 'p',
      writable: true,
      scenes: [
        {
          id: 's2',
          projectId: 'p',
          title: '第二集第一场',
          position: 0,
          rowVersion: 0,
          createdAt: 'now',
          updatedAt: 'now',
        },
      ],
      onImportHandled: () => undefined,
    };
    render(<RoughCutWorkspace {...props} />);
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    fireEvent.click(screen.getByRole('button', { name: '按集导入' }));
    await waitFor(() => expect(screen.getByLabelText('选择集数')).toHaveValue('2'));
    fireEvent.click(screen.getByRole('button', { name: '一键导入本集' }));
    await screen.findByText(/导入 1 个视频/);
    await waitFor(() => expect(stored.sceneIds).toEqual(['s2']));
    fireEvent.click(screen.getByRole('button', { name: '按集导入' }));
    await waitFor(() => expect(screen.getByLabelText('选择集数')).toHaveValue('2'));
    fireEvent.click(screen.getByRole('button', { name: '一键导入本集' }));
    await screen.findByText(/导入 0 个视频/);
    expect(screen.getAllByRole('button', { name: /选择片段/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '按集导入' }));
    await waitFor(() => expect(screen.getByLabelText('选择集数')).toHaveValue('2'));
    fireEvent.change(screen.getByLabelText('选择集数'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('手动设置集数'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '第二集第一场' }));
    fireEvent.click(screen.getByRole('button', { name: '一键导入本集' }));
    await waitFor(() =>
      expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第 7 集 · 粗剪'),
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'roughCut.save',
        expect.objectContaining({ name: '第 7 集 · 粗剪', sceneIds: ['s2'] }),
        expect.anything(),
      ),
    );
  });
  it('serializes autosaves and waits for the latest edit when docking remounts the view', async () => {
    const base = call.getMockImplementation()!;
    let finishFirst!: () => void;
    let first = true;
    call.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'roughCut.save' && first) {
        first = false;
        return new Promise((resolve) => {
          finishFirst = () => {
            stored = { ...stored, ...params, rowVersion: stored.rowVersion + 1 };
            resolve({ sequence: stored, unavailableClipIds: [] });
          };
        });
      }
      return base(method, params) as unknown;
    });
    const props = { projectId: 'p', writable: true, scenes: [], onImportHandled: () => undefined };
    const firstView = render(<RoughCutWorkspace {...props} />);
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    fireEvent.change(screen.getByLabelText('粗剪序列名称'), { target: { value: '编辑一' } });
    await waitFor(() => expect(finishFirst).toBeDefined(), { timeout: 2000 });
    fireEvent.change(screen.getByLabelText('粗剪序列名称'), { target: { value: '编辑二' } });
    firstView.unmount();
    render(<RoughCutWorkspace {...props} />);
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.save')).toHaveLength(1);
    finishFirst();
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('编辑二'));
    const saves = call.mock.calls.filter(([method]) => method === 'roughCut.save');
    expect(saves).toHaveLength(2);
    expect(saves[1]?.[1]).toMatchObject({ name: '编辑二', expectedRowVersion: 2 });
  });
  it('keeps properties collapsed while selecting, editing and reordering; saves without mutating sources', async () => {
    render(
      <RoughCutWorkspace projectId="p" writable scenes={[]} onImportHandled={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    expect(screen.getByRole('button', { name: '属性' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('complementary', { name: '片段属性' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择片段 1 第一镜' }));
    expect(screen.queryByLabelText('片段入点')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '属性' }));
    fireEvent.change(screen.getByLabelText('片段入点'), { target: { value: '0.75' } });
    fireEvent.click(screen.getByRole('button', { name: '收起片段属性' }));
    fireEvent.click(screen.getByRole('button', { name: '向后移动片段' }));
    await waitFor(
      () =>
        expect(call).toHaveBeenCalledWith(
          'roughCut.save',
          expect.objectContaining({
            expectedRowVersion: 1,
            clips: [
              expect.objectContaining({ id: 'two' }),
              expect.objectContaining({ id: 'one', inMs: 750 }),
            ],
          }),
          expect.objectContaining({ projectId: 'p' }),
        ),
      { timeout: 2000 },
    );
    expect(screen.getByRole('button', { name: '属性' })).toHaveAttribute('aria-expanded', 'false');
    expect(initial.clips[0]?.inMs).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '撤销粗剪' }));
    expect(screen.getByRole('button', { name: '选择片段 1 第一镜' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重做粗剪' }));
    expect(screen.getByRole('button', { name: '选择片段 1 第二镜' })).toBeInTheDocument();
  });
  it('rejects foreign drops and consumes a library import exactly once', async () => {
    const handled = vi.fn();
    const props = { projectId: 'p', writable: true, scenes: [], onImportHandled: handled };
    const { rerender } = render(<RoughCutWorkspace {...props} />);
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    fireEvent.drop(screen.getByText('时间线').parentElement!.parentElement!, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'text/plain'
            ? JSON.stringify({
                version: 1,
                projectId: 'other',
                assets: [{ id: 'foreign', kind: 'scene-video' }],
              })
            : '',
      },
    });
    expect(await screen.findByText('Error: 只能拖入当前项目的素材。')).toBeInTheDocument();
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.prepare')).toHaveLength(0);
    rerender(
      <RoughCutWorkspace
        {...props}
        importRequest={{ projectId: 'p', token: 1, assetIds: ['new-asset'] }}
      />,
    );
    await waitFor(() => expect(handled).toHaveBeenCalledWith(1));
    rerender(
      <RoughCutWorkspace
        {...props}
        importRequest={{ projectId: 'p', token: 1, assetIds: ['new-asset'] }}
      />,
    );
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.prepare')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '选择片段 3 第一镜' })).toBeInTheDocument();
  });
  it('disables edits in read-only projects while allowing property inspection', async () => {
    render(
      <RoughCutWorkspace
        projectId="p"
        writable={false}
        scenes={[]}
        onImportHandled={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('粗剪序列名称')).toHaveValue('第一集'));
    fireEvent.click(screen.getByRole('button', { name: '选择片段 1 第一镜' }));
    fireEvent.click(screen.getByRole('button', { name: '属性' }));
    expect(screen.getByLabelText('片段入点')).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除片段' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出 MP4' })).toBeDisabled();
  });
});
