import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type CSSProperties,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clapperboard,
  ExternalLink,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  AssetInfo,
  RoughCutClip,
  RoughCutEpisode,
  RoughCutExportJob,
  RoughCutSequence,
  SceneInfo,
} from '@ai-video/contracts';
import { projectWorker, workerMediaUrl, workerScope } from '../worker-scope';
import { RoughCutExportStatus } from './RoughCutExportStatus';
import { RoughCutPreview } from './RoughCutPreview';
import { ASSET_POINTER_DRAG, type AssetPointerDrag } from '../assets/asset-pointer-drag';
import {
  assetDropIds,
  clipLength,
  locateTimeline,
  moveClip,
  sequenceLength,
  splitClip,
  timeLabel,
} from './timeline-model';
import './rough-cut.css';

export interface RoughCutImportRequest {
  projectId: string;
  token: number;
  assetIds: string[];
}
interface Props {
  active?: boolean;
  projectId: string;
  writable: boolean;
  scenes: SceneInfo[];
  importRequest?: RoughCutImportRequest;
  onImportHandled: (token: number) => void;
}

// Docking moves this view between React parents. Keep unsaved edits and finish
// the previous writer before a remounted view reads the same local sequence.
const pendingSaves = new Map<string, Promise<void>>();
const unsavedDrafts = new Map<string, { sequence: RoughCutSequence; revision: number }>();
const latestExports = new Map<string, RoughCutExportJob>();

