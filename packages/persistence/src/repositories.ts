import type Database from 'better-sqlite3';
import type {
  AgentTaskDocumentVersionRecord,
  AgentTaskDocumentVersionRepository,
  AgentTaskEventRecord,
  AgentTaskEventRepository,
  AgentTaskGenerationRecord,
  AgentTaskGenerationRepository,
  AgentTaskRecord,
  AgentTaskRepository,
  AgentToolCallRecord,
  AgentToolCallRepository,
  AgentToolAuthorizationRecord,
  AgentToolAuthorizationRepository,
  AssetRecord,
  AssetTagRecord,
  AssetGroupRecord,
  AssetRepository,
  ChatMessageRecord,
  ChatMessageRepository,
  ConstraintRecord,
  ConstraintRepository,
  ContextSnapshotRecord,
  ContextSnapshotRepository,
  ConversationRecord,
  ConversationRepository,
  DocumentRecord,
  DocumentWorkflowAuditRecord,
  DocumentWorkflowAuditRepository,
  DocumentPublicationRecord,
  DocumentPublicationRepository,
  DocumentRepository,
  DocumentReviewRecord,
  DocumentReviewRepository,
  DocumentVersionRecord,
  GenerationDraftRecord,
  GenerationDraftRepository,
  GenerationResultRecord,
  GenerationResultRepository,
  JobRecord,
  JobRepository,
  LlmGenerationRecord,
  LlmGenerationRepository,
  LlmGenerationAttemptRecord,
  LlmGenerationAttemptRepository,
  LlmProviderStepRecord,
  LlmProviderStepRepository,
  MemoryRecord,
  MemoryRepository,
  ProjectRecord,
  ProjectRepository,
  SceneRecord,
  SceneRepository,
  ShotRecord,
  ShotRepository,
} from '@ai-video/domain';

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: Database.Database) {}

  get(): ProjectRecord {
    const row = this.database
      .prepare('SELECT id, name, created_at, updated_at FROM projects LIMIT 1')
      .get() as ProjectRow | undefined;
    if (!row) throw new Error('Project metadata is missing.');
    return mapProject(row);
  }

  touch(updatedAt: string): void {
    this.database.prepare('UPDATE projects SET updated_at = ?').run(updatedAt);
  }
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ProjectScopedRepository {
  constructor(protected readonly database: Database.Database) {}
}

class SqliteDocumentRepository extends ProjectScopedRepository implements DocumentRepository {
  save(record: DocumentRecord): void {
    this.database
      .prepare(
        `INSERT INTO documents
         (id, project_id, kind, title, scope_type, scope_id,
          current_version_id, published_version_id, lifecycle_status, row_version,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title,
           scope_type = excluded.scope_type, scope_id = excluded.scope_id,
           current_version_id = COALESCE(excluded.current_version_id, documents.current_version_id),
           published_version_id = COALESCE(
             excluded.published_version_id,
             documents.published_version_id
           ),
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.kind,
        record.title,
        record.scopeType,
        record.scopeId ?? null,
        record.currentVersionId ?? null,
        record.publishedVersionId ?? null,
        record.lifecycleStatus ?? 'active',
        record.rowVersion ?? 0,
        record.updatedAt ?? record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): DocumentRecord | undefined {
    const row = this.database.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      DocumentRow | undefined;
    return row ? mapDocument(row) : undefined;
  }

  listByProject(projectId: string): DocumentRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY created_at, id')
        .all(projectId) as DocumentRow[]
    ).map(mapDocument);
  }

  saveVersion(record: DocumentRecord, version: DocumentVersionRecord): void {
    this.database.transaction(() => {
      this.save(record);
      this.database
        .prepare(
          `INSERT INTO document_versions
           (id, document_id, version, content_markdown, state, base_version_id,
            title_snapshot, scope_type_snapshot, scope_id_snapshot,
            author_type, author_id, source_task_id, source_message_id,
            context_snapshot_id, content_hash, state_updated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.id,
          version.documentId,
          version.version,
          version.contentMarkdown,
          version.state ?? 'published',
          version.baseVersionId ?? null,
          version.titleSnapshot ?? record.title,
          version.scopeTypeSnapshot ?? record.scopeType,
          version.scopeIdSnapshot ?? record.scopeId ?? null,
          version.authorType ?? 'user',
          version.authorId ?? null,
          version.sourceTaskId ?? null,
          version.sourceMessageId ?? null,
          version.contextSnapshotId ?? null,
          version.contentHash ?? null,
          version.stateUpdatedAt ?? version.createdAt,
          version.createdAt,
        );
      const autoPublish = (version.state ?? 'published') === 'published';
      this.database
        .prepare(
          `UPDATE documents
           SET current_version_id = ?,
               published_version_id = CASE WHEN ? THEN ? ELSE published_version_id END,
               updated_at = ?,
               row_version = row_version + CASE WHEN ? THEN 1 ELSE 0 END
           WHERE id = ?`,
        )
        .run(
          version.id,
          autoPublish ? 1 : 0,
          version.id,
          record.updatedAt,
          autoPublish ? 1 : 0,
          record.id,
        );
    })();
  }

  getVersion(id: string): DocumentVersionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM document_versions WHERE id = ?').get(id) as
      DocumentVersionRow | undefined;
    return row ? mapDocumentVersion(row) : undefined;
  }

  listVersions(documentId: string): DocumentVersionRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version DESC')
        .all(documentId) as DocumentVersionRow[]
    ).map(mapDocumentVersion);
  }

  updatePublishedVersion(
    documentId: string,
    publishedVersionId: string,
    expectedRowVersion: number,
    updatedAt: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE documents
         SET published_version_id = ?, updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND row_version = ?
           AND EXISTS (
             SELECT 1 FROM document_versions
             WHERE document_versions.id = ?
               AND document_versions.document_id = documents.id
           )`,
      )
      .run(publishedVersionId, updatedAt, documentId, expectedRowVersion, publishedVersionId);
    return result.changes === 1;
  }

  updateVersionState(
    versionId: string,
    state: NonNullable<DocumentVersionRecord['state']>,
    expectedStateVersion: number,
    stateUpdatedAt: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE document_versions
         SET state = ?, state_updated_at = ?, state_version = state_version + 1
         WHERE id = ? AND state_version = ?`,
      )
      .run(state, stateUpdatedAt, versionId, expectedStateVersion);
    return result.changes === 1;
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
  lifecycle_status: 'active' | 'archived';
  row_version: number;
  created_at: string;
  updated_at: string;
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    scopeType: row.scope_type,
    scopeId: row.scope_id ?? undefined,
    currentVersionId: row.current_version_id ?? undefined,
    publishedVersionId: row.published_version_id ?? undefined,
    lifecycleStatus: row.lifecycle_status,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DocumentVersionRow {
  id: string;
  document_id: string;
  version: number;
  content_markdown: string;
  state: NonNullable<DocumentVersionRecord['state']>;
  base_version_id: string | null;
  title_snapshot: string | null;
  scope_type_snapshot: string | null;
  scope_id_snapshot: string | null;
  author_type: NonNullable<DocumentVersionRecord['authorType']>;
  author_id: string | null;
  source_task_id: string | null;
  source_message_id: string | null;
  context_snapshot_id: string | null;
  content_hash: string | null;
  state_updated_at: string | null;
  state_version: number;
  created_at: string;
}

function mapDocumentVersion(row: DocumentVersionRow): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
    state: row.state,
    baseVersionId: row.base_version_id ?? undefined,
    titleSnapshot: row.title_snapshot ?? undefined,
    scopeTypeSnapshot: row.scope_type_snapshot ?? undefined,
    scopeIdSnapshot: row.scope_id_snapshot ?? undefined,
    authorType: row.author_type,
    authorId: row.author_id ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    contextSnapshotId: row.context_snapshot_id ?? undefined,
    contentHash: row.content_hash ?? undefined,
    stateUpdatedAt: row.state_updated_at ?? undefined,
    stateVersion: row.state_version,
    createdAt: row.created_at,
  };
}

