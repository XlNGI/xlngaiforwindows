import type { ProductionReadResult } from '@ai-video/contracts';

export function productionInstructionUpdateRequest(result: ProductionReadResult): string {
  const targets = new Map<string, string>();
  const references = new Set<string>();
  for (const issue of result.issues) {
    if (issue.code !== 'STALE_INSTRUCTION') continue;
    const target = issue.target ?? result.target;
    targets.set(`${target.kind}:${target.id}`, issue.targetTitle ?? '当前制作对象');
    for (const reference of issue.changedReferences ?? []) references.add(reference.title);
  }
  return [
    '请根据最新项目资料，更新以下已有场次或镜头的制作指令：',
    ...[...targets].map(([id, title]) => `- ${title}（${id}）`),
    ...(references.size ? [`已更新的资料：${[...references].join('、')}。`] : []),
    '先读取当前对象、制作指令及相关资料，只修改受资料变化影响的部分，保留已有剧情、镜头顺序、对白、素材选择和手工修改，不重建场次或镜头。',
    '使用当前版本保存更新；有冲突先说明。检查并修订相关连续性问题，按实际保存结果报告仍待处理的项目；不要提交图片或视频生成任务。',
  ].join('\n');
}
