import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentTaskCreateDocumentDraftParams,
  AgentTaskCreateDocumentDraftResult,
  AgentTaskDetail,
  AgentTaskEventInfo,
  AgentTaskGetParams,
  AgentTaskInfo,
  AgentTaskListParams,
  DocumentDetail,
  DocumentDraftSaveParams,
  DocumentPublicationInfo,
  DocumentPublishParams,
  DocumentRestoreParams,
  DocumentReviewInfo,
  DocumentReviewRequestChangesParams,
  DocumentReviewRejectParams,
  DocumentReviewSubmitParams,
  DocumentSummary,
  DocumentVersionInfo,
  TaskLogItem,
  TaskLogPage,
  TaskLogListParams,
} from '@ai-video/contracts';
import type {
  DocumentWorkflowAuditAction,
  DocumentWorkflowAuditActorType,
  OpenProject,
} from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

const LOCAL_USER = 'local-user';
const MAX_DOCUMENT_LENGTH = 1_000_000;
const MAX_TITLE_LENGTH = 200;

type WorkflowErrorCode =
  'DOCUMENT_BASE_CONFLICT' | 'IDEMPOTENCY_KEY_REUSED' | 'CONFLICT' | 'INVALID_STATE';

export class DocumentWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowErrorCode,
  ) {
    super(message);
    this.name = 'DocumentWorkflowError';
  }
}

interface DocumentRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  scope_type: string;
  scope_id: string | null;
  current_version_id: string | null;
  published_version_id: string | null;
  lifecycle_status: string;
  row_version: number;
  created_at: string;
  updated_at: string;
}

interface DocumentVersionRow {
  id: string;
  document_id: string;
  version: number;
  content_markdown: string;
  state: string;
  base_version_id: string | null;
  title_snapshot: string | null;
  scope_type_snapshot: string | null;
  scope_id_snapshot: string | null;
  author_type: string;
  source_task_id: string | null;
  source_message_id: string | null;
  context_snapshot_id: string | null;
  state_version: number;
  created_at: string;
}

interface AgentTaskRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  user_message_id: string | null;
  task_type: string;
  scope_type: string;
  scope_id: string | null;
  title: string;
  status: string;
  outcome: string | null;
  context_snapshot_id: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  phase: AgentTaskInfo['phase'];
  row_version: number;
}

interface AgentTaskEventRow {
  id: string;
  task_id: string;
  sequence: number;
  event_type: string;
  level: string;
  summary: string;
  created_at: string;
}

interface ReviewRow {
  id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  task_id: string | null;
  status: string;
  requested_at: string;
  decided_at: string | null;
  comment: string | null;
  version: number;
}

interface PublicationRow {
  id: string;
  document_id: string;
  document_version_id: string;
  previous_version_id: string | null;
  publication_no: number;
  published_at: string;
}

