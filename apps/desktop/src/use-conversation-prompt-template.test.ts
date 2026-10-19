import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationInfo, ConversationPromptTemplateInfo } from '@ai-video/contracts';
import { useConversationPromptTemplate } from './use-conversation-prompt-template';
import { SCENE_PROMPT_CONSTRAINT_TEMPLATE } from './conversation-prompt-template';
import { callWorker } from './worker-client';
import { selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
const conversation = (id: string, projectId = 'project'): ConversationInfo => ({
  id,
  projectId,
  scopeType: 'project',
  title: id,
  createdAt: 'now',
  updatedAt: 'now',
});
const saved = (id: string, content: string, rowVersion = 1): ConversationPromptTemplateInfo => ({
  conversationId: id,
  content,
  rowVersion,
});
beforeEach(() => {
  selectWorkerScope(undefined);
  vi.resetAllMocks();
});
afterEach(cleanup);

describe('conversation prompt template drafts', () => {
  it('loads a detailed starter, saves the edited value before submitting, and respects saved clearing', async () => {
    const target = conversation('a');
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '', 0));
    const { result } = renderHook(() => useConversationPromptTemplate(target));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.content).toBe(SCENE_PROMPT_CONSTRAINT_TEMPLATE);
    act(() => result.current.change('固定清晨与冷色风格'));
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '固定清晨与冷色风格'));
    let submitted = '';
    await act(async () => {
      submitted = await result.current.saveForSubmission(target);
    });
    expect(submitted).toBe('固定清晨与冷色风格');
    expect(callWorker).toHaveBeenLastCalledWith('conversation.promptTemplate.save', {
      conversationId: 'a',
      content: submitted,
      expectedRowVersion: 0,
    });
    act(() => result.current.change(''));
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '', 2));
    await act(async () => {
      await result.current.saveForSubmission(target);
    });
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '', 2));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.content).toBe('');
  });

  it('retains each conversation draft and ignores an old save response after switching projects', async () => {
    const a = conversation('a');
    const b = conversation('b', 'other-project');
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', 'A 初始'));
    const { result, rerender } = renderHook(({ target }) => useConversationPromptTemplate(target), {
      initialProps: { target: a },
    });
    await waitFor(() => expect(result.current.content).toBe('A 初始'));
    act(() => result.current.change('A 修改'));
    let finish!: (value: ConversationPromptTemplateInfo) => void;
    vi.mocked(callWorker).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<string>;
    await act(async () => {
      pending = result.current.saveForSubmission(a);
      await Promise.resolve();
    });
    vi.mocked(callWorker).mockResolvedValueOnce(saved('b', 'B 独立要求'));
    rerender({ target: b });
    await waitFor(() => expect(result.current.content).toBe('B 独立要求'));
    await act(async () => {
      finish(saved('a', 'A 修改', 2));
      await pending;
    });
    expect(result.current.content).toBe('B 独立要求');
    rerender({ target: a });
    await waitFor(() => expect(result.current.content).toBe('A 修改'));
  });

  it('waits for an in-flight load and uses the explicitly targeted conversation instead of the visible draft', async () => {
    const a = conversation('a');
    const b = conversation('b');
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', 'A 约束'));
    const { result } = renderHook(() => useConversationPromptTemplate(a));
    await waitFor(() => expect(result.current.content).toBe('A 约束'));
    let finish!: (value: ConversationPromptTemplateInfo) => void;
    vi.mocked(callWorker).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<string>;
    await act(async () => {
      pending = result.current.saveForSubmission(b);
      await Promise.resolve();
    });
    await act(async () => {
      finish(saved('b', 'B 约束'));
      expect(await pending).toBe('B 约束');
    });
    expect(result.current.content).toBe('A 约束');
  });

  it('coalesces simultaneous saves and keeps a conflict draft available for recovery', async () => {
    const target = conversation('a');
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '原要求'));
    const { result } = renderHook(() => useConversationPromptTemplate(target));
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => result.current.change('新要求'));
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '新要求', 2));
    await act(async () => {
      await Promise.all([
        result.current.saveForSubmission(target),
        result.current.saveForSubmission(target),
      ]);
    });
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'conversation.promptTemplate.save'),
    ).toHaveLength(1);
    act(() => result.current.change('冲突草稿'));
    vi.mocked(callWorker).mockRejectedValueOnce(
      new Error('CONVERSATION_PROMPT_TEMPLATE_ROW_VERSION_CONFLICT'),
    );
    await act(async () => {
      await expect(result.current.saveForSubmission(target)).rejects.toThrow('CONFLICT');
    });
    expect(result.current.content).toBe('冲突草稿');
    expect(result.current.error).toContain('其他窗口');
  });

  it('rejects submission on load failure and reloads from the new Worker session', async () => {
    const target = conversation('a');
    selectWorkerScope({ projectId: 'project', projectSessionId: 'old' });
    vi.mocked(callWorker).mockRejectedValueOnce(new Error('读取失败'));
    const { result, rerender } = renderHook(() => useConversationPromptTemplate(target));
    await waitFor(() => expect(result.current.error).toBe('读取失败'));
    vi.mocked(callWorker).mockRejectedValueOnce(new Error('读取失败'));
    await act(async () => {
      await expect(result.current.saveForSubmission(target)).rejects.toThrow('读取失败');
    });
    selectWorkerScope({ projectId: 'project', projectSessionId: 'new' });
    vi.mocked(callWorker).mockResolvedValueOnce(saved('a', '恢复后的约束', 3));
    rerender();
    await waitFor(() => expect(result.current.content).toBe('恢复后的约束'));
    expect(callWorker).toHaveBeenLastCalledWith(
      'conversation.promptTemplate.get',
      { conversationId: 'a' },
      { projectId: 'project', projectSessionId: 'new' },
    );
  });
});
