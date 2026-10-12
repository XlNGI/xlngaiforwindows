import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  AdapterSchemaRecord,
  LlmGenerationAttemptRecord,
  ProjectRecord,
  UsageIndexRecord,
} from '@ai-video/domain';
import type {
  AdapterDescriptor,
  UnifiedAgentAdapterSchemaAuditInfo,
  UnifiedAgentAdapterSchemaConfirmParams,
  UnifiedAgentAdapterSchemaConfirmResult,
  UnifiedAgentAdapterSchemaProposeParams,
  UnifiedAgentAdapterSchemaProposeResult,
  UnifiedAgentAdapterSchemaRollbackParams,
  UnifiedAgentAdapterSchemaRollbackResult,
  ProviderConnectionCompleteParams,
  ProviderConnectionResult,
  ProviderDefinitionInfo,
  ProviderLegacyMigrationParams,
  ProviderLegacyMigrationResult,
  LlmPricingSnapshotInfo,
  ModelPricingInfo,
  ModelPricingUpdateParams,
  ModelBinding,
  ModelBindingEnableParams,
  ModelContract,
  ModelContractEnableParams,
  ModelCatalogStatus,
  ProviderDefaultInfo,
  ProviderDefaultRole,
  ProviderDefaultUpdateParams,
  ProviderModelCapabilities,
  ProviderModelCreateParams,
  ProviderModelInfo,
  ProviderModelUpdateParams,
  ProviderProfileCreateParams,
  ProviderProfileInfo,
  ProviderProfileUpdateParams,
  ProviderRuntimeProfile,
  RemoteProviderModelInfo,
} from '@ai-video/contracts';
import { isUniCompApiMediaTemplateKey, mediaModelBindings } from '@ai-video/contracts';
import { createAppRepositories, migrateAppDatabase, openAppDatabase } from '@ai-video/persistence';
import {
  listModelBindings as listStaticModelBindings,
  listModelContracts as listStaticModelContracts,
  setCatalogStatus,
  setRegisteredBindingStatus,
  setRegisteredContractStatus,
} from './model-contract-registry.js';
import {
  emptyModelCapabilities,
  hasAnyModelCapability,
  inferKnownModelCapabilities,
  listBuiltInProviderModels,
  listProviderDefinitions,
  ProviderRegistryValidationError,
  validateProviderConfiguration,
} from './provider-registry.js';
import { resolveModelBinding } from './model-contract-registry.js';
import { normalizeCurrency, normalizeDecimalPrice } from './usage-cost.js';

const DEFAULT_APP_DATA_DIRECTORY = '.ai-video-workspace';
const APP_DATABASE_NAME = 'app-settings.sqlite';
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROFILE_NAME_LIMIT = 80;
const ERROR_MESSAGE_LIMIT = 500;
const ERROR_CODE_LIMIT = 80;
const MODEL_ID_LIMIT = 200;
const MODEL_NAME_LIMIT = 200;

export interface AppSettingsServiceOptions {
  appDataDirectory?: string;
  nativeBinding?: object;
  now?: () => string;
}

export class ProviderProfileValidationError extends Error {}

export class AdapterSchemaValidationError extends Error {}

export interface ResolvedLlmSelection {
  providerProfileId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  remoteModelId: string;
  contractId?: string;
  contractRevision?: number;
  contractStatus?: ProviderModelInfo['contractStatus'];
  protocol: 'openai-responses' | 'openai-chat-completions';
  baseUrl: string;
  pricingSnapshot?: LlmPricingSnapshotInfo;
}

export class AppSettingsService {
  private database?: Database.Database;
  private modelContractDirectorySeeded = false;
  private readonly appDataDirectory: string;
  private readonly nativeBinding?: object;
  private readonly now: () => string;

