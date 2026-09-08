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
      parameters: {
        type: 'object',
        additionalProperties: name === 'task.plan.submit',
        properties: {},
      },
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
    selectMedia: vi.fn<AgentProviderToolExecutor['selectMedia']>(),
    startProviderStep: vi.fn<AgentProviderToolExecutor['startProviderStep']>(),
    completeProviderStep: vi.fn<AgentProviderToolExecutor['completeProviderStep']>(),
    terminateGeneration: vi.fn<AgentProviderToolExecutor['terminateGeneration']>(() => 1),
  } satisfies AgentProviderToolExecutor;
}

class FakePlanService {
  phase = 0;
  completed = false;
  generic = false;
  failures: string[] = [];
  planOnlyRound(_taskId?: string, _prompt?: string, mode?: string) {
    this.generic = mode !== undefined && mode !== 'short-drama';
    return { systemInstruction: 'plan only', tools: [grant('task.plan.submit')] };
  }
  submitPlanOnly() {
    this.phase = 1;
    return {};
  }
  getByTask(): ConversationTaskPlanInfo | undefined {
    if (this.phase === 0) return undefined;
    return { status: this.completed ? 'succeeded' : 'active' } as ConversationTaskPlanInfo;
  }
  availableToolGrants(): ConversationTaskToolGrant[] {
    if (this.completed) return [];
    if (this.generic) return [grant('task.package.complete')];
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
  availableOperations(): string[] {
    if (!this.generic) return [];
    if (this.phase === 1) return ['media.image.prepare'];
    if (this.phase === 2) return ['media.video.prepare'];
    return [];
  }
  beginStep(_input: { taskId: string; operation: string }) {
    return `step-${this.phase}`;
  }
  recordStepSuccess() {
    this.phase += 1;
    return true;
  }
  recordStepFailure(input: { operation: string }) {
    this.failures.push(input.operation);
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

  it('enforces an image-to-video generic dependency plan before Worker tool execution', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'task.plan.submit',
            { version: 2, steps: [], constraints: [] },
            { id: 'plan' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('media.image.prepare', { prompt: 'Dragon' }, { id: 'image-call' })],
        { stopReason: 'toolUse', responseId: 'response-image' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'media.video.prepare',
            { prompt: 'Animate the dragon' },
            { id: 'video-call' },
          ),
        ],
        { stopReason: 'toolUse', responseId: 'response-video' },
      ),
      fauxAssistantMessage([fauxToolCall('task.package.complete', {}, { id: 'complete' })], {
        stopReason: 'toolUse',
      }),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
    vi.mocked(providerTools.executeTools).mockImplementation((params) =>
      Promise.resolve({
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: params.providerResponseId,
          outputs: params.calls.map((call) => ({
            callId: call.id,
            output: JSON.stringify({ status: 'prepared', operation: call.name }),
          })),
        },
        tools: [
          providerDefinition('media.image.prepare', 'image-next'),
          providerDefinition('media.video.prepare', 'video-next'),
        ],
      }),
    );
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [
          providerDefinition('media.image.prepare', 'image-initial'),
          providerDefinition('media.video.prepare', 'video-initial'),
        ],
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
      prompt: '生成一张龙的图片，再把它生成视频',
    });
    await runtime.wait(identity.generationId);

    expect(plans.generic).toBe(true);
    expect(generation.failNative.mock.calls).toEqual([]);
    expect(plans.completed).toBe(true);
    const configuredCalls = generation.configureAgentTools.mock.calls as unknown as Array<
      [unknown, LlmToolDefinition[]]
    >;
    expect(configuredCalls.map((call) => call[1].map((tool) => tool.name))).toEqual([
      ['task.plan.submit'],
      ['media.image.prepare', 'task.package.complete'],
      ['media.video.prepare', 'task.package.complete'],
      ['task.package.complete'],
      [],
    ]);
    expect(
      vi.mocked(providerTools.executeTools).mock.calls.map(([params]) => params.calls[0]?.name),
    ).toEqual(['media.image.prepare', 'media.video.prepare']);
    expect(providerTools.startProviderStep).toHaveBeenCalledTimes(2);
    expect(configuredCalls[0]?.[1].map((tool) => tool.name)).toEqual(['task.plan.submit']);
    expect(generation.complete).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: 'task_package_complete' }),
    );
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
      fauxAssistantMessage(
        [
          { type: 'text', text: 'I will archive the draft.' },
          fauxToolCall('document.archive', {}, { id: 'archive-call' }),
        ],
        { stopReason: 'toolUse', responseId: 'response-archive' },
      ),
      fauxAssistantMessage('The archive request was approved.'),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
    const confirmation = {
      version: 1 as const,
      confirmationId: 'confirmation',
      confirmationToken: 'confirmation-token',
      taskId: 'task',
      toolCallId: 'tool-call',
      operation: 'document.archive',
      action: 'document.archive' as const,
      argumentsHash: 'arguments-hash',
      projectSessionId: identity.projectSessionId,
      riskLevel: 'R2' as const,
      summary: '归档文档“Draft”',
      affectedEntities: [{ type: 'document', id: 'document', label: 'Draft' }],
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
    expect(generation.failNative).not.toHaveBeenCalled();
    expect(generation.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('I will archive the draft.'),
      }),
    );
  });

  it('exposes a pending media selection and resumes the same Pi task with the matching token', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'media.video.prepare',
            { prompt: 'A dragon flying in the sky' },
            { id: 'video-call' },
          ),
        ],
        { stopReason: 'toolUse', responseId: 'response-video' },
      ),
      fauxAssistantMessage('The local video draft is ready for cost confirmation.'),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
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
    const decision = {
      providerProfileId: 'media-profile',
      modelId: 'media-model',
      adapterKey: 'media-adapter',
      parameters: { prompt: mediaSelection.prompt },
    };
    vi.mocked(providerTools.executeTools).mockResolvedValue({ mediaSelection });
    vi.mocked(providerTools.selectMedia).mockReturnValue({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-video',
        outputs: [{ callId: 'video-call', output: '{"status":"prepared"}' }],
      },
      tools: [],
    });
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [providerDefinition('media.video.prepare', 'media-authorization')],
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
      prompt: '帮我生成龙在天空翱翔的视频',
    });
    await vi.waitFor(() =>
      expect(runtime.get(identity.generationId).mediaSelection).toEqual(mediaSelection),
    );

    expect(runtime.selectMedia(identity.generationId, 'wrong-token', decision)).toBe(false);
    expect(
      runtime.selectMedia(identity.generationId, mediaSelection.selectionToken, decision),
    ).toBe(true);
    await runtime.wait(identity.generationId);

    expect(providerTools.selectMedia).toHaveBeenCalledWith({
      ...identity,
      selectionToken: mediaSelection.selectionToken,
      selection: decision,
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
