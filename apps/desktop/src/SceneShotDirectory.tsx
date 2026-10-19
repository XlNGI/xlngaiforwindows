import { Aperture, ChevronRight, Clapperboard, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SceneInfo, ShotInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

export function SceneShotDirectory({
  projectId,
  scenes,
  sceneId,
  shotId,
  shots,
  writable,
  onSelectScene,
  onSelectShot,
  onAddScene,
}: {
  projectId: string;
  scenes: SceneInfo[];
  sceneId?: string;
  shotId?: string;
  shots: ShotInfo[];
  writable: boolean;
  onSelectScene: (scene: SceneInfo) => void;
  onSelectShot: (scene: SceneInfo, shot: ShotInfo) => void;
  onAddScene: () => void;
}) {
  return (
    <aside className="directory-index scene-shot-directory" aria-label="场次与镜头目录">
      <div className="tree-heading">
        <span>场次与镜头</span>
        <button
          className="icon-button subtle"
          type="button"
          title="新建场次"
          disabled={!writable}
          onClick={onAddScene}
        >
          <Plus size={14} />
        </button>
      </div>
      {scenes.map((scene) => (
        <SceneEntry
          key={`${projectId}:${scene.id}`}
          scene={scene}
          selected={sceneId === scene.id}
          shotId={shotId}
          shots={shots}
          onSelectScene={onSelectScene}
          onSelectShot={onSelectShot}
        />
      ))}
      {scenes.length === 0 && <small className="tree-empty">暂无场次</small>}
    </aside>
  );
}

function SceneEntry({
  scene,
  selected,
  shotId,
  shots,
  onSelectScene,
  onSelectShot,
}: {
  scene: SceneInfo;
  selected: boolean;
  shotId?: string;
  shots: ShotInfo[];
  onSelectScene: (scene: SceneInfo) => void;
  onSelectShot: (scene: SceneInfo, shot: ShotInfo) => void;
}) {
  const [expanded, setExpanded] = useState(selected);
  const [loaded, setLoaded] = useState<ShotInfo[]>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (selected) setExpanded(true);
  }, [selected]);
  useEffect(() => {
    if (!expanded || selected) return;
    let active = true;
    const callWorker = projectWorker();
    setFailed(false);
    void callWorker('shot.list', { sceneId: scene.id })
      .then((items) => {
        if (active) setLoaded(items);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [expanded, selected, scene.id, scene.rowVersion, retry]);
  const items = selected ? shots.filter((shot) => shot.sceneId === scene.id) : loaded;
  return (
    <div className="scene-directory-branch">
      <div className="scene-directory-row">
        <button
          className="icon-button subtle scene-directory-toggle"
          type="button"
          aria-label={`${expanded ? '收起' : '展开'}${scene.title}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight size={13} />
        </button>
        <button
          className={`tree-item ${selected && !shotId ? 'selected' : ''}`}
          type="button"
          title={scene.title}
          aria-current={selected && !shotId ? 'page' : undefined}
          onClick={() => {
            setExpanded(true);
            onSelectScene(scene);
          }}
        >
          <Clapperboard size={13} />
          <span>{scene.title}</span>
        </button>
      </div>
      {expanded && (
        <div className="scene-directory-shots" aria-label={`${scene.title}的镜头`}>
          {items?.map((shot) => (
            <button
              key={shot.id}
              className={`tree-item nested ${selected && shotId === shot.id ? 'selected' : ''}`}
              type="button"
              title={shot.title}
              aria-current={selected && shotId === shot.id ? 'page' : undefined}
              onClick={() => onSelectShot(scene, shot)}
            >
              <Aperture size={13} />
              <span>{shot.title}</span>
            </button>
          ))}
          {failed && !selected ? (
            <button className="text-button" type="button" onClick={() => setRetry((n) => n + 1)}>
              镜头加载失败，点击重试
            </button>
          ) : !items ? (
            <small className="tree-empty">正在读取镜头…</small>
          ) : items.length === 0 ? (
            <small className="tree-empty">暂无镜头</small>
          ) : null}
        </div>
      )}
    </div>
  );
}
