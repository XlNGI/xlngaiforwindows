import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@ai-video/contracts';
import { isCurrentWorkerScope, projectWorker, workerScope } from './worker-scope';
import { MODAL_Z_INDEX } from './workspace/ui-layers';

export interface DraftDeletionTarget {
  id: string;
  title: string;
  lifecycleStatus: string;
  publishedVersionId?: string;
  rowVersion: number;
  chapterId?: string;
  chapterRowVersion?: number;
  productionTarget?: { kind: 'scene' | 'shot'; id: string };
  parentSelectionId?: string;
  dirty?: boolean;
}

export function useDraftDocumentBatch({
  items,
  visibleItems = items,
  writable,
  busy = false,
  resetKey,
  dirtyDocumentId,
  onDeleted,
  onSelectionChange,
  allowArchive = false,
  confirmationNote,
}: {
  items: DraftDeletionTarget[];
  visibleItems?: DraftDeletionTarget[];
  writable: boolean;
  busy?: boolean;
  resetKey: string;
  dirtyDocumentId?: string;
  onDeleted: (items: DraftDeletionTarget[], archived: DocumentSummary[]) => Promise<void>;
  onSelectionChange?: () => void;
  allowArchive?: boolean;
  confirmationNote?: string;
}) {
  const [action, setAction] = useState('删除');
  const [selection, setSelection] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<DraftDeletionTarget[]>();
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const operation = useRef(0);
  const mounted = useRef(true);
  const scope = workerScope();
  const callWorker = projectWorker(scope);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
    };
  }, []);
  useEffect(() => {
    operation.current += 1;
    setSelection([]);
    setConfirmation(undefined);
    setDeleting(false);
    setMessage('');
  }, [resetKey, scope?.projectId, scope?.projectSessionId]);

  const selectable = (item: DraftDeletionTarget) =>
    item.lifecycleStatus === 'active' && !item.publishedVersionId;
  const selectableIdsKey = items
    .filter(selectable)
    .map((item) => item.id)
    .sort()
    .join('\0');
  useEffect(() => {
    const ids = new Set(selectableIdsKey.split('\0'));
    setSelection((current) => {
      const next = current.filter((id) => ids.has(id));
      return next.length === current.length ? current : next;
    });
  }, [selectableIdsKey]);
  const checked = items.filter((item) => selectable(item) && selection.includes(item.id));
  const selectedIds = new Set(checked.map((item) => item.id));
  const selected = checked.filter(
    (item) => !item.parentSelectionId || !selectedIds.has(item.parentSelectionId),
  );
  const disabled = busy || deleting;

  const confirmDelete = async () => {
    if (!confirmation?.length || !writable || disabled) return;
    const request = ++operation.current;
    const current = () =>
      mounted.current && request === operation.current && isCurrentWorkerScope(scope);
    setDeleting(true);
    const deleted: DraftDeletionTarget[] = [];
    const archived: DocumentSummary[] = [];
    const failures: string[] = [];
    for (const item of confirmation) {
      if (!current()) break;
      try {
        if (item.productionTarget) {
          await callWorker('production.lifecycle.change', {
            target: item.productionTarget,
            expectedRowVersion: item.rowVersion,
            archived: true,
          });
        } else if (item.chapterId) {
          const detail = await callWorker('document.get', { documentId: item.id });
          if (!current()) break;
          if (detail.publishedVersionId) throw new Error('已发布，请先取消发布');
          if (detail.rowVersion !== item.rowVersion) throw new Error('文档已变化，请刷新后重试');
          await callWorker('novel.chapter.archive', {
            chapterId: item.chapterId,
            expectedRowVersion: item.chapterRowVersion!,
            reason: 'user_archive',
          });
        } else {
          archived.push(
            await callWorker('document.archive', {
              documentId: item.id,
              expectedDocumentRowVersion: item.rowVersion,
            }),
          );
        }
        deleted.push(item);
      } catch (reason) {
        failures.push(
          `${item.title}：${reason instanceof Error ? reason.message : `${action}失败`}`,
        );
      }
    }
    if (!current()) return;
    setSelection((ids) => ids.filter((id) => !deleted.some((item) => item.id === id)));
    setConfirmation(undefined);
    let refreshError = '';
    try {
      if (deleted.length) await onDeleted(deleted, archived);
    } catch (reason) {
      refreshError = `目录刷新失败：${reason instanceof Error ? reason.message : '请刷新目录'}`;
    }
    if (!current()) return;
    setDeleting(false);
    setMessage(
      [
        `已${action} ${deleted.length} 个草稿，可在已归档或已删除列表中恢复。`,
        ...failures,
        refreshError,
      ]
        .filter(Boolean)
        .join(' '),
    );
  };

  return {
    selectedIds,
    disabled,
    deleting,
    message,
    checkbox: (item: DraftDeletionTarget, label = `选择文档 ${item.title}`) => (
      <input
        className="draft-document-checkbox"
        type="checkbox"
        aria-label={label}
        title={item.publishedVersionId ? '已发布，请先取消发布后删除' : undefined}
        checked={selectedIds.has(item.id)}
        disabled={disabled || !selectable(item)}
        onChange={(event) => {
          onSelectionChange?.();
          setSelection((ids) =>
            event.target.checked
              ? [...new Set([...ids, item.id])]
              : ids.filter((id) => id !== item.id),
          );
        }}
      />
    ),
    controls: (selectLabel = '全选', countLabel = `已选 ${selected.length} 项`) => (
      <div className="draft-document-selection" role="group" aria-label="草稿批量操作">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !visibleItems.some(selectable)}
          onClick={() => {
            onSelectionChange?.();
            setSelection((ids) => [
              ...new Set([...ids, ...visibleItems.filter(selectable).map((item) => item.id)]),
            ]);
          }}
        >
          {selectLabel}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !selected.length}
          onClick={() => setSelection([])}
        >
          取消全选
        </button>
        <span>{countLabel}</span>
        {allowArchive && (
          <button
            type="button"
            className="button secondary"
            disabled={!writable || disabled || !selected.length}
            onClick={() => {
              setAction('归档');
              setMessage('');
              setConfirmation(selected);
            }}
          >
            归档所选
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={!writable || disabled || !selected.length}
          onClick={() => {
            setAction('删除');
            setMessage('');
            setConfirmation(selected);
          }}
        >
          删除所选
        </button>
      </div>
    ),
    dialog: confirmation && (
      <div className="dialog-backdrop" role="presentation" style={{ zIndex: MODAL_Z_INDEX }}>
        <section
          className="document-close-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`${action}所选草稿？`}
        >
          <h2>{action}所选草稿？</h2>
          <p>
            将{action} {confirmation.length} 个草稿，之后可在已归档或已删除列表中恢复。
          </p>
          {confirmationNote && <p>{confirmationNote}</p>}
          <ul>
            {confirmation.map((item) => (
              <li key={item.id}>{item.title}</li>
            ))}
          </ul>
          {confirmation.some((item) => item.id === dirtyDocumentId || item.dirty) && (
            <p>当前文档未保存的更改将被放弃，保留最近一次保存的版本。</p>
          )}
          <div className="document-close-actions">
            <button
              type="button"
              className="button secondary"
              disabled={deleting}
              onClick={() => setConfirmation(undefined)}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!writable || disabled}
              onClick={() => void confirmDelete()}
            >
              {deleting ? `${action}中…` : `确认${action}`}
            </button>
          </div>
        </section>
      </div>
    ),
  };
}
