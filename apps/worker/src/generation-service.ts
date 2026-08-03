import { randomUUID } from 'node:crypto';
import type {
  ChatMessageInfo,
  LlmAttemptInfo,
  LlmGenerationCompleteParams,
  LlmGenerationFailParams,
  LlmGenerationIdentity,
  LlmGenerationInfo,
  LlmGenerationObserveParams,
  LlmGenerationPrepareParams,
  LlmGenerationPrepareResult,
  LlmGenerationRetryParams,
  LlmGenerationRetryPrepareParams,
  LlmGenerationRuntimeRequest,
  LlmPricingSnapshotInfo,
  NormalizedLlmUsage,
} from '@ai-video/contracts';
import type { LlmGenerationAttemptRecord, ProjectRecord } from '@ai-video/domain';
import { LlmProviderError, type LlmProvider } from '@ai-video/llm';
import { createRepositories } from '@ai-video/persistence';
import type { ResolvedLlmSelection } from './app-settings-service.js';
import { ContentService } from './content-service.js';
import { ContextService, toContextInfo } from './context-service.js';
import { ProjectService } from './project-service.js';
import { calculateEstimatedCost, normalizeCurrency, normalizeDecimalPrice } from './usage-cost.js';

interface GenerationState extends LlmGenerationInfo {
  attemptId: string;
  projectId: string;
  controller?: AbortController;
  completion?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  persistedCharacters: number;
  runtimeRequest?: LlmGenerationRuntimeRequest;
  attempt: LlmGenerationAttemptRecord;
}

export interface LlmSelectionResolver {
  resolveLlmSelection(profileId: string, modelId: string): ResolvedLlmSelection;
}

export interface GenerationServiceOptions {
  cancellationTimeoutMs?: number;
  flushIntervalMs?: number;
  flushCharacterThreshold?: number;
  selectionResolver?: LlmSelectionResolver;
  usageIndexer?: LlmUsageIndexer;
}

export interface LlmUsageIndexer {
  indexLlmAttempt(project: ProjectRecord, attempt: LlmGenerationAttemptRecord): void;
}

export class GenerationService {
  private readonly generations = new Map<string, GenerationState>();
  private readonly cancellationTimeoutMs: number;
  private readonly flushIntervalMs: number;
  private readonly flushCharacterThreshold: number;
  private readonly selectionResolver?: LlmSelectionResolver;
  private readonly usageIndexer?: LlmUsageIndexer;

  constructor(
    private readonly projects: ProjectService,
    _content: ContentService,
    private readonly contexts: ContextService,
    private readonly legacyProvider: LlmProvider,
    options: GenerationServiceOptions = {},
  ) {
    this.cancellationTimeoutMs = options.cancellationTimeoutMs ?? 5_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.flushCharacterThreshold = options.flushCharacterThreshold ?? 512;
    this.selectionResolver = options.selectionResolver;
    this.usageIndexer = options.usageIndexer;
  }

  status() {
    const status = this.legacyProvider.status();
    return {
      provider: status.name,
      model: status.model,
      configured: status.configured,
      configurationSource: status.configured ? ('environment' as const) : ('none' as const),
    };
  }

  generate(conversationId: string, prompt: string, budgetTokens?: number): LlmGenerationInfo {
    this.assertLegacyConfigured();
    return this.startLegacy(conversationId, prompt.trim(), budgetTokens);
  }

  prepare(params: LlmGenerationPrepareParams): LlmGenerationPrepareResult {
    const selection = this.resolveSelection(params.providerProfileId, params.modelId);
    return this.startNative(
      params.conversationId,
      params.prompt.trim(),
      selection,
      params.budgetTokens,
    );
  }

  runtime(identity: LlmGenerationIdentity): LlmGenerationRuntimeRequest {
    const state = this.requireNativeState(identity);
    if (!isActive(state.status) || !state.runtimeRequest) {
      throw new Error('LLM generation is no longer available for native streaming.');
    }
    return { ...state.runtimeRequest };
  }

