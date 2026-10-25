import {
  withAgentResponseLanguageInstruction,
  withAgentToolInstructions,
} from './agent-policy-instructions.js';
import { randomUUID } from 'node:crypto';
import { splitConversationRequest } from './conversation-request.js';
import type {
  AgentGenerationPrepareParams,
  ChatMessageInfo,
  LlmAttemptInfo,
  LlmGenerationCompleteParams,
  LlmGenerationFailParams,
  LlmGenerationIdentity,
  LlmGenerationInfo,
  LlmInputAttachment,
  LlmGenerationObserveParams,
  LlmGenerationPrepareParams,
  LlmGenerationPrepareResult,
  LlmGenerationRetryParams,
  LlmGenerationRetryPrepareParams,
  LlmGenerationRuntimeRequest,
  LlmToolContinuation,
  LlmToolDefinition,
  LlmPricingSnapshotInfo,
  LlmUsageAccounting,
  NormalizedLlmUsage,
  WorkerGenerationMetric,
} from '@ai-video/contracts';
import { estimateTokenCount, toContextManifest, type ProductionContext } from '@ai-video/context';
import type {
  LlmGenerationAttemptRecord,
  LlmGenerationRecord,
  ProjectRecord,
} from '@ai-video/domain';
import { LlmProviderError, type LlmProvider } from '@ai-video/llm';
import {
  captureTaskHistory,
  createRepositories,
  syncLibraryChunksForChatMessage,
} from '@ai-video/persistence';
import type { ResolvedLlmSelection } from './app-settings-service.js';
import { ContentService } from './content-service.js';
import { ContextService, toContextInfo } from './context-service.js';
import type { NovelContextService } from './novel-context-service.js';
import { ProjectService } from './project-service.js';
import {
  addDecimalStrings,
  calculateEstimatedCost,
  normalizeCurrency,
  normalizeDecimalPrice,
} from './usage-cost.js';
import { assertProjectTaskAdmission } from './task-admission.js';
import { readRequestAccounting, updateModelRequest } from './provider-request-ledger.js';

interface GenerationState extends LlmGenerationInfo {
  agentBaseInstruction?: string;
  providerUsage?: Map<string, NormalizedLlmUsage>;
  accounting?: LlmUsageAccounting;
  attemptId: string;
  projectId: string;
  projectSessionId: string;
  controller?: AbortController;
  completion?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  persistedCharacters: number;
  runtimeRequest?: LlmGenerationRuntimeRequest;
  record: LlmGenerationRecord;
  attempt: LlmGenerationAttemptRecord;
}

interface GenerationCreationOptions {
  taskExecution?: 'ordered' | 'parallel' | 'auto';
  idempotencyKey?: string;
  retryOfGenerationId?: string;
  selectedChapterIds?: string[];
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
  generationMetricReporter?: (metric: WorkerGenerationMetric) => void;
  novelContextService?: NovelContextService;
}

export interface LlmUsageIndexer {
  indexLlmAttempt(project: ProjectRecord, attempt: LlmGenerationAttemptRecord): void;
}

export class ConversationBusyError extends Error {
  constructor() {
    super('当前会话的上一轮仍在执行，请等待完成或停止生成后再发送。');
    this.name = 'ConversationBusyError';
  }
}

