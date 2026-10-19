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
import { validateToolArguments } from '@earendil-works/pi-ai';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

export interface AgentProviderToolExecutor {
  recordProviderRequest?(
    identity: LlmGenerationIdentity,
    requestId: string,
    stage: string,
    metadata: Record<string, unknown>,
  ): void;
  recordValidationFailure?(
    identity: LlmGenerationIdentity,
    operation: string,
    argumentBytes: number,
    reason: string,
  ): void;
  refreshTools?(identity: LlmGenerationIdentity): LlmToolDefinition[];
  advanceTextTurn?(params: AgentProviderStepCompleteParams): LlmToolDefinition[];
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
  terminateGeneration(
    generationId: string,
    reason: 'cancelled' | 'failed',
    errorMessage?: string,
  ): number;
}

type ProviderCallContext = {
  definition?: LlmToolDefinition;
  providerResponseId: string;
  usage?: NormalizedLlmUsage;
};

type ConfirmationRequester = (request: AgentToolConfirmationRequest) => Promise<boolean>;
type MediaSelectionRequester = (
  request: MediaModelSelectionRequest,
) => Promise<MediaModelSelectionDecision | undefined>;
type MediaSubmissionRequester = (request: MediaSubmissionConfirmationRequest) => Promise<boolean>;

export interface AgentProviderPlanHooks {
  begin(operation: string): string | undefined;
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
  private batch?: {
    key: string;
    definitions: Map<string, LlmToolDefinition>;
    updates: LlmToolDefinition[][];
  };
  private activeReads = 0;
  private validationFailures = 0;
  private readonly selectedTools = new Set<string>();
  private readonly readWaiters: Array<() => void> = [];

  constructor(
    private readonly executor: AgentProviderToolExecutor,
    private readonly identity: LlmGenerationIdentity,
    initialDefinitions: LlmToolDefinition[],
    private readonly requestConfirmation: ConfirmationRequester,
    private readonly requestMediaSelection: MediaSelectionRequester,
    private readonly requestMediaSubmission: MediaSubmissionRequester = () =>
      Promise.resolve(false),
    private readonly planHooks?: AgentProviderPlanHooks,
    private readonly lazyTools = false,
  ) {
    this.definitions = cloneDefinitions(initialDefinitions);
    this.definitions.forEach((definition) => unifiedAgentToolRegistry.require(definition.name));
  }

  tools(allowedOperations?: readonly string[]): AgentTool[] {
    const allowed = allowedOperations ? new Set(allowedOperations) : undefined;
    const tools = this.definitions
      .filter(
        (definition) =>
          (!allowed ||
            allowed.has(definition.name) ||
            isLibraryRetrievalOperation(definition.name)) &&
          this.isLoaded(definition.name),
      )
      .map((definition) => this.tool(definition));
    if (this.lazyTools) tools.push(this.loaderTool());
    return tools;
  }

  currentDefinitions(allowedOperations?: readonly string[]): LlmToolDefinition[] {
    const allowed = allowedOperations ? new Set(allowedOperations) : undefined;
    const definitions = cloneDefinitions(
      this.definitions.filter(
        (definition) =>
          (!allowed ||
            allowed.has(definition.name) ||
            isLibraryRetrievalOperation(definition.name)) &&
          this.isLoaded(definition.name),
      ),
    );
    if (this.lazyTools) definitions.push(this.loaderDefinition());
    return definitions;
  }

  private isLoaded(name: string): boolean {
    return (
      !this.lazyTools ||
      this.selectedTools.has(name) ||
      [
        'conversation.task.route',
        'project.structure.get',
        'library.search',
        'library.read',
      ].includes(name)
    );
  }

