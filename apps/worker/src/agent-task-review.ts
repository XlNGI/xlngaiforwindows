import type Database from 'better-sqlite3';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';

type Artifact = {
  id: string;
  kind: 'document' | 'shot';
  version?: string;
  contentHash: string;
  updatedAt: string;
};
export type ReviewManifest = {
  artifacts: Artifact[];
  sources: Array<{ id: string; currentVersion: unknown }>;
  requirements: Array<{ id: string; text: string }>;
  decisions: Array<{ source: string; text: string }>;
  /** Directed target -> prerequisite IDs; sources are still globally protected. */
  dependencies?: Record<string, string[]>;
  continuityDependencies?: Record<string, string[]>;
  obligations?: unknown[];
};
type Snapshot = {
  schemaVersion: 2;
  artifacts: Artifact[];
  sources: Array<{ id: string; version: unknown }>;
  requirements: ReviewManifest['requirements'];
  decisions: ReviewManifest['decisions'];
  dependencies?: Record<string, string[]>;
  continuityDependencies?: Record<string, string[]>;
  obligations?: unknown[];
};
type Evidence = { referenceId: string; quote: string; version?: unknown };
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
  protocolVersion: 4;
  assessmentId: string;
  reviewId: string;
  conclusion: string;
  summary: string;
  issues: Issue[];
  resolutions: Resolution[];
  reviewedTargetIds: string[];
  coverage: Array<{ id: string; key: string; dependencyHash: string }>;
};
export type TaskReviewState = {
  reviewId: string;
  ready: boolean;
  issues: Issue[];
  reviewScope: string[];
  references: Array<{ id: string; kind: string; version?: unknown }>;
  previousConclusion?: string;
  approved: boolean;
};

const artifactKey = (artifact: Artifact) => contextContentHash(JSON.stringify(artifact));
const dependencies = (snapshot: Snapshot, targetId: string) => {
  const seen = new Set<string>([targetId]);
  const related: Array<{ id: string; key: string }> = [];
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
  return contextContentHash(
    JSON.stringify([
      snapshot.sources,
      snapshot.requirements,
      snapshot.decisions,
      snapshot.obligations,
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
    .all(projectId, taskId) as Array<{ id: string }>;
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
    if (![2, 3, 4].includes(Number(value.protocolVersion))) {
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
        (value.protocolVersion === 4 &&
          open.get(issue.issueId)?.evidenceStatus === 'needs_correction')
      )
        open.set(issue.issueId, issue);
      seenIssues.add(issue.issueId);
    }
    for (const resolution of event.resolutions) open.delete(resolution.issueId);
    // v2 inferred approval for every unreported target. Keep its findings and
    // resolutions, but require explicit reassessment before granting coverage.
    if (value.protocolVersion === 3 || value.protocolVersion === 4)
      for (const item of event.coverage)
        if (event.reviewedTargetIds.includes(item.id)) coverage.set(item.id, item);
  }
  return { open, coverage, events, seenIssues };
}

export function taskReviewState(
  db: Database.Database,
  projectId: string,
  taskId: string,
  manifest: ReviewManifest,
  ready: boolean,
): TaskReviewState {
  const snapshot: Snapshot = {
    schemaVersion: 2,
    artifacts: manifest.artifacts,
    sources: manifest.sources.map((s) => ({ id: s.id, version: s.currentVersion })),
    requirements: manifest.requirements,
    decisions: manifest.decisions,
    ...(manifest.obligations ? { obligations: manifest.obligations } : {}),
    ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
    ...(manifest.continuityDependencies
      ? { continuityDependencies: manifest.continuityDependencies }
      : {}),
  };
  const content = JSON.stringify(snapshot);
  const result = new AgentContextStore(db).putResult(
    projectId,
    taskId,
    `review-snapshot:${contextContentHash(content)}`,
    'task.review.snapshot',
    content,
  );
  const history = reviewHistory(db, projectId, taskId);
  const issues = [...history.open.values()];
  const reviewScope = snapshot.artifacts
    .filter((a) => {
      const covered = history.coverage.get(a.id);
      return (
        covered?.key !== artifactKey(a) ||
        covered.dependencyHash !== dependencies(snapshot, a.id) ||
        issues.some((i) => i.legacy || i.targetId === a.id)
      );
    })
    .map((a) => a.id);
  return {
    reviewId: result.id,
    ready,
    issues,
    reviewScope,
    references: [
      ...snapshot.artifacts.map((a) => ({ id: a.id, kind: a.kind, version: a.version })),
      ...snapshot.sources.map((s) => ({ id: s.id, kind: 'source', version: s.version })),
      ...snapshot.requirements.map((r) => ({ id: r.id, kind: 'requirement' })),
    ],
    previousConclusion: issues.length
      ? 'needs_revision'
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
    fields(e, ['referenceId', 'quote']);
    return { referenceId: text(e.referenceId, 256), quote: text(e.quote, 2000) };
  });
}

