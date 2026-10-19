import { tmpdir } from 'node:os';
import { VoiceReferenceRepository } from '@ai-video/persistence';
import { resolveSceneMedia } from './scene-media-service.js';
import { ProductionService } from './production-service.js';
import { ShotContinuityService } from './shot-continuity-service.js';
import type { CharacterVoiceReferenceSaveParams } from '@ai-video/contracts';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  IPC_PROTOCOL_VERSION,
  type ChatMessageListParams,
  type ChatMessageSaveParams,
  type AgentTaskCreateDocumentDraftParams,
  type AgentGenerationPrepareParams,
  type AgentDocumentIntent,
  type NovelWritingIntent,
  type UnifiedAgentRunParams,
  type UnifiedAgentCapability,
  type ConversationTaskMode,
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
  type AgentGenerationSelectMediaParams,
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
  type ConversationPromptTemplateSaveParams,
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
  type MediaSubmissionRequestParams,
  type MediaSubmissionConfirmParams,
  type MediaTaskCancelParams,
  type AgentGenerationConfirmMediaSubmissionParams,
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
  inferUnifiedAgentCapabilityHint,
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
import { ConversationBusyError, GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { VideoGenerationService } from './video-generation-service.js';
import { MediaPreparationService, resolveMediaProviderRoute } from './media-preparation-service.js';
import { MaintenanceService } from './maintenance-service.js';
import { SampleProjectService } from './sample-project-service.js';
import {
  AdapterSchemaValidationError,
  AppSettingsService,
  ProviderProfileValidationError,
} from './app-settings-service.js';
import {
  AgentProviderCapabilityError,
  assertAgentToolLoopSelection,
  isRetiredAgentModel,
} from './provider-registry.js';
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
import { MediaOrchestrationService } from './media-orchestration-service.js';
import { ProjectStructureCompiler } from './structure-compiler.js';
import { ProjectTaskRuntime } from './project-task-runtime.js';
import { TaskScheduleService } from './task-schedule-service.js';
import { TaskCapacity } from './task-capacity.js';
import { ExecutionPool } from './execution-pool.js';
import { NovelBatchService } from './novel-batch-service.js';
import { FileTaskService } from './file-task-service.js';
import { ProjectRuntimeRegistry, ProjectRuntimeScopeError } from './project-runtime-registry.js';
import { resetRuntime, recoverRuntime } from './worker-commands.js';
import { DubbingService, DubbingValidationError } from './dubbing-service.js';
import type { DubbingWorkerMethodMap } from '@ai-video/contracts';
import { resolvePiConversationRuntimeEnabled } from './conversation-runtime.js';
import { AgentSystemToolService } from './agent-system-tool-service.js';
import { prepareAgentGeneration } from './agent-generation-preparation.js';
import {
  adapterBindsCatalogModel,
  getAdapter,
  setAdapterOverrides,
} from '@ai-video/generation-adapters';
import { createRepositories } from '@ai-video/persistence';

const WORKER_VERSION = '0.1.0';

export function inferUnifiedAgentCapability(prompt: string): UnifiedAgentCapability {
  return inferUnifiedAgentCapabilityHint(prompt);
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
  adapterService: AdapterService,
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
  mediaModelSelection: import('@ai-video/contracts').MediaModelSelectionSnapshot;
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
  const route = resolveMediaProviderRoute(profile);
  if (!route) {
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
  if (
    !adapterBindsCatalogModel(adapter, {
      providerType: profile.providerType,
      remoteModelId: model.remoteModelId,
      parameterTemplateKey: model.parameterTemplateKey,
      contractStatus: model.contractStatus,
    })
  ) {
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
  const providerRegion = route.providerRegion;
  if (requestedRegion !== undefined && requestedRegion !== providerRegion) {
    throw new ProviderProfileValidationError(
      'The selected provider profile does not match the requested region.',
    );
  }
  return {
    profile,
    model,
    adapter,
    providerRegion,
    mediaModelSelection: {
      providerProfileId: profile.id,
      providerType: route.providerType,
      providerBaseUrlCategory: route.baseUrlCategory,
      providerRegion,
      modelId: model.id,
      remoteModelId: model.remoteModelId,
      adapterKey: adapter.key,
      adapterSchemaVersion: adapter.schemaVersion,
      adapterSchemaSource: schemaRecord?.source === 'manual' ? 'manual' : 'official-adapter',
      contractId: adapter.contractId,
      contractRevision: adapter.contractRevision,
      contractStatus: model.contractStatus,
    },
  };
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

/** Compatibility wrapper around resolveAgentRunWorkflow. Prompt language is not a router. */
export function inferConversationTaskMode(
  prompt: string,
  selectedChapterIds?: readonly string[],
): ConversationTaskMode {
  return resolveAgentRunWorkflow({ prompt, selectedChapterIds });
}

/**
 * Keep one System Agent workflow for project operations. The user message is
 * not routed into a novel, screenplay, or document-only runtime; the model
 * resolves the resource through project.structure.get and then selects the
 * authorized domain tool.
 */
export function resolveAgentRunWorkflow(input: {
  prompt?: string;
  novelIntent?: NovelWritingIntent;
  selectedChapterIds?: readonly string[];
}): ConversationTaskMode {
  void input;
  return 'document';
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
    parameterTemplateKey?: string;
    contractStatus?: string;
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
      adapterBindsCatalogModel(adapter, {
        providerType,
        remoteModelId: model.remoteModelId,
        parameterTemplateKey: model.parameterTemplateKey,
        contractStatus: model.contractStatus,
      }) &&
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
  profile: { providerType: string },
  model: { remoteModelId: string; parameterTemplateKey?: string; contractStatus?: string },
  capability: UnifiedAgentCapability | undefined,
): boolean {
  if (
    !adapterBindsCatalogModel(adapter, {
      providerType: profile.providerType,
      remoteModelId: model.remoteModelId,
      parameterTemplateKey: model.parameterTemplateKey,
      contractStatus: model.contractStatus,
    })
  ) {
    return false;
  }
  if (!capability || capability === 'auto') return true;
  if (capability === 'image') return adapter.capability.endsWith('TO_IMAGE');
  if (capability === 'video') return adapter.capability.endsWith('TO_VIDEO');
  return false;
}

function toModelSchemaInfo(
  profile: ReturnType<typeof appSettingsService.listProfiles>[number],
  model: ReturnType<typeof appSettingsService.listModels>[number],
  adapters: ReturnType<AdapterService['catalog']>['adapters'],
  capability?: UnifiedAgentCapability,
): UnifiedAgentModelSchemaInfo {
  const matchingAdapters = adapters.filter((adapter) =>
    adapterMatchesCapability(adapter, profile, model, capability),
  );
  const persistedForModel = appSettingsService.listAdapterSchemaRecords().flatMap((record) => {
    try {
      const descriptor = JSON.parse(record.descriptorJson) as AdapterDescriptor;
      return adapterBindsCatalogModel(descriptor, {
        providerType: profile.providerType,
        remoteModelId: model.remoteModelId,
        parameterTemplateKey: model.parameterTemplateKey,
        contractStatus: model.contractStatus,
      })
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
    contractId: model.contractId,
    contractRevision: model.contractRevision,
    contractStatus: model.contractStatus,
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
  'characterVoice.list',
  'characterVoice.save',
  'characterVoiceReference.list',
  'characterVoiceReference.save',
  'audio.import',
  'audio.list',
  'audio.get',
  'audio.mediaSource',
  'audio.trash',
  'audio.restore',
  'audio.purge',
  'dubbing.runtime.get',
  'dubbing.scene.get',
  'dubbing.cue.save',
  'dubbing.cue.delete',
  'dubbing.take.generate',
  'dubbing.take.adopt',
  'dubbing.job.submit',
  'dubbing.job.cancel',
  'dubbing.job.retry',
  'dubbing.job.get',
  'dubbing.job.list',
  'dubbing.output.adopt',
  'health',
  'sqlite.probe',
  'project.create',
  'project.createSample',
  'project.open',
  'project.close',
  'project.current',
  'project.runtime.attach',
  'project.runtime.create',
  'project.runtime.createSample',
  'project.runtime.restore',
  'project.runtime.activate',
  'project.runtime.unload',
  'project.runtime.list',
  'project.runtime.registrations',
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
  'model.contract.list',
  'model.contract.get',
  'model.contract.setEnabled',
  'model.binding.list',
  'model.binding.setEnabled',
  'model.protocol.list',
  'model.task-adapter.list',
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
  'novel.export.start',
  'novel.export.get',
  'novel.export.list',
  'novel.export.cancel',
  'file.task.create',
  'file.task.get',
  'file.task.list',
  'file.task.cancel',
  'novel.export.reveal',
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
  'conversation.runtime.get',
  'conversation.runtime.list',
  'conversation.runtime.supplement',
  'novel.batch.get',
  'novel.batch.cancel',
  'conversation.runtime.confirm',
  'conversation.runtime.selectMedia',
  'conversation.runtime.confirmMediaSubmission',
  'agent.generation.executeTools',
  'agent.generation.cancel',
  'agent.generation.confirmTool',
  'agent.generation.confirmMediaSubmission',
  'agent.generation.selectMedia',
  'agent.providerStep.complete',
  'agent.providerStep.start',
  'task.log.list',
  'generation.job.events.list',
  'agent.changeSet.create',
  'agent.changeSet.list',
  'agent.changeSet.apply',
  'agent.changeSet.reject',
  'scene.list',
  'production.read',
  'production.compile',
  'shot.continuity.get',
  'shot.continuity.preview',
  'shot.continuity.confirm',
  'shot.continuity.clear',
  'shot.continuity.firstFrame',
  'shot.continuity.prompt.prepare',
  'shot.continuity.prompt.save',
  'production.defaults.get',
  'production.defaults.save',
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
  'conversation.promptTemplate.get',
  'conversation.promptTemplate.save',
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
  'media.generation.requestSubmission',
  'media.generation.confirmSubmission',
  'media.task.cancel',
  'video.generate.attachTask',
  'video.generate.observe',
  'video.generate.fail',
  'video.generate.pause',
  'video.generate.resume',
  'video.generate.timeout',
  'video.generate.cancel',
  'video.generate.get',
  'video.generate.list',
  'project.task.subscribe',
  'task.schedule.list',
  'task.schedule.get',
  'task.schedule.events',
  'task.schedule.create',
  'task.schedule.cancel',
  'asset.list',
  'scene.media.resolve',
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
const appSettingsService = new AppSettingsService({ nativeBinding: packagedSqliteBinding });
setAdapterOverrides(appSettingsService.listConfirmedAdapterSchemas());
let nativeProviderBridge: NativeProviderBridge | undefined;
const taskCapacity = new TaskCapacity();
const executionPool = new ExecutionPool();
const llmProvider = new OpenAIResponsesProvider({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
});
function createProjectRuntimeServices() {
  const projectService = new ProjectService({ nativeBinding: packagedSqliteBinding });
  const contentService = new ContentService(projectService);
  const documentWorkflowService = new DocumentWorkflowService(projectService);
  const novelService = new NovelService(projectService);
  const agentOrchestrationService = new AgentOrchestrationService(projectService);
  const partialArtifactService = new PartialArtifactService(
    projectService,
    documentWorkflowService,
  );
  const markdownExportService = new MarkdownExportService(projectService, undefined, executionPool);
  const fileTaskService = new FileTaskService(projectService, novelService, executionPool);
  const changeSetService = new ChangeSetService(projectService);
  const taskPlanService = new TaskPlanService(projectService);
  let piConversationRuntime: PiConversationRuntime | undefined;

  function configureRuntime(bridge: NativeProviderBridge): void {
    nativeProviderBridge = bridge;
    projectTaskRuntime.start();
    dubbingService.recover();
    if (piConversationRuntime && piConversationRuntime.list().length > 0) return;
    piConversationRuntime = new PiConversationRuntime({
      generation: generationService,
      capacity: executionPool,
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
      providerTools: agentProviderLoopService,
    });
  }
  const adapterService = new AdapterService(projectService);
  const imageGenerationService = new ImageGenerationService(
    projectService,
    undefined,
    undefined,
    executionPool,
  );
  const videoGenerationService = new VideoGenerationService(
    projectService,
    undefined,
    appSettingsService,
    executionPool,
  );
  const maintenanceService = new MaintenanceService(projectService);
  const sampleProjectService = new SampleProjectService(projectService);
  const contextService = new ContextService(projectService);
  const novelContextService = new NovelContextService(projectService);
  const usageService = new UsageService(projectService, appSettingsService, {
    nativeBinding: packagedSqliteBinding,
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
  const mediaPreparationService = new MediaPreparationService(
    projectService,
    appSettingsService,
    adapterService,
    imageGenerationService,
    videoGenerationService,
    (identity) => generationService.runtime(identity).attachments ?? [],
  );
  const shotContinuityService = new ShotContinuityService(
    projectService,
    imageGenerationService,
    undefined,
    executionPool,
    generationService,
    appSettingsService,
  );
  const taskScheduleService = new TaskScheduleService(projectService, {
    enabled: process.env.AI_VIDEO_TASK_SCHEDULER_ENABLED !== '0',
    capacity: taskCapacity,
  });
  const mediaOrchestrationService = new MediaOrchestrationService(
    projectService,
    appSettingsService,
    imageGenerationService,
    videoGenerationService,
    {
      request: async (...args: Parameters<NativeProviderBridge['request']>) => {
        if (!nativeProviderBridge) throw new Error('Native Provider bridge is not configured.');
        return nativeProviderBridge.request(...args);
      },
    } as unknown as NativeProviderBridge,
    undefined,
    taskScheduleService,
    executionPool,
  );
  const projectTaskRuntime = new ProjectTaskRuntime(
    projectService,
    videoGenerationService,
    {
      request: async (...args: Parameters<NativeProviderBridge['request']>) => {
        if (!nativeProviderBridge) throw new Error('Native Provider bridge is not configured.');
        return nativeProviderBridge.request(...args);
      },
    } as Pick<NativeProviderBridge, 'request'>,
    { scheduler: taskScheduleService, images: imageGenerationService },
  );
  const dubbingService = new DubbingService(projectService, appSettingsService, {
    capacity: executionPool,
    nativeAvailable: () => Boolean(nativeProviderBridge),
    native: {
      request: async (...args: Parameters<NativeProviderBridge['request']>) => {
        if (!nativeProviderBridge) throw new Error('Native Provider bridge is not configured.');
        return nativeProviderBridge.request(...args);
      },
    },
  });
  const agentSystemToolService: AgentSystemToolService = new AgentSystemToolService(
    projectService,
    contentService,
    imageGenerationService,
    appSettingsService,
    mediaPreparationService,
    documentWorkflowService,
    maintenanceService,
    new ProjectStructureCompiler(),
    novelService,
    {
      submit: (...args) => novelBatchService.submit(...args),
      get: (...args) => novelBatchService.get(...args),
      readSource: (...args) => novelBatchService.readSource(...args),
    },
  );
  const agentProviderLoopService: AgentProviderLoopService = new AgentProviderLoopService(
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
    agentSystemToolService,
    mediaPreparationService,
    mediaOrchestrationService,
  );
  const novelBatchService: NovelBatchService = new NovelBatchService(projectService, {
    available: () => Boolean(piConversationRuntime) && resolvePiConversationRuntimeEnabled(),
    prepare: (params, target) =>
      prepareAgentGeneration(
        {
          generations: generationService,
          loop: agentProviderLoopService,
          orchestration: agentOrchestrationService,
        },
        params,
        target,
      ),
    start: async (prepared) => {
      try {
        if (!piConversationRuntime) throw new Error('Pi runtime is unavailable.');
        await piConversationRuntime.start({
          identity: prepared.stream,
          projectId: prepared.stream.projectId,
          projectSessionId: prepared.stream.projectSessionId,
          conversationId: prepared.stream.conversationId,
          taskId: prepared.agentTaskId,
          mode: 'novel-writing',
          prompt: prepared.generation.userMessage.content,
        });
      } catch (error) {
        agentProviderLoopService.terminateGeneration(
          prepared.stream.generationId,
          'failed',
          error instanceof Error ? error.message : 'Batch child could not start.',
        );
        generationService.failNative({
          ...prepared.stream,
          content: '',
          error: 'Batch child could not start.',
          retryable: true,
        });
      }
    },
    cancel: async (id) => {
      piConversationRuntime?.cancel(id);
      agentProviderLoopService.terminateGeneration(id, 'cancelled');
      await generationService.cancel(id);
    },
    discardUncommitted: () => generationService.discardUncommitted(),
  });

  const services = {
    appSettingsService,
    projectService,
    contentService,
    documentWorkflowService,
    novelService,
    agentOrchestrationService,
    partialArtifactService,
    markdownExportService,
    fileTaskService,
    changeSetService,
    taskPlanService,
    novelBatchService,
    adapterService,
    imageGenerationService,
    videoGenerationService,
    maintenanceService,
    sampleProjectService,
    contextService,
    novelContextService,
    usageService,
    generationService,
    mediaPreparationService,
    shotContinuityService,
    taskScheduleService,
    mediaOrchestrationService,
    projectTaskRuntime,
    dubbingService,
    agentSystemToolService,
    agentProviderLoopService,
    get piConversationRuntime() {
      return piConversationRuntime;
    },
    configureRuntime,
    async stop() {
      shotContinuityService.cancelAll();
      await fileTaskService.stop();
      await markdownExportService.stop();
      taskScheduleService.cancelAllWaiting();
      piConversationRuntime?.cancelAll();
      await piConversationRuntime?.drain();
      await resetRuntime(services);
    },
    recover() {
      recoverRuntime(services);
    },
    isBusy() {
      if (!projectService.current()) return false;
      return projectService.access(false, (db) =>
        Boolean(
          db
            .prepare(
              `SELECT 1 FROM llm_generations WHERE status IN ('prepared','streaming')
        UNION ALL SELECT 1 FROM generation_jobs WHERE media_state IN ('awaiting_confirmation','submitting','submission_unknown','polling','downloading')
        UNION ALL SELECT 1 FROM dubbing_jobs WHERE status IN ('pending','running','cancelling','interrupted')
        UNION ALL SELECT 1 FROM file_tasks WHERE status IN ('pending','running')
        UNION ALL SELECT 1 FROM markdown_export_jobs WHERE status IN ('queued','writing','verifying') LIMIT 1`,
            )
            .get(),
        ),
      );
    },
  };
  if (nativeProviderBridge) configureRuntime(nativeProviderBridge);
  return services;
}
type RuntimeServices = ReturnType<typeof createProjectRuntimeServices>;
const runtimeRegistry = new ProjectRuntimeRegistry(
  createProjectRuntimeServices,
  appSettingsService,
  {
    nativeBinding: packagedSqliteBinding,
    maxLoaded: process.env.AI_VIDEO_TASK_SCHEDULER_ENABLED === '0' ? 1 : 4,
  },
);
export function configurePiConversationRuntime(bridge: NativeProviderBridge): void {
  nativeProviderBridge = bridge;
  for (const runtime of runtimeRegistry.all()) runtime.configureRuntime(bridge);
  void runtimeRegistry
    .restoreRegistered()
    .catch((error: unknown) => recordWorkerError('project.runtime.restore', error));
}

/** Used by controlled host shutdown and integration harnesses after admission stops. */
export async function shutdownWorker(): Promise<void> {
  await runtimeRegistry.shutdown();
  await runtimeRegistry.fallback.stop();
  appSettingsService.close();
}

function errorResponse(id: string, error: WorkerError): WorkerResponse {
  return {
    id,
    protocolVersion: IPC_PROTOCOL_VERSION,
    ok: false,
    error: { ...error, requestId: id },
  };
}

export function recordWorkerError(operation: string, error: unknown): void {
  runtimeRegistry.fallback.maintenanceService.recordError(operation, error);
}

export function recordQueueWait(method: WorkerMethod, waitMs: number): void {
  runtimeRegistry.fallback.maintenanceService.recordQueueWait(method, waitMs);
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

  try {
    validateRuntimeScope(candidate.scope);
  } catch (error) {
    return errorResponse(id, {
      code: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid runtime scope.',
    });
  }

  return {
    id,
    protocolVersion: IPC_PROTOCOL_VERSION,
    method: candidate.method,
    params: candidate.params ?? {},
    ...(candidate.scope ? { scope: candidate.scope } : {}),
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

function listGenerationJobEvents(
  projectService: ProjectService,
  params: GenerationJobEventsListParams,
): GenerationJobEventsPage {
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
  return bindWorkerRequest(request).run();
}

function validateRuntimeScope(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RequestValidationError('Runtime scope must be an object.');
  const scope = value as Record<string, unknown>;
  if (
    Object.keys(scope).some((key) => key !== 'projectId' && key !== 'projectSessionId') ||
    [scope.projectId, scope.projectSessionId].some(
      (id) => typeof id !== 'string' || !id.trim() || id.length > 128,
    )
  )
    throw new RequestValidationError('Runtime scope requires bounded project and session IDs.');
}

const lifecycleMethods = new Set<string>([
  'project.create',
  'project.createSample',
  'project.open',
  'project.restore',
  'project.close',
]);
/** Capture ownership at ingress, before a mutation is queued. */
export function bindWorkerRequest(request: WorkerRequest): {
  queueKey: string;
  run: () => Promise<WorkerResponse>;
} {
  let services: RuntimeServices = runtimeRegistry.fallback;
  let epoch: string | undefined;
  let bindingError: unknown;
  const control = request.method.startsWith('project.runtime.');
  try {
    validateRuntimeScope(request.scope);
    services = request.scope ? runtimeRegistry.get(request.scope) : runtimeRegistry.current();
    epoch = services.projectService.currentSessionId();
  } catch (error) {
    bindingError = error;
  }
  const release = runtimeRegistry.retain(services);
  return {
    queueKey:
      control || lifecycleMethods.has(request.method)
        ? 'project-lifecycle'
        : (epoch ?? 'application'),
    run: async () => {
      const startedAt = performance.now();
      try {
        let response: WorkerResponse;
        try {
          if (bindingError)
            throw bindingError instanceof Error
              ? bindingError
              : new Error('Project runtime binding failed.');
          const params = validateSessionRequestParams(request.method, request.params);
          if (control) {
            let result: unknown;
            if (request.scope)
              throw new RequestValidationError(
                'Lifecycle controls use their explicit runtime parameters.',
              );
            if (
              [
                'project.runtime.create',
                'project.runtime.createSample',
                'project.runtime.restore',
              ].includes(request.method)
            ) {
              const method = request.method.replace('project.runtime.', 'project.') as WorkerMethod;
              const created = (await runtimeRegistry.replace(async (runtime) => {
                const response = await executeInfrastructureCommand(method, params, {
                  ...runtime,
                  appSettingsService,
                });
                return response.result;
              })) as import('@ai-video/contracts').ProjectInfo;
              result = runtimeRegistry.list().find((entry) => entry.project.id === created.id)!;
            } else if (request.method === 'project.runtime.attach')
              result = await runtimeRegistry.attach(
                params as unknown as import('@ai-video/contracts').WorkerMethodMap['project.runtime.attach']['params'],
              );
            else if (request.method === 'project.runtime.activate')
              result = await runtimeRegistry.activate(
                params as unknown as import('@ai-video/contracts').ProjectRuntimeScope,
              );
            else if (request.method === 'project.runtime.unload')
              result = await runtimeRegistry.unload(
                params as unknown as import('@ai-video/contracts').ProjectRuntimeScope,
              );
            else if (request.method === 'project.runtime.registrations')
              result = appSettingsService.listRuntimeRegistrations();
            else result = runtimeRegistry.list();
            response = {
              id: request.id,
              protocolVersion: IPC_PROTOCOL_VERSION,
              ok: true,
              result,
            } as WorkerResponse;
          } else if (lifecycleMethods.has(request.method)) {
            runtimeRegistry.assertBound(services, epoch);
            if (request.method !== 'project.close')
              requireString(params, 'rootPath' in params ? 'rootPath' : 'destinationRoot');
            const previous = epoch
              ? { projectId: services.projectService.current()!.id, projectSessionId: epoch }
              : undefined;
            const result =
              request.method === 'project.close'
                ? previous
                  ? await runtimeRegistry.unload(previous)
                  : { closed: true }
                : await runtimeRegistry.replace(async (runtime) => {
                    const result = await executeInfrastructureCommand(request.method, params, {
                      ...runtime,
                      appSettingsService,
                    });
                    return result.result;
                  }, previous);
            response = {
              id: request.id,
              protocolVersion: IPC_PROTOCOL_VERSION,
              ok: true,
              result,
            } as WorkerResponse;
          } else {
            runtimeRegistry.assertBound(services, epoch);
            response = await handleRequestCore(request, services);
          }
        } catch (error) {
          response = errorResponse(request.id, mapWorkerError(request.method, error));
        }
        services.maintenanceService.recordRequest(
          request.method,
          request.id,
          response.ok,
          performance.now() - startedAt,
        );
        return response;
      } finally {
        release();
      }
    },
  };
}

async function handleRequestCore(
  request: WorkerRequest,
  services: RuntimeServices,
): Promise<WorkerResponse> {
  const {
    projectService,
    contentService,
    documentWorkflowService,
    novelService,
    agentOrchestrationService,
    partialArtifactService,
    markdownExportService,
    fileTaskService,
    changeSetService,
    adapterService,
    imageGenerationService,
    videoGenerationService,
    maintenanceService,
    sampleProjectService,
    contextService,
    novelContextService,
    usageService,
    generationService,
    mediaPreparationService,
    taskScheduleService,
    mediaOrchestrationService,
    projectTaskRuntime,
    dubbingService,
    agentProviderLoopService,
    shotContinuityService,
    piConversationRuntime,
    novelBatchService,
  } = services;
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
    if (
      request.method === 'maintenance.cache.clear' &&
      dubbingService
        .listJobs()
        .some((job) => ['pending', 'running', 'cancelling'].includes(job.status))
    )
      throw new DubbingValidationError(
        'MEDIA_BUSY',
        '配音制作进行中，请完成或停止任务后清理缓存。',
      );
    let result: unknown;
    const infrastructure = await executeInfrastructureCommand(request.method, params, {
      projectService,
      sampleProjectService,
      appSettingsService,
      usageService,
      maintenanceService,
      generationService,
      agentProviderLoopService,
      agentOrchestrationService,
      partialArtifactService,
      markdownExportService,
      mediaOrchestrationService,
      imageGenerationService,
      videoGenerationService,
      projectTaskRuntime,
      dubbingService,
      shotContinuityService,
    });
    if (infrastructure.handled) {
      result = infrastructure.result;
    } else {
      switch (request.method) {
        case 'production.defaults.get':
          result = new ProductionService(projectService).getDefaults();
          break;
        case 'production.defaults.save':
          result = new ProductionService(projectService).saveDefaults(
            params as unknown as {
              expectedRowVersion: number;
              settings: import('@ai-video/contracts').ProductionDefaults;
            },
          );
          break;
        case 'production.read':
          result = new ProductionService(projectService).read(
            params.target as import('@ai-video/contracts').ProductionTarget,
          );
          break;
        case 'shot.continuity.get':
          result = shotContinuityService.get(requireString(params, 'shotId'));
          break;
        case 'shot.continuity.preview':
          result = await shotContinuityService.preview(
            params as unknown as import('@ai-video/contracts').ShotContinuityPreviewParams,
          );
          break;
        case 'shot.continuity.confirm':
          result = await shotContinuityService.confirm(
            params as unknown as import('@ai-video/contracts').ShotContinuityConfirmParams,
          );
          break;
        case 'shot.continuity.clear':
          result = shotContinuityService.clear(
            requireString(params, 'shotId'),
            params.expectedRowVersion as number,
          );
          break;
        case 'shot.continuity.firstFrame':
          result = shotContinuityService.firstFrame(
            requireString(params, 'shotId'),
            params.expectedRowVersion as number,
            requireString(params, 'assetId'),
          );
          break;
        case 'shot.continuity.prompt.prepare':
          result = await shotContinuityService.preparePrompt(
            params as unknown as import('@ai-video/contracts').ShotContinuityPromptPrepareParams,
          );
          break;
        case 'shot.continuity.prompt.save':
          result = shotContinuityService.savePrompt(
            requireString(params, 'shotId'),
            params.expectedRowVersion as number,
            params.kind as 'image' | 'video',
            requireString(params, 'prompt'),
          );
          break;
        case 'production.compile':
          result = new ProductionService(projectService).compile(
            params as unknown as import('@ai-video/contracts').ProductionCompileParams,
          );
          break;
        case 'scene.media.resolve':
          result = resolveSceneMedia(
            projectService,
            params as unknown as import('@ai-video/contracts').SceneMediaResolveParams,
          );
          break;
        case 'characterVoice.list':
          result = dubbingService.listVoices(params.includeArchived === true);
          break;
        case 'characterVoiceReference.list':
          result = projectService.access(false, (database, project) =>
            new VoiceReferenceRepository(database, project.id).list(),
          );
          break;
        case 'characterVoiceReference.save':
          result = projectService.access(true, (database, project) =>
            new VoiceReferenceRepository(database, project.id).save(
              params as unknown as CharacterVoiceReferenceSaveParams,
            ),
          );
          break;
        case 'characterVoice.save':
          result = dubbingService.saveVoice(
            params as unknown as DubbingWorkerMethodMap['characterVoice.save']['params'],
          );
          break;
        case 'audio.import':
          result = await dubbingService.importAudio(
            params as unknown as DubbingWorkerMethodMap['audio.import']['params'],
          );
          break;
        case 'audio.list':
          result = dubbingService.listAudio(params);
          break;
        case 'audio.get':
          result = dubbingService.audio(requireString(params, 'audioId'));
          break;
        case 'audio.mediaSource':
          result = dubbingService.audioSource(requireString(params, 'audioId'));
          break;
        case 'audio.trash':
          result = dubbingService.trashAudio(requireString(params, 'audioId'));
          break;
        case 'audio.restore':
          result = dubbingService.restoreAudio(requireString(params, 'audioId'));
          break;
        case 'audio.purge':
          result = dubbingService.purgeAudio(
            requireString(params, 'audioId'),
            params.confirm === true,
          );
          break;
        case 'dubbing.runtime.get':
          result = await dubbingService.runtimeInfo();
          break;
        case 'dubbing.scene.get':
          result = dubbingService.scene(requireString(params, 'sceneId'));
          break;
        case 'dubbing.cue.save':
          result = dubbingService.saveCue(
            params as unknown as DubbingWorkerMethodMap['dubbing.cue.save']['params'],
          );
          break;
        case 'dubbing.cue.delete':
          result = dubbingService.deleteCue(
            requireString(params, 'cueId'),
            requireNumber(params, 'expectedRowVersion'),
          );
          break;
        case 'dubbing.take.generate':
          result = dubbingService.generateTake(
            params as unknown as DubbingWorkerMethodMap['dubbing.take.generate']['params'],
          );
          break;
        case 'dubbing.take.adopt':
          result = dubbingService.adoptTake(
            requireString(params, 'cueId'),
            requireString(params, 'takeId'),
            requireNumber(params, 'expectedRowVersion'),
          );
          break;
        case 'dubbing.job.submit':
          result = await dubbingService.submit(
            params as unknown as DubbingWorkerMethodMap['dubbing.job.submit']['params'],
          );
          break;
        case 'dubbing.job.cancel':
          result = dubbingService.cancel(requireString(params, 'jobId'));
          break;
        case 'dubbing.job.retry':
          result = dubbingService.retry(
            params as unknown as DubbingWorkerMethodMap['dubbing.job.retry']['params'],
          );
          break;
        case 'dubbing.job.get':
          result = dubbingService.getJob(requireString(params, 'jobId'));
          break;
        case 'dubbing.job.list':
          result = dubbingService.listJobSummaries(
            typeof params.sceneId === 'string' ? params.sceneId : undefined,
          );
          break;
        case 'dubbing.output.adopt':
          result = dubbingService.adoptOutput(
            requireString(params, 'jobId'),
            requireNumber(params, 'expectedRowVersion'),
          );
          break;
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
          {
            const job = fileTaskService.create({
              kind: 'novel-import',
              input: params as unknown as NovelImportParams,
              idempotencyKey: `legacy:${request.id}`,
            });
            const completed = await fileTaskService.wait(job.id);
            if (completed.status !== 'succeeded')
              throw new Error(completed.error ?? 'Novel import failed.');
            result = completed.result;
          }
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
          result = await markdownExportService.prepare(
            params as unknown as NovelMarkdownExportPrepareParams,
          );
          break;
        case 'novel.export.start':
          result = markdownExportService.start(
            params as unknown as NovelMarkdownExportPrepareParams,
          );
          break;
        case 'novel.export.get':
          result = markdownExportService.get(String(params.jobId));
          break;
        case 'novel.export.list':
          result = markdownExportService.list();
          break;
        case 'novel.export.cancel':
          result = await markdownExportService.cancel(String(params.jobId));
          break;
        case 'file.task.create':
          result = fileTaskService.create(
            params as unknown as import('@ai-video/contracts').FileTaskCreateParams,
          );
          break;
        case 'file.task.get':
          result = fileTaskService.get(String(params.taskId));
          break;
        case 'file.task.list':
          result = fileTaskService.list();
          break;
        case 'file.task.cancel':
          result = await fileTaskService.cancel(String(params.taskId));
          break;
        case 'novel.export.reveal':
          result = await markdownExportService.reveal({ jobId: requireString(params, 'jobId') });
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
          const capabilityHint = 'text' as const;
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
                  .filter((model) => {
                    if (
                      !modelMatchesUnifiedAgentRequest(
                        'text',
                        model,
                        profile.providerType,
                        adapterCatalog,
                        hasImageAttachment,
                      )
                    )
                      return false;
                    try {
                      assertAgentToolLoopSelection(profile, model);
                      return true;
                    } catch {
                      return false;
                    }
                  })
                  .map((model) => ({
                    providerProfileId: profile.id,
                    providerName: profile.name,
                    modelId: model.id,
                    remoteModelId: model.remoteModelId,
                    modelName: model.displayName,
                    capabilities: model.capabilities,
                    source: model.source,
                    schemaReady: true,
                  }))
              : [],
          );

          let storedPreference: ReturnType<
            ContentService['getConversationModelPreference']
          > | null = null;
          if (!agentParams.providerProfileId && !agentParams.modelId) {
            try {
              storedPreference = contentService.getConversationModelPreference({
                conversationId: agentParams.conversationId,
                capability: 'text',
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
              capability: 'text',
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
            const requestedProfile = profiles.find(
              (profile) => profile.id === requestedProviderProfileId,
            );
            const requestedModel = requestedProfile
              ? appSettingsService
                  .listModels(requestedProfile.id)
                  .find((model) => model.id === requestedModelId)
              : undefined;
            let reason: 'model_unavailable' | 'capability_mismatch' | 'agent_tools_required' =
              'model_unavailable';
            if (requestedProfile && requestedModel) {
              if (
                isRetiredAgentModel(requestedProfile.providerType, requestedModel.remoteModelId)
              ) {
                reason = 'model_unavailable';
              } else {
                try {
                  assertAgentToolLoopSelection(requestedProfile, requestedModel);
                  reason =
                    hasImageAttachment && requestedModel.capabilities.vision !== true
                      ? 'capability_mismatch'
                      : 'model_unavailable';
                } catch {
                  reason = 'agent_tools_required';
                }
              }
            }
            result = {
              status: 'needs_model_selection',
              capability: 'text',
              reason,
              models: candidates,
            };
            break;
          }

          const profile = appSettingsService.getProfile(selected.providerProfileId);
          if (!profile) throw new ProviderProfileValidationError('Provider profile was not found.');
          const model = appSettingsService
            .listModels(selected.providerProfileId)
            .find((candidate) => candidate.id === selected.modelId);
          assertAgentToolLoopSelection(profile, model);
          const provenance = {
            source: storedPreference ? ('conversation-preference' as const) : ('request' as const),
            capability: 'text' as const,
            confirmedAt: storedPreference?.confirmedAt ?? new Date().toISOString(),
          };
          // Every project request uses the same System Agent. Chapter
          // shortcuts supply optional context for the model.
          // Semantic interpretation belongs to the LLM. UI intent is only a hint.
          const novelIntent = agentParams.novelIntent;
          const documentIntent = { operation: 'document.list' as const };
          const prepared = prepareAgentGeneration(
            {
              generations: generationService,
              loop: agentProviderLoopService,
              orchestration: agentOrchestrationService,
            },
            {
              conversationId: agentParams.conversationId,
              prompt: agentParams.prompt,
              ...(resolvePiConversationRuntimeEnabled()
                ? { taskExecution: agentParams.taskExecution ?? ('parallel' as const) }
                : {}),
              providerProfileId: selected.providerProfileId,
              modelId: selected.modelId,
              attachments: agentParams.attachments,
              budgetTokens: agentParams.budgetTokens,
              idempotencyKey: agentParams.idempotencyKey,
              agentMode: 'document',
              researchMode: agentParams.researchMode,
              documentIntent,
              selectedChapterIds: agentParams.selectedChapterIds,
              targetPlatform: agentParams.targetPlatform,
              ...(novelIntent ? { novelIntent } : {}),
            },
            undefined,
            provenance,
          );
          result = {
            status: 'started',
            capability: capabilityHint,
            ...prepared,
            runtimeOwner: resolvePiConversationRuntimeEnabled() ? 'pi' : 'native-agent',
            runtimeMode: 'document',
          };
          break;
        }
        case 'agent.generation.prepare': {
          const agentParams = params as unknown as AgentGenerationPrepareParams;
          const profile = appSettingsService.getProfile(agentParams.providerProfileId);
          if (!profile) {
            throw new ProviderProfileValidationError('Provider profile was not found.');
          }
          const model = appSettingsService
            .listModels(agentParams.providerProfileId)
            .find((candidate) => candidate.id === agentParams.modelId);
          assertAgentToolLoopSelection(profile, model);
          // `agentMode` is retained at the IPC boundary for compatibility with
          // older Desktop callers. It never selects an Agent persona: all
          // requests use the same project System Agent and resolver.
          // Semantic interpretation belongs to the LLM. UI intent is only a hint.
          const novelIntent = agentParams.novelIntent;
          const documentIntent = agentParams.documentIntent ?? {
            operation: 'document.list' as const,
          };
          const selectedChapterIds = agentParams.selectedChapterIds;
          const targetPlatform = agentParams.targetPlatform;
          const prepared = prepareAgentGeneration(
            {
              generations: generationService,
              loop: agentProviderLoopService,
              orchestration: agentOrchestrationService,
            },
            {
              ...agentParams,
              agentMode: 'document',
              documentIntent,
              selectedChapterIds,
              targetPlatform,
              ...(novelIntent ? { novelIntent } : {}),
            },
            undefined,
            {
              source: 'request',
              capability: 'text',
              confirmedAt: new Date().toISOString(),
            },
          );
          result = {
            ...prepared,
            runtimeOwner: resolvePiConversationRuntimeEnabled() ? 'pi' : 'native-agent',
            runtimeMode: 'document',
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
        case 'novel.batch.get':
          result = novelBatchService.get(String(params.batchId));
          break;
        case 'novel.batch.cancel':
          result = await novelBatchService.cancel(String(params.batchId));
          break;
        case 'conversation.runtime.supplement':
          if (!piConversationRuntime?.hasActive(String(params.generationId)))
            throw new Error('Target runtime is no longer accepting input.');
          result = generationService.supplement(
            String(params.generationId),
            String(params.content),
            String(params.idempotencyKey),
          );
          break;
        case 'conversation.runtime.list':
          result = piConversationRuntime?.list() ?? [];
          break;
        case 'conversation.runtime.get': {
          if (!piConversationRuntime) throw new Error('Pi conversation runtime is not configured.');
          result = piConversationRuntime.get(requireString(params, 'generationId'));
          break;
        }
        case 'conversation.runtime.confirm': {
          if (!piConversationRuntime) throw new Error('Pi conversation runtime is not configured.');
          result = {
            accepted: piConversationRuntime.confirm(
              requireString(params, 'generationId'),
              requireString(params, 'confirmationToken'),
              params.approved === true,
            ),
          };
          break;
        }
        case 'conversation.runtime.selectMedia': {
          if (!piConversationRuntime) throw new Error('Pi conversation runtime is not configured.');
          const mediaParams =
            params as unknown as import('@ai-video/contracts').ConversationRuntimeSelectMediaParams;
          result = {
            accepted: piConversationRuntime.selectMedia(
              requireString(params, 'generationId'),
              requireString(params, 'selectionToken'),
              mediaParams.selection,
            ),
          };
          break;
        }
        case 'conversation.runtime.confirmMediaSubmission': {
          if (!piConversationRuntime) throw new Error('Pi conversation runtime is not configured.');
          result = {
            accepted: piConversationRuntime.confirmMediaSubmission(
              requireString(params, 'generationId'),
              requireString(params, 'jobId'),
              requireString(params, 'confirmationToken'),
              params.approved === true,
            ),
          };
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
        case 'agent.generation.confirmMediaSubmission': {
          const confirmationParams =
            params as unknown as AgentGenerationConfirmMediaSubmissionParams;
          const execution =
            await agentProviderLoopService.confirmMediaSubmission(confirmationParams);
          generationService.configureAgentTools(
            confirmationParams,
            execution.tools ?? [],
            execution.continuation,
          );
          result = execution;
          break;
        }
        case 'agent.generation.selectMedia': {
          const selectionParams = params as unknown as AgentGenerationSelectMediaParams;
          const execution = agentProviderLoopService.selectMedia(selectionParams);
          generationService.configureAgentTools(
            selectionParams,
            execution.tools ?? [],
            execution.continuation,
          );
          result = execution;
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
          result = listGenerationJobEvents(
            projectService,
            params as unknown as GenerationJobEventsListParams,
          );
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
        case 'conversation.promptTemplate.get':
          result = contentService.getConversationPromptTemplate(
            requireString(params, 'conversationId'),
          );
          break;
        case 'conversation.promptTemplate.save':
          result = contentService.saveConversationPromptTemplate(
            params as unknown as ConversationPromptTemplateSaveParams,
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
            adapterService,
            'image',
            imageParams.adapterKey,
            imageParams.providerProfileId,
            imageParams.modelId,
          );
          result = mediaPreparationService.prepareImage({
            ...imageParams,
            providerProfileId: selection.profile.id,
            modelId: selection.model.id,
            mediaModelSelection: selection.mediaModelSelection,
          });
          break;
        }
        case 'media.generation.requestSubmission':
          result = mediaOrchestrationService.requestSubmission(
            params as unknown as MediaSubmissionRequestParams,
          );
          projectTaskRuntime.kick();
          break;
        case 'media.generation.confirmSubmission':
          result = await mediaOrchestrationService.confirmSubmission(
            params as unknown as MediaSubmissionConfirmParams,
          );
          projectTaskRuntime.kick();
          break;
        case 'media.task.cancel':
          result = await mediaOrchestrationService.cancel(
            params as unknown as MediaTaskCancelParams,
          );
          projectTaskRuntime.kick();
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
            projectSessionId:
              typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
            dataUrl: requireString(params, 'dataUrl'),
            contentType: requireString(params, 'contentType'),
            assetKind: optionalImageAssetKind(params, 'assetKind'),
          } satisfies ImageGenerationSavePreviewParams);
          break;
        case 'image.generate.fail':
          result = imageGenerationService.failTransport(
            requireString(params, 'jobId'),
            typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          );
          break;
        case 'image.generate.cancel':
          result = imageGenerationService.cancel(
            requireString(params, 'jobId'),
            typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          );
          break;
        case 'image.generate.get':
          result = imageGenerationService.get(requireString(params, 'jobId'));
          break;
        case 'video.generate.prepare': {
          const videoParams = params as unknown as VideoGenerationPrepareParams;
          const selection = resolveMediaSelectionForRequest(
            adapterService,
            'video',
            requireString(params, 'adapterKey'),
            videoParams.providerProfileId,
            videoParams.modelId,
            videoParams.providerRegion,
          );
          result = mediaPreparationService.prepareVideo({
            ...videoParams,
            adapterKey: requireString(params, 'adapterKey'),
            providerRegion: selection.providerRegion,
            providerProfileId: selection.profile.id,
            modelId: selection.model.id,
            mediaModelSelection: selection.mediaModelSelection,
            assetKind: optionalVideoAssetKind(params, 'assetKind'),
          });
          projectTaskRuntime.kick();
          break;
        }
        case 'video.generate.attachTask':
          result = videoGenerationService.attachTask({
            jobId: requireString(params, 'jobId'),
            providerTaskId: requireString(params, 'providerTaskId'),
            projectSessionId:
              typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          } satisfies VideoGenerationAttachTaskParams);
          projectTaskRuntime.kick();
          break;
        case 'video.generate.observe':
          result = videoGenerationService.observe({
            jobId: requireString(params, 'jobId'),
            providerTaskId: requireString(params, 'providerTaskId'),
            providerStatus: requireNumber(params, 'providerStatus'),
            providerBody: params.providerBody,
            projectSessionId:
              typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          } satisfies VideoGenerationObserveParams);
          projectTaskRuntime.kick();
          break;
        case 'video.generate.fail':
          result = videoGenerationService.fail({
            jobId: requireString(params, 'jobId'),
            failureKind: requireVideoFailureKind(params, 'failureKind'),
            message: typeof params.message === 'string' ? params.message : undefined,
            projectSessionId:
              typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          } satisfies VideoGenerationFailParams);
          projectTaskRuntime.kick();
          break;
        case 'video.generate.pause':
          result = videoGenerationService.pause(requireString(params, 'jobId'));
          projectTaskRuntime.kick();
          break;
        case 'video.generate.resume':
          result = videoGenerationService.resume(requireString(params, 'jobId'));
          projectTaskRuntime.kick();
          break;
        case 'video.generate.timeout':
          result = videoGenerationService.timeout(
            requireString(params, 'jobId'),
            typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          );
          projectTaskRuntime.kick();
          break;
        case 'video.generate.cancel':
          result = videoGenerationService.cancel(
            requireString(params, 'jobId'),
            typeof params.projectSessionId === 'string' ? params.projectSessionId : undefined,
          );
          projectTaskRuntime.kick();
          break;
        case 'video.generate.get':
          result = videoGenerationService.get(requireString(params, 'jobId'));
          break;
        case 'video.generate.list':
          result = videoGenerationService.list();
          break;
        case 'task.schedule.list':
        case 'task.schedule.get':
        case 'task.schedule.events':
        case 'task.schedule.create':
        case 'task.schedule.cancel': {
          if (params.projectId !== projectService.current()?.id)
            throw new RequestValidationError('Scheduled task project scope is stale.');
          if (
            (request.method === 'task.schedule.create' ||
              request.method === 'task.schedule.cancel') &&
            params.projectSessionId !== projectService.currentSessionId()
          )
            throw new RequestValidationError('Scheduled task runtime scope is stale.');
          const id = (key: string) => {
            const value = requireString(params, key);
            if (value.length > 128) throw new RequestValidationError('Task ID exceeds its limit.');
            return value;
          };
          if (request.method === 'task.schedule.list') result = taskScheduleService.list();
          else if (request.method === 'task.schedule.get')
            result = taskScheduleService.get(id('taskId'));
          else if (request.method === 'task.schedule.events') {
            const after = params.afterSequence ?? 0;
            if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)
              throw new RequestValidationError('Event sequence is invalid.');
            result = taskScheduleService.events(id('taskId'), after);
          } else if (request.method === 'task.schedule.create') {
            const upstream = params.upstreamTaskIds ?? [];
            if (
              !Array.isArray(upstream) ||
              upstream.length > 32 ||
              upstream.some(
                (value: unknown) =>
                  typeof value !== 'string' || !value.trim() || value.length > 128,
              )
            )
              throw new RequestValidationError('Task dependencies are invalid.');
            result = taskScheduleService.register(id('jobId'), upstream as string[]);
          } else {
            const task = taskScheduleService.get(id('taskId'));
            result = await mediaOrchestrationService.cancel({ jobId: task.ownerJobId });
          }
          break;
        }
        case 'project.task.subscribe':
          result = projectTaskRuntime.snapshot(
            typeof params.afterRevision === 'number' ? params.afterRevision : -1,
          );
          {
            const snapshot = result as import('@ai-video/contracts').ProjectTaskSnapshot;
            const dubbingJobs = dubbingService.listJobSummaries();
            const revision = snapshot.revision + dubbingService.getRevision();
            result = {
              ...snapshot,
              revision,
              changed: revision !== params.afterRevision,
              dubbingJobs,
              activeCount:
                snapshot.activeCount +
                dubbingJobs.filter((job) =>
                  ['pending', 'running', 'interrupted'].includes(job.status),
                ).length,
            };
          }
          break;
        case 'asset.list':
          result = imageGenerationService.listAssets({
            kind: typeof params.kind === 'string' ? params.kind : undefined,
            sceneId: typeof params.sceneId === 'string' ? params.sceneId : undefined,
            sourceDocumentId:
              typeof params.sourceDocumentId === 'string' ? params.sourceDocumentId : undefined,
            shotId: typeof params.shotId === 'string' ? params.shotId : undefined,
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
          dubbingService.assertVideoDeletable(requireString(params, 'assetId'), false);
          result = imageGenerationService.deleteAsset(
            requireString(params, 'assetId'),
            params.confirm === true,
          );
          break;
        case 'asset.restore':
          result = imageGenerationService.restoreAsset(requireString(params, 'assetId'));
          break;
        case 'asset.purge':
          dubbingService.assertVideoDeletable(requireString(params, 'assetId'), true);
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
  if (error instanceof ProjectRuntimeScopeError)
    return { code: 'STALE_SESSION', message, retryable: false, operation };
  if (error instanceof RequestValidationError) {
    return { code: 'INVALID_REQUEST', message, retryable: false, operation };
  }
  if (error instanceof ConversationBusyError) {
    return { code: 'CONFLICT', message, retryable: false, operation };
  }
  if (error instanceof DubbingValidationError) {
    return {
      code: 'INVALID_PARAMETERS',
      message,
      retryable: false,
      operation,
      details: { dubbingCode: error.code },
    };
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
  if (value === 'generated-video' || value === 'shot-video' || value === 'scene-video')
    return value;
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
