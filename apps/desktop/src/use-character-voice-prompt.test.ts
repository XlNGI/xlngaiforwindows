import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail } from '@ai-video/contracts';
import { useCharacterVoicePrompt } from './use-character-voice-prompt';
import { callWorker } from './worker-client';
import { selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
const voice: DocumentDetail = {
  id: 'voice',
  projectId: 'project',
  kind: 'voice',
  title: '角色音色',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 2,
  createdAt: 'now',
  updatedAt: 'now',
  currentVersionId: 'v1',
  currentVersion: {
    id: 'v1',
    documentId: 'voice',
    version: 1,
    contentMarkdown: '低沉清晰',
    sampleText: '你好。',
    state: 'draft',
    authorType: 'user',
    createdAt: 'now',
  },
};
const options = { characterId: 'character', voiceDocumentId: 'voice', writable: true };

beforeEach(() => {
  selectWorkerScope(undefined);
  vi.mocked(callWorker).mockReset();
  vi.mocked(callWorker).mockResolvedValue(voice);
});
afterEach(() => {
  cleanup();
  selectWorkerScope(undefined);
});

describe('useCharacterVoicePrompt', () => {
  it.each(['published', 'in_review', 'project_read_only'] as const)(
    'keeps %s voice prompts read-only',
    async (state) => {
      vi.mocked(callWorker).mockResolvedValue({
        ...voice,
        publishedVersionId: state === 'published' ? 'published' : undefined,
        currentVersion: {
          ...voice.currentVersion!,
          state: state === 'in_review' ? 'in_review' : 'draft',
        },
      } as never);
      const { result } = renderHook(() =>
        useCharacterVoicePrompt({
          ...options,
          writable: state !== 'project_read_only',
        }),
      );
      await waitFor(() => expect(result.current.document?.id).toBe('voice'));
      expect(result.current.content).toBe('低沉清晰');
      expect(result.current.writable).toBe(false);
      act(() => result.current.setContent('试图修改'));
      await expect(result.current.save()).rejects.toThrow('不可编辑');
      expect(callWorker).not.toHaveBeenCalledWith('document.draft.save', expect.anything());
    },
  );

  it('ignores a late response for the previously selected character and voice', async () => {
    let finish!: (value: DocumentDetail) => void;
    vi.mocked(callWorker).mockImplementation((_method, params) =>
      (params as { documentId: string }).documentId === 'voice'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ ...voice, id: 'voice-2', title: '第二角色音色' }),
    );
    const { result, rerender } = renderHook((props) => useCharacterVoicePrompt(props), {
      initialProps: options,
    });
    rerender({ ...options, characterId: 'character-2', voiceDocumentId: 'voice-2' });
    await waitFor(() => expect(result.current.document?.id).toBe('voice-2'));
    await act(async () => {
      finish(voice);
      await Promise.resolve();
    });
    expect(result.current.document?.id).toBe('voice-2');
  });

  it('retries a failed read and does not create placeholder documents', async () => {
    vi.mocked(callWorker).mockRejectedValueOnce(new Error('读取失败'));
    const { result } = renderHook(() => useCharacterVoicePrompt(options));
    await waitFor(() => expect(result.current.error).toBe('读取失败'));
    expect(result.current.document).toBeUndefined();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.content).toBe('低沉清晰'));
    expect(result.current.error).toBe('');
    expect(callWorker).not.toHaveBeenCalledWith('document.draft.save', expect.anything());
  });

  it('hides data immediately on a project switch and rejects a foreign project response', async () => {
    selectWorkerScope({ projectId: 'project', projectSessionId: 'one' });
    const { result, rerender } = renderHook(() => useCharacterVoicePrompt(options));
    await waitFor(() => expect(result.current.document?.id).toBe('voice'));
    selectWorkerScope({ projectId: 'other-project', projectSessionId: 'two' });
    rerender();
    expect(result.current.document).toBeUndefined();
    expect(result.current.content).toBe('');
    await waitFor(() => expect(result.current.error).toContain('已不可用'));
  });
});