  observe(params: LlmGenerationObserveParams): LlmGenerationInfo {
    const state = this.requireNativeState(params);
    if (!isActive(state.status)) return publicState(state);
    this.assertMonotonicContent(state, params.content);
    const observedAt = nowIso();
    const attempt: LlmGenerationAttemptRecord = {
      ...state.attempt,
      status: 'streaming',
      firstTokenAt:
        state.attempt.firstTokenAt || !params.content ? state.attempt.firstTokenAt : observedAt,
    };
    const saved = this.persistAssistantAndAttempt(state, params.content, 'streaming', attempt);
    if (!saved) throw new Error('Project session changed during generation.');
    state.status = 'streaming';
    state.attempt = attempt;
    state.assistantMessage = saved;
    state.persistedCharacters = saved.content.length;
    return publicState(state);
  }

  complete(params: LlmGenerationCompleteParams): LlmGenerationInfo {
    const state = this.requireNativeState(params);
    if (!isActive(state.status)) return publicState(state);
    this.assertMonotonicContent(state, params.content);
    const usage = normalizeUsage(params.usage);
    const pricing = pricingSnapshotOf(state.attempt);
    const estimatedCost = calculateEstimatedCost(usage, pricing);
    const providerResponseId = normalizeOptionalText(params.providerResponseId, 256);
    const finishReason = normalizeOptionalText(params.finishReason, 80);
    const completedAt = nowIso();
    const attempt: LlmGenerationAttemptRecord = {
      ...state.attempt,
      status: 'complete',
      firstTokenAt:
        state.attempt.firstTokenAt || !params.content ? state.attempt.firstTokenAt : completedAt,
      completedAt,
      providerResponseId,
      finishReason,
      ...usageFields(usage),
      estimatedCost,
      currency: estimatedCost ? pricing?.currency : undefined,
      errorCode: undefined,
      errorMessage: undefined,
    };
    const saved = this.persistAssistantAndAttempt(state, params.content, 'complete', attempt);
    if (!saved) throw new Error('Project session changed during generation.');
    state.assistantMessage = saved;
    state.attempt = attempt;
    state.persistedCharacters = saved.content.length;
    state.providerResponseId = providerResponseId;
    state.finishReason = finishReason;
    state.status = 'complete';
    this.indexAttemptBestEffort(attempt);
    return publicState(state);
  }

  failNative(params: LlmGenerationFailParams): LlmGenerationInfo {
    const state = this.requireNativeState(params);
    if (!isActive(state.status)) return publicState(state);
    this.assertMonotonicContent(state, params.content);
    this.finishNativeFailure(
      state,
      false,
      params.error,
      params.retryable,
      params.content,
      params.usage,
    );
    return publicState(state);
  }

  get(generationId: string): LlmGenerationInfo {
    const state = this.generations.get(generationId);
    if (!state) throw new Error('Generation was not found.');
    return publicState(state);
  }

  async cancel(generationId: string): Promise<LlmGenerationInfo> {
    const state = this.generations.get(generationId);
    if (!state) throw new Error('Generation was not found.');
    if (!isActive(state.status)) return publicState(state);
    if (state.executionMode === 'native') {
      this.finishNativeFailure(
        state,
        true,
        'Generation was cancelled.',
        true,
        state.assistantMessage.content,
      );
    } else if (state.controller) {
      state.controller.abort();
      await this.waitForCancellation(state);
    }
    return publicState(state);
  }

  retry(params: LlmGenerationRetryParams): LlmGenerationInfo {
    this.assertLegacyConfigured();
    const source = this.retrySource(params.assistantMessageId);
    return this.startLegacy(source.conversationId, source.prompt, params.budgetTokens, source.user);
  }

