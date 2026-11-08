import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShotContinuityContext } from '@ai-video/contracts';
import { ShotContinuityPanel } from './ShotContinuityPanel';
import { callWorker } from './worker-client';
import { streamPreparedLlmGeneration } from './llm-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./llm-client', () => ({ streamPreparedLlmGeneration: vi.fn() }));
vi.mock('./dubbing/media', () => ({
  useDubbingMedia: () => ({ src: 'https://local.invalid/previous.mp4' }),
}));
vi.mock('./AssetImagePreview', () => ({
  AssetImagePreview: ({ asset }: { asset: { id: string } }) => <span>{asset.id}</span>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const image = {
  id: 'frame',
  projectId: 'project',
  kind: 'first-frame',
  relativePath: 'frame.png',
  contentHash: 'hash',
  sizeBytes: 100,
  createdAt: 'now',
};
const base: ShotContinuityContext = {
  shotId: 'next',
  rowVersion: 0,
  stale: false,
  images: [],
  previousShot: {
    id: 'previous',
    sceneId: 'scene',
    title: '桥上',
    position: 0,
    status: 'draft',
    rowVersion: 0,
    createdAt: 'now',
    updatedAt: 'now',
  },
  videos: [{ ...image, id: 'video', kind: 'shot-video', relativePath: 'previous.mp4' }],
};
const confirmed: ShotContinuityContext = {
  ...base,
  rowVersion: 1,
  images: [image],
  binding: {
    sourceShotId: 'previous',
    sourceVideoAssetId: 'video',
    sourceVideoHash: 'hash',
    targetRowVersion: 0,
    mode: 'continue',
    notes: '',
    frames: [{ assetId: 'frame', timeMs: 1000 }],
    anchorAssetId: 'frame',
    firstFrameAssetId: 'frame',
  },
};
function fixture(initial = base) {
  let state = structuredClone(initial);
  const onGenerate = vi.fn<(mode: 'image', context: ShotContinuityContext) => void>();
  const onAskAgent = vi.fn<(context: ShotContinuityContext) => Promise<void> | void>();
  vi.mocked(callWorker).mockImplementation(async (method, params) => {
    await Promise.resolve();
    if (method === 'shot.continuity.get') return state;
    if (method === 'asset.list') return [...props.assets, ...base.videos];
    if (method === 'shot.continuity.probe')
      return { durationMs: 2000, fps: 25, sourceToken: 'a'.repeat(64) };
    if (method === 'shot.continuity.preview')
      return {
        dataUrl: 'data:image/jpeg;base64,/9j/',
        timeMs: (params as { timeMs: number }).timeMs,
        sourceToken: 'a'.repeat(64),
        durationMs: 2000,
        fps: 25,
      };
    if (method === 'shot.continuity.selection.confirm') {
      state = {
        ...structuredClone(confirmed),
        binding: { ...confirmed.binding!, mode: 'reference', firstFrameAssetId: undefined },
      };
      return state;
    }
    if (method === 'shot.continuity.reconfirm') {
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        stale: false,
        reconfirmable: false,
      };
      return state;
    }
    const values = params as {
      notes?: string;
      prompt?: string;
      assetId?: string;
      role?: 'reference' | 'first-frame';
    };
    if (method === 'shot.continuity.intent.save') {
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        binding: { ...state.binding!, notes: values.notes!, imagePrompt: undefined },
      };
      return state;
    }
    if (method === 'shot.continuity.prompt.save') {
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        binding: { ...state.binding!, imagePrompt: values.prompt },
      };
      return state;
    }
    if (method === 'shot.continuity.reference') {
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        binding: {
          ...state.binding!,
          referenceAssetId: values.assetId,
          referenceRole: values.role,
          firstFrameAssetId: values.role === 'first-frame' ? values.assetId : undefined,
        },
      };
      return state;
    }
    if (method === 'shot.continuity.references') {
      const selected = params as { assetIds: string[]; firstFrameAssetId?: string };
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        binding: {
          ...state.binding!,
          referenceAssetId: undefined,
          referenceRole: undefined,
          referenceAssetIds: selected.assetIds.filter((id) => id !== selected.firstFrameAssetId),
          firstFrameAssetId: selected.firstFrameAssetId,
        },
      };
      return state;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const props = {
    projectId: 'project',
    shotId: 'next',
    writable: true,
    sourceDirty: false,
    assets: [image, { ...image, id: 'new-composition' }],
    llm: { providerProfileId: 'profile', modelId: 'model', name: '视觉模型', vision: true },
    onChange: vi.fn<(context: ShotContinuityContext) => void>(),
    onGenerate,
    onAskAgent,
  };
  return {
    props,
    onGenerate,
    onAskAgent,
    setState: (next: ShotContinuityContext) => {
      state = next;
    },
  };
}

describe('manual continuity workflow', () => {
  it('lets the user explicitly keep selected frames after only the shot prompt changes', async () => {
    const f = fixture({
      ...confirmed,
      currentShotRowVersion: 2,
      stale: true,
      reconfirmable: true,
      binding: { ...confirmed.binding!, imagePrompt: '沿用原图片提示词。' },
    });
    render(<ShotContinuityPanel {...f.props} />);
    const accept = await screen.findByRole('button', { name: '确认沿用现有选帧' });
    fireEvent.click(accept);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('shot.continuity.reconfirm', {
        shotId: 'next',
        expectedRowVersion: 1,
        expectedTargetRowVersion: 2,
      }),
    );
    expect(await screen.findByText('已确认沿用现有选帧，可以填充本镜视频表单。')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '填充参考图生图表单' })).toBeEnabled(),
    );
  });

  it('requires explicit video, frame and anchor selection and does not generate automatically', async () => {
    const f = fixture();
    render(<ShotContinuityPanel {...f.props} />);
    const videos = await screen.findByLabelText('上一镜头推荐视频');
    expect(videos).toHaveValue('');
    fireEvent.change(videos, { target: { value: 'video' } });
    const player = screen.getByLabelText('选帧播放器');
    Object.defineProperty(player, 'duration', { value: 2, configurable: true });
    fireEvent.loadedMetadata(player);
    fireEvent.click(screen.getByText('添加此画面'));
    const radio = await screen.findByRole('radio');
    expect(radio).not.toBeChecked();
    expect(screen.getByText('确认所选画面')).toBeDisabled();
    fireEvent.click(radio);
    fireEvent.click(screen.getByText('确认所选画面'));
    await screen.findByText('已确认的衔接');
    expect(callWorker).toHaveBeenCalledWith(
      'shot.continuity.selection.confirm',
      expect.objectContaining({ frames: [expect.objectContaining({ videoAssetId: 'video' })] }),
    );
    expect(f.onAskAgent).not.toHaveBeenCalled();
    expect(streamPreparedLlmGeneration).not.toHaveBeenCalled();
    expect(screen.queryByText('保存并制作衔接视频')).not.toBeInTheDocument();
  });

  it('saves the explicit intent then hands off to the existing Agent without starting another LLM', async () => {
    const f = fixture(confirmed);
    render(<ShotContinuityPanel {...f.props} />);
    fireEvent.change(await screen.findByLabelText('参考图生成要求'), {
      target: { value: '转身后的侧面中景，作为中间画面参考。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '交给 Agent 编写参考图提示词' }));
    await waitFor(() =>
      expect(f.onAskAgent.mock.calls.at(-1)?.[0]?.binding?.notes).toBe(
        '转身后的侧面中景，作为中间画面参考。',
      ),
    );
    expect(f.onAskAgent.mock.calls.at(-1)?.[0]?.rowVersion).toBe(2);
    expect(f.onGenerate).not.toHaveBeenCalled();
    expect(streamPreparedLlmGeneration).not.toHaveBeenCalled();
  });

  it('supports hand-written image prompts without an LLM and fills image production only', async () => {
    const f = fixture(confirmed);
    render(<ShotContinuityPanel {...f.props} llm={undefined} />);
    fireEvent.change(await screen.findByLabelText('参考图图片提示词'), {
      target: { value: '人工提示词：人物已转身，侧面中景。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '填充参考图生图表单' }));
    await waitFor(() =>
      expect(f.onGenerate.mock.calls.at(-1)?.[1]?.binding?.imagePrompt).toBe(
        '人工提示词：人物已转身，侧面中景。',
      ),
    );
    expect(f.onGenerate.mock.calls.at(-1)?.[0]).toBe('image');
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'shot.continuity.prompt.save')[0]?.[1],
    ).toMatchObject({ kind: 'image' });
  });

  it('selects multiple output images, changes the explicit first frame and clears without silently saving', async () => {
    const f = fixture({
      ...confirmed,
      binding: { ...confirmed.binding!, mode: 'reference', firstFrameAssetId: undefined },
    });
    render(<ShotContinuityPanel {...f.props} />);
    fireEvent.change(await screen.findByLabelText('添加本镜头图片'), {
      target: { value: 'new-composition' },
    });
    fireEvent.change(screen.getByLabelText('添加本镜头图片'), { target: { value: 'frame' } });
    expect(callWorker).not.toHaveBeenCalledWith('shot.continuity.references', expect.anything());
    fireEvent.change(screen.getByLabelText('本镜头首帧'), { target: { value: 'new-composition' } });
    fireEvent.click(screen.getByText('确认绑定图片'));
    await waitFor(() =>
      expect(f.props.onChange.mock.calls.at(-1)?.[0]?.binding?.firstFrameAssetId).toBe(
        'new-composition',
      ),
    );
    expect(f.props.onChange.mock.calls.at(-1)?.[0]?.binding?.referenceAssetIds).toEqual(['frame']);
    fireEvent.click(screen.getByText('移除图片 2'));
    fireEvent.click(screen.getByText('移除图片 1'));
    fireEvent.click(screen.getByText('确认绑定图片'));
    await waitFor(() =>
      expect(f.props.onChange.mock.calls.at(-1)?.[0]?.binding?.referenceAssetId).toBeUndefined(),
    );
    expect(f.props.onChange.mock.calls.at(-1)?.[0]?.binding?.firstFrameAssetId).toBeUndefined();
  });

  it('shows saved Agent output on refresh and preserves newer unsaved manual edits', async () => {
    const f = fixture(confirmed);
    const view = render(<ShotContinuityPanel {...f.props} revision={0} />);
    await screen.findByLabelText('参考图图片提示词');
    f.setState({
      ...confirmed,
      rowVersion: 2,
      binding: { ...confirmed.binding!, imagePrompt: 'Agent 保存的静态参考图提示词' },
    });
    view.rerender(<ShotContinuityPanel {...f.props} revision={1} />);
    await waitFor(() =>
      expect(screen.getByLabelText('参考图图片提示词')).toHaveValue('Agent 保存的静态参考图提示词'),
    );
    fireEvent.change(screen.getByLabelText('参考图图片提示词'), {
      target: { value: '用户正在编辑' },
    });
    f.setState({
      ...confirmed,
      rowVersion: 3,
      binding: { ...confirmed.binding!, imagePrompt: '迟到的 Agent 输出' },
    });
    view.rerender(<ShotContinuityPanel {...f.props} revision={2} />);
    await waitFor(() =>
      expect(f.props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rowVersion: 3 })),
    );
    expect(screen.getByLabelText('参考图图片提示词')).toHaveValue('用户正在编辑');
  });

  it('blocks stale, read-only and unsaved inputs, and requires vision for Agent handoff', async () => {
    const f = fixture(confirmed);
    const view = render(
      <ShotContinuityPanel {...f.props} llm={{ ...f.props.llm, vision: false }} />,
    );
    expect(
      await screen.findByRole('button', { name: '交给 Agent 编写参考图提示词' }),
    ).toBeDisabled();
    view.rerender(<ShotContinuityPanel {...f.props} sourceDirty />);
    expect(screen.getByRole('button', { name: '填充参考图生图表单' })).toBeDisabled();
    view.rerender(<ShotContinuityPanel {...f.props} writable={false} />);
    expect(screen.getByLabelText('添加本镜头图片')).toBeDisabled();
  });
});
