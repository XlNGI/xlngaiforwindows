import type Database from 'better-sqlite3';
import { contextContentHash } from '@ai-video/persistence';
import {
  PRODUCTION_BUNDLE_LIMITS,
  type ProductionBundleDocument,
  type ProductionBundleRef,
  type ProductionBundleShot,
  type ProductionBundleScene,
} from '@ai-video/contracts';
import {
  assertBundleInputs,
  bundleObjects,
  bundleTask,
  committedBundle,
  loadBundle,
  type BundleState,
} from './production-bundle-state.js';
import { bundlePromptIdentity } from './production-bundle-schema.js';
export function assertBundleRunBudget(
  db: Database.Database,
  projectId: string,
  taskId: string,
): void {
  const snapshot = bundleTask(db, projectId, taskId);
  const limits = {
    ...PRODUCTION_BUNDLE_LIMITS,
    ...(snapshot.productionBundleLimits as Partial<typeof PRODUCTION_BUNDLE_LIMITS>),
  };
  const task = db
    .prepare(
      'SELECT turn_count,output_tokens,created_at FROM agent_tasks WHERE id=? AND project_id=?',
    )
    .get(taskId, projectId) as {
    turn_count: number;
    output_tokens: number;
    created_at: string;
  };
  if (
    task.turn_count >= limits.taskTurns ||
    task.output_tokens >= limits.taskOutputTokens ||
    Date.now() - Date.parse(task.created_at) >= limits.taskElapsedMs
  )
    throw new Error(
      'BUNDLE_TASK_BUDGET_EXHAUSTED: Preserve candidates and committed facts; the remaining task turn, output or elapsed-time limit was reached.',
    );
  const state = loadBundle(db, projectId, taskId);
  const progressAt = state
    ? (state.progressAt ??
      state.entries.reduce((at, e) => (e.updatedAt > at ? e.updatedAt : at), state.createdAt))
    : task.created_at;
  const calls = db
    .prepare(
      `SELECT status,error_message,result_summary_json,tool_name FROM (
        SELECT status,error_message,result_summary_json,tool_name,completed_at AS at,rowid AS ordinal,0 AS origin
        FROM agent_tool_calls WHERE project_id=? AND task_id=? AND status IN ('failed','succeeded') AND completed_at>=?
        UNION ALL
        SELECT 'failed',json_extract(summary,'$.reason'),NULL,json_extract(summary,'$.operation'),created_at,sequence,1
        FROM agent_task_events WHERE project_id=? AND task_id=? AND event_type='tool_validation_failed' AND created_at>=?
      ) ORDER BY at DESC,ordinal DESC,origin DESC LIMIT 100`,
    )
    .all(projectId, taskId, progressAt, projectId, taskId, progressAt) as Array<{
    error_message: string | null;
    result_summary_json: string | null;
    status: string;
    tool_name: string;
  }>;
  const failures: string[] = [];
  for (const call of calls) {
    if (call.status === 'succeeded') {
      continue;
    }
    let reason = call.error_message ?? call.result_summary_json ?? 'Unknown tool failure';
    try {
      const parsed = JSON.parse(reason) as {
        error?: {
          message?: string;
        };
      };
      reason = parsed.error?.message ?? reason;
    } catch {
      /* Plain-text domain and preflight errors are also durable facts. */
    }
    // Do not collapse unrelated invalid fields into one generic error code.
    // Recovery references and echoed arguments change between attempts, not the cause.
    reason = reason
      .split(/\n(?:Arguments retained|No write occurred)|Received arguments:/)[0]!
      .trim();
    failures.push(`${call.tool_name}: ${reason}`);
    if (failures.length === limits.repeatedErrors) break;
  }
  if (failures.length === limits.repeatedErrors && failures.every((c) => c === failures[0]))
    throw new Error(
      `BUNDLE_NO_PROGRESS_LIMIT: ${failures[0]!.slice(0, 1000)} repeated ${failures.length} times without candidate or accepted review progress. Preserve the package and report the unresolved field.`,
    );
}
export function checkBundle(db: Database.Database, projectId: string, taskId: string) {
  bundleTask(db, projectId, taskId);
  const state = loadBundle(db, projectId, taskId);
  if (!state) throw new Error('BUNDLE_NOT_STARTED');
  assertBundleInputs(db, projectId, taskId, state);
  const objects = bundleObjects(db, projectId, taskId, state),
    errors: Array<{
      key: string;
      field: string;
      reason: string;
    }> = [];
  // Domain saves append new objects and preserve existing positions. Reject a
  // candidate order that those semantics cannot represent without reordering
  // unrelated user content.
  if (state.manifest && !committedBundle(db, projectId, taskId)) {
    const checkOrder = (keys: string[], kind: 'scene' | 'shot', sceneKey?: string) => {
      const scene = sceneKey ? (objects.get(sceneKey) as ProductionBundleScene) : undefined;
      const scopeId = kind === 'scene' ? projectId : scene?.existing?.id;
      const table = kind === 'scene' ? 'scenes' : 'shots';
      const column = kind === 'scene' ? 'project_id' : 'scene_id';
      let next = scopeId
        ? Number(
            (
              db
                .prepare(`SELECT COALESCE(MAX(position),-1)+1 n FROM ${table} WHERE ${column}=?`)
                .get(scopeId) as {
                n: number;
              }
            ).n,
          )
        : 0;
      let previous = -1;
      for (const key of keys) {
        const item = objects.get(key);
        if (!item) continue;
        const row = item.existing
          ? (db
              .prepare(`SELECT position FROM ${table} WHERE id=? AND ${column}=?`)
              .get(item.existing.id, scopeId ?? '') as
              | {
                  position: number;
                }
              | undefined)
          : undefined;
        const position = item.existing ? row?.position : next++;
        if (position === undefined) continue; // target validation reports missing/foreign objects
        if (position <= previous)
          errors.push({
            key,
            field: `manifest.${kind === 'scene' ? 'sceneKeys' : 'shotKeys'}`,
            reason:
              'BUNDLE_ORDER_CONFLICT: existing order is preserved and new objects append. Repair the manifest order; implicit reordering is not supported.',
          });
        previous = position;
      }
    };
    checkOrder(state.manifest.sceneKeys, 'scene');
    for (const sceneKey of state.manifest.sceneKeys)
      checkOrder(
        state.manifest.shotKeys.filter(
          (key) => (objects.get(key) as ProductionBundleShot | undefined)?.sceneKey === sceneKey,
        ),
        'shot',
        sceneKey,
      );
  }
  const ref = (owner: string, field: string, r: ProductionBundleRef, kind: string) => {
    if ('localKey' in r) {
      const target = objects.get(r.localKey);
      if (!target || !('kind' in target) || target.kind !== kind) {
        const publicKind = kind === 'scene' ? 'location' : kind;
        const available = [...objects.values()]
          .filter((item) => 'kind' in item && item.kind === kind)
          .map((item) => item.localKey)
          .slice(0, 20);
        errors.push({
          key: owner,
          field,
          reason: `Expected kind=${publicKind} prompt localKey; "${r.localKey}" ${target ? 'has a different kind' : 'has not been submitted'}. Available ${publicKind} localKeys: ${JSON.stringify(available)}.${kind === 'scene' ? ' Story-scene membership uses sceneKey; sceneDocumentIds binds location images.' : ''}`,
        });
      }
    } else {
      const target = state.reused.find((s) => s.documentId === r.existingId);
      if (!target || target.kind !== kind)
        errors.push({
          key: owner,
          field,
          reason: `Expected snapshotted active ${kind} existingId ${r.existingId}; rebase with its exact version before reuse.`,
        });
    }
  };
  const existingIds = new Set<string>();
  for (const entry of state.entries) {
    const item = objects.get(entry.key)!;
    if (item.existing && !committedBundle(db, projectId, taskId)) {
      if (existingIds.has(item.existing.id))
        errors.push({
          key: entry.key,
          field: 'existing',
          reason: 'Two keys cannot edit the same object.',
        });
      existingIds.add(item.existing.id);
      const row = db
        .prepare(
          entry.kind === 'document'
            ? 'SELECT kind,row_version,current_version_id,published_version_id,lifecycle_status FROM documents WHERE id=? AND project_id=?'
            : entry.kind === 'scene'
              ? 'SELECT row_version,archived_at FROM scenes WHERE id=? AND project_id=?'
              : 'SELECT s.row_version,s.archived_at,s.scene_id FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=? AND c.archived_at IS NULL',
        )
        .get(item.existing.id, projectId) as
        | {
            kind?: string;
            row_version: number;
            current_version_id?: string;
            published_version_id?: string;
            lifecycle_status?: string;
            archived_at?: string;
            scene_id?: string;
          }
        | undefined;
      if (
        !row ||
        row.row_version !== item.existing.rowVersion ||
        row.archived_at ||
        row.published_version_id ||
        (row.lifecycle_status && row.lifecycle_status !== 'active') ||
        (entry.kind === 'document' &&
          (row.kind !== (item as ProductionBundleDocument).kind ||
            row.current_version_id !== item.existing.versionId))
      )
        errors.push({
          key: entry.key,
          field: 'existing',
          reason:
            'BUNDLE_TARGET_CONFLICT: active draft, kind, rowVersion and exact current document version required.',
        });
      if (
        state.sources.some((s) => s.documentId === item.existing!.id) ||
        state.reused.some((s) => s.documentId === item.existing!.id)
      )
        errors.push({
          key: entry.key,
          field: 'existing',
          reason: 'A source or read-only reused input cannot also be overwritten by this package.',
        });
      if (entry.kind !== 'document' && row) {
        const saved = db
          .prepare(
            `SELECT timing_json FROM ${entry.kind === 'scene' ? 'scenes' : 'shots'} WHERE id=?`,
          )
          .get(item.existing.id) as {
          timing_json: string | null;
        };
        const timing = saved.timing_json
          ? (JSON.parse(saved.timing_json) as {
              locked?: boolean;
              estimatedDurationSeconds: number;
            })
          : undefined;
        const replacement = (item as ProductionBundleScene | ProductionBundleShot).timing;
        if (
          timing?.locked &&
          replacement !== undefined &&
          (replacement.estimatedDurationSeconds !== timing.estimatedDurationSeconds ||
            replacement.locked !== true)
        )
          errors.push({
            key: entry.key,
            field: 'timing',
            reason: 'Locked timing cannot be changed.',
          });
      }
      if (entry.kind === 'shot' && row?.scene_id) {
        const scene = objects.get((item as ProductionBundleShot).sceneKey);
        if (scene?.existing?.id !== row.scene_id)
          errors.push({
            key: entry.key,
            field: 'sceneKey',
            reason: 'Existing shots cannot move to a different scene.',
          });
      }
    }
    if (
      entry.kind === 'scene' &&
      !state.entries.some(
        (e) =>
          e.kind === 'shot' && (objects.get(e.key) as ProductionBundleShot).sceneKey === entry.key,
      )
    )
      errors.push({
        key: entry.key,
        field: 'shots',
        reason: 'Every story scene requires at least one shot.',
      });
    if (entry.kind === 'shot') {
      const shot = item as ProductionBundleShot;
      if (!state.entries.some((e) => e.kind === 'scene' && e.key === shot.sceneKey))
        errors.push({
          key: entry.key,
          field: 'sceneKey',
          reason: `Referenced scene localKey "${shot.sceneKey}" has not been submitted. Submit its complete scene prompt with that localKey, or correct this shot's sceneKey to an actual scene.`,
        });
    }
    const bindings = item.bindings;
    for (const [field, kind] of [
      ['characterDocumentIds', 'character'],
      ['sceneDocumentIds', 'scene'],
      ['propDocumentIds', 'prop'],
    ] as const)
      for (const r of bindings?.[field] ?? []) ref(entry.key, 'bindings.' + field, r, kind);
    if (bindings?.voiceDocumentId)
      ref(entry.key, 'bindings.voiceDocumentId', bindings.voiceDocumentId, 'voice');
    for (const pair of bindings?.voiceBindings ?? []) {
      if (pair.characterDocumentId)
        ref(
          entry.key,
          'bindings.voiceBindings.characterDocumentId',
          pair.characterDocumentId,
          'character',
        );
      ref(entry.key, 'bindings.voiceBindings.voiceDocumentId', pair.voiceDocumentId, 'voice');
    }
  }
  const sealed = state.sealedRevision === state.revision && !!state.manifest;
  const ready = sealed && !errors.length;
  return {
    status: ready ? 'bundle_structure_checked' : 'bundle_candidate_incomplete',
    bundleId: taskId,
    revision: state.revision,
    candidates: state.entries.map((entry) =>
      bundlePromptIdentity(objects.get(entry.key)!, entry.kind),
    ),
    sealed,
    errors,
    structureReady: ready,
    businessSaved: !!committedBundle(db, projectId, taskId),
  };
}
export function bundleFingerprint(state: BundleState): string {
  return contextContentHash(
    JSON.stringify([
      state.revision,
      state.entries.map((e) => [e.key, e.hash]),
      state.sources,
      state.reused,
      state.requirementsHash,
      state.manifest,
    ]),
  );
}
/** Bounded structural status projection; bodies remain in Result Store. */
export function bundleCheckPage(check: ReturnType<typeof checkBundle>, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('BUNDLE_INVALID_RANGE');
  const total = Math.max(check.candidates.length, check.errors.length);
  return {
    ...check,
    candidates: check.candidates.slice(offset, offset + 20),
    candidateTotal: check.candidates.length,
    errors: check.errors.slice(offset, offset + 20),
    errorCount: check.errors.length,
    pageOffset: offset,
    pageSize: 20,
    pageRead: { toolName: 'production.bundle', arguments: { operation: 'check', offset } },
    ...(offset + 20 < total ? { nextOffset: offset + 20 } : {}),
  };
}
