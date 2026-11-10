import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ProductionCompileResult } from '@ai-video/contracts';
import { ProductionTimingDetails } from './ProductionTimingDetails';
afterEach(cleanup);
const result: ProductionCompileResult = {
  target: { kind: 'shot', id: 'pen' },
  rowVersion: 1,
  issues: [],
  parameters: { duration: 5 },
  estimatedDurationSeconds: 2.2,
  requestedDurationSeconds: 5,
  ...{
    prompt: '自然拿笔',
    timing: {
      estimatedDurationSeconds: 2.2,
    },
  },
};
it('shows numeric timing and follows current form edits instead of the compiled request', () => {
  const view = render(<ProductionTimingDetails result={result} requestedDuration={5} />);
  expect(screen.getByText(/请求余量 2.8 秒/)).toBeInTheDocument();
  expect(screen.getByText('2.2 秒')).toBeInTheDocument();
  view.rerender(<ProductionTimingDetails result={result} requestedDuration="15" />);
  expect(screen.getByText(/请求余量 12.8 秒/)).toBeInTheDocument();
  expect(screen.getByText(/当前模型请求 15 秒/)).toBeInTheDocument();
  view.rerender(<ProductionTimingDetails result={result} requestedDuration={1} />);
  expect(screen.getByText(/比内容预计短 1.2 秒/)).toBeInTheDocument();
  expect(screen.queryByText(/请求余量/)).not.toBeInTheDocument();
  view.rerender(<ProductionTimingDetails result={result} requestedDuration={-1} />);
  expect(screen.getByText(/请求时长由模型决定/)).toBeInTheDocument();
  expect(screen.queryByText(/当前模型请求 5 秒/)).not.toBeInTheDocument();
  view.rerender(<ProductionTimingDetails result={result} requestedDuration={undefined} />);
  expect(screen.getByText(/请求时长尚未确定/)).toBeInTheDocument();
});
it('shows ordered scene intervals and duration locks', () => {
  render(
    <ProductionTimingDetails
      result={{
        ...result,
        timeline: [
          {
            shotId: 'pen',
            title: '拿笔',
            startSeconds: 10,
            endSeconds: 12.2,
            estimatedDurationSeconds: 2.2,
            prompt: '自然拿笔',
            timing: { ...result.timing!, locked: true },
          },
          {
            shotId: 'old',
            title: '旧镜头',
            prompt: '旧正文',
            timing: { estimatedDurationSeconds: 4 },
          },
        ],
      }}
      requestedDuration={2.2}
    />,
  );
  expect(screen.getByText(/拿笔：10—12.2 秒/)).toBeInTheDocument();
  expect(screen.getByText('2.2 秒 · 时长已锁定')).toBeInTheDocument();
  expect(screen.getByText('4 秒')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('does not show a full-scene estimate as evidence for a selected segment', () => {
  render(
    <ProductionTimingDetails
      result={{
        ...result,
        target: { kind: 'scene', id: 'scene' },
        source: {
          mode: 'form',
          target: { kind: 'scene', id: 'scene' },
          token: 'token',
          shotIds: ['pen'],
        },
      }}
      requestedDuration={5}
    />,
  );
  expect(screen.getByText(/内容预计 2.2 秒/)).toBeInTheDocument();
  expect(screen.queryByText(/估时依据：自然拿笔并稳定/)).not.toBeInTheDocument();
});
