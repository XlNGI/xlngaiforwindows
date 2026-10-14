import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useRef, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  DubbingCueInfo,
  DubbingJobInfo,
  DubbingSceneSnapshot,
  DubbingTakeInfo,
  ProviderProfileInfo,
  WorkerMethodMap,
} from '@ai-video/contracts';
import { callWorker } from '../worker-client';
import { useDubbingMedia } from './media';
import './dubbing.css';

type RuntimeInfo = WorkerMethodMap['dubbing.runtime.get']['result'];
type Props = {
  projectId: string;
  sceneId: string;
  documents: DocumentSummary[];
  writable: boolean;
  onOpenAsset?: (assetId: string) => void;
};
type Editor = {
  id?: string;
  rowVersion?: number;
  speaker: string;
  voiceId: string;
  text: string;
  startSeconds: string;
  emotion: string;
  lipSync: boolean;
  visibleSpeaker: string;
  x: string;
  y: string;
  pauseSeconds: string;
};
const newEditor = (): Editor => ({
  speaker: '',
  voiceId: '',
  text: '',
  startSeconds: '0',
  emotion: '',
  lipSync: false,
  visibleSpeaker: '',
  x: '',
  y: '',
  pauseSeconds: '0',
});
const statusLabels: Record<DubbingJobInfo['status'], string> = {
  pending: '等待处理',
  running: '正在处理',
  submission_unknown: '提交结果待核实',
  interrupted: '已中断',
  cancelling: '正在停止',
  cancelled: '已停止',
  failed: '处理失败',
  complete: '已完成',
};
const stepLabels: Record<string, string> = {
  speech: '生成配音',
  prepare: '准备片段',
  upload: '上传片段',
  lipsync: '处理口型',
  download: '保存结果',
  validate: '检查结果',
  compose: '合成场次',
  commit: '保存成片',
};
const inProgress = (job: DubbingJobInfo) =>
  ['pending', 'running', 'cancelling'].includes(job.status);
function jobCueId(job: DubbingJobInfo): string | undefined {
  if (typeof job.inputSnapshot.cueId === 'string') return job.inputSnapshot.cueId;
  const value = job.inputSnapshot.cue;
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? value.id
    : undefined;
}

