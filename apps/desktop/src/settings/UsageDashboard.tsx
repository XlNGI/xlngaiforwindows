import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, DatabaseBackup, RefreshCw } from 'lucide-react';
import type { UsageEntryInfo, UsageQueryParams, UsageQueryResult } from '@ai-video/contracts';
import { usageClient } from '../usage-client';

type RangePreset = 'today' | 'week' | 'month' | 'custom';

const emptyResult: UsageQueryResult = { entries: [], summaries: [] };

export function UsageDashboard() {
  const [preset, setPreset] = useState<RangePreset>('month');
  const [customStart, setCustomStart] = useState(() => toDateInput(firstDayOfMonth(new Date())));
  const [customEnd, setCustomEnd] = useState(() => toDateInput(new Date()));
  const [providerProfileId, setProviderProfileId] = useState('');
  const [modelId, setModelId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<UsageQueryParams['status']>();
  const [result, setResult] = useState<UsageQueryResult>(emptyResult);
  const [knownEntries, setKnownEntries] = useState<UsageEntryInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const preserveMessageOnRefresh = useRef(false);

  const range = useMemo(
    () => usageRange(preset, customStart, customEnd),
    [preset, customStart, customEnd],
  );

  useEffect(() => {
    if (!range) return;
    let active = true;
    setBusy(true);
    if (preserveMessageOnRefresh.current) preserveMessageOnRefresh.current = false;
    else setMessage('');
    void usageClient
      .list({
        ...range,
        providerProfileId: providerProfileId || undefined,
        modelId: modelId || undefined,
        projectId: projectId || undefined,
        status,
      })
      .then((next) => {
        if (!active) return;
        setResult(next);
        setKnownEntries((current) => mergeUsageEntries(current, next.entries));
      })
      .catch((reason) => {
        if (active) setMessage(reason instanceof Error ? reason.message : '使用量加载失败。');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [range?.startAt, range?.endAt, providerProfileId, modelId, projectId, status, refreshKey]);

  const providers = uniqueOptions(
    knownEntries.map((entry) => ({ value: entry.providerProfileId, label: entry.providerName })),
  );
  const models = uniqueOptions(
    knownEntries
      .filter((entry) => !providerProfileId || entry.providerProfileId === providerProfileId)
      .map((entry) => ({ value: entry.modelId, label: entry.modelName })),
  );
  const projects = uniqueOptions(
    knownEntries.map((entry) => ({ value: entry.projectId, label: entry.projectName })),
  );
  const totalTokens = result.entries.reduce((total, entry) => total + (entry.totalTokens ?? 0), 0);
  const statusCounts = {
    complete: result.entries.filter((entry) => entry.status === 'complete').length,
    failed: result.entries.filter((entry) => entry.status === 'failed').length,
    cancelled: result.entries.filter((entry) => entry.status === 'cancelled').length,
  };
  const rebuild = async () => {
    setBusy(true);
    setMessage('');
    try {
      const rebuilt = await usageClient.rebuild();
      setMessage(
        `索引已重建：扫描 ${rebuilt.projectsScanned} 个项目，写入 ${rebuilt.attemptsIndexed} 次调用${rebuilt.projectsSkipped ? `，跳过 ${rebuilt.projectsSkipped} 个项目` : ''}。`,
      );
      preserveMessageOnRefresh.current = true;
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '用量索引重建失败。');
      setBusy(false);
    }
  };

  return (
    <section className="usage-dashboard">
      <header className="settings-section-header">
        <div>
          <span className="eyebrow">本地派生索引</span>
          <h3>使用量与费用</h3>
          <small>Token 来自供应商返回值；费用使用调用时的用户定价快照。</small>
        </div>
        <div className="settings-header-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => void rebuild()}
          >
            <DatabaseBackup size={14} />
            重建用量索引
          </button>
        </div>
      </header>

      <div className="usage-controls">
        <div className="usage-presets" aria-label="统计周期">
          {(
            [
              ['today', '今日'],
              ['week', '本周'],
              ['month', '本月'],
              ['custom', '自定义'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={preset === value ? 'active' : ''}
              onClick={() => setPreset(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="usage-custom-range">
            <CalendarRange size={14} />
            <label>
              开始日期
              <input
                type="date"
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
              />
            </label>
            <label>
              结束日期
              <input
                type="date"
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </label>
          </div>
        )}
        <div className="usage-filters">
          <label>
            供应商
            <select
              value={providerProfileId}
              onChange={(event) => {
                setProviderProfileId(event.target.value);
                setModelId('');
              }}
            >
              <option value="">全部供应商</option>
              {providers.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            模型
            <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
              <option value="">全部模型</option>
              {models.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            项目
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">全部项目</option>
              {projects.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              value={status ?? ''}
              onChange={(event) =>
                setStatus((event.target.value || undefined) as UsageQueryParams['status'])
              }
            >
              <option value="">全部状态</option>
              <option value="complete">成功</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
        </div>
      </div>

      {!range && <div className="settings-message">自定义日期范围无效。</div>}
      {message && (
        <div className="settings-message" role="status">
          {message}
        </div>
      )}

      <div className="usage-summary-grid">
        <article>
          <small>调用次数</small>
          <strong>{result.entries.length}</strong>
        </article>
        <article>
          <small>供应商返回 Token</small>
          <strong>{formatInteger(totalTokens)}</strong>
        </article>
        <article>
          <small>状态分布</small>
          <strong>{result.entries.length} 次</strong>
          <span>
            成功 {statusCounts.complete} · 失败 {statusCounts.failed} · 取消{' '}
            {statusCounts.cancelled}
          </span>
        </article>
        {result.summaries.map((summary) => (
          <article key={summary.currency}>
            <small>{summary.currency} 预计费用</small>
            <strong>
              {summary.currency} {summary.estimatedCost}
            </strong>
            <span>{summary.attempts} 次有定价调用</span>
          </article>
        ))}
      </div>

      <div className="usage-entry-list" aria-busy={busy}>
        {result.entries.length === 0 ? (
          <div className="empty-settings-state compact">
            <strong>{busy ? '正在加载…' : '当前范围没有用量记录'}</strong>
            <span>完成一次使用托管供应商的 LLM 调用后，记录会显示在这里。</span>
          </div>
        ) : (
          result.entries.map((entry) => (
            <article className="usage-entry" key={entry.attemptId}>
              <div>
                <strong>{entry.projectName}</strong>
                <span>
                  {entry.providerName} · {entry.modelName}
                </span>
              </div>
              <span className={`usage-status status-${entry.status}`}>
                {statusLabel(entry.status)}
              </span>
              <div className="usage-token-breakdown">
                <span>输入 {formatOptionalInteger(entry.inputTokens)}</span>
                <span>缓存 {formatOptionalInteger(entry.cachedInputTokens)}</span>
                <span>输出 {formatOptionalInteger(entry.outputTokens)}</span>
                <span>推理 {formatOptionalInteger(entry.reasoningTokens)}</span>
              </div>
              <strong className="usage-entry-cost">
                {entry.currency && entry.estimatedCost
                  ? `${entry.currency} ${entry.estimatedCost}`
                  : '费用未知'}
              </strong>
              <time>{new Date(entry.createdAt).toLocaleString()}</time>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function usageRange(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
): Pick<UsageQueryParams, 'startAt' | 'endAt'> | undefined {
  const now = new Date();
  let start: Date;
  let end: Date;
  if (preset === 'custom') {
    start = parseDateInput(customStart);
    const lastDay = parseDateInput(customEnd);
    end = new Date(lastDay);
    end.setDate(end.getDate() + 1);
  } else {
    end = startOfDay(now);
    end.setDate(end.getDate() + 1);
    if (preset === 'today') start = startOfDay(now);
    else if (preset === 'week') {
      start = startOfDay(now);
      const day = start.getDay() || 7;
      start.setDate(start.getDate() - day + 1);
    } else start = firstDayOfMonth(now);
  }
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) {
    return undefined;
  }
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? Number.NaN, (month ?? Number.NaN) - 1, day ?? Number.NaN);
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function firstDayOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function toDateInput(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mergeUsageEntries(current: UsageEntryInfo[], next: UsageEntryInfo[]): UsageEntryInfo[] {
  const byAttempt = new Map(current.map((entry) => [entry.attemptId, entry]));
  for (const entry of next) byAttempt.set(entry.attemptId, entry);
  return [...byAttempt.values()];
}

function uniqueOptions(options: Array<{ value: string; label: string }>) {
  const unique = new Map<string, string>();
  for (const option of options)
    if (!unique.has(option.value)) unique.set(option.value, option.label);
  return [...unique].map(([value, label]) => ({ value, label }));
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatOptionalInteger(value: number | undefined): string {
  return value === undefined ? '未知' : formatInteger(value);
}

function statusLabel(status: string): string {
  if (status === 'complete') return '成功';
  if (status === 'cancelled') return '已取消';
  return '失败';
}
