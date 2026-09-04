import { describe, expect, it, vi } from 'vitest';
import type {
  AgentGenerationExecuteToolsResult,
  LlmGenerationIdentity,
  LlmToolDefinition,
} from '@ai-video/contracts';
import {
  AgentProviderToolGateway,
  type AgentProviderToolExecutor,
} from './agent-provider-tool-gateway.js';

const identity: LlmGenerationIdentity = {
  generationId: 'generation',
  attemptId: 'attempt',
  projectId: 'project',
  projectSessionId: 'session',
  conversationId: 'conversation',
};

function definition(
  name: LlmToolDefinition['name'] = 'document.create_draft',
  authorizationHandle = 'worker-only-handle',
): LlmToolDefinition {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string' } },
    },
    authorizationHandle,
  };
}

function executor(
  executeResult: AgentGenerationExecuteToolsResult,
  confirmResult: AgentGenerationExecuteToolsResult = executeResult,
  mediaResult: AgentGenerationExecuteToolsResult = executeResult,
) {
  return {
    executeTools: vi.fn<AgentProviderToolExecutor['executeTools']>(() =>
      Promise.resolve(executeResult),
    ),
    confirmTool: vi.fn<AgentProviderToolExecutor['confirmTool']>(() => confirmResult),
    selectMedia: vi.fn<AgentProviderToolExecutor['selectMedia']>(() => mediaResult),
    startProviderStep: vi.fn<AgentProviderToolExecutor['startProviderStep']>(),
    completeProviderStep: vi.fn<AgentProviderToolExecutor['completeProviderStep']>(),
    terminateGeneration: vi.fn<AgentProviderToolExecutor['terminateGeneration']>(() => 1),
  } satisfies AgentProviderToolExecutor;
}

describe('AgentProviderToolGateway', () => {
  it('keeps the authorization handle outside Provider arguments and returns the Worker result', async () => {
    const nextDefinition = definition('research.search', 'next-handle');
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-1',
        outputs: [{ callId: 'call-1', output: '{"status":"draft_created"}' }],
      },
      tools: [nextDefinition],
    });
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition()],
      vi.fn(),
      vi.fn(),
    );

    gateway.captureProviderCall('call-1', 'response-1', {
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
    });
    const result = await gateway.tools()[0]!.execute('call-1', { title: 'Draft' });

    expect(worker.executeTools).toHaveBeenCalledWith({
      ...identity,
      providerResponseId: 'response-1',
      calls: [
        {
          id: 'call-1',
          name: 'document.create_draft',
          argumentsJson: '{"title":"Draft"}',
          authorizationHandle: 'worker-only-handle',
        },
      ],
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    });
    expect(
      JSON.parse(vi.mocked(worker.executeTools).mock.calls[0]![0].calls[0]!.argumentsJson),
    ).toEqual({ title: 'Draft' });
    expect(result.content).toEqual([{ type: 'text', text: '{"status":"draft_created"}' }]);
    expect(gateway.currentDefinitions()).toEqual([nextDefinition]);
  });

  it.each([true, false])(
    'returns an explicit confirmation decision to Worker (%s)',
    async (approved) => {
      const request = {
        confirmationToken: 'confirmation-token',
        action: 'document.archive' as const,
        documentId: 'document',
        documentTitle: 'Draft',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      const worker = executor(
        { confirmation: request },
        {
          continuation: {
            protocol: 'openai-responses',
            previousResponseId: 'response-2',
            outputs: [{ callId: 'call-2', output: JSON.stringify({ approved }) }],
          },
          tools: [],
        },
      );
      const ask = vi.fn(() => Promise.resolve(approved));
      const gateway = new AgentProviderToolGateway(worker, identity, [definition()], ask, vi.fn());

      gateway.captureProviderCall('call-2', 'response-2');
      await expect(gateway.tools()[0]!.execute('call-2', {})).resolves.toMatchObject({
        content: [{ type: 'text', text: JSON.stringify({ approved }) }],
      });
      expect(ask).toHaveBeenCalledWith(request);
      expect(worker.confirmTool).toHaveBeenCalledWith({
        ...identity,
        confirmationToken: request.confirmationToken,
        approved,
      });
    },
  );

  it('returns an explicit media model selection to Worker without changing the Agent model', async () => {
    const request = {
      selectionToken: 'media-selection-token',
      kind: 'video' as const,
      prompt: 'Dragon flying in the sky',
      inputAssetIds: [],
      inputAttachmentCount: 0,
      proposedParameters: {},
      candidates: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const selection = {
      providerProfileId: 'media-profile',
      modelId: 'media-model',
      adapterKey: 'video-adapter',
      parameters: { prompt: request.prompt },
    };
    const worker = executor(
      { mediaSelection: request },
      { mediaSelection: request },
      {
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: 'response-media',
          outputs: [{ callId: 'call-media', output: '{"status":"prepared"}' }],
        },
        tools: [],
      },
    );
    const askMedia = vi.fn(() => Promise.resolve(selection));
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition('media.video.prepare')],
      vi.fn(),
      askMedia,
    );

    gateway.captureProviderCall('call-media', 'response-media');
    await gateway.tools()[0]!.execute('call-media', { prompt: request.prompt });

    expect(askMedia).toHaveBeenCalledWith(request);
    expect(worker.selectMedia).toHaveBeenCalledWith({
      ...identity,
      selectionToken: request.selectionToken,
      selection,
    });
  });

  it('rejects calls without Provider response context before reaching Worker', async () => {
    const worker = executor({});
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition()],
      vi.fn(),
      vi.fn(),
    );

    await expect(gateway.tools()[0]!.execute('missing', {})).rejects.toThrow(
      'missing its Provider response context',
    );
    expect(worker.executeTools).not.toHaveBeenCalled();
  });

  it('forwards provider-step and terminal lifecycle operations', () => {
    const worker = executor({});
    const gateway = new AgentProviderToolGateway(worker, identity, [], vi.fn(), vi.fn());

    gateway.startProviderStep();
    gateway.completeProviderStep('response-final', 'stop', { totalTokens: 9 });
    gateway.terminate('failed');

    expect(worker.startProviderStep).toHaveBeenCalledWith(identity);
    expect(worker.completeProviderStep).toHaveBeenCalledWith({
      ...identity,
      providerResponseId: 'response-final',
      finishReason: 'stop',
      usage: { totalTokens: 9 },
    });
    expect(worker.terminateGeneration).toHaveBeenCalledWith(identity.generationId, 'failed');
  });
});
