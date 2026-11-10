import { applyMigrationV76 } from './migration-v76.js';
import type Database from 'better-sqlite3';

type ObjectValue = Record<string, unknown>;
const parsed = (value: unknown): ObjectValue => {
  if (typeof value === 'string') {
    try {
      return parsed(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
};
const bindings = (value: ObjectValue): ObjectValue | undefined => {
  const refs = parsed(value.references);
  const result: ObjectValue = { schemaVersion: 1 };
  for (const key of ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'])
    if (Array.isArray(refs[key])) result[key] = refs[key];
  if (typeof value.voiceDocumentId === 'string') result.voiceDocumentId = value.voiceDocumentId;
  if (Array.isArray(value.speech)) {
    const pairs = value.speech
      .map(parsed)
      .filter((cue) => typeof cue.voiceDocumentId === 'string')
      .map((cue) => ({
        ...(typeof cue.characterDocumentId === 'string'
          ? { characterDocumentId: cue.characterDocumentId }
          : {}),
        voiceDocumentId: cue.voiceDocumentId,
      }));
    if (pairs.length)
      result.voiceBindings = [
        ...new Map(pairs.map((pair) => [JSON.stringify(pair), pair])).values(),
      ];
  }
  return Object.keys(result).length > 1 ? result : undefined;
};
const timing = (value: ObjectValue) => {
  const old = parsed(value.timing),
    seconds = old.estimatedDurationSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 3600
    ? { estimatedDurationSeconds: seconds, ...(old.locked === true ? { locked: true } : {}) }
    : undefined;
};
const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

/** Convert pending objects once. Runtime readers accept only the new contract. */
function pending(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pending);
  if (!value || typeof value !== 'object') return value;
  const result = { ...(value as ObjectValue) };
  for (const [key, child] of Object.entries(result)) result[key] = pending(child);
  const old = parsed(result.authoringIR);
  if (result.authoringIR) {
    result.prompt ??= old.prompt;
    result.bindings = bindings(old);
    result.timing = timing(old);
    delete result.authoringIR;
  }
  const content = parsed(result.contentIR);
  if (result.contentIR) {
    result.bindings = bindings(content);
    if (typeof content.sampleText === 'string') result.sampleText = content.sampleText;
    delete result.contentIR;
  }
  if (result.videoPrompt !== undefined) {
    result.prompt ??= result.videoPrompt;
    delete result.videoPrompt;
  }
  if (
    typeof result.title === 'string' &&
    (result.sceneDocumentId !== undefined || result.characterDocumentIds !== undefined)
  ) {
    result.bindings = {
      schemaVersion: 1,
      ...(result.sceneDocumentId !== undefined
        ? { sceneDocumentIds: result.sceneDocumentId ? [result.sceneDocumentId] : [] }
        : {}),
      ...(Array.isArray(result.characterDocumentIds)
        ? { characterDocumentIds: result.characterDocumentIds }
        : {}),
      ...parsed(result.bindings),
    };
    delete result.sceneDocumentId;
    delete result.characterDocumentIds;
  }
  return result;
}

/** Retire content/authoring IR storage; all writes run inside the migration transaction. */
export function applyMigrationV77(db: Database.Database): void {
  const hasColumn = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (c) => c.name === column,
    );
  const retiringContract = !hasColumn('shots', 'bindings_json');
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  for (const [table, additions] of [
    [
      'document_versions',
      [
        'bindings_json TEXT CHECK(bindings_json IS NULL OR json_valid(bindings_json))',
        'sample_text TEXT',
      ],
    ],
    [
      'scenes',
      [
        'bindings_json TEXT CHECK(bindings_json IS NULL OR json_valid(bindings_json))',
        'timing_json TEXT CHECK(timing_json IS NULL OR json_valid(timing_json))',
      ],
    ],
    [
      'shots',
      [
        'bindings_json TEXT CHECK(bindings_json IS NULL OR json_valid(bindings_json))',
        'timing_json TEXT CHECK(timing_json IS NULL OR json_valid(timing_json))',
      ],
    ],
    [
      'agent_change_set_items',
      [
        'prompt_bindings_json TEXT CHECK(prompt_bindings_json IS NULL OR json_valid(prompt_bindings_json))',
        'timing_json TEXT CHECK(timing_json IS NULL OR json_valid(timing_json))',
        'sample_text TEXT',
      ],
    ],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const column of additions)
      if (!columns.some((c) => c.name === column.split(' ')[0]))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
  const versions = (
    hasColumn('document_versions', 'content_ir_json')
      ? db.prepare('SELECT id,content_ir_json FROM document_versions').all()
      : []
  ) as Array<{ id: string; content_ir_json: string | null }>;
  const saveVersion = db.prepare(
    'UPDATE document_versions SET bindings_json=COALESCE(bindings_json,?),sample_text=COALESCE(sample_text,?) WHERE id=?',
  );
  for (const row of versions) {
    const old = parsed(row.content_ir_json);
    saveVersion.run(
      json(bindings(old)),
      typeof old.sampleText === 'string' ? old.sampleText : null,
      row.id,
    );
  }
  for (const table of ['scenes', 'shots']) {
    const rows = (
      hasColumn(table, 'authoring_ir_json')
        ? db.prepare(`SELECT id,authoring_ir_json FROM ${table}`).all()
        : []
    ) as Array<{ id: string; authoring_ir_json: string | null }>;
    const save = db.prepare(
      `UPDATE ${table} SET bindings_json=COALESCE(bindings_json,?),timing_json=COALESCE(timing_json,?) WHERE id=?`,
    );
    for (const row of rows) {
      const old = parsed(row.authoring_ir_json);
      let relations = bindings(old);
      if (table === 'scenes') {
        const scene = db.prepare('SELECT scene_document_id FROM scenes WHERE id=?').get(row.id) as {
          scene_document_id: string | null;
        };
        const cast = db
          .prepare(
            'SELECT character_document_id FROM scene_character_bindings WHERE scene_id=? ORDER BY position',
          )
          .all(row.id) as Array<{ character_document_id: string }>;
        if (scene.scene_document_id || cast.length)
          relations = {
            schemaVersion: 1,
            ...(scene.scene_document_id ? { sceneDocumentIds: [scene.scene_document_id] } : {}),
            ...(cast.length
              ? { characterDocumentIds: cast.map((c) => c.character_document_id) }
              : {}),
            ...relations,
          };
      }
      save.run(json(relations), json(timing(old)), row.id);
    }
  }
  const items = (
    hasColumn('agent_change_set_items', 'production_authoring_ir_json')
      ? db
          .prepare(
            `SELECT id,title,entity_type,production_authoring_ir_json,${hasColumn('agent_change_set_items', 'scene_bindings_json') ? 'scene_bindings_json' : 'NULL AS scene_bindings_json'},${hasColumn('agent_change_set_items', 'scene_document_id') ? 'scene_document_id' : 'NULL AS scene_document_id'} FROM agent_change_set_items`,
          )
          .all()
      : []
  ) as Array<{
    id: string;
    title: string;
    entity_type: string;
    production_authoring_ir_json: string | null;
    scene_bindings_json: string | null;
    scene_document_id: string | null;
  }>;
  for (const item of items) {
    const old = parsed(item.production_authoring_ir_json);
    const staged = pending({
      title: item.title,
      ...parsed(item.scene_bindings_json),
      ...(item.scene_document_id ? { sceneDocumentId: item.scene_document_id } : {}),
    }) as ObjectValue;
    const relations = { ...parsed(staged.bindings), ...bindings(old) };
    const prompt = typeof old.prompt === 'string' ? old.prompt : staged.prompt;
    db.prepare(
      'UPDATE agent_change_set_items SET prompt_bindings_json=COALESCE(prompt_bindings_json,?),timing_json=COALESCE(timing_json,?),shot_prompt=COALESCE(shot_prompt,?) WHERE id=?',
    ).run(
      Object.keys(relations).length ? json(relations) : null,
      json(timing(old)),
      item.entity_type !== 'document' && typeof prompt === 'string' ? prompt : null,
      item.id,
    );
  }
  for (const stage of db
    .prepare('SELECT id,scenes_json FROM scene_structure_stages')
    .all() as Array<{ id: string; scenes_json: string }>)
    db.prepare('UPDATE scene_structure_stages SET scenes_json=? WHERE id=?').run(
      JSON.stringify(pending(JSON.parse(stage.scenes_json))),
      stage.id,
    );
  // Old candidate hashes and review receipts describe the retired contract. Keep
  // the original Result Store bytes recoverable, but never resume them as current
  // reviewed candidates or silently commit a different interpretation.
  if (retiringContract)
    db.prepare(
      "UPDATE agent_context_results SET tool_name='production.bundle.retired' WHERE tool_name='production.bundle.state'",
    ).run();
  for (const [table, column] of [
    ['document_versions', 'content_ir_json'],
    ['scenes', 'authoring_ir_json'],
    ['shots', 'authoring_ir_json'],
    ['agent_change_set_items', 'production_authoring_ir_json'],
    ['agent_change_set_items', 'scene_bindings_json'],
    ['agent_change_set_items', 'scene_document_id'],
    ['scenes', 'authoring_bindings_applied'],
  ])
    if (hasColumn(table!, column!)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  for (const trigger of triggers) {
    if (trigger.name.startsWith('agent_changes_')) continue;
    let sql = trigger.sql
      .replaceAll('content_ir_json', 'bindings_json')
      .replaceAll('authoring_ir_json', 'bindings_json');
    if (trigger.name === 'agent_change_set_item_shot_prompt_match')
      sql = sql
        .replace("NEW.entity_type != 'shot'", "NEW.entity_type = 'document'")
        .replace(
          'shot prompt is only allowed on shot items',
          'Document proposals use content_markdown for text',
        );
    if (trigger.name === 'document_versions_published_read_only_insert')
      sql = sql.replace(
        'AND NEW.bindings_json IS (',
        'AND NEW.sample_text IS (SELECT published.sample_text FROM documents JOIN document_versions published ON published.id=documents.published_version_id WHERE documents.id=NEW.document_id) AND NEW.bindings_json IS (',
      );
    db.exec(sql);
  }
  applyMigrationV76(db);
}
