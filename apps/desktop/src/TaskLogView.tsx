import {
  AlertCircle,
  ChevronDown,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  Image as ImageIcon,
  ListChecks,
  RefreshCw,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentTaskDetail,
  AgentPartialArtifactInfo,
  ImageGenerationJobInfo,
  TaskLogItem,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

interface TaskLogViewProps {
  projectId?: string;
  onOpenDocument?: (documentId: string) => void;
  onOpenConversation?: (conversationId: string) => void;
}

const kindLabel: Record<TaskLogItem['kind'], string> = {
  'agent-document': 'Agent 文档',
  image: '图片',
  video: '视频',
};

const statusLabel: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_review: '等待审核',
  completed: '已完成',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
  recovering: '恢复中',
};

const eventLevelLabel: Record<AgentTaskDetail['events'][number]['level'], string> = {
  info: '信息',
  warning: '警告',
  error: '错误',
};

const operationLabel: Record<AgentTaskDetail['documents'][number]['operation'], string> = {
  create: '创建',
  update: '更新',
  regenerate: '重新生成',
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusText(value: string): string {
  return statusLabel[value] ? `${statusLabel[value]} (${value})` : value;
}

function TaskLogStatus({ status, outcome }: { status: string; outcome?: string }) {
  return (
    <div className="task-log-detail-status">
      <div>
        <span>状态</span>
        <strong className={`task-status task-status-${status}`}>{statusText(status)}</strong>
      </div>
      {outcome && (
        <div>
          <span>结果</span>
          <strong>{outcome}</strong>
        </div>
      )}
    </div>
  );
}

function AgentTaskDetailPanel({
  detail,
  onOpenDocument,
  onOpenConversation,
}: {
  detail: AgentTaskDetail;
  onOpenDocument?: (documentId: string) => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { task, events, documents, providerSteps, researchSources } = detail;
  const [partials, setPartials] = useState<AgentPartialArtifactInfo[]>([]);
  const [partialBusy, setPartialBusy] = useState<string>();
  const [partialError, setPartialError] = useState<string>();

  useEffect(() => {
    let active = true;
    void callWorker('agent.partial.list', { includeTerminal: true })
      .then((rows) => {
        if (active) setPartials(rows.filter((row) => row.taskId === task.id));
      })
      .catch(() => {
        if (active) setPartials([]);
      });
    return () => {
      active = false;
    };
  }, [task.id]);

  const discardPartial = async (partial: AgentPartialArtifactInfo) => {
    if (!window.confirm('确定丢弃这份未完成产物吗？丢弃后将清除其内容，且无法恢复。')) return;
    setPartialBusy(partial.id);
    setPartialError(undefined);
    try {
      await callWorker('agent.partial.discard', {
        artifactId: partial.id,
        expectedRowVersion: partial.rowVersion,
      });
      setPartials((current) =>
        current.map((item) =>
          item.id === partial.id
            ? { ...item, status: 'discarded', rowVersion: item.rowVersion + 1 }
            : item,
        ),
      );
    } catch (reason) {
      setPartialError(reason instanceof Error ? reason.message : '丢弃未完成产物失败');
    } finally {
      setPartialBusy(undefined);
    }
  };

  const recoverPartial = async (partial: AgentPartialArtifactInfo) => {
    if (!partial.documentId) return;
    if (!window.confirm('将未完成内容恢复为新的用户草稿吗？原有版本不会被覆盖。')) return;
    setPartialBusy(partial.id);
    setPartialError(undefined);
    try {
      const document = await callWorker('document.get', { documentId: partial.documentId });
      const recovered = await callWorker('agent.partial.recover', {
        artifactId: partial.id,
        expectedRowVersion: partial.rowVersion,
        expectedDocumentRowVersion: document.rowVersion,
      });
      setPartials((current) =>
        current.map((item) =>
          item.id === partial.id
            ? { ...item, status: 'recovered', rowVersion: item.rowVersion + 1 }
            : item,
        ),
      );
      onOpenDocument?.(recovered.id);
    } catch (reason) {
      setPartialError(reason instanceof Error ? reason.message : '恢复未完成产物失败');
    } finally {
      setPartialBusy(undefined);
    }
  };
  return (
    <div className="task-log-detail-body">
      <TaskLogStatus status={task.status} outcome={task.outcome} />

      <dl className="task-log-detail-meta">
        <div>
          <dt>任务 ID</dt>
          <dd>{task.id}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatDate(task.createdAt)}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{formatDate(task.updatedAt)}</dd>
        </div>
        {task.completedAt && (
          <div>
            <dt>完成时间</dt>
            <dd>{formatDate(task.completedAt)}</dd>
          </div>
        )}
        {(task.providerName || task.modelName) && (
          <div>
            <dt>模型</dt>
            <dd>{[task.providerName, task.modelName].filter(Boolean).join(' · ')}</dd>
          </div>
        )}
        {(task.inputTokens !== undefined || task.outputTokens !== undefined) && (
          <div>
            <dt>Token</dt>
            <dd>
              输入 {task.inputTokens ?? 0} · 输出 {task.outputTokens ?? 0}
            </dd>
          </div>
        )}
        {task.estimatedCost && (
          <div>
            <dt>费用</dt>
            <dd>{task.estimatedCost}</dd>
          </div>
        )}
      </dl>

      {(() => {
        const conversationId = task.conversationId;
        return onOpenConversation && conversationId ? (
          <button
            className="button secondary task-log-open-document"
            type="button"
            onClick={() => onOpenConversation(conversationId)}
          >
            <ExternalLink size={13} />
            打开来源会话
          </button>
        ) : null;
      })()}

      {(task.errorCode || task.errorMessage) && (
        <div className="task-log-detail-error" role="alert">
          <AlertCircle size={15} />
          <div>
            {task.errorCode && <strong>{task.errorCode}</strong>}
            {task.errorMessage && <p>{task.errorMessage}</p>}
          </div>
        </div>
      )}

      <section className="task-log-detail-section" aria-labelledby="task-log-events-heading">
        <h3 id="task-log-events-heading">
          <Clock3 size={15} />
          事件时间线
        </h3>
        {events.length > 0 ? (
          <ol className="task-log-timeline">
            {events.map((event) => (
              <li className={`task-log-event task-log-event-${event.level}`} key={event.id}>
                <span className="task-log-event-marker" aria-hidden="true" />
                <div className="task-log-event-main">
                  <div className="task-log-event-heading">
                    <strong>{event.eventType}</strong>
                    <span>{eventLevelLabel[event.level]}</span>
                  </div>
                  <p>{event.summary}</p>
                  <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="task-log-detail-empty">暂无事件记录。</p>
        )}
      </section>

      <section className="task-log-detail-section" aria-labelledby="task-log-documents-heading">
        <h3 id="task-log-documents-heading">
          <FileText size={15} />
          文档产物
        </h3>
        {documents.length > 0 ? (
          <>
            <ul className="task-log-artifacts">
              {documents.map((document) => (
                <li key={`${document.documentVersionId}-${document.createdAt}`}>
                  <div>
                    <strong>{operationLabel[document.operation]}</strong>
                    <span>文档 {document.documentId}</span>
                  </div>
                  <small>
                    版本 {document.documentVersionId} · {formatDate(document.createdAt)}
                  </small>
                </li>
              ))}
            </ul>
            {(() => {
              const primaryDocument = documents[0];
              return onOpenDocument && primaryDocument ? (
                <button
                  className="button secondary task-log-open-document"
                  type="button"
                  onClick={() => onOpenDocument(primaryDocument.documentId)}
                >
                  <FileText size={13} />
                  打开文档
                </button>
              ) : null;
            })()}
          </>
        ) : (
          <p className="task-log-detail-empty">暂无文档产物。</p>
        )}
      </section>

      <section
        className="task-log-detail-section"
        aria-labelledby="task-log-provider-steps-heading"
      >
        <h3 id="task-log-provider-steps-heading">
          <ListChecks size={15} />
          Provider steps
        </h3>
        {providerSteps.length > 0 ? (
          <ol className="task-log-artifacts">
            {providerSteps.map((step) => (
              <li key={step.id}>
                <div>
                  <strong>
                    Step {step.ordinal + 1}: {statusText(step.status)}
                  </strong>
                  <span>
                    {step.protocol} · {step.toolCallCount} tool call
                    {step.toolCallCount === 1 ? '' : 's'}
                  </span>
                </div>
                <small>
                  {step.finishReason ? `finish: ${step.finishReason} · ` : ''}
                  input {step.inputTokens ?? 0} · output {step.outputTokens ?? 0}
                  {step.reasoningTokens !== undefined ? ` · reasoning ${step.reasoningTokens}` : ''}
                  {step.providerReportedCost
                    ? ` · ${step.providerReportedCost}${step.currency ? ` ${step.currency}` : ''}`
                    : ''}
                  {' · '}
                  {formatDate(step.startedAt)}
                </small>
                {(step.errorCode || step.errorMessage) && (
                  <small className="task-log-provider-step-error">
                    {[step.errorCode, step.errorMessage].filter(Boolean).join(': ')}
                  </small>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="task-log-detail-empty">No Provider steps were recorded for this task.</p>
        )}
      </section>

      <section className="task-log-detail-section" aria-labelledby="task-log-research-heading">
        <h3 id="task-log-research-heading">
          <Globe2 size={15} />
          研究来源
        </h3>
        {researchSources.length > 0 ? (
          <ul className="task-log-research-sources">
            {researchSources.map((source) => (
              <li key={source.id}>
                <div className="task-log-research-heading">
                  <strong>{source.citationLabel ?? '来源'}</strong>
                  <span
                    className={`task-research-status task-research-status-${source.adoptionStatus}`}
                  >
                    {source.adoptionStatus === 'adopted'
                      ? '已采用'
                      : source.adoptionStatus === 'excluded'
                        ? '已排除'
                        : '待判断'}
                  </span>
                </div>
                <a
                  href={source.canonicalUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={source.canonicalUrl}
                >
                  {source.title}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
                <div className="task-log-research-meta">
                  <span>{source.site}</span>
                  <time dateTime={source.retrievedAt}>{formatDate(source.retrievedAt)}</time>
                  {source.status === 'failed' && <span>抓取失败</span>}
                  {source.truncated && <span>内容已截断</span>}
                  {source.cacheStatus && source.cacheStatus !== 'present' && (
                    <span>缓存{source.cacheStatus === 'missing' ? '缺失' : '已过期'}</span>
                  )}
                </div>
                {source.adoptionReason && <small>{source.adoptionReason}</small>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-log-detail-empty">暂无研究来源。</p>
        )}
      </section>

      <section className="task-log-detail-section" aria-labelledby="task-log-partials-heading">
        <h3 id="task-log-partials-heading">
          <FileText size={15} /> 未完成产物
        </h3>
        {task.status === 'failed' &&
          partials.some((partial) => partial.status === 'recoverable') && (
            <p className="task-log-detail-notice" role="status">
              任务失败，但仍有可恢复的未完成产物。请选择“恢复草稿”或“丢弃”。
            </p>
          )}
        {partialError && (
          <p className="task-log-detail-error" role="alert">
            {partialError}
          </p>
        )}
        {partials.length > 0 ? (
          <ul className="task-log-artifacts">
            {partials.map((partial) => (
              <li key={partial.id}>
                <div>
                  <strong>{partial.targetKind}</strong>
                  <span>
                    {partial.contentLength} bytes · {partial.status}
                  </span>
                </div>
                {partial.status === 'recoverable' && (
                  <div className="task-log-artifact-actions">
                    <button
                      className="button secondary"
                      type="button"
                      disabled={partialBusy === partial.id}
                      onClick={() => void recoverPartial(partial)}
                    >
                      恢复草稿
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={partialBusy === partial.id}
                      onClick={() => void discardPartial(partial)}
                    >
                      丢弃
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-log-detail-empty">暂无未完成产物。</p>
        )}
      </section>
    </div>
  );
}

function SourceHint({ item }: { item: TaskLogItem }) {
  const SourceIcon = item.kind === 'image' ? ImageIcon : Video;
  return (
    <div className="task-log-source-hint">
      <SourceIcon size={22} />
      <h3>{kindLabel[item.kind]}来源</h3>
      <p>当前仅展示生成任务的基础来源信息，详细参数和产物请从对应工作区查看。</p>
      <dl>
        <div>
          <dt>来源任务 ID</dt>
          <dd>{item.sourceId}</dd>
        </div>
        <div>
          <dt>任务状态</dt>
          <dd>{statusText(item.status)}</dd>
        </div>
        <div>
          <dt>记录时间</dt>
          <dd>{formatDate(item.createdAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

function summarizeParameters(parameters: Record<string, unknown>): string {
  const summarized = Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const compact = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      return [key, compact];
    }),
  );
  const json = JSON.stringify(summarized);
  return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : json;
}

function MediaTaskDetailPanel({
  item,
  detail,
}: {
  item: TaskLogItem;
  detail: ImageGenerationJobInfo | VideoGenerationJobInfo;
}) {
  const isImage = item.kind === 'image';
  return (
    <div className="task-log-detail-body">
      <TaskLogStatus status={detail.status} />
      <dl className="task-log-detail-meta">
        <div>
          <dt>任务 ID</dt>
          <dd>{detail.id}</dd>
        </div>
        <div>
          <dt>适配器</dt>
          <dd>{detail.adapterKey}</dd>
        </div>
        {detail.shotId && (
          <div>
            <dt>镜头</dt>
            <dd>{detail.shotId}</dd>
          </div>
        )}
        <div>
          <dt>创建时间</dt>
          <dd>{formatDate(detail.createdAt)}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{formatDate(detail.updatedAt)}</dd>
        </div>
        {!isImage && (
          <>
            <div>
              <dt>资产类型</dt>
              <dd>{(detail as VideoGenerationJobInfo).assetKind}</dd>
            </div>
            <div>
              <dt>Provider 任务</dt>
              <dd>{(detail as VideoGenerationJobInfo).providerTaskId ?? '未提交'}</dd>
            </div>
            <div>
              <dt>轮询</dt>
              <dd>
                {(detail as VideoGenerationJobInfo).metadata.pollAttempts} 次 · 截止{' '}
                {(detail as VideoGenerationJobInfo).metadata.pollDeadlineAt
                  ? formatDate((detail as VideoGenerationJobInfo).metadata.pollDeadlineAt!)
                  : '无'}
              </dd>
            </div>
          </>
        )}
      </dl>

      {detail.error && (
        <div className="task-log-detail-error" role="alert">
          <AlertCircle size={15} />
          <p>{detail.error}</p>
        </div>
      )}

      <section className="task-log-detail-section" aria-labelledby="task-log-request-heading">
        <h3 id="task-log-request-heading">请求参数摘要</h3>
        <pre className="task-log-request-summary">{summarizeParameters(detail.request)}</pre>
      </section>

      <section className="task-log-detail-section" aria-labelledby="task-log-results-heading">
        <h3 id="task-log-results-heading">{isImage ? '图片产物' : '视频产物'}</h3>
        {detail.results.length > 0 ? (
          <ul className="task-log-artifacts">
            {detail.results.map((result) => (
              <li key={result.id}>
                <div>
                  <strong>{isImage ? '图片' : '视频'}</strong>
                  <span>{result.asset?.relativePath ?? '未落盘'}</span>
                </div>
                <small>创建于 {formatDate(result.createdAt)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-log-detail-empty">暂无已落盘产物。</p>
        )}
      </section>
    </div>
  );
}

export function TaskLogView({ projectId, onOpenDocument, onOpenConversation }: TaskLogViewProps) {
  const [items, setItems] = useState<TaskLogItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<TaskLogItem>();
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null);
  const [mediaDetail, setMediaDetail] = useState<
    ImageGenerationJobInfo | VideoGenerationJobInfo | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [detailMessage, setDetailMessage] = useState('');
  const detailRequestRef = useRef(0);
  const [kindFilter, setKindFilter] = useState<TaskLogItem['kind'] | ''>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setItems([]);
      setNextCursor(undefined);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const page = await callWorker('task.log.list', {
        limit: 50,
        kind: kindFilter || undefined,
        status: statusFilter || undefined,
      });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setSelectedItem((current) =>
        current && page.items.some((item) => item.id === current.id) ? current : undefined,
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '任务日志读取失败');
    } finally {
      setBusy(false);
    }
  }, [projectId, kindFilter, statusFilter]);

  useEffect(() => {
    detailRequestRef.current += 1;
    setSelectedItem(undefined);
    setDetail(null);
    setMediaDetail(null);
    setDetailMessage('');
    setDetailBusy(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      if (!busy && !detailBusy && !loadingMore) void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [projectId, refresh, busy, detailBusy, loadingMore]);

  const openDetails = async (item: TaskLogItem) => {
    const requestId = ++detailRequestRef.current;
    setSelectedItem(item);
    setDetail(null);
    setMediaDetail(null);
    setDetailMessage('');
    if (item.kind !== 'agent-document') {
      setDetailBusy(true);
      try {
        const nextDetail =
          item.kind === 'image'
            ? await callWorker('image.generate.get', { jobId: item.sourceId })
            : await callWorker('video.generate.get', { jobId: item.sourceId });
        if (requestId === detailRequestRef.current) setMediaDetail(nextDetail);
      } catch (reason) {
        if (requestId === detailRequestRef.current) {
          setDetailMessage(reason instanceof Error ? reason.message : '任务详情读取失败');
        }
      } finally {
        if (requestId === detailRequestRef.current) setDetailBusy(false);
      }
      return;
    }

    setDetailBusy(true);
    try {
      const nextDetail = await callWorker('agent.task.get', { taskId: item.sourceId });
      if (requestId === detailRequestRef.current) setDetail(nextDetail);
    } catch (reason) {
      if (requestId === detailRequestRef.current) {
        setDetailMessage(reason instanceof Error ? reason.message : '任务详情读取失败');
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailBusy(false);
    }
  };

  const closeDetails = () => {
    detailRequestRef.current += 1;
    setSelectedItem(undefined);
    setDetail(null);
    setMediaDetail(null);
    setDetailMessage('');
    setDetailBusy(false);
  };

  const loadMore = async () => {
    if (!projectId || !nextCursor) return;
    setLoadingMore(true);
    setMessage('');
    try {
      const page = await callWorker('task.log.list', {
        limit: 50,
        cursor: nextCursor,
        kind: kindFilter || undefined,
        status: statusFilter || undefined,
      });
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '任务日志加载失败');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="task-log-workspace">
      <div className="workspace-toolbar">
        <div>
          <span className="eyebrow">项目执行记录</span>
          <h1>任务日志</h1>
        </div>
        <select
          aria-label="任务类型筛选"
          value={kindFilter}
          onChange={(event) => {
            setKindFilter(event.target.value as TaskLogItem['kind'] | '');
            setSelectedItem(undefined);
            setDetail(null);
          }}
          disabled={!projectId}
        >
          <option value="">全部类型</option>
          <option value="agent-document">Agent 文档</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
        </select>
        <select
          aria-label="任务状态筛选"
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value);
            setSelectedItem(undefined);
            setDetail(null);
          }}
          disabled={!projectId}
        >
          <option value="">全部状态</option>
          {Object.keys(statusLabel).map((status) => (
            <option key={status} value={status}>
              {statusLabel[status]}
            </option>
          ))}
        </select>
        <button
          className="button secondary"
          type="button"
          title="刷新任务日志"
          onClick={() => void refresh()}
          disabled={busy || !projectId}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      {!projectId ? (
        <div className="empty-stage">
          <div className="empty-icon">
            <ListChecks size={28} />
          </div>
          <h2>请打开一个项目</h2>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-stage">
          <div className="empty-icon">
            <ListChecks size={28} />
          </div>
          <h2>暂无任务</h2>
          <p>Agent 文档、图片和视频任务完成后会在这里保留记录。</p>
        </div>
      ) : (
        <div className={`task-log-content${selectedItem ? ' has-detail' : ''}`}>
          <div className="task-log-list" aria-label="任务日志列表">
            {items.map((item) => (
              <button
                className={`task-log-row${selectedItem?.id === item.id ? ' is-selected' : ''}`}
                key={item.id}
                type="button"
                aria-pressed={selectedItem?.id === item.id}
                onClick={() => void openDetails(item)}
              >
                <div className="task-log-kind">{kindLabel[item.kind]}</div>
                <div className="task-log-main">
                  <strong>{item.title}</strong>
                  <small>{formatDate(item.createdAt)}</small>
                </div>
                <span className={`task-status task-status-${item.status}`}>
                  {statusText(item.status)}
                </span>
              </button>
            ))}
          </div>
          {nextCursor && (
            <button
              className="button secondary task-log-load-more"
              type="button"
              title="加载更多任务"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              <ChevronDown size={14} />
              加载更多
            </button>
          )}
          {selectedItem && (
            <aside className="task-log-detail" aria-label="任务详情">
              <div className="task-log-detail-header">
                <div>
                  <span>{kindLabel[selectedItem.kind]}</span>
                  <h2>{selectedItem.title}</h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  title="关闭任务详情"
                  aria-label="关闭任务详情"
                  onClick={closeDetails}
                >
                  <X size={16} />
                </button>
              </div>
              {detailBusy ? (
                <div className="task-log-detail-loading">正在读取任务详情…</div>
              ) : detailMessage ? (
                <div className="task-log-detail-error task-log-detail-error-block" role="alert">
                  <AlertCircle size={15} />
                  <span>{detailMessage}</span>
                </div>
              ) : selectedItem.kind !== 'agent-document' && mediaDetail ? (
                <MediaTaskDetailPanel item={selectedItem} detail={mediaDetail} />
              ) : selectedItem.kind === 'agent-document' && detail ? (
                <AgentTaskDetailPanel
                  detail={detail}
                  onOpenDocument={onOpenDocument}
                  onOpenConversation={onOpenConversation}
                />
              ) : selectedItem.kind === 'agent-document' ? (
                <div className="task-log-detail-loading">暂无任务详情。</div>
              ) : (
                <SourceHint item={selectedItem} />
              )}
            </aside>
          )}
        </div>
      )}
      {message && <div className="inline-status">{message}</div>}
    </section>
  );
}
