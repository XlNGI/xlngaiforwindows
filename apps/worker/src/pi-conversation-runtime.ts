import type {
  ConversationRuntime,
  ConversationRuntimeStartRequest,
  ConversationRuntimeStartResult,
} from './conversation-runtime.js';
import type {
  LlmGenerationCompleteParams,
  LlmGenerationIdentity,
  LlmGenerationRuntimeRequest,
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

const MAX_FROZEN_CONTEXT_CHARACTERS = 400_000;

/**
 * Worker-owned Pi runtime. Pi owns only the in-memory loop; project data,
 * tool authorization and task completeness remain in the existing services.
 */
export class PiConversationRuntime implements ConversationRuntime {
  readonly kind = 'pi' as const;
  private readonly active = new Map<string, ActiveRun>();
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
    if (request.mode !== 'short-drama') {
      throw new Error('Pi runtime is currently enabled only for short-drama tasks.');
    }
    const existing = this.active.get(identity.generationId);
    if (existing) return Promise.resolve({ runtime: 'pi', taskId: existing.taskId });

    const runtime = this.options.generation.runtime(identity);
    const model = modelFromRuntime(runtime);
    const gateway = this.options.createGateway({
      taskId: request.taskId,
      generationId: identity.generationId,
      attemptId: identity.attemptId,
      projectId: request.projectId,
      projectSessionId: request.projectSessionId,
      conversationId: request.conversationId,
    });
    const planning = this.options.plans.planOnlyRound(request.taskId, prompt);
    const planningGrants = planning.tools;
    this.options.generation.configureAgentTools(
      identity,
      planningGrants.map((grant) => grant.tool),
    );

    let planningRound = true;
    let turnCount = 0;
    let aggregate = '';
    let lastResponseId: string | undefined;
    let lastUsage: NormalizedLlmUsage | undefined;
    const streamFn = this.options.streamFn ?? this.createNativeStream(identity);
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: withFrozenContext(planning.systemInstruction, runtime.context),
        model,
        thinkingLevel: 'off',
        tools: gateway.tools(planningGrants),
      },
      toolExecution: 'parallel',
      // eslint-disable-next-line @typescript-eslint/require-await
      beforeToolCall: async ({ toolCall }) => {
        if (planningRound && toolCall.name !== 'task.plan.submit') {
          return { block: true, reason: 'Only task.plan.submit is available during planning.' };
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
        const plan = this.options.plans.getByTask(request.taskId);
        if (plan?.status === 'active') planningRound = false;
        const grants = planningRound
          ? planningGrants
          : this.options.plans.availableToolGrants(request.taskId);
        const definitions = grants.map((grant) => grant.tool);
        const continuation = buildContinuation(
          runtimeProtocol(this.options.generation.runtime(identity)),
          message,
          toolResults,
        );
        this.options.generation.configureAgentTools(identity, definitions, continuation);
        return {
          context: { ...context, tools: gateway.tools(grants) },
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

    const completion = this.run(
      agent,
      identity,
      request.taskId,
      prompt,
      () => ({ aggregate, lastResponseId, lastUsage }),
      () => this.active.get(identity.generationId)?.cancelled === true,
    );
    this.active.set(identity.generationId, {
      identity,
      taskId: request.taskId,
      agent,
      completion,
      cancelled: false,
    });
    this.options.onEvent?.({ type: 'started', taskId: request.taskId });
    void completion.finally(() => this.active.delete(identity.generationId));
    return Promise.resolve({ runtime: 'pi', taskId: request.taskId });
  }

  cancel(generationId: string): boolean {
    const active = this.active.get(generationId);
    if (!active) return false;
    active.cancelled = true;
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
      const plan = this.options.plans.getByTask(taskId);
      if (state.errorMessage) {
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
      this.options.generation.complete(completed);
      if (plan?.status === 'succeeded') this.options.onEvent?.({ type: 'waiting_review', taskId });
    } catch (error) {
      if (isCancelled()) return;
      const message = error instanceof Error ? error.message : String(error);
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
