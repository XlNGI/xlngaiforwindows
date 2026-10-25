import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
  AdapterParameters,
  ProductionCompileResult,
  ProductionSource,
  ProductionTarget,
  ProductionCompileParams,
} from '@ai-video/contracts';
import { useProductionAuthoring } from './use-production-authoring';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const adapter = {
  key: 'model-a',
  parameterSchema: {
    properties: {
      prompt: { type: 'string' },
      duration: { type: 'integer' },
      resolution: { type: 'string' },
      ratio: { type: 'string' },
    },
  },
} as unknown as AdapterDescriptor;
const target: ProductionTarget = { kind: 'scene', id: 'scene-a' };
const source: ProductionSource = {
  target,
  mode: 'form',
  token: 'a'.repeat(64),
};
const compiled = (patch: Partial<ProductionCompileResult> = {}): ProductionCompileResult => ({
  target,
  rowVersion: 1,
  source,
  issues: [],
  parameters: { prompt: '系统填入', duration: 5 },
  ...patch,
});
function useForm(
  props: { target?: ProductionTarget; adapter?: AdapterDescriptor; ready?: boolean } = {},
) {
  const [parameters, setParameters] = useState<AdapterParameters>({ resolution: '720P' });
  const state = useProductionAuthoring({
    projectId: 'project',
    target: props.target ?? target,
    adapter: props.adapter ?? adapter,
    providerKey: 'provider',
    ready: props.ready ?? true,
    setParameters,
  });
  return {
    ...state,
    parameters,
    edit: (field: string, value: string | number) => {
      state.changed(field, value);
      setParameters((current) => ({ ...current, [field]: value }));
    },
  };
}
describe('production form local compilation', () => {
  it('fills the newly confirmed continuity prompt instead of an old saved form, while retaining other preferences', async () => {
    const selectedAdapter = {
      ...adapter,
      parameterSchema: {
        ...adapter.parameterSchema,
        properties: {
          ...adapter.parameterSchema.properties,
          images: { type: 'array', title: '图片' },
        },
      },
    } as AdapterDescriptor;
    vi.mocked(callWorker).mockResolvedValue(
      compiled({
        parameters: {
          prompt: '已确认的后续动作',
          images: ['project-asset://confirmed-frame'],
          duration: 5,
        },
        continuity: {
          shotId: 'shot',
          rowVersion: 2,
          binding: {
            sourceShotId: 'previous',
            sourceVideoAssetId: 'video',
            sourceVideoHash: 'hash',
            targetRowVersion: 1,
            mode: 'continue',
            notes: '',
            frames: [{ assetId: 'confirmed-frame', timeMs: 1000 }],
            anchorAssetId: 'confirmed-frame',
            firstFrameAssetId: 'confirmed-frame',
            videoPrompt: '已确认的后续动作',
          },
        },
      }),
    );
    const { result } = renderHook(() => {
      const [parameters, setParameters] = useState<AdapterParameters>({});
      const state = useProductionAuthoring({
        projectId: 'project',
        target: { kind: 'shot', id: 'shot' },
        adapter: selectedAdapter,
        providerKey: 'provider',
        ready: true,
        setParameters,
        initialOverrides: {
          prompt: '旧草稿',
          images: ['project-asset://old'],
          resolution: '1080P',
        },
      });
      return { state, parameters };
    });
    await waitFor(() => expect(result.current.parameters.prompt).toBe('已确认的后续动作'));
    expect(result.current.parameters.images).toEqual(['project-asset://confirmed-frame']);
    expect(result.current.parameters.resolution).toBe('1080P');
  });
  it.each([
    { inputImages: [] },
    { inputImages: [{ assetId: 'selected-frame', role: 'first-frame' as const }] },
  ])(
    'keeps image-selection provenance without recompiling the submitted form (%j)',
    async ({ inputImages }) => {
      const token = 'b'.repeat(64);
      vi.mocked(callWorker).mockImplementation((method, params) => {
        if (method !== 'production.compile') return Promise.resolve(compiled());
        const request = params as ProductionCompileParams;
        const selected = JSON.stringify(request.inputImages) === JSON.stringify(inputImages);
        if (request.expectedToken && request.expectedToken !== (selected ? token : source.token))
          return Promise.reject(new Error('制作来源已变化，请重新适配。'));
        return Promise.resolve(
          compiled({ source: { ...source, inputImages, token: selected ? token : source.token } }),
        );
      });
      const { result } = renderHook(() => {
        const [parameters, setParameters] = useState<AdapterParameters>({});
        return {
          ...useProductionAuthoring({
            projectId: 'project',
            target,
            adapter,
            providerKey: 'provider',
            ready: true,
            setParameters,
            inputImages,
          }),
          parameters,
        };
      });
      await waitFor(() => expect(result.current.result?.source?.token).toBe(token));
      act(() => {
        window.dispatchEvent(new Event('production-source-updated'));
      });
      await waitFor(() =>
        expect(
          vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'production.compile'),
        ).toHaveLength(2),
      );
      await expect(result.current.beforeSubmit()).resolves.toEqual({
        ...source,
        mode: 'form',
        inputImages,
        token,
      });
      const calls = vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'production.compile');
      expect(calls).toHaveLength(2);
      for (const [, request] of calls)
        expect((request as ProductionCompileParams).inputImages).toEqual(inputImages);
    },
  );
  it('refills authoritative structured inputs without appending the previous images again', async () => {
    const contentAdapter = {
      ...adapter,
      parameterSchema: {
        ...adapter.parameterSchema,
        properties: { content: { type: 'array', title: '内容', items: { type: 'object' } } },
      },
    } as AdapterDescriptor;
    const content: import('@ai-video/contracts').AdapterParameterValue[] = [
      { type: 'text', text: '雨夜' },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: 'https://example.com/actor.png' },
      },
    ];
    vi.mocked(callWorker).mockResolvedValue(compiled({ parameters: { content } }));
    const { result } = renderHook(() => useForm({ adapter: contentAdapter }));
    await waitFor(() => expect(result.current.parameters.content).toEqual(content));
    act(() => result.current.refill());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parameters.content).toEqual(content);
  });
  it('shows model adaptation notices without blocking and removes fields outside the selected schema', async () => {
    vi.mocked(callWorker).mockResolvedValue(
      compiled({
        parameters: { prompt: '保留剧情与声音描述', duration: 8, old_model_only: true },
        notices: [{ code: 'MODEL_PARAMETER_NOT_APPLIED', message: '当前模型不传入扩写设置' }],
      }),
    );
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parameters.prompt).toBe('保留剧情与声音描述');
    expect(result.current.parameters).not.toHaveProperty('old_model_only');
    expect(result.current.result?.notices).toHaveLength(1);
    await expect(result.current.beforeSubmit()).resolves.toEqual({ ...source, mode: 'form' });
  });
  it('projects a changed model schema while preserving each model manual values', async () => {
    const first: AdapterDescriptor = {
      ...adapter,
      parameterSchema: {
        ...adapter.parameterSchema,
        properties: {
          prompt: { type: 'string' as const, title: '提示词' },
          duration: { type: 'integer' as const, title: '时长' },
          audio: { type: 'boolean' as const, title: '声音' },
        },
      },
    };
    const second: AdapterDescriptor = {
      ...adapter,
      key: 'model-b',
      parameterSchema: {
        ...adapter.parameterSchema,
        properties: {
          prompt: { type: 'string' as const, title: '提示词' },
          duration: { type: 'integer' as const, title: '时长' },
        },
      },
    };
    vi.mocked(callWorker).mockImplementation((method, params) =>
      Promise.resolve(
        compiled({
          parameters:
            (params as { adapterKey: string }).adapterKey === first.key
              ? { prompt: '模型一', duration: 5, audio: true }
              : { prompt: '模型二', duration: 8 },
        }),
      ),
    );
    const { result, rerender } = renderHook(({ selected }) => useForm({ adapter: selected }), {
      initialProps: { selected: first },
    });
    await waitFor(() => expect(result.current.parameters.audio).toBe(true));
    act(() => result.current.edit('prompt', '模型一人工稿'));
    rerender({ selected: second });
    await waitFor(() => expect(result.current.parameters.prompt).toBe('模型二'));
    expect(result.current.parameters).not.toHaveProperty('audio');
    rerender({ selected: first });
    await waitFor(() => expect(result.current.parameters.prompt).toBe('模型一人工稿'));
    expect(result.current.parameters.audio).toBe(true);
  });
  it('shows the entire scene and derived parameters even when the selected model needs separate production segments', async () => {
    vi.mocked(callWorker).mockResolvedValue(
      compiled({
        compiledPrompt: '镜头01：观察\n镜头02：决定离开',
        estimatedDurationSeconds: 23,
        parameters: { prompt: '镜头01：观察\n镜头02：决定离开', ratio: '9:16' },
        issues: [{ code: 'SCENE_REQUIRES_SEGMENTS', message: '完整场次超过当前模型单次能力' }],
      }),
    );
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.parameters.prompt).toContain('镜头02：决定离开'));
    expect(result.current.parameters.ratio).toBe('9:16');
    expect(result.current.result?.estimatedDurationSeconds).toBe(23);
    act(() => {
      result.current.edit('prompt', '用户重新安排的一段动作');
      result.current.edit('duration', 5);
    });
    await expect(result.current.beforeSubmit()).resolves.toEqual({ ...source, mode: 'form' });
    expect(result.current.parameters).toMatchObject({
      prompt: '用户重新安排的一段动作',
      duration: 5,
    });
  });
  it('fills automatically, preserves a manual edit arriving before compilation, and clears it only on explicit refill', async () => {
    let resolve!: (value: ProductionCompileResult) => void;
    vi.mocked(callWorker).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }) as never,
    );
    const { result } = renderHook(() => useForm());
    act(() => result.current.edit('prompt', '人工修改'));
    await act(async () => {
      resolve(compiled());
      await Promise.resolve();
    });
    expect(result.current.parameters).toEqual({
      prompt: '人工修改',
      duration: 5,
      resolution: '720P',
    });
    vi.mocked(callWorker).mockResolvedValue(compiled());
    act(() => result.current.refill());
    await waitFor(() => expect(result.current.parameters.prompt).toBe('系统填入'));
    expect(callWorker).toHaveBeenCalledWith('production.compile', {
      target,
      adapterKey: 'model-a',
    });
    expect(
      vi.mocked(callWorker).mock.calls.every(([method]) => method === 'production.compile'),
    ).toBe(true);
  });
  it('ignores a late result for a previous target and restores overrides when switching back', async () => {
    let oldResolve!: (value: ProductionCompileResult) => void;
    vi.mocked(callWorker)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            oldResolve = done;
          }) as never,
      )
      .mockResolvedValue(
        compiled({
          target: { kind: 'scene', id: 'scene-b' },
          parameters: { prompt: '第二场' },
        }),
      );
    const { result, rerender } = renderHook(({ selected }) => useForm({ target: selected }), {
      initialProps: { selected: target },
    });
    act(() => result.current.edit('prompt', '第一场人工稿'));
    rerender({ selected: { kind: 'scene', id: 'scene-b' } });
    await waitFor(() => expect(result.current.parameters.prompt).toBe('第二场'));
    await act(async () => {
      oldResolve(compiled({ parameters: { prompt: '旧异步结果' } }));
      await Promise.resolve();
    });
    expect(result.current.parameters.prompt).toBe('第二场');
    vi.mocked(callWorker).mockResolvedValue(compiled());
    rerender({ selected: target });
    await waitFor(() => expect(result.current.parameters.prompt).toBe('第一场人工稿'));
  });
  it('reports source changes without blocking the final form or recompiling on submission', async () => {
    vi.mocked(callWorker).mockResolvedValue(compiled());
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.result?.source).toEqual(source));
    act(() => result.current.edit('prompt', '只有江晚与老瞎子的镜头'));
    await expect(result.current.beforeSubmit()).resolves.toEqual({ ...source, mode: 'form' });
    vi.mocked(callWorker).mockResolvedValue(
      compiled({ source: { ...source, token: 'b'.repeat(64) } }),
    );
    await expect(result.current.beforeSubmit()).resolves.toEqual({ ...source, mode: 'form' });
    expect(callWorker).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('production-source-updated'));
    });
    await waitFor(() => expect(result.current.error).toContain('已保留当前表单'));
    expect(result.current.parameters.prompt).toBe('只有江晚与老瞎子的镜头');
    await expect(result.current.beforeSubmit()).resolves.toMatchObject({
      mode: 'form',
      token: 'b'.repeat(64),
    });
  });
  it('shows stale dependency details after an update event without overwriting manual form edits', async () => {
    vi.mocked(callWorker).mockResolvedValue(compiled());
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.result?.source).toEqual(source));
    act(() => result.current.edit('prompt', '保留我的表单修改'));
    const issue = {
      code: 'INVALID_IR_REFERENCE',
      message: '「入场」引用的资料林澈已有新版本',
      target: { kind: 'shot' as const, id: 'shot' },
      targetTitle: '入场',
    };
    vi.mocked(callWorker).mockResolvedValue(
      compiled({
        source: { ...source, token: 'b'.repeat(64) },
        parameters: { prompt: '新编译内容' },
        issues: [issue],
      }),
    );
    act(() => {
      window.dispatchEvent(new Event('production-source-updated'));
    });
    await waitFor(() => expect(result.current.result?.issues).toEqual([issue]));
    expect(result.current.parameters.prompt).toBe('保留我的表单修改');
    await expect(result.current.beforeSubmit()).resolves.toMatchObject({ mode: 'form' });
    vi.mocked(callWorker).mockResolvedValue(
      compiled({ source: { ...source, token: 'c'.repeat(64) } }),
    );
    act(() => result.current.refreshKeepingEdits());
    await waitFor(() => expect(result.current.result?.source?.token).toBe('c'.repeat(64)));
    expect(result.current.parameters.prompt).toBe('保留我的表单修改');
    await expect(result.current.beforeSubmit()).resolves.toMatchObject({ token: 'c'.repeat(64) });
  });
  it('keeps continuity warnings advisory and supports targets without structured instructions', async () => {
    vi.mocked(callWorker).mockResolvedValue(
      compiled({
        issues: [
          { code: 'INVALID_IR_REFERENCE', message: '沈孤鸿状态缺少前置证据' },
          { code: 'PARAMETER_CONFLICT', message: '江晚外观锁定值发生变化' },
        ],
      }),
    );
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parameters.prompt).toBe('系统填入');
    act(() => result.current.edit('prompt', '江晚继续打铁，老瞎子离去'));
    await expect(result.current.beforeSubmit()).resolves.toEqual({ ...source, mode: 'form' });
    expect(result.current.parameters.prompt).not.toContain('沈孤鸿');
    vi.mocked(callWorker).mockResolvedValue(
      compiled({ source: undefined, parameters: {}, issues: [] }),
    );
    act(() => result.current.refill());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.result?.source).toBeUndefined());
    await expect(result.current.beforeSubmit()).resolves.toBeUndefined();
  });
  it('allows a completed manual form when instruction compilation is unavailable', async () => {
    vi.mocked(callWorker).mockRejectedValue(new Error('制作说明暂时不可用'));
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('制作说明暂时不可用');
    act(() => result.current.edit('prompt', '手工填写的镜头'));
    await expect(result.current.beforeSubmit()).resolves.toBeUndefined();
    expect(result.current.parameters.prompt).toBe('手工填写的镜头');
  });
});
