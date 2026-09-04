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
      if (method === 'agent.generation.cancel') return Promise.resolve({ cancelled: true });
      if (method === 'llm.generation.get')
        return Promise.resolve(state('complete', 'Native draft'));
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
            protocol: 'openai-responses' as const,
            previousResponseId: 'response-tool',
            outputs: [{ callId: 'call-1', output: '{"status":"draft_created"}' }],
          },
        });
      }
      if (method === 'agent.generation.confirmTool') {
        return Promise.resolve({
          continuation: {
            protocol: 'openai-responses' as const,
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
    );
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
        setTimeout(() => {
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
        }, 0);
        return Promise.resolve();
      })
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        setTimeout(() => {
          channel.onmessage?.({ type: 'started' });
          channel.onmessage?.({ type: 'delta', delta: 'Draft created.' });
          channel.onmessage?.({
            type: 'complete',
            providerResponseId: 'response-final',
            finishReason: 'completed',
          });
        }, 0);
        return Promise.resolve();
      });

    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });
    await run.completion;

    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect((native.invoke.mock.calls[0]?.[1] as { onEvent: unknown }).onEvent).not.toBe(
      (native.invoke.mock.calls[1]?.[1] as { onEvent: unknown }).onEvent,
    );
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

  it('resumes a Native-owned Agent tool loop after explicit media model selection', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
    };
    native.invoke
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        setTimeout(() => {
          channel.onmessage?.({ type: 'started' });
          channel.onmessage?.({
            type: 'toolCalls',
            providerResponseId: 'response-media',
            calls: [
              {
                id: 'media-call',
                name: 'media.video.prepare',
                argumentsJson: JSON.stringify({ prompt: mediaSelection.prompt }),
                authorizationHandle: 'media-authorization',
              },
            ],
          });
        }, 0);
        return Promise.resolve();
      })
      .mockImplementationOnce((_command, args) => {
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        setTimeout(() => {
          channel.onmessage?.({ type: 'started' });
          channel.onmessage?.({ type: 'delta', delta: 'Draft ready.' });
          channel.onmessage?.({ type: 'complete', providerResponseId: 'response-final' });
        }, 0);
        return Promise.resolve();
      });
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'agent.generation.executeTools') return Promise.resolve({ mediaSelection });
      if (method === 'agent.generation.selectMedia') {
        return Promise.resolve({
          continuation: {
            protocol: 'openai-responses',
            previousResponseId: 'response-media',
            outputs: [{ callId: 'media-call', output: '{"status":"prepared"}' }],
          },
        });
      }
      if (method === 'agent.providerStep.start' || method === 'agent.providerStep.complete') {
        return Promise.resolve({});
      }
      if (method === 'llm.generation.complete') {
        const input = params as LlmGenerationCompleteParams;
        return Promise.resolve(state('complete', input.content));
      }
      throw new Error(`Unexpected Worker method ${method}`);
    });
    const onMediaSelection = vi.fn(() => Promise.resolve(mediaDecision));

    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState() {},
      onMediaSelection,
    });
    await run.completion;

    expect(onMediaSelection).toHaveBeenCalledWith(mediaSelection);
    expect(callWorker).toHaveBeenCalledWith('agent.generation.selectMedia', {
      ...prepared.stream,
      selectionToken: mediaSelection.selectionToken,
      selection: mediaDecision,
    });
  });

  it('fails closed after sixteen provider invocations to prevent a tool-call storm', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
    };
    let starts = 0;
    native.invoke.mockImplementation((_command, args) => {
      starts += 1;
      const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
        .onEvent;
      channel.onmessage?.({ type: 'started' });
      channel.onmessage?.({
        type: 'toolCalls',
        providerResponseId: `response-${starts}`,
        calls: [
          {
            id: `call-${starts}`,
            name: 'document.create_draft',
            argumentsJson: '{"title":"Draft","contentMarkdown":"# Draft"}',
            authorizationHandle: 'native-only-handle',
          },
        ],
      });
      return Promise.resolve();
    });
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'agent.generation.executeTools')
        return Promise.resolve({
          continuation: {
            protocol: 'openai-responses',
            previousResponseId: 'response-tool',
            outputs: [{ callId: 'call', output: '{}' }],
          },
        });
      if (method === 'llm.generation.fail')
        return Promise.resolve({ ...state('failed', ''), retryable: true });
      if (method === 'agent.generation.cancel') return Promise.resolve({ cancelled: true });
      return Promise.resolve(prepared.generation);
    });
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });
    await run.completion;
    expect(starts).toBe(16);
    expect(states.at(-1)).toMatchObject({ status: 'failed', retryable: true });
  });

  it('subscribes to a Native-owned Agent runtime without duplicating Worker tool execution', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'native-agent',
    };
    native.invoke.mockImplementation((command, args) => {
      expect(command).toBe('agent_runtime_start');
      const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
        .onEvent;
      setTimeout(() => {
        channel.onmessage?.({ type: 'started' });
        channel.onmessage?.({ type: 'delta', delta: 'Native draft' });
        channel.onmessage?.({ type: 'complete', providerResponseId: 'response-final' });
      }, 0);
      return Promise.resolve();
    });
    const deltas: string[] = [];
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta: (content) => deltas.push(content),
      onState: (next) => states.push(next),
    });
    await run.completion;

    expect(deltas).toEqual(['Native draft']);
    expect(states.at(-1)).toMatchObject({
      status: 'complete',
      assistantMessage: { content: 'Native draft' },
    });
    expect(callWorker).toHaveBeenCalledWith('llm.generation.get', { generationId: 'generation' });
    expect(callWorker).not.toHaveBeenCalledWith('agent.generation.executeTools', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith('agent.providerStep.complete', expect.anything());
  });

  it('persists Native-owned Agent cancellation and settles when its terminal event is lost', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'native-agent',
    };
    native.invoke.mockImplementation((command) => {
      if (command === 'agent_runtime_start') return Promise.resolve();
      if (command === 'agent_runtime_cancel') return Promise.resolve(true);
      throw new Error(`Unexpected native command ${command}`);
    });
    const states: LlmGenerationInfo[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState: (next) => states.push(next),
    });
    await Promise.resolve();

    await run.cancel();
    await run.completion;

    expect(callWorker).toHaveBeenCalledWith('agent.generation.cancel', {
      generationId: 'generation',
    });
    expect(native.invoke).toHaveBeenCalledWith('agent_runtime_cancel', {
      attemptId: 'attempt',
    });
    expect(callWorker).toHaveBeenCalledWith('llm.generation.cancel', {
      generationId: 'generation',
    });
    expect(states.at(-1)?.status).toBe('cancelled');
  });

  it('starts and observes a Worker-owned Pi runtime without opening a native socket', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'pi',
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
    );
    expect(states.at(-1)?.status).toBe('complete');
  });

  it('returns Pi confirmations through Worker RPC and preserves the prepared runtime mode', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'pi',
      runtimeMode: 'novel-writing',
    };
    const confirmation = {
      confirmationToken: 'pi-confirmation',
      action: 'document.archive' as const,
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
      expect.objectContaining({ taskId: 'agent-task', mode: 'novel-writing' }),
    );
    expect(onConfirmation).toHaveBeenCalledWith(confirmation);
    expect(callWorker).toHaveBeenCalledWith('conversation.runtime.confirm', {
      generationId: 'generation',
      confirmationToken: 'pi-confirmation',
      approved: true,
    });
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
    expect(callWorker).toHaveBeenCalledWith('conversation.runtime.selectMedia', {
      generationId: 'generation',
      selectionToken: mediaSelection.selectionToken,
      selection: mediaDecision,
    });
  });

  it('fails and cancels the Worker-owned Pi runtime when observation disconnects', async () => {
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
    await run.completion;
    expect(native.invoke).not.toHaveBeenCalled();
    expect(callWorker).toHaveBeenCalledWith('agent.generation.cancel', {
      generationId: 'generation',
    });
    expect(states.at(-1)?.status).toBe('failed');
  });

  it('returns a Native-owned Agent confirmation to the Native runtime without calling the Worker', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'native-agent',
    };
    native.invoke.mockImplementation((command, args) => {
      if (command === 'agent_runtime_confirm') return Promise.resolve(true);
      expect(command).toBe('agent_runtime_start');
      const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
        .onEvent;
      setTimeout(() => {
        channel.onmessage?.({
          type: 'confirmation',
          confirmation: {
            confirmationToken: 'one-time-token',
            action: 'document.archive',
            documentId: 'document',
            documentTitle: 'Draft',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        });
        channel.onmessage?.({ type: 'complete', providerResponseId: 'response-final' });
      }, 0);
      return Promise.resolve();
    });

    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta() {},
      onState() {},
      onConfirmation: () => Promise.resolve(true),
    });
    await run.completion;

    expect(native.invoke).toHaveBeenCalledWith(
      'agent_runtime_confirm',
      expect.objectContaining({ confirmationToken: 'one-time-token', approved: true }),
    );
    expect(callWorker).not.toHaveBeenCalledWith('agent.generation.confirmTool', expect.anything());
  });

  it('re-subscribes when the Native-owned Agent attempt is already running', async () => {
    const agentPrepared: AgentGenerationPrepareResult = {
      ...prepared,
      agentTaskId: 'agent-task',
      runtimeOwner: 'native-agent',
    };
    native.invoke
      .mockRejectedValueOnce(new Error('The LLM attempt is already streaming.'))
      .mockImplementationOnce((command, args) => {
        expect(command).toBe('agent_runtime_subscribe');
        const channel = (args as { onEvent: { onmessage?: (event: LlmNativeStreamEvent) => void } })
          .onEvent;
        setTimeout(() => {
          channel.onmessage?.({ type: 'started' });
          channel.onmessage?.({ type: 'delta', delta: 'Resumed draft' });
          channel.onmessage?.({ type: 'complete', providerResponseId: 'response-final' });
        }, 0);
        return Promise.resolve(true);
      });
    const deltas: string[] = [];
    const run = streamPreparedLlmGeneration(agentPrepared, {
      onDelta: (content) => deltas.push(content),
      onState() {},
    });
    await run.completion;

    expect(deltas).toEqual(['Resumed draft']);
    expect(native.invoke).toHaveBeenNthCalledWith(
      2,
      'agent_runtime_subscribe',
      expect.objectContaining({ attemptId: 'attempt' }),
    );
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
