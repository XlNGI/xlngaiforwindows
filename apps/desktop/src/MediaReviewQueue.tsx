import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  DubbingCueSaveParams,
  MediaModelSelectionDecision,
  MediaReviewForm,
  MediaReviewSummary,
} from '@ai-video/contracts';
import { projectWorker, workerScope } from './worker-scope';

export function MediaReviewQueue({
  projectId,
  conversationId,
  writable,
  renderMediaForm,
  renderTimeline,
}: {
  projectId: string;
  conversationId: string;
  writable: boolean;
  renderMediaForm: (
    form: MediaReviewForm,
    submit: (selection: MediaModelSelectionDecision) => void,
  ) => ReactNode;
  renderTimeline?: (
    forms: MediaReviewSummary[],
    renderForm: (form: MediaReviewSummary) => ReactNode,
    error: ReactNode,
  ) => ReactNode;
}) {
  return (
    <ReviewQueue
      key={`${projectId}:${workerScope(projectId)?.projectSessionId ?? ''}:${conversationId}`}
      {...{ projectId, conversationId, writable, renderMediaForm, renderTimeline }}
    />
  );
}

function ReviewQueue({
  projectId,
  conversationId,
  writable,
  renderMediaForm,
  renderTimeline,
}: Parameters<typeof MediaReviewQueue>[0]) {
  const [forms, setForms] = useState<MediaReviewSummary[]>([]);
  const [active, setActive] = useState<MediaReviewForm>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const alive = useRef(true);
  const submitting = useRef(false);
  const worker = useRef(projectWorker(workerScope(projectId))).current;
  const refresh = async () => {
    const result = await worker('media.review.list', { conversationId });
    if (alive.current) {
      setForms(result ?? []);
      setLoadError('');
    }
  };
  useEffect(() => {
    alive.current = true;
    const load = () =>
      void refresh().catch((reason: Error) => {
        if (alive.current) setLoadError(reason.message);
      });
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
    // Queue identity is keyed to the project/session and conversation.
  }, [conversationId, worker]);

  const open = async (id: string) => {
    setBusy(true);
    setMessage('');
    try {
      const form = await worker('media.review.get', { formId: id });
      if (alive.current) setActive(form);
    } catch (reason) {
      if (alive.current) setMessage((reason as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const submit = async (selection?: MediaModelSelectionDecision, audio?: DubbingCueSaveParams) => {
    if (!active || submitting.current || !writable) return;
    submitting.current = true;
    setBusy(true);
    setMessage('');
    try {
      const saved = await worker('media.review.submit', {
        formId: active.id,
        expectedRowVersion: active.rowVersion,
        reviewToken: active.reviewToken!,
        ...(selection ? { selection } : {}),
        ...(audio ? { audio } : {}),
      });
      if (!alive.current) return;
      setActive(saved);
      await refresh();
      if (alive.current) setMessage(saved.error ?? '已按审核后的参数提交，可在任务日志查看进度。');
    } catch (reason) {
      if (alive.current) setMessage((reason as Error).message);
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const cancel = async () => {
    if (!active || submitting.current || !writable) return;
    try {
      const form = await worker('media.review.cancel', {
        formId: active.id,
        expectedRowVersion: active.rowVersion,
      });
      if (!alive.current) return;
      setActive(form);
      await refresh();
    } catch (reason) {
      if (alive.current) setMessage((reason as Error).message);
    }
  };
  const renderForm = (form: MediaReviewSummary) => (
    <section
      key={form.id}
      className="media-review-queue media-review-timeline-item"
      aria-label={`媒体审核表单：${form.draft.label}`}
    >
      <strong className="media-review-label">媒体审核表单</strong>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => void open(form.id)}
      >
        {form.draft.label} ·{' '}
        {form.draft.kind === 'audio' ? '音频' : form.draft.kind === 'image' ? '图片' : '视频'} ·{' '}
        {
          (
            {
              pending: '待审核',
              submitting: '正在提交',
              submitted: '已提交',
              cancelled: '已取消',
            } as const
          )[form.status]
        }
      </button>
      {form.blockers.map((blocker) => (
        <small key={blocker}>{blocker}</small>
      ))}
      {active?.id === form.id && (
        <div className="media-review-editor" aria-busy={busy}>
          <strong>{active.draft.label}</strong>
          {active.jobId && <p>已关联生成任务：{active.jobId}</p>}
          {active.blockers.map((blocker) => (
            <p key={blocker}>{blocker}</p>
          ))}
          {active.status === 'pending' &&
            writable &&
            !busy &&
            active.blockers.length === 0 &&
            (active.draft.kind === 'audio' ? (
              <AudioReviewForm
                key={`${active.id}:${active.rowVersion}`}
                form={active}
                onSubmit={(audio) => void submit(undefined, audio)}
              />
            ) : (
              active.selectionRequest &&
              renderMediaForm(active, (selection) => void submit(selection))
            ))}
          {active.status === 'pending' && writable && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void cancel()}
            >
              取消此表单
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setActive(undefined)}
          >
            收起表单
          </button>
        </div>
      )}
      {(active?.id === form.id || (!active && forms[0]?.id === form.id)) && message && (
        <p role="status">{message}</p>
      )}
    </section>
  );
  const error = loadError ? <p role="alert">审核队列加载失败：{loadError}</p> : null;
  if (renderTimeline) return renderTimeline(forms, renderForm, error);
  if (forms.length === 0 && !loadError) return null;
  const pending = forms.filter((form) => form.status === 'pending').length;
  return (
    <section className="media-review-queue" aria-label="媒体审核表单队列">
      <details open={pending > 0 || Boolean(loadError)}>
        <summary>
          媒体审核表单 · {pending} 项待审核 / {forms.length} 项
        </summary>
        {forms.map(renderForm)}
        {error}
      </details>
    </section>
  );
}

function AudioReviewForm({
  form,
  onSubmit,
}: {
  form: MediaReviewForm;
  onSubmit: (audio: DubbingCueSaveParams) => void;
}) {
  const [cue, setCue] = useState(form.draft.audio!);
  const [approved, setApproved] = useState(false);
  const voices = form.voices ?? [];
  return (
    <form
      className="media-review-audio"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(cue);
      }}
    >
      <label>
        台词 / 旁白
        <textarea
          aria-label="配音台词"
          value={cue.text}
          maxLength={4000}
          onChange={(event) => setCue({ ...cue, text: event.target.value })}
        />
      </label>
      <label>
        固定声音
        <select
          aria-label="配音声音"
          value={cue.voiceProfileId ?? ''}
          onChange={(event) => setCue({ ...cue, voiceProfileId: event.target.value })}
        >
          <option value="">请选择声音</option>
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.voiceId} · {voice.model}
            </option>
          ))}
        </select>
      </label>
      {!voices.length && <p>请先在场次配音面板配置角色或旁白声音，再刷新本表单。</p>}
      <label>
        起点（毫秒）
        <input
          type="number"
          min={0}
          max={600000}
          value={cue.startMs}
          onChange={(event) => setCue({ ...cue, startMs: Number(event.target.value) })}
        />
      </label>
      <label>
        情绪
        <select
          value={cue.emotion ?? 'calm'}
          onChange={(event) => setCue({ ...cue, emotion: event.target.value })}
        >
          {['calm', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'].map((emotion) => (
            <option key={emotion} value={emotion}>
              {emotion}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={approved}
          onChange={(event) => setApproved(event.target.checked)}
        />
        我已审核台词及音色，并知悉生成可能产生费用
      </label>
      <button
        type="submit"
        className="button primary"
        disabled={
          !approved || !cue.text.trim() || !voices.some((voice) => voice.id === cue.voiceProfileId)
        }
      >
        提交生成
      </button>
    </form>
  );
}
