import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssetInfo, ShotImageContext, ShotImageSaveParams } from '@ai-video/contracts';
import { ShotImageWorkspace } from './ShotImageWorkspace';
import { ShotWorkspace } from './ShotWorkspace';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: (props: {
    label: string;
    value: string;
    readOnly: boolean;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={props.label}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock('./AssetImagePreview', () => ({
  AssetImagePreview: ({ asset }: { asset: AssetInfo }) => <span>{asset.id}</span>,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});
const image = (shotId: string): ShotImageContext => ({
  shotId,
  prompt: '',
  purpose: 'composition',
  intent: '',
  rowVersion: 0,
  currentSourceToken: 'a'.repeat(64),
  stale: false,
  sourceStale: false,
  inputImages: [],
  assets: [],
  videoImages: { shotId, rowVersion: 0, selections: [], conflicts: [] },
});
function fixture(id: string) {
  let state = image(id);
  let deferSave: ((next: ShotImageContext) => void) | undefined;
  vi.mocked(callWorker).mockImplementation(async (method, params) => {
    if (method === 'shot.image.get')
      return { ...state, shotId: 'shotId' in params ? params.shotId : id };
    if (method === 'shot.image.save') {
      const p = params as ShotImageSaveParams;
      if (p.expectedRowVersion !== state.rowVersion)
        throw new Error('图片提示词已更新，草稿已保留');
      state = { ...state, ...p, rowVersion: state.rowVersion + 1 };
      if (deferSave)
        return new Promise<ShotImageContext>((resolve) => {
          deferSave = resolve;
        });
      return state;
    }
    if (method === 'shot.prompt.preview')
      return { prompt: `${state.prompt}\n输入图片说明`, inputImages: state.inputImages };
    if (method === 'shot.videoImages.save') {
      const p = params as { selections: ShotImageContext['inputImages'] };
      state = {
        ...state,
        videoImages: {
          ...state.videoImages,
          rowVersion: state.videoImages.rowVersion + 1,
          selections: p.selections,
        },
      };
      return state;
    }
    if (method === 'shot.continuity.get')
      return { shotId: id, rowVersion: 0, stale: false, images: [], videos: [] };
    if (method === 'scene.media.resolve') return { characters: [], voices: [], assets: [] };
    return [];
  });
  const onFill = vi.fn(),
    onContext = vi.fn(),
    onAskAgent = vi.fn();
  const props = {
    projectId: 'project',
    shotId: id,
    writable: true,
    assets: [],
    documents: [],
    sources: <section>参考来源</section>,
    onFill,
    onContext,
    onAskAgent,
  };
  return {
    props,
    onFill,
    onContext,
    onAskAgent,
    setState: (next: ShotImageContext) => {
      state = next;
    },
    getState: () => state,
    setDeferred: () => {
      deferSave = () => undefined;
    },
    finish: () => deferSave?.(state),
  };
}
it('edits and fills a first-shot image independently with no source or video save', async () => {
  const f = fixture('no-source');
  render(<ShotImageWorkspace {...f.props} />);
  const editor = await screen.findByLabelText('本镜图片提示词');
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  expect(screen.getByRole('button', { name: '填充本镜图片表单' })).toBeDisabled();
  fireEvent.change(editor, { target: { value: '门边定格瞬间' } });
  fireEvent.change(screen.getByLabelText('图片创作目标'), { target: { value: 'last-frame' } });
  fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
  await waitFor(() => expect(f.onFill).toHaveBeenCalledOnce());
  expect(f.onFill.mock.calls[0]![0]).toMatchObject({
    prompt: '门边定格瞬间\n输入图片说明',
    purpose: 'last-frame',
    inputImages: [],
  });
  expect(callWorker).not.toHaveBeenCalledWith('shot.save', expect.anything());
  expect(callWorker).not.toHaveBeenCalledWith('shot.videoImages.save', expect.anything());
});
it('preserves each image draft on shot navigation and refuses silently overwriting another window', async () => {
  const f = fixture('draft-one');
  const view = render(<ShotImageWorkspace key="one" {...f.props} />);
  const editor = await screen.findByLabelText('本镜图片提示词');
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  fireEvent.change(editor, { target: { value: '本镜未保存草稿' } });
  view.rerender(<ShotImageWorkspace key="two" {...f.props} shotId="draft-two" />);
  await waitFor(() => expect(screen.getByLabelText('本镜图片提示词')).toHaveValue(''));
  view.rerender(<ShotImageWorkspace key="one" {...f.props} />);
  await waitFor(() =>
    expect(screen.getByLabelText('本镜图片提示词')).toHaveValue('本镜未保存草稿'),
  );
  f.setState({ ...image('draft-one'), prompt: '另一个窗口的新正文', rowVersion: 2 });
  view.rerender(<ShotImageWorkspace key="one" {...f.props} revision={1} />);
  await screen.findByText(/其他窗口已保存新版本/);
  fireEvent.click(screen.getByRole('button', { name: '保存图片提示词' }));
  await screen.findByText('图片提示词已更新，草稿已保留');
  expect(screen.getByLabelText('本镜图片提示词')).toHaveValue('本镜未保存草稿');
  expect(f.getState().prompt).toBe('另一个窗口的新正文');
});
it('does not adopt a generated result until confirmation and preserves order and explicit first-frame roles', async () => {
  const f = fixture('adoption');
  const assets = ['a', 'b'].map((id) => ({
    id,
    projectId: 'project',
    kind: 'generated-image',
    relativePath: `${id}.png`,
    contentHash: id,
    sizeBytes: 1,
    createdAt: 'now',
  }));
  render(<ShotImageWorkspace {...f.props} assets={assets} candidates={assets} />);
  await waitFor(() => expect(f.onContext).toHaveBeenCalled());
  expect(callWorker).not.toHaveBeenCalledWith('shot.videoImages.save', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: '采用 a.png' }));
  fireEvent.click(screen.getByRole('button', { name: '采用 b.png' }));
  fireEvent.change(screen.getByLabelText('图片 2 视频用途'), { target: { value: 'first-frame' } });
  const second = screen.getByLabelText('图片 2 视频用途').closest('article')!;
  fireEvent.click(within(second).getByRole('button', { name: '前移' }));
  fireEvent.click(screen.getByRole('button', { name: '确认采用图片' }));
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith('shot.videoImages.save', {
      shotId: 'adoption',
      expectedRowVersion: 0,
      selections: [
        { assetId: 'b', role: 'first-frame' },
        { assetId: 'a', role: 'reference' },
      ],
    }),
  );
  expect(f.getState().inputImages).toEqual([]);
});
it('ignores a late image save after switching the shot instead of filling the new target', async () => {
  const f = fixture('late-one');
  f.setState({ ...image('late-one'), prompt: '旧镜图片' });
  const view = render(<ShotImageWorkspace key="old" {...f.props} />);
  await waitFor(() => expect(screen.getByLabelText('本镜图片提示词')).toHaveValue('旧镜图片'));
  f.setDeferred();
  fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith('shot.image.save', expect.anything()),
  );
  view.rerender(<ShotImageWorkspace key="new" {...f.props} shotId="late-two" />);
  f.finish();
  await Promise.resolve();
  expect(f.onFill).not.toHaveBeenCalled();
});
it('explains inherited bindings and allows explicitly confirming an empty video list', async () => {
  const f = fixture('inherited-bindings');
  f.setState({
    ...image('inherited-bindings'),
    videoImages: { shotId: 'inherited-bindings', rowVersion: 0, conflicts: [] },
  });
  render(<ShotImageWorkspace {...f.props} />);
  await screen.findByText(/尚未单独确认视频图片/);
  fireEvent.click(screen.getByRole('button', { name: '确认采用图片' }));
  await waitFor(() =>
    expect(f.getState().videoImages).toMatchObject({ rowVersion: 1, selections: [] }),
  );
  expect(screen.queryByText(/尚未单独确认视频图片/)).not.toBeInTheDocument();
});
it('retains image and video drafts across tabs and defaults to the video editor', async () => {
  const f = fixture('tabs');
  let video = '视频动作流程';
  const onPromptChange = vi.fn((value: string) => {
    video = value;
  });
  const props = {
    ...f.props,
    shotTitle: '开场',
    shotStatus: 'draft',
    shotPosition: 0,
    prompt: video,
    bindings: { schemaVersion: 1 as const },
    storyboardTitle: '',
    storyboardContent: '',
    storyboardBusy: false,
    hasStoryboard: false,
    onPromptChange,
    onSavePrompt: vi.fn(),
    onGenerateImage: vi.fn(),
    onGenerateVideo: vi.fn(),
    onStoryboardTitleChange: vi.fn(),
    onStoryboardContentChange: vi.fn(),
    onSaveStoryboard: vi.fn(),
  };
  const view = render(<ShotWorkspace {...props} />);
  expect(screen.getByRole('tab', { name: '视频提示词' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: '本镜参考图' }));
  await waitFor(() =>
    expect(screen.getByLabelText('本镜图片提示词')).not.toHaveAttribute('readonly'),
  );
  fireEvent.change(screen.getByLabelText('本镜图片提示词'), { target: { value: '只画开场瞬间' } });
  fireEvent.click(screen.getByRole('tab', { name: '视频提示词' }));
  expect(screen.getByLabelText('镜头提示词')).toHaveValue('视频动作流程');
  view.rerender(<ShotWorkspace {...props} prompt="改过的视频动作" />);
  fireEvent.click(screen.getByRole('tab', { name: '本镜参考图' }));
  expect(screen.getByLabelText('本镜图片提示词')).toHaveValue('只画开场瞬间');
});
