import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ConversationPackageCompleteResult,
  ConversationDeliverableKind,
  ConversationDeliverableStatus,
  ConversationTaskToolGrant,
  ConversationTaskPlanInfo,
  ConversationTaskPlanStatus,
  ConversationTaskPlan,
  ConversationTaskPlanV1,
  ConversationTaskPlanV2,
  ConversationTaskPlanErrorCode,
  ConversationTaskMode,
  ConversationTaskToolName,
  ConversationTargetPlatform,
  DomainToolResultV1,
} from '@ai-video/contracts';
import type {
  AgentTaskDeliverableRecord,
  AgentTaskDeliverableStatus,
  AgentTaskPlanRecord,
  AgentTaskPlanStatus,
} from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import {
  ConversationTaskPlanValidationError,
  validateConversationTaskPlan,
} from './request-validation.js';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

export class TaskPlanServiceError extends Error {
  constructor(
    readonly code: ConversationTaskPlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface FrozenTaskRow {
  id: string;
  project_id: string;
  project_session_id: string;
  conversation_id: string | null;
  request_snapshot_json: string;
  status: string;
}

interface FrozenShortDramaSnapshot {
  agentMode: 'short-drama';
  selectedChapterIds: string[];
  targetPlatform: ConversationTargetPlatform;
}

interface FrozenGenericPlanSnapshot {
  version: 2;
  mode: Exclude<ConversationTaskMode, 'short-drama'>;
  authorizedOperations: string[];
  requiredOperations: string[];
}

const deliverableTools: Record<
  ConversationDeliverableKind,
  'novel.episode.submit_draft' | 'document.create_draft' | 'novel.episode.submit_structure'
> = {
  'episode-outline': 'novel.episode.submit_draft',
  'character-prompts': 'document.create_draft',
  'scene-prompts': 'document.create_draft',
  'scene-shot-structure': 'novel.episode.submit_structure',
  'shot-prompts': 'novel.episode.submit_structure',
  'production-notes': 'document.create_draft',
};

export class TaskPlanService {
  constructor(
    private readonly projects: ProjectService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  planOnlyRound(
    taskId: string,
    userPrompt: string,
    mode: ConversationTaskMode = 'short-drama',
  ): {
    systemInstruction: string;
    tools: ConversationTaskToolGrant[];
  } {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const task = database
          .prepare(
            `SELECT id, project_id, project_session_id, conversation_id, request_snapshot_json, status
           FROM agent_tasks WHERE id = ? AND project_id = ?`,
          )
          .get(taskId, project.id) as FrozenTaskRow | undefined;
        if (!task || !['queued', 'running'].includes(task.status)) {
          throw new TaskPlanServiceError(
            task ? 'TASK_PLAN_INVALID_STATE' : 'TASK_PLAN_TASK_NOT_FOUND',
            task ? 'The task cannot enter its planning round.' : 'The task was not found.',
          );
        }
        if (createRepositories(database).agentTaskPlans.getByTask(task.id)) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The task already has a frozen plan.',
          );
        }
        if (mode !== 'short-drama') {
          const authorizedOperations = this.authorizedOperations(database, task.id);
          const requiredOperations = inferRequiredPlanOperations(userPrompt, authorizedOperations);
          if (requiredOperations.length < 2) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_INVALID_STATE',
              'The request does not contain enough authorized operations for a generic plan.',
            );
          }
          const planning: FrozenGenericPlanSnapshot = {
            version: 2,
            mode,
            authorizedOperations,
            requiredOperations,
          };
          const taskSnapshot = parseTaskSnapshot(task.request_snapshot_json);
          const existingPlanning = taskSnapshot.structuredPlan;
          if (
            existingPlanning !== undefined &&
            JSON.stringify(existingPlanning) !== JSON.stringify(planning)
          ) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_INVALID_STATE',
              'The task already has different frozen generic planning requirements.',
            );
          }
          if (existingPlanning === undefined) {
            database
              .prepare(
                `UPDATE agent_tasks SET request_snapshot_json = ?, row_version = row_version + 1
               WHERE id = ? AND project_id = ?`,
              )
              .run(
                JSON.stringify({ ...taskSnapshot, structuredPlan: planning }),
                task.id,
                project.id,
              );
          }
          return {
            systemInstruction: buildGenericPlanOnlyInstruction({
              userPrompt,
              authorizedOperations,
              requiredOperations,
            }),
            tools: [{ tool: genericPlanToolDefinition(authorizedOperations) }],
          };
        }
        const snapshot = this.readShortDramaSnapshot(task.request_snapshot_json);
        return {
          systemInstruction: buildPlanOnlyInstruction({
            userPrompt,
            targetPlatform: snapshot.targetPlatform,
            selectedChapterCount: snapshot.selectedChapterIds.length,
          }),
          tools: [{ tool: conversationTaskToolDefinition('task.plan.submit') }],
        };
      })(),
    );
  }

  submitPlanOnly(input: {
    taskId: string;
    candidate: unknown;
    idempotencyKey?: string;
  }): ConversationTaskPlanInfo {
    const frozen = this.submit(input);
    if (frozen.status === 'active') return frozen;
    return this.transitionPlan({
      planId: frozen.id,
      status: 'active',
      expectedRowVersion: 0,
    });
  }

  availableToolGrants(taskId: string): ConversationTaskToolGrant[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const plan = repositories.agentTaskPlans.getByTask(taskId);
      if (!plan || plan.projectId !== project.id) {
        throw new TaskPlanServiceError('TASK_PLAN_TASK_NOT_FOUND', 'Task plan was not found.');
      }
      if (plan.status !== 'active') return [];
      if (plan.version === 2) {
        return [{ tool: conversationTaskToolDefinition('task.package.complete') }];
      }
      if (plan.action === 'analyze') {
        return [{ tool: conversationTaskToolDefinition('task.package.complete') }];
      }
      const usedToolNames = new Set<string>();
      const grants = repositories.agentTaskDeliverables
        .listByPlan(plan.id)
        .filter((deliverable) => deliverable.status === 'ready')
        .flatMap((deliverable): ConversationTaskToolGrant[] => {
          const deliverableKind = deliverable.kind as ConversationDeliverableKind;
          const toolName = deliverableTools[deliverableKind];
          if (usedToolNames.has(toolName)) return [];
          usedToolNames.add(toolName);
          const tool = conversationTaskToolDefinition(toolName);
          tool.description = `${tool.description} Authorized deliverable: ${deliverable.kind}.`;
          return [
            {
              deliverableId: deliverable.id,
              deliverableKind,
              tool: { ...tool, name: toolName },
            },
          ];
        });
      grants.push({ tool: conversationTaskToolDefinition('task.package.complete') });
      return grants;
    });
  }

  beginDeliverable(input: {
    taskId: string;
    deliverableId: string;
    toolName: string;
  }): ConversationTaskPlanInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.getByTask(input.taskId);
        const deliverable = repositories.agentTaskDeliverables.get(input.deliverableId);
        if (
          !plan ||
          plan.projectId !== project.id ||
          plan.status !== 'active' ||
          !deliverable ||
          deliverable.planId !== plan.id ||
          deliverable.projectId !== project.id
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DELIVERABLE_NOT_READY',
            'The deliverable is not available for this task.',
          );
        }
        if (deliverable.status === 'succeeded') {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DUPLICATE_COMPLETION',
            'The deliverable has already succeeded.',
          );
        }
        if (deliverable.status !== 'ready' || deliverable.operation !== input.toolName) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DELIVERABLE_NOT_READY',
            'The tool is not authorized for this deliverable state.',
          );
        }
        this.assertDependenciesSucceeded(
          repositories.agentTaskDeliverables.listByPlan(plan.id),
          deliverable,
        );
        if (
          !repositories.agentTaskDeliverables.updateStatus(
            deliverable.id,
            'in_progress',
            this.now(),
            deliverable.rowVersion,
          )
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The deliverable changed before execution started.',
          );
        }
        return this.toInfo(plan, repositories.agentTaskDeliverables.listByPlan(plan.id));
      })(),
    );
  }

  availableOperations(taskId: string): string[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const plan = repositories.agentTaskPlans.getByTask(taskId);
      if (!plan || plan.projectId !== project.id || plan.version !== 2) {
        throw new TaskPlanServiceError(
          'TASK_PLAN_TASK_NOT_FOUND',
          'Generic task plan was not found.',
        );
      }
      if (plan.status !== 'active') return [];
      return [
        ...new Set(
          repositories.agentTaskDeliverables
            .listByPlan(plan.id)
            .filter((step) => step.status === 'ready')
            .map((step) => step.operation),
        ),
      ];
    });
  }

  beginStep(input: { taskId: string; operation: string }): string {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.getByTask(input.taskId);
        if (
          !plan ||
          plan.projectId !== project.id ||
          plan.version !== 2 ||
          plan.status !== 'active'
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DELIVERABLE_NOT_READY',
            'The generic plan step is not available for this task.',
          );
        }
        const all = repositories.agentTaskDeliverables.listByPlan(plan.id);
        const step = all.find(
          (candidate) => candidate.status === 'ready' && candidate.operation === input.operation,
        );
        if (!step) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DELIVERABLE_NOT_READY',
            `Operation ${input.operation} is not ready in the frozen plan.`,
          );
        }
        this.assertDependenciesSucceeded(all, step);
        if (
          !repositories.agentTaskDeliverables.updateStatus(
            step.id,
            'in_progress',
            this.now(),
            step.rowVersion,
          )
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The generic plan step changed before execution started.',
          );
        }
        return step.id;
      })(),
    );
  }

  recordStepSuccess(input: {
    taskId: string;
    stepId: string;
    operation: string;
    resultText: string;
  }): boolean {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.getByTask(input.taskId);
        const step = repositories.agentTaskDeliverables.get(input.stepId);
        if (
          !plan ||
          plan.projectId !== project.id ||
          plan.version !== 2 ||
          plan.status !== 'active' ||
          !step ||
          step.planId !== plan.id ||
          step.operation !== input.operation ||
          step.status !== 'in_progress'
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DELIVERABLE_NOT_READY',
            'The generic plan step is not executing.',
          );
        }
        const result = parseToolResult(input.resultText);
        if (isUnsuccessfulToolResult(result)) {
          this.failStep(database, plan, step, `Tool returned status ${String(result.status)}.`);
          return false;
        }
        const now = this.now();
        const completed = database
          .prepare(
            `UPDATE agent_task_deliverables
             SET status = 'succeeded', result_summary_json = ?, error_code = NULL,
                 error_message = NULL, updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND plan_id = ? AND status = 'in_progress' AND row_version = ?`,
          )
          .run(input.resultText, now, step.id, plan.id, step.rowVersion);
        if (completed.changes !== 1) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The generic plan step changed before its result was recorded.',
          );
        }
        this.refreshReadyDeliverables(database, plan.id, now);
        this.appendTaskEvent(
          database,
          project.id,
          input.taskId,
          'task.plan.step.succeeded',
          `Plan step ${step.kind} succeeded.`,
          { stepId: step.kind, operation: step.operation },
          now,
        );
        return true;
      })(),
    );
  }

  recordStepFailure(input: {
    taskId: string;
    stepId: string;
    operation: string;
    error: unknown;
  }): void {
    this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.getByTask(input.taskId);
        const step = repositories.agentTaskDeliverables.get(input.stepId);
        if (
          !plan ||
          plan.projectId !== project.id ||
          plan.version !== 2 ||
          !step ||
          step.planId !== plan.id ||
          step.operation !== input.operation ||
          step.status !== 'in_progress'
        ) {
          return;
        }
        this.failStep(
          database,
          plan,
          step,
          input.error instanceof Error ? input.error.message : String(input.error),
        );
      })(),
    );
  }

  recordDeliverableSuccess(input: {
    taskId: string;
    deliverableId: string;
    entityType: 'document' | 'change-set' | 'task';
    entityId: string;
  }): DomainToolResultV1 {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.getByTask(input.taskId);
        const deliverable = repositories.agentTaskDeliverables.get(input.deliverableId);
        if (
          !plan ||
          plan.projectId !== project.id ||
          plan.version !== 1 ||
          !deliverable ||
          deliverable.planId !== plan.id
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_TASK_NOT_FOUND',
            'The task deliverable was not found.',
          );
        }
        if (deliverable.status === 'succeeded') {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DUPLICATE_COMPLETION',
            'The deliverable has already succeeded.',
          );
        }
        if (plan.status !== 'active' || deliverable.status !== 'in_progress') {
          throw new TaskPlanServiceError(
            'TASK_PLAN_DELIVERABLE_NOT_READY',
            'The deliverable is not executing.',
          );
        }
        this.assertEntityOwnership(
          database,
          project.id,
          input.taskId,
          input.entityType,
          input.entityId,
        );
        const now = this.now();
        const completed = database
          .prepare(
            `UPDATE agent_task_deliverables
             SET status = 'succeeded', entity_type = ?, entity_id = ?, error_code = NULL,
                 error_message = NULL, updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND plan_id = ? AND status = 'in_progress' AND row_version = ?`,
          )
          .run(
            input.entityType,
            input.entityId,
            now,
            deliverable.id,
            plan.id,
            deliverable.rowVersion,
          );
        if (completed.changes !== 1) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The deliverable changed before its result was recorded.',
          );
        }
        this.refreshReadyDeliverables(database, plan.id, now);
        const all = repositories.agentTaskDeliverables.listByPlan(plan.id);
        const remaining = requiredMissing(all);
        this.appendTaskEvent(
          database,
          project.id,
          input.taskId,
          'task.deliverable.succeeded',
          `Deliverable ${deliverable.kind} succeeded.`,
          { deliverable: deliverable.kind, entityType: input.entityType, entityId: input.entityId },
          now,
        );
        return {
          version: 1 as const,
          status: 'succeeded' as const,
          deliverable: deliverable.kind as ConversationDeliverableKind,
          entityType: input.entityType,
          entityId: input.entityId,
          summary: `Deliverable ${deliverable.kind} succeeded.`,
          remainingRequiredDeliverables: remaining,
          retryable: false,
        };
      })(),
    );
  }

  completePackage(taskId: string): ConversationPackageCompleteResult {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.getByTask(taskId);
        if (!plan || plan.projectId !== project.id || plan.status !== 'active') {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The task package is not active.',
          );
        }
        const deliverables = repositories.agentTaskDeliverables.listByPlan(plan.id);
        const missing = requiredMissing(deliverables);
        const now = this.now();
        if (missing.length > 0) {
          const followUpCount = (
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM agent_task_events
                 WHERE task_id = ? AND event_type = 'task.package.follow_up_requested'`,
              )
              .get(taskId) as { count: number }
          ).count;
          if (followUpCount >= 2) {
            const failedPlan = repositories.agentTaskPlans.updateStatus(
              plan.id,
              'failed',
              now,
              plan.rowVersion,
            );
            const failedTask = database
              .prepare(
                `UPDATE agent_tasks SET status = 'failed', retryable = 1,
                 error_code = 'TASK_PACKAGE_FOLLOW_UP_LIMIT',
                 error_message = ?, completed_at = ?, updated_at = ?, row_version = row_version + 1
                 WHERE id = ? AND project_id = ? AND status = 'running'`,
              )
              .run(
                `Required deliverables remain incomplete: ${missing.join(', ')}.`,
                now,
                now,
                taskId,
                project.id,
              );
            if (!failedPlan || failedTask.changes !== 1) {
              throw new TaskPlanServiceError(
                'TASK_PLAN_INVALID_STATE',
                'The task changed before the follow-up limit could be recorded.',
              );
            }
            this.appendTaskEvent(
              database,
              project.id,
              taskId,
              'task.package.follow_up_exhausted',
              'Required deliverables remain incomplete after two follow-up rounds.',
              { missingDeliverables: missing },
              now,
            );
            return {
              complete: false as const,
              taskStatus: 'failed' as const,
              errorCode: 'TASK_PACKAGE_FOLLOW_UP_LIMIT' as const,
            };
          }
          const ordinal = (followUpCount + 1) as 1 | 2;
          const prompt = buildMissingDeliverablesFollowUp(missing);
          this.reactivateFailedSteps(database, plan.id, now);
          this.appendTaskEvent(
            database,
            project.id,
            taskId,
            'task.package.follow_up_requested',
            `Follow-up ${ordinal} requested for missing deliverables.`,
            { ordinal, missingDeliverables: missing },
            now,
          );
          return {
            complete: false as const,
            followUp: { ordinal, prompt, missingDeliverables: missing },
          };
        }
        for (const deliverable of deliverables.filter(
          (item) => plan.version === 1 && item.required,
        )) {
          if (!deliverable.entityType || !deliverable.entityId) {
            throw new TaskPlanServiceError(
              'TASK_PACKAGE_ENTITY_INVALID',
              `Deliverable ${deliverable.kind} has no durable entity.`,
            );
          }
          this.assertEntityOwnership(
            database,
            project.id,
            taskId,
            deliverable.entityType,
            deliverable.entityId,
          );
        }
        if (!repositories.agentTaskPlans.updateStatus(plan.id, 'succeeded', now, plan.rowVersion)) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The task plan changed before completion.',
          );
        }
        const taskStatus: 'completed' | 'waiting_review' =
          plan.version === 2
            ? genericPlanRequiresReview(deliverables)
              ? 'waiting_review'
              : 'completed'
            : plan.action === 'analyze'
              ? 'completed'
              : 'waiting_review';
        const updatedTask =
          taskStatus === 'completed'
            ? database
                .prepare(
                  `UPDATE agent_tasks SET status = 'completed', completed_at = ?, updated_at = ?,
                   row_version = row_version + 1
                   WHERE id = ? AND project_id = ? AND status = 'running'`,
                )
                .run(now, now, taskId, project.id)
            : database
                .prepare(
                  `UPDATE agent_tasks SET status = 'waiting_review', phase = 'waiting_review',
                   updated_at = ?, row_version = row_version + 1
                   WHERE id = ? AND project_id = ? AND status = 'running'`,
                )
                .run(now, taskId, project.id);
        if (updatedTask.changes !== 1) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'The task changed before package completion.',
          );
        }
        this.appendTaskEvent(
          database,
          project.id,
          taskId,
          'task.package.completed',
          'All required task deliverables succeeded.',
          { taskStatus },
          now,
        );
        return { complete: true as const, taskStatus };
      })(),
    );
  }

  submit(input: {
    taskId: string;
    candidate: unknown;
    idempotencyKey?: string;
  }): ConversationTaskPlanInfo {
    let plan: ConversationTaskPlan;
    try {
      plan = validateConversationTaskPlan(input.candidate);
    } catch (error) {
      if (error instanceof ConversationTaskPlanValidationError) throw error;
      throw new TaskPlanServiceError('TASK_PLAN_INVALID_TYPE', 'Task plan validation failed.');
    }
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const task = database
          .prepare(
            `SELECT id, project_id, project_session_id, conversation_id, request_snapshot_json, status
             FROM agent_tasks WHERE id = ? AND project_id = ?`,
          )
          .get(input.taskId, project.id) as FrozenTaskRow | undefined;
        if (!task) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_TASK_NOT_FOUND',
            'The task does not belong to the current project.',
          );
        }
        if (!['queued', 'running'].includes(task.status)) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'Only queued or running tasks may freeze a task plan.',
          );
        }
        const shortDramaSnapshot =
          plan.version === 1 ? this.readShortDramaSnapshot(task.request_snapshot_json) : undefined;
        const genericSnapshot =
          plan.version === 2 ? this.readGenericPlanSnapshot(task.request_snapshot_json) : undefined;
        if (plan.version === 1) {
          if (plan.mode !== shortDramaSnapshot!.agentMode) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_TASK_MODE_MISMATCH',
              'The proposed plan mode does not match the frozen task mode.',
            );
          }
          if (plan.targetPlatform !== shortDramaSnapshot!.targetPlatform) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_PLATFORM_MISMATCH',
              'The proposed target platform does not match the frozen user selection.',
            );
          }
          assertSeedanceDeliverableContract(plan);
          this.assertChapterScope(database, project.id, shortDramaSnapshot!.selectedChapterIds);
        } else {
          this.assertGenericPlanContract(plan, genericSnapshot!);
        }

        const planJson = JSON.stringify(plan);
        const planHash = createHash('sha256').update(planJson, 'utf8').digest('hex');
        const repositories = createRepositories(database);
        const existing = repositories.agentTaskPlans.getByTask(task.id);
        if (existing) {
          if (existing.planHash !== planHash) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_IDEMPOTENCY_CONFLICT',
              'This task already has a different frozen plan.',
            );
          }
          return this.toInfo(existing, repositories.agentTaskDeliverables.listByPlan(existing.id));
        }
        if (input.idempotencyKey) {
          const reused = database
            .prepare(
              `SELECT task_id FROM agent_task_plans
               WHERE project_id = ? AND idempotency_key = ?`,
            )
            .get(project.id, input.idempotencyKey) as { task_id: string } | undefined;
          if (reused) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_IDEMPOTENCY_CONFLICT',
              'The task plan idempotency key was already used by another task.',
            );
          }
        }

        const now = this.now();
        const record: AgentTaskPlanRecord = {
          id: randomUUID(),
          taskId: task.id,
          projectId: project.id,
          version: plan.version,
          mode: plan.version === 1 ? plan.mode : genericSnapshot!.mode,
          action: plan.version === 1 ? plan.action : actionForGenericPlan(plan),
          targetPlatform: plan.version === 1 ? plan.targetPlatform : undefined,
          planJson,
          trustedScopeJson: JSON.stringify({
            version: 1,
            projectId: project.id,
            projectSessionId: task.project_session_id,
            conversationId: task.conversation_id,
            taskId: task.id,
            selectedChapterIds: shortDramaSnapshot?.selectedChapterIds ?? [],
            ...(genericSnapshot
              ? {
                  authorizedOperations: genericSnapshot.authorizedOperations,
                  requiredOperations: genericSnapshot.requiredOperations,
                }
              : {}),
          }),
          planHash,
          status: 'frozen',
          idempotencyKey: input.idempotencyKey,
          rowVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
        repositories.agentTaskPlans.save(record);
        const planItems =
          plan.version === 1
            ? plan.deliverables.map((deliverable) => ({
                kind: deliverable.kind,
                operation: deliverableTools[deliverable.kind],
                required: deliverable.required,
                dependsOn: deliverable.dependsOn,
              }))
            : plan.steps.map((step) => ({
                kind: step.id,
                operation: step.operation,
                required: step.required,
                dependsOn: step.dependsOn,
              }));
        const deliverables = planItems.map((deliverable, ordinal) => {
          const item: AgentTaskDeliverableRecord = {
            id: randomUUID(),
            planId: record.id,
            taskId: task.id,
            projectId: project.id,
            ordinal,
            kind: deliverable.kind,
            operation: deliverable.operation,
            required: deliverable.required,
            dependsOnJson: JSON.stringify(deliverable.dependsOn),
            status: deliverable.dependsOn.length === 0 ? 'ready' : 'pending',
            rowVersion: 0,
            createdAt: now,
            updatedAt: now,
          };
          repositories.agentTaskDeliverables.save(item);
          return item;
        });
        return this.toInfo(record, deliverables);
      })(),
    );
  }

  getByTask(taskId: string): ConversationTaskPlanInfo | undefined {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const plan = repositories.agentTaskPlans.getByTask(taskId);
      if (!plan || plan.projectId !== project.id) return undefined;
      return this.toInfo(plan, repositories.agentTaskDeliverables.listByPlan(plan.id));
    });
  }

  transitionPlan(input: {
    planId: string;
    status: ConversationTaskPlanStatus;
    expectedRowVersion: number;
  }): ConversationTaskPlanInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const plan = repositories.agentTaskPlans.get(input.planId);
        if (!plan || plan.projectId !== project.id) {
          throw new TaskPlanServiceError('TASK_PLAN_TASK_NOT_FOUND', 'Task plan was not found.');
        }
        assertPlanStatusTransition(plan.status, input.status);
        if (
          !repositories.agentTaskPlans.updateStatus(
            plan.id,
            input.status,
            this.now(),
            input.expectedRowVersion,
          )
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'Task plan changed before the status transition could be applied.',
          );
        }
        const updated = repositories.agentTaskPlans.get(plan.id)!;
        return this.toInfo(updated, repositories.agentTaskDeliverables.listByPlan(plan.id));
      })(),
    );
  }

  transitionDeliverable(input: {
    deliverableId: string;
    status: ConversationDeliverableStatus;
    expectedRowVersion: number;
  }): ConversationTaskPlanInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const deliverable = repositories.agentTaskDeliverables.get(input.deliverableId);
        if (!deliverable || deliverable.projectId !== project.id) {
          throw new TaskPlanServiceError('TASK_PLAN_TASK_NOT_FOUND', 'Deliverable was not found.');
        }
        assertDeliverableStatusTransition(deliverable.status, input.status);
        if (input.status === 'in_progress') {
          const all = repositories.agentTaskDeliverables.listByPlan(deliverable.planId);
          const byKind = new Map(all.map((item) => [item.kind, item.status]));
          const dependencies = JSON.parse(deliverable.dependsOnJson) as string[];
          if (dependencies.some((kind) => byKind.get(kind) !== 'succeeded')) {
            throw new TaskPlanServiceError(
              'TASK_PLAN_INVALID_STATE',
              'Deliverable dependencies have not succeeded.',
            );
          }
        }
        if (
          !repositories.agentTaskDeliverables.updateStatus(
            deliverable.id,
            input.status,
            this.now(),
            input.expectedRowVersion,
          )
        ) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_INVALID_STATE',
            'Deliverable changed before the status transition could be applied.',
          );
        }
        const plan = repositories.agentTaskPlans.get(deliverable.planId)!;
        return this.toInfo(plan, repositories.agentTaskDeliverables.listByPlan(plan.id));
      })(),
    );
  }

  private assertDependenciesSucceeded(
    all: AgentTaskDeliverableRecord[],
    deliverable: AgentTaskDeliverableRecord,
  ): void {
    const byKind = new Map(all.map((item) => [item.kind, item.status]));
    const dependencies = JSON.parse(deliverable.dependsOnJson) as string[];
    if (dependencies.some((kind) => byKind.get(kind) !== 'succeeded')) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_DELIVERABLE_NOT_READY',
        'Deliverable dependencies have not succeeded.',
      );
    }
  }

  private refreshReadyDeliverables(database: Database.Database, planId: string, now: string): void {
    const repositories = createRepositories(database);
    const all = repositories.agentTaskDeliverables.listByPlan(planId);
    const byKind = new Map(all.map((item) => [item.kind, item.status]));
    for (const deliverable of all) {
      if (deliverable.status !== 'pending' && deliverable.status !== 'blocked') continue;
      const dependencies = JSON.parse(deliverable.dependsOnJson) as string[];
      if (dependencies.every((kind) => byKind.get(kind) === 'succeeded')) {
        repositories.agentTaskDeliverables.updateStatus(
          deliverable.id,
          'ready',
          now,
          deliverable.rowVersion,
        );
      }
    }
  }

  private assertEntityOwnership(
    database: Database.Database,
    projectId: string,
    taskId: string,
    entityType: 'document' | 'change-set' | 'task',
    entityId: string,
  ): void {
    let owned = false;
    if (entityType === 'document') {
      owned = Boolean(
        database
          .prepare(
            `SELECT 1 FROM documents
             INNER JOIN agent_task_document_versions links ON links.document_id = documents.id
             WHERE documents.id = ? AND documents.project_id = ? AND links.task_id = ? LIMIT 1`,
          )
          .get(entityId, projectId, taskId),
      );
    } else if (entityType === 'change-set') {
      owned = Boolean(
        database
          .prepare(
            `SELECT 1 FROM agent_change_sets
             WHERE id = ? AND project_id = ? AND task_id = ?`,
          )
          .get(entityId, projectId, taskId),
      );
    } else {
      owned =
        entityId === taskId &&
        Boolean(
          database
            .prepare('SELECT 1 FROM agent_tasks WHERE id = ? AND project_id = ?')
            .get(taskId, projectId),
        );
    }
    if (!owned) {
      throw new TaskPlanServiceError(
        'TASK_PACKAGE_ENTITY_INVALID',
        'The deliverable entity does not belong to the current project and task.',
      );
    }
  }

  private appendTaskEvent(
    database: Database.Database,
    projectId: string,
    taskId: string,
    eventType: string,
    summary: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    const sequence = (
      database
        .prepare(
          'SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM agent_task_events WHERE task_id = ?',
        )
        .get(taskId) as { value: number }
    ).value;
    database
      .prepare(
        `INSERT INTO agent_task_events
         (id, task_id, project_id, sequence, event_type, level, actor_type, summary,
          payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'info', 'worker', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        projectId,
        sequence,
        eventType,
        summary,
        JSON.stringify(payload),
        createdAt,
      );
  }

  private authorizedOperations(database: Database.Database, taskId: string): string[] {
    const rows = database
      .prepare(
        `SELECT DISTINCT allowed_operation AS operation
         FROM agent_tool_authorizations
         WHERE task_id = ? AND status = 'issued'
         ORDER BY allowed_operation`,
      )
      .all(taskId) as Array<{ operation: string }>;
    return rows.map((row) => row.operation).filter((operation) => !operation.startsWith('task.'));
  }

  private readGenericPlanSnapshot(value: string): FrozenGenericPlanSnapshot {
    const snapshot = parseTaskSnapshot(value);
    const planning = snapshot.structuredPlan;
    if (!planning || typeof planning !== 'object' || Array.isArray(planning)) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_SCOPE_INVALID',
        'The task does not contain frozen generic planning requirements.',
      );
    }
    const candidate = planning as Record<string, unknown>;
    const validAuthorizedOperations = (operations: unknown): operations is string[] =>
      Array.isArray(operations) &&
      operations.length >= 1 &&
      operations.length <= 100 &&
      operations.every(
        (operation) =>
          typeof operation === 'string' && operation.length >= 2 && operation.length <= 128,
      ) &&
      new Set(operations).size === operations.length;
    const validRequiredOperations = (operations: unknown): operations is string[] =>
      Array.isArray(operations) &&
      operations.length >= 2 &&
      operations.length <= 12 &&
      operations.every(
        (operation) =>
          typeof operation === 'string' && operation.length >= 2 && operation.length <= 128,
      );
    const authorizedOperations = candidate.authorizedOperations;
    const requiredOperations = candidate.requiredOperations;
    if (
      candidate.version !== 2 ||
      (candidate.mode !== 'document' && candidate.mode !== 'novel-writing') ||
      !validAuthorizedOperations(authorizedOperations) ||
      !validRequiredOperations(requiredOperations)
    ) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_SCOPE_INVALID',
        'The frozen generic planning requirements are invalid.',
      );
    }
    if (!requiredOperations.every((operation) => authorizedOperations.includes(operation))) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_SCOPE_INVALID',
        'The frozen generic planning requirements are invalid.',
      );
    }
    return {
      version: 2,
      mode: candidate.mode,
      authorizedOperations: [...authorizedOperations],
      requiredOperations: [...requiredOperations],
    };
  }

  private assertGenericPlanContract(
    plan: ConversationTaskPlanV2,
    snapshot: FrozenGenericPlanSnapshot,
  ): void {
    const authorized = new Set(snapshot.authorizedOperations);
    for (const step of plan.steps) {
      if (
        !authorized.has(step.operation) ||
        step.operation === 'task.plan.submit' ||
        step.operation === 'task.package.complete'
      ) {
        throw new TaskPlanServiceError(
          'TASK_PLAN_OPERATION_UNAUTHORIZED',
          `Plan operation ${step.operation} is not authorized for this task.`,
        );
      }
      unifiedAgentToolRegistry.require(step.operation);
    }
    const requiredSteps = plan.steps.filter((step) => step.required);
    const requiredCounts = new Map<string, number>();
    const stepCounts = new Map<string, number>();
    for (const operation of snapshot.requiredOperations) {
      requiredCounts.set(operation, (requiredCounts.get(operation) ?? 0) + 1);
    }
    for (const step of requiredSteps) {
      stepCounts.set(step.operation, (stepCounts.get(step.operation) ?? 0) + 1);
    }
    for (const [operation, count] of requiredCounts) {
      if ((stepCounts.get(operation) ?? 0) < count) {
        throw new TaskPlanServiceError(
          'TASK_PLAN_REQUIRED_OPERATION_MISSING',
          `The plan omitted required operation ${operation}.`,
        );
      }
    }
    if (!matchRequiredStepSequence(plan.steps, requiredSteps, snapshot.requiredOperations)) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_INVALID_DEPENDENCY',
        'The required operation sequence is not represented by distinct dependency-ordered steps.',
      );
    }
  }

  private failStep(
    database: Database.Database,
    plan: AgentTaskPlanRecord,
    step: AgentTaskDeliverableRecord,
    message: string,
  ): void {
    const now = this.now();
    const bounded = message.normalize('NFC').slice(0, 500);
    database
      .prepare(
        `UPDATE agent_task_deliverables
         SET status = 'failed', error_code = 'TOOL_EXECUTION_FAILED', error_message = ?,
             updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND plan_id = ? AND status = 'in_progress' AND row_version = ?`,
      )
      .run(bounded, now, step.id, plan.id, step.rowVersion);
    this.appendTaskEvent(
      database,
      plan.projectId,
      plan.taskId,
      'task.plan.step.failed',
      `Plan step ${step.kind} failed.`,
      { stepId: step.kind, operation: step.operation },
      now,
    );
  }

  private reactivateFailedSteps(database: Database.Database, planId: string, now: string): void {
    const repositories = createRepositories(database);
    const all = repositories.agentTaskDeliverables.listByPlan(planId);
    const byKind = new Map(all.map((item) => [item.kind, item.status]));
    for (const step of all) {
      if (step.status !== 'failed' && step.status !== 'blocked') continue;
      const dependencies = JSON.parse(step.dependsOnJson) as string[];
      if (dependencies.every((dependency) => byKind.get(dependency) === 'succeeded')) {
        repositories.agentTaskDeliverables.updateStatus(step.id, 'ready', now, step.rowVersion);
      }
    }
  }

  private readShortDramaSnapshot(value: string): FrozenShortDramaSnapshot {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw new TaskPlanServiceError(
        'TASK_PLAN_SCOPE_INVALID',
        'The frozen task snapshot is not valid JSON.',
      );
    }
    if (
      snapshot.agentMode !== 'short-drama' ||
      !['seedance', 'generic-video', 'generic-image'].includes(snapshot.targetPlatform as string) ||
      !Array.isArray(snapshot.selectedChapterIds) ||
      snapshot.selectedChapterIds.length < 1 ||
      snapshot.selectedChapterIds.length > 50 ||
      snapshot.selectedChapterIds.some(
        (id) => typeof id !== 'string' || !id.trim() || id.length > 128,
      ) ||
      new Set(snapshot.selectedChapterIds).size !== snapshot.selectedChapterIds.length
    ) {
      throw new TaskPlanServiceError(
        snapshot.agentMode === 'short-drama'
          ? 'TASK_PLAN_SCOPE_INVALID'
          : 'TASK_PLAN_TASK_MODE_MISMATCH',
        'The task does not contain a valid frozen short-drama chapter scope.',
      );
    }
    return {
      agentMode: 'short-drama',
      selectedChapterIds: [...(snapshot.selectedChapterIds as string[])],
      targetPlatform: snapshot.targetPlatform as ConversationTargetPlatform,
    };
  }

  private assertChapterScope(
    database: Database.Database,
    projectId: string,
    selectedChapterIds: string[],
  ): void {
    const placeholders = selectedChapterIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT id FROM novel_chapters
         WHERE project_id = ? AND lifecycle_status = 'active' AND id IN (${placeholders})`,
      )
      .all(projectId, ...selectedChapterIds) as Array<{ id: string }>;
    if (rows.length !== selectedChapterIds.length) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_SCOPE_INVALID',
        'One or more frozen chapter IDs do not belong to the current project.',
      );
    }
  }

  private toInfo(
    plan: AgentTaskPlanRecord,
    deliverables: AgentTaskDeliverableRecord[],
  ): ConversationTaskPlanInfo {
    const parsedPlan = JSON.parse(plan.planJson) as ConversationTaskPlan;
    const trusted = JSON.parse(plan.trustedScopeJson) as {
      selectedChapterIds?: string[];
      authorizedOperations?: string[];
      requiredOperations?: string[];
    };
    return {
      id: plan.id,
      taskId: plan.taskId,
      projectId: plan.projectId,
      plan: parsedPlan,
      trustedScope: {
        selectedChapterIds: [...(trusted.selectedChapterIds ?? [])],
        ...(trusted.authorizedOperations
          ? { authorizedOperations: [...trusted.authorizedOperations] }
          : {}),
        ...(trusted.requiredOperations
          ? { requiredOperations: [...trusted.requiredOperations] }
          : {}),
      },
      status: plan.status,
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        kind: deliverable.kind,
        operation: deliverable.operation,
        required: deliverable.required,
        dependsOn: JSON.parse(deliverable.dependsOnJson) as string[],
        status: deliverable.status,
      })),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
}

function conversationTaskToolDefinition(
  name: ConversationTaskToolName,
): ConversationTaskToolGrant['tool'] {
  return { ...unifiedAgentToolRegistry.definition(name), name };
}

function genericPlanToolDefinition(
  authorizedOperations: string[],
): ConversationTaskToolGrant['tool'] {
  return {
    name: 'task.plan.submit',
    description:
      'Submit the complete generic dependency plan. This is the only tool available during the planning round.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'steps', 'constraints'],
      properties: {
        version: { const: 2 },
        steps: {
          type: 'array',
          minItems: 2,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'operation', 'required', 'dependsOn', 'constraints'],
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
              operation: { enum: authorizedOperations },
              required: { type: 'boolean' },
              dependsOn: {
                type: 'array',
                maxItems: 11,
                items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
              },
              constraints: {
                type: 'array',
                maxItems: 10,
                items: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
          },
        },
        constraints: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  };
}

const planTransitions: Record<AgentTaskPlanStatus, ReadonlySet<AgentTaskPlanStatus>> = {
  frozen: new Set(['frozen', 'active', 'failed', 'cancelled']),
  active: new Set(['active', 'succeeded', 'failed', 'cancelled']),
  failed: new Set(['failed', 'active', 'cancelled']),
  succeeded: new Set(['succeeded']),
  cancelled: new Set(['cancelled']),
};

const deliverableTransitions: Record<
  AgentTaskDeliverableStatus,
  ReadonlySet<AgentTaskDeliverableStatus>
> = {
  pending: new Set(['pending', 'ready', 'blocked', 'cancelled']),
  ready: new Set(['ready', 'in_progress', 'blocked', 'cancelled']),
  in_progress: new Set(['in_progress', 'succeeded', 'failed', 'blocked', 'cancelled']),
  failed: new Set(['failed', 'ready', 'cancelled']),
  blocked: new Set(['blocked', 'ready', 'cancelled']),
  succeeded: new Set(['succeeded']),
  cancelled: new Set(['cancelled']),
};

export function assertPlanStatusTransition(
  current: AgentTaskPlanStatus,
  next: AgentTaskPlanStatus,
): void {
  if (!planTransitions[current].has(next)) {
    throw new TaskPlanServiceError(
      'TASK_PLAN_INVALID_STATE',
      `Invalid task plan status transition: ${current} -> ${next}.`,
    );
  }
}

export function assertDeliverableStatusTransition(
  current: AgentTaskDeliverableStatus,
  next: AgentTaskDeliverableStatus,
): void {
  if (!deliverableTransitions[current].has(next)) {
    throw new TaskPlanServiceError(
      'TASK_PLAN_INVALID_STATE',
      `Invalid deliverable status transition: ${current} -> ${next}.`,
    );
  }
}

export function buildPlanOnlyInstruction(input: {
  userPrompt: string;
  targetPlatform: ConversationTargetPlatform;
  selectedChapterCount: number;
}): string {
  const expectedSeedancePlan =
    input.targetPlatform === 'seedance'
      ? `For this Seedance short-drama request, include these four required deliverables exactly once:\n` +
        `1. episode-outline (dependsOn: [])\n` +
        `2. character-prompts (dependsOn: [])\n` +
        `3. scene-shot-structure (dependsOn: [episode-outline, character-prompts])\n` +
        `4. shot-prompts (dependsOn: [scene-shot-structure])\n`
      : '';
  return [
    'You are in a plan-only round for a short-drama task.',
    'Your only available tool is task.plan.submit. Call it exactly once with the complete plan.',
    'Do not create deliverables, call business tools, or claim that the task is complete in this round.',
    `The Worker-frozen target platform is ${input.targetPlatform}. Copy it exactly into targetPlatform.`,
    `The Worker has frozen ${input.selectedChapterCount} selected chapter(s). Do not provide or infer chapter IDs.`,
    'Never include authority or secret fields such as projectId, projectSessionId, sessionId, conversationId, taskId, chapterIds, selectedChapterIds, documentId, path, localPath, filePath, providerProfileId, providerCredential, credential, or secret.',
    expectedSeedancePlan.trim(),
    'Original user request:',
    input.userPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildGenericPlanOnlyInstruction(input: {
  userPrompt: string;
  authorizedOperations: string[];
  requiredOperations: string[];
}): string {
  return [
    'You are in a plan-only round for a generic multi-step task.',
    'Your only available tool is task.plan.submit. Call it exactly once with a version 2 plan.',
    'Each step needs a stable lowercase id, one exact authorized operation, required, dependsOn, and bounded constraints.',
    'Do not call business tools, invent authority fields, include credentials or paths, or claim completion in this round.',
    `Worker-authorized operations: ${input.authorizedOperations.join(', ')}.`,
    `Required operation order: ${input.requiredOperations.join(' -> ')}. Every later required operation must depend transitively on the previous one.`,
    'Original user request:',
    input.userPrompt,
  ].join('\n\n');
}

export function shouldRequireStructuredPlan(
  mode: ConversationTaskMode,
  userPrompt: string,
  authorizedOperations: readonly string[],
): boolean {
  if (mode === 'short-drama') return true;
  return inferRequiredPlanOperations(userPrompt, authorizedOperations).length >= 2;
}

export function inferRequiredPlanOperations(
  userPrompt: string,
  authorizedOperations: readonly string[],
): string[] {
  const prompt = userPrompt.normalize('NFKC').toLowerCase();
  const authorized = new Set(authorizedOperations);
  const matches: Array<{ operation: string; index: number }> = [];
  const add = (operation: string, pattern: RegExp): void => {
    if (!authorized.has(operation)) return;
    const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (const match of prompt.matchAll(globalPattern)) {
      if (match.index !== undefined) matches.push({ operation, index: match.index });
    }
  };

  add(
    'media.image.prepare',
    /(?:生成|创建|制作|绘制|画|generate|create|make)[^，。,.!?]{0,48}(?:图片|图像|插画|海报|image|picture)/u,
  );
  add(
    'media.video.prepare',
    /(?:生成|创建|制作|转成|变成|generate|create|make|turn)[^，。,.!?]{0,48}(?:视频|动画|video|animation)/u,
  );
  add('research.search', /(?:研究|检索|搜索资料|查找资料|research|search for sources)/u);

  const documentPattern =
    /(?:写|起草|创建|生成|整理|改写|更新|write|draft|create|revise|update)[^，。,.!?]{0,48}(?:文档|草稿|大纲|方案|报告|document|draft|outline|report)/u;
  const documentOperation = authorizedOperations.find(
    (operation) =>
      operation.startsWith('document.') &&
      operation !== 'document.get' &&
      operation !== 'document.search' &&
      operation !== 'document.versions',
  );
  if (documentOperation) add(documentOperation, documentPattern);

  const novelPattern =
    /(?:续写|重写|改写|创作|continue|rewrite)[^，。,.!?]{0,48}(?:章节|小说|chapter|novel)/u;
  const novelOperation = authorizedOperations.find((operation) => operation.startsWith('novel.'));
  if (novelOperation) add(novelOperation, novelPattern);

  const explicitSystemSignals: Record<string, RegExp> = {
    'asset.alias.update':
      /(?:修改|更新|设置|change|update|set)[^，。,.!?]{0,32}(?:素材)?(?:别名|alias)/u,
    'asset.tags.add': /(?:添加|加上|add)[^，。,.!?]{0,32}(?:标签|tag)/u,
    'asset.tags.remove': /(?:移除|去掉|remove)[^，。,.!?]{0,32}(?:标签|tag)/u,
    'asset.tags.replace': /(?:替换|replace)[^，。,.!?]{0,32}(?:标签|tag)/u,
    'asset.trash': /(?:删除|移入回收站|trash|delete)[^，。,.!?]{0,32}(?:素材|asset)/u,
    'asset.restore': /(?:恢复|restore)[^，。,.!?]{0,32}(?:素材|asset)/u,
    'asset.purge': /(?:彻底删除|永久删除|purge)[^，。,.!?]{0,32}(?:素材|asset)/u,
    'tag.create': /(?:创建|新建|create)[^，。,.!?]{0,32}(?:标签|tag)/u,
    'tag.update': /(?:修改|重命名|update|rename)[^，。,.!?]{0,32}(?:标签|tag)/u,
    'tag.delete': /(?:删除|delete)[^，。,.!?]{0,32}(?:标签|tag)/u,
    'assetGroup.create': /(?:创建|新建|create)[^，。,.!?]{0,32}(?:素材组|asset group)/u,
    'assetGroup.update': /(?:修改|更新|update)[^，。,.!?]{0,32}(?:素材组|asset group)/u,
    'assetGroup.delete': /(?:删除|delete)[^，。,.!?]{0,32}(?:素材组|asset group)/u,
    'conversation.create': /(?:创建|新建|create)[^，。,.!?]{0,32}(?:会话|conversation)/u,
    'conversation.rename': /(?:重命名|rename)[^，。,.!?]{0,32}(?:会话|conversation)/u,
    'conversation.archive': /(?:归档|archive)[^，。,.!?]{0,32}(?:会话|conversation)/u,
    'conversation.restore': /(?:恢复|restore)[^，。,.!?]{0,32}(?:会话|conversation)/u,
    'settings.provider.apply':
      /(?:应用|修改|更新|apply|update)[^，。,.!?]{0,32}(?:provider|供应商|模型设置)/u,
    'maintenance.clear_cache': /(?:清理|清空|clear)[^，。,.!?]{0,32}(?:缓存|cache)/u,
  };
  for (const [operation, pattern] of Object.entries(explicitSystemSignals)) add(operation, pattern);

  return matches
    .sort((left, right) =>
      left.index === right.index
        ? left.operation.localeCompare(right.operation)
        : left.index - right.index,
    )
    .slice(0, 12)
    .map(({ operation }) => operation);
}

function parseTaskSnapshot(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new TaskPlanServiceError(
      'TASK_PLAN_SCOPE_INVALID',
      'The frozen task snapshot is not valid JSON.',
    );
  }
}

function actionForGenericPlan(plan: ConversationTaskPlanV2): AgentTaskPlanRecord['action'] {
  return plan.steps.every(
    (step) => unifiedAgentToolRegistry.require(step.operation).riskLevel === 'R0',
  )
    ? 'analyze'
    : 'generate';
}

function genericPlanRequiresReview(deliverables: AgentTaskDeliverableRecord[]): boolean {
  return deliverables.some(
    (step) =>
      step.operation === 'document.create_draft' ||
      step.operation === 'document.update_draft' ||
      step.operation.startsWith('novel.'),
  );
}

function stepDependsOn(
  steps: ConversationTaskPlanV2['steps'],
  stepId: string,
  expectedDependencyId: string,
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step.dependsOn]));
  const pending = [...(byId.get(stepId) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.shift()!;
    if (dependency === expectedDependencyId) return true;
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    pending.push(...(byId.get(dependency) ?? []));
  }
  return false;
}

function matchRequiredStepSequence(
  allSteps: ConversationTaskPlanV2['steps'],
  requiredSteps: ConversationTaskPlanV2['steps'],
  operations: readonly string[],
  index = 0,
  previousStepId?: string,
  used = new Set<string>(),
): boolean {
  if (index >= operations.length) return true;
  for (const step of requiredSteps) {
    if (
      used.has(step.id) ||
      step.operation !== operations[index] ||
      (previousStepId && !stepDependsOn(allSteps, step.id, previousStepId))
    ) {
      continue;
    }
    used.add(step.id);
    if (matchRequiredStepSequence(allSteps, requiredSteps, operations, index + 1, step.id, used)) {
      return true;
    }
    used.delete(step.id);
  }
  return false;
}

function parseToolResult(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool Result must be an object.');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new TaskPlanServiceError(
      'TASK_PLAN_INVALID_STATE',
      'The plan step Tool Result is not valid JSON.',
    );
  }
}

function isUnsuccessfulToolResult(result: Record<string, unknown>): boolean {
  return (
    typeof result.status === 'string' &&
    [
      'rejected',
      'failed',
      'error',
      'conflicted',
      'cancelled',
      'unavailable',
      'not_found',
      'confirmation_rejected',
    ].includes(result.status)
  );
}

function requiredMissing(deliverables: AgentTaskDeliverableRecord[]): string[] {
  return deliverables
    .filter((item) => item.required && item.status !== 'succeeded')
    .map((item) => item.kind);
}

function assertSeedanceDeliverableContract(plan: ConversationTaskPlanV1): void {
  if (plan.targetPlatform !== 'seedance' || plan.action === 'analyze') return;
  const expected: Array<{
    kind: ConversationDeliverableKind;
    dependsOn: ConversationDeliverableKind[];
  }> = [
    { kind: 'episode-outline', dependsOn: [] },
    { kind: 'character-prompts', dependsOn: [] },
    {
      kind: 'scene-shot-structure',
      dependsOn: ['episode-outline', 'character-prompts'],
    },
    { kind: 'shot-prompts', dependsOn: ['scene-shot-structure'] },
  ];
  if (
    plan.deliverables.length !== expected.length ||
    expected.some(
      ({ kind }) => !plan.deliverables.some((item) => item.kind === kind && item.required),
    )
  ) {
    throw new TaskPlanServiceError(
      'TASK_PLAN_INVALID_DELIVERABLE',
      'A Seedance generation plan must contain the four required short-drama deliverables.',
    );
  }
  for (const item of expected) {
    const actual = plan.deliverables.find((candidate) => candidate.kind === item.kind)!;
    if (
      actual.dependsOn.length !== item.dependsOn.length ||
      item.dependsOn.some((dependency) => !actual.dependsOn.includes(dependency))
    ) {
      throw new TaskPlanServiceError(
        'TASK_PLAN_INVALID_DEPENDENCY',
        `Seedance deliverable ${item.kind} does not match the required dependency contract.`,
      );
    }
  }
}

export function buildMissingDeliverablesFollowUp(missing: string[]): string {
  return `任务尚未完成。缺少：${missing.join('、')}。\n请调用已授权工具完成剩余交付物；不要仅返回完成说明。`;
}
