import type Database from 'better-sqlite3';
import type {
  AssetRecord,
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
  JobRecord,
  JobRepository,
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
        record.createdAt,
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
        record.createdAt,
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
         (id, project_id, kind, relative_path, content_hash, size_bytes, source_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, relative_path = excluded.relative_path,
           content_hash = excluded.content_hash, size_bytes = excluded.size_bytes,
           source_url = excluded.source_url`,
      )
      .run(
        record.id,
        record.projectId,
        record.kind,
        record.relativePath,
        record.contentHash,
        record.sizeBytes,
        record.sourceUrl ?? null,
        record.createdAt,
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
}

interface AssetRow {
  id: string;
  project_id: string;
  kind: string;
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  source_url: string | null;
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
          request_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_task_id = excluded.provider_task_id, status = excluded.status,
           error_json = excluded.error_json, updated_at = excluded.updated_at`,
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

interface JobRow {
  id: string;
  project_id: string;
  shot_id: string | null;
  adapter_key: string;
  provider_task_id: string | null;
  status: string;
  request_json: string;
  error_json: string | null;
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
  contextSnapshots: ContextSnapshotRepository;
  memories: MemoryRepository;
  constraints: ConstraintRepository;
  assets: AssetRepository;
  generationDrafts: GenerationDraftRepository;
  jobs: JobRepository;
} {
  return {
    projects: new SqliteProjectRepository(database),
    documents: new SqliteDocumentRepository(database),
    scenes: new SqliteSceneRepository(database),
    shots: new SqliteShotRepository(database),
    conversations: new SqliteConversationRepository(database),
    chatMessages: new SqliteChatMessageRepository(database),
    contextSnapshots: new SqliteContextSnapshotRepository(database),
    memories: new ScopedContentRepository<MemoryRecord>(database, 'memories'),
    constraints: new ScopedContentRepository<ConstraintRecord>(database, 'constraints'),
    assets: new SqliteAssetRepository(database),
    generationDrafts: new SqliteGenerationDraftRepository(database),
    jobs: new SqliteJobRepository(database),
  };
}
