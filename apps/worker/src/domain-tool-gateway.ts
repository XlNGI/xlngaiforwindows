import { randomUUID } from 'node:crypto';
import type {
  ConversationDeliverableKind,
  ConversationTaskToolGrant,
  DomainToolResultV1,
  LlmToolDefinition,
} from '@ai-video/contracts';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { ChangeSetService } from './change-set-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import { TaskPlanService } from './task-plan-service.js';
import { createRepositories } from '@ai-video/persistence';
import type { AgentToolCallRecord } from '@ai-video/domain';
import { hashAgentToolArguments, unifiedAgentToolRegistry } from './agent-tool-registry.js';

export interface PiToolIdentity {
  taskId: string;
  generationId?: string;
  attemptId?: string;
  projectId: string;
  projectSessionId: string;
  conversationId: string;
  userMessageId?: string;
  contextSnapshotId?: string;
}

type ToolArguments = Record<string, unknown>;

class DuplicatePiToolCall extends Error {
  constructor(readonly resultJson: string) {
    super('This Pi tool call has already completed.');
  }
}

/**
 * The only bridge from Pi tools to application services. Tool schemas are
 * copied from the Worker-owned grants and model arguments never provide task,
 * project, chapter, document, or filesystem authority.
 */
export class DomainToolGateway {
  constructor(
    private readonly projects: ProjectService,
    private readonly plans: TaskPlanService,
    private readonly documents: DocumentWorkflowService,
    private readonly changeSets: ChangeSetService,
    private readonly identity: PiToolIdentity,
  ) {}

  tools(grants: ConversationTaskToolGrant[]): AgentTool[] {
    grants.forEach((grant) => unifiedAgentToolRegistry.require(grant.tool.name));
    return grants.map((grant) => this.tool(grant));
  }