class SqliteDocumentReviewRepository
  extends ProjectScopedRepository
  implements DocumentReviewRepository
{
  save(record: DocumentReviewRecord): void {
    this.database
      .prepare(
        `INSERT INTO document_reviews
         (id, project_id, document_id, document_version_id, task_id, status,
          requested_by_type, requested_by_id, requested_at, decided_by_type,
          decided_by_id, decided_at, comment, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           status = excluded.status,
           requested_by_type = excluded.requested_by_type,
           requested_by_id = excluded.requested_by_id,
           requested_at = excluded.requested_at,
           decided_by_type = excluded.decided_by_type,
           decided_by_id = excluded.decided_by_id,
           decided_at = excluded.decided_at,
           comment = excluded.comment,
           version = excluded.version`,
      )
      .run(
        record.id,
        record.projectId,
        record.documentId,
        record.documentVersionId,
        record.taskId ?? null,
        record.status,
        record.requestedByType,
        record.requestedById ?? null,
        record.requestedAt,
        record.decidedByType ?? null,
        record.decidedById ?? null,
        record.decidedAt ?? null,
        record.comment ?? null,
        record.version,
      );
  }

  get(id: string): DocumentReviewRecord | undefined {
    const row = this.database.prepare('SELECT * FROM document_reviews WHERE id = ?').get(id) as
      DocumentReviewRow | undefined;
    return row ? mapDocumentReview(row) : undefined;
  }

  getByVersion(documentVersionId: string): DocumentReviewRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM document_reviews WHERE document_version_id = ?')
      .get(documentVersionId) as DocumentReviewRow | undefined;
    return row ? mapDocumentReview(row) : undefined;
  }

  listByDocument(documentId: string): DocumentReviewRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM document_reviews
           WHERE document_id = ? ORDER BY requested_at DESC, id DESC`,
        )
        .all(documentId) as DocumentReviewRow[]
    ).map(mapDocumentReview);
  }

  update(record: DocumentReviewRecord, expectedVersion: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE document_reviews SET
           task_id = ?, status = ?, requested_by_type = ?, requested_by_id = ?,
           requested_at = ?, decided_by_type = ?, decided_by_id = ?, decided_at = ?,
           comment = ?, version = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        record.taskId ?? null,
        record.status,
        record.requestedByType,
        record.requestedById ?? null,
        record.requestedAt,
        record.decidedByType ?? null,
        record.decidedById ?? null,
        record.decidedAt ?? null,
        record.comment ?? null,
        record.version,
        record.id,
        expectedVersion,
      );
    return result.changes === 1;
  }
}

interface DocumentReviewRow {
  id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  task_id: string | null;
  status: DocumentReviewRecord['status'];
  requested_by_type: string;
  requested_by_id: string | null;
  requested_at: string;
  decided_by_type: string | null;
  decided_by_id: string | null;
  decided_at: string | null;
  comment: string | null;
  version: number;
}

function mapDocumentReview(row: DocumentReviewRow): DocumentReviewRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    taskId: row.task_id ?? undefined,
    status: row.status,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id ?? undefined,
    requestedAt: row.requested_at,
    decidedByType: row.decided_by_type ?? undefined,
    decidedById: row.decided_by_id ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    comment: row.comment ?? undefined,
    version: row.version,
  };
}

class SqliteDocumentPublicationRepository
  extends ProjectScopedRepository
  implements DocumentPublicationRepository
{
  append(record: DocumentPublicationRecord): void {
    this.database
      .prepare(
        `INSERT INTO document_publications
         (id, project_id, document_id, document_version_id, previous_version_id,
          publication_no, review_id, task_id, published_by_type, published_by_id,
          published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.documentId,
        record.documentVersionId,
        record.previousVersionId ?? null,
        record.publicationNo,
        record.reviewId ?? null,
        record.taskId ?? null,
        record.publishedByType,
        record.publishedById ?? null,
        record.publishedAt,
      );
  }

  get(id: string): DocumentPublicationRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM document_publications WHERE id = ?')
      .get(id) as DocumentPublicationRow | undefined;
    return row ? mapDocumentPublication(row) : undefined;
  }

  listByDocument(documentId: string): DocumentPublicationRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM document_publications
           WHERE document_id = ? ORDER BY publication_no DESC, id DESC`,
        )
        .all(documentId) as DocumentPublicationRow[]
    ).map(mapDocumentPublication);
  }
}

interface DocumentPublicationRow {
  id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  previous_version_id: string | null;
  publication_no: number;
  review_id: string | null;
  task_id: string | null;
  published_by_type: string;
  published_by_id: string | null;
  published_at: string;
}

function mapDocumentPublication(row: DocumentPublicationRow): DocumentPublicationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    previousVersionId: row.previous_version_id ?? undefined,
    publicationNo: row.publication_no,
    reviewId: row.review_id ?? undefined,
    taskId: row.task_id ?? undefined,
    publishedByType: row.published_by_type,
    publishedById: row.published_by_id ?? undefined,
    publishedAt: row.published_at,
  };
}

class SqliteDocumentWorkflowAuditRepository
  extends ProjectScopedRepository
  implements DocumentWorkflowAuditRepository
{
  append(record: DocumentWorkflowAuditRecord): void {
    this.database
      .prepare(
        `INSERT INTO document_audit_events
         (id, project_id, sequence, action, actor_type, actor_id, document_id,
          document_version_id, source_version_id, review_id, publication_id, task_id,
          metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.sequence,
        record.action,
        record.actorType,
        record.actorId ?? null,
        record.documentId,
        record.documentVersionId,
        record.sourceVersionId ?? null,
        record.reviewId ?? null,
        record.publicationId ?? null,
        record.taskId ?? null,
        record.metadataJson ?? '{}',
        record.createdAt,
      );
  }

  listByProject(projectId: string, limit = 100): DocumentWorkflowAuditRecord[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), 1_000)
      : 100;
    return (
      this.database
        .prepare(
          `SELECT * FROM document_audit_events
           WHERE project_id = ? ORDER BY sequence DESC, id DESC LIMIT ?`,
        )
        .all(projectId, boundedLimit) as DocumentWorkflowAuditRow[]
    ).map(mapDocumentWorkflowAudit);
  }

  listByDocument(documentId: string, limit = 100): DocumentWorkflowAuditRecord[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), 1_000)
      : 100;
    return (
      this.database
        .prepare(
          `SELECT * FROM document_audit_events
           WHERE document_id = ? ORDER BY sequence DESC, id DESC LIMIT ?`,
        )
        .all(documentId, boundedLimit) as DocumentWorkflowAuditRow[]
    ).map(mapDocumentWorkflowAudit);
  }
}

interface DocumentWorkflowAuditRow {
  id: string;
  project_id: string;
  sequence: number;
  action: DocumentWorkflowAuditRecord['action'];
  actor_type: DocumentWorkflowAuditRecord['actorType'];
  actor_id: string | null;
  document_id: string;
  document_version_id: string;
  source_version_id: string | null;
  review_id: string | null;
  publication_id: string | null;
  task_id: string | null;
  metadata_json: string;
  created_at: string;
}

function mapDocumentWorkflowAudit(row: DocumentWorkflowAuditRow): DocumentWorkflowAuditRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id ?? undefined,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    sourceVersionId: row.source_version_id ?? undefined,
    reviewId: row.review_id ?? undefined,
    publicationId: row.publication_id ?? undefined,
    taskId: row.task_id ?? undefined,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}

class SqliteAgentTaskDocumentVersionRepository
  extends ProjectScopedRepository
  implements AgentTaskDocumentVersionRepository
{
  link(record: AgentTaskDocumentVersionRecord): void {
    this.database
      .prepare(
        `INSERT INTO agent_task_document_versions
         (task_id, document_id, document_version_id, operation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.taskId,
        record.documentId,
        record.documentVersionId,
        record.operation,
        record.createdAt,
      );
  }

  listByTask(taskId: string): AgentTaskDocumentVersionRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_task_document_versions
           WHERE task_id = ? ORDER BY created_at, document_version_id`,
        )
        .all(taskId) as AgentTaskDocumentVersionRow[]
    ).map(mapAgentTaskDocumentVersion);
  }
}

interface AgentTaskDocumentVersionRow {
  task_id: string;
  document_id: string;
  document_version_id: string;
  operation: AgentTaskDocumentVersionRecord['operation'];
  created_at: string;
}

function mapAgentTaskDocumentVersion(
  row: AgentTaskDocumentVersionRow,
): AgentTaskDocumentVersionRecord {
  return {
    taskId: row.task_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    operation: row.operation,
    createdAt: row.created_at,
  };
}

class SqliteSceneRepository extends ProjectScopedRepository implements SceneRepository {
  save(record: SceneRecord): void {
    this.database
      .prepare(
        `INSERT INTO scenes (id, project_id, title, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.title,
        record.position,
        record.updatedAt ?? record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): SceneRecord | undefined {
    const row = this.database.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as
      SceneRow | undefined;
    return row ? mapScene(row) : undefined;
  }

  listByProject(projectId: string): SceneRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position, id')
        .all(projectId) as SceneRow[]
    ).map(mapScene);
  }
}

interface SceneRow {
  id: string;
  project_id: string;
  title: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function mapScene(row: SceneRow): SceneRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class SqliteShotRepository extends ProjectScopedRepository implements ShotRepository {
  save(record: ShotRecord): void {
    this.database
      .prepare(
        `INSERT INTO shots (id, scene_id, title, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.sceneId,
        record.title,
        record.position,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): ShotRecord | undefined {
    const row = this.database.prepare('SELECT * FROM shots WHERE id = ?').get(id) as
      ShotRow | undefined;
    return row ? mapShot(row) : undefined;
  }

  listByScene(sceneId: string): ShotRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM shots WHERE scene_id = ? ORDER BY position, id')
        .all(sceneId) as ShotRow[]
    ).map(mapShot);
  }
}

