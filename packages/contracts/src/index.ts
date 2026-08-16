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

export interface DocumentPublicationInfo {
  id: string;
  documentId: string;
  documentVersionId: string;
  previousVersionId?: string;
  publicationNo: number;
  publishedAt: string;
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

export interface AgentTaskDetail {
  task: AgentTaskInfo;
  events: AgentTaskEventInfo[];
  documents: AgentTaskDocumentArtifact[];
}

export interface AgentTaskListParams {
  limit?: number;
  conversationId?: string;
}

export interface AgentTaskGetParams {
  taskId: string;
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
  documentId?: string;
  documentVersionId?: string;
}

export interface TaskLogListParams {
  limit?: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface SceneSaveParams {
  sceneId?: string;
  title: string;
}

export interface ShotInfo {
  id: string;
  sceneId: string;
  title: string;
  position: number;
  status: string;
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
}

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

export interface LlmGenerationPrepareParams extends ContextPreviewParams {
  prompt: string;
  providerProfileId: string;
  modelId: string;
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
}

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
  'maintenance.diagnostics.export': {
    params: DiagnosticExportParams;
    result: DiagnosticExportResult;
  };
  'maintenance.diagnostics.reveal': {
    params: DiagnosticRevealParams;
    result: PathResult;
  };
  'document.list': { params: Record<string, never>; result: DocumentSummary[] };
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
  'agent.task.createDocumentDraft': {
    params: AgentTaskCreateDocumentDraftParams;
    result: AgentTaskCreateDocumentDraftResult;
  };
  'agent.task.list': { params: AgentTaskListParams; result: AgentTaskInfo[] };
  'agent.task.get': { params: AgentTaskGetParams; result: AgentTaskDetail };
  'task.log.list': { params: TaskLogListParams; result: TaskLogItem[] };
  'scene.list': { params: Record<string, never>; result: SceneInfo[] };
  'scene.save': { params: SceneSaveParams; result: SceneInfo };
  'shot.list': { params: ShotListParams; result: ShotInfo[] };
  'shot.save': { params: ShotSaveParams; result: ShotInfo };
  'conversation.list': { params: ConversationListParams; result: ConversationInfo[] };
  'conversation.create': { params: ConversationCreateParams; result: ConversationInfo };
  'conversation.update': { params: ConversationUpdateParams; result: ConversationInfo };
  'conversation.archive': { params: ConversationArchiveParams; result: ConversationInfo };
  'conversation.restore': { params: ConversationRestoreParams; result: ConversationInfo };
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
