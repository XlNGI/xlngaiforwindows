import type Database from 'better-sqlite3';
import type {
  ModelPricingRecord,
  ModelPricingRepository,
  ProviderDefaultRecord,
  ProviderDefaultRepository,
  ProviderDefaultRole,
  ProviderModelRecord,
  ProviderModelRepository,
  ProviderProfileRecord,
  ProviderProfileRepository,
  UsageIndexRecord,
  UsageIndexRepository,
} from '@ai-video/domain';

class SqliteProviderProfileRepository implements ProviderProfileRepository {
  constructor(private readonly database: Database.Database) {}

  save(record: ProviderProfileRecord): void {
    this.database
      .prepare(
        `INSERT INTO provider_profiles
         (id, name, category, provider_type, access_type, protocol, base_url,
          enabled, connection_status, last_checked_at, last_error_code,
          last_error_message, migration_source, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           category = excluded.category,
           provider_type = excluded.provider_type,
           access_type = excluded.access_type,
           protocol = excluded.protocol,
           base_url = excluded.base_url,
           enabled = excluded.enabled,
           connection_status = excluded.connection_status,
           last_checked_at = excluded.last_checked_at,
           last_error_code = excluded.last_error_code,
           last_error_message = excluded.last_error_message,
           migration_source = excluded.migration_source,
           updated_at = excluded.updated_at,
           archived_at = excluded.archived_at`,
      )
      .run(
        record.id,
        record.name,
        record.category,
        record.providerType,
        record.accessType,
        record.protocol,
        record.baseUrl,
        record.enabled ? 1 : 0,
        record.connectionStatus,
        record.lastCheckedAt ?? null,
        record.lastErrorCode ?? null,
        record.lastErrorMessage ?? null,
        record.migrationSource ?? null,
        record.createdAt,
        record.updatedAt,
        record.archivedAt ?? null,
      );
  }

  get(id: string): ProviderProfileRecord | undefined {
    const row = this.database.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(id) as
      ProviderProfileRow | undefined;
    return row ? mapProviderProfile(row) : undefined;
  }

  list(includeArchived = false): ProviderProfileRecord[] {
    const rows = this.database
      .prepare(
        includeArchived
          ? 'SELECT * FROM provider_profiles ORDER BY name, id'
          : 'SELECT * FROM provider_profiles WHERE archived_at IS NULL ORDER BY name, id',
      )
      .all() as ProviderProfileRow[];
    return rows.map(mapProviderProfile);
  }

  getByMigrationSource(source: 'vidu' | 'vidu-cn'): ProviderProfileRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM provider_profiles WHERE migration_source = ?')
      .get(source) as ProviderProfileRow | undefined;
    return row ? mapProviderProfile(row) : undefined;
  }

  archive(id: string, archivedAt: string): void {
    this.database
      .prepare(
        `UPDATE provider_profiles
         SET archived_at = ?, enabled = 0, connection_status = 'disabled', updated_at = ?
         WHERE id = ?`,
      )
      .run(archivedAt, archivedAt, id);
  }
}

interface ProviderProfileRow {
  id: string;
  name: string;
  category: ProviderProfileRecord['category'];
  provider_type: string;
  access_type: ProviderProfileRecord['accessType'];
  protocol: string;
  base_url: string;
  enabled: number;
  connection_status: ProviderProfileRecord['connectionStatus'];
  last_checked_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  migration_source: ProviderProfileRecord['migrationSource'] | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function mapProviderProfile(row: ProviderProfileRow): ProviderProfileRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    providerType: row.provider_type,
    accessType: row.access_type,
    protocol: row.protocol,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    connectionStatus: row.connection_status,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    migrationSource: row.migration_source ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

class SqliteProviderModelRepository implements ProviderModelRepository {
  constructor(private readonly database: Database.Database) {}