interface ShotRow {
  id: string;
  scene_id: string;
  title: string;
  position: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapShot(row: ShotRow): ShotRecord {
  return {
    id: row.id,
    sceneId: row.scene_id,
    title: row.title,
    position: row.position,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class SqliteConversationRepository
  extends ProjectScopedRepository
  implements ConversationRepository
{
  save(record: ConversationRecord): void {
    this.database
      .prepare(
        `INSERT INTO conversations
         (id, project_id, scope_type, scope_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scope_type = excluded.scope_type, scope_id = excluded.scope_id,
           title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.scopeType,
        record.scopeId ?? null,
        record.title,
        record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): ConversationRecord | undefined {
    const row = this.database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      ConversationRow | undefined;
    return row ? mapConversation(row) : undefined;
  }

  listByProject(projectId: string): ConversationRecord[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
        )
        .all(projectId) as ConversationRow[]
    ).map(mapConversation);
  }
}

interface ConversationRow {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id ?? undefined,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class SqliteChatMessageRepository extends ProjectScopedRepository implements ChatMessageRepository {
  save(record: ChatMessageRecord): void {
    this.database
      .prepare(
        `INSERT INTO chat_messages
         (id, conversation_id, reply_to_message_id, role, content, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reply_to_message_id = excluded.reply_to_message_id,
           content = excluded.content,
           status = excluded.status`,
      )
      .run(
        record.id,
        record.conversationId,
        record.replyToMessageId ?? null,
        record.role,
        record.content,
        record.status,
        record.createdAt,
      );
  }

  get(id: string): ChatMessageRecord | undefined {
    const row = this.database.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as
      ChatMessageRow | undefined;
    return row ? mapChatMessage(row) : undefined;
  }

  listPage(conversationId: string, limit: number, before?: string): ChatMessageRecord[] {
    let rows: ChatMessageRow[];
    if (before) {
      const cursor = this.database
        .prepare('SELECT created_at, id FROM chat_messages WHERE id = ? AND conversation_id = ?')
        .get(before, conversationId) as Pick<ChatMessageRow, 'created_at' | 'id'> | undefined;
      if (!cursor) return [];
      rows = this.database
        .prepare(
          `SELECT * FROM chat_messages
           WHERE conversation_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          conversationId,
          cursor.created_at,
          cursor.created_at,
          cursor.id,
          limit,
        ) as ChatMessageRow[];
    } else {
      rows = this.database
        .prepare(
          `SELECT * FROM chat_messages
           WHERE conversation_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(conversationId, limit) as ChatMessageRow[];
    }
    return rows.map(mapChatMessage);
  }

  failStreamingByProject(projectId: string, failureMessage: string): number {
    const result = this.database
      .prepare(
        `UPDATE chat_messages
         SET status = 'failed',
             content = CASE WHEN length(trim(content)) = 0 THEN ? ELSE content END
         WHERE status = 'streaming'
           AND conversation_id IN (
             SELECT id FROM conversations WHERE project_id = ?
           )`,
      )
      .run(failureMessage, projectId);
    return result.changes;
  }
}

interface ChatMessageRow {
  id: string;
  conversation_id: string;
  reply_to_message_id: string | null;
  role: ChatMessageRecord['role'];
  content: string;
  status: ChatMessageRecord['status'];
  created_at: string;
}

function mapChatMessage(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
  };
}

class SqliteLlmGenerationAttemptRepository
  extends ProjectScopedRepository
  implements LlmGenerationAttemptRepository
{
  save(record: LlmGenerationAttemptRecord): void {
    this.database
      .prepare(
        `INSERT INTO llm_generation_attempts
         (id, generation_id, conversation_id, user_message_id, assistant_message_id,
          context_snapshot_id, provider_profile_id, provider_name_snapshot, model_id,
          model_name_snapshot, protocol, status, started_at, first_token_at, completed_at,
          provider_response_id, finish_reason, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, total_tokens, raw_usage_json, pricing_snapshot_json, estimated_cost,
          currency, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           first_token_at = excluded.first_token_at,
           completed_at = excluded.completed_at,
           provider_response_id = excluded.provider_response_id,
           finish_reason = excluded.finish_reason,
           input_tokens = excluded.input_tokens,
           cached_input_tokens = excluded.cached_input_tokens,
           output_tokens = excluded.output_tokens,
           reasoning_tokens = excluded.reasoning_tokens,
           total_tokens = excluded.total_tokens,
           raw_usage_json = excluded.raw_usage_json,
           pricing_snapshot_json = excluded.pricing_snapshot_json,
           estimated_cost = excluded.estimated_cost,
           currency = excluded.currency,
           error_code = excluded.error_code,
           error_message = excluded.error_message`,
      )
      .run(
        record.id,
        record.generationId,
        record.conversationId,
        record.userMessageId,
        record.assistantMessageId,
        record.contextSnapshotId,
        record.providerProfileId ?? null,
        record.providerNameSnapshot,
        record.modelId ?? null,
        record.modelNameSnapshot,
        record.protocol,
        record.status,
        record.startedAt,
        record.firstTokenAt ?? null,
        record.completedAt ?? null,
        record.providerResponseId ?? null,
        record.finishReason ?? null,
        record.inputTokens ?? null,
        record.cachedInputTokens ?? null,
        record.outputTokens ?? null,
        record.reasoningTokens ?? null,
        record.totalTokens ?? null,
        record.rawUsageJson ?? null,
        record.pricingSnapshotJson ?? null,
        record.estimatedCost ?? null,
        record.currency ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
      );
  }

  get(id: string): LlmGenerationAttemptRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM llm_generation_attempts WHERE id = ?')
      .get(id) as LlmGenerationAttemptRow | undefined;
    return row ? mapLlmGenerationAttempt(row) : undefined;
  }

  getByAssistantMessage(assistantMessageId: string): LlmGenerationAttemptRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM llm_generation_attempts
         WHERE assistant_message_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(assistantMessageId) as LlmGenerationAttemptRow | undefined;
    return row ? mapLlmGenerationAttempt(row) : undefined;
  }

  listByProject(projectId: string): LlmGenerationAttemptRecord[] {
    return (
      this.database
        .prepare(
          `SELECT attempts.* FROM llm_generation_attempts attempts
           INNER JOIN conversations ON conversations.id = attempts.conversation_id
           WHERE conversations.project_id = ?
           ORDER BY attempts.started_at, attempts.id`,
        )
        .all(projectId) as LlmGenerationAttemptRow[]
    ).map(mapLlmGenerationAttempt);
  }

  failActiveByProject(projectId: string, completedAt: string, errorMessage: string): number {
    return this.database
      .prepare(
        `UPDATE llm_generation_attempts
         SET status = 'failed', completed_at = ?, error_code = 'worker-restarted', error_message = ?
         WHERE status IN ('prepared', 'streaming', 'interrupted')
           AND conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)`,
      )
      .run(completedAt, errorMessage, projectId).changes;
  }
}

class SqliteLlmGenerationRepository
  extends ProjectScopedRepository
  implements LlmGenerationRepository
{
  insert(record: LlmGenerationRecord): void {
    this.database
      .prepare(
        `INSERT INTO llm_generations
         (id, project_id, project_session_id, conversation_id, context_snapshot_id,
          user_message_id, assistant_message_id, status, execution_mode,
          retry_of_generation_id, idempotency_key, provider_profile_id, model_id,
          error_code, error_message, retryable, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.projectSessionId,
        record.conversationId,
        record.contextSnapshotId,
        record.userMessageId,
        record.assistantMessageId,
        record.status,
        record.executionMode,
        record.retryOfGenerationId ?? null,
        record.idempotencyKey ?? null,
        record.providerProfileId ?? null,
        record.modelId ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.retryable === undefined ? null : record.retryable ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.version,
      );
  }

  get(id: string): LlmGenerationRecord | undefined {
    const row = this.database.prepare('SELECT * FROM llm_generations WHERE id = ?').get(id) as
      LlmGenerationRow | undefined;
    return row ? mapLlmGeneration(row) : undefined;
  }

  getByIdempotencyKey(projectId: string, idempotencyKey: string): LlmGenerationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM llm_generations
         WHERE project_id = ? AND idempotency_key = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, idempotencyKey) as LlmGenerationRow | undefined;
    return row ? mapLlmGeneration(row) : undefined;
  }

  update(record: LlmGenerationRecord, expectedVersion: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE llm_generations SET
           project_session_id = ?, status = ?, execution_mode = ?,
           retry_of_generation_id = ?, idempotency_key = ?, provider_profile_id = ?, model_id = ?,
           error_code = ?, error_message = ?, retryable = ?, updated_at = ?, version = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        record.projectSessionId,
        record.status,
        record.executionMode,
        record.retryOfGenerationId ?? null,
        record.idempotencyKey ?? null,
        record.providerProfileId ?? null,
        record.modelId ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.retryable === undefined ? null : record.retryable ? 1 : 0,
        record.updatedAt,
        record.version,
        record.id,
        expectedVersion,
      );
    return result.changes === 1;
  }

  failActiveByProject(projectId: string, updatedAt: string, errorMessage: string): number {
    return this.database
      .prepare(
        `UPDATE llm_generations
         SET status = 'failed', error_code = 'worker-restarted', error_message = ?,
             retryable = 1, updated_at = ?, version = version + 1
         WHERE project_id = ? AND status IN ('prepared', 'streaming')`,
      )
      .run(errorMessage, updatedAt, projectId).changes;
  }
}

interface LlmGenerationRow {
  id: string;
  project_id: string;
  project_session_id: string;
  conversation_id: string;
  context_snapshot_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: LlmGenerationRecord['status'];
  execution_mode: LlmGenerationRecord['executionMode'];
  retry_of_generation_id: string | null;
  idempotency_key: string | null;
  provider_profile_id: string | null;
  model_id: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function mapLlmGeneration(row: LlmGenerationRow): LlmGenerationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectSessionId: row.project_session_id,
    conversationId: row.conversation_id,
    contextSnapshotId: row.context_snapshot_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    executionMode: row.execution_mode,
    retryOfGenerationId: row.retry_of_generation_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    providerProfileId: row.provider_profile_id ?? undefined,
    modelId: row.model_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    retryable: row.retryable === null ? undefined : row.retryable === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

class SqliteAgentTaskRepository extends ProjectScopedRepository implements AgentTaskRepository {
  save(record: AgentTaskRecord): void {
    this.database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, project_session_id, conversation_id, user_message_id,
          task_type, scope_type, scope_id, title, request_snapshot_json, request_hash,
          context_snapshot_id, status, outcome, retry_of_task_id, idempotency_key,
          error_code, error_message, retryable, created_at, started_at, updated_at,
          completed_at, phase, row_version, tool_call_limit, tool_call_count, lifecycle_status,
          archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_session_id = excluded.project_session_id,
           conversation_id = excluded.conversation_id,
           user_message_id = excluded.user_message_id,
           task_type = excluded.task_type,
           scope_type = excluded.scope_type,
           scope_id = excluded.scope_id,
           title = excluded.title,
           request_snapshot_json = excluded.request_snapshot_json,
           request_hash = excluded.request_hash,
           context_snapshot_id = excluded.context_snapshot_id,
           status = excluded.status,
           outcome = excluded.outcome,
           retry_of_task_id = excluded.retry_of_task_id,
           idempotency_key = excluded.idempotency_key,
           error_code = excluded.error_code,
           error_message = excluded.error_message,
           retryable = excluded.retryable,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at,
           phase = excluded.phase,
           row_version = excluded.row_version,
           tool_call_limit = excluded.tool_call_limit,
           tool_call_count = excluded.tool_call_count,
           lifecycle_status = excluded.lifecycle_status,
           archived_at = excluded.archived_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.projectSessionId,
        record.conversationId ?? null,
        record.userMessageId ?? null,
        record.taskType,
        record.scopeType,
        record.scopeId ?? null,
        record.title,
        record.requestSnapshotJson,
        record.requestHash,
        record.contextSnapshotId ?? null,
        record.status,
        record.outcome ?? null,
        record.retryOfTaskId ?? null,
        record.idempotencyKey ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.retryable === undefined ? null : record.retryable ? 1 : 0,
        record.createdAt,
        record.startedAt ?? null,
        record.updatedAt,
        record.completedAt ?? null,
        record.phase,
        record.rowVersion,
        record.toolCallLimit,
        record.toolCallCount,
        record.lifecycleStatus,
        record.archivedAt ?? null,
      );
  }

  get(id: string): AgentTaskRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as
      AgentTaskRow | undefined;
    return row ? mapAgentTask(row) : undefined;
  }

  getByIdempotencyKey(projectId: string, idempotencyKey: string): AgentTaskRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_tasks
         WHERE project_id = ? AND idempotency_key = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, idempotencyKey) as AgentTaskRow | undefined;
    return row ? mapAgentTask(row) : undefined;
  }

  listByProject(projectId: string): AgentTaskRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_tasks
           WHERE project_id = ? ORDER BY updated_at DESC, id DESC`,
        )
        .all(projectId) as AgentTaskRow[]
    ).map(mapAgentTask);
  }

  update(record: AgentTaskRecord, expectedVersion: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE agent_tasks SET
           project_session_id = ?, conversation_id = ?, user_message_id = ?,
           task_type = ?, scope_type = ?, scope_id = ?, title = ?,
           request_snapshot_json = ?, request_hash = ?, context_snapshot_id = ?,
           status = ?, outcome = ?, retry_of_task_id = ?, idempotency_key = ?,
           error_code = ?, error_message = ?, retryable = ?, started_at = ?,
           updated_at = ?, completed_at = ?, phase = ?, row_version = ?, tool_call_limit = ?,
           tool_call_count = ?, lifecycle_status = ?, archived_at = ?
         WHERE id = ? AND row_version = ?`,
      )
      .run(
        record.projectSessionId,
        record.conversationId ?? null,
        record.userMessageId ?? null,
        record.taskType,
        record.scopeType,
        record.scopeId ?? null,
        record.title,
        record.requestSnapshotJson,
        record.requestHash,
        record.contextSnapshotId ?? null,
        record.status,
        record.outcome ?? null,
        record.retryOfTaskId ?? null,
        record.idempotencyKey ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.retryable === undefined ? null : record.retryable ? 1 : 0,
        record.startedAt ?? null,
        record.updatedAt,
        record.completedAt ?? null,
        record.phase,
        record.rowVersion,
        record.toolCallLimit,
        record.toolCallCount,
        record.lifecycleStatus,
        record.archivedAt ?? null,
        record.id,
        expectedVersion,
      );
    return result.changes === 1;
  }
}

