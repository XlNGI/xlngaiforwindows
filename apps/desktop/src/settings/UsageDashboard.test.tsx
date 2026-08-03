import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageClient } from '../usage-client';
import { UsageDashboard } from './UsageDashboard';

vi.mock('../usage-client', () => ({
  usageClient: {
    list: vi.fn(),
    rebuild: vi.fn(),
  },
}));

const entries = [
  {
    attemptId: 'attempt-usd',
    projectId: 'project-a',
    projectName: '项目 A',
    providerProfileId: 'provider-a',
    providerName: 'OpenAI A',
    modelId: 'model-a',
    modelName: 'GPT A',
    status: 'complete',
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCost: '0.002',
    currency: 'USD',
    createdAt: '2026-08-03T01:00:00.000Z',
  },
  {
    attemptId: 'attempt-cny',
    projectId: 'project-b',
    projectName: '项目 B',
    providerProfileId: 'provider-b',
    providerName: 'Relay B',
    modelId: 'model-b',
    modelName: 'Model B',
    status: 'failed',
    inputTokens: 80,
    outputTokens: 10,
    totalTokens: 90,
    estimatedCost: '0.03',
    currency: 'CNY',
    createdAt: '2026-08-03T02:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usageClient.list).mockResolvedValue({
    entries,
    summaries: [
      {
        currency: 'CNY',
        attempts: 1,
        inputTokens: 80,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        totalTokens: 90,
        estimatedCost: '0.03',
      },
      {
        currency: 'USD',
        attempts: 1,
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 150,
        estimatedCost: '0.002',
      },
    ],
  });
  vi.mocked(usageClient.rebuild).mockResolvedValue({
    projectsScanned: 2,
    projectsSkipped: 1,
    attemptsIndexed: 8,
  });
});

afterEach(cleanup);

describe('UsageDashboard', () => {
  it('shows currencies separately and applies usage filters', async () => {
    render(<UsageDashboard />);

    expect((await screen.findAllByText('USD 0.002')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('CNY 0.03').length).toBeGreaterThan(0);
    expect(screen.getAllByText('项目 A').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'failed' } });

    await waitFor(() =>
      expect(usageClient.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed' }),
      ),
    );
  });

  it('rebuilds the derived usage index and refreshes the list', async () => {
    render(<UsageDashboard />);
    await waitFor(() => expect(usageClient.list).toHaveBeenCalledTimes(1));
    const callsBefore = vi.mocked(usageClient.list).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /重建用量索引/ }));

    expect(
      await screen.findByText(/扫描 2 个项目，写入 8 次调用，跳过 1 个项目/),
    ).toBeInTheDocument();
    await waitFor(() => expect(usageClient.list).toHaveBeenCalledTimes(callsBefore + 1));
  });
});
