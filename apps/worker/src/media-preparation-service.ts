import type {
  AdapterDescriptor,
  AdapterParameters,
  ImageAssetKind,
  ImageGenerationJobInfo,
  ImageGenerationPrepareParams,
  LlmGenerationIdentity,
  LlmInputAttachment,
  MediaGenerationDraft,
  MediaGenerationKind,
  MediaInputReferenceV1,
  MediaModelCandidate,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
  MediaModelSelectionSnapshot,
  MediaProviderBaseUrlCategory,
  MediaProviderType,
  MediaTaskSummary,
  ModelPricingInfo,
  ProviderModelInfo,
  ProviderProfileInfo,
  VideoAssetKind,
  VideoGenerationJobInfo,
  VideoGenerationPrepareParams,
  VideoProviderRegion,
} from '@ai-video/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  isWanVideoBaseUrl,
  isWanMediaAdapter,
  seedProductionInputs,
  productionImagesFromParameters,
  addProductionRoleVoices,
  supportsProductionAudioUpload,
  productionInputSupport,
} from '@ai-video/contracts';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { adapterBindsCatalogModel, getAdapter } from '@ai-video/generation-adapters';
import { createRepositories } from '@ai-video/persistence';
import type { AdapterService } from './adapter-service.js';
import type { AppSettingsService } from './app-settings-service.js';
import { AgentToolPolicyError } from './agent-tool-registry.js';
import type { ImageGenerationService } from './image-generation-service.js';
import { resolveProjectRelativePath, type ProjectService } from './project-service.js';
import { assertStorageCapacity } from './storage-capacity.js';
import type { VideoGenerationService } from './video-generation-service.js';
import { isOfficialVideoAdapter, materializeOfficialVideoInputs } from './official-video-inputs.js';
import { ProductionService } from './production-service.js';

const MAX_MEDIA_CANDIDATES = 50;
const MAX_MEDIA_PARAMETERS = 40;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONTROLLED_IMAGE_BYTES = 25 * 1024 * 1024;

export interface MediaPrepareArguments {
  prompt: string;
  inputAssetIds: string[];
  parameters: AdapterParameters;
  shotId?: string;
  sceneId?: string;
  assetKind?: ImageAssetKind | VideoAssetKind;
}

export interface MediaSelectionContext {
  kind: MediaGenerationKind;
  arguments: MediaPrepareArguments;
  inputAttachmentCount: number;
  inputAttachments: MediaAttachmentSnapshot[];
  candidates: MediaModelCandidate[];
}

interface MediaAttachmentSnapshot {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  sha256: string;
}

interface MaterializedMediaInputs {
  references: MediaInputReferenceV1[];
  paths: string[];
  parameters: AdapterParameters;
}

type MediaIdentity = LlmGenerationIdentity;

