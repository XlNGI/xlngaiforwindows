import { useState } from 'react';
import type { AgentTaskDetail, AgentTaskReviewTargetInfo } from '@ai-video/contracts';

const labels = {
  unverified: '内容未核验',
  pending: '待内容核验',
  needs_revision: '内容需复核或修复',
  verified: '内容已核验',
};

export function AgentDeliveryFeedback({
  detail,
  onOpenTarget,
}: {
  detail: AgentTaskDetail;
  onOpenTarget?: (projectId: string, target: AgentTaskReviewTargetInfo) => void;
}) {
  const [selectedRequirement, setSelectedRequirement] = useState<string>();
  const review = detail.deliveryReview;
  if (!review?.targets?.length && !review?.issues?.length && !review?.bundle) return null;
  const requirement = review.requirements?.find((r) => r.id === selectedRequirement);
  return (
    <details className="agent-delivery-feedback">
      <summary>
        查看交付与质量 · {review.targets?.length ?? 0} 份正文 · {review.issueCount} 项待处理
      </summary>
      {review.bundle && (
        <p>
          {review.bundle.businessSaved ? '草稿已保存' : '候选处理中'} ·{' '}
          {review.bundle.readbackVerified ? '读回已核对' : '待读回核对'}
          {' · '}
          {review.bundle.requestedAt ? '点击后耗时' : '任务耗时'}{' '}
          {Math.floor(review.bundle.elapsedMs / 60000)} 分{' '}
          {Math.floor(review.bundle.elapsedMs / 1000) % 60} 秒
          {review.bundle.preparationMs !== undefined &&
            `（含启动准备 ${(review.bundle.preparationMs / 1000).toFixed(1)} 秒）`}
          {' · '}
          {Object.entries(review.bundle.counts)
            .map(
              ([kind, count]) =>
                `${({ character: '角色', scene: '场景资料', prop: '道具', voice: '音色样本', storyScene: '场次', shot: '镜头', plan: '辅助文档' } as Record<string, string>)[kind] ?? kind} ${count}`,
            )
            .join('、') || '尚无已保存产物'}
        </p>
      )}
      <ul>
        {review.targets?.map((target) => (
          <li key={target.id}>
            <strong>{target.title}</strong> · {labels[target.state]}
            {onOpenTarget && (
              <button type="button" onClick={() => onOpenTarget(detail.task.projectId, target)}>
                打开当前正文
              </button>
            )}
            <details>
              <summary>对象与核对版本</summary>
              <p>
                {target.id} · {target.version ?? '未取得版本'}
              </p>
            </details>
            {review.issues
              ?.filter((issue) => issue.targetId === target.id)
              .map((issue) => (
                <div key={issue.id}>
                  <p>
                    {issue.evidenceStatus === 'needs_correction'
                      ? '待核实问题（证据需更正）：'
                      : '待处理问题：'}
                    {issue.description}
                  </p>
                  {issue.targetVersion && issue.targetVersion !== target.version && (
                    <small>问题来自较早版本，当前正文仍需复核。</small>
                  )}
                  {issue.requirementIds.map((id) => (
                    <button key={id} type="button" onClick={() => setSelectedRequirement(id)}>
                      查看对应原始要求
                    </button>
                  ))}
                </div>
              ))}
          </li>
        ))}
      </ul>
      {review.issues
        ?.filter((issue) => !review.targets?.some((target) => target.id === issue.targetId))
        .map((issue) => (
          <p key={issue.id}>待重新定位的问题：{issue.description}</p>
        ))}
      {Boolean(review.requirements?.length) && (
        <details open={Boolean(requirement)}>
          <summary>核对原始要求 · {review.requirements?.length} 项</summary>
          {review.requirements?.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={selectedRequirement === item.id}
              onClick={() => setSelectedRequirement(item.id)}
            >
              要求 {index + 1}
            </button>
          ))}
          {requirement && (
            <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {requirement.text}
            </blockquote>
          )}
        </details>
      )}
    </details>
  );
}
