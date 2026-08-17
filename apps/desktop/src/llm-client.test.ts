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
import { streamPreparedLlmGeneration } from './llm-client';

let requiresConfirmation = false;

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
    requiresConfirmation = false;
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
      if (method === 'agent.generation.executeTools') {
        if (requiresConfirmation) {
          return Promise.resolve({
            confirmation: {
              confirmationToken: 'one-time-token',
              action: 'document.archive' as const,
              documentId: 'document',
              documentTitle: 'Draft',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          });
        }
        return Promise.resolve({
          continuation: {
            previousResponseId: 'response-tool',
            outputs: [{ callId: 'call-1', output: '{"status":"draft_created"}' }],
          },
        });
      }
      if (method === 'agent.generation.confirmTool') {
        return Promise.resolve({
          continuation: {
            previousResponseId: 'response-tool',
            outputs: [{ callId: 'call-1', output: '{"status":"archived"}' }],
          },
        });
      }
      if (method === 'agent.providerStep.complete') return Promise.resolve({});
      if (method === 'agent.providerStep.start') return Promise.resolve({});
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

  it('executes Agent tool calls and starts a continuation stream before completing', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
    };
    native.invoke
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        channel.onmessage?.({ type: 'started' });
        channel.onmessage?.({
          type: 'toolCalls',
          providerResponseId: 'response-tool',
          calls: [
            {
              id: 'call-1',
              name: 'document.create_draft',
              argumentsJson: '{"title":"Draft","contentMarkdown":"# Draft"}',
              authorizationHandle: 'native-only-handle',
            },
          ],
        });
        return Promise.resolve();
      })
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        channel.onmessage?.({ type: 'started' });
        channel.onmessage?.({ type: 'delta', delta: 'Draft created.' });
        channel.onmessage?.({
          type: 'complete',
          providerResponseId: 'response-final',
          finishReason: 'completed',
        });
        return Promise.resolve();
      });

    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });
    await run.completion;

    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(callWorker).toHaveBeenCalledWith(
      'agent.generation.executeTools',
      expect.objectContaining({ providerResponseId: 'response-tool' }),
    );
    expect(callWorker).toHaveBeenCalledWith(
      'agent.providerStep.complete',
      expect.objectContaining({ providerResponseId: 'response-final' }),
    );
    expect(states.at(-1)).toMatchObject({ status: 'complete' });
  });

  it('confirms a high-impact Agent tool locally before continuing the same Provider loop', async () => {
    requiresConfirmation = true;
    const agentPrepared: AgentGenerationPrepareResult = { ...prepared, agentTaskId: 'agent-task' };
    native.invoke
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        channel.onmessage?.({ type: 'started' });
        channel.onmessage?.({
          type: 'toolCalls',
          providerResponseId: 'response-tool',
          calls: [
            {
              id: 'call-1',
              name: 'document.archive',
              argumentsJson: '{}',
              authorizationHandle: 'native-only-handle',
            },
          ],
        });
        return Promise.resolve();
      })
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        channel.onmessage?.({ type: 'started' });
        channel.onmessage?.({
          type: 'complete',
          providerResponseId: 'response-final',
          finishReason: 'completed',
        });
        return Promise.resolve();
      });

    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState() {},
      onConfirmation: (request) => {
        expect(request.action).toBe('document.archive');
        return Promise.resolve(true);
      },
    });
    await run.completion;

    expect(callWorker).toHaveBeenCalledWith(
      'agent.generation.confirmTool',
      expect.objectContaining({ confirmationToken: 'one-time-token', approved: true }),
    );
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
});
