import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentGenerationPrepareResult,
  LlmGenerationInfo,
  LlmGenerationCompleteParams,
  LlmGenerationFailParams,
  LlmGenerationObserveParams,
  LlmGenerationPrepareResult,
  LlmNativeStreamEvent,
} from '@ai-video/contracts';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class<T> {
    onmessage?: (event: T) => void;
  },
  invoke: native.invoke,
  isTauri: () => true,
}));

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));

import { callWorker } from './worker-client';
import { TaskConfirmationQueue, type TaskConfirmation } from './task-confirmations';
import { selectWorkerScope } from './worker-scope';
import { coalesceVisibleDelta, streamPreparedLlmGeneration } from './llm-client';

const prepared: LlmGenerationPrepareResult = {
  stream: {
    generationId: 'generation',
    attemptId: 'attempt',
    projectId: 'project',
    projectSessionId: 'project-session',
    conversationId: 'conversation',
  },
  generation: {
    generationId: 'generation',
    attemptId: 'attempt',
    projectId: 'project',
    conversationId: 'conversation',
    snapshotId: 'snapshot',
    status: 'prepared',
    executionMode: 'native',
    providerProfileId: 'profile',
    modelId: 'model',
    userMessage: {
      id: 'user',
      conversationId: 'conversation',
      role: 'user',
      content: 'Prompt',
      status: 'complete',
      createdAt: 'now',
    },
    assistantMessage: {
      id: 'assistant',
      conversationId: 'conversation',
      replyToMessageId: 'user',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: 'now',
    },
    sources: [],
  },
};

