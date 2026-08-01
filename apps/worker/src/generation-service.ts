import { randomUUID } from 'node:crypto';
import type {
  ChatMessageInfo,
  LlmGenerationInfo,
  LlmGenerationRetryParams,
} from '@ai-video/contracts';
import { LlmProviderError, type LlmProvider } from '@ai-video/llm';
import { createRepositories } from '@ai-video/persistence';
import { ContentService } from './content-service.js';
import { ContextService, toContextInfo } from './context-service.js';
import { ProjectService } from './project-service.js';

interface GenerationState extends LlmGenerationInfo {
  controller: AbortController;
  projectId: string;
  completion?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  persistedCharacters: number;
}

export interface GenerationServiceOptions {
  cancellationTimeoutMs?: number;
  flushIntervalMs?: number;
  flushCharacterThreshold?: number;
}

export class GenerationService {
  private readonly generations = new Map<string, GenerationState>();
  private readonly cancellationTimeoutMs: number;
  private readonly flushIntervalMs: number;
  private readonly flushCharacterThreshold: number;

  constructor(
    private readonly projects: ProjectService,
    private readonly content: ContentService,
    private readonly contexts: ContextService,
    private readonly provider: LlmProvider,
    options: GenerationServiceOptions = {},
  ) {
    this.cancellationTimeoutMs = options.cancellationTimeoutMs ?? 5_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.flushCharacterThreshold = options.flushCharacterThreshold ?? 512;
  }

  status() {
    const status = this.provider.status();
    return { provider: status.name, model: status.model, configured: status.configured };
  }

  generate(conversationId: string, prompt: string, budgetTokens?: number): LlmGenerationInfo {
    this.assertConfigured();
    return this.start(conversationId, prompt.trim(), budgetTokens);
  }

  get(generationId: string): LlmGenerationInfo {
    const state = this.generations.get(generationId);
    if (!state) throw new Error('Generation was not found.');
    return publicState(state);
  }

  async cancel(generationId: string): Promise<LlmGenerationInfo> {
    const state = this.generations.get(generationId);
    if (!state) throw new Error('Generation was not found.');
    if (state.status === 'streaming') {
      state.controller.abort();
      await this.waitForCancellation(state);
    }
    return publicState(state);
  }

