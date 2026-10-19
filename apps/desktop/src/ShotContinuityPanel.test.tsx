import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const onGenerate = vi.fn();
  vi.mocked(callWorker).mockImplementation(async (method, params) => {
    await Promise.resolve();
    if (method === 'shot.continuity.get') return state;
    if (method === 'shot.continuity.preview')
      return {
        dataUrl: 'data:image/jpeg;base64,/9j/',
        timeMs: 1000,
        sourceToken: 'a'.repeat(64),
        durationMs: 2000,
        fps: 25,
      };
    if (method === 'shot.continuity.confirm') {
      state = structuredClone(confirmed);
      return state;
    }
    if (method === 'shot.continuity.prompt.prepare')
      return { generation: {}, stream: { generationId: 'llm' } } as never;
    if (method === 'shot.continuity.prompt.save') {
      const values = params as { kind: string; prompt: string };
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        binding: {
          ...state.binding!,
          [values.kind === 'image' ? 'imagePrompt' : 'videoPrompt']: values.prompt,
        },
      };
      return state;
    }
    if (method === 'shot.continuity.firstFrame') {
      state = {
        ...state,
        rowVersion: state.rowVersion + 1,
        binding: { ...state.binding!, firstFrameAssetId: (params as { assetId: string }).assetId },
      };
      return state;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  vi.mocked(streamPreparedLlmGeneration).mockImplementation((_prepared, callbacks) => ({
    identity: {} as never,
    completion: Promise.resolve().then(() =>
      callbacks.onState({
        status: 'complete',
        assistantMessage: { content: '保持桥柱旁站位，缓慢转头。' },
      } as never),
    ),
    cancel: vi.fn(),
    detach: vi.fn(),
  }));
  const props = {
    projectId: 'project',
    shotId: 'next',
    writable: true,
    sourceDirty: false,
    assets: [image, { ...image, id: 'new-composition' }],
    llm: { providerProfileId: 'profile', modelId: 'model', name: '视觉模型', vision: true },
    onChange: vi.fn(),
    onGenerate,
  };
  return {
    props,
    onGenerate,
    setState: (next: ShotContinuityContext) => {
      state = next;
    },
  };
}

describe('manual continuity workflow', () => {
  it('requires manual video, frame and anchor selection before confirmation or any LLM call', async () => {
    const f = fixture();
    render(<ShotContinuityPanel {...f.props} />);
    const videos = await screen.findByLabelText('上一镜头视频');
    expect((videos as HTMLSelectElement).value).toBe('');
    expect(
      vi.mocked(callWorker).mock.calls.some(([method]) => method.includes('prompt.prepare')),
    ).toBe(false);
    fireEvent.change(videos, { target: { value: 'video' } });
    const player = screen.getByLabelText('上一镜头选帧播放器');
    Object.defineProperty(player, 'duration', { value: 2, configurable: true });
    fireEvent.loadedMetadata(player);
    fireEvent.click(screen.getByText('添加此画面'));
    const radio = await screen.findByRole('radio');
    expect((radio as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText<HTMLButtonElement>('确认所选画面').disabled).toBe(true);
    fireEvent.click(radio);
    fireEvent.click(screen.getByText('确认所选画面'));
    await screen.findByText('已确认的衔接');
    expect(streamPreparedLlmGeneration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('LLM 生成后续视频提示词'));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>('衔接视频提示词').value).toContain(
        '缓慢转头',
      ),
    );
    expect(f.onGenerate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('衔接视频提示词'), {
      target: { value: '人工修改：人物只转头。' },
    });
    fireEvent.click(screen.getByText('保存并制作衔接视频'));
    await waitFor(() => expect(f.onGenerate).toHaveBeenCalledOnce());
    expect(f.onGenerate.mock.calls[0]?.[0]).toBe('video');
    expect(f.onGenerate.mock.calls[0]?.[1]).toMatchObject({
      binding: { videoPrompt: '人工修改：人物只转头。' },
    });
  });

  it('requires final image adoption when reframing before enabling video prompting', async () => {
    const f = fixture({
      ...confirmed,
      binding: { ...confirmed.binding!, mode: 'reframe', firstFrameAssetId: undefined },
    });
    render(<ShotContinuityPanel {...f.props} />);
    const button = await screen.findByText('LLM 生成后续视频提示词');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('确认下一视频首帧'), {
      target: { value: 'new-composition' },
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(streamPreparedLlmGeneration).not.toHaveBeenCalled();
  });

  it('discards a late LLM result after the confirmed source changes', async () => {
    const f = fixture(confirmed);
    let finish!: () => void;
    vi.mocked(streamPreparedLlmGeneration).mockImplementation((_prepared, callbacks) => ({
      identity: {} as never,
      completion: new Promise<void>((resolve) => {
        finish = () => {
          callbacks.onState({
            status: 'complete',
            assistantMessage: { content: '迟到提示词' },
          } as never);
          resolve();
        };
      }),
      cancel: vi.fn(),
      detach: vi.fn(),
    }));
    render(<ShotContinuityPanel {...f.props} />);
    fireEvent.click(await screen.findByText('LLM 生成后续视频提示词'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    f.setState({ ...confirmed, rowVersion: 2 });
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await screen.findByText(/旧提示词未采用/u);
    expect(screen.getByLabelText<HTMLTextAreaElement>('衔接视频提示词').value).toBe('');
  });

  it('keeps read-only projects, unsaved story changes and text-only LLMs from generating', async () => {
    const f = fixture(confirmed);
    const view = render(
      <ShotContinuityPanel {...f.props} llm={{ ...f.props.llm, vision: false }} />,
    );
    expect((await screen.findByText<HTMLButtonElement>('LLM 生成后续视频提示词')).disabled).toBe(
      true,
    );
    view.rerender(<ShotContinuityPanel {...f.props} sourceDirty />);
    expect(screen.getByText<HTMLButtonElement>('保存并制作衔接视频').disabled).toBe(true);
    view.rerender(<ShotContinuityPanel {...f.props} writable={false} />);
    expect(screen.getByText<HTMLButtonElement>('LLM 生成后续视频提示词').disabled).toBe(true);
    expect(streamPreparedLlmGeneration).not.toHaveBeenCalled();
  });
});