const mediaSelection = {
  selectionToken: 'media-selection-token',
  kind: 'video' as const,
  prompt: 'A dragon flying in the sky',
  inputAssetIds: [],
  inputAttachmentCount: 0,
  proposedParameters: {},
  candidates: [],
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const mediaDecision = {
  providerProfileId: 'media-profile',
  modelId: 'media-model',
  adapterKey: 'media-adapter',
  parameters: { prompt: mediaSelection.prompt },
};

function state(status: LlmGenerationInfo['status'], content: string): LlmGenerationInfo {
  return {
    ...prepared.generation,
    status,
    assistantMessage: {
      ...prepared.generation.assistantMessage,
      content,
      status: status === 'complete' ? 'complete' : status === 'failed' ? 'failed' : 'streaming',
    },
  };
}

describe('coalesceVisibleDelta', () => {
  it('keeps true incremental tokens', () => {
    expect(coalesceVisibleDelta('你', '好')).toBe('好');
  });

  it('skips prefix and equal snapshots', () => {
    expect(coalesceVisibleDelta('A\n\n', 'A\n\n')).toBeUndefined();
    expect(coalesceVisibleDelta('A\n\n', 'A\n\nB\n\n')).toBe('B\n\n');
  });

  it('ignores leading-newline replays of already visible text', () => {
    expect(coalesceVisibleDelta('A', '\n\nA')).toBeUndefined();
    expect(coalesceVisibleDelta('A', '\n\nA\n\nB')).toBe('\n\nB');
    expect(coalesceVisibleDelta('A\n\nB', '\n\nB')).toBeUndefined();
  });

  it('does not duplicate glm step text that is replayed after a paragraph break', () => {
    let aggregate = '';
    for (const incoming of [
      '我先了解一下当前项目的文档情况。',
      '\n\n我先了解一下当前项目的文档情况。',
      '\n\n我先查看一下现有文档，确认版本情况，再将 v2 内容更新进去。',
      '\n\n我先查看一下现有文档，确认版本情况，再将 v2 内容更新进去。',
    ]) {
      const fragment = coalesceVisibleDelta(aggregate, incoming);
      if (fragment) aggregate += fragment;
    }
    expect(aggregate).toBe(
      '我先了解一下当前项目的文档情况。\n\n我先查看一下现有文档，确认版本情况，再将 v2 内容更新进去。',
    );
  });

  it('ignores whitespace-only deltas and token replays across tool rounds', () => {
    expect(coalesceVisibleDelta('A', '\n\n')).toBeUndefined();
    expect(coalesceVisibleDelta('', '\n\nA')).toBe('A');
    let aggregate = '';
    let streamVisible = '';
    for (const incoming of ['I will search the library.']) {
      streamVisible += incoming;
      const fragment = coalesceVisibleDelta(aggregate, streamVisible);
      if (fragment) aggregate += fragment;
    }
    streamVisible = '';
    for (const incoming of ['\n\n', 'I', ' will search the library.']) {
      streamVisible += incoming;
      const fragment = coalesceVisibleDelta(aggregate, streamVisible);
      if (fragment) aggregate += fragment;
    }
    expect(aggregate).toBe('I will search the library.');
    streamVisible = '';
    for (const incoming of ['\n\n', 'Search hit 3 results.']) {
      streamVisible += incoming;
      const fragment = coalesceVisibleDelta(aggregate, streamVisible);
      if (fragment) aggregate += fragment;
    }
    expect(aggregate).toBe('I will search the library.\n\nSearch hit 3 results.');
  });
});

describe('streamPreparedLlmGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'llm.generation.observe') {
        const input = params as LlmGenerationObserveParams;
        return Promise.resolve(state('streaming', input.content));
      }
      if (method === 'llm.generation.complete') {
        const input = params as LlmGenerationCompleteParams;
        return Promise.resolve(state('complete', input.content));
      }
      if (method === 'llm.generation.fail') {
        const input = params as LlmGenerationFailParams;
        return Promise.resolve({
          ...state('failed', input.content || input.error),
          error: input.error,
          retryable: input.retryable,
        });
      }
      if (method === 'llm.generation.cancel') {
        return Promise.resolve(state('cancelled', ''));
      }
      if (method === 'agent.generation.cancel') return Promise.resolve({ cancelled: true });
      if (method === 'llm.generation.get')
        return Promise.resolve(state('complete', 'Native draft'));
      throw new Error(`Unexpected Worker method ${method}`);
    });
  });

  it('batches deltas and completes only after the native terminal event', async () => {
    native.invoke.mockImplementation((command, args) => {
      if (command !== 'llm_stream') throw new Error(`Unexpected native command ${command}`);
      const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
        .onEvent;
      channel.onmessage?.({ type: 'started' });
      channel.onmessage?.({ type: 'delta', delta: 'first ' });
      channel.onmessage?.({ type: 'delta', delta: 'second' });
      channel.onmessage?.({
        type: 'complete',
        providerResponseId: 'response',
        finishReason: 'completed',
      });
      return Promise.resolve();
    });
    const deltas: string[] = [];
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(prepared, {
      onDelta: (content) => deltas.push(content),
      onState: (next) => states.push(next),
    });

    await run.completion;

    expect(deltas).toEqual(['first ', 'first second']);
    expect(states.at(-1)).toMatchObject({
      status: 'complete',
      assistantMessage: { content: 'first second' },
    });
    expect(callWorker).toHaveBeenCalledWith(
      'llm.generation.complete',
      expect.objectContaining({ content: 'first second', providerResponseId: 'response' }),
      { projectId: prepared.stream.projectId, projectSessionId: prepared.stream.projectSessionId },
    );
  });

  it('marks a native invocation without a terminal event as failed', async () => {
    native.invoke.mockResolvedValue(undefined);
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(prepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });

    await run.completion;

    expect(states.at(-1)).toMatchObject({
      status: 'failed',
      error: 'Native LLM stream ended without a terminal event.',
    });
  });

  it('waits for a terminal channel event delivered after the native command returns', async () => {
    native.invoke.mockImplementation((_command, args) => {
      const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
        .onEvent;
      setTimeout(() => {
        channel.onmessage?.({ type: 'started' });
        channel.onmessage?.({
          type: 'complete',
          providerResponseId: 'response-delayed',
          finishReason: 'completed',
        });
      }, 0);
      return Promise.resolve();
    });
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(prepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });

    await run.completion;

    expect(states.at(-1)).toMatchObject({ status: 'complete' });
    expect(callWorker).toHaveBeenCalledWith(
      'llm.generation.complete',
      expect.objectContaining({ providerResponseId: 'response-delayed' }),
      { projectId: prepared.stream.projectId, projectSessionId: prepared.stream.projectSessionId },
    );
  });

  it('rejects Agent events on a plain stream without executing business tools', async () => {
    native.invoke.mockImplementation((_command, args) => {
      const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
        .onEvent;
      channel.onmessage?.({
        type: 'toolCalls',
        calls: [{ id: 'call', name: 'document.create_draft', argumentsJson: '{}' }],
      });
      return Promise.resolve();
    });
    const states: LlmGenerationInfo[] = [];
    await streamPreparedLlmGeneration(prepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    }).completion;
    expect(states.at(-1)).toMatchObject({ status: 'failed', retryable: false });
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.some(([method]) => method === 'agent.generation.executeTools'),
    ).toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['pi', 'native-agent', 'desktop', undefined] as const)(
    'routes prepared Agent owner %s to the Worker without opening a native socket',
    async (runtimeOwner) => {
      const agentPrepared: AgentGenerationPrepareResult = {
        ...prepared,
        agentTaskId: 'agent-task',
        runtimeOwner,
        runtimeMode: 'document',
      };
      let polls = 0;
      // eslint-disable-next-line @typescript-eslint/require-await
      vi.mocked(callWorker).mockImplementation(async (method) => {
        if (method === 'conversation.runtime.start') return { runtime: 'pi', taskId: 'agent-task' };
        if (method === 'conversation.runtime.get') return { active: true };
        if (method === 'llm.generation.get') {
          polls += 1;
          return { ...prepared.generation, status: polls > 1 ? 'complete' : 'streaming' };
        }
        return prepared.generation;
      });
      const states: LlmGenerationInfo[] = [];
      const run = streamPreparedLlmGeneration(agentPrepared, {
        onDelta() {},
        onState: (next) => states.push(next),
      });
      await run.completion;
      expect(native.invoke).not.toHaveBeenCalled();
      expect(callWorker).toHaveBeenCalledWith(
        'conversation.runtime.start',
        expect.objectContaining({ taskId: 'agent-task', mode: 'document' }),
        {
          projectId: prepared.stream.projectId,
          projectSessionId: prepared.stream.projectSessionId,
        },
      );
      expect(states.at(-1)?.status).toBe('complete');
    },
  );

  it('returns Pi confirmations through Worker RPC and preserves the prepared runtime mode', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'pi',
      runtimeMode: 'document',
    };
    const confirmation = {
      version: 1 as const,
      confirmationId: 'confirmation',
      confirmationToken: 'pi-confirmation',
      taskId: 'task',
      toolCallId: 'tool-call',
      operation: 'document.archive',
      action: 'document.archive' as const,
      argumentsHash: 'arguments-hash',
      projectSessionId: 'project-session',
      riskLevel: 'R2' as const,
      summary: '归档文档“Draft”',
      affectedEntities: [{ type: 'document', id: 'document', label: 'Draft' }],
      documentId: 'document',
      documentTitle: 'Draft',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    let confirmationPending = true;
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(callWorker).mockImplementation(async (method) => {
      if (method === 'conversation.runtime.start') return { runtime: 'pi', taskId: 'agent-task' };
      if (method === 'conversation.runtime.get') {
        return confirmationPending ? { active: true, confirmation } : { active: true };
      }
      if (method === 'conversation.runtime.confirm') {
        confirmationPending = false;
        return { accepted: true };
      }
      if (method === 'llm.generation.get') return state('complete', 'Archived.');
      return prepared.generation;
    });
    const onConfirmation = vi.fn(() => Promise.resolve(true));

    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState() {},
      onConfirmation,
    });
    await run.completion;

    expect(callWorker).toHaveBeenCalledWith(
      'conversation.runtime.start',
      expect.objectContaining({ taskId: 'agent-task', mode: 'document' }),
      { projectId: prepared.stream.projectId, projectSessionId: prepared.stream.projectSessionId },
    );
    expect(onConfirmation).toHaveBeenCalledWith(confirmation);
    expect(callWorker).toHaveBeenCalledWith(
      'conversation.runtime.confirm',
      {
        generationId: 'generation',
        confirmationToken: 'pi-confirmation',
        approved: true,
      },
      { projectId: prepared.stream.projectId, projectSessionId: prepared.stream.projectSessionId },
    );
  });

  it('returns Pi media selection through its dedicated Worker RPC', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'pi',
    };
    let selectionPending = true;
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(callWorker).mockImplementation(async (method) => {
      if (method === 'conversation.runtime.start') return { runtime: 'pi', taskId: 'agent-task' };
      if (method === 'conversation.runtime.get') {
        return selectionPending ? { active: true, mediaSelection } : { active: true };
      }
      if (method === 'conversation.runtime.selectMedia') {
        selectionPending = false;
        return { accepted: true };
      }
      if (method === 'llm.generation.get') return state('complete', 'Draft ready.');
      return prepared.generation;
    });
    const onMediaSelection = vi.fn(() => Promise.resolve(mediaDecision));

    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState() {},
      onMediaSelection,
    });
    await run.completion;

    expect(onMediaSelection).toHaveBeenCalledWith(mediaSelection);
    expect(callWorker).toHaveBeenCalledWith(
      'conversation.runtime.selectMedia',
      {
        generationId: 'generation',
        selectionToken: mediaSelection.selectionToken,
        selection: mediaDecision,
      },
      { projectId: prepared.stream.projectId, projectSessionId: prepared.stream.projectSessionId },
    );
  });

  it('keeps the Worker-owned Pi runtime running when observation disconnects', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'pi',
    };
    // eslint-disable-next-line @typescript-eslint/require-await
    vi.mocked(callWorker).mockImplementation(async (method) => {
      if (method === 'conversation.runtime.start') return { runtime: 'pi', taskId: 'agent-task' };
      if (method === 'conversation.runtime.get') return { active: true };
      if (method === 'llm.generation.get') throw new Error('Worker response channel closed');
      if (method === 'agent.generation.cancel') return state('cancelled', '');
      if (method === 'llm.generation.fail') {
        return {
          ...prepared.generation,
          status: 'failed',
          error: 'Worker response channel closed',
          retryable: true,
        };
      }
      return prepared.generation;
    });
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });
    await expect(run.completion).rejects.toThrow('Worker response channel closed');
    expect(native.invoke).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.some(
          ([method]) => method === 'agent.generation.cancel' || method === 'llm.generation.fail',
        ),
    ).toBe(false);
    expect(states).toEqual([]);
  });
});