/** Worker-owned media catalog, selection validation, and local draft boundary. */
export class MediaPreparationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly settings: AppSettingsService,
    private readonly adapters: AdapterService,
    private readonly images: ImageGenerationService,
    private readonly videos: VideoGenerationService,
    private readonly resolveAttachments: (
      identity: MediaIdentity,
    ) => LlmInputAttachment[] = () => [],
  ) {}

  prepareImage(params: ImageGenerationPrepareParams): ImageGenerationJobInfo {
    params = this.prepareProductionDraft(params);
    const materialized = this.materializeInputs([], params.parameters);
    try {
      return this.images.prepare({
        ...params,
        mediaInputReferences: materialized.references,
        mediaSubmissionParameters: materialized.parameters,
      });
    } catch (error) {
      cleanupMaterializedPaths(materialized.paths);
      throw error;
    }
  }

  prepareVideo(params: VideoGenerationPrepareParams): VideoGenerationJobInfo {
    params = this.prepareProductionDraft(params);
    if (isOfficialVideoAdapter(params.adapterKey)) {
      const profile = params.providerProfileId
        ? this.settings.getProfile(params.providerProfileId)
        : undefined;
      const route = profile ? resolveMediaProviderRoute(profile) : undefined;
      const model = profile
        ? this.settings
            .listModels(profile.id)
            .find((item) => item.id === params.modelId || item.remoteModelId === params.modelId)
        : undefined;
      const adapter = getAdapter(params.adapterKey);
      if (
        !profile ||
        !route ||
        !profile.enabled ||
        profile.connectionStatus !== 'ready' ||
        !model ||
        !model.enabled ||
        model.unavailableAt ||
        !adapter ||
        model.contractRevision !== adapter.contractRevision ||
        route.providerRegion !== params.providerRegion ||
        !adapterBindsCatalogModel(adapter, {
          providerType: profile.providerType,
          remoteModelId: model.remoteModelId,
          contractStatus: model.contractStatus,
        })
      )
        throw new Error('所选官方视频连接、模型或合同当前不可用。');
      params = {
        ...params,
        mediaModelSelection: this.snapshot(
          {
            providerProfileId: profile.id,
            modelId: model.id,
            remoteModelId: model.remoteModelId,
            contractId: model.contractId,
            contractRevision: model.contractRevision,
            contractStatus: model.contractStatus,
          },
          adapter,
        ),
      };
    }
    const materialized =
      isOfficialVideoAdapter(params.adapterKey) || isWanMediaAdapter(getAdapter(params.adapterKey))
        ? materializeOfficialVideoInputs(this.projects, params)
        : this.materializeInputs([], params.parameters);
    try {
      return this.videos.prepare({
        ...params,
        mediaInputReferences: materialized.references,
        mediaSubmissionParameters: materialized.parameters,
      });
    } catch (error) {
      cleanupMaterializedPaths(materialized.paths);
      throw error;
    }
  }

  private prepareProductionDraft<
    T extends ImageGenerationPrepareParams | VideoGenerationPrepareParams,
  >(params: T): T {
    if (params.productionSource) return params;
    const target =
      'sceneId' in params && params.sceneId
        ? { kind: 'scene' as const, id: params.sceneId }
        : params.shotId
          ? { kind: 'shot' as const, id: params.shotId }
          : undefined;
    if (!target) return params;
    const compiled = new ProductionService(this.projects).compile({
      target,
      adapterKey: params.adapterKey,
    });
    if (compiled.issues.length)
      throw new Error(compiled.issues.map((issue) => issue.message).join('\n'));
    return compiled.source
      ? {
          ...params,
          productionSource: compiled.source,
          parameters: { ...compiled.parameters, ...params.parameters },
        }
      : params;
  }

  selectionContext(
    kind: MediaGenerationKind,
    rawArguments: unknown,
    identity: MediaIdentity,
  ): MediaSelectionContext {
    this.assertIdentity(identity);
    const args = parseMediaPrepareArguments(kind, rawArguments);
    this.assertInputAssets(args.inputAssetIds);
    const inputAttachments = this.resolveAttachments(identity).flatMap((attachment) => {
      if (!attachment.mimeType.toLowerCase().startsWith('image/') || !attachment.dataUrl) return [];
      const parsed = parseCanonicalImageDataUrl(attachment.dataUrl);
      if (normalizeImageContentType(attachment.mimeType) !== parsed.contentType) {
        throw new AgentToolPolicyError(
          'AGENT_TOOL_ARGUMENTS_INVALID',
          'An image attachment MIME type does not match its encoded content.',
          true,
        );
      }
      return [{ contentType: parsed.contentType, sha256: parsed.sha256 }];
    });
    const inputAttachmentCount = inputAttachments.length;
    return {
      kind,
      arguments: args,
      inputAttachmentCount,
      inputAttachments,
      candidates: this.listCandidates(
        kind,
        args.inputAssetIds.length +
          inputAttachmentCount +
          (Array.isArray(args.parameters.images) ? args.parameters.images.length : 0),
        typeof args.parameters.video === 'string',
      ),
    };
  }

  selectionRequest(
    context: MediaSelectionContext,
    selectionToken: string,
    expiresAt: string,
  ): MediaModelSelectionRequest {
    return {
      selectionToken,
      kind: context.kind,
      prompt: context.arguments.prompt,
      inputAssetIds: [...context.arguments.inputAssetIds],
      inputAttachmentCount: context.inputAttachmentCount,
      proposedParameters: cloneParameters(context.arguments.parameters),
      candidates: structuredClone(context.candidates),
      expiresAt,
    };
  }

  prepareSelected(
    context: MediaSelectionContext,
    selection: MediaModelSelectionDecision,
    identity: MediaIdentity,
  ): MediaGenerationDraft {
    this.assertIdentity(identity);
    this.assertInputAssets(context.arguments.inputAssetIds);
    const current = this.listCandidates(
      context.kind,
      context.arguments.inputAssetIds.length +
        context.inputAttachmentCount +
        (Array.isArray(context.arguments.parameters.images)
          ? context.arguments.parameters.images.length
          : 0),
      typeof context.arguments.parameters.video === 'string',
    );
    const candidate = current.find(
      (item) =>
        item.providerProfileId === selection.providerProfileId &&
        item.modelId === selection.modelId,
    );
    const adapter = candidate?.adapters.find((item) => item.key === selection.adapterKey);
    if (!candidate || !adapter) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_ARGUMENTS_INVALID',
        'The selected media Provider, model, or adapter is no longer available.',
        true,
      );
    }
    const frozenCandidate = context.candidates.find(
      (item) =>
        item.providerProfileId === candidate.providerProfileId &&
        item.modelId === candidate.modelId,
    );
    const frozenAdapter = frozenCandidate?.adapters.find((item) => item.key === adapter.key);
    if (
      !frozenCandidate ||
      !frozenAdapter ||
      frozenAdapter.schemaVersion !== adapter.schemaVersion ||
      frozenCandidate.providerRegion !== candidate.providerRegion ||
      frozenCandidate.remoteModelId !== candidate.remoteModelId
    ) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_ARGUMENTS_TAMPERED',
        'The media selection changed after it was shown to the user.',
        true,
      );
    }

    const target = context.arguments.sceneId
      ? { kind: 'scene' as const, id: context.arguments.sceneId }
      : context.arguments.shotId
        ? { kind: 'shot' as const, id: context.arguments.shotId }
        : undefined;
    const production = target
      ? new ProductionService(this.projects).compile({
          target,
          adapterKey: adapter.key,
          ...(context.arguments.inputAssetIds.length
            ? {
                inputImages: context.arguments.inputAssetIds.map((assetId) => ({
                  assetId,
                  role: 'reference' as const,
                })),
              }
            : {}),
        })
      : undefined;
    if (production?.issues.length)
      throw new Error(production.issues.map((issue) => issue.message).join('\n'));
    let parameters = this.normalizeParameters(
      production
        ? {
            ...context,
            arguments: {
              ...context.arguments,
              parameters: { ...production.parameters, ...context.arguments.parameters },
            },
          }
        : context,
      adapter,
      selection.parameters,
    );
    const audioMode = production?.instruction?.audio.mode;
    const sceneInputs = production?.sceneInputs;
    const hasAudio = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(hasAudio);
      if (!value || typeof value !== 'object') return false;
      const node = value as Record<string, unknown>;
      return (
        (typeof node.type === 'string' &&
          ['reference_audio', 'driving_audio', 'audio_url'].includes(node.type)) ||
        Object.values(node).some(hasAudio)
      );
    };

    if (
      sceneInputs &&
      !hasAudio(parameters) &&
      (audioMode === 'voice-reference' || audioMode === 'dialogue-driven')
    ) {
      if (!supportsProductionAudioUpload(adapter))
        throw new Error('当前渠道未接入本地音频上传，请提供公网音频地址或选择支持上传的连接。');
      const voices =
        audioMode === 'voice-reference'
          ? (sceneInputs.scene.characterBindings ?? []).flatMap((binding) => {
              if (binding.voiceDisabled) return [];
              const voice = binding.voiceReferenceVersionId
                ? sceneInputs.media.voices.find(
                    (v) =>
                      v.versionId === binding.voiceReferenceVersionId &&
                      v.characterDocumentId === binding.characterDocumentId,
                  )
                : sceneInputs.media.characters.find(
                    (c) => c.characterDocumentId === binding.characterDocumentId,
                  )?.voice;
              return voice ? [voice] : [];
            })
          : [];
      parameters = addProductionRoleVoices(
        adapter,
        parameters,
        voices,
        audioMode === 'dialogue-driven' ? sceneInputs.scene.dialogueAudioId : undefined,
      );
    }
    const validation = this.adapters.validate({ adapterKey: adapter.key, parameters });
    if (!validation.valid) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_ARGUMENTS_INVALID',
        `Media parameters failed Adapter Schema validation: ${validation.errors
          .slice(0, 5)
          .map((error) => `${error.path}: ${error.message}`)
          .join('; ')}`,
        true,
      );
    }

    const snapshot = this.snapshot(candidate, adapter);
    const common = {
      ...(production?.source ? { productionSource: production.source } : {}),
      shotId: context.arguments.shotId,
      adapterKey: adapter.key,
      parameters,
      providerProfileId: candidate.providerProfileId,
      modelId: candidate.modelId,
      conversationId: identity.conversationId,
      originalPrompt: context.arguments.prompt,
      costNoticeAcknowledged: false,
      mediaModelSelection: snapshot,
    };
    const job =
      context.kind === 'image'
        ? this.prepareImage(common)
        : this.prepareVideo({
            ...common,
            sceneId: context.arguments.sceneId,
            providerRegion: candidate.providerRegion,
            assetKind:
              context.arguments.assetKind === 'scene-video' ||
              context.arguments.assetKind === 'shot-video'
                ? context.arguments.assetKind
                : 'generated-video',
          });
    return {
      draftId: job.id,
      kind: context.kind,
      status: 'draft',
      prompt: context.arguments.prompt,
      inputAssetIds: [...context.arguments.inputAssetIds],
      mediaModelSelection: snapshot,
      normalizedParameters: redactInlineMedia(parameters),
      missingParameters: [],
      costNotice: candidate.costNotice,
    };
  }

  getTask(taskId: string): MediaTaskSummary {
    const normalizedTaskId = requireText(taskId, 'taskId', 200);
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const record = repositories.jobs.get(normalizedTaskId);
      if (!record || record.projectId !== project.id) {
        throw new AgentToolPolicyError(
          'AGENT_TOOL_PROJECT_SCOPE',
          'The requested media task is not available in the current project.',
        );
      }
      const adapter = this.adapters
        .catalog()
        .adapters.find((item) => item.key === record.adapterKey);
      const snapshotKind = readSnapshotKind(record.taskSnapshotJson);
      const kind: MediaGenerationKind =
        snapshotKind ??
        (adapter
          ? adapter.capability.endsWith('TO_IMAGE')
            ? 'image'
            : 'video'
          : record.adapterKey.includes('TO_VIDEO')
            ? 'video'
            : 'image');
      const results = repositories.generationResults.listByJob(record.id);
      return {
        taskId: record.id,
        kind,
        state:
          record.mediaState ??
          normalizeTaskState(kind, record.status, Boolean(record.providerTaskId)),
        adapterKey: record.adapterKey,
        resultAssetIds: results.flatMap((result) => (result.assetId ? [result.assetId] : [])),
        error: readJobError(record.errorJson),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  }

  private listCandidates(
    kind: MediaGenerationKind,
    inputCount: number,
    hasVideo = false,
  ): MediaModelCandidate[] {
    const adapters = this.adapters.catalog().adapters;
    const candidates: MediaModelCandidate[] = [];
    for (const profile of this.settings.listProfiles(false)) {
      const route = resolveMediaProviderRoute(profile);
      if (!route || !profile.enabled || profile.connectionStatus !== 'ready') continue;
      for (const model of this.settings.listModels(profile.id)) {
        if (!model.enabled || model.unavailableAt || !modelSupportsKind(model, kind)) continue;
        const matching = adapters.filter(
          (adapter) =>
            adapterBindsCatalogModel(adapter, {
              providerType: profile.providerType,
              remoteModelId: model.remoteModelId,
              parameterTemplateKey: model.parameterTemplateKey,
              contractStatus: model.contractStatus,
            }) &&
            adapterSupportsInputs(adapter, kind, inputCount, hasVideo) &&
            this.settings.getAdapterSchemaRecord(adapter.key)?.status !== 'needs_confirmation',
        );
        if (matching.length === 0) continue;
        candidates.push({
          providerProfileId: profile.id,
          providerName: profile.name,
          providerType: route.providerType,
          providerRegion: route.providerRegion,
          modelId: model.id,
          remoteModelId: model.remoteModelId,
          modelName: model.displayName,
          contractId: model.contractId,
          contractRevision: model.contractRevision,
          contractStatus: model.contractStatus,
          adapters: matching.map((adapter) => structuredClone(adapter)),
          costNotice: costNotice(this.settings.listModelPricing(profile.id), model),
        });
        if (candidates.length >= MAX_MEDIA_CANDIDATES) return candidates;
      }
    }
    return candidates;
  }

  private snapshot(
    candidate: Pick<
      MediaModelCandidate,
      | 'providerProfileId'
      | 'modelId'
      | 'remoteModelId'
      | 'contractId'
      | 'contractRevision'
      | 'contractStatus'
    >,
    adapter: AdapterDescriptor,
  ): MediaModelSelectionSnapshot {
    const profile = this.settings.getProfile(candidate.providerProfileId);
    const route = profile ? resolveMediaProviderRoute(profile) : undefined;
    if (!profile || !route) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_ARGUMENTS_INVALID',
        'The selected media Provider is no longer available.',
        true,
      );
    }
    const schema = this.settings.getAdapterSchemaRecord(adapter.key);
    return {
      providerProfileId: candidate.providerProfileId,
      providerType: route.providerType,
      providerBaseUrlCategory: route.baseUrlCategory,
      ...(route.providerType === 'wan-video' ? { providerBaseUrl: profile.baseUrl } : {}),
      providerRegion: route.providerRegion,
      modelId: candidate.modelId,
      remoteModelId: candidate.remoteModelId,
      adapterKey: adapter.key,
      adapterSchemaVersion: adapter.schemaVersion,
      adapterSchemaSource: schema?.source === 'manual' ? 'manual' : 'official-adapter',
      ...(candidate.contractId
        ? {
            contractId: candidate.contractId,
            contractRevision: candidate.contractRevision,
            contractStatus: candidate.contractStatus,
          }
        : {}),
    };
  }

  private normalizeParameters(
    context: MediaSelectionContext,
    adapter: AdapterDescriptor,
    selected: AdapterParameters,
  ): AdapterParameters {
    validateParameterRecord(selected, true, context.inputAttachments);
    const properties = adapter.parameterSchema.properties;
    const parameters: AdapterParameters = {};
    for (const [key, property] of Object.entries(properties)) {
      if (property.default !== undefined) parameters[key] = structuredClone(property.default);
    }
    Object.assign(
      parameters,
      cloneParameters(context.arguments.parameters),
      cloneParameters(selected),
    );
    const images = productionImagesFromParameters(adapter, parameters);
    for (const assetId of context.arguments.inputAssetIds) {
      if (
        !images.some(
          (image) => image.url.replace(/^project-asset:\/\//u, 'asset://') === 'asset://' + assetId,
        )
      )
        images.push({ url: 'asset://' + assetId, role: 'reference' });
    }
    const content = Array.isArray(parameters.content) ? parameters.content : [];
    const hasText = content.some(
      (value) =>
        value && typeof value === 'object' && !Array.isArray(value) && value.type === 'text',
    );
    const normalized = seedProductionInputs(
      adapter,
      parameters,
      typeof parameters.prompt === 'string'
        ? parameters.prompt
        : hasText
          ? undefined
          : context.arguments.prompt,
      images.length ? images : undefined,
    );
    if (adapter.parameterSchema.properties.media && typeof normalized.video === 'string') {
      normalized.media = [
        ...(Array.isArray(normalized.media) ? normalized.media : []),
        {
          type: adapter.capability === 'VIDEO_TO_VIDEO' ? 'first_clip' : 'reference_video',
          url: normalized.video,
        },
      ];
      delete normalized.video;
    }
    return normalized;
  }

  private materializeInputs(
    inputAssetIds: string[],
    parameters: AdapterParameters,
  ): MaterializedMediaInputs {
    const project = this.projects.current();
    if (!project) throw new Error('No project is open.');
    // Desktop sends asset IDs, just like Agent callers. Resolve bytes only in
    // the owning Worker and pass bounded controlled-file handles to Native.
    inputAssetIds = [
      ...new Set([
        ...inputAssetIds,
        ...Object.values(parameters).flatMap((value) =>
          (Array.isArray(value) ? value : [value]).flatMap((item) =>
            typeof item === 'string' && /^(?:asset|project-asset):\/\//u.test(item)
              ? [item.slice(item.indexOf('://') + 3)]
              : [],
          ),
        ),
      ]),
    ];
    const images = Array.isArray(parameters.images) ? parameters.images : [];
    const inlineImages = images.flatMap((value) =>
      typeof value === 'string' && value.toLowerCase().startsWith('data:image/')
        ? [parseCanonicalImageDataUrl(value)]
        : [],
    );
    const sharedInputRoot = process.env.AI_VIDEO_MEDIA_INPUT_ROOT;
    const inputRoot = sharedInputRoot?.trim() || project.rootPath;
    const assetImages = this.projects.access(false, (database, currentProject) => {
      const repositories = createRepositories(database);
      return inputAssetIds.map((assetId) => {
        const asset = repositories.assets.get(assetId);
        if (
          !asset ||
          asset.projectId !== currentProject.id ||
          asset.deletedAt ||
          asset.kind.toLowerCase().includes('video')
        ) {
          throw new AgentToolPolicyError(
            'AGENT_TOOL_PROJECT_SCOPE',
            'Every media input asset must be an active image in the current project.',
          );
        }
        const bytes = readFileSync(
          resolveProjectRelativePath(currentProject.rootPath, asset.relativePath),
        );
        const parsed = parseStoredImage(bytes);
        if (createHash('sha256').update(bytes).digest('hex') !== asset.contentHash) {
          throw new AgentToolPolicyError(
            'AGENT_TOOL_ARGUMENTS_INVALID',
            'A media input asset failed its content integrity check.',
          );
        }
        return { assetId, ...parsed };
      });
    });
    const totalBytes = [...assetImages, ...inlineImages].reduce(
      (total, image) => total + image.bytes.byteLength,
      0,
    );
    const directory = resolveProjectRelativePath(inputRoot, 'cache/media-inputs');
    if (totalBytes > 0) {
      mkdirSync(directory, { recursive: true });
      assertStorageCapacity(directory, totalBytes);
    }
    const paths: string[] = [];
    const references: MediaInputReferenceV1[] = inputAssetIds.map((assetId) => ({
      type: 'asset',
      assetId,
    }));
    try {
      const assetUris = new Map<string, string>();
      const inlineUris: string[] = [];
      for (const image of [...assetImages, ...inlineImages]) {
        const handle = `cache/media-inputs/${randomUUID()}.${image.extension}`;
        const finalPath = resolveProjectRelativePath(inputRoot, handle);
        const temporaryPath = `${finalPath}.${process.pid}.tmp`;
        try {
          writeFileSync(temporaryPath, image.bytes, { flag: 'wx' });
          renameSync(temporaryPath, finalPath);
        } catch (error) {
          rmSync(temporaryPath, { force: true });
          throw error;
        }
        paths.push(finalPath);
        references.push({
          type: 'controlled_temporary_file',
          handle,
          contentType: image.contentType,
        });
        const uri = `controlled-file://${handle}`;
        if ('assetId' in image) assetUris.set(image.assetId, uri);
        else inlineUris.push(uri);
      }
      let inlineIndex = 0;
      const transformed = cloneParameters(parameters);
      for (const [key, value] of Object.entries(transformed)) {
        if (Array.isArray(value)) {
          transformed[key] = value.map((item) => {
            if (typeof item === 'string' && /^(?:asset|project-asset):\/\//u.test(item)) {
              return assetUris.get(item.slice(item.indexOf('://') + 3)) ?? item;
            }
            if (typeof item === 'string' && item.toLowerCase().startsWith('data:image/')) {
              return inlineUris[inlineIndex++] ?? item;
            }
            return item;
          });
        } else if (typeof value === 'string' && /^(?:asset|project-asset):\/\//u.test(value)) {
          transformed[key] = assetUris.get(value.slice(value.indexOf('://') + 3)) ?? value;
        } else if (typeof value === 'string' && value.toLowerCase().startsWith('data:image/')) {
          transformed[key] = inlineUris[inlineIndex++] ?? value;
        }
      }
      return { references, paths, parameters: transformed };
    } catch (error) {
      cleanupMaterializedPaths(paths);
      throw error;
    }
  }

  private assertIdentity(identity: MediaIdentity): void {
    const current = this.projects.current();
    if (
      !current ||
      current.id !== identity.projectId ||
      this.projects.currentSessionId() !== identity.projectSessionId
    ) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The media request does not belong to the current project session.',
      );
    }
    const conversation = this.projects.access(false, (database) =>
      database
        .prepare('SELECT 1 FROM conversations WHERE id = ? AND project_id = ?')
        .get(identity.conversationId, current.id),
    );
    if (!conversation) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The media request does not belong to a current-project conversation.',
      );
    }
  }

  private assertInputAssets(assetIds: string[]): void {
    this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      for (const assetId of assetIds) {
        const asset = repositories.assets.get(assetId);
        if (
          !asset ||
          asset.projectId !== project.id ||
          asset.deletedAt ||
          asset.kind.toLowerCase().includes('video')
        ) {
          throw new AgentToolPolicyError(
            'AGENT_TOOL_PROJECT_SCOPE',
            'Every media input asset must be an active image in the current project.',
          );
        }
      }
    });
  }
}

