import type {
  AgentGenerationConfirmToolParams,
  AgentGenerationConfirmToolResult,
  AgentGenerationConfirmMediaSubmissionParams,
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
  MediaSubmissionConfirmationRequest,
} from '@ai-video/contracts';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

export interface AgentProviderToolExecutor {
  executeTools(
    params: AgentGenerationExecuteToolsParams,
  ): Promise<AgentGenerationExecuteToolsResult>;
  confirmTool(params: AgentGenerationConfirmToolParams): AgentGenerationConfirmToolResult;
  confirmMediaSubmission?(
    params: AgentGenerationConfirmMediaSubmissionParams,
  ): Promise<AgentGenerationExecuteToolsResult>;
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
type MediaSubmissionRequester = (request: MediaSubmissionConfirmationRequest) => Promise<boolean>;

export interface AgentProviderPlanHooks {
  begin(operation: string): string;
  succeed(stepId: string, operation: string, resultText: string): boolean;
  fail(stepId: string, operation: string, error: unknown): void;
}

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
    private readonly requestMediaSubmission: MediaSubmissionRequester = () =>
      Promise.resolve(false),
    private readonly planHooks?: AgentProviderPlanHooks,
  ) {
    this.definitions = cloneDefinitions(initialDefinitions);
    this.definitions.forEach((definition) => unifiedAgentToolRegistry.require(definition.name));
  }

  tools(allowedOperations?: readonly string[]): AgentTool[] {
    const allowed = allowedOperations ? new Set(allowedOperations) : undefined;
    return this.definitions
      .filter((definition) => !allowed || allowed.has(definition.name))
      .map((definition) => this.tool(definition));
  }

  currentDefinitions(allowedOperations?: readonly string[]): LlmToolDefinition[] {
    const allowed = allowedOperations ? new Set(allowedOperations) : undefined;
    return cloneDefinitions(
      this.definitions.filter((definition) => !allowed || allowed.has(definition.name)),
    );
  }

  hasDefinition(operation: string): boolean {
    return this.definitions.some((definition) => definition.name === operation);
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
    const stepId = this.planHooks?.begin(definition.name);
    const call = {
      id: toolCallId,
      name: definition.name,
      argumentsJson: JSON.stringify(args),
      authorizationHandle: definition.authorizationHandle,
    };
    try {
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
      if (execution.mediaSubmission) {
        const confirmation = execution.mediaSubmission;
        const approved = await this.requestMediaSubmission(confirmation);
        if (!this.executor.confirmMediaSubmission) {
          throw new Error('Worker media submission confirmation is not configured.');
        }
        execution = await this.executor.confirmMediaSubmission({
          ...this.identity,
          jobId: confirmation.jobId,
          confirmationToken: confirmation.confirmationToken,
          approved,
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
      if (stepId && !this.planHooks!.succeed(stepId, definition.name, output)) {
        throw new Error(`Planned operation ${definition.name} did not succeed.`);
      }
      return {
        content: [{ type: 'text', text: output }],
        details: { status: 'completed', toolName: definition.name },
      };
    } catch (error) {
      if (stepId) this.planHooks?.fail(stepId, definition.name, error);
      throw error;
    }
  }
}

function cloneDefinitions(definitions: LlmToolDefinition[]): LlmToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    parameters: structuredClone(definition.parameters),
  }));
}
