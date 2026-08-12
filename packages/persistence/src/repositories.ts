import type Database from 'better-sqlite3';
import type {
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
  DocumentRepository,
  DocumentVersionRecord,
  GenerationDraftRecord,
  GenerationDraftRepository,
  GenerationResultRecord,
  GenerationResultRepository,
  JobRecord,
  JobRepository,
  LlmGenerationAttemptRecord,
  LlmGenerationAttemptRepository,
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
          current_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title,
           scope_type = excluded.scope_type, scope_id = excluded.scope_id,
           current_version_id = excluded.current_version_id, updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.kind,
        record.title,
        record.scopeType,
        record.scopeId ?? null,
        record.currentVersionId ?? null,
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
        .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY created_at')
        .all(projectId) as DocumentRow[]
    ).map(mapDocument);
  }

  saveVersion(record: DocumentRecord, version: DocumentVersionRecord): void {
    this.database.transaction(() => {
      this.save(record);
      this.database
        .prepare(
          `INSERT INTO document_versions
           (id, document_id, version, content_markdown, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          version.id,
          version.documentId,
          version.version,
          version.contentMarkdown,
          version.createdAt,
        );
      this.database
        .prepare('UPDATE documents SET current_version_id = ?, updated_at = ? WHERE id = ?')
        .run(version.id, record.updatedAt, record.id);
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
}

interface DocumentRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  scope_type: string;
  scope_id: string | null;
  current_version_id: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DocumentVersionRow {
  id: string;
  document_id: string;
  version: number;
  content_markdown: string;
  created_at: string;
}

function mapDocumentVersion(row: DocumentVersionRow): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
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
        .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at')
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
        .prepare(`SELECT * FROM ${this.table} WHERE project_id = ? ORDER BY created_at`)
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
  scenes: SceneRepository;
  shots: ShotRepository;
  conversations: ConversationRepository;
  chatMessages: ChatMessageRepository;
  llmGenerationAttempts: LlmGenerationAttemptRepository;
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
    scenes: new SqliteSceneRepository(database),
    shots: new SqliteShotRepository(database),
    conversations: new SqliteConversationRepository(database),
    chatMessages: new SqliteChatMessageRepository(database),
    llmGenerationAttempts: new SqliteLlmGenerationAttemptRepository(database),
    contextSnapshots: new SqliteContextSnapshotRepository(database),
    memories: new ScopedContentRepository<MemoryRecord>(database, 'memories'),
    constraints: new ScopedContentRepository<ConstraintRecord>(database, 'constraints'),
    assets: new SqliteAssetRepository(database),
    generationDrafts: new SqliteGenerationDraftRepository(database),
    jobs: new SqliteJobRepository(database),
    generationResults: new SqliteGenerationResultRepository(database),
  };
}
