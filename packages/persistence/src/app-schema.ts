export const CURRENT_APP_SCHEMA_VERSION = 4;

export const APP_MIGRATION_V1 = `
CREATE TABLE app_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category TEXT NOT NULL CHECK (category IN ('llm', 'image', 'video', 'multi')),
  provider_type TEXT NOT NULL CHECK (length(trim(provider_type)) > 0),
  access_type TEXT NOT NULL CHECK (access_type IN ('official', 'custom')),
  protocol TEXT NOT NULL CHECK (length(trim(protocol)) > 0),
  base_url TEXT NOT NULL CHECK (length(trim(base_url)) > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  connection_status TEXT NOT NULL CHECK (
    connection_status IN (
      'draft', 'testing', 'ready', 'auth-failed', 'network-failed',
      'protocol-failed', 'sync-failed', 'disabled'
    )
  ),
  last_checked_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE provider_models (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  remote_model_id TEXT NOT NULL CHECK (length(trim(remote_model_id)) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  source TEXT NOT NULL CHECK (source IN ('remote', 'built-in', 'manual')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  last_synced_at TEXT,
  last_seen_at TEXT,
  unavailable_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_profile_id, remote_model_id)
);

CREATE TABLE model_pricing (
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (length(trim(currency)) > 0),
  unit_tokens INTEGER NOT NULL CHECK (unit_tokens > 0),
  input_price TEXT NOT NULL CHECK (length(trim(input_price)) > 0),
  cached_input_price TEXT CHECK (cached_input_price IS NULL OR length(trim(cached_input_price)) > 0),
  output_price TEXT NOT NULL CHECK (length(trim(output_price)) > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider_profile_id, model_id)
);

CREATE TABLE provider_defaults (
  role TEXT PRIMARY KEY CHECK (role IN ('quality', 'balanced', 'fast', 'vision', 'embedding')),
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_index (
  attempt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_cost TEXT,
  currency TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_provider_profiles_active ON provider_profiles(archived_at, enabled, name);
CREATE INDEX idx_provider_models_profile ON provider_models(provider_profile_id, enabled, display_name);
CREATE INDEX idx_usage_index_created ON usage_index(created_at, provider_profile_id, model_id);
CREATE INDEX idx_usage_index_project ON usage_index(project_id, created_at);
`;

export const APP_MIGRATION_V2 = `
ALTER TABLE provider_profiles ADD COLUMN migration_source TEXT
  CHECK (migration_source IS NULL OR migration_source IN ('vidu', 'vidu-cn'));

CREATE UNIQUE INDEX idx_provider_profiles_migration_source
  ON provider_profiles(migration_source)
  WHERE migration_source IS NOT NULL;
`;

export const APP_MIGRATION_V3 = `
ALTER TABLE model_pricing ADD COLUMN credit_price TEXT
  CHECK (credit_price IS NULL OR length(trim(credit_price)) > 0);
`;

export const APP_MIGRATION_V4 = `
CREATE TABLE adapter_schemas (
  adapter_key TEXT PRIMARY KEY CHECK (length(trim(adapter_key)) > 0),
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  source TEXT NOT NULL CHECK (source IN ('official-adapter', 'manual', 'synced-catalog', 'missing')),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'needs_confirmation', 'missing')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE adapter_schema_audits (
  id TEXT PRIMARY KEY,
  adapter_key TEXT NOT NULL REFERENCES adapter_schemas(adapter_key) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  action TEXT NOT NULL CHECK (action IN ('proposed', 'confirmed', 'rolled_back')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  conversation_id TEXT,
  reason TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_adapter_schema_audits_key ON adapter_schema_audits(adapter_key, version DESC, created_at DESC);
`;