  private tool(grant: ConversationTaskToolGrant): AgentTool {
    const definition = grant.tool;
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      // Pi accepts the same JSON Schema dialect used by the Worker contracts.
      parameters: definition.parameters,
      executionMode: unifiedAgentToolRegistry.executionMode(definition.name),
      execute: async (toolCallId, args) => this.execute(toolCallId, grant, args as ToolArguments),
    } as AgentTool;
  }

  private async execute(
    toolCallId: string,
    grant: ConversationTaskToolGrant,
    args: ToolArguments,
  ): Promise<AgentToolResult<DomainToolResultV1 | Record<string, unknown>>> {
    const call = this.beginToolCall(toolCallId, grant.tool.name, args);
    try {
      const result = await this.executeUnlogged(grant, args);
      this.finishToolCall(call, result);
      return result;
    } catch (error) {
      if (!(error instanceof DuplicatePiToolCall)) this.failToolCall(call, error);
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async executeUnlogged(
    grant: ConversationTaskToolGrant,
    args: ToolArguments,
  ): Promise<AgentToolResult<DomainToolResultV1 | Record<string, unknown>>> {
    switch (grant.tool.name) {
      case 'task.plan.submit': {
        const plan = this.plans.submitPlanOnly({
          taskId: this.identity.taskId,
          candidate: args,
          idempotencyKey: `pi-plan:${this.identity.taskId}`,
        });
        return resultText({
          version: 1,
          status: 'succeeded',
          summary: 'Task plan frozen and activated.',
          remainingRequiredDeliverables: plan.deliverables
            .filter((item) => item.required && item.status !== 'succeeded')
            .map((item) => item.kind),
          retryable: false,
        });
      }
      case 'task.package.complete': {
        const completed = this.plans.completePackage(this.identity.taskId);
        if (completed.complete) {
          const output = unifiedAgentToolRegistry.serializeResult(completed);
          return {
            content: [{ type: 'text', text: output }],
            details: completed as unknown as Record<string, unknown>,
            terminate: true,
          };
        }
        return resultText(completed as unknown as Record<string, unknown>);
      }
      default:
        if (!grant.deliverableId || !grant.deliverableKind) {
          throw new Error(`Pi tool ${grant.tool.name} is missing a deliverable grant.`);
        }
        return this.executeDeliverable(
          grant.deliverableId,
          grant.deliverableKind,
          grant.tool,
          args,
        );
    }
  }

  private beginToolCall(
    toolCallId: string,
    toolName: string,
    args: ToolArguments,
  ): AgentToolCallRecord {
    const idempotencyKey = `pi:${this.identity.generationId ?? this.identity.taskId}:${toolCallId}`;
    const existing = this.projects.access(false, (database) =>
      createRepositories(database).agentToolCalls.getByIdempotencyKey(
        this.identity.taskId,
        idempotencyKey,
      ),
    );
    if (existing) {
      if (existing.status === 'succeeded' && existing.resultSummaryJson) {
        throw new DuplicatePiToolCall(existing.resultSummaryJson);
      }
      throw new Error('This Pi tool call is already executing or has already failed.');
    }
    const now = new Date().toISOString();
    const record: AgentToolCallRecord = {
      id: randomUUID(),
      taskId: this.identity.taskId,
      projectId: this.identity.projectId,
      toolName,
      normalizedArgumentsHash: hashAgentToolArguments(args),
      argumentsSummaryJson: JSON.stringify({ keys: Object.keys(args).sort(), runtime: 'pi' }),
      status: 'received',
      idempotencyKey,
      createdAt: now,
      version: 0,
      redactionState: 'native',
    };
    this.projects.access(true, (database) => {
      const repository = createRepositories(database).agentToolCalls;
      repository.save(record);
      const validated = { ...record, status: 'validated' as const, startedAt: now, version: 1 };
      repository.save(validated);
      repository.save({ ...validated, status: 'executing', version: 2 });
    });
    return { ...record, status: 'executing', startedAt: now, version: 2 };
  }

  private finishToolCall(
    call: AgentToolCallRecord,
    result: AgentToolResult<DomainToolResultV1 | Record<string, unknown>>,
  ): void {
    const summary =
      result.details && typeof result.details === 'object' ? result.details : { ok: true };
    this.projects.access(true, (database) => {
      createRepositories(database).agentToolCalls.save({
        ...call,
        status: 'succeeded',
        resultSummaryJson: JSON.stringify(summary),
        completedAt: new Date().toISOString(),
        version: call.version + 1,
      });
    });
  }

  private failToolCall(call: AgentToolCallRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.projects.access(true, (database) => {
      createRepositories(database).agentToolCalls.save({
        ...call,
        status: 'failed',
        errorCode: error instanceof DuplicatePiToolCall ? 'PI_TOOL_DUPLICATE' : 'PI_TOOL_FAILED',
        errorMessage: message.slice(0, 500),
        resultSummaryJson: JSON.stringify({ status: 'failed', retryable: false }),
        completedAt: new Date().toISOString(),
        version: call.version + 1,
      });
    });
  }

  private executeDeliverable(
    deliverableId: string,
    kind: ConversationDeliverableKind,
    definition: LlmToolDefinition,
    args: ToolArguments,
  ): AgentToolResult<DomainToolResultV1> {
    this.plans.beginDeliverable({
      taskId: this.identity.taskId,
      deliverableId,
      toolName: definition.name,
    });
    const entity = this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const task = database
          .prepare(
            `SELECT scope_type, scope_id, user_message_id, context_snapshot_id
             FROM agent_tasks WHERE id = ? AND project_id = ?`,
          )
          .get(this.identity.taskId, project.id) as
          | {
              scope_type: 'project' | 'scene' | 'shot';
              scope_id: string | null;
              user_message_id: string | null;
              context_snapshot_id: string | null;
            }
          | undefined;
        if (!task) throw new Error('Pi task no longer belongs to the current project.');
        if (definition.name === 'novel.episode.submit_structure') {
          const structure = parseStructure(args);
          const changeSet = this.changeSets.create({
            taskId: this.identity.taskId,
            title: structure.episodeTitle,
            items: structure.scenes.flatMap((scene, sceneIndex) => [
              {
                entityType: 'scene' as const,
                action: 'create' as const,
                title: scene.title,
              },
              ...scene.shots.map((shot) => ({
                entityType: 'shot' as const,
                action: 'create' as const,
                parentItemOrdinal: sceneIndex,
                title: shot.title,
                prompt: shot.prompt,
              })),
            ]),
          });
          return { entityType: 'change-set' as const, entityId: changeSet.id };
        }

        const title = requiredString(args.title, 'title', 200);
        const contentMarkdown = requiredString(args.contentMarkdown, 'contentMarkdown', 1_000_000);
        const document = this.documents.writePiAgentDraftInTransaction(database, project, {
          taskId: this.identity.taskId,
          title,
          contentMarkdown,
          kind: documentKindFor(kind, args.documentKind),
          scopeType: task.scope_type,
          scopeId: task.scope_id ?? undefined,
          sourceMessageId: task.user_message_id ?? this.identity.userMessageId,
          contextSnapshotId: task.context_snapshot_id ?? this.identity.contextSnapshotId,
        });
        if (kind === 'episode-outline') {
          database
            .prepare(
              `INSERT INTO document_bindings
               (id, project_id, document_id, role, domain_scope, status, row_version, created_at, updated_at)
               VALUES (lower(hex(randomblob(16))), ?, ?, 'screenplay', 'short-drama', 'active', 0, ?, ?)`,
            )
            .run(project.id, document.id, new Date().toISOString(), new Date().toISOString());
        }
        return { entityType: 'document' as const, entityId: document.id };
      })(),
    );
    const completed = this.plans.recordDeliverableSuccess({
      taskId: this.identity.taskId,
      deliverableId,
      entityType: entity.entityType,
      entityId: entity.entityId,
    });
    return {
      content: [{ type: 'text', text: unifiedAgentToolRegistry.serializeResult(completed) }],
      details: completed,
    };
  }

  /** Returns the current Worker-owned grants after a plan or deliverable turn. */
  refresh(): AgentTool[] {
    return this.tools(this.plans.availableToolGrants(this.identity.taskId));
  }
}