function blankSequence(projectId: string): RoughCutSequence {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    name: '未命名粗剪',
    sceneIds: [],
    clips: [],
    rowVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function RoughCutWorkspace({
  active = true,
  projectId,
  writable,
  scenes,
  importRequest,
  onImportHandled,
}: Props) {
  const scope = workerScope(projectId);
  const sessionKey = `${projectId}:${scope?.projectSessionId ?? 'local'}`;
  const call = useMemo(() => projectWorker(scope), [sessionKey]);
  const [sequence, setSequence] = useState(() => blankSequence(projectId));
  const draft = useRef(sequence);
  const [sequences, setSequences] = useState<RoughCutSequence[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saveStatus, setSaveStatus] = useState('未保存');
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const dirty = useRef(false);
  const alive = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queuedRevision = useRef(-1);
  const versions = useRef(new Map<string, number>());
  const [selectedId, setSelectedId] = useState<string>();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [mediaErrors, setMediaErrors] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<AssetInfo[]>([]);
  const [history, setHistory] = useState<RoughCutSequence[]>([]);
  const [future, setFuture] = useState<RoughCutSequence[]>([]);
  const [episodeOpen, setEpisodeOpen] = useState(false);
  const [sceneSelection, setSceneSelection] = useState<string[]>([]);
  const [episodes, setEpisodes] = useState<RoughCutEpisode[]>([]);
  const [episodeChoice, setEpisodeChoice] = useState('custom');
  const [customEpisodeNumber, setCustomEpisodeNumber] = useState('1');
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const [episodeError, setEpisodeError] = useState('');
  const [importNew, setImportNew] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const importing = useRef(false);
  const [dropHint, setDropHint] = useState<{ beforeId?: string; count: number }>();
  const pointerReceiver = useRef<(event: CustomEvent<AssetPointerDrag>) => void>(() => undefined);
  const [job, setJob] = useState<RoughCutExportJob | undefined>(() =>
    latestExports.get(sessionKey),
  );
  const updateJob = useCallback(
    (next: RoughCutExportJob) => {
      latestExports.set(sessionKey, next);
      if (latestExports.size > 8) latestExports.delete(latestExports.keys().next().value!);
      setJob(next);
    },
    [sessionKey],
  );
  const [preparingExport, setPreparingExport] = useState<'xml' | 'mp4'>();
  const [zoom, setZoom] = useState(1);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  const [seekRevision, setSeekRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const importTokens = useRef(new Set<number>());
  const trim = useRef<
    { clip: RoughCutClip; side: 'inMs' | 'outMs'; x: number; scale: number } | undefined
  >(undefined);
  const [trimPreview, setTrimPreview] = useState<RoughCutClip>();
  const total = sequenceLength(sequence.clips);
  const position = locateTimeline(sequence.clips, playhead);
  const selected = sequence.clips.find((clip) => clip.id === selectedId);
  const unavailable = [...new Set([...missing, ...mediaErrors])];

  const update = useCallback((next: RoughCutSequence) => {
    draft.current = next;
    setSequence(next);
  }, []);
  const seek = (timeMs: number) => {
    const next = Math.max(0, Math.min(sequenceLength(draft.current.clips), timeMs));
    playheadRef.current = next;
    setPlayhead(next);
    setSeekRevision((value) => value + 1);
  };
  const change = (next: RoughCutSequence, remember = true) => {
    if (!writable || busy || !loaded) return;
    if (remember) {
      const previous = draft.current;
      setHistory((items) => [...items.slice(-49), previous]);
      setFuture([]);
    }
    setPlaying(false);
    update(next);
    dirty.current = true;
    revisionRef.current += 1;
    unsavedDrafts.set(sessionKey, { sequence: next, revision: revisionRef.current });
    setRevision(revisionRef.current);
    setSaveStatus('待保存');
    if (playheadRef.current > sequenceLength(next.clips)) seek(sequenceLength(next.clips));
  };

  const persist = useCallback(
    (snapshot: RoughCutSequence, atRevision: number): Promise<void> => {
      if (!dirty.current || queuedRevision.current === atRevision) return queue.current;
      queuedRevision.current = atRevision;
      const work = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (alive.current) setSaveStatus('正在保存');
          const state = await call('roughCut.save', {
            id: snapshot.id,
            expectedRowVersion: versions.current.get(snapshot.id) ?? snapshot.rowVersion,
            name: snapshot.name,
            sceneIds: snapshot.sceneIds,
            clips: snapshot.clips,
          });
          versions.current.set(snapshot.id, state.sequence.rowVersion);
          const cached = unsavedDrafts.get(sessionKey);
          if (cached?.sequence.id === snapshot.id) {
            if (cached.revision === atRevision) unsavedDrafts.delete(sessionKey);
            else
              unsavedDrafts.set(sessionKey, {
                ...cached,
                sequence: { ...cached.sequence, rowVersion: state.sequence.rowVersion },
              });
          }
          if (!alive.current || draft.current.id !== snapshot.id) return;
          update({ ...draft.current, rowVersion: state.sequence.rowVersion });
          setMissing(state.unavailableClipIds);
          setSequences((items) => [
            state.sequence,
            ...items.filter((item) => item.id !== snapshot.id),
          ]);
          if (atRevision === revisionRef.current) {
            dirty.current = false;
            setSaveStatus('已保存到本地');
          }
        });
      queue.current = work;
      pendingSaves.set(sessionKey, work);
      void work
        .finally(() => {
          if (pendingSaves.get(sessionKey) === work) pendingSaves.delete(sessionKey);
        })
        .catch(() => undefined);
      void work.catch((reason) => {
        queuedRevision.current = -1;
        if (alive.current) {
          setMessage(String(reason));
          setSaveStatus('保存失败，编辑仍保留');
        }
      });
      return work;
    },
    [call, update, sessionKey],
  );

  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  useEffect(() => {
    setPlaying(false);
    seek(0);
  }, [sessionKey]);

  useEffect(() => {
    alive.current = true;
    let active = true;
    void Promise.resolve(pendingSaves.get(sessionKey))
      .catch(() => undefined)
      .then(() => call('roughCut.list', {}))
      .then(async (items) => {
        if (!active) return;
        setSequences(items);
        const cached = unsavedDrafts.get(sessionKey);
        if (cached) {
          update(cached.sequence);
          dirty.current = true;
          revisionRef.current = cached.revision;
          setRevision(cached.revision);
          setSaveStatus('待保存');
        } else if (items[0]) {
          const state = await call('roughCut.get', { id: items[0].id });
          if (!active) return;
          versions.current.set(state.sequence.id, state.sequence.rowVersion);
          update(state.sequence);
          setMissing(state.unavailableClipIds);
          setSaveStatus('已保存到本地');
        }
        setLoaded(true);
      })
      .catch((reason) => {
        if (active) setMessage(`粗剪加载失败：${String(reason)}`);
      });
    return () => {
      active = false;
      alive.current = false;
      void persist(draft.current, revisionRef.current).catch(() => undefined);
    };
  }, [call, persist, update]);

  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const timer = setTimeout(
      () => void persist(draft.current, revisionRef.current).catch(() => undefined),
      600,
    );
    return () => clearTimeout(timer);
  }, [loaded, revision, persist]);

  useEffect(() => {
    let active = true;
    for (const assetId of new Set(
      sequence.clips.filter((clip) => !missing.includes(clip.id)).map((clip) => clip.assetId),
    )) {
      if (sources[assetId]) continue;
      void call('asset.mediaSource', { assetId })
        .then((source) => {
          if (active)
            setSources((current) => ({
              ...current,
              [assetId]:
                '__TAURI_INTERNALS__' in window
                  ? convertFileSrc(source.path)
                  : workerMediaUrl(assetId),
            }));
        })
        .catch(() => {
          if (active)
            setMediaErrors((current) => [
              ...new Set([
                ...current,
                ...sequence.clips.filter((clip) => clip.assetId === assetId).map((clip) => clip.id),
              ]),
            ]);
        });
    }
    return () => {
      active = false;
    };
  }, [call, sequence.clips, missing]);

  const insert = async (assetIds: string[], beforeId?: string) => {
    if (!writable || !loaded || busy || importing.current) return;
    importing.current = true;
    setBusy(true);
    setMessage('');
    try {
      const prepared = await call('roughCut.prepare', { assetIds });
      if (!alive.current) return;
      const current = draft.current;
      if (current.clips.length + prepared.clips.length > 200)
        throw new Error('序列最多包含 200 个片段。');
      const clips = [...current.clips];
      const index = beforeId ? clips.findIndex((clip) => clip.id === beforeId) : clips.length;
      clips.splice(index < 0 ? clips.length : index, 0, ...prepared.clips);
      change({ ...current, clips });
      setSelectedId(prepared.clips[0]?.id);
    } finally {
      importing.current = false;
      if (alive.current) setBusy(false);
    }
  };

  pointerReceiver.current = (event) => {
    const detail = event.detail;
    if (detail.phase === 'cancel') {
      setDropHint(undefined);
      return;
    }
    if (!active || !writable || !loaded || busy || importing.current || episodeOpen) return;
    let assetIds: string[];
    try {
      assetIds = assetDropIds(detail.serialized, projectId);
    } catch {
      return;
    }
    if (detail.phase === 'probe') {
      event.preventDefault();
      return;
    }
    const contains = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (
        detail.x >= rect.left &&
        detail.x <= rect.right &&
        detail.y >= rect.top &&
        detail.y <= rect.bottom
      );
    };
    const inside = [
      ...(workspace.current?.querySelectorAll('.rough-cut-viewer-row, .rough-cut-timeline') ?? []),
    ].some(contains);
    if (!inside) {
      setDropHint(undefined);
      return;
    }
    const clipElements = [
      ...(workspace.current?.querySelectorAll<HTMLElement>('[data-rough-cut-clip]') ?? []),
    ];
    const hovered = clipElements.find(contains);
    let beforeId: string | undefined;
    if (hovered) {
      const rect = hovered.getBoundingClientRect();
      const index = clipElements.indexOf(hovered);
      beforeId =
        detail.x < rect.left + rect.width / 2
          ? hovered.dataset.roughCutClip
          : clipElements[index + 1]?.dataset.roughCutClip;
    }
    event.preventDefault();
    if (detail.phase === 'move') setDropHint({ beforeId, count: assetIds.length });
    else {
      setDropHint(undefined);
      void insert(assetIds, beforeId).catch((reason) => setMessage(String(reason)));
    }
  };
  useEffect(() => {
    const receive = (event: Event) =>
      pointerReceiver.current(event as CustomEvent<AssetPointerDrag>);
    document.addEventListener(ASSET_POINTER_DRAG, receive);
    return () => document.removeEventListener(ASSET_POINTER_DRAG, receive);
  }, []);

  useEffect(() => {
    if (
      !loaded ||
      busy ||
      !writable ||
      !importRequest ||
      importTokens.current.has(importRequest.token)
    )
      return;
    importTokens.current.add(importRequest.token);
    if (importRequest.projectId !== projectId) {
      onImportHandled(importRequest.token);
      return;
    }
    void insert(importRequest.assetIds)
      .catch((reason) => setMessage(String(reason)))
      .finally(() => onImportHandled(importRequest.token));
  }, [loaded, busy, writable, importRequest?.token]);

  useEffect(() => {
    setCandidates([]);
    if (!propertiesOpen || !selected || (!selected.sceneId && !selected.shotId)) return;
    let active = true;
    void call('asset.list', {
      ...(selected.shotId ? { shotId: selected.shotId } : { sceneId: selected.sceneId }),
      kind: 'video',
      limit: 200,
      sort: 'created-desc',
    })
      .then((items) => {
        if (active) setCandidates(items.filter((item) => item.kind.includes('video')));
      })
      .catch((reason) => {
        if (active) setMessage(String(reason));
      });
    return () => {
      active = false;
    };
  }, [call, propertiesOpen, selected?.id, selected?.assetId]);

  const drop = (event: DragEvent, beforeId?: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!writable || busy) return;
    try {
      const internal = event.dataTransfer.getData('application/x-ai-video-rough-cut');
      if (internal) {
        const data = JSON.parse(internal) as { sequenceId: string; clipId: string };
        if (data.sequenceId !== sequence.id) throw new Error('请在同一序列内调整顺序。');
        change({ ...draft.current, clips: moveClip(draft.current.clips, data.clipId, beforeId) });
      } else {
        const serialized =
          event.dataTransfer.getData('application/x-ai-video-asset+json') ||
          event.dataTransfer.getData('text/plain');
        void insert(assetDropIds(serialized, projectId), beforeId).catch((reason) =>
          setMessage(String(reason)),
        );
      }
    } catch (reason) {
      setMessage(String(reason));
    }
  };
  const patchClip = (patch: Partial<RoughCutClip>) => {
    if (selected)
      change({
        ...draft.current,
        clips: draft.current.clips.map((clip) =>
          clip.id === selected.id ? { ...clip, ...patch } : clip,
        ),
      });
  };
  const trimMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = trim.current;
    if (!state) return;
    const delta = Math.round((event.clientX - state.x) / state.scale);
    const value = state.clip[state.side] + delta;
    setTrimPreview({
      ...state.clip,
      [state.side]:
        state.side === 'inMs'
          ? Math.max(0, Math.min(state.clip.outMs - 34, value))
          : Math.max(state.clip.inMs + 34, Math.min(state.clip.durationMs, value)),
    });
  };
  const finishTrim = () => {
    if (trimPreview)
      change({
        ...draft.current,
        clips: draft.current.clips.map((clip) => (clip.id === trimPreview.id ? trimPreview : clip)),
      });
    trim.current = undefined;
    setTrimPreview(undefined);
  };
  const switchSequence = async (sequenceId: string) => {
    setBusy(true);
    try {
      await persist(draft.current, revisionRef.current);
      const state = await call('roughCut.get', { id: sequenceId });
      if (!alive.current) return;
      update(state.sequence);
      versions.current.set(sequenceId, state.sequence.rowVersion);
      setMissing(state.unavailableClipIds);
      dirty.current = false;
      setSaveStatus('已保存到本地');
      setHistory([]);
      setFuture([]);
      setSelectedId(undefined);
      setPlaying(false);
      seek(0);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const newSequence = async () => {
    setBusy(true);
    try {
      await persist(draft.current, revisionRef.current);
      if (!alive.current) return;
      const next = blankSequence(projectId);
      update(next);
      setMissing([]);
      setHistory([]);
      setFuture([]);
      setSelectedId(undefined);
      setPlaying(false);
      seek(0);
      dirty.current = false;
      setSaveStatus('未保存');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const exportSequence = async (format: 'xml' | 'mp4') => {
    setBusy(true);
    setMessage('');
    setPreparingExport(format);
    try {
      await persist(draft.current, revisionRef.current);
      const current = draft.current;
      const result = await call('roughCut.export.start', {
        sequenceId: current.id,
        expectedRowVersion: versions.current.get(current.id) ?? current.rowVersion,
        format,
      });
      updateJob(result);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPreparingExport(undefined);
      }
    }
  };
  const openEpisode = async () => {
    setEpisodeOpen(true);
    setEpisodeLoading(true);
    setEpisodeError('');
    setSceneSelection(sequence.sceneIds);
    try {
      const options = await call('roughCut.episodes', {});
      if (!alive.current) return;
      setEpisodes(options);
      const option =
        options.find(
          (item) =>
            item.sceneIds.length === sequence.sceneIds.length &&
            item.sceneIds.every((sceneId) => sequence.sceneIds.includes(sceneId)),
        ) ?? options[0];
      setEpisodeChoice(option ? String(option.number) : 'custom');
      setSceneSelection(option?.sceneIds ?? sequence.sceneIds);
      setImportNew(
        Boolean(
          sequence.clips.length &&
          (!option || !option.sceneIds.every((sceneId) => sequence.sceneIds.includes(sceneId))),
        ),
      );
    } catch (reason) {
      if (alive.current) setEpisodeError(`集数读取失败：${String(reason)}`);
    } finally {
      if (alive.current) setEpisodeLoading(false);
    }
  };
  const addEpisode = async () => {
    const number = episodeChoice === 'custom' ? Number(customEpisodeNumber) : Number(episodeChoice);
    if (!Number.isSafeInteger(number) || number < 1 || number > 99999)
      throw new Error('请输入 1–99999 的集数。');
    setBusy(true);
    try {
      if (importNew) await persist(draft.current, revisionRef.current);
      const prepared = await call('roughCut.prepare', { sceneIds: sceneSelection });
      if (!alive.current) return;
      const current = importNew ? blankSequence(projectId) : draft.current;
      const additions = prepared.clips.filter(
        (clip) => !current.clips.some((existing) => existing.assetId === clip.assetId),
      );
      if (current.clips.length + additions.length > 200)
        throw new Error('序列最多包含 200 个片段。');
      change({
        ...current,
        name: `第 ${number} 集 · 粗剪`,
        sceneIds: [...sceneSelection],
        clips: [...current.clips, ...additions],
      });
      if (importNew) {
        setMissing([]);
        setSelectedId(undefined);
        seek(0);
      }
      setEpisodeOpen(false);
      setMessage(
        prepared.missingSceneIds.length
          ? `${prepared.missingSceneIds.length} 个场次仍有缺失视频，请补齐后再加入；已有片段保留。`
          : `第 ${number} 集已按故事顺序导入 ${additions.length} 个视频；已有素材未重复加入。`,
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const perform = (action: () => Promise<unknown>) =>
    void action().catch((reason) => setMessage(String(reason)));
  return (
    <section
      ref={workspace}
      className={`rough-cut-workspace${dropHint ? ' is-asset-drag-over' : ''}`}
      aria-label="粗剪工作台"
      onDragOver={(event) => {
        if (writable && loaded && !busy) event.preventDefault();
      }}
      onDrop={(event) => drop(event)}
    >
      <header className="rough-cut-heading">
        <div className="rough-cut-title">
          <input
            aria-label="粗剪序列名称"
            value={sequence.name}
            maxLength={200}
            disabled={!writable || busy || !loaded}
            onChange={(event) => change({ ...draft.current, name: event.target.value })}
          />
          <small>
            {sequence.clips.length} 个视频片段 · {timeLabel(total)}{' '}
            <span aria-live="polite">· {saveStatus}</span>
          </small>
        </div>
        <div className="rough-cut-actions">
          <select
            aria-label="切换粗剪序列"
            value={sequences.some((item) => item.id === sequence.id) ? sequence.id : ''}
            disabled={busy || !loaded}
            onChange={(event) => perform(() => switchSequence(event.target.value))}
          >
            {!sequences.some((item) => item.id === sequence.id) && (
              <option value="">新建序列</option>
            )}
            {sequences.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            type="button"
            title="新建粗剪序列"
            aria-label="新建粗剪序列"
            disabled={!writable || busy || !loaded}
            onClick={() => perform(newSequence)}
          >
            <Plus size={16} />
          </button>
          <button
            className="button subtle"
            type="button"
            title="按集数一键导入，自动按场次和镜头顺序排列"
            disabled={!writable || busy || !loaded}
            onClick={() => perform(openEpisode)}
          >
            <Clapperboard size={14} />
            按集导入
          </button>
          <button
            className="button subtle"
            type="button"
            title="导出 Final Cut Pro 7 XML 和媒体副本"
            disabled={!writable || busy || !sequence.clips.length || job?.status === 'running'}
            onClick={() => perform(() => exportSequence('xml'))}
          >
            <ExternalLink size={14} />
            导出剪辑包
          </button>
          <button
            className="button primary"
            type="button"
            title={
              !sequence.clips.length
                ? '先将视频加入时间线，再导出 MP4'
                : '将当前时间线渲染为 MP4，完成后显示文件位置'
            }
            disabled={!writable || busy || !sequence.clips.length || job?.status === 'running'}
            onClick={() => perform(() => exportSequence('mp4'))}
          >
            {preparingExport === 'mp4'
              ? '正在准备…'
              : job?.format === 'mp4' && job.status === 'running'
                ? '正在导出 MP4…'
                : '导出 MP4'}
          </button>
        </div>
      </header>
      {message && (
        <div className="rough-cut-notice" role="status">
          <span>{message}</span>
          {saveStatus.startsWith('保存失败') && (
            <button
              className="button subtle"
              type="button"
              onClick={() => perform(() => persist(draft.current, revisionRef.current))}
            >
              重试保存
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label="关闭粗剪提示"
            onClick={() => setMessage('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {preparingExport && (
        <div className="rough-cut-notice" role="status">
          正在保存剪辑并准备{preparingExport === 'mp4' ? ' MP4' : '剪辑包'}导出…
        </div>
      )}
      {job && !preparingExport && (
        <RoughCutExportStatus
          key={job.id}
          initial={job}
          onUpdate={updateJob}
          onDismiss={() => {
            latestExports.delete(sessionKey);
            setJob(undefined);
          }}
        />
      )}
      {unavailable.some((clipId) => sequence.clips.some((clip) => clip.id === clipId)) && (
        <div className="rough-cut-notice rough-cut-error" role="alert">
          <span>部分来源视频已删除、移动或发生变化，请恢复来源或替换片段后再导出。</span>
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={() =>
              perform(async () => {
                setBusy(true);
                try {
                  await persist(draft.current, revisionRef.current);
                  const state = await call('roughCut.get', { id: draft.current.id });
                  if (!alive.current) return;
                  setMissing(state.unavailableClipIds);
                  setMediaErrors([]);
                  setSources({});
                } finally {
                  if (alive.current) setBusy(false);
                }
              })
            }
          >
            重新检测来源
          </button>
        </div>
      )}
      <div className={`rough-cut-viewer-row${propertiesOpen ? ' properties-open' : ''}`}>
        <div className="rough-cut-viewer">
          <div className="rough-cut-viewer-toolbar">
            <span>序列预览</span>
            <button
              className="button subtle"
              type="button"
              aria-expanded={propertiesOpen}
              aria-controls="rough-cut-properties"
              onClick={() => setPropertiesOpen((value) => !value)}
            >
              <SlidersHorizontal size={14} />
              属性
            </button>
          </div>
          <div
            className="rough-cut-screen"
            style={
              {
                '--rough-cut-aspect': sequence.clips[0]
                  ? sequence.clips[0].width / sequence.clips[0].height
                  : 16 / 9,
              } as CSSProperties
            }
          >
            <div className="rough-cut-frame">
              <RoughCutPreview
                key={`${sessionKey}:${sequence.id}`}
                clips={sequence.projectId === projectId ? sequence.clips : []}
                sources={sources}
                unavailable={unavailable}
                timeMs={playhead}
                seekRevision={seekRevision}
                playing={playing}
                onTime={(time) => {
                  playheadRef.current = time;
                  setPlayhead(time);
                }}
                onStopped={() => setPlaying(false)}
                onError={setMessage}
              />
            </div>
          </div>
          <div className="rough-cut-transport">
            <span>{timeLabel(playhead)}</span>
            <button
              className="icon-button"
              type="button"
              aria-label={playing ? '暂停预览' : '播放序列'}
              disabled={
                !position ||
                unavailable.includes(position.clip.id) ||
                !sources[position.clip.assetId]
              }
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <input
              aria-label="序列播放位置"
              type="range"
              min={0}
              max={Math.max(1, total)}
              step={1}
              value={Math.min(playhead, total)}
              disabled={!total}
              onChange={(event) => seek(Number(event.target.value))}
            />
            <span>{timeLabel(total)}</span>
          </div>
        </div>
        {propertiesOpen && (
          <aside id="rough-cut-properties" className="rough-cut-properties" aria-label="片段属性">
            <div className="rough-cut-properties-heading">
              <strong>片段属性</strong>
              <button
                className="icon-button"
                type="button"
                aria-label="收起片段属性"
                onClick={() => setPropertiesOpen(false)}
              >
                <X size={15} />
              </button>
            </div>
            {selected ? (
              <>
                <label>
                  片段名称
                  <input
                    key={selected.id}
                    defaultValue={selected.name}
                    maxLength={200}
                    disabled={!writable}
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name && name !== selected.name) patchClip({ name });
                    }}
                  />
                </label>
                <small>
                  源时长 {timeLabel(selected.durationMs)} · {selected.width} × {selected.height}
                </small>
                <div className="rough-cut-range-fields">
                  <label>
                    入点（秒）
                    <input
                      aria-label="片段入点"
                      type="number"
                      step="0.001"
                      min={0}
                      max={(selected.outMs - 34) / 1000}
                      value={selected.inMs / 1000}
                      disabled={!writable}
                      onChange={(event) => {
                        const inMs = Math.round(Number(event.target.value) * 1000);
                        if (inMs >= 0 && inMs <= selected.outMs - 34) patchClip({ inMs });
                      }}
                    />
                  </label>
                  <label>
                    出点（秒）
                    <input
                      aria-label="片段出点"
                      type="number"
                      step="0.001"
                      min={(selected.inMs + 34) / 1000}
                      max={selected.durationMs / 1000}
                      value={selected.outMs / 1000}
                      disabled={!writable}
                      onChange={(event) => {
                        const outMs = Math.round(Number(event.target.value) * 1000);
                        if (outMs <= selected.durationMs && outMs >= selected.inMs + 34)
                          patchClip({ outMs });
                      }}
                    />
                  </label>
                </div>
                <label>
                  画面适配
                  <select
                    value={selected.fit}
                    disabled={!writable}
                    onChange={(event) =>
                      patchClip({ fit: event.target.value as RoughCutClip['fit'] })
                    }
                  >
                    <option value="contain">完整显示</option>
                    <option value="cover">裁切填充</option>
                  </select>
                </label>
                <label className="rough-cut-checkbox">
                  <input
                    type="checkbox"
                    checked={!selected.muted}
                    disabled={!writable || !selected.hasAudio}
                    onChange={(event) => patchClip({ muted: !event.target.checked })}
                  />
                  {selected.hasAudio ? '保留素材原声' : '源素材无音频'}
                </label>
                {candidates.length > 1 && (
                  <label>
                    素材版本
                    <select
                      aria-label="替换素材版本"
                      value={selected.assetId}
                      disabled={!writable || busy}
                      onChange={(event) => {
                        const assetId = event.target.value;
                        setBusy(true);
                        perform(async () => {
                          try {
                            const replacement = (
                              await call('roughCut.prepare', { assetIds: [assetId] })
                            ).clips[0]!;
                            const preserveRange = selected.outMs <= replacement.durationMs;
                            patchClip({
                              ...replacement,
                              id: selected.id,
                              ...(preserveRange
                                ? { inMs: selected.inMs, outMs: selected.outMs }
                                : {}),
                              muted: selected.muted,
                              fit: selected.fit,
                            });
                            setMissing((items) => items.filter((item) => item !== selected.id));
                            setMediaErrors((items) => items.filter((item) => item !== selected.id));
                            if (!preserveRange)
                              setMessage('新版本短于原裁切范围，已恢复为新素材完整时长。');
                          } finally {
                            setBusy(false);
                          }
                        });
                      }}
                    >
                      {candidates.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.alias?.trim() || '视频版本'} ·{' '}
                          {new Date(asset.createdAt).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <small>裁切和静音只影响本序列。源文件保留。</small>
              </>
            ) : (
              <p className="rough-cut-empty-property">选择时间线中的片段以查看属性。</p>
            )}
          </aside>
        )}
      </div>
      <div
        className={`rough-cut-timeline${dropHint ? ' is-drag-over' : ''}`}
        onDragOver={(event) => {
          if (writable && !busy) event.preventDefault();
        }}
        onDrop={(event) => drop(event)}
      >
        <div className="rough-cut-timeline-toolbar">
          <strong>时间线</strong>
          {dropHint && (
            <span className="rough-cut-drop-hint" role="status">
              松开导入 {dropHint.count} 个视频{dropHint.beforeId ? ' · 插入此处' : ' · 追加到末尾'}
            </span>
          )}
          <small>{timeLabel(total)} 总时长</small>
          <div className="rough-cut-edit-tools">
            <button
              className="icon-button"
              type="button"
              aria-label="撤销粗剪"
              disabled={!writable || !history.length}
              onClick={() => {
                const previous = history.at(-1)!;
                const current = draft.current;
                setFuture((items) => [...items, current]);
                setHistory((items) => items.slice(0, -1));
                change({ ...previous, rowVersion: draft.current.rowVersion }, false);
              }}
            >
              <Undo2 size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="重做粗剪"
              disabled={!writable || !future.length}
              onClick={() => {
                const next = future.at(-1)!;
                const current = draft.current;
                setHistory((items) => [...items, current]);
                setFuture((items) => items.slice(0, -1));
                change({ ...next, rowVersion: draft.current.rowVersion }, false);
              }}
            >
              <Redo2 size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="向前移动片段"
              disabled={!writable || !selected || sequence.clips[0]?.id === selected.id}
              onClick={() => {
                const index = sequence.clips.findIndex((clip) => clip.id === selectedId);
                change({
                  ...draft.current,
                  clips: moveClip(sequence.clips, selectedId!, sequence.clips[index - 1]?.id),
                });
              }}
            >
              <ArrowLeft size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="向后移动片段"
              disabled={!writable || !selected || sequence.clips.at(-1)?.id === selected?.id}
              onClick={() => {
                const index = sequence.clips.findIndex((clip) => clip.id === selectedId);
                change({
                  ...draft.current,
                  clips: moveClip(sequence.clips, selectedId!, sequence.clips[index + 2]?.id),
                });
              }}
            >
              <ArrowRight size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="在播放头处分割"
              disabled={!writable || !position}
              onClick={() => {
                const clips = splitClip(sequence.clips, playhead, crypto.randomUUID());
                if (clips !== sequence.clips) change({ ...draft.current, clips });
                else setMessage('请将播放头移动到片段内部，分割后每段至少保留一帧。');
              }}
            >
              <Scissors size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="移除片段"
              disabled={!writable || !selected}
              onClick={() => {
                change({
                  ...draft.current,
                  clips: sequence.clips.filter((clip) => clip.id !== selected?.id),
                });
                setSelectedId(undefined);
              }}
            >
              <Trash2 size={15} />
            </button>
            <label className="rough-cut-zoom">
              缩放
              <input
                aria-label="时间线缩放"
                type="range"
                min={1}
                max={5}
                step={0.25}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
          </div>
        </div>
        <div className="rough-cut-timeline-scroll">
          <div className="rough-cut-tracks" style={{ minWidth: `${zoom * 100}%` }}>
            <div className="rough-cut-ruler">
              {Array.from({ length: 7 }, (_, index) => (
                <span key={index} style={{ left: `${(index / 6) * 100}%` }}>
                  {timeLabel((total * index) / 6)}
                </span>
              ))}
            </div>
            <div className="rough-cut-track">
              <span className="rough-cut-track-label">视频 1</span>
              <div className="rough-cut-clip-row">
                {!sequence.clips.length && (
                  <span className="rough-cut-drop-placeholder">
                    拖入视频至此，按故事顺序建立时间线
                  </span>
                )}
                {sequence.clips.map((clip, index) => {
                  const displayed = trimPreview?.id === clip.id ? trimPreview : clip;
                  const start = sequenceLength(sequence.clips.slice(0, index));
                  return (
                    <div
                      key={clip.id}
                      data-rough-cut-clip={clip.id}
                      className={`rough-cut-clip${selectedId === clip.id ? ' selected' : ''}${unavailable.includes(clip.id) ? ' unavailable' : ''}${dropHint?.beforeId === clip.id ? ' drop-before' : ''}`}
                      style={{ flex: `0 0 ${(clipLength(clip) / Math.max(1, total)) * 100}%` }}
                      draggable={writable && !busy}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          'application/x-ai-video-rough-cut',
                          JSON.stringify({ sequenceId: sequence.id, clipId: clip.id }),
                        );
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(event) => {
                        if (writable && !busy) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.classList.add('drop-before');
                        }
                      }}
                      onDragLeave={(event) => event.currentTarget.classList.remove('drop-before')}
                      onDrop={(event) => {
                        event.currentTarget.classList.remove('drop-before');
                        drop(event, clip.id);
                      }}
                    >
                      <button
                        className="rough-cut-clip-select"
                        type="button"
                        aria-label={`选择片段 ${index + 1} ${clip.name}`}
                        aria-pressed={selectedId === clip.id}
                        onClick={() => {
                          setSelectedId(clip.id);
                          setPlaying(false);
                          seek(start);
                        }}
                      >
                        {sources[clip.assetId] && !unavailable.includes(clip.id) && (
                          <video
                            src={`${sources[clip.assetId]}#t=${clip.inMs / 1000}`}
                            preload="metadata"
                            muted
                            playsInline
                          />
                        )}
                        <span>
                          {clip.name}
                          <small>
                            {timeLabel(clipLength(displayed))}
                            {unavailable.includes(clip.id) ? ' · 来源不可用' : ''}
                          </small>
                        </span>
                      </button>
                      {(['inMs', 'outMs'] as const).map((side) => (
                        <button
                          key={side}
                          className={`rough-cut-trim-handle ${side === 'inMs' ? 'left' : 'right'}`}
                          type="button"
                          aria-label={`${side === 'inMs' ? '裁切入点' : '裁切出点'} ${clip.name}`}
                          disabled={!writable}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedId(clip.id);
                            setPlaying(false);
                            event.currentTarget.setPointerCapture(event.pointerId);
                            trim.current = {
                              clip,
                              side,
                              x: event.clientX,
                              scale:
                                (event.currentTarget.parentElement?.getBoundingClientRect().width ??
                                  1) / clipLength(clip),
                            };
                          }}
                          onPointerMove={trimMove}
                          onPointerUp={finishTrim}
                          onPointerCancel={() => {
                            trim.current = undefined;
                            setTrimPreview(undefined);
                          }}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="rough-cut-track rough-cut-audio-track">
              <span className="rough-cut-track-label">
                <Volume2 size={13} />
                原声
              </span>
              <div className="rough-cut-clip-row">
                {sequence.clips.map((clip) => (
                  <div
                    className={`rough-cut-audio-clip${clip.muted || !clip.hasAudio ? ' muted' : ''}`}
                    key={clip.id}
                    style={{ flex: `0 0 ${(clipLength(clip) / Math.max(1, total)) * 100}%` }}
                  >
                    {clip.muted || !clip.hasAudio ? <VolumeX size={13} /> : <Volume2 size={13} />}
                    <span>{clip.muted ? '已静音' : clip.hasAudio ? '素材原声' : '无原声'}</span>
                  </div>
                ))}
              </div>
            </div>
            {total > 0 && (
              <div
                className="rough-cut-playhead"
                style={{ left: `calc(72px + (100% - 72px) * ${Math.min(1, playhead / total)})` }}
              />
            )}
          </div>
        </div>
        <div className="rough-cut-timeline-footer">
          <small>
            {busy ? '正在处理素材…' : '拖动调整顺序 · 拖动片段两端裁切 · 在属性中精确设置起止点'}
          </small>
          {sequence.rowVersion > 0 && (
            <button
              type="button"
              className="button subtle"
              disabled={!writable || busy}
              onClick={() => {
                if (!window.confirm('删除当前粗剪序列？源素材会保留。')) return;
                perform(async () => {
                  setBusy(true);
                  try {
                    await persist(draft.current, revisionRef.current);
                    await call('roughCut.delete', {
                      id: sequence.id,
                      expectedRowVersion: versions.current.get(sequence.id) ?? sequence.rowVersion,
                    });
                    setSequences((items) => items.filter((item) => item.id !== sequence.id));
                    dirty.current = false;
                    await newSequence();
                  } finally {
                    if (alive.current) setBusy(false);
                  }
                });
              }}
            >
              删除序列
            </button>
          )}
        </div>
      </div>
      {episodeOpen && (
        <div className="rough-cut-dialog-backdrop" onClick={() => !busy && setEpisodeOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="按集导入"
            className="rough-cut-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rough-cut-properties-heading">
              <strong>按集导入</strong>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭本集选材"
                disabled={busy}
                onClick={() => setEpisodeOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p>选择集数，一键导入本集视频，按场次与镜头顺序排列。</p>
            {episodeLoading ? (
              <p role="status">正在读取集数…</p>
            ) : (
              <>
                {episodeError && <p role="alert">{episodeError}</p>}
                <label className="rough-cut-episode-field">
                  选择集数
                  <select
                    aria-label="选择集数"
                    value={episodeChoice}
                    disabled={busy}
                    onChange={(event) => {
                      const choice = event.target.value;
                      setEpisodeChoice(choice);
                      const option = episodes.find((item) => String(item.number) === choice);
                      setSceneSelection(option?.sceneIds ?? []);
                      setImportNew(
                        Boolean(
                          sequence.clips.length &&
                          (!option ||
                            !option.sceneIds.every((sceneId) =>
                              sequence.sceneIds.includes(sceneId),
                            )),
                        ),
                      );
                    }}
                  >
                    {episodes.map((item) => (
                      <option key={item.number} value={item.number}>
                        第 {item.number} 集 · {item.sceneIds.length} 个场次
                      </option>
                    ))}
                    <option value="custom">手动设置集数与场次</option>
                  </select>
                </label>
                {episodeChoice === 'custom' && (
                  <label className="rough-cut-episode-field">
                    集数
                    <input
                      aria-label="手动设置集数"
                      type="number"
                      min="1"
                      max="99999"
                      step="1"
                      value={customEpisodeNumber}
                      disabled={busy}
                      onChange={(event) => setCustomEpisodeNumber(event.target.value)}
                    />
                  </label>
                )}
                {!episodes.length && (
                  <p>当前场次没有已保存的集数关联。设置一次集数与场次，保存后即可按集导入。</p>
                )}
                <p>
                  已选 {sceneSelection.length}{' '}
                  个场次。整场视频优先，缺少时使用各镜头最新视频；缺失素材会提示。
                </p>
              </>
            )}
            <div className="rough-cut-scene-options">
              {[...scenes]
                .sort((a, b) => a.position - b.position)
                .map((scene) => (
                  <label className="rough-cut-checkbox" key={scene.id}>
                    <input
                      type="checkbox"
                      checked={sceneSelection.includes(scene.id)}
                      disabled={busy || episodeLoading || episodeChoice !== 'custom'}
                      onChange={(event) =>
                        setSceneSelection((items) =>
                          event.target.checked
                            ? [...items, scene.id]
                            : items.filter((item) => item !== scene.id),
                        )
                      }
                    />
                    {scene.title}
                  </label>
                ))}
              {!scenes.length && <p>项目中还没有场次，可先从素材库直接加入视频。</p>}
            </div>
            {episodeChoice !== 'custom' && (
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() => {
                  setCustomEpisodeNumber(episodeChoice);
                  setEpisodeChoice('custom');
                }}
              >
                调整本集场次
              </button>
            )}
            {sequence.clips.length > 0 && (
              <label className="rough-cut-checkbox">
                <input
                  type="checkbox"
                  checked={importNew}
                  disabled={busy}
                  onChange={(event) => setImportNew(event.target.checked)}
                />
                导入到新序列，保留当前剪辑
              </label>
            )}
            <button
              type="button"
              className="button primary"
              disabled={busy || episodeLoading || !sceneSelection.length}
              onClick={() => void addEpisode().catch((reason) => setEpisodeError(String(reason)))}
            >
              <Check size={14} />
              {busy ? '正在导入…' : '一键导入本集'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
