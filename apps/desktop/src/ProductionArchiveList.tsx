import { useEffect, useState } from 'react';
import type { SceneInfo, ShotInfo } from '@ai-video/contracts';
import { isCurrentWorkerScope, projectWorker, workerScope } from './worker-scope';

export type ProductionLifecycleTarget = { kind: 'scene' | 'shot'; id: string };

export function ProductionArchiveList({
  writable,
  revision,
  onRestored,
}: {
  writable: boolean;
  revision: number;
  onRestored: (target: ProductionLifecycleTarget) => Promise<void>;
}) {
  const [items, setItems] = useState<Array<{ scene: SceneInfo; shots: ShotInfo[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const scope = workerScope();
  useEffect(() => {
    setBusy(false);
  }, [scope?.projectId, scope?.projectSessionId]);
  useEffect(() => {
    let active = true;
    const callWorker = projectWorker(scope);
    setLoading(true);
    setError('');
    void callWorker('scene.list', { includeArchived: true })
      .then(async (scenes) =>
        Promise.all(
          scenes.map(async (scene) => ({
            scene,
            shots: await callWorker('shot.list', { sceneId: scene.id, includeArchived: true }),
          })),
        ),
      )
      .then((rows) => {
        if (active)
          setItems(
            rows.filter((row) => row.scene.archivedAt || row.shots.some((shot) => shot.archivedAt)),
          );
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '归档列表加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope?.projectId, scope?.projectSessionId, revision, retry]);

  const restore = async (target: ProductionLifecycleTarget, rowVersion: number) => {
    if (!writable || busy) return;
    setBusy(true);
    setError('');
    try {
      await projectWorker(scope)('production.lifecycle.change', {
        target,
        expectedRowVersion: rowVersion,
        archived: false,
      });
      if (!isCurrentWorkerScope(scope)) return;
      // Remove a successful restoration even if refreshing the active directory fails.
      setItems((rows) =>
        target.kind === 'scene'
          ? rows
              .map((row) =>
                row.scene.id === target.id
                  ? {
                      ...row,
                      scene: { ...row.scene, archivedAt: undefined, rowVersion: rowVersion + 1 },
                    }
                  : row,
              )
              .filter((row) => row.scene.archivedAt || row.shots.some((shot) => shot.archivedAt))
          : rows
              .map((row) => ({ ...row, shots: row.shots.filter((shot) => shot.id !== target.id) }))
              .filter((row) => row.scene.archivedAt || row.shots.some((shot) => shot.archivedAt)),
      );
      await onRestored(target);
    } catch (reason) {
      if (isCurrentWorkerScope(scope))
        setError(reason instanceof Error ? reason.message : '恢复失败');
    } finally {
      if (isCurrentWorkerScope(scope)) setBusy(false);
    }
  };
  return (
    <div aria-label="已归档场次与镜头">
      <p>归档和删除的内容均可在这里恢复。恢复场次后，其下原先可用的镜头会一并显示。</p>
      {loading ? (
        <p role="status">正在读取归档…</p>
      ) : items.length === 0 && !error ? (
        <small>暂无已归档内容</small>
      ) : null}
      {items.map(({ scene, shots }) => (
        <div key={scene.id}>
          <div className="scene-directory-row">
            <span>{scene.title}</span>
            {scene.archivedAt && (
              <button
                type="button"
                className="text-button"
                disabled={!writable || busy || loading}
                aria-label={`恢复场次 ${scene.title}`}
                onClick={() => void restore({ kind: 'scene', id: scene.id }, scene.rowVersion)}
              >
                恢复
              </button>
            )}
          </div>
          <div className="scene-directory-shots">
            {shots
              .filter((shot) => scene.archivedAt || shot.archivedAt)
              .map((shot) => (
                <div className="scene-directory-row" key={shot.id}>
                  <span>{shot.title}</span>
                  {scene.archivedAt ? (
                    <small>随场次恢复{shot.archivedAt ? '后仍单独归档' : ''}</small>
                  ) : (
                    <button
                      type="button"
                      className="text-button"
                      disabled={!writable || busy || loading}
                      aria-label={`恢复镜头 ${shot.title}`}
                      onClick={() => void restore({ kind: 'shot', id: shot.id }, shot.rowVersion)}
                    >
                      恢复
                    </button>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setRetry((n) => n + 1)}
          >
            刷新归档列表
          </button>
        </p>
      )}
    </div>
  );
}
