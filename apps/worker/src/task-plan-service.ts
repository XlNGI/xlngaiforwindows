import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ConversationPackageCompleteResult,
  ConversationDeliverableKind,
  ConversationDeliverableStatus,
  ConversationTaskToolGrant,
  ConversationTaskPlanInfo,
  ConversationTaskPlanStatus,
  ConversationTaskPlanV1,
  ConversationTaskPlanErrorCode,
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
  validateConversationTaskPlanV1,
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
  ): {
    systemInstruction: string;
    tools: ConversationTaskToolGrant[];
  } {
    return this.projects.access(false, (database, project) => {
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
      const snapshot = this.readShortDramaSnapshot(task.request_snapshot_json);
      return {
        systemInstruction: buildPlanOnlyInstruction({
          userPrompt,
          targetPlatform: snapshot.targetPlatform,
          selectedChapterCount: snapshot.selectedChapterIds.length,
        }),
        tools: [{ tool: conversationTaskToolDefinition('task.plan.submit') }],
      };
    });
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
      if (plan.action === 'analyze') {
        return [{ tool: conversationTaskToolDefinition('task.package.complete') }];
      }
      const usedToolNames = new Set<string>();
      const grants = repositories.agentTaskDeliverables
        .listByPlan(plan.id)
        .filter((deliverable) => deliverable.status === 'ready')
        .flatMap((deliverable): ConversationTaskToolGrant[] => {
          const toolName = deliverableTools[deliverable.kind];
          if (usedToolNames.has(toolName)) return [];
          usedToolNames.add(toolName);
          const tool = conversationTaskToolDefinition(toolName);
          tool.description = `${tool.description} Authorized deliverable: ${deliverable.kind}.`;
          return [
            {
              deliverableId: deliverable.id,
              deliverableKind: deliverable.kind,
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
        if (
          deliverable.status !== 'ready' ||
          deliverableTools[deliverable.kind] !== input.toolName
        ) {
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
          deliverable: deliverable.kind,
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
        for (const deliverable of deliverables.filter((item) => item.required)) {
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
          plan.action === 'analyze' ? 'completed' : 'waiting_review';
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
    let plan: ConversationTaskPlanV1;
    try {
      plan = validateConversationTaskPlanV1(input.candidate);
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
        const snapshot = this.readShortDramaSnapshot(task.request_snapshot_json);
        if (plan.mode !== snapshot.agentMode) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_TASK_MODE_MISMATCH',
            'The proposed plan mode does not match the frozen task mode.',
          );
        }
        if (plan.targetPlatform !== snapshot.targetPlatform) {
          throw new TaskPlanServiceError(
            'TASK_PLAN_PLATFORM_MISMATCH',
            'The proposed target platform does not match the frozen user selection.',
          );
        }
        assertSeedanceDeliverableContract(plan);
        this.assertChapterScope(database, project.id, snapshot.selectedChapterIds);

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
          version: 1,
          mode: plan.mode,
          action: plan.action,
          targetPlatform: plan.targetPlatform,
          planJson,
          trustedScopeJson: JSON.stringify({
            version: 1,
            projectId: project.id,
            projectSessionId: task.project_session_id,
            conversationId: task.conversation_id,
            taskId: task.id,
            selectedChapterIds: snapshot.selectedChapterIds,
          }),
          planHash,
          status: 'frozen',
          idempotencyKey: input.idempotencyKey,
          rowVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
        repositories.agentTaskPlans.save(record);
        const deliverables = plan.deliverables.map((deliverable, ordinal) => {
          const item: AgentTaskDeliverableRecord = {
            id: randomUUID(),
            planId: record.id,
            taskId: task.id,
            projectId: project.id,
            ordinal,
            kind: deliverable.kind,
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
          const dependencies = JSON.parse(
            deliverable.dependsOnJson,
          ) as ConversationDeliverableKind[];
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
    const dependencies = JSON.parse(deliverable.dependsOnJson) as ConversationDeliverableKind[];
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
      const dependencies = JSON.parse(deliverable.dependsOnJson) as ConversationDeliverableKind[];
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
    const parsedPlan = JSON.parse(plan.planJson) as ConversationTaskPlanV1;
    const trusted = JSON.parse(plan.trustedScopeJson) as { selectedChapterIds: string[] };
    return {
      id: plan.id,
      taskId: plan.taskId,
      projectId: plan.projectId,
      plan: parsedPlan,
      trustedScope: { selectedChapterIds: [...trusted.selectedChapterIds] },
      status: plan.status,
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        kind: deliverable.kind,
        required: deliverable.required,
        dependsOn: JSON.parse(deliverable.dependsOnJson) as ConversationDeliverableKind[],
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

function requiredMissing(
  deliverables: AgentTaskDeliverableRecord[],
): ConversationDeliverableKind[] {
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

export function buildMissingDeliverablesFollowUp(missing: ConversationDeliverableKind[]): string {
  return `任务尚未完成。缺少：${missing.join('、')}。\n请调用已授权工具完成剩余交付物；不要仅返回完成说明。`;
}
