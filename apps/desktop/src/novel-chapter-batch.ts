import type {
  LlmGenerationPrepareResult,
  NovelChapterRequest,
  UnifiedAgentRunParams,
  UnifiedAgentRunResult,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

export async function runNovelChapterBatch(
  params: UnifiedAgentRunParams,
  requests: NovelChapterRequest[],
  callbacks: {
    isCancelled(): boolean;
    onProgress(message: string): void;
    onStarted?(): Promise<void>;
    launch(prepared: LlmGenerationPrepareResult): Promise<void>;
  },
): Promise<Extract<UnifiedAgentRunResult, { status: 'needs_model_selection' }> | void> {
  for (const [index, request] of requests.entries()) {
    if (callbacks.isCancelled()) return;
    const label = request.intent.displayLabel!;
    callbacks.onProgress(`正在生成${label}（${index + 1}/${requests.length}）`);
    const prepared = await callWorker('agent.run', {
      ...params,
      prompt: request.prompt,
      novelIntent: request.intent,
      idempotencyKey: `${params.idempotencyKey}:chapter:${index}`,
    });
    if (prepared.status === 'needs_model_selection') {
      if (callbacks.isCancelled()) return;
      if (index === 0) return prepared;
      throw new Error(`${label}的模型不可用，后续章节已停止；请重新选择模型后继续剩余章节。`);
    }
    if (prepared.status !== 'started' || !('stream' in prepared))
      throw new Error(`${label}未能启动，后续章节已停止。`);
    if (callbacks.isCancelled()) {
      await callWorker('llm.generation.cancel', { generationId: prepared.stream.generationId });
      return;
    }
    if (index === 0) {
      try {
        await callbacks.onStarted?.();
      } catch (reason) {
        await callWorker('llm.generation.cancel', { generationId: prepared.stream.generationId });
        throw reason;
      }
      if (callbacks.isCancelled()) {
        await callWorker('llm.generation.cancel', { generationId: prepared.stream.generationId });
        return;
      }
    }
    await callbacks.launch(prepared);
    if (callbacks.isCancelled()) return;
    const generation = await callWorker('llm.generation.get', {
      generationId: prepared.stream.generationId,
    });
    const detail = await callWorker('agent.task.get', { taskId: prepared.agentTaskId });
    const savedTarget =
      detail.target?.targetKind === 'novel-chapter' &&
      detail.documents.some((document) => document.documentId === detail.target?.documentId);
    if (
      generation.status !== 'complete' ||
      !savedTarget ||
      !['waiting_review', 'completed'].includes(detail.task.status)
    )
      throw new Error(
        `${label}未完成，后续章节已停止。${generation.error ?? detail.task.errorMessage ?? ''}`,
      );
  }
  if (!callbacks.isCancelled())
    callbacks.onProgress(`${requests.length}章草稿已生成，请逐章审核。`);
}
