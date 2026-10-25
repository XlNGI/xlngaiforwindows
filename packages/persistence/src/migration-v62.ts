import type Database from 'better-sqlite3';

type Timing = { estimatedDurationSeconds: number; rationale: string };

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

function readExplicitTiming(value: unknown): Timing | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const timing = (value as Record<string, unknown>).timing;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return undefined;
  const candidate = timing as Record<string, unknown>;
  if (
    typeof candidate.estimatedDurationSeconds !== 'number' ||
    !Number.isFinite(candidate.estimatedDurationSeconds) ||
    candidate.estimatedDurationSeconds <= 0 ||
    candidate.estimatedDurationSeconds > 3600 ||
    typeof candidate.rationale !== 'string' ||
    !candidate.rationale.trim() ||
    candidate.rationale.length > 2000
  )
    return undefined;
  return {
    estimatedDurationSeconds: candidate.estimatedDurationSeconds,
    rationale: candidate.rationale,
  };
}

function minimalIR(kind: 'scene' | 'shot', prompt: string, timing?: Timing): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind,
    prompt,
    ...(timing ? { timing } : {}),
  });
}

function backfillProductionIR(database: Database.Database): void {
  const sceneRows = database
    .prepare(
      'SELECT id,video_prompt FROM scenes WHERE authoring_ir_json IS NULL AND video_prompt IS NOT NULL AND length(trim(video_prompt))>0',
    )
    .all() as Array<{ id: string; video_prompt: string }>;
  const saveScene = database.prepare(
    'UPDATE scenes SET authoring_ir_json=? WHERE id=? AND authoring_ir_json IS NULL',
  );
  for (const row of sceneRows) saveScene.run(minimalIR('scene', row.video_prompt), row.id);

  const shotRows = database
    .prepare(
      `SELECT shots.id,shots.prompt,scenes.project_id
       FROM shots JOIN scenes ON scenes.id=shots.scene_id
       WHERE shots.authoring_ir_json IS NULL AND shots.prompt IS NOT NULL AND length(trim(shots.prompt))>0`,
    )
    .all() as Array<{ id: string; prompt: string; project_id: string }>;
  const latestTiming = tableExists(database, 'production_instruction_versions_archive')
    ? database.prepare(
        "SELECT instruction_json FROM production_instruction_versions_archive WHERE project_id=? AND target_kind='shot' AND target_id=? ORDER BY revision DESC LIMIT 1",
      )
    : undefined;
  const saveShot = database.prepare(
    'UPDATE shots SET authoring_ir_json=? WHERE id=? AND authoring_ir_json IS NULL',
  );
  for (const row of shotRows) {
    let timing: Timing | undefined;
    if (latestTiming) {
      const legacy = latestTiming.get(row.project_id, row.id) as
        { instruction_json: string } | undefined;
      if (legacy) {
        try {
          timing = readExplicitTiming(JSON.parse(legacy.instruction_json));
        } catch {
          timing = undefined;
        }
      }
    }
    saveShot.run(minimalIR('shot', row.prompt, timing), row.id);
  }

  const itemRows = database
    .prepare(
      `SELECT id,entity_type,shot_prompt,scene_bindings_json
       FROM agent_change_set_items
       WHERE production_authoring_ir_json IS NULL AND status='pending'`,
    )
    .all() as Array<{
    id: string;
    entity_type: string;
    shot_prompt: string | null;
    scene_bindings_json: string | null;
  }>;
  const saveItem = database.prepare(
    'UPDATE agent_change_set_items SET production_authoring_ir_json=? WHERE id=? AND production_authoring_ir_json IS NULL',
  );
  for (const row of itemRows) {
    let prompt: string | undefined;
    if (row.entity_type === 'shot') prompt = row.shot_prompt ?? undefined;
    if (row.entity_type === 'scene' && row.scene_bindings_json) {
      try {
        const bindings = JSON.parse(row.scene_bindings_json) as Record<string, unknown>;
        if (typeof bindings.videoPrompt === 'string') prompt = bindings.videoPrompt;
      } catch {
        prompt = undefined;
      }
    }
    if (prompt?.trim())
      saveItem.run(minimalIR(row.entity_type as 'scene' | 'shot', prompt), row.id);
  }
}

