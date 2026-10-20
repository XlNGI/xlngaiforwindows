import type {
  ConversationRuntime,
  ConversationRuntimeStartRequest,
  ConversationRuntimeStartResult,
} from './conversation-runtime.js';
import type {
  AgentToolConfirmationRequest,
  ConversationRuntimeGetResult,
  ConversationRuntimeLiveAction,
  LlmGenerationCompleteParams,
  LlmGenerationIdentity,
  LlmGenerationRuntimeRequest,
  LlmToolDefinition,
  LlmToolCall,
  LlmToolContinuation,
  LlmChatToolTurn,
  NormalizedLlmUsage,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
  MediaSubmissionConfirmationRequest,
} from '@ai-video/contracts';
import { Agent, type AgentContext, type StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { createPiStreamFunction, NativeProviderBridge } from './native-provider-bridge.js';
import { DomainToolGateway, type PiToolIdentity } from './domain-tool-gateway.js';
import { ExecutionPool, type ExecutionLease } from './execution-pool.js';
import type { GenerationService } from './generation-service.js';
import { TaskPlanService } from './task-plan-service.js';
import {
  AgentProviderToolGateway,
  type AgentProviderPlanHooks,
  type AgentProviderToolExecutor,
} from './agent-provider-tool-gateway.js';

export interface PiConversationRuntimeOptions {
  capacity?: ExecutionPool;
  generation: Pick<
    GenerationService,
    'runtime' | 'configureAgentTools' | 'observe' | 'complete' | 'failNative' | 'cancel' | 'get'
  > &
    Partial<
      Pick<
        GenerationService,
        'waitUntilReady' | 'supplement' | 'consumeSupplements' | 'recordProviderUsage'
      >
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
  liveActions: ConversationRuntimeLiveAction[];
};

type PendingConfirmation = {
  request: AgentToolConfirmationRequest;
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingMediaSelection = {
  request: MediaModelSelectionRequest;
  resolve: (selection: MediaModelSelectionDecision | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingMediaSubmission = {
  request: MediaSubmissionConfirmationRequest;
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const MAX_FROZEN_CONTEXT_CHARACTERS = 400_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TOOL_OUTPUT_REPAIRS = 2;

type ToolOutputFailure = {
  operation: string;
  argumentBytes: number;
  reason: string;
};

function toolOutputFailure(error: string): ToolOutputFailure | undefined {
  // Only these terminal errors guarantee that none of this response's tools
  // executed. Network interruptions and business failures must not be replayed.
  const invalid = error.match(
    /^INVALID_TOOL_ARGUMENTS: ([a-zA-Z][\w.]{0,127}) returned invalid object JSON \((\d{1,8}) bytes\)/,
  );
  if (invalid && error.includes('No tool was executed.')) {
    const diagnostic = error.match(
      /jsonError=(syntax|eof|data|io|non_object); line=(\d+); column=(\d+)/,
    );
    return {
      operation: invalid[1]!,
      argumentBytes: Number(invalid[2]),
      reason: `INVALID_TOOL_ARGUMENTS${diagnostic ? `; ${diagnostic[0]}` : ''}`,
    };
  }
  const truncated = error.match(
    /^(?:INCOMPLETE_PROVIDER_OUTPUT|INCOMPLETE_TOOL_OUTPUT): finishReason=(length|max_tokens|max_output_tokens)[;.]/,
  );
  if (truncated && /No tool was executed[.;]/.test(error)) {
    return {
      operation: 'model.request',
      argumentBytes: Number(error.match(/(\d{1,8}) argument bytes/)?.[1] ?? 0),
      reason: `INCOMPLETE_TOOL_OUTPUT; finishReason=${truncated[1]}`,
    };
  }
  return undefined;
}

/**
 * Worker-owned Pi runtime. Pi owns only the in-memory loop; project data,
 * tool authorization and task completeness remain in the existing services.
 */
export class PiConversationRuntime implements ConversationRuntime {
  readonly kind = 'pi' as const;
  private readonly active = new Map<string, ActiveRun>();
  private readonly queued = new Map<
    string,
    {
      identity: LlmGenerationIdentity;
      taskId: string;
      controller: AbortController;
      completion: Promise<void>;
    }
  >();
  private readonly capacity: ExecutionPool;
  private readonly executionLeases = new Map<string, ExecutionLease>();
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly pendingMediaSelections = new Map<string, PendingMediaSelection>();
  private readonly pendingMediaSubmissions = new Map<string, PendingMediaSubmission>();
  private readonly maxTurns: number;

  constructor(private readonly options: PiConversationRuntimeOptions) {
    this.maxTurns = options.maxTurns ?? 24;
    this.capacity = options.capacity ?? new ExecutionPool();
  }

  async start(request: ConversationRuntimeStartRequest): Promise<ConversationRuntimeStartResult> {
    await Promise.resolve();
    const identity = request.identity;
    if (!identity || !request.prompt?.trim())
      throw new Error('Pi runtime requires a generation identity and prompt.');
    if (
      identity.projectId !== request.projectId ||
      identity.projectSessionId !== request.projectSessionId ||
      identity.conversationId !== request.conversationId
    )
      throw new Error('Pi runtime identity does not match the requested project session.');
    const existing = this.queued.get(identity.generationId);
    // Validate the trusted identity before registering any queued observation.
    this.options.generation.runtime(identity);
    if (existing) return { runtime: 'pi', taskId: existing.taskId };
    const controller = new AbortController();
    const schedulingId = randomUUID();
    this.options.providerTools?.recordProviderRequest?.(
      identity,
      schedulingId,
      'dependency_wait',
      {},
    );
    const completion = Promise.resolve().then(async () => {
      try {
        await this.options.generation.waitUntilReady?.(identity, controller.signal);
        this.options.providerTools?.recordProviderRequest?.(
          identity,
          schedulingId,
          'capacity_wait',
          {},
        );
        await this.capacity.run('text', request.projectId, controller.signal, async (lease) => {
          this.options.providerTools?.recordProviderRequest?.(
            identity,
            schedulingId,
            'complete',
            {},
          );
          this.executionLeases.set(identity.generationId, lease);
          try {
            await this.startAdmitted(request);
            await this.active.get(identity.generationId)?.completion;
          } finally {
            if (this.executionLeases.get(identity.generationId) === lease)
              this.executionLeases.delete(identity.generationId);
          }
        });
      } catch (error) {
        this.options.providerTools?.recordProviderRequest?.(
          identity,
          schedulingId,
          controller.signal.aborted ? 'cancelled' : 'failed',
          {},
        );
        const current = this.options.generation.get(identity.generationId);
        if (['prepared', 'streaming'].includes(current.status)) {
          this.options.providerTools?.terminateGeneration(
            identity.generationId,
            'failed',
            error instanceof Error ? error.message : 'Queued task interrupted.',
          );
          this.options.generation.failNative({
            ...identity,
            content: current.assistantMessage.content,
            error: error instanceof Error ? error.message : 'Queued task was interrupted.',
            retryable: true,
          });
        }
      } finally {
        this.queued.delete(identity.generationId);
      }
    });
    this.queued.set(identity.generationId, {
      identity,
      taskId: request.taskId,
      controller,
      completion,
    });
    return { runtime: 'pi', taskId: request.taskId };
  }

  private async startAdmitted(
    request: ConversationRuntimeStartRequest,
  ): Promise<ConversationRuntimeStartResult> {
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
    // Short-drama still freezes a plan first. Ordinary document sessions
    // authorize tools and let the model choose; prompt regex is not a router.
    const shortDramaWorkflow = request.mode === 'short-drama';
    const plannedWorkflow = shortDramaWorkflow;
    const gateway = plannedWorkflow ? this.options.createGateway(gatewayIdentity) : undefined;
    const planning = plannedWorkflow
      ? this.options.plans.planOnlyRound(request.taskId, prompt, request.mode)
      : undefined;
    const planningGrants = planning?.tools ?? [];
    const providerGateway = !shortDramaWorkflow
      ? this.createProviderGateway(identity, runtime.tools ?? [], false, request.taskId)
      : undefined;
    const initialDefinitions = plannedWorkflow
      ? [...planningGrants.map((grant) => grant.tool)]
      : providerGateway!.currentDefinitions();
    // Establish policies for all currently authorized tools before sending the
    // first request. Lazy loading changes schemas, not the frozen policy prefix.
    this.options.generation.configureAgentTools(
      identity,
      initialDefinitions,
      undefined,
      plannedWorkflow ? initialDefinitions : (runtime.tools ?? initialDefinitions),
    );
    const configuredRuntime = this.options.generation.runtime(identity);

    let planningRound = plannedWorkflow;
    let turnCount = 0;
    let aggregate = '';
    const aggregateState = {
      aggregate: '',
      responseId: undefined as string | undefined,
      segment: '',
    };
    let lastResponseId: string | undefined;
    let lastUsage: NormalizedLlmUsage | undefined;
    let outputRecoveryInstruction = '';
    const captureAssistantText = (message: AssistantMessage): string => {
      aggregate = appendAssistantText(aggregateState, message);
      return aggregate;
    };
    const providerStream = this.options.streamFn ?? this.createNativeStream(identity);
    // Pi invokes prepareNextTurn even for the final stop response, and does
    // not invoke it before the first request. Count at the send boundary so
    // initial, loader and output-repair requests share exactly one budget.
    const streamFn: StreamFn = (model, context, options) => {
      this.options.generation.runtime(identity);
      if (turnCount >= this.maxTurns)
        throw new Error(`Pi runtime exceeded the ${this.maxTurns}-turn limit.`);
      this.options.onEvent?.({ type: 'turn_started', taskId: request.taskId, turn: turnCount + 1 });
      this.options.generation.runtime(identity);
      turnCount += 1;
      return providerStream(model, context, options);
    };
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: withFrozenContext(
          planning?.systemInstruction ??
            unifiedAgentInstruction(configuredRuntime.systemInstruction),
          configuredRuntime.context,
        ),
        model,
        thinkingLevel: 'off',
        tools: plannedWorkflow ? [...gateway!.tools(planningGrants)] : providerGateway!.tools(),
      },
      toolExecution: 'parallel',
      // eslint-disable-next-line @typescript-eslint/require-await
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        providerGateway?.freezeProviderResponse(
          assistantMessage.content.filter((item) => item.type === 'toolCall'),
        );
        if (planningRound && toolCall.name !== 'task.plan.submit') {
          return {
            block: true,
            reason:
              'Only task.plan.submit and authorized project retrieval are available during planning.',
          };
        }
        if (providerGateway?.hasDefinition(toolCall.name)) {
          providerGateway.captureProviderCall(
            toolCall.id,
            assistantMessage.responseId,
            usageFromPi(assistantMessage),
          );
        }
        const active = this.active.get(identity.generationId);
        if (active && !active.liveActions.some((item) => item.id === toolCall.id)) {
          active.liveActions.push({
            id: toolCall.id,
            toolName: toolCall.name,
            status: 'running',
          });
        }
        return undefined;
      },
      prepareNextTurnWithContext: ({ message, toolResults, context }) => {
        providerGateway?.assertRepairBudget();
        gateway?.assertRepairBudget();
        providerGateway?.finishProviderResponse();
        const supplements =
          this.options.generation.consumeSupplements?.(identity.generationId) ?? [];
        if (supplements.length && !toolResults.length && message.role === 'assistant')
          providerGateway?.advanceTextTurn(message.responseId, usageFromPi(message));
        for (const supplement of supplements)
          agent.steer({ role: 'user', content: supplement.content, timestamp: Date.now() });
        if (message.role === 'assistant') {
          lastResponseId = message.responseId;
          lastUsage = usageFromPi(message);
          const nextAggregate = captureAssistantText(message);
          this.options.generation.observe({ ...identity, content: nextAggregate });
        }
        const plan = plannedWorkflow ? this.options.plans.getByTask(request.taskId) : undefined;
        if (plan?.status === 'active') planningRound = false;
        const grants = plannedWorkflow
          ? planningRound
            ? planningGrants
            : this.options.plans.availableToolGrants(request.taskId)
          : [];
        const definitions =
          plan?.status === 'succeeded'
            ? []
            : plannedWorkflow && planningRound
              ? [...planningGrants.map((grant) => grant.tool)]
              : shortDramaWorkflow
                ? grants.map((grant) => grant.tool)
                : providerGateway!.currentDefinitions();
        const continuation = buildContinuation(
          runtimeProtocol(this.options.generation.runtime(identity)),
          message,
          toolResults,
          context.messages,
        );
        this.options.generation.configureAgentTools(identity, definitions, continuation);
        if (providerGateway && toolResults.length > 0 && plan?.status !== 'succeeded') {
          providerGateway.startProviderStep();
        }
        return {
          context: {
            ...context,
            systemPrompt: planningRound
              ? context.systemPrompt
              : withFrozenContext(
                  unifiedAgentInstruction(
                    this.options.generation.runtime(identity).systemInstruction,
                  ),
                  this.options.generation.runtime(identity).context,
                ) + outputRecoveryInstruction,
            tools:
              plan?.status === 'succeeded'
                ? []
                : plannedWorkflow && planningRound
                  ? [...gateway!.tools(planningGrants)]
                  : shortDramaWorkflow
                    ? gateway!.tools(grants)
                    : providerGateway!.tools(),
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      afterToolCall: async ({ toolCall, isError }) => {
        const active = this.active.get(identity.generationId);
        const live = active?.liveActions.find((item) => item.id === toolCall.id);
        if (live) live.status = isError ? 'failed' : 'succeeded';
        if (!isError)
          this.options.onEvent?.({
            type: 'tool_succeeded',
            taskId: request.taskId,
            toolName: toolCall.name,
          });
        return undefined;
      },
    });

    if (providerGateway && !plannedWorkflow) {
      providerGateway.startProviderStep();
    }

    const completion = this.run(
      agent,
      identity,
      request.taskId,
      prompt,
      () => ({ aggregate, lastResponseId, lastUsage }),
      () => this.active.get(identity.generationId)?.cancelled === true,
      plannedWorkflow,
      providerGateway,
      (failure) => {
        // runtime() fences cancellation, stale attempts and project switches
        // before changing schemas or issuing another model request.
        const current = this.options.generation.runtime(identity);
        providerGateway?.assertRepairBudget();
        gateway?.assertRepairBudget();
        const staged =
          ['scene.submit_structure', 'scene.structure.stage'].includes(failure.operation) &&
          providerGateway?.preferStagedSceneAuthoring();
        outputRecoveryInstruction =
          `\n\n[TOOL OUTPUT RECOVERY]\nThe last response failed before any tool was executed: ${failure.reason}. ` +
          'Continue the original user request with the same constraints and completed tool results. ' +
          'Retry only unfinished work; never repeat successful writes or invent saved IDs. ' +
          'Return complete JSON objects matching the loaded schemas. Do not repeat prompt text alongside instruction. ' +
          (staged
            ? 'For NEW scene/shot authoring use the loaded scene.structure.stage tool: get resumable stages first, resume the matching stage or begin with a stable executionKey, put_scene, put_shots (one or two shots per call during recovery), get missing ranges, then finalize. Reuse the returned stageId and latest rowVersion. Never restart a saved stage or claim it is saved before finalize returns scene_structure_saved. For EXISTING scene revisions load scene.read and scene.submit_structure, preserve sceneId/CAS and use the update contract; never create a replacement scene. '
            : 'Reduce each submission where the tool supports it, preserving every required field and existing IDs. ') +
          'If saving still fails, say the task is unfinished and distinguish already saved drafts/parts from the failed submission.';
        agent.state.systemPrompt =
          withFrozenContext(
            planningRound
              ? planning!.systemInstruction
              : unifiedAgentInstruction(current.systemInstruction),
            current.context,
          ) + outputRecoveryInstruction;
        const grants = planningRound
          ? planningGrants
          : plannedWorkflow
            ? this.options.plans.availableToolGrants(request.taskId)
            : [];
        const definitions = providerGateway
          ? providerGateway.currentDefinitions()
          : grants.map((grant) => grant.tool);
        agent.state.tools = providerGateway ? providerGateway.tools() : gateway!.tools(grants);
        // Keep the last successful continuation, never the malformed response.
        this.options.generation.configureAgentTools(identity, definitions, current.continuation);
        return staged ? 'scene.structure.stage' : 'model.request';
      },
    );
    this.active.set(identity.generationId, {
      identity,
      taskId: request.taskId,
      agent,
      completion,
      cancelled: false,
      liveActions: [],
    });
    this.options.onEvent?.({ type: 'started', taskId: request.taskId });
    void completion.finally(() => {
      this.active.delete(identity.generationId);
      this.resolvePendingConfirmation(identity.generationId, false);
      this.resolvePendingMediaSelection(identity.generationId, undefined);
      this.resolvePendingMediaSubmission(identity.generationId, false);
    });
    return Promise.resolve({ runtime: 'pi', taskId: request.taskId });
  }

  cancel(generationId: string): boolean {
    const queued = this.queued.get(generationId);
    queued?.controller.abort(new Error('Task cancelled before execution.'));
    const active = this.active.get(generationId);
    if (!active) {
      if (queued) void this.options.generation.cancel(generationId);
      return Boolean(queued);
    }
    active.cancelled = true;
    this.resolvePendingConfirmation(generationId, false);
    this.resolvePendingMediaSelection(generationId, undefined);
    this.resolvePendingMediaSubmission(generationId, false);
    // GenerationService transitions native generations synchronously before
    // returning its Promise. Mark SQLite cancelled before aborting Pi so the
    // aborted assistant message cannot win the race and persist as a failure.
    void this.options.generation.cancel(generationId).catch(() => undefined);
    active.agent.abort();
    return true;
  }

  async wait(generationId: string): Promise<void> {
    await (this.queued.get(generationId)?.completion ?? this.active.get(generationId)?.completion);
  }

  cancelAll(): void {
    for (const generationId of new Set([...this.active.keys(), ...this.queued.keys()]))
      this.cancel(generationId);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.queued.values()].map((run) => run.completion));
  }

  /** Reattach callers after a Desktop restart without creating a second Agent loop. */
  hasActive(generationId: string): boolean {
    return this.active.has(generationId) || this.queued.has(generationId);
  }

  list() {
    return [...this.queued.values()].map((run) => ({
      identity: { ...run.identity },
      taskId: run.taskId,
      generation: this.options.generation.get(run.identity.generationId),
    }));
  }

  get(generationId: string): ConversationRuntimeGetResult {
    const active = this.active.get(generationId);
    return {
      active: Boolean(active) || this.queued.has(generationId),
      liveActions: active?.liveActions ?? [],
      confirmation: this.pendingConfirmations.get(generationId)?.request,
      mediaSelection: this.pendingMediaSelections.get(generationId)?.request,
      mediaSubmission: this.pendingMediaSubmissions.get(generationId)?.request,
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

  selectMedia(
    generationId: string,
    selectionToken: string,
    selection: MediaModelSelectionDecision | undefined,
  ): boolean {
    const pending = this.pendingMediaSelections.get(generationId);
    if (!pending || pending.request.selectionToken !== selectionToken) return false;
    clearTimeout(pending.timeout);
    this.pendingMediaSelections.delete(generationId);
    pending.resolve(selection);
    return true;
  }

  confirmMediaSubmission(
    generationId: string,
    jobId: string,
    confirmationToken: string,
    approved: boolean,
  ): boolean {
    const pending = this.pendingMediaSubmissions.get(generationId);
    if (
      !pending ||
      pending.request.jobId !== jobId ||
      pending.request.confirmationToken !== confirmationToken
    ) {
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingMediaSubmissions.delete(generationId);
    pending.resolve(approved);
    return true;
  }

  private createProviderGateway(
    identity: LlmGenerationIdentity,
    tools: LlmToolDefinition[],
    planned: boolean,
    taskId: string,
  ): AgentProviderToolGateway {
    if (!this.options.providerTools) {
      throw new Error('Pi runtime requires the Worker Agent tool executor for this workflow.');
    }
    const planHooks: AgentProviderPlanHooks | undefined = planned
      ? {
          begin: (operation) => this.options.plans.beginStep({ taskId, operation }),
          succeed: (stepId, operation, resultText) =>
            this.options.plans.recordStepSuccess({
              taskId,
              stepId,
              operation,
              resultText,
            }),
          fail: (stepId, operation, error) =>
            this.options.plans.recordStepFailure({
              taskId,
              stepId,
              operation,
              error,
            }),
        }
      : undefined;
    return new AgentProviderToolGateway(
      this.options.providerTools,
      identity,
      tools,
      (request) => this.requestConfirmation(identity.generationId, request),
      (request) => this.requestMediaSelection(identity.generationId, request),
      (request) => this.requestMediaSubmission(identity.generationId, request),
      planHooks,
      !planned,
    );
  }

  private requestConfirmation(
    generationId: string,
    request: AgentToolConfirmationRequest,
  ): Promise<boolean> {
    if (this.pendingConfirmations.has(generationId)) {
      return Promise.reject(new Error('Pi runtime already has a pending confirmation.'));
    }
    const wait = () =>
      new Promise<boolean>((resolve, reject) => {
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
    return this.executionLeases.get(generationId)?.suspend(wait) ?? wait();
  }

  private resolvePendingConfirmation(generationId: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(generationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingConfirmations.delete(generationId);
    pending.resolve(approved);
  }

  private requestMediaSelection(
    generationId: string,
    request: MediaModelSelectionRequest,
  ): Promise<MediaModelSelectionDecision | undefined> {
    if (this.pendingMediaSelections.has(generationId)) {
      return Promise.reject(new Error('Pi runtime already has a pending media selection.'));
    }
    const wait = () =>
      new Promise<MediaModelSelectionDecision | undefined>((resolve, reject) => {
        const expiresIn = Math.min(
          MAX_TIMER_DELAY_MS,
          Math.max(0, Date.parse(request.expiresAt) - Date.now()),
        );
        const timeout = setTimeout(() => {
          this.pendingMediaSelections.delete(generationId);
          reject(new Error('Media model selection expired before the user responded.'));
        }, expiresIn);
        this.pendingMediaSelections.set(generationId, { request, resolve, timeout });
      });
    return this.executionLeases.get(generationId)?.suspend(wait) ?? wait();
  }

  private resolvePendingMediaSelection(
    generationId: string,
    selection: MediaModelSelectionDecision | undefined,
  ): void {
    const pending = this.pendingMediaSelections.get(generationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingMediaSelections.delete(generationId);
    pending.resolve(selection);
  }

  private requestMediaSubmission(
    generationId: string,
    request: MediaSubmissionConfirmationRequest,
  ): Promise<boolean> {
    if (this.pendingMediaSubmissions.has(generationId)) {
      return Promise.reject(new Error('Pi runtime already has a pending media submission.'));
    }
    const wait = () =>
      new Promise<boolean>((resolve, reject) => {
        const expiresIn = Math.min(
          MAX_TIMER_DELAY_MS,
          Math.max(0, Date.parse(request.expiresAt) - Date.now()),
        );
        const timeout = setTimeout(() => {
          this.pendingMediaSubmissions.delete(generationId);
          reject(new Error('Media submission confirmation expired before the user responded.'));
        }, expiresIn);
        this.pendingMediaSubmissions.set(generationId, { request, resolve, timeout });
      });
    return this.executionLeases.get(generationId)?.suspend(wait) ?? wait();
  }

  private resolvePendingMediaSubmission(generationId: string, approved: boolean): void {
    const pending = this.pendingMediaSubmissions.get(generationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingMediaSubmissions.delete(generationId);
    pending.resolve(approved);
  }

  private createNativeStream(identity: LlmGenerationIdentity): StreamFn {
    if (!this.options.bridge) throw new Error('Pi runtime requires a NativeProviderBridge.');
    const observations = new Map<string, { at: number; seen: Set<string> }>();
    return createPiStreamFunction(
      this.options.bridge,
      (model, context, options) => {
        const runtime = this.options.generation.runtime(identity);
        return nativeParams({
          ...runtime,
          systemInstruction: context.systemPrompt ?? runtime.systemInstruction,
          // Pi's system prompt already includes the frozen project context.
          context: context.systemPrompt === undefined ? runtime.context : '',
          inferenceSettings: runtime.inferenceSettings
            ? {
                ...runtime.inferenceSettings,
                maxOutputTokens: Math.min(
                  options?.maxTokens ?? model.maxTokens,
                  runtime.inferenceSettings.maxOutputTokens,
                ),
              }
            : undefined,
        });
      },
      (requestId, stage, metadata) => {
        const previous = observations.get(requestId) ?? { at: 0, seen: new Set<string>() };
        const now = Date.now();
        const terminal = ['complete', 'failed', 'cancelled'].includes(stage);
        const first = !previous.seen.has(stage);
        previous.seen.add(stage);
        if (first || terminal || now - previous.at >= 500) {
          this.options.providerTools?.recordProviderRequest?.(identity, requestId, stage, metadata);
          previous.at = now;
        }
        if (terminal) observations.delete(requestId);
        else observations.set(requestId, previous);
        const active = this.active.get(identity.generationId);
        if (active) {
          let live = active.liveActions.find((item) => item.id === requestId);
          if (!live) {
            live = { id: requestId, toolName: 'model.request', status: 'running' };
            active.liveActions.push(live);
          }
          live.phase = stage;
          live.lastActivityAt = new Date().toISOString();
          if (typeof metadata.toolName === 'string') live.toolName = metadata.toolName;
          if (typeof metadata.argumentBytes === 'number')
            live.argumentBytes = metadata.argumentBytes;
          if (terminal) live.status = stage === 'complete' ? 'succeeded' : 'failed';
          if (active.liveActions.length > 80)
            active.liveActions.splice(0, active.liveActions.length - 80);
        }
      },
      (requestId, usage) => {
        this.options.generation.recordProviderUsage?.(identity, requestId, usage);
      },
    );
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
    prepareOutputRepair?: (failure: ToolOutputFailure) => string,
  ): Promise<void> {
    const observed = { aggregate: '', responseId: undefined as string | undefined, segment: '' };
    agent.subscribe((event) => {
      if (event.type !== 'message_update' && event.type !== 'message_end') return;
      if (event.message.role !== 'assistant') return;
      const text = appendAssistantText(observed, event.message);
      if (text) this.options.generation.observe({ ...identity, content: text });
    });
    try {
      await agent.prompt(prompt);
      let repairs = 0;
      let repairLimitError: string | undefined;
      while (agent.state.errorMessage && !isCancelled()) {
        const failure = toolOutputFailure(agent.state.errorMessage);
        if (!failure || !prepareOutputRepair) break;
        this.options.providerTools?.recordValidationFailure?.(
          identity,
          failure.operation,
          failure.argumentBytes,
          failure.reason,
        );
        if (repairs >= MAX_TOOL_OUTPUT_REPAIRS) {
          repairLimitError = `TOOL_OUTPUT_REPAIR_LIMIT: ${failure.reason}; operation=${failure.operation}; argumentBytes=${failure.argumentBytes}; retries=${MAX_TOOL_OUTPUT_REPAIRS}. No tool from the failed response was executed.`;
          break;
        }
        // Drop failed assistant messages (including any partial tool calls).
        // Preserve the user request and every completed tool/result pair.
        const messages = agent.state.messages.filter(
          (message) =>
            message.role !== 'assistant' || !['error', 'aborted'].includes(message.stopReason),
        );
        const last = messages.at(-1);
        if (!last || (last.role !== 'user' && last.role !== 'toolResult')) break;
        agent.state.messages = messages;
        const toolName = prepareOutputRepair(failure);
        if (isCancelled()) return;
        const repair: ConversationRuntimeLiveAction = {
          id: `output-repair:${++repairs}`,
          toolName,
          phase: 'repairing_tool_output',
          status: 'running',
          lastActivityAt: new Date().toISOString(),
        };
        this.active.get(identity.generationId)?.liveActions.push(repair);
        await agent.continue();
        repair.status = agent.state.errorMessage ? 'failed' : 'succeeded';
      }
      if (isCancelled()) return;
      const state = agent.state;
      const final = snapshot();
      const plan = plannedWorkflow ? this.options.plans.getByTask(taskId) : undefined;
      const error = repairLimitError ?? state.errorMessage;
      if (error) {
        providerGateway?.terminate('failed', error);
        this.options.generation.failNative({
          ...identity,
          content: final.aggregate || observed.aggregate,
          error,
          retryable: true,
        });
        this.options.onEvent?.({ type: 'failed', taskId, message: error });
        return;
      }
      const completed: LlmGenerationCompleteParams = {
        ...identity,
        content: final.aggregate || observed.aggregate,
        providerResponseId: final.lastResponseId,
        finishReason: plan?.status === 'succeeded' ? 'task_package_complete' : 'stop',
        // Native usage is captured at the request boundary, including loader
        // and failed responses. Pi's default zero usage is not a provider report.
        usage: this.options.streamFn ? final.lastUsage : undefined,
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
      providerGateway?.terminate('failed', message);
      this.options.generation.failNative({
        ...identity,
        content: observed.aggregate,
        error: message,
        retryable: true,
      });
      this.options.onEvent?.({ type: 'failed', taskId, message });
    }
  }
}

function unifiedAgentInstruction(base: string): string {
  base +=
    '\nProduction reads use bounded views: scene.read defaults to IDs/bindings; production.read defaults to one saved authored instruction. Read text when missing an instruction or when stale to preserve manual edits. Follow contentPage.nextOffset with expectedVersion until complete; concatenate JSON pages before parsing. Reuse current results across tools and use ifVersion for dependency-aware unchanged responses. Batch related revisions. executionKey may be omitted so Worker derives a stable task command; changed=false means the current content and sources already match. CONTINUITY_UNVERIFIED means evidence is absent or prose cannot be compared: report it without inventing prior actions or rewriting every predecessor. Use comparison.entity/attribute/state only with real saved IDs and supported stable states; keep action detail in key/value. Saved needs_attention drafts remain saved and blocked for media until issues are resolved.';
  base +=
    '\nFor revisions, batch independent read-only calls in one response and reuse successful results. Read tools can be reused within the authorized task budget; tools.load only selects schemas and does not renew or expand authorization. For a production update, read the current shared scene and affected shot instructions, then use production.execute to update existing targets together (at most 30 operations and 512 KiB per list). When reference documents change, update their drafts first, then revise affected existing scene/shot instructions against the latest references and rowVersions; never recreate scenes, erase manual edits, or merely stamp old instructions as current. STALE_INSTRUCTION issues identify affected targets and changed references. Refreshing a production form does not repair saved instructions. Production tasks have at most 32 business calls and 24 model turns; batch independent reads and writes, keep saved progress, and report unfinished work clearly if a limit or network failure interrupts the task.';
  base +=
    '\nFor production prompt authoring, use production.read on demand and production.execute with a structured execution list for existing saved character/setting/scene/shot IDs. Fill only relevant fields, including explicit continuity before/after/locked facts and predecessor IDs when supported by the story. These are authored requirements, never proof that a generated video followed them. Read the target rowVersion first; stable executionKey retries identical content only. Do not fabricate resource IDs or system statuses. Create documents with the existing draft tools, and save scene/cast/shot relationships through scene.submit_structure as editable drafts without requesting user approval before updating production instructions. A manual prompt/cast edit makes the old instruction stale; read the current state and write a new instruction revision preserving that edit. The user chooses the Provider/model after entering the production form. Do not change official model contracts or make paid submissions from this checklist.';
  return `${base}\n\nYou are the unified project Agent. Understand the user's natural-language goal yourself. Answer directly when no business operation is needed, and call only the Worker-authorized tools when an operation is needed. Capability hints are non-authoritative. Before saving text, retrieve project.structure.get or project.get_context and choose the resourceMap destination by the user's goal. Echo the resourceId in the write call. Novel chapter bodies and novel outlines/settings belong to the 小说 workspace; short-drama outlines/plans belong to 剧本, and production character/scene prompts belong to 角色与场景. 场次与镜头 is a scene → shot tree with an independent prompt per shot. Choose needed tools with tools.load from the compact catalog; this only loads schemas and never grants authorization. For scene/shot authoring submit instruction only; the system renders prompts. Reference documents belong in sceneDocumentId/characterDocumentIds/subjects, never in continuity.predecessors; predecessors may only name real prior scenes/shots and otherwise stay empty. If scene validation fails, load scene.structure.stage, query existing progress, and replace only the rejected scene setup or shot range instead of repeating the whole plan. Saved drafts with readiness:needs_attention remain saved; report their issues and do not claim they are ready for media generation. Use scene.structure.stage for multi-scene or long plans: save shared scene setup then at most four shots per call, query missing ranges after interruptions and finalize one complete editable draft without user confirmation. For a small scene.submit_structure call use resourceId:workspace:shots, resolution:resolved and real reference IDs. You must semantically identify ALL appearing characters, including silent characters, aliases and pronouns, and the scene from project resources read on demand. Return actual document IDs; the system never infers relationships from names or prompt placeholders. Read existing scenes with scene.read on demand before revising them. For existing scenes include sceneId/current expectedRowVersion and shots:[] instead of creating duplicates; return the full updated cast and preserve prompt text unless asked to rewrite. If a reference is ambiguous or missing return resolution:needs_clarification, scenes:[], feedback, and no binding changes. Create missing character/scene documents first only if authorized. A changeSetId is an audit locator. When the result confirms scene_structure_saved/applied, scenes, shots and bindings are already saved as editable drafts in the directory; never request user approval to save them. The user may edit them later. A standalone storyboard document never creates scene/shot entries. Report the actual returned state. A document kind such as outline does not determine whether it is a novel or screenplay. The project name and current visible page do not override the user's goal. For existing resources echo their actual document/node ID and current version/CAS. Check the returned locator.workspace, resourceId and documentVersionId before reporting where content was saved. For an explicit image or video generation request, call media.image.prepare or media.video.prepare; do not merely write a prompt or claim the application cannot generate media. The user, never the Agent or Worker, chooses the concrete media Provider/model from compatible candidates. A media prepare result creates only a local draft and never means that a paid Provider request was submitted. Never claim that an image, video, document, or system change was completed unless the corresponding tool result confirms it.`;
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
    maxTokens: runtime.inferenceSettings?.maxOutputTokens ?? 16_384,
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

export type AssistantTextAccumulator = {
  aggregate: string;
  responseId?: string;
  segment: string;
};

export function appendAssistantText(
  accumulator: AssistantTextAccumulator,
  message: AssistantMessage,
): string {
  const text = assistantText(message);
  if (!text) return accumulator.aggregate;
  const responseId = message.responseId?.trim() || undefined;
  const strippedText = stripLeadingNewlines(text);
  const strippedSegment = stripLeadingNewlines(accumulator.segment);
  const sameTurn =
    accumulator.segment.length === 0 ||
    (responseId && accumulator.responseId
      ? responseId === accumulator.responseId
      : strippedText === strippedSegment || strippedText.startsWith(strippedSegment));
  if (sameTurn) {
    if (strippedText.length < strippedSegment.length) {
      if (responseId) accumulator.responseId = responseId;
      return accumulator.aggregate;
    }
    const nextSegment = text.startsWith(accumulator.segment) ? text : strippedText;
    accumulator.aggregate =
      accumulator.aggregate.slice(
        0,
        Math.max(0, accumulator.aggregate.length - accumulator.segment.length),
      ) + nextSegment;
    accumulator.segment = nextSegment;
    if (responseId) accumulator.responseId = responseId;
    return accumulator.aggregate;
  }
  if (
    strippedText === strippedSegment ||
    strippedText === stripLeadingNewlines(accumulator.aggregate)
  ) {
    if (responseId) accumulator.responseId = responseId;
    return accumulator.aggregate;
  }
  accumulator.responseId = responseId;
  accumulator.segment = strippedText;
  accumulator.aggregate = accumulator.aggregate
    ? `${stripTrailingNewlines(accumulator.aggregate)}\n\n${strippedText}`
    : strippedText;
  return accumulator.aggregate;
}

function stripLeadingNewlines(value: string): string {
  return value.replace(/^(?:\r\n|\n|\r)+/, '');
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)+$/, '');
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
  messages: AgentContext['messages'],
): LlmToolContinuation | undefined {
  if (message.role !== 'assistant' || results.length === 0) return undefined;
  if (protocol === 'openai-responses' && !message.responseId) return undefined;
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
      .join('\n'),
  }));
  if (protocol === 'openai-responses') {
    return { protocol, previousResponseId: message.responseId!, outputs };
  }
  // Chat Completions is stateless: a response ID cannot recover earlier tool
  // results. Rebuild completed turns from Pi, including failed tool results.
  const history: LlmChatToolTurn[] = [];
  let turn: LlmChatToolTurn | undefined;
  for (const item of messages) {
    if (item === message) break;
    if (item.role === 'assistant') {
      turn = {
        content: assistantText(item),
        calls: item.content
          .filter((block) => block.type === 'toolCall')
          .map((call) => ({
            id: call.id,
            name: call.name,
            argumentsJson: JSON.stringify(call.arguments),
          })),
        outputs: [],
      };
      history.push(turn);
    } else if (item.role === 'toolResult' && turn) {
      turn.outputs.push({
        callId: item.toolCallId,
        output: item.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      });
    }
  }
  return {
    protocol,
    providerResponseId: message.responseId ?? `pi:${calls[0]?.id ?? 'tool-turn'}`,
    history: compactRepeatedResults(history, outputs),
    content: assistantText(message),
    calls,
    outputs,
  };
}

/** Keep one exact copy of repeated read results; no unique content or constraints are removed. */
export function compactRepeatedResults(
  history: LlmChatToolTurn[],
  current: Array<{ callId: string; output: string }>,
): LlmChatToolTurn[] {
  const copies = new Map(current.map((output) => [output.output, output.callId]));
  const result = structuredClone(history);
  for (const turn of [...result].reverse()) {
    for (const output of [...turn.outputs].reverse()) {
      const latest = copies.get(output.output);
      if (latest && output.output.length > 2000)
        output.output = JSON.stringify({
          status: 'identical_result',
          fullResultCallId: latest,
          instruction: 'The exact result is retained at the later tool result in this request.',
        });
      else copies.set(output.output, output.callId);
    }
  }
  return result;
}