export function resolveMediaProviderRoute(profile: ProviderProfileInfo):
  | {
      providerType: MediaProviderType;
      providerRegion: VideoProviderRegion;
      baseUrlCategory: MediaProviderBaseUrlCategory;
    }
  | undefined {
  if (
    profile.accessType !== 'official' ||
    (profile.providerType === 'unicompapi' &&
      (profile.protocol !== 'openai-chat-completions' ||
        profile.baseUrl !== 'https://unicompapi.com/v1'))
  ) {
    return undefined;
  }
  if (profile.providerType === 'unicompapi') {
    return {
      providerType: 'unicompapi',
      providerRegion: 'unicompapi',
      baseUrlCategory: 'official-unicompapi',
    };
  }
  const officialVideoRoutes = {
    'wan-video': {
      protocol: 'dashscope-video',
      baseUrl: 'https://dashscope.aliyuncs.com',
      category: 'official-wan',
    },
    'seedance-video': {
      protocol: 'seedance-video',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      category: 'official-seedance',
    },
    'minimax-video': {
      protocol: 'minimax-video-v2',
      baseUrl: 'https://api.minimax.cn',
      category: 'official-minimax-video',
    },
  } as const;
  const official = officialVideoRoutes[profile.providerType as keyof typeof officialVideoRoutes];
  if (
    official &&
    profile.protocol === official.protocol &&
    (profile.baseUrl === official.baseUrl ||
      (profile.providerType === 'wan-video' && isWanVideoBaseUrl(profile.baseUrl)))
  )
    return {
      providerType: profile.providerType as MediaProviderType,
      providerRegion: 'cn',
      baseUrlCategory: official.category,
    };
  if (profile.providerType !== 'vidu' || profile.protocol !== 'vidu-v2') return undefined;
  if (profile.baseUrl === 'https://api.vidu.cn') {
    return {
      providerType: 'vidu',
      providerRegion: 'cn',
      baseUrlCategory: 'official-vidu-cn',
    };
  }
  if (profile.baseUrl === 'https://api.vidu.com') {
    return {
      providerType: 'vidu',
      providerRegion: 'global',
      baseUrlCategory: 'official-vidu-global',
    };
  }
  return undefined;
}

