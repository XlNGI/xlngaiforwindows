/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, createFauxCore } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  ConversationTaskPlanInfo,
  ConversationTaskToolGrant,
  LlmGenerationRuntimeRequest,
  LlmToolDefinition,
} from '@ai-video/contracts';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import type { AgentProviderToolExecutor } from './agent-provider-tool-gateway.js';
import type { DomainToolGateway, PiToolIdentity } from './domain-tool-gateway.js';

const identity = {
  generationId: 'generation',
  attemptId: 'attempt',
  projectId: 'project',
  projectSessionId: 'session',
  conversationId: 'conversation',
} as const;

const runtimeRequest: LlmGenerationRuntimeRequest = {
  ...identity,
  providerProfileId: 'profile',
  modelId: 'model',
  remoteModelId: 'model',
  protocol: 'openai-responses',
  baseUrl: 'https://example.test',
  systemInstruction: 'short drama system',
  context: 'selected chapter context',
  prompt: 'generate',
};

function grant(name: string, deliverableKind?: string): ConversationTaskToolGrant {
  return {
    ...(deliverableKind
      ? { deliverableId: `${deliverableKind}-id`, deliverableKind: deliverableKind as any }
      : {}),
    tool: {
      name: name as any,
      description: name,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  } as ConversationTaskToolGrant;
}

function providerDefinition(name: string, authorizationHandle: string): LlmToolDefinition {
  return {
    name: name as LlmToolDefinition['name'],
    description: name,
    parameters: { type: 'object', additionalProperties: true, properties: {} },
    authorizationHandle,
  };
}

function fakeProviderExecutor() {
  return {
    executeTools: vi.fn<AgentProviderToolExecutor['executeTools']>(),
    confirmTool: vi.fn<AgentProviderToolExecutor['confirmTool']>(),
    startProviderStep: vi.fn<AgentProviderToolExecutor['startProviderStep']>(),
    completeProviderStep: vi.fn<AgentProviderToolExecutor['completeProviderStep']>(),
    terminateGeneration: vi.fn<AgentProviderToolExecutor['terminateGeneration']>(() => 1),
  } satisfies AgentProviderToolExecutor;
}

class FakePlanService {
  phase = 0;
  completed = false;
  planOnlyRound() {
    return { systemInstruction: 'plan only', tools: [grant('task.plan.submit')] };
  }
  submitPlanOnly() {
    this.phase = 1;
    return {};
  }
  getByTask(): ConversationTaskPlanInfo | undefined {
    return { status: this.completed ? 'succeeded' : 'active' } as ConversationTaskPlanInfo;
  }
  availableToolGrants(): ConversationTaskToolGrant[] {
    if (this.phase === 1) return [grant('novel.episode.submit_draft', 'episode-outline')];
    if (this.phase === 2) return [grant('document.create_draft', 'character-prompts')];
    if (this.phase === 3) return [grant('document.create_draft', 'scene-prompts')];
    if (this.phase === 4) return [grant('novel.episode.submit_structure', 'scene-shot-structure')];
    if (this.phase === 5) return [grant('novel.episode.submit_structure', 'shot-prompts')];
    return [grant('task.package.complete')];
  }
  beginDeliverable() {
    return {} as ConversationTaskPlanInfo;
  }
  recordDeliverableSuccess() {
    this.phase += 1;
    return {
      version: 1,
      status: 'succeeded',
      remainingRequiredDeliverables: [],
      retryable: false,
      summary: 'done',
    } as any;
  }
  completePackage() {
    this.completed = true;
    return { complete: true, taskStatus: 'waiting_review' } as const;
  }
}

function fakeGateway(plans: FakePlanService): DomainToolGateway {
  return {
    tools(grants: ConversationTaskToolGrant[]) {
      return grants.map((item) => ({
        name: item.tool.name,
        label: item.tool.name,
        description: item.tool.description,
        parameters: item.tool.parameters as never,
        executionMode: 'sequential',
        execute: async () => {
          if (item.tool.name === 'task.plan.submit') plans.submitPlanOnly();
          else if (item.tool.name === 'task.package.complete') plans.completePackage();
          else plans.recordDeliverableSuccess();
          return {
            content: [{ type: 'text', text: `ok:${item.tool.name}` }],
            details: {},
            ...(item.tool.name === 'task.package.complete' ? { terminate: true } : {}),
          };
        },
      })) as AgentTool[];
    },
  } as unknown as DomainToolGateway;
}

describe('PiConversationRuntime', () => {
  it('runs the short-drama plan and all four deliverables before waiting_review', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task.plan.submit', {}, { id: 'plan' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('novel.episode.submit_draft', {}, { id: 'outline' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('document.create_draft', {}, { id: 'character' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('document.create_draft', {}, { id: 'scene' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(
        [fauxToolCall('novel.episode.submit_structure', {}, { id: 'structure' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxToolCall('novel.episode.submit_structure', {}, { id: 'shots' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('task.package.complete', {}, { id: 'complete' })], {
        stopReason: 'toolUse',
      }),
    ]);
    const plans = new FakePlanService();
    const observed: string[] = [];
    let systemPrompt = '';
    const generation = {
      runtime: vi.fn(() => runtimeRequest),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      streamFn: (model, context, options) => {
        systemPrompt = context.systemPrompt ?? '';
        return faux.streamSimple(model, context, options);
      },
      createGateway: (_identity: PiToolIdentity) => fakeGateway(plans),
      onEvent: (event) => observed.push(event.type),
    });

    await expect(
      runtime.start({
        taskId: 'task',
        projectId: identity.projectId,
        projectSessionId: identity.projectSessionId,
        conversationId: identity.conversationId,
        mode: 'short-drama',
        identity,
        prompt: 'generate an episode',
      }),
    ).resolves.toMatchObject({ runtime: 'pi', taskId: 'task' });
    await runtime.wait(identity.generationId);

    expect(plans.completed).toBe(true);
    expect(generation.complete).toHaveBeenCalledOnce();
    expect(generation.failNative).not.toHaveBeenCalled();
    expect(observed).toContain('waiting_review');
    expect(faux.state.callCount).toBe(7);
    expect(systemPrompt).toContain('[FROZEN PROJECT CONTEXT]');
    expect(systemPrompt).toContain('selected chapter context');
  });

  it('answers ordinary questions through Pi without entering short-drama planning', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([fauxAssistantMessage('The project currently has one active draft.')]);
    const plans = new FakePlanService();
    const planOnlyRound = vi.spyOn(plans, 'planOnlyRound');
    const providerTools = fakeProviderExecutor();
    const generation = {
      runtime: vi.fn(() => ({ ...runtimeRequest, tools: [] })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    let systemPrompt = '';
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      providerTools,
      streamFn: (model, context, options) => {
        systemPrompt = context.systemPrompt ?? '';
        return faux.streamSimple(model, context, options);
      },
      createGateway: () => fakeGateway(plans),
    });

    await runtime.start({
      taskId: 'task',
      projectId: identity.projectId,
      projectSessionId: identity.projectSessionId,
      conversationId: identity.conversationId,
      mode: 'document',
      identity,
      prompt: 'What is in this project?',
    });
    await runtime.wait(identity.generationId);

    expect(planOnlyRound).not.toHaveBeenCalled();
    expect(providerTools.startProviderStep).toHaveBeenCalledOnce();
    expect(providerTools.completeProviderStep).toHaveBeenCalledOnce();
    expect(providerTools.executeTools).not.toHaveBeenCalled();
    expect(generation.complete).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'The project currently has one active draft.' }),
    );
    expect(systemPrompt).toContain('unified project Agent');
  });

  it('executes a document tool and refreshes Worker authorizations for the next Pi turn', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('document.create_draft', { title: 'Draft' }, { id: 'document-call' })],
        { stopReason: 'toolUse', responseId: 'response-document' },
      ),
      fauxAssistantMessage('The reviewable draft was created.'),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
    vi.mocked(providerTools.executeTools).mockResolvedValue({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-document',
        outputs: [{ callId: 'document-call', output: '{"status":"draft_created"}' }],
      },
      tools: [],
    });
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [providerDefinition('document.create_draft', 'document-authorization')],
      })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      providerTools,
      streamFn: faux.streamSimple,
      createGateway: () => fakeGateway(plans),
    });

    await runtime.start({
      taskId: 'task',
      projectId: identity.projectId,
      projectSessionId: identity.projectSessionId,
      conversationId: identity.conversationId,
      mode: 'document',
      identity,
      prompt: 'Create a draft.',
    });
    await runtime.wait(identity.generationId);

    expect(providerTools.executeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        calls: [
          expect.objectContaining({
            id: 'document-call',
            name: 'document.create_draft',
            authorizationHandle: 'document-authorization',
          }),
        ],
      }),
    );
    expect(providerTools.startProviderStep).toHaveBeenCalledTimes(2);
    expect(generation.configureAgentTools).toHaveBeenCalledWith(
      identity,
      [],
      expect.objectContaining({ protocol: 'openai-responses' }),
    );
    expect(generation.complete).toHaveBeenCalledOnce();
  });

  it('refreshes research tools across multiple Pi turns', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('research.search', { query: 'source' }, { id: 'search-call' })],
        { stopReason: 'toolUse', responseId: 'response-search' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('research.fetch', { sourceHandle: 'source-1' }, { id: 'fetch-call' })],
        { stopReason: 'toolUse', responseId: 'response-fetch' },
      ),
      fauxAssistantMessage('Research complete.'),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
    vi.mocked(providerTools.executeTools).mockImplementation((params) =>
      Promise.resolve({
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: params.providerResponseId,
          outputs: params.calls.map((call) => ({ callId: call.id, output: '{"status":"ok"}' })),
        },
        tools:
          params.calls[0]?.name === 'research.search'
            ? [providerDefinition('research.fetch', 'fetch-authorization')]
            : [],
      }),
    );
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [providerDefinition('research.search', 'search-authorization')],
      })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      providerTools,
      streamFn: faux.streamSimple,
      createGateway: () => fakeGateway(plans),
    });

    await runtime.start({
      taskId: 'task',
      projectId: identity.projectId,
      projectSessionId: identity.projectSessionId,
      conversationId: identity.conversationId,
      mode: 'document',
      identity,
      prompt: 'Research this topic.',
    });
    await runtime.wait(identity.generationId);

    expect(providerTools.executeTools).toHaveBeenCalledTimes(2);
    expect(vi.mocked(providerTools.executeTools).mock.calls[1]![0].calls[0]).toMatchObject({
      id: 'fetch-call',
      name: 'research.fetch',
      authorizationHandle: 'fetch-authorization',
    });
    expect(providerTools.startProviderStep).toHaveBeenCalledTimes(3);
    expect(generation.complete).toHaveBeenCalledOnce();
  });

  it('exposes a pending Worker confirmation and resumes Pi only with the matching token', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('document.archive', {}, { id: 'archive-call' })], {
        stopReason: 'toolUse',
        responseId: 'response-archive',
      }),
      fauxAssistantMessage('The archive request was approved.'),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
    const confirmation = {
      confirmationToken: 'confirmation-token',
      action: 'document.archive' as const,
      documentId: 'document',
      documentTitle: 'Draft',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    vi.mocked(providerTools.executeTools).mockResolvedValue({ confirmation });
    vi.mocked(providerTools.confirmTool).mockReturnValue({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-archive',
        outputs: [{ callId: 'archive-call', output: '{"status":"archived"}' }],
      },
      tools: [],
    });
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [providerDefinition('document.archive', 'archive-authorization')],
      })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      providerTools,
      streamFn: faux.streamSimple,
      createGateway: () => fakeGateway(plans),
    });

    await runtime.start({
      taskId: 'task',
      projectId: identity.projectId,
      projectSessionId: identity.projectSessionId,
      conversationId: identity.conversationId,
      mode: 'document',
      identity,
      prompt: 'Archive the draft.',
    });
    await vi.waitFor(() =>
      expect(runtime.get(identity.generationId).confirmation).toEqual(confirmation),
    );

    expect(runtime.confirm(identity.generationId, 'wrong-token', true)).toBe(false);
    expect(runtime.confirm(identity.generationId, confirmation.confirmationToken, true)).toBe(true);
    await runtime.wait(identity.generationId);

    expect(runtime.get(identity.generationId)).toEqual({ active: false, confirmation: undefined });
    expect(providerTools.confirmTool).toHaveBeenCalledWith({
      ...identity,
      confirmationToken: confirmation.confirmationToken,
      approved: true,
    });
    expect(generation.complete).toHaveBeenCalledOnce();
  });

  it('uses the unified Pi path for novel writing without invoking the short-drama planner', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([fauxAssistantMessage('Chapter analysis complete.')]);
    const plans = new FakePlanService();
    const planOnlyRound = vi.spyOn(plans, 'planOnlyRound');
    const providerTools = fakeProviderExecutor();
    const generation = {
      runtime: vi.fn(() => ({ ...runtimeRequest, tools: [] })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      providerTools,
      streamFn: faux.streamSimple,
      createGateway: () => fakeGateway(plans),
    });

    await runtime.start({
      taskId: 'task',
      projectId: identity.projectId,
      projectSessionId: identity.projectSessionId,
      conversationId: identity.conversationId,
      mode: 'novel-writing',
      identity,
      prompt: 'Analyze this chapter.',
    });
    await runtime.wait(identity.generationId);

    expect(planOnlyRound).not.toHaveBeenCalled();
    expect(generation.complete).toHaveBeenCalledOnce();
  });

  it('rejects mismatched project sessions', async () => {
    const plans = new FakePlanService();
    const generation = { runtime: () => runtimeRequest };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      streamFn: () => {
        throw new Error('not reached');
      },
      createGateway: () => fakeGateway(plans),
    });
    await expect(
      runtime.start({
        taskId: 'task',
        projectId: 'other',
        projectSessionId: 'session',
        conversationId: 'conversation',
        mode: 'short-drama',
        identity,
        prompt: 'x',
      }),
    ).rejects.toThrow('does not match');
  });

  it('persists cancellation before Pi can report its aborted stream as a failure', async () => {
    const faux = createFauxCore({
      api: 'pi-test',
      provider: 'pi-test',
      tokensPerSecond: 10,
      tokenSize: { min: 1, max: 1 },
    });
    faux.setResponses([fauxAssistantMessage('a deliberately slow response')]);
    const plans = new FakePlanService();
    const generation = {
      runtime: vi.fn(() => runtimeRequest),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(() => Promise.resolve({})),
      get: vi.fn(),
    };
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      streamFn: faux.streamSimple,
      createGateway: () => fakeGateway(plans),
    });

    await runtime.start({
      taskId: 'task',
      projectId: identity.projectId,
      projectSessionId: identity.projectSessionId,
      conversationId: identity.conversationId,
      mode: 'short-drama',
      identity,
      prompt: 'generate an episode',
    });
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));

    expect(runtime.cancel(identity.generationId)).toBe(true);
    await runtime.wait(identity.generationId);

    expect(generation.cancel).toHaveBeenCalledWith(identity.generationId);
    expect(generation.failNative).not.toHaveBeenCalled();
    expect(generation.complete).not.toHaveBeenCalled();
  });
});
