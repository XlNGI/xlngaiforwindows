import type {
  ConversationRuntime,
  ConversationRuntimeStartRequest,
  ConversationRuntimeStartResult,
} from './conversation-runtime.js';
import type {
  AgentToolConfirmationRequest,
  LlmGenerationCompleteParams,
  LlmGenerationIdentity,
  LlmGenerationRuntimeRequest,
  LlmToolDefinition,
  LlmToolCall,
  LlmToolContinuation,
  NormalizedLlmUsage,
} from '@ai-video/contracts';
import { Agent, type AgentContext, type StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import { createPiStreamFunction, NativeProviderBridge } from './native-provider-bridge.js';
import { DomainToolGateway, type PiToolIdentity } from './domain-tool-gateway.js';
import type { GenerationService } from './generation-service.js';
import { TaskPlanService } from './task-plan-service.js';
import {
  AgentProviderToolGateway,
  type AgentProviderToolExecutor,
} from './agent-provider-tool-gateway.js';

export interface PiConversationRuntimeOptions {
  generation: Pick<
    GenerationService,
    'runtime' | 'configureAgentTools' | 'observe' | 'complete' | 'failNative' | 'cancel' | 'get'
  >;
  plans: TaskPlanService;
  /** Production uses the NativeProviderBridge; tests may inject a faux Pi stream. */
  bridge?: NativeProviderBridge;
  streamFn?: StreamFn;
  createGateway: (identity: PiToolIdentity) => DomainToolGateway;
  providerTools?: AgentProviderToolExecutor;
  maxTurns?: number;
  onEvent?: (event: PiRuntimeEvent) => void;
}

export type PiRuntimeEvent =
  | { type: 'started'; taskId: string }
  | { type: 'turn_started'; taskId: string; turn: number }
  | { type: 'tool_succeeded'; taskId: string; toolName: string }
  | { type: 'waiting_review'; taskId: string }
  | { type: 'failed'; taskId: string; message: string };

type ActiveRun = {
  identity: LlmGenerationIdentity;
  taskId: string;
  agent: Agent;
  completion: Promise<void>;
  cancelled: boolean;
};

type PendingConfirmation = {
  request: AgentToolConfirmationRequest;
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const MAX_FROZEN_CONTEXT_CHARACTERS = 400_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Worker-owned Pi runtime. Pi owns only the in-memory loop; project data,
 * tool authorization and task completeness remain in the existing services.
 */
export class PiConversationRuntime implements ConversationRuntime {
  readonly kind = 'pi' as const;
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly maxTurns: number;

  constructor(private readonly options: PiConversationRuntimeOptions) {
    this.maxTurns = options.maxTurns ?? 24;
  }

  async start(request: ConversationRuntimeStartRequest): Promise<ConversationRuntimeStartResult> {
    const identity = request.identity;
    const prompt = request.prompt?.trim();
    if (!identity || !prompt) {
      throw new Error('Pi runtime requires a generation identity and prompt.');
    }
    if (
      identity.projectId !== request.projectId ||
      identity.projectSessionId !== request.projectSessionId
    ) {
      throw new Error('Pi runtime identity does not match the requested project session.');
    }
    const existing = this.active.get(identity.generationId);
    if (existing) return Promise.resolve({ runtime: 'pi', taskId: existing.taskId });

    const runtime = this.options.generation.runtime(identity);
    const model = modelFromRuntime(runtime);
    const gatewayIdentity = {
      taskId: request.taskId,
      generationId: identity.generationId,
      attemptId: identity.attemptId,
      projectId: request.projectId,
      projectSessionId: request.projectSessionId,
      conversationId: request.conversationId,
    };
    const plannedWorkflow = request.mode === 'short-drama';
    const gateway = plannedWorkflow ? this.options.createGateway(gatewayIdentity) : undefined;
    const planning = plannedWorkflow
      ? this.options.plans.planOnlyRound(request.taskId, prompt)
      : undefined;
    const planningGrants = planning?.tools ?? [];
    const providerGateway = !plannedWorkflow
      ? this.createProviderGateway(identity, runtime.tools ?? [])
      : undefined;
    const initialDefinitions = plannedWorkflow
      ? planningGrants.map((grant) => grant.tool)
      : providerGateway!.currentDefinitions();
    this.options.generation.configureAgentTools(identity, initialDefinitions);

    let planningRound = plannedWorkflow;
    let turnCount = 0;
    let aggregate = '';
    let lastResponseId: string | undefined;
    let lastUsage: NormalizedLlmUsage | undefined;
    const streamFn = this.options.streamFn ?? this.createNativeStream(identity);
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: withFrozenContext(
          planning?.systemInstruction ?? unifiedAgentInstruction(runtime.systemInstruction),
          runtime.context,
        ),
        model,
        thinkingLevel: 'off',
        tools: plannedWorkflow ? gateway!.tools(planningGrants) : providerGateway!.tools(),
      },
      toolExecution: plannedWorkflow ? 'parallel' : 'sequential',
      // eslint-disable-next-line @typescript-eslint/require-await
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        if (planningRound && toolCall.name !== 'task.plan.submit') {
          return { block: true, reason: 'Only task.plan.submit is available during planning.' };
        }
        if (providerGateway) {
          providerGateway.captureProviderCall(
            toolCall.id,
            assistantMessage.responseId,
            usageFromPi(assistantMessage),
          );
        }
        return undefined;
      },
      prepareNextTurnWithContext: ({ message, toolResults, context }) => {
        turnCount += 1;
        this.options.onEvent?.({ type: 'turn_started', taskId: request.taskId, turn: turnCount });
        if (turnCount > this.maxTurns) {
          throw new Error(`Pi runtime exceeded the ${this.maxTurns}-turn limit.`);
        }
        if (message.role === 'assistant') {
          lastResponseId = message.responseId;
          lastUsage = usageFromPi(message);
          const text = assistantText(message);
          if (text.length > aggregate.length) {
            aggregate = text;
            this.options.generation.observe({ ...identity, content: aggregate });
          }
        }
        const plan = plannedWorkflow ? this.options.plans.getByTask(request.taskId) : undefined;
        if (plan?.status === 'active') planningRound = false;
        const grants = plannedWorkflow
          ? planningRound
            ? planningGrants
            : this.options.plans.availableToolGrants(request.taskId)
          : [];
        const definitions = plannedWorkflow
          ? grants.map((grant) => grant.tool)
          : providerGateway!.currentDefinitions();
        const continuation = buildContinuation(
          runtimeProtocol(this.options.generation.runtime(identity)),
          message,
          toolResults,
        );
        this.options.generation.configureAgentTools(identity, definitions, continuation);
        if (providerGateway && toolResults.length > 0) providerGateway.startProviderStep();
        return {
          context: {
            ...context,
            tools: plannedWorkflow ? gateway!.tools(grants) : providerGateway!.tools(),
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      afterToolCall: async ({ toolCall, isError }) => {
        if (!isError)
          this.options.onEvent?.({
            type: 'tool_succeeded',
            taskId: request.taskId,
            toolName: toolCall.name,
          });
        return undefined;
      },
    });

    if (providerGateway) providerGateway.startProviderStep();

    const completion = this.run(
      agent,
      identity,
      request.taskId,
      prompt,
      () => ({ aggregate, lastResponseId, lastUsage }),
      () => this.active.get(identity.generationId)?.cancelled === true,
      plannedWorkflow,
      providerGateway,
    );
    this.active.set(identity.generationId, {
      identity,
      taskId: request.taskId,
      agent,
      completion,
      cancelled: false,
    });
    this.options.onEvent?.({ type: 'started', taskId: request.taskId });
    void completion.finally(() => {
      this.active.delete(identity.generationId);
      this.resolvePendingConfirmation(identity.generationId, false);
    });
    return Promise.resolve({ runtime: 'pi', taskId: request.taskId });
  }

  cancel(generationId: string): boolean {
    const active = this.active.get(generationId);
    if (!active) return false;
    active.cancelled = true;
    this.resolvePendingConfirmation(generationId, false);
    // GenerationService transitions native generations synchronously before
    // returning its Promise. Mark SQLite cancelled before aborting Pi so the
    // aborted assistant message cannot win the race and persist as a failure.
    void this.options.generation.cancel(generationId).catch(() => undefined);
    active.agent.abort();
    return true;
  }

  async wait(generationId: string): Promise<void> {
    await this.active.get(generationId)?.completion;
  }

  /** Reattach callers after a Desktop restart without creating a second Agent loop. */
  hasActive(generationId: string): boolean {
    return this.active.has(generationId);
  }

  get(generationId: string): { active: boolean; confirmation?: AgentToolConfirmationRequest } {
    return {
      active: this.active.has(generationId),
      confirmation: this.pendingConfirmations.get(generationId)?.request,
    };
  }

  confirm(generationId: string, confirmationToken: string, approved: boolean): boolean {
    const pending = this.pendingConfirmations.get(generationId);
    if (!pending || pending.request.confirmationToken !== confirmationToken) return false;
    clearTimeout(pending.timeout);
    this.pendingConfirmations.delete(generationId);
    pending.resolve(approved);
    return true;
  }

  private createProviderGateway(
    identity: LlmGenerationIdentity,
    tools: LlmToolDefinition[],
  ): AgentProviderToolGateway {
    if (!this.options.providerTools) {
      throw new Error('Pi runtime requires the Worker Agent tool executor for this workflow.');
    }
    return new AgentProviderToolGateway(this.options.providerTools, identity, tools, (request) =>
      this.requestConfirmation(identity.generationId, request),
    );
  }

  private requestConfirmation(
    generationId: string,
    request: AgentToolConfirmationRequest,
  ): Promise<boolean> {
    if (this.pendingConfirmations.has(generationId)) {
      return Promise.reject(new Error('Pi runtime already has a pending confirmation.'));
    }
    return new Promise<boolean>((resolve, reject) => {
      const expiresIn = Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(0, Date.parse(request.expiresAt) - Date.now()),
      );
      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(generationId);
        reject(new Error('Agent confirmation expired before the user responded.'));
      }, expiresIn);
      this.pendingConfirmations.set(generationId, { request, resolve, timeout });
    });
  }

  private resolvePendingConfirmation(generationId: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(generationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingConfirmations.delete(generationId);
    pending.resolve(approved);
  }

  private createNativeStream(identity: LlmGenerationIdentity): StreamFn {
    if (!this.options.bridge) throw new Error('Pi runtime requires a NativeProviderBridge.');
    return createPiStreamFunction(this.options.bridge, () => {
      const runtime = this.options.generation.runtime(identity);
      return nativeParams(runtime);
    });
  }

  private async run(
    agent: Agent,
    identity: LlmGenerationIdentity,
    taskId: string,
    prompt: string,
    snapshot: () => { aggregate: string; lastResponseId?: string; lastUsage?: NormalizedLlmUsage },
    isCancelled: () => boolean,
    plannedWorkflow: boolean,
    providerGateway?: AgentProviderToolGateway,
  ): Promise<void> {
    let latest = '';
    agent.subscribe((event) => {
      if (event.type !== 'message_update' && event.type !== 'message_end') return;
      if (event.message.role !== 'assistant') return;
      const text = assistantText(event.message);
      if (text.length > latest.length) {
        latest = text;
        this.options.generation.observe({ ...identity, content: text });
      }
    });
    try {
      await agent.prompt(prompt);
      if (isCancelled()) return;
      const state = agent.state;
      const final = snapshot();
      const plan = plannedWorkflow ? this.options.plans.getByTask(taskId) : undefined;
      if (state.errorMessage) {
        providerGateway?.terminate('failed');
        this.options.generation.failNative({
          ...identity,
          content: final.aggregate || latest,
          error: state.errorMessage,
          retryable: true,
        });
        this.options.onEvent?.({ type: 'failed', taskId, message: state.errorMessage });
        return;
      }
      const completed: LlmGenerationCompleteParams = {
        ...identity,
        content: final.aggregate || latest,
        providerResponseId: final.lastResponseId,
        finishReason: plan?.status === 'succeeded' ? 'task_package_complete' : 'stop',
        usage: final.lastUsage,
      };
      providerGateway?.completeProviderStep(
        final.lastResponseId,
        completed.finishReason,
        final.lastUsage,
      );
      this.options.generation.complete(completed);
      if (plan?.status === 'succeeded') this.options.onEvent?.({ type: 'waiting_review', taskId });
    } catch (error) {
      if (isCancelled()) return;
      const message = error instanceof Error ? error.message : String(error);
      providerGateway?.terminate('failed');
      this.options.generation.failNative({
        ...identity,
        content: latest,
        error: message,
        retryable: true,
      });
      this.options.onEvent?.({ type: 'failed', taskId, message });
    }
  }
}