  retryPrepare(params: LlmGenerationRetryPrepareParams): LlmGenerationPrepareResult {
    const selection = this.resolveSelection(params.providerProfileId, params.modelId);
    const source = this.retrySource(params.assistantMessageId);
    return this.startNative(
      source.conversationId,
      source.prompt,
      selection,
      params.budgetTokens,
      source.user,
    );
  }

  async cancelAll(): Promise<void> {
    const active = [...this.generations.values()].filter((state) => isActive(state.status));
    const legacy: GenerationState[] = [];
    for (const state of active) {
      if (state.executionMode === 'native') {
        this.finishNativeFailure(
          state,
          true,
          'Generation was cancelled.',
          true,
          state.assistantMessage.content,
        );
      } else if (state.controller) {
        state.controller.abort();
        legacy.push(state);
      }
    }
    await Promise.allSettled(legacy.map((state) => this.waitForCancellation(state)));
  }

  recoverInterrupted(): number {
    const project = this.projects.current();
    if (!project || project.mode !== 'read-write') return 0;
    return this.projects.access(true, (database) => {
      const repositories = createRepositories(database);
      return database.transaction(() => {
        const messages = repositories.chatMessages.failStreamingByProject(
          project.id,
          '生成因 Worker 重启而中断。',
        );
        repositories.llmGenerationAttempts.failActiveByProject(
          project.id,
          nowIso(),
          '生成因 Worker 重启而中断。',
        );
        return messages;
      })();
    });
  }

  private assertLegacyConfigured(): void {
    if (!this.legacyProvider.status().configured) {
      throw new LlmProviderError('OPENAI_API_KEY is not configured.', 'NOT_CONFIGURED', false);
    }
  }

  private resolveSelection(profileId: string, modelId: string): ResolvedLlmSelection {
    if (!this.selectionResolver) {
      throw new Error('Managed LLM provider profiles are unavailable.');
    }
    return this.selectionResolver.resolveLlmSelection(profileId, modelId);
  }