function parseMediaPrepareArguments(
  kind: MediaGenerationKind,
  value: unknown,
): MediaPrepareArguments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      'Media prepare arguments must be an object.',
      true,
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'prompt',
    'inputAssetIds',
    'parameters',
    'shotId',
    'sceneId',
    'assetKind',
  ]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      `Media prepare arguments contain unsupported field ${unknown}.`,
      true,
    );
  }
  const prompt = requireText(record.prompt, 'prompt', 5_000);
  const inputAssetIds = Array.isArray(record.inputAssetIds)
    ? record.inputAssetIds.map((item) => requireText(item, 'inputAssetIds', 200))
    : [];
  if (inputAssetIds.length > 7 || new Set(inputAssetIds).size !== inputAssetIds.length) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      'inputAssetIds must contain at most seven unique asset IDs.',
      true,
    );
  }
  const parameters = record.parameters === undefined ? {} : requireParameters(record.parameters);
  validateParameterRecord(parameters, false, []);
  const shotId =
    record.shotId === undefined ? undefined : requireText(record.shotId, 'shotId', 200);
  const sceneId =
    record.sceneId === undefined ? undefined : requireText(record.sceneId, 'sceneId', 200);
  const assetKind = parseAssetKind(kind, record.assetKind);
  return { prompt, inputAssetIds, parameters, shotId, sceneId, assetKind };
}

