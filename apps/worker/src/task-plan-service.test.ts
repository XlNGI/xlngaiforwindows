import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDeliverableKind, ConversationTaskPlanV1 } from '@ai-video/contracts';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';
import {
  assertDeliverableStatusTransition,
  assertPlanStatusTransition,
  buildMissingDeliverablesFollowUp,
  TaskPlanService,
  TaskPlanServiceError,
} from './task-plan-service.js';
import {
  ConversationTaskPlanValidationError,
  validateConversationTaskPlanV1,
} from './request-validation.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const validPlan: ConversationTaskPlanV1 = {
  version: 1,
  mode: 'short-drama',
  action: 'generate',
  targetPlatform: 'seedance',
  deliverables: [
    { kind: 'episode-outline', required: true, dependsOn: [] },
    { kind: 'character-prompts', required: true, dependsOn: [] },
    {
      kind: 'scene-shot-structure',
      required: true,
      dependsOn: ['episode-outline', 'character-prompts'],
    },
    { kind: 'shot-prompts', required: true, dependsOn: ['scene-shot-structure'] },
  ],
  constraints: ['每集控制在 3 分钟内', '输出适配 Seedance 的中文提示词'],
};

async function setup(targetPlatform: 'seedance' | 'generic-video' = 'seedance') {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-task-plan-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), '雾港纪事');
  const conversation = new ContentService(project).createConversation({
    scopeType: 'project',
    title: 'AI 漫剧',
  });
  const identifiers = project.access(true, (database, current) => {
    const now = '2026-08-28T08:00:00.000Z';
    database
      .prepare(
        `INSERT INTO documents
         (id, project_id, kind, title, scope_type, lifecycle_status, row_version, created_at, updated_at)
         VALUES ('chapter-document', ?, 'note', '第一章', 'project', 'active', 0, ?, ?)`,
      )
      .run(current.id, now, now);
    database
      .prepare(
        `INSERT INTO novel_chapters
         (id, project_id, document_id, position, display_label, lifecycle_status,
          row_version, created_at, updated_at)
         VALUES ('chapter-1', ?, 'chapter-document', 0, '第一章', 'active', 0, ?, ?)`,
      )
      .run(current.id, now, now);
    database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, project_session_id, conversation_id, task_type, scope_type, title,
          request_snapshot_json, request_hash, status, created_at, started_at, updated_at, phase,
          row_version, tool_call_limit)
         VALUES ('task-1', ?, ?, ?, 'document-create', 'project', '生成漫剧', ?, ?,
                 'running', ?, ?, ?, 'model_running', 0, 16)`,
      )
      .run(
        current.id,
        project.currentSessionId(),
        conversation.id,
        JSON.stringify({
          promptHash: 'prompt-hash',
          agentMode: 'short-drama',
          selectedChapterIds: ['chapter-1'],
          targetPlatform,
        }),
        'request-hash',
        now,
        now,
        now,
      );
    return { projectId: current.id, taskId: 'task-1', chapterId: 'chapter-1' };
  });
  return { project, service: new TaskPlanService(project), ...identifiers };
}

function validationCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof ConversationTaskPlanValidationError ? error.code : undefined;
  }
}

function serviceCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof TaskPlanServiceError ? error.code : undefined;
  }
}

function deliverableId(
  plan: ReturnType<TaskPlanService['getByTask']>,
  kind: ConversationDeliverableKind,
): string {
  const deliverable = plan?.deliverables.find((item) => item.kind === kind);
  if (!deliverable) throw new Error(`Missing test deliverable ${kind}.`);
  return deliverable.id;
}

function createOwnedDocument(
  project: ProjectService,
  taskId: string,
  suffix: string,
  linked = true,
): string {
  return project.access(true, (database, current) => {
    const now = '2026-08-28T08:01:00.000Z';
    const documentId = `document-${suffix}`;
    const versionId = `version-${suffix}`;
    database
      .prepare(
        `INSERT INTO documents
         (id, project_id, kind, title, scope_type, lifecycle_status, row_version, created_at, updated_at)
         VALUES (?, ?, 'note', ?, 'project', 'active', 0, ?, ?)`,
      )
      .run(documentId, current.id, suffix, now, now);
    database
      .prepare(
        `INSERT INTO document_versions (id, document_id, version, content_markdown, created_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .run(versionId, documentId, `# ${suffix}`, now);
    if (linked) {
      database
        .prepare(
          `INSERT INTO agent_task_document_versions
           (task_id, document_id, document_version_id, operation, created_at)
           VALUES (?, ?, ?, 'create', ?)`,
        )
        .run(taskId, documentId, versionId, now);
    }
    return documentId;
  });
}

