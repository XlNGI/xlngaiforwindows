import { Aperture, ChevronRight, Clapperboard, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SceneInfo, ShotInfo } from '@ai-video/contracts';
import { projectWorker, workerScope } from './worker-scope';
import { DocumentDirectoryTitleText } from './DocumentDirectoryTitle';
import { useDraftDocumentBatch, type DraftDeletionTarget } from './DraftDocumentBatch';
import { ProductionArchiveList, type ProductionLifecycleTarget } from './ProductionArchiveList';

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
  onRenameScene,
  onRenameShot,
  onLifecycleChanged,
  dirtySceneId,
  dirtyShotId,
  busy = false,
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
  onRenameScene?: (scene: SceneInfo, title: string) => void | Promise<void>;
  onRenameShot?: (scene: SceneInfo, shot: ShotInfo, title: string) => void | Promise<void>;
  onLifecycleChanged?: (targets: ProductionLifecycleTarget[]) => Promise<void>;
  dirtySceneId?: string;
  dirtyShotId?: string;
  busy?: boolean;
}) {
  const scope = workerScope();
  const [archivedView, setArchivedView] = useState(false);
  const [revision, setRevision] = useState(0);
  const [knownShots, setKnownShots] = useState<Record<string, ShotInfo[]>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    setKnownShots({});
    setHidden([]);
    setArchivedView(false);
  }, [projectId, scope?.projectSessionId]);
  const rememberShots = useCallback((id: string, items: ShotInfo[]) => {
    setKnownShots((current) => ({ ...current, [id]: items }));
  }, []);
  const activeScenes = scenes.filter(
    (item) => !item.archivedAt && !hidden.includes(`scene:${item.id}`),
  );
  const sceneTarget = (item: SceneInfo): DraftDeletionTarget => ({
    id: `scene:${item.id}`,
    title: item.title,
    rowVersion: item.rowVersion,
    lifecycleStatus: 'active',
    productionTarget: { kind: 'scene', id: item.id },
    dirty: item.id === dirtySceneId || (item.id === sceneId && Boolean(dirtyShotId)),
  });
  const shotTarget = (item: ShotInfo): DraftDeletionTarget => ({
    id: `shot:${item.id}`,
    title: item.title,
    rowVersion: item.rowVersion,
    lifecycleStatus: 'active',
    productionTarget: { kind: 'shot', id: item.id },
    parentSelectionId: `scene:${item.sceneId}`,
    dirty: item.id === dirtyShotId,
  });
  const availableShots = {
    ...knownShots,
    ...(sceneId ? { [sceneId]: shots.filter((item) => item.sceneId === sceneId) } : {}),
  };
  const targets = [
    ...activeScenes.map(sceneTarget),
    ...Object.values(availableShots)
      .flat()
      .filter(
        (item) =>
          !item.archivedAt &&
          !hidden.includes(`shot:${item.id}`) &&
          activeScenes.some((parent) => parent.id === item.sceneId),
      )
      .map(shotTarget),
  ];
  const batch = useDraftDocumentBatch({
    items: targets,
    writable,
    busy,
    resetKey: projectId,
    allowArchive: true,
    confirmationNote:
      '归档或删除场次会同时隐藏其下镜头；恢复后保留内容与绑定。单独归档的镜头需单独恢复。',
    onDeleted: async (deleted) => {
      setHidden((ids) => [...ids, ...deleted.map((item) => item.id)]);
      setRevision((n) => n + 1);
      await onLifecycleChanged?.(deleted.map((item) => item.productionTarget!));
    },
  });
  const [editingKey, setEditingKey] = useState<string>();
  const [editingTitle, setEditingTitle] = useState('');

  const beginTitleEdit = (key: string, title: string) => {
    setEditingKey(key);
    setEditingTitle(title);
  };

  const cancelTitleEdit = () => {
    setEditingKey(undefined);
    setEditingTitle('');
  };

  const commitTitleEdit = async (
    key: string,
    originalTitle: string,
    onRename?: () => void | Promise<void>,
  ) => {
    if (editingKey !== key) return;
    const nextTitle = editingTitle.trim();
    cancelTitleEdit();
    if (!nextTitle || nextTitle === originalTitle.trim() || !onRename) return;
    await onRename();
  };

  return (
    <aside className="directory-index scene-shot-directory" aria-label="场次与镜头目录">
      <div className="tree-heading">
        <span>场次与镜头</span>
        <button
          className="icon-button subtle"
          type="button"
          title="新建场次"
          disabled={!writable || batch.disabled}
          onClick={onAddScene}
        >
          <Plus size={14} />
        </button>
      </div>
      <button
        type="button"
        className="text-button"
        disabled={batch.deleting}
        onClick={() => setArchivedView((value) => !value)}
      >
        {archivedView ? '返回草稿' : '已归档 / 已删除'}
      </button>
      {archivedView ? (
        <ProductionArchiveList
          key={projectId}
          writable={writable && !busy}
          revision={revision}
          onRestored={async (target) => {
            setHidden((ids) => ids.filter((id) => id !== `${target.kind}:${target.id}`));
            setRevision((n) => n + 1);
            await onLifecycleChanged?.([]);
          }}
        />
      ) : (
        <>
          {batch.controls()}
          {batch.message && <p role="status">{batch.message}</p>}
          {activeScenes.map((scene) => (
            <SceneEntry
              key={`${projectId}:${scope?.projectSessionId}:${scene.id}`}
              scene={scene}
              selected={sceneId === scene.id}
              shotId={shotId}
              shots={shots.filter((item) => !hidden.includes(`shot:${item.id}`))}
              writable={writable && !batch.disabled}
              revision={revision}
              onShotsLoaded={rememberShots}
              checkbox={(item) =>
                batch.checkbox(
                  'sceneId' in item ? shotTarget(item) : sceneTarget(item),
                  `选择${'sceneId' in item ? '镜头' : '场次'} ${item.title}`,
                )
              }
              onSelectScene={onSelectScene}
              onSelectShot={onSelectShot}
              editingKey={editingKey}
              editingTitle={editingTitle}
              onBeginTitleEdit={beginTitleEdit}
              onEditingTitleChange={setEditingTitle}
              onCommitTitleEdit={commitTitleEdit}
              onCancelTitleEdit={cancelTitleEdit}
              onRenameScene={onRenameScene}
              onRenameShot={onRenameShot}
            />
          ))}
          {activeScenes.length === 0 && <small className="tree-empty">暂无场次</small>}
        </>
      )}
      {batch.dialog}
    </aside>
  );
}

