/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, createFauxCore } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  ConversationTaskPlanInfo,
  ConversationTaskToolGrant,
  LlmGenerationRuntimeRequest,
} from '@ai-video/contracts';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
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

  it('rejects non-short-drama starts and mismatched project sessions', async () => {
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
        projectId: 'project',
        projectSessionId: 'session',
        conversationId: 'conversation',
        mode: 'document',
        identity,
        prompt: 'x',
      }),
    ).rejects.toThrow('short-drama');
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
