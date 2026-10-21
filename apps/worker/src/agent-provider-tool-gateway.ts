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
import { loadedToolGuidance } from './agent-workflow-guidance.js';
import { RepeatedReadResults } from './repeated-read-results.js';
import { normalizeProductionAuthoringArguments } from '@ai-video/contracts';

const CORE_TOOLS = [
  'conversation.task.route',
  'project.structure.get',
  'library.search',
  'library.read',
];
const MAX_LOADED_TOOLS = 16;
const MAX_LOADED_SCHEMA_BYTES = 128 * 1024;

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
  private completionError?: string;
  private readonly selectedTools = new Set<string>();
  private catalog: string;
  private readonly catalogNames: string[];
  private readonly repeatedResults = new RepeatedReadResults();
  private readonly deliveredGuidance = new Set<string>();
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
    this.catalog = this.definitions
      .filter((tool) => !CORE_TOOLS.includes(tool.name))
      .map((tool) => `${tool.name}: ${tool.description.split('.')[0]!.slice(0, 80)}`)
      .join('; ');
    this.catalogNames = this.definitions.map((tool) => tool.name);
  }

  tools(allowedOperations?: readonly string[]): AgentTool[] {
    return this.currentDefinitions(allowedOperations).map((definition) =>
      definition.name === 'tools.load' ? this.loaderTool() : this.tool(definition),
    );
  }

  currentDefinitions(allowedOperations?: readonly string[]): LlmToolDefinition[] {
    for (const definition of this.definitions)
      if (!this.catalogNames.includes(definition.name)) {
        this.catalogNames.push(definition.name);
        if (!CORE_TOOLS.includes(definition.name))
          this.catalog += `; ${definition.name}: ${definition.description.split('.')[0]!.slice(0, 80)}`;
      }
    const allowed = allowedOperations ? new Set(allowedOperations) : undefined;
    const available = this.definitions.filter(
      (definition) =>
        (!allowed ||
          allowed.has(definition.name) ||
          isLibraryRetrievalOperation(definition.name)) &&
        this.isLoaded(definition.name),
    );
    if (!this.lazyTools) return cloneDefinitions(available);
    const byName = new Map(available.map((definition) => [definition.name, definition]));
    return [
      ...CORE_TOOLS.flatMap((name) =>
        byName.has(name) ? [structuredClone(byName.get(name)!)] : [],
      ),
      this.loaderDefinition(),
      ...[...this.selectedTools]
        .filter((name) => !CORE_TOOLS.includes(name))
        .flatMap((name) => (byName.has(name) ? [structuredClone(byName.get(name)!)] : [])),
    ];
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
      description: `Load up to six authorized tools by exact name. Previously loaded tools remain available in stable order (at most ${MAX_LOADED_TOOLS} extra tools / 128 KiB). Use reset=true only to begin a new phase when that budget is exceeded; it rebuilds the prompt cache. Loading never grants authorization. Read the returned workflow instructions. Catalog: ${this.catalog}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['names'],
        properties: {
          reset: {
            type: 'boolean',
            description: 'Explicitly replace the loaded phase when its schema budget is exceeded.',
          },
          names: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
            items: { type: 'string', enum: this.catalogNames },
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
        const { names, reset } = args as { names: string[]; reset?: boolean };
        if (
          !Array.isArray(names) ||
          names.length > 6 ||
          names.some((name) => !this.hasDefinition(name))
        )
          throw new Error('Select at most six authorized tool names from the catalog.');
        const selection = new Set(reset ? [] : this.selectedTools);
        names.filter((name) => !CORE_TOOLS.includes(name)).forEach((name) => selection.add(name));
        const selectedDefinitions = this.definitions.filter((definition) =>
          selection.has(definition.name),
        );
        const schemaBytes = Buffer.byteLength(
          JSON.stringify(
            selectedDefinitions.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          ),
        );
        if (selection.size > MAX_LOADED_TOOLS || schemaBytes > MAX_LOADED_SCHEMA_BYTES)
          throw new Error(
            'Loaded schema budget exceeded. Choose the tools needed for the next phase with reset=true.',
          );
        this.selectedTools.clear();
        selection.forEach((name) => this.selectedTools.add(name));
        const guidance = loadedToolGuidance(names);
        const instructions = this.deliveredGuidance.has(guidance) ? undefined : guidance;
        this.deliveredGuidance.add(guidance);
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'tools_loaded',
                names,
                loaded: [...selection],
                cacheRebuild: reset === true,
                instructions,
              }),
            },
          ],
          details: {},
        });
      },
    } as unknown as AgentTool;
  }

  hasDefinition(operation: string): boolean {
    return this.definitions.some((definition) => definition.name === operation);
  }

  clearResultReuse(): void {
    this.repeatedResults.clear();
  }

  preferStagedSceneAuthoring(): boolean {
    if (!this.hasDefinition('scene.structure.stage')) return false;
    // Load only an already authorized schema. Existing-scene revisions can
    // still explicitly load submit_structure and use its ID/CAS update path.
    this.selectedTools.delete('scene.submit_structure');
    this.selectedTools.add('scene.structure.stage');
    return true;
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
    if (this.executor.advanceTextTurn && this.readBatchContext)
      this.definitions = cloneDefinitions(
        this.executor.advanceTextTurn({
          ...this.identity,
          ...this.readBatchContext,
          finishReason: 'tool_calls',
        }),
      );
    else if (this.executor.refreshTools)
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
    this.readBatchContext = undefined;
  }

  private readBatchContext?: { providerResponseId?: string; usage?: NormalizedLlmUsage };

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
    if (this.batch) this.readBatchContext = { providerResponseId, usage };
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
    if (this.completionError) throw new Error(this.completionError);
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
      args = normalizeProductionAuthoringArguments(definition.name, args);
      const validated: unknown = validateToolArguments(definition, {
        type: 'toolCall',
        id: 'validation',
        name: definition.name,
        arguments: args as Record<string, unknown>,
      });
      return validated;
    } catch (error) {
      this.validationFailures += 1;
      if (isNewSceneAuthoring(definition.name, args)) this.preferStagedSceneAuthoring();
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
      const result = JSON.parse(output) as {
        status?: string;
        error?: { code?: string; message?: string };
      };
      if (result?.status === 'rejected') {
        if (result.error?.code === 'AGENT_TOOL_ARGUMENTS_INVALID') this.validationFailures += 1;
        if (isNewSceneAuthoring(name, args)) this.preferStagedSceneAuthoring();
        throw new Error(boundedValidationError(new Error(output)));
      }
      this.validationFailures = 0;
      if (stepId && !this.planHooks!.succeed(stepId, definition.name, output)) {
        throw new Error(`Planned operation ${definition.name} did not succeed.`);
      }
      return {
        content: [
          { type: 'text', text: readonly ? this.repeatedResults.use(toolCallId, output) : output },
        ],
        details: { status: 'completed', toolName: definition.name },
      };
    } catch (error) {
      if (error instanceof Error && /AGENT_TOOL_QUOTA_EXHAUSTED/.test(error.message))
        this.completionError = error.message;
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

function isNewSceneAuthoring(name: string, args: unknown): boolean {
  if (name === 'scene.structure.stage') return true;
  if (name !== 'scene.submit_structure') return false;
  const scenes = (args as { scenes?: Array<{ sceneId?: string }> } | undefined)?.scenes;
  return !Array.isArray(scenes) || scenes.some((scene) => !scene?.sceneId);
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
