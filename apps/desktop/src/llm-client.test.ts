import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
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
import { streamPreparedLlmGeneration } from './llm-client';

const prepared: LlmGenerationPrepareResult = {
  stream: {
    generationId: 'generation',
    attemptId: 'attempt',
    projectId: 'project',
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
});
