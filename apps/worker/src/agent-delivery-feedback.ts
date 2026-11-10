import type Database from 'better-sqlite3';
import { bundleTiming } from './production-bundle-timing.js';
import { isBundleTask } from './production-bundle-state.js';
import { bundleSavedObjects, bundleReadbackRecorded } from './production-bundle-service.js';
import type { AgentTaskDetail, AgentTaskReviewTargetInfo } from '@ai-video/contracts';
import { AgentContextStore } from '@ai-video/persistence';
import type { TaskReviewState } from './agent-task-review.js';

/** Read-only UI projection of the existing review authority, never a second quality store. */
export function deliveryFeedback(
  db: Database.Database,
  projectId: string,
  taskId: string,
  documents: AgentTaskDetail['documents'],
  review?: TaskReviewState,
): NonNullable<AgentTaskDetail['deliveryReview']> {
  const requirements =
    new AgentContextStore(db).loadTask(projectId, taskId)?.userRequirements ?? [];
  const requirementIds = new Set(requirements.map((r) => r.id));
  const bundle = isBundleTask(db, taskId),
    saved = bundle ? bundleSavedObjects(db, projectId, taskId) : [],
    readbackVerified = bundle && bundleReadbackRecorded(db, projectId, taskId);
  const mapping = new Map(saved.map((o) => [`candidate:${o.key}`, o]));
  const realId = (id: string) => mapping.get(id)?.id ?? id;
  const pendingIds = new Set((review?.reviewScope ?? []).map(realId));
  const issues = (review?.issues ?? []).map((issue) => ({
    id: issue.issueId,
    targetId: issue.targetId ? realId(issue.targetId) : undefined,
    targetVersion: issue.targetVersion,
    description: issue.description,
    evidenceStatus: issue.evidenceStatus,
    requirementIds: [...new Set(issue.evidence.map((e) => e.referenceId))].filter((id) =>
      requirementIds.has(id),
    ),
  }));
  const targets: AgentTaskReviewTargetInfo[] = [];
  const reviewReferences =
    review?.references
      .filter((r): r is typeof r & { kind: AgentTaskReviewTargetInfo['kind'] } =>
        ['document', 'scene', 'shot'].includes(r.kind),
      )
      .map((r) => ({
        ...r,
        id: realId(r.id),
        version: mapping.get(r.id)?.versionId ?? r.version,
      })) ?? [];
  const allReferences = new Map<
    string,
    { id: string; kind: AgentTaskReviewTargetInfo['kind']; version?: unknown }
  >(documents.map((d) => [d.documentId, { id: d.documentId, kind: 'document' }]));
  for (const reference of reviewReferences) allReferences.set(reference.id, reference);
  for (const reference of allReferences.values()) {
    // The review authority has already resolved current content versions.
    // UI metadata must not read/hash every document or IR body again on each poll.
    const metadata =
      reference.kind === 'shot'
        ? (db
            .prepare(
              'SELECT s.title,s.scene_id AS sceneId FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=? AND s.archived_at IS NULL AND c.archived_at IS NULL',
            )
            .get(reference.id, projectId) as { title: string; sceneId: string } | undefined)
        : reference.kind === 'scene'
          ? (db
              .prepare(
                'SELECT title FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL',
              )
              .get(reference.id, projectId) as { title: string } | undefined)
          : (db
              .prepare(
                "SELECT title,current_version_id AS version FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
              )
              .get(reference.id, projectId) as { title: string; version: string } | undefined);
    if (!metadata) continue;
    targets.push({
      id: reference.id,
      kind: reference.kind,
      ...metadata,
      ...(typeof reference.version === 'string' ? { version: reference.version } : {}),
      state: issues.some((i) => !i.targetId || i.targetId === reference.id)
        ? 'needs_revision'
        : !reviewReferences.some((r) => r.id === reference.id)
          ? 'unverified'
          : pendingIds.has(reference.id) || (bundle && !readbackVerified)
            ? 'pending'
            : 'verified',
    });
  }
  return {
    ...(bundle
      ? {
          bundle: {
            businessSaved: saved.length > 0,
            readbackVerified,
            counts: saved.reduce<Record<string, number>>((counts, item) => {
              const kind =
                item.kind === 'document'
                  ? String(item.expected.kind)
                  : item.kind === 'scene'
                    ? 'storyScene'
                    : 'shot';
              counts[kind] = (counts[kind] ?? 0) + 1;
              return counts;
            }, {}),
            ...bundleTiming(db, projectId, taskId),
          },
        }
      : {}),
    state: review
      ? review.approved &&
        (!bundle || readbackVerified) &&
        targets.every((target) => target.state === 'verified')
        ? 'verified'
        : issues.length
          ? 'needs_revision'
          : 'pending'
      : 'unverified',
    pendingTargetIds: [...pendingIds],
    issueCount: issues.length,
    targets,
    requirements: requirements.map(({ id, text }) => ({ id, text })),
    issues,
  };
}
