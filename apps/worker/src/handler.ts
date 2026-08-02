import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  IPC_PROTOCOL_VERSION,
  type ChatMessageListParams,
  type ChatMessageSaveParams,
  type AdapterResolveParams,
  type AdapterValidateParams,
  type ConversationCreateParams,
  type DocumentRestoreParams,
  type DocumentSaveParams,
  type ImageAssetKind,
  type HealthResult,
  type GenerationDraftGetParams,
  type GenerationDraftSaveParams,
  type ImageGenerationPrepareParams,
  type ImageGenerationCompleteParams,
  type ImageGenerationSavePreviewParams,
  type AssetPreviewParams,
  type AssetRevealParams,
  type AssetRenameParams,
  type ProjectCreateParams,
  type ProjectExportParams,
  type ProjectOpenParams,
  type ProjectRestoreParams,
  type MessageConstraintParams,
  type MessageDocumentParams,
  type SceneSaveParams,
  type ShotSaveParams,
  type SqliteProbeResult,
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
import { GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';

const WORKER_VERSION = '0.1.0';
const methods = new Set<WorkerMethod>([
  'health',
  'sqlite.probe',
  'project.create',
  'project.open',
  'project.close',
  'project.current',
  'project.recent',
  'project.integrity',
  'project.backup',
  'project.export',
  'project.restore',
  'document.list',
  'document.get',
  'document.save',
  'document.versions',
  'document.restore',
  'scene.list',
  'scene.save',
  'shot.list',
  'shot.save',
  'conversation.list',
  'conversation.create',
  'chat.message.list',
  'chat.message.save',
  'chat.message.toDocument',
  'chat.message.toMemory',
  'chat.message.toConstraint',
  'context.preview',
  'llm.status',
  'llm.generate',
  'llm.generation.get',
  'llm.generation.cancel',
  'llm.generation.retry',
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
  'asset.list',
  'asset.preview',
  'asset.reveal',
  'asset.rename',
  'asset.delete',
]);
const isPackaged = 'pkg' in process;
// A literal require lets pkg discover and extract the native addon from the executable.
const packagedSqliteBinding = isPackaged
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('better-sqlite3/build/Release/better_sqlite3.node') as object)
  : undefined;
const projectService = new ProjectService({ nativeBinding: packagedSqliteBinding });
const contentService = new ContentService(projectService);
const adapterService = new AdapterService(projectService);
const imageGenerationService = new ImageGenerationService(projectService);
const contextService = new ContextService(projectService);
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
);

function errorResponse(id: string, error: WorkerError): WorkerResponse {
  return { id, protocolVersion: IPC_PROTOCOL_VERSION, ok: false, error };
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

    const params = request.params as Record<string, unknown>;
    let result: unknown;
    switch (request.method) {
      case 'project.create': {
        const typedParams: ProjectCreateParams = {
          name: requireString(params, 'name'),
          rootPath: requireString(params, 'rootPath'),
        };
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        result = projectService.create(typedParams.rootPath, typedParams.name);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        break;
      }
      case 'project.open': {
        const typedParams: ProjectOpenParams = { rootPath: requireString(params, 'rootPath') };
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        result = projectService.open(typedParams.rootPath);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        break;
      }
      case 'project.close':
        await generationService.cancelAll();
        imageGenerationService.cancelAll();
        projectService.close();
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
        result = projectService.restore(typedParams.backupPath, typedParams.destinationRoot);
        generationService.recoverInterrupted();
        imageGenerationService.recoverInterrupted();
        break;
      }
      case 'document.list':
        result = contentService.listDocuments();
        break;
      case 'document.get':
        result = contentService.getDocument(requireString(params, 'documentId'));
        break;
      case 'document.save':
        result = contentService.saveDocument(params as unknown as DocumentSaveParams);
        break;
      case 'document.versions':
        result = contentService.listDocumentVersions(requireString(params, 'documentId'));
        break;
      case 'document.restore':
        result = contentService.restoreDocument(params as unknown as DocumentRestoreParams);
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
        );
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
        });
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
      case 'asset.list':
        result = imageGenerationService.listAssets({
          kind: typeof params.kind === 'string' ? params.kind : undefined,
        });
        break;
      case 'asset.preview':
        result = imageGenerationService.previewAsset({
          assetId: requireString(params, 'assetId'),
        } satisfies AssetPreviewParams);
        break;
      case 'asset.reveal':
        result = imageGenerationService.revealAsset({
          assetId: requireString(params, 'assetId'),
        } satisfies AssetRevealParams);
        break;
      case 'asset.rename':
        result = imageGenerationService.renameAsset(params as unknown as AssetRenameParams);
        break;
      case 'asset.delete':
        result = imageGenerationService.deleteAsset(requireString(params, 'assetId'));
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
    return errorResponse(request.id, {
      code:
        error instanceof AdapterNotFoundError
          ? 'ADAPTER_NOT_FOUND'
          : error instanceof InvalidAdapterParametersError
            ? 'INVALID_PARAMETERS'
            : error instanceof LlmProviderError
              ? error.code === 'NOT_CONFIGURED'
                ? 'LLM_NOT_CONFIGURED'
                : 'LLM_REQUEST_FAILED'
              : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unexpected worker error.',
      details: error instanceof InvalidAdapterParametersError ? error.validation.errors : undefined,
    });
  }
}