function parseAssetKind(
  kind: MediaGenerationKind,
  value: unknown,
): ImageAssetKind | VideoAssetKind | undefined {
  if (value === undefined) return undefined;
  const imageKinds = new Set<ImageAssetKind>([
    'character',
    'scene',
    'first-frame',
    'last-frame',
    'generated-image',
  ]);
  const videoKinds = new Set<VideoAssetKind>(['generated-video', 'shot-video', 'scene-video']);
  if (
    typeof value !== 'string' ||
    (kind === 'image'
      ? !imageKinds.has(value as ImageAssetKind)
      : !videoKinds.has(value as VideoAssetKind))
  ) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      `assetKind is invalid for ${kind} generation.`,
      true,
    );
  }
  return value as ImageAssetKind | VideoAssetKind;
}

function adapterSupportsInputs(
  adapter: AdapterDescriptor,
  kind: MediaGenerationKind,
  inputCount: number,
  hasVideo = false,
): boolean {
  if (kind === 'image' && !adapter.capability.endsWith('TO_IMAGE')) return false;
  if (kind === 'video' && !adapter.capability.endsWith('TO_VIDEO')) return false;
  const support = productionInputSupport(adapter);
  if (hasVideo)
    return (
      support.video &&
      ['VIDEO_TO_VIDEO', 'REFERENCE_TO_VIDEO'].includes(adapter.capability) &&
      inputCount <= support.maxImages
    );
  if (adapter.capability === 'VIDEO_TO_VIDEO') return false;
  if (inputCount === 0) return adapter.capability.startsWith('TEXT_TO_');
  if (!support.images) return false;
  if (adapter.capability === 'IMAGE_TO_VIDEO') return inputCount === 1;
  if (adapter.capability === 'START_END_TO_VIDEO') return inputCount === 2;
  return (
    adapter.capability.startsWith('REFERENCE_TO_') &&
    inputCount >= support.minImages &&
    inputCount <= support.maxImages
  );
}

