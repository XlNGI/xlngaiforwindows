import type { ProductionCompileResult, ProductionTiming } from '@ai-video/contracts';

function TimingEvidence({ timing }: { timing?: ProductionTiming }) {
  if (!timing) return null;
  return (
    <>
      <p>估时依据：{timing.rationale}</p>
      {timing.beats?.length ? (
        <ul aria-label="镜内节拍（相对本镜）">
          {timing.beats.map((beat, index) => (
            <li key={index}>
              {beat.startSeconds}—{beat.endSeconds} 秒：{beat.description}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Use the current form value: the compiler snapshot may precede a manual duration edit. */
export function ProductionTimingDetails({
  result,
  requestedDuration,
}: {
  result?: ProductionCompileResult;
  requestedDuration: unknown;
}) {
  const estimated = result?.estimatedDurationSeconds;
  const requested =
    (typeof requestedDuration === 'number' ||
      (typeof requestedDuration === 'string' && requestedDuration.trim())) &&
    Number.isFinite(Number(requestedDuration)) &&
    Number(requestedDuration) > 0
      ? Number(requestedDuration)
      : undefined;
  const difference =
    estimated !== undefined && requested !== undefined
      ? Number((requested - estimated).toFixed(6))
      : undefined;
  return (
    <section aria-label="镜头估时依据">
      {estimated !== undefined && (
        <>
          <p>
            内容预计 {estimated} 秒 ·{' '}
            {requested !== undefined
              ? `当前模型请求 ${requested} 秒`
              : Number(requestedDuration) === -1
                ? '请求时长由模型决定'
                : '请求时长尚未确定'}
          </p>
          {difference !== undefined && difference > 0 && (
            <p role="status">
              请求余量 {difference} 秒。保持自然动作节奏，生成后检查并选取完整可用的片段。
            </p>
          )}
          {difference !== undefined && difference < 0 && (
            <p role="status">
              当前请求比内容预计短 {-difference}{' '}
              秒，可能无法容纳完整动作或对白；请核对时长或重新编排。
            </p>
          )}
          <TimingEvidence
            timing={result?.source?.shotIds?.length ? undefined : result?.authoringIR?.timing}
          />
        </>
      )}
      {Boolean(result?.timeline?.length) && (
        <details>
          <summary>场次分镜时间轴（{result!.timeline!.length} 镜头）</summary>
          <ol>
            {result!.timeline!.map((entry) => (
              <li key={entry.shotId}>
                {entry.title}：
                {entry.startSeconds === undefined || entry.endSeconds === undefined
                  ? '时间待补充'
                  : `${entry.startSeconds}—${entry.endSeconds} 秒`}
                <TimingEvidence timing={entry.timing} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