export function DubbingScenePanel(props: Props) {
  return <DubbingSceneContent key={`${props.projectId}:${props.sceneId}`} {...props} />;
}
function DubbingSceneContent({ projectId, sceneId, documents, writable, onOpenAsset }: Props) {
  const active = useRef(true);
  const loadSequence = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<DubbingSceneSnapshot>();
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [profiles, setProfiles] = useState<ProviderProfileInfo[]>([]);
  const [videos, setVideos] = useState<AssetInfo[]>([]);
  const [editor, setEditor] = useState<Editor>(newEditor);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [videoId, setVideoId] = useState('');
  const [mode, setMode] = useState<'compose' | 'lipsync'>('compose');
  const [syncProfileId, setSyncProfileId] = useState('');
  const [costAcknowledged, setCostAcknowledged] = useState(false);
  const [removeSourceAudio, setRemoveSourceAudio] = useState(false);
  const [unitPrice, setUnitPrice] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const characters = documents.filter(
    (item) =>
      item.projectId === projectId &&
      item.kind === 'character' &&
      item.lifecycleStatus !== 'archived',
  );
  const voices = snapshot?.voices ?? [];
  const cues = snapshot?.cues ?? [];
  const jobs = snapshot?.jobs ?? [];
  const lipSyncSeconds = cues
    .filter((item) => item.lipSync)
    .reduce((total, cue) => {
      const take = cue.takes?.find((item) => item.id === cue.selectedTakeId);
      return (
        total +
        (snapshot?.audioFiles.find((item) => item.id === take?.audioId)?.durationMs ?? 0) / 1000
      );
    }, 0);
  const readyProvider = (id?: string) =>
    profiles.some(
      (item) =>
        item.id === id && item.enabled && !item.archivedAt && item.connectionStatus === 'ready',
    );

  const refresh = async () => {
    const sequence = ++loadSequence.current;
    const data = await callWorker('dubbing.scene.get', { sceneId });
    if (active.current && sequence === loadSequence.current) setSnapshot(data);
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      loadSequence.current++;
    };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setLoading(true);
    void Promise.all([
      callWorker('dubbing.scene.get', { sceneId }),
      callWorker('dubbing.runtime.get', {}),
      callWorker('provider.profile.list', {}),
      callWorker('asset.list', { sceneId, kind: 'video', limit: 100 }),
    ])
      .then(async ([data, tools, connections, sceneVideos]) => {
        const usableSceneVideos = sceneVideos.filter(
          (item) => !item.deletedAt && item.kind.toLowerCase().includes('video'),
        );
        const assets = usableSceneVideos.length
          ? usableSceneVideos
          : await callWorker('asset.list', { kind: 'video', limit: 100 });
        if (!current || !active.current) return;
        setSnapshot(data);
        setRuntime(tools);
        setProfiles(connections);
        const allowed = assets.filter(
          (item) =>
            item.projectId === projectId &&
            !item.deletedAt &&
            item.kind.toLowerCase().includes('video'),
        );
        setVideos(allowed);
        setVideoId(allowed[0]?.id ?? '');
        setSyncProfileId(
          connections.find(
            (item) => item.providerType === 'sync' && item.enabled && !item.archivedAt,
          )?.id ?? '',
        );
      })
      .catch((error: unknown) => {
        if (current && active.current)
          setMessage(error instanceof Error ? error.message : '配音读取失败。');
      })
      .finally(() => {
        if (current && active.current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [expanded, projectId, sceneId]);
  const running = jobs.some(inProgress);
  useEffect(() => {
    if (!expanded || !running) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [expanded, running, sceneId]);

  const perform = async (operation: () => Promise<unknown>, success?: string) => {
    if (!writable || busy) return;
    setBusy(true);
    setMessage('');
    try {
      await operation();
      if (!active.current) return;
      await refresh();
      if (active.current && success) setMessage(success);
    } catch (error) {
      if (active.current)
        setMessage(error instanceof Error ? error.message : '操作失败，请检查设置后重试。');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const saveCue = async () => {
    const narration = editor.speaker === 'narration';
    const selectedVoice = narration
      ? voices.find((item) => item.id === editor.voiceId)
      : voices.find((item) => item.characterDocumentId === editor.speaker);
    if (!selectedVoice) {
      setMessage('请先为说话者保存声音。');
      return;
    }
    const startMs = Math.round(Number(editor.startSeconds) * 1000);
    const trailingPauseMs = Math.round(Number(editor.pauseSeconds) * 1000);
    const hasCoordinates = editor.x !== '' || editor.y !== '';
    if (
      !Number.isFinite(startMs) ||
      startMs < 0 ||
      !Number.isFinite(trailingPauseMs) ||
      trailingPauseMs < 0 ||
      (hasCoordinates && (editor.x === '' || editor.y === ''))
    ) {
      setMessage('请填写有效的起点、停顿和完整的人物位置。');
      return;
    }
    if (editor.lipSync && !narration && (!editor.visibleSpeaker.trim() || !hasCoordinates)) {
      setMessage('口型处理需要说明画面中的说话者，并填写人物位置。');
      return;
    }
    await perform(async () => {
      await callWorker('dubbing.cue.save', {
        id: editor.id,
        sceneId,
        speakerKind: narration ? 'narration' : 'character',
        characterDocumentId: narration ? undefined : editor.speaker,
        voiceProfileId: selectedVoice.id,
        text: editor.text,
        position: editor.id
          ? (cues.find((item) => item.id === editor.id)?.position ?? 0)
          : cues.length,
        startMs,
        trailingPauseMs,
        emotion: editor.emotion || undefined,
        lipSync: !narration && editor.lipSync,
        visibleSpeaker: editor.visibleSpeaker.trim() || undefined,
        speakerCoordinates: hasCoordinates ? [Number(editor.x), Number(editor.y)] : undefined,
        expectedRowVersion: editor.rowVersion,
      });
      if (active.current) setEditor(newEditor());
    }, '台词已保存，可生成或导入配音。');
  };
  const editCue = (cue: DubbingCueInfo) => {
    setEditor({
      id: cue.id,
      rowVersion: cue.rowVersion,
      speaker: cue.speakerKind === 'narration' ? 'narration' : (cue.characterDocumentId ?? ''),
      voiceId: cue.voiceProfileId ?? '',
      text: cue.text,
      startSeconds: String(cue.startMs / 1000),
      emotion: cue.emotion ?? '',
      lipSync: cue.lipSync,
      visibleSpeaker: cue.visibleSpeaker ?? '',
      x: cue.speakerCoordinates ? String(cue.speakerCoordinates[0]) : '',
      y: cue.speakerCoordinates ? String(cue.speakerCoordinates[1]) : '',
      pauseSeconds: String((cue.trailingPauseMs ?? 0) / 1000),
    });
  };
  const importAudio = async (cue: DubbingCueInfo) => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setMessage('请在桌面应用中选择本地 WAV 或 MP3 配音文件。');
      return;
    }
    await perform(async () => {
      const selected = await openDialog({
        title: '导入这一条台词的配音',
        multiple: false,
        directory: false,
        filters: [{ name: '音频', extensions: ['wav', 'mp3'] }],
      });
      if (!active.current || typeof selected !== 'string') return;
      await callWorker('audio.import', {
        sourcePath: selected,
        cueId: cue.id,
        expectedRowVersion: cue.rowVersion,
      });
    }, '导入完成。试听后选择采用。');
  };
  const submit = () => {
    if (!videoId || !removeSourceAudio || (mode === 'lipsync' && !costAcknowledged)) return;
    const price = unitPrice.trim() ? Number(unitPrice) : undefined;
    const maximum = maxAmount.trim() ? Number(maxAmount) : undefined;
    if (
      (price !== undefined && (!Number.isFinite(price) || price < 0)) ||
      (maximum !== undefined && (!Number.isFinite(maximum) || maximum <= 0))
    ) {
      setMessage('请填写有效的单价和费用上限。');
      return;
    }
    void perform(
      () =>
        callWorker('dubbing.job.submit', {
          sceneId,
          sourceVideoAssetId: videoId,
          mode,
          providerProfileId: mode === 'lipsync' ? syncProfileId : undefined,
          model: mode === 'lipsync' ? 'sync-3' : undefined,
          budget:
            mode === 'lipsync'
              ? { currency, unitPrice: price, maxAmount: maximum, maxAttempts: 1 }
              : undefined,
          costAcknowledged: mode === 'compose' || costAcknowledged,
          removeSourceAudioAcknowledged: removeSourceAudio,
        }),
      '已提交，可在后台任务中查看进度。',
    );
  };
  const selectedVideo = videos.find((item) => item.id === videoId);
  return (
    <section className="dubbing-panel" aria-label="场次配音">
      <div className="dubbing-heading">
        <div>
          <h2>场次配音</h2>
          <p>录入台词，确认固定配音，再处理口型或合成完整场次。</p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? '收起配音' : '打开配音'}
        </button>
      </div>
      {expanded ? (
        <>
          {!writable ? (
            <p className="dubbing-note">当前项目为只读，可以试听已有配音和成片。</p>
          ) : null}
          {loading ? <p role="status">正在读取配音…</p> : null}
          {runtime && !runtime.available ? (
            <p className="dubbing-error">
              本地合成工具暂不可用：{runtime.error || '请检查安装资源。'}
            </p>
          ) : null}
          {runtime && !runtime.nativeAvailable ? (
            <p className="dubbing-note">
              远程配音与口型处理需要桌面应用；可先编辑台词和试听已有结果。
            </p>
          ) : null}
          <label className="dubbing-check">
            <input
              type="checkbox"
              checked={costAcknowledged}
              disabled={!writable || busy}
              onChange={(event) => setCostAcknowledged(event.target.checked)}
            />
            我确认生成配音或处理口型可能产生费用；每次手动提交，不自动重试付费请求。
          </label>
          <ul className="dubbing-cue-list">
            {cues.map((cue) => {
              const voice = voices.find(
                (item) =>
                  item.id === cue.voiceProfileId ||
                  item.characterDocumentId === cue.characterDocumentId,
              );
              const name =
                cue.speakerKind === 'narration'
                  ? '旁白'
                  : (characters.find((item) => item.id === cue.characterDocumentId)?.title ??
                    '历史角色');
              const producing = jobs.some((item) => inProgress(item) && jobCueId(item) === cue.id);
              return (
                <li className="dubbing-cue" key={cue.id}>
                  <div className="dubbing-heading">
                    <strong>
                      {cue.position + 1}. {name}
                    </strong>
                    <span className="dubbing-badge">
                      {(cue.startMs / 1000).toFixed(2)} 秒 · {cue.lipSync ? '需要口型' : '直接配音'}
                    </span>
                  </div>
                  <p className="dubbing-cue-text">{cue.text}</p>
                  <div className="dubbing-actions">
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!writable || busy}
                      onClick={() => editCue(cue)}
                    >
                      编辑台词
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={
                        !writable ||
                        busy ||
                        producing ||
                        !costAcknowledged ||
                        !runtime?.nativeAvailable ||
                        !runtime?.available ||
                        !readyProvider(voice?.providerProfileId)
                      }
                      onClick={() =>
                        void perform(
                          () =>
                            callWorker('dubbing.take.generate', {
                              cueId: cue.id,
                              expectedRowVersion: cue.rowVersion,
                              costAcknowledged,
                            }),
                          '配音已提交，完成后请试听。',
                        )
                      }
                    >
                      生成配音
                    </button>
                    {cue.takes?.length ? (
                      <button
                        className="text-button"
                        type="button"
                        disabled={
                          !writable ||
                          busy ||
                          producing ||
                          !costAcknowledged ||
                          !runtime?.nativeAvailable ||
                          !runtime.available ||
                          !readyProvider(voice?.providerProfileId)
                        }
                        onClick={() =>
                          void perform(
                            () =>
                              callWorker('dubbing.take.generate', {
                                cueId: cue.id,
                                expectedRowVersion: cue.rowVersion,
                                costAcknowledged,
                                forceNewTake: true,
                              }),
                            '已提交新配音版本，原配音保留。',
                          )
                        }
                      >
                        重新生成新版本
                      </button>
                    ) : null}
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!writable || busy}
                      onClick={() => void importAudio(cue)}
                    >
                      导入配音
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      disabled={!writable || busy}
                      onClick={() =>
                        void perform(() =>
                          callWorker('dubbing.cue.delete', {
                            cueId: cue.id,
                            expectedRowVersion: cue.rowVersion,
                          }),
                        )
                      }
                    >
                      删除台词
                    </button>
                  </div>
                  <div className="dubbing-takes">
                    {(cue.takes ?? []).map((take) => (
                      <TakePreview
                        key={take.id}
                        projectId={projectId}
                        take={take}
                        selected={cue.selectedTakeId === take.id}
                        writable={writable && !busy}
                        onAdopt={() =>
                          void perform(
                            () =>
                              callWorker('dubbing.take.adopt', {
                                cueId: cue.id,
                                takeId: take.id,
                                expectedRowVersion: cue.rowVersion,
                              }),
                            '已采用这份配音。',
                          )
                        }
                      />
                    ))}
                  </div>
                  {!cue.takes?.length ? (
                    <p className="dubbing-note">尚无配音。也可导入已经确认音色的本地录音。</p>
                  ) : !cue.selectedTakeId ? (
                    <p className="dubbing-note">请试听并采用一份配音。</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="dubbing-cue-editor">
            <h3>{editor.id ? '编辑台词' : '添加台词'}</h3>
            <fieldset className="dubbing-fields" disabled={!writable || busy || loading}>
              <label>
                说话者
                <select
                  value={editor.speaker}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      speaker: event.target.value,
                      lipSync: event.target.value === 'narration' ? false : editor.lipSync,
                    })
                  }
                >
                  <option value="">选择角色或旁白</option>
                  {characters.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                  <option value="narration">旁白</option>
                </select>
              </label>
              {editor.speaker === 'narration' ? (
                <label>
                  旁白音色
                  <select
                    value={editor.voiceId}
                    onChange={(event) => setEditor({ ...editor, voiceId: event.target.value })}
                  >
                    <option value="">选择已保存的声音</option>
                    {voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {characters.find((item) => item.id === voice.characterDocumentId)?.title ??
                          '旁白'}{' '}
                        · {voice.voiceId}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                视频起点（秒）
                <input
                  type="number"
                  min="0"
                  max="600"
                  step="0.001"
                  value={editor.startSeconds}
                  onChange={(event) => setEditor({ ...editor, startSeconds: event.target.value })}
                />
              </label>
              <label>
                句后停顿（秒）
                <input
                  type="number"
                  min="0"
                  max="60"
                  step="0.001"
                  value={editor.pauseSeconds}
                  onChange={(event) => setEditor({ ...editor, pauseSeconds: event.target.value })}
                />
              </label>
              <label>
                情绪
                <select
                  value={editor.emotion}
                  onChange={(event) => setEditor({ ...editor, emotion: event.target.value })}
                >
                  <option value="">自然</option>
                  <option value="happy">开心</option>
                  <option value="sad">悲伤</option>
                  <option value="angry">生气</option>
                  <option value="fearful">害怕</option>
                  <option value="surprised">惊讶</option>
                  <option value="calm">平静</option>
                  <option value="disgusted">厌恶</option>
                </select>
              </label>
            </fieldset>
            <label>
              台词内容
              <textarea
                maxLength={4000}
                value={editor.text}
                readOnly={!writable || busy}
                onChange={(event) => setEditor({ ...editor, text: event.target.value })}
                placeholder="录入确认后的台词…"
              />
            </label>
            <label className="dubbing-check">
              <input
                type="checkbox"
                checked={editor.lipSync}
                disabled={!writable || busy || editor.speaker === 'narration'}
                onChange={(event) => setEditor({ ...editor, lipSync: event.target.checked })}
              />
              这段有可见说话人物，需要处理口型
            </label>
            {editor.lipSync ? (
              <fieldset className="dubbing-fields" disabled={!writable || busy}>
                <label>
                  画面中的说话者
                  <input
                    value={editor.visibleSpeaker}
                    onChange={(event) =>
                      setEditor({ ...editor, visibleSpeaker: event.target.value })
                    }
                    placeholder="例如：画面左侧的女主"
                  />
                </label>
                <label>
                  人物横向位置（0–1）
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={editor.x}
                    onChange={(event) => setEditor({ ...editor, x: event.target.value })}
                  />
                </label>
                <label>
                  人物纵向位置（0–1）
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={editor.y}
                    onChange={(event) => setEditor({ ...editor, y: event.target.value })}
                  />
                </label>
              </fieldset>
            ) : null}
            <div className="dubbing-actions">
              <button
                className="button secondary"
                type="button"
                disabled={!writable || busy || loading || !editor.speaker || !editor.text.trim()}
                onClick={() => void saveCue()}
              >
                保存台词
              </button>
              {editor.id ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setEditor(newEditor())}
                >
                  取消编辑
                </button>
              ) : null}
            </div>
            {!voices.length ? (
              <p className="dubbing-note">先在角色资料中保存声音，旁白也可复用已保存的声音。</p>
            ) : null}
          </div>
          <div className="dubbing-output-editor">
            <h3>制作场次成片</h3>
            <fieldset className="dubbing-fields" disabled={!writable || busy || loading}>
              <label>
                源视频
                <select value={videoId} onChange={(event) => setVideoId(event.target.value)}>
                  <option value="">选择已有视频</option>
                  {videos.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.alias || item.relativePath.split(/[\\/]/).pop() || item.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                制作方式
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as 'compose' | 'lipsync')}
                >
                  <option value="compose">直接配音合成</option>
                  <option value="lipsync">先处理口型，再合成</option>
                </select>
              </label>
              {mode === 'lipsync' ? (
                <>
                  <label>
                    口型连接
                    <select
                      value={syncProfileId}
                      onChange={(event) => setSyncProfileId(event.target.value)}
                    >
                      <option value="">选择 Sync 连接</option>
                      {profiles
                        .filter(
                          (item) =>
                            item.providerType === 'sync' && item.enabled && !item.archivedAt,
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                            {item.connectionStatus !== 'ready' ? '（待验证）' : ''}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    币种
                    <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                      <option value="USD">USD</option>
                      <option value="CNY">CNY</option>
                    </select>
                  </label>
                  <label>
                    每秒单价
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={unitPrice}
                      placeholder="未知"
                      onChange={(event) => setUnitPrice(event.target.value)}
                    />
                  </label>
                  <label>
                    本次费用上限
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={maxAmount}
                      placeholder="填写预算"
                      onChange={(event) => setMaxAmount(event.target.value)}
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
            {selectedVideo ? (
              <VideoPreview projectId={projectId} assetId={selectedVideo.id} label="源视频试听" />
            ) : null}
            <label className="dubbing-check">
              <input
                type="checkbox"
                disabled={!writable || busy}
                checked={removeSourceAudio}
                onChange={(event) => setRemoveSourceAudio(event.target.checked)}
              />
              我确认移除源视频全部声音（包含背景声），使用已采用的配音合成新视频。
            </label>
            <p className="dubbing-note">
              成片使用已采用的配音，源视频保留。所有台词需先试听采用，并按实际时长安排互不重叠的区间。
            </p>
            {mode === 'lipsync' && !unitPrice.trim() ? (
              <p className="dubbing-note">
                当前单价未知，仅允许单段验证；不显示为免费，也不自动扩大处理范围。
              </p>
            ) : null}
            {mode === 'lipsync' &&
            unitPrice.trim() &&
            Number.isFinite(Number(unitPrice)) &&
            Number(unitPrice) >= 0 ? (
              <p className="dubbing-note">
                口型区间合计 {lipSyncSeconds.toFixed(2)} 秒，按填写单价估算{' '}
                {(lipSyncSeconds * Number(unitPrice)).toFixed(4)} {currency}
                。实际费用以供应商账单为准。
              </p>
            ) : null}
            <div className="dubbing-actions">
              <button
                className="button primary"
                type="button"
                disabled={
                  !writable ||
                  busy ||
                  !runtime?.available ||
                  !videoId ||
                  !removeSourceAudio ||
                  !cues.length ||
                  cues.some((item) => !item.selectedTakeId) ||
                  (mode === 'lipsync' &&
                    (!runtime.nativeAvailable ||
                      !costAcknowledged ||
                      !readyProvider(syncProfileId)))
                }
                onClick={submit}
              >
                提交制作
              </button>
              <button
                className="text-button"
                type="button"
                disabled={loading}
                onClick={() =>
                  void refresh().catch((error: unknown) => {
                    if (active.current)
                      setMessage(error instanceof Error ? error.message : '刷新失败。');
                  })
                }
              >
                刷新进度
              </button>
            </div>
          </div>
          {jobs.length ? (
            <div className="dubbing-output-editor">
              <h3>配音任务与成片</h3>
              <p className="dubbing-note">
                收起面板后任务继续运行。提交结果不明确时先核实，不重复付费提交。
              </p>
              <ul className="dubbing-job-list">
                {jobs.map((job) => (
                  <li className="dubbing-job" key={job.id}>
                    <div className="dubbing-heading">
                      <strong>
                        {job.kind === 'speech'
                          ? '台词配音'
                          : job.kind === 'lipsync'
                            ? '口型与成片'
                            : '场次合成'}
                      </strong>
                      <span className="dubbing-badge">{statusLabels[job.status]}</span>
                    </div>
                    <div className="dubbing-job-steps">
                      {job.steps?.map((step) => (
                        <span key={step.id}>
                          {stepLabels[step.kind] ?? step.kind} · {statusLabels[step.status]}
                        </span>
                      ))}
                    </div>
                    {job.error ? <p className="dubbing-error">{job.error}</p> : null}
                    {job.kind !== 'compose' ? (
                      <p className="dubbing-note">
                        {job.budget.state === 'estimated' && job.budget.estimatedTotal !== undefined
                          ? `预计费用 ${job.budget.estimatedTotal.toFixed(4)} ${job.budget.currency ?? ''}`
                          : '本次供应商费用未知'}
                        ；每次付费提交需确认。
                      </p>
                    ) : null}
                    {job.outputAssetId ? (
                      <VideoPreview
                        projectId={projectId}
                        assetId={job.outputAssetId}
                        label="成片试听"
                      />
                    ) : null}
                    <div className="dubbing-actions">
                      {inProgress(job) || job.status === 'submission_unknown' ? (
                        <button
                          className="button secondary"
                          type="button"
                          disabled={!writable || busy}
                          onClick={() =>
                            void perform(() => callWorker('dubbing.job.cancel', { jobId: job.id }))
                          }
                        >
                          停止任务
                        </button>
                      ) : null}
                      {job.status === 'failed' ? (
                        <button
                          className="button secondary"
                          type="button"
                          disabled={
                            !writable || busy || (job.kind !== 'compose' && !costAcknowledged)
                          }
                          onClick={() =>
                            void perform(
                              () =>
                                callWorker('dubbing.job.retry', {
                                  jobId: job.id,
                                  costAcknowledged,
                                }),
                              '已请求重试，成功片段会复用。',
                            )
                          }
                        >
                          重试失败步骤
                        </button>
                      ) : null}
                      {job.status === 'complete' && job.outputAssetId ? (
                        <>
                          <button
                            className="button secondary"
                            type="button"
                            disabled={!writable || busy || !!job.adoptedAt}
                            onClick={() =>
                              void perform(
                                () =>
                                  callWorker('dubbing.output.adopt', {
                                    jobId: job.id,
                                    expectedRowVersion: job.rowVersion,
                                  }),
                                '已采用场次成片。',
                              )
                            }
                          >
                            {job.adoptedAt ? '已采用成片' : '采用成片'}
                          </button>
                          {onOpenAsset ? (
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => onOpenAsset(job.outputAssetId!)}
                            >
                              查看素材
                            </button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {message ? (
            <p role="status" className="dubbing-note">
              {message}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function TakePreview({
  projectId,
  take,
  selected,
  writable,
  onAdopt,
}: {
  projectId: string;
  take: DubbingTakeInfo;
  selected: boolean;
  writable: boolean;
  onAdopt: () => void;
}) {
  const source = useDubbingMedia(projectId, take.audioId, true);
  return (
    <div className="dubbing-take">
      {source?.src ? (
        <audio controls preload="metadata" src={source.src} aria-label="配音试听" />
      ) : (
        <span>{source?.error ?? '正在读取配音…'}</span>
      )}
      <button
        className="button secondary"
        type="button"
        disabled={!writable || selected || !source?.src}
        onClick={onAdopt}
      >
        {selected ? '已采用配音' : '采用配音'}
      </button>
      {take.voiceSnapshot ? (
        <span>声音版本 {take.voiceSnapshot.revision}</span>
      ) : (
        <span>导入配音</span>
      )}
    </div>
  );
}
function VideoPreview({
  projectId,
  assetId,
  label,
}: {
  projectId: string;
  assetId: string;
  label: string;
}) {
  const source = useDubbingMedia(projectId, assetId, false);
  return source?.src ? (
    <video
      className="dubbing-video"
      controls
      preload="metadata"
      src={source.src}
      aria-label={label}
    />
  ) : source?.error ? (
    <p className="dubbing-error">{source.error}</p>
  ) : null;
}
