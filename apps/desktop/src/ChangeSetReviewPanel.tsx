import { Check, ChevronDown, CircleAlert, ListChecks, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentChangeSetInfo } from '@ai-video/contracts';
import { callWorker } from './worker-client';

interface ChangeSetReviewPanelProps {
  projectId?: string;
  writable: boolean;
}

const terminalStatuses = new Set(['applied', 'rejected', 'conflicted']);

export function ChangeSetReviewPanel({ projectId, writable }: ChangeSetReviewPanelProps) {
  const [changeSets, setChangeSets] = useState<AgentChangeSetInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string>();
  const [selectedItems, setSelectedItems] = useState<Record<string, string[]>>({});
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!projectId) {
      setChangeSets([]);
      return;
    }
    setChangeSets(await callWorker('agent.changeSet.list', { includeTerminal: false }));
  };

  useEffect(() => {
    void load();
  }, [projectId]);

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
      setChangeSets((rows) => rows.map((row) => (row.id === result.id ? result : row)));
      setSelectedItems((rows) => ({ ...rows, [result.id]: [] }));
      setMessage(
        result.status === 'conflicted'
          ? 'The proposal conflicted with a newer scene or shot version.'
          : action === 'apply'
            ? 'Selected proposal changes applied.'
            : 'Selected proposal changes rejected.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Change set action failed.');
      await load();
    } finally {
      setBusyId(undefined);
    }
  };

  if (!projectId || changeSets.length === 0) return null;

  return (
    <section className="change-set-review" aria-label="Scene and shot proposals">
      <div className="change-set-review-heading">
        <div>
          <span className="eyebrow">Agent proposals</span>
          <h2>
            <ListChecks size={16} /> Scene and shot changes
          </h2>
        </div>
        <button
          className="icon-button subtle"
          type="button"
          title="Refresh proposals"
          aria-label="Refresh proposals"
          disabled={Boolean(busyId)}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {message && <p className="inline-status">{message}</p>}
      <div className="change-set-list">
        {changeSets.map((changeSet) => {
          const pending = pendingItems(changeSet);
          const selected = itemSelection(changeSet);
          const expanded = expandedId === changeSet.id;
          const terminal = terminalStatuses.has(changeSet.status);
          return (
            <article className="change-set-entry" key={changeSet.id}>
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
                    {changeSet.status} · {pending.length} pending item
                    {pending.length === 1 ? '' : 's'}
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
                            {item.action} {item.entityType}: {item.title}
                          </strong>
                          <small>
                            {item.status}
                            {item.shotStatus ? ` · ${item.shotStatus}` : ''}
                            {item.expectedRowVersion !== undefined
                              ? ` · base v${item.expectedRowVersion}`
                              : ''}
                          </small>
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
                        <Check size={14} /> Approve
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={!writable || Boolean(busyId)}
                        onClick={() => void mutate(changeSet, 'reject')}
                      >
                        <X size={14} /> Reject
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
