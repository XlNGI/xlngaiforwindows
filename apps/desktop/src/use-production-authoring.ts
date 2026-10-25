import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdapterDescriptor,
  AdapterParameters,
  ProductionSource,
  ProductionTarget,
  ProductionCompileResult,
  ProductionCompileParams,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { projectProductionParameters } from '@ai-video/contracts';

function compileRequest(
  target: ProductionTarget,
  adapter: AdapterDescriptor,
  shotIds: string[] | undefined,
  inputImages: ProductionCompileParams['inputImages'],
): ProductionCompileParams {
  return {
    target,
    adapterKey: adapter.key,
    ...(shotIds ? { shotIds } : {}),
    ...(inputImages !== undefined ? { inputImages } : {}),
  };
}

/** Provider selection is user-owned. This hook only compiles a local form draft. */
export function useProductionAuthoring(input: {
  projectId?: string;
  target?: ProductionTarget;
  adapter?: AdapterDescriptor;
  providerKey: string;
  ready: boolean;
  setParameters: (update: (current: AdapterParameters) => AdapterParameters) => void;
  initialOverrides?: AdapterParameters;
  shotIds?: string[];
  inputImages?: import('@ai-video/contracts').ProductionImageSelection[];
}) {
  const callWorker = projectWorker();
  const { projectId, target, adapter, providerKey, ready, setParameters } = input;
  const [result, setResult] = useState<ProductionCompileResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const overrides = useRef(
    new Map<string, Record<string, AdapterParameters[string] | undefined>>(),
  );
  const rangeKey = input.shotIds?.join(',') ?? '';
  const imageKey = JSON.stringify(input.inputImages);
  const inputImages = input.inputImages;
  const contextKey = `${projectId}:${target?.kind}:${target?.id}:${adapter?.key}:${providerKey}:${rangeKey}:${imageKey}`;
  const shotIds = rangeKey ? rangeKey.split(',') : undefined;
  const currentKey = useRef(contextKey);
  currentKey.current = contextKey;
  const initialOverrides = useRef(input.initialOverrides);
  initialOverrides.current = input.initialOverrides;
  const preserveEdits = useCallback(
    (parameters: AdapterParameters): AdapterParameters => {
      const next = { ...parameters };
      for (const [field, value] of Object.entries(overrides.current.get(contextKey) ?? {})) {
        if (value === undefined) delete next[field];
        else next[field] = value;
      }
      return adapter ? projectProductionParameters(adapter, next) : next;
    },
    [contextKey, adapter],
  );

  useEffect(() => {
    let active = true;
    setResult(undefined);
    setError('');
    if (!projectId || !target || !adapter || !ready) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void callWorker('production.compile', compileRequest(target, adapter, shotIds, inputImages))
      .then((compiled) => {
        if (!active || currentKey.current !== contextKey) return;
        setResult(compiled);
        if (!compiled) return;
        if (!shotIds && !overrides.current.has(contextKey) && initialOverrides.current) {
          const initial = { ...initialOverrides.current };
          if (compiled.continuity?.binding) {
            for (const field of [
              'prompt',
              'content',
              'images',
              'image',
              'image_url',
              'img_url',
              'first_frame_url',
              'last_frame_url',
              'media',
            ])
              delete initial[field];
          }
          overrides.current.set(contextKey, initial);
        }
        setParameters((current) => {
          const supported = projectProductionParameters(adapter, current);
          const patch = { ...compiled.parameters };
          return preserveEdits({ ...supported, ...patch });
        });
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '制作内容读取失败。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    projectId,
    target?.kind,
    target?.id,
    adapter,
    ready,
    providerKey,
    contextKey,
    refresh,
    setParameters,
    preserveEdits,
  ]);

  useEffect(() => {
    if (!target || !result?.source) return;
    let active = true;
    const inspect = () => {
      if (!adapter) return;
      void callWorker('production.compile', compileRequest(target, adapter, shotIds, inputImages))
        .then((latest) => {
          if (
            active &&
            currentKey.current === contextKey &&
            latest?.source?.token !== result.source?.token
          ) {
            setResult(latest);
            setError('制作说明或参考资料已更新，已保留当前表单；生成时以表单内容为准。');
          }
        })
        .catch(() => {
          if (active && currentKey.current === contextKey)
            setError('制作说明暂时无法读取，仍可编辑当前表单并生成。');
        });
    };
    window.addEventListener('production-source-updated', inspect);
    window.addEventListener('character-voice-reference-updated', inspect);
    return () => {
      active = false;
      window.removeEventListener('production-source-updated', inspect);
      window.removeEventListener('character-voice-reference-updated', inspect);
    };
  }, [target?.kind, target?.id, result?.source?.token, contextKey]);

  return {
    preserveEdits,
    overriddenFields: Object.keys(overrides.current.get(contextKey) ?? {}),
    refreshKeepingEdits: () => setRefresh((value) => value + 1),
    result,
    loading,
    error,
    changed: (field: string, value: AdapterParameters[string] | undefined) => {
      const values = overrides.current.get(contextKey) ?? {};
      values[field] = value;
      overrides.current.set(contextKey, values);
    },
    refill: () => {
      overrides.current.set(contextKey, {});
      setRefresh((value) => value + 1);
    },
    beforeSubmit: (): Promise<ProductionSource | undefined> => {
      if (!target) return Promise.resolve(undefined);
      if (
        !result?.source ||
        result.source.target.kind !== target.kind ||
        result.source.target.id !== target.id
      )
        return Promise.resolve(undefined);
      return Promise.resolve({
        ...result.source,
        mode: 'form',
        target,
        ...(shotIds ? { shotIds } : {}),
        ...(inputImages !== undefined ? { inputImages } : {}),
      });
    },
  };
}
