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
export function useProductionInstructions(input: {
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
        if (!compiled || (compiled.issues.length && !compiled.compiledPrompt)) return;
        if (!shotIds && !overrides.current.has(contextKey) && initialOverrides.current) {
          const initial = { ...initialOverrides.current };
          if (compiled.continuity?.binding) {
            // A saved old form cannot replace the newly confirmed prompt or image bindings.
            for (const field of ['prompt', 'images', 'media', 'content']) delete initial[field];
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
      void (
        (shotIds || inputImages) && adapter
          ? callWorker('production.compile', compileRequest(target, adapter, shotIds, inputImages))
          : callWorker('production.read', { target })
      )
        .then((latest) => {
          if (active && latest?.source?.token !== result.source?.token)
            setError('来源内容或素材绑定已更新，请重新填入制作内容。');
        })
        .catch(() => {
          if (active) setError('制作来源暂时不可用，请重新读取。');
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
    beforeSubmit: async (): Promise<ProductionSource | undefined> => {
      if (loading || error || result?.issues.length)
        throw new Error(
          error ||
            result?.issues.map((issue) => issue.message).join('\n') ||
            '正在适配制作内容，请稍后提交。',
        );
      if (!target || !adapter) return undefined;
      const latest = await callWorker('production.compile', {
        ...compileRequest(target, adapter, shotIds, inputImages),
        ...(result?.source ? { expectedToken: result.source.token } : {}),
      });
      if (latest?.source?.token !== result?.source?.token)
        throw new Error('制作来源已变化，请重新填入制作内容。');
      if (latest?.issues.length)
        throw new Error(latest.issues.map((issue) => issue.message).join('\n'));
      return latest?.source;
    },
  };
}
