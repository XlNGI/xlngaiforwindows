import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase } from './database.js';
import { applyMigrationV62 } from './migration-v62.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  databases.push(db);
  migrateDatabase(db);
  db.exec(`
    ALTER TABLE production_instruction_versions_archive RENAME TO production_instruction_versions;
    ALTER TABLE production_execution_lists_archive RENAME TO production_execution_lists;
    ALTER TABLE production_change_set_instructions_archive RENAME TO production_change_set_instructions;
    DROP TABLE agent_write_receipts;
    DROP TABLE production_stage_payloads_archive;
    DROP TABLE production_defaults_archive;
    DROP TABLE production_review_forms;
    DELETE FROM schema_migrations WHERE version>=62;
    INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','项目','now','now');
    INSERT INTO scenes(id,project_id,title,position,video_prompt,row_version,created_at,updated_at)
      VALUES('scene','p','场次',2,'  场次原文。  ',7,'before','before');
    INSERT INTO shots(id,scene_id,title,position,prompt,row_version,created_at,updated_at)
      VALUES('shot','scene','镜头',3,'  镜头原文。  ',11,'before','before');
    INSERT INTO production_execution_lists(id,project_id,execution_key,request_hash,request_json,result_json,created_at)
      VALUES('old','p','legacy-executor','hash','{}','{}','before');
  `);
  return db;
}
function legacy(db: Database.Database, id: string, instruction: unknown, revision = 1) {
  db.prepare(
    `INSERT INTO production_instruction_versions(id,project_id,target_kind,target_id,revision,instruction_json,source_hash,execution_list_id,created_at)
    VALUES(?,'p','shot',?,?,?,'source','old','before')`,
  ).run(`${id}-${revision}`, id, revision, JSON.stringify(instruction));
}
function shotIR(db: Database.Database, id = 'shot') {
  return JSON.parse(
    (
      db.prepare('SELECT authoring_ir_json FROM shots WHERE id=?').get(id) as {
        authoring_ir_json: string;
      }
    ).authoring_ir_json,
  ) as Record<string, unknown>;
}