  constructor(options: AppSettingsServiceOptions = {}) {
    const configuredDirectory =
      options.appDataDirectory ??
      process.env.AI_VIDEO_APP_DATA_DIR ??
      join(homedir(), DEFAULT_APP_DATA_DIRECTORY);
    if (!isAbsolute(configuredDirectory)) {
      throw new Error('Application data directory must be absolute.');
    }
    this.appDataDirectory = resolve(configuredDirectory);
    this.nativeBinding = options.nativeBinding;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getAdapterSchema(adapterKey: string): AdapterDescriptor | null {
    const record = this.repositories().adapterSchemas.get(adapterKey);
    if (!record || record.status !== 'confirmed') return null;
    try {
      return JSON.parse(record.descriptorJson) as AdapterDescriptor;
    } catch {
      throw new AdapterSchemaValidationError('Stored adapter schema is invalid JSON.');
    }
  }

  getAdapterSchemaRecord(adapterKey: string): AdapterSchemaRecord | undefined {
    return this.repositories().adapterSchemas.get(adapterKey);
  }

  listAdapterSchemaRecords(): AdapterSchemaRecord[] {
    return this.repositories().adapterSchemas.list();
  }

  listConfirmedAdapterSchemas(): AdapterDescriptor[] {
    return this.repositories()
      .adapterSchemas.list()
      .filter((record) => record.status === 'confirmed')
      .flatMap((record) => {
        try {
          return [JSON.parse(record.descriptorJson) as AdapterDescriptor];
        } catch {
          return [];
        }
      });
  }

  listModelContracts(status?: ProviderModelInfo['contractStatus']): ModelContract[] {
    return this.repositories()
      .modelContracts.list()
      .map((record) => JSON.parse(record.descriptorJson) as ModelContract)
      .filter((contract) => !status || contract.status === status);
  }

  getModelContract(contractId: string, contractRevision: number): ModelContract | null {
    const record = this.repositories().modelContracts.get(contractId, contractRevision);
    return record ? (JSON.parse(record.descriptorJson) as ModelContract) : null;
  }

  listModelBindings(
    status?: ProviderModelInfo['contractStatus'],
    providerType?: string,
  ): ModelBinding[] {
    return this.repositories()
      .modelBindings.list()
      .map((record) => JSON.parse(record.descriptorJson) as ModelBinding)
      .filter(
        (binding) =>
          (!status || binding.status === status) &&
          (!providerType || binding.providerType === providerType),
      );
  }

  setModelContractEnabled(params: ModelContractEnableParams): ModelContract {
    const repositories = this.repositories();
    const existing = repositories.modelContracts.get(params.contractId, params.contractRevision);
    if (!existing) throw new Error('Model contract revision was not found.');
    const contract = setCatalogStatus(
      JSON.parse(existing.descriptorJson) as ModelContract,
      params.enabled,
    );
    repositories.modelContracts.save({
      ...existing,
      status: contract.status,
      descriptorJson: JSON.stringify(contract),
      updatedAt: this.now(),
    });
    setRegisteredContractStatus(contract.contractId, contract.contractRevision, contract.status);
    return contract;
  }

  setModelBindingEnabled(params: ModelBindingEnableParams): ModelBinding {
    const repositories = this.repositories();
    const existing = repositories.modelBindings.get(params.bindingId);
    if (!existing) throw new Error('Model binding was not found.');
    const contract = repositories.modelContracts.get(
      existing.contractId,
      existing.contractRevision,
    );
    if (params.enabled && (!contract || contract.status !== 'enabled')) {
      throw new ProviderProfileValidationError(
        'Enable and verify the canonical model contract before enabling this binding.',
      );
    }
    const binding = setCatalogStatus(
      JSON.parse(existing.descriptorJson) as ModelBinding,
      params.enabled,
    );
    repositories.modelBindings.save({
      ...existing,
      status: binding.status,
      descriptorJson: JSON.stringify(binding),
      updatedAt: this.now(),
    });
    setRegisteredBindingStatus(binding.bindingId, binding.status);
    return binding;
  }

  proposeAdapterSchema(
    params: UnifiedAgentAdapterSchemaProposeParams,
    diff: string[],
  ): UnifiedAgentAdapterSchemaProposeResult {
    if (params.adapterKey.endsWith(':contract-1')) {
      throw new AdapterSchemaValidationError(
        'Official contract parameters can only change through a verified contract revision.',
      );
    }
    const now = this.now();
    const repositories = this.repositories();
    const existing = repositories.adapterSchemas.get(params.adapterKey);
    const version = (existing?.version ?? 0) + 1;
    const beforeJson = existing?.descriptorJson;
    const descriptorJson = JSON.stringify(params.descriptor);
    this.getDatabase().transaction(() => {
      repositories.adapterSchemas.save({
        adapterKey: params.adapterKey,
        descriptorJson,
        source: 'manual',
        status: 'needs_confirmation',
        version,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      repositories.adapterSchemas.saveAudit({
        id: randomUUID(),
        adapterKey: params.adapterKey,
        version,
        action: 'proposed',
        actorType: params.actorType ?? 'agent',
        conversationId: params.conversationId,
        reason: params.reason,
        beforeJson,
        afterJson: descriptorJson,
        createdAt: now,
      });
    })();
    return {
      status: 'proposed',
      adapterKey: params.adapterKey,
      version,
      requiresConfirmation: true,
      diff,
    };
  }

  confirmAdapterSchema(
    params: UnifiedAgentAdapterSchemaConfirmParams,
  ): UnifiedAgentAdapterSchemaConfirmResult {
    const repositories = this.repositories();
    const existing = repositories.adapterSchemas.get(params.adapterKey);
    if (!existing) throw new AdapterSchemaValidationError('No pending schema proposal exists.');
    if (existing.status !== 'needs_confirmation') {
      throw new AdapterSchemaValidationError('Adapter schema is not awaiting confirmation.');
    }
    if (existing.version !== params.version) {
      throw new AdapterSchemaValidationError('Only the latest schema proposal can be confirmed.');
    }
    const descriptor = parseAdapterDescriptor(existing.descriptorJson);
    const now = this.now();
    this.getDatabase().transaction(() => {
      repositories.adapterSchemas.save({ ...existing, status: 'confirmed', updatedAt: now });
      repositories.adapterSchemas.saveAudit({
        id: randomUUID(),
        adapterKey: params.adapterKey,
        version: existing.version,
        action: 'confirmed',
        actorType: params.actorType ?? 'user',
        conversationId: params.conversationId,
        reason: params.reason,
        beforeJson: existing.descriptorJson,
        afterJson: existing.descriptorJson,
        createdAt: now,
      });
    })();
    return {
      status: 'confirmed',
      adapterKey: params.adapterKey,
      version: existing.version,
      descriptor,
    };
  }

  rollbackAdapterSchema(
    params: UnifiedAgentAdapterSchemaRollbackParams,
  ): UnifiedAgentAdapterSchemaRollbackResult {
    const repositories = this.repositories();
    const existing = repositories.adapterSchemas.get(params.adapterKey);
    if (!existing) throw new AdapterSchemaValidationError('Adapter schema was not found.');
    const target = repositories.adapterSchemas
      .listAudits(params.adapterKey, 200)
      .find(
        (audit) =>
          audit.action === 'confirmed' && audit.version === params.version && audit.afterJson,
      );
    if (!target?.afterJson) {
      throw new AdapterSchemaValidationError(
        'The requested confirmed schema version was not found.',
      );
    }
    const descriptor = parseAdapterDescriptor(target.afterJson);
    const version = existing.version + 1;
    const now = this.now();
    this.getDatabase().transaction(() => {
      repositories.adapterSchemas.save({
        ...existing,
        descriptorJson: target.afterJson!,
        source: 'manual',
        status: 'confirmed',
        version,
        updatedAt: now,
      });
      repositories.adapterSchemas.saveAudit({
        id: randomUUID(),
        adapterKey: params.adapterKey,
        version,
        action: 'rolled_back',
        actorType: params.actorType ?? 'user',
        conversationId: params.conversationId,
        reason: params.reason,
        beforeJson: existing.descriptorJson,
        afterJson: target.afterJson,
        createdAt: now,
      });
    })();
    return {
      status: 'rolled_back',
      adapterKey: params.adapterKey,
      version,
      rolledBackToVersion: params.version,
      descriptor,
    };
  }

  listAdapterSchemaAudits(
    adapterKey: string,
    limit?: number,
  ): UnifiedAgentAdapterSchemaAuditInfo[] {
    return this.repositories()
      .adapterSchemas.listAudits(adapterKey, limit)
      .map((audit) => ({
        id: audit.id,
        adapterKey: audit.adapterKey,
        version: audit.version,
        action: audit.action,
        actorType: audit.actorType,
        conversationId: audit.conversationId,
        reason: audit.reason,
        createdAt: audit.createdAt,
      }));
  }

  listProfiles(includeArchived = false): ProviderProfileInfo[] {
    return this.repositories().providerProfiles.list(includeArchived).map(toProfileInfo);
  }

  getProfile(profileId: string): ProviderProfileInfo | null {
    const normalizedProfileId = requireUuid(profileId);
    const profile = this.repositories().providerProfiles.get(normalizedProfileId);
    return profile && !profile.archivedAt ? toProfileInfo(profile) : null;
  }

  createProfile(params: ProviderProfileCreateParams): ProviderProfileInfo {
    const now = this.now();
    const profile = {
      id: randomUUID(),
      ...normalizeProfileInput(params),
      enabled: false,
      connectionStatus: 'draft' as const,
      createdAt: now,
      updatedAt: now,
    };
    const repositories = this.repositories();
    this.getDatabase().transaction(() => {
      repositories.providerProfiles.save(profile);
      for (const model of listBuiltInProviderModels(profile.providerType)) {
        repositories.providerModels.save({
          id: randomUUID(),
          providerProfileId: profile.id,
          remoteModelId: model.remoteModelId,
          displayName: model.displayName,
          capabilitiesJson: JSON.stringify(model.capabilities),
          source: 'built-in',
          enabled: true,
          ...contractMetadata(profile.providerType, model.remoteModelId, true),
          createdAt: now,
          updatedAt: now,
        });
      }
    })();
    return toProfileInfo(profile);
  }

  updateProfile(params: ProviderProfileUpdateParams): ProviderProfileInfo {
    const normalizedProfileId = requireUuid(params.profileId);
    const repositories = this.repositories();
    const existing = repositories.providerProfiles.get(normalizedProfileId);
    if (!existing || existing.archivedAt) throw new Error('Provider profile was not found.');
    const normalized = normalizeProfileInput(params);
    const profile = {
      ...existing,
      ...normalized,
      enabled: params.enabled,
      connectionStatus: params.enabled
        ? existing.connectionStatus === 'disabled'
          ? ('draft' as const)
          : existing.connectionStatus
        : ('disabled' as const),
      updatedAt: this.now(),
    };
    repositories.providerProfiles.save(profile);
    return toProfileInfo(profile);
  }

  archiveProfile(profileId: string): ProviderProfileInfo {
    const normalizedProfileId = requireUuid(profileId);
    const repositories = this.repositories();
    const existing = repositories.providerProfiles.get(normalizedProfileId);
    if (!existing || existing.archivedAt) throw new Error('Provider profile was not found.');
    const archivedAt = this.now();
    repositories.providerProfiles.archive(normalizedProfileId, archivedAt);
    const archived = repositories.providerProfiles.get(normalizedProfileId);
    if (!archived) throw new Error('Provider profile archive failed.');
    return toProfileInfo(archived);
  }

  migrateLegacyProfile(params: ProviderLegacyMigrationParams): ProviderLegacyMigrationResult {
    const source = params.source;
    if (source !== 'vidu' && source !== 'vidu-cn') {
      throw new ProviderProfileValidationError('Unsupported legacy credential source.');
    }
    const repositories = this.repositories();
    const existing = repositories.providerProfiles.getByMigrationSource(source);
    if (existing) {
      return existing.archivedAt
        ? { state: 'archived' }
        : { state: 'existing', profile: toProfileInfo(existing) };
    }
    const definition = listProviderDefinitions().find(
      (item) => item.id === (source === 'vidu' ? 'vidu-global' : 'vidu-china'),
    );
    if (!definition) throw new Error('Legacy Vidu provider definition was not found.');
    const now = this.now();
    const profile = {
      id: randomUUID(),
      name: `${definition.name}（旧版迁移）`,
      category: definition.category,
      providerType: definition.providerType,
      accessType: definition.accessType,
      protocol: definition.protocol,
      baseUrl: definition.baseUrl,
      enabled: false,
      connectionStatus: 'draft' as const,
      migrationSource: source,
      createdAt: now,
      updatedAt: now,
    };
    this.getDatabase().transaction(() => {
      repositories.providerProfiles.save(profile);
      for (const model of listBuiltInProviderModels(profile.providerType)) {
        repositories.providerModels.save({
          id: randomUUID(),
          providerProfileId: profile.id,
          remoteModelId: model.remoteModelId,
          displayName: model.displayName,
          capabilitiesJson: JSON.stringify(model.capabilities),
          source: 'built-in',
          enabled: true,
          ...contractMetadata(profile.providerType, model.remoteModelId, true),
          createdAt: now,
          updatedAt: now,
        });
      }
    })();
    return { state: 'created', profile: toProfileInfo(profile) };
  }

  listProviderDefinitions(): ProviderDefinitionInfo[] {
    return listProviderDefinitions();
  }

  beginConnectionTest(profileId: string): ProviderRuntimeProfile {
    const normalizedProfileId = requireUuid(profileId);
    const repositories = this.repositories();
    const existing = repositories.providerProfiles.get(normalizedProfileId);
    if (!existing || existing.archivedAt) throw new Error('Provider profile was not found.');
    const testing = {
      ...existing,
      connectionStatus: 'testing' as const,
      updatedAt: this.now(),
    };
    repositories.providerProfiles.save(testing);
    return {
      profileId: testing.id,
      providerType: testing.providerType,
      protocol: testing.protocol,
      baseUrl: testing.baseUrl,
    };
  }

  completeConnectionTest(params: ProviderConnectionCompleteParams): ProviderConnectionResult {
    const normalizedProfileId = requireUuid(params.profileId);
    const repositories = this.repositories();
    const existing = repositories.providerProfiles.get(normalizedProfileId);
    if (!existing || existing.archivedAt) throw new Error('Provider profile was not found.');
    const now = this.now();
    const successful = params.status === 'ready';
    const profile = {
      ...existing,
      enabled: successful ? true : existing.enabled,
      connectionStatus: params.status,
      lastCheckedAt: now,
      lastErrorCode: successful ? undefined : normalizeErrorCode(params.errorCode),
      lastErrorMessage: successful ? undefined : normalizeErrorMessage(params.errorMessage),
      updatedAt: now,
    };

    if (successful && params.models !== undefined) {
      const remoteModels = normalizeRemoteModels(params.models);
      const synchronize = this.getDatabase().transaction(() => {
        repositories.providerProfiles.save(profile);
        this.synchronizeRemoteModels(normalizedProfileId, existing.providerType, remoteModels, now);
      });
      synchronize();
    } else {
      repositories.providerProfiles.save(profile);
    }

    return {
      profile: toProfileInfo(profile),
      models: this.listModels(normalizedProfileId),
      modelSyncStatus: successful
        ? params.models === undefined
          ? 'unsupported'
          : 'synced'
        : params.status === 'sync-failed'
          ? 'failed'
          : 'not-attempted',
    };
  }

  listModels(profileId: string): ProviderModelInfo[] {
    const profile = this.requireActiveProfile(profileId);
    const repository = this.repositories().providerModels;
    return repository.listByProfile(profile.id).map((record) => {
      // Backfill already-synced rows when a newly verified official contract ships.
      const metadata = contractMetadata(profile.providerType, record.remoteModelId, record.enabled);
      const officialBinding = mediaModelBindings.find(
        (binding) =>
          binding.providerType === profile.providerType &&
          binding.remoteModelId === record.remoteModelId,
      );
      if (officialBinding) {
        const existing = toModelInfo(record).capabilities;
        const official = inferContractCapabilities(profile.providerType, record.remoteModelId);
        const capabilities = hasAnyModelCapability(existing)
          ? Object.fromEntries(
              Object.entries(official).map(([key, value]) => [
                key,
                value && existing[key as keyof ProviderModelCapabilities],
              ]),
            )
          : official;
        const capabilitiesJson = JSON.stringify(capabilities);
        if (record.parameterTemplateKey || record.capabilitiesJson !== capabilitiesJson) {
          record = {
            ...record,
            capabilitiesJson,
            parameterTemplateKey: undefined,
            updatedAt: this.now(),
          };
          repository.save(record);
        }
      }
      if (
        metadata.contractId &&
        (record.contractId !== metadata.contractId ||
          record.contractStatus !== metadata.contractStatus)
      ) {
        record = { ...record, ...metadata, updatedAt: this.now() };
        repository.save(record);
      }
      const model = toModelInfo(record);
      if (model.contractId && !hasAnyModelCapability(model.capabilities)) {
        const capabilities = inferContractCapabilities(profile.providerType, model.remoteModelId);
        if (hasAnyModelCapability(capabilities)) {
          const updated = {
            ...record,
            capabilitiesJson: JSON.stringify(capabilities),
            updatedAt: this.now(),
          };
          repository.save(updated);
          return { ...model, capabilities, updatedAt: updated.updatedAt };
        }
      }
      return model;
    });
  }

  createManualModel(params: ProviderModelCreateParams): ProviderModelInfo {
    const profile = this.requireActiveProfile(params.profileId);
    const repositories = this.repositories();
    const remoteModelId = normalizeModelId(params.remoteModelId);
    if (repositories.providerModels.getByRemoteId(profile.id, remoteModelId)) {
      throw new ProviderProfileValidationError(
        'A model with this remote model ID already exists for the provider profile.',
      );
    }
    const requestedCapabilities = normalizeModelCapabilities(params.capabilities);
    const capabilities =
      params.enabled &&
      !hasAnyModelCapability(requestedCapabilities) &&
      resolveModelBinding(profile.providerType, remoteModelId)
        ? inferContractCapabilities(profile.providerType, remoteModelId)
        : requestedCapabilities;
    const enabled = params.enabled === true;
    if (enabled && !hasAnyModelCapability(capabilities)) {
      throw new ProviderProfileValidationError(
        'Select at least one model capability before enabling the model.',
      );
    }
    const parameterTemplateKey = normalizeParameterTemplateKey(
      profile.providerType,
      params.parameterTemplateKey,
    );
    assertOfficialMediaConfiguration(
      profile.providerType,
      remoteModelId,
      capabilities,
      parameterTemplateKey,
    );
    const now = this.now();
    const model = {
      id: randomUUID(),
      providerProfileId: profile.id,
      remoteModelId,
      displayName: normalizeModelName(params.displayName ?? remoteModelId),
      capabilitiesJson: JSON.stringify(capabilities),
      source: 'manual' as const,
      enabled,
      parameterTemplateKey,
      ...contractMetadata(profile.providerType, remoteModelId, enabled),
      createdAt: now,
      updatedAt: now,
    };
    repositories.providerModels.save(model);
    return toModelInfo(model);
  }

  updateModel(params: ProviderModelUpdateParams): ProviderModelInfo {
    const profile = this.requireActiveProfile(params.profileId);
    const repositories = this.repositories();
    const model = repositories.providerModels.get(requireUuid(params.modelId));
    if (!model || model.providerProfileId !== profile.id) {
      throw new Error('Provider model was not found.');
    }
    const requestedCapabilities = normalizeModelCapabilities(params.capabilities);
    const capabilities =
      params.enabled && !hasAnyModelCapability(requestedCapabilities) && model.contractId
        ? inferContractCapabilities(profile.providerType, model.remoteModelId)
        : requestedCapabilities;
    if (params.enabled && !hasAnyModelCapability(capabilities)) {
      throw new ProviderProfileValidationError(
        'Select at least one model capability before enabling the model.',
      );
    }
    if (params.enabled && model.unavailableAt) {
      throw new ProviderProfileValidationError(
        'A remotely unavailable model cannot be enabled until it appears in synchronization again.',
      );
    }
    const parameterTemplateKey =
      params.parameterTemplateKey === undefined
        ? model.parameterTemplateKey
        : normalizeParameterTemplateKey(profile.providerType, params.parameterTemplateKey);
    const updated = {
      ...model,
      displayName: normalizeModelName(params.displayName),
      capabilitiesJson: JSON.stringify(capabilities),
      enabled: params.enabled,
      parameterTemplateKey,
      contractStatus:
        params.enabled && model.contractId ? 'enabled' : (model.contractStatus ?? undefined),
      updatedAt: this.now(),
    };
    assertOfficialMediaConfiguration(
      profile.providerType,
      model.remoteModelId,
      capabilities,
      parameterTemplateKey,
    );
    if (
      mediaModelBindings.some(
        (binding) =>
          binding.providerType === profile.providerType &&
          binding.remoteModelId === model.remoteModelId,
      )
    ) {
      Object.assign(
        updated,
        contractMetadata(profile.providerType, model.remoteModelId, params.enabled),
      );
    }
    repositories.providerModels.save(updated);
    return toModelInfo(updated);
  }

  listModelPricing(profileId: string): ModelPricingInfo[] {
    const profile = this.requireActiveProfile(profileId);
    return this.repositories().modelPricing.listByProfile(profile.id);
  }

  updateModelPricing(params: ModelPricingUpdateParams): ModelPricingInfo {
    const profile = this.requireActiveProfile(params.providerProfileId);
    const repositories = this.repositories();
    const model = repositories.providerModels.get(requireUuid(params.modelId));
    if (!model || model.providerProfileId !== profile.id) {
      throw new Error('Provider model was not found.');
    }
    const creditBased = profile.providerType === 'vidu';
    const pricing: ModelPricingInfo = {
      providerProfileId: profile.id,
      modelId: model.id,
      currency: normalizeCurrency(params.currency),
      unitTokens: 1_000_000,
      inputPrice: creditBased ? '0' : normalizeDecimalPrice(params.inputPrice ?? '', 'Input price'),
      cachedInputPrice:
        !creditBased && params.cachedInputPrice?.trim()
          ? normalizeDecimalPrice(params.cachedInputPrice, 'Cached input price')
          : undefined,
      outputPrice: creditBased
        ? '0'
        : normalizeDecimalPrice(params.outputPrice ?? '', 'Output price'),
      creditPrice: creditBased
        ? normalizeDecimalPrice(params.creditPrice ?? '', 'Credit price')
        : undefined,
      updatedAt: this.now(),
    };
    repositories.modelPricing.save(pricing);
    return pricing;
  }

  resolveCreditPricing(
    providerProfileId: string,
    modelId: string,
  ): { currency: string; creditPrice: string } | undefined {
    const repositories = this.repositories();
    const profile = repositories.providerProfiles.get(requireUuid(providerProfileId));
    if (!profile || profile.archivedAt || profile.providerType !== 'vidu') {
      return undefined;
    }
    const model = resolveProviderModel(repositories.providerModels, profile.id, modelId);
    if (!model) return undefined;
    const pricing = repositories.modelPricing.get(profile.id, model.id);
    return pricing?.creditPrice
      ? { currency: pricing.currency, creditPrice: pricing.creditPrice }
      : undefined;
  }

  listProviderDefaults(): ProviderDefaultInfo[] {
    return this.repositories().providerDefaults.list();
  }

  updateProviderDefault(params: ProviderDefaultUpdateParams): ProviderDefaultInfo | null {
    const role = normalizeProviderDefaultRole(params.role);
    const repositories = this.repositories();
    if (!params.providerProfileId && !params.modelId) {
      repositories.providerDefaults.delete(role);
      return null;
    }
    if (!params.providerProfileId || !params.modelId) {
      throw new ProviderProfileValidationError(
        'Provider profile and model are both required for a default role.',
      );
    }
    const profile = this.requireActiveProfile(params.providerProfileId);
    const model = repositories.providerModels.get(requireUuid(params.modelId));
    if (!model || model.providerProfileId !== profile.id) {
      throw new Error('Provider model was not found.');
    }
    if (!model.enabled || model.unavailableAt) {
      throw new ProviderProfileValidationError(
        'A default role requires an enabled and available model.',
      );
    }
    const capabilities = normalizeModelCapabilities(
      JSON.parse(model.capabilitiesJson) as ProviderModelCapabilities,
    );
    if (!supportsProviderDefaultRole(role, capabilities)) {
      throw new ProviderProfileValidationError(
        `The selected model does not support the ${role} default role.`,
      );
    }
    const record: ProviderDefaultInfo = {
      role,
      providerProfileId: profile.id,
      modelId: model.id,
      updatedAt: this.now(),
    };
    repositories.providerDefaults.save(record);
    return record;
  }

  resolveLlmSelection(profileId: string, modelId: string): ResolvedLlmSelection {
    const normalizedProfileId = requireUuid(profileId);
    const normalizedModelId = requireUuid(modelId);
    const repositories = this.repositories();
    const profile = repositories.providerProfiles.get(normalizedProfileId);
    if (!profile || profile.archivedAt) throw new Error('Provider profile was not found.');
    if (!profile.enabled || profile.connectionStatus !== 'ready') {
      throw new ProviderProfileValidationError(
        'Select an enabled provider connection that passed its connectivity test.',
      );
    }
    if (profile.category !== 'llm' && profile.category !== 'multi') {
      throw new ProviderProfileValidationError('The selected provider does not support LLM use.');
    }
    if (profile.protocol !== 'openai-responses' && profile.protocol !== 'openai-chat-completions') {
      throw new ProviderProfileValidationError(
        'The selected provider protocol does not support LLM streaming.',
      );
    }
    const modelRecord = repositories.providerModels.get(normalizedModelId);
    if (!modelRecord || modelRecord.providerProfileId !== profile.id) {
      throw new Error('Provider model was not found.');
    }
    const model = toModelInfo(modelRecord);
    if (!model.enabled || model.unavailableAt) {
      throw new ProviderProfileValidationError('Select an enabled and available model.');
    }
    if (!model.capabilities.text || !model.capabilities.streaming) {
      throw new ProviderProfileValidationError(
        'The selected model must support text generation and streaming.',
      );
    }
    return {
      providerProfileId: profile.id,
      providerName: profile.name,
      modelId: model.id,
      modelName: model.displayName,
      remoteModelId: model.remoteModelId,
      contractId: model.contractId,
      contractRevision: model.contractRevision,
      contractStatus: model.contractStatus,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      pricingSnapshot: toPricingSnapshot(repositories.modelPricing.get(profile.id, model.id)),
    };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  indexLlmAttempt(project: ProjectRecord, attempt: LlmGenerationAttemptRecord): void {
    const record = toUsageIndexRecord(project, attempt);
    if (record) this.repositories().usageIndex.save(record);
  }

  listUsageIndex(startAt: string, endAt: string): UsageIndexRecord[] {
    return this.repositories().usageIndex.listByCreatedAt(startAt, endAt);
  }

  replaceUsageIndex(records: UsageIndexRecord[]): void {
    const database = this.getDatabase();
    const repository = this.repositories().usageIndex;
    database.transaction(() => {
      database.prepare('DELETE FROM usage_index').run();
      for (const record of records) repository.save(record);
    })();
  }

  private repositories() {
    return createAppRepositories(this.getDatabase());
  }

  private getDatabase(): Database.Database {
    if (!this.database) {
      this.database = openAppDatabase(join(this.appDataDirectory, APP_DATABASE_NAME), {
        nativeBinding: this.nativeBinding,
      });
      migrateAppDatabase(this.database);
      if (!this.modelContractDirectorySeeded) {
        this.seedModelContractDirectory();
        this.modelContractDirectorySeeded = true;
      }
    }
    return this.database;
  }

  private seedModelContractDirectory(): void {
    if (!this.database) throw new Error('Application database is not open.');
    const repositories = createAppRepositories(this.database);
    const now = new Date().toISOString();
    for (const contract of listStaticModelContracts()) {
      const existing = repositories.modelContracts.get(
        contract.contractId,
        contract.contractRevision,
      );
      const isOfficialMediaContract = mediaModelBindings.some(
        (binding) => binding.contractId === contract.contractId,
      );
      const status = isOfficialMediaContract
        ? ((existing?.status as ModelCatalogStatus | undefined) ?? contract.status)
        : contract.status === 'enabled' &&
            existing?.status !== 'rejected' &&
            existing?.status !== 'revalidation_required'
          ? 'enabled'
          : ((existing?.status as ModelCatalogStatus | undefined) ?? contract.status);
      repositories.modelContracts.save({
        contractId: contract.contractId,
        contractRevision: contract.contractRevision,
        status,
        descriptorJson: JSON.stringify({ ...contract, status }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      setRegisteredContractStatus(contract.contractId, contract.contractRevision, status);
    }
    for (const binding of listStaticModelBindings()) {
      const existing = repositories.modelBindings.get(binding.bindingId);
      const isOfficialMediaBinding = mediaModelBindings.some(
        (item) => item.bindingId === binding.bindingId,
      );
      const status = isOfficialMediaBinding
        ? ((existing?.status as ModelCatalogStatus | undefined) ?? binding.status)
        : binding.status === 'enabled' &&
            existing?.status !== 'rejected' &&
            existing?.status !== 'revalidation_required'
          ? 'enabled'
          : ((existing?.status as ModelCatalogStatus | undefined) ?? binding.status);
      repositories.modelBindings.save({
        bindingId: binding.bindingId,
        providerType: binding.providerType,
        remoteModelId: binding.remoteModelId,
        contractId: binding.contractId,
        contractRevision: binding.contractRevision,
        status,
        descriptorJson: JSON.stringify({ ...binding, status }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      setRegisteredBindingStatus(binding.bindingId, status);
    }
  }

  private requireActiveProfile(profileId: string): ProviderProfileInfo {
    const normalizedProfileId = requireUuid(profileId);
    const profile = this.repositories().providerProfiles.get(normalizedProfileId);
    if (!profile || profile.archivedAt) throw new Error('Provider profile was not found.');
    return profile;
  }

  private synchronizeRemoteModels(
    profileId: string,
    providerType: string,
    remoteModels: RemoteProviderModelInfo[],
    now: string,
  ): void {
    const repository = this.repositories().providerModels;
    const seen = new Set(remoteModels.map((model) => model.id));
    for (const remote of remoteModels) {
      const existing = repository.getByRemoteId(profileId, remote.id);
      repository.save({
        id: existing?.id ?? randomUUID(),
        providerProfileId: profileId,
        remoteModelId: remote.id,
        displayName: remote.displayName ?? existing?.displayName ?? remote.id,
        capabilitiesJson: JSON.stringify(
          existing?.capabilitiesJson
            ? normalizeSyncedCapabilities(existing.capabilitiesJson, providerType, remote.id)
            : inferContractCapabilities(providerType, remote.id),
        ),
        source:
          existing?.source === 'manual' || existing?.source === 'built-in'
            ? existing.source
            : 'remote',
        enabled: existing?.enabled ?? false,
        parameterTemplateKey: existing?.parameterTemplateKey,
        ...contractMetadata(providerType, remote.id, existing?.enabled ?? false),
        lastSyncedAt: now,
        lastSeenAt: now,
        unavailableAt: undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    for (const existing of repository.listByProfile(profileId)) {
      if (existing.source !== 'remote' || seen.has(existing.remoteModelId)) continue;
      repository.save({
        ...existing,
        lastSyncedAt: now,
        unavailableAt: existing.unavailableAt ?? now,
        updatedAt: now,
      });
    }
  }
}

function normalizeProfileInput(
  params: ProviderProfileCreateParams,
): Omit<ProviderProfileInfo, 'id' | 'enabled' | 'connectionStatus' | 'createdAt' | 'updatedAt'> {
  const name = params.name.trim();
  if (!name || name.length > PROFILE_NAME_LIMIT) {
    throw new ProviderProfileValidationError(
      `Provider profile name must contain 1-${PROFILE_NAME_LIMIT} characters.`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(params.providerType)) {
    throw new ProviderProfileValidationError('Provider type must be a safe lowercase identifier.');
  }
  if (!IDENTIFIER_PATTERN.test(params.protocol)) {
    throw new ProviderProfileValidationError(
      'Provider protocol must be a safe lowercase identifier.',
    );
  }
  const profile = {
    name,
    category: params.category,
    providerType: params.providerType,
    accessType: params.accessType,
    protocol: params.protocol,
    baseUrl: normalizeBaseUrl(params.baseUrl),
  };
  try {
    validateProviderConfiguration(profile);
  } catch (error) {
    if (error instanceof ProviderRegistryValidationError) {
      throw new ProviderProfileValidationError(error.message);
    }
    throw error;
  }
  return profile;
}

function parseAdapterDescriptor(value: string): AdapterDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AdapterSchemaValidationError('Adapter schema descriptor is invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdapterSchemaValidationError('Adapter schema descriptor must be an object.');
  }
  return parsed as AdapterDescriptor;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderProfileValidationError('Provider Base URL is invalid.');
  }
  if (url.protocol !== 'https:') {
    throw new ProviderProfileValidationError('Provider Base URL must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderProfileValidationError(
      'Provider Base URL cannot contain credentials, query parameters, or fragments.',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function requireUuid(value: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) {
    throw new ProviderProfileValidationError('Provider profile ID is invalid.');
  }
  return normalized;
}

function tryUuid(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return UUID_V4_PATTERN.test(normalized) ? normalized : undefined;
}

function resolveProviderModel(
  models: ReturnType<AppSettingsService['repositories']>['providerModels'],
  profileId: string,
  modelId: string,
): { id: string; providerProfileId: string } | undefined {
  const asUuid = tryUuid(modelId);
  if (asUuid) {
    const byId = models.get(asUuid);
    if (byId?.providerProfileId === profileId) return byId;
  }
  try {
    return models.getByRemoteId(profileId, normalizeModelId(modelId));
  } catch {
    return undefined;
  }
}

function toProfileInfo(record: ProviderProfileInfo): ProviderProfileInfo {
  return {
    ...record,
    lastErrorMessage: record.lastErrorMessage?.slice(0, ERROR_MESSAGE_LIMIT),
  };
}

function normalizeRemoteModels(models: RemoteProviderModelInfo[]): RemoteProviderModelInfo[] {
  if (models.length > 10_000) {
    throw new ProviderProfileValidationError('Provider model list exceeds the supported limit.');
  }
  const normalized = new Map<string, RemoteProviderModelInfo>();
  for (const model of models) {
    const id = normalizeModelId(model.id);
    normalized.set(id, {
      id,
      displayName: model.displayName ? normalizeModelName(model.displayName) : undefined,
    });
  }
  return [...normalized.values()];
}

function normalizeModelId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MODEL_ID_LIMIT || hasControlCharacter(normalized)) {
    throw new ProviderProfileValidationError(
      `Remote model ID must contain 1-${MODEL_ID_LIMIT} non-control characters.`,
    );
  }
  return normalized;
}

function normalizeModelName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MODEL_NAME_LIMIT || hasControlCharacter(normalized)) {
    throw new ProviderProfileValidationError(
      `Model display name must contain 1-${MODEL_NAME_LIMIT} characters.`,
    );
  }
  return normalized;
}

function normalizeModelCapabilities(
  capabilities: ProviderModelCapabilities,
): ProviderModelCapabilities {
  const normalized: ProviderModelCapabilities = {
    text: capabilities.text,
    vision: capabilities.vision,
    streaming: capabilities.streaming,
    reasoning: capabilities.reasoning,
    tools: capabilities.tools,
    structuredOutput: capabilities.structuredOutput,
    embeddings: capabilities.embeddings,
    imageGeneration: capabilities.imageGeneration,
    imageEditing: capabilities.imageEditing ?? false,
    videoGeneration: capabilities.videoGeneration,
  };
  if (Object.values(normalized).some((value) => typeof value !== 'boolean')) {
    throw new ProviderProfileValidationError('Every model capability must be a boolean.');
  }
  return normalized;
}

function normalizeProviderDefaultRole(value: ProviderDefaultRole): ProviderDefaultRole {
  if (!['quality', 'balanced', 'fast', 'vision', 'embedding'].includes(value)) {
    throw new ProviderProfileValidationError('Provider default role is invalid.');
  }
  return value;
}

function supportsProviderDefaultRole(
  role: ProviderDefaultRole,
  capabilities: ProviderModelCapabilities,
): boolean {
  if (role === 'vision') return capabilities.vision;
  if (role === 'embedding') return capabilities.embeddings;
  return capabilities.text && capabilities.streaming;
}

function toModelInfo(record: {
  id: string;
  providerProfileId: string;
  remoteModelId: string;
  displayName: string;
  capabilitiesJson: string;
  source: ProviderModelInfo['source'];
  enabled: boolean;
  parameterTemplateKey?: string;
  lastSyncedAt?: string;
  lastSeenAt?: string;
  unavailableAt?: string;
  contractId?: string;
  contractRevision?: number;
  contractStatus?: ProviderModelInfo['contractStatus'];
  createdAt: string;
  updatedAt: string;
}): ProviderModelInfo {
  const { capabilitiesJson, ...model } = record;
  return {
    ...model,
    capabilities: normalizeModelCapabilities(
      JSON.parse(capabilitiesJson) as ProviderModelCapabilities,
    ),
  };
}

function contractMetadata(
  providerType: string,
  remoteModelId: string,
  enabled = false,
): Pick<ProviderModelInfo, 'contractId' | 'contractRevision' | 'contractStatus'> {
  const resolved = resolveModelBinding(providerType, remoteModelId);
  return resolved
    ? {
        contractId: resolved.binding.contractId,
        contractRevision: resolved.binding.contractRevision,
        contractStatus:
          resolved.contract.status !== 'enabled'
            ? resolved.contract.status
            : resolved.binding.status !== 'enabled'
              ? resolved.binding.status
              : enabled
                ? 'enabled'
                : resolved.binding.status,
      }
    : {};
}

function assertOfficialMediaConfiguration(
  providerType: string,
  remoteModelId: string,
  capabilities: ProviderModelCapabilities,
  templateKey?: string,
): void {
  const binding = mediaModelBindings.find(
    (item) => item.providerType === providerType && item.remoteModelId === remoteModelId,
  );
  if (!binding) return;
  if (templateKey)
    throw new ProviderProfileValidationError(
      'This media model binds an official contract and cannot use a channel parameter template.',
    );
  const official = inferContractCapabilities(providerType, remoteModelId);
  for (const key of Object.keys(capabilities) as (keyof ProviderModelCapabilities)[]) {
    if (capabilities[key] && !official[key])
      throw new ProviderProfileValidationError(
        'Model capabilities cannot exceed the official contract.',
      );
  }
}

function normalizeSyncedCapabilities(
  capabilitiesJson: string,
  providerType: string,
  remoteModelId: string,
): ProviderModelCapabilities {
  const existing = normalizeModelCapabilities(
    JSON.parse(capabilitiesJson) as ProviderModelCapabilities,
  );
  if (hasAnyModelCapability(existing)) return existing;
  return inferContractCapabilities(providerType, remoteModelId);
}

function inferContractCapabilities(
  providerType: string,
  remoteModelId: string,
): ProviderModelCapabilities {
  const resolved = resolveModelBinding(providerType, remoteModelId);
  if (!resolved) return inferKnownModelCapabilities(providerType, remoteModelId);
  const capabilities = emptyModelCapabilities();
  capabilities.text = resolved.contract.capabilities.text;
  capabilities.vision = resolved.contract.capabilities.vision;
  capabilities.streaming = resolved.contract.capabilities.streaming;
  capabilities.reasoning = resolved.contract.capabilities.reasoning;
  capabilities.tools = resolved.contract.capabilities.tools;
  capabilities.structuredOutput = resolved.contract.capabilities.structuredOutput;
  capabilities.imageGeneration = resolved.contract.capabilities.imageGeneration;
  capabilities.imageEditing = resolved.contract.capabilities.imageEditing;
  capabilities.videoGeneration = resolved.contract.capabilities.videoGeneration;
  return capabilities;
}

function normalizeParameterTemplateKey(
  providerType: string,
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim();
  if (providerType !== 'unicompapi' || !isUniCompApiMediaTemplateKey(normalized)) {
    throw new ProviderProfileValidationError('Parameter template is not supported for this model.');
  }
  return normalized;
}

function normalizeErrorCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().slice(0, ERROR_CODE_LIMIT);
  return normalized || undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizeErrorMessage(value: string | undefined): string | undefined {
  const normalized = value?.trim().slice(0, ERROR_MESSAGE_LIMIT);
  return normalized || undefined;
}

function toPricingSnapshot(
  pricing: ModelPricingInfo | undefined,
): LlmPricingSnapshotInfo | undefined {
  return pricing
    ? {
        currency: pricing.currency,
        unitTokens: pricing.unitTokens,
        inputPrice: pricing.inputPrice,
        cachedInputPrice: pricing.cachedInputPrice,
        outputPrice: pricing.outputPrice,
        configuredAt: pricing.updatedAt,
      }
    : undefined;
}

export function toUsageIndexRecord(
  project: ProjectRecord,
  attempt: LlmGenerationAttemptRecord,
): UsageIndexRecord | undefined {
  if (!attempt.providerProfileId || !attempt.modelId) return undefined;
  if (!['complete', 'failed', 'cancelled'].includes(attempt.status)) return undefined;
  return {
    attemptId: attempt.id,
    projectId: project.id,
    projectName: project.name,
    providerProfileId: attempt.providerProfileId,
    providerName: attempt.providerNameSnapshot,
    modelId: attempt.modelId,
    modelName: attempt.modelNameSnapshot,
    status: attempt.status,
    inputTokens: attempt.inputTokens,
    cachedInputTokens: attempt.cachedInputTokens,
    outputTokens: attempt.outputTokens,
    reasoningTokens: attempt.reasoningTokens,
    totalTokens: attempt.totalTokens,
    estimatedCost: attempt.estimatedCost,
    currency: attempt.currency,
    createdAt: attempt.startedAt,
  };
}