  private retrySource(assistantMessageId: string): {
    conversationId: string;
    prompt: string;
    user: ChatMessageInfo;
  } {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const assistant = repositories.chatMessages.get(assistantMessageId);
      const conversation = assistant
        ? repositories.conversations.get(assistant.conversationId)
        : undefined;
      if (!assistant || assistant.role !== 'assistant' || conversation?.projectId !== project.id) {
        throw new Error('Assistant message was not found.');
      }
      const user = assistant.replyToMessageId
        ? repositories.chatMessages.get(assistant.replyToMessageId)
        : undefined;
      if (!user || user.role !== 'user' || user.conversationId !== conversation.id) {
        throw new Error('Assistant message has no valid original user message.');
      }
      return { conversationId: conversation.id, prompt: user.content, user };
    });
  }

  private startNative(
    conversationId: string,
    prompt: string,
    selection: ResolvedLlmSelection,
    budgetTokens?: number,
    existingUser?: ChatMessageInfo,
  ): LlmGenerationPrepareResult {
    const prepared = this.createState(
      conversationId,
      prompt,
      budgetTokens,
      existingUser,
      'native',
      selection,
    );
    const { state, systemInstruction, context } = prepared;
    state.runtimeRequest = {
      generationId: state.generationId,
      attemptId: state.attemptId,
      projectId: state.projectId,
      conversationId: state.conversationId,
      providerProfileId: selection.providerProfileId,
      modelId: selection.modelId,
      remoteModelId: selection.remoteModelId,
      protocol: selection.protocol,
      baseUrl: selection.baseUrl,
      systemInstruction,
      context,
      prompt,
    };
    return {
      generation: publicState(state),
      stream: identityOf(state),
    };
  }

  private startLegacy(
    conversationId: string,
    prompt: string,
    budgetTokens?: number,
    existingUser?: ChatMessageInfo,
  ): LlmGenerationInfo {
    const prepared = this.createState(conversationId, prompt, budgetTokens, existingUser, 'legacy');
    const { state, systemInstruction, context } = prepared;
    state.status = 'streaming';
    state.controller = new AbortController();
    state.completion = this.runLegacy(state, systemInstruction, context, prompt);
    return publicState(state);
  }

  private createState(
    conversationId: string,
    prompt: string,
    budgetTokens: number | undefined,
    existingUser: ChatMessageInfo | undefined,
    executionMode: 'legacy' | 'native',
    selection?: ResolvedLlmSelection,
  ): { state: GenerationState; systemInstruction: string; context: string } {
    if (!prompt) throw new Error('Prompt is required.');
    const projectId = this.projects.current()?.id;
    if (!projectId) throw new Error('No project is open.');
    const compiled = this.contexts.compile(conversationId, budgetTokens);
    const snapshotId = randomUUID();
    const generationId = randomUUID();
    const attemptId = randomUUID();
    const startedAt = nowIso();
    const userMessage: ChatMessageInfo = existingUser ?? {
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: prompt,
      status: 'complete',
      createdAt: startedAt,
    };
    const assistantMessage: ChatMessageInfo = {
      id: randomUUID(),
      conversationId,
      replyToMessageId: userMessage.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: startedAt,
    };
    const legacyStatus = this.legacyProvider.status();
    const attempt: LlmGenerationAttemptRecord = {
      id: attemptId,
      generationId,
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      contextSnapshotId: snapshotId,
      providerProfileId: selection?.providerProfileId,
      providerNameSnapshot: selection?.providerName ?? legacyStatus.name,
      modelId: selection?.modelId,
      modelNameSnapshot: selection?.modelName ?? legacyStatus.model,
      protocol: selection?.protocol ?? 'legacy-openai-responses',
      status: executionMode === 'native' ? 'prepared' : 'streaming',
      startedAt,
      pricingSnapshotJson: selection?.pricingSnapshot
        ? JSON.stringify(selection.pricingSnapshot)
        : undefined,
    };
    const state: GenerationState = {
      generationId,
      attemptId,
      projectId,
      conversationId,
      snapshotId,
      status: executionMode === 'native' ? 'prepared' : 'streaming',
      executionMode,
      providerProfileId: selection?.providerProfileId,
      modelId: selection?.modelId,
      userMessage,
      assistantMessage,
      sources: toContextInfo(compiled).sources,
      persistedCharacters: 0,
      attempt,
    };
    this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      const persistedUser = existingUser
        ? repositories.chatMessages.get(existingUser.id)
        : undefined;
      if (
        existingUser &&
        (!persistedUser ||
          persistedUser.role !== 'user' ||
          persistedUser.conversationId !== conversation.id)
      ) {
        throw new Error('Original user message was not found.');
      }
      database.transaction(() => {
        repositories.contextSnapshots.save({
          id: snapshotId,
          projectId: project.id,
          purpose: 'llm-generation',
          contentJson: JSON.stringify(compiled),
          createdAt: startedAt,
        });
        if (!existingUser) repositories.chatMessages.save(userMessage);
        repositories.chatMessages.save(assistantMessage);
        repositories.llmGenerationAttempts.save(attempt);
        repositories.conversations.save({ ...conversation, updatedAt: startedAt });
        repositories.projects.touch(startedAt);
      })();
      project.updatedAt = startedAt;
    });
    this.generations.set(state.generationId, state);
    return {
      state,
      systemInstruction: compiled.systemInstruction,
      context: compiled.rendered,
    };
  }

  private async runLegacy(
    state: GenerationState,
    systemInstruction: string,
    context: string,
    prompt: string,
  ): Promise<void> {
    const controller = state.controller;
    if (!controller) throw new Error('Legacy generation controller is unavailable.');
    try {
      const result = await this.legacyProvider.stream({
        systemInstruction,
        context,
        prompt,
        signal: controller.signal,
        onDelta: (delta) => {
          if (controller.signal.aborted || state.status !== 'streaming') return;
          if (!state.attempt.firstTokenAt && delta) {
            state.attempt = { ...state.attempt, firstTokenAt: nowIso(), status: 'streaming' };
          }
          state.assistantMessage = {
            ...state.assistantMessage,
            content: state.assistantMessage.content + delta,
          };
          if (
            state.assistantMessage.content.length - state.persistedCharacters >=
            this.flushCharacterThreshold
          ) {
            this.flushStreaming(state);
          } else {
            this.scheduleFlush(state);
          }
        },
      });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.clearFlushTimer(state);
      const attempt: LlmGenerationAttemptRecord = {
        ...state.attempt,
        status: 'complete',
        completedAt: nowIso(),
        providerResponseId: result.providerResponseId,
        finishReason: 'completed',
        errorCode: undefined,
        errorMessage: undefined,
      };
      const saved = this.persistAssistantAndAttempt(state, result.content, 'complete', attempt);
      if (!saved) throw new Error('Project session changed during generation.');
      state.assistantMessage = saved;
      state.attempt = attempt;
      state.providerResponseId = result.providerResponseId;
      state.finishReason = 'completed';
      state.status = 'complete';
      this.indexAttemptBestEffort(attempt);
    } catch (error) {
      this.clearFlushTimer(state);
      if (state.status !== 'streaming') return;
      this.failLegacy(state, controller.signal.aborted, error);
    }
  }

  private async waitForCancellation(state: GenerationState): Promise<void> {
    const completion = state.completion ?? Promise.resolve();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.cancellationTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed && isActive(state.status)) {
      this.failLegacy(state, true, new Error('Provider did not stop after cancellation.'));
    }
  }

  private failLegacy(state: GenerationState, cancelled: boolean, error: unknown): void {
    this.clearFlushTimer(state);
    state.status = cancelled ? 'cancelled' : 'failed';
    state.error = cancelled
      ? 'Generation was cancelled.'
      : normalizeError(error instanceof Error ? error.message : 'Generation failed.');
    state.retryable = cancelled || (error instanceof LlmProviderError ? error.retryable : true);
    this.persistFailure(state, state.assistantMessage.content || state.error);
  }

  private finishNativeFailure(
    state: GenerationState,
    cancelled: boolean,
    error: string,
    retryable: boolean,
    content: string,
    usage?: NormalizedLlmUsage,
  ): void {
    state.status = cancelled ? 'cancelled' : 'failed';
    state.error = cancelled ? 'Generation was cancelled.' : normalizeError(error);
    state.retryable = cancelled || retryable;
    this.persistFailure(state, content || state.error, usage);
  }

  private persistFailure(
    state: GenerationState,
    content: string,
    usageInput?: NormalizedLlmUsage,
  ): void {
    try {
      const usage = normalizeUsage(usageInput);
      const pricing = pricingSnapshotOf(state.attempt);
      const estimatedCost = calculateEstimatedCost(usage, pricing);
      const attempt: LlmGenerationAttemptRecord = {
        ...state.attempt,
        status: state.status === 'cancelled' ? 'cancelled' : 'failed',
        completedAt: nowIso(),
        ...usageFields(usage),
        estimatedCost,
        currency: estimatedCost ? pricing?.currency : undefined,
        errorCode: state.status === 'cancelled' ? 'cancelled' : 'generation-failed',
        errorMessage: state.error,
      };
      const saved = this.persistAssistantAndAttempt(state, content, 'failed', attempt);
      if (saved) {
        state.assistantMessage = saved;
        state.attempt = attempt;
        state.persistedCharacters = saved.content.length;
        this.indexAttemptBestEffort(attempt);
      }
    } catch (persistenceError) {
      const message =
        persistenceError instanceof Error ? persistenceError.message : 'Unknown persistence error.';
      state.error = `${state.error ?? 'Generation failed.'} Failed to persist terminal state: ${message}`;
    }
  }

  private requireNativeState(identity: LlmGenerationIdentity): GenerationState {
    const state = this.generations.get(identity.generationId);
    if (!state || state.executionMode !== 'native') {
      throw new Error('Native LLM generation was not found.');
    }
    if (
      state.attemptId !== identity.attemptId ||
      state.projectId !== identity.projectId ||
      state.conversationId !== identity.conversationId
    ) {
      throw new Error('Stale LLM generation callback was rejected.');
    }
    if (this.projects.current()?.id !== state.projectId) {
      throw new Error('Project session changed during generation.');
    }
    return state;
  }

  private assertMonotonicContent(state: GenerationState, content: string): void {
    if (!content.startsWith(state.assistantMessage.content)) {
      throw new Error('Out-of-order LLM stream content was rejected.');
    }
  }

  private scheduleFlush(state: GenerationState): void {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      if (state.status !== 'streaming' || state.controller?.signal.aborted) return;
      try {
        this.flushStreaming(state);
      } catch (error) {
        state.controller?.abort();
        this.failLegacy(state, false, error);
      }
    }, this.flushIntervalMs);
  }

  private flushStreaming(state: GenerationState): void {
    this.clearFlushTimer(state);
    const attempt: LlmGenerationAttemptRecord = { ...state.attempt, status: 'streaming' };
    const saved = this.persistAssistantAndAttempt(
      state,
      state.assistantMessage.content,
      'streaming',
      attempt,
    );
    if (!saved) {
      state.controller?.abort();
      return;
    }
    state.assistantMessage = saved;
    state.attempt = attempt;
    state.persistedCharacters = saved.content.length;
  }

  private clearFlushTimer(state: GenerationState): void {
    if (!state.flushTimer) return;
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }

  private persistAssistantAndAttempt(
    state: GenerationState,
    content: string,
    status: ChatMessageInfo['status'],
    attempt: LlmGenerationAttemptRecord,
  ): ChatMessageInfo | undefined {
    if (this.projects.current()?.id !== state.projectId) return undefined;
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(state.conversationId);
      if (!conversation || conversation.projectId !== project.id) return undefined;
      const message: ChatMessageInfo = {
        ...state.assistantMessage,
        content,
        status,
      };
      const updatedAt = nowIso();
      database.transaction(() => {
        repositories.chatMessages.save(message);
        repositories.llmGenerationAttempts.save(attempt);
        repositories.conversations.save({ ...conversation, updatedAt });
        repositories.projects.touch(updatedAt);
      })();
      project.updatedAt = updatedAt;
      return message;
    });
  }

  private indexAttemptBestEffort(attempt: LlmGenerationAttemptRecord): void {
    if (!this.usageIndexer) return;
    const project = this.projects.current();
    if (!project) return;
    try {
      this.usageIndexer.indexLlmAttempt(project, attempt);
    } catch {
      // The application usage index is a rebuildable cache and must not change generation state.
    }
  }
}

