import type {
  GenerationJobEventInfo,
  VideoGenerationFailureKind,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';

const statusLabels: Record<string, string> = {
  pending: '正在提交',
  queued: '排队中',
  running: '执行中',
  polling: '生成中',
  downloading: '正在保存结果',
  paused: '已暂停',
  waiting_review: '等待审核',
  recovering: '恢复中',
  completed: '已完成',
  succeeded: '已完成',
  failed: '失败',
  'timed-out': '已超时',
  cancelled: '已取消',
  rejected: '已拒绝',
};

const phaseLabels: Record<GenerationJobEventInfo['phase'], string> = {
  prepare: '准备任务',
  submit: '提交生成',
  poll: '查询进度',
  download: '保存结果',
  complete: '完成',
  fail: '失败',
};

const exactEventSummaries: Record<string, string> = {
  'Image generation job prepared.': '图片生成任务已准备完成。',
  'Video generation job prepared.': '视频生成任务已准备完成。',
  'Provider video task submitted.': '视频任务已提交，正在等待生成。',
  'Provider video task polled.': '已查询一次视频生成进度。',
  'Provider video output is downloading.': '生成完成，正在把视频保存到本地素材库。',
  'Image result downloaded and committed locally.': '图片已保存到本地素材库。',
  'Video output downloaded and committed locally.': '视频已保存到本地素材库。',
  'Video submission was interrupted before a provider task was recorded.':
    '应用中断时任务尚未完成提交，为避免重复扣费，本次任务已停止。',
  'Generation was interrupted before completion.': '应用中断导致任务未完成，请重新生成。',
};

export interface GenerationErrorFeedback {
  userMessage: string;
  technicalDetail?: string;
}

export function generationStatusLabel(status: string): string {
  return statusLabels[status] ?? status;
}

export function generationPhaseLabel(phase: GenerationJobEventInfo['phase']): string {
  return phaseLabels[phase];
}

export function videoProgressGuidance(
  job: Pick<VideoGenerationJobInfo, 'status' | 'elapsedMs' | 'request'>,
): string {
  switch (job.status) {
    case 'pending':
      return '正在连接生成服务；提交成功后会自动查询进度。';
    case 'polling':
      if (job.request.off_peak === true)
        return '错峰任务可能等待较久，可离开当前页面，应用会继续查询。';
      if (job.elapsedMs < 2 * 60_000) return '视频通常需要几分钟生成，可离开当前页面继续其他工作。';
      if (job.elapsedMs < 15 * 60_000) return '仍在生成中，应用会自动查询，无需重复提交。';
      return '本次生成耗时较长，应用仍在自动查询；可暂停查询或取消任务。';
    case 'downloading':
      return 'Provider 已完成生成，正在安全保存到本地素材库。';
    case 'paused':
      return '已停止自动查询；任务仍保留在 Provider，可随时继续。';
    case 'succeeded':
      return '结果已进入素材库，可直接查看、播放或打开文件位置。';
    case 'failed':
      return '本次任务未完成，可根据提示调整后重新提交。';
    case 'timed-out':
      return '已停止自动查询；可稍后重新提交或检查 Provider 后台。';
    case 'cancelled':
      return '本地任务已取消，不会继续查询。';
  }
}

export function generationEventSummary(summary: string): string {
  const exact = exactEventSummaries[summary];
  if (exact) return exact;
  if (/Worker restarted.*polling resumed/i.test(summary)) {
    return '应用已恢复，并继续查询此前提交的视频任务。';
  }
  if (/polling failed with HTTP (\d+)/i.test(summary)) {
    const code = summary.match(/HTTP (\d+)/i)?.[1];
    return `查询生成进度失败${code ? `（HTTP ${code}）` : ''}，请稍后重试。`;
  }
  return summary;
}

export function generationErrorFeedback(
  message: string,
  failureKind?: VideoGenerationFailureKind,
): GenerationErrorFeedback {
  const normalized = message.trim();
  const technicalDetail = /[\u3400-\u9fff]/u.test(normalized) ? undefined : normalized;
  if (failureKind === 'interrupted' || /interrupted|worker restarted/i.test(normalized)) {
    return {
      userMessage: '应用中断时任务未能安全继续，请重新生成。',
      technicalDetail,
    };
  }
  if (/authentication|unauthorized|HTTP 401/i.test(normalized)) {
    return {
      userMessage: '服务认证失败，请检查所选服务区域和 API 密钥。',
      technicalDetail,
    };
  }
  if (failureKind === 'timeout' || /timed? out|timeout/i.test(normalized)) {
    return { userMessage: '等待生成结果超时，可稍后重新尝试。', technicalDetail };
  }
  if (
    failureKind === 'transport' ||
    /transport|network|ECONN|ENOTFOUND|fetch failed/i.test(normalized)
  ) {
    return { userMessage: '无法连接生成服务，请检查网络后重试。', technicalDetail };
  }
  if (failureKind === 'download' || /download/i.test(normalized)) {
    return { userMessage: '结果已生成，但保存到本地时失败，请重试。', technicalDetail };
  }
  if (
    /invalid_request|unsupported|not support|unknown (?:field|parameter)|is required/i.test(
      normalized,
    )
  ) {
    return {
      userMessage:
        '当前模型不接受这组参数。请检查必填项；如果界面参数与官方文档不一致，请更新模型 Schema 或更换模型。',
      technicalDetail: normalized,
    };
  }
  if (/did not contain|returned no .*output|unsupported .*state/i.test(normalized)) {
    return { userMessage: '生成服务返回了无法识别的结果，请稍后重试或更换模型。', technicalDetail };
  }
  if (/[\u3400-\u9fff]/u.test(normalized)) return { userMessage: normalized };
  return { userMessage: '任务未能完成，请查看技术信息或稍后重试。', technicalDetail };
}