it('preserves prompts and relational state verbatim, moves only valid explicit latest timing, and keeps existing IR authoritative', () => {
  const db = fixture();
  legacy(db, 'shot', {
    timing: { estimatedDurationSeconds: 6.5, rationale: '动作停顿' },
    summary: '不得渲染这个旧摘要',
  });
  const invalidTimings = [
    undefined,
    { estimatedDurationSeconds: 0, rationale: 'x' },
    { estimatedDurationSeconds: 3601, rationale: 'x' },
    { estimatedDurationSeconds: '5', rationale: 'x' },
    { estimatedDurationSeconds: 5, rationale: '' },
    { estimatedDurationSeconds: 5, rationale: 'x'.repeat(2001) },
  ];
  invalidTimings.forEach((timing, i) => {
    const id = `invalid-${i}`;
    db.prepare(
      "INSERT INTO shots(id,scene_id,title,position,prompt,created_at,updated_at) VALUES(?,'scene',?,?,'文中5秒不能推断','before','before')",
    ).run(id, id, i + 4);
    legacy(db, id, {
      timing,
      generation: { duration: 5 },
      data: { timing: { estimatedDurationSeconds: 5 } },
    });
  });
  const existing = { schemaVersion: 1, kind: 'shot', prompt: '已有 IR', data: { keep: true } };
  db.prepare(
    "INSERT INTO shots(id,scene_id,title,position,prompt,authoring_ir_json,created_at,updated_at) VALUES('existing','scene','已有',10,'已有 IR',?,'before','before')",
  ).run(JSON.stringify(existing));
  const before = db
    .prepare(
      'SELECT id,scene_id,title,position,prompt,row_version,created_at,updated_at FROM shots ORDER BY id',
    )
    .all();
  migrateDatabase(db);
  expect(shotIR(db)).toEqual({
    schemaVersion: 1,
    kind: 'shot',
    prompt: '  镜头原文。  ',
    timing: { estimatedDurationSeconds: 6.5, rationale: '动作停顿' },
  });
  invalidTimings.forEach((_, i) => expect(shotIR(db, `invalid-${i}`).timing).toBeUndefined());
  expect(shotIR(db, 'existing')).toEqual(existing);
  expect(
    db
      .prepare(
        'SELECT id,scene_id,title,position,prompt,row_version,created_at,updated_at FROM shots ORDER BY id',
      )
      .all(),
  ).toEqual(before);
  expect(
    JSON.parse(
      (
        db.prepare("SELECT authoring_ir_json FROM scenes WHERE id='scene'").get() as {
          authoring_ir_json: string;
        }
      ).authoring_ir_json,
    ),
  ).toEqual({ schemaVersion: 1, kind: 'scene', prompt: '  场次原文。  ' });
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('production_instruction_versions','production_execution_lists','production_change_set_instructions')",
      )
      .all(),
  ).toEqual([]);
  expect(
    db
      .prepare(
        'SELECT instruction_json FROM production_instruction_versions_archive WHERE target_id=?',
      )
      .get('shot'),
  ).toEqual({
    instruction_json: JSON.stringify({
      timing: { estimatedDurationSeconds: 6.5, rationale: '动作停顿' },
      summary: '不得渲染这个旧摘要',
    }),
  });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('migrates pending prompts, retry receipts, provider defaults and recoverable stage bodies without rendering old instructions', () => {
  const db = fixture();
  db.exec(`INSERT INTO conversations(id,project_id,scope_type,title,created_at,updated_at) VALUES('chat','p','project','会话','before','before');
    INSERT INTO agent_change_sets(id,project_id,title,created_at,updated_at) VALUES('changes','p','待处理','before','before');
    INSERT INTO agent_change_set_items(id,change_set_id,project_id,ordinal,entity_type,action,title,scene_bindings_json,created_at,updated_at)
      VALUES('item-scene','changes','p',0,'scene','create','场次','{"videoPrompt":"  待处理场次原文  "}','before','before');
    INSERT INTO agent_change_set_items(id,change_set_id,project_id,ordinal,entity_type,action,parent_item_id,title,shot_prompt,created_at,updated_at)
      VALUES('item-shot','changes','p',1,'shot','create','item-scene','镜头','待处理镜头原文','before','before');
    INSERT INTO production_change_set_instructions(item_id,project_id,instruction_json) VALUES('item-shot','p','{"summary":"旧指令不得覆盖正文"}');`);
  for (const key of ['shot-prompts:session:task:hash', 'shot-timings:session:task:hash'])
    db.prepare(
      "INSERT INTO production_execution_lists VALUES(?,'p',?,'request-hash',?,?,'before')",
    ).run(key, key, JSON.stringify({ shots: [] }), JSON.stringify({ changedCount: 1 }));
  const stage = [
    {
      count: 2,
      scene: { title: '场次', videoPrompt: 'stage 场次原文', instruction: { summary: '不渲染' } },
      shots: [
        { title: '镜头', prompt: 'stage 镜头原文', instruction: { summary: '不渲染' } },
        { title: '没有最终文本', instruction: { summary: '不能猜提示词' } },
      ],
    },
  ];
  db.prepare(
    "INSERT INTO scene_structure_stages(id,project_id,conversation_id,execution_key,title,expected_scene_count,scenes_json,created_at,updated_at) VALUES('stage','p','chat','key','场次',1,?,'before','before')",
  ).run(JSON.stringify(stage));
  const defaults = {
    style: { medium: '写实' },
    visual: { lighting: '冷光' },
    generation: { ratio: '16:9', watermark: false, duration: 5 },
  };
  db.prepare("INSERT INTO production_defaults VALUES('p',3,?,'before')").run(
    JSON.stringify(defaults),
  );
  migrateDatabase(db);
  const items = db
    .prepare(
      'SELECT production_authoring_ir_json AS ir FROM agent_change_set_items ORDER BY ordinal',
    )
    .all() as Array<{ ir: string }>;
  expect(items.map((row) => JSON.parse(row.ir) as unknown)).toEqual([
    { schemaVersion: 1, kind: 'scene', prompt: '  待处理场次原文  ' },
    { schemaVersion: 1, kind: 'shot', prompt: '待处理镜头原文' },
  ]);
  expect(
    db
      .prepare(
        'SELECT execution_key,request_hash,request_json,result_json FROM agent_write_receipts ORDER BY execution_key',
      )
      .all(),
  ).toEqual(
    db
      .prepare(
        "SELECT execution_key,request_hash,request_json,result_json FROM production_execution_lists_archive WHERE execution_key LIKE 'shot-%' ORDER BY execution_key",
      )
      .all(),
  );
  const migratedStage: unknown = JSON.parse(
    (
      db.prepare("SELECT scenes_json FROM scene_structure_stages WHERE id='stage'").get() as {
        scenes_json: string;
      }
    ).scenes_json,
  );
  expect(migratedStage).toEqual([
    {
      count: 2,
      scene: {
        title: '场次',
        authoringIR: { schemaVersion: 1, kind: 'scene', prompt: 'stage 场次原文' },
      },
      shots: [
        {
          title: '镜头',
          authoringIR: { schemaVersion: 1, kind: 'shot', prompt: 'stage 镜头原文' },
        },
        null,
      ],
    },
  ]);
  expect(
    (
      db
        .prepare("SELECT scenes_json FROM production_stage_payloads_archive WHERE stage_id='stage'")
        .get() as { scenes_json: string }
    ).scenes_json,
  ).toBe(JSON.stringify(stage));
  expect(
    JSON.parse(
      (
        db.prepare("SELECT settings_json FROM production_defaults WHERE project_id='p'").get() as {
          settings_json: string;
        }
      ).settings_json,
    ),
  ).toEqual({ generation: { ratio: '16:9', watermark: false } });
  expect(
    JSON.parse(
      (
        db
          .prepare("SELECT settings_json FROM production_defaults_archive WHERE project_id='p'")
          .get() as { settings_json: string }
      ).settings_json,
    ),
  ).toEqual(defaults);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('rolls back archives, receipts and IR atomically when migration fails and can retry safely', () => {
  const db = fixture();
  db.exec(
    "CREATE TRIGGER fail_v62 BEFORE INSERT ON schema_migrations WHEN NEW.version=62 BEGIN SELECT RAISE(ABORT,'v62 failure'); END;",
  );
  expect(() => migrateDatabase(db)).toThrow('v62 failure');
  expect(getSchemaVersion(db)).toBe(61);
  expect(db.prepare("SELECT authoring_ir_json FROM shots WHERE id='shot'").get()).toEqual({
    authoring_ir_json: null,
  });
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='agent_write_receipts' OR name LIKE '%_archive'",
      )
      .all(),
  ).toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM production_execution_lists').get()).toEqual({
    n: 1,
  });
  db.exec('DROP TRIGGER fail_v62');
  expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
  expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
});

it('does not replace existing IR, prompt projections or receipt results on repeated execution', () => {
  const db = fixture();
  migrateDatabase(db);
  const next = JSON.stringify({
    schemaVersion: 1,
    kind: 'shot',
    prompt: '升级后改写',
    data: { keep: 1 },
  });
  db.prepare("UPDATE shots SET prompt='升级后改写',authoring_ir_json=? WHERE id='shot'").run(next);
  const before = db.prepare('SELECT * FROM shots ORDER BY id').all();
  expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
  db.transaction(() => applyMigrationV62(db))();
  expect(db.prepare('SELECT * FROM shots ORDER BY id').all()).toEqual(before);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