  private loaderDefinition(): LlmToolDefinition {
    return {
      name: 'tools.load',
      description: `Choose up to six tools by exact name for the next turn. Replaces the previous selection; authorization remains Worker-owned. Core routing, structure and retrieval stay available. Catalog: ${this.definitions
        .filter((tool) => !['library.search', 'library.read'].includes(tool.name))
        .map((tool) => `${tool.name}: ${tool.description.split('.')[0]!.slice(0, 150)}`)
        .join('; ')}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['names'],
        properties: {
          names: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
            items: { type: 'string', enum: this.definitions.map((tool) => tool.name) },
          },
        },
      },
    };
  }

  private loaderTool(): AgentTool {
    return {
      ...this.loaderDefinition(),
      label: 'Load tool schemas',
      executionMode: 'sequential',
      prepareArguments: (args: unknown) => this.prepareArguments(this.loaderDefinition(), args),
      execute: (_id: string, args: unknown) => {
        const names = (args as { names: string[] }).names;
        if (
          !Array.isArray(names) ||
          names.length > 6 ||
          names.some((name) => !this.hasDefinition(name))
        )
          throw new Error('Select at most six authorized tool names from the catalog.');
        this.selectedTools.clear();
        names.forEach((name) => this.selectedTools.add(name));
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify({ status: 'tools_loaded', names }) }],
          details: {},
        });
      },
    } as unknown as AgentTool;
  }

  hasDefinition(operation: string): boolean {
    return this.definitions.some((definition) => definition.name === operation);
  }

  freezeProviderResponse(calls: Array<{ id: string; name: string }>): void {
    if (calls.some((call) => call.name === 'tools.load')) return;
    const key = calls.map((call) => call.id).join(':');
    if (
      this.batch?.key === key ||
      !calls.every((call) => unifiedAgentToolRegistry.executionMode(call.name) === 'parallel')
    )
      return;
    if (calls.length > 8 || new Set(calls.map((call) => call.id)).size !== calls.length)
      throw new Error('A read-only response must contain at most eight distinct tool calls.');
    this.batch = {
      key,
      definitions: new Map(
        calls.map((call) => [call.id, structuredClone(this.liveDefinition(call.name))]),
      ),
      updates: [],
    };
  }

  finishProviderResponse(): void {
    const batch = this.batch;
    if (!batch) return;
    if (this.executor.refreshTools)
      this.definitions = cloneDefinitions(this.executor.refreshTools(this.identity));
    else if (batch.updates.length)
      this.definitions = cloneDefinitions(
        batch.updates[0]!.filter((definition) =>
          batch.updates.every((update) =>
            update.some(
              (candidate) =>
                candidate.name === definition.name &&
                candidate.authorizationHandle === definition.authorizationHandle,
            ),
          ),
        ),
      );
    this.batch = undefined;
  }

  advanceTextTurn(providerResponseId: string | undefined, usage?: NormalizedLlmUsage): void {
    const tools = this.executor.advanceTextTurn?.({
      ...this.identity,
      providerResponseId,
      finishReason: 'supplement',
      usage,
    });
    if (tools) this.definitions = cloneDefinitions(tools);
  }

  captureProviderCall(
    toolCallId: string,
    providerResponseId: string | undefined,
    usage?: NormalizedLlmUsage,
  ): void {
    this.calls.set(toolCallId, {
      definition: this.batch?.definitions.get(toolCallId),
      providerResponseId:
        providerResponseId?.trim() || `pi:${this.identity.attemptId}:${toolCallId}`,
      usage,
    });
  }

  startProviderStep(): void {
    this.executor.startProviderStep(this.identity);
  }

  assertRepairBudget(): void {
    if (this.validationFailures >= 3)
      throw new Error(
        'TOOL_REPAIR_LIMIT: 参数校验连续修复达到上限（3次），请缩小为分段提交。已保存的草稿仍可继续。',
      );
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

  terminate(reason: 'cancelled' | 'failed', errorMessage?: string): void {
    if (errorMessage?.trim()) {
      this.executor.terminateGeneration(this.identity.generationId, reason, errorMessage);
      return;
    }
    this.executor.terminateGeneration(this.identity.generationId, reason);
  }

  private tool(definition: LlmToolDefinition): AgentTool {
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      executionMode: unifiedAgentToolRegistry.executionMode(definition.name),
      prepareArguments: (args: unknown) => this.prepareArguments(definition, args),
      execute: async (toolCallId, args) => this.execute(toolCallId, definition.name, args),
    } as AgentTool;
  }

  private prepareArguments(definition: LlmToolDefinition, args: unknown): unknown {
    try {
      this.assertRepairBudget();
      const validated: unknown = validateToolArguments(definition, {
        type: 'toolCall',
        id: 'validation',
        name: definition.name,
        arguments: args as Record<string, unknown>,
      });
      return validated;
    } catch (error) {
      this.validationFailures += 1;
      const reason = boundedValidationError(error);
      this.executor.recordValidationFailure?.(
        this.identity,
        definition.name,
        Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8'),
        reason,
      );
      throw new Error(reason);
    }
  }

  private liveDefinition(name: string): LlmToolDefinition {
    const live = this.definitions.find((definition) => definition.name === name);
    if (!live) {
      throw new Error(`Worker tool ${name} is no longer authorized for this Provider step.`);
    }
    return live;
  }

  private async execute(
    toolCallId: string,
    name: string,
    args: unknown,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const context = this.calls.get(toolCallId);
    this.calls.delete(toolCallId);
    if (!context) throw new Error('Pi tool call is missing its Provider response context.');
    const definition = context.definition ?? this.liveDefinition(name);
    const readonly = unifiedAgentToolRegistry.executionMode(name) === 'parallel';
    if (readonly) {
      if (this.activeReads >= 4)
        await new Promise<void>((resolve) => this.readWaiters.push(resolve));
      else this.activeReads += 1;
    }
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
      if (execution.tools) {
        if (this.batch) this.batch.updates.push(cloneDefinitions(execution.tools));
        else this.definitions = cloneDefinitions(execution.tools);
      }
      const output = execution.continuation.outputs.find(
        (item) => item.callId === toolCallId,
      )?.output;
      if (output === undefined)
        throw new Error('Worker tool continuation omitted the Pi tool result.');
      unifiedAgentToolRegistry.assertResultText(output);
      this.validationFailures = 0;
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
    } finally {
      if (readonly) {
        const next = this.readWaiters.shift();
        if (next) next();
        else this.activeReads -= 1;
      }
    }
  }
}

export function boundedValidationError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Invalid tool arguments.';
  return message.split('Received arguments:')[0]!.trim().slice(0, 1600);
}

export function isLibraryRetrievalOperation(operation: string): boolean {
  return operation === 'library.search' || operation === 'library.read';
}

function cloneDefinitions(definitions: LlmToolDefinition[]): LlmToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    parameters: structuredClone(definition.parameters),
  }));
}
