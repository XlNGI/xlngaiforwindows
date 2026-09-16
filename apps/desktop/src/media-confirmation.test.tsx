import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaSubmissionConfirmationRequest } from '@ai-video/contracts';
import {
  MediaSubmissionConfirmationCard,
  MediaSubmissionConfirmationDialog,
} from './media-confirmation';

afterEach(cleanup);

const confirmation: MediaSubmissionConfirmationRequest = {
  confirmationToken: 'one-time-token',
  jobId: 'media-job',
  kind: 'video',
  draftVersion: 2,
  providerName: '媒体供应商',
  modelName: '视频模型',
  adapterKey: 'TEXT_TO_VIDEO:test:model:v1',
  parameterSummary: [
    { key: 'duration', value: '5' },
    { key: 'prompt', value: '雨夜的城市街道' },
  ],
  costNotice: { required: true, summary: '本次提交可能产生费用。' },
  expiresAt: '2999-01-01T00:00:00.000Z',
};

describe('media submission confirmation', () => {
  it('shows the frozen draft version and parameters before a paid submission', () => {
    const onDecide = vi.fn();
    render(<MediaSubmissionConfirmationCard confirmation={confirmation} onDecide={onDecide} />);

    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('提交视频生成任务');
    expect(card).toHaveTextContent('媒体供应商 / 视频模型');
    expect(card).toHaveTextContent('草稿版本 v2');
    expect(card).toHaveTextContent('duration');
    expect(card).toHaveTextContent('雨夜的城市街道');
    expect(card).toHaveTextContent('本次提交可能产生费用。');

    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecide).toHaveBeenNthCalledWith(1, true);
    expect(onDecide).toHaveBeenNthCalledWith(2, false);
  });

  it('labels the image kind and wraps the same card in the modal shell', () => {
    const onDecide = vi.fn();
    render(
      <MediaSubmissionConfirmationDialog
        confirmation={{ ...confirmation, kind: 'image' }}
        onDecide={onDecide}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '确认付费提交' });
    expect(dialog).toHaveTextContent('提交图片生成任务');
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });
});
