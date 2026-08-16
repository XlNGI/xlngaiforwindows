import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  IPC_PROTOCOL_VERSION,
  type ChatMessageListParams,
  type ChatMessageSaveParams,
  type AgentTaskCreateDocumentDraftParams,
  type AgentTaskGetParams,
  type AdapterResolveParams,
  type AdapterValidateParams,
  type ConversationArchiveParams,
  type ConversationCreateParams,
  type ConversationRestoreParams,
  type ConversationUpdateParams,
  type DocumentRestoreParams,
  type DocumentDraftSaveParams,
  type DocumentPublishParams,
  type DocumentReviewRequestChangesParams,
  type DocumentReviewRejectParams,
  type DocumentReviewSubmitParams,
  type DocumentSaveParams,
  type ImageAssetKind,
  type HealthResult,
  type GenerationDraftGetParams,
  type GenerationDraftSaveParams,
  type ImageGenerationPrepareParams,
  type ImageGenerationCompleteParams,
  type ImageGenerationSavePreviewParams,
  type VideoAssetKind,
  type VideoGenerationAttachTaskParams,
  type VideoGenerationFailParams,
  type VideoGenerationFailureKind,
  type VideoGenerationObserveParams,
  type VideoGenerationPrepareParams,
  type AssetPreviewParams,
  type AssetMediaSourceParams,
  type AssetOpenParams,
  type AssetRevealParams,
  type AssetRenameParams,
  type AssetAliasUpdateParams,
  type ProjectCreateParams,
  type SampleProjectCreateParams,
  type DiagnosticExportParams,
  type ProjectExportParams,
  type ProjectOpenParams,
  type ProjectRestoreParams,
  type ProviderProfileCreateParams,
  type ProviderLegacyMigrationParams,
  type ProviderProfileUpdateParams,
  type ProviderConnectionCompleteParams,
  type ProviderModelCreateParams,
  type ProviderModelUpdateParams,
  type MessageConstraintParams,
  type MessageDocumentParams,
  type LlmGenerationCompleteParams,
  type LlmGenerationFailParams,
  type LlmGenerationIdentity,
  type LlmGenerationObserveParams,
  type LlmGenerationPrepareParams,
  type LlmGenerationRetryPrepareParams,
  type ModelPricingUpdateParams,
  type ProviderDefaultUpdateParams,
  type SceneSaveParams,
  type ShotSaveParams,
  type SqliteProbeResult,
  type UsageQueryParams,
  type WorkerError,
  type WorkerMethod,
  type WorkerRequest,
  type WorkerResponse,
} from '@ai-video/contracts';
import { LlmProviderError, OpenAIResponsesProvider } from '@ai-video/llm';
import {
  AdapterNotFoundError,
  AdapterService,
  InvalidAdapterParametersError,
} from './adapter-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowError, DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { VideoGenerationService } from './video-generation-service.js';
import { MaintenanceService } from './maintenance-service.js';
import { SampleProjectService } from './sample-project-service.js';
import { AppSettingsService, ProviderProfileValidationError } from './app-settings-service.js';
import { UsageService } from './usage-service.js';
import { RequestValidationError, validateSessionRequestParams } from './request-validation.js';