interface AgentTaskRow {
  id: string;
  project_id: string;
  project_session_id: string;
  conversation_id: string | null;
  user_message_id: string | null;
  task_type: AgentTaskRecord['taskType'];
  scope_type: string;
  scope_id: string | null;
  title: string;
  request_snapshot_json: string;
  request_hash: string;
  context_snapshot_id: string | null;
  status: AgentTaskRecord['status'];
  outcome: AgentTaskRecord['outcome'] | null;
  retry_of_task_id: string | null;
  idempotency_key: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  phase: AgentTaskRecord['phase'];
  row_version: number;
  tool_call_limit: number;
  tool_call_count: number;
  lifecycle_status: 'active' | 'archived';
  archived_at: string | null;
}

function mapAgentTask(row: AgentTaskRow): AgentTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectSessionId: row.project_session_id,
    conversationId: row.conversation_id ?? undefined,
    userMessageId: row.user_message_id ?? undefined,
    taskType: row.task_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id ?? undefined,
    title: row.title,
    requestSnapshotJson: row.request_snapshot_json,
    requestHash: row.request_hash,
    contextSnapshotId: row.context_snapshot_id ?? undefined,
    status: row.status,
    outcome: row.outcome ?? undefined,
    retryOfTaskId: row.retry_of_task_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    retryable: row.retryable === null ? undefined : row.retryable === 1,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    phase: row.phase,
    rowVersion: row.row_version,
    toolCallLimit: row.tool_call_limit,
    toolCallCount: row.tool_call_count,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
  };
}

