export type ProjectOpenMode = 'read-write' | 'read-only';

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenProject extends ProjectRecord {
  mode: ProjectOpenMode;
  schemaVersion: number;
}

export interface RecentProject {
  name: string;
  rootPath: string;
  lastOpenedAt: string;
}

export interface IntegrityReport {
  ok: boolean;
  messages: string[];
  schemaVersion: number;
}

export interface DocumentRecord {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  scopeType: string;
  scopeId?: string;
  currentVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextSnapshotRecord {
  id: string;
  projectId: string;
  purpose: string;
  contentJson: string;
  createdAt: string;
}

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  version: number;
  contentMarkdown: string;
  createdAt: string;
}

export interface SceneRecord {
  id: string;
  projectId: string;
  title: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShotRecord {
  id: string;
  sceneId: string;
  title: string;
  position: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  projectId: string;
  scopeType: string;
  scopeId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type ChatMessageStatus = 'streaming' | 'complete' | 'failed';

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  replyToMessageId?: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  scopeType: string;
  scopeId?: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConstraintRecord extends MemoryRecord {
  kind: string;
}

export interface AssetRecord {
  id: string;
  projectId: string;
  kind: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  sourceUrl?: string;
  createdAt: string;
}

export interface GenerationResultRecord {
  id: string;
  jobId: string;
  assetId?: string;
  providerUrl?: string;
  createdAt: string;
}

export interface GenerationDraftRecord {
  id: string;
  shotId: string;
  adapterKey: string;
  parametersJson: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  projectId: string;
  shotId?: string;
  adapterKey: string;
  providerTaskId?: string;
  status: string;
  requestJson: string;
  errorJson?: string;
  metadataJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRepository {
  get(): ProjectRecord;
  touch(updatedAt: string): void;
}

export interface DocumentRepository {
  save(record: DocumentRecord): void;
  get(id: string): DocumentRecord | undefined;
  listByProject(projectId: string): DocumentRecord[];
  saveVersion(record: DocumentRecord, version: DocumentVersionRecord): void;
  getVersion(id: string): DocumentVersionRecord | undefined;
  listVersions(documentId: string): DocumentVersionRecord[];
}

export interface ContextSnapshotRepository {
  save(record: ContextSnapshotRecord): void;
  get(id: string): ContextSnapshotRecord | undefined;
  listByProject(projectId: string, limit: number): ContextSnapshotRecord[];
}

export interface SceneRepository {
  save(record: SceneRecord): void;
  get(id: string): SceneRecord | undefined;
  listByProject(projectId: string): SceneRecord[];
}

export interface ShotRepository {
  save(record: ShotRecord): void;
  get(id: string): ShotRecord | undefined;
  listByScene(sceneId: string): ShotRecord[];
}

export interface ConversationRepository {
  save(record: ConversationRecord): void;
  get(id: string): ConversationRecord | undefined;
  listByProject(projectId: string): ConversationRecord[];
}

export interface ChatMessageRepository {
  save(record: ChatMessageRecord): void;
  get(id: string): ChatMessageRecord | undefined;
  listPage(conversationId: string, limit: number, before?: string): ChatMessageRecord[];
  failStreamingByProject(projectId: string, failureMessage: string): number;
}

export interface MemoryRepository {
  save(record: MemoryRecord): void;
  get(id: string): MemoryRecord | undefined;
  listByProject(projectId: string): MemoryRecord[];
}

export interface ConstraintRepository {
  save(record: ConstraintRecord): void;
  get(id: string): ConstraintRecord | undefined;
  listByProject(projectId: string): ConstraintRecord[];
}

export interface AssetRepository {
  save(record: AssetRecord): void;
  get(id: string): AssetRecord | undefined;
  listByProject(projectId: string): AssetRecord[];
  delete(id: string): void;
}

export interface GenerationDraftRepository {
  save(record: GenerationDraftRecord): void;
  get(shotId: string, adapterKey: string): GenerationDraftRecord | undefined;
}

export interface JobRepository {
  save(record: JobRecord): void;
  get(id: string): JobRecord | undefined;
  listByProject(projectId: string): JobRecord[];
}

export interface GenerationResultRepository {
  save(record: GenerationResultRecord): void;
  listByJob(jobId: string): GenerationResultRecord[];
}