  save(record: ProviderModelRecord): void {
    this.database
      .prepare(
        `INSERT INTO provider_models
         (id, provider_profile_id, remote_model_id, display_name, capabilities_json,
          source, enabled, last_synced_at, last_seen_at, unavailable_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           remote_model_id = excluded.remote_model_id,
           display_name = excluded.display_name,
           capabilities_json = excluded.capabilities_json,
           source = excluded.source,
           enabled = excluded.enabled,
           last_synced_at = excluded.last_synced_at,
           last_seen_at = excluded.last_seen_at,
           unavailable_at = excluded.unavailable_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.providerProfileId,
        record.remoteModelId,
        record.displayName,
        record.capabilitiesJson,
        record.source,
        record.enabled ? 1 : 0,
        record.lastSyncedAt ?? null,
        record.lastSeenAt ?? null,
        record.unavailableAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): ProviderModelRecord | undefined {
    const row = this.database.prepare('SELECT * FROM provider_models WHERE id = ?').get(id) as
      ProviderModelRow | undefined;
    return row ? mapProviderModel(row) : undefined;
  }

  getByRemoteId(providerProfileId: string, remoteModelId: string): ProviderModelRecord | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM provider_models WHERE provider_profile_id = ? AND remote_model_id = ?',
      )
      .get(providerProfileId, remoteModelId) as ProviderModelRow | undefined;
    return row ? mapProviderModel(row) : undefined;
  }

  listByProfile(providerProfileId: string): ProviderModelRecord[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM provider_models WHERE provider_profile_id = ? ORDER BY display_name, id',
        )
        .all(providerProfileId) as ProviderModelRow[]
    ).map(mapProviderModel);
  }
}

interface ProviderModelRow {
  id: string;
  provider_profile_id: string;
  remote_model_id: string;
  display_name: string;
  capabilities_json: string;
  source: ProviderModelRecord['source'];
  enabled: number;
  last_synced_at: string | null;
  last_seen_at: string | null;
  unavailable_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapProviderModel(row: ProviderModelRow): ProviderModelRecord {
  return {
    id: row.id,
    providerProfileId: row.provider_profile_id,
    remoteModelId: row.remote_model_id,
    displayName: row.display_name,
    capabilitiesJson: row.capabilities_json,
    source: row.source,
    enabled: row.enabled === 1,
    lastSyncedAt: row.last_synced_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    unavailableAt: row.unavailable_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class SqliteModelPricingRepository implements ModelPricingRepository {
  constructor(private readonly database: Database.Database) {}

  save(record: ModelPricingRecord): void {
    this.database
      .prepare(
         `INSERT INTO model_pricing
         (provider_profile_id, model_id, currency, unit_tokens, input_price,
           cached_input_price, output_price, credit_price, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_profile_id, model_id) DO UPDATE SET
           currency = excluded.currency,
           unit_tokens = excluded.unit_tokens,
           input_price = excluded.input_price,
            cached_input_price = excluded.cached_input_price,
            output_price = excluded.output_price,
            credit_price = excluded.credit_price,
            updated_at = excluded.updated_at`,
      )
      .run(
        record.providerProfileId,
        record.modelId,
        record.currency,
        record.unitTokens,
        record.inputPrice,
        record.cachedInputPrice ?? null,
        record.outputPrice,
        record.creditPrice ?? null,
        record.updatedAt,
      );
  }

  get(providerProfileId: string, modelId: string): ModelPricingRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM model_pricing WHERE provider_profile_id = ? AND model_id = ?')
      .get(providerProfileId, modelId) as ModelPricingRow | undefined;
    return row ? mapModelPricing(row) : undefined;
  }

  listByProfile(providerProfileId: string): ModelPricingRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM model_pricing WHERE provider_profile_id = ? ORDER BY model_id')
        .all(providerProfileId) as ModelPricingRow[]
    ).map(mapModelPricing);
  }
}

interface ModelPricingRow {
  provider_profile_id: string;
  model_id: string;
  currency: string;
  unit_tokens: number;
  input_price: string;
  cached_input_price: string | null;
  output_price: string;
  credit_price: string | null;
  updated_at: string;
}

function mapModelPricing(row: ModelPricingRow): ModelPricingRecord {
  return {
    providerProfileId: row.provider_profile_id,
    modelId: row.model_id,
    currency: row.currency,
    unitTokens: row.unit_tokens,
    inputPrice: row.input_price,
    cachedInputPrice: row.cached_input_price ?? undefined,
    outputPrice: row.output_price,
    creditPrice: row.credit_price ?? undefined,
    updatedAt: row.updated_at,
  };
}

class SqliteProviderDefaultRepository implements ProviderDefaultRepository {
  constructor(private readonly database: Database.Database) {}

  save(record: ProviderDefaultRecord): void {
    this.database
      .prepare(
        `INSERT INTO provider_defaults (role, provider_profile_id, model_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET
           provider_profile_id = excluded.provider_profile_id,
           model_id = excluded.model_id,
           updated_at = excluded.updated_at`,
      )
      .run(record.role, record.providerProfileId, record.modelId, record.updatedAt);
  }

  get(role: ProviderDefaultRole): ProviderDefaultRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM provider_defaults WHERE role = ?')
      .get(role) as ProviderDefaultRow | undefined;
    return row ? mapProviderDefault(row) : undefined;
  }

  list(): ProviderDefaultRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM provider_defaults ORDER BY role')
        .all() as ProviderDefaultRow[]
    ).map(mapProviderDefault);
  }

  delete(role: ProviderDefaultRole): void {
    this.database.prepare('DELETE FROM provider_defaults WHERE role = ?').run(role);
  }
}

interface ProviderDefaultRow {
  role: ProviderDefaultRole;
  provider_profile_id: string;
  model_id: string;
  updated_at: string;
}

function mapProviderDefault(row: ProviderDefaultRow): ProviderDefaultRecord {
  return {
    role: row.role,
    providerProfileId: row.provider_profile_id,
    modelId: row.model_id,
    updatedAt: row.updated_at,
  };
}

class SqliteUsageIndexRepository implements UsageIndexRepository {
  constructor(private readonly database: Database.Database) {}

  save(record: UsageIndexRecord): void {
    this.database
      .prepare(
        `INSERT INTO usage_index
         (attempt_id, project_id, project_name, provider_profile_id, provider_name,
          model_id, model_name, status, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, total_tokens, estimated_cost, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
           project_id = excluded.project_id,
           project_name = excluded.project_name,
           provider_profile_id = excluded.provider_profile_id,
           provider_name = excluded.provider_name,
           model_id = excluded.model_id,
           model_name = excluded.model_name,
           status = excluded.status,
           input_tokens = excluded.input_tokens,
           cached_input_tokens = excluded.cached_input_tokens,
           output_tokens = excluded.output_tokens,
           reasoning_tokens = excluded.reasoning_tokens,
           total_tokens = excluded.total_tokens,
           estimated_cost = excluded.estimated_cost,
           currency = excluded.currency,
           created_at = excluded.created_at`,
      )
      .run(
        record.attemptId,
        record.projectId,
        record.projectName,
        record.providerProfileId,
        record.providerName,
        record.modelId,
        record.modelName,
        record.status,
        record.inputTokens ?? null,
        record.cachedInputTokens ?? null,
        record.outputTokens ?? null,
        record.reasoningTokens ?? null,
        record.totalTokens ?? null,
        record.estimatedCost ?? null,
        record.currency ?? null,
        record.createdAt,
      );
  }

  get(attemptId: string): UsageIndexRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM usage_index WHERE attempt_id = ?')
      .get(attemptId) as UsageIndexRow | undefined;
    return row ? mapUsageIndex(row) : undefined;
  }

  listByCreatedAt(startAt: string, endAt: string): UsageIndexRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM usage_index
           WHERE created_at >= ? AND created_at < ?
           ORDER BY created_at, attempt_id`,
        )
        .all(startAt, endAt) as UsageIndexRow[]
    ).map(mapUsageIndex);
  }
}

interface UsageIndexRow {
  attempt_id: string;
  project_id: string;
  project_name: string;
  provider_profile_id: string;
  provider_name: string;
  model_id: string;
  model_name: string;
  status: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: string | null;
  currency: string | null;
  created_at: string;
}

function mapUsageIndex(row: UsageIndexRow): UsageIndexRecord {
  return {
    attemptId: row.attempt_id,
    projectId: row.project_id,
    projectName: row.project_name,
    providerProfileId: row.provider_profile_id,
    providerName: row.provider_name,
    modelId: row.model_id,
    modelName: row.model_name,
    status: row.status,
    inputTokens: row.input_tokens ?? undefined,
    cachedInputTokens: row.cached_input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    reasoningTokens: row.reasoning_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    estimatedCost: row.estimated_cost ?? undefined,
    currency: row.currency ?? undefined,
    createdAt: row.created_at,
  };
}

export function createAppRepositories(database: Database.Database): {
  providerProfiles: ProviderProfileRepository;
  providerModels: ProviderModelRepository;
  modelPricing: ModelPricingRepository;
  providerDefaults: ProviderDefaultRepository;
  usageIndex: UsageIndexRepository;
} {
  return {
    providerProfiles: new SqliteProviderProfileRepository(database),
    providerModels: new SqliteProviderModelRepository(database),
    modelPricing: new SqliteModelPricingRepository(database),
    providerDefaults: new SqliteProviderDefaultRepository(database),
    usageIndex: new SqliteUsageIndexRepository(database),
  };
}
