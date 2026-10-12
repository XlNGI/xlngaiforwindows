import type { AgentGenerationPrepareParams, LlmGenerationPrepareResult } from '@ai-video/contracts';
import type {
  AgentOrchestrationService,
  NovelTaskPreparation,
} from './agent-orchestration-service.js';
import type {
  AgentModelSelectionProvenance,
  AgentProviderLoopService,
} from './agent-provider-loop-service.js';
import type { GenerationService } from './generation-service.js';

export function prepareAgentGeneration(
  services: {
    generations: GenerationService;
    loop: AgentProviderLoopService;
    orchestration: AgentOrchestrationService;
  },
  params: AgentGenerationPrepareParams,
  novelTask?: NovelTaskPreparation,
  provenance?: AgentModelSelectionProvenance,
): LlmGenerationPrepareResult & { agentTaskId: string } {
  let prepared: LlmGenerationPrepareResult | undefined;
  try {
    prepared = services.generations.prepare(params);
    const agent = services.loop.prepare(
      prepared.stream,
      params.prompt,
      params.title,
      novelTask?.documentIntent ?? params.documentIntent ?? { operation: 'document.list' },
      params.researchMode,
      novelTask?.taskId,
      params.selectedChapterIds,
      params.targetPlatform,
      provenance,
    );
    services.generations.configureAgentTools(prepared.stream, agent.tools);
    return { ...prepared, agentTaskId: agent.taskId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (prepared) {
      services.loop.terminateGeneration(prepared.stream.generationId, 'failed', message);
      services.generations.failNative({
        ...prepared.stream,
        content: prepared.generation.assistantMessage.content,
        error: message,
        retryable: true,
      });
    }
    if (novelTask) services.orchestration.failTaskBeforeGeneration(novelTask.taskId, message);
    throw error;
  }
}
