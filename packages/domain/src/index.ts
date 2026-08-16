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
  publishedVersionId?: string;
  lifecycleStatus?: 'active' | 'archived';
  rowVersion?: number;
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
  state?:
    | 'draft'
    | 'in_review'
    | 'published'
    | 'changes_requested'
    | 'rejected'
    | 'superseded'
    | 'discarded';
  baseVersionId?: string;
  titleSnapshot?: string;
  scopeTypeSnapshot?: string;
  scopeIdSnapshot?: string;
  authorType?: 'user' | 'agent' | 'import' | 'migration';
  authorId?: string;
  sourceTaskId?: string;
  sourceMessageId?: string;
  contextSnapshotId?: string;
  contentHash?: string;
  stateUpdatedAt?: string;
  stateVersion?: number;
  createdAt: string;
}

export type AgentTaskType =
  | 'document-create'
  | 'document-update'
  | 'document-query'
  | 'document-archive'
  | 'document-restore';
export type AgentTaskStatus =
  'queued' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'cancelled';
export type AgentTaskOutcome =
  'published' | 'rejected' | 'discarded' | 'read-only' | 'archived' | 'restored';
export type AgentTaskPhase =
  | 'queued'
  | 'intent_resolving'
  | 'context_compiling'
  | 'model_running'
  | 'tool_validating'
  | 'waiting_confirmation'
  | 'artifact_persisting'
  | 'waiting_review'
  | 'recovering';

export interface AgentTaskRecord {
  id: string;
  projectId: string;
  projectSessionId: string;
  conversationId?: string;
  userMessageId?: string;
  taskType: AgentTaskType;
  scopeType: string;
  scopeId?: string;
  title: string;
  requestSnapshotJson: string;
  requestHash: string;
  contextSnapshotId?: string;
  status: AgentTaskStatus;
  outcome?: AgentTaskOutcome;
  retryOfTaskId?: string;
  idempotencyKey?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  phase: AgentTaskPhase;
  rowVersion: number;
  toolCallLimit: number;
  toolCallCount: number;
  lifecycleStatus: 'active' | 'archived';
  archivedAt?: string;
}

export type AgentTaskEventLevel = 'info' | 'warning' | 'error';

export interface AgentTaskEventRecord {
  id: string;
  taskId: string;
  projectId: string;
  sequence: number;
  eventType: string;
  level: AgentTaskEventLevel;
  actorType?: string;
  actorId?: string;
  summary: string;
  payloadJson?: string;
  dedupeKey?: string;
  createdAt: string;
}

export interface AgentTaskGenerationRecord {
  taskId: string;
  generationId: string;
  ordinal: number;
  purpose: string;
  createdAt: string;
}

export type AgentToolCallStatus =
  | 'received'
  | 'validated'
  | 'awaiting_confirmation'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentToolCallRecord {
  id: string;
  taskId: string;
  projectId: string;
  generationId?: string;
  attemptId?: string;
  providerCallId?: string;
  toolName: string;
  providerStepId?: string;
  authorizationId?: string;
  toolOrdinal?: number;
  normalizedArgumentsHash: string;
  argumentsSummaryJson: string;
  resultSummaryJson?: string;
  resultDocumentId?: string;
  resultDocumentVersionId?: string;
  status: AgentToolCallStatus;
  idempotencyKey?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  version: number;
  redactionState: 'native' | 'legacy_redacted';
}

export type LlmProviderStepStatus =
  'prepared' | 'in_flight' | 'complete' | 'failed' | 'interrupted';

