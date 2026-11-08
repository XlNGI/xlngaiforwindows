import type Database from 'better-sqlite3';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import { validateProductionTiming, type ProductionShotAuthoringIR } from '@ai-video/contracts';
import { isSavedStructureStatus } from './agent-saved-production-receipts.js';
import { hasCurrentRead, type ReviewArtifact, type ReadResult } from './agent-task-artifacts.js';
import { taskReviewState } from './agent-task-review.js';
import { taskPlanScope, STRUCTURE_DELIVERABLE_TOOLS } from './agent-task-deliverables.js';

/**
 * `ProductionAuthoringIR` deliberately keeps references optional for ordinary
 * hand-authored production. The one-click script-to-media workflow has a
 * stricter task contract: every new shot must make all three reference scopes
 * explicit, including an empty list when that scope is unused.
 */
export function requireScriptToMediaShotReferences(
  ir: ProductionShotAuthoringIR,
  label = 'shot',
): void {
  const references = ir.references;
  for (const key of ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'] as const) {
    if (!references || !Array.isArray(references[key])) {
      throw new Error(
        `SCRIPT_TO_MEDIA_REFERENCES_REQUIRED: ${label} authoringIR.references.${key} must be an array (use [] when empty).`,
      );
    }
  }
}

/** Read the frozen task declaration without making ordinary production writes strict. */
export function isScriptToMediaTask(
  database: Database.Database,
  taskId: string | undefined,
): boolean {
  if (!taskId) return false;
  const row = database
    .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id=?')
    .get(taskId) as { request_snapshot_json?: string } | undefined;
  if (!row?.request_snapshot_json) return false;
  try {
    const snapshot = JSON.parse(row.request_snapshot_json) as Record<string, unknown>;
    return snapshot.productionSkillId === 'script-to-media';
  } catch {
    return false;
  }
}