function modelSupportsKind(model: ProviderModelInfo, kind: MediaGenerationKind): boolean {
  return kind === 'image'
    ? model.capabilities.imageGeneration || model.capabilities.imageEditing === true
    : model.capabilities.videoGeneration;
}

function costNotice(pricing: ModelPricingInfo[], model: ProviderModelInfo) {
  const configured = pricing.find((item) => item.modelId === model.id);
  const detail = configured?.creditPrice
    ? `Configured credit price: ${configured.creditPrice} ${configured.currency} per credit.`
    : 'The exact amount depends on the selected parameters and Provider response.';
  return { required: true as const, summary: `Provider submission may incur charges. ${detail}` };
}

function normalizeTaskState(
  kind: MediaGenerationKind,
  status: string,
  hasProviderTaskId: boolean,
): MediaTaskSummary['state'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'timed-out') return 'timed_out';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'downloading') return 'downloading';
  if (status === 'polling' || hasProviderTaskId) return 'polling';
  if (kind === 'image' && status === 'running') return 'draft';
  return 'draft';
}

function readJobError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function readSnapshotKind(value: string | undefined): MediaGenerationKind | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { capability?: unknown };
    return parsed.capability === 'image' || parsed.capability === 'video'
      ? parsed.capability
      : undefined;
  } catch {
    return undefined;
  }
}