function identityOf(state: GenerationState): LlmGenerationIdentity {
  return {
    generationId: state.generationId,
    attemptId: state.attemptId,
    projectId: state.projectId,
    conversationId: state.conversationId,
  };
}

function isActive(status: LlmGenerationInfo['status']): boolean {
  return status === 'prepared' || status === 'streaming';
}

function publicState(state: GenerationState): LlmGenerationInfo {
  return {
    generationId: state.generationId,
    attemptId: state.attemptId,
    projectId: state.projectId,
    conversationId: state.conversationId,
    snapshotId: state.snapshotId,
    status: state.status,
    executionMode: state.executionMode,
    providerProfileId: state.providerProfileId,
    modelId: state.modelId,
    providerResponseId: state.providerResponseId,
    finishReason: state.finishReason,
    userMessage: state.userMessage,
    assistantMessage: { ...state.assistantMessage, attempt: toAttemptInfo(state.attempt) },
    sources: state.sources,
    error: state.error,
    retryable: state.retryable,
  };
}

function normalizeUsage(usage: NormalizedLlmUsage | undefined): NormalizedLlmUsage | undefined {
  if (!usage) return undefined;
  const normalized: NormalizedLlmUsage = {
    inputTokens: normalizeTokenCount(usage.inputTokens),
    cachedInputTokens: normalizeTokenCount(usage.cachedInputTokens),
    outputTokens: normalizeTokenCount(usage.outputTokens),
    reasoningTokens: normalizeTokenCount(usage.reasoningTokens),
    totalTokens: normalizeTokenCount(usage.totalTokens),
    providerReportedCost: normalizeProviderReportedCost(usage.providerReportedCost),
  };
  if (usage.raw && typeof usage.raw === 'object' && !Array.isArray(usage.raw)) {
    const raw = JSON.stringify(usage.raw);
    if (raw.length <= 64 * 1024) normalized.raw = JSON.parse(raw) as Record<string, unknown>;
  }
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Provider usage contains an invalid token count.');
  }
  return value;
}

