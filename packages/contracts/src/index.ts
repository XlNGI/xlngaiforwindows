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

export interface ProjectCreateParams {
  name: string;
  rootPath: string;
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

export type DocumentKind = 'outline' | 'plan' | 'character' | 'scene' | 'storyboard' | 'note';

export interface DocumentSummary {
  id: string;
  projectId: string;
  kind: DocumentKind;
  title: string;
  scopeType: ConversationScopeType;
  scopeId?: string;
  currentVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionInfo {
  id: string;
  documentId: string;
  version: number;
  contentMarkdown: string;
  createdAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  currentVersion?: DocumentVersionInfo;
}

export interface DocumentGetParams {
  documentId: string;
}

export interface DocumentSaveParams {
  documentId?: string;
  kind: DocumentKind;
  title: string;
  contentMarkdown: string;
  scopeType?: ConversationScopeType;
  scopeId?: string;
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
}

export interface ConversationListParams {
  scopeType?: ConversationScopeType;
  scopeId?: string;
}

export interface ConversationCreateParams {
  scopeType: ConversationScopeType;
  scopeId?: string;
  title?: string;
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
}

export type LlmGenerationStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';

export interface LlmGenerateParams extends ContextPreviewParams {
  prompt: string;
}

export interface LlmGenerationInfo {
  generationId: string;
  conversationId: string;
  snapshotId: string;
  status: LlmGenerationStatus;
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
}

export type GenerationCapability = 'TEXT_TO_IMAGE' | 'REFERENCE_TO_IMAGE' | 'IMAGE_TO_VIDEO';

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
}

export interface GenerationDraftSaveParams extends GenerationDraftGetParams {
  parameters: AdapterParameters;
}

export type ImageGenerationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AssetInfo {
  id: string;
  projectId: string;
  kind: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  sourceUrl?: string;
  createdAt: string;
}

export interface ImageGenerationResultInfo {
  id: string;
  jobId: string;
  asset?: AssetInfo;
  providerUrl?: string;
  createdAt: string;
}

export interface ImageGenerationJobInfo {
  id: string;
  shotId?: string;
  adapterKey: string;
  status: ImageGenerationJobStatus;
  request: AdapterParameters;
  results: ImageGenerationResultInfo[];
  error?: string;
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
  assetKind?: 'character' | 'scene' | 'first-frame' | 'last-frame' | 'generated-image';
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

export interface AssetListParams {
  kind?: string;
}

export interface AssetRenameParams {
  assetId: string;
  name: string;
}

export interface AssetDeleteParams {
  assetId: string;
}

export interface WorkerMethodMap {
  health: { params: Record<string, never>; result: HealthResult };
  'sqlite.probe': { params: SqliteProbeParams; result: SqliteProbeResult };
  'project.create': { params: ProjectCreateParams; result: ProjectInfo };
  'project.open': { params: ProjectOpenParams; result: ProjectInfo };
  'project.close': { params: Record<string, never>; result: { closed: true } };
  'project.current': { params: Record<string, never>; result: ProjectInfo | null };
  'project.recent': { params: Record<string, never>; result: RecentProjectInfo[] };
  'project.integrity': { params: Record<string, never>; result: ProjectIntegrityResult };
  'project.backup': { params: ProjectBackupParams; result: PathResult };
  'project.export': { params: ProjectExportParams; result: PathResult };
  'project.restore': { params: ProjectRestoreParams; result: ProjectInfo };
  'document.list': { params: Record<string, never>; result: DocumentSummary[] };
  'document.get': { params: DocumentGetParams; result: DocumentDetail };
  'document.save': { params: DocumentSaveParams; result: DocumentDetail };
  'document.versions': { params: DocumentVersionsParams; result: DocumentVersionInfo[] };
  'document.restore': { params: DocumentRestoreParams; result: DocumentDetail };
  'scene.list': { params: Record<string, never>; result: SceneInfo[] };
  'scene.save': { params: SceneSaveParams; result: SceneInfo };
  'shot.list': { params: ShotListParams; result: ShotInfo[] };
  'shot.save': { params: ShotSaveParams; result: ShotInfo };
  'conversation.list': { params: ConversationListParams; result: ConversationInfo[] };
  'conversation.create': { params: ConversationCreateParams; result: ConversationInfo };
  'chat.message.list': { params: ChatMessageListParams; result: ChatMessagePage };
  'chat.message.save': { params: ChatMessageSaveParams; result: ChatMessageInfo };
  'chat.message.toDocument': { params: MessageDocumentParams; result: DocumentDetail };
  'chat.message.toMemory': { params: MessageArtifactParams; result: CreatedArtifact };
  'chat.message.toConstraint': { params: MessageConstraintParams; result: CreatedArtifact };
  'context.preview': { params: ContextPreviewParams; result: ProductionContextInfo };
  'llm.status': { params: Record<string, never>; result: LlmStatusResult };
  'llm.generate': { params: LlmGenerateParams; result: LlmGenerationInfo };
  'llm.generation.get': { params: LlmGenerationGetParams; result: LlmGenerationInfo };
  'llm.generation.cancel': { params: LlmGenerationGetParams; result: LlmGenerationInfo };
  'llm.generation.retry': { params: LlmGenerationRetryParams; result: LlmGenerationInfo };
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
  'asset.list': { params: AssetListParams; result: AssetInfo[] };
  'asset.rename': { params: AssetRenameParams; result: AssetInfo };
  'asset.delete': { params: AssetDeleteParams; result: { deleted: true } };
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
    | 'ADAPTER_NOT_FOUND'
    | 'INVALID_PARAMETERS'
    | 'LLM_NOT_CONFIGURED'
    | 'LLM_REQUEST_FAILED';
  message: string;
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
