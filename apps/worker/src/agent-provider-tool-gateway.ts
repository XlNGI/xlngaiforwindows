import type {
  AgentGenerationConfirmToolParams,
  AgentGenerationConfirmToolResult,
  AgentGenerationConfirmMediaSubmissionParams,
  AgentGenerationExecuteToolsParams,
  AgentGenerationExecuteToolsResult,
  AgentProviderStepCompleteParams,
  LlmGenerationIdentity,
  NormalizedLlmUsage,
  LlmToolDefinition,
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
import { taskCheckpointValidationDefinition } from './agent-task-checkpoint-schema.js';
import { PREPARED_ARGUMENT_TOOLS, type PreparedArgumentsRef } from './agent-prepared-arguments.js';

export const CORE_TOOLS = [
  'conversation.ask',
  'conversation.task.route',
  'conversation.task.checkpoint',
  'project.structure.get',
  'library.search',
  'library.read',
];

export interface AgentProviderToolExecutor {
  resolveToolArguments?(identity: LlmGenerationIdentity, tool: string, args: unknown): unknown;
  preserveToolArguments?(
    identity: LlmGenerationIdentity,
    tool: string,
    args: unknown,
    callId?: string,
  ): PreparedArgumentsRef;
  projectToolResult?(identity: LlmGenerationIdentity, callId: string, output: string): string;
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
  reserveTurn?(identity: LlmGenerationIdentity): void;
  recordProviderUsage?(
    identity: LlmGenerationIdentity,
    requestId: string,
    usage: NormalizedLlmUsage,
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
  selectMedia(params: AgentGenerationSelectMediaParams): Promise<AgentGenerationExecuteToolsResult>;
  startProviderStep(identity: LlmGenerationIdentity): void;
  completeProviderStep(params: AgentProviderStepCompleteParams): void;
  terminateGeneration(
    generationId: string,
    reason: 'cancelled' | 'failed',
    errorMessage?: string,
    providerErrorCode?: string,
  ): number;
}

export class AgentTaskContinuationRequired extends Error {
  constructor(readonly instruction: string) {
    super(instruction);
    this.name = 'AgentTaskContinuationRequired';
  }
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
  private sceneShotBatchLimit = 4;
  private completionError?: string;
  private readonly selectedTools = new Set<string>();
  private catalog: string;
  private readonly catalogNames: string[];
  private readonly repeatedResults = new RepeatedReadResults();
  private readonly deliveredGuidance = new Set<string>();
  private readonly supportsTaskCheckpoint: boolean;
  private readonly readWaiters: Array<() => void> = [];
  // A durable review boundary closes the current Worker step. Pi still calls
  // prepareNextTurnWithContext after finalizing tool results, so remember the
  // termination and avoid trying to advance that already-closed step.
  private terminated = false;

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
    // The runtime decides whether to coordinate durable stages at task start.
    // A later authorization refresh cannot enable that coordinator mid-task.
    this.supportsTaskCheckpoint = initialDefinitions.some(
      (tool) => tool.name === 'conversation.task.checkpoint',
    );
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
    if (!this.lazyTools) return this.withRecoveryLimits(available);
    const byName = new Map(available.map((definition) => [definition.name, definition]));
    return this.withRecoveryLimits([
      ...CORE_TOOLS.flatMap((name) =>
        byName.has(name) ? [structuredClone(byName.get(name)!)] : [],
      ),
      this.loaderDefinition(),
      ...[...this.selectedTools]
        .filter((name) => !CORE_TOOLS.includes(name))
        .flatMap((name) => (byName.has(name) ? [structuredClone(byName.get(name)!)] : [])),
    ]);
  }

  private withRecoveryLimits(definitions: LlmToolDefinition[]): LlmToolDefinition[] {
    const tools = cloneDefinitions(definitions);
    if (this.sceneShotBatchLimit === 4) return tools;
    const stage = tools.find((tool) => tool.name === 'scene.structure.stage');
    if (stage) {
      const shots = (stage.parameters.properties as Record<string, Record<string, unknown>>)?.shots;
      if (shots) shots.maxItems = this.sceneShotBatchLimit;
      stage.description += ` Recovery limit: put_shots accepts at most ${this.sceneShotBatchLimit} ordered shots per call. Preserve every planned shot using successive shotOffset values.`;
    }
    return tools;
  }

  private refreshedDefinitions(definitions: LlmToolDefinition[]): LlmToolDefinition[] {
    return cloneDefinitions(definitions).filter(
      (tool) => this.supportsTaskCheckpoint || tool.name !== 'conversation.task.checkpoint',
    );
  }

  private isLoaded(name: string): boolean {
    return !this.lazyTools || this.selectedTools.has(name) || CORE_TOOLS.includes(name);
  }

  private loaderDefinition(): LlmToolDefinition {
    return {
      name: 'tools.load',
      description: `Load the authorized tools needed for the current step by exact name. Previously loaded tools remain available in stable order. Context management accounts for schema cost against the selected model. Use reset=true to explicitly replace the phase selection. Loading never grants authorization. Read the returned workflow instructions. Catalog: ${this.catalog}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['names'],
        properties: {
          workflow: {
            type: 'string',
            enum: ['character-image', 'scene-image', 'video-prompt'],
            description:
              'Load the specialized authoring policy for the current deliverable. Generic document tools do not load unrelated image/video policies.',
          },
          reset: {
            type: 'boolean',
            description: 'Explicitly replace the current phase selection.',
          },
          names: {
            type: 'array',
            minItems: 1,
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
        const { names, reset, workflow } = args as {
          names: string[];
          reset?: boolean;
          workflow?: string;
        };
        if (
          !Array.isArray(names) ||
          !names.length ||
          names.some((name) => !this.hasDefinition(name))
        )
          throw new Error('Select authorized tool names from the catalog.');
        const selection = new Set(reset ? [] : this.selectedTools);
        names.filter((name) => !CORE_TOOLS.includes(name)).forEach((name) => selection.add(name));
        const newlyLoaded = [...selection].filter((name) => !this.selectedTools.has(name));
        this.selectedTools.clear();
        selection.forEach((name) => this.selectedTools.add(name));
        const blocks = loadedToolGuidance(names, workflow)
          .split(/\r?\n\s*\r?\n/)
          .filter(Boolean);
        const instructions =
          blocks.filter((block) => !this.deliveredGuidance.has(block)).join('\n\n') || undefined;
        blocks.forEach((block) => this.deliveredGuidance.add(block));
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'tools_loaded',
                names,
                loaded: [...selection],
                newlyLoaded,
                reused: names.filter((name) => !newlyLoaded.includes(name)),
                cacheRebuild: reset === true,
                instructions,
                workflow,
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

  restoreSelection(names: string[]): void {
    this.selectedTools.clear();
    for (const name of names)
      if (!CORE_TOOLS.includes(name) && this.hasDefinition(name)) this.selectedTools.add(name);
  }

  clearResultReuse(omittedCallIds?: ReadonlySet<string>): void {
    this.repeatedResults.clear(omittedCallIds);
  }

  preferStagedSceneAuthoring(): boolean {
    if (!this.hasDefinition('scene.structure.stage')) return false;
    // Load only an already authorized schema. Existing-scene revisions can
    // still explicitly load submit_structure and use its ID/CAS update path.
    this.selectedTools.delete('scene.submit_structure');
    this.selectedTools.add('scene.structure.stage');
    return true;
  }

  recoverSceneAuthoring(reason: 'output-size' | 'arguments'): string | undefined {
    if (!this.preferStagedSceneAuthoring()) return undefined;
    if (reason === 'output-size')
      this.sceneShotBatchLimit = Math.max(1, Math.floor(this.sceneShotBatchLimit / 2));
    return (
      `For NEW scene/shot content use scene.structure.stage with at most ${this.sceneShotBatchLimit} ordered shots per put_shots call, one write call per response. ` +
      'Resume the matching stage using get and its latest stageId, rowVersion and missingShots; do not repeat saved scenes or shots. ' +
      'Only when no matching stage exists, begin with a stable executionKey and the full sceneShotCounts manifest, then put_scene and put_shots in order. ' +
      'Preserve the full manifest and prompt content across successive shotOffset batches; plan remaining writes using this batch size and missingShots. ' +
      'Each new shot is {"title":"...","authoringIR":{"schemaVersion":1,"kind":"shot","prompt":"..."}}; put optional creative fields in authoringIR.data and real document IDs in authoringIR.references. ' +
      'Use complete JSON with escaped quotes/newlines inside strings. Put final generation text in authoringIR.prompt. ' +
      'For EXISTING scene revisions keep sceneId and expectedRowVersion through scene.read/scene.submit_structure; never create replacements.'
    );
  }

  providerResponseRejection(calls: Array<{ id: string; name: string }>): string | undefined {
    if (calls.length > 8 || new Set(calls.map((call) => call.id)).size !== calls.length)
      return 'A response must contain at most eight distinct tool calls. No calls were executed.';
    if (calls.length <= 1) return undefined;
    if (
      calls.some(
        (call) =>
          call.name === 'tools.load' ||
          !unifiedAgentToolRegistry.has(call.name) ||
          unifiedAgentToolRegistry.executionMode(call.name) !== 'parallel',
      )
    )
      return (
        'Only independent read-only calls may share a response. No calls were executed. ' +
        'Submit tools.load or one write alone; read its result before the next write.'
      );
    return undefined;
  }

  freezeProviderResponse(calls: Array<{ id: string; name: string }>): void {
    const rejection = this.providerResponseRejection(calls);
    if (rejection) throw new Error(rejection);
    if (calls.some((call) => call.name === 'tools.load')) return;
    const key = calls.map((call) => call.id).join(':');
    if (
      this.batch?.key === key ||
      !calls.every((call) => unifiedAgentToolRegistry.executionMode(call.name) === 'parallel')
    )
      return;
    this.batch = {
      key,
      definitions: new Map(
        calls.map((call) => [call.id, structuredClone(this.liveDefinition(call.name))]),
      ),
      updates: [],
    };
  }

  finishProviderResponse(): void {
    if (this.terminated) {
      this.batch = undefined;
      this.readBatchContext = undefined;
      return;
    }
    const batch = this.batch;
    if (!batch) return;
    if (this.executor.advanceTextTurn && this.readBatchContext)
      this.definitions = this.refreshedDefinitions(
        this.executor.advanceTextTurn({
          ...this.identity,
          ...this.readBatchContext,
          finishReason: 'tool_calls',
        }),
      );
    else if (this.executor.refreshTools)
      this.definitions = this.refreshedDefinitions(this.executor.refreshTools(this.identity));
    else if (batch.updates.length)
      this.definitions = this.refreshedDefinitions(
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
    if (tools) this.definitions = this.refreshedDefinitions(tools);
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
    if (this.terminated) return;
    this.executor.startProviderStep(this.identity);
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
    args = this.executor.resolveToolArguments?.(this.identity, definition.name, args) ?? args;
    definition = taskCheckpointValidationDefinition(definition, args);
    try {
      const validated: unknown = validateToolArguments(definition, {
        type: 'toolCall',
        id: 'validation',
        name: definition.name,
        arguments: args as Record<string, unknown>,
      });
      return validated;
    } catch (error) {
      const recovery = isNewSceneAuthoring(definition.name, args)
        ? this.recoverSceneAuthoring('arguments')
        : undefined;
      const reason = boundedValidationError(error, definition, args);
      this.executor.recordValidationFailure?.(
        this.identity,
        definition.name,
        Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8'),
        reason,
      );
      const prepared = PREPARED_ARGUMENT_TOOLS.has(definition.name)
        ? this.executor.preserveToolArguments?.(this.identity, definition.name, args)
        : undefined;
      throw new Error([reason, recovery, preparedInstruction(prepared)].filter(Boolean).join('\n'));
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
        execution = await this.executor.selectMedia({
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
        const definitions = this.refreshedDefinitions(execution.tools);
        if (this.batch) this.batch.updates.push(definitions);
        else this.definitions = definitions;
      }
      const toolOutput = execution.continuation.outputs.find((item) => item.callId === toolCallId);
      const output = toolOutput?.output;
      if (output === undefined)
        throw new Error('Worker tool continuation omitted the Pi tool result.');
      unifiedAgentToolRegistry.assertResultText(output);
      const result = JSON.parse(output) as {
        status?: string;
        error?: { code?: string; message?: string };
      };
      if (unifiedAgentToolRegistry.isFailureResult(result)) {
        const recovery = isNewSceneAuthoring(name, args)
          ? this.recoverSceneAuthoring('arguments')
          : undefined;
        throw new Error(
          [boundedValidationError(new Error(output)), recovery].filter(Boolean).join('\n'),
        );
      }
      if (execution.terminate) this.terminated = true;
      if (stepId && !this.planHooks!.succeed(stepId, definition.name, output)) {
        throw new Error(`Planned operation ${definition.name} did not succeed.`);
      }
      return {
        content: [
          {
            type: 'text',
            text:
              this.executor.projectToolResult?.(this.identity, toolCallId, output) ??
              (readonly ? this.repeatedResults.use(toolCallId, output) : output),
          },
          ...(toolOutput?.images ?? []).map((item) => ({
            type: 'image' as const,
            data: item.data,
            mimeType: item.mimeType,
          })),
        ],
        details: { status: 'completed', toolName: definition.name },
        ...(execution.terminate ? { terminate: true } : {}),
      };
    } catch (error) {
      if (error instanceof Error && /AGENT_TOOL_QUOTA_EXHAUSTED/.test(error.message))
        this.completionError = error.message;
      if (stepId) this.planHooks?.fail(stepId, definition.name, error);
      if (PREPARED_ARGUMENT_TOOLS.has(name)) {
        const prepared = this.executor.preserveToolArguments?.(
          this.identity,
          name,
          args,
          toolCallId,
        );
        if (prepared)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${preparedInstruction(prepared)}`,
          );
      }
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

function preparedInstruction(ref?: PreparedArgumentsRef): string | undefined {
  return ref
    ? `Arguments retained, not proof of a save. Retry the same tool using preparedArguments=${JSON.stringify(ref)} plus only corrected top-level fields. Original CAS still applies. Arrays/objects are replaced as a whole.`
    : undefined;
}

export function boundedValidationError(
  error: unknown,
  definition?: LlmToolDefinition,
  args?: unknown,
): string {
  const message = error instanceof Error ? error.message : 'Invalid tool arguments.';
  const paths = definition ? unsupportedArgumentPaths(definition.parameters, args) : [];
  return [
    ...(paths.length ? [`Unsupported fields: ${paths.join(', ')}.`] : []),
    message.split('Received arguments:')[0]!.trim(),
    ...(definition?.name === 'document.submit_draft'
      ? [
          'New document: omit documentId, expectedDocumentRowVersion and baseVersionId completely, even null. Existing document: provide documentId and that target’s current expectedDocumentRowVersion/baseVersionId; omit bindingRole. Source version IDs are provenance, never output-target CAS. contentIR is only for character/scene/prop; plans/scripts keep all authored structure in contentMarkdown and omit contentIR. Preserve all content when correcting fields.',
        ]
      : []),
    ...(definition?.name === 'conversation.task.checkpoint' &&
    args &&
    typeof args === 'object' &&
    (args as Record<string, unknown>).operation === 'review'
      ? [
          'No review executed. Call conversation.task.checkpoint operation=state and follow current pendingActions using the Worker reviewId. Report content findings with targetId/category/description/evidence; resolve or withdraw open issueIds with reason and evidence. Worker manages hashes, versions and missing reads; never report system readiness as a content defect.',
        ]
      : []),
    ...(definition?.name === 'conversation.task.checkpoint' &&
    args &&
    typeof args === 'object' &&
    (args as Record<string, unknown>).operation === 'plan'
      ? [
          'Deliverables: documentKind is only for document.submit_draft (scripts use plan); requireReferences supports scene.update_shot_prompts and scene structure creation. Structure tools count saved scenes. targetIds are existing output IDs; omit them for new outputs.',
        ]
      : []),
  ]
    .join('\n')
    .slice(0, 1600);
}

// Diagnostics only: the schema validator remains authoritative. Never include
// argument values or interpret open authoringIR.data as envelope fields.
function unsupportedArgumentPaths(schema: unknown, args: unknown): string[] {
  const paths: string[] = [];
  let visited = 0;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const visit = (shape: unknown, value: unknown, path: string, depth: number): void => {
    if (!record(shape) || paths.length >= 6 || ++visited > 8000 || depth > 24) return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        visit(shape.items, item, `${path}[${index}]`, depth + 1);
        if (paths.length >= 6 || visited > 8000) break;
      }
    } else if (record(value)) {
      const properties = record(shape.properties) ? shape.properties : {};
      for (const [key, item] of Object.entries(value)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(properties, key) && shape.additionalProperties === false)
          paths.push(JSON.stringify(nextPath.slice(0, 160)));
        else if (Object.hasOwn(properties, key)) visit(properties[key], item, nextPath, depth + 1);
        if (paths.length >= 6 || visited > 8000) break;
      }
    }
  };
  visit(schema, args, '', 0);
  return paths;
}

function isNewSceneAuthoring(name: string, args: unknown): boolean {
  if (name === 'scene.structure.stage') return true;
  if (!['scene.submit_structure', 'novel.episode.submit_structure'].includes(name)) return false;
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