function resultText(
  value: Record<string, unknown>,
): AgentToolResult<DomainToolResultV1 | Record<string, unknown>> {
  return {
    content: [{ type: 'text', text: unifiedAgentToolRegistry.serializeResult(value) }],
    details: value,
  };
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function documentKindFor(
  kind: ConversationDeliverableKind,
  requested: unknown,
): 'outline' | 'plan' | 'character' | 'scene' | 'storyboard' | 'note' {
  if (kind === 'episode-outline') return 'plan';
  if (kind === 'character-prompts') return 'character';
  if (kind === 'scene-prompts') return 'scene';
  if (requested === undefined) return 'note';
  if (
    requested === 'outline' ||
    requested === 'plan' ||
    requested === 'character' ||
    requested === 'scene' ||
    requested === 'storyboard' ||
    requested === 'note'
  )
    return requested;
  throw new Error('documentKind is invalid.');
}

function parseStructure(args: ToolArguments): {
  episodeTitle: string;
  scenes: Array<{ title: string; shots: Array<{ title: string; prompt: string }> }>;
} {
  const episodeTitle = requiredString(args.episodeTitle, 'episodeTitle', 200);
  if (!Array.isArray(args.scenes) || args.scenes.length < 1 || args.scenes.length > 20) {
    throw new Error('scenes must contain between 1 and 20 items.');
  }
  const scenes = args.scenes.map((raw, sceneIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`scene ${sceneIndex} must be an object.`);
    }
    const scene = raw as Record<string, unknown>;
    if (Object.keys(scene).some((key) => !['title', 'shots'].includes(key))) {
      throw new Error(`scene ${sceneIndex} contains an unsupported field.`);
    }
    if (!Array.isArray(scene.shots) || scene.shots.length < 1 || scene.shots.length > 30) {
      throw new Error(`scene ${sceneIndex} shots must contain between 1 and 30 items.`);
    }
    return {
      title: requiredString(scene.title, `scene ${sceneIndex} title`, 200),
      shots: scene.shots.map((rawShot, shotIndex) => {
        if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) {
          throw new Error(`shot ${sceneIndex}.${shotIndex} must be an object.`);
        }
        const shot = rawShot as Record<string, unknown>;
        if (Object.keys(shot).some((key) => !['title', 'prompt'].includes(key))) {
          throw new Error(`shot ${sceneIndex}.${shotIndex} contains an unsupported field.`);
        }
        return {
          title: requiredString(shot.title, `shot ${sceneIndex}.${shotIndex} title`, 200),
          prompt: requiredString(shot.prompt, `shot ${sceneIndex}.${shotIndex} prompt`, 2_000),
        };
      }),
    };
  });
  return { episodeTitle, scenes };
}