export interface LlmProviderStepRecord {
  id: string;
  projectId: string;
  generationId: string;
  attemptId: string;
  ordinal: number;
  protocol: string;
  providerResponseId?: string;
  status: LlmProviderStepStatus;
  toolCallCount: number;
  finishReason?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  providerReportedCost?: string;
  currency?: string;
  continuationManifestJson?: string;
  requestHash: string;
  responseHash?: string;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type AgentToolAuthorizationStatus = 'issued' | 'revoked' | 'expired';

export interface AgentToolAuthorizationRecord {
  id: string;
  projectId: string;
  taskId: string;
  generationId: string;
  attemptId: string;
  providerStepId: string;
  projectSessionId: string;
  allowedOperation: string;
  targetDocumentId?: string;
  scopeType?: string;
  scopeId?: string;
  baseVersionId?: string;
  expectedDocumentRowVersion?: number;
  policyVersion: string;
  toolSchemaVersion: string;
  authorizationHandleHash: string;
  status: AgentToolAuthorizationStatus;
  maxCallUses: number;
  usedCallCount: number;
  expiresAt: string;
  revokedAt?: string;
  rowVersion: number;
  createdAt: string;
}

export type AgentTaskConfirmationStatus = 'pending' | 'rejected' | 'expired' | 'consumed';

export interface AgentTaskConfirmationRecord {
  id: string;
  projectId: string;
  taskId: string;
  generationId: string;
  attemptId: string;
  originalToolCallId: string;
  action: string;
  targetDocumentId?: string;
  targetVersionId?: string;
  expectedDocumentRowVersion?: number;
  normalizedArgumentsHash: string;
  continuationDescriptorJson: string;
  tokenHash: string;
  continuationAuthorizationId?: string;
  status: AgentTaskConfirmationStatus;
  expiresAt: string;
  approvedByType?: string;
  approvedById?: string;
  approvedAt?: string;
  consumedAt?: string;
  createdAt: string;
}

export interface AgentTaskDocumentArtifactRecord {
  id: string;
  projectId: string;
  taskId: string;
  documentId: string;
  documentVersionId: string;
  artifactRole: 'primary';
  disposition: 'draft' | 'published' | 'rejected' | 'discarded';
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type DocumentReviewStatus =
  'pending' | 'approved' | 'changes_requested' | 'rejected' | 'withdrawn';

export interface DocumentReviewRecord {
  id: string;
  projectId: string;
  documentId: string;
  documentVersionId: string;
  taskId?: string;
  status: DocumentReviewStatus;
  requestedByType: string;
  requestedById?: string;
  requestedAt: string;
  decidedByType?: string;
  decidedById?: string;
  decidedAt?: string;
  comment?: string;
  version: number;
}

export interface DocumentPublicationRecord {
  id: string;
  projectId: string;
  documentId: string;
  documentVersionId: string;
  previousVersionId?: string;
  publicationNo: number;
  reviewId?: string;
  taskId?: string;
  publishedByType: string;
  publishedById?: string;
  publishedAt: string;
}

export interface AgentTaskDocumentVersionRecord {
  taskId: string;
  documentId: string;
  documentVersionId: string;
  operation: 'create' | 'update' | 'regenerate';
  createdAt: string;
}

/** Immutable, project-scoped history for document workflow state changes. */
export type DocumentWorkflowAuditAction =
  | 'draft_saved'
  | 'draft_restored'
  | 'review_submitted'
  | 'review_changes_requested'
  | 'review_rejected'
  | 'published';

export type DocumentWorkflowAuditActorType = 'user' | 'agent' | 'system' | 'import' | 'migration';

export interface DocumentWorkflowAuditRecord {
  id: string;
  projectId: string;
  sequence: number;
  action: DocumentWorkflowAuditAction;
  actorType: DocumentWorkflowAuditActorType;
  actorId?: string;
  documentId: string;
  documentVersionId: string;
  sourceVersionId?: string;
  reviewId?: string;
  publicationId?: string;
  taskId?: string;
  metadataJson?: string;
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
  archivedAt?: string;
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

export type LlmExecutionMode = 'legacy' | 'native';

export interface LlmGenerationRecord {
  id: string;
  projectId: string;
  projectSessionId: string;
  conversationId: string;
  contextSnapshotId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: Exclude<LlmAttemptStatus, 'interrupted'>;
  executionMode: LlmExecutionMode;
  retryOfGenerationId?: string;
  idempotencyKey?: string;
  providerProfileId?: string;
  modelId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

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
  updatePublishedVersion(
    documentId: string,
    publishedVersionId: string,
    expectedRowVersion: number,
    updatedAt: string,
  ): boolean;
  updateVersionState(
    versionId: string,
    state: NonNullable<DocumentVersionRecord['state']>,
    expectedStateVersion: number,
    stateUpdatedAt: string,
  ): boolean;
}

export interface AgentTaskRepository {
  save(record: AgentTaskRecord): void;
  get(id: string): AgentTaskRecord | undefined;
  getByIdempotencyKey(projectId: string, idempotencyKey: string): AgentTaskRecord | undefined;
  listByProject(projectId: string): AgentTaskRecord[];
  update(record: AgentTaskRecord, expectedVersion: number): boolean;
}

export interface AgentTaskEventRepository {
  append(record: AgentTaskEventRecord): void;
  listByTask(taskId: string): AgentTaskEventRecord[];
}

export interface AgentTaskGenerationRepository {
  link(record: AgentTaskGenerationRecord): void;
  listByTask(taskId: string): AgentTaskGenerationRecord[];
}

export interface AgentToolCallRepository {
  save(record: AgentToolCallRecord): void;
  get(id: string): AgentToolCallRecord | undefined;
  getByProviderCallId(
    taskId: string,
    attemptId: string,
    providerStepId: string,
    providerCallId: string,
  ): AgentToolCallRecord | undefined;
  getByIdempotencyKey(taskId: string, idempotencyKey: string): AgentToolCallRecord | undefined;
  listByTask(taskId: string): AgentToolCallRecord[];
  update(record: AgentToolCallRecord, expectedVersion: number): boolean;
}

export interface LlmProviderStepRepository {
  save(record: LlmProviderStepRecord): void;
  get(id: string): LlmProviderStepRecord | undefined;
  listByAttempt(attemptId: string): LlmProviderStepRecord[];
}

export interface AgentToolAuthorizationRepository {
  save(record: AgentToolAuthorizationRecord): void;
  get(id: string): AgentToolAuthorizationRecord | undefined;
  listByProviderStep(providerStepId: string): AgentToolAuthorizationRecord[];
  update(record: AgentToolAuthorizationRecord, expectedRowVersion: number): boolean;
}

export interface AgentTaskConfirmationRepository {
  save(record: AgentTaskConfirmationRecord): void;
  get(id: string): AgentTaskConfirmationRecord | undefined;
  getPendingByTask(taskId: string): AgentTaskConfirmationRecord | undefined;
}

export interface AgentTaskDocumentArtifactRepository {
  save(record: AgentTaskDocumentArtifactRecord): void;
  getPrimary(taskId: string): AgentTaskDocumentArtifactRecord | undefined;
  update(record: AgentTaskDocumentArtifactRecord, expectedRowVersion: number): boolean;
}

export interface DocumentReviewRepository {
  save(record: DocumentReviewRecord): void;
  get(id: string): DocumentReviewRecord | undefined;
  getByVersion(documentVersionId: string): DocumentReviewRecord | undefined;
  listByDocument(documentId: string): DocumentReviewRecord[];
  update(record: DocumentReviewRecord, expectedVersion: number): boolean;
}

export interface DocumentPublicationRepository {
  append(record: DocumentPublicationRecord): void;
  get(id: string): DocumentPublicationRecord | undefined;
  listByDocument(documentId: string): DocumentPublicationRecord[];
}

export interface AgentTaskDocumentVersionRepository {
  link(record: AgentTaskDocumentVersionRecord): void;
  listByTask(taskId: string): AgentTaskDocumentVersionRecord[];
}

export interface DocumentWorkflowAuditRepository {
  append(record: DocumentWorkflowAuditRecord): void;
  listByProject(projectId: string, limit?: number): DocumentWorkflowAuditRecord[];
  listByDocument(documentId: string, limit?: number): DocumentWorkflowAuditRecord[];
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

export interface LlmGenerationRepository {
  insert(record: LlmGenerationRecord): void;
  get(id: string): LlmGenerationRecord | undefined;
  getByIdempotencyKey(projectId: string, idempotencyKey: string): LlmGenerationRecord | undefined;
  update(record: LlmGenerationRecord, expectedVersion: number): boolean;
  failActiveByProject(projectId: string, updatedAt: string, errorMessage: string): number;
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
