import type {
  AgentGenerationConfirmToolParams,
  AgentGenerationConfirmToolResult,
  AgentGenerationExecuteToolsParams,
  AgentGenerationExecuteToolsResult,
  AgentProviderStepCompleteParams,
  LlmGenerationIdentity,
  LlmToolDefinition,
  NormalizedLlmUsage,
  AgentToolConfirmationRequest,
  AgentGenerationSelectMediaParams,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
} from '@ai-video/contracts';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

export interface AgentProviderToolExecutor {
  executeTools(
    params: AgentGenerationExecuteToolsParams,
  ): Promise<AgentGenerationExecuteToolsResult>;
  confirmTool(params: AgentGenerationConfirmToolParams): AgentGenerationConfirmToolResult;
  selectMedia(params: AgentGenerationSelectMediaParams): AgentGenerationExecuteToolsResult;
  startProviderStep(identity: LlmGenerationIdentity): void;
  completeProviderStep(params: AgentProviderStepCompleteParams): void;
  terminateGeneration(generationId: string, reason: 'cancelled' | 'failed'): number;
}

type ProviderCallContext = {
  providerResponseId: string;
  usage?: NormalizedLlmUsage;
};

type ConfirmationRequester = (request: AgentToolConfirmationRequest) => Promise<boolean>;
type MediaSelectionRequester = (
  request: MediaModelSelectionRequest,
) => Promise<MediaModelSelectionDecision | undefined>;

/**
 * Adapts Pi's single-tool callback to the existing Worker authorization,
 * transaction, confirmation, and audit service. It deliberately owns no
 * business policy of its own.
 */
export class AgentProviderToolGateway {
  private definitions: LlmToolDefinition[];
  private readonly calls = new Map<string, ProviderCallContext>();

  constructor(
    private readonly executor: AgentProviderToolExecutor,
    private readonly identity: LlmGenerationIdentity,
    initialDefinitions: LlmToolDefinition[],
    private readonly requestConfirmation: ConfirmationRequester,
    private readonly requestMediaSelection: MediaSelectionRequester,
  ) {
    this.definitions = cloneDefinitions(initialDefinitions);
    this.definitions.forEach((definition) => unifiedAgentToolRegistry.require(definition.name));
  }

  tools(): AgentTool[] {
    return this.definitions.map((definition) => this.tool(definition));
  }

  currentDefinitions(): LlmToolDefinition[] {
    return cloneDefinitions(this.definitions);
  }

  captureProviderCall(
    toolCallId: string,
    providerResponseId: string | undefined,
    usage?: NormalizedLlmUsage,
  ): void {
    this.calls.set(toolCallId, {
      providerResponseId:
        providerResponseId?.trim() || `pi:${this.identity.attemptId}:${toolCallId}`,
      usage,
    });
  }

  startProviderStep(): void {
    this.executor.startProviderStep(this.identity);
  }

  completeProviderStep(
    providerResponseId: string | undefined,
    finishReason: string | undefined,
    usage: NormalizedLlmUsage | undefined,
  ): void {
    this.executor.completeProviderStep({
      ...this.identity,
      providerResponseId,
      finishReason,
      usage,
    });
  }

  terminate(reason: 'cancelled' | 'failed'): void {
    this.executor.terminateGeneration(this.identity.generationId, reason);
  }

  private tool(definition: LlmToolDefinition): AgentTool {
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      executionMode: unifiedAgentToolRegistry.executionMode(definition.name),
      execute: async (toolCallId, args) => this.execute(toolCallId, definition, args),
    } as AgentTool;
  }

  private async execute(
    toolCallId: string,
    definition: LlmToolDefinition,
    args: unknown,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const context = this.calls.get(toolCallId);
    this.calls.delete(toolCallId);
    if (!context) throw new Error('Pi tool call is missing its Provider response context.');
    const call = {
      id: toolCallId,
      name: definition.name,
      argumentsJson: JSON.stringify(args),
      authorizationHandle: definition.authorizationHandle,
    };
    let execution = await this.executor.executeTools({
      ...this.identity,
      providerResponseId: context.providerResponseId,
      calls: [call],
      usage: context.usage,
    });
    if (execution.confirmation) {
      const approved = await this.requestConfirmation(execution.confirmation);
      execution = this.executor.confirmTool({
        ...this.identity,
        confirmationToken: execution.confirmation.confirmationToken,
        approved,
      });
    }
    if (execution.mediaSelection) {
      const selection = await this.requestMediaSelection(execution.mediaSelection);
      execution = this.executor.selectMedia({
        ...this.identity,
        selectionToken: execution.mediaSelection.selectionToken,
        selection,
      });
    }
    if (!execution.continuation) {
      throw new Error('Worker tool execution did not return a continuation result.');
    }
    this.definitions = cloneDefinitions(execution.tools ?? []);
    const output = execution.continuation.outputs.find(
      (item) => item.callId === toolCallId,
    )?.output;
    if (output === undefined)
      throw new Error('Worker tool continuation omitted the Pi tool result.');
    unifiedAgentToolRegistry.assertResultText(output);
    return {
      content: [{ type: 'text', text: output }],
      details: { status: 'completed', toolName: definition.name },
    };
  }
}

function cloneDefinitions(definitions: LlmToolDefinition[]): LlmToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    parameters: structuredClone(definition.parameters),
  }));
}
