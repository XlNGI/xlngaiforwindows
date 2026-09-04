export const IPC_PROTOCOL_VERSION = 1 as const;

export interface HealthResult {
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  workerVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
}

export interface SqliteProbeParams {
  databasePath?: string;
}

export interface SqliteProbeResult {
  databasePath: string;
  sqliteVersion: string;
  journalMode: string;
  writeVerified: boolean;
}

export type ProjectOpenMode = 'read-write' | 'read-only';

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  mode: ProjectOpenMode;
  schemaVersion: number;
}

export interface RecentProjectInfo {
  name: string;
  rootPath: string;
  lastOpenedAt: string;
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

export interface ProviderProfileInfo {
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

export interface ProviderLegacyMigrationParams {
  source: 'vidu' | 'vidu-cn';
}

export interface ProviderLegacyMigrationResult {
  state: 'created' | 'existing' | 'archived';
  profile?: ProviderProfileInfo;
}

export interface ProviderProfileListParams {
  includeArchived?: boolean;
}

export interface ProviderProfileGetParams {
  profileId: string;
}

export interface ProviderProfileCreateParams {
  name: string;
  category: ProviderCategory;
  providerType: string;
  accessType: ProviderAccessType;
  protocol: string;
  baseUrl: string;
}

export interface ProviderProfileUpdateParams extends ProviderProfileCreateParams {
  profileId: string;
  enabled: boolean;
}

export interface ProviderDefinitionInfo {
  id: string;
  name: string;
  category: ProviderCategory;
  providerType: string;
  protocol: string;
  baseUrl: string;
  accessType: 'official';
}

export interface ProviderModelCapabilities {
  text: boolean;
  vision: boolean;
  streaming: boolean;
  reasoning: boolean;
  tools: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
  imageGeneration: boolean;
  /** True when the model accepts an input image through an image-edit route. */
  imageEditing?: boolean;
  videoGeneration: boolean;
}

export type ProviderModelSource = 'remote' | 'built-in' | 'manual';

export interface ProviderModelInfo {
  id: string;
  providerProfileId: string;
  remoteModelId: string;
  displayName: string;
  capabilities: ProviderModelCapabilities;
  source: ProviderModelSource;
  enabled: boolean;
  lastSyncedAt?: string;
  lastSeenAt?: string;
  unavailableAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type UnifiedAgentSchemaSource = 'official-adapter' | 'manual' | 'synced-catalog' | 'missing';
export type UnifiedAgentSchemaStatus = 'confirmed' | 'needs_confirmation' | 'missing';

export interface UnifiedAgentModelCatalogListParams {
  capability?: UnifiedAgentCapability;
  providerProfileId?: string;
  includeUnavailable?: boolean;
}

export interface UnifiedAgentModelSchemaInfo {
  providerProfileId: string;
  providerName: string;
  providerType: string;
  modelId: string;
  remoteModelId: string;
  modelName: string;
  modelCapabilities: ProviderModelCapabilities;
  modelSource: ProviderModelSource;
  modelEnabled: boolean;
  modelUnavailableAt?: string;
  schemaStatus: UnifiedAgentSchemaStatus;
  schemaSource: UnifiedAgentSchemaSource;
  adapters: AdapterDescriptor[];
  missingRequired: string[];
  updatedAt: string;
}

export interface UnifiedAgentModelCatalogListResult {
  models: UnifiedAgentModelSchemaInfo[];
  generatedAt: string;
}

export interface UnifiedAgentModelCatalogGetParams {
  providerProfileId: string;
  modelId: string;
  capability?: UnifiedAgentCapability;
}

export type UnifiedAgentModelCatalogGetResult = UnifiedAgentModelSchemaInfo;

export interface UnifiedAgentAdapterSchemaGetParams {
  adapterKey: string;
}

export interface UnifiedAgentAdapterSchemaProposeParams {
  adapterKey: string;
  descriptor: AdapterDescriptor;
  reason?: string;
  conversationId?: string;
  actorType?: 'user' | 'agent' | 'system';
}

export interface UnifiedAgentAdapterSchemaProposeResult {
  status: 'proposed';
  adapterKey: string;
  version: number;
  requiresConfirmation: boolean;
  diff: string[];
}

export interface UnifiedAgentAdapterSchemaConfirmParams {
  adapterKey: string;
  version: number;
  reason?: string;
  conversationId?: string;
  actorType?: 'user' | 'agent' | 'system';
}

export interface UnifiedAgentAdapterSchemaConfirmResult {
  status: 'confirmed';
  adapterKey: string;
  version: number;
  descriptor: AdapterDescriptor;
}

export interface UnifiedAgentAdapterSchemaRollbackParams {
  adapterKey: string;
  version: number;
  reason?: string;
  conversationId?: string;
  actorType?: 'user' | 'agent' | 'system';
}

export interface UnifiedAgentAdapterSchemaRollbackResult {
  status: 'rolled_back';
  adapterKey: string;
  version: number;
  rolledBackToVersion: number;
  descriptor: AdapterDescriptor;
}

export interface UnifiedAgentAdapterSchemaAuditListParams {
  adapterKey: string;
  limit?: number;
}

export type UnifiedAgentAdapterSchemaAuditListResult = UnifiedAgentAdapterSchemaAuditInfo[];

export interface UnifiedAgentAdapterSchemaAuditInfo {
  id: string;
  adapterKey: string;
  version: number;
  action: 'proposed' | 'confirmed' | 'rolled_back';
  actorType: 'user' | 'agent' | 'system';
  conversationId?: string;
  reason?: string;
  createdAt: string;
}

export interface ModelPricingInfo {
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

export interface ModelPricingUpdateParams {
  providerProfileId: string;
  modelId: string;
  currency: string;
  inputPrice?: string;
  cachedInputPrice?: string;
  outputPrice?: string;
  creditPrice?: string;
}

export type ProviderDefaultRole = 'quality' | 'balanced' | 'fast' | 'vision' | 'embedding';

export interface ProviderDefaultInfo {
  role: ProviderDefaultRole;
  providerProfileId: string;
  modelId: string;
  updatedAt: string;
}

export interface ProviderDefaultUpdateParams {
  role: ProviderDefaultRole;
  providerProfileId?: string;
  modelId?: string;
}

export interface ProviderRuntimeProfile {
  profileId: string;
  providerType: string;
  protocol: string;
  baseUrl: string;
}

export interface RemoteProviderModelInfo {
  id: string;
  displayName?: string;
}

export type ProviderConnectionFailureStatus =
  'auth-failed' | 'network-failed' | 'protocol-failed' | 'sync-failed';

export interface ProviderConnectionCompleteParams {
  profileId: string;
  status: 'ready' | ProviderConnectionFailureStatus;
  errorCode?: string;
  errorMessage?: string;
  models?: RemoteProviderModelInfo[];
}

export interface ProviderConnectionResult {
  profile: ProviderProfileInfo;
  models: ProviderModelInfo[];
  modelSyncStatus: 'synced' | 'unsupported' | 'failed' | 'not-attempted';
}

export interface ProviderModelCreateParams {
  profileId: string;
  remoteModelId: string;
  displayName?: string;
  capabilities: ProviderModelCapabilities;
  enabled?: boolean;
}

export interface ProviderModelUpdateParams {
  profileId: string;
  modelId: string;
  displayName: string;
  capabilities: ProviderModelCapabilities;
  enabled: boolean;
}

export interface ProjectCreateParams {
  name: string;
  rootPath: string;
}

export interface SampleProjectCreateParams {
  rootPath: string;
  name?: string;
}

export interface ProjectOpenParams {
  rootPath: string;
}

export interface ProjectIntegrityResult {
  ok: boolean;
  messages: string[];
  schemaVersion: number;
}

export interface ProjectBackupParams {
  destinationPath?: string;
}

export interface ProjectExportParams {
  destinationRoot: string;
}

export interface ProjectRestoreParams {
  backupPath: string;
  destinationRoot: string;
}

export interface PathResult {
  path: string;
}

export type NovelMarkdownExportType = 'chapter' | 'selection' | 'volume' | 'work';
export type NovelMarkdownExportFormat = 'files' | 'merged';
export type NovelMarkdownExportStatus =
  'queued' | 'writing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';

export interface NovelMarkdownExportPrepareParams {
  exportType: NovelMarkdownExportType;
  exportFormat?: NovelMarkdownExportFormat;
  chapterId?: string;
  chapterIds?: string[];
  volumeId?: string;
  includeDraft?: boolean;
}

export interface NovelMarkdownExportJobInfo {
  id: string;
  projectId: string;
  exportType: NovelMarkdownExportType;
  exportFormat: NovelMarkdownExportFormat;
  packagePath: string;
  status: NovelMarkdownExportStatus;
  itemCount: number;
  manifestHash?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CacheInspectionResult {
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  skippedLinks: number;
}

export interface CacheClearResult {
  removedFiles: number;
  removedDirectories: number;
  freedBytes: number;
  removedLinks: number;
}

export interface ResearchCacheCleanupParams {
  maxBytes?: number;
}

export interface ResearchCacheCleanupResult {
  missingCount: number;
  expiredCount: number;
  evictedCount: number;
  removedBytes: number;
  retainedBytes: number;
}

export interface ContextSnapshotCleanupParams {
  olderThanDays?: number;
}

export interface ContextSnapshotCleanupResult {
  removedCount: number;
  retainedCount: number;
}

export interface WorkerMetricByOperation {
  operation: string;
  requests: number;
  ok: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
  recentRequestIds: string[];
}

export interface WorkerGenerationMetric {
  generationId: string;
  providerName: string;
  modelId?: string;
  status: 'complete' | 'failed' | 'cancelled';
  startedAt: string;
  firstTokenAt?: string;
  completedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: string;
  retryOfGenerationId?: string;
}

export interface WorkerProviderMetric {
  providerName: string;
  attempts: number;
  complete: number;
  failed: number;
  cancelled: number;
  totalDurationMs: number;
  maxDurationMs: number;
  maxFirstTokenMs: number;
}

export interface WorkerQueueWaitMetric {
  operation: string;
  samples: number;
  totalMs: number;
  maxMs: number;
}

export interface WorkerMetricsSnapshot {
  totals: {
    requests: number;
    ok: number;
    errors: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
  generationTotals: {
    attempts: number;
    complete: number;
    failed: number;
    cancelled: number;
    totalDurationMs: number;
    maxDurationMs: number;
    maxFirstTokenMs: number;
  };
  queueWaitTotals: {
    samples: number;
    totalMs: number;
    maxMs: number;
  };
  byOperation: WorkerMetricByOperation[];
  byProvider: WorkerProviderMetric[];
  byQueueOperation: WorkerQueueWaitMetric[];
  recentRequests: Array<{
    at: string;
    requestId: string;
    operation: string;
    ok: boolean;
    durationMs: number;
  }>;
  recentGenerations: WorkerGenerationMetric[];
}

export interface DiagnosticExportParams {
  destinationRoot?: string;
}

export interface DiagnosticExportResult {
  path: string;
  createdAt: string;
  manifestVersion: 1;
  fileCount: number;
}

export interface DiagnosticRevealParams {
  path: string;
}

export type DocumentKind = 'outline' | 'plan' | 'character' | 'scene' | 'storyboard' | 'note';
export type DocumentLifecycleStatus = 'active' | 'archived';
export type DocumentVersionState =
  | 'draft'
  | 'in_review'
  | 'published'
  | 'changes_requested'
  | 'rejected'
  | 'superseded'
  | 'discarded';
export type DocumentReviewStatus =
  'pending' | 'approved' | 'changes_requested' | 'rejected' | 'withdrawn';

export interface DocumentSummary {
  id: string;
  projectId: string;
  kind: DocumentKind;
  title: string;
  scopeType: ConversationScopeType;
  scopeId?: string;
  currentVersionId?: string;
  publishedVersionId?: string;
  lifecycleStatus: DocumentLifecycleStatus;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionInfo {
  id: string;
  documentId: string;
  version: number;
  contentMarkdown: string;
  state: DocumentVersionState;
  baseVersionId?: string;
  titleSnapshot?: string;
  scopeTypeSnapshot?: ConversationScopeType;
  scopeIdSnapshot?: string;
  authorType: 'user' | 'agent' | 'import' | 'migration';
  sourceTaskId?: string;
  sourceMessageId?: string;
  contextSnapshotId?: string;
  createdAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  currentVersion?: DocumentVersionInfo;
  publishedVersion?: DocumentVersionInfo;
}

export type NovelProfileStatus = 'active' | 'archived';
export type NovelVolumeStatus = 'active' | 'archived';
export type NovelChapterLifecycleStatus = 'reserved' | 'active' | 'archived';
export type NovelChapterArchiveReason = 'user_archive' | 'generation_placeholder';
export type DocumentBindingRole =
  | 'work-outline'
  | 'volume-outline'
  | 'character-bible'
  | 'world-bible'
  | 'timeline'
  | 'style-guide'
  | 'adaptation-proposal'
  | 'screenplay'
  | 'scene-outline'
  | 'shot-plan'
  | 'research'
  | 'note';
export type DocumentBindingDomain = 'shared' | 'novel' | 'short-drama';
export type DocumentBindingStatus = 'active' | 'archived' | 'needs_review';

export interface NovelProfileInfo {
  projectId: string;
  projectName: string;
  language: string;
  status: NovelProfileStatus;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelProfileGetParams {
  createIfMissing?: boolean;
}

export interface NovelProfileUpdateParams {
  language?: string;
  status?: NovelProfileStatus;
  expectedRowVersion: number;
}

export interface NovelVolumeInfo {
  id: string;
  projectId: string;
  title: string;
  position: number;
  status: NovelVolumeStatus;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelVolumeListParams {
  includeArchived?: boolean;
}

export interface NovelVolumeSaveParams {
  volumeId?: string;
  title: string;
  position?: number;
  status?: NovelVolumeStatus;
  expectedRowVersion?: number;
}

export interface NovelChapterInfo {
  id: string;
  projectId: string;
  volumeId?: string;
  documentId: string;
  title: string;
  position: number;
  displayLabel: string;
  lifecycleStatus: NovelChapterLifecycleStatus;
  archiveReason?: NovelChapterArchiveReason;
  documentRowVersion: number;
  /** Number of locally persisted RAG chunks for the current saved draft version. */
  ragChunkCount: number;
  ragIndexedAt?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelChapterListParams {
  volumeId?: string;
  includeArchived?: boolean;
}

export interface NovelChapterSaveParams {
  chapterId?: string;
  volumeId?: string;
  title: string;
  displayLabel?: string;
  position?: number;
  lifecycleStatus?: NovelChapterLifecycleStatus;
  archiveReason?: NovelChapterArchiveReason;
  expectedRowVersion?: number;
}

export interface NovelChapterArchiveParams {
  chapterId: string;
  expectedRowVersion: number;
  reason?: NovelChapterArchiveReason;
}

export interface NovelChapterRestoreParams {
  chapterId: string;
  expectedRowVersion: number;
}

export interface NovelImportChapterInput {
  title: string;
  displayLabel?: string;
  contentMarkdown: string;
}

export interface NovelImportParams {
  volumeTitle?: string;
  chapters: NovelImportChapterInput[];
}

export interface NovelImportResult {
  volume?: NovelVolumeInfo;
  chapters: NovelChapterInfo[];
  importedCount: number;
}

export interface NovelBindingInfo {
  id: string;
  projectId: string;
  documentId: string;
  volumeId?: string;
  chapterId?: string;
  sceneId?: string;
  shotId?: string;
  role: DocumentBindingRole;
  domainScope: DocumentBindingDomain;
  status: DocumentBindingStatus;
  migrationIssueCode?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelBindingListParams {
  includeNeedsReview?: boolean;
}

export interface NovelConsistencyIssueInfo {
  code:
    | 'missing-rag-index'
    | 'stale-rag-index'
    | 'duplicate-position'
    | 'duplicate-display-label'
    | 'stale-summary';
  severity: 'warning' | 'error';
  chapterId?: string;
  message: string;
}

export interface NovelConsistencyReport {
  projectId: string;
  generatedAt: string;
  chapterCount: number;
  indexedChunkCount: number;
  currentSummaryCount: number;
  staleSummaryCount: number;
  issues: NovelConsistencyIssueInfo[];
}

export interface NovelBindingSaveParams {
  bindingId?: string;
  documentId: string;
  volumeId?: string;
  chapterId?: string;
  sceneId?: string;
  shotId?: string;
  role: DocumentBindingRole;
  domainScope: DocumentBindingDomain;
  status?: DocumentBindingStatus;
  expectedRowVersion?: number;
}

export interface DocumentGetParams {
  documentId: string;
}

export interface DocumentSaveParams {
  documentId?: string;
  /** @deprecated The editor no longer exposes classification. Legacy callers may still send it. */
  kind?: DocumentKind;
  title: string;
  contentMarkdown: string;
  scopeType?: ConversationScopeType;
  scopeId?: string;
  expectedDocumentRowVersion?: number;
}

export interface DocumentDraftSaveParams extends DocumentSaveParams {
  baseVersionId?: string;
  sourceTaskId?: string;
  sourceMessageId?: string;
  contextSnapshotId?: string;
  authorType?: 'user' | 'agent' | 'import';
}

export interface DocumentReviewInfo {
  id: string;
  projectId: string;
  documentId: string;
  documentVersionId: string;
  taskId?: string;
  status: DocumentReviewStatus;
  requestedAt: string;
  decidedAt?: string;
  comment?: string;
  version: number;
}

export interface DocumentReviewSubmitParams {
  documentId: string;
  documentVersionId?: string;
  expectedDocumentRowVersion: number;
}

export interface DocumentReviewRejectParams {
  documentId: string;
  documentVersionId?: string;
  expectedDocumentRowVersion: number;
  comment?: string;
}

/** Returns a reviewable draft to editing without ending its Agent task. */
export type DocumentReviewRequestChangesParams = DocumentReviewRejectParams;

export interface DocumentPublishParams {
  documentId: string;
  documentVersionId?: string;
  expectedDocumentRowVersion: number;
  expectedPublishedVersionId?: string;
}

export type DocumentSelfPublishParams = DocumentPublishParams;

export interface DocumentPublicationInfo {
  id: string;
  documentId: string;
  documentVersionId: string;
  previousVersionId?: string;
  publicationNo: number;
  publishedAt: string;
}

export const AGENT_TOOL_RISK_LEVELS = ['R0', 'R1', 'R2', 'R3'] as const;
export type AgentToolRiskLevel = (typeof AGENT_TOOL_RISK_LEVELS)[number];
export type AgentToolConfirmationPolicy =
  'none' | 'explicit-user-intent' | 'always' | 'protected-ui';
export type AgentToolExecutionLane = 'parallel-readonly' | 'serial';

export interface AgentToolRiskPolicy {
  riskLevel: AgentToolRiskLevel;
  description: string;
  confirmationPolicy: AgentToolConfirmationPolicy;
}

/** Frozen P0 defaults. Worker policy may only make a registered tool more restrictive. */
export const AGENT_TOOL_RISK_POLICIES = {
  R0: {
    riskLevel: 'R0',
    description: 'Read-only operation without external side effects.',
    confirmationPolicy: 'none',
  },
  R1: {
    riskLevel: 'R1',
    description: 'Locally reversible write requested explicitly by the user.',
    confirmationPolicy: 'explicit-user-intent',
  },
  R2: {
    riskLevel: 'R2',
    description: 'Paid external call or important state change.',
    confirmationPolicy: 'always',
  },
  R3: {
    riskLevel: 'R3',
    description: 'Irreversible, destructive, or security-sensitive operation.',
    confirmationPolicy: 'protected-ui',
  },
} as const satisfies Record<AgentToolRiskLevel, AgentToolRiskPolicy>;

export interface AgentToolRegistryEntryV1 {
  version: 1;
  name: string;
  riskLevel: AgentToolRiskLevel;
  confirmationPolicy: AgentToolConfirmationPolicy;
  executionLane: AgentToolExecutionLane;
  inputSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
}

/** Task-scoped registry snapshot. It is policy output, not model-provided authority. */
export interface AgentToolRegistryV1 {
  version: 1;
  taskId: string;
  projectSessionId: string;
  tools: AgentToolRegistryEntryV1[];
  createdAt: string;
}

export type AgentToolPolicyErrorCode =
  | 'AGENT_TOOL_UNKNOWN'
  | 'AGENT_TOOL_UNAUTHORIZED'
  | 'AGENT_TOOL_PROJECT_SCOPE'
  | 'AGENT_TOOL_AUTHORIZATION_EXPIRED'
  | 'AGENT_TOOL_AUTHORIZATION_REPLAYED'
  | 'AGENT_TOOL_ARGUMENTS_TAMPERED'
  | 'AGENT_TOOL_CONFIRMATION_EXPIRED'
  | 'AGENT_TOOL_CONFIRMATION_REPLAYED'
  | 'AGENT_TOOL_ARGUMENTS_INVALID'
  | 'AGENT_TOOL_RESULT_INVALID'
  | 'AGENT_TOOL_RESULT_TOO_LARGE'
  | 'AGENT_TOOL_RESULT_FORBIDDEN';

export interface AgentToolPolicyErrorV1 {
  version: 1;
  status: 'rejected';
  error: {
    code: AgentToolPolicyErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface AgentConfirmationRequestV1 {
  version: 1;
  confirmationId: string;
  taskId: string;
  toolCallId: string;
  operation: string;
  argumentsHash: string;
  projectSessionId: string;
  riskLevel: Extract<AgentToolRiskLevel, 'R2' | 'R3'>;
  summary: string;
  affectedEntities: Array<{ type: string; id: string; label?: string }>;
  costNotice?: string;
  draftVersion?: number;
  expiresAt: string;
}

/** Opaque, short-lived grant. The handle must never enter Provider messages or durable snapshots. */
export interface AgentToolAuthorizationGrantV1 {
  version: 1;
  authorizationHandle: string;
  confirmationId: string;
  taskId: string;
  toolCallId: string;
  operation: string;
  argumentsHash: string;
  projectSessionId: string;
  singleUse: true;
  expiresAt: string;
}

export const AGENT_TOOL_RESULT_LIMITS = {
  maxJsonBytes: 64 * 1024,
  maxSummaryCharacters: 2_048,
  maxCollectionItems: 100,
} as const;

/** Keys that must not occur anywhere in a model-visible Tool Result. */
export const AGENT_TOOL_RESULT_FORBIDDEN_FIELDS = [
  'authorization',
  'authorizationHandle',
  'apiKey',
  'token',
  'secret',
  'credential',
  'headers',
  'absolutePath',
  'localPath',
  'sqliteHandle',
  'providerRawResponse',
  'base64',
  'dataUrl',
] as const;

export type MediaGenerationTaskState =
  | 'draft'
  | 'awaiting_confirmation'
  | 'submitting'
  | 'polling'
  | 'submission_unknown'
  | 'downloading'
  | 'validating'
  | 'committing'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export const MEDIA_GENERATION_TERMINAL_STATES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
] as const satisfies readonly MediaGenerationTaskState[];

/** Allowed forward transitions for the Worker-owned media state machine. */
export const MEDIA_GENERATION_ALLOWED_TRANSITIONS = {
  draft: ['awaiting_confirmation', 'cancelled'],
  awaiting_confirmation: ['submitting', 'failed', 'cancelled'],
  submitting: ['polling', 'submission_unknown', 'downloading', 'validating', 'failed', 'cancelled'],
  polling: ['downloading', 'validating', 'failed', 'timed_out', 'cancelled'],
  submission_unknown: ['polling', 'downloading', 'validating', 'failed', 'cancelled'],
  downloading: ['validating', 'failed', 'cancelled'],
  validating: ['committing', 'failed'],
  committing: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
} as const satisfies Readonly<
  Record<MediaGenerationTaskState, readonly MediaGenerationTaskState[]>
>;

export type MediaInputReferenceV1 =
  | { type: 'asset'; assetId: string }
  | { type: 'controlled_temporary_file'; handle: string; contentType: string };

export interface MediaProviderSelectionSnapshotV1 {
  providerProfileId: string;
  providerType: string;
  providerRegion: VideoProviderRegion;
  modelId: string;
  remoteModelId: string;
  adapterKey: string;
  adapterSchemaVersion: number;
}

/** Durable media draft. Parameters contain references only, never media bytes or secrets. */
export interface MediaGenerationDraftV1 {
  version: 1;
  draftId: string;
  draftVersion: number;
  projectId: string;
  projectSessionId: string;
  conversationId: string;
  capability: 'image' | 'video';
  state: Extract<MediaGenerationTaskState, 'draft' | 'awaiting_confirmation'>;
  provider: MediaProviderSelectionSnapshotV1;
  parameters: AdapterParameters;
  inputs: MediaInputReferenceV1[];
  createdAt: string;
  updatedAt: string;
}

export type NormalizedMediaOutput =
  | { type: 'remote_url'; url: string }
  | { type: 'authenticated_content'; providerTaskId: string }
  | { type: 'native_temporary_file'; handle: string };

export type NormalizedMediaTaskState =
  | { state: 'queued' | 'running'; progress?: number; retryAfterMs?: number }
  | { state: 'succeeded'; output: NormalizedMediaOutput }
  | { state: 'failed'; code?: string; message: string; retryable: boolean }
  | { state: 'cancelled' };

export interface MediaTaskAcceptedV1 {
  version: 1;
  accepted: true;
  taskId: string;
  state: Extract<MediaGenerationTaskState, 'submitting' | 'polling'>;
}

export type AgentTaskType =
  | 'document-create'
  | 'document-update'
  | 'document-query'
  | 'document-archive'
  | 'document-restore'
  | 'schema-query';
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

export interface AgentTaskInfo {
  id: string;
  projectId: string;
  conversationId?: string;
  userMessageId?: string;
  taskType: AgentTaskType;
  scopeType: ConversationScopeType;
  scopeId?: string;
  title: string;
  status: AgentTaskStatus;
  outcome?: AgentTaskOutcome;
  contextSnapshotId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  phase: AgentTaskPhase;
  rowVersion: number;
  providerName?: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: string;
}

export interface AgentTaskEventInfo {
  id: string;
  taskId: string;
  sequence: number;
  eventType: string;
  level: 'info' | 'warning' | 'error';
  summary: string;
  createdAt: string;
}

export interface AgentTaskDocumentArtifact {
  documentId: string;
  documentVersionId: string;
  operation: 'create' | 'update' | 'regenerate';
  createdAt: string;
}

/** A redacted, task-scoped view of one Provider request/response step. */
export interface AgentProviderStepInfo {
  id: string;
  generationId: string;
  attemptId: string;
  ordinal: number;
  protocol: string;
  status: 'prepared' | 'in_flight' | 'complete' | 'failed' | 'interrupted';
  toolCallCount: number;
  finishReason?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  providerReportedCost?: string;
  currency?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentResearchSourceInfo {
  id: string;
  title: string;
  site: string;
  canonicalUrl: string;
  retrievedAt: string;
  contentHash?: string;
  characterCount?: number;
  truncated: boolean;
  status: 'searched' | 'fetched' | 'excluded' | 'failed';
  citationLabel?: string;
  adoptionStatus: 'unreviewed' | 'adopted' | 'excluded';
  adoptionReason?: string;
  cacheStatus?: 'present' | 'missing' | 'expired';
  cacheErrorCode?: string;
}

export interface AgentTaskDetail {
  task: AgentTaskInfo;
  pendingConfirmation?: AgentTaskPendingConfirmationInfo;
  pendingSchemaConfirmation?: AgentTaskPendingSchemaConfirmationInfo;
  plan?: ConversationTaskPlanInfo;
  events: AgentTaskEventInfo[];
  documents: AgentTaskDocumentArtifact[];
  providerSteps: AgentProviderStepInfo[];
  researchSources: AgentResearchSourceInfo[];
}

export interface AgentTaskPendingSchemaConfirmationInfo {
  action: 'adapter.schema.propose';
  adapterKey: string;
  version: number;
  diff: string[];
  status: 'pending';
}

/** Safe-to-display confirmation metadata; the one-time token is never persisted or returned. */
export interface AgentTaskPendingConfirmationInfo {
  action: AgentToolConfirmationRequest['action'];
  documentId: string;
  documentTitle: string;
  expiresAt: string;
  status: 'pending' | 'expired';
}

export interface AgentTaskListParams {
  limit?: number;
  conversationId?: string;
}

export interface AgentTaskGetParams {
  taskId: string;
}

export interface AgentTaskEventsParams {
  taskId: string;
  afterSequence?: number;
  limit?: number;
}

export interface AgentTaskEventsResult {
  task: AgentTaskInfo;
  events: AgentTaskEventInfo[];
  nextSequence: number;
  hasMore: boolean;
}

/** Explicit user action that converts a completed assistant response into a reviewable draft. */
export interface AgentTaskCreateDocumentDraftParams {
  messageId: string;
  title?: string;
  targetDocumentId?: string;
  expectedDocumentRowVersion?: number;
  idempotencyKey?: string;
}

export interface AgentTaskCreateDocumentDraftResult {
  task: AgentTaskInfo;
  document: DocumentDetail;
}

export interface TaskLogItem {
  id: string;
  kind: 'agent-document' | 'image' | 'video';
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sourceId: string;
  conversationId?: string;
  shotId?: string;
  documentId?: string;
  documentVersionId?: string;
  providerName?: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: string;
}

export type TaskLogKind = TaskLogItem['kind'];

export interface TaskLogListParams {
  limit?: number;
  cursor?: string;
  kind?: TaskLogKind;
  status?: string;
}

export interface TaskLogPage {
  items: TaskLogItem[];
  nextCursor?: string;
}

/** Safe, project-scoped lifecycle facts for an image/video generation job. */
export interface GenerationJobEventInfo {
  id: string;
  jobId: string;
  sequence: number;
  phase: 'prepare' | 'submit' | 'poll' | 'download' | 'complete' | 'fail';
  status: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface GenerationJobEventsListParams {
  jobId: string;
  afterSequence?: number;
  limit?: number;
}

export interface GenerationJobEventsPage {
  events: GenerationJobEventInfo[];
  nextSequence: number;
  hasMore: boolean;
}

export interface DocumentVersionsParams {
  documentId: string;
}

export interface DocumentRestoreParams {
  documentId: string;
  versionId: string;
}

export interface SceneInfo {
  id: string;
  projectId: string;
  title: string;
  position: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SceneSaveParams {
  sceneId?: string;
  title: string;
  expectedRowVersion?: number;
}

export interface ShotInfo {
  id: string;
  sceneId: string;
  title: string;
  position: number;
  status: string;
  documentId?: string;
  /** Short-drama episode shot prompt (image/video generation text). */
  prompt?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShotListParams {
  sceneId: string;
}

export interface ShotSaveParams {
  shotId?: string;
  sceneId: string;
  title: string;
  status?: string;
  documentId?: string;
  prompt?: string;
  expectedRowVersion?: number;
}

export interface ShotStoryboardSaveParams {
  shotId: string;
  title: string;
  contentMarkdown: string;
}

export interface ConstraintInfo {
  id: string;
  projectId: string;
  scopeType: ConversationScopeType;
  scopeId?: string;
  kind: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentChangeSetStatus =
  'proposed' | 'partially_applied' | 'applied' | 'rejected' | 'conflicted';
export type AgentChangeSetItemStatus = 'pending' | 'applied' | 'rejected' | 'conflicted';

export interface AgentChangeSetItemDraft {
  entityType: 'scene' | 'shot' | 'document';
  action: 'create' | 'update';
  targetId?: string;
  parentSceneId?: string;
  parentItemOrdinal?: number;
  title: string;
  shotStatus?: string;
  /** Shot prompt for `shot` items; applied to `shots.prompt` when approved. */
  prompt?: string;
  documentKind?: DocumentKind;
  contentMarkdown?: string;
  scopeType?: ConversationScopeType;
  scopeId?: string;
  expectedRowVersion?: number;
  expectedCurrentVersionId?: string;
}

export interface AgentChangeSetItemInfo extends AgentChangeSetItemDraft {
  id: string;
  ordinal: number;
  status: AgentChangeSetItemStatus;
  appliedEntityId?: string;
  errorCode?: string;
}

export interface AgentChangeSetInfo {
  id: string;
  projectId: string;
  taskId?: string;
  title: string;
  status: AgentChangeSetStatus;
  rowVersion: number;
  items: AgentChangeSetItemInfo[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentChangeSetCreateParams {
  taskId?: string;
  title: string;
  items: AgentChangeSetItemDraft[];
}

export interface AgentChangeSetListParams {
  includeTerminal?: boolean;
}

export interface AgentChangeSetApplyParams {
  changeSetId: string;
  expectedRowVersion: number;
  itemIds?: string[];
}

export type AgentChangeSetRejectParams = AgentChangeSetApplyParams;

export type ConversationScopeType = 'project' | 'scene' | 'shot';

export interface ConversationInfo {
  id: string;
  projectId: string;
  scopeType: ConversationScopeType;
  scopeId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ConversationListParams {
  scopeType?: ConversationScopeType;
  scopeId?: string;
  includeArchived?: boolean;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface ConversationPage {
  items: ConversationInfo[];
  nextCursor?: string;
}

export interface ConversationCreateParams {
  scopeType: ConversationScopeType;
  scopeId?: string;
  title?: string;
}

export interface ConversationUpdateParams {
  conversationId: string;
  title: string;
}

export interface ConversationArchiveParams {
  conversationId: string;
}

export interface ConversationRestoreParams {
  conversationId: string;
}

export type ConversationModelPreferenceCapability = Exclude<UnifiedAgentCapability, 'auto'>;

export interface ConversationModelPreferenceInfo {
  conversationId: string;
  capability: ConversationModelPreferenceCapability;
  providerProfileId: string;
  modelId: string;
  confirmedAt: string;
  updatedAt: string;
}

export interface ConversationModelPreferenceGetParams {
  conversationId: string;
  capability: ConversationModelPreferenceCapability;
}

export interface ConversationModelPreferenceSetParams {
  conversationId: string;
  capability: ConversationModelPreferenceCapability;
  providerProfileId: string;
  modelId: string;
}

export interface ConversationModelPreferenceClearParams {
  conversationId: string;
  capability: ConversationModelPreferenceCapability;
}

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type ChatMessageStatus = 'streaming' | 'complete' | 'failed';

export interface ChatMessageInfo {
  id: string;
  conversationId: string;
  replyToMessageId?: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
  attempt?: LlmAttemptInfo;
}

export interface ChatMessageListParams {
  conversationId: string;
  before?: string;
  limit?: number;
}

export interface ChatMessagePage {
  items: ChatMessageInfo[];
  nextCursor?: string;
}

export interface ChatMessageSaveParams {
  messageId?: string;
  conversationId: string;
  replyToMessageId?: string;
  role: ChatMessageRole;
  content: string;
  status?: ChatMessageStatus;
}

export interface MessageArtifactParams {
  messageId: string;
}

export interface MessageDocumentParams extends MessageArtifactParams {
  title: string;
  kind?: DocumentKind;
}

export interface MessageConstraintParams extends MessageArtifactParams {
  kind?: string;
}

export interface CreatedArtifact {
  id: string;
}

export interface ContextSourceInfo {
  id: string;
  type: 'document' | 'memory' | 'constraint' | 'conversation';
  scopeType: ConversationScopeType;
  scopeId?: string;
  label: string;
  version?: number;
  versionId?: string;
  includedCharacters: number;
  originalCharacters: number;
  truncated: boolean;
}

export interface ProductionContextInfo {
  version: 1;
  scopeType: ConversationScopeType;
  scopeId?: string;
  scopeLabel: string;
  estimatedTokens: number;
  budgetTokens: number;
  sources: ContextSourceInfo[];
}

export interface ContextPreviewParams {
  conversationId: string;
  budgetTokens?: number;
}

export interface LlmStatusResult {
  provider: string;
  model: string;
  configured: boolean;
  configurationSource: 'environment' | 'none' | 'managed';
}

export type LlmGenerationStatus = 'prepared' | 'streaming' | 'complete' | 'failed' | 'cancelled';

export type LlmExecutionMode = 'legacy' | 'native';

export interface LlmGenerateParams extends ContextPreviewParams {
  prompt: string;
  idempotencyKey?: string;
}

export interface LlmGenerationInfo {
  generationId: string;
  attemptId?: string;
  projectId?: string;
  projectSessionId?: string;
  conversationId: string;
  snapshotId: string;
  status: LlmGenerationStatus;
  executionMode?: LlmExecutionMode;
  providerProfileId?: string;
  modelId?: string;
  providerResponseId?: string;
  finishReason?: string;
  userMessage: ChatMessageInfo;
  assistantMessage: ChatMessageInfo;
  sources: ContextSourceInfo[];
  error?: string;
  retryable?: boolean;
}

export interface LlmGenerationGetParams {
  generationId: string;
}

export interface LlmGenerationRetryParams {
  assistantMessageId: string;
  budgetTokens?: number;
  idempotencyKey?: string;
}

export interface LlmGenerationIdentity {
  generationId: string;
  attemptId: string;
  projectId: string;
  projectSessionId: string;
  conversationId: string;
}

/** Local attachment content supplied to a multimodal Agent invocation. */
export interface LlmInputAttachment {
  name: string;
  mimeType: string;
  /** Data URL for image inputs. Binary files are not persisted or exposed to tools. */
  dataUrl?: string;
  text?: string;
}

export interface LlmGenerationPrepareParams extends ContextPreviewParams {
  prompt: string;
  providerProfileId: string;
  modelId: string;
  attachments?: LlmInputAttachment[];
  idempotencyKey?: string;
}

export interface LlmGenerationRetryPrepareParams extends LlmGenerationRetryParams {
  providerProfileId: string;
  modelId: string;
}

export interface LlmGenerationPrepareResult {
  generation: LlmGenerationInfo;
  stream: LlmGenerationIdentity;
}

export interface LlmGenerationRuntimeRequest extends LlmGenerationIdentity {
  providerProfileId: string;
  modelId: string;
  remoteModelId: string;
  protocol: 'openai-responses' | 'openai-chat-completions';
  baseUrl: string;
  systemInstruction: string;
  context: string;
  prompt: string;
  attachments?: LlmInputAttachment[];
  tools?: LlmToolDefinition[];
  continuation?: LlmToolContinuation;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Opaque Native Runtime capability. It is never serialized into the Provider request. */
  authorizationHandle?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  authorizationHandle?: string;
}

export interface LlmToolOutput {
  callId: string;
  output: string;
}

export interface LlmResponsesToolContinuation {
  protocol: 'openai-responses';
  previousResponseId: string;
  outputs: LlmToolOutput[];
}

export interface LlmChatCompletionsToolContinuation {
  protocol: 'openai-chat-completions';
  providerResponseId: string;
  calls: LlmToolCall[];
  outputs: LlmToolOutput[];
}

export type LlmToolContinuation = LlmResponsesToolContinuation | LlmChatCompletionsToolContinuation;

/** Maximum UTF-8 size of one JSONL message on the Worker <-> Native host channel. */
export const SIDECAR_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024;

export type HostMethod =
  | 'provider.stream.start'
  | 'provider.stream.cancel'
  | 'provider.confirmation.wait'
  | 'provider.confirmation.resolve';

/** Provider request data that is safe to cross the sidecar boundary. Credentials and headers are absent. */
export interface NativeProviderStreamStartParams extends LlmGenerationIdentity {
  providerProfileId: string;
  modelId: string;
  remoteModelId: string;
  protocol: 'openai-responses' | 'openai-chat-completions';
  baseUrl: string;
  systemInstruction: string;
  context: string;
  prompt: string;
  attachments?: LlmInputAttachment[];
  tools?: Array<Pick<LlmToolDefinition, 'name' | 'description' | 'parameters'>>;
  continuation?:
    | LlmResponsesToolContinuation
    | (Omit<LlmChatCompletionsToolContinuation, 'calls'> & {
        calls: Array<Pick<LlmToolCall, 'id' | 'name' | 'argumentsJson'>>;
      });
}

export interface NativeProviderStreamCancelParams {
  streamRequestId: string;
  projectSessionId: string;
}

export interface NativeProviderConfirmationWaitParams {
  confirmationToken: string;
  projectSessionId: string;
}

export interface NativeProviderConfirmationResolveParams extends NativeProviderConfirmationWaitParams {
  approved: boolean;
}

export type HostMethodParams = {
  'provider.stream.start': NativeProviderStreamStartParams;
  'provider.stream.cancel': NativeProviderStreamCancelParams;
  'provider.confirmation.wait': NativeProviderConfirmationWaitParams;
  'provider.confirmation.resolve': NativeProviderConfirmationResolveParams;
};

export interface HostError {
  code:
    | 'INVALID_ENVELOPE'
    | 'MESSAGE_TOO_LARGE'
    | 'METHOD_NOT_FOUND'
    | 'INVALID_PARAMETERS'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_FAILED'
    | 'INTERRUPTED'
    | 'CANCELLED'
    | 'STALE_SESSION'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR';
  message: string;
  retryable: boolean;
}

export type NativeProviderHostEvent =
  | { type: 'started'; projectSessionId: string }
  | { type: 'text_delta'; projectSessionId: string; delta: string }
  | { type: 'thinking_delta'; projectSessionId: string; delta: string }
  | { type: 'tool_call_start'; projectSessionId: string; callId: string; name: string }
  | { type: 'tool_call_delta'; projectSessionId: string; callId: string; delta: string }
  | {
      type: 'tool_call_end';
      projectSessionId: string;
      call: Pick<LlmToolCall, 'id' | 'name' | 'argumentsJson'>;
    }
  | { type: 'usage'; projectSessionId: string; usage: NormalizedLlmUsage }
  | {
      type: 'complete';
      projectSessionId: string;
      providerResponseId?: string;
      finishReason?: string;
    }
  | { type: 'failed'; projectSessionId: string; error: HostError }
  | { type: 'cancelled'; projectSessionId: string };

export type SidecarEnvelope =
  | { kind: 'worker.response'; requestId: string; payload: WorkerResponse }
  | { kind: 'host.request'; requestId: string; method: HostMethod; params: unknown }
  | {
      kind: 'host.event';
      requestId: string;
      sequence: number;
      event: NativeProviderHostEvent;
    }
  | { kind: 'host.response'; requestId: string; ok: true; result: unknown }
  | { kind: 'host.response'; requestId: string; ok: false; error: HostError };

export interface AgentGenerationPrepareParams extends LlmGenerationPrepareParams {
  agentMode: 'document' | 'novel-writing' | 'short-drama';
  /** Frozen chapter scope for short-drama episode generation (max 50). */
  selectedChapterIds?: string[];
  /** Trusted Desktop selection. Required for short-drama and frozen into its task snapshot. */
  targetPlatform?: ConversationTargetPlatform;
  /**
   * External research is opt-out for explicit Agent document tasks. The Worker
   * still enforces the selected mode when deciding which tools to authorize.
   */
  researchMode?: AgentResearchMode;
  title?: string;
  /**
   * This is trusted Desktop input, not a Provider tool argument. A target is
   * resolved and frozen by the Worker before the Provider sees any tool.
   */
  documentIntent?: AgentDocumentIntent;
  /** Trusted Desktop intent. Provider tool arguments never carry these targets. */
  novelIntent?: NovelWritingIntent;
}

/** Capabilities that the unified conversational Agent may route to. */
export type UnifiedAgentCapability =
  'text' | 'image' | 'video' | 'document' | 'novel' | 'short-drama' | 'research' | 'asset' | 'auto';

/**
 * A deterministic UI/offline hint only. The selected LLM remains responsible
 * for semantic intent and tool selection, and Worker policy remains
 * authoritative for every operation.
 */
export function inferUnifiedAgentCapabilityHint(prompt: string): UnifiedAgentCapability {
  const value = prompt.normalize('NFC');
  if (/(搜索|查找|联网|最新资料|网页|研究)/u.test(value)) return 'research';
  if (
    /(?:生成|制作|创建|绘制|画出|画一张)/u.test(value) &&
    /(图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)/u.test(value) &&
    !/(提示词|prompt|文档)/iu.test(value)
  )
    return 'image';
  if (/(改写|重写|润色|总结|提取|分析|识别|描述|转写|翻译|提示词)/u.test(value)) return 'document';
  if (
    /(文生视频|图生视频|参考生视频|首尾帧(?:生|生成)?视频|(?:生成|制作|创建)[^。！？\n]{0,80}(?:的)?视频(?:[。！？!?]|$)|输出视频|做成视频)/u.test(
      value,
    )
  )
    return 'video';
  if (
    /(文生图|图生图|参考生图|生成(?:一张|一个|一组|该|这个)?(?:图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)|制作(?:一张|一个|一组|该|这个)?(?:图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)|创建(?:一张|一个|一组|该|这个)?(?:图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)|生图)/u.test(
      value,
    )
  )
    return 'image';
  if (/(小说|章节|续写|短剧|剧本|场次|镜头)/u.test(value)) return 'document';
  return 'text';
}

export interface UnifiedAgentModelCandidate {
  providerProfileId: string;
  providerName: string;
  modelId: string;
  remoteModelId: string;
  modelName: string;
  capabilities: ProviderModelCapabilities;
  source: ProviderModelSource;
  /** False when the model exists but its parameter schema still needs configuration. */
  schemaReady?: boolean;
}

export interface UnifiedAgentRunParams {
  conversationId: string;
  prompt: string;
  attachments?: LlmInputAttachment[];
  capability?: UnifiedAgentCapability;
  /** The conversation-scoped model selected by the user, when already known. */
  providerProfileId?: string;
  modelId?: string;
  /** Selected generation adapter for image/video requests. */
  adapterKey?: string;
  /** User-supplied adapter parameters, validated by the Worker. */
  parameters?: AdapterParameters;
  shotId?: string;
  providerRegion?: VideoProviderRegion;
  assetKind?: ImageAssetKind | VideoAssetKind;
  budgetTokens?: number;
  idempotencyKey?: string;
}

export interface UnifiedAgentModelSelectionRequest {
  prompt: string;
  capability: UnifiedAgentCapability;
  models: UnifiedAgentModelCandidate[];
  reason?: 'missing_model' | 'model_unavailable' | 'capability_mismatch' | 'agent_tools_required';
}

export type UnifiedAgentRunResult =
  | {
      status: 'needs_model_selection';
      capability: UnifiedAgentCapability;
      reason:
        'missing_model' | 'model_unavailable' | 'capability_mismatch' | 'agent_tools_required';
      models: UnifiedAgentModelCandidate[];
    }
  | {
      status: 'needs_parameters';
      capability: 'image' | 'video';
      providerProfileId: string;
      modelId: string;
      modelName: string;
      adapters: AdapterDescriptor[];
      missingRequired: string[];
      affectsCost: boolean;
    }
  | {
      status: 'image_prepared';
      capability: 'image';
      job: ImageGenerationJobInfo;
    }
  | {
      status: 'video_prepared';
      capability: 'video';
      job: VideoGenerationJobInfo;
    }
  | ({ status: 'started'; capability: UnifiedAgentCapability } & AgentGenerationPrepareResult);

/** Versioned, model-proposed business plan. Authority fields are injected by the Worker. */
export type ConversationTaskMode = 'document' | 'novel-writing' | 'short-drama';
export type ConversationTaskAction = 'generate' | 'revise' | 'analyze';
export type ConversationTargetPlatform = 'seedance' | 'generic-video' | 'generic-image';
export type ConversationDeliverableKind =
  | 'episode-outline'
  | 'character-prompts'
  | 'scene-prompts'
  | 'scene-shot-structure'
  | 'shot-prompts'
  | 'production-notes';

export interface ConversationTaskDeliverableV1 {
  kind: ConversationDeliverableKind;
  required: boolean;
  dependsOn: ConversationDeliverableKind[];
}

export interface ConversationTaskPlanV1 {
  version: 1;
  mode: ConversationTaskMode;
  action: ConversationTaskAction;
  targetPlatform?: ConversationTargetPlatform;
  deliverables: ConversationTaskDeliverableV1[];
  constraints: string[];
}

export type ConversationTaskPlanStatus = 'frozen' | 'active' | 'succeeded' | 'failed' | 'cancelled';
export type ConversationDeliverableStatus =
  'pending' | 'ready' | 'in_progress' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export type ConversationTaskPlanErrorCode =
  | 'TASK_PLAN_INVALID_TYPE'
  | 'TASK_PLAN_UNKNOWN_FIELD'
  | 'TASK_PLAN_AUTHORITY_FIELD_FORBIDDEN'
  | 'TASK_PLAN_INVALID_VERSION'
  | 'TASK_PLAN_INVALID_MODE'
  | 'TASK_PLAN_INVALID_ACTION'
  | 'TASK_PLAN_INVALID_PLATFORM'
  | 'TASK_PLAN_INVALID_DELIVERABLE'
  | 'TASK_PLAN_DUPLICATE_DELIVERABLE'
  | 'TASK_PLAN_INVALID_DEPENDENCY'
  | 'TASK_PLAN_CYCLIC_DEPENDENCY'
  | 'TASK_PLAN_TASK_NOT_FOUND'
  | 'TASK_PLAN_TASK_MODE_MISMATCH'
  | 'TASK_PLAN_SCOPE_INVALID'
  | 'TASK_PLAN_PLATFORM_MISMATCH'
  | 'TASK_PLAN_IDEMPOTENCY_CONFLICT'
  | 'TASK_PLAN_INVALID_STATE'
  | 'TASK_PLAN_DELIVERABLE_NOT_READY'
  | 'TASK_PLAN_DUPLICATE_COMPLETION'
  | 'TASK_PACKAGE_ENTITY_INVALID'
  | 'TASK_PACKAGE_INCOMPLETE'
  | 'TASK_PACKAGE_FOLLOW_UP_LIMIT';

export type ConversationTaskToolName =
  | 'task.plan.submit'
  | 'novel.episode.submit_draft'
  | 'document.create_draft'
  | 'novel.episode.submit_structure'
  | 'task.package.complete';

export interface ConversationTaskToolGrant {
  deliverableId?: string;
  deliverableKind?: ConversationDeliverableKind;
  tool: LlmToolDefinition & { name: ConversationTaskToolName };
}

export interface DomainToolResultV1 {
  version: 1;
  status: 'succeeded' | 'rejected' | 'needs_confirmation' | 'conflicted';
  deliverable?: ConversationDeliverableKind;
  entityType?: 'document' | 'change-set' | 'task';
  entityId?: string;
  summary: string;
  remainingRequiredDeliverables: ConversationDeliverableKind[];
  retryable: boolean;
}

export interface ConversationPackageCompleteResult {
  complete: boolean;
  taskStatus?: 'waiting_review' | 'completed' | 'failed';
  errorCode?: Extract<ConversationTaskPlanErrorCode, 'TASK_PACKAGE_FOLLOW_UP_LIMIT'>;
  followUp?: {
    ordinal: 1 | 2;
    prompt: string;
    missingDeliverables: ConversationDeliverableKind[];
  };
}

export interface ConversationTaskPlanInfo {
  id: string;
  taskId: string;
  projectId: string;
  plan: ConversationTaskPlanV1;
  /** Worker-owned scope copied from the frozen task snapshot, never from model output. */
  trustedScope: { selectedChapterIds: string[] };
  status: ConversationTaskPlanStatus;
  deliverables: Array<
    ConversationTaskDeliverableV1 & {
      id: string;
      status: ConversationDeliverableStatus;
    }
  >;
  createdAt: string;
  updatedAt: string;
}

export type AgentResearchMode = 'auto' | 'project_only' | 'network_disabled';

export type AgentGenerationPrepareResult =
  | (LlmGenerationPrepareResult & {
      agentTaskId: string;
      /** Native-owned runs keep executing when a Desktop view unsubscribes. */
      runtimeOwner?: 'desktop' | 'native-agent' | 'pi';
      /** Worker-selected internal workflow; never a user-visible Agent mode. */
      runtimeMode?: ConversationTaskMode;
    })
  | { pendingIntent: AgentPendingIntentInfo };

export type NovelWritingAction = 'create_chapter' | 'continue_chapter' | 'rewrite_chapter';

export interface NovelWritingIntent {
  action?: NovelWritingAction;
  chapterId?: string;
  volumeId?: string;
  chapterTitle?: string;
  displayLabel?: string;
}

export interface AgentPendingIntentInfo {
  id: string;
  projectId: string;
  conversationId: string;
  requestedAction?: NovelWritingAction;
  reasonCode: 'NEGATED_ACTION' | 'AMBIGUOUS_ACTION' | 'TARGET_REQUIRED' | 'TARGET_NOT_UNIQUE';
  status: 'pending' | 'resolved' | 'cancelled' | 'expired';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRuntimeStartParams extends LlmGenerationIdentity {
  taskId: string;
  mode: ConversationTaskMode;
  prompt: string;
}

export interface ConversationRuntimeStartResult {
  runtime: 'pi';
  taskId: string;
}

export interface ConversationRuntimeGetParams {
  generationId: string;
}

export interface ConversationRuntimeGetResult {
  active: boolean;
  confirmation?: AgentToolConfirmationRequest;
  mediaSelection?: MediaModelSelectionRequest;
}

export interface ConversationRuntimeConfirmParams {
  generationId: string;
  confirmationToken: string;
  approved: boolean;
}

export interface ConversationRuntimeConfirmResult {
  accepted: boolean;
}

export interface ConversationRuntimeSelectMediaParams {
  generationId: string;
  selectionToken: string;
  selection?: MediaModelSelectionDecision;
}

export interface ConversationRuntimeSelectMediaResult {
  accepted: boolean;
}

export interface NovelPendingIntentListParams {
  includeResolved?: boolean;
}

export interface NovelPendingIntentCancelParams {
  intentId: string;
}

export interface AgentPartialArtifactInfo {
  id: string;
  taskId: string;
  chapterId?: string;
  documentId?: string;
  targetKind: 'chapter' | 'reference-create' | 'reference-update';
  contentLength: number;
  status: 'recoverable' | 'recovered' | 'discarded' | 'expired';
  rowVersion: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPartialArtifactListParams {
  includeTerminal?: boolean;
}

export interface AgentPartialArtifactRecoverParams {
  artifactId: string;
  expectedRowVersion: number;
  expectedDocumentRowVersion: number;
}

export interface AgentPartialArtifactDiscardParams {
  artifactId: string;
  expectedRowVersion: number;
}

export interface NovelAdaptationProposalInfo {
  id: string;
  projectId: string;
  sourceChapterId: string;
  sourceDocumentVersionId: string;
  sourceContentHash: string;
  proposalDocumentId: string;
  proposalDocumentVersionId: string;
  adaptationTaskId: string;
  createdAt: string;
}

export type AgentDocumentOperation =
  | 'adapter.schema.get'
  | 'adapter.schema.propose'
  | 'adapter.schema.audit.list'
  | 'document.create_draft'
  | 'document.list'
  | 'document.read'
  | 'document.update_draft'
  | 'document.archive'
  | 'document.restore'
  | 'novel.chapter.submit_draft'
  | 'novel.reference.submit_draft'
  | 'novel.adaptation.submit_proposal'
  | 'novel.episode.submit_draft'
  | 'novel.episode.submit_structure';

export interface AgentDocumentIntent {
  operation: AgentDocumentOperation;
  /** Required for read, update, archive, and restore. */
  documentId?: string;
}

export interface AgentGenerationExecuteToolsParams extends LlmGenerationIdentity {
  providerResponseId: string;
  calls: LlmToolCall[];
  usage?: NormalizedLlmUsage;
}

export interface AgentGenerationExecuteToolsResult {
  continuation?: LlmToolContinuation;
  confirmation?: AgentToolConfirmationRequest;
  mediaSelection?: MediaModelSelectionRequest;
  /** Tools authorized for the next Provider step, including read-only research. */
  tools?: LlmToolDefinition[];
}

export type MediaGenerationKind = 'image' | 'video';
export type MediaProviderType = 'unicompapi' | 'vidu';
export type MediaProviderBaseUrlCategory =
  'official-unicompapi' | 'official-vidu-global' | 'official-vidu-cn';

export interface MediaModelSelectionSnapshot {
  providerProfileId: string;
  providerType: MediaProviderType;
  providerBaseUrlCategory: MediaProviderBaseUrlCategory;
  providerRegion: VideoProviderRegion;
  modelId: string;
  remoteModelId: string;
  adapterKey: string;
  adapterSchemaVersion: number;
  adapterSchemaSource: 'official-adapter' | 'manual';
}

export interface MediaModelCandidate {
  providerProfileId: string;
  providerName: string;
  providerType: MediaProviderType;
  providerRegion: VideoProviderRegion;
  modelId: string;
  remoteModelId: string;
  modelName: string;
  adapters: AdapterDescriptor[];
  costNotice: { required: true; summary: string };
}

/** Worker-created UI request. It is never included in a Provider Tool Result. */
export interface MediaModelSelectionRequest {
  selectionToken: string;
  kind: MediaGenerationKind;
  prompt: string;
  inputAssetIds: string[];
  inputAttachmentCount: number;
  proposedParameters: AdapterParameters;
  candidates: MediaModelCandidate[];
  expiresAt: string;
}

export interface MediaModelSelectionDecision {
  providerProfileId: string;
  modelId: string;
  adapterKey: string;
  parameters: AdapterParameters;
  assetKind?: ImageAssetKind | VideoAssetKind;
}

export interface AgentGenerationSelectMediaParams extends LlmGenerationIdentity {
  selectionToken: string;
  selection?: MediaModelSelectionDecision;
}

export interface MediaGenerationDraft {
  draftId: string;
  kind: MediaGenerationKind;
  status: 'draft';
  prompt: string;
  inputAssetIds: string[];
  mediaModelSelection: MediaModelSelectionSnapshot;
  normalizedParameters: AdapterParameters;
  missingParameters: string[];
  costNotice: { required: true; summary: string };
}

export interface MediaTaskSummary {
  taskId: string;
  kind: MediaGenerationKind;
  state: MediaGenerationTaskState;
  adapterKey: string;
  resultAssetIds: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolConfirmationRequest {
  confirmationToken: string;
  action: 'document.archive' | 'document.restore';
  documentId: string;
  documentTitle: string;
  expiresAt: string;
}

export interface AgentGenerationConfirmToolParams extends LlmGenerationIdentity {
  confirmationToken: string;
  approved: boolean;
}

export interface AgentGenerationConfirmToolResult {
  continuation?: LlmToolContinuation;
  /** Tools authorized for the Provider step created after confirmation. */
  tools?: LlmToolDefinition[];
}

export interface AgentProviderStepCompleteParams extends LlmGenerationIdentity {
  providerResponseId?: string;
  finishReason?: string;
  usage?: NormalizedLlmUsage;
}

export type AgentProviderStepStartParams = LlmGenerationIdentity;

export interface LlmGenerationObserveParams extends LlmGenerationIdentity {
  content: string;
}

export interface NormalizedLlmUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  providerReportedCost?: ProviderReportedCostInfo;
  raw?: Record<string, unknown>;
}

export interface ProviderReportedCostInfo {
  amount: string;
  currency?: string;
}

export interface LlmPricingSnapshotInfo {
  currency: string;
  unitTokens: number;
  inputPrice: string;
  cachedInputPrice?: string;
  outputPrice: string;
  configuredAt: string;
}

export interface LlmAttemptInfo {
  id: string;
  generationId: string;
  providerProfileId?: string;
  providerName: string;
  modelId?: string;
  modelName: string;
  protocol: string;
  status: LlmGenerationStatus | 'interrupted';
  startedAt: string;
  firstTokenAt?: string;
  completedAt?: string;
  providerResponseId?: string;
  finishReason?: string;
  usage?: NormalizedLlmUsage;
  pricingSnapshot?: LlmPricingSnapshotInfo;
  estimatedCost?: string;
  currency?: string;
  providerReportedCost?: ProviderReportedCostInfo;
  errorCode?: string;
  errorMessage?: string;
}

export interface LlmGenerationCompleteParams extends LlmGenerationObserveParams {
  providerResponseId?: string;
  finishReason?: string;
  usage?: NormalizedLlmUsage;
}

export interface LlmGenerationFailParams extends LlmGenerationObserveParams {
  error: string;
  retryable: boolean;
  usage?: NormalizedLlmUsage;
}

export type LlmNativeStreamEvent =
  | { type: 'started' }
  | { type: 'delta'; delta: string }
  | { type: 'confirmation'; confirmation: AgentToolConfirmationRequest }
  | {
      type: 'toolCalls';
      calls: LlmToolCall[];
      providerResponseId?: string;
      usage?: NormalizedLlmUsage;
    }
  | {
      type: 'complete';
      providerResponseId?: string;
      finishReason?: string;
      usage?: NormalizedLlmUsage;
    }
  | { type: 'failed'; error: string; retryable: boolean; usage?: NormalizedLlmUsage }
  | { type: 'cancelled'; usage?: NormalizedLlmUsage };

export interface UsageQueryParams {
  startAt: string;
  endAt: string;
  providerProfileId?: string;
  modelId?: string;
  projectId?: string;
  status?: 'complete' | 'failed' | 'cancelled';
}

export interface UsageEntryInfo {
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

export interface UsageCurrencySummary {
  currency: string;
  attempts: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCost: string;
}

export interface UsageQueryResult {
  entries: UsageEntryInfo[];
  summaries: UsageCurrencySummary[];
}

export interface UsageRebuildResult {
  projectsScanned: number;
  projectsSkipped: number;
  attemptsIndexed: number;
}

export type GenerationCapability =
  | 'TEXT_TO_IMAGE'
  | 'REFERENCE_TO_IMAGE'
  | 'TEXT_TO_VIDEO'
  | 'IMAGE_TO_VIDEO'
  | 'REFERENCE_TO_VIDEO'
  | 'START_END_TO_VIDEO';

export type AdapterParameterValue = string | number | boolean | string[];
export type AdapterParameters = Record<string, AdapterParameterValue>;

export interface AdapterParameterProperty {
  type: 'string' | 'integer' | 'boolean' | 'array';
  title: string;
  description?: string;
  default?: AdapterParameterValue;
  enum?: AdapterParameterValue[];
  const?: AdapterParameterValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  /** Product-level metadata surfaced before submission. */
  affectsCost?: boolean;
  overwritesExisting?: boolean;
  mutuallyExclusiveWith?: string[];
  requires?: string[];
  items?: {
    type: 'string';
    format?: 'uri';
  };
}

export interface AdapterParameterSchema {
  $schema: 'https://json-schema.org/draft/2020-12/schema';
  type: 'object';
  additionalProperties: false;
  required: string[];
  properties: Record<string, AdapterParameterProperty>;
  allOf?: Record<string, unknown>[];
}

export type AdapterControl = 'text' | 'textarea' | 'select' | 'number' | 'toggle' | 'url-list';

export interface AdapterUiField {
  key: string;
  control: AdapterControl;
  group: 'basic' | 'advanced';
  order: number;
  placeholder?: string;
}

export interface AdapterUiSchema {
  fields: AdapterUiField[];
}

export interface AdapterDescriptor {
  key: string;
  capability: GenerationCapability;
  capabilityLabel: string;
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  apiVersion: string;
  schemaVersion: number;
  endpoint: string;
  documentationUrl: string;
  credentialProvider: string;
  parameterSchema: AdapterParameterSchema;
  uiSchema: AdapterUiSchema;
}

export interface AdapterCatalogResult {
  capabilities: { key: GenerationCapability; label: string }[];
  providers: { key: string; label: string }[];
  adapters: AdapterDescriptor[];
}

export interface AdapterResolveParams {
  capability: GenerationCapability;
  provider: string;
  model: string;
  apiVersion?: string;
}

export interface AdapterValidateParams {
  adapterKey: string;
  parameters: AdapterParameters;
}

export interface AdapterValidationError {
  path: string;
  message: string;
}

export interface AdapterValidationResult {
  valid: boolean;
  errors: AdapterValidationError[];
}

export interface GenerationDraftInfo {
  id: string;
  shotId: string;
  adapterKey: string;
  parameters: AdapterParameters;
  updatedAt: string;
}

export interface GenerationDraftGetParams {
  shotId: string;
  adapterKey: string;
  providerProfileId?: string;
  modelId?: string;
}

export interface GenerationDraftSaveParams extends GenerationDraftGetParams {
  parameters: AdapterParameters;
}

export type ImageGenerationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ImageAssetKind =
  'character' | 'scene' | 'first-frame' | 'last-frame' | 'generated-image';

export interface AssetInfo {
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
  tags?: AssetTagInfo[];
  createdAt: string;
}

export interface ImageGenerationResultInfo {
  id: string;
  jobId: string;
  asset?: AssetInfo;
  providerUrl?: string;
  createdAt: string;
}

export interface ImagePreviewInfo {
  assetId?: string;
  jobId?: string;
  dataUrl: string;
  contentType: string;
  sourceUrl?: string;
}

export interface ImageGenerationJobInfo {
  id: string;
  shotId?: string;
  adapterKey: string;
  status: ImageGenerationJobStatus;
  request: AdapterParameters;
  results: ImageGenerationResultInfo[];
  error?: string;
  preview?: ImagePreviewInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ImageGenerationPrepareParams {
  shotId?: string;
  adapterKey: string;
  parameters: AdapterParameters;
  providerProfileId?: string;
  modelId?: string;
  conversationId?: string;
  originalPrompt?: string;
  costNoticeAcknowledged?: boolean;
  /** Worker-validated immutable selection. IPC callers cannot provide this field. */
  mediaModelSelection?: MediaModelSelectionSnapshot;
  /** Worker-created input references. IPC callers cannot provide this field. */
  mediaInputReferences?: MediaInputReferenceV1[];
}

export interface ImageGenerationCompleteParams {
  jobId: string;
  providerStatus: number;
  providerBody: unknown;
  assetKind?: ImageAssetKind;
  saveAsset?: boolean;
}

export interface ImageGenerationSavePreviewParams {
  jobId: string;
  dataUrl: string;
  contentType: string;
  assetKind?: ImageAssetKind;
}

export interface ImageGenerationFailParams {
  jobId: string;
}

export interface ImageGenerationCancelParams {
  jobId: string;
}

export interface ImageGenerationGetParams {
  jobId: string;
}

export type VideoGenerationJobStatus =
  | 'pending'
  | 'polling'
  | 'downloading'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'cancelled';
export type VideoGenerationFailureKind =
  'transport' | 'provider' | 'download' | 'interrupted' | 'timeout';
export type VideoAssetKind = 'generated-video' | 'shot-video';
export type VideoProviderRegion = 'global' | 'cn' | 'unicompapi';

export interface VideoGenerationCostInfo {
  amount: number;
  unit: 'credits' | 'unknown';
  unitPrice?: string;
  estimatedAmount?: string;
  currency?: string;
}

export interface VideoGenerationMetadataInfo {
  providerRegion: VideoProviderRegion;
  providerProfileId?: string;
  modelId?: string;
  providerState?: string;
  pollAttempts: number;
  lastPolledAt?: string;
  pollDeadlineAt?: string;
  failureKind?: VideoGenerationFailureKind;
  cost?: VideoGenerationCostInfo;
}

export interface VideoGenerationResultInfo {
  id: string;
  jobId: string;
  asset: AssetInfo;
  createdAt: string;
}

export interface VideoGenerationJobInfo {
  id: string;
  projectId: string;
  shotId?: string;
  adapterKey: string;
  assetKind: VideoAssetKind;
  providerTaskId?: string;
  status: VideoGenerationJobStatus;
  request: AdapterParameters;
  metadata: VideoGenerationMetadataInfo;
  results: VideoGenerationResultInfo[];
  error?: string;
  elapsedMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface VideoGenerationPrepareParams {
  shotId?: string;
  adapterKey: string;
  parameters: AdapterParameters;
  providerRegion: VideoProviderRegion;
  providerProfileId?: string;
  modelId?: string;
  assetKind?: VideoAssetKind;
  conversationId?: string;
  originalPrompt?: string;
  costNoticeAcknowledged?: boolean;
  /** Worker-validated immutable selection. IPC callers cannot provide this field. */
  mediaModelSelection?: MediaModelSelectionSnapshot;
  /** Worker-created input references. IPC callers cannot provide this field. */
  mediaInputReferences?: MediaInputReferenceV1[];
}

export interface VideoGenerationAttachTaskParams {
  jobId: string;
  providerTaskId: string;
}

export interface VideoGenerationObserveParams {
  jobId: string;
  providerTaskId: string;
  providerStatus: number;
  providerBody: unknown;
}

export interface VideoGenerationFailParams {
  jobId: string;
  failureKind: VideoGenerationFailureKind;
  message?: string;
}

export interface VideoGenerationJobParams {
  jobId: string;
}

export interface AssetListParams {
  kind?: string;
  keyword?: string;
  deleted?: 'active' | 'trash';
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  tagIds?: string[];
  sort?: 'created-asc' | 'created-desc';
  cursor?: string;
}

export interface AssetRenameParams {
  assetId: string;
  name: string;
}

export interface AssetAliasUpdateParams {
  assetId: string;
  alias: string;
}

export interface AssetTagInfo {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  assetCount?: number;
}
export interface AssetGroupInfo {
  id: string;
  projectId: string;
  name: string;
  tagIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  assetCount?: number;
}
export interface AssetTagListParams {
  keyword?: string;
}
export interface AssetTagCreateParams {
  name: string;
}
export interface AssetTagUpdateParams {
  tagId: string;
  name: string;
}
export interface AssetTagDeleteParams {
  tagId: string;
}
export interface AssetTagAssignmentParams {
  assetIds: string[];
  tagIds: string[];
}
export interface AssetGroupListParams {
  keyword?: string;
}
export interface AssetGroupCreateParams {
  name: string;
  tagIds: string[];
}
export interface AssetGroupUpdateParams {
  groupId: string;
  name: string;
  tagIds: string[];
}
export interface AssetGroupDeleteParams {
  groupId: string;
}
export interface AssetGroupResolveParams {
  groupId: string;
}

export interface AssetDeleteParams {
  assetId: string;
  confirm?: boolean;
}

export interface AssetDeleteResult {
  deleted: true;
  referenceCount: number;
}

export interface AssetPurgeParams {
  assetId: string;
  confirm: boolean;
}

export interface AssetRestoreParams {
  assetId: string;
}

export interface AssetPreviewParams {
  assetId: string;
}

export interface AssetMediaSourceParams {
  assetId: string;
}

export interface AssetMediaSourceInfo {
  assetId: string;
  path: string;
  contentType: string;
}

export interface AssetRevealParams {
  assetId: string;
}

export interface AssetOpenParams {
  assetId: string;
}

export interface AssetRevealResult {
  path: string;
}

export interface AssetSourceInfo {
  assetId: string;
  jobId: string;
  shotId?: string;
}

export interface WorkerMethodMap {
  health: { params: Record<string, never>; result: HealthResult };
  'sqlite.probe': { params: SqliteProbeParams; result: SqliteProbeResult };
  'project.create': { params: ProjectCreateParams; result: ProjectInfo };
  'project.createSample': { params: SampleProjectCreateParams; result: ProjectInfo };
  'project.open': { params: ProjectOpenParams; result: ProjectInfo };
  'project.close': { params: Record<string, never>; result: { closed: true } };
  'project.current': { params: Record<string, never>; result: ProjectInfo | null };
  'project.recent': { params: Record<string, never>; result: RecentProjectInfo[] };
  'project.integrity': { params: Record<string, never>; result: ProjectIntegrityResult };
  'project.backup': { params: ProjectBackupParams; result: PathResult };
  'project.export': { params: ProjectExportParams; result: PathResult };
  'project.restore': { params: ProjectRestoreParams; result: ProjectInfo };
  'provider.profile.list': {
    params: ProviderProfileListParams;
    result: ProviderProfileInfo[];
  };
  'provider.profile.get': {
    params: ProviderProfileGetParams;
    result: ProviderProfileInfo | null;
  };
  'provider.profile.create': {
    params: ProviderProfileCreateParams;
    result: ProviderProfileInfo;
  };
  'provider.profile.update': {
    params: ProviderProfileUpdateParams;
    result: ProviderProfileInfo;
  };
  'provider.profile.archive': {
    params: ProviderProfileGetParams;
    result: ProviderProfileInfo;
  };
  'provider.profile.migrateLegacy': {
    params: ProviderLegacyMigrationParams;
    result: ProviderLegacyMigrationResult;
  };
  'provider.definition.list': {
    params: Record<string, never>;
    result: ProviderDefinitionInfo[];
  };
  'provider.connection.begin': {
    params: ProviderProfileGetParams;
    result: ProviderRuntimeProfile;
  };
  'provider.connection.complete': {
    params: ProviderConnectionCompleteParams;
    result: ProviderConnectionResult;
  };
  'provider.model.list': {
    params: ProviderProfileGetParams;
    result: ProviderModelInfo[];
  };
  'provider.model.createManual': {
    params: ProviderModelCreateParams;
    result: ProviderModelInfo;
  };
  'provider.model.update': {
    params: ProviderModelUpdateParams;
    result: ProviderModelInfo;
  };
  'provider.model.pricing.list': {
    params: ProviderProfileGetParams;
    result: ModelPricingInfo[];
  };
  'provider.model.pricing.update': {
    params: ModelPricingUpdateParams;
    result: ModelPricingInfo;
  };
  'provider.default.list': {
    params: Record<string, never>;
    result: ProviderDefaultInfo[];
  };
  'provider.default.update': {
    params: ProviderDefaultUpdateParams;
    result: ProviderDefaultInfo | null;
  };
  'usage.list': { params: UsageQueryParams; result: UsageQueryResult };
  'usage.rebuild': { params: Record<string, never>; result: UsageRebuildResult };
  'maintenance.cache.inspect': {
    params: Record<string, never>;
    result: CacheInspectionResult;
  };
  'maintenance.cache.clear': { params: Record<string, never>; result: CacheClearResult };
  'maintenance.researchCache.cleanup': {
    params: ResearchCacheCleanupParams;
    result: ResearchCacheCleanupResult;
  };
  'maintenance.metrics': { params: Record<string, never>; result: WorkerMetricsSnapshot };
  'maintenance.contextSnapshots.cleanup': {
    params: ContextSnapshotCleanupParams;
    result: ContextSnapshotCleanupResult;
  };
  'maintenance.diagnostics.export': {
    params: DiagnosticExportParams;
    result: DiagnosticExportResult;
  };
  'maintenance.diagnostics.reveal': {
    params: DiagnosticRevealParams;
    result: PathResult;
  };
  'document.list': { params: Record<string, never>; result: DocumentSummary[] };
  'novel.profile.get': { params: NovelProfileGetParams; result: NovelProfileInfo | null };
  'novel.profile.update': { params: NovelProfileUpdateParams; result: NovelProfileInfo };
  'novel.volume.list': { params: NovelVolumeListParams; result: NovelVolumeInfo[] };
  'novel.volume.save': { params: NovelVolumeSaveParams; result: NovelVolumeInfo };
  'novel.chapter.list': { params: NovelChapterListParams; result: NovelChapterInfo[] };
  'novel.chapter.save': { params: NovelChapterSaveParams; result: NovelChapterInfo };
  'novel.chapter.archive': { params: NovelChapterArchiveParams; result: NovelChapterInfo };
  'novel.chapter.restore': { params: NovelChapterRestoreParams; result: NovelChapterInfo };
  'novel.import': { params: NovelImportParams; result: NovelImportResult };
  'novel.binding.list': { params: NovelBindingListParams; result: NovelBindingInfo[] };
  'novel.context.consistencyReport': {
    params: Record<string, never>;
    result: NovelConsistencyReport;
  };
  'novel.binding.save': { params: NovelBindingSaveParams; result: NovelBindingInfo };
  'novel.export.prepare': {
    params: NovelMarkdownExportPrepareParams;
    result: NovelMarkdownExportJobInfo;
  };
  'novel.intent.list': { params: NovelPendingIntentListParams; result: AgentPendingIntentInfo[] };
  'novel.intent.cancel': { params: NovelPendingIntentCancelParams; result: AgentPendingIntentInfo };
  'agent.partial.list': {
    params: AgentPartialArtifactListParams;
    result: AgentPartialArtifactInfo[];
  };
  'agent.partial.recover': { params: AgentPartialArtifactRecoverParams; result: DocumentDetail };
  'agent.partial.discard': {
    params: AgentPartialArtifactDiscardParams;
    result: AgentPartialArtifactInfo;
  };
  'document.get': { params: DocumentGetParams; result: DocumentDetail };
  'document.save': { params: DocumentSaveParams; result: DocumentDetail };
  'document.draft.save': { params: DocumentDraftSaveParams; result: DocumentDetail };
  'document.versions': { params: DocumentVersionsParams; result: DocumentVersionInfo[] };
  'document.restore': { params: DocumentRestoreParams; result: DocumentDetail };
  'document.review.submit': { params: DocumentReviewSubmitParams; result: DocumentReviewInfo };
  'document.review.requestChanges': {
    params: DocumentReviewRequestChangesParams;
    result: DocumentReviewInfo;
  };
  'document.review.reject': { params: DocumentReviewRejectParams; result: DocumentReviewInfo };
  'document.publish': {
    params: DocumentPublishParams;
    result: { document: DocumentDetail; publication: DocumentPublicationInfo };
  };
  'document.selfPublish': {
    params: DocumentSelfPublishParams;
    result: { document: DocumentDetail; publication: DocumentPublicationInfo };
  };
  'agent.task.createDocumentDraft': {
    params: AgentTaskCreateDocumentDraftParams;
    result: AgentTaskCreateDocumentDraftResult;
  };
  'agent.task.list': { params: AgentTaskListParams; result: AgentTaskInfo[] };
  'agent.task.get': { params: AgentTaskGetParams; result: AgentTaskDetail };
  'agent.task.events': { params: AgentTaskEventsParams; result: AgentTaskEventsResult };
  'agent.generation.prepare': {
    params: AgentGenerationPrepareParams;
    result: AgentGenerationPrepareResult;
  };
  /** Unified natural-language entry point. It may ask for a model or parameters before starting. */
  'agent.run': {
    params: UnifiedAgentRunParams;
    result: UnifiedAgentRunResult;
  };
  'model.catalog.list': {
    params: UnifiedAgentModelCatalogListParams;
    result: UnifiedAgentModelCatalogListResult;
  };
  'model.catalog.get': {
    params: UnifiedAgentModelCatalogGetParams;
    result: UnifiedAgentModelCatalogGetResult | null;
  };
  'adapter.schema.get': {
    params: UnifiedAgentAdapterSchemaGetParams;
    result: AdapterDescriptor | null;
  };
  'adapter.schema.propose': {
    params: UnifiedAgentAdapterSchemaProposeParams;
    result: UnifiedAgentAdapterSchemaProposeResult;
  };
  'adapter.schema.confirm': {
    params: UnifiedAgentAdapterSchemaConfirmParams;
    result: UnifiedAgentAdapterSchemaConfirmResult;
  };
  'adapter.schema.rollback': {
    params: UnifiedAgentAdapterSchemaRollbackParams;
    result: UnifiedAgentAdapterSchemaRollbackResult;
  };
  'adapter.schema.audit.list': {
    params: UnifiedAgentAdapterSchemaAuditListParams;
    result: UnifiedAgentAdapterSchemaAuditListResult;
  };
  'conversation.runtime.start': {
    params: ConversationRuntimeStartParams;
    result: ConversationRuntimeStartResult;
  };
  'conversation.runtime.get': {
    params: ConversationRuntimeGetParams;
    result: ConversationRuntimeGetResult;
  };
  'conversation.runtime.confirm': {
    params: ConversationRuntimeConfirmParams;
    result: ConversationRuntimeConfirmResult;
  };
  'conversation.runtime.selectMedia': {
    params: ConversationRuntimeSelectMediaParams;
    result: ConversationRuntimeSelectMediaResult;
  };
  'agent.generation.executeTools': {
    params: AgentGenerationExecuteToolsParams;
    result: AgentGenerationExecuteToolsResult;
  };
  'agent.generation.cancel': { params: LlmGenerationGetParams; result: { cancelled: boolean } };
  'agent.generation.confirmTool': {
    params: AgentGenerationConfirmToolParams;
    result: AgentGenerationConfirmToolResult;
  };
  'agent.generation.selectMedia': {
    params: AgentGenerationSelectMediaParams;
    result: AgentGenerationExecuteToolsResult;
  };
  'agent.providerStep.complete': {
    params: AgentProviderStepCompleteParams;
    result: Record<string, never>;
  };
  'agent.providerStep.start': {
    params: AgentProviderStepStartParams;
    result: Record<string, never>;
  };
  'task.log.list': { params: TaskLogListParams; result: TaskLogPage };
  'generation.job.events.list': {
    params: GenerationJobEventsListParams;
    result: GenerationJobEventsPage;
  };
  'scene.list': { params: Record<string, never>; result: SceneInfo[] };
  'scene.save': { params: SceneSaveParams; result: SceneInfo };
  'shot.list': { params: ShotListParams; result: ShotInfo[] };
  'shot.save': { params: ShotSaveParams; result: ShotInfo };
  'shot.storyboard.save': { params: ShotStoryboardSaveParams; result: DocumentDetail };
  'constraint.list': { params: Record<string, never>; result: ConstraintInfo[] };
  'agent.changeSet.create': {
    params: AgentChangeSetCreateParams;
    result: AgentChangeSetInfo;
  };
  'agent.changeSet.list': {
    params: AgentChangeSetListParams;
    result: AgentChangeSetInfo[];
  };
  'agent.changeSet.apply': {
    params: AgentChangeSetApplyParams;
    result: AgentChangeSetInfo;
  };
  'agent.changeSet.reject': {
    params: AgentChangeSetRejectParams;
    result: AgentChangeSetInfo;
  };
  'conversation.list': { params: ConversationListParams; result: ConversationPage };
  'conversation.create': { params: ConversationCreateParams; result: ConversationInfo };
  'conversation.update': { params: ConversationUpdateParams; result: ConversationInfo };
  'conversation.archive': { params: ConversationArchiveParams; result: ConversationInfo };
  'conversation.restore': { params: ConversationRestoreParams; result: ConversationInfo };
  'conversation.modelPreference.get': {
    params: ConversationModelPreferenceGetParams;
    result: ConversationModelPreferenceInfo | null;
  };
  'conversation.modelPreference.set': {
    params: ConversationModelPreferenceSetParams;
    result: ConversationModelPreferenceInfo;
  };
  'conversation.modelPreference.clear': {
    params: ConversationModelPreferenceClearParams;
    result: { cleared: boolean };
  };
  'chat.message.list': { params: ChatMessageListParams; result: ChatMessagePage };
  'chat.message.save': { params: ChatMessageSaveParams; result: ChatMessageInfo };
  'chat.message.toDocument': { params: MessageDocumentParams; result: DocumentDetail };
  'chat.message.toMemory': { params: MessageArtifactParams; result: CreatedArtifact };
  'chat.message.toConstraint': { params: MessageConstraintParams; result: CreatedArtifact };
  'context.preview': { params: ContextPreviewParams; result: ProductionContextInfo };
  'llm.status': { params: Record<string, never>; result: LlmStatusResult };
  'llm.generate': { params: LlmGenerateParams; result: LlmGenerationInfo };
  'llm.generation.prepare': {
    params: LlmGenerationPrepareParams;
    result: LlmGenerationPrepareResult;
  };
  'llm.generation.runtime': {
    params: LlmGenerationIdentity;
    result: LlmGenerationRuntimeRequest;
  };
  'llm.generation.observe': {
    params: LlmGenerationObserveParams;
    result: LlmGenerationInfo;
  };
  'llm.generation.complete': {
    params: LlmGenerationCompleteParams;
    result: LlmGenerationInfo;
  };
  'llm.generation.fail': {
    params: LlmGenerationFailParams;
    result: LlmGenerationInfo;
  };
  'llm.generation.get': { params: LlmGenerationGetParams; result: LlmGenerationInfo };
  'llm.generation.cancel': { params: LlmGenerationGetParams; result: LlmGenerationInfo };
  'llm.generation.retry': { params: LlmGenerationRetryParams; result: LlmGenerationInfo };
  'llm.generation.retryPrepare': {
    params: LlmGenerationRetryPrepareParams;
    result: LlmGenerationPrepareResult;
  };
  'adapter.catalog': { params: Record<string, never>; result: AdapterCatalogResult };
  'adapter.resolve': { params: AdapterResolveParams; result: AdapterDescriptor };
  'adapter.validate': { params: AdapterValidateParams; result: AdapterValidationResult };
  'generation.draft.get': {
    params: GenerationDraftGetParams;
    result: GenerationDraftInfo | null;
  };
  'generation.draft.save': {
    params: GenerationDraftSaveParams;
    result: GenerationDraftInfo;
  };
  'image.generate.prepare': {
    params: ImageGenerationPrepareParams;
    result: ImageGenerationJobInfo;
  };
  'image.generate.complete': {
    params: ImageGenerationCompleteParams;
    result: ImageGenerationJobInfo;
  };
  'image.generate.savePreview': {
    params: ImageGenerationSavePreviewParams;
    result: ImageGenerationJobInfo;
  };
  'image.generate.fail': {
    params: ImageGenerationFailParams;
    result: ImageGenerationJobInfo;
  };
  'image.generate.cancel': {
    params: ImageGenerationCancelParams;
    result: ImageGenerationJobInfo;
  };
  'image.generate.get': {
    params: ImageGenerationGetParams;
    result: ImageGenerationJobInfo;
  };
  'video.generate.prepare': {
    params: VideoGenerationPrepareParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.attachTask': {
    params: VideoGenerationAttachTaskParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.observe': {
    params: VideoGenerationObserveParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.fail': {
    params: VideoGenerationFailParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.pause': {
    params: VideoGenerationJobParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.resume': {
    params: VideoGenerationJobParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.timeout': {
    params: VideoGenerationJobParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.cancel': {
    params: VideoGenerationJobParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.get': {
    params: VideoGenerationJobParams;
    result: VideoGenerationJobInfo;
  };
  'video.generate.list': {
    params: Record<string, never>;
    result: VideoGenerationJobInfo[];
  };
  'asset.list': { params: AssetListParams; result: AssetInfo[] };
  'asset.preview': { params: AssetPreviewParams; result: ImagePreviewInfo };
  'asset.mediaSource': { params: AssetMediaSourceParams; result: AssetMediaSourceInfo };
  'asset.open': { params: AssetOpenParams; result: AssetRevealResult };
  'asset.reveal': { params: AssetRevealParams; result: AssetRevealResult };
  'asset.rename': { params: AssetRenameParams; result: AssetInfo };
  'asset.alias.update': { params: AssetAliasUpdateParams; result: AssetInfo };
  'asset.delete': { params: AssetDeleteParams; result: AssetDeleteResult };
  'asset.restore': { params: AssetRestoreParams; result: AssetInfo };
  'asset.purge': { params: AssetPurgeParams; result: { purged: true } };
  'asset.source.locate': { params: AssetPreviewParams; result: AssetSourceInfo };
  'tag.list': { params: AssetTagListParams; result: AssetTagInfo[] };
  'tag.create': { params: AssetTagCreateParams; result: AssetTagInfo };
  'tag.update': { params: AssetTagUpdateParams; result: AssetTagInfo };
  'tag.delete': { params: AssetTagDeleteParams; result: { deleted: true } };
  'asset.tags.replace': { params: AssetTagAssignmentParams; result: AssetInfo[] };
  'asset.tags.add': { params: AssetTagAssignmentParams; result: AssetInfo[] };
  'asset.tags.remove': { params: AssetTagAssignmentParams; result: AssetInfo[] };
  'assetGroup.list': { params: AssetGroupListParams; result: AssetGroupInfo[] };
  'assetGroup.create': { params: AssetGroupCreateParams; result: AssetGroupInfo };
  'assetGroup.update': { params: AssetGroupUpdateParams; result: AssetGroupInfo };
  'assetGroup.delete': { params: AssetGroupDeleteParams; result: { deleted: true } };
  'assetGroup.resolve': { params: AssetGroupResolveParams; result: AssetInfo[] };
}

export type WorkerMethod = keyof WorkerMethodMap;

export interface WorkerRequest<M extends WorkerMethod = WorkerMethod> {
  id: string;
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  method: M;
  params: WorkerMethodMap[M]['params'];
}

export interface WorkerError {
  code:
    | 'INVALID_REQUEST'
    | 'METHOD_NOT_FOUND'
    | 'INTERNAL_ERROR'
    | 'PROTOCOL_MISMATCH'
    | 'PROJECT_NOT_FOUND'
    | 'PROJECT_READ_ONLY'
    | 'PROJECT_LOCKED'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'DOCUMENT_BASE_CONFLICT'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'INVALID_STATE'
    | 'STALE_SESSION'
    | 'ADAPTER_NOT_FOUND'
    | 'INVALID_PARAMETERS'
    | 'MODEL_TOOLS_REQUIRED'
    | 'PROVIDER_TOOL_LOOP_REQUIRED'
    | 'LLM_NOT_CONFIGURED'
    | 'LLM_REQUEST_FAILED';
  message: string;
  requestId?: string;
  retryable?: boolean;
  operation?: string;
  details?: unknown;
}

export type WorkerResponse<M extends WorkerMethod = WorkerMethod> =
  | {
      id: string;
      protocolVersion: typeof IPC_PROTOCOL_VERSION;
      ok: true;
      result: WorkerMethodMap[M]['result'];
    }
  | {
      id: string;
      protocolVersion: typeof IPC_PROTOCOL_VERSION;
      ok: false;
      error: WorkerError;
    };