class SqliteAgentTaskEventRepository
  extends ProjectScopedRepository
  implements AgentTaskEventRepository
{
  append(record: AgentTaskEventRecord): void {
    this.database
      .prepare(
        `INSERT INTO agent_task_events
         (id, task_id, project_id, sequence, event_type, level, actor_type, actor_id,
          summary, payload_json, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.taskId,
        record.projectId,
        record.sequence,
        record.eventType,
        record.level,
        record.actorType ?? null,
        record.actorId ?? null,
        record.summary,
        record.payloadJson ?? null,
        record.dedupeKey ?? null,
        record.createdAt,
      );
  }

  listByTask(taskId: string): AgentTaskEventRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM agent_task_events WHERE task_id = ? ORDER BY sequence, id')
        .all(taskId) as AgentTaskEventRow[]
    ).map(mapAgentTaskEvent);
  }
}

interface AgentTaskEventRow {
  id: string;
  task_id: string;
  project_id: string;
  sequence: number;
  event_type: string;
  level: AgentTaskEventRecord['level'];
  actor_type: string | null;
  actor_id: string | null;
  summary: string;
  payload_json: string | null;
  dedupe_key: string | null;
  created_at: string;
}

function mapAgentTaskEvent(row: AgentTaskEventRow): AgentTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    sequence: row.sequence,
    eventType: row.event_type,
    level: row.level,
    actorType: row.actor_type ?? undefined,
    actorId: row.actor_id ?? undefined,
    summary: row.summary,
    payloadJson: row.payload_json ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    createdAt: row.created_at,
  };
}

class SqliteAgentTaskGenerationRepository
  extends ProjectScopedRepository
  implements AgentTaskGenerationRepository
{
  link(record: AgentTaskGenerationRecord): void {
    this.database
      .prepare(
        `INSERT INTO agent_task_generations
         (task_id, generation_id, ordinal, purpose, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.taskId, record.generationId, record.ordinal, record.purpose, record.createdAt);
  }

  listByTask(taskId: string): AgentTaskGenerationRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_task_generations
           WHERE task_id = ? ORDER BY ordinal, generation_id`,
        )
        .all(taskId) as AgentTaskGenerationRow[]
    ).map(mapAgentTaskGeneration);
  }
}

interface AgentTaskGenerationRow {
  task_id: string;
  generation_id: string;
  ordinal: number;
  purpose: string;
  created_at: string;
}

function mapAgentTaskGeneration(row: AgentTaskGenerationRow): AgentTaskGenerationRecord {
  return {
    taskId: row.task_id,
    generationId: row.generation_id,
    ordinal: row.ordinal,
    purpose: row.purpose,
    createdAt: row.created_at,
  };
}

class SqliteAgentToolCallRepository
  extends ProjectScopedRepository
  implements AgentToolCallRepository
{
  save(record: AgentToolCallRecord): void {
    this.database
      .prepare(
        `INSERT INTO agent_tool_calls
         (id, project_id, task_id, generation_id, attempt_id, authorization_id, provider_step_id,
          provider_call_id, tool_ordinal, tool_name, normalized_arguments_hash,
          arguments_summary_json, result_summary_json, result_document_id,
          result_document_version_id, status, idempotency_key, error_code, error_message,
          created_at, started_at, completed_at, version, redaction_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           generation_id = excluded.generation_id,
           attempt_id = excluded.attempt_id,
           authorization_id = excluded.authorization_id,
           provider_step_id = excluded.provider_step_id,
           provider_call_id = excluded.provider_call_id,
           tool_ordinal = excluded.tool_ordinal,
           tool_name = excluded.tool_name,
           normalized_arguments_hash = excluded.normalized_arguments_hash,
           arguments_summary_json = excluded.arguments_summary_json,
           result_summary_json = excluded.result_summary_json,
           result_document_id = excluded.result_document_id,
           result_document_version_id = excluded.result_document_version_id,
           status = excluded.status,
           idempotency_key = excluded.idempotency_key,
           error_code = excluded.error_code,
           error_message = excluded.error_message,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           version = excluded.version,
           redaction_state = excluded.redaction_state`,
      )
      .run(
        record.id,
        record.projectId,
        record.taskId,
        record.generationId ?? null,
        record.attemptId ?? null,
        record.authorizationId ?? null,
        record.providerStepId ?? null,
        record.providerCallId ?? null,
        record.toolOrdinal ?? null,
        record.toolName,
        record.normalizedArgumentsHash,
        record.argumentsSummaryJson,
        record.resultSummaryJson ?? null,
        record.resultDocumentId ?? null,
        record.resultDocumentVersionId ?? null,
        record.status,
        record.idempotencyKey ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.createdAt,
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.version,
        record.redactionState,
      );
  }

  get(id: string): AgentToolCallRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agent_tool_calls WHERE id = ?').get(id) as
      AgentToolCallRow | undefined;
    return row ? mapAgentToolCall(row) : undefined;
  }

  getByProviderCallId(
    taskId: string,
    attemptId: string,
    providerStepId: string,
    providerCallId: string,
  ): AgentToolCallRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_tool_calls
         WHERE task_id = ? AND attempt_id = ? AND provider_step_id = ? AND provider_call_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId, attemptId, providerStepId, providerCallId) as AgentToolCallRow | undefined;
    return row ? mapAgentToolCall(row) : undefined;
  }

  getByIdempotencyKey(taskId: string, idempotencyKey: string): AgentToolCallRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_tool_calls
         WHERE task_id = ? AND idempotency_key = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId, idempotencyKey) as AgentToolCallRow | undefined;
    return row ? mapAgentToolCall(row) : undefined;
  }

  listByTask(taskId: string): AgentToolCallRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_tool_calls
           WHERE task_id = ? ORDER BY created_at, id`,
        )
        .all(taskId) as AgentToolCallRow[]
    ).map(mapAgentToolCall);
  }

  update(record: AgentToolCallRecord, expectedVersion: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE agent_tool_calls SET
           generation_id = ?, attempt_id = ?, authorization_id = ?, provider_step_id = ?,
           provider_call_id = ?, tool_ordinal = ?, tool_name = ?, normalized_arguments_hash = ?,
           arguments_summary_json = ?, result_summary_json = ?, result_document_id = ?,
           result_document_version_id = ?, status = ?, idempotency_key = ?, error_code = ?,
           error_message = ?, started_at = ?, completed_at = ?, version = ?, redaction_state = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        record.generationId ?? null,
        record.attemptId ?? null,
        record.authorizationId ?? null,
        record.providerStepId ?? null,
        record.providerCallId ?? null,
        record.toolOrdinal ?? null,
        record.toolName,
        record.normalizedArgumentsHash,
        record.argumentsSummaryJson,
        record.resultSummaryJson ?? null,
        record.resultDocumentId ?? null,
        record.resultDocumentVersionId ?? null,
        record.status,
        record.idempotencyKey ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.version,
        record.redactionState,
        record.id,
        expectedVersion,
      );
    return result.changes === 1;
  }
}

interface AgentToolCallRow {
  id: string;
  project_id: string;
  task_id: string;
  generation_id: string | null;
  attempt_id: string | null;
  authorization_id: string | null;
  provider_step_id: string | null;
  provider_call_id: string | null;
  tool_ordinal: number | null;
  tool_name: string;
  normalized_arguments_hash: string;
  arguments_summary_json: string;
  result_summary_json: string | null;
  result_document_id: string | null;
  result_document_version_id: string | null;
  status: AgentToolCallRecord['status'];
  idempotency_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  version: number;
  redaction_state: 'native' | 'legacy_redacted';
}

function mapAgentToolCall(row: AgentToolCallRow): AgentToolCallRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    generationId: row.generation_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    authorizationId: row.authorization_id ?? undefined,
    providerStepId: row.provider_step_id ?? undefined,
    providerCallId: row.provider_call_id ?? undefined,
    toolOrdinal: row.tool_ordinal ?? undefined,
    toolName: row.tool_name,
    normalizedArgumentsHash: row.normalized_arguments_hash,
    argumentsSummaryJson: row.arguments_summary_json,
    resultSummaryJson: row.result_summary_json ?? undefined,
    resultDocumentId: row.result_document_id ?? undefined,
    resultDocumentVersionId: row.result_document_version_id ?? undefined,
    status: row.status,
    idempotencyKey: row.idempotency_key ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    version: row.version,
    redactionState: row.redaction_state,
  };
}

