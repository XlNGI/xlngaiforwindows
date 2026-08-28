import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkAppIntegrity,
  createAppRepositories,
  getAppSchemaVersion,
  getSchemaVersion,
  migrateAppDatabase,
  migrateDatabase,
  openAppDatabase,
  openProjectDatabase,
} from './index.js';
import { APP_MIGRATION_V1 } from './app-schema.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-app-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('app settings database', () => {
  it('migrates independently from project databases and contains no credential column', async () => {
    const directory = await temporaryDirectory();
    const appDatabase = openAppDatabase(join(directory, 'app-settings.sqlite'));
    const projectDatabase = openProjectDatabase(join(directory, 'project.sqlite'));

    expect(getAppSchemaVersion(appDatabase)).toBe(0);
    expect(migrateAppDatabase(appDatabase)).toBe(3);
    expect(checkAppIntegrity(appDatabase)).toMatchObject({ ok: true, schemaVersion: 3 });
    expect(getSchemaVersion(projectDatabase)).toBe(0);
    expect(migrateDatabase(projectDatabase)).toBe(31);
    expect(getAppSchemaVersion(appDatabase)).toBe(3);

    const providerColumns = appDatabase
      .prepare("SELECT name FROM pragma_table_info('provider_profiles')")
      .all() as Array<{ name: string }>;
    expect(providerColumns.map((column) => column.name)).not.toContain('api_key');
    expect(providerColumns.map((column) => column.name)).not.toContain('secret');
    expect(providerColumns.map((column) => column.name)).toContain('migration_source');

    appDatabase.close();
    projectDatabase.close();
  });

  it('upgrades an existing app schema v1 without losing provider profiles', async () => {
    const directory = await temporaryDirectory();
    const database = openAppDatabase(join(directory, 'app-settings-v1.sqlite'));
    database.exec(APP_MIGRATION_V1);
    database
      .prepare('INSERT INTO app_schema_migrations (version, applied_at) VALUES (1, ?)')
      .run('2026-08-03T00:00:00.000Z');
    database
      .prepare(
        `INSERT INTO provider_profiles
         (id, name, category, provider_type, access_type, protocol, base_url, enabled,
          connection_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '11111111-1111-4111-8111-111111111111',
        'Existing Vidu',
        'multi',
        'vidu',
        'official',
        'vidu-v2',
        'https://api.vidu.cn',
        1,
        'ready',
        '2026-08-03T00:00:00.000Z',
        '2026-08-03T00:00:00.000Z',
      );

    expect(migrateAppDatabase(database, '2026-08-03T01:00:00.000Z')).toBe(3);
    expect(createAppRepositories(database).providerProfiles.list()).toMatchObject([
      { name: 'Existing Vidu', migrationSource: undefined },
    ]);
    database.close();
  });

  it('round-trips provider, model, pricing, defaults, and idempotent usage records', async () => {
    const directory = await temporaryDirectory();
    const database = openAppDatabase(join(directory, 'app-settings.sqlite'));
    migrateAppDatabase(database, '2026-08-03T00:00:00.000Z');
    const repositories = createAppRepositories(database);

    repositories.providerProfiles.save({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'OpenAI 主账号',
      category: 'llm',
      providerType: 'openai',
      accessType: 'official',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      connectionStatus: 'ready',
      migrationSource: 'vidu',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    repositories.providerModels.save({
      id: 'model-record',
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      remoteModelId: 'quality-model',
      displayName: 'Quality Model',
      capabilitiesJson: JSON.stringify(['text', 'streaming']),
      source: 'remote',
      enabled: true,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    repositories.modelPricing.save({
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      modelId: 'model-record',
      currency: 'CNY',
      unitTokens: 1_000_000,
      inputPrice: '8.00',
      cachedInputPrice: '2.00',
      outputPrice: '32.00',
      creditPrice: '0.03125',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    repositories.providerDefaults.save({
      role: 'balanced',
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      modelId: 'model-record',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    repositories.usageIndex.save({
      attemptId: 'attempt',
      projectId: 'project',
      projectName: 'Project',
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      providerName: 'OpenAI 主账号',
      modelId: 'quality-model',
      modelName: 'Quality Model',
      status: 'complete',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCost: '0.0024',
      currency: 'CNY',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    repositories.usageIndex.save({
      attemptId: 'attempt',
      projectId: 'project',
      projectName: 'Project',
      providerProfileId: '11111111-1111-4111-8111-111111111111',
      providerName: 'OpenAI 主账号',
      modelId: 'quality-model',
      modelName: 'Quality Model',
      status: 'complete',
      inputTokens: 120,
      outputTokens: 60,
      totalTokens: 180,
      estimatedCost: '0.0029',
      currency: 'CNY',
      createdAt: '2026-08-03T00:00:00.000Z',
    });

    expect(repositories.providerProfiles.list()).toHaveLength(1);
    expect(repositories.providerProfiles.getByMigrationSource('vidu')).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      migrationSource: 'vidu',
    });
    expect(
      repositories.providerModels.getByRemoteId(
        '11111111-1111-4111-8111-111111111111',
        'quality-model',
      ),
    ).toMatchObject({ displayName: 'Quality Model', enabled: true });
    expect(
      repositories.modelPricing.get('11111111-1111-4111-8111-111111111111', 'model-record'),
    ).toMatchObject({
      currency: 'CNY',
      inputPrice: '8.00',
      outputPrice: '32.00',
      creditPrice: '0.03125',
    });
    expect(repositories.providerDefaults.get('balanced')).toMatchObject({
      modelId: 'model-record',
    });
    expect(repositories.usageIndex.get('attempt')).toMatchObject({
      inputTokens: 120,
      outputTokens: 60,
      estimatedCost: '0.0029',
    });
    expect(
      repositories.usageIndex.listByCreatedAt(
        '2026-08-03T00:00:00.000Z',
        '2026-08-04T00:00:00.000Z',
      ),
    ).toHaveLength(1);

    repositories.providerProfiles.archive(
      '11111111-1111-4111-8111-111111111111',
      '2026-08-03T01:00:00.000Z',
    );
    expect(repositories.providerProfiles.list()).toHaveLength(0);
    expect(repositories.providerProfiles.list(true)).toMatchObject([
      { enabled: false, connectionStatus: 'disabled' },
    ]);

    database.close();
  });
});
