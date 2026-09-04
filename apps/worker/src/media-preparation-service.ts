import type {
  AdapterDescriptor,
  AdapterParameters,
  ImageAssetKind,
  ImageGenerationJobInfo,
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
  VideoProviderRegion,
} from '@ai-video/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRepositories } from '@ai-video/persistence';
import type { AdapterService } from './adapter-service.js';
import type { AppSettingsService } from './app-settings-service.js';
import { AgentToolPolicyError } from './agent-tool-registry.js';
import type { ImageGenerationService } from './image-generation-service.js';
import { resolveProjectRelativePath, type ProjectService } from './project-service.js';
import { assertStorageCapacity } from './storage-capacity.js';
import type { VideoGenerationService } from './video-generation-service.js';

const MAX_MEDIA_CANDIDATES = 50;
const MAX_MEDIA_PARAMETERS = 40;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export interface MediaPrepareArguments {
  prompt: string;
  inputAssetIds: string[];
  parameters: AdapterParameters;
  shotId?: string;
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
      candidates: this.listCandidates(kind, args.inputAssetIds.length + inputAttachmentCount),
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
      context.arguments.inputAssetIds.length + context.inputAttachmentCount,
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

    const parameters = this.normalizeParameters(context, adapter, selection.parameters);
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
    const materialized = this.materializeInputs(context.arguments.inputAssetIds, parameters);
    const common = {
      shotId: context.arguments.shotId,
      adapterKey: adapter.key,
      parameters,
      providerProfileId: candidate.providerProfileId,
      modelId: candidate.modelId,
      conversationId: identity.conversationId,
      originalPrompt: context.arguments.prompt,
      costNoticeAcknowledged: false,
      mediaModelSelection: snapshot,
      mediaInputReferences: materialized.references,
    };
    let job: ImageGenerationJobInfo | VideoGenerationJobInfo;
    try {
      if (context.kind === 'image') {
        job = this.images.prepare(common);
      } else {
        job = this.videos.prepare({
          ...common,
          providerRegion: candidate.providerRegion,
          assetKind:
            context.arguments.assetKind === 'generated-video' ||
            context.arguments.assetKind === 'shot-video'
              ? context.arguments.assetKind
              : 'generated-video',
        });
      }
    } catch (error) {
      for (const path of materialized.paths) rmSync(path, { force: true });
      throw error;
    }
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
      if (!adapter) throw new Error('The media task adapter is no longer available.');
      const kind: MediaGenerationKind = adapter.capability.endsWith('TO_IMAGE') ? 'image' : 'video';
      const results = repositories.generationResults.listByJob(record.id);
      return {
        taskId: record.id,
        kind,
        state: normalizeTaskState(kind, record.status, Boolean(record.providerTaskId)),
        adapterKey: record.adapterKey,
        resultAssetIds: results.flatMap((result) => (result.assetId ? [result.assetId] : [])),
        error: readJobError(record.errorJson),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  }

  private listCandidates(kind: MediaGenerationKind, inputCount: number): MediaModelCandidate[] {
    const adapters = this.adapters.catalog().adapters;
    const candidates: MediaModelCandidate[] = [];
    for (const profile of this.settings.listProfiles(false)) {
      const route = resolveMediaProviderRoute(profile);
      if (!route || !profile.enabled || profile.connectionStatus !== 'ready') continue;
      for (const model of this.settings.listModels(profile.id)) {
        if (!model.enabled || model.unavailableAt || !modelSupportsKind(model, kind)) continue;
        const matching = adapters.filter(
          (adapter) =>
            adapter.provider === profile.providerType &&
            adapter.model === model.remoteModelId &&
            adapterSupportsInputs(adapter, kind, inputCount) &&
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
          adapters: matching.map((adapter) => structuredClone(adapter)),
          costNotice: costNotice(this.settings.listModelPricing(profile.id), model),
        });
        if (candidates.length >= MAX_MEDIA_CANDIDATES) return candidates;
      }
    }
    return candidates;
  }

  private snapshot(
    candidate: MediaModelCandidate,
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
      providerRegion: route.providerRegion,
      modelId: candidate.modelId,
      remoteModelId: candidate.remoteModelId,
      adapterKey: adapter.key,
      adapterSchemaVersion: adapter.schemaVersion,
      adapterSchemaSource: schema?.source === 'manual' ? 'manual' : 'official-adapter',
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
    if (properties.prompt?.type === 'string' && parameters.prompt === undefined) {
      parameters.prompt = context.arguments.prompt;
    }
    if (properties.images) {
      const assetReferences = context.arguments.inputAssetIds.map((id) => `asset://${id}`);
      const selectedImages = Array.isArray(parameters.images) ? parameters.images : [];
      parameters.images = [...new Set([...assetReferences, ...selectedImages])];
    }
    return parameters;
  }

  private materializeInputs(
    inputAssetIds: string[],
    parameters: AdapterParameters,
  ): MaterializedMediaInputs {
    const project = this.projects.current();
    if (!project) throw new Error('No project is open.');
    const images = Array.isArray(parameters.images) ? parameters.images : [];
    const parsedImages = images.flatMap((value) =>
      value.toLowerCase().startsWith('data:image/') ? [parseCanonicalImageDataUrl(value)] : [],
    );
    const directory = resolveProjectRelativePath(project.rootPath, 'cache/media-inputs');
    if (parsedImages.length > 0) {
      mkdirSync(directory, { recursive: true });
      assertStorageCapacity(
        directory,
        parsedImages.reduce((total, image) => total + image.bytes.byteLength, 0),
      );
    }
    const paths: string[] = [];
    const references: MediaInputReferenceV1[] = inputAssetIds.map((assetId) => ({
      type: 'asset',
      assetId,
    }));
    try {
      for (const image of parsedImages) {
        const handle = `cache/media-inputs/${randomUUID()}.${image.extension}`;
        const finalPath = resolveProjectRelativePath(project.rootPath, handle);
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
      }
      return { references, paths };
    } catch (error) {
      for (const path of paths) rmSync(path, { force: true });
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
  const allowed = new Set(['prompt', 'inputAssetIds', 'parameters', 'shotId', 'assetKind']);
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
  const assetKind = parseAssetKind(kind, record.assetKind);
  return { prompt, inputAssetIds, parameters, shotId, assetKind };
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
  const videoKinds = new Set<VideoAssetKind>(['generated-video', 'shot-video']);
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
): boolean {
  if (kind === 'image' && !adapter.capability.endsWith('TO_IMAGE')) return false;
  if (kind === 'video' && !adapter.capability.endsWith('TO_VIDEO')) return false;
  const imageProperty = adapter.parameterSchema.properties.images;
  if (inputCount === 0) return !imageProperty && adapter.capability.startsWith('TEXT_TO_');
  if (!imageProperty) return false;
  return (
    inputCount >= (imageProperty.minItems ?? 0) && inputCount <= (imageProperty.maxItems ?? 20)
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
            item.toLowerCase().startsWith('data:image/') ? 'attachment://omitted' : item,
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