it('observes two projects concurrently and cancels only the selected identity while another confirmation waits', async () => {
  const snapshots = new Map<string, string>();
  let cards: TaskConfirmation[] = [];
  const queue = new TaskConfirmationQueue((items) => {
    cards = items;
  });
  const starts: string[] = [];
  const decisions = new Set<string>();
  vi.mocked(callWorker).mockImplementation(((
    method: string,
    params: { generationId?: string; projectId?: string },
    scope?: { projectId: string; projectSessionId: string },
  ) => {
    const id = params.generationId!;
    if (method === 'conversation.runtime.start') {
      starts.push(id);
      snapshots.set(id, 'streaming');
      return Promise.resolve({ runtime: 'pi' });
    }
    if (method === 'conversation.runtime.get')
      return Promise.resolve({
        active: true,
        ...(!decisions.has(id)
          ? { confirmation: { confirmationToken: id, expiresAt: '2099-01-01', summary: id } }
          : {}),
      });
    if (method === 'conversation.runtime.confirm') {
      decisions.add(id);
      snapshots.set(id, 'complete');
      return Promise.resolve({ accepted: true });
    }
    if (method === 'agent.generation.cancel' || method === 'llm.generation.cancel')
      snapshots.set(id, 'cancelled');
    expect(scope?.projectId).toBe(id);
    return Promise.resolve({ ...prepared.generation, generationId: id, status: snapshots.get(id) });
  }) as typeof callWorker);
  const create = (id: string) =>
    streamPreparedLlmGeneration(
      {
        ...prepared,
        agentTaskId: id,
        runtimeOwner: 'pi',
        stream: {
          ...prepared.stream,
          projectId: id,
          generationId: id,
          projectSessionId: id + '-epoch',
        },
      } as LlmGenerationPrepareResult,
      {
        onDelta() {},
        onState() {},
        onConfirmation: (request) => queue.request(id, id, 'tool', request),
      },
    );
  const a = create('A'),
    b = create('B');
  selectWorkerScope({ projectId: 'unrelated', projectSessionId: 'unrelated' });
  await vi.waitFor(() => expect(cards).toHaveLength(2));
  expect(starts.sort()).toEqual(['A', 'B']);
  await a.cancel();
  queue.removeOwner('A');
  expect(cards[0]?.owner).toBe('B');
  expect(snapshots.get('B')).toBe('streaming');
  queue.decide(cards[0]!.key, true);
  await Promise.all([a.completion, b.completion]);
  expect(snapshots.get('B')).toBe('complete');
  expect(
    vi
      .mocked(callWorker)
      .mock.calls.filter(([method]) => method === 'agent.generation.cancel')
      .map(([, params]) => (params as { generationId: string }).generationId),
  ).toEqual(['A']);
  selectWorkerScope(undefined);
});
