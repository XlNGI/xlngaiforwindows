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

export type LlmAttemptStatus =
  'prepared' | 'streaming' | 'complete' | 'failed' | 'cancelled' | 'interrupted';

export interface LlmGenerationAttemptRecord {
  id: string;
  generationId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  contextSnapshotId: string;
  providerProfileId?: string;
  providerNameSnapshot: string;
  modelId?: string;
  modelNameSnapshot: string;
  protocol: string;
  status: LlmAttemptStatus;
  startedAt: string;
  firstTokenAt?: string;
  completedAt?: string;
  providerResponseId?: string;
  finishReason?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  rawUsageJson?: string;
  pricingSnapshotJson?: string;
  estimatedCost?: string;
  currency?: string;
  errorCode?: string;
  errorMessage?: string;
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
  alias?: string;
  updatedAt?: string;
  deletedAt?: string;
  trashRelativePath?: string;
  createdAt: string;
}

export interface AssetTagRecord {
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetGroupRecord {
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  tagIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationResultRecord {
  id: string;
  jobId: string;
  assetId?: string;
  providerUrl?: string;
  createdAt: string;
}

export type ProviderCategory = 'llm' | 'image' | 'video' | 'multi';
export type ProviderAccessType = 'official' | 'custom';
export type ProviderConnectionStatus =
  | 'draft'
  | 'testing'
  | 'ready'
  | 'auth-failed'
  | 'network-failed'
  | 'protocol-failed'
  | 'sync-failed'
  | 'disabled';
export type ProviderModelSource = 'remote' | 'built-in' | 'manual';
export type ProviderDefaultRole = 'quality' | 'balanced' | 'fast' | 'vision' | 'embedding';

export interface ProviderProfileRecord {
  id: string;
  name: string;
  category: ProviderCategory;
  providerType: string;
  accessType: ProviderAccessType;
  protocol: string;
  baseUrl: string;
  enabled: boolean;
  connectionStatus: ProviderConnectionStatus;
  lastCheckedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  migrationSource?: 'vidu' | 'vidu-cn';
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ProviderModelRecord {
  id: string;
  providerProfileId: string;
  remoteModelId: string;
  displayName: string;
  capabilitiesJson: string;
  source: ProviderModelSource;
  enabled: boolean;
  lastSyncedAt?: string;
  lastSeenAt?: string;
  unavailableAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPricingRecord {
  providerProfileId: string;
  modelId: string;
  currency: string;
  unitTokens: number;
  inputPrice: string;
  cachedInputPrice?: string;
  outputPrice: string;
  creditPrice?: string;
  updatedAt: string;
}

export interface ProviderDefaultRecord {
  role: ProviderDefaultRole;
  providerProfileId: string;
  modelId: string;
  updatedAt: string;
}

export interface UsageIndexRecord {
  attemptId: string;
  projectId: string;
  projectName: string;
  providerProfileId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  status: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCost?: string;
  currency?: string;
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

export interface LlmGenerationAttemptRepository {
  save(record: LlmGenerationAttemptRecord): void;
  get(id: string): LlmGenerationAttemptRecord | undefined;
  getByAssistantMessage(assistantMessageId: string): LlmGenerationAttemptRecord | undefined;
  listByProject(projectId: string): LlmGenerationAttemptRecord[];
  failActiveByProject(projectId: string, completedAt: string, errorMessage: string): number;
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
  ): AssetRecord[];
  delete(id: string): void;
  listTags(projectId: string): AssetTagRecord[];
  getTag(id: string): AssetTagRecord | undefined;
  saveTag(record: AssetTagRecord): void;
  deleteTag(id: string): void;
  listTagIds(assetId: string): string[];
  replaceTags(assetId: string, tagIds: string[], createdAt: string): void;
  countDraftReferences(assetId: string): number;
  listGroups(projectId: string): AssetGroupRecord[];
  getGroup(id: string): AssetGroupRecord | undefined;
  saveGroup(record: AssetGroupRecord): void;
  deleteGroup(id: string): void;
  resolveGroup(groupId: string): AssetRecord[];
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
  findJobIdByAsset(assetId: string): string | undefined;
}

export interface ProviderProfileRepository {
  save(record: ProviderProfileRecord): void;
  get(id: string): ProviderProfileRecord | undefined;
  list(includeArchived?: boolean): ProviderProfileRecord[];
  getByMigrationSource(source: 'vidu' | 'vidu-cn'): ProviderProfileRecord | undefined;
  archive(id: string, archivedAt: string): void;
}

export interface ProviderModelRepository {
  save(record: ProviderModelRecord): void;
  get(id: string): ProviderModelRecord | undefined;
  getByRemoteId(providerProfileId: string, remoteModelId: string): ProviderModelRecord | undefined;
  listByProfile(providerProfileId: string): ProviderModelRecord[];
}

export interface ModelPricingRepository {
  save(record: ModelPricingRecord): void;
  get(providerProfileId: string, modelId: string): ModelPricingRecord | undefined;
  listByProfile(providerProfileId: string): ModelPricingRecord[];
}

export interface ProviderDefaultRepository {
  save(record: ProviderDefaultRecord): void;
  get(role: ProviderDefaultRole): ProviderDefaultRecord | undefined;
  list(): ProviderDefaultRecord[];
  delete(role: ProviderDefaultRole): void;
}

export interface UsageIndexRepository {
  save(record: UsageIndexRecord): void;
  get(attemptId: string): UsageIndexRecord | undefined;
  listByCreatedAt(startAt: string, endAt: string): UsageIndexRecord[];
}
