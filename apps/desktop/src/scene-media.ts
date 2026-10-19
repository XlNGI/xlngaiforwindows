import { useEffect, useRef, useState } from 'react';
import type {
  SceneCharacterBindingInfo,
  SceneMediaResolveParams,
  SceneMediaResolveResult,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

const pending = new Map<string, Promise<SceneMediaResolveResult>>();
export function readSceneMedia(projectId: string, params: SceneMediaResolveParams) {
  const callWorker = projectWorker();
  const key = `${projectId}:${JSON.stringify(params)}`;
  let request = pending.get(key);
  if (!request) {
    request = Promise.resolve().then(() => callWorker('scene.media.resolve', params));
    pending.set(key, request);
    void request
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      })
      .catch(() => undefined);
  }
  return request;
}

export function sceneMediaParams(
  characters: SceneCharacterBindingInfo[],
  assetIds: string[] = [],
): SceneMediaResolveParams {
  return {
    characterDocumentIds: characters.map((c) => c.characterDocumentId),
    assetIds: [
      ...new Set([
        ...assetIds,
        ...characters.flatMap((c) => (c.imageAssetId ? [c.imageAssetId] : [])),
      ]),
    ],
    voiceVersionIds: [
      ...new Set(
        characters.flatMap((c) => (c.voiceReferenceVersionId ? [c.voiceReferenceVersionId] : [])),
      ),
    ],
  };
}

export function effectiveSceneCast(
  cast: SceneCharacterBindingInfo[],
  media: SceneMediaResolveResult,
): SceneCharacterBindingInfo[] {
  return cast.map((binding) => {
    const defaults = media.characters.find(
      (c) => c.characterDocumentId === binding.characterDocumentId,
    );
    return {
      ...binding,
      imageAssetId: binding.imageDisabled
        ? undefined
        : (binding.imageAssetId ?? defaults?.defaultImage?.id),
      voiceReferenceVersionId: binding.voiceDisabled
        ? undefined
        : (binding.voiceReferenceVersionId ?? defaults?.voice?.versionId),
    };
  });
}

export function useSceneMedia(
  projectId: string | undefined,
  params: SceneMediaResolveParams,
  revision: unknown,
) {
  const query = JSON.stringify(params);
  const key = `${projectId}:${query}`;
  const [state, setState] = useState<{
    key: string;
    value?: SceneMediaResolveResult;
    error?: string;
    loading: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  const observed = useRef<{ key: string; revision: unknown } | undefined>(undefined);
  useEffect(() => {
    if (observed.current?.key === key && observed.current.revision !== revision)
      pending.delete(key);
    observed.current = { key, revision };
    let active = true;
    let sequence = 0;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const token = ++sequence;
      if (!projectId) return;
      setState((current) => ({
        key,
        value: current?.key === key ? current.value : undefined,
        loading: true,
      }));
      void readSceneMedia(projectId, JSON.parse(query) as SceneMediaResolveParams)
        .then((value) => {
          if (active && token === sequence) setState({ key, value, loading: false });
        })
        .catch(() => {
          if (active && token === sequence)
            setState({ key, error: '角色参考资料读取失败，请重试。', loading: false });
        });
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; characterDocumentId?: string }>)
        .detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      if (
        detail?.characterDocumentId &&
        !params.characterDocumentIds.includes(detail.characterDocumentId)
      )
        return;
      pending.delete(`${projectId}:${query}`);
      clearTimeout(scheduled);
      scheduled = setTimeout(refresh, 40);
    };
    refresh();
    window.addEventListener('character-voice-reference-updated', changed);
    return () => {
      active = false;
      clearTimeout(scheduled);
      window.removeEventListener('character-voice-reference-updated', changed);
    };
  }, [projectId, query, key, revision, retry]);
  const current = state?.key === key ? state : undefined;
  return { ...current, loading: !current || current.loading, retry: () => setRetry((n) => n + 1) };
}