class SqliteLlmProviderStepRepository
  extends ProjectScopedRepository
  implements LlmProviderStepRepository
{
  save(record: LlmProviderStepRecord): void {
    this.database
      .prepare(
        `INSERT INTO llm_provider_steps
         (id, project_id, generation_id, attempt_id, ordinal, protocol, provider_response_id, status,
          tool_call_count, finish_reason, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, total_tokens, provider_reported_cost, currency, continuation_manifest_json,
          request_hash, response_hash, started_at, completed_at, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_response_id = excluded.provider_response_id, status = excluded.status,
           tool_call_count = excluded.tool_call_count, finish_reason = excluded.finish_reason,
           input_tokens = excluded.input_tokens, cached_input_tokens = excluded.cached_input_tokens,
           output_tokens = excluded.output_tokens, reasoning_tokens = excluded.reasoning_tokens,
           total_tokens = excluded.total_tokens, provider_reported_cost = excluded.provider_reported_cost,
           currency = excluded.currency, continuation_manifest_json = excluded.continuation_manifest_json,
           response_hash = excluded.response_hash, completed_at = excluded.completed_at,
           error_code = excluded.error_code, error_message = excluded.error_message`,
      )
      .run(
        record.id,
        record.projectId,
        record.generationId,
        record.attemptId,
        record.ordinal,
        record.protocol,
        record.providerResponseId ?? null,
        record.status,
        record.toolCallCount,
        record.finishReason ?? null,
        record.inputTokens ?? null,
        record.cachedInputTokens ?? null,
        record.outputTokens ?? null,
        record.reasoningTokens ?? null,
        record.totalTokens ?? null,
        record.providerReportedCost ?? null,
        record.currency ?? null,
        record.continuationManifestJson ?? null,
        record.requestHash,
        record.responseHash ?? null,
        record.startedAt,
        record.completedAt ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
      );
  }

  get(id: string): LlmProviderStepRecord | undefined {
    const row = this.database.prepare('SELECT * FROM llm_provider_steps WHERE id = ?').get(id) as
      LlmProviderStepRow | undefined;
    return row ? mapLlmProviderStep(row) : undefined;
  }

  listByAttempt(attemptId: string): LlmProviderStepRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM llm_provider_steps WHERE attempt_id = ? ORDER BY ordinal, id')
        .all(attemptId) as LlmProviderStepRow[]
    ).map(mapLlmProviderStep);
  }
}

interface LlmProviderStepRow {
  id: string;
  project_id: string;
  generation_id: string;
  attempt_id: string;
  ordinal: number;
  protocol: string;
  provider_response_id: string | null;
  status: LlmProviderStepRecord['status'];
  tool_call_count: number;
  finish_reason: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  provider_reported_cost: string | null;
  currency: string | null;
  continuation_manifest_json: string | null;
  request_hash: string;
  response_hash: string | null;
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

function mapLlmProviderStep(row: LlmProviderStepRow): LlmProviderStepRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    ordinal: row.ordinal,
    protocol: row.protocol,
    providerResponseId: row.provider_response_id ?? undefined,
    status: row.status,
    toolCallCount: row.tool_call_count,
    finishReason: row.finish_reason ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    cachedInputTokens: row.cached_input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    reasoningTokens: row.reasoning_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    providerReportedCost: row.provider_reported_cost ?? undefined,
    currency: row.currency ?? undefined,
    continuationManifestJson: row.continuation_manifest_json ?? undefined,
    requestHash: row.request_hash,
    responseHash: row.response_hash ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

class SqliteAgentToolAuthorizationRepository
  extends ProjectScopedRepository
  implements AgentToolAuthorizationRepository
{
  save(record: AgentToolAuthorizationRecord): void {
    this.database
      .prepare(
        `INSERT INTO agent_tool_authorizations
         (id, project_id, task_id, generation_id, attempt_id, provider_step_id, project_session_id,
          allowed_operation, target_document_id, scope_type, scope_id, base_version_id,
          expected_document_row_version, policy_version, tool_schema_version,
          authorization_handle_hash, status, max_call_uses, used_call_count, expires_at, revoked_at,
          row_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, used_call_count = excluded.used_call_count, expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at, row_version = excluded.row_version`,
      )
      .run(
        record.id,
        record.projectId,
        record.taskId,
        record.generationId,
        record.attemptId,
        record.providerStepId,
        record.projectSessionId,
        record.allowedOperation,
        record.targetDocumentId ?? null,
        record.scopeType ?? null,
        record.scopeId ?? null,
        record.baseVersionId ?? null,
        record.expectedDocumentRowVersion ?? null,
        record.policyVersion,
        record.toolSchemaVersion,
        record.authorizationHandleHash,
        record.status,
        record.maxCallUses,
        record.usedCallCount,
        record.expiresAt,
        record.revokedAt ?? null,
        record.rowVersion,
        record.createdAt,
      );
  }

  get(id: string): AgentToolAuthorizationRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM agent_tool_authorizations WHERE id = ?')
      .get(id) as AgentToolAuthorizationRow | undefined;
    return row ? mapAgentToolAuthorization(row) : undefined;
  }

  listByProviderStep(providerStepId: string): AgentToolAuthorizationRecord[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM agent_tool_authorizations WHERE provider_step_id = ? ORDER BY created_at, id',
        )
        .all(providerStepId) as AgentToolAuthorizationRow[]
    ).map(mapAgentToolAuthorization);
  }

  update(record: AgentToolAuthorizationRecord, expectedRowVersion: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE agent_tool_authorizations
       SET status = ?, used_call_count = ?, expires_at = ?, revoked_at = ?, row_version = ?
       WHERE id = ? AND row_version = ?`,
      )
      .run(
        record.status,
        record.usedCallCount,
        record.expiresAt,
        record.revokedAt ?? null,
        record.rowVersion,
        record.id,
        expectedRowVersion,
      );
    return result.changes === 1;
  }
}

interface AgentToolAuthorizationRow {
  id: string;
  project_id: string;
  task_id: string;
  generation_id: string;
  attempt_id: string;
  provider_step_id: string;
  project_session_id: string;
  allowed_operation: string;
  target_document_id: string | null;
  scope_type: string | null;
  scope_id: string | null;
  base_version_id: string | null;
  expected_document_row_version: number | null;
  policy_version: string;
  tool_schema_version: string;
  authorization_handle_hash: string;
  status: AgentToolAuthorizationRecord['status'];
  max_call_uses: number;
  used_call_count: number;
  expires_at: string;
  revoked_at: string | null;
  row_version: number;
  created_at: string;
}

function mapAgentToolAuthorization(row: AgentToolAuthorizationRow): AgentToolAuthorizationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    providerStepId: row.provider_step_id,
    projectSessionId: row.project_session_id,
    allowedOperation: row.allowed_operation,
    targetDocumentId: row.target_document_id ?? undefined,
    scopeType: row.scope_type ?? undefined,
    scopeId: row.scope_id ?? undefined,
    baseVersionId: row.base_version_id ?? undefined,
    expectedDocumentRowVersion: row.expected_document_row_version ?? undefined,
    policyVersion: row.policy_version,
    toolSchemaVersion: row.tool_schema_version,
    authorizationHandleHash: row.authorization_handle_hash,
    status: row.status,
    maxCallUses: row.max_call_uses,
    usedCallCount: row.used_call_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    rowVersion: row.row_version,
    createdAt: row.created_at,
  };
}

interface LlmGenerationAttemptRow {
  id: string;
  generation_id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  context_snapshot_id: string;
  provider_profile_id: string | null;
  provider_name_snapshot: string;
  model_id: string | null;
  model_name_snapshot: string;
  protocol: string;
  status: LlmGenerationAttemptRecord['status'];
  started_at: string;
  first_token_at: string | null;
  completed_at: string | null;
  provider_response_id: string | null;
  finish_reason: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  raw_usage_json: string | null;
  pricing_snapshot_json: string | null;
  estimated_cost: string | null;
  currency: string | null;
  error_code: string | null;
  error_message: string | null;
}

function mapLlmGenerationAttempt(row: LlmGenerationAttemptRow): LlmGenerationAttemptRecord {
  return {
    id: row.id,
    generationId: row.generation_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    contextSnapshotId: row.context_snapshot_id,
    providerProfileId: row.provider_profile_id ?? undefined,
    providerNameSnapshot: row.provider_name_snapshot,
    modelId: row.model_id ?? undefined,
    modelNameSnapshot: row.model_name_snapshot,
    protocol: row.protocol,
    status: row.status,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    providerResponseId: row.provider_response_id ?? undefined,
    finishReason: row.finish_reason ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    cachedInputTokens: row.cached_input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    reasoningTokens: row.reasoning_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    rawUsageJson: row.raw_usage_json ?? undefined,
    pricingSnapshotJson: row.pricing_snapshot_json ?? undefined,
    estimatedCost: row.estimated_cost ?? undefined,
    currency: row.currency ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

class SqliteContextSnapshotRepository
  extends ProjectScopedRepository
  implements ContextSnapshotRepository
{
  save(record: ContextSnapshotRecord): void {
    this.database
      .prepare(
        `INSERT INTO context_snapshots (id, project_id, purpose, content_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.projectId, record.purpose, record.contentJson, record.createdAt);
  }

  get(id: string): ContextSnapshotRecord | undefined {
    const row = this.database.prepare('SELECT * FROM context_snapshots WHERE id = ?').get(id) as
      ContextSnapshotRow | undefined;
    return row ? mapContextSnapshot(row) : undefined;
  }

  listByProject(projectId: string, limit: number): ContextSnapshotRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM context_snapshots
           WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, limit) as ContextSnapshotRow[]
    ).map(mapContextSnapshot);
  }
}