export class GenerationService {
  private readonly generations = new Map<string, GenerationState>();
  private readonly cancellationTimeoutMs: number;
  private readonly flushIntervalMs: number;
  private readonly flushCharacterThreshold: number;
  private readonly selectionResolver?: LlmSelectionResolver;
  private readonly usageIndexer?: LlmUsageIndexer;
  private readonly generationMetricReporter?: (metric: WorkerGenerationMetric) => void;

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
    this.generationMetricReporter = options.generationMetricReporter;
    this.novelContexts = options.novelContextService;
  }

  private readonly novelContexts?: NovelContextService;

  status() {
    const status = this.legacyProvider.status();
    return {
      provider: status.name,
      model: status.model,
      configured: status.configured,
      configurationSource: status.configured ? ('environment' as const) : ('none' as const),
    };
  }

  private reportGeneration(state: GenerationState, status: WorkerGenerationMetric['status']): void {
    this.generationMetricReporter?.({
      generationId: state.record.id,
      providerName: state.attempt.providerNameSnapshot,
      modelId: state.attempt.modelId,
      status,
      startedAt: state.attempt.startedAt,
      firstTokenAt: state.attempt.firstTokenAt,
      completedAt: state.attempt.completedAt,
      inputTokens: state.attempt.inputTokens,
      outputTokens: state.attempt.outputTokens,
      estimatedCost: state.attempt.estimatedCost,
      retryOfGenerationId: state.record.retryOfGenerationId,
    });
  }

  generate(
    conversationId: string,
    prompt: string,
    budgetTokens?: number,
    idempotencyKey?: string,
  ): LlmGenerationInfo {
    const existing = this.findIdempotent(idempotencyKey);
    if (existing) return generationInfoOf(existing);
    this.assertLegacyConfigured();
    return this.startLegacy(conversationId, prompt.trim(), budgetTokens, undefined, {
      idempotencyKey,
    });
  }

  prepare(
    params: LlmGenerationPrepareParams | AgentGenerationPrepareParams,
  ): LlmGenerationPrepareResult {
    const existing = this.findIdempotent(params.idempotencyKey);
    if (existing) return prepareResultOf(existing);
    const selection = this.resolveSelection(params.providerProfileId, params.modelId);
    const prepared = this.startNative(
      params.conversationId,
      params.prompt,
      selection,
      params.budgetTokens,
      undefined,
      { idempotencyKey: params.idempotencyKey, taskExecution: params.taskExecution },
      // Chapter selections are hints for the System Agent, never an implicit
      // full-text context. The resolver must locate and read the requested
      // resources through library tools.
      undefined,
      params.attachments,
    );
    // Optional UI locators are context, never an instruction classification
    // or permission to create a business target before the model runs.
    const hints = {
      ...('novelIntent' in params ? { novelIntent: params.novelIntent } : {}),
      ...('selectedChapterIds' in params ? { selectedChapterIds: params.selectedChapterIds } : {}),
      ...('targetPlatform' in params ? { targetPlatform: params.targetPlatform } : {}),
    };
    if (Object.values(hints).some((value) => value !== undefined)) {
      const state = this.requireNativeState(prepared.stream);
      if (state.runtimeRequest)
        state.runtimeRequest.context += `\n\n可选 UI 目标提示（按用户本轮语义决定是否采用，须用工具验证真实目标）：${JSON.stringify(hints)}`;
    }
    return prepared;
  }

  runtime(identity: LlmGenerationIdentity): LlmGenerationRuntimeRequest {
    const state = this.requireNativeState(identity);
    if (!isActive(state.status) || !state.runtimeRequest) {
      throw new Error('LLM generation is no longer available for native streaming.');
    }
    return { ...state.runtimeRequest };
  }

  discardUncommitted(): void {
    this.projects.access(false, (database) => {
      for (const [id, state] of this.generations)
        if (!database.prepare('SELECT 1 FROM llm_generations WHERE id=?').get(id)) {
          this.clearFlushTimer(state);
          this.generations.delete(id);
        }
    });
  }

  private domainDependenciesReady(generationId: string): boolean {
    const rows = this.projects.access(
      false,
      (database) =>
        database
          .prepare(
            `
      SELECT deps.batch_id AS batchId,deps.child_key AS childKey,deps.upstream_key AS upstreamKey,deps.milestone,deps.frozen_version_id AS frozenVersionId,
        child.task_id AS taskId,upstream.document_id AS documentId,upstream.conflict_artifact_id AS conflictId,
        generation.status AS generationStatus,task.status AS taskStatus,
        artifact.document_version_id AS versionId,artifact.disposition
      FROM novel_batch_children child JOIN novel_batch_dependencies deps ON deps.batch_id=child.batch_id AND deps.child_key=child.child_key
      JOIN novel_batch_children upstream ON upstream.batch_id=deps.batch_id AND upstream.child_key=deps.upstream_key
      JOIN llm_generations generation ON generation.id=upstream.generation_id JOIN agent_tasks task ON task.id=upstream.task_id
      LEFT JOIN agent_task_document_artifacts artifact ON artifact.task_id=upstream.task_id AND artifact.artifact_role='primary'
      WHERE child.generation_id=?`,
          )
          .all(generationId) as Array<{
          batchId: string;
          childKey: string;
          upstreamKey: string;
          milestone: 'draft' | 'published';
          frozenVersionId: string | null;
          taskId: string;
          documentId: string;
          conflictId: string | null;
          generationStatus: string;
          taskStatus: string;
          versionId: string | null;
          disposition: string | null;
        }>,
    );
    for (const row of rows) {
      if (row.frozenVersionId) continue;
      if (
        row.conflictId ||
        ['failed', 'cancelled'].includes(row.generationStatus) ||
        ['failed', 'cancelled'].includes(row.taskStatus) ||
        ['rejected', 'discarded'].includes(row.disposition ?? '')
      )
        throw new Error(
          'A required chapter artifact is unavailable; retry or revise the batch explicitly.',
        );
      if (
        row.generationStatus !== 'complete' ||
        !row.versionId ||
        (row.milestone === 'published' && row.disposition !== 'published')
      )
        return false;
    }
    if (rows.some((row) => !row.frozenVersionId))
      this.projects.access(true, (database) =>
        database.transaction(() => {
          for (const row of rows)
            if (!row.frozenVersionId) {
              database
                .prepare(
                  'UPDATE novel_batch_dependencies SET frozen_version_id=? WHERE batch_id=? AND child_key=? AND upstream_key=? AND frozen_version_id IS NULL',
                )
                .run(row.versionId, row.batchId, row.childKey, row.upstreamKey);
              database
                .prepare(
                  'INSERT OR IGNORE INTO novel_batch_sources(batch_id,task_id,document_id,version_id,milestone) VALUES(?,?,?,?,?)',
                )
                .run(row.batchId, row.taskId, row.documentId, row.versionId, row.milestone);
            }
        })(),
      );
    return true;
  }

  /** Wait outside all database transactions and execution slots. Never replay a failed prerequisite. */
  async waitUntilReady(identity: LlmGenerationIdentity, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const state = this.requireNativeState(identity);
      if (!isActive(state.status)) throw new Error('Queued generation is no longer active.');
      if (!this.domainDependenciesReady(identity.generationId)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, 250);
          const abort = () => {
            clearTimeout(timer);
            reject(
              signal.reason instanceof Error ? signal.reason : new Error('Chapter task cancelled.'),
            );
          };
          signal.addEventListener('abort', abort, { once: true });
        });
        continue;
      }
      const dependency = this.projects.access(
        false,
        (database) =>
          database
            .prepare(
              `
        SELECT parent.id,parent.status,branches.dependency_snapshot_json AS snapshot
        FROM generation_branches branches JOIN llm_generations parent ON parent.id=branches.dependency_generation_id
        WHERE branches.generation_id=?`,
            )
            .get(identity.generationId) as
            { id: string; status: string; snapshot: string | null } | undefined,
      );
      if (!dependency) return;
      if (dependency.status === 'complete') {
        if (!dependency.snapshot) {
          const parent = this.get(dependency.id);
          const snapshot = JSON.stringify({
            generationId: dependency.id,
            userMessage: parent.userMessage,
            assistantMessage: parent.assistantMessage,
          });
          const segments: Array<{
            generationId: string;
            userMessage: ChatMessageInfo;
            assistantMessage: ChatMessageInfo;
          }> = [];
          const visited = new Set<string>();
          let cursor: string | undefined = dependency.id;
          while (cursor && !visited.has(cursor) && segments.length < 32) {
            visited.add(cursor);
            const current = this.get(cursor);
            segments.unshift({
              generationId: cursor,
              userMessage: current.userMessage,
              assistantMessage: current.assistantMessage,
            });
            cursor = this.projects.access(
              false,
              (database) =>
                (
                  database
                    .prepare(
                      'SELECT dependency_generation_id AS id FROM generation_branches WHERE generation_id=? AND dependency_snapshot_json IS NOT NULL',
                    )
                    .get(cursor!) as { id: string | null } | undefined
                )?.id ?? undefined,
            );
          }
          const text = segments
            .map(
              (segment) =>
                `\n\n[指定跟进任务 ${segment.generationId} 的完成结果]\nuser: ${segment.userMessage.content}\nassistant: ${segment.assistantMessage.content}`,
            )
            .join('');
          const budget =
            this.projects.access(false, (database) => {
              const row = createRepositories(database).contextSnapshots.get(state.snapshotId);
              return row
                ? (JSON.parse(row.contentJson) as { budgetTokens?: number }).budgetTokens
                : undefined;
            }) ?? 24_000;
          if (
            !state.runtimeRequest ||
            estimateTokenCount(
              state.runtimeRequest.systemInstruction + state.runtimeRequest.context + text,
            ) > budget
          )
            throw new Error('Follow-up result exceeds the frozen context budget.');
          this.projects.access(true, (database) =>
            database
              .prepare(
                'UPDATE generation_branches SET dependency_snapshot_json=? WHERE generation_id=? AND dependency_snapshot_json IS NULL',
              )
              .run(snapshot, identity.generationId),
          );
          state.runtimeRequest.context += text;
        }
        return;
      }
      if (!['prepared', 'streaming'].includes(dependency.status))
        throw new Error(
          'The preceding task did not complete; this follow-up requires an explicit retry.',
        );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(
            signal.reason instanceof Error ? signal.reason : new Error('Generation cancelled.'),
          );
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 50);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }

  supplement(generationId: string, content: string, idempotencyKey: string): ChatMessageInfo {
    const state = this.generations.get(generationId);
    if (!state || !isActive(state.status))
      throw new Error('Target task is no longer accepting input.');
    this.requireNativeState(identityOf(state));
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const existing = database
          .prepare(
            'SELECT message_id AS id,content,generation_id AS generationId FROM generation_supplements WHERE id=?',
          )
          .get(idempotencyKey) as { id: string; content: string; generationId: string } | undefined;
        if (existing) {
          if (existing.generationId !== generationId || existing.content !== content)
            throw new Error('Supplement operation key has different input.');
          return repositories.chatMessages.get(existing.id)!;
        }
        const count = database
          .prepare('SELECT COUNT(*) AS n FROM generation_supplements WHERE generation_id=?')
          .get(generationId) as { n: number };
        if (count.n >= 32) throw new Error('Task supplement queue is full (32).');
        const total = database
          .prepare(
            'SELECT COALESCE(SUM(length(content)),0) AS n FROM generation_supplements WHERE generation_id=?',
          )
          .get(generationId) as { n: number };
        if (state.userMessage.content.length + total.n + content.length + 1000 > 100000)
          throw new Error('Task supplements exceed the input budget.');
        const message: ChatMessageInfo = {
          id: randomUUID(),
          conversationId: state.conversationId,
          role: 'user',
          content,
          status: 'complete',
          createdAt: nowIso(),
        };
        repositories.chatMessages.save(message);
        database
          .prepare(
            'INSERT INTO generation_supplements(id,generation_id,message_id,content,created_at) VALUES(?,?,?,?,?)',
          )
          .run(idempotencyKey, generationId, message.id, content, message.createdAt);
        syncLibraryChunksForChatMessage(
          database,
          project.id,
          message,
          repositories.conversations.get(state.conversationId)!,
          message.createdAt,
        );
        return message;
      })(),
    );
  }

  consumeSupplements(generationId: string): Array<{ id: string; content: string }> {
    const state = this.generations.get(generationId);
    if (!state?.runtimeRequest || !isActive(state.status)) return [];
    const rows = this.projects.access(true, (database) =>
      database.transaction(() => {
        const rows = database
          .prepare(
            'SELECT id,content FROM generation_supplements WHERE generation_id=? AND consumed_at IS NULL ORDER BY rowid',
          )
          .all(generationId) as Array<{ id: string; content: string }>;
        for (const row of rows)
          database
            .prepare(
              'UPDATE generation_supplements SET consumed_at=? WHERE id=? AND consumed_at IS NULL',
            )
            .run(nowIso(), row.id);
        return rows;
      })(),
    );
    // Pi appends these as user messages. Its send-time budget includes all supplements;
    // the original prompt and frozen system context must stay unchanged.
    return rows;
  }

  configureAgentTools(
    identity: LlmGenerationIdentity,
    tools: LlmToolDefinition[],
    continuation?: LlmToolContinuation,
    policyTools?: LlmToolDefinition[],
  ): void {
    const state = this.requireNativeState(identity);
    if (!isActive(state.status) || !state.runtimeRequest) {
      throw new Error('LLM generation is no longer available for Agent tool execution.');
    }
    state.agentBaseInstruction ??= state.runtimeRequest.systemInstruction;
    state.runtimeRequest = {
      ...state.runtimeRequest,
      systemInstruction: withAgentToolInstructions(
        policyTools ? state.agentBaseInstruction : state.runtimeRequest.systemInstruction,
        policyTools ?? tools,
      ),
      tools: tools.map((tool) => ({ ...tool, parameters: structuredClone(tool.parameters) })),
      continuation: continuation ? cloneToolContinuation(continuation) : undefined,
    };
  }

  /** Usage events are snapshots for one actual request, not increments or business steps. */
  recordProviderRequest(
    identity: LlmGenerationIdentity,
    requestId: string,
    stage: string,
    metadata: Record<string, unknown>,
  ): void {
    const state = this.requireNativeState(identity);
    if (!isActive(state.status) && !['cancelled', 'failed'].includes(state.status)) return;
    this.updateRequestAccounting(state, identity, requestId, stage, metadata);
  }

  recordProviderUsage(
    identity: LlmGenerationIdentity,
    requestId: string,
    usage: NormalizedLlmUsage,
  ): void {
    const state = this.requireNativeState(identity);
    // Cancellation is persisted before aborting the stream. Retain any final
    // reported charge from that in-flight request without changing its status.
    if (!isActive(state.status) && !['cancelled', 'failed'].includes(state.status)) return;
    const normalized = normalizeUsage(usage);
    if (!normalized) return;
    this.updateRequestAccounting(state, identity, requestId, 'usage', {}, normalized);
  }

  private updateRequestAccounting(
    state: GenerationState,
    identity: LlmGenerationIdentity,
    requestId: string,
    stage: string,
    metadata: Record<string, unknown>,
    usage?: NormalizedLlmUsage,
  ): void {
    const pricing = pricingSnapshotOf(state.attempt);
    const result = this.projects.access(true, (database) =>
      database.transaction(() => {
        if (!updateModelRequest(database, identity, requestId, stage, metadata, usage))
          return undefined;
        const accounting = readRequestAccounting(database, identity, pricing);
        const requests = new Map(
          accounting.requests
            .filter((request) => request.usage)
            .map((request) => [request.requestId, request.usage!]),
        );
        const total = sumProviderUsage(requests, accounting.requestCount);
        // A total Provider cost is authoritative only when every dispatched request reported it.
        if (total && accounting.reportedRequests !== accounting.requestCount)
          delete total.providerReportedCost;
        const estimatedCost = calculateEstimatedCost(total, pricing);
        const attempt = {
          ...state.attempt,
          ...usageFields(total, accounting),
          estimatedCost,
          currency: estimatedCost ? pricing?.currency : undefined,
        };
        createRepositories(database).llmGenerationAttempts.save(attempt);
        return { accounting, requests, attempt };
      })(),
    );
    if (!result) return;
    state.accounting = result.accounting;
    state.providerUsage = result.requests;
    state.attempt = result.attempt;
    if (!isActive(state.status)) this.indexAttemptBestEffort(result.attempt);
  }

  observe(params: LlmGenerationObserveParams): LlmGenerationInfo {
    const state = this.requireNativeState(params);
    if (!isActive(state.status)) return publicState(state);
    const current = state.assistantMessage.content;
    // Native/Pi callbacks can arrive concurrently around a tool continuation.
    // A delayed or replaced snapshot is stale rather than an invalid generation.
    if (params.content === current || !params.content.startsWith(current)) {
      return publicState(state);
    }
    this.recordAssistantBoundary(state, current.length);
    const observedAt = nowIso();
    const attempt: LlmGenerationAttemptRecord = {
      ...state.attempt,
      status: 'streaming',
      firstTokenAt:
        state.attempt.firstTokenAt || !params.content ? state.attempt.firstTokenAt : observedAt,
    };
    state.status = 'streaming';
    state.attempt = attempt;
    state.assistantMessage = {
      ...state.assistantMessage,
      content: params.content,
      status: 'streaming',
    };
    if (
      state.persistedCharacters === 0 ||
      params.content.length - state.persistedCharacters >= this.flushCharacterThreshold
    )
      this.flushStreaming(state);
    else this.scheduleFlush(state);
    return publicState(state);
  }

  complete(params: LlmGenerationCompleteParams): LlmGenerationInfo {
    const state = this.requireNativeState(params);
    if (!isActive(state.status)) return publicState(state);
    const content = this.resolveMonotonicContent(state.assistantMessage.content, params.content);
    const usage =
      sumProviderUsage(state.providerUsage, state.accounting?.requestCount) ??
      normalizeUsage(params.usage);
    const pricing = pricingSnapshotOf(state.attempt);
    const estimatedCost = calculateEstimatedCost(usage, pricing);
    const providerResponseId = normalizeOptionalText(params.providerResponseId, 256);
    const finishReason = normalizeOptionalText(params.finishReason, 80);
    const completedAt = nowIso();
    const attempt: LlmGenerationAttemptRecord = {
      ...state.attempt,
      status: 'complete',
      firstTokenAt:
        state.attempt.firstTokenAt || !content ? state.attempt.firstTokenAt : completedAt,
      completedAt,
      providerResponseId,
      finishReason,
      ...usageFields(usage, state.accounting),
      estimatedCost,
      currency: estimatedCost ? pricing?.currency : undefined,
      errorCode: undefined,
      errorMessage: undefined,
    };
    const saved = this.persistAssistantAndAttempt(state, content, 'complete', attempt);
    if (!saved) throw new Error('Project session changed during generation.');
    state.assistantMessage = saved;
    state.attempt = attempt;
    state.persistedCharacters = saved.content.length;
    state.providerResponseId = providerResponseId;
    state.finishReason = finishReason;
    state.status = 'complete';
    this.indexAttemptBestEffort(attempt);
    this.reportGeneration(state, 'complete');
    return publicState(state);
  }

  failNative(params: LlmGenerationFailParams): LlmGenerationInfo {
    const state = this.requireNativeState(params);
    if (!isActive(state.status)) return publicState(state);
    const content = this.resolveMonotonicContent(state.assistantMessage.content, params.content);
    this.finishNativeFailure(state, false, params.error, params.retryable, content, params.usage);
    return publicState(state);
  }

  get(generationId: string): LlmGenerationInfo {
    const state = this.generations.get(generationId);
    return state ? publicState(state) : this.loadPersisted(generationId);
  }

  async cancel(generationId: string): Promise<LlmGenerationInfo> {
    const state = this.generations.get(generationId);
    if (!state) return this.cancelPersisted(generationId);
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
    const existing = this.findIdempotent(params.idempotencyKey);
    if (existing) return generationInfoOf(existing);
    this.assertLegacyConfigured();
    const source = this.retrySource(params.assistantMessageId);
    return this.startLegacy(
      source.conversationId,
      source.prompt,
      params.budgetTokens,
      source.user,
      {
        idempotencyKey: params.idempotencyKey,
        retryOfGenerationId: source.generationId,
      },
    );
  }

  retryPrepare(params: LlmGenerationRetryPrepareParams): LlmGenerationPrepareResult {
    const existing = this.findIdempotent(params.idempotencyKey);
    if (existing) return prepareResultOf(existing);
    const selection = this.resolveSelection(params.providerProfileId, params.modelId);
    const source = this.retrySource(params.assistantMessageId);
    return this.startNative(
      source.conversationId,
      source.prompt,
      selection,
      params.budgetTokens,
      source.user,
      {
        idempotencyKey: params.idempotencyKey,
        retryOfGenerationId: source.generationId,
      },
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
        const recoveredAt = nowIso();
        const failureMessage = '生成因 Worker 重启而中断。';
        database
          .prepare(
            `UPDATE llm_provider_requests SET stage='failed',updated_at=?,completed_at=? WHERE project_id=? AND completed_at IS NULL`,
          )
          .run(recoveredAt, recoveredAt, project.id);
        const messages = repositories.chatMessages.failStreamingByProject(
          project.id,
          failureMessage,
        );
        repositories.llmGenerationAttempts.failActiveByProject(
          project.id,
          recoveredAt,
          failureMessage,
        );
        repositories.llmGenerations.failActiveByProject(project.id, recoveredAt, failureMessage);
        for (const attempt of repositories.llmGenerationAttempts.listByProject(project.id)) {
          const persisted = parsePersistedUsage(attempt.rawUsageJson);
          if (!persisted?.accounting?.requests.some((request) => !request.completedAt)) continue;
          const generation = repositories.llmGenerations.get(attempt.generationId);
          if (!generation) continue;
          const accounting = readRequestAccounting(
            database,
            {
              generationId: generation.id,
              attemptId: attempt.id,
              projectId: project.id,
              projectSessionId: generation.projectSessionId,
              conversationId: generation.conversationId,
            },
            pricingSnapshotOf(attempt),
          );
          const updated = {
            ...attempt,
            rawUsageJson: JSON.stringify({ ...persisted, accounting }),
          };
          repositories.llmGenerationAttempts.save(updated);
          this.indexAttemptBestEffort(updated);
        }
        return messages;
      })();
    });
  }

  private findIdempotent(
    idempotencyKey: string | undefined,
  ): GenerationState | LlmGenerationInfo | undefined {
    if (!idempotencyKey) return undefined;
    const generationId = this.projects.access(
      false,
      (database, project) =>
        createRepositories(database).llmGenerations.getByIdempotencyKey(project.id, idempotencyKey)
          ?.id,
    );
    if (!generationId) return undefined;
    return this.generations.get(generationId) ?? this.loadPersisted(generationId);
  }

  private loadPersisted(generationId: string): LlmGenerationInfo {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const record = repositories.llmGenerations.get(generationId);
      if (!record || record.projectId !== project.id) throw new Error('Generation was not found.');
      const userMessage = repositories.chatMessages.get(record.userMessageId);
      const assistantMessage = repositories.chatMessages.get(record.assistantMessageId);
      const attempt = repositories.llmGenerationAttempts.getByAssistantMessage(
        record.assistantMessageId,
      );
      if (!userMessage || !assistantMessage || !attempt) {
        throw new Error('Generation persistence is incomplete.');
      }
      const snapshot = repositories.contextSnapshots.get(record.contextSnapshotId);
      return {
        generationId: record.id,
        attemptId: attempt.id,
        projectId: record.projectId,
        projectSessionId: record.projectSessionId,
        conversationId: record.conversationId,
        snapshotId: record.contextSnapshotId,
        status: record.status,
        executionMode: record.executionMode,
        providerProfileId: record.providerProfileId,
        modelId: record.modelId,
        providerResponseId: attempt.providerResponseId,
        finishReason: attempt.finishReason,
        userMessage,
        assistantMessage: { ...assistantMessage, attempt: toAttemptInfo(attempt) },
        sources: contextSourcesOf(snapshot?.contentJson),
        error: record.errorMessage,
        retryable: record.retryable,
      };
    });
  }

  private cancelPersisted(generationId: string): LlmGenerationInfo {
    this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const record = repositories.llmGenerations.get(generationId);
      if (!record || record.projectId !== project.id) throw new Error('Generation was not found.');
      if (!isActive(record.status)) return;
      const assistant = repositories.chatMessages.get(record.assistantMessageId);
      const attempt = repositories.llmGenerationAttempts.getByAssistantMessage(
        record.assistantMessageId,
      );
      const conversation = repositories.conversations.get(record.conversationId);
      if (!assistant || !attempt || !conversation) {
        throw new Error('Generation persistence is incomplete.');
      }
      const updatedAt = nowIso();
      const errorMessage = 'Generation was cancelled.';
      const nextRecord: LlmGenerationRecord = {
        ...record,
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage,
        retryable: true,
        updatedAt,
        version: record.version + 1,
      };
      const nextAttempt: LlmGenerationAttemptRecord = {
        ...attempt,
        status: 'cancelled',
        completedAt: updatedAt,
        errorCode: 'cancelled',
        errorMessage,
      };
      const updated = database.transaction(() => {
        if (!repositories.llmGenerations.update(nextRecord, record.version)) return false;
        repositories.chatMessages.save({
          ...assistant,
          content: assistant.content || errorMessage,
          status: 'failed',
        });
        repositories.llmGenerationAttempts.save(nextAttempt);
        repositories.conversations.save({ ...conversation, updatedAt });
        repositories.projects.touch(updatedAt);
        return true;
      })();
      if (updated) project.updatedAt = updatedAt;
    });
    return this.loadPersisted(generationId);
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
    generationId?: string;
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
      return {
        conversationId: conversation.id,
        prompt: user.content,
        user,
        generationId: repositories.llmGenerationAttempts.getByAssistantMessage(assistant.id)
          ?.generationId,
      };
    });
  }

  private startNative(
    conversationId: string,
    prompt: string,
    selection: ResolvedLlmSelection,
    budgetTokens?: number,
    existingUser?: ChatMessageInfo,
    options: GenerationCreationOptions = {},
    selectedChapterIds?: string[],
    attachments?: LlmInputAttachment[],
  ): LlmGenerationPrepareResult {
    const existing = this.findIdempotent(options.idempotencyKey);
    if (existing) return prepareResultOf(existing);
    const prepared = this.createState(
      conversationId,
      prompt,
      budgetTokens,
      existingUser,
      'native',
      selection,
      options,
      selectedChapterIds,
    );
    const { state, systemInstruction, context } = prepared;
    state.runtimeRequest = {
      generationId: state.generationId,
      attemptId: state.attemptId,
      projectId: state.projectId,
      projectSessionId: state.projectSessionId,
      conversationId: state.conversationId,
      providerProfileId: selection.providerProfileId,
      modelId: selection.modelId,
      remoteModelId: selection.remoteModelId,
      inferenceSettings: selection.inferenceSettings,
      contextWindowTokens: selection.contextWindowTokens ?? 64_000,
      contextWindowSource: selection.contextWindowTokens ? 'contract' : 'fallback',
      protocol: selection.protocol,
      baseUrl: selection.baseUrl,
      systemInstruction,
      context,
      prompt,
      attachments: attachments?.map((attachment) => ({ ...attachment })),
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
    options: GenerationCreationOptions = {},
  ): LlmGenerationInfo {
    const existing = this.findIdempotent(options.idempotencyKey);
    if (existing) return generationInfoOf(existing);
    const prepared = this.createState(
      conversationId,
      prompt,
      budgetTokens,
      existingUser,
      'legacy',
      undefined,
      options,
    );
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
    options: GenerationCreationOptions = {},
    selectedChapterIds?: string[],
  ): { state: GenerationState; systemInstruction: string; context: string } {
    if (!prompt) throw new Error('Prompt is required.');
    const projectId = this.projects.current()?.id;
    const projectSessionId = this.projects.currentSessionId();
    if (!projectId || !projectSessionId) throw new Error('No project is open.');
    const boundary = this.projects.access(false, (database) => captureTaskHistory(database));
    const compiled =
      selectedChapterIds && this.novelContexts
        ? this.novelContexts.compileShortDrama(conversationId, budgetTokens, selectedChapterIds)
        : this.contexts.compile(conversationId, budgetTokens, boundary);
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
    const record: LlmGenerationRecord = {
      id: generationId,
      projectId,
      projectSessionId,
      conversationId,
      contextSnapshotId: snapshotId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status: executionMode === 'native' ? 'prepared' : 'streaming',
      executionMode,
      retryOfGenerationId: options.retryOfGenerationId,
      idempotencyKey: options.idempotencyKey,
      providerProfileId: selection?.providerProfileId,
      modelId: selection?.modelId,
      createdAt: startedAt,
      updatedAt: startedAt,
      version: 0,
    };
    const state: GenerationState = {
      generationId,
      attemptId,
      projectId,
      projectSessionId,
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
      record,
      attempt,
    };
    this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (conversation.archivedAt) {
        throw new Error('Archived conversations cannot be updated.');
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
        const active = database
          .prepare(
            `SELECT id FROM llm_generations
             WHERE project_id = ? AND conversation_id = ? AND status IN ('prepared', 'streaming')
             ORDER BY rowid DESC LIMIT 1`,
          )
          .get(project.id, conversationId) as { id: string } | undefined;
        if (
          active &&
          (!options.taskExecution || process.env.AI_VIDEO_CONVERSATION_PARALLEL_ENABLED === '0')
        ) {
          throw new ConversationBusyError();
        }
        assertProjectTaskAdmission(database);
        repositories.contextSnapshots.save({
          id: snapshotId,
          projectId: project.id,
          purpose: 'llm-generation',
          contentJson: JSON.stringify(toContextManifest(compiled)),
          createdAt: startedAt,
        });
        if (!existingUser) repositories.chatMessages.save(userMessage);
        repositories.chatMessages.save(assistantMessage);
        if (!existingUser) {
          syncLibraryChunksForChatMessage(
            database,
            project.id,
            userMessage,
            conversation,
            startedAt,
          );
        }
        syncLibraryChunksForChatMessage(
          database,
          project.id,
          assistantMessage,
          conversation,
          startedAt,
        );
        repositories.llmGenerations.insert(record);
        const input = splitConversationRequest(userMessage.content);
        database
          .prepare('UPDATE llm_generations SET user_request=?,session_constraints=? WHERE id=?')
          .run(input.request, input.constraints, generationId);
        database
          .prepare(
            `INSERT INTO generation_branches(generation_id,branch_id,input_message_id,history_cutoff,
          excluded_generation_ids_json,execution,dependency_generation_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            generationId,
            generationId,
            userMessage.id,
            boundary.cutoff,
            JSON.stringify(boundary.excludedGenerationIds),
            options.taskExecution === 'ordered'
              ? 'ordered'
              : options.taskExecution === 'parallel'
                ? 'parallel'
                : 'legacy',
            options.taskExecution === 'ordered' ? (active?.id ?? null) : null,
            startedAt,
          );
        repositories.llmGenerationAttempts.save(attempt);
        repositories.conversations.save({ ...conversation, updatedAt: startedAt });
        repositories.projects.touch(startedAt);
      })();
      project.updatedAt = startedAt;
    });
    this.generations.set(state.generationId, state);
    const activeTaskContext = this.projects.access(false, (database, project) => {
      const rows = database
        .prepare(
          `SELECT generations.id,generations.status,COALESCE(generations.user_request,messages.content) AS prompt,
            generations.created_at,
            (SELECT COUNT(*) FROM agent_change_sets sets JOIN agent_task_generations links ON links.task_id=sets.task_id WHERE links.generation_id=generations.id) AS proposals
           FROM llm_generations generations
           JOIN chat_messages messages ON messages.id=generations.user_message_id
          WHERE generations.project_id=? AND generations.conversation_id=?
            AND generations.id<>?
          ORDER BY generations.created_at DESC LIMIT 8`,
        )
        .all(project.id, conversationId, generationId) as Array<{
        id: string;
        status: string;
        prompt: string;
        created_at: string;
        proposals: number;
      }>;
      if (!rows.length) return '';
      return `\n\n当前会话最近任务。由你判断语义关系，需要关联时调用 conversation.task.route：\n${rows.map((row) => `- generationId=${row.id}；状态=${row.status}；创建=${row.created_at}；提案数=${row.proposals}；用户请求=${JSON.stringify(splitConversationRequest(row.prompt).request.slice(0, 800))}`).join('\n')}\n可选关系：independent（独立执行）、follow_up（继续成功任务）、inspect（查询失败/取消/其他任务的真实结果，不建立成功依赖）、supplement（向活动任务补充指令）。无明确关系选择 independent。`;
    });
    return {
      state,
      systemInstruction: withAgentResponseLanguageInstruction(compiled.systemInstruction),
      context: `${compiled.rendered}${activeTaskContext}`,
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
      this.reportGeneration(state, 'complete');
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
      const usage =
        sumProviderUsage(state.providerUsage, state.accounting?.requestCount) ??
        normalizeUsage(usageInput);
      const pricing = pricingSnapshotOf(state.attempt);
      const estimatedCost = calculateEstimatedCost(usage, pricing);
      const attempt: LlmGenerationAttemptRecord = {
        ...state.attempt,
        status: state.status === 'cancelled' ? 'cancelled' : 'failed',
        completedAt: nowIso(),
        ...usageFields(usage, state.accounting),
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
    this.reportGeneration(state, state.status === 'cancelled' ? 'cancelled' : 'failed');
  }

  private requireNativeState(identity: LlmGenerationIdentity): GenerationState {
    const state = this.generations.get(identity.generationId);
    if (!state || state.executionMode !== 'native') {
      throw new Error('Native LLM generation was not found.');
    }
    if (
      state.attemptId !== identity.attemptId ||
      state.projectId !== identity.projectId ||
      state.projectSessionId !== identity.projectSessionId ||
      state.conversationId !== identity.conversationId
    ) {
      throw new Error('Stale LLM generation callback was rejected.');
    }
    if (
      this.projects.current()?.id !== state.projectId ||
      this.projects.currentSessionId() !== state.projectSessionId
    ) {
      throw new Error('Project session changed during generation.');
    }
    return state;
  }

  private resolveMonotonicContent(current: string, incoming: string): string {
    return incoming.startsWith(current) ? incoming : current;
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
    if (
      this.projects.current()?.id !== state.projectId ||
      this.projects.currentSessionId() !== state.projectSessionId
    ) {
      return undefined;
    }
    if (content.length > state.assistantMessage.content.length) {
      this.recordAssistantBoundary(state, state.assistantMessage.content.length);
    }
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
      const nextRecord: LlmGenerationRecord = {
        ...state.record,
        status: generationStatusForAttempt(attempt.status),
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        retryable: state.retryable,
        updatedAt,
        version: state.record.version + 1,
      };
      database.transaction(() => {
        repositories.chatMessages.save(message);
        syncLibraryChunksForChatMessage(database, project.id, message, conversation, updatedAt);
        if (!repositories.llmGenerations.update(nextRecord, state.record.version)) {
          throw new Error('LLM generation state conflict.');
        }
        repositories.llmGenerationAttempts.save(attempt);
        repositories.conversations.save({ ...conversation, updatedAt });
        repositories.projects.touch(updatedAt);
      })();
      state.record = nextRecord;
      project.updatedAt = updatedAt;
      return message;
    });
  }

  /** Persist ordering metadata, without duplicating text or interpreting model intent. */
  private recordAssistantBoundary(state: GenerationState, startOffset: number): void {
    this.projects.access(true, (database, project) => {
      if (
        project.id !== state.projectId ||
        this.projects.currentSessionId() !== state.projectSessionId
      )
        return;
      database.transaction(() => {
        const owner = database
          .prepare(`SELECT task_id FROM agent_task_generations WHERE generation_id = ?`)
          .get(state.generationId) as { task_id: string } | undefined;
        if (!owner) return;
        const lastTool = database
          .prepare(
            `SELECT MAX(sequence) AS sequence FROM agent_task_events
           WHERE task_id = ? AND event_type = 'agent.tool.started'`,
          )
          .get(owner.task_id) as { sequence: number | null };
        const dedupeKey = `assistant:${state.attemptId}:${lastTool.sequence ?? 'start'}`;
        if (
          database
            .prepare('SELECT 1 FROM agent_task_events WHERE task_id = ? AND dedupe_key = ?')
            .get(owner.task_id, dedupeKey)
        )
          return;
        const next = database
          .prepare(
            'SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM agent_task_events WHERE task_id = ?',
          )
          .get(owner.task_id) as { sequence: number };
        database
          .prepare(
            `INSERT INTO agent_task_events
           (id, task_id, project_id, sequence, event_type, level, actor_type, summary,
            payload_json, dedupe_key, created_at)
           VALUES (?, ?, ?, ?, 'agent.assistant.started', 'info', 'assistant', ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            owner.task_id,
            project.id,
            next.sequence,
            '助手阶段回复',
            JSON.stringify({ messageId: state.assistantMessage.id, startOffset }),
            dedupeKey,
            nowIso(),
          );
      })();
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

function cloneToolContinuation(continuation: LlmToolContinuation): LlmToolContinuation {
  if (continuation.protocol === 'openai-chat-completions') {
    return {
      protocol: continuation.protocol,
      providerResponseId: continuation.providerResponseId,
      content: continuation.content,
      userMessages: continuation.userMessages?.slice(),
      history: continuation.history?.map((turn) => ({
        content: turn.content,
        userMessages: turn.userMessages?.slice(),
        calls: turn.calls.map((call) => ({ ...call })),
        outputs: turn.outputs.map((output) => ({ ...output })),
      })),
      calls: continuation.calls.map((call) => ({ ...call })),
      outputs: continuation.outputs.map((output) => ({ ...output })),
    };
  }
  return {
    protocol: continuation.protocol,
    previousResponseId: continuation.previousResponseId,
    userMessages: continuation.userMessages?.slice(),
    outputs: continuation.outputs.map((output) => ({ ...output })),
  };
}

function identityOf(state: GenerationState): LlmGenerationIdentity {
  return {
    generationId: state.generationId,
    attemptId: state.attemptId,
    projectId: state.projectId,
    projectSessionId: state.projectSessionId,
    conversationId: state.conversationId,
  };
}

function isActive(status: LlmGenerationInfo['status']): boolean {
  return status === 'prepared' || status === 'streaming';
}

function generationStatusForAttempt(
  status: LlmGenerationAttemptRecord['status'],
): LlmGenerationRecord['status'] {
  return status === 'interrupted' ? 'failed' : status;
}

function generationInfoOf(state: GenerationState | LlmGenerationInfo): LlmGenerationInfo {
  return 'record' in state ? publicState(state) : state;
}

function prepareResultOf(state: GenerationState | LlmGenerationInfo): LlmGenerationPrepareResult {
  const generation = generationInfoOf(state);
  if (!generation.attemptId || !generation.projectId || !generation.projectSessionId) {
    throw new Error('Generation persistence is incomplete.');
  }
  return {
    generation,
    stream: {
      generationId: generation.generationId,
      attemptId: generation.attemptId,
      projectId: generation.projectId,
      projectSessionId: generation.projectSessionId,
      conversationId: generation.conversationId,
    },
  };
}

function contextSourcesOf(contentJson: string | undefined): LlmGenerationInfo['sources'] {
  if (!contentJson) return [];
  try {
    return toContextInfo(JSON.parse(contentJson) as ProductionContext).sources;
  } catch {
    return [];
  }
}

function publicState(state: GenerationState): LlmGenerationInfo {
  return {
    generationId: state.generationId,
    attemptId: state.attemptId,
    projectId: state.projectId,
    projectSessionId: state.projectSessionId,
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

const USAGE_TOKEN_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
] as const;

function sumProviderUsage(
  requests: Map<string, NormalizedLlmUsage> | undefined,
  expectedCount = requests?.size,
): NormalizedLlmUsage | undefined {
  if (!requests?.size) return undefined;
  const snapshots = [...requests.values()];
  const total: NormalizedLlmUsage = {};
  for (const key of USAGE_TOKEN_FIELDS) {
    const values = snapshots.map((usage) => usage[key]).filter((value) => value !== undefined);
    if (values.length)
      total[key] = normalizeTokenCount(values.reduce((sum, value) => sum + value, 0));
  }
  const costs = snapshots.map((usage) => usage.providerReportedCost);
  if (
    snapshots.length === expectedCount &&
    costs.every((cost) => cost && cost.currency === costs[0]?.currency)
  )
    total.providerReportedCost = {
      amount: addDecimalStrings(costs.map((cost) => cost!.amount)),
      currency: costs[0]?.currency,
    };
  return total;
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
  accounting?: LlmUsageAccounting,
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
    rawUsageJson:
      usage || accounting
        ? JSON.stringify({ ...usage, ...(accounting ? { accounting } : {}) })
        : undefined,
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
    accounting: persistedUsage?.accounting,
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

function parsePersistedUsage(
  value: string | undefined,
): (NormalizedLlmUsage & { accounting?: LlmUsageAccounting }) | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as NormalizedLlmUsage & { accounting?: LlmUsageAccounting };
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
