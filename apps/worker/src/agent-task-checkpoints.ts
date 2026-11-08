import type Database from 'better-sqlite3';
import { AgentContextStore } from '@ai-video/persistence';
import { AGENT_TOOL_RESULT_LIMITS } from '@ai-video/contracts';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { modelResultReceipt } from './agent-context-results.js';
import { savedProductionReceipts } from './agent-saved-production-receipts.js';
import { isTaskHandoffEvidence, taskEvidenceKey } from './agent-preparation-evidence.js';
import { scriptToMediaCompletionPending } from './production-skill-validation.js';
import { submitTaskReview, type TaskReviewState } from './agent-task-review.js';
import {
  saveTaskPlan,
  assessTaskCompletion,
  assertTaskPartialAllowed,
} from './agent-task-deliverables.js';

export const TASK_CHECKPOINT_TOOL = 'conversation.task.checkpoint';

/** Current control facts stay separate from paged historical evidence. */
function pendingActions(pending: unknown[]): Array<Record<string, unknown>> {
  return pending.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const review = value.semanticReview as Record<string, unknown> | undefined;
    return [
      {
        key: value.key,
        ...Object.fromEntries(
          [
            'intent',
            'minimumCount',
            'savedCount',
            'persistedCount',
            'remainingCount',
            'countUnit',
            'missingTargetIds',
            'unreadTargetIds',
            'missingTexts',
            'creationBinding',
            'repairOutputs',
            'criteriaFailures',
            'duplicateDialogue',
          ]
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, value[key]]),
        ),
        ...(review
          ? {
              semanticReview: {
                reviewId: review.reviewId,
                ready: review.ready,
                previousConclusion: review.previousConclusion,
                reviewScope: review.reviewScope,
                issues: review.issues,
                references: review.references,
              },
            }
          : {}),
        nextAction: value.nextAction,
      },
    ];
  });
}

