import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  AgentTaskDetail,
  LlmGenerationInfo,
  UnifiedAgentRunResult,
} from '@ai-video/contracts';
import { splitNovelChapterCreationRequest } from '@ai-video/contracts';
import { runNovelChapterBatch } from './novel-chapter-batch';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
const params = {
  conversationId: 'conversation',
  prompt: '生成第四章和第五章',
  idempotencyKey: 'batch',
};
const requests = splitNovelChapterCreationRequest(params.prompt);
beforeEach(() => vi.resetAllMocks());

function mockBatch(failed = false) {
  let started = 0;
  vi.mocked(callWorker).mockImplementation((method) => {
    if (method === 'agent.run') {
      started++;
      return Promise.resolve({
        status: 'started',
        agentTaskId: `task-${started}`,
        stream: { generationId: `generation-${started}` },
      } as UnifiedAgentRunResult);
    }
    if (method === 'llm.generation.get')
      return Promise.resolve({
        status: failed ? 'failed' : 'complete',
        error: failed ? 'timeout' : undefined,
      } as LlmGenerationInfo);
    if (method === 'agent.task.get')
      return Promise.resolve({
        task: { status: failed ? 'failed' : 'waiting_review' },
        target: { targetKind: 'novel-chapter', documentId: `document-${started}` },
        documents: failed ? [] : [{ documentId: `document-${started}` }],
      } as AgentTaskDetail);
    if (method === 'llm.generation.cancel')
      return Promise.resolve({ status: 'cancelled' } as LlmGenerationInfo);
    throw new Error(`Unexpected ${method}`);
  });
}

describe('runNovelChapterBatch', () => {
  it.each(['missing_model', 'model_unavailable'] as const)(
    'preserves model selection before any chapter runs: %s',
    async (reason) => {
      const selection = {
        status: 'needs_model_selection' as const,
        capability: 'text' as const,
        reason,
        models: [],
      };
      vi.mocked(callWorker).mockResolvedValue(selection);
      const launch = vi.fn();
      const onStarted = vi.fn();
      expect(
        await runNovelChapterBatch(params, requests, {
          launch,
          onStarted,
          onProgress: vi.fn(),
          isCancelled: () => false,
        }),
      ).toEqual(selection);
      expect(callWorker).toHaveBeenCalledTimes(1);
      expect(callWorker).toHaveBeenCalledWith(
        'agent.run',
        expect.objectContaining({
          novelIntent: { action: 'create_chapter', displayLabel: '第四章', chapterTitle: '第四章' },
        }),
      );
      expect(launch).not.toHaveBeenCalled();
      expect(onStarted).not.toHaveBeenCalled();
    },
  );

  it('starts the next chapter only after the previous draft has been saved', async () => {
    mockBatch();
    let release!: () => void;
    const launch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const onProgress = vi.fn();
    const onStarted = vi.fn();
    const batch = runNovelChapterBatch(params, requests, {
      launch,
      onStarted,
      onProgress,
      isCancelled: () => false,
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.run'),
    ).toHaveLength(1);
    release();
    await batch;
    const calls = vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.run');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toMatchObject({
      novelIntent: { displayLabel: '第四章' },
      idempotencyKey: 'batch:chapter:0',
    });
    expect(calls[1]?.[1]).toMatchObject({
      novelIntent: { displayLabel: '第五章' },
      idempotencyKey: 'batch:chapter:1',
    });
    expect(onProgress).toHaveBeenLastCalledWith('2章草稿已生成，请逐章审核。');
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(calls.every(([, params]) => !(params as { modelId?: string }).modelId)).toBe(true);
  });

  it('stops at the remaining chapter if its model becomes unavailable', async () => {
    mockBatch();
    const original = vi.mocked(callWorker).getMockImplementation()!;
    let starts = 0;
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'agent.run' && ++starts === 2)
        return Promise.resolve({
          status: 'needs_model_selection',
          capability: 'text',
          reason: 'model_unavailable',
          models: [],
        } as UnifiedAgentRunResult);
      return original(method, params);
    });
    const launch = vi.fn();
    await expect(
      runNovelChapterBatch(params, requests, {
        launch,
        onProgress: vi.fn(),
        isCancelled: () => false,
      }),
    ).rejects.toThrow('第五章的模型不可用');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(starts).toBe(2);
  });

  it('cancels the prepared chapter if preserving the original request fails', async () => {
    mockBatch();
    const launch = vi.fn();
    await expect(
      runNovelChapterBatch(params, requests, {
        launch,
        onProgress: vi.fn(),
        isCancelled: () => false,
        onStarted: () => Promise.reject(new Error('message save failed')),
      }),
    ).rejects.toThrow('message save failed');
    expect(launch).not.toHaveBeenCalled();
    expect(callWorker).toHaveBeenCalledWith('llm.generation.cancel', {
      generationId: 'generation-1',
    });
  });

  it('stops remaining chapters after a failed generation', async () => {
    mockBatch(true);
    await expect(
      runNovelChapterBatch(params, requests, {
        launch: vi.fn(),
        onProgress: vi.fn(),
        isCancelled: () => false,
      }),
    ).rejects.toThrow('第四章未完成，后续章节已停止。timeout');
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.run'),
    ).toHaveLength(1);
  });

  it('stops after cancellation while the first chapter is running', async () => {
    mockBatch();
    let cancelled = false;
    await runNovelChapterBatch(params, requests, {
      launch: () => {
        cancelled = true;
        return Promise.resolve();
      },
      onProgress: vi.fn(),
      isCancelled: () => cancelled,
    });
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.run'),
    ).toHaveLength(1);
  });

  it('cancels a prepared generation when the project changes during preparation', async () => {
    mockBatch();
    let checks = 0;
    const launch = vi.fn();
    await runNovelChapterBatch(params, requests, {
      launch,
      onProgress: vi.fn(),
      isCancelled: () => ++checks > 1,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(callWorker).toHaveBeenCalledWith('llm.generation.cancel', {
      generationId: 'generation-1',
    });
  });
});