function createOwnedChangeSet(project: ProjectService, taskId: string, suffix: string): string {
  return project.access(true, (database, current) => {
    const id = `change-set-${suffix}`;
    const now = '2026-08-28T08:02:00.000Z';
    database
      .prepare(
        `INSERT INTO agent_change_sets
         (id, project_id, task_id, title, status, row_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'proposed', 0, ?, ?)`,
      )
      .run(id, current.id, taskId, suffix, now, now);
    return id;
  });
}

function startAndComplete(
  service: TaskPlanService,
  taskId: string,
  kind: ConversationDeliverableKind,
  toolName: string,
  entityType: 'document' | 'change-set' | 'task',
  entityId: string,
) {
  const id = deliverableId(service.getByTask(taskId), kind);
  service.beginDeliverable({ taskId, deliverableId: id, toolName });
  return service.recordDeliverableSuccess({ taskId, deliverableId: id, entityType, entityId });
}

describe('ConversationTaskPlanV1 validation', () => {
  it('rejects unknown, authority, illegal platform, duplicate, missing and cyclic inputs', () => {
    expect(
      validationCode(() => validateConversationTaskPlanV1({ ...validPlan, extra: true })),
    ).toBe('TASK_PLAN_UNKNOWN_FIELD');
    expect(
      validationCode(() =>
        validateConversationTaskPlanV1({ ...validPlan, selectedChapterIds: ['chapter-elsewhere'] }),
      ),
    ).toBe('TASK_PLAN_AUTHORITY_FIELD_FORBIDDEN');
    expect(
      validationCode(() =>
        validateConversationTaskPlanV1({ ...validPlan, targetPlatform: 'other' }),
      ),
    ).toBe('TASK_PLAN_INVALID_PLATFORM');
    expect(
      validationCode(() =>
        validateConversationTaskPlanV1({
          ...validPlan,
          deliverables: [
            { kind: 'episode-outline', required: true, dependsOn: [] },
            { kind: 'episode-outline', required: false, dependsOn: [] },
          ],
        }),
      ),
    ).toBe('TASK_PLAN_DUPLICATE_DELIVERABLE');
    expect(
      validationCode(() =>
        validateConversationTaskPlanV1({
          ...validPlan,
          deliverables: [{ kind: 'episode-outline', required: true, dependsOn: ['shot-prompts'] }],
        }),
      ),
    ).toBe('TASK_PLAN_INVALID_DEPENDENCY');
    expect(
      validationCode(() =>
        validateConversationTaskPlanV1({
          ...validPlan,
          deliverables: [
            { kind: 'episode-outline', required: true, dependsOn: ['character-prompts'] },
            { kind: 'character-prompts', required: true, dependsOn: ['episode-outline'] },
          ],
        }),
      ),
    ).toBe('TASK_PLAN_CYCLIC_DEPENDENCY');
  });

  it('limits model plans to eight deliverables', () => {
    const repeated = Array.from({ length: 9 }, (_, index) => ({
      kind: `kind-${index}`,
      required: true,
      dependsOn: [],
    }));
    expect(
      validationCode(() =>
        validateConversationTaskPlanV1({ ...validPlan, deliverables: repeated }),
      ),
    ).toBe('TASK_PLAN_INVALID_DELIVERABLE');
  });
});