/** Exact dialogue in a read source is a business fact, not an LLM review verdict. */
function sourceDialogueCounts(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of body.split(/\r?\n/)) {
    const dialogue = /^\s*(?:[-*]\s*)?[^：:\r\n]{1,24}[：:]\s*[“"]([^”"]+)[”"]\s*$/.exec(line);
    if (!dialogue) continue;
    const text = dialogue[1]!.trim();
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

function spokenQuoteInPrompt(prompt: string, text: string): boolean {
  for (const quote of ['“' + text + '”', '"' + text + '"']) {
    let offset = prompt.indexOf(quote);
    while (offset !== -1) {
      const before = prompt.slice(Math.max(0, offset - 80), offset);
      const nearby = before.slice(-36);
      if (
        !/(?:不重复|不得重复|避免重复|不要重说|不再重复|不再说|上一镜|前一镜|前镜)/.test(nearby) &&
        /(?:[：:]\s*|(?:说|问|答|念|对白|台词)[^。；\n]{0,55})$/.test(before)
      )
        return true;
      offset = prompt.indexOf(quote, offset + quote.length);
    }
  }
  return false;
}

function sourceDialogueRepeatedAcrossShots(
  db: Database.Database,
  projectId: string,
  sources: Array<{ id: string; version: unknown; currentVersion: unknown; complete: boolean }>,
  shots: Array<{ id: string; prompt: string }>,
) {
  if (shots.length < 2) return [];
  const allowed = new Map<string, number>();
  for (const source of sources) {
    if (!source.complete || source.version !== source.currentVersion) continue;
    const row = db
      .prepare(
        'SELECT v.content_markdown body FROM document_versions v JOIN documents d ON d.id=v.document_id ' +
          'WHERE d.id=? AND d.project_id=? AND d.current_version_id=v.id',
      )
      .get(source.id, projectId) as { body: string } | undefined;
    if (!row) continue;
    for (const [text, count] of sourceDialogueCounts(row.body))
      allowed.set(text, Math.max(allowed.get(text) ?? 0, count));
  }
  return [...allowed].flatMap(([text, allowedOccurrences]) => {
    const shotIds = shots
      .filter(({ prompt }) => spokenQuoteInPrompt(prompt, text))
      .map(({ id }) => id);
    return shotIds.length > allowedOccurrences ? [{ text, allowedOccurrences, shotIds }] : [];
  });
}

/** Frozen workflow requirements apply even when the model omitted them from its plan. */
export function scriptToMediaCompletionPending(
  db: Database.Database,
  projectId: string,
  generationId: string,
  taskId: string,
  includeApproved = false,
): Array<Record<string, unknown>> | undefined {
  if (!isScriptToMediaTask(db, taskId)) return undefined;
  const documentIds = new Set<string>();
  const sceneIds = new Set<string>();
  const shotIds = new Set<string>();
  const scope = taskPlanScope(db, projectId, generationId, taskId);
  for (const item of scope)
    for (const id of item.targetIds) {
      if (item.toolName === 'document.submit_draft') documentIds.add(id);
      else if (STRUCTURE_DELIVERABLE_TOOLS.includes(item.toolName)) sceneIds.add(id);
      else shotIds.add(id);
    }
  const reads = db
    .prepare(
      `SELECT content,created_at FROM agent_context_results WHERE project_id=? AND task_id=?
       AND status='completed' AND tool_name IN ('production.read','scene.read','document.read','library.read') ORDER BY rowid`,
    )
    .all(projectId, taskId) as ReadResult[];
  for (const read of reads) {
    // Legacy tasks without an explicit contract retain their discovered scope.
    // Once targets are declared, reading another object cannot alter the contract.
    if (scope.length) break;
    try {
      const value = JSON.parse(read.content) as {
        target?: { kind?: string; id?: string };
        sceneId?: string;
        shotId?: string;
      };
      if (value.target?.kind === 'shot' && value.target.id) shotIds.add(value.target.id);
      else if (value.target?.kind === 'scene' && value.target.id) sceneIds.add(value.target.id);
    } catch {
      // Only explicit valid production targets establish the scope of reused work.
    }
  }
  const writes = db
    .prepare(
      `SELECT tool_name,result_summary_json FROM agent_tool_calls
       WHERE project_id=? AND generation_id=? AND status='succeeded'`,
    )
    .all(projectId, generationId) as Array<{ tool_name: string; result_summary_json: string }>;
  for (const row of writes) {
    if (scope.length) break;
    try {
      const result = JSON.parse(row.result_summary_json) as Record<string, unknown>;
      if (row.tool_name === 'document.submit_draft' && result.status === 'draft_saved') {
        if (typeof result.documentId === 'string') documentIds.add(result.documentId);
      } else if (
        ['scene.update_shot_prompts', 'scene.update_shot_timings'].includes(row.tool_name) &&
        ['shot_prompts_saved', 'shot_timings_saved'].includes(String(result.status))
      ) {
        const savedShots: unknown[] = Array.isArray(result.shots) ? result.shots : [];
        for (const shot of savedShots) {
          if (!shot || typeof shot !== 'object') continue;
          const shotId = (shot as Record<string, unknown>).shotId;
          if (typeof shotId === 'string') shotIds.add(shotId);
        }
      } else if (
        [
          'scene.structure.stage',
          'scene.submit_structure',
          'novel.episode.submit_structure',
        ].includes(row.tool_name) &&
        isSavedStructureStatus(result.status)
      ) {
        for (const id of Array.isArray(result.sceneIds) ? result.sceneIds : [])
          if (typeof id === 'string') sceneIds.add(id);
      }
    } catch {
      // Historical audit fragments do not identify committed artifacts.
    }
  }
  const artifacts: ReviewArtifact[] = [];
  const dependencies: Record<string, string[]> = {};
  const continuityDependencies: Record<string, string[]> = {};
  const missingTargets: string[] = [];
  const invalidShots: Array<{ shotId: string; reason: string }> = [];
  const currentShots = new Map<
    string,
    { id: string; authoring_ir_json: string; updated_at: string }
  >();
  for (const id of sceneIds) {
    const shots = db
      .prepare(
        `SELECT s.id,s.authoring_ir_json,s.updated_at FROM shots s JOIN scenes c ON c.id=s.scene_id
         WHERE c.id=? AND c.project_id=? AND c.archived_at IS NULL AND s.archived_at IS NULL`,
      )
      .all(id, projectId) as Array<{ id: string; authoring_ir_json: string; updated_at: string }>;
    for (const shot of shots) currentShots.set(shot.id, shot);
    if (!shots.length) missingTargets.push(id);
  }
  for (const id of shotIds) {
    const shot = db
      .prepare(
        `SELECT s.id,s.authoring_ir_json,s.updated_at FROM shots s JOIN scenes c ON c.id=s.scene_id
         WHERE s.id=? AND c.project_id=? AND c.archived_at IS NULL AND s.archived_at IS NULL`,
      )
      .get(id, projectId) as
      { id: string; authoring_ir_json: string; updated_at: string } | undefined;
    if (shot) currentShots.set(shot.id, shot);
    else missingTargets.push(id);
  }
  for (const shot of currentShots.values()) {
    try {
      const ir = JSON.parse(shot.authoring_ir_json) as ProductionShotAuthoringIR;
      requireScriptToMediaShotReferences(ir);
      validateProductionTiming(ir.timing);
      if (!ir.timing?.beats?.length)
        throw new Error('timing.beats must describe natural action/dialogue timing.');
      artifacts.push({
        id: shot.id,
        kind: 'shot',
        body: ir.prompt,
        updatedAt: shot.updated_at,
        versionId: contextContentHash(shot.authoring_ir_json),
      });
      for (const key of ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'] as const)
        for (const documentId of ir.references?.[key] ?? []) {
          documentIds.add(documentId);
          (dependencies[shot.id] ??= []).push(documentId);
        }
    } catch (error) {
      invalidShots.push({
        shotId: shot.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const id of documentIds) {
    const row = db
      .prepare(
        `SELECT v.content_markdown,d.updated_at,d.title,d.kind,d.current_version_id FROM documents d JOIN document_versions v
         ON v.id=d.current_version_id AND v.document_id=d.id
         WHERE d.id=? AND d.project_id=? AND d.lifecycle_status='active'`,
      )
      .get(id, projectId) as
      | {
          content_markdown: string;
          updated_at: string;
          title: string;
          kind: string;
          current_version_id: string;
        }
      | undefined;
    if (row)
      artifacts.push({
        id,
        kind: 'document',
        body: row.content_markdown,
        updatedAt: row.updated_at,
        title: row.title,
        documentKind: row.kind,
        versionId: row.current_version_id,
      });
    else missingTargets.push(id);
  }
  const unread = artifacts.filter((artifact) => !hasCurrentRead(artifact, reads));
  const planIds = artifacts
    .filter(
      (a) =>
        a.kind === 'document' &&
        a.documentKind === 'plan' &&
        (!scope.length || scope.some((item) => item.targetIds.includes(a.id))),
    )
    .map((a) => a.id);
  const orderedShots = (
    db.prepare('PRAGMA table_info(shots)').all() as Array<{ name: string }>
  ).some((column) => column.name === 'position')
    ? (db
        .prepare(
          `SELECT s.id,s.scene_id FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE c.project_id=? AND c.archived_at IS NULL AND s.archived_at IS NULL ORDER BY c.id,s.position,s.id`,
        )
        .all(projectId) as Array<{ id: string; scene_id: string }>)
    : [];
  for (const artifact of artifacts) {
    const ids = new Set(dependencies[artifact.id]);
    if (artifact.kind === 'shot') for (const id of planIds) ids.add(id);
    // Plans and actual shots are reviewed together. An in-place shot revision
    // must also invalidate approval of task plans that describe the old facts.
    // Source/independent documents outside the task contract are not rewritten.
    if (planIds.includes(artifact.id)) for (const id of currentShots.keys()) ids.add(id);
    const index = orderedShots.findIndex((shot) => shot.id === artifact.id);
    if (index >= 0)
      for (const adjacent of [orderedShots[index - 1], orderedShots[index + 1]])
        if (adjacent?.scene_id === orderedShots[index]!.scene_id && currentShots.has(adjacent.id))
          (continuityDependencies[artifact.id] ??= []).push(adjacent.id);
    const sceneId =
      artifact.kind === 'shot'
        ? (
            db.prepare('SELECT scene_id FROM shots WHERE id=?').get(artifact.id) as
              { scene_id: string } | undefined
          )?.scene_id
        : undefined;
    for (const item of scope.filter(
      (item) =>
        item.targetIds.includes(artifact.id) || (sceneId && item.targetIds.includes(sceneId)),
    ))
      for (const key of item.dependsOn ?? []) {
        const dependency = scope.find((item) => item.key === key);
        for (const id of dependency?.targetIds ?? []) {
          if (dependency && STRUCTURE_DELIVERABLE_TOOLS.includes(dependency.toolName))
            for (const shot of db
              .prepare('SELECT id FROM shots WHERE scene_id=? AND archived_at IS NULL')
              .all(id) as Array<{ id: string }>)
              ids.add(shot.id);
          else ids.add(id);
        }
      }
    dependencies[artifact.id] = [...ids].sort();
  }
  const state = new AgentContextStore(db).loadTask(projectId, taskId);
  const sources = new Map<
    string,
    { id: string; version: unknown; currentVersion: unknown; complete: boolean }
  >();
  for (const read of reads) {
    try {
      const value = JSON.parse(read.content) as Record<string, unknown>;
      const id = value.sourceId;
      if (typeof id !== 'string' || artifacts.some((a) => a.id === id)) continue;
      const version = value.versionId ?? value.version;
      const current = db
        .prepare(
          `SELECT d.id,d.current_version_id,d.updated_at,v.content_markdown FROM documents d
        LEFT JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id WHERE d.project_id=? AND
        (d.id=? OR d.id IN (SELECT document_id FROM document_versions WHERE id=?))`,
        )
        .get(projectId, id, typeof version === 'string' ? version : '') as
        | {
            id: string;
            current_version_id: string;
            updated_at: string;
            content_markdown: string | null;
          }
        | undefined;
      if (current && !artifacts.some((a) => a.id === current.id))
        sources.set(current.id, {
          id: current.id,
          version,
          currentVersion: current.current_version_id,
          complete: hasCurrentRead(
            {
              id: current.id,
              sourceIds: [id],
              kind: 'document',
              versionId: current.current_version_id,
              updatedAt: current.updated_at,
              body: current.content_markdown ?? '',
            },
            reads,
          ),
        });
    } catch {
      /* Invalid reads cannot establish source versions. */
    }
  }
  const manifest = {
    obligations: scope.map(({ key, criteria, dependsOn }) => ({ key, criteria, dependsOn })),
    dependencies,
    continuityDependencies,
    artifacts: artifacts
      .map(({ id, kind, versionId, body, updatedAt }) => ({
        id,
        kind,
        version: versionId,
        updatedAt,
        contentHash: contextContentHash(body),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    requirements: state?.userRequirements ?? [],
    decisions: state?.confirmedDecisions ?? [],
  };
  const staleSources = manifest.sources.filter((s) => s.version !== s.currentVersion);
  const unreadSources = manifest.sources.filter((s) => !s.complete);
  const orderedTaskShots = orderedShots.length
    ? orderedShots
        .filter(({ id }) => currentShots.has(id))
        .map(({ id }) => ({ id, prompt: artifacts.find((a) => a.id === id)?.body ?? '' }))
    : artifacts.filter((a) => a.kind === 'shot').map(({ id, body }) => ({ id, prompt: body }));
  const duplicateDialogue = sourceDialogueRepeatedAcrossShots(
    db,
    projectId,
    manifest.sources,
    orderedTaskShots,
  );
  const structuralReady =
    !scope.some((item) => item.targetIds.length < item.minimumCount) &&
    artifacts.some((a) => a.kind === 'shot') &&
    !invalidShots.length &&
    !unread.length &&
    manifest.sources.length > 0 &&
    !staleSources.length &&
    !unreadSources.length &&
    !duplicateDialogue.length;
  const review = taskReviewState(
    db,
    projectId,
    taskId,
    manifest,
    structuralReady && !missingTargets.length,
  );
  if (review.approved && !includeApproved) return [];
  const missingStructure = !artifacts.some((a) => a.kind === 'shot') && !invalidShots.length;
  // Reconcile the next operation from durable facts. A required review is not
  // a request to rewrite valid outputs or repeat already completed readback.
  const nextAction = missingTargets.length
    ? {
        kind: 'repair_plan',
        missingTargets,
        instruction:
          'Declared outputs are no longer active. Reconcile the contract and persisted objects; do not silently omit these targets.',
      }
    : missingStructure
      ? { kind: 'continue_outputs' }
      : invalidShots.length
        ? { kind: 'repair_outputs', outputs: invalidShots }
        : !manifest.sources.length || staleSources.length || unreadSources.length
          ? { kind: 'read_sources', sources: [...staleSources, ...unreadSources] }
          : unread.length
            ? { kind: 'read_outputs', outputs: unread.map(({ id, kind }) => ({ id, kind })) }
            : duplicateDialogue.length
              ? {
                  kind: 'repair_outputs',
                  toolName: 'scene.update_shot_prompts',
                  duplicateDialogue,
                  targetIds: [...new Set(duplicateDialogue.flatMap((item) => item.shotIds))],
                  instruction:
                    'The same exact source dialogue appears in more saved shots than the read source contains. Compare the current shot sequence with the source, repair only the affected existing shot prompts with current CAS, then read back the changed shots. Do not create new shots or weaken the task plan.',
                }
              : {
                  kind: 'review_outputs',
                  toolName: 'conversation.task.checkpoint',
                  arguments: { operation: 'review', reviewId: review.reviewId },
                  reviewScope: review.reviewScope,
                  issues: review.issues,
                };
  return [
    {
      key: 'skill:script-to-media:final-check',
      repairRequired: true,
      nextAction,
      semanticReview: {
        ...review,
        instruction:
          'Worker owns reviewId, versions and readiness. Assess reviewScope and outstanding issues against references and user requirements, including consistency between saved plans and actual shots. Submit operation=review with reviewId, reviewedTargetIds listing only targets actually assessed, conclusion, summary and structured content issues (targetId, category, description, exact evidence referenceId/quote). referenceId is the exact artifact/source/requirement ID in references, never a resultId or version ID. Findings with evidenceStatus=needs_correction are unconfirmed: correct their evidence in issues using the same issueId, or explicitly withdraw with evidence after reassessment; do not edit valid content just to satisfy a citation error. Empty passed never clears outstanding findings. Partial assessment never approves omitted targets. Never report missing reads or stale snapshots as content issues. Resolve each prior issueId explicitly after a changed target has been read, or withdraw a false positive with concrete reason and evidence without editing valid content. Unaffected explicitly approved targets retain coverage. A read receipt is not quality approval.',
      },
      missingSourceRead: manifest.sources.length === 0,
      staleSources,
      unreadSources,
      missingStructure,
      missingTargets,
      invalidShots,
      ...(duplicateDialogue.length ? { duplicateDialogue } : {}),
      unreviewedArtifacts: unread.map(({ id, kind }) => ({ id, kind })),
      readbackActions: unread.map((artifact) =>
        artifact.kind === 'shot'
          ? {
              id: artifact.id,
              kind: artifact.kind,
              tool: 'production.read',
              arguments: { target: { kind: 'shot', id: artifact.id }, view: 'authoring' },
              instruction: 'Read all versioned pages; use current rowVersion before any edit.',
            }
          : {
              id: artifact.id,
              kind: artifact.kind,
              title: artifact.title,
              tool: 'library.read',
              arguments: {
                artifact: { documentId: artifact.id, expectedVersionId: artifact.versionId },
                readMode: 'source',
              },
              expectedSourceId: artifact.id,
              expectedVersionId: artifact.versionId,
              instruction:
                'Read this known version directly; no search required, including after restart. Follow nextOffset until complete. Independent readbackActions may share one response. A read is not semantic approval.',
            },
      ),
      instruction:
        'This is an automatic runtime check, not an output deliverable. Do not copy it into operation=plan or invent an extra verification document. ' +
        (missingStructure
          ? 'No active saved shots have been identified for this task. This is outstanding work, not evidence of a previous run or existing outputs. Read the selected source, reuse or create the required material drafts, then save the scene and shot structure. '
          : invalidShots.length
            ? 'Repair only the listed invalid shots in place with current CAS, including missing timing, beats or reference arrays. '
            : duplicateDialogue.length
              ? 'Repair the listed repeated source dialogue across existing shots in place. Source occurrence counts include intentional repeated lines; do not remove valid source dialogue. '
              : 'Follow nextAction for the current verification phase. Saved structure is valid; only change it if a concrete semantic issue requires repair. ') +
        'Follow readbackActions only for unread current objects; group independent reads in one response. production.read accepts scene/shot targets; library.read accepts exact versioned task artifacts without searching again. Follow all pages. When semanticReview.ready is true, follow its reviewId, reviewScope and issueIds. Check material prompts, bindings, dialogue speakers/order/no repeats, continuity, timing and audio against actual sources. Submit only concrete content defects; system readiness is managed by Worker. Repair affected targets in place, then explicitly resolve issueIds after rereading; withdraw documented false positives without unnecessary edits. Load a tool only when its schema is absent. Do not recreate saved outputs or ask the user to continue. Readback proves text availability only, never semantic correctness.',
    },
  ];
}