const WORKER_VERSION = '0.1.0';
const methods = new Set<WorkerMethod>([
  'health',
  'sqlite.probe',
  'project.create',
  'project.createSample',
  'project.open',
  'project.close',
  'project.current',
  'project.recent',
  'project.integrity',
  'project.backup',
  'project.export',
  'project.restore',
  'provider.profile.list',
  'provider.profile.get',
  'provider.profile.create',
  'provider.profile.update',
  'provider.profile.archive',
  'provider.profile.migrateLegacy',
  'provider.definition.list',
  'provider.connection.begin',
  'provider.connection.complete',
  'provider.model.list',
  'provider.model.createManual',
  'provider.model.update',
  'provider.model.pricing.list',
  'provider.model.pricing.update',
  'provider.default.list',
  'provider.default.update',
  'usage.list',
  'usage.rebuild',
  'maintenance.cache.inspect',
  'maintenance.cache.clear',
  'maintenance.metrics',
  'maintenance.contextSnapshots.cleanup',
  'maintenance.diagnostics.export',
  'maintenance.diagnostics.reveal',
  'document.list',
  'document.get',
  'document.save',
  'document.draft.save',
  'document.versions',
  'document.restore',
  'document.review.submit',
  'document.review.requestChanges',
  'document.review.reject',
  'document.publish',
  'agent.task.createDocumentDraft',
  'agent.task.list',
  'agent.task.get',
  'task.log.list',
  'scene.list',
  'scene.save',
  'shot.list',
  'shot.save',
  'conversation.list',
  'conversation.create',
  'conversation.update',
  'conversation.archive',
  'conversation.restore',
  'chat.message.list',
  'chat.message.save',
  'chat.message.toDocument',
  'chat.message.toMemory',
  'chat.message.toConstraint',
  'context.preview',
  'llm.status',
  'llm.generate',
  'llm.generation.prepare',
  'llm.generation.runtime',
  'llm.generation.observe',
  'llm.generation.complete',
  'llm.generation.fail',
  'llm.generation.get',
  'llm.generation.cancel',
  'llm.generation.retry',
  'llm.generation.retryPrepare',
  'adapter.catalog',
  'adapter.resolve',
  'adapter.validate',
  'generation.draft.get',
  'generation.draft.save',
  'image.generate.prepare',
  'image.generate.complete',
  'image.generate.savePreview',
  'image.generate.fail',
  'image.generate.cancel',
  'image.generate.get',
  'video.generate.prepare',
  'video.generate.attachTask',
  'video.generate.observe',
  'video.generate.fail',
  'video.generate.pause',
  'video.generate.resume',
  'video.generate.timeout',
  'video.generate.cancel',
  'video.generate.get',
  'video.generate.list',
  'asset.list',
  'asset.preview',
  'asset.mediaSource',
  'asset.open',
  'asset.reveal',
  'asset.rename',
  'asset.alias.update',
  'asset.delete',
  'asset.restore',
  'asset.purge',
  'asset.source.locate',
  'tag.list',
  'tag.create',
  'tag.update',
  'tag.delete',
  'asset.tags.replace',
  'asset.tags.add',
  'asset.tags.remove',
  'assetGroup.list',
  'assetGroup.create',
  'assetGroup.update',
  'assetGroup.delete',
  'assetGroup.resolve',
]);
const isPackaged = 'pkg' in process;
// A literal require lets pkg discover and extract the native addon from the executable.
const packagedSqliteBinding = isPackaged
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('better-sqlite3/build/Release/better_sqlite3.node') as object)
  : undefined;
const projectService = new ProjectService({ nativeBinding: packagedSqliteBinding });
const appSettingsService = new AppSettingsService({ nativeBinding: packagedSqliteBinding });
const contentService = new ContentService(projectService);
const documentWorkflowService = new DocumentWorkflowService(projectService);
const adapterService = new AdapterService(projectService);
const imageGenerationService = new ImageGenerationService(projectService);
const videoGenerationService = new VideoGenerationService(
  projectService,
  undefined,
  appSettingsService,
);
const maintenanceService = new MaintenanceService(projectService);
const sampleProjectService = new SampleProjectService(projectService);
const contextService = new ContextService(projectService);
const usageService = new UsageService(projectService, appSettingsService, {
  nativeBinding: packagedSqliteBinding,
});
const llmProvider = new OpenAIResponsesProvider({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
});
const generationService = new GenerationService(
  projectService,
  contentService,
  contextService,
  llmProvider,
  { selectionResolver: appSettingsService, usageIndexer: appSettingsService },
);

function errorResponse(id: string, error: WorkerError): WorkerResponse {
  return {
    id,
    protocolVersion: IPC_PROTOCOL_VERSION,
    ok: false,
    error: { ...error, requestId: id },
  };
}

export function recordWorkerError(operation: string, error: unknown): void {
  maintenanceService.recordError(operation, error);
}

