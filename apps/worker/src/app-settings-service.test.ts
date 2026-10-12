import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppSettingsService,
  normalizeBaseUrl,
  ProviderProfileValidationError,
} from './app-settings-service.js';
import { emptyModelCapabilities } from './provider-registry.js';
import { getAdapter } from '@ai-video/generation-adapters';
import { openAppDatabase } from '@ai-video/persistence';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-worker-settings-'));
  temporaryDirectories.push(directory);
  let tick = 0;
  return new AppSettingsService({
    appDataDirectory: directory,
    now: () => `2026-08-03T00:00:0${tick++}.000Z`,
  });
}

describe('AppSettingsService', () => {
  it('preserves an explicitly disabled official media contract across directory reseeding', async () => {
    const service = await createService();
    const contractId = 'cn.happyhorse.1.1.t2v';
    service.setModelContractEnabled({ contractId, contractRevision: 1, enabled: false });
    service.close();
    const reopened = new AppSettingsService({ appDataDirectory: temporaryDirectories.at(-1)! });
    try {
      expect(reopened.getModelContract(contractId, 1)?.status).toBe('verified');
      reopened.setModelContractEnabled({ contractId, contractRevision: 1, enabled: true });
    } finally {
      reopened.close();
    }
  });

  it('backfills previously synced HappyHorse models and uses only the official contract', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'UniComp',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const model = service.createManualModel({
      profileId: profile.id,
      remoteModelId: 'happyhorse-1.1-r2v',
      capabilities: emptyModelCapabilities(),
    });
    const legacyDatabase = openAppDatabase(
      join(temporaryDirectories.at(-1)!, 'app-settings.sqlite'),
    );
    legacyDatabase
      .prepare(
        'UPDATE provider_models SET contract_id = NULL, contract_revision = NULL, contract_status = NULL, parameter_template_key = ? WHERE id = ?',
      )
      .run('openai-compatible-video', model.id);
    legacyDatabase.close();
    expect(service.listModels(profile.id)[0]).toMatchObject({
      contractId: 'cn.happyhorse.1.1.r2v',
      capabilities: { videoGeneration: true, text: false, tools: false },
    });
    const enabled = service.updateModel({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: emptyModelCapabilities(),
      enabled: true,
    });
    expect(enabled.parameterTemplateKey).toBeUndefined();
    expect(() =>
      service.updateModel({
        ...enabled,
        profileId: profile.id,
        modelId: model.id,
        parameterTemplateKey: 'openai-compatible-video',
      }),
    ).toThrow('cannot use a channel parameter template');
    expect(() =>
      service.updateModel({
        ...enabled,
        profileId: profile.id,
        modelId: model.id,
        capabilities: { ...enabled.capabilities, tools: true },
      }),
    ).toThrow('cannot exceed the official contract');
    service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'happyhorse-1.1-r2v' }],
    });
    service.close();
  });

  it('creates, updates, lists, and archives provider profiles', async () => {
    const service = await createService();
    const created = service.createProfile({
      name: ' OpenAI 主账号 ',
      category: 'llm',
      providerType: 'openai',
      accessType: 'official',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1/',
    });
    expect(created).toMatchObject({
      name: 'OpenAI 主账号',
      baseUrl: 'https://api.openai.com/v1',
      enabled: false,
      connectionStatus: 'draft',
    });
    expect(service.getProfile(created.id)).toEqual(created);
    expect(service.getProfile(created.id.toUpperCase())).toEqual(created);

    const updated = service.updateProfile({
      profileId: created.id,
      name: 'OpenAI 备用账号',
      category: 'llm',
      providerType: 'openai',
      accessType: 'custom',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://relay.example/v1',
      enabled: true,
    });
    expect(updated).toMatchObject({
      name: 'OpenAI 备用账号',
      accessType: 'custom',
      enabled: true,
    });
    expect(service.listProfiles()).toHaveLength(1);

    const archived = service.archiveProfile(created.id);
    expect(archived).toMatchObject({ enabled: false, connectionStatus: 'disabled' });
    expect(service.getProfile(created.id)).toBeNull();
    expect(service.listProfiles()).toHaveLength(0);
    expect(service.listProfiles(true)).toHaveLength(1);
    service.close();
  });

  it('rejects unsafe identifiers and Base URLs', async () => {
    const service = await createService();
    expect(() =>
      service.createProfile({
        name: 'Unsafe',
        category: 'llm',
        providerType: '../../secret',
        accessType: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toThrow(ProviderProfileValidationError);
    expect(() => normalizeBaseUrl('http://relay.example/v1')).toThrow('must use HTTPS');
    expect(() => normalizeBaseUrl('https://user:pass@relay.example/v1?key=secret')).toThrow(
      'cannot contain credentials',
    );
    service.close();
  });

  it('seeds enabled built-in media models for each Vidu connection', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'Vidu 中国站 A',
      category: 'multi',
      providerType: 'vidu',
      accessType: 'official',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
    });
    const models = service.listModels(profile.id);
    expect(models).toHaveLength(10);
    expect(models.every((model) => model.source === 'built-in' && model.enabled)).toBe(true);
    expect(models.find((model) => model.remoteModelId === 'viduq2')?.capabilities).toMatchObject({
      imageGeneration: true,
      videoGeneration: false,
    });
    expect(
      models.find((model) => model.remoteModelId === 'viduq3-pro')?.capabilities,
    ).toMatchObject({
      imageGeneration: false,
      videoGeneration: true,
    });

    const connected = service.completeConnectionTest({ profileId: profile.id, status: 'ready' });
    expect(connected.modelSyncStatus).toBe('unsupported');
    expect(connected.models.every((model) => model.source === 'built-in')).toBe(true);
    service.close();
  });

  it('persists canonical contract metadata for a verified model binding candidate', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'MiniMax',
      category: 'llm',
      providerType: 'minimax',
      accessType: 'custom',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.minimaxi.com/v1',
    });
    const model = service.createManualModel({
      profileId: profile.id,
      remoteModelId: 'MiniMax-H3',
      displayName: 'MiniMax H3',
      capabilities: { ...emptyModelCapabilities(), text: true, streaming: true, tools: true },
      enabled: false,
    });
    expect(model).toMatchObject({
      remoteModelId: 'MiniMax-H3',
      contractId: 'cn.minimax.h3',
      contractRevision: 1,
      contractStatus: 'discovered',
    });
    const enabled = service.updateModel({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: model.capabilities,
      enabled: true,
    });
    expect(enabled.contractStatus).toBe('enabled');
    service.close();
  });

  it('tracks adapter schema proposals, confirmation, rollback, and audits', async () => {
    const service = await createService();
    const base = getAdapter('TEXT_TO_IMAGE:vidu:viduq2:v2');
    if (!base) throw new Error('test adapter missing');
    const proposed = service.proposeAdapterSchema(
      {
        adapterKey: base.key,
        descriptor: {
          ...base,
          schemaVersion: base.schemaVersion + 1,
          parameterSchema: {
            ...base.parameterSchema,
            properties: {
              ...base.parameterSchema.properties,
              quality: { type: 'string', title: 'Quality', enum: ['standard', 'high'] },
            },
          },
        },
        reason: 'official schema update',
      },
      ['parameter added: quality'],
    );
    expect(proposed).toMatchObject({ status: 'proposed', version: 1, requiresConfirmation: true });
    expect(service.getAdapterSchema(base.key)).toBeNull();
    const confirmed = service.confirmAdapterSchema({ adapterKey: base.key, version: 1 });
    expect(confirmed.status).toBe('confirmed');
    expect(service.getAdapterSchema(base.key)?.schemaVersion).toBe(2);
    const audits = service.listAdapterSchemaAudits(base.key);
    expect(audits.map((audit) => audit.action)).toEqual(['confirmed', 'proposed']);
    const rolledBack = service.rollbackAdapterSchema({ adapterKey: base.key, version: 1 });
    expect(rolledBack).toMatchObject({ status: 'rolled_back', rolledBackToVersion: 1, version: 2 });
    service.close();
  });

  it('synchronizes models without granting capabilities to unknown IDs', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'Relay',
      category: 'llm',
      providerType: 'relay',
      accessType: 'custom',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://relay.example/v1',
    });

    expect(service.beginConnectionTest(profile.id)).toMatchObject({
      profileId: profile.id,
      protocol: 'openai-chat-completions',
    });
    const synchronized = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'vendor-experimental-model' }, { id: 'vendor-experimental-model' }],
    });
    expect(synchronized.modelSyncStatus).toBe('synced');
    expect(synchronized.models).toHaveLength(1);
    expect(synchronized.models[0]).toMatchObject({
      remoteModelId: 'vendor-experimental-model',
      enabled: false,
      capabilities: emptyModelCapabilities(),
    });

    const classified = service.updateModel({
      profileId: profile.id,
      modelId: synchronized.models[0]!.id,
      displayName: 'Relay Vision Model',
      capabilities: { ...emptyModelCapabilities(), text: true, vision: true, streaming: true },
      enabled: true,
    });
    expect(classified.enabled).toBe(true);

    const syncFailed = service.completeConnectionTest({
      profileId: profile.id,
      status: 'sync-failed',
      errorCode: 'models-invalid',
      errorMessage: 'The provider returned an invalid model list.',
    });
    expect(syncFailed.modelSyncStatus).toBe('failed');
    expect(syncFailed.models).toEqual([classified]);
    service.close();
  });

  it('uses an explicit canonical contract for known current model IDs', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'DeepSeek',
      category: 'llm',
      providerType: 'deepseek',
      accessType: 'custom',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.deepseek.com',
    });
    const synchronized = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'deepseek-flash' }],
    });
    expect(synchronized.models[0]).toMatchObject({
      remoteModelId: 'deepseek-flash',
      contractId: 'cn.deepseek.v4.1-flash',
      contractRevision: 1,
      contractStatus: 'discovered',
      capabilities: {
        text: true,
        vision: true,
        streaming: true,
        tools: true,
      },
    });
    service.close();
  });

  it('binds confirmed UniComp model IDs to canonical contracts', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'UniCompAPI',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const model = service.createManualModel({
      profileId: profile.id,
      remoteModelId: 'glm-5.3',
      displayName: 'GLM-5.3',
      capabilities: { ...emptyModelCapabilities(), text: true, streaming: true, tools: true },
      enabled: true,
    });
    expect(model).toMatchObject({
      contractId: 'cn.zhipu.glm-5.3',
      contractRevision: 1,
      contractStatus: 'enabled',
    });
    service.close();
  });

  it('fills default capabilities for an already discovered contract-bound model', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'UniCompAPI',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const first = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'deepseek-v4-flash-0731' }],
    });
    expect(first.models[0]).toMatchObject({
      contractId: 'cn.deepseek.v4.1-flash',
      capabilities: { text: true, streaming: true, tools: true, vision: true },
    });
    service.close();
  });

  it('marks disappeared remote models unavailable and keeps manual models', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'OpenAI',
      category: 'llm',
      providerType: 'openai',
      accessType: 'official',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
    const first = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'gpt-5' }, { id: 'gpt-4.1' }],
    });
    expect(first.models.every((model) => model.enabled === false)).toBe(true);

    const manual = service.createManualModel({
      profileId: profile.id,
      remoteModelId: 'manual-deployment',
      capabilities: { ...emptyModelCapabilities(), text: true, streaming: true },
      enabled: true,
    });
    const second = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'gpt-5' }],
    });
    expect(second.models.find((model) => model.remoteModelId === 'gpt-4.1')?.unavailableAt).toBe(
      '2026-08-03T00:00:03.000Z',
    );
    expect(second.models.find((model) => model.id === manual.id)?.unavailableAt).toBeUndefined();
    service.close();
  });

  it('preserves user capability checkboxes across UniCompAPI synchronization', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'UniCompAPI',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const first = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'gpt-5.6-terra' }, { id: 'vendor-experimental-model' }],
    });
    const terra = first.models.find((item) => item.remoteModelId === 'gpt-5.6-terra')!;
    const unknown = first.models.find(
      (item) => item.remoteModelId === 'vendor-experimental-model',
    )!;
    expect(terra.enabled).toBe(false);
    expect(terra.capabilities.tools).toBe(true);
    expect(unknown.enabled).toBe(false);
    expect(unknown.capabilities).toMatchObject({
      text: false,
      tools: false,
      imageGeneration: false,
    });

    service.updateModel({
      profileId: profile.id,
      modelId: terra.id,
      displayName: terra.displayName,
      capabilities: { ...emptyModelCapabilities(), text: true, streaming: true },
      enabled: false,
    });
    const refreshed = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'gpt-5.6-terra' }, { id: 'vendor-experimental-model' }],
    });
    expect(
      refreshed.models.find((item) => item.remoteModelId === 'gpt-5.6-terra')?.capabilities.tools,
    ).toBe(false);
    expect(refreshed.models.find((item) => item.remoteModelId === 'gpt-5.6-terra')?.enabled).toBe(
      false,
    );
    service.close();
  });

  it('binds a UniCompAPI media template without copying remote model IDs into adapters', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'UniCompAPI',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const synced = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'vendor-hosted-video-model' }],
    });
    const model = synced.models[0]!;
    const updated = service.updateModel({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: { ...emptyModelCapabilities(), videoGeneration: true },
      enabled: true,
      parameterTemplateKey: 'openai-compatible-video',
    });
    expect(updated.parameterTemplateKey).toBe('openai-compatible-video');
    expect(updated.remoteModelId).toBe('vendor-hosted-video-model');
    const resynced = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'vendor-hosted-video-model' }],
    });
    expect(resynced.models[0]?.parameterTemplateKey).toBe('openai-compatible-video');
    expect(resynced.models[0]?.capabilities.videoGeneration).toBe(true);
    service.close();
  });

  it('rejects altered official endpoints while retaining failed profile configuration', async () => {
    const service = await createService();
    expect(() =>
      service.createProfile({
        name: 'Fake official',
        category: 'llm',
        providerType: 'openai',
        accessType: 'official',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toThrow('must match a built-in definition');

    const profile = service.createProfile({
      name: 'Relay',
      category: 'llm',
      providerType: 'relay',
      accessType: 'custom',
      protocol: 'openai-responses',
      baseUrl: 'https://relay.example/v1',
    });
    service.completeConnectionTest({
      profileId: profile.id,
      status: 'auth-failed',
      errorCode: 'http-401',
      errorMessage: `Authentication failed ${'x'.repeat(600)}`,
    });
    expect(service.getProfile(profile.id)).toMatchObject({
      baseUrl: 'https://relay.example/v1',
      connectionStatus: 'auth-failed',
      lastErrorCode: 'http-401',
    });
    expect(service.getProfile(profile.id)?.lastErrorMessage).toHaveLength(500);
    service.close();
  });

  it('resolves only ready LLM profiles with enabled streaming text models', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'Managed OpenAI',
      category: 'llm',
      providerType: 'openai',
      accessType: 'official',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(() => service.resolveLlmSelection(profile.id, profile.id)).toThrow(
      'passed its connectivity test',
    );
    const connected = service.completeConnectionTest({
      profileId: profile.id,
      status: 'ready',
      models: [{ id: 'gpt-5' }],
    });
    const model = connected.models[0]!;
    expect(() => service.resolveLlmSelection(profile.id, model.id)).toThrow(
      'enabled and available',
    );
    service.updateModel({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: model.capabilities,
      enabled: true,
    });

    const pricing = service.updateModelPricing({
      providerProfileId: profile.id,
      modelId: model.id,
      currency: 'usd',
      inputPrice: '1.2500',
      cachedInputPrice: '0.5',
      outputPrice: '10',
    });
    expect(service.listModelPricing(profile.id)).toEqual([pricing]);

    const resolved = service.resolveLlmSelection(profile.id, model.id);
    expect(resolved).toEqual({
      providerProfileId: profile.id,
      providerName: 'Managed OpenAI',
      modelId: model.id,
      modelName: model.displayName,
      remoteModelId: 'gpt-5',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      pricingSnapshot: {
        currency: 'USD',
        unitTokens: 1_000_000,
        inputPrice: '1.25',
        cachedInputPrice: '0.5',
        outputPrice: '10',
        configuredAt: pricing.updatedAt,
      },
    });
    service.updateModelPricing({
      providerProfileId: profile.id,
      modelId: model.id,
      currency: 'USD',
      inputPrice: '99',
      outputPrice: '99',
    });
    expect(resolved.pricingSnapshot?.inputPrice).toBe('1.25');

    const defaultModel = service.updateProviderDefault({
      role: 'balanced',
      providerProfileId: profile.id,
      modelId: model.id,
    });
    expect(service.listProviderDefaults()).toEqual([defaultModel]);
    expect(() =>
      service.updateProviderDefault({
        role: 'embedding',
        providerProfileId: profile.id,
        modelId: model.id,
      }),
    ).toThrow('does not support');
    expect(service.updateProviderDefault({ role: 'balanced' })).toBeNull();
    expect(service.listProviderDefaults()).toEqual([]);
    service.close();
  });

  it('stores a user-defined Vidu price per credit', async () => {
    const service = await createService();
    const profile = service.createProfile({
      name: 'Vidu 中国站',
      category: 'multi',
      providerType: 'vidu',
      accessType: 'official',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
    });
    const model = service.listModels(profile.id).find((item) => item.remoteModelId === 'viduq3')!;

    const pricing = service.updateModelPricing({
      providerProfileId: profile.id,
      modelId: model.id,
      currency: 'cny',
      creditPrice: '0.0312500',
    });

    expect(pricing).toMatchObject({
      currency: 'CNY',
      inputPrice: '0',
      outputPrice: '0',
      creditPrice: '0.03125',
    });
    expect(service.resolveCreditPricing(profile.id, model.id)).toEqual({
      currency: 'CNY',
      creditPrice: '0.03125',
    });
    expect(service.resolveCreditPricing(profile.id, 'viduq3')).toEqual({
      currency: 'CNY',
      creditPrice: '0.03125',
    });
    expect(service.resolveCreditPricing(profile.id, 'missing-model')).toBeUndefined();
    service.close();
  });

  it('creates one idempotent migration profile per legacy Vidu credential source', async () => {
    const service = await createService();
    const first = service.migrateLegacyProfile({ source: 'vidu-cn' });
    expect(first).toMatchObject({
      state: 'created',
      profile: {
        name: 'Vidu 中国站（旧版迁移）',
        baseUrl: 'https://api.vidu.cn',
        protocol: 'vidu-v2',
        migrationSource: 'vidu-cn',
        enabled: false,
        connectionStatus: 'draft',
      },
    });
    expect(first.profile && service.listModels(first.profile.id)).toHaveLength(10);
    expect(service.migrateLegacyProfile({ source: 'vidu-cn' })).toMatchObject({
      state: 'existing',
      profile: { id: first.profile?.id },
    });
    if (!first.profile) throw new Error('Migration profile was not created.');
    service.archiveProfile(first.profile.id);
    expect(service.migrateLegacyProfile({ source: 'vidu-cn' })).toEqual({ state: 'archived' });
    service.close();
  });
});