  retry(params: LlmGenerationRetryParams): LlmGenerationInfo {
    this.assertConfigured();
    const source = this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const assistant = repositories.chatMessages.get(params.assistantMessageId);
      const conversation = assistant
        ? repositories.conversations.get(assistant.conversationId)
        : undefined;
      if (!assistant || assistant.role !== 'assistant' || conversation?.projectId !== project.id)
        throw new Error('Assistant message was not found.');
      const user = assistant.replyToMessageId
        ? repositories.chatMessages.get(assistant.replyToMessageId)
        : undefined;
      if (!user || user.role !== 'user' || user.conversationId !== conversation.id) {
        throw new Error('Assistant message has no valid original user message.');
      }
      return { conversationId: conversation.id, prompt: user.content, user };
    });
    return this.start(source.conversationId, source.prompt, params.budgetTokens, source.user);
  }

  async cancelAll(): Promise<void> {
    const active = [...this.generations.values()].filter((state) => state.status === 'streaming');
    for (const state of active) state.controller.abort();
    await Promise.allSettled(active.map((state) => this.waitForCancellation(state)));
  }

  recoverInterrupted(): number {
    const project = this.projects.current();
    if (!project || project.mode !== 'read-write') return 0;
    return this.projects.access(true, (database) =>
      createRepositories(database).chatMessages.failStreamingByProject(
        project.id,
        '生成因 Worker 重启而中断。',
      ),
    );
  }

  private assertConfigured(): void {
    if (!this.provider.status().configured) {
      throw new LlmProviderError('OPENAI_API_KEY is not configured.', 'NOT_CONFIGURED', false);
    }
  }

  private start(
    conversationId: string,
    prompt: string,
    budgetTokens?: number,
    existingUser?: ChatMessageInfo,
  ): LlmGenerationInfo {
    if (!prompt) throw new Error('Prompt is required.');
    const context = this.contexts.compile(conversationId, budgetTokens);
    const snapshotId = this.contexts.saveSnapshot(context, 'llm-generation');
    const userMessage =
      existingUser ?? this.content.saveMessage({ conversationId, role: 'user', content: prompt });
    const assistantMessage = this.content.saveMessage({
      conversationId,
      replyToMessageId: userMessage.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    const generationId = randomUUID();
    const projectId = this.projects.current()?.id;
    if (!projectId) throw new Error('No project is open.');
    const state: GenerationState = {
      generationId,
      conversationId,
      snapshotId,
      status: 'streaming',
      userMessage,
      assistantMessage,
      sources: toContextInfo(context).sources,
      controller: new AbortController(),
      projectId,
      persistedCharacters: 0,
    };
    this.generations.set(generationId, state);
    state.completion = this.run(state, context.systemInstruction, context.rendered, prompt);
    return publicState(state);
  }

  private async run(
    state: GenerationState,
    systemInstruction: string,
    context: string,
    prompt: string,
  ): Promise<void> {
    try {
      const result = await this.provider.stream({
        systemInstruction,
        context,
        prompt,
        signal: state.controller.signal,
        onDelta: (delta) => {
          if (state.controller.signal.aborted || state.status !== 'streaming') return;
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
      if (state.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.clearFlushTimer(state);
      const saved = this.saveAssistant(state, result.content, 'complete');
      if (!saved) throw new Error('Project session changed during generation.');
      state.assistantMessage = saved;
      state.status = 'complete';
    } catch (error) {
      this.clearFlushTimer(state);
      if (state.status !== 'streaming') return;
      const cancelled = state.controller.signal.aborted;
      this.fail(state, cancelled, error);
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
    if (!completed && state.status === 'streaming') {
      this.fail(state, true, new Error('Provider did not stop after cancellation.'));
    }
  }

  private fail(state: GenerationState, cancelled: boolean, error: unknown): void {
    this.clearFlushTimer(state);
    state.status = cancelled ? 'cancelled' : 'failed';
    state.error = cancelled
      ? 'Generation was cancelled.'
      : error instanceof Error
        ? error.message
        : 'Generation failed.';
    state.retryable = cancelled || (error instanceof LlmProviderError ? error.retryable : true);
    try {
      const saved = this.saveAssistant(
        state,
        state.assistantMessage.content || state.error,
        'failed',
      );
      if (saved) state.assistantMessage = saved;
    } catch (persistenceError) {
      const message =
        persistenceError instanceof Error ? persistenceError.message : 'Unknown persistence error.';
      state.error = `${state.error} Failed to persist terminal state: ${message}`;
    }
  }

  private scheduleFlush(state: GenerationState): void {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      if (state.status !== 'streaming' || state.controller.signal.aborted) return;
      try {
        this.flushStreaming(state);
      } catch (error) {
        state.controller.abort();
        this.fail(state, false, error);
      }
    }, this.flushIntervalMs);
  }

  private flushStreaming(state: GenerationState): void {
    this.clearFlushTimer(state);
    const saved = this.saveAssistant(state, state.assistantMessage.content, 'streaming');
    if (!saved) {
      state.controller.abort();
      return;
    }
    state.assistantMessage = saved;
    state.persistedCharacters = saved.content.length;
  }

  private clearFlushTimer(state: GenerationState): void {
    if (!state.flushTimer) return;
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }

  private saveAssistant(
    state: GenerationState,
    content: string,
    status: ChatMessageInfo['status'],
  ): ChatMessageInfo | undefined {
    if (this.projects.current()?.id !== state.projectId) return undefined;
    return this.content.saveMessage({
      messageId: state.assistantMessage.id,
      conversationId: state.conversationId,
      replyToMessageId: state.userMessage.id,
      role: 'assistant',
      content,
      status,
    });
  }
}

function publicState(state: GenerationState): LlmGenerationInfo {
  return {
    generationId: state.generationId,
    conversationId: state.conversationId,
    snapshotId: state.snapshotId,
    status: state.status,
    userMessage: state.userMessage,
    assistantMessage: state.assistantMessage,
    sources: state.sources,
    error: state.error,
    retryable: state.retryable,
  };
}