describe('TaskPlanService P4 plan-only round', () => {
  it('exposes only task.plan.submit and binds the example prompt to the frozen platform', async () => {
    const { service, taskId } = await setup();
    const userPrompt = '我要生成主要大纲、镜头、角色的提示词，用于生成 AI 漫剧，使用 Seedance。';
    const round = service.planOnlyRound(taskId, userPrompt);

    expect(round.tools.map((grant) => grant.tool.name)).toEqual(['task.plan.submit']);
    expect(round.systemInstruction).toContain(userPrompt);
    expect(round.systemInstruction).toContain('short-drama');
    expect(round.systemInstruction).toContain('seedance');
    for (const kind of [
      'episode-outline',
      'character-prompts',
      'scene-shot-structure',
      'shot-prompts',
    ]) {
      expect(round.systemInstruction).toContain(kind);
    }
    expect(round.systemInstruction).toContain('Do not provide or infer chapter IDs');
  });

  it('validates, freezes and activates a plan while retaining Worker-owned chapter scope', async () => {
    const { service, taskId, chapterId, projectId } = await setup();
    const info = service.submitPlanOnly({ taskId, candidate: validPlan, idempotencyKey: 'plan-1' });

    expect(info).toMatchObject({
      taskId,
      projectId,
      status: 'active',
      trustedScope: { selectedChapterIds: [chapterId] },
      plan: { targetPlatform: 'seedance' },
    });
    expect(info.deliverables.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: 'episode-outline', status: 'ready' },
      { kind: 'character-prompts', status: 'ready' },
      { kind: 'scene-shot-structure', status: 'pending' },
      { kind: 'shot-prompts', status: 'pending' },
    ]);
  });

  it('rejects omitted Seedance deliverables, wrong dependencies and platform mismatch', async () => {
    const { service, taskId } = await setup();
    expect(
      serviceCode(() =>
        service.submitPlanOnly({
          taskId,
          candidate: { ...validPlan, deliverables: validPlan.deliverables.slice(0, 3) },
        }),
      ),
    ).toBe('TASK_PLAN_INVALID_DELIVERABLE');

    const wrongDependency = {
      ...validPlan,
      deliverables: validPlan.deliverables.map((item) =>
        item.kind === 'shot-prompts' ? { ...item, dependsOn: ['episode-outline'] } : item,
      ),
    };
    expect(serviceCode(() => service.submitPlanOnly({ taskId, candidate: wrongDependency }))).toBe(
      'TASK_PLAN_INVALID_DEPENDENCY',
    );
    expect(
      serviceCode(() =>
        service.submitPlanOnly({
          taskId,
          candidate: { ...validPlan, targetPlatform: 'generic-video' },
        }),
      ),
    ).toBe('TASK_PLAN_PLATFORM_MISMATCH');
  });

  it('is idempotent for the same plan and rejects a changed frozen plan', async () => {
    const { service, taskId } = await setup();
    const first = service.submitPlanOnly({ taskId, candidate: validPlan, idempotencyKey: 'same' });
    const second = service.submitPlanOnly({ taskId, candidate: validPlan, idempotencyKey: 'same' });
    expect(second.id).toBe(first.id);
    expect(
      serviceCode(() =>
        service.submitPlanOnly({
          taskId,
          candidate: { ...validPlan, constraints: ['changed'] },
          idempotencyKey: 'same',
        }),
      ),
    ).toBe('TASK_PLAN_IDEMPOTENCY_CONFLICT');
  });

  it('rejects a chapter outside the current project even when a task snapshot was forged', async () => {
    const { project, service, taskId } = await setup();
    project.access(true, (database) => {
      const now = '2026-08-28T08:00:00.000Z';
      database
        .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('foreign-project', 'Foreign', now, now);
      database
        .prepare(
          `INSERT INTO documents
           (id, project_id, kind, title, scope_type, lifecycle_status, row_version, created_at, updated_at)
           VALUES ('foreign-document', 'foreign-project', 'note', 'Foreign', 'project', 'active', 0, ?, ?)`,
        )
        .run(now, now);
      database
        .prepare(
          `INSERT INTO novel_chapters
           (id, project_id, document_id, position, display_label, lifecycle_status,
            row_version, created_at, updated_at)
           VALUES ('foreign-chapter', 'foreign-project', 'foreign-document', 0, 'Foreign',
                   'active', 0, ?, ?)`,
        )
        .run(now, now);
      database.prepare('UPDATE agent_tasks SET request_snapshot_json = ? WHERE id = ?').run(
        JSON.stringify({
          agentMode: 'short-drama',
          selectedChapterIds: ['foreign-chapter'],
          targetPlatform: 'seedance',
        }),
        taskId,
      );
    });

    expect(serviceCode(() => service.submitPlanOnly({ taskId, candidate: validPlan }))).toBe(
      'TASK_PLAN_SCOPE_INVALID',
    );
  });
});

