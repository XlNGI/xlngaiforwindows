import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  IPC_PROTOCOL_VERSION,
  type ChatMessageListParams,
  type ChatMessageSaveParams,
  type AgentTaskCreateDocumentDraftParams,
  type AgentGenerationPrepareParams,
  type AgentDocumentIntent,
  type UnifiedAgentRunParams,
  type UnifiedAgentCapability,
  type UnifiedAgentModelCandidate,
  type UnifiedAgentModelCatalogListParams,
  type UnifiedAgentModelCatalogGetParams,
  type UnifiedAgentModelSchemaInfo,
  type AdapterDescriptor,
  type UnifiedAgentAdapterSchemaProposeParams,
  type UnifiedAgentAdapterSchemaConfirmParams,
  type UnifiedAgentAdapterSchemaRollbackParams,
  type UnifiedAgentAdapterSchemaAuditListParams,
  type AgentGenerationExecuteToolsParams,
  type AgentGenerationConfirmToolParams,
  type AgentProviderStepCompleteParams,
  type AgentProviderStepStartParams,
  type AgentTaskGetParams,
  type AgentTaskEventsParams,
  type GenerationJobEventsListParams,
  type GenerationJobEventsPage,
  type GenerationJobEventInfo,
  type AdapterResolveParams,
  type AdapterValidateParams,
  type ConversationArchiveParams,
  type ConversationCreateParams,
  type ConversationRestoreParams,
  type ConversationUpdateParams,
  type ConversationModelPreferenceGetParams,
  type ConversationModelPreferenceSetParams,
  type ConversationModelPreferenceClearParams,
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
  type VideoProviderRegion,
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
  type MessageConstraintParams,
  type MessageDocumentParams,
  type LlmGenerationCompleteParams,
  type LlmGenerationFailParams,
  type LlmGenerationIdentity,
  type LlmGenerationObserveParams,
  type LlmGenerationPrepareParams,
  type LlmGenerationRetryPrepareParams,
  type NovelBindingSaveParams,
  type NovelPendingIntentCancelParams,
  type AgentPartialArtifactRecoverParams,
  type AgentPartialArtifactDiscardParams,
  type NovelChapterArchiveParams,
  type NovelChapterRestoreParams,
  type NovelChapterSaveParams,
  type NovelImportParams,
  type NovelProfileUpdateParams,
  type NovelVolumeSaveParams,
  type NovelMarkdownExportPrepareParams,
  type SceneSaveParams,
  type ShotSaveParams,
  ShotStoryboardSaveParams,
  type AgentChangeSetCreateParams,
  type AgentChangeSetApplyParams,
  type AgentChangeSetRejectParams,
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
import { NovelContextService } from './novel-context-service.js';
import { DocumentWorkflowError, DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { VideoGenerationService } from './video-generation-service.js';
import { MaintenanceService } from './maintenance-service.js';
import { SampleProjectService } from './sample-project-service.js';
import {
  AdapterSchemaValidationError,
  AppSettingsService,
  ProviderProfileValidationError,
} from './app-settings-service.js';
import { AgentProviderCapabilityError, assertAgentToolLoopSelection } from './provider-registry.js';
import { UsageService } from './usage-service.js';
import { RequestValidationError, validateSessionRequestParams } from './request-validation.js';
import { executeInfrastructureCommand } from './worker-commands.js';
import {
  AgentProviderLoopService,
  type AgentSchemaManager,
} from './agent-provider-loop-service.js';
import { NovelService, NovelServiceError } from './novel-service.js';
import {
  AgentOrchestrationError,
  AgentOrchestrationService,
} from './agent-orchestration-service.js';
import { PartialArtifactService } from './partial-artifact-service.js';
import { MarkdownExportService } from './markdown-export-service.js';
import { ChangeSetService } from './change-set-service.js';
import type { ConversationRuntimeStartParams } from '@ai-video/contracts';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import { DomainToolGateway } from './domain-tool-gateway.js';
import { TaskPlanService } from './task-plan-service.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
import { resolvePiConversationRuntimeEnabled } from './conversation-runtime.js';
import { getAdapter, setAdapterOverrides } from '@ai-video/generation-adapters';
import { createRepositories } from '@ai-video/persistence';

const WORKER_VERSION = '0.1.0';

export function inferUnifiedAgentCapability(prompt: string): UnifiedAgentCapability {
  const value = prompt.normalize('NFC');
  if (/(搜索|查找|联网|最新资料|网页|研究)/u.test(value)) return 'research';
  // A direct request to render an image must win over the generic document
  // keywords. Requests such as “生成角色三视图提示词” remain document work,
  // while “直接生成角色三视图” is an image-generation task.
  if (
    /(?:生成|制作|创建|绘制|画出|画一张)/u.test(value) &&
    /(图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)/u.test(value) &&
    !/(提示词|prompt|文档)/iu.test(value)
  )
    return 'image';
  if (/(改写|重写|润色|总结|提取|分析|识别|描述|转写|翻译|提示词)/u.test(value)) return 'document';
  if (
    /(文生视频|图生视频|参考生视频|首尾帧(?:生|生成)?视频|生成(?:一段|一个|该|这个)?视频|制作(?:一段|一个|该|这个)?视频|创建(?:一段|一个|该|这个)?视频|输出视频|做成视频)/u.test(
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

/** Resolve the Provider route from the user-selected profile, never from a
 * generic media default. The profile's base URL is part of its protected
 * connection configuration and therefore authoritative for region routing. */
export function resolveMediaProviderRegion(profile: {
  providerType: string;
  baseUrl: string;
}): VideoProviderRegion {
  if (profile.providerType === 'unicompapi') return 'unicompapi';
  if (profile.providerType === 'vidu' && profile.baseUrl === 'https://api.vidu.cn') return 'cn';
  return 'global';
}

/**
 * Validate the complete user-selected media tuple at every Worker entrypoint.
 * The UI is allowed to send either a local model ID or a remote model ID for
 * compatibility with older callers, but the resulting task always stores the
 * canonical local ID. No provider, model, adapter, or region is inferred.
 */
function resolveMediaSelectionForRequest(
  capability: 'image' | 'video',
  adapterKey: string,
  providerProfileId: string | undefined,
  modelId: string | undefined,
  requestedRegion?: VideoProviderRegion,
): {
  profile: ReturnType<AppSettingsService['listProfiles']>[number];
  model: ReturnType<AppSettingsService['listModels']>[number];
  adapter: AdapterDescriptor;
  providerRegion: VideoProviderRegion;
} {
  if (!providerProfileId || !modelId) {
    throw new ProviderProfileValidationError(
      'Provider profile and model are required for media generation.',
    );
  }
  const profile = appSettingsService.getProfile(providerProfileId);
  if (!profile) throw new ProviderProfileValidationError('Provider profile was not found.');
  if (!profile.enabled || profile.connectionStatus !== 'ready') {
    throw new ProviderProfileValidationError(
      'Select an enabled provider connection that passed its connectivity test.',
    );
  }
  const supportedProfile =
    (profile.providerType === 'vidu' && profile.protocol === 'vidu-v2') ||
    (profile.providerType === 'unicompapi' && profile.protocol === 'openai-chat-completions');
  if (!supportedProfile) {
    throw new ProviderProfileValidationError(
      'The selected provider does not support media generation.',
    );
  }
  const model = appSettingsService
    .listModels(profile.id)
    .find((candidate) => candidate.id === modelId || candidate.remoteModelId === modelId);
  if (!model) throw new ProviderProfileValidationError('Provider model was not found.');
  if (!model.enabled || model.unavailableAt) {
    throw new ProviderProfileValidationError('Select an enabled and available media model.');
  }
  const adapter = adapterService
    .catalog()
    .adapters.find((candidate) => candidate.key === adapterKey);
  if (!adapter) throw new AdapterNotFoundError(`Adapter ${adapterKey} was not found.`);
  if (adapter.provider !== profile.providerType || adapter.model !== model.remoteModelId) {
    throw new ProviderProfileValidationError(
      'The selected provider, model, and adapter do not match.',
    );
  }
  if (capability === 'image') {
    if (!adapter.capability.endsWith('TO_IMAGE')) {
      throw new ProviderProfileValidationError('The selected adapter is not an image generator.');
    }
    const supportsImage =
      adapter.capability === 'REFERENCE_TO_IMAGE'
        ? model.capabilities.imageEditing === true || model.capabilities.imageGeneration === true
        : model.capabilities.imageGeneration === true;
    if (!supportsImage) {
      throw new ProviderProfileValidationError(
        'The selected model does not support this image adapter.',
      );
    }
  } else {
    if (!adapter.capability.endsWith('TO_VIDEO') || model.capabilities.videoGeneration !== true) {
      throw new ProviderProfileValidationError(
        'The selected model does not support this video adapter.',
      );
    }
  }
  const schemaRecord = appSettingsService.getAdapterSchemaRecord(adapter.key);
  if (schemaRecord?.status === 'needs_confirmation') {
    throw new AdapterSchemaValidationError(
      'This adapter schema is awaiting confirmation and cannot be submitted yet.',
    );
  }
  const providerRegion = resolveMediaProviderRegion(profile);
  if (requestedRegion !== undefined && requestedRegion !== providerRegion) {
    throw new ProviderProfileValidationError(
      'The selected provider profile does not match the requested region.',
    );
  }
  return { profile, model, adapter, providerRegion };
}

/**
 * Map read-only schema questions onto the controlled Agent tool loop.
 *
 * This intentionally stays conservative: only an explicit inspection-style
 * request containing schema/parameter vocabulary is classified as a schema
 * query. Everything else keeps the normal document-draft default.
 */
export function inferAgentDocumentIntent(prompt: string): AgentDocumentIntent {
  const value = prompt.normalize('NFC').trim();
  const mentionsSchema = /(schema|参数|字段|配置项|输入项|接口定义|能力描述)/iu.test(value);
  const asksToInspect =
    /(?:查看|查询|查一下|了解|支持哪些|有哪些|哪些|什么|列出|获取|inspect|show|get|list|what|which)/iu.test(
      value,
    );
  if (mentionsSchema && /(?:历史|审计|记录|版本|history|audit|changes)/iu.test(value)) {
    return { operation: 'adapter.schema.audit.list' };
  }
  if (
    mentionsSchema &&
    /(?:添加|新增|修改|更新|补充|调整|add|update|modify|change)/iu.test(value)
  ) {
    return { operation: 'adapter.schema.propose' };
  }
  return mentionsSchema && asksToInspect
    ? { operation: 'adapter.schema.get' }
    : { operation: 'document.create_draft' };
}

function capabilityMatchesModel(
  capability: UnifiedAgentCapability,
  model: {
    capabilities: {
      text: boolean;
      streaming: boolean;
      tools: boolean;
      imageGeneration: boolean;
      imageEditing?: boolean;
      videoGeneration: boolean;
    };
  },
): boolean {
  if (capability === 'image')
    return model.capabilities.imageGeneration === true || model.capabilities.imageEditing === true;
  if (capability === 'video') return model.capabilities.videoGeneration === true;
  return (
    model.capabilities.text === true &&
    model.capabilities.streaming === true &&
    model.capabilities.tools === true
  );
}

/**
 * Applies the media-input rules used by the unified Agent model picker.
 * Vision is required for image understanding, while reference media is
 * matched against a dedicated generation adapter (for example
 * REFERENCE_TO_IMAGE or IMAGE_TO_VIDEO).
 */
export function modelMatchesUnifiedAgentRequest(
  capability: UnifiedAgentCapability,
  model: {
    enabled: boolean;
    unavailableAt?: string | null;
    remoteModelId: string;
    capabilities: {
      text: boolean;
      streaming: boolean;
      tools: boolean;
      vision?: boolean;
      imageGeneration: boolean;
      imageEditing?: boolean;
      videoGeneration: boolean;
    };
  },
  providerType: string,
  adapters: readonly { provider: string; model: string; capability: string }[],
  hasImageAttachment: boolean,
): boolean {
  if (!model.enabled || model.unavailableAt) return false;
  if (hasImageAttachment && capability !== 'image' && capability !== 'video') {
    if (model.capabilities.vision !== true) return false;
  }
  if (!capabilityMatchesModel(capability, model)) return false;
  if (!hasImageAttachment || (capability !== 'image' && capability !== 'video')) return true;

  const providerSupportsReference = adapters.some(
    (adapter) =>
      adapter.provider === providerType &&
      adapter.model === model.remoteModelId &&
      (capability === 'image'
        ? adapter.capability === 'REFERENCE_TO_IMAGE'
        : adapter.capability === 'IMAGE_TO_VIDEO' || adapter.capability === 'REFERENCE_TO_VIDEO'),
  );
  return capability === 'image'
    ? model.capabilities.imageEditing === true || providerSupportsReference
    : providerSupportsReference;
}

function adapterMatchesCapability(
  adapter: { provider: string; model: string; capability: string },
  providerType: string,
  remoteModelId: string,
  capability: UnifiedAgentCapability | undefined,
): boolean {
  if (adapter.provider !== providerType || adapter.model !== remoteModelId) return false;
  if (!capability || capability === 'auto') return true;
  if (capability === 'image') return adapter.capability.endsWith('TO_IMAGE');
  if (capability === 'video') return adapter.capability.endsWith('TO_VIDEO');
  return false;
}

function toModelSchemaInfo(
  profile: ReturnType<typeof appSettingsService.listProfiles>[number],
  model: ReturnType<typeof appSettingsService.listModels>[number],
  adapters: ReturnType<typeof adapterService.catalog>['adapters'],
  capability?: UnifiedAgentCapability,
): UnifiedAgentModelSchemaInfo {
  const matchingAdapters = adapters.filter((adapter) =>
    adapterMatchesCapability(adapter, profile.providerType, model.remoteModelId, capability),
  );
  const persistedForModel = appSettingsService.listAdapterSchemaRecords().flatMap((record) => {
    try {
      const descriptor = JSON.parse(record.descriptorJson) as AdapterDescriptor;
      return descriptor.provider === profile.providerType &&
        descriptor.model === model.remoteModelId
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
  const pendingSchema =
    matchingAdapters.some(
      (adapter) =>
        appSettingsService.getAdapterSchemaRecord(adapter.key)?.status === 'needs_confirmation',
    ) || persistedForModel.some((record) => record.status === 'needs_confirmation');
  const manualSchema =
    matchingAdapters.some(
      (adapter) => appSettingsService.getAdapterSchemaRecord(adapter.key)?.source === 'manual',
    ) || persistedForModel.some((record) => record.source === 'manual');
  const schemaRelevant = capability === 'image' || capability === 'video';
  const required = [
    ...new Set(matchingAdapters.flatMap((adapter) => adapter.parameterSchema.required)),
  ];
  return {
    providerProfileId: profile.id,
    providerName: profile.name,
    providerType: profile.providerType,
    modelId: model.id,
    remoteModelId: model.remoteModelId,
    modelName: model.displayName,
    modelCapabilities: model.capabilities,
    modelSource: model.source,
    modelEnabled: model.enabled,
    modelUnavailableAt: model.unavailableAt,
    schemaStatus: !schemaRelevant
      ? 'confirmed'
      : pendingSchema
        ? 'needs_confirmation'
        : matchingAdapters.length > 0
          ? 'confirmed'
          : 'missing',
    schemaSource: !schemaRelevant
      ? 'official-adapter'
      : pendingSchema || manualSchema
        ? 'manual'
        : matchingAdapters.length > 0
          ? 'official-adapter'
          : 'missing',
    adapters: matchingAdapters,
    missingRequired: required,
    updatedAt: model.updatedAt,
  };
}
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
  'maintenance.researchCache.cleanup',
  'maintenance.metrics',
  'maintenance.contextSnapshots.cleanup',
  'maintenance.diagnostics.export',
  'maintenance.diagnostics.reveal',
  'document.list',
  'novel.profile.get',
  'novel.profile.update',
  'novel.volume.list',
  'novel.volume.save',
  'novel.chapter.list',
  'novel.chapter.save',
  'novel.chapter.archive',
  'novel.chapter.restore',
  'novel.import',
  'novel.binding.list',
  'novel.binding.save',
  'novel.context.consistencyReport',
  'novel.intent.list',
  'novel.intent.cancel',
  'novel.export.prepare',
  'agent.partial.list',
  'agent.partial.recover',
  'agent.partial.discard',
  'document.get',
  'document.save',
  'document.draft.save',
  'document.versions',
  'document.restore',
  'document.review.submit',
  'document.review.requestChanges',
  'document.review.reject',
  'document.publish',
  'document.selfPublish',
  'agent.task.createDocumentDraft',
  'agent.task.list',
  'agent.task.get',
  'agent.task.events',
  'agent.generation.prepare',
  'agent.run',
  'model.catalog.list',
  'model.catalog.get',
  'adapter.schema.get',
  'adapter.schema.propose',
  'adapter.schema.confirm',
  'adapter.schema.rollback',
  'adapter.schema.audit.list',
  'conversation.runtime.start',
  'agent.generation.executeTools',
  'agent.generation.cancel',
  'agent.generation.confirmTool',
  'agent.providerStep.complete',
  'agent.providerStep.start',
  'task.log.list',
  'generation.job.events.list',
  'agent.changeSet.create',
  'agent.changeSet.list',
  'agent.changeSet.apply',
  'agent.changeSet.reject',
  'scene.list',
  'scene.save',
  'shot.list',
  'shot.save',
  'shot.storyboard.save',
  'constraint.list',
  'conversation.list',
  'conversation.create',
  'conversation.update',
  'conversation.archive',
  'conversation.restore',
  'conversation.modelPreference.get',
  'conversation.modelPreference.set',
  'conversation.modelPreference.clear',
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
setAdapterOverrides(appSettingsService.listConfirmedAdapterSchemas());
const contentService = new ContentService(projectService);
const documentWorkflowService = new DocumentWorkflowService(projectService);
const novelService = new NovelService(projectService);
const agentOrchestrationService = new AgentOrchestrationService(projectService);
const partialArtifactService = new PartialArtifactService(projectService, documentWorkflowService);
const markdownExportService = new MarkdownExportService(projectService);
const changeSetService = new ChangeSetService(projectService);
const taskPlanService = new TaskPlanService(projectService);
let piConversationRuntime: PiConversationRuntime | undefined;

export function configurePiConversationRuntime(bridge: NativeProviderBridge): void {
  piConversationRuntime = new PiConversationRuntime({
    generation: generationService,
    plans: taskPlanService,
    bridge,
    createGateway: (identity) =>
      new DomainToolGateway(
        projectService,
        taskPlanService,
        documentWorkflowService,
        changeSetService,
        identity,
      ),
  });
}
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
const novelContextService = new NovelContextService(projectService);
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
  {
    novelContextService,
    selectionResolver: appSettingsService,
    usageIndexer: appSettingsService,
    generationMetricReporter: (metric) => maintenanceService.recordGenerationMetric(metric),
  },
);
const agentProviderLoopService = new AgentProviderLoopService(
  projectService,
  documentWorkflowService,
  undefined,
  changeSetService,
  {
    get: (adapterKey) =>
      appSettingsService.getAdapterSchema(adapterKey) ?? getAdapter(adapterKey) ?? null,
  },
  {
    propose: ({ adapterKey, descriptor, reason, conversationId }) => {
      validateAdapterDescriptorProposal(adapterKey, descriptor);
      const existing =
        appSettingsService.getAdapterSchema(adapterKey) ??
        adapterService.catalog().adapters.find((adapter) => adapter.key === adapterKey);
      if (
        existing &&
        (existing.endpoint !== descriptor.endpoint ||
          existing.credentialProvider !== descriptor.credentialProvider ||
          existing.provider !== descriptor.provider)
      ) {
        throw new AdapterSchemaValidationError(
          'Agent schema proposals cannot change provider connection or credential settings.',
        );
      }
      const diff = diffAdapterDescriptors(existing, descriptor);
      const proposal = appSettingsService.proposeAdapterSchema(
        {
          adapterKey,
          descriptor,
          reason,
          conversationId,
          actorType: 'agent',
        },
        diff,
      );
      if (!schemaDiffRequiresConfirmation(diff)) {
        appSettingsService.confirmAdapterSchema({
          adapterKey,
          version: proposal.version,
          reason: '低风险 Schema 字段变更自动确认',
          conversationId,
          actorType: 'agent',
        });
        return { ...proposal, requiresConfirmation: false };
      }
      return proposal;
    },
    listAudits: (adapterKey, limit) =>
      appSettingsService.listAdapterSchemaAudits(adapterKey, limit),
  } satisfies AgentSchemaManager,
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

export function recordQueueWait(method: WorkerMethod, waitMs: number): void {
  maintenanceService.recordQueueWait(method, waitMs);
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

function listGenerationJobEvents(params: GenerationJobEventsListParams): GenerationJobEventsPage {
  const jobId = requireString(params as unknown as Record<string, unknown>, 'jobId');
  const afterSequence = Math.max(-1, Math.floor(params.afterSequence ?? -1));
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  return projectService.access(false, (database, project) => {
    const repositories = createRepositories(database);
    const job = repositories.jobs.get(jobId);
    if (!job || job.projectId !== project.id) throw new Error('Generation job was not found.');
    const rows = repositories.generationJobEvents.listByJobPage(jobId, afterSequence, limit + 1);
    const hasMore = rows.length > limit;
    const events: GenerationJobEventInfo[] = rows.slice(0, limit).map((event) => {
      let details: Record<string, unknown> | undefined;
      if (event.detailsJson) {
        try {
          const parsed: unknown = JSON.parse(event.detailsJson);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            details = redactGenerationEventDetails(parsed as Record<string, unknown>);
          }
        } catch {
          // Ignore malformed historical details rather than exposing raw persistence data.
        }
      }
      return {
        id: event.id,
        jobId: event.jobId,
        sequence: event.sequence ?? 0,
        phase: event.phase,
        status: event.status,
        summary: event.summary,
        details,
        createdAt: event.createdAt,
      };
    });
    return {
      events,
      nextSequence: events.length > 0 ? events[events.length - 1]!.sequence : afterSequence,
      hasMore,
    };
  });
}

function redactGenerationEventDetails(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 20)) {
    if (typeof value === 'string') output[key] = value.slice(0, 256);
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (typeof value === 'boolean') output[key] = value;
  }
  return output;
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
    const infrastructure = await executeInfrastructureCommand(request.method, params, {
      projectService,
      sampleProjectService,
      appSettingsService,
      usageService,
      maintenanceService,
      generationService,
      agentProviderLoopService,
      partialArtifactService,
      markdownExportService,
      imageGenerationService,
      videoGenerationService,
    });
    if (infrastructure.handled) {
      result = infrastructure.result;
    } else {
      switch (request.method) {
        case 'document.list':
          result = documentWorkflowService.listDocuments();
          break;
        case 'novel.profile.get':
          result = novelService.getProfile(params) ?? null;
          break;
        case 'novel.profile.update':
          result = novelService.updateProfile(params as unknown as NovelProfileUpdateParams);
          break;
        case 'novel.volume.list':
          result = novelService.listVolumes(params);
          break;
        case 'novel.volume.save':
          result = novelService.saveVolume(params as unknown as NovelVolumeSaveParams);
          break;
        case 'novel.chapter.list':
          result = novelService.listChapters(params);
          break;
        case 'novel.chapter.save':
          result = novelService.saveChapter(params as unknown as NovelChapterSaveParams);
          break;
        case 'novel.chapter.archive':
          result = novelService.archiveChapter(params as unknown as NovelChapterArchiveParams);
          break;
        case 'novel.chapter.restore':
          result = novelService.restoreChapter(params as unknown as NovelChapterRestoreParams);
          break;
        case 'novel.import':
          result = novelService.importNovel(params as unknown as NovelImportParams);
          break;
        case 'novel.binding.list':
          result = novelService.listBindings(params);
          break;
        case 'novel.binding.save':
          result = novelService.saveBinding(params as unknown as NovelBindingSaveParams);
          break;
        case 'novel.context.consistencyReport':
          result = novelContextService.consistencyReport();
          break;
        case 'novel.intent.list':
          result = agentOrchestrationService.listPending(params);
          break;
        case 'novel.intent.cancel':
          result = agentOrchestrationService.cancelPending(
            params as unknown as NovelPendingIntentCancelParams,
          );
          break;
        case 'novel.export.prepare':
          result = markdownExportService.prepare(
            params as unknown as NovelMarkdownExportPrepareParams,
          );
          break;
        case 'agent.partial.list':
          result = partialArtifactService.list(params);
          break;
        case 'agent.partial.recover':
          result = partialArtifactService.recover(
            params as unknown as AgentPartialArtifactRecoverParams,
          );
          break;
        case 'agent.partial.discard':
          result = partialArtifactService.discard(
            params as unknown as AgentPartialArtifactDiscardParams,
          );
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
        case 'document.selfPublish':
          result = documentWorkflowService.selfPublish(params as unknown as DocumentPublishParams);
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
        case 'agent.task.events':
          result = documentWorkflowService.getTaskEvents(
            params as unknown as AgentTaskEventsParams,
          );
          break;
        case 'model.catalog.list': {
          const catalogParams = params as unknown as UnifiedAgentModelCatalogListParams;
          const capability =
            catalogParams.capability && catalogParams.capability !== 'auto'
              ? catalogParams.capability
              : undefined;
          const adapters = adapterService.catalog().adapters;
          const models = appSettingsService.listProfiles(false).flatMap((profile) => {
            if (!profile.enabled) return [];
            if (catalogParams.providerProfileId && profile.id !== catalogParams.providerProfileId)
              return [];
            return appSettingsService
              .listModels(profile.id)
              .filter(
                (model) =>
                  model.enabled &&
                  (catalogParams.includeUnavailable || !model.unavailableAt) &&
                  (!capability || capabilityMatchesModel(capability, model)),
              )
              .map((model) => toModelSchemaInfo(profile, model, adapters, capability));
          });
          result = { models, generatedAt: new Date().toISOString() };
          break;
        }
        case 'model.catalog.get': {
          const catalogParams = params as unknown as UnifiedAgentModelCatalogGetParams;
          const profile = appSettingsService.getProfile(catalogParams.providerProfileId);
          const model = profile
            ? appSettingsService
                .listModels(profile.id)
                .find((candidate) => candidate.id === catalogParams.modelId)
            : undefined;
          result =
            profile && model
              ? toModelSchemaInfo(
                  profile,
                  model,
                  adapterService.catalog().adapters,
                  catalogParams.capability,
                )
              : null;
          break;
        }
        case 'adapter.schema.get': {
          const schemaParams = params as { adapterKey: string };
          result =
            appSettingsService.getAdapterSchema(schemaParams.adapterKey) ??
            adapterService
              .catalog()
              .adapters.find((adapter) => adapter.key === schemaParams.adapterKey) ??
            null;
          break;
        }
        case 'adapter.schema.propose': {
          const schemaParams = params as unknown as UnifiedAgentAdapterSchemaProposeParams;
          validateAdapterDescriptorProposal(schemaParams.adapterKey, schemaParams.descriptor);
          const existing =
            appSettingsService.getAdapterSchema(schemaParams.adapterKey) ??
            adapterService
              .catalog()
              .adapters.find((adapter) => adapter.key === schemaParams.adapterKey);
          if (
            existing &&
            (existing.endpoint !== schemaParams.descriptor.endpoint ||
              existing.credentialProvider !== schemaParams.descriptor.credentialProvider ||
              existing.provider !== schemaParams.descriptor.provider)
          ) {
            throw new RequestValidationError(
              'Agent schema proposals cannot change provider connection or credential settings.',
            );
          }
          const diff = diffAdapterDescriptors(existing, schemaParams.descriptor);
          result = appSettingsService.proposeAdapterSchema(schemaParams, diff);
          break;
        }
        case 'adapter.schema.confirm': {
          const schemaParams = params as unknown as UnifiedAgentAdapterSchemaConfirmParams;
          result = appSettingsService.confirmAdapterSchema(schemaParams);
          setAdapterOverrides(appSettingsService.listConfirmedAdapterSchemas());
          // Close the project-local Agent task that produced this proposal.
          // The app-settings confirmation is intentionally separate from the
          // project database, so correlate only the bounded adapter/version
          // summary persisted by the controlled tool call.
          projectService.access(true, (database, project) => {
            const now = new Date().toISOString();
            database
              .prepare(
                `UPDATE agent_tasks SET status = 'completed', outcome = 'read-only',
                 completed_at = ?, updated_at = ?, row_version = row_version + 1
                 WHERE project_id = ? AND task_type = 'schema-query' AND status = 'running'
                   AND id IN (
                     SELECT task_id FROM agent_tool_calls
                     WHERE tool_name = 'adapter.schema.propose' AND status = 'succeeded'
                       AND json_extract(result_summary_json, '$.adapterKey') = ?
                       AND json_extract(result_summary_json, '$.version') = ?
                   )`,
              )
              .run(now, now, project.id, schemaParams.adapterKey, schemaParams.version);
          });
          break;
        }
        case 'adapter.schema.rollback': {
          const schemaParams = params as unknown as UnifiedAgentAdapterSchemaRollbackParams;
          result = appSettingsService.rollbackAdapterSchema(schemaParams);
          setAdapterOverrides(appSettingsService.listConfirmedAdapterSchemas());
          projectService.access(true, (database, project) => {
            const now = new Date().toISOString();
            database
              .prepare(
                `UPDATE agent_tasks SET status = 'completed', outcome = 'read-only',
                 completed_at = ?, updated_at = ?, row_version = row_version + 1
                 WHERE project_id = ? AND task_type = 'schema-query' AND status = 'running'
                   AND id IN (
                     SELECT task_id FROM agent_tool_calls
                     WHERE tool_name = 'adapter.schema.propose' AND status = 'succeeded'
                       AND json_extract(result_summary_json, '$.adapterKey') = ?
                       AND json_extract(result_summary_json, '$.version') = ?
                   )`,
              )
              .run(now, now, project.id, schemaParams.adapterKey, schemaParams.version + 1);
          });
          break;
        }
        case 'adapter.schema.audit.list': {
          const schemaParams = params as unknown as UnifiedAgentAdapterSchemaAuditListParams;
          result = appSettingsService.listAdapterSchemaAudits(
            schemaParams.adapterKey,
            schemaParams.limit,
          );
          break;
        }
        case 'agent.run': {
          const agentParams = params as unknown as UnifiedAgentRunParams;
          const capability =
            agentParams.capability && agentParams.capability !== 'auto'
              ? agentParams.capability
              : inferUnifiedAgentCapability(agentParams.prompt);
          const hasImageAttachment =
            agentParams.attachments?.some((attachment) =>
              attachment.mimeType.toLowerCase().startsWith('image/'),
            ) ?? false;
          const adapterCatalog = adapterService.catalog().adapters;
          const profiles = appSettingsService.listProfiles(false);
          const candidates: UnifiedAgentModelCandidate[] = profiles.flatMap((profile) =>
            profile.enabled && profile.connectionStatus === 'ready'
              ? appSettingsService
                  .listModels(profile.id)
                  .filter((model) =>
                    modelMatchesUnifiedAgentRequest(
                      capability,
                      model,
                      profile.providerType,
                      adapterCatalog,
                      hasImageAttachment,
                    ),
                  )
                  .map((model) => ({
                    providerProfileId: profile.id,
                    providerName: profile.name,
                    modelId: model.id,
                    remoteModelId: model.remoteModelId,
                    modelName: model.displayName,
                    capabilities: model.capabilities,
                    source: model.source,
                    schemaReady:
                      capability !== 'image' && capability !== 'video'
                        ? true
                        : adapterService
                            .catalog()
                            .adapters.some(
                              (adapter) =>
                                adapter.provider === profile.providerType &&
                                adapter.model === model.remoteModelId &&
                                appSettingsService.getAdapterSchemaRecord(adapter.key)?.status !==
                                  'needs_confirmation' &&
                                (capability === 'image'
                                  ? adapter.capability.endsWith('TO_IMAGE')
                                  : adapter.capability.endsWith('TO_VIDEO')),
                            ),
                  }))
              : [],
          );

          let storedPreference: ReturnType<
            ContentService['getConversationModelPreference']
          > | null = null;
          // Media Provider/model selection is an explicit user decision. The
          // Worker may validate a remembered selection when Desktop sends it
          // explicitly, but must not select a media model from persistence.
          if (
            !agentParams.providerProfileId &&
            !agentParams.modelId &&
            capability !== 'auto' &&
            capability !== 'image' &&
            capability !== 'video'
          ) {
            try {
              storedPreference = contentService.getConversationModelPreference({
                conversationId: agentParams.conversationId,
                capability,
              });
            } catch {
              // Catalog/model-selection validation remains useful before a project is open.
            }
          }
          const requestedProviderProfileId =
            agentParams.providerProfileId ?? storedPreference?.providerProfileId;
          const requestedModelId = agentParams.modelId ?? storedPreference?.modelId;

          if (!requestedProviderProfileId || !requestedModelId) {
            result = {
              status: 'needs_model_selection',
              capability,
              reason: storedPreference ? 'model_unavailable' : 'missing_model',
              models: candidates,
            };
            break;
          }

          const selected = candidates.find(
            (candidate) =>
              candidate.providerProfileId === requestedProviderProfileId &&
              candidate.modelId === requestedModelId,
          );
          if (!selected) {
            result = {
              status: 'needs_model_selection',
              capability,
              reason: candidates.some(
                (candidate) =>
                  candidate.providerProfileId === requestedProviderProfileId &&
                  candidate.modelId === requestedModelId,
              )
                ? 'capability_mismatch'
                : 'model_unavailable',
              models: candidates,
            };
            break;
          }

          if (capability === 'image' || capability === 'video') {
            const selectedProfile = profiles.find(
              (profile) => profile.id === selected.providerProfileId,
            );
            if (!selectedProfile) {
              throw new ProviderProfileValidationError('Provider profile was not found.');
            }
            const adapters = adapterService
              .catalog()
              .adapters.filter(
                (adapter) =>
                  adapter.provider === selectedProfile.providerType &&
                  adapter.model === selected.remoteModelId &&
                  (capability === 'image'
                    ? adapter.capability.endsWith('TO_IMAGE')
                    : adapter.capability.endsWith('TO_VIDEO')),
              );
            if (!agentParams.adapterKey || !agentParams.parameters) {
              result = {
                status: 'needs_parameters',
                capability,
                providerProfileId: selected.providerProfileId,
                modelId: selected.modelId,
                conversationId: agentParams.conversationId,
                originalPrompt: agentParams.prompt,
                costNoticeAcknowledged: true,
                modelName: selected.modelName,
                adapters,
                missingRequired: adapters.flatMap((adapter) => adapter.parameterSchema.required),
                affectsCost: true,
              };
              break;
            }
            const adapter = adapters.find((item) => item.key === agentParams.adapterKey);
            if (!adapter)
              throw new Error('The selected generation adapter is not available for this model.');
            const schemaRecord = appSettingsService.getAdapterSchemaRecord(adapter.key);
            if (schemaRecord?.status === 'needs_confirmation') {
              throw new AdapterSchemaValidationError(
                'This adapter schema is awaiting confirmation and cannot be submitted yet.',
              );
            }
            const parameters = agentParams.parameters;
            if (capability === 'image') {
              const mediaSelection = resolveMediaSelectionForRequest(
                'image',
                adapter.key,
                selected.providerProfileId,
                selected.modelId,
              );
              const job = imageGenerationService.prepare({
                shotId: agentParams.shotId,
                adapterKey: adapter.key,
                parameters,
                providerProfileId: mediaSelection.profile.id,
                modelId: mediaSelection.model.id,
                conversationId: agentParams.conversationId,
                originalPrompt: agentParams.prompt,
                costNoticeAcknowledged: true,
              } satisfies ImageGenerationPrepareParams);
              result = { status: 'image_prepared', capability: 'image', job };
            } else {
              const mediaSelection = resolveMediaSelectionForRequest(
                'video',
                adapter.key,
                selected.providerProfileId,
                selected.modelId,
                agentParams.providerRegion,
              );
              const job = videoGenerationService.prepare({
                shotId: agentParams.shotId,
                adapterKey: adapter.key,
                parameters,
                providerRegion: mediaSelection.providerRegion,
                providerProfileId: mediaSelection.profile.id,
                modelId: mediaSelection.model.id,
                conversationId: agentParams.conversationId,
                originalPrompt: agentParams.prompt,
                costNoticeAcknowledged: true,
                assetKind:
                  agentParams.assetKind === 'generated-video' ||
                  agentParams.assetKind === 'shot-video'
                    ? agentParams.assetKind
                    : undefined,
              } satisfies VideoGenerationPrepareParams);
              result = { status: 'video_prepared', capability: 'video', job };
            }
            break;
          }

          const profile = appSettingsService.getProfile(selected.providerProfileId);
          if (!profile) throw new ProviderProfileValidationError('Provider profile was not found.');
          const model = appSettingsService
            .listModels(selected.providerProfileId)
            .find((candidate) => candidate.id === selected.modelId);
          assertAgentToolLoopSelection(profile, model);
          const prepared = generationService.prepare({
            conversationId: agentParams.conversationId,
            prompt: agentParams.prompt,
            providerProfileId: selected.providerProfileId,
            modelId: selected.modelId,
            attachments: agentParams.attachments,
            budgetTokens: agentParams.budgetTokens,
            idempotencyKey: agentParams.idempotencyKey,
          });
          const agent = agentProviderLoopService.prepare(
            prepared.stream,
            agentParams.prompt,
            undefined,
            inferAgentDocumentIntent(agentParams.prompt),
            'auto',
          );
          generationService.configureAgentTools(prepared.stream, agent.tools);
          result = {
            status: 'started',
            capability,
            ...prepared,
            agentTaskId: agent.taskId,
            runtimeOwner: 'native-agent',
          };
          break;
        }
        case 'agent.generation.prepare': {
          const agentParams = params as unknown as AgentGenerationPrepareParams;
          if (agentParams.agentMode === 'novel-writing') {
            const orchestration = agentOrchestrationService.prepareNovelTask({
              conversationId: agentParams.conversationId,
              projectSessionId: projectService.currentSessionId() ?? 'unknown-session',
              prompt: agentParams.prompt,
              title: agentParams.title,
              intent: agentParams.novelIntent,
              idempotencyKey: agentParams.idempotencyKey,
            });
            if ('pendingIntent' in orchestration) {
              result = { pendingIntent: orchestration.pendingIntent };
              break;
            }
            const profile = appSettingsService.getProfile(agentParams.providerProfileId);
            if (!profile) {
              agentOrchestrationService.failTaskBeforeGeneration(
                orchestration.taskId,
                'Provider profile was not found.',
              );
              throw new ProviderProfileValidationError('Provider profile was not found.');
            }
            const model = appSettingsService
              .listModels(agentParams.providerProfileId)
              .find((candidate) => candidate.id === agentParams.modelId);
            try {
              assertAgentToolLoopSelection(profile, model);
            } catch (error) {
              agentOrchestrationService.failTaskBeforeGeneration(
                orchestration.taskId,
                error instanceof Error ? error.message : 'Provider cannot run Agent tools.',
              );
              throw error;
            }
            try {
              const prepared = generationService.prepare({
                ...agentParams,
                novelIntent: {
                  ...agentParams.novelIntent,
                  chapterId: orchestration.chapterId,
                },
              });
              const agent = agentProviderLoopService.prepare(
                prepared.stream,
                agentParams.prompt,
                agentParams.title,
                orchestration.documentIntent,
                agentParams.researchMode,
                orchestration.taskId,
              );
              generationService.configureAgentTools(prepared.stream, agent.tools);
              result = { ...prepared, agentTaskId: agent.taskId, runtimeOwner: 'native-agent' };
            } catch (error) {
              agentOrchestrationService.failTaskBeforeGeneration(
                orchestration.taskId,
                error instanceof Error ? error.message : 'Generation preparation failed.',
              );
              throw error;
            }
            break;
          }
          const profile = appSettingsService.getProfile(agentParams.providerProfileId);
          if (!profile) {
            throw new ProviderProfileValidationError('Provider profile was not found.');
          }
          const model = appSettingsService
            .listModels(agentParams.providerProfileId)
            .find((candidate) => candidate.id === agentParams.modelId);
          assertAgentToolLoopSelection(profile, model);
          const prepared = generationService.prepare(agentParams);
          const agent = agentProviderLoopService.prepare(
            prepared.stream,
            agentParams.prompt,
            agentParams.title,
            agentParams.documentIntent ?? inferAgentDocumentIntent(agentParams.prompt),
            agentParams.researchMode,
            undefined,
            agentParams.agentMode === 'short-drama' ? agentParams.selectedChapterIds : undefined,
            agentParams.agentMode === 'short-drama' ? agentParams.targetPlatform : undefined,
          );
          generationService.configureAgentTools(prepared.stream, agent.tools);
          result = {
            ...prepared,
            agentTaskId: agent.taskId,
            runtimeOwner:
              agentParams.agentMode === 'short-drama' && resolvePiConversationRuntimeEnabled()
                ? 'pi'
                : 'native-agent',
          };
          break;
        }
        case 'conversation.runtime.start': {
          if (!piConversationRuntime) throw new Error('Pi conversation runtime is not configured.');
          const runtimeParams = params as unknown as ConversationRuntimeStartParams;
          result = await piConversationRuntime.start({
            taskId: runtimeParams.taskId,
            projectId: runtimeParams.projectId,
            projectSessionId: runtimeParams.projectSessionId,
            conversationId: runtimeParams.conversationId,
            mode: runtimeParams.mode,
            identity: {
              generationId: runtimeParams.generationId,
              attemptId: runtimeParams.attemptId,
              projectId: runtimeParams.projectId,
              projectSessionId: runtimeParams.projectSessionId,
              conversationId: runtimeParams.conversationId,
            },
            prompt: runtimeParams.prompt,
          });
          break;
        }
        case 'agent.generation.executeTools': {
          const executionParams = params as unknown as AgentGenerationExecuteToolsParams;
          const execution = await agentProviderLoopService.executeTools(executionParams);
          generationService.configureAgentTools(
            executionParams,
            execution.tools ?? [],
            execution.continuation,
          );
          result = execution;
          break;
        }
        case 'agent.generation.cancel': {
          const generationId = requireString(params, 'generationId');
          const piCancelled = piConversationRuntime?.cancel(generationId) ?? false;
          const providerCancelled = agentProviderLoopService.cancelGeneration(generationId);
          if (piCancelled) {
            agentProviderLoopService.terminateGeneration(generationId, 'cancelled');
          }
          result = {
            cancelled: piCancelled || providerCancelled,
          };
          break;
        }
        case 'agent.generation.confirmTool': {
          const confirmationParams = params as unknown as AgentGenerationConfirmToolParams;
          const confirmation = agentProviderLoopService.confirmTool(confirmationParams);
          generationService.configureAgentTools(
            confirmationParams,
            confirmation.tools ?? [],
            confirmation.continuation,
          );
          result = confirmation;
          break;
        }
        case 'agent.providerStep.complete':
          agentProviderLoopService.completeProviderStep(
            params as unknown as AgentProviderStepCompleteParams,
          );
          result = {};
          break;
        case 'agent.providerStep.start':
          agentProviderLoopService.startProviderStep(
            params as unknown as AgentProviderStepStartParams,
          );
          result = {};
          break;
        case 'agent.changeSet.create':
          result = changeSetService.create(params as unknown as AgentChangeSetCreateParams);
          break;
        case 'agent.changeSet.list':
          result = changeSetService.list(params);
          break;
        case 'agent.changeSet.apply':
          result = changeSetService.apply(params as unknown as AgentChangeSetApplyParams);
          break;
        case 'agent.changeSet.reject':
          result = changeSetService.reject(params as unknown as AgentChangeSetRejectParams);
          break;
        case 'task.log.list':
          result = documentWorkflowService.listTaskLog(params);
          break;
        case 'generation.job.events.list':
          result = listGenerationJobEvents(params as unknown as GenerationJobEventsListParams);
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
        case 'shot.storyboard.save':
          result = contentService.saveShotStoryboard(params as unknown as ShotStoryboardSaveParams);
          break;
        case 'constraint.list':
          result = contentService.listConstraints();
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
          result = contentService.archiveConversation(
            params as unknown as ConversationArchiveParams,
          );
          break;
        case 'conversation.restore':
          result = contentService.restoreConversation(
            params as unknown as ConversationRestoreParams,
          );
          break;
        case 'conversation.modelPreference.get':
          result = contentService.getConversationModelPreference(
            params as unknown as ConversationModelPreferenceGetParams,
          );
          break;
        case 'conversation.modelPreference.set':
          result = contentService.setConversationModelPreference(
            params as unknown as ConversationModelPreferenceSetParams,
          );
          break;
        case 'conversation.modelPreference.clear':
          result = contentService.clearConversationModelPreference(
            params as unknown as ConversationModelPreferenceClearParams,
          );
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
        case 'llm.generation.complete': {
          const completed = generationService.complete(
            params as unknown as LlmGenerationCompleteParams,
          );
          agentProviderLoopService.clearGeneration(completed.generationId);
          result = completed;
          break;
        }
        case 'llm.generation.fail': {
          const failParams = params as unknown as LlmGenerationFailParams;
          partialArtifactService.captureInterrupted(failParams, failParams.content);
          const failed = generationService.failNative(failParams);
          agentProviderLoopService.terminateGeneration(failed.generationId, 'failed');
          result = failed;
          break;
        }
        case 'llm.generation.get':
          result = generationService.get(requireString(params, 'generationId'));
          break;
        case 'llm.generation.cancel': {
          const generationId = requireString(params, 'generationId');
          const current = generationService.get(generationId);
          if (current.executionMode === 'native' && current.assistantMessage.content) {
            partialArtifactService.captureInterruptedByGeneration(
              generationId,
              current.assistantMessage.content,
            );
          }
          result = await generationService.cancel(generationId);
          agentProviderLoopService.terminateGeneration(generationId, 'cancelled');
          break;
        }
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
        case 'image.generate.prepare': {
          const imageParams = params as unknown as ImageGenerationPrepareParams;
          const selection = resolveMediaSelectionForRequest(
            'image',
            imageParams.adapterKey,
            imageParams.providerProfileId,
            imageParams.modelId,
          );
          result = imageGenerationService.prepare({
            ...imageParams,
            providerProfileId: selection.profile.id,
            modelId: selection.model.id,
          });
          break;
        }
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
        case 'video.generate.prepare': {
          const videoParams = params as unknown as VideoGenerationPrepareParams;
          const selection = resolveMediaSelectionForRequest(
            'video',
            requireString(params, 'adapterKey'),
            videoParams.providerProfileId,
            videoParams.modelId,
            videoParams.providerRegion,
          );
          result = videoGenerationService.prepare({
            ...videoParams,
            adapterKey: requireString(params, 'adapterKey'),
            providerRegion: selection.providerRegion,
            providerProfileId: selection.profile.id,
            modelId: selection.model.id,
            assetKind: optionalVideoAssetKind(params, 'assetKind'),
          });
          break;
        }
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

function validateAdapterDescriptorProposal(
  adapterKey: string,
  descriptor: AdapterDescriptor,
): void {
  if (!descriptor || typeof descriptor !== 'object' || descriptor.key !== adapterKey) {
    throw new RequestValidationError('descriptor.key must match adapterKey.');
  }
  const requiredStrings: Array<keyof AdapterDescriptor> = [
    'key',
    'capabilityLabel',
    'provider',
    'providerLabel',
    'model',
    'modelLabel',
    'apiVersion',
    'endpoint',
    'documentationUrl',
    'credentialProvider',
  ];
  for (const field of requiredStrings) {
    if (typeof descriptor[field] !== 'string' || !String(descriptor[field]).trim()) {
      throw new RequestValidationError(`descriptor.${String(field)} must be a non-empty string.`);
    }
  }
  if (!/^https:\/\//i.test(descriptor.endpoint)) {
    throw new RequestValidationError('descriptor.endpoint must use HTTPS.');
  }
  const schema = descriptor.parameterSchema;
  if (!schema || schema.type !== 'object' || schema.additionalProperties !== false) {
    throw new RequestValidationError(
      'descriptor.parameterSchema must be an object schema with additionalProperties=false.',
    );
  }
  if (
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    !Array.isArray(schema.required)
  ) {
    throw new RequestValidationError(
      'descriptor.parameterSchema must define properties and required.',
    );
  }
  for (const field of schema.required) {
    if (
      typeof field !== 'string' ||
      !Object.prototype.hasOwnProperty.call(schema.properties, field)
    ) {
      throw new RequestValidationError(
        `descriptor.parameterSchema.required contains unknown field: ${String(field)}.`,
      );
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (
      !property ||
      typeof property !== 'object' ||
      !['string', 'integer', 'boolean', 'array'].includes(property.type)
    ) {
      throw new RequestValidationError(
        `descriptor.parameterSchema.properties.${key} has an invalid type.`,
      );
    }
  }
}

function diffAdapterDescriptors(
  previous: AdapterDescriptor | undefined,
  next: AdapterDescriptor,
): string[] {
  if (!previous) return ['new adapter schema'];
  const diff: string[] = [];
  for (const field of [
    'capability',
    'provider',
    'model',
    'apiVersion',
    'endpoint',
    'credentialProvider',
  ] as const) {
    if (previous[field] !== next[field]) diff.push(`${field} changed`);
  }
  const previousProperties = previous.parameterSchema.properties;
  const nextProperties = next.parameterSchema.properties;
  for (const key of Object.keys(previousProperties)) {
    if (!Object.prototype.hasOwnProperty.call(nextProperties, key))
      diff.push(`parameter removed: ${key}`);
    else if (JSON.stringify(previousProperties[key]) !== JSON.stringify(nextProperties[key])) {
      diff.push(`parameter changed: ${key}`);
    }
  }
  for (const key of Object.keys(nextProperties)) {
    if (!Object.prototype.hasOwnProperty.call(previousProperties, key))
      diff.push(`parameter added: ${key}`);
  }
  if (
    JSON.stringify(previous.parameterSchema.required) !==
    JSON.stringify(next.parameterSchema.required)
  ) {
    diff.push('required parameters changed');
  }
  if (
    JSON.stringify(previous.parameterSchema.allOf ?? []) !==
    JSON.stringify(next.parameterSchema.allOf ?? [])
  ) {
    diff.push('parameter dependencies changed');
  }
  if (JSON.stringify(previous.uiSchema) !== JSON.stringify(next.uiSchema))
    diff.push('ui schema changed');
  return diff.length > 0 ? diff : ['no structural changes'];
}

function schemaDiffRequiresConfirmation(diff: string[]): boolean {
  return diff.some((item) =>
    /new adapter schema|removed|required parameters changed|dependencies changed|provider changed|endpoint changed|credentialProvider changed|parameter changed/u.test(
      item,
    ),
  );
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
  if (error instanceof NovelServiceError) {
    return { code: error.code, message, retryable: false, operation };
  }
  if (error instanceof AgentOrchestrationError) {
    return { code: error.code, message, retryable: false, operation };
  }
  if (message === 'AGENT_PARTIAL_ARTIFACT_UNAVAILABLE') {
    return { code: 'CONFLICT', message, retryable: false, operation };
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
  if (error instanceof AdapterSchemaValidationError) {
    return { code: 'INVALID_PARAMETERS', message, retryable: false, operation };
  }
  if (error instanceof AgentProviderCapabilityError) {
    return { code: error.code, message, retryable: false, operation };
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
