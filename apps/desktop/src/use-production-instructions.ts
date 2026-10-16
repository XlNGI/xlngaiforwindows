import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdapterDescriptor,
  AdapterParameters,
  ProductionSource,
  ProductionTarget,
  ProductionCompileResult,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

/** Provider selection is user-owned. This hook only compiles a local form draft. */
export function useProductionInstructions(input: {
  projectId?: string;
  target?: ProductionTarget;
  adapter?: AdapterDescriptor;
  providerKey: string;
  ready: boolean;
  setParameters: (update: (current: AdapterParameters) => AdapterParameters) => void;
  preparePatch?: (
    compiled: ProductionCompileResult,
    current: AdapterParameters,
  ) => AdapterParameters;
  initialOverrides?: AdapterParameters;
}) {
  const { projectId, target, adapter, providerKey, ready, setParameters } = input;
  const [result, setResult] = useState<ProductionCompileResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const overrides = useRef(
    new Map<string, Record<string, AdapterParameters[string] | undefined>>(),
  );
  const contextKey = `${projectId}:${target?.kind}:${target?.id}:${adapter?.key}:${providerKey}`;
  const currentKey = useRef(contextKey);
  currentKey.current = contextKey;
  const preparePatch = useRef(input.preparePatch);
  preparePatch.current = input.preparePatch;
  const initialOverrides = useRef(input.initialOverrides);
  initialOverrides.current = input.initialOverrides;
  const preserveEdits = useCallback(
    (parameters: AdapterParameters): AdapterParameters => {
      const next = { ...parameters };
      for (const [field, value] of Object.entries(overrides.current.get(contextKey) ?? {})) {
        if (value === undefined) delete next[field];
        else next[field] = value;
      }
      return next;
    },
    [contextKey],
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
    void callWorker('production.compile', { target, adapterKey: adapter.key })
      .then((compiled) => {
        if (!active || currentKey.current !== contextKey) return;
        setResult(compiled);
        if (!compiled || compiled.issues.length) return;
        if (!overrides.current.has(contextKey) && initialOverrides.current)
          overrides.current.set(contextKey, { ...initialOverrides.current });
        setParameters((current) => {
          const patch = preparePatch.current?.(compiled, current) ?? { ...compiled.parameters };
          if (!preparePatch.current && Array.isArray(patch.content))
            patch.content = [
              ...patch.content,
              ...(Array.isArray(current.content)
                ? current.content.filter(
                    (item) =>
                      item &&
                      typeof item === 'object' &&
                      !Array.isArray(item) &&
                      item.type !== 'text',
                  )
                : []),
            ];
          return preserveEdits({ ...current, ...patch });
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
      void callWorker('production.read', { target })
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
        target,
        adapterKey: adapter.key,
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