function SceneEntry({
  scene,
  selected,
  shotId,
  shots,
  writable,
  onSelectScene,
  onSelectShot,
  editingKey,
  editingTitle,
  onBeginTitleEdit,
  onEditingTitleChange,
  onCommitTitleEdit,
  onCancelTitleEdit,
  onRenameScene,
  onRenameShot,
  revision,
  onShotsLoaded,
  checkbox,
}: {
  scene: SceneInfo;
  selected: boolean;
  shotId?: string;
  shots: ShotInfo[];
  writable: boolean;
  onSelectScene: (scene: SceneInfo) => void;
  onSelectShot: (scene: SceneInfo, shot: ShotInfo) => void;
  editingKey?: string;
  editingTitle: string;
  onBeginTitleEdit: (key: string, title: string) => void;
  onEditingTitleChange: (title: string) => void;
  onCommitTitleEdit: (
    key: string,
    originalTitle: string,
    onRename?: () => void | Promise<void>,
  ) => void | Promise<void>;
  onCancelTitleEdit: () => void;
  onRenameScene?: (scene: SceneInfo, title: string) => void | Promise<void>;
  onRenameShot?: (scene: SceneInfo, shot: ShotInfo, title: string) => void | Promise<void>;
  revision: number;
  onShotsLoaded: (sceneId: string, shots: ShotInfo[]) => void;
  checkbox: (item: SceneInfo | ShotInfo) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(selected);
  const [loaded, setLoaded] = useState<ShotInfo[]>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const titleSelection = useRef(false);
  const shotsId = useId();
  const sceneTitleKey = `scene:${scene.id}`;
  useEffect(() => {
    if (!selected) return;
    if (titleSelection.current && !shotId) {
      titleSelection.current = false;
      return;
    }
    titleSelection.current = false;
    setExpanded(true);
  }, [selected, shotId]);
  useEffect(() => {
    if (!expanded || selected) return;
    let active = true;
    const callWorker = projectWorker();
    setFailed(false);
    void callWorker('shot.list', { sceneId: scene.id })
      .then((items) => {
        if (active) {
          setLoaded(items);
          onShotsLoaded(scene.id, items);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [expanded, selected, scene.id, scene.rowVersion, retry, revision, onShotsLoaded]);
  const items = selected ? shots.filter((shot) => shot.sceneId === scene.id) : loaded;
  return (
    <div className="scene-directory-branch">
      <div className="scene-directory-row">
        {checkbox(scene)}
        <button
          className="icon-button subtle scene-directory-toggle"
          type="button"
          aria-label={`${expanded ? '收起' : '展开'}${scene.title}`}
          aria-expanded={expanded}
          aria-controls={shotsId}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronRight size={13} />
        </button>
        {editingKey === sceneTitleKey ? (
          <input
            className="scene-directory-title-input"
            type="text"
            aria-label="场次标题"
            autoFocus
            readOnly={!writable}
            value={editingTitle}
            onChange={(event) => onEditingTitleChange(event.target.value)}
            onBlur={() =>
              void onCommitTitleEdit(sceneTitleKey, scene.title, () =>
                onRenameScene?.(scene, editingTitle),
              )
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancelTitleEdit();
              }
            }}
          />
        ) : (
          <button
            className={`tree-item ${selected && !shotId ? 'selected' : ''}`}
            type="button"
            title={scene.title}
            aria-current={selected && !shotId ? 'page' : undefined}
            aria-expanded={expanded}
            aria-controls={shotsId}
            onClick={() => {
              if (selected && !shotId && writable && onRenameScene) {
                onBeginTitleEdit(sceneTitleKey, scene.title);
                return;
              }
              setExpanded((open) => !open);
              if (!selected || shotId) {
                titleSelection.current = true;
                onSelectScene(scene);
              }
            }}
          >
            <Clapperboard size={13} />
            <DocumentDirectoryTitleText text={scene.title} />
          </button>
        )}
      </div>
      {expanded && (
        <div id={shotsId} className="scene-directory-shots" aria-label={`${scene.title}的镜头`}>
          {items
            ?.filter((shot) => !shot.archivedAt)
            .map((shot) => (
              <div className="scene-directory-row" key={shot.id}>
                {checkbox(shot)}
                {editingKey === `shot:${shot.id}` ? (
                  <input
                    key={shot.id}
                    className="scene-directory-title-input scene-directory-shot-title-input"
                    type="text"
                    aria-label="镜头标题"
                    autoFocus
                    readOnly={!writable}
                    value={editingTitle}
                    onChange={(event) => onEditingTitleChange(event.target.value)}
                    onBlur={() =>
                      void onCommitTitleEdit(`shot:${shot.id}`, shot.title, () =>
                        onRenameShot?.(scene, shot, editingTitle),
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        onCancelTitleEdit();
                      }
                    }}
                  />
                ) : (
                  <button
                    key={shot.id}
                    className={`tree-item nested ${selected && shotId === shot.id ? 'selected' : ''}`}
                    type="button"
                    title={shot.title}
                    aria-current={selected && shotId === shot.id ? 'page' : undefined}
                    onClick={() => {
                      if (selected && shotId === shot.id && writable && onRenameShot) {
                        onBeginTitleEdit(`shot:${shot.id}`, shot.title);
                        return;
                      }
                      onSelectShot(scene, shot);
                    }}
                  >
                    <Aperture size={13} />
                    <DocumentDirectoryTitleText text={shot.title} />
                  </button>
                )}
              </div>
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