interface ContextSnapshotRow {
  id: string;
  project_id: string;
  purpose: string;
  content_json: string;
  created_at: string;
}

function mapContextSnapshot(row: ContextSnapshotRow): ContextSnapshotRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    purpose: row.purpose,
    contentJson: row.content_json,
    createdAt: row.created_at,
  };
}

class ScopedContentRepository<T extends MemoryRecord> extends ProjectScopedRepository {
  constructor(
    database: Database.Database,
    private readonly table: 'memories' | 'constraints',
  ) {
    super(database);
  }

  save(record: T): void {
    if (this.table === 'constraints') {
      const constraint = record as unknown as ConstraintRecord;
      this.database
        .prepare(
          `INSERT INTO constraints
           (id, project_id, scope_type, scope_id, kind, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             scope_type = excluded.scope_type, scope_id = excluded.scope_id,
             kind = excluded.kind, content = excluded.content, updated_at = excluded.updated_at`,
        )
        .run(
          constraint.id,
          constraint.projectId,
          constraint.scopeType,
          constraint.scopeId ?? null,
          constraint.kind,
          constraint.content,
          constraint.createdAt,
          constraint.updatedAt,
        );
      return;
    }
    this.database
      .prepare(
        `INSERT INTO memories
         (id, project_id, scope_type, scope_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scope_type = excluded.scope_type, scope_id = excluded.scope_id,
           content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.scopeType,
        record.scopeId ?? null,
        record.content,
        record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): T | undefined {
    const row = this.database.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as
      ScopedContentRow | undefined;
    return row ? this.map(row) : undefined;
  }

  listByProject(projectId: string): T[] {
    return (
      this.database
        .prepare(`SELECT * FROM ${this.table} WHERE project_id = ? ORDER BY created_at, id`)
        .all(projectId) as ScopedContentRow[]
    ).map((row) => this.map(row));
  }

  private map(row: ScopedContentRow): T {
    const base: MemoryRecord = {
      id: row.id,
      projectId: row.project_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id ?? undefined,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return (this.table === 'constraints' ? { ...base, kind: row.kind ?? '' } : base) as T;
  }
}

interface ScopedContentRow {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string | null;
  kind?: string;
  content: string;
  created_at: string;
  updated_at: string;
}

class SqliteAssetRepository extends ProjectScopedRepository implements AssetRepository {
  save(record: AssetRecord): void {
    this.database
      .prepare(
        `INSERT INTO assets
         (id, project_id, kind, relative_path, content_hash, size_bytes, source_url, alias,
          created_at, updated_at, deleted_at, trash_relative_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, relative_path = excluded.relative_path,
           content_hash = excluded.content_hash, size_bytes = excluded.size_bytes,
           source_url = excluded.source_url, alias = excluded.alias,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
           trash_relative_path = excluded.trash_relative_path`,
      )
      .run(
        record.id,
        record.projectId,
        record.kind,
        record.relativePath,
        record.contentHash,
        record.sizeBytes,
        record.sourceUrl ?? null,
        record.alias ?? '',
        record.createdAt,
        record.updatedAt ?? record.createdAt,
        record.deletedAt ?? null,
        record.trashRelativePath ?? null,
      );
  }

  get(id: string): AssetRecord | undefined {
    const row = this.database.prepare('SELECT * FROM assets WHERE id = ?').get(id) as
      AssetRow | undefined;
    return row ? mapAsset(row) : undefined;
  }

  listByProject(projectId: string): AssetRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at')
        .all(projectId) as AssetRow[]
    ).map(mapAsset);
  }

  queryByProject(
    projectId: string,
    params: {
      keyword?: string;
      kind?: string;
      deleted?: 'active' | 'trash';
      createdFrom?: string;
      createdTo?: string;
      limit?: number;
      tagIds?: string[];
      sort?: 'created-asc' | 'created-desc';
      cursor?: string;
    },
  ): AssetRecord[] {
    const where = [
      'project_id = ?',
      params.deleted === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    const values: Array<string | number> = [projectId];
    if (params.kind === 'image') {
      where.push("kind NOT LIKE '%video%'");
    } else if (params.kind === 'video') {
      where.push("kind LIKE '%video%'");
    } else if (params.kind) {
      where.push('kind = ?');
      values.push(params.kind);
    }
    if (params.keyword?.trim()) {
      where.push(
        `(alias LIKE ? COLLATE NOCASE OR relative_path LIKE ? COLLATE NOCASE OR id IN (
          SELECT assignment.asset_id
          FROM asset_tag_assignments assignment
          JOIN tags tag ON tag.id = assignment.tag_id
          WHERE tag.project_id = ? AND tag.name LIKE ? COLLATE NOCASE
        ))`,
      );
      const q = `%${params.keyword.trim()}%`;
      values.push(q, q, projectId, q);
    }
    if (params.createdFrom) {
      where.push('created_at >= ?');
      values.push(params.createdFrom);
    }
    if (params.createdTo) {
      where.push('created_at <= ?');
      values.push(params.createdTo);
    }
    if (params.tagIds?.length) {
      const placeholders = params.tagIds.map(() => '?').join(',');
      where.push(
        `id IN (SELECT asset_id FROM asset_tag_assignments WHERE tag_id IN (${placeholders}) GROUP BY asset_id HAVING COUNT(DISTINCT tag_id) = ?)`,
      );
      values.push(...params.tagIds, params.tagIds.length);
    }
    if (params.cursor) {
      const separator = params.cursor.indexOf('|');
      if (separator <= 0) throw new Error('Asset cursor is invalid.');
      const createdAt = params.cursor.slice(0, separator);
      const id = params.cursor.slice(separator + 1);
      const operator = params.sort === 'created-desc' ? '<' : '>';
      where.push(`(created_at ${operator} ? OR (created_at = ? AND id ${operator} ?))`);
      values.push(createdAt, createdAt, id);
    }
    const limit = Math.min(Math.max(params.limit ?? 60, 1), 200);
    values.push(limit);
    const direction = params.sort === 'created-desc' ? 'DESC' : 'ASC';
    return (
      this.database
        .prepare(
          `SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at ${direction}, id ${direction} LIMIT ?`,
        )
        .all(...values) as AssetRow[]
    ).map(mapAsset);
  }

  delete(id: string): void {
    this.database.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  listTags(projectId: string): AssetTagRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM tags WHERE project_id = ? ORDER BY name, id')
        .all(projectId) as AssetTagRow[]
    ).map(mapAssetTag);
  }
  getTag(id: string): AssetTagRecord | undefined {
    const row = this.database.prepare('SELECT * FROM tags WHERE id = ?').get(id) as
      AssetTagRow | undefined;
    return row ? mapAssetTag(row) : undefined;
  }
  saveTag(record: AssetTagRecord): void {
    this.database
      .prepare(
        `INSERT INTO tags (id, project_id, name, normalized_name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, normalized_name=excluded.normalized_name, updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.name,
        record.normalizedName,
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      );
  }
  deleteTag(id: string): void {
    this.database.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }
  listTagIds(assetId: string): string[] {
    return (
      this.database
        .prepare(
          'SELECT tag_id AS id FROM asset_tag_assignments WHERE asset_id = ? ORDER BY tag_id',
        )
        .all(assetId) as Array<{ id: string }>
    ).map((row) => row.id);
  }
  replaceTags(assetId: string, tagIds: string[], createdAt: string): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM asset_tag_assignments WHERE asset_id = ?').run(assetId);
      const insert = this.database.prepare(
        'INSERT INTO asset_tag_assignments (asset_id, tag_id, created_at) VALUES (?, ?, ?)',
      );
      for (const tagId of [...new Set(tagIds)]) insert.run(assetId, tagId, createdAt);
    })();
  }
  countDraftReferences(assetId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(DISTINCT generation_drafts.id) AS count
         FROM generation_drafts, json_tree(generation_drafts.parameters_json)
         WHERE json_tree.type = 'text' AND json_tree.value = ?`,
      )
      .get(assetId) as { count: number };
    return row.count;
  }
  listGroups(projectId: string): AssetGroupRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM asset_groups WHERE project_id = ? ORDER BY name, id')
        .all(projectId) as AssetGroupRow[]
    ).map((row) => mapAssetGroup(this.database, row));
  }
  getGroup(id: string): AssetGroupRecord | undefined {
    const row = this.database.prepare('SELECT * FROM asset_groups WHERE id = ?').get(id) as
      AssetGroupRow | undefined;
    return row ? mapAssetGroup(this.database, row) : undefined;
  }
  saveGroup(record: AssetGroupRecord): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO asset_groups (id, project_id, name, normalized_name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, normalized_name=excluded.normalized_name, updated_at=excluded.updated_at`,
        )
        .run(
          record.id,
          record.projectId,
          record.name,
          record.normalizedName,
          record.createdBy,
          record.createdAt,
          record.updatedAt,
        );
      this.database.prepare('DELETE FROM asset_group_tags WHERE group_id = ?').run(record.id);
      const insert = this.database.prepare(
        'INSERT INTO asset_group_tags (group_id, tag_id) VALUES (?, ?)',
      );
      for (const tagId of [...new Set(record.tagIds)]) insert.run(record.id, tagId);
    })();
  }
  deleteGroup(id: string): void {
    this.database.prepare('DELETE FROM asset_groups WHERE id = ?').run(id);
  }
  resolveGroup(groupId: string): AssetRecord[] {
    const group = this.getGroup(groupId);
    if (!group || !group.tagIds.length) return [];
    return this.queryByProject(group.projectId, {
      tagIds: group.tagIds,
      deleted: 'active',
      limit: 200,
    });
  }
}

