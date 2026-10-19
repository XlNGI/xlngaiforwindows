import type { AgentProtectedUiHandoff, MediaModelSelectionDecision } from '@ai-video/contracts';
import { MediaModelSelectionCard } from './ChatPanel';
import { MediaSubmissionConfirmationCard } from './media-confirmation';
import type { TaskConfirmation } from './task-confirmations';
import { MODAL_Z_INDEX } from './workspace/ui-layers';

export function TaskConfirmationDialog({
  item,
  count,
  onDecide,
  onOpenProtectedUi,
}: {
  item: TaskConfirmation;
  count: number;
  onDecide: (key: string, decision: boolean | MediaModelSelectionDecision | undefined) => void;
  onOpenProtectedUi: (handoff: AgentProtectedUiHandoff) => void;
}) {
  const decide = (value: boolean | MediaModelSelectionDecision | undefined) =>
    onDecide(item.key, value);
  return (
    <div className="dialog-backdrop" role="presentation" style={{ zIndex: MODAL_Z_INDEX }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label="任务确认">
        <p>
          {item.label} · {count} 项待确认
        </p>
        {item.kind === 'paid' ? (
          <MediaSubmissionConfirmationCard confirmation={item.request} onDecide={decide} />
        ) : item.kind === 'model' ? (
          <MediaModelSelectionCard
            request={item.request}
            referenceImageInputs={item.referenceImageInputs}
            onSelect={decide}
            onCancel={() => decide(undefined)}
          />
        ) : (
          <div className="agent-confirmation">
            <strong>需要确认：{item.request.summary}</strong>
            <small>风险等级：{item.request.riskLevel}</small>
            <ul>
              {item.request.affectedEntities.map((entity) => (
                <li key={`${entity.type}:${entity.id}`}>{entity.label || entity.id}</li>
              ))}
            </ul>
            <small>确认有效期至 {new Date(item.request.expiresAt).toLocaleString()}</small>
            <button
              className="button primary"
              type="button"
              disabled={Date.parse(item.request.expiresAt) <= Date.now()}
              onClick={() => {
                if (item.request.protectedUi) onOpenProtectedUi(item.request.protectedUi);
                decide(true);
              }}
            >
              {item.request.protectedUi ? '在受保护页面继续' : '批准'}
            </button>
            <button className="button secondary" type="button" onClick={() => decide(false)}>
              拒绝
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
