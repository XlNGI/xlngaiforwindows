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
import {
  appendAssistantText,
  PiConversationRuntime,
  type AssistantTextAccumulator,
} from './pi-conversation-runtime.js';
import { AgentTaskContinuationRequired } from './agent-provider-tool-gateway.js';
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
    advanceTextTurn: undefined as AgentProviderToolExecutor['advanceTextTurn'],
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
    if (_input.operation === 'library.search' || _input.operation === 'library.read') {
      return undefined;
    }
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
  it('continues an unfinished task in the same generation and preserves the continuation input', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage('I saved the first page; the task is not done.', {
        responseId: 'unfinished-page-one',
      }),
      fauxAssistantMessage('All requested pages are complete.', {
        responseId: 'finished-all-pages',
      }),
    ]);
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [providerDefinition('scene.structure.stage', 'stage')],
      })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const providerTools = fakeProviderExecutor();
    const advanceTextTurn = vi.fn<NonNullable<AgentProviderToolExecutor['advanceTextTurn']>>(() => [
      providerDefinition('scene.structure.stage', 'stage-next'),
    ]);
    providerTools.advanceTextTurn = advanceTextTurn;
    providerTools.completeProviderStep
      .mockImplementationOnce(() => {
        throw new AgentTaskContinuationRequired(
          'Resume the saved stage and finish every remaining page.',
        );
      })
      .mockImplementationOnce(() => undefined);
    const systemPrompts: string[] = [];
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: new FakePlanService() as never,
      providerTools,
      streamFn: (model, context, options) => {
        systemPrompts.push(context.systemPrompt ?? '');
        return faux.streamSimple(model, context, options);
      },
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...identity,
      identity,
      taskId: 'task',
      mode: 'document',
      prompt: 'Create a large scene plan',
    });
    await runtime.wait(identity.generationId);

    expect(faux.state.callCount).toBe(2);
    expect(systemPrompts).toHaveLength(2);
    for (const systemPrompt of systemPrompts) {
      expect(systemPrompt).toContain('内部续执行及修复指令不改变语言');
      expect(systemPrompt).toContain('真实用户明确指定的输出语言优先');
    }
    expect(advanceTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: 'supplement' }),
    );
    const continuations = generation.configureAgentTools.mock.calls.map(
      ([, , continuation]) => continuation as LlmGenerationRuntimeRequest['continuation'],
    );
    expect(
      continuations.some(
        (continuation) =>
          continuation?.protocol === 'openai-responses' &&
          continuation.userMessages?.includes(
            'Resume the saved stage and finish every remaining page.',
          ),
      ),
    ).toBe(true);
    expect(generation.complete).toHaveBeenCalledTimes(1);
    expect(generation.failNative).not.toHaveBeenCalled();
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'preserves reference images in the Native continuation and Chat history (%s)',
    async (protocol) => {
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              'tools.load',
              { names: ['shot.continuity.read', 'shot.continuity.save'] },
              { id: 'load-continuity' },
            ),
          ],
          { stopReason: 'toolUse', responseId: 'load-response' },
        ),
        fauxAssistantMessage(
          [fauxToolCall('shot.continuity.read', { shotId: 'shot' }, { id: 'frames' })],
          { stopReason: 'toolUse', responseId: 'frame-response' },
        ),
        fauxAssistantMessage(
          [fauxToolCall('shot.continuity.save', { shotId: 'shot' }, { id: 'save' })],
          { stopReason: 'toolUse', responseId: 'save-response' },
        ),
        fauxAssistantMessage('已保存参考图图片提示词。', { responseId: 'done' }),
      ]);
      const tools = [
        providerDefinition('shot.continuity.read', 'read'),
        providerDefinition('shot.continuity.save', 'save'),
      ];
      const generation = {
        runtime: vi.fn(() => ({ ...runtimeRequest, protocol, tools })),
        configureAgentTools: vi.fn(),
        observe: vi.fn(),
        complete: vi.fn(),
        failNative: vi.fn(),
        cancel: vi.fn(),
        get: vi.fn(),
      };
      const providerTools = fakeProviderExecutor();
      providerTools.executeTools.mockImplementation(async (params) => {
        const frame = params.calls[0]!.name === 'shot.continuity.read';
        return {
          tools,
          continuation: {
            protocol: 'openai-responses',
            previousResponseId: params.providerResponseId,
            outputs: [
              {
                callId: params.calls[0]!.id,
                output: frame
                  ? '{"visualInputs":[{"assetId":"frame"}]}'
                  : '{"status":"shot_reference_prompt_saved"}',
                ...(frame ? { images: [{ mimeType: 'image/jpeg', data: '/9j/pixels' }] } : {}),
              },
            ],
          },
        };
      });
      const runtime = new PiConversationRuntime({
        generation: generation as never,
        plans: new FakePlanService() as never,
        providerTools,
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('No planning');
        },
      });
      await runtime.start({
        ...identity,
        identity,
        taskId: 'task',
        mode: 'document',
        prompt: '协助生成中间画面参考图',
      });
      await runtime.wait(identity.generationId);
      expect(generation.failNative).not.toHaveBeenCalled();
      const continuations = generation.configureAgentTools.mock.calls.map(
        ([, , continuation]) => continuation as LlmGenerationRuntimeRequest['continuation'],
      );
      expect(
        continuations.some((continuation) =>
          continuation?.outputs.some((output) => output.images?.[0]?.data === '/9j/pixels'),
        ),
      ).toBe(true);
      if (protocol === 'openai-chat-completions')
        expect(
          continuations.some(
            (continuation) =>
              continuation?.protocol === protocol &&
              continuation.history?.some((turn) =>
                turn.outputs.some((output) => output.images?.[0]?.data === '/9j/pixels'),
              ),
          ),
        ).toBe(true);
    },
  );

  it('stops a repeated incomplete response when the Agent makes no tool progress', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage('Still working.', { responseId: 'stalled-one' }),
      fauxAssistantMessage(
        [fauxToolCall('library.read', { sourceId: 'already-read' }, { id: 'read-again' })],
        { stopReason: 'toolUse', responseId: 'stalled-read' },
      ),
      fauxAssistantMessage('Still working.', { responseId: 'stalled-two' }),
    ]);
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        tools: [providerDefinition('library.read', 'read')],
      })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const providerTools = fakeProviderExecutor();
    providerTools.advanceTextTurn = vi.fn<
      NonNullable<AgentProviderToolExecutor['advanceTextTurn']>
    >(() => [providerDefinition('library.read', 'read-next')]);
    vi.mocked(providerTools.executeTools).mockResolvedValue({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'stalled-read',
        outputs: [{ callId: 'read-again', output: '{"status":"read"}' }],
      },
      tools: [providerDefinition('library.read', 'read-next')],
    });
    providerTools.completeProviderStep.mockImplementation(() => {
      throw new AgentTaskContinuationRequired('The task still has unfinished stages.');
    });
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: new FakePlanService() as never,
      providerTools,
      streamFn: faux.streamSimple,
      createGateway: () => {
        throw new Error('No planning');
      },
    });
    await runtime.start({
      ...identity,
      identity,
      taskId: 'task',
      mode: 'document',
      prompt: 'Create a large scene plan',
    });
    await runtime.wait(identity.generationId);

    expect(faux.state.callCount).toBe(3);
    expect(providerTools.executeTools).toHaveBeenCalledTimes(1);
    expect(generation.complete).not.toHaveBeenCalled();
    expect(generation.failNative).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('AGENT_TASK_CONTINUATION_STALLED'),
      }),
    );
  });

  it.each([true, false])(
    'continues beyond the former request cap; final stop=%s',
    async (finalStop) => {
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        ...Array.from({ length: finalStop ? 23 : 24 }, (_, index) =>
          fauxAssistantMessage(
            [fauxToolCall('tools.load', { names: ['library.read'] }, { id: `load-${index}` })],
            { stopReason: 'toolUse', responseId: `response-${index}` },
          ),
        ),
        fauxAssistantMessage('Finished at the boundary.'),
      ]);
      const generation = {
        runtime: vi.fn(() => ({
          ...runtimeRequest,
          tools: [providerDefinition('library.read', 'read')],
        })),
        configureAgentTools: vi.fn(),
        observe: vi.fn(),
        complete: vi.fn(),
        failNative: vi.fn(),
        cancel: vi.fn(),
        get: vi.fn(),
      };
      const turns: number[] = [];
      const runtime = new PiConversationRuntime({
        generation: generation as never,
        plans: new FakePlanService() as never,
        providerTools: fakeProviderExecutor(),
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('No planning');
        },
        onEvent: (event) => {
          if (event.type === 'turn_started') turns.push(event.turn);
        },
      });
      await runtime.start({
        ...identity,
        identity,
        taskId: 'task',
        mode: 'document',
        prompt: 'Continue',
      });
      await runtime.wait(identity.generationId);
      const expectedRequests = finalStop ? 24 : 25;
      expect(faux.state.callCount).toBe(expectedRequests);
      expect(turns).toEqual(Array.from({ length: expectedRequests }, (_, i) => i + 1));
      expect(generation.complete).toHaveBeenCalledTimes(1);
      expect(generation.failNative).not.toHaveBeenCalled();
    },
  );

  it('runs the short-drama plan and all four deliverables before waiting_review', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task.plan.submit', {}, { id: 'plan' })], {
        stopReason: 'toolUse',
        responseId: 'response-plan',
      }),
      fauxAssistantMessage([fauxToolCall('novel.episode.submit_draft', {}, { id: 'outline' })], {
        stopReason: 'toolUse',
        responseId: 'response-outline',
      }),
      fauxAssistantMessage([fauxToolCall('document.create_draft', {}, { id: 'character' })], {
        stopReason: 'toolUse',
        responseId: 'response-character',
      }),
      fauxAssistantMessage([fauxToolCall('document.create_draft', {}, { id: 'scene' })], {
        stopReason: 'toolUse',
        responseId: 'response-scene',
      }),
      fauxAssistantMessage(
        [fauxToolCall('novel.episode.submit_structure', {}, { id: 'structure' })],
        { stopReason: 'toolUse', responseId: 'response-structure' },
      ),
      fauxAssistantMessage([fauxToolCall('novel.episode.submit_structure', {}, { id: 'shots' })], {
        stopReason: 'toolUse',
        responseId: 'response-shots',
      }),
      fauxAssistantMessage([fauxToolCall('task.package.complete', {}, { id: 'complete' })], {
        stopReason: 'toolUse',
        responseId: 'response-complete',
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
    expect(systemPrompt).not.toContain('[FROZEN PROJECT CONTEXT]');
    expect(systemPrompt).not.toContain('selected chapter context');
    expect(systemPrompt).toContain('面向用户的可见进展说明');
    expect(systemPrompt).toContain('已完成 / 依据 / 未完成项 / 下一步');
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
    expect(systemPrompt).toContain('用户使用中文时使用简体中文');
    expect(systemPrompt).toContain('除非用户明确要求翻译或输出英文');
  });

  it('publishes visible text while the Provider is still streaming', async () => {
    const faux = createFauxCore({
      api: 'pi-test',
      provider: 'pi-test',
      tokensPerSecond: 20,
      tokenSize: { min: 1, max: 1 },
    });
    const reply = '正在检查项目资料并确认下一步。';
    faux.setResponses([
      fauxAssistantMessage([
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: reply },
      ]),
    ]);
    const plans = new FakePlanService();
    const providerTools = fakeProviderExecutor();
    const generation = {
      runtime: vi.fn(() => ({ ...runtimeRequest, tools: [] })),
      configureAgentTools: vi.fn(),
      observe: vi.fn<(params: { content: string }) => void>(),
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
      prompt: '请检查项目资料',
    });
    await vi.waitFor(() => expect(generation.observe).toHaveBeenCalled());
    expect(generation.observe.mock.calls[0]![0].content.length).toBeLessThan(reply.length);
    expect(generation.complete).not.toHaveBeenCalled();
    await runtime.wait(identity.generationId);
    expect(generation.observe.mock.calls.at(-1)?.[0].content).toBe(reply);
    expect(
      generation.observe.mock.calls.every(([params]) => !params.content.includes('private')),
    ).toBe(true);
    expect(generation.complete).toHaveBeenCalledWith(expect.objectContaining({ content: reply }));
  });

  it('lets the model pick image and video tools in document mode without a forced plan', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [
          { type: 'text', text: '我先准备图片，再根据结果制作视频。' },
          fauxToolCall(
            'tools.load',
            { names: ['media.image.prepare', 'media.video.prepare'] },
            { id: 'load' },
          ),
        ],
        { stopReason: 'toolUse', responseId: 'load-response' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('media.image.prepare', { prompt: 'Dragon' }, { id: 'image-call' })],
        { stopReason: 'toolUse', responseId: 'response-image' },
      ),
      fauxAssistantMessage(
        [
          { type: 'text', text: '图片草稿已准备好，接着制作视频。' },
          fauxToolCall(
            'media.video.prepare',
            { prompt: 'Animate the dragon' },
            { id: 'video-call' },
          ),
        ],
        { stopReason: 'toolUse', responseId: 'response-video' },
      ),
      fauxAssistantMessage('图片和视频草稿均已准备完成。'),
    ]);
    const plans = new FakePlanService();
    const planOnlyRound = vi.spyOn(plans, 'planOnlyRound');
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
      observe: vi.fn<(params: { content: string }) => void>(),
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

    expect(planOnlyRound).not.toHaveBeenCalled();
    expect(plans.generic).toBe(false);
    expect(generation.failNative.mock.calls).toEqual([]);
    expect(
      vi.mocked(providerTools.executeTools).mock.calls.map(([params]) => params.calls[0]?.name),
    ).toEqual(['media.image.prepare', 'media.video.prepare']);
    expect(providerTools.startProviderStep).toHaveBeenCalled();
    expect(generation.observe.mock.calls[0]?.[0].content).toBe(
      '我先准备图片，再根据结果制作视频。',
    );
    const middle = '我先准备图片，再根据结果制作视频。\n\n图片草稿已准备好，接着制作视频。';
    const middleIndex = generation.observe.mock.calls.findIndex(
      ([params]) => params.content === middle,
    );
    expect(middleIndex).toBeGreaterThan(0);
    expect(generation.observe.mock.invocationCallOrder[0]).toBeLessThan(
      providerTools.executeTools.mock.invocationCallOrder[0]!,
    );
    expect(generation.observe.mock.invocationCallOrder[middleIndex]).toBeGreaterThan(
      providerTools.executeTools.mock.invocationCallOrder[0]!,
    );
    expect(generation.observe.mock.invocationCallOrder[middleIndex]).toBeLessThan(
      providerTools.executeTools.mock.invocationCallOrder[1]!,
    );
    expect(generation.observe.mock.calls.at(-1)?.[0].content).toBe(
      `${middle}\n\n图片和视频草稿均已准备完成。`,
    );
    expect(generation.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        content: `${middle}\n\n图片和视频草稿均已准备完成。`,
      }),
    );
  });

  it('lets the model retrieve and execute sequential operations without a semantic planning gate', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    const plannedCall = (name: string, id: string, args = {}) =>
      fauxAssistantMessage([fauxToolCall(name, args, { id })], {
        stopReason: 'toolUse',
        responseId: `response-${id}`,
      });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'tools.load',
            { names: ['document.create_draft', 'media.image.prepare', 'media.video.prepare'] },
            { id: 'load' },
          ),
        ],
        { stopReason: 'toolUse', responseId: 'load-response' },
      ),
      plannedCall('library.search', 'search', { query: '第一章', sourceTypes: ['novel-chapter'] }),
      plannedCall('library.read', 'read', { sourceHandle: 'chapter-source' }),
      plannedCall('media.image.prepare', 'image'),
      plannedCall('library.read', 'read-more', { sourceHandle: 'chapter-source' }),
      plannedCall('media.video.prepare', 'video'),
      fauxAssistantMessage('图片和视频草稿已准备。'),
    ]);
    const plans = new FakePlanService();
    const beginStep = vi.spyOn(plans, 'beginStep');
    const recordStepSuccess = vi.spyOn(plans, 'recordStepSuccess');
    const providerTools = fakeProviderExecutor();
    const definitions = [
      providerDefinition('library.search', 'search-handle'),
      providerDefinition('library.read', 'read-handle'),
      providerDefinition('document.create_draft', 'draft-handle'),
      providerDefinition('media.image.prepare', 'image-handle'),
      providerDefinition('media.video.prepare', 'video-handle'),
    ];
    vi.mocked(providerTools.executeTools).mockImplementation((params) =>
      Promise.resolve({
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: params.providerResponseId,
          outputs: params.calls.map((call) => ({
            callId: call.id,
            output: JSON.stringify({
              status:
                call.name === 'library.search'
                  ? 'searched'
                  : call.name === 'library.read'
                    ? 'read'
                    : 'prepared',
            }),
          })),
        },
        tools: definitions,
      }),
    );
    const libraryPolicy = 'Decide how to search the project library; preserve draft labels.';
    const generation = {
      runtime: vi.fn(() => ({
        ...runtimeRequest,
        systemInstruction: libraryPolicy,
        tools: definitions,
      })),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
    };
    const systemPrompts: string[] = [];
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: plans as never,
      providerTools,
      streamFn: (model, context, options) => {
        systemPrompts.push(context.systemPrompt ?? '');
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
      prompt: '根据小说第一章生成一张龙的图片，再把它生成视频',
    });
    await runtime.wait(identity.generationId);

    expect(generation.failNative).not.toHaveBeenCalled();
    expect(systemPrompts[0]).toContain(libraryPolicy);
    expect(systemPrompts[0]).toContain('A saved draft may still have readiness issues');
    expect(systemPrompts[0]).not.toContain('directory receives entities only after user approval');
    expect(systemPrompts[0]).not.toContain('plan only');
    expect(systemPrompts.length).toBeGreaterThan(1);
    for (const systemPrompt of systemPrompts) {
      expect(systemPrompt.trimEnd()).toMatch(
        /# 本轮可见回复语言\n[\s\S]*真实用户明确指定的输出语言优先[\s\S]*不输出私有推演。$/,
      );
      expect(systemPrompt).toContain('内部续执行、工具修复和恢复消息不属于真实用户消息');
    }
    expect(plans.completed).toBe(false);
    expect(providerTools.executeTools.mock.calls.map(([params]) => params.calls[0]?.id)).toEqual([
      'search',
      'read',
      'image',
      'read-more',
      'video',
    ]);
    expect(beginStep).not.toHaveBeenCalled();
    expect(recordStepSuccess).not.toHaveBeenCalled();
    const configured = (
      generation.configureAgentTools.mock.calls as unknown as Array<[unknown, LlmToolDefinition[]]>
    ).map(([, tools]) => tools.map((tool) => tool.name));
    expect(configured[0]).toEqual(['library.search', 'library.read', 'tools.load']);
    expect(configured[1]).toEqual(expect.arrayContaining(definitions.map((tool) => tool.name)));
    expect(generation.complete).toHaveBeenCalled();
  });

  it.each(['multiple writes', 'mixed read/write', 'loader with write'])(
    'blocks the entire %s response and permits a corrected next response',
    async (kind) => {
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      const second =
        kind === 'multiple writes'
          ? 'document.create_draft'
          : kind === 'mixed read/write'
            ? 'library.search'
            : 'tools.load';
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('tools.load', { names: ['document.create_draft'] }, { id: 'load' })],
          { stopReason: 'toolUse', responseId: 'load-response' },
        ),
        fauxAssistantMessage(
          [
            fauxToolCall('document.create_draft', { title: 'Blocked' }, { id: 'blocked-write' }),
            fauxToolCall(second, { title: 'Blocked' }, { id: 'blocked-other' }),
          ],
          { stopReason: 'toolUse', responseId: 'blocked-response' },
        ),
        fauxAssistantMessage(
          [fauxToolCall('document.create_draft', { title: 'Corrected' }, { id: 'corrected' })],
          { stopReason: 'toolUse', responseId: 'corrected-response' },
        ),
        fauxAssistantMessage('Saved.'),
      ]);
      const providerTools = fakeProviderExecutor();
      const definitions = [providerDefinition('document.create_draft', 'handle')];
      providerTools.executeTools.mockImplementation(async (params) => ({
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: params.providerResponseId,
          outputs: params.calls.map((call) => ({ callId: call.id, output: '{"status":"saved"}' })),
        },
        tools: definitions,
      }));
      const generation = {
        runtime: vi.fn(() => ({ ...runtimeRequest, tools: definitions })),
        configureAgentTools: vi.fn(),
        observe: vi.fn(),
        complete: vi.fn(),
        failNative: vi.fn(),
        cancel: vi.fn(),
        get: vi.fn(),
      };
      const contexts: string[] = [];
      const runtime = new PiConversationRuntime({
        generation: generation as never,
        providerTools,
        plans: new FakePlanService() as never,
        createGateway: () => fakeGateway(new FakePlanService()),
        streamFn: (model, context, options) => {
          contexts.push(JSON.stringify(context.messages));
          return faux.streamSimple(model, context, options);
        },
      });
      await runtime.start({
        taskId: 'task',
        ...identity,
        identity,
        mode: 'document',
        prompt: 'Save.',
      });
      await runtime.wait(identity.generationId);
      expect(generation.failNative).not.toHaveBeenCalled();
      expect(providerTools.executeTools.mock.calls.map(([params]) => params.calls[0]?.id)).toEqual([
        'corrected',
      ]);
      expect(contexts.some((context) => context.includes('No calls were executed'))).toBe(true);
      expect(generation.complete).toHaveBeenCalledOnce();
    },
  );

  it('executes a document tool and refreshes Worker authorizations for the next Pi turn', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['document.create_draft'] }, { id: 'load' })],
        { stopReason: 'toolUse', responseId: 'load-response' },
      ),
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
    expect(providerTools.startProviderStep).toHaveBeenCalledTimes(3);
    expect(generation.configureAgentTools).toHaveBeenCalledWith(
      identity,
      [expect.objectContaining({ name: 'tools.load' })],
      expect.objectContaining({ protocol: 'openai-responses' }),
      [expect.objectContaining({ name: 'tools.load' })],
    );
    expect(generation.complete).toHaveBeenCalledOnce();
  });

  it('refreshes research tools across multiple Pi turns', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['research.search'] }, { id: 'load' })],
        { stopReason: 'toolUse', responseId: 'load-response' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('research.search', { query: 'source' }, { id: 'search-call' })],
        { stopReason: 'toolUse', responseId: 'response-search' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['research.fetch'] }, { id: 'load-fetch' })],
        { stopReason: 'toolUse', responseId: 'load-fetch-response' },
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
    expect(providerTools.startProviderStep).toHaveBeenCalledTimes(5);
    expect(generation.complete).toHaveBeenCalledOnce();
  });

  it('exposes a pending Worker confirmation and resumes Pi only with the matching token', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['document.archive'] }, { id: 'load' })],
        { stopReason: 'toolUse', responseId: 'load-response' },
      ),
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

    expect(runtime.get(identity.generationId)).toMatchObject({ active: false });
    expect(providerTools.confirmTool).toHaveBeenCalledWith({
      ...identity,
      confirmationToken: confirmation.confirmationToken,
      approved: true,
    });
    expect(generation.complete).toHaveBeenCalledOnce();
    expect(generation.failNative).not.toHaveBeenCalled();
    expect(generation.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'I will archive the draft.\n\nThe archive request was approved.',
      }),
    );
  });

  it('exposes a pending media selection and resumes the same Pi task with the matching token', async () => {
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('tools.load', { names: ['media.video.prepare'] }, { id: 'load' })],
        { stopReason: 'toolUse', responseId: 'load-response' },
      ),
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
    vi.mocked(providerTools.selectMedia).mockResolvedValue({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-video',
        outputs: [{ callId: 'video-call', output: '{"status":"polling","taskId":"media-job"}' }],
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

describe('appendAssistantText', () => {
  it('does not duplicate a completed turn when responseId arrives after streaming', () => {
    const accumulator: AssistantTextAccumulator = { aggregate: '', segment: '' };
    appendAssistantText(accumulator, fauxAssistantMessage('I will search the library.'));
    appendAssistantText(
      accumulator,
      fauxAssistantMessage('I will search the library.', { responseId: 'resp-1' }),
    );
    expect(accumulator.aggregate).toBe('I will search the library.');
    expect(accumulator.responseId).toBe('resp-1');
  });

  it('keeps later tool-round text without replaying the previous paragraph', () => {
    const accumulator: AssistantTextAccumulator = { aggregate: '', segment: '' };
    appendAssistantText(accumulator, fauxAssistantMessage('I will search the library.'));
    appendAssistantText(
      accumulator,
      fauxAssistantMessage('I will search the library.', { responseId: 'resp-1' }),
    );
    appendAssistantText(
      accumulator,
      fauxAssistantMessage('\n\nI will search the library.', { responseId: 'resp-1' }),
    );
    appendAssistantText(accumulator, fauxAssistantMessage('Search hit 3 results.'));
    appendAssistantText(
      accumulator,
      fauxAssistantMessage('Search hit 3 results.', { responseId: 'resp-2' }),
    );
    expect(accumulator.aggregate).toBe('I will search the library.\n\nSearch hit 3 results.');
  });
});