export function parseRequest(value: unknown): WorkerRequest | WorkerResponse {
  if (!value || typeof value !== 'object') {
    return errorResponse('unknown', {
      code: 'INVALID_REQUEST',
      message: 'Request must be a JSON object.',
    });
  }

  const candidate = value as Partial<WorkerRequest>;
  const id = typeof candidate.id === 'string' ? candidate.id : 'unknown';

  if (candidate.protocolVersion !== IPC_PROTOCOL_VERSION) {
    return errorResponse(id, {
      code: 'PROTOCOL_MISMATCH',
      message: `Worker requires IPC protocol v${IPC_PROTOCOL_VERSION}.`,
    });
  }

  if (typeof candidate.method !== 'string' || !methods.has(candidate.method)) {
    return errorResponse(id, {
      code: 'METHOD_NOT_FOUND',
      message: `Unknown worker method: ${String(candidate.method)}`,
    });
  }

  return {
    id,
    protocolVersion: IPC_PROTOCOL_VERSION,
    method: candidate.method,
    params: candidate.params ?? {},
  };
}

function probeSqlite(databasePath?: string): SqliteProbeResult {
  const resolvedPath = resolve(databasePath ?? join(tmpdir(), 'ai-video-workspace-m0.sqlite'));
  const database = new Database(resolvedPath, {
    nativeBinding: packagedSqliteBinding as unknown as string | undefined,
  });

  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    const journalMode = String(database.pragma('journal_mode = WAL', { simple: true }));
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get() as {
      version: string;
    };

    database.exec(`
      CREATE TABLE IF NOT EXISTS m0_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checked_at TEXT NOT NULL
      )
    `);
    database
      .prepare(
        `INSERT INTO m0_probe (id, checked_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at`,
      )
      .run(new Date().toISOString());
    const row = database.prepare('SELECT checked_at FROM m0_probe WHERE id = 1').get();

    return {
      databasePath: resolvedPath,
      sqliteVersion: sqliteVersion.version,
      journalMode,
      writeVerified: Boolean(row),
    };
  } finally {
    database.close();
  }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a string.`);
  return value;
}

function requireStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value as string[];
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`);
  }
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${key} must be a number.`);
  return value;
}

const imageAssetKinds = new Set<ImageAssetKind>([
  'character',
  'scene',
  'first-frame',
  'last-frame',
  'generated-image',
]);

function optionalImageAssetKind(
  params: Record<string, unknown>,
  key: string,
): ImageAssetKind | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !imageAssetKinds.has(value as ImageAssetKind))
    throw new Error(`${key} must be a valid image asset kind.`);
  return value as ImageAssetKind;
}

export async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  const startedAt = performance.now();
  const response = await handleRequestCore(request);
  maintenanceService.recordRequest(
    request.method,
    request.id,
    response.ok,
    performance.now() - startedAt,
  );
  return response;
}

async function handleRequestCore(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (request.method === 'health') {
      const result: HealthResult = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        workerVersion: WORKER_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
      };
      return { id: request.id, protocolVersion: IPC_PROTOCOL_VERSION, ok: true, result };
    }

    if (request.method === 'sqlite.probe') {
      const params = request.params as { databasePath?: unknown };
      if (params.databasePath !== undefined && typeof params.databasePath !== 'string') {
        return errorResponse(request.id, {
          code: 'INVALID_REQUEST',
          message: 'databasePath must be a string.',
        });
      }
      return {
        id: request.id,
        protocolVersion: IPC_PROTOCOL_VERSION,
        ok: true,
        result: probeSqlite(params.databasePath),
      };
    }

    const params = validateSessionRequestParams(request.method, request.params);
    let result: unknown;
    switch (request.method) {
      case 'project.create': {
        const typedParams: ProjectCreateParams = {
          name: requireString(params, 'name'),
          rootPath: requireString(params, 'rootPath'),
        };
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        videoGenerationService.cancelAll();
        maintenanceService.resetSession();
        result = projectService.create(typedParams.rootPath, typedParams.name);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        videoGenerationService.recoverInterrupted();
        break;
      }
      case 'project.createSample': {
        const typedParams: SampleProjectCreateParams = {
          rootPath: requireString(params, 'rootPath'),
          name:
            params.name === undefined
              ? undefined
              : typeof params.name === 'string'
                ? params.name
                : (() => {
                    throw new Error('name must be a string.');
                  })(),
        };
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        videoGenerationService.cancelAll();
        maintenanceService.resetSession();
        result = sampleProjectService.create(typedParams);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        videoGenerationService.recoverInterrupted();
        break;
      }
      case 'project.open': {
        const typedParams: ProjectOpenParams = { rootPath: requireString(params, 'rootPath') };
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        videoGenerationService.cancelAll();
        maintenanceService.resetSession();
        result = projectService.open(typedParams.rootPath);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        videoGenerationService.recoverInterrupted();
        break;
      }
      case 'project.close':
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        videoGenerationService.cancelAll();
        projectService.close();
        maintenanceService.resetSession();
        result = { closed: true };
        break;
      case 'project.current':
        result = projectService.current() ?? null;
        break;
      case 'project.recent':
        result = projectService.listRecent();
        break;
      case 'project.integrity':
        result = projectService.integrity();
        break;
      case 'project.backup':
        result = {
          path: await projectService.backup(params.destinationPath as string | undefined),
        };
        break;
      case 'project.export': {
        const typedParams: ProjectExportParams = {
          destinationRoot: requireString(params, 'destinationRoot'),
        };
        result = { path: await projectService.exportProject(typedParams.destinationRoot) };
        break;
      }
      case 'project.restore': {
        const typedParams: ProjectRestoreParams = {
          backupPath: requireString(params, 'backupPath'),
          destinationRoot: requireString(params, 'destinationRoot'),
        };
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        videoGenerationService.cancelAll();
        maintenanceService.resetSession();
        result = projectService.restore(typedParams.backupPath, typedParams.destinationRoot);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        videoGenerationService.recoverInterrupted();
        break;
      }
      case 'provider.profile.list':
        result = appSettingsService.listProfiles(params.includeArchived === true);
        break;
      case 'provider.profile.get':
        result = appSettingsService.getProfile(requireString(params, 'profileId'));
        break;
      case 'provider.profile.create':
        result = appSettingsService.createProfile(params as unknown as ProviderProfileCreateParams);
        break;
      case 'provider.profile.update':
        result = appSettingsService.updateProfile(params as unknown as ProviderProfileUpdateParams);
        break;
      case 'provider.profile.archive':
        result = appSettingsService.archiveProfile(requireString(params, 'profileId'));
        break;
      case 'provider.profile.migrateLegacy':
        result = appSettingsService.migrateLegacyProfile(
          params as unknown as ProviderLegacyMigrationParams,
        );
        break;
      case 'provider.definition.list':
        result = appSettingsService.listProviderDefinitions();
        break;
      case 'provider.connection.begin':
        result = appSettingsService.beginConnectionTest(requireString(params, 'profileId'));
        break;
      case 'provider.connection.complete':
        result = appSettingsService.completeConnectionTest(
          params as unknown as ProviderConnectionCompleteParams,
        );
        break;
      case 'provider.model.list':
        result = appSettingsService.listModels(requireString(params, 'profileId'));
        break;
      case 'provider.model.createManual':
        result = appSettingsService.createManualModel(
          params as unknown as ProviderModelCreateParams,
        );
        break;
      case 'provider.model.update':
        result = appSettingsService.updateModel(params as unknown as ProviderModelUpdateParams);
        break;
      case 'provider.model.pricing.list':
        result = appSettingsService.listModelPricing(requireString(params, 'profileId'));
        break;
      case 'provider.model.pricing.update':
        result = appSettingsService.updateModelPricing(
          params as unknown as ModelPricingUpdateParams,
        );
        break;
      case 'provider.default.list':
        result = appSettingsService.listProviderDefaults();
        break;
      case 'provider.default.update':
        result = appSettingsService.updateProviderDefault(
          params as unknown as ProviderDefaultUpdateParams,
        );
        break;
      case 'usage.list':
        result = usageService.list(params as unknown as UsageQueryParams);
        break;
      case 'usage.rebuild':
        result = usageService.rebuild();
        break;
      case 'maintenance.cache.inspect':
        result = maintenanceService.inspectCache();
        break;
      case 'maintenance.cache.clear':
        result = maintenanceService.clearCache();
        break;
      case 'maintenance.metrics':
        result = maintenanceService.getMetrics();
        break;
      case 'maintenance.contextSnapshots.cleanup':
        result = maintenanceService.cleanupContextSnapshots(params);
        break;
      case 'maintenance.diagnostics.export': {
        const typedParams: DiagnosticExportParams = {
          destinationRoot:
            params.destinationRoot === undefined
              ? undefined
              : typeof params.destinationRoot === 'string'
                ? params.destinationRoot
                : (() => {
                    throw new Error('destinationRoot must be a string.');
                  })(),
        };
        result = maintenanceService.exportDiagnostics(typedParams);
        break;
      }
      case 'maintenance.diagnostics.reveal':
        result = maintenanceService.revealDiagnostics(requireString(params, 'path'));
        break;
      case 'document.list':
        result = documentWorkflowService.listDocuments();
        break;
      case 'document.get':
        result = documentWorkflowService.getDocument(requireString(params, 'documentId'));
        break;
      case 'document.save':
        result = contentService.saveDocument(params as unknown as DocumentSaveParams);
        break;
      case 'document.draft.save':
        result = documentWorkflowService.saveDraft(params as unknown as DocumentDraftSaveParams);
        break;
      case 'document.versions':
        result = documentWorkflowService.listVersions(requireString(params, 'documentId'));
        break;
      case 'document.restore':
        result = contentService.restoreDocument(params as unknown as DocumentRestoreParams);
        break;
      case 'document.review.submit':
        result = documentWorkflowService.submitReview(
          params as unknown as DocumentReviewSubmitParams,
        );
        break;
      case 'document.review.requestChanges':
        result = documentWorkflowService.requestChanges(
          params as unknown as DocumentReviewRequestChangesParams,
        );
        break;
      case 'document.review.reject':
        result = documentWorkflowService.rejectReview(
          params as unknown as DocumentReviewRejectParams,
        );
        break;
      case 'document.publish':
        result = documentWorkflowService.publish(params as unknown as DocumentPublishParams);
        break;
      case 'agent.task.createDocumentDraft':
        result = documentWorkflowService.createDocumentDraftFromMessage(
          params as unknown as AgentTaskCreateDocumentDraftParams,
        );
        break;
      case 'agent.task.list':
        result = documentWorkflowService.listTasks(params);
        break;
      case 'agent.task.get':
        result = documentWorkflowService.getTask(params as unknown as AgentTaskGetParams);
        break;
      case 'task.log.list':
        result = documentWorkflowService.listTaskLog(params);
        break;
      case 'scene.list':
        result = contentService.listScenes();
        break;
      case 'scene.save':
        result = contentService.saveScene(params as unknown as SceneSaveParams);
        break;
      case 'shot.list':
        result = contentService.listShots(requireString(params, 'sceneId'));
        break;
      case 'shot.save':
        result = contentService.saveShot(params as unknown as ShotSaveParams);
        break;
      case 'conversation.list':
        result = contentService.listConversations(params);
        break;
      case 'conversation.create':
        result = contentService.createConversation(params as unknown as ConversationCreateParams);
        break;
      case 'conversation.update':
        result = contentService.updateConversation(params as unknown as ConversationUpdateParams);
        break;
      case 'conversation.archive':
        result = contentService.archiveConversation(params as unknown as ConversationArchiveParams);
        break;
      case 'conversation.restore':
        result = contentService.restoreConversation(params as unknown as ConversationRestoreParams);
        break;
      case 'chat.message.list':
        result = contentService.listMessages(params as unknown as ChatMessageListParams);
        break;
      case 'chat.message.save':
        result = contentService.saveMessage(params as unknown as ChatMessageSaveParams);
        break;
      case 'chat.message.toDocument':
        result = contentService.messageToDocument(params as unknown as MessageDocumentParams);
        break;
      case 'chat.message.toMemory':
        result = contentService.messageToMemory(requireString(params, 'messageId'));
        break;
      case 'chat.message.toConstraint':
        result = contentService.messageToConstraint(params as unknown as MessageConstraintParams);
        break;
      case 'context.preview':
        result = contextService.preview(
          requireString(params, 'conversationId'),
          optionalNumber(params, 'budgetTokens'),
        );
        break;
      case 'llm.status':
        result = generationService.status();
        break;
      case 'llm.generate':
        result = generationService.generate(
          requireString(params, 'conversationId'),
          requireString(params, 'prompt'),
          optionalNumber(params, 'budgetTokens'),
          typeof params.idempotencyKey === 'string' ? params.idempotencyKey : undefined,
        );
        break;
      case 'llm.generation.prepare':
        result = generationService.prepare(params as unknown as LlmGenerationPrepareParams);
        break;
      case 'llm.generation.runtime':
        result = generationService.runtime(params as unknown as LlmGenerationIdentity);
        break;
      case 'llm.generation.observe':
        result = generationService.observe(params as unknown as LlmGenerationObserveParams);
        break;
      case 'llm.generation.complete':
        result = generationService.complete(params as unknown as LlmGenerationCompleteParams);
        break;
      case 'llm.generation.fail':
        result = generationService.failNative(params as unknown as LlmGenerationFailParams);
        break;
      case 'llm.generation.get':
        result = generationService.get(requireString(params, 'generationId'));
        break;
      case 'llm.generation.cancel':
        result = await generationService.cancel(requireString(params, 'generationId'));
        break;
      case 'llm.generation.retry':
        result = generationService.retry({
          assistantMessageId: requireString(params, 'assistantMessageId'),
          budgetTokens: optionalNumber(params, 'budgetTokens'),
          idempotencyKey:
            typeof params.idempotencyKey === 'string' ? params.idempotencyKey : undefined,
        });
        break;
      case 'llm.generation.retryPrepare':
        result = generationService.retryPrepare(
          params as unknown as LlmGenerationRetryPrepareParams,
        );
        break;
      case 'adapter.catalog':
        result = adapterService.catalog();
        break;
      case 'adapter.resolve':
        result = adapterService.resolve(params as unknown as AdapterResolveParams);
        break;
      case 'adapter.validate':
        result = adapterService.validate(params as unknown as AdapterValidateParams);
        break;
      case 'generation.draft.get':
        result = adapterService.getDraft(params as unknown as GenerationDraftGetParams);
        break;
      case 'generation.draft.save':
        result = adapterService.saveDraft(params as unknown as GenerationDraftSaveParams);
        break;
      case 'image.generate.prepare':
        result = imageGenerationService.prepare(params as unknown as ImageGenerationPrepareParams);
        break;
      case 'image.generate.complete':
        result = await imageGenerationService.complete({
          ...(params as unknown as ImageGenerationCompleteParams),
          jobId: requireString(params, 'jobId'),
          assetKind: optionalImageAssetKind(params, 'assetKind'),
          saveAsset: typeof params.saveAsset === 'boolean' ? params.saveAsset : undefined,
        });
        break;
      case 'image.generate.savePreview':
        result = imageGenerationService.savePreview({
          jobId: requireString(params, 'jobId'),
          dataUrl: requireString(params, 'dataUrl'),
          contentType: requireString(params, 'contentType'),
          assetKind: optionalImageAssetKind(params, 'assetKind'),
        } satisfies ImageGenerationSavePreviewParams);
        break;
      case 'image.generate.fail':
        result = imageGenerationService.failTransport(requireString(params, 'jobId'));
        break;
      case 'image.generate.cancel':
        result = imageGenerationService.cancel(requireString(params, 'jobId'));
        break;
      case 'image.generate.get':
        result = imageGenerationService.get(requireString(params, 'jobId'));
        break;
      case 'video.generate.prepare':
        result = videoGenerationService.prepare({
          ...(params as unknown as VideoGenerationPrepareParams),
          adapterKey: requireString(params, 'adapterKey'),
          assetKind: optionalVideoAssetKind(params, 'assetKind'),
        });
        break;
      case 'video.generate.attachTask':
        result = videoGenerationService.attachTask({
          jobId: requireString(params, 'jobId'),
          providerTaskId: requireString(params, 'providerTaskId'),
        } satisfies VideoGenerationAttachTaskParams);
        break;
      case 'video.generate.observe':
        result = videoGenerationService.observe({
          jobId: requireString(params, 'jobId'),
          providerTaskId: requireString(params, 'providerTaskId'),
          providerStatus: requireNumber(params, 'providerStatus'),
          providerBody: params.providerBody,
        } satisfies VideoGenerationObserveParams);
        break;
      case 'video.generate.fail':
        result = videoGenerationService.fail({
          jobId: requireString(params, 'jobId'),
          failureKind: requireVideoFailureKind(params, 'failureKind'),
          message: typeof params.message === 'string' ? params.message : undefined,
        } satisfies VideoGenerationFailParams);
        break;
      case 'video.generate.pause':
        result = videoGenerationService.pause(requireString(params, 'jobId'));
        break;
      case 'video.generate.resume':
        result = videoGenerationService.resume(requireString(params, 'jobId'));
        break;
      case 'video.generate.timeout':
        result = videoGenerationService.timeout(requireString(params, 'jobId'));
        break;
      case 'video.generate.cancel':
        result = videoGenerationService.cancel(requireString(params, 'jobId'));
        break;
      case 'video.generate.get':
        result = videoGenerationService.get(requireString(params, 'jobId'));
        break;
      case 'video.generate.list':
        result = videoGenerationService.list();
        break;
      case 'asset.list':
        result = imageGenerationService.listAssets({
          kind: typeof params.kind === 'string' ? params.kind : undefined,
          keyword: typeof params.keyword === 'string' ? params.keyword : undefined,
          deleted: params.deleted === 'trash' ? 'trash' : 'active',
          createdFrom: typeof params.createdFrom === 'string' ? params.createdFrom : undefined,
          createdTo: typeof params.createdTo === 'string' ? params.createdTo : undefined,
          limit: typeof params.limit === 'number' ? params.limit : undefined,
          tagIds: Array.isArray(params.tagIds)
            ? params.tagIds.filter((x): x is string => typeof x === 'string')
            : undefined,
          sort: params.sort === 'created-desc' ? 'created-desc' : 'created-asc',
          cursor: typeof params.cursor === 'string' ? params.cursor : undefined,
        });
        break;
      case 'asset.preview':
        result = imageGenerationService.previewAsset({
          assetId: requireString(params, 'assetId'),
        } satisfies AssetPreviewParams);
        break;
      case 'asset.mediaSource':
        result = imageGenerationService.assetMediaSource({
          assetId: requireString(params, 'assetId'),
        } satisfies AssetMediaSourceParams);
        break;
      case 'asset.open':
        result = imageGenerationService.openAsset({
          assetId: requireString(params, 'assetId'),
        } satisfies AssetOpenParams);
        break;
      case 'asset.reveal':
        result = imageGenerationService.revealAsset({
          assetId: requireString(params, 'assetId'),
        } satisfies AssetRevealParams);
        break;
      case 'asset.rename':
        result = imageGenerationService.renameAsset(params as unknown as AssetRenameParams);
        break;
      case 'asset.alias.update':
        result = imageGenerationService.updateAssetAlias(
          params as unknown as AssetAliasUpdateParams,
        );
        break;
      case 'asset.delete':
        result = imageGenerationService.deleteAsset(
          requireString(params, 'assetId'),
          params.confirm === true,
        );
        break;
      case 'asset.restore':
        result = imageGenerationService.restoreAsset(requireString(params, 'assetId'));
        break;
      case 'asset.purge':
        result = imageGenerationService.purgeAsset(
          requireString(params, 'assetId'),
          params.confirm === true,
        );
        break;
      case 'asset.source.locate':
        result = imageGenerationService.locateAssetSource(requireString(params, 'assetId'));
        break;
      case 'tag.list':
        result = imageGenerationService.listTags(
          typeof params.keyword === 'string' ? params.keyword : undefined,
        );
        break;
      case 'tag.create':
        result = imageGenerationService.createTag(requireString(params, 'name'));
        break;
      case 'tag.update':
        result = imageGenerationService.updateTag(
          requireString(params, 'tagId'),
          requireString(params, 'name'),
        );
        break;
      case 'tag.delete':
        result = imageGenerationService.deleteTag(requireString(params, 'tagId'));
        break;
      case 'asset.tags.replace':
        result = imageGenerationService.replaceAssetTags(
          requireStringArray(params, 'assetIds'),
          requireStringArray(params, 'tagIds'),
        );
        break;
      case 'asset.tags.add':
        result = imageGenerationService.changeAssetTags(
          requireStringArray(params, 'assetIds'),
          requireStringArray(params, 'tagIds'),
          'add',
        );
        break;
      case 'asset.tags.remove':
        result = imageGenerationService.changeAssetTags(
          requireStringArray(params, 'assetIds'),
          requireStringArray(params, 'tagIds'),
          'remove',
        );
        break;
      case 'assetGroup.list':
        result = imageGenerationService.listGroups(
          typeof params.keyword === 'string' ? params.keyword : undefined,
        );
        break;
      case 'assetGroup.create':
        result = imageGenerationService.createGroup(
          requireString(params, 'name'),
          requireStringArray(params, 'tagIds'),
        );
        break;
      case 'assetGroup.update':
        result = imageGenerationService.updateGroup(
          requireString(params, 'groupId'),
          requireString(params, 'name'),
          requireStringArray(params, 'tagIds'),
        );
        break;
      case 'assetGroup.delete':
        result = imageGenerationService.deleteGroup(requireString(params, 'groupId'));
        break;
      case 'assetGroup.resolve':
        result = imageGenerationService.resolveGroup(requireString(params, 'groupId'));
        break;
      default:
        return errorResponse(request.id, {
          code: 'METHOD_NOT_FOUND',
          message: 'Unknown worker method.',
        });
    }

    return {
      id: request.id,
      protocolVersion: IPC_PROTOCOL_VERSION,
      ok: true,
      result,
    } as WorkerResponse;
  } catch (error) {
    recordWorkerError(request.method, error);
    return errorResponse(request.id, mapWorkerError(request.method, error));
  }
}

function mapWorkerError(operation: string, error: unknown): WorkerError {
  const message = error instanceof Error ? error.message : 'Unexpected worker error.';
  if (error instanceof RequestValidationError) {
    return { code: 'INVALID_REQUEST', message, retryable: false, operation };
  }
  if (error instanceof DocumentWorkflowError) {
    return {
      code: error.code,
      message,
      retryable: false,
      operation,
    };
  }
  if (error instanceof AdapterNotFoundError) {
    return { code: 'ADAPTER_NOT_FOUND', message, retryable: false, operation };
  }
  if (error instanceof InvalidAdapterParametersError) {
    return {
      code: 'INVALID_PARAMETERS',
      message,
      retryable: false,
      operation,
      details: error.validation.errors,
    };
  }
  if (error instanceof ProviderProfileValidationError) {
    return { code: 'INVALID_PARAMETERS', message, retryable: false, operation };
  }
  if (error instanceof LlmProviderError) {
    return {
      code: error.code === 'NOT_CONFIGURED' ? 'LLM_NOT_CONFIGURED' : 'LLM_REQUEST_FAILED',
      message,
      retryable: error.retryable,
      operation,
    };
  }
  if (/read-only/i.test(message)) {
    return { code: 'PROJECT_READ_ONLY', message, retryable: false, operation };
  }
  if (/already open for writing|project is already open/i.test(message)) {
    return { code: 'PROJECT_LOCKED', message, retryable: true, operation };
  }
  if (/stale .*callback|session changed|out-of-order/i.test(message)) {
    return { code: 'STALE_SESSION', message, retryable: false, operation };
  }
  if (/was not found|not found/i.test(message)) {
    return { code: 'NOT_FOUND', message, retryable: false, operation };
  }
  if (/no longer available|invalid state|terminal state/i.test(message)) {
    return { code: 'INVALID_STATE', message, retryable: false, operation };
  }
  if (/already exists|conflict/i.test(message)) {
    return { code: 'CONFLICT', message, retryable: false, operation };
  }
  return { code: 'INTERNAL_ERROR', message, retryable: true, operation };
}

function optionalVideoAssetKind(
  params: Record<string, unknown>,
  key: string,
): VideoAssetKind | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (value === 'generated-video' || value === 'shot-video') return value;
  throw new Error(`${key} must be a supported video asset kind.`);
}

function requireVideoFailureKind(
  params: Record<string, unknown>,
  key: string,
): VideoGenerationFailureKind {
  const value = requireString(params, key);
  if (['transport', 'provider', 'download', 'interrupted', 'timeout'].includes(value)) {
    return value as VideoGenerationFailureKind;
  }
  throw new Error(`${key} must be a supported video failure kind.`);
}
