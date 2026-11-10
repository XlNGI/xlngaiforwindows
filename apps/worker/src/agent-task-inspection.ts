import type Database from 'better-sqlite3';
import { bundleTiming } from './production-bundle-timing.js';
import { bundleSavedObjects, bundleReadbackRecorded } from './production-bundle-service.js';
import { isBundleTask, loadBundle, retiredBundleStatus } from './production-bundle-state.js';
import { scriptToMediaCompletionPending } from './production-skill-validation.js';
import type { TaskReviewState } from './agent-task-review.js';

/** Current task facts precede historical pages. No project content or snapshots are written. */
export function inspectAgentTask(db: Database.Database, projectId: string, generationId: string) {
  const task = db
    .prepare(
      `SELECT t.id,t.status,t.phase,t.created_at,t.completed_at,t.error_code,
    t.error_message,t.turn_count,t.input_tokens,t.output_tokens FROM agent_tasks t
    JOIN agent_task_generations l ON l.task_id=t.id WHERE l.generation_id=? AND t.project_id=?`,
    )
    .get(generationId, projectId) as
    | {
        id: string;
        status: string;
        phase: string;
        created_at: string;
        completed_at: string | null;
        error_code: string | null;
        error_message: string | null;
        turn_count: number;
        input_tokens: number;
        output_tokens: number;
      }
    | undefined;
  if (!task) return { available: false, reason: 'No linked task exists for this generation.' };
  const bundleTask = isBundleTask(db, task.id);
  const retired = bundleTask ? retiredBundleStatus(db, projectId, task.id) : undefined;
  const bundle = !retired && bundleTask ? loadBundle(db, projectId, task.id) : undefined;
  const bundleObjects = bundleTask ? bundleSavedObjects(db, projectId, task.id) : [];
  const observedAt = new Date().toISOString();
  const calls = db
    .prepare(
      `SELECT tool_name,status,error_code,error_message,result_summary_json,completed_at
    FROM agent_tool_calls WHERE project_id=? AND task_id=? ORDER BY created_at,rowid`,
    )
    .all(projectId, task.id) as Array<{
    tool_name: string;
    status: string;
    error_code: string | null;
    error_message: string | null;
    result_summary_json: string | null;
    completed_at: string | null;
  }>;
  const scenes = new Set<string>(),
    shots = new Set<string>(),
    documents = new Set<string>();
  let lastSavedAt: string | null = null;
  const failures: Record<string, number> = {};
  const latestFailures: Array<{
    tool: string;
    code: string;
    message: string | null;
    at: string | null;
  }> = [];
  const addIds = (set: Set<string>, ids: unknown) => {
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') set.add(id);
  };
  for (const call of calls) {
    if (call.status === 'failed') {
      const code =
        /TASK_[A-Z_]+/.exec(call.error_message ?? '')?.[0] ?? call.error_code ?? 'TOOL_FAILED';
      failures[code] = (failures[code] ?? 0) + 1;
      latestFailures.push({
        tool: call.tool_name,
        code,
        message: call.error_message?.slice(0, 500) ?? null,
        at: call.completed_at,
      });
      continue;
    }
    if (call.status !== 'succeeded' || !call.result_summary_json) continue;
    let result: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.result_summary_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      result = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!result || typeof result !== 'object') continue;
    const saved =
      [
        'scene_structure_saved',
        'episode_structure_saved',
        'shot_prompts_saved',
        'shot_timings_saved',
        'draft_saved',
        'chapter_saved',
        'bundle_committed',
      ].includes(String(result.status)) ||
      (result.status === 'scene_structure_partially_saved' && result.savedSceneThisCall === true);
    if (!saved) continue;
    addIds(scenes, result.sceneIds);
    addIds(shots, result.shotIds);
    if (typeof result.documentId === 'string') documents.add(result.documentId);
    if (Array.isArray(result.shots))
      for (const shot of result.shots as unknown[]) {
        if (shot && typeof shot === 'object' && 'shotId' in shot && typeof shot.shotId === 'string')
          shots.add(shot.shotId);
      }
    const execution = result.execution as { replayed?: boolean; effect?: string } | undefined;
    if (result.changedCount !== 0 && execution?.replayed !== true && execution?.effect !== 'none')
      lastSavedAt = call.completed_at;
  }
  for (const item of bundleObjects) {
    (item.kind === 'scene' ? scenes : item.kind === 'shot' ? shots : documents).add(item.id);
  }
  const activeScenes = [...scenes].filter((id) =>
    db
      .prepare('SELECT 1 FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL')
      .get(id, projectId),
  );
  const activeShots = new Set(
    [...shots].filter((id) =>
      db
        .prepare(
          `SELECT 1 FROM shots s JOIN scenes c ON c.id=s.scene_id
    WHERE s.id=? AND c.project_id=? AND s.archived_at IS NULL AND c.archived_at IS NULL`,
        )
        .get(id, projectId),
    ),
  );
  // Structure receipts may omit child IDs after a scene-header update. Count only
  // task-attributed scenes, never the entire project's unrelated production.
  for (const id of activeScenes)
    for (const shot of db
      .prepare('SELECT id FROM shots WHERE scene_id=? AND archived_at IS NULL')
      .all(id) as Array<{ id: string }>)
      activeShots.add(shot.id);
  const materialCounts: Record<string, number> = {};
  for (const id of documents) {
    const doc = db
      .prepare(
        "SELECT kind FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
      )
      .get(id, projectId) as { kind: string } | undefined;
    if (doc && ['character', 'scene', 'prop', 'voice'].includes(doc.kind))
      materialCounts[doc.kind] = (materialCounts[doc.kind] ?? 0) + 1;
  }
  const latestGeneration = (
    db
      .prepare(
        'SELECT generation_id FROM agent_task_generations WHERE task_id=? ORDER BY ordinal DESC LIMIT 1',
      )
      .get(task.id) as { generation_id: string }
  ).generation_id;
  let pending: ReturnType<typeof scriptToMediaCompletionPending>;
  let reviewError: string | undefined;
  try {
    pending = scriptToMediaCompletionPending(db, projectId, latestGeneration, task.id);
  } catch (error) {
    reviewError = error instanceof Error ? error.message : String(error);
  }
  const review = pending?.[0]?.semanticReview as TaskReviewState | undefined;
  const targetCount =
    review?.references.filter((r) => ['scene', 'shot', 'document'].includes(r.kind)).length ?? 0;
  const rawAction = pending?.[0]?.nextAction;
  const action =
    rawAction && typeof rawAction === 'object' && !Array.isArray(rawAction)
      ? (rawAction as Record<string, unknown>)
      : undefined;
  return {
    available: true,
    ...(retired ? { retiredBundle: retired } : {}),
    observedAt,
    taskId: task.id,
    status: task.status,
    phase: task.phase,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    elapsedMs: Math.max(
      0,
      Date.parse(task.completed_at ?? observedAt) - Date.parse(task.created_at),
    ),
    error: task.error_code ? { code: task.error_code, message: task.error_message } : undefined,
    saved: {
      scenes: activeScenes.length,
      shots: activeShots.size,
      materialDocuments: materialCounts,
      lastSavedAt,
    },
    review: bundleTask
      ? {
          available: false,
          reason:
            'This workflow uses structural validation and independent readback, not semantic review.',
        }
      : review
        ? {
            available: true,
            readyToSubmit: review.ready,
            approved: review.approved,
            currentTargetCount: targetCount,
            acceptedTargetCount: targetCount - review.reviewScope.length,
            pendingTargetCount: review.reviewScope.length,
            openIssueCount: review.issues.length,
          }
        : {
            available: false,
            reason: reviewError ?? 'No script-to-media review state is available.',
          },
    nextAction: action
      ? {
          kind: action.kind,
          ...('toolName' in action ? { toolName: action.toolName } : {}),
          stateRead: {
            toolName: 'conversation.task.checkpoint',
            arguments: { operation: 'state', targetGenerationId: latestGeneration },
          },
        }
      : undefined,
    calls: {
      total: calls.length,
      failed: latestFailures.length,
      failureCategories: failures,
      latestFailures: latestFailures.slice(-5),
    },
    usage: {
      turns: task.turn_count,
      inputTokens: task.input_tokens,
      outputTokens: task.output_tokens,
      instruction:
        'Cumulative input includes repeated/cached input; it is not one context window or a cost estimate.',
    },
    ...(bundle
      ? {
          bundle: {
            timing: bundleTiming(db, projectId, task.id),
            candidateCount: bundle.entries.length,
            revision: bundle.revision,
            businessSaved: bundleObjects.length > 0,
            readbackVerified: bundleReadbackRecorded(db, projectId, task.id),
            localStages: db
              .prepare(
                `SELECT json_extract(content,'$.operation') operation,
              COUNT(*) calls,
              SUM(CASE WHEN json_extract(content,'$.outcome')='failed' THEN 1 ELSE 0 END) failures,
              SUM(json_extract(content,'$.durationMs')) durationMs,
              MIN(json_extract(content,'$.startedAt')) startedAt,
              MAX(json_extract(content,'$.finishedAt')) finishedAt
              FROM agent_context_results WHERE project_id=? AND task_id=? AND tool_name='production.bundle.metric'
              GROUP BY json_extract(content,'$.operation')`,
              )
              .all(projectId, task.id),
          },
        }
      : {}),
    instruction:
      'These are current task facts, independent of historical receipt pagination. Saved output and readyToSubmit do not mean accepted review or completion. Use elapsedMs for task duration; receipt timestamps cover only those operations. Do not infer who cancelled from the terminal status.',
  };
}