function retireStagedInstructions(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS production_stage_payloads_archive (
    stage_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    scenes_json TEXT NOT NULL CHECK(json_valid(scenes_json))
  );`);
  const rows = database
    .prepare('SELECT id,project_id,scenes_json FROM scene_structure_stages')
    .all() as Array<{
    id: string;
    project_id: string;
    scenes_json: string;
  }>;
  for (const row of rows) {
    const parts = JSON.parse(row.scenes_json) as Array<{
      scene?: Record<string, unknown>;
      shots: Array<Record<string, unknown> | null>;
      saved?: unknown;
    }>;
    let changed = false;
    const convert = (value: Record<string, unknown> | null | undefined, kind: 'scene' | 'shot') => {
      if (
        !value ||
        (!Object.hasOwn(value, 'instruction') &&
          !Object.hasOwn(value, 'prompt') &&
          !Object.hasOwn(value, 'videoPrompt'))
      )
        return value;
      changed = true;
      const next = { ...value };
      delete next.instruction;
      if (!next.authoringIR) {
        const prompt = kind === 'scene' ? next.videoPrompt : next.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) return undefined;
        next.authoringIR = JSON.parse(minimalIR(kind, prompt)) as unknown;
      }
      // Projections are regenerated when the IR is saved, never submitted as a second body.
      delete next.videoPrompt;
      delete next.prompt;
      return next;
    };
    for (const part of parts) {
      const scene = convert(part.scene, 'scene');
      if (scene) part.scene = scene;
      else delete part.scene;
      part.shots = part.shots.map((shot) => convert(shot, 'shot') ?? null);
    }
    if (!changed) continue;
    database
      .prepare(
        'INSERT OR IGNORE INTO production_stage_payloads_archive(stage_id,project_id,scenes_json) VALUES(?,?,?)',
      )
      .run(row.id, row.project_id, row.scenes_json);
    database
      .prepare('UPDATE scene_structure_stages SET scenes_json=? WHERE id=?')
      .run(JSON.stringify(parts), row.id);
  }
}

function migrateProviderDefaults(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS production_defaults_archive (
    project_id TEXT PRIMARY KEY REFERENCES projects(id), row_version INTEGER NOT NULL,
    settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), updated_at TEXT NOT NULL
  );`);
  const rows = database.prepare('SELECT * FROM production_defaults').all() as Array<{
    project_id: string;
    row_version: number;
    settings_json: string;
    updated_at: string;
  }>;
  for (const row of rows) {
    const previous = JSON.parse(row.settings_json) as { generation?: Record<string, unknown> };
    const generation: Record<string, unknown> = {};
    for (const field of ['ratio', 'resolution', 'promptExtend', 'watermark']) {
      const value = previous.generation?.[field];
      if (
        ['ratio', 'resolution'].includes(field)
          ? typeof value === 'string' && value.length > 0 && value.length <= 40
          : typeof value === 'boolean'
      )
        generation[field] = value;
    }
    const next = JSON.stringify(Object.keys(generation).length ? { generation } : {});
    if (next === row.settings_json) continue;
    database
      .prepare(
        'INSERT OR IGNORE INTO production_defaults_archive(project_id,row_version,settings_json,updated_at) VALUES(?,?,?,?)',
      )
      .run(row.project_id, row.row_version, row.settings_json, row.updated_at);
    database
      .prepare('UPDATE production_defaults SET settings_json=? WHERE project_id=?')
      .run(next, row.project_id);
  }
}

/** Archive the former executor and move its remaining idempotency receipts to their own table. */
export function applyMigrationV62(database: Database.Database): void {
  const renames = [
    ['production_instruction_versions', 'production_instruction_versions_archive'],
    ['production_execution_lists', 'production_execution_lists_archive'],
    ['production_change_set_instructions', 'production_change_set_instructions_archive'],
  ] as const;
  for (const [source, archive] of renames)
    if (tableExists(database, source) && !tableExists(database, archive))
      database.exec(`ALTER TABLE ${source} RENAME TO ${archive}`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_write_receipts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      execution_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      created_at TEXT NOT NULL,
      UNIQUE(project_id, execution_key)
    );
  `);
  if (tableExists(database, 'production_execution_lists_archive'))
    database.exec(`
      INSERT OR IGNORE INTO agent_write_receipts
        (id,project_id,execution_key,request_hash,request_json,result_json,created_at)
      SELECT id,project_id,execution_key,request_hash,request_json,result_json,created_at
      FROM production_execution_lists_archive
      WHERE execution_key LIKE 'shot-prompts:%' OR execution_key LIKE 'shot-timings:%';
    `);

  backfillProductionIR(database);
  retireStagedInstructions(database);
  migrateProviderDefaults(database);
}