function requireParameters(value: unknown): AdapterParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      'parameters must be an object.',
      true,
    );
  }
  return value as AdapterParameters;
}

function validateParameterRecord(
  parameters: AdapterParameters,
  allowInlineImages: boolean,
  inputAttachments: MediaAttachmentSnapshot[],
): void {
  if (Object.keys(parameters).length > MAX_MEDIA_PARAMETERS) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      `parameters may contain at most ${MAX_MEDIA_PARAMETERS} fields.`,
      true,
    );
  }
  const remainingAttachments = new Map<string, number>();
  for (const attachment of inputAttachments) {
    const key = `${attachment.contentType}:${attachment.sha256}`;
    remainingAttachments.set(key, (remainingAttachments.get(key) ?? 0) + 1);
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (
      (value && typeof value === 'object' && !Array.isArray(value)) ||
      (Array.isArray(value) && value.some((item) => item && typeof item === 'object'))
    ) {
      let nodes = 0;
      const inspect = (item: unknown, depth: number): void => {
        if (++nodes > 2000 || depth > 10) throw invalidParameter(key);
        if (typeof item === 'string') {
          if (
            item.length > 20000 ||
            looksLikeAbsolutePath(item) ||
            /^data:/iu.test(item) ||
            looksLikeLongBase64(item)
          )
            throw invalidParameter(key);
          return;
        }
        if (typeof item === 'number' || typeof item === 'boolean') return;
        if (Array.isArray(item)) {
          if (item.length > 64) throw invalidParameter(key);
          item.forEach((child) => inspect(child, depth + 1));
          return;
        }
        if (item && typeof item === 'object') {
          for (const [name, child] of Object.entries(item)) {
            if (
              !name ||
              name.length > 100 ||
              /secret|authorization|api.?key|headers|signed.?url|__proto__|constructor|prototype/iu.test(
                name,
              )
            )
              throw invalidParameter(key);
            inspect(child, depth + 1);
          }
          return;
        }
        throw invalidParameter(key);
      };
      inspect(value, 0);
      continue;
    }
    if (!key || key.length > 100) throw invalidParameter(key);
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && value.length > 20) throw invalidParameter(key);
    for (const item of values) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) throw invalidParameter(key);
      if (typeof item !== 'string') continue;
      if (looksLikeAbsolutePath(item)) throw invalidParameter(key);
      if (item.toLowerCase().startsWith('data:')) {
        if (!allowInlineImages || key !== 'images') {
          throw invalidParameter(key);
        }
        const parsed = parseCanonicalImageDataUrl(item);
        const attachmentKey = `${parsed.contentType}:${parsed.sha256}`;
        const remaining = remainingAttachments.get(attachmentKey) ?? 0;
        if (remaining < 1) {
          throw new AgentToolPolicyError(
            'AGENT_TOOL_ARGUMENTS_TAMPERED',
            'An inline media parameter was not one of the attachments frozen for this request.',
            true,
          );
        }
        remainingAttachments.set(attachmentKey, remaining - 1);
      } else if (item.length > 10_000 || looksLikeLongBase64(item)) {
        throw invalidParameter(key);
      }
    }
  }
}

