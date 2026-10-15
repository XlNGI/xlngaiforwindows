import { Check, ChevronDown, CircleAlert, ListChecks, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentChangeSetInfo, DocumentSummary } from '@ai-video/contracts';
import { callWorker } from './worker-client';

interface ChangeSetReviewPanelProps {
  projectId?: string;
  writable: boolean;
  refreshRevision?: number;
  focusChangeSetId?: string;
  onApplied?: (changeSet: AgentChangeSetInfo) => void | Promise<void>;
  documents?: DocumentSummary[];
}

const terminalStatuses = new Set(['applied', 'rejected', 'conflicted']);
const statusLabels: Record<string, string> = {
  proposed: '待审核',
  partially_applied: '部分已批准',
  applied: '已写入目录',
  rejected: '已拒绝',
  conflicted: '版本冲突',
  pending: '待审核',
};

export function ChangeSetReviewPanel({
  projectId,
  writable,
  refreshRevision,
  focusChangeSetId,
  onApplied,
  documents = [],
}: ChangeSetReviewPanelProps) {
  const [changeSets, setChangeSets] = useState<AgentChangeSetInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string>();
  const [selectedItems, setSelectedItems] = useState<Record<string, string[]>>({});
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState('');
  const currentProjectId = useRef(projectId);
  currentProjectId.current = projectId;
  const loadRequest = useRef(0);
  const focusedEntry = useRef<HTMLElement>(null);

  const load = async () => {
    const request = ++loadRequest.current;
    if (!projectId) {
      setChangeSets([]);
      return;
    }
    try {
      const rows = await callWorker('agent.changeSet.list', { includeTerminal: false });
      if (currentProjectId.current === projectId && request === loadRequest.current)
        setChangeSets(rows);
    } catch (error) {
      if (currentProjectId.current === projectId && request === loadRequest.current)
        setMessage(error instanceof Error ? error.message : '方案加载失败');
    }
  };

  useEffect(() => {
    setChangeSets([]);
    setSelectedItems({});
    setBusyId(undefined);
    setMessage('');
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => {
      loadRequest.current += 1;
    };
  }, [projectId, refreshRevision]);

  useEffect(() => {
    setExpandedId(focusChangeSetId);
  }, [projectId, focusChangeSetId]);

  useEffect(() => {
    focusedEntry.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusChangeSetId, changeSets]);

  const pendingItems = (changeSet: AgentChangeSetInfo) =>
    changeSet.items.filter((item) => item.status === 'pending');

  const itemSelection = (changeSet: AgentChangeSetInfo): string[] => {
    const current = selectedItems[changeSet.id];
    return current?.filter((id) => pendingItems(changeSet).some((item) => item.id === id)) ?? [];
  };

  const mutate = async (changeSet: AgentChangeSetInfo, action: 'apply' | 'reject') => {
    if (!writable || busyId) return;
    const pending = pendingItems(changeSet);
    const selected = itemSelection(changeSet);
    setBusyId(changeSet.id);
    setMessage('');
    try {
      const result = await callWorker(`agent.changeSet.${action}`, {
        changeSetId: changeSet.id,
        expectedRowVersion: changeSet.rowVersion,
        ...(selected.length > 0 && selected.length < pending.length ? { itemIds: selected } : {}),
      });
      if (currentProjectId.current !== projectId) return;
      setChangeSets((rows) => rows.map((row) => (row.id === result.id ? result : row)));
      setSelectedItems((rows) => ({ ...rows, [result.id]: [] }));
      setMessage(
        result.status === 'conflicted'
          ? '场次或镜头已被修改，请重新检查方案。'
          : action === 'apply'
            ? '所选场次与镜头已写入目录。'
            : '所选方案内容已拒绝。',
      );
      if (action === 'apply' && result.items.some((item) => item.status === 'applied'))
        await onApplied?.(result);
    } catch (error) {
      if (currentProjectId.current !== projectId) return;
      setMessage(error instanceof Error ? error.message : '方案操作失败');
      await load();
    } finally {
      if (currentProjectId.current === projectId) setBusyId(undefined);
    }
  };

  if (!projectId || (changeSets.length === 0 && !message)) return null;

  return (
    <section className="change-set-review" aria-label="场次与镜头待审核方案">
      <div className="change-set-review-heading">
        <div>
          <span className="eyebrow">助手生成的方案</span>
          <h2>
            <ListChecks size={16} /> 场次与镜头方案
          </h2>
        </div>
        <button
          className="icon-button subtle"
          type="button"
          title="刷新方案"
          aria-label="刷新方案"
          disabled={Boolean(busyId)}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="inline-status">审核并批准后，场次与镜头会显示在目录中。</p>
      {message && <p className="inline-status">{message}</p>}
      <div className="change-set-list">
        {changeSets.map((changeSet) => {
          const pending = pendingItems(changeSet);
          const selected = itemSelection(changeSet);
          const expanded = expandedId === changeSet.id;
          const terminal = terminalStatuses.has(changeSet.status);
          return (
            <article
              className="change-set-entry"
              key={changeSet.id}
              ref={changeSet.id === focusChangeSetId ? focusedEntry : undefined}
            >
              <button
                className="change-set-entry-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? undefined : changeSet.id)}
              >
                <ChevronDown size={14} className={expanded ? 'rotated' : ''} />
                <span>
                  <strong>{changeSet.title}</strong>
                  <small>
                    {statusLabels[changeSet.status] ?? changeSet.status} · {pending.length} 项待审核
                  </small>
                </span>
              </button>
              {expanded && (
                <div className="change-set-entry-body">
                  <ul className="change-set-items">
                    {changeSet.items.map((item) => (
                      <li key={item.id} className={`change-set-item ${item.status}`}>
                        {item.status === 'pending' && (
                          <input
                            type="checkbox"
                            checked={selected.includes(item.id)}
                            onChange={(event) =>
                              setSelectedItems((rows) => ({
                                ...rows,
                                [changeSet.id]: event.target.checked
                                  ? [...selected, item.id]
                                  : selected.filter((id) => id !== item.id),
                              }))
                            }
                            aria-label={`Select ${item.entityType} ${item.title}`}
                          />
                        )}
                        <span>
                          <strong>
                            {item.action === 'create' ? '新增' : '修改'}
                            {item.entityType === 'scene'
                              ? '场次'
                              : item.entityType === 'shot'
                                ? '镜头'
                                : '文档'}
                            ：{item.title}
                          </strong>
                          <small>
                            {statusLabels[item.status] ?? item.status}
                            {item.shotStatus ? ` · ${item.shotStatus}` : ''}
                            {item.expectedRowVersion !== undefined
                              ? ` · base v${item.expectedRowVersion}`
                              : ''}
                          </small>
                          {item.prompt ? (
                            <small className="change-set-item-prompt">
                              {`提示词：${item.prompt}`}
                            </small>
                          ) : null}
                          {item.videoPrompt && (
                            <small className="change-set-item-prompt">
                              完整视频提示词：{item.videoPrompt}
                            </small>
                          )}
                          {item.characterDocumentIds !== undefined && (
                            <small>
                              出场角色：
                              {item.characterDocumentIds
                                .map(
                                  (id) =>
                                    documents.find((document) => document.id === id)?.title ??
                                    '角色资料不可用',
                                )
                                .join('、') || '无角色'}
                            </small>
                          )}
                          {item.sceneDocumentId ? (
                            <small>
                              绑定场景：
                              {documents.find((document) => document.id === item.sceneDocumentId)
                                ?.title ?? '场景资料不可用'}
                            </small>
                          ) : item.entityType === 'scene' ? (
                            <small>未绑定场景</small>
                          ) : null}
                        </span>
                        {item.status === 'conflicted' && <CircleAlert size={14} />}
                      </li>
                    ))}
                  </ul>
                  {!terminal && pending.length > 0 && (
                    <div className="change-set-actions">
                      <button
                        className="button primary"
                        type="button"
                        disabled={!writable || Boolean(busyId)}
                        onClick={() => void mutate(changeSet, 'apply')}
                      >
                        <Check size={14} /> 批准并写入目录
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={!writable || Boolean(busyId)}
                        onClick={() => void mutate(changeSet, 'reject')}
                      >
                        <X size={14} /> 拒绝方案
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