/** Validate exact citations against current persisted content; the LLM judges their meaning. */
function evidenceFor(
  db: Database.Database,
  projectId: string,
  snapshot: Snapshot,
  value: unknown,
): Evidence[] {
  return evidenceShape(value).map(({ referenceId, quote }) => {
    const artifact = snapshot.artifacts.find((a) => a.id === referenceId);
    const source = snapshot.sources.find((s) => s.id === referenceId);
    const requirement = snapshot.requirements.find((r) => r.id === referenceId);
    let body = requirement?.text;
    if (artifact?.kind === 'shot') {
      body = (
        db
          .prepare(
            `SELECT s.authoring_ir_json body FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=?`,
          )
          .get(referenceId, projectId) as { body: string } | undefined
      )?.body;
      // Compare authored strings, rather than JSON escape sequences.
      if (body) body = allStrings(JSON.parse(body)).join('\n');
    } else if (artifact || source) {
      body = (
        db
          .prepare(
            `SELECT v.content_markdown body FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.id=? AND d.project_id=? AND v.id=?`,
          )
          .get(referenceId, projectId, artifact?.version ?? source?.version) as
          { body: string } | undefined
      )?.body;
    }
    if (!artifact && !source && !requirement)
      throw new Error(
        `TASK_REVIEW_EVIDENCE_INVALID: referenceId=${referenceId} is absent from current semanticReview.references. Use the artifact/source ID, not a resultId or version ID.`,
      );
    if (!body?.includes(quote))
      throw new Error(
        `TASK_REVIEW_EVIDENCE_INVALID: referenceId=${referenceId} does not contain the exact quote in its current snapshot version. Read that reference and quote its actual text.`,
      );
    return { referenceId, quote, version: artifact?.version ?? source?.version };
  });
}
function allStrings(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(allStrings)
      : [];
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
  ]);
  const store = new AgentContextStore(db);
  const saved =
    typeof args.reviewId === 'string' ? store.result(projectId, taskId, args.reviewId) : undefined;
  if (
    !current ||
    !saved ||
    saved.toolName !== 'task.review.snapshot' ||
    args.reviewId !== current.reviewId
  )
    throw new Error(
      'TASK_REVIEW_STALE: No content finding recorded. Read operation=state pendingActions and use the current Worker reviewId.',
    );
  if (!current.ready)
    throw new Error(
      'TASK_REVIEW_NOT_READY: No content finding recorded. Follow operation=state pendingActions to read only missing current versions or repair structural data.',
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
    throw new Error(
      'TASK_REVIEW_SCOPE_INVALID: Explicitly list only assessed targets from current reviewScope in reviewedTargetIds. Omitted targets remain pending.',
    );
  const reviewedTargetIds = args.reviewedTargetIds as string[];
  const issues: Issue[] = args.issues.map((raw) => {
    const issue = object(raw);
    fields(issue, ['issueId', 'targetId', 'category', 'description', 'evidence']);
    const target = snapshot.artifacts.find((a) => a.id === issue.targetId);
    if (
      !target ||
      !reviewedTargetIds.includes(target.id) ||
      !['content', 'consistency', 'requirement'].includes(String(issue.category))
    )
      throw new Error(
        'TASK_REVIEW_TARGET_INVALID: Content findings require a current artifact and a content category. System readiness is managed by Worker.',
      );
    const prior = typeof issue.issueId === 'string' ? history.open.get(issue.issueId) : undefined;
    if (
      issue.issueId !== undefined &&
      (!prior || prior.evidenceStatus !== 'needs_correction' || prior.targetId !== target.id)
    )
      throw new Error(
        'TASK_REVIEW_ISSUE_INVALID: issueId in issues may only correct evidence for an open needs_correction finding on the same target. Close verified findings through resolutions.',
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
  const resolutions: Resolution[] = ((args.resolutions as unknown[]) ?? []).map((raw) => {
    const r = object(raw);
    fields(r, ['issueId', 'disposition', 'reason', 'evidence']);
    const issue = history.open.get(String(r.issueId));
    if (!issue || !['resolved', 'withdrawn'].includes(String(r.disposition)))
      throw new Error('TASK_REVIEW_ISSUE_INVALID');
    if (issue.targetId && !reviewedTargetIds.includes(issue.targetId))
      throw new Error('TASK_REVIEW_SCOPE_INVALID: Reassess the issue target before closing it.');
    if (r.disposition === 'resolved') {
      const target = snapshot.artifacts.find((a) => a.id === issue.targetId);
      if (issue.legacy || !target || target.version === issue.targetVersion)
        throw new Error(
          'TASK_REVIEW_TARGET_UNCHANGED: Reassess a false positive with disposition=withdrawn and concrete evidence; resolving requires a changed, fully read target.',
        );
    }
    const evidence = evidenceFor(db, projectId, snapshot, r.evidence);
    const relevant = evidence.some((e) =>
      r.disposition === 'resolved'
        ? e.referenceId === issue.targetId
        : issue.legacy ||
          e.referenceId === issue.targetId ||
          issue.evidence.some((prior) => prior.referenceId === e.referenceId),
    );
    if (!relevant)
      throw new Error(
        'TASK_REVIEW_EVIDENCE_UNRELATED: Repair evidence must cite the changed target; withdrawal evidence must cite the finding target or its original references.',
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
  if (args.conclusion === 'passed' && history.open.size)
    throw new Error(
      'TASK_REVIEW_UNRESOLVED: Explicitly resolve or withdraw each outstanding issue by issueId with evidence.',
    );
  if (args.conclusion === 'needs_revision' && !history.open.size)
    throw new Error('TASK_REVIEW_INVALID: needs_revision requires a concrete content finding.');
  return {
    status: 'task_review_recorded',
    protocolVersion: 4,
    assessmentId,
    reviewId: current.reviewId,
    conclusion: args.conclusion,
    summary,
    issues,
    resolutions,
    reviewedTargetIds,
    coverage: snapshot.artifacts
      .filter(
        (a) =>
          reviewedTargetIds.includes(a.id) &&
          ![...history.open.values()].some((i) => i.targetId === a.id),
      )
      .map((a) => ({
        id: a.id,
        key: artifactKey(a),
        dependencyHash: dependencies(snapshot, a.id),
      })),
  };
}