/** The caller persists this result in the existing authorized tool transaction. */
export function taskCheckpoint(
  db: Database.Database,
  projectId: string,
  args: Record<string, unknown>,
  identity: AgentSystemToolIdentity,
): Record<string, unknown> {
  if (
    Object.keys(args).some(
      (key) =>
        ![
          'operation',
          'decision',
          'sourceRequirementId',
          'remainingWork',
          'workingNotes',
          'targetGenerationId',
          'evidenceOffset',
          'evidenceContentOffset',
          'receiptOffset',
          'deliverables',
          'reason',
          'blockedByCallId',
          'resultId',
          'resultOffset',
          'resultLimit',
          'resultView',
          'expectedHash',
          'stateOffset',
          'reviewId',
          'reviewedTargetIds',
          'conclusion',
          'summary',
          'issues',
          'resolutions',
        ].includes(key),
    )
  )
    throw new Error('Unknown task checkpoint field.');
  if (!identity.taskId || !identity.toolCallId)
    throw new Error('Checkpoint requires an active task call.');
  const current = db
    .prepare(
      `SELECT g.id FROM agent_task_generations l JOIN llm_generations g ON g.id=l.generation_id
    JOIN agent_tasks t ON t.id=l.task_id
    WHERE l.task_id=? AND t.status='running' AND t.phase='model_running'
    AND g.project_id=? AND g.conversation_id=? AND g.status IN ('prepared','streaming') ORDER BY l.ordinal DESC LIMIT 1`,
    )
    .get(identity.taskId, projectId, identity.conversationId) as { id: string } | undefined;
  if (!current) throw new Error('Checkpoint task is no longer active in this conversation.');
  if (args.operation === 'review') {
    const pending = scriptToMediaCompletionPending(
      db,
      projectId,
      current.id,
      identity.taskId,
      true,
    );
    try {
      return submitTaskReview(
        db,
        projectId,
        identity.taskId,
        args,
        pending?.[0]?.semanticReview as TaskReviewState | undefined,
      );
    } catch (error) {
      const actions = pendingActions(pending ?? []).map((action) => {
        const review = action.semanticReview as TaskReviewState | undefined;
        const next = action.nextAction as { kind?: string } | undefined;
        return {
          key: action.key,
          semanticReview: review ? { reviewId: review.reviewId, ready: review.ready } : undefined,
          nextAction: {
            kind: next?.kind,
            toolName: TASK_CHECKPOINT_TOOL,
            arguments: { operation: 'state' },
          },
        };
      });
      throw new Error(
        `${(error as Error).message} Current Worker actions: ${JSON.stringify(actions)}`,
      );
    }
  }
  if (args.operation === 'decision') {
    if (
      Object.keys(args).some(
        (key) => !['operation', 'decision', 'sourceRequirementId'].includes(key),
      )
    )
      throw new Error('Unexpected decision field.');
    const store = new AgentContextStore(db),
      state = store.loadTask(projectId, identity.taskId);
    const requirement = state?.userRequirements.find((r) => r.id === args.sourceRequirementId);
    if (
      !state ||
      !requirement ||
      typeof args.decision !== 'string' ||
      !args.decision.trim() ||
      args.decision.length > 2000 ||
      !requirement.text.includes(args.decision)
    )
      throw new Error('Decision must quote a persisted user requirement.');
    const decision = { text: args.decision, source: requirement.id };
    if (
      !state.confirmedDecisions.some(
        (d) => d.text === decision.text && d.source === decision.source,
      )
    )
      state.confirmedDecisions.push(decision);
    store.saveTask(projectId, current.id, identity.conversationId, state);
    return { status: 'task_decision_recorded', ...decision };
  }
  if (args.operation === 'result' || args.operation === 'state') {
    if (
      Object.keys(args).some(
        (key) =>
          !(
            args.operation === 'state'
              ? ['operation', 'targetGenerationId', 'stateOffset']
              : [
                  'operation',
                  'resultId',
                  'resultOffset',
                  'resultLimit',
                  'resultView',
                  'expectedHash',
                  'targetGenerationId',
                ]
          ).includes(key),
      )
    )
      throw new Error('Unexpected result read field.');
    const generationId = args.targetGenerationId ?? current.id;
    const target = db
      .prepare(
        `SELECT links.task_id FROM agent_task_generations links JOIN llm_generations g ON g.id=links.generation_id
      WHERE g.id=? AND g.project_id=? AND g.conversation_id=?`,
      )
      .get(generationId, projectId, identity.conversationId) as { task_id: string } | undefined;
    if (!target) throw new Error('Result task is outside this conversation.');
    if (args.operation === 'state') {
      const offset = args.stateOffset ?? 0;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Invalid stateOffset.');
      const store = new AgentContextStore(db),
        state = store.loadTask(projectId, target.task_id);
      // A state read can follow a write before the Runtime observes its result.
      // Reconcile through the same authority used by review and completion.
      const progress =
        generationId === current.id
          ? assessTaskCompletion(db, projectId, current.id, target.task_id)
          : undefined;
      const pending = progress?.pending ?? state?.pendingSteps ?? [];
      const evidence = store.evidence(projectId, target.task_id, true);
      const records = [
        ...(state?.userRequirements ?? []).map((value) => ({ kind: 'userRequirement', ...value })),
        ...(state?.confirmedDecisions ?? []).map((value) => ({ kind: 'decision', ...value })),
        ...(state?.projectConstraints ?? []).map((value) => ({
          kind: 'constraint',
          reference: value,
        })),
        ...pending.map((value) => ({ kind: 'pending', value })),
        ...store
          .resultRefs(projectId, target.task_id)
          .map((value) => ({ kind: 'result', ...value })),
        ...(state?.generatedArtifacts ?? []).map((value) => ({ kind: 'artifact', ...value })),
        ...evidence.map((value) => ({ kind: 'evidence', ...value })),
        ...(state?.completedSteps ?? []).map((callId) => ({ kind: 'completed', callId })),
      ];
      const page = {
        status: 'task_state_read',
        taskId: target.task_id,
        currentStage: state?.currentStage,
        taskGoal: state?.taskGoal,
        executionStatus: state?.executionStatus,
        checkpoint: state?.checkpoint,
        pendingActions: pendingActions(pending),
        records: records.slice(offset, offset + 20),
        totalRecords: records.length,
        nextOffset: offset + 20 < records.length ? offset + 20 : null,
      };
      const content = JSON.stringify(page);
      if (Buffer.byteLength(content, 'utf8') <= AGENT_TOOL_RESULT_LIMITS.maxJsonBytes) return page;
      // State is durable working data too. Persist the complete immutable page before
      // returning its read contract; never truncate requirements to fit a tool response.
      const snapshot = store.putResult(
        projectId,
        target.task_id,
        `${identity.toolCallId}:state-page`,
        'runtime.task.state',
        content,
        args,
      );
      const receipt = JSON.parse(modelResultReceipt(snapshot)) as Record<string, unknown>;
      if (generationId !== current.id)
        receipt.read = {
          ...(receipt.read as Record<string, unknown>),
          targetGenerationId: generationId,
        };
      return receipt;
    }
    if (typeof args.resultId !== 'string') throw new Error('resultId is required.');
    return new AgentContextStore(db).readResult(
      projectId,
      target.task_id,
      args.resultId,
      args.resultOffset as number | undefined,
      args.resultLimit as number | undefined,
      args.expectedHash as string | undefined,
      args.resultView as 'content' | 'arguments' | undefined,
    );
  }
  if (args.operation === 'plan' || args.operation === 'partial') {
    if (
      Object.keys(args).some(
        (key) =>
          !(
            args.operation === 'plan'
              ? ['operation', 'deliverables']
              : ['operation', 'reason', 'blockedByCallId']
          ).includes(key),
      )
    )
      throw new Error('Plan and partial reports apply only to this current task.');
    if (args.operation === 'plan')
      return saveTaskPlan(db, projectId, current.id, args.deliverables, identity.taskId);
    if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000)
      throw new Error('Partial completion requires a concrete reason (1–2000 characters).');
    if (
      args.blockedByCallId !== undefined &&
      (typeof args.blockedByCallId !== 'string' ||
        !args.blockedByCallId.trim() ||
        args.blockedByCallId.length > 256)
    )
      throw new Error('blockedByCallId must identify a failed tool call in this task.');
    assertTaskPartialAllowed(
      assessTaskCompletion(db, projectId, current.id, identity.taskId),
      typeof args.blockedByCallId === 'string'
        ? new AgentContextStore(db).resultForCall(projectId, identity.taskId, args.blockedByCallId)
        : undefined,
    );
    return {
      status: 'task_partial_reported',
      generationId: current.id,
      reason: args.reason,
      ...(args.blockedByCallId ? { blockedByCallId: args.blockedByCallId } : {}),
      instruction:
        'Outstanding deliverables remain unfulfilled. End with the concrete blocker and saved versus unfinished work; do not claim completion.',
    };
  }
  if (args.deliverables !== undefined || args.reason !== undefined)
    throw new Error('Deliverables and reason require operation=plan or partial.');
  const generationId = args.targetGenerationId ?? current.id;
  if (
    typeof generationId !== 'string' ||
    !db
      .prepare('SELECT id FROM llm_generations WHERE id=? AND project_id=? AND conversation_id=?')
      .get(generationId, projectId, identity.conversationId)
  )
    throw new Error('Checkpoint generation is outside this conversation.');
  const previous = db
    .prepare(
      `SELECT result_summary_json FROM agent_tool_calls WHERE project_id=? AND generation_id=? AND tool_name=?
    AND status='succeeded' AND json_valid(result_summary_json) AND json_extract(result_summary_json,'$.status')='task_checkpoint_saved'
    ORDER BY rowid DESC LIMIT 1`,
    )
    .get(projectId, generationId, TASK_CHECKPOINT_TOOL) as
    { result_summary_json: string } | undefined;
  const checkpoint = previous
    ? (JSON.parse(previous.result_summary_json) as Record<string, unknown>)
    : undefined;
  if (args.operation === 'save') {
    if (
      generationId !== current.id ||
      args.evidenceOffset !== undefined ||
      args.evidenceContentOffset !== undefined ||
      args.receiptOffset !== undefined
    )
      throw new Error('Save can only checkpoint the current task; offsets are for reading.');
    for (const key of ['remainingWork', 'workingNotes'])
      if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 6000)
        throw new Error(`${key} must contain 1–6000 characters.`);
    const evidenceRows = db
      .prepare(
        `SELECT tool_name,result_summary_json FROM agent_tool_calls WHERE project_id=? AND generation_id=?
      AND tool_name NOT IN (?, 'conversation.task.route') AND status='succeeded'`,
      )
      .all(projectId, current.id, TASK_CHECKPOINT_TOOL) as Array<{
      tool_name: string;
      result_summary_json: string | null;
    }>;
    const keys = new Set<string>();
    for (const row of evidenceRows) {
      try {
        const result = JSON.parse(row.result_summary_json ?? 'null') as Record<
          string,
          unknown
        > | null;
        if (result && isTaskHandoffEvidence(row.tool_name, result))
          keys.add(taskEvidenceKey(row.tool_name, result));
      } catch {
        /* Malformed audit cannot establish new evidence. */
      }
    }
    const previousKeys = new Set(
      Array.isArray(checkpoint?.evidenceKeys) ? checkpoint.evidenceKeys : [],
    );
    if (!keys.size || (previousKeys.size && ![...keys].some((key) => !previousKeys.has(key))))
      throw new Error(
        'TASK_CHECKPOINT_NO_PROGRESS: no new successful evidence or saved work since the last handoff. Correct the pending tool call, or use operation=partial with a concrete reason and report unfinished work. Do not retry save without new evidence.',
      );
    return {
      status: 'task_checkpoint_saved',
      checkpointId: identity.toolCallId,
      generationId: current.id,
      taskId: identity.taskId,
      remainingWork: args.remainingWork,
      workingNotes: args.workingNotes,
      notesAreAssistantClaims: true,
      evidenceCount: keys.size,
      evidenceKeys: [...keys],
      savedProductionReceipts: savedProductionReceipts(db, projectId, { generationId: current.id }),
      instruction:
        'Handoff persisted, task still running. Continue ALL remaining work in the next stage. Receipts verify past saves, not current CAS. Read further receipt/evidence pages on demand. Do not repeat saved writes.',
    };
  }
  if (args.operation !== 'read') throw new Error('Invalid checkpoint operation.');
  if (
    (args.evidenceOffset !== undefined && args.receiptOffset !== undefined) ||
    (args.evidenceContentOffset !== undefined && args.evidenceOffset === undefined)
  )
    throw new Error('Choose one checkpoint, receipt or evidence page per read.');
  const offset = (key: string): number => {
    const value = args[key] ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid ${key}.`);
    return value;
  };
  const evidenceOffset = offset('evidenceOffset');
  const rows =
    args.evidenceOffset === undefined
      ? []
      : (db
          .prepare(
            `SELECT provider_call_id,tool_name,status,result_summary_json FROM agent_tool_calls
    WHERE project_id=? AND generation_id=? AND tool_name<>? AND status IN ('succeeded','failed') ORDER BY rowid LIMIT 2 OFFSET ?`,
          )
          .all(projectId, generationId, TASK_CHECKPOINT_TOOL, evidenceOffset) as Array<{
          provider_call_id: string;
          tool_name: string;
          status: string;
          result_summary_json: string | null;
        }>);
  const row = rows[0];
  const contentOffset = offset('evidenceContentOffset');
  const raw = row?.result_summary_json ?? 'null';
  if (row && contentOffset > raw.length)
    throw new Error('Evidence content offset exceeds this result.');
  const end = Math.min(raw.length, contentOffset + 4096);
  return {
    status: 'task_checkpoint_read',
    generationId,
    checkpointId: checkpoint?.checkpointId ?? null,
    ...(args.evidenceOffset === undefined && args.receiptOffset === undefined
      ? { checkpoint: checkpoint ?? null }
      : {}),
    ...(args.receiptOffset === undefined
      ? {}
      : {
          savedProductionReceipts: savedProductionReceipts(
            db,
            projectId,
            { generationId },
            offset('receiptOffset'),
          ),
        }),
    ...(args.evidenceOffset === undefined
      ? {}
      : {
          evidence: row
            ? {
                callId: row.provider_call_id,
                toolName: row.tool_name,
                status: row.status,
                resultJson: raw.slice(contentOffset, end),
                contentOffset,
                complete: contentOffset === 0 && end === raw.length,
                ...(end < raw.length ? { nextContentOffset: end } : {}),
                totalCharacters: raw.length,
                offsetUnit: 'utf16_code_units',
              }
            : null,
          evidenceOffset,
          ...(rows.length > 1 ? { nextEvidenceOffset: evidenceOffset + 1 } : {}),
        }),
    instruction:
      'Historical audit and model handoff notes only. Concatenate resultJson pages from contentOffset=0 to totalCharacters before parsing; fragments are not complete evidence. Verify current versions before further edits. No writes were replayed.',
  };
}