function unifiedAgentInstruction(base: string): string {
  return `${base}\n\nYou are the unified project Agent. Understand the user's natural-language goal yourself. Answer directly when no business operation is needed, and call only the Worker-authorized tools when an operation is needed. Capability hints are non-authoritative. Never claim that an image, video, document, or system change was completed unless the corresponding tool result confirms it.`;
}

function withFrozenContext(instruction: string, context: string): string {
  const bounded = context.slice(0, MAX_FROZEN_CONTEXT_CHARACTERS);
  return bounded ? `${instruction}\n\n[FROZEN PROJECT CONTEXT]\n${bounded}` : instruction;
}

function modelFromRuntime(runtime: LlmGenerationRuntimeRequest): Model<string> {
  return {
    id: runtime.modelId,
    name: runtime.remoteModelId,
    api: runtime.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions',
    provider: 'ai-video-native',
    baseUrl: runtime.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function nativeParams(runtime: LlmGenerationRuntimeRequest) {
  return {
    ...runtime,
    tools: runtime.tools?.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  };
}

function assistantText(message: {
  role: string;
  content: Array<{ type: string; text?: string }>;
}): string {
  return message.role === 'assistant'
    ? message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
    : '';
}

function usageFromPi(message: AssistantMessage): NormalizedLlmUsage | undefined {
  if (!message.usage) return undefined;
  return {
    inputTokens: message.usage.input,
    cachedInputTokens: message.usage.cacheRead,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
  };
}

function runtimeProtocol(runtime: LlmGenerationRuntimeRequest): LlmToolContinuation['protocol'] {
  return runtime.protocol;
}

function buildContinuation(
  protocol: LlmToolContinuation['protocol'],
  message: AgentContext['messages'][number],
  results: ToolResultMessage[],
): LlmToolContinuation | undefined {
  if (message.role !== 'assistant' || !message.responseId || results.length === 0) return undefined;
  const calls = message.content
    .filter(
      (item): item is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> =>
        item.type === 'toolCall',
    )
    .map((call): LlmToolCall => ({
      id: call.id,
      name: call.name,
      argumentsJson: JSON.stringify(call.arguments),
    }));
  const outputs = results.map((result) => ({
    callId: result.toolCallId,
    output: result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .slice(0, 100_000),
  }));
  if (protocol === 'openai-responses') {
    return { protocol, previousResponseId: message.responseId, outputs };
  }
  return { protocol, providerResponseId: message.responseId, calls, outputs };
}
