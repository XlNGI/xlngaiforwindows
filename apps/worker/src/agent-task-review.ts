import type Database from 'better-sqlite3';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import { TaskRepairError, type TaskRepairDiagnostic } from './agent-task-repair.js';
type ReviewRequirement = {
  id: string;
  text: string;
  unit?: { parentId: string; start: number; end: number; heading: string };
};
type Artifact = {
  id: string;
  kind: 'document' | 'shot' | 'scene';
  version?: string;
  contentHash: string;
  updatedAt: string;
  /** Immutable candidate in the same Result Store; absent for persisted artifacts. */
  candidate?: {
    resultId: string;
    localKey: string;
    taskId: string;
  };
};
export type ReviewManifest = {
  artifacts: Artifact[];
  sources: Array<{
    id: string;
    currentVersion: unknown;
  }>;
  requirements: ReviewRequirement[];
  originalRequirements?: Array<{
    id: string;
    text: string;
  }>;
  decisions: Array<{
    source: string;
    text: string;
  }>;
  /** Directed target -> prerequisite IDs; sources are still globally protected. */
  dependencies?: Record<string, string[]>;
  continuityDependencies?: Record<string, string[]>;
  /** Stable prerequisite content that is independent of later reference edits. */
  targetContextHashes?: Record<string, string>;
  obligations?: unknown[];
  /** Only the declared obligations applying to this target invalidate its coverage. */
  targetObligationHashes?: Record<string, string>;
};
type Snapshot = {
  schemaVersion: 3;
  artifacts: Artifact[];
  sources: Array<{
    id: string;
    version: unknown;
  }>;
  requirements: ReviewManifest['requirements'];
  originalRequirements?: ReviewManifest['originalRequirements'];
  decisions: ReviewManifest['decisions'];
  dependencies?: Record<string, string[]>;
  continuityDependencies?: Record<string, string[]>;
  targetContextHashes?: Record<string, string>;
  obligations?: unknown[];
  targetObligationHashes?: Record<string, string>;
};
type Evidence = {
  referenceId: string;
  quote: string;
  field?: string;
  version?: unknown;
};
type RequirementAssessment = {
  requirementId: string;
  requirementQuote: string;
  targetId: string;
  verdict: 'satisfied' | 'missing' | 'conflict' | 'uncertain' | 'not_applicable';
  reason: string;
  evidence: Evidence[];
};
type Issue = {
  issueId: string;
  targetId?: string;
  targetVersion?: string;
  category: string;
  description: string;
  evidence: Evidence[];
  /** A reported suspicion is durable, but invalid citations never confirm a defect. */
  evidenceStatus?: 'verified' | 'needs_correction';
  evidenceError?: string;
  legacy?: boolean;
};
type Resolution = {
  issueId: string;
  disposition: 'resolved' | 'withdrawn';
  reason: string;
  evidence: Evidence[];
};
type ReviewEvent = {
  status: 'task_review_recorded';
  protocolVersion: 5;
  assessmentId: string;
  reviewId: string;
  conclusion: string;
  summary: string;
  issues: Issue[];
  resolutions: Resolution[];
  reviewedTargetIds: string[];
  requirementAssessments: RequirementAssessment[];
  coverage: Array<{
    id: string;
    key: string;
    dependencyHash: string;
  }>;
};
export type TaskReviewState = {
  reviewId: string;
  ready: boolean;
  readyTargetIds: string[];
  requirementIds: string[];
  evidenceContract: string;
  issues: Issue[];
  reviewScope: string[];
  references: Array<{
    id: string;
    kind: string;
    version?: unknown;
  }>;
  previousConclusion?: string;
  approved: boolean;
};
const artifactKey = (artifact: Artifact) => contextContentHash(JSON.stringify(artifact));
const coverageKey = (item: ReviewEvent['coverage'][number]) =>
  JSON.stringify([item.id, item.key, item.dependencyHash]);
