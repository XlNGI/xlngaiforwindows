import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
  AdapterParameters,
  ProductionCompileResult,
  ProductionSource,
  ProductionTarget,
} from '@ai-video/contracts';
import { useProductionInstructions } from './use-production-instructions';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const adapter = { key: 'model-a' } as AdapterDescriptor;
const target: ProductionTarget = { kind: 'scene', id: 'scene-a' };
const source: ProductionSource = {
  target,
  instructionId: 'instruction',
  revision: 1,
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
  const state = useProductionInstructions({
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
  it('reports source changes and checks again before submission', async () => {
    vi.mocked(callWorker).mockResolvedValue(compiled());
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.result?.source).toEqual(source));
    await expect(result.current.beforeSubmit()).resolves.toEqual(source);
    vi.mocked(callWorker).mockResolvedValue(
      compiled({ source: { ...source, token: 'b'.repeat(64) } }),
    );
    await expect(result.current.beforeSubmit()).rejects.toThrow('制作来源已变化');
    act(() => {
      window.dispatchEvent(new Event('production-source-updated'));
    });
    await waitFor(() => expect(result.current.error).toContain('来源内容或素材绑定已更新'));
    await expect(result.current.beforeSubmit()).rejects.toThrow('来源内容');
  });
  it('does not fill conflicting requirements and supports legacy targets without instructions', async () => {
    vi.mocked(callWorker).mockResolvedValue(
      compiled({ issues: [{ code: 'CONFLICT', message: '剧情冲突' }] }),
    );
    const { result } = renderHook(() => useForm());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parameters.prompt).toBeUndefined();
    await expect(result.current.beforeSubmit()).rejects.toThrow('剧情冲突');
    vi.mocked(callWorker).mockResolvedValue(
      compiled({ source: undefined, parameters: {}, issues: [] }),
    );
    act(() => result.current.refill());
    await waitFor(() => expect(result.current.result?.source).toBeUndefined());
    await expect(result.current.beforeSubmit()).resolves.toBeUndefined();
  });
});