describe('TaskPlanService P4 bounded tools and completion gate', () => {
  it('registers only ready tools and unlocks dependency-bound deliverables transactionally', async () => {
    const { project, service, taskId } = await setup();
    const plan = service.submitPlanOnly({ taskId, candidate: validPlan });
    expect(service.availableToolGrants(taskId).map((grant) => grant.tool.name)).toEqual([
      'novel.episode.submit_draft',
      'document.create_draft',
      'task.package.complete',
    ]);
    const structureId = deliverableId(plan, 'scene-shot-structure');
    expect(
      serviceCode(() =>
        service.beginDeliverable({
          taskId,
          deliverableId: structureId,
          toolName: 'novel.episode.submit_structure',
        }),
      ),
    ).toBe('TASK_PLAN_DELIVERABLE_NOT_READY');
    expect(
      serviceCode(() =>
        service.beginDeliverable({
          taskId,
          deliverableId: deliverableId(plan, 'episode-outline'),
          toolName: 'document.create_draft',
        }),
      ),
    ).toBe('TASK_PLAN_DELIVERABLE_NOT_READY');

    const outlineDocument = createOwnedDocument(project, taskId, 'outline');
    const outlineResult = startAndComplete(
      service,
      taskId,
      'episode-outline',
      'novel.episode.submit_draft',
      'document',
      outlineDocument,
    );
    expect(outlineResult.remainingRequiredDeliverables).toEqual([
      'character-prompts',
      'scene-shot-structure',
      'shot-prompts',
    ]);
    expect(
      service.getByTask(taskId)?.deliverables.find((item) => item.kind === 'scene-shot-structure'),
    ).toMatchObject({ status: 'pending' });

    const characterDocument = createOwnedDocument(project, taskId, 'characters');
    startAndComplete(
      service,
      taskId,
      'character-prompts',
      'document.create_draft',
      'document',
      characterDocument,
    );
    expect(service.availableToolGrants(taskId).map((grant) => grant.tool.name)).toEqual([
      'novel.episode.submit_structure',
      'task.package.complete',
    ]);
  });

  it('serializes ready deliverables that share one tool name', async () => {
    const { project, service, taskId } = await setup('generic-video');
    const plan: ConversationTaskPlanV1 = {
      ...validPlan,
      targetPlatform: 'generic-video',
      deliverables: [
        { kind: 'character-prompts', required: true, dependsOn: [] },
        { kind: 'scene-prompts', required: true, dependsOn: [] },
      ],
    };
    service.submitPlanOnly({ taskId, candidate: plan });
    const grants = service.availableToolGrants(taskId);
    expect(grants.filter((grant) => grant.tool.name === 'document.create_draft')).toHaveLength(1);
    const first = grants.find((grant) => grant.tool.name === 'document.create_draft')!;
    const document = createOwnedDocument(project, taskId, 'first-shared');
    service.beginDeliverable({
      taskId,
      deliverableId: first.deliverableId!,
      toolName: first.tool.name,
    });
    service.recordDeliverableSuccess({
      taskId,
      deliverableId: first.deliverableId!,
      entityType: 'document',
      entityId: document,
    });
    expect(
      service
        .availableToolGrants(taskId)
        .filter((grant) => grant.tool.name === 'document.create_draft'),
    ).toHaveLength(1);
  });

  it('does not authorize mutation tools for analyze plans', async () => {
    const { service, taskId } = await setup('generic-video');
    service.submitPlanOnly({
      taskId,
      candidate: {
        ...validPlan,
        action: 'analyze',
        targetPlatform: 'generic-video',
        deliverables: [{ kind: 'production-notes', required: true, dependsOn: [] }],
      },
    });
    expect(service.availableToolGrants(taskId).map((grant) => grant.tool.name)).toEqual([
      'task.package.complete',
    ]);
  });

  it('rejects out-of-scope entities and duplicate deliverable completion', async () => {
    const { project, service, taskId } = await setup();
    const plan = service.submitPlanOnly({ taskId, candidate: validPlan });
    const id = deliverableId(plan, 'episode-outline');
    service.beginDeliverable({
      taskId,
      deliverableId: id,
      toolName: 'novel.episode.submit_draft',
    });
    const unlinked = createOwnedDocument(project, taskId, 'unlinked', false);
    expect(
      serviceCode(() =>
        service.recordDeliverableSuccess({
          taskId,
          deliverableId: id,
          entityType: 'document',
          entityId: unlinked,
        }),
      ),
    ).toBe('TASK_PACKAGE_ENTITY_INVALID');

    const linked = createOwnedDocument(project, taskId, 'linked');
    service.recordDeliverableSuccess({
      taskId,
      deliverableId: id,
      entityType: 'document',
      entityId: linked,
    });
    expect(
      serviceCode(() =>
        service.recordDeliverableSuccess({
          taskId,
          deliverableId: id,
          entityType: 'document',
          entityId: linked,
        }),
      ),
    ).toBe('TASK_PLAN_DUPLICATE_COMPLETION');
  });

  it('persists two targeted follow-ups, then fails without rolling the failure back', async () => {
    const { project, service, taskId } = await setup();
    service.submitPlanOnly({ taskId, candidate: validPlan });

    expect(service.completePackage(taskId)).toEqual({
      complete: false,
      followUp: {
        ordinal: 1,
        prompt: buildMissingDeliverablesFollowUp([
          'episode-outline',
          'character-prompts',
          'scene-shot-structure',
          'shot-prompts',
        ]),
        missingDeliverables: [
          'episode-outline',
          'character-prompts',
          'scene-shot-structure',
          'shot-prompts',
        ],
      },
    });
    expect(service.completePackage(taskId).followUp?.ordinal).toBe(2);
    expect(service.completePackage(taskId)).toEqual({
      complete: false,
      taskStatus: 'failed',
      errorCode: 'TASK_PACKAGE_FOLLOW_UP_LIMIT',
    });
    const persisted = project.access(false, (database) => ({
      plan: database
        .prepare('SELECT status FROM agent_task_plans WHERE task_id = ?')
        .get(taskId) as {
        status: string;
      },
      task: database
        .prepare('SELECT status, error_code FROM agent_tasks WHERE id = ?')
        .get(taskId) as {
        status: string;
        error_code: string;
      },
      events: database
        .prepare('SELECT event_type FROM agent_task_events WHERE task_id = ? ORDER BY sequence')
        .all(taskId) as Array<{ event_type: string }>,
    }));
    expect(persisted.plan.status).toBe('failed');
    expect(persisted.task).toMatchObject({
      status: 'failed',
      error_code: 'TASK_PACKAGE_FOLLOW_UP_LIMIT',
    });
    expect(persisted.events.map((event) => event.event_type)).toEqual([
      'task.package.follow_up_requested',
      'task.package.follow_up_requested',
      'task.package.follow_up_exhausted',
    ]);
  });

  it('completes exactly the four Seedance deliverables and advances the task to review', async () => {
    const { project, service, taskId } = await setup();
    service.submitPlanOnly({ taskId, candidate: validPlan });
    startAndComplete(
      service,
      taskId,
      'episode-outline',
      'novel.episode.submit_draft',
      'document',
      createOwnedDocument(project, taskId, 'outline-complete'),
    );
    startAndComplete(
      service,
      taskId,
      'character-prompts',
      'document.create_draft',
      'document',
      createOwnedDocument(project, taskId, 'characters-complete'),
    );
    startAndComplete(
      service,
      taskId,
      'scene-shot-structure',
      'novel.episode.submit_structure',
      'change-set',
      createOwnedChangeSet(project, taskId, 'structure'),
    );
    startAndComplete(
      service,
      taskId,
      'shot-prompts',
      'novel.episode.submit_structure',
      'change-set',
      createOwnedChangeSet(project, taskId, 'shots'),
    );

    expect(service.completePackage(taskId)).toEqual({
      complete: true,
      taskStatus: 'waiting_review',
    });
    const persisted = project.access(false, (database) => ({
      task: database.prepare('SELECT status, phase FROM agent_tasks WHERE id = ?').get(taskId) as {
        status: string;
        phase: string;
      },
      eventTypes: (
        database
          .prepare('SELECT event_type FROM agent_task_events WHERE task_id = ? ORDER BY sequence')
          .all(taskId) as Array<{ event_type: string }>
      ).map((event) => event.event_type),
    }));
    expect(service.getByTask(taskId)?.status).toBe('succeeded');
    expect(persisted.task).toEqual({ status: 'waiting_review', phase: 'waiting_review' });
    expect(
      persisted.eventTypes.filter((type) => type === 'task.deliverable.succeeded'),
    ).toHaveLength(4);
    expect(persisted.eventTypes.at(-1)).toBe('task.package.completed');
  });

  it('keeps legacy status-transition guards intact', async () => {
    const { service, taskId } = await setup();
    const plan = service.submit({ taskId, candidate: validPlan });
    expect(() => assertPlanStatusTransition('frozen', 'succeeded')).toThrow(TaskPlanServiceError);
    expect(() => assertDeliverableStatusTransition('pending', 'in_progress')).toThrow(
      TaskPlanServiceError,
    );
    expect(
      serviceCode(() =>
        service.transitionDeliverable({
          deliverableId: plan.deliverables[2]!.id,
          status: 'in_progress',
          expectedRowVersion: 0,
        }),
      ),
    ).toBe('TASK_PLAN_INVALID_STATE');
  });
});
