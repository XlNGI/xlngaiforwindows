import { describe, expect, it } from 'vitest';
import {
  generationErrorFeedback,
  generationEventSummary,
  generationPhaseLabel,
  generationStatusLabel,
  videoProgressGuidance,
} from './generation-feedback';

describe('generation feedback', () => {
  it('preserves already-submitted and download outcomes when admission stops a later request', () => {
    expect(
      generationErrorFeedback(
        'Provider image task already submitted; polling failed: REQUEST_QUEUE_FULL: 请求较多',
      ).userMessage,
    ).toContain('图片任务已提交');
    expect(
      generationErrorFeedback('REQUEST_QUEUE_TIMEOUT: 请求尚未发送', 'download').userMessage,
    ).toContain('结果已生成');
    expect(generationErrorFeedback('PROVIDER_COOLDOWN：请稍后重试').userMessage).toContain(
      '正在限流',
    );
    expect(
      generationErrorFeedback('Later operation failed: REQUEST_QUEUE_FULL: busy').userMessage,
    ).not.toContain('尚未发送');
  });
  it.each([
    ['REQUEST_QUEUE_FULL', '当前请求较多'],
    ['REQUEST_QUEUE_TIMEOUT', '当前请求较多'],
    ['PROVIDER_CIRCUIT_OPEN', '连续出错'],
    ['PROVIDER_COOLDOWN', '正在限流'],
  ])('explains %s as an admission refusal before generic transport errors', (code, message) => {
    const result = generationErrorFeedback(`${code}: 请求尚未发送`, 'transport');
    expect(result.userMessage).toContain(message);
    expect(result.technicalDetail).toContain(code);
  });

  it('uses one Chinese status and lifecycle vocabulary', () => {
    expect(generationStatusLabel('polling')).toBe('生成中');
    expect(generationStatusLabel('downloading')).toBe('正在保存结果');
    expect(generationPhaseLabel('download')).toBe('保存结果');
    expect(generationEventSummary('Provider video task submitted.')).toBe(
      '视频任务已提交，正在等待生成。',
    );
    expect(
      generationEventSummary(
        'Worker restarted; Provider video polling resumed from the persisted task snapshot.',
      ),
    ).toBe('应用已恢复，并继续查询此前提交的视频任务。');
  });

  it('turns technical failures into guidance while retaining technical detail', () => {
    expect(
      generationErrorFeedback('Provider authentication failed with HTTP 401.', 'provider'),
    ).toEqual({
      userMessage: '服务认证失败，请检查所选服务区域和 API 密钥。',
      technicalDetail: 'Provider authentication failed with HTTP 401.',
    });
    expect(generationErrorFeedback('fetch failed: ECONNRESET', 'transport')).toEqual({
      userMessage: '无法连接生成服务，请检查网络后重试。',
      technicalDetail: 'fetch failed: ECONNRESET',
    });
    expect(
      generationErrorFeedback(
        'Provider 视频任务提交失败，HTTP 400：invalid_request：input_reference is required。',
        'provider',
      ),
    ).toEqual({
      userMessage:
        '当前模型不接受这组参数。请检查必填项；如果界面参数与官方文档不一致，请更新模型 Schema 或更换模型。',
      technicalDetail:
        'Provider 视频任务提交失败，HTTP 400：invalid_request：input_reference is required。',
    });
  });

  it('sets expectations without inventing a completion time', () => {
    expect(videoProgressGuidance({ status: 'polling', elapsedMs: 30_000, request: {} })).toContain(
      '通常需要几分钟',
    );
    expect(
      videoProgressGuidance({ status: 'polling', elapsedMs: 60_000, request: { off_peak: true } }),
    ).toContain('错峰任务');
    expect(
      videoProgressGuidance({ status: 'downloading', elapsedMs: 60_000, request: {} }),
    ).toContain('保存到本地素材库');
  });
});