interface AssetTagRow {
  id: string;
  project_id: string;
  name: string;
  normalized_name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
function mapAssetTag(row: AssetTagRow): AssetTagRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    normalizedName: row.normalized_name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
interface AssetGroupRow {
  id: string;
  project_id: string;
  name: string;
  normalized_name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
function mapAssetGroup(database: Database.Database, row: AssetGroupRow): AssetGroupRecord {
  const tagIds = (
    database
      .prepare('SELECT tag_id AS id FROM asset_group_tags WHERE group_id = ? ORDER BY tag_id')
      .all(row.id) as Array<{ id: string }>
  ).map((x) => x.id);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    normalizedName: row.normalized_name,
    tagIds,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface AssetRow {
  id: string;
  project_id: string;
  kind: string;
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  source_url: string | null;
  alias: string;
  updated_at: string | null;
  deleted_at: string | null;
  trash_relative_path: string | null;
  created_at: string;
}

function mapAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    sourceUrl: row.source_url ?? undefined,
    alias: row.alias,
    updatedAt: row.updated_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    trashRelativePath: row.trash_relative_path ?? undefined,
    createdAt: row.created_at,
  };
}

class SqliteGenerationDraftRepository
  extends ProjectScopedRepository
  implements GenerationDraftRepository
{
  save(record: GenerationDraftRecord): void {
    this.database
      .prepare(
        `INSERT INTO generation_drafts
         (id, shot_id, adapter_key, parameters_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(shot_id, adapter_key) DO UPDATE SET
           parameters_json = excluded.parameters_json,
           updated_at = excluded.updated_at`,
      )
      .run(record.id, record.shotId, record.adapterKey, record.parametersJson, record.updatedAt);
  }

  get(shotId: string, adapterKey: string): GenerationDraftRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM generation_drafts WHERE shot_id = ? AND adapter_key = ?')
      .get(shotId, adapterKey) as GenerationDraftRow | undefined;
    return row ? mapGenerationDraft(row) : undefined;
  }
}

interface GenerationDraftRow {
  id: string;
  shot_id: string;
  adapter_key: string;
  parameters_json: string;
  updated_at: string;
}

function mapGenerationDraft(row: GenerationDraftRow): GenerationDraftRecord {
  return {
    id: row.id,
    shotId: row.shot_id,
    adapterKey: row.adapter_key,
    parametersJson: row.parameters_json,
    updatedAt: row.updated_at,
  };
}

class SqliteJobRepository extends ProjectScopedRepository implements JobRepository {
  save(record: JobRecord): void {
    this.database
      .prepare(
        `INSERT INTO generation_jobs
         (id, project_id, shot_id, adapter_key, provider_task_id, status,
          request_json, error_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_task_id = excluded.provider_task_id, status = excluded.status,
           error_json = excluded.error_json, metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.shotId ?? null,
        record.adapterKey,
        record.providerTaskId ?? null,
        record.status,
        record.requestJson,
        record.errorJson ?? null,
        record.metadataJson ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): JobRecord | undefined {
    const row = this.database.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as
      JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  listByProject(projectId: string): JobRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at')
        .all(projectId) as JobRow[]
    ).map(mapJob);
  }
}

class SqliteGenerationResultRepository
  extends ProjectScopedRepository
  implements GenerationResultRepository
{
  save(record: GenerationResultRecord): void {
    this.database
      .prepare(
        `INSERT INTO generation_results (id, job_id, asset_id, provider_url, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET asset_id = excluded.asset_id,
           provider_url = excluded.provider_url`,
      )
      .run(
        record.id,
        record.jobId,
        record.assetId ?? null,
        record.providerUrl ?? null,
        record.createdAt,
      );
  }

  listByJob(jobId: string): GenerationResultRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM generation_results WHERE job_id = ? ORDER BY created_at, id')
        .all(jobId) as GenerationResultRow[]
    ).map(mapGenerationResult);
  }

  findJobIdByAsset(assetId: string): string | undefined {
    const row = this.database
      .prepare(
        'SELECT job_id AS id FROM generation_results WHERE asset_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(assetId) as { id: string } | undefined;
    return row?.id;
  }
}

interface GenerationResultRow {
  id: string;
  job_id: string;
  asset_id: string | null;
  provider_url: string | null;
  created_at: string;
}

function mapGenerationResult(row: GenerationResultRow): GenerationResultRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    assetId: row.asset_id ?? undefined,
    providerUrl: row.provider_url ?? undefined,
    createdAt: row.created_at,
  };
}

interface JobRow {
  id: string;
  project_id: string;
  shot_id: string | null;
  adapter_key: string;
  provider_task_id: string | null;
  status: string;
  request_json: string;
  error_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    shotId: row.shot_id ?? undefined,
    adapterKey: row.adapter_key,
    providerTaskId: row.provider_task_id ?? undefined,
    status: row.status,
    requestJson: row.request_json,
    errorJson: row.error_json ?? undefined,
    metadataJson: row.metadata_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRepositories(database: Database.Database): {
  projects: ProjectRepository;
  documents: DocumentRepository;
  documentWorkflowAudits: DocumentWorkflowAuditRepository;
  documentReviews: DocumentReviewRepository;
  documentPublications: DocumentPublicationRepository;
  scenes: SceneRepository;
  shots: ShotRepository;
  conversations: ConversationRepository;
  chatMessages: ChatMessageRepository;
  llmGenerations: LlmGenerationRepository;
  llmGenerationAttempts: LlmGenerationAttemptRepository;
  llmProviderSteps: LlmProviderStepRepository;
  agentTasks: AgentTaskRepository;
  agentTaskEvents: AgentTaskEventRepository;
  agentTaskGenerations: AgentTaskGenerationRepository;
  agentToolCalls: AgentToolCallRepository;
  agentToolAuthorizations: AgentToolAuthorizationRepository;
  agentTaskDocumentVersions: AgentTaskDocumentVersionRepository;
  contextSnapshots: ContextSnapshotRepository;
  memories: MemoryRepository;
  constraints: ConstraintRepository;
  assets: AssetRepository;
  generationDrafts: GenerationDraftRepository;
  jobs: JobRepository;
  generationResults: GenerationResultRepository;
} {
  return {
    projects: new SqliteProjectRepository(database),
    documents: new SqliteDocumentRepository(database),
    documentWorkflowAudits: new SqliteDocumentWorkflowAuditRepository(database),
    documentReviews: new SqliteDocumentReviewRepository(database),
    documentPublications: new SqliteDocumentPublicationRepository(database),
    scenes: new SqliteSceneRepository(database),
    shots: new SqliteShotRepository(database),
    conversations: new SqliteConversationRepository(database),
    chatMessages: new SqliteChatMessageRepository(database),
    llmGenerations: new SqliteLlmGenerationRepository(database),
    llmGenerationAttempts: new SqliteLlmGenerationAttemptRepository(database),
    llmProviderSteps: new SqliteLlmProviderStepRepository(database),
    agentTasks: new SqliteAgentTaskRepository(database),
    agentTaskEvents: new SqliteAgentTaskEventRepository(database),
    agentTaskGenerations: new SqliteAgentTaskGenerationRepository(database),
    agentToolCalls: new SqliteAgentToolCallRepository(database),
    agentToolAuthorizations: new SqliteAgentToolAuthorizationRepository(database),
    agentTaskDocumentVersions: new SqliteAgentTaskDocumentVersionRepository(database),
    contextSnapshots: new SqliteContextSnapshotRepository(database),
    memories: new ScopedContentRepository<MemoryRecord>(database, 'memories'),
    constraints: new ScopedContentRepository<ConstraintRecord>(database, 'constraints'),
    assets: new SqliteAssetRepository(database),
    generationDrafts: new SqliteGenerationDraftRepository(database),
    jobs: new SqliteJobRepository(database),
    generationResults: new SqliteGenerationResultRepository(database),
  };
}
