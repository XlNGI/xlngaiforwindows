import type { MediaSubmissionConfirmationRequest } from '@ai-video/contracts';
import { MODAL_Z_INDEX } from './workspace/ui-layers';

/**
 * One review surface for every paid media submission.
 *
 * The Agent loop froze a draft version and showed its provider, model,
 * parameters and cost notice before calling the Provider, while the direct chat
 * and production-panel paths only raised a native `window.confirm` with a
 * plain-text summary. That let the user approve a paid action whose frozen
 * parameters were never shown in the same shape. All paid paths now render this
 * card so the review surface cannot drift again.
 */
export function MediaSubmissionConfirmationCard({
  confirmation,
  onDecide,
}: {
  confirmation: MediaSubmissionConfirmationRequest;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="agent-confirmation" role="alert">
      <strong>需要确认：提交{confirmation.kind === 'image' ? '图片' : '视频'}生成任务</strong>
      <span>
        {confirmation.providerName} / {confirmation.modelName}
      </span>
      <small>草稿版本 v{confirmation.draftVersion}</small>
      <dl className="agent-confirmation-parameters">
        {confirmation.parameterSummary.map(({ key, value }) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <small>{confirmation.costNotice.summary}</small>
      <small>确认有效期至 {new Date(confirmation.expiresAt).toLocaleString()}</small>
      <div>
        <button className="button primary" type="button" onClick={() => onDecide(true)}>
          批准
        </button>
        <button className="button secondary" type="button" onClick={() => onDecide(false)}>
          拒绝
        </button>
      </div>
    </div>
  );
}

/** Modal shell for callers outside the conversation panel. */
export function MediaSubmissionConfirmationDialog({
  confirmation,
  onDecide,
}: {
  confirmation: MediaSubmissionConfirmationRequest;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" style={{ zIndex: MODAL_Z_INDEX }}>
      <section
        className="media-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="确认付费提交"
      >
        <MediaSubmissionConfirmationCard confirmation={confirmation} onDecide={onDecide} />
      </section>
    </div>
  );
}