const dependencies = (snapshot: Snapshot, targetId: string) => {
  const seen = new Set<string>([targetId]);
  const related: Array<{
    id: string;
    key: string;
  }> = [];
  const visit = (id: string) => {
    for (const dependency of snapshot.dependencies?.[id] ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      const artifact = snapshot.artifacts.find((a) => a.id === dependency);
      related.push({ id: dependency, key: artifact ? artifactKey(artifact) : 'missing' });
      visit(dependency);
    }
  };
  visit(targetId);
  for (const id of snapshot.continuityDependencies?.[targetId] ?? []) {
    const artifact = snapshot.artifacts.find((a) => a.id === id);
    related.push({ id: `continuity:${id}`, key: artifact ? artifactKey(artifact) : 'missing' });
  }
  const targetContextHash = snapshot.targetContextHashes?.[targetId];
  if (targetContextHash) related.push({ id: 'target-context', key: targetContextHash });
  return contextContentHash(
    JSON.stringify([
      snapshot.sources,
      snapshot.requirements,
      snapshot.decisions,
      snapshot.targetObligationHashes
        ? ['target-obligations-v1', snapshot.targetObligationHashes[targetId]]
        : snapshot.obligations,
      snapshot.requirements.length ? 'requirement-evidence-v1' : undefined,
      // A snapshot with an explicit graph cannot reuse pre-graph approval.
      snapshot.dependencies ? related.sort((a, b) => a.id.localeCompare(b.id)) : undefined,
    ]),
  );
};
/** One authority: immutable snapshots and assessment events reuse the full Result Store. */
function reviewHistory(db: Database.Database, projectId: string, taskId: string) {
  const store = new AgentContextStore(db);
  const rows = db
    .prepare(
      `SELECT id FROM agent_context_results WHERE project_id=? AND task_id=?
    AND tool_name='conversation.task.checkpoint'
    AND CASE WHEN json_valid(content) THEN
      (status='completed' AND json_extract(content,'$.status')='task_review_recorded') OR
      (status='failed' AND json_extract(content,'$.error.message') LIKE 'TASK_REVIEW_EVIDENCE_INVALID:%')
    ELSE 0 END ORDER BY rowid`,
    )
    .all(projectId, taskId) as Array<{
    id: string;
  }>;
  const open = new Map<string, Issue>();
  const coverage = new Map<string, ReviewEvent['coverage'][number]>();
  const events = new Map<string, ReviewEvent>();
  const seenIssues = new Set<string>();
  for (const row of rows) {
    // Integrity failures must not silently turn a failed review into approval.
    const result = store.result(projectId, taskId, row.id)!;
    if (result.status === 'failed') {
      // Compatibility projection: old citation failures rolled back the whole
      // report. Reconstruct suspicions from its immutable arguments/snapshot,
      // never confirmed defects or approval. No historical data is rewritten.
      const args = result.arguments as Record<string, unknown> | undefined;
      if (
        args?.operation !== 'review' ||
        args.conclusion !== 'needs_revision' ||
        typeof args.reviewId !== 'string' ||
        !Array.isArray(args.issues) ||
        !Array.isArray(args.reviewedTargetIds)
      )
        continue;
      const saved = store.result(projectId, taskId, args.reviewId);
      if (saved?.toolName !== 'task.review.snapshot') continue;
      const snapshot = JSON.parse(saved.content) as Snapshot;
      for (const raw of args.issues) {
        try {
          const issue = object(raw);
          fields(issue, ['targetId', 'category', 'description', 'evidence']);
          const target = snapshot.artifacts.find((a) => a.id === issue.targetId);
          if (
            !target ||
            !args.reviewedTargetIds.includes(target.id) ||
            !['content', 'consistency', 'requirement'].includes(String(issue.category))
          )
            continue;
          const description = text(issue.description, 2000);
          const evidence = evidenceShape(issue.evidence);
          const issueId = findingId(target, String(issue.category), description, evidence);
          if (!seenIssues.has(issueId))
            open.set(issueId, {
              issueId,
              targetId: target.id,
              targetVersion: target.version,
              category: String(issue.category),
              description,
              evidence,
              evidenceStatus: 'needs_correction',
              evidenceError:
                'Prior citation validation failed. Reassess against current references; correct this issueId or explicitly withdraw with evidence.',
            });
          seenIssues.add(issueId);
        } catch {
          // Malformed envelopes are not content findings.
        }
      }
      continue;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(result.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.status !== 'task_review_recorded') continue;
    if (![2, 3, 4, 5].includes(Number(value.protocolVersion))) {
      // Old free-text findings have no trustworthy target/version. Preserve them
      // for explicit evidence-backed reassessment; old hashes never decide completion.
      if (value.conclusion === 'needs_revision' && Array.isArray(value.issues))
        for (const [index, description] of value.issues.entries()) {
          const issueId = `legacy:${row.id}:${index}`;
          if (typeof description === 'string')
            open.set(issueId, {
              issueId,
              category: 'legacy',
              description,
              evidence: [],
              legacy: true,
            });
        }
      continue;
    }
    const event = value as unknown as ReviewEvent;
    if (events.has(event.assessmentId)) continue;
    events.set(event.assessmentId, event);
    for (const issue of event.issues) {
      if (
        !seenIssues.has(issue.issueId) ||
        (Number(value.protocolVersion) >= 4 &&
          open.get(issue.issueId)?.evidenceStatus === 'needs_correction')
      )
        open.set(issue.issueId, issue);
      seenIssues.add(issue.issueId);
    }
    for (const resolution of event.resolutions) open.delete(resolution.issueId);
    // v2 inferred approval for every unreported target. Keep its findings and
    // resolutions, but require explicit reassessment before granting coverage.
    // Keep exact coverage for each prerequisite graph: later material/binding
    // assessments must not erase an unchanged, previously accepted shot phase.
    if ([3, 4, 5].includes(Number(value.protocolVersion)))
      for (const item of event.coverage)
        if (event.reviewedTargetIds.includes(item.id)) coverage.set(coverageKey(item), item);
  }
  return { open, coverage, events, seenIssues };
}
export function taskReviewState(
  db: Database.Database,
  projectId: string,
  taskId: string,
  manifest: ReviewManifest,
  ready: boolean,
  readyTargetIds?: string[],
  persistSnapshot = true,
): TaskReviewState {
  const snapshot: Snapshot = {
    schemaVersion: 3,
    artifacts: manifest.artifacts,
    sources: manifest.sources.map((s) => ({ id: s.id, version: s.currentVersion })),
    requirements: manifest.requirements,
    ...(manifest.originalRequirements
      ? { originalRequirements: manifest.originalRequirements }
      : {}),
    decisions: manifest.decisions,
    ...(manifest.obligations ? { obligations: manifest.obligations } : {}),
    ...(manifest.targetObligationHashes
      ? { targetObligationHashes: manifest.targetObligationHashes }
      : {}),
    ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
    ...(manifest.continuityDependencies
      ? { continuityDependencies: manifest.continuityDependencies }
      : {}),
    ...(manifest.targetContextHashes ? { targetContextHashes: manifest.targetContextHashes } : {}),
  };
  const content = JSON.stringify(snapshot);
  const result = persistSnapshot
    ? new AgentContextStore(db).putResult(
        projectId,
        taskId,
        `review-snapshot:${contextContentHash(content)}`,
        'task.review.snapshot',
        content,
      )
    : undefined;
  const history = reviewHistory(db, projectId, taskId);
  const issues = [...history.open.values()];
  const reviewScope = snapshot.artifacts
    .filter((a) => {
      const covered = history.coverage.has(
        coverageKey({
          id: a.id,
          key: artifactKey(a),
          dependencyHash: dependencies(snapshot, a.id),
        }),
      );
      return !covered || issues.some((i) => i.legacy || i.targetId === a.id);
    })
    .map((a) => a.id);
  return {
    reviewId: result?.id ?? '',
    ready,
    readyTargetIds: readyTargetIds ?? (ready ? snapshot.artifacts.map((a) => a.id) : []),
    requirementIds: snapshot.requirements.map((r) => r.id),
    evidenceContract:
      'For each reviewed target assess every original requirement. Use requirementIds to group Worker units sharing verdict/reason/evidence; omit requirementQuote. not_applicable may also group explicit targetIds sharing scope reasoning. Every pair is still validated; at most 1000 expanded pairs per batch. Review a small set of ready targets per call; omitted targets stay pending and accepted current coverage survives later batches. requirementAssessments contain requirementId, targetId, verdict, reason and field-specific evidence. For Worker units omit requirementQuote or quote the complete unit; legacy requirements require an exact excerpt. Decompose multiple obligations into multiple assessments; recheck the full original text for omissions. satisfied must cite that target prompt/contentMarkdown; auxiliary timing/data cannot prove a prompt requirement. not_applicable needs concrete source/requirement evidence and scope reasoning. missing/conflict/uncertain require an open issue on that target. reviewId is this Result Store UUID, never a content hash. Read the snapshot with operation=result if original requirements are not in the working set. A partial result accepts only reviewedTargetIds; repair assessmentErrors for rejectedTargetIds without repeating accepted targets.',
    issues,
    reviewScope,
    references: [
      ...snapshot.artifacts.map((a) => ({ id: a.id, kind: a.kind, version: a.version })),
      ...snapshot.sources.map((s) => ({ id: s.id, kind: 'source', version: s.version })),
      ...snapshot.requirements.map((r) => ({ id: r.id, kind: 'requirement' })),
    ],
    previousConclusion: issues.length
      ? 'needs_revision'
      : [...history.events.values()].at(-1)?.conclusion === 'partial'
        ? 'partial'
        : history.events.size
          ? 'passed'
          : undefined,
    approved: ready && !issues.length && !reviewScope.length,
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TASK_REVIEW_INVALID: Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('TASK_REVIEW_INVALID: Missing concrete description, reason or evidence.');
  return value;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new Error('TASK_REVIEW_INVALID: Unsupported review field.');
}
const findingId = (target: Artifact, category: string, description: string, evidence: Evidence[]) =>
  `issue:${contextContentHash(JSON.stringify([target.id, target.version, category, description, evidence]))}`;
function evidenceShape(value: unknown): Evidence[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new Error('TASK_REVIEW_EVIDENCE_REQUIRED');
  return value.map((raw) => {
    const e = object(raw);
    fields(e, ['referenceId', 'quote', 'field', 'version']);
    if (
      e.field !== undefined &&
      (typeof e.field !== 'string' ||
        !['prompt', 'contentMarkdown', 'timing', 'bindings', 'requirement', 'sampleText'].includes(
          e.field,
        ))
    )
      throw new Error('TASK_REVIEW_EVIDENCE_INVALID: Unsupported evidence field.');
    return {
      referenceId: text(e.referenceId, 256),
      quote: text(e.quote, 2000),
      ...(typeof e.field === 'string' ? { field: e.field } : {}),
      ...(e.version !== undefined ? { version: e.version } : {}),
    };
  });
}
/** Validate exact citations against current persisted content; the LLM judges their meaning. */
function evidenceFor(
  db: Database.Database,
  projectId: string,
  snapshot: Snapshot,
  value: unknown,
): Evidence[] {
  return evidenceShape(value).map(({ referenceId, quote, field, version }) => {
    const artifact = snapshot.artifacts.find((a) => a.id === referenceId);
    const source = snapshot.sources.find((s) => s.id === referenceId);
    const requirement = snapshot.requirements.find((r) => r.id === referenceId);
    if (
      version !== undefined &&
      JSON.stringify(version) !== JSON.stringify(artifact?.version ?? source?.version)
    )
      throw new Error(
        'TASK_REVIEW_EVIDENCE_INVALID: Supplied version differs from current snapshot. Omit version; Worker manages it.',
      );
    let body = requirement?.text;
    if (artifact?.candidate) {
      const result = new AgentContextStore(db).result(
        projectId,
        artifact.candidate.taskId,
        artifact.candidate.resultId,
      );
      if (!result || result.toolName !== 'production.bundle.part')
        throw new Error('TASK_REVIEW_EVIDENCE_INVALID: Missing immutable candidate.');
      const part = JSON.parse(result.content) as {
        documents: Array<Record<string, unknown>>;
        scenes: Array<Record<string, unknown>>;
        shots: Array<Record<string, unknown>>;
      };
      const item = [...part.documents, ...part.scenes, ...part.shots].find(
        (i) => i.localKey === artifact.candidate!.localKey,
      );
      if (!item || contextContentHash(JSON.stringify(item)) !== artifact.contentHash)
        throw new Error('TASK_REVIEW_EVIDENCE_INVALID: Candidate hash differs.');
      const selected = field ?? 'prompt';
      const allowed =
        artifact.kind === 'document'
          ? ['prompt', 'contentMarkdown', 'sampleText', 'bindings']
          : ['prompt', 'bindings', 'timing'];
      if (!allowed.includes(selected))
        throw new Error(
          `TASK_REVIEW_EVIDENCE_INVALID: referenceId=${referenceId} is a candidate; use its ${allowed.join('/')} field. For original requirement text, use field=requirement and that requirement's actual ID, never a candidate ID or a Skill quote.`,
        );
      body = evidenceBody(
        selected === 'prompt' ? (item.contentMarkdown ?? item.prompt) : item[selected],
      );
    } else if (artifact?.kind === 'shot' || artifact?.kind === 'scene') {
      const row = db
        .prepare(
          artifact.kind === 'scene'
            ? 'SELECT video_prompt AS prompt,bindings_json,timing_json FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL'
            : 'SELECT s.prompt,s.bindings_json,s.timing_json FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=? AND s.archived_at IS NULL AND c.archived_at IS NULL',
        )
        .get(referenceId, projectId) as
        | { prompt: string | null; bindings_json: string | null; timing_json: string | null }
        | undefined;
      if (field && !['prompt', 'bindings', 'timing'].includes(field))
        throw new Error('TASK_REVIEW_EVIDENCE_INVALID: Use prompt, bindings or timing.');
      body = row
        ? evidenceBody(
            !field || field === 'prompt'
              ? row.prompt
              : JSON.parse((field === 'bindings' ? row.bindings_json : row.timing_json) ?? 'null'),
          )
        : undefined;
    } else if (artifact || source) {
      if (field && !['contentMarkdown', 'sampleText', 'bindings'].includes(field))
        throw new Error(
          'TASK_REVIEW_EVIDENCE_INVALID: Document evidence uses contentMarkdown, sampleText or bindings.',
        );
      const row = db
        .prepare(
          `SELECT v.content_markdown,v.sample_text,v.bindings_json FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.id=? AND d.project_id=? AND v.id=?`,
        )
        .get(referenceId, projectId, artifact?.version ?? source?.version) as
        | {
            content_markdown: string;
            sample_text: string | null;
            bindings_json: string | null;
          }
        | undefined;
      body = row
        ? evidenceBody(
            field === 'bindings'
              ? JSON.parse(row.bindings_json ?? 'null')
              : field === 'sampleText'
                ? row.sample_text
                : row.content_markdown,
          )
        : undefined;
    }
    if (!artifact && !source && !requirement)
      throw new Error(
        `TASK_REVIEW_EVIDENCE_INVALID: referenceId=${referenceId} is absent from current semanticReview.references. Use the artifact/source ID, not a resultId or version ID.`,
      );
    if (!body?.includes(quote))
      throw new Error(
        `TASK_REVIEW_EVIDENCE_INVALID: referenceId=${referenceId} does not contain the exact quote in its current snapshot version. Read that reference and quote its actual text.`,
      );
    if (requirement && field && field !== 'requirement')
      throw new Error(
        'TASK_REVIEW_EVIDENCE_INVALID: Requirement evidence must identify requirement.',
      );
    return {
      referenceId,
      quote,
      field:
        field ??
        (requirement
          ? 'requirement'
          : artifact?.kind === 'shot' || artifact?.kind === 'scene'
            ? 'prompt'
            : 'contentMarkdown'),
      version: artifact?.version ?? source?.version,
    };
  });
}
function evidenceBody(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? undefined
      : JSON.stringify(value);
}
/** The authorized tool boundary persists the returned event in its existing transaction. */
export function submitTaskReview(
  db: Database.Database,
  projectId: string,
  taskId: string,
  args: Record<string, unknown>,
  current: TaskReviewState | undefined,
): Record<string, unknown> {
  fields(args, [
    'operation',
    'reviewId',
    'reviewedTargetIds',
    'conclusion',
    'summary',
    'issues',
    'resolutions',
    'requirementAssessments',
  ]);
  const store = new AgentContextStore(db);
  const invalid = (
    code: string,
    field: string,
    message: string,
    facts: Partial<TaskRepairDiagnostic> = {},
  ): TaskRepairError =>
    new TaskRepairError(`${code}: ${message}`, {
      kind: 'review',
      code,
      field,
      reviewId: current?.reviewId,
      ...(current?.reviewId
        ? { snapshotRead: { operation: 'result', resultId: current.reviewId } }
        : {}),
      instruction:
        'Correct only the identified field or submit a smaller set of ready targets. Use exact current IDs and verbatim original requirement text; keep accepted targets and saved content unchanged.',
      ...facts,
    });
  const saved =
    typeof args.reviewId === 'string' ? store.result(projectId, taskId, args.reviewId) : undefined;
  if (
    !current ||
    !saved ||
    saved.toolName !== 'task.review.snapshot' ||
    args.reviewId !== current.reviewId
  )
    throw invalid(
      'TASK_REVIEW_STALE',
      'reviewId',
      'No content finding recorded. Read operation=state pendingActions and use the current Worker reviewId.',
      { expected: current?.reviewId, received: args.reviewId },
    );
  if (
    !current.ready &&
    !(
      Array.isArray(args.reviewedTargetIds) &&
      args.reviewedTargetIds.length &&
      args.reviewedTargetIds.every((id) => current.readyTargetIds.includes(String(id)))
    )
  )
    throw invalid(
      'TASK_REVIEW_NOT_READY',
      'reviewedTargetIds',
      'No content finding recorded. Follow operation=state pendingActions to read only missing current versions or repair structural data.',
      { allowedValues: current.readyTargetIds },
    );
  const snapshot = JSON.parse(saved.content) as Snapshot;
  const summary = text(args.summary, 4000);
  if (
    !['passed', 'needs_revision'].includes(String(args.conclusion)) ||
    !Array.isArray(args.issues) ||
    args.issues.length > 100 ||
    (args.resolutions !== undefined &&
      (!Array.isArray(args.resolutions) || args.resolutions.length > 100))
  )
    throw new Error('TASK_REVIEW_INVALID');
  const assessmentId = contextContentHash(
    JSON.stringify([
      args.reviewId,
      args.reviewedTargetIds,
      args.conclusion,
      summary,
      args.issues,
      args.resolutions ?? [],
      args.requirementAssessments ?? [],
    ]),
  );
  const history = reviewHistory(db, projectId, taskId);
  const replay = history.events.get(assessmentId);
  if (replay) return { ...replay };
  if (
    !Array.isArray(args.reviewedTargetIds) ||
    !args.reviewedTargetIds.length ||
    args.reviewedTargetIds.length > 1000 ||
    args.reviewedTargetIds.some(
      (id) => typeof id !== 'string' || !current.reviewScope.includes(id),
    ) ||
    new Set(args.reviewedTargetIds).size !== args.reviewedTargetIds.length
  )
    throw invalid(
      'TASK_REVIEW_SCOPE_INVALID',
      'reviewedTargetIds',
      'Explicitly list only assessed targets from current reviewScope in reviewedTargetIds. Omitted targets remain pending.',
      { allowedValues: current.reviewScope },
    );
  const reviewedTargetIds = args.reviewedTargetIds as string[];
  const issues: Issue[] = args.issues.map((raw, index) => {
    const issue = object(raw);
    fields(issue, ['issueId', 'targetId', 'category', 'description', 'evidence']);
    const target = snapshot.artifacts.find((a) => a.id === issue.targetId);
    if (!target || !['content', 'consistency', 'requirement'].includes(String(issue.category)))
      throw invalid(
        'TASK_REVIEW_TARGET_INVALID',
        'issues.targetId',
        'Content findings require a current artifact and a content category. System readiness is managed by Worker.',
        { index, received: issue.targetId, allowedValues: current.reviewScope },
      );
    if (!reviewedTargetIds.includes(target.id))
      throw invalid(
        'TASK_REVIEW_SCOPE_INVALID',
        'reviewedTargetIds',
        'Include every finding target in reviewedTargetIds. The suggested batch is not mandatory for reporting a defect: select the actual affected current targets and remove unrelated targets from this assessment.',
        {
          index,
          targetId: target.id,
          received: reviewedTargetIds,
          allowedValues: current.reviewScope,
        },
      );
    const prior = typeof issue.issueId === 'string' ? history.open.get(issue.issueId) : undefined;
    if (
      issue.issueId !== undefined &&
      (!prior || prior.evidenceStatus !== 'needs_correction' || prior.targetId !== target.id)
    )
      throw invalid(
        'TASK_REVIEW_ISSUE_INVALID',
        'issues.issueId',
        'issueId in issues may only correct evidence for an open needs_correction finding on the same target. Close verified findings through resolutions.',
        {
          index,
          ...(typeof issue.issueId === 'string' ? { issueId: issue.issueId } : {}),
          targetId: target.id,
        },
      );
    const description = text(issue.description, 2000);
    let evidence: Evidence[], evidenceError: string | undefined;
    try {
      evidence = evidenceFor(db, projectId, snapshot, issue.evidence);
    } catch (error) {
      // Only exact-citation failures become pending corrections. Invalid envelope,
      // stale snapshot and system readiness errors still reject the request.
      if (!(error instanceof Error) || !error.message.startsWith('TASK_REVIEW_EVIDENCE_INVALID:'))
        throw error;
      evidenceError = error.message;
      evidence = issue.evidence as Evidence[];
    }
    const issueId =
      prior?.issueId ?? findingId(target, String(issue.category), description, evidence);
    return {
      issueId,
      targetId: target.id,
      targetVersion: target.version,
      category: String(issue.category),
      description,
      evidence,
      evidenceStatus: evidenceError ? 'needs_correction' : 'verified',
      ...(evidenceError ? { evidenceError } : {}),
    };
  });
  const resolutions: Resolution[] = ((args.resolutions as unknown[]) ?? []).map((raw, index) => {
    const r = object(raw);
    fields(r, ['issueId', 'disposition', 'reason', 'evidence']);
    const issue = history.open.get(String(r.issueId));
    const facts = {
      index,
      issueId: String(r.issueId),
      ...(issue?.targetId ? { targetId: issue.targetId } : {}),
    };
    if (!issue || !['resolved', 'withdrawn'].includes(String(r.disposition)))
      throw invalid(
        'TASK_REVIEW_ISSUE_INVALID',
        'resolutions',
        'Use an open issueId and a supported disposition.',
        facts,
      );
    if (issue.targetId && !reviewedTargetIds.includes(issue.targetId))
      throw invalid(
        'TASK_REVIEW_SCOPE_INVALID',
        'reviewedTargetIds',
        'Reassess the issue target before closing it.',
        facts,
      );
    if (r.disposition === 'resolved') {
      const target = snapshot.artifacts.find((a) => a.id === issue.targetId);
      if (issue.legacy || !target || target.version === issue.targetVersion)
        throw invalid(
          'TASK_REVIEW_TARGET_UNCHANGED',
          'disposition',
          'Reassess a false positive with disposition=withdrawn and concrete evidence; resolving requires a changed, fully read target.',
          facts,
        );
    }
    let evidence: Evidence[];
    try {
      evidence = evidenceFor(db, projectId, snapshot, r.evidence);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TASK_REVIEW_')) throw error;
      throw invalid('TASK_REVIEW_EVIDENCE_INVALID', 'resolutions.evidence', error.message, facts);
    }
    const relevant = evidence.some((e) =>
      r.disposition === 'resolved'
        ? e.referenceId === issue.targetId
        : issue.legacy ||
          e.referenceId === issue.targetId ||
          issue.evidence.some((prior) => prior.referenceId === e.referenceId),
    );
    if (!relevant)
      throw invalid(
        'TASK_REVIEW_EVIDENCE_UNRELATED',
        'resolutions.evidence',
        'Repair evidence must cite the changed target; withdrawal evidence must cite the finding target or its original references.',
        {
          ...facts,
          allowedValues:
            r.disposition === 'resolved'
              ? [issue.targetId!]
              : [
                  ...new Set(
                    [issue.targetId, ...issue.evidence.map((e) => e.referenceId)].filter(
                      (id): id is string => !!id,
                    ),
                  ),
                ],
        },
      );
    return {
      issueId: issue.issueId,
      disposition: r.disposition as Resolution['disposition'],
      reason: text(r.reason, 2000),
      evidence,
    };
  });
  if (new Set(issues.map((i) => i.issueId)).size !== issues.length)
    throw new Error('TASK_REVIEW_ISSUE_INVALID: Duplicate finding.');
  if (issues.some((i) => history.seenIssues.has(i.issueId) && !history.open.has(i.issueId)))
    throw new Error(
      'TASK_REVIEW_ISSUE_CLOSED: A closed finding cannot be resurrected by replaying the same assessment. Provide new evidence for a new defect.',
    );
  if (new Set(resolutions.map((r) => r.issueId)).size !== resolutions.length)
    throw new Error('TASK_REVIEW_ISSUE_INVALID: Duplicate resolution.');
  if (
    issues.some((issue) => resolutions.some((resolution) => resolution.issueId === issue.issueId))
  )
    throw new Error(
      'TASK_REVIEW_ISSUE_INVALID: Correcting and closing the same finding in one assessment is contradictory. Reassess it once with current evidence.',
    );
  for (const r of resolutions) history.open.delete(r.issueId);
  for (const i of issues) history.open.set(i.issueId, i);
  const blockingIssue = [...history.open.values()].find(
    (issue) => issue.legacy || !issue.targetId || reviewedTargetIds.includes(issue.targetId),
  );
  if (args.conclusion === 'passed' && blockingIssue)
    throw invalid(
      'TASK_REVIEW_UNRESOLVED',
      'resolutions',
      'Explicitly resolve or withdraw each outstanding issue on the reviewed targets by issueId with evidence. Issues on omitted targets stay open and block stage completion.',
      { issueId: blockingIssue.issueId, targetId: blockingIssue.targetId },
    );
  if (args.conclusion === 'needs_revision' && !history.open.size)
    throw new Error('TASK_REVIEW_INVALID: needs_revision requires a concrete content finding.');
  const requirementAssessments: RequirementAssessment[] = [];
  const assessmentErrors: TaskRepairError[] = [];
  if (
    args.requirementAssessments !== undefined &&
    (!Array.isArray(args.requirementAssessments) || args.requirementAssessments.length > 1000)
  )
    throw new Error(
      'TASK_REVIEW_REQUIREMENTS_INVALID: Provide at most 1000 scoped assessments per call; use partial target reviews.',
    );
  const validateAssessment = (raw: unknown, index: number): RequirementAssessment => {
    const assessment = object(raw);
    fields(assessment, [
      'requirementId',
      'requirementQuote',
      'targetId',
      'verdict',
      'reason',
      'evidence',
    ]);
    const requirement = snapshot.requirements.find((r) => r.id === assessment.requirementId);
    const facts = {
      index,
      ...(reviewedTargetIds.includes(String(assessment.targetId))
        ? { targetId: String(assessment.targetId) }
        : {}),
      ...(requirement ? { requirementId: requirement.id } : {}),
    };
    const reject = (field: string, message: string, extra: Partial<TaskRepairDiagnostic> = {}) =>
      invalid(
        'TASK_REVIEW_REQUIREMENTS_INVALID',
        field,
        `requirementAssessments[${index}].${field}: ${message}`,
        { ...facts, ...extra },
      );
    if (!requirement)
      throw reject('requirementId', 'Use a current original requirement ID.', {
        received: assessment.requirementId,
        allowedValues: snapshot.requirements.map((r) => r.id),
      });
    // Unit IDs point at immutable, verbatim original slices. The model need not recopy them.
    const quote = assessment.requirementQuote ?? (requirement.unit ? requirement.text : undefined);
    if (
      typeof quote !== 'string' ||
      !quote.trim() ||
      quote.length > 2000 ||
      !requirement.text.includes(quote) ||
      (requirement.unit && quote !== requirement.text)
    )
      throw reject(
        'requirementQuote',
        'For a Worker unit omit requirementQuote or quote its complete exact text; do not replace it with one sentence. Legacy requirements need a verbatim excerpt.',
        {
          received: typeof quote === 'string' ? quote.slice(0, 160) : null,
          expected: {
            requirementId: requirement.id,
            policy: 'verbatim substring, 1–2000 characters',
          },
        },
      );
    if (!reviewedTargetIds.includes(String(assessment.targetId)))
      throw reject('targetId', 'Target is outside reviewedTargetIds.', {
        received: assessment.targetId,
        allowedValues: reviewedTargetIds,
      });
    const verdicts = ['satisfied', 'missing', 'conflict', 'uncertain', 'not_applicable'];
    if (!verdicts.includes(String(assessment.verdict)))
      throw reject('verdict', 'Use a supported verdict.', {
        received: assessment.verdict,
        allowedValues: verdicts,
      });
    let evidence: Evidence[];
    try {
      evidence = evidenceFor(db, projectId, snapshot, assessment.evidence);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TASK_REVIEW_')) throw error;
      throw invalid(
        'TASK_REVIEW_EVIDENCE_INVALID',
        'evidence',
        `requirementAssessments[${index}].evidence: ${error.message}`,
        facts,
      );
    }
    if (
      assessment.verdict === 'satisfied' &&
      !evidence.some(
        (e) =>
          e.referenceId === assessment.targetId &&
          ['prompt', 'contentMarkdown'].includes(e.field ?? ''),
      )
    )
      throw invalid(
        'TASK_REVIEW_BODY_EVIDENCE_REQUIRED',
        'evidence',
        'satisfied must cite the actual target prompt/contentMarkdown, never timing/data or a model summary.',
        facts,
      );
    if (
      assessment.verdict === 'not_applicable' &&
      !evidence.some(
        (e) =>
          e.referenceId === requirement.id || snapshot.sources.some((s) => s.id === e.referenceId),
      )
    )
      throw invalid(
        'TASK_REVIEW_SCOPE_EVIDENCE_REQUIRED',
        'evidence',
        'Explain applicability using the original requirement or a current source.',
        facts,
      );
    if (
      ['missing', 'conflict', 'uncertain'].includes(String(assessment.verdict)) &&
      ![...history.open.values()].some((i) => i.targetId === assessment.targetId)
    )
      throw invalid(
        'TASK_REVIEW_REQUIREMENT_ISSUE_REQUIRED',
        'evidence',
        'Keep missing/conflicting/uncertain requirements open as a concrete issue on the affected target.',
        facts,
      );
    let reason: string;
    try {
      reason = text(assessment.reason, 2000);
    } catch {
      throw reject('reason', 'Explain the assessment in 1–2000 characters.');
    }
    return {
      requirementId: requirement.id,
      requirementQuote: quote,
      targetId: String(assessment.targetId),
      verdict: assessment.verdict as RequirementAssessment['verdict'],
      reason,
      evidence,
    };
  };
  const assessments = ((args.requirementAssessments ?? []) as unknown[]).flatMap((raw) => {
    const assessment = object(raw);
    const { requirementIds, targetIds, ...single } = assessment;
    if (
      requirementIds !== undefined &&
      (Object.hasOwn(assessment, 'requirementId') ||
        Object.hasOwn(assessment, 'requirementQuote') ||
        !Array.isArray(requirementIds) ||
        !requirementIds.length ||
        requirementIds.length > 1000 ||
        new Set(requirementIds).size !== requirementIds.length ||
        requirementIds.some((id) => !snapshot.requirements.some((r) => r.id === id && r.unit)))
    )
      throw invalid(
        'TASK_REVIEW_REQUIREMENTS_INVALID',
        'requirementIds',
        'Group distinct current Worker unit IDs with a shared verdict, reason and evidence; omit requirementId and requirementQuote.',
      );
    const selected = (requirementIds ?? [assessment.requirementId]) as string[];
    if (
      targetIds !== undefined &&
      (!selected.every((id) => snapshot.requirements.some((r) => r.id === id && r.unit)) ||
        assessment.verdict !== 'not_applicable' ||
        Object.hasOwn(assessment, 'targetId') ||
        !Array.isArray(targetIds) ||
        !targetIds.length ||
        targetIds.length > 1000 ||
        targetIds.some((id) => typeof id !== 'string' || !reviewedTargetIds.includes(id)) ||
        new Set(targetIds).size !== targetIds.length)
    )
      throw invalid(
        'TASK_REVIEW_REQUIREMENTS_INVALID',
        'targetIds',
        'Grouped targets require a current Worker unit, not_applicable, distinct explicit reviewed targets and a shared scope reason. satisfied needs individual target evidence.',
      );
    const targets = targetIds === undefined ? [assessment.targetId] : (targetIds as string[]);
    if (selected.length * targets.length > 1000)
      throw new Error(
        'TASK_REVIEW_REQUIREMENTS_INVALID: At most 1000 expanded assessments; review fewer targets per batch.',
      );
    return selected.flatMap((requirementId) => {
      const requirement = snapshot.requirements.find((r) => r.id === requirementId);
      const evidence =
        assessment.evidence === undefined &&
        requirement?.unit &&
        assessment.verdict === 'not_applicable'
          ? [{ referenceId: requirement.id, quote: requirement.text, field: 'requirement' }]
          : assessment.evidence;
      return targets.map((targetId) => ({ ...single, requirementId, targetId, evidence }));
    });
  });
  if (assessments.length > 1000)
    throw new Error(
      'TASK_REVIEW_REQUIREMENTS_INVALID: At most 1000 expanded assessments; review fewer targets per batch.',
    );
  for (const [index, raw] of assessments.entries()) {
    try {
      requirementAssessments.push(validateAssessment(raw, index));
    } catch (error) {
      if (!(error instanceof TaskRepairError)) throw error;
      // An unscoped envelope cannot be partly accepted. Scoped argument errors
      // invalidate that whole target, never just the faulty requirement row.
      if (!error.repair.targetId || args.conclusion !== 'passed') throw error;
      assessmentErrors.push(error);
    }
  }
  for (const targetId of reviewedTargetIds)
    for (const requirement of snapshot.requirements)
      if (
        args.conclusion === 'passed' &&
        !requirementAssessments.some(
          (a) => a.targetId === targetId && a.requirementId === requirement.id,
        )
      )
        if (!assessmentErrors.some((error) => error.repair.targetId === targetId))
          assessmentErrors.push(
            invalid(
              'TASK_REVIEW_REQUIREMENT_COVERAGE_REQUIRED',
              'requirementAssessments',
              `targetId=${targetId} requirementId=${requirement.id}. Assess every original requirement, including applicable obligations omitted from the model plan.`,
              { targetId, requirementId: requirement.id },
            ),
          );
  const rejectedTargetIds = [...new Set(assessmentErrors.map((error) => error.repair.targetId!))];
  const acceptedTargetIds = reviewedTargetIds.filter((id) => !rejectedTargetIds.includes(id));
  if (assessmentErrors.length && (!acceptedTargetIds.length || resolutions.length))
    throw assessmentErrors[0]!;
  return {
    status: 'task_review_recorded',
    protocolVersion: 5,
    assessmentId,
    reviewId: current.reviewId,
    conclusion: assessmentErrors.length ? 'partial' : args.conclusion,
    ...(assessmentErrors.length
      ? {
          requestedConclusion: args.conclusion,
          rejectedTargetIds,
          assessmentErrors: assessmentErrors.map((error) => ({
            message: error.message,
            repair: error.repair,
          })),
          instruction:
            'Only reviewedTargetIds were accepted. Keep those targets; correct the rejectedTargetIds using assessmentErrors and the current Worker reviewId. This partial result does not approve the whole stage.',
        }
      : {}),
    summary,
    issues,
    resolutions,
    reviewedTargetIds: acceptedTargetIds,
    requirementAssessments: requirementAssessments.filter((a) =>
      acceptedTargetIds.includes(a.targetId),
    ),
    coverage: snapshot.artifacts
      .filter(
        (a) =>
          acceptedTargetIds.includes(a.id) &&
          snapshot.requirements.every((r) =>
            requirementAssessments.some(
              (assessment) => assessment.targetId === a.id && assessment.requirementId === r.id,
            ),
          ) &&
          ![...history.open.values()].some((i) => i.targetId === a.id),
      )
      .map((a) => ({
        id: a.id,
        key: artifactKey(a),
        dependencyHash: dependencies(snapshot, a.id),
      })),
  };
}