function invalidParameter(key: string): AgentToolPolicyError {
  return new AgentToolPolicyError(
    'AGENT_TOOL_ARGUMENTS_INVALID',
    `Media parameter ${key || '(empty)'} is invalid or contains unsupported local data.`,
    true,
  );
}

function parseCanonicalImageDataUrl(
  value: string,
): MediaAttachmentSnapshot & { bytes: Buffer; extension: 'png' | 'jpg' | 'webp' } {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
  if (!match) throw invalidParameter('images');
  const encoded = match[2]!;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_INLINE_IMAGE_BYTES) throw invalidParameter('images');
  if (bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) {
    throw invalidParameter('images');
  }
  const contentType = normalizeImageContentType(`image/${match[1]!.toLowerCase()}`);
  if (!contentType || !hasImageSignature(bytes, contentType)) throw invalidParameter('images');
  return {
    contentType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
    extension: contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp',
  };
}

function parseStoredImage(bytes: Buffer): {
  bytes: Buffer;
  contentType: MediaAttachmentSnapshot['contentType'];
  extension: 'png' | 'jpg' | 'webp';
} {
  if (bytes.length < 1 || bytes.length > MAX_CONTROLLED_IMAGE_BYTES)
    throw invalidParameter('images');
  for (const contentType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    if (!hasImageSignature(bytes, contentType)) continue;
    return {
      bytes,
      contentType,
      extension:
        contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp',
    };
  }
  throw invalidParameter('images');
}

function cleanupMaterializedPaths(paths: string[]): void {
  for (const path of paths) rmSync(path, { force: true });
}

function normalizeImageContentType(
  value: string,
): MediaAttachmentSnapshot['contentType'] | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'image/jpg' || normalized === 'image/jpeg') return 'image/jpeg';
  if (normalized === 'image/png' || normalized === 'image/webp') return normalized;
  return undefined;
}

function hasImageSignature(
  bytes: Buffer,
  contentType: MediaAttachmentSnapshot['contentType'],
): boolean {
  if (contentType === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

function looksLikeLongBase64(value: string): boolean {
  return value.length >= 512 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

function redactInlineMedia(parameters: AdapterParameters): AdapterParameters {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) =>
            typeof item === 'string' && item.toLowerCase().startsWith('data:image/')
              ? 'attachment://omitted'
              : item,
          )
        : typeof value === 'string' && value.toLowerCase().startsWith('data:image/')
          ? 'attachment://omitted'
          : value,
    ]),
  );
}

function cloneParameters(parameters: AdapterParameters): AdapterParameters {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      `${name} must be a string.`,
      true,
    );
  }
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum) {
    throw new AgentToolPolicyError(
      'AGENT_TOOL_ARGUMENTS_INVALID',
      `${name} is outside its allowed length.`,
      true,
    );
  }
  return normalized;
}