function normalizeProviderReportedCost(
  value: NormalizedLlmUsage['providerReportedCost'],
): NormalizedLlmUsage['providerReportedCost'] {
  if (!value) return undefined;
  return {
    amount: normalizeDecimalPrice(value.amount, 'Provider reported cost'),
    currency: value.currency ? normalizeCurrency(value.currency) : undefined,
  };
}

function usageFields(
  usage: NormalizedLlmUsage | undefined,
): Pick<
  LlmGenerationAttemptRecord,
  | 'inputTokens'
  | 'cachedInputTokens'
  | 'outputTokens'
  | 'reasoningTokens'
  | 'totalTokens'
  | 'rawUsageJson'
> {
  return {
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.reasoningTokens,
    totalTokens: usage?.totalTokens,
    rawUsageJson: usage ? JSON.stringify(usage) : undefined,
  };
}

function pricingSnapshotOf(
  attempt: LlmGenerationAttemptRecord,
): LlmPricingSnapshotInfo | undefined {
  if (!attempt.pricingSnapshotJson) return undefined;
  try {
    return JSON.parse(attempt.pricingSnapshotJson) as LlmPricingSnapshotInfo;
  } catch {
    return undefined;
  }
}

function toAttemptInfo(attempt: LlmGenerationAttemptRecord): LlmAttemptInfo {
  const persistedUsage = parsePersistedUsage(attempt.rawUsageJson);
  const usage = normalizeUsage({
    inputTokens: attempt.inputTokens,
    cachedInputTokens: attempt.cachedInputTokens,
    outputTokens: attempt.outputTokens,
    reasoningTokens: attempt.reasoningTokens,
    totalTokens: attempt.totalTokens,
    providerReportedCost: persistedUsage?.providerReportedCost,
  });
  return {
    id: attempt.id,
    generationId: attempt.generationId,
    providerProfileId: attempt.providerProfileId,
    providerName: attempt.providerNameSnapshot,
    modelId: attempt.modelId,
    modelName: attempt.modelNameSnapshot,
    protocol: attempt.protocol,
    status: attempt.status,
    startedAt: attempt.startedAt,
    firstTokenAt: attempt.firstTokenAt,
    completedAt: attempt.completedAt,
    providerResponseId: attempt.providerResponseId,
    finishReason: attempt.finishReason,
    usage,
    pricingSnapshot: pricingSnapshotOf(attempt),
    estimatedCost: attempt.estimatedCost,
    currency: attempt.currency,
    providerReportedCost: usage?.providerReportedCost,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
  };
}

function parsePersistedUsage(value: string | undefined): NormalizedLlmUsage | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as NormalizedLlmUsage;
  } catch {
    return undefined;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\r\n\0]+/g, ' ')
    .slice(0, 500);
  return normalized || 'Generation failed.';
}

function normalizeOptionalText(value: string | undefined, limit: number): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/[\r\n\0]+/g, ' ')
    .slice(0, limit);
  return normalized || undefined;
}