interface TaskDocumentRow {
  document_id: string;
  document_version_id: string;
  operation: 'create' | 'update' | 'regenerate';
  created_at: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function required(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  if (normalized.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters.`);
  return normalized;
}

function documentKind(value: string): DocumentSummary['kind'] {
  return ['outline', 'plan', 'character', 'scene', 'storyboard', 'note'].includes(value)
    ? (value as DocumentSummary['kind'])
    : 'note';
}

function documentState(value: string): DocumentVersionInfo['state'] {
  return [
    'draft',
    'in_review',
    'published',
    'changes_requested',
    'rejected',
    'superseded',
    'discarded',
  ].includes(value)
    ? (value as DocumentVersionInfo['state'])
    : 'draft';
}

function scopeType(value: string): DocumentSummary['scopeType'] {
  if (value === 'project' || value === 'scene' || value === 'shot') return value;
  throw new Error('Document scope is invalid.');
}

function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: documentKind(row.kind),
    title: row.title,
    scopeType: scopeType(row.scope_type),
    scopeId: row.scope_id ?? undefined,
    currentVersionId: row.current_version_id ?? undefined,
    publishedVersionId: row.published_version_id ?? undefined,
    lifecycleStatus: row.lifecycle_status === 'archived' ? 'archived' : 'active',
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocumentVersion(row: DocumentVersionRow): DocumentVersionInfo {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
    state: documentState(row.state),
    baseVersionId: row.base_version_id ?? undefined,
    titleSnapshot: row.title_snapshot ?? undefined,
    scopeTypeSnapshot: row.scope_type_snapshot ? scopeType(row.scope_type_snapshot) : undefined,
    scopeIdSnapshot: row.scope_id_snapshot ?? undefined,
    authorType: ['user', 'agent', 'import', 'migration'].includes(row.author_type)
      ? (row.author_type as DocumentVersionInfo['authorType'])
      : 'user',
    sourceTaskId: row.source_task_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    contextSnapshotId: row.context_snapshot_id ?? undefined,
    createdAt: row.created_at,
  };
}

function taskType(value: string): AgentTaskInfo['taskType'] {
  if (
    [
      'document-create',
      'document-update',
      'document-query',
      'document-archive',
      'document-restore',
    ].includes(value)
  ) {
    return value as AgentTaskInfo['taskType'];
  }
  throw new Error('Agent task type is invalid.');
}

function taskStatus(value: string): AgentTaskInfo['status'] {
  if (['queued', 'running', 'waiting_review', 'completed', 'failed', 'cancelled'].includes(value)) {
    return value as AgentTaskInfo['status'];
  }
  throw new Error('Agent task state is invalid.');
}

function toTask(row: AgentTaskRow): AgentTaskInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id ?? undefined,
    userMessageId: row.user_message_id ?? undefined,
    taskType: taskType(row.task_type),
    scopeType: scopeType(row.scope_type),
    scopeId: row.scope_id ?? undefined,
    title: row.title,
    status: taskStatus(row.status),
    outcome: ['published', 'rejected', 'discarded', 'read-only', 'archived', 'restored'].includes(
      row.outcome ?? '',
    )
      ? (row.outcome as AgentTaskInfo['outcome'])
      : undefined,
    contextSnapshotId: row.context_snapshot_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    retryable: row.retryable === null ? undefined : row.retryable === 1,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    phase: row.phase,
    rowVersion: row.row_version,
  };
}

function toEvent(row: AgentTaskEventRow): AgentTaskEventInfo {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    eventType: row.event_type,
    level: row.level === 'warning' || row.level === 'error' ? row.level : 'info',
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function toReview(row: ReviewRow): DocumentReviewInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    taskId: row.task_id ?? undefined,
    status: row.status as DocumentReviewInfo['status'],
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    comment: row.comment ?? undefined,
    version: row.version,
  };
}

function toPublication(row: PublicationRow): DocumentPublicationInfo {
  return {
    id: row.id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    previousVersionId: row.previous_version_id ?? undefined,
    publicationNo: row.publication_no,
    publishedAt: row.published_at,
  };
}

export class DocumentWorkflowService {
  constructor(private readonly projects: ProjectService) {}

  listDocuments(): DocumentSummary[] {
    return this.projects.access(false, (database, project) =>
      (
        database
          .prepare(
            `SELECT * FROM documents
             WHERE project_id = ? AND lifecycle_status = 'active'
             ORDER BY updated_at DESC, id DESC`,
          )
          .all(project.id) as DocumentRow[]
      ).map(toDocumentSummary),
    );
  }

  getDocument(documentId: string): DocumentDetail {
    return this.projects.access(false, (database, project) =>
      this.getDocumentInProject(database, project, documentId),
    );
  }

  listVersions(documentId: string): DocumentVersionInfo[] {
    return this.projects.access(false, (database, project) => {
      this.requireDocument(database, project, documentId);
      return (
        database
          .prepare(
            'SELECT * FROM document_versions WHERE document_id = ? ORDER BY version DESC, id DESC',
          )
          .all(documentId) as DocumentVersionRow[]
      ).map(toDocumentVersion);
    });
  }

  saveDraft(params: DocumentDraftSaveParams): DocumentDetail {
    const title = required(params.title, 'Document title', MAX_TITLE_LENGTH);
    if (params.contentMarkdown.length > MAX_DOCUMENT_LENGTH) {
      throw new Error(`Document content exceeds ${MAX_DOCUMENT_LENGTH} characters.`);
    }
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const document = this.writeDraft(database, project, {
          ...params,
          title,
          authorType: params.authorType ?? 'user',
        });
        const version = document.currentVersion;
        if (!version) throw new DocumentWorkflowError('EXPECTED_VERSION_MISSING', 'CONFLICT');
        this.appendAudit(database, project.id, {
          action: 'draft_saved',
          actorType: params.authorType ?? 'user',
          actorId: params.authorType === 'agent' ? 'agent' : LOCAL_USER,
          documentId: document.id,
          documentVersionId: version.id,
          taskId: version.sourceTaskId,
          metadata: {
            operation: params.documentId ? 'update' : 'create',
            baseVersionId: version.baseVersionId ?? null,
          },
          createdAt: version.createdAt,
        });
        this.touchProject(database, project);
        return document;
      })(),
    );
  }

  restoreDocument(params: DocumentRestoreParams): DocumentDetail {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const document = this.requireDocument(database, project, params.documentId);
        const sourceVersion = this.requireVersion(database, document.id, params.versionId);
        const restored = this.writeDraft(database, project, {
          documentId: document.id,
          kind: documentKind(document.kind),
          title: document.title,
          contentMarkdown: sourceVersion.content_markdown,
          scopeType: scopeType(document.scope_type),
          scopeId: document.scope_id ?? undefined,
          expectedDocumentRowVersion: document.row_version,
          authorType: 'user',
        });
        const version = restored.currentVersion;
        if (!version) throw new DocumentWorkflowError('EXPECTED_VERSION_MISSING', 'CONFLICT');
        this.appendAudit(database, project.id, {
          action: 'draft_restored',
          actorType: 'user',
          actorId: LOCAL_USER,
          documentId: restored.id,
          documentVersionId: version.id,
          sourceVersionId: sourceVersion.id,
          taskId: version.sourceTaskId,
          metadata: { sourceVersionNumber: sourceVersion.version },
          createdAt: version.createdAt,
        });
        this.touchProject(database, project, version.createdAt);
        return restored;
      })(),
    );
  }

  submitReview(params: DocumentReviewSubmitParams): DocumentReviewInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const document = this.requireDocument(database, project, params.documentId);
        this.requireDocumentRowVersion(document, params.expectedDocumentRowVersion);
        const version = this.requireVersion(
          database,
          document.id,
          params.documentVersionId ?? document.current_version_id,
        );
        this.requireCurrentVersion(document, version);
        if (!['draft', 'changes_requested'].includes(version.state)) {
          throw new DocumentWorkflowError(
            'Document version is not ready for review.',
            'INVALID_STATE',
          );
        }
        const now = new Date().toISOString();
        const existing = database
          .prepare('SELECT * FROM document_reviews WHERE document_version_id = ?')
          .get(version.id) as ReviewRow | undefined;
        if (existing && !['changes_requested', 'withdrawn'].includes(existing.status)) {
          throw new DocumentWorkflowError(
            'A review already exists for this document version.',
            'CONFLICT',
          );
        }
        const reviewId = existing?.id ?? randomUUID();
        if (existing) {
          database
            .prepare(
              `UPDATE document_reviews
               SET status = 'pending', requested_by_type = ?, requested_by_id = ?, requested_at = ?,
                   decided_by_type = NULL, decided_by_id = NULL, decided_at = NULL, comment = NULL,
                   version = version + 1
               WHERE id = ?`,
            )
            .run(LOCAL_USER, LOCAL_USER, now, reviewId);
        } else {
          database
            .prepare(
              `INSERT INTO document_reviews
               (id, project_id, document_id, document_version_id, task_id, status,
                requested_by_type, requested_by_id, requested_at, version)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0)`,
            )
            .run(
              reviewId,
              project.id,
              document.id,
              version.id,
              version.source_task_id,
              LOCAL_USER,
              LOCAL_USER,
              now,
            );
        }
        this.updateVersionState(database, version, 'in_review', now);
        this.bumpDocument(database, document.id, params.expectedDocumentRowVersion, now);
        this.appendEvent(
          database,
          project.id,
          version.source_task_id,
          'document.review.started',
          'info',
          'Draft submitted for review.',
          { documentId: document.id, documentVersionId: version.id, reviewId },
          now,
        );
        this.appendAudit(database, project.id, {
          action: 'review_submitted',
          actorType: 'user',
          actorId: LOCAL_USER,
          documentId: document.id,
          documentVersionId: version.id,
          reviewId,
          taskId: version.source_task_id ?? undefined,
          createdAt: now,
        });
        this.touchProject(database, project, now);
        return toReview(
          database
            .prepare('SELECT * FROM document_reviews WHERE id = ?')
            .get(reviewId) as ReviewRow,
        );
      })(),
    );
  }

  requestChanges(params: DocumentReviewRequestChangesParams): DocumentReviewInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const document = this.requireDocument(database, project, params.documentId);
        this.requireDocumentRowVersion(document, params.expectedDocumentRowVersion);
        const version = this.requireVersion(
          database,
          document.id,
          params.documentVersionId ?? document.current_version_id,
        );
        this.requireCurrentVersion(document, version);
        if (version.state !== 'in_review') {
          throw new DocumentWorkflowError(
            'Document version must be in review before changes can be requested.',
            'INVALID_STATE',
          );
        }
        const review = database
          .prepare('SELECT * FROM document_reviews WHERE document_version_id = ?')
          .get(version.id) as ReviewRow | undefined;
        if (!review || review.status !== 'pending') {
          throw new DocumentWorkflowError(
            'No pending review exists for this document version.',
            'INVALID_STATE',
          );
        }
        const now = new Date().toISOString();
        const comment = params.comment?.trim().slice(0, 2_000) || null;
        database
          .prepare(
            `UPDATE document_reviews
             SET status = 'changes_requested', decided_by_type = ?, decided_by_id = ?, decided_at = ?,
                 comment = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(LOCAL_USER, LOCAL_USER, now, comment, review.id);
        this.updateVersionState(database, version, 'changes_requested', now);
        this.bumpDocument(database, document.id, params.expectedDocumentRowVersion, now);
        this.appendEvent(
          database,
          project.id,
          version.source_task_id,
          'document.review.changes_requested',
          'info',
          'Document draft was returned for revision.',
          { documentId: document.id, documentVersionId: version.id, reviewId: review.id },
          now,
        );
        this.appendAudit(database, project.id, {
          action: 'review_changes_requested',
          actorType: 'user',
          actorId: LOCAL_USER,
          documentId: document.id,
          documentVersionId: version.id,
          sourceVersionId: document.published_version_id ?? undefined,
          reviewId: review.id,
          taskId: version.source_task_id ?? undefined,
          createdAt: now,
        });
        this.touchProject(database, project, now);
        return toReview(
          database
            .prepare('SELECT * FROM document_reviews WHERE id = ?')
            .get(review.id) as ReviewRow,
        );
      })(),
    );
  }

  rejectReview(params: DocumentReviewRejectParams): DocumentReviewInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const document = this.requireDocument(database, project, params.documentId);
        this.requireDocumentRowVersion(document, params.expectedDocumentRowVersion);
        const version = this.requireVersion(
          database,
          document.id,
          params.documentVersionId ?? document.current_version_id,
        );
        this.requireCurrentVersion(document, version);
        if (version.state !== 'in_review') {
          throw new DocumentWorkflowError(
            'Document version must be in review before it can be rejected.',
            'INVALID_STATE',
          );
        }
        const review = database
          .prepare('SELECT * FROM document_reviews WHERE document_version_id = ?')
          .get(version.id) as ReviewRow | undefined;
        if (!review || review.status !== 'pending') {
          throw new DocumentWorkflowError(
            'No pending review exists for this document version.',
            'INVALID_STATE',
          );
        }
        const now = new Date().toISOString();
        const comment = params.comment?.trim().slice(0, 2_000) || null;
        database
          .prepare(
            `UPDATE document_reviews
             SET status = 'rejected', decided_by_type = ?, decided_by_id = ?, decided_at = ?,
                 comment = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(LOCAL_USER, LOCAL_USER, now, comment, review.id);
        this.updateVersionState(database, version, 'rejected', now);
        this.bumpDocument(database, document.id, params.expectedDocumentRowVersion, now);
        this.completeSourceTask(
          database,
          project.id,
          version.source_task_id,
          version.id,
          'rejected',
          now,
        );
        this.appendEvent(
          database,
          project.id,
          version.source_task_id,
          'document.draft.rejected',
          'info',
          'Document draft was rejected.',
          { documentId: document.id, documentVersionId: version.id, reviewId: review.id },
          now,
        );
        this.appendAudit(database, project.id, {
          action: 'review_rejected',
          actorType: 'user',
          actorId: LOCAL_USER,
          documentId: document.id,
          documentVersionId: version.id,
          reviewId: review.id,
          taskId: version.source_task_id ?? undefined,
          createdAt: now,
        });
        this.touchProject(database, project, now);
        return toReview(
          database
            .prepare('SELECT * FROM document_reviews WHERE id = ?')
            .get(review.id) as ReviewRow,
        );
      })(),
    );
  }

  publish(params: DocumentPublishParams): {
    document: DocumentDetail;
    publication: DocumentPublicationInfo;
  } {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const document = this.requireDocument(database, project, params.documentId);
        this.requireDocumentRowVersion(document, params.expectedDocumentRowVersion);
        const version = this.requireVersion(
          database,
          document.id,
          params.documentVersionId ?? document.current_version_id,
        );
        this.requireCurrentVersion(document, version);
        if (version.state !== 'in_review') {
          throw new DocumentWorkflowError(
            'Document version must be approved through review before publishing.',
            'INVALID_STATE',
          );
        }
        const review = database
          .prepare('SELECT * FROM document_reviews WHERE document_version_id = ?')
          .get(version.id) as ReviewRow | undefined;
        if (!review || review.status !== 'pending') {
          throw new DocumentWorkflowError(
            'No pending review exists for this document version.',
            'INVALID_STATE',
          );
        }
        const expectedPublished = params.expectedPublishedVersionId ?? undefined;
        const actualPublished = document.published_version_id ?? undefined;
        if (
          expectedPublished !== actualPublished ||
          (version.base_version_id ?? undefined) !== actualPublished
        ) {
          this.appendEvent(
            database,
            project.id,
            version.source_task_id,
            'document.publish.conflicted',
            'warning',
            'The draft was based on an outdated published version.',
            { documentId: document.id, documentVersionId: version.id },
            new Date().toISOString(),
          );
          throw new DocumentWorkflowError(
            'DOCUMENT_BASE_CONFLICT: The published document changed while this draft was being reviewed.',
            'DOCUMENT_BASE_CONFLICT',
          );
        }
        const now = new Date().toISOString();
        const nextPublicationNo =
          ((
            database
              .prepare(
                'SELECT MAX(publication_no) AS value FROM document_publications WHERE document_id = ?',
              )
              .get(document.id) as { value: number | null }
          ).value ?? 0) + 1;
        const publicationId = randomUUID();
        database
          .prepare(
            `UPDATE document_reviews
             SET status = 'approved', decided_by_type = ?, decided_by_id = ?, decided_at = ?,
                 version = version + 1
             WHERE id = ?`,
          )
          .run(LOCAL_USER, LOCAL_USER, now, review.id);
        this.updateVersionState(database, version, 'published', now);
        database
          .prepare(
            `INSERT INTO document_publications
             (id, project_id, document_id, document_version_id, previous_version_id, publication_no,
              review_id, task_id, published_by_type, published_by_id, published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            publicationId,
            project.id,
            document.id,
            version.id,
            document.published_version_id,
            nextPublicationNo,
            review.id,
            version.source_task_id,
            LOCAL_USER,
            LOCAL_USER,
            now,
          );
        const update = database
          .prepare(
            `UPDATE documents
             SET published_version_id = ?, current_version_id = ?, updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND row_version = ?`,
          )
          .run(version.id, version.id, now, document.id, params.expectedDocumentRowVersion);
        if (update.changes !== 1) {
          throw new DocumentWorkflowError('Document was changed in another window.', 'CONFLICT');
        }
        this.completeSourceTask(
          database,
          project.id,
          version.source_task_id,
          version.id,
          'published',
          now,
        );
        this.appendEvent(
          database,
          project.id,
          version.source_task_id,
          'document.published',
          'info',
          'Document version was published as project authority.',
          { documentId: document.id, documentVersionId: version.id, publicationId },
          now,
        );
        this.appendAudit(database, project.id, {
          action: 'published',
          actorType: 'user',
          actorId: LOCAL_USER,
          documentId: document.id,
          documentVersionId: version.id,
          reviewId: review.id,
          publicationId,
          taskId: version.source_task_id ?? undefined,
          metadata: { previousVersionId: document.published_version_id ?? null },
          createdAt: now,
        });
        this.touchProject(database, project, now);
        return {
          document: this.getDocumentInProject(database, project, document.id),
          publication: toPublication(
            database
              .prepare('SELECT * FROM document_publications WHERE id = ?')
              .get(publicationId) as PublicationRow,
          ),
        };
      })(),
    );
  }

  createDocumentDraftFromMessage(
    params: AgentTaskCreateDocumentDraftParams,
  ): AgentTaskCreateDocumentDraftResult {
    return this.projects.access(true, (database, project) =>
      database.transaction(() =>
        this.createDocumentDraftFromMessageInTransaction(database, project, params),
      )(),
    );
  }

  listTasks(params: AgentTaskListParams = {}): AgentTaskInfo[] {
    return this.projects.access(false, (database, project) => {
      const limit = Math.min(Math.max(params.limit ?? 100, 1), 300);
      const rows = params.conversationId
        ? (database
            .prepare(
              `SELECT * FROM agent_tasks
               WHERE project_id = ? AND conversation_id = ?
               ORDER BY updated_at DESC, id DESC LIMIT ?`,
            )
            .all(project.id, params.conversationId, limit) as AgentTaskRow[])
        : (database
            .prepare(
              'SELECT * FROM agent_tasks WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?',
            )
            .all(project.id, limit) as AgentTaskRow[]);
      return rows.map(toTask);
    });
  }

  getTask(params: AgentTaskGetParams): AgentTaskDetail {
    return this.projects.access(false, (database, project) => {
      const task = this.requireTask(database, project, params.taskId);
      const events = (
        database
          .prepare('SELECT * FROM agent_task_events WHERE task_id = ? ORDER BY sequence, id')
          .all(task.id) as AgentTaskEventRow[]
      ).map(toEvent);
      const documents = (
        database
          .prepare(
            `SELECT artifacts.document_id, artifacts.document_version_id,
                    COALESCE((
                      SELECT history.operation FROM agent_task_document_versions history
                      WHERE history.task_id = artifacts.task_id
                        AND history.document_version_id = artifacts.document_version_id
                      ORDER BY history.created_at DESC, history.operation DESC LIMIT 1
                    ), 'create') AS operation,
                    artifacts.updated_at AS created_at
             FROM agent_task_document_artifacts artifacts WHERE task_id = ?
             ORDER BY created_at, id`,
          )
          .all(task.id) as TaskDocumentRow[]
      ).map((item) => ({
        documentId: item.document_id,
        documentVersionId: item.document_version_id,
        operation: item.operation,
        createdAt: item.created_at,
      }));
      return { task: toTask(task), events, documents };
    });
  }

  listTaskLog(params: TaskLogListParams = {}): TaskLogPage {
    return this.projects.access(false, (database, project) => {
      const pageLimit = Math.min(Math.max(params.limit ?? 50, 1), 100);
      const maxFetch = 5_000;
      const includeTasks = params.kind === undefined || params.kind === 'agent-document';
      const includeJobs =
        params.kind === undefined || params.kind === 'image' || params.kind === 'video';
      const tasks = includeTasks
        ? (database
            .prepare(
              `SELECT tasks.id, tasks.title, tasks.status, tasks.created_at, tasks.updated_at,
                      (SELECT artifacts.document_id
                        FROM agent_task_document_artifacts artifacts
                       WHERE artifacts.task_id = tasks.id
                        ORDER BY artifacts.updated_at DESC, artifacts.id DESC
                        LIMIT 1) AS document_id,
                      (SELECT artifacts.document_version_id
                        FROM agent_task_document_artifacts artifacts
                       WHERE artifacts.task_id = tasks.id
                        ORDER BY artifacts.updated_at DESC, artifacts.id DESC
                        LIMIT 1) AS document_version_id
               FROM agent_tasks tasks
               WHERE tasks.project_id = ?${params.status ? ' AND tasks.status = ?' : ''}
                ORDER BY tasks.updated_at DESC, tasks.id DESC LIMIT ?`,
            )
            .all(
              ...(params.status ? [project.id, params.status, maxFetch] : [project.id, maxFetch]),
            ) as Array<{
            id: string;
            title: string;
            status: string;
            created_at: string;
            updated_at: string;
            document_id: string | null;
            document_version_id: string | null;
          }>)
        : [];
      const jobs = includeJobs
        ? (database
            .prepare(
              `SELECT id, adapter_key, status, created_at, updated_at
               FROM generation_jobs WHERE project_id = ?${params.status ? ' AND status = ?' : ''}
               ORDER BY updated_at DESC, id DESC LIMIT ?`,
            )
            .all(
              ...(params.status ? [project.id, params.status, maxFetch] : [project.id, maxFetch]),
            ) as Array<{
            id: string;
            adapter_key: string;
            status: string;
            created_at: string;
            updated_at: string;
          }>)
        : [];
      const items: TaskLogItem[] = [
        ...tasks.map((task): TaskLogItem => ({
          id: `agent:${task.id}`,
          kind: 'agent-document',
          title: task.title,
          status: task.status,
          createdAt: task.created_at,
          updatedAt: task.updated_at,
          sourceId: task.id,
          documentId: task.document_id ?? undefined,
          documentVersionId: task.document_version_id ?? undefined,
        })),
        ...jobs
          .map((job): TaskLogItem => ({
            id: `job:${job.id}`,
            kind: /video|vidu/i.test(job.adapter_key) ? 'video' : 'image',
            title: job.adapter_key,
            status: job.status,
            createdAt: job.created_at,
            updatedAt: job.updated_at,
            sourceId: job.id,
          }))
          .filter((item) => !params.kind || item.kind === params.kind),
      ].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      );
      const cursorIndex = params.cursor ? items.findIndex((item) => item.id === params.cursor) : -1;
      const afterCursor = params.cursor && cursorIndex < 0 ? [] : items.slice(cursorIndex + 1);
      const page = afterCursor.slice(0, pageLimit);
      return {
        items: page,
        nextCursor: afterCursor.length > pageLimit ? page.at(-1)?.id : undefined,
      };
    });
  }

  private createDocumentDraftFromMessageInTransaction(
    database: Database.Database,
    project: OpenProject,
    params: AgentTaskCreateDocumentDraftParams,
  ): AgentTaskCreateDocumentDraftResult {
    const message = database
      .prepare(
        `SELECT messages.id, messages.content, messages.role, messages.status,
                messages.reply_to_message_id, conversations.id AS conversation_id,
                conversations.scope_type, conversations.scope_id
         FROM chat_messages messages
         INNER JOIN conversations ON conversations.id = messages.conversation_id
         WHERE messages.id = ? AND conversations.project_id = ?`,
      )
      .get(params.messageId, project.id) as
      | {
          id: string;
          content: string;
          role: string;
          status: string;
          reply_to_message_id: string | null;
          conversation_id: string;
          scope_type: string;
          scope_id: string | null;
        }
      | undefined;
    if (!message) throw new Error('Message was not found.');
    if (message.role !== 'assistant' || message.status !== 'complete') {
      throw new DocumentWorkflowError(
        'Only completed assistant messages can create a document draft.',
        'INVALID_STATE',
      );
    }
    const target = params.targetDocumentId
      ? this.requireDocument(database, project, params.targetDocumentId)
      : undefined;
    if (target && params.expectedDocumentRowVersion !== target.row_version) {
      throw new DocumentWorkflowError('Document was changed in another window.', 'CONFLICT');
    }
    const title = required(
      params.title ?? this.deriveTitle(message.content),
      'Document title',
      MAX_TITLE_LENGTH,
    );
    const requestHash = hash(
      JSON.stringify({
        messageId: message.id,
        targetDocumentId: target?.id,
        title,
        contentHash: hash(message.content),
      }),
    );
    if (params.idempotencyKey) {
      const existing = database
        .prepare('SELECT * FROM agent_tasks WHERE project_id = ? AND idempotency_key = ?')
        .get(project.id, params.idempotencyKey) as
        (AgentTaskRow & { request_hash: string }) | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DocumentWorkflowError(
            'IDEMPOTENCY_KEY_REUSED: The same idempotency key was used for another request.',
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        const artifact = database
          .prepare(
            `SELECT document_id FROM agent_task_document_artifacts
             WHERE task_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
          )
          .get(existing.id) as { document_id: string } | undefined;
        if (!artifact) {
          throw new DocumentWorkflowError(
            'The existing task has no document artifact.',
            'CONFLICT',
          );
        }
        return {
          task: toTask(existing),
          document: this.getDocumentInProject(database, project, artifact.document_id),
        };
      }
    }
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const context = database
      .prepare(
        `SELECT context_snapshot_id FROM llm_generation_attempts
         WHERE assistant_message_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(message.id) as { context_snapshot_id: string } | undefined;
    database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, project_session_id, conversation_id, user_message_id, task_type,
          scope_type, scope_id, title, request_snapshot_json, request_hash, context_snapshot_id,
          status, idempotency_key, created_at, updated_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0)`,
      )
      .run(
        taskId,
        project.id,
        this.projects.currentSessionId() ?? 'unknown-session',
        message.conversation_id,
        message.reply_to_message_id,
        target ? 'document-update' : 'document-create',
        message.scope_type,
        message.scope_id,
        title,
        JSON.stringify({
          messageId: message.id,
          targetDocumentId: target?.id,
          contentHash: hash(message.content),
        }),
        requestHash,
        context?.context_snapshot_id ?? null,
        params.idempotencyKey ?? null,
        now,
        now,
      );
    this.appendEvent(
      database,
      project.id,
      taskId,
      'agent.task.created',
      'info',
      'Document draft task was created from a completed assistant response.',
      { messageId: message.id },
      now,
    );
    database
      .prepare(
        `UPDATE agent_tasks SET status = 'running', phase = 'model_running', started_at = ?, updated_at = ?, row_version = row_version + 1
         WHERE id = ?`,
      )
      .run(now, now, taskId);
    this.appendEvent(
      database,
      project.id,
      taskId,
      'agent.task.started',
      'info',
      'The draft creation tool is running.',
      undefined,
      now,
    );
    const toolId = randomUUID();
    const toolArguments = JSON.stringify({
      title,
      targetDocumentId: target?.id,
      messageId: message.id,
    });
    database
      .prepare(
        `INSERT INTO agent_tool_calls
         (id, project_id, task_id, tool_name, normalized_arguments_hash, arguments_summary_json,
          status, idempotency_key, created_at, version, redaction_state)
         VALUES (?, ?, ?, 'document.create_draft', ?, ?, 'received', ?, ?, 0, 'native')`,
      )
      .run(
        toolId,
        project.id,
        taskId,
        hash(toolArguments),
        JSON.stringify({
          operation: 'document.create_draft',
          targetDocumentId: target?.id ?? null,
        }),
        params.idempotencyKey ?? `manual:${toolId}`,
        now,
      );
    database
      .prepare(
        `UPDATE agent_tool_calls SET status = 'validated', started_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(now, toolId);
    database
      .prepare(
        "UPDATE agent_tool_calls SET status = 'executing', version = version + 1 WHERE id = ?",
      )
      .run(toolId);
    const document = this.writeDraft(database, project, {
      documentId: target?.id,
      kind: target ? documentKind(target.kind) : 'note',
      title,
      contentMarkdown: message.content,
      scopeType: target ? scopeType(target.scope_type) : scopeType(message.scope_type),
      scopeId: target?.scope_id ?? message.scope_id ?? undefined,
      expectedDocumentRowVersion: target?.row_version,
      baseVersionId: target?.published_version_id ?? undefined,
      sourceTaskId: taskId,
      sourceMessageId: message.id,
      contextSnapshotId: context?.context_snapshot_id,
      authorType: 'agent',
    });
    const versionId = document.currentVersion?.id;
    if (!versionId) throw new DocumentWorkflowError('EXPECTED_ARTIFACT_MISSING', 'CONFLICT');
    const version = document.currentVersion;
    this.appendAudit(database, project.id, {
      action: 'draft_saved',
      actorType: 'agent',
      actorId: 'agent',
      documentId: document.id,
      documentVersionId: versionId,
      taskId,
      metadata: {
        operation: target ? 'update' : 'create',
        sourceMessageId: message.id,
        baseVersionId: version?.baseVersionId ?? null,
      },
      createdAt: version?.createdAt ?? now,
    });
    database
      .prepare(
        `INSERT INTO agent_task_document_versions
         (task_id, document_id, document_version_id, operation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, document.id, versionId, target ? 'update' : 'create', now);
    database
      .prepare(
        `INSERT INTO agent_task_document_artifacts
         (id, project_id, task_id, document_id, document_version_id, artifact_role,
          disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'primary', 'draft', ?, ?)`,
      )
      .run(randomUUID(), project.id, taskId, document.id, versionId, now, now);
    database
      .prepare(
        `UPDATE agent_tool_calls
         SET status = 'succeeded', result_summary_json = ?, result_document_id = ?,
             result_document_version_id = ?, completed_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(
        JSON.stringify({ status: 'draft', reviewRequired: true }),
        document.id,
        versionId,
        now,
        toolId,
      );
    database
      .prepare(
        `UPDATE agent_tasks
         SET status = 'waiting_review', phase = 'waiting_review', updated_at = ?, row_version = row_version + 1
         WHERE id = ?`,
      )
      .run(now, taskId);
    this.appendEvent(
      database,
      project.id,
      taskId,
      'document.draft.created',
      'info',
      'A Markdown draft was created and is waiting for user review.',
      { documentId: document.id, documentVersionId: versionId },
      now,
    );
    this.appendEvent(
      database,
      project.id,
      taskId,
      'agent.task.waiting_review',
      'info',
      'The task is waiting for review and explicit publication.',
      undefined,
      now,
    );
    this.touchProject(database, project, now);
    return {
      task: toTask(this.requireTask(database, project, taskId)),
      document: this.getDocumentInProject(database, project, document.id),
    };
  }

  private writeDraft(
    database: Database.Database,
    project: OpenProject,
    params: DocumentDraftSaveParams & { title: string; authorType: 'user' | 'agent' | 'import' },
  ): DocumentDetail {
    const existing = params.documentId
      ? this.requireDocument(database, project, params.documentId)
      : undefined;
    if (existing && params.expectedDocumentRowVersion !== undefined) {
      this.requireDocumentRowVersion(existing, params.expectedDocumentRowVersion);
    }
    if (existing && params.expectedDocumentRowVersion === undefined) {
      throw new DocumentWorkflowError(
        'expectedDocumentRowVersion is required when saving an existing document.',
        'CONFLICT',
      );
    }
    const nextScopeType =
      params.scopeType ?? (existing ? scopeType(existing.scope_type) : 'project');
    const nextScopeId =
      nextScopeType === 'project' ? undefined : (params.scopeId ?? existing?.scope_id ?? undefined);
    this.assertScope(database, project, nextScopeType, nextScopeId);
    const documentId = existing?.id ?? randomUUID();
    const current = existing?.current_version_id
      ? this.requireVersion(database, documentId, existing.current_version_id)
      : undefined;
    const inheritsDraftProvenance =
      current !== undefined && ['draft', 'changes_requested'].includes(current.state);
    const inheritedSourceTaskId =
      !params.sourceTaskId && inheritsDraftProvenance
        ? (current?.source_task_id ?? undefined)
        : undefined;
    const inheritedSourceMessageId =
      !params.sourceMessageId && inheritsDraftProvenance
        ? (current?.source_message_id ?? undefined)
        : undefined;
    const inheritedContextSnapshotId =
      !params.contextSnapshotId && inheritsDraftProvenance
        ? (current?.context_snapshot_id ?? undefined)
        : undefined;
    const sourceTaskId = params.sourceTaskId ?? inheritedSourceTaskId;
    const sourceMessageId = params.sourceMessageId ?? inheritedSourceMessageId;
    const contextSnapshotId = params.contextSnapshotId ?? inheritedContextSnapshotId;
    if (sourceTaskId) this.requireTask(database, project, sourceTaskId);
    if (sourceMessageId) this.assertMessageInProject(database, project, sourceMessageId);
    if (contextSnapshotId) this.assertContextInProject(database, project, contextSnapshotId);
    const inheritedBase = current?.base_version_id ?? existing?.published_version_id ?? undefined;
    const baseVersionId = params.baseVersionId ?? inheritedBase;
    if (baseVersionId) this.requireVersion(database, documentId, baseVersionId);
    const now = new Date().toISOString();
    const versionNumber =
      ((
        database
          .prepare('SELECT MAX(version) AS value FROM document_versions WHERE document_id = ?')
          .get(documentId) as { value: number | null }
      ).value ?? 0) + 1;
    if (!existing) {
      database
        .prepare(
          `INSERT INTO documents
           (id, project_id, kind, title, scope_type, scope_id, current_version_id,
            published_version_id, lifecycle_status, row_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'active', 0, ?, ?)`,
        )
        .run(
          documentId,
          project.id,
          params.kind ?? 'note',
          params.title,
          nextScopeType,
          nextScopeId ?? null,
          now,
          now,
        );
    } else if (current && ['draft', 'changes_requested'].includes(current.state)) {
      this.updateVersionState(database, current, 'superseded', now);
    } else if (current?.state === 'in_review') {
      throw new DocumentWorkflowError(
        'A document version in review cannot be edited. Return or reject it first.',
        'INVALID_STATE',
      );
    }
    const versionId = randomUUID();
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, version, content_markdown, created_at, state, base_version_id,
          title_snapshot, scope_type_snapshot, scope_id_snapshot, author_type, author_id,
          source_task_id, source_message_id, context_snapshot_id, content_hash, state_updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        documentId,
        versionNumber,
        params.contentMarkdown,
        now,
        baseVersionId ?? null,
        params.title,
        nextScopeType,
        nextScopeId ?? null,
        params.authorType,
        params.authorType === 'agent' ? 'agent' : LOCAL_USER,
        sourceTaskId ?? null,
        sourceMessageId ?? null,
        contextSnapshotId ?? null,
        hash(params.contentMarkdown),
        now,
      );
    if (existing) {
      const update = database
        .prepare(
          `UPDATE documents
           SET kind = ?, title = ?, scope_type = ?, scope_id = ?, current_version_id = ?,
               updated_at = ?, row_version = row_version + 1
           WHERE id = ? AND row_version = ?`,
        )
        .run(
          params.kind ?? existing.kind,
          params.title,
          nextScopeType,
          nextScopeId ?? null,
          versionId,
          now,
          documentId,
          params.expectedDocumentRowVersion,
        );
      if (update.changes !== 1) {
        throw new DocumentWorkflowError('Document was changed in another window.', 'CONFLICT');
      }
    } else {
      database
        .prepare(
          `UPDATE documents SET current_version_id = ?, updated_at = ?, row_version = 1 WHERE id = ?`,
        )
        .run(versionId, now, documentId);
    }
    if (inheritedSourceTaskId) {
      const taskUpdate = database
        .prepare(
          `UPDATE agent_tasks
           SET updated_at = ?, row_version = row_version + 1
           WHERE id = ? AND status = 'waiting_review'`,
        )
        .run(now, inheritedSourceTaskId);
      if (taskUpdate.changes !== 1) {
        throw new DocumentWorkflowError(
          'The source Agent task is no longer awaiting review.',
          'CONFLICT',
        );
      }
      database
        .prepare(
          `INSERT INTO agent_task_document_versions
           (task_id, document_id, document_version_id, operation, created_at)
           VALUES (?, ?, ?, 'update', ?)`,
        )
        .run(inheritedSourceTaskId, documentId, versionId, now);
      const artifactUpdate = database
        .prepare(
          `UPDATE agent_task_document_artifacts
           SET document_version_id = ?, row_version = row_version + 1, updated_at = ?
           WHERE task_id = ? AND artifact_role = 'primary' AND disposition = 'draft'
             AND document_id = ? AND document_version_id = ?`,
        )
        .run(versionId, now, inheritedSourceTaskId, documentId, current?.id ?? null);
      if (artifactUpdate.changes !== 1) {
        throw new DocumentWorkflowError(
          'The Agent task primary draft was changed by another request.',
          'CONFLICT',
        );
      }
      this.appendEvent(
        database,
        project.id,
        inheritedSourceTaskId,
        'document.draft.revision_created',
        'info',
        'A user revision was created from the Agent draft.',
        { documentId, documentVersionId: versionId },
        now,
      );
    }
    return this.getDocumentInProject(database, project, documentId);
  }

  private getDocumentInProject(
    database: Database.Database,
    project: OpenProject,
    documentId: string,
  ): DocumentDetail {
    const document = this.requireDocument(database, project, documentId);
    const currentVersion = document.current_version_id
      ? (database
          .prepare('SELECT * FROM document_versions WHERE id = ?')
          .get(document.current_version_id) as DocumentVersionRow | undefined)
      : undefined;
    const publishedVersion = document.published_version_id
      ? (database
          .prepare('SELECT * FROM document_versions WHERE id = ?')
          .get(document.published_version_id) as DocumentVersionRow | undefined)
      : undefined;
    return {
      ...toDocumentSummary(document),
      currentVersion: currentVersion ? toDocumentVersion(currentVersion) : undefined,
      publishedVersion: publishedVersion ? toDocumentVersion(publishedVersion) : undefined,
    };
  }

  private requireDocument(
    database: Database.Database,
    project: OpenProject,
    id: string,
  ): DocumentRow {
    const document = database.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      DocumentRow | undefined;
    if (!document || document.project_id !== project.id) throw new Error('Document was not found.');
    return document;
  }

  private requireVersion(
    database: Database.Database,
    documentId: string,
    versionId: string | null | undefined,
  ): DocumentVersionRow {
    if (!versionId) throw new Error('Document version was not found.');
    const version = database
      .prepare('SELECT * FROM document_versions WHERE id = ?')
      .get(versionId) as DocumentVersionRow | undefined;
    if (!version || version.document_id !== documentId)
      throw new Error('Document version was not found.');
    return version;
  }

  private requireTask(
    database: Database.Database,
    project: OpenProject,
    taskId: string,
  ): AgentTaskRow {
    const task = database.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as
      AgentTaskRow | undefined;
    if (!task || task.project_id !== project.id) throw new Error('Agent task was not found.');
    return task;
  }

  private requireDocumentRowVersion(document: DocumentRow, expected: number): void {
    if (!Number.isInteger(expected) || expected < 0 || document.row_version !== expected) {
      throw new DocumentWorkflowError('Document was changed in another window.', 'CONFLICT');
    }
  }

  private requireCurrentVersion(document: DocumentRow, version: DocumentVersionRow): void {
    if (document.current_version_id !== version.id) {
      throw new DocumentWorkflowError(
        'Only the current working version can be reviewed or published.',
        'CONFLICT',
      );
    }
  }

  private bumpDocument(
    database: Database.Database,
    documentId: string,
    expectedRowVersion: number,
    now: string,
  ): void {
    const result = database
      .prepare(
        `UPDATE documents SET updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND row_version = ?`,
      )
      .run(now, documentId, expectedRowVersion);
    if (result.changes !== 1) {
      throw new DocumentWorkflowError('Document was changed in another window.', 'CONFLICT');
    }
  }

  private updateVersionState(
    database: Database.Database,
    version: DocumentVersionRow,
    state: DocumentVersionInfo['state'],
    stateUpdatedAt: string,
  ): void {
    const result = database
      .prepare(
        `UPDATE document_versions
         SET state = ?, state_updated_at = ?, state_version = state_version + 1
         WHERE id = ? AND state_version = ?`,
      )
      .run(state, stateUpdatedAt, version.id, version.state_version);
    if (result.changes !== 1) {
      throw new DocumentWorkflowError(
        'Document version was changed in another window.',
        'CONFLICT',
      );
    }
  }

  private appendAudit(
    database: Database.Database,
    projectId: string,
    entry: {
      action: DocumentWorkflowAuditAction;
      actorType: DocumentWorkflowAuditActorType;
      actorId?: string;
      documentId: string;
      documentVersionId: string;
      sourceVersionId?: string;
      reviewId?: string;
      publicationId?: string;
      taskId?: string;
      metadata?: Record<string, string | number | boolean | null>;
      createdAt: string;
    },
  ): void {
    const metadataJson = JSON.stringify(entry.metadata ?? {});
    if (metadataJson.length > 4_096) {
      throw new Error('Document audit metadata exceeds 4096 characters.');
    }
    const sequence =
      ((
        database
          .prepare('SELECT MAX(sequence) AS value FROM document_audit_events WHERE project_id = ?')
          .get(projectId) as { value: number | null }
      ).value ?? -1) + 1;
    createRepositories(database).documentWorkflowAudits.append({
      id: randomUUID(),
      projectId,
      sequence,
      action: entry.action,
      actorType: entry.actorType,
      actorId: entry.actorId,
      documentId: entry.documentId,
      documentVersionId: entry.documentVersionId,
      sourceVersionId: entry.sourceVersionId,
      reviewId: entry.reviewId,
      publicationId: entry.publicationId,
      taskId: entry.taskId,
      metadataJson,
      createdAt: entry.createdAt,
    });
  }

  private appendEvent(
    database: Database.Database,
    projectId: string,
    taskId: string | null | undefined,
    eventType: string,
    level: 'info' | 'warning' | 'error',
    summary: string,
    payload: Record<string, string> | undefined,
    createdAt: string,
  ): void {
    if (!taskId) return;
    const nextSequence =
      ((
        database
          .prepare('SELECT MAX(sequence) AS value FROM agent_task_events WHERE task_id = ?')
          .get(taskId) as { value: number | null }
      ).value ?? -1) + 1;
    database
      .prepare(
        `INSERT INTO agent_task_events
         (id, task_id, project_id, sequence, event_type, level, actor_type, actor_id,
          summary, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'system', 'worker', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        projectId,
        nextSequence,
        eventType,
        level,
        summary,
        payload ? JSON.stringify(payload) : null,
        createdAt,
      );
  }

  private completeSourceTask(
    database: Database.Database,
    projectId: string,
    taskId: string | null | undefined,
    documentVersionId: string,
    outcome: 'published' | 'rejected',
    now: string,
  ): void {
    if (!taskId) return;
    const task = this.requireTask(database, { id: projectId } as OpenProject, taskId);
    if (task.status !== 'waiting_review') return;
    const result = database
      .prepare(
        `UPDATE agent_tasks
         SET status = 'completed', outcome = ?, updated_at = ?, completed_at = ?, row_version = row_version + 1
         WHERE id = ? AND row_version = ?`,
      )
      .run(outcome, now, now, taskId, task.row_version);
    if (result.changes !== 1) {
      throw new DocumentWorkflowError('Agent task was changed by another request.', 'CONFLICT');
    }
    const artifactUpdate = database
      .prepare(
        `UPDATE agent_task_document_artifacts
         SET disposition = ?, row_version = row_version + 1, updated_at = ?
         WHERE task_id = ? AND artifact_role = 'primary' AND disposition = 'draft'
           AND document_version_id = ?`,
      )
      .run(outcome, now, taskId, documentVersionId);
    if (artifactUpdate.changes !== 1) {
      throw new DocumentWorkflowError(
        'Agent task primary artifact was changed by another request.',
        'CONFLICT',
      );
    }
    this.appendEvent(
      database,
      projectId,
      taskId,
      'agent.task.completed',
      'info',
      outcome === 'published'
        ? 'The document task completed with publication.'
        : 'The document task completed with rejection.',
      { outcome },
      now,
    );
  }

  private assertScope(
    database: Database.Database,
    project: OpenProject,
    type: DocumentSummary['scopeType'],
    id: string | undefined,
  ): void {
    if (type === 'project') return;
    if (!id) throw new Error('scopeId is required for scene and shot documents.');
    if (type === 'scene') {
      const scene = database
        .prepare('SELECT id FROM scenes WHERE id = ? AND project_id = ?')
        .get(id, project.id);
      if (!scene) throw new Error('Scene was not found.');
      return;
    }
    const shot = database
      .prepare(
        `SELECT shots.id FROM shots INNER JOIN scenes ON scenes.id = shots.scene_id
         WHERE shots.id = ? AND scenes.project_id = ?`,
      )
      .get(id, project.id);
    if (!shot) throw new Error('Shot was not found.');
  }

  private assertMessageInProject(
    database: Database.Database,
    project: OpenProject,
    messageId: string,
  ): void {
    const row = database
      .prepare(
        `SELECT messages.id FROM chat_messages messages
         INNER JOIN conversations ON conversations.id = messages.conversation_id
         WHERE messages.id = ? AND conversations.project_id = ?`,
      )
      .get(messageId, project.id);
    if (!row) throw new Error('Message was not found.');
  }

  private assertContextInProject(
    database: Database.Database,
    project: OpenProject,
    snapshotId: string,
  ): void {
    const row = database
      .prepare('SELECT id FROM context_snapshots WHERE id = ? AND project_id = ?')
      .get(snapshotId, project.id);
    if (!row) throw new Error('Context snapshot was not found.');
  }

  private touchProject(
    database: Database.Database,
    project: OpenProject,
    now = new Date().toISOString(),
  ): void {
    database.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id);
    project.updatedAt = now;
  }

  private deriveTitle(content: string): string {
    const heading = content
      .split(/\r?\n/)
      .find((line) => /^#{1,6}\s+/.test(line))
      ?.replace(/^#{1,6}\s+/, '')
      .trim();
    return (
      heading?.slice(0, MAX_TITLE_LENGTH) || `会话草稿 ${new Date().toLocaleDateString('zh-CN')}`
    );
  }
}
