import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { migrateDatabase, getSchemaVersion } from './database.js';
import { MIGRATION_V1 } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  db.function('sha256', (v) => createHash('sha256').update(String(v)).digest('hex'));
  db.exec(MIGRATION_V1);
  db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run('before');
  db.exec(
    "CREATE TRIGGER stop_v77 BEFORE INSERT ON schema_migrations WHEN NEW.version=77 BEGIN SELECT RAISE(ABORT,'stop v77'); END",
  );
  expect(() => migrateDatabase(db)).toThrow('stop v77');
  expect(getSchemaVersion(db)).toBe(76);
  db.exec('DROP TRIGGER stop_v77');
  db.exec(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','项目','before','before')",
  );
  const insert = db.prepare(
    "INSERT INTO documents(id,project_id,kind,title,scope_type,row_version,created_at,updated_at) VALUES(?,'p',?,?,'project',7,'before','before')",
  );
  for (const [id, kind] of [
    ['character', 'character'],
    ['voice', 'voice'],
    ['setting', 'scene'],
    ['prop', 'prop'],
  ])
    insert.run(id, kind, id);
  db.prepare(
    "INSERT INTO document_versions(id,document_id,version,content_markdown,state,created_at,content_ir_json) VALUES('version','voice',1,?,'draft','before',?)",
  ).run(
    '  音色原文\n自由格式。  ',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'voice',
      data: { ignored: '旧结构' },
      sampleText: '  试音原句。  ',
    }),
  );
  db.exec("UPDATE documents SET current_version_id='version' WHERE id='voice'");
  db.prepare(
    "INSERT INTO scenes(id,project_id,title,position,video_prompt,authoring_ir_json,row_version,created_at,updated_at) VALUES('scene','p','场次',0,?,?,4,'before','before')",
  ).run(
    ' 原场次文本。 ',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'scene',
      prompt: ' 原场次文本。 ',
      references: { sceneDocumentIds: ['setting'] },
      timing: { estimatedDurationSeconds: 7, locked: true, rationale: '旧依据', beats: [] },
    }),
  );
  db.prepare(
    "INSERT INTO shots(id,scene_id,title,position,prompt,authoring_ir_json,row_version,created_at,updated_at) VALUES('shot','scene','镜头',0,?,?,9,'before','before')",
  ).run(
    '  原镜头对白。\n完整文本。  ',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'shot',
      prompt: '  原镜头对白。\n完整文本。  ',
      references: {
        characterDocumentIds: ['character'],
        sceneDocumentIds: ['setting'],
        propDocumentIds: ['prop'],
      },
      speech: [
        { characterDocumentId: 'character', voiceDocumentId: 'voice', text: '对白留在正文' },
      ],
      timing: { estimatedDurationSeconds: 7, rationale: '旧依据' },
    }),
  );
  return db;
}
it('preserves text bytes, explicit bindings, audition text, duration and row versions while dropping all former IR columns', () => {
  const db = fixture();
  expect(migrateDatabase(db)).toBe(77);
  const shot = db
    .prepare('SELECT prompt,bindings_json,timing_json,row_version FROM shots')
    .get() as { prompt: string; bindings_json: string; timing_json: string; row_version: number };
  expect(shot.prompt).toBe('  原镜头对白。\n完整文本。  ');
  expect(shot.row_version).toBe(9);
  expect(JSON.parse(shot.bindings_json)).toEqual({
    schemaVersion: 1,
    characterDocumentIds: ['character'],
    sceneDocumentIds: ['setting'],
    propDocumentIds: ['prop'],
    voiceBindings: [{ characterDocumentId: 'character', voiceDocumentId: 'voice' }],
  });
  expect(JSON.parse(shot.timing_json)).toEqual({ estimatedDurationSeconds: 7 });
  expect(
    db.prepare('SELECT content_markdown,sample_text,state FROM document_versions').get(),
  ).toEqual({
    content_markdown: '  音色原文\n自由格式。  ',
    sample_text: '  试音原句。  ',
    state: 'draft',
  });
  expect(
    JSON.parse(
      (db.prepare('SELECT timing_json FROM scenes').get() as { timing_json: string }).timing_json,
    ),
  ).toEqual({ estimatedDurationSeconds: 7, locked: true });
  for (const table of ['document_versions', 'scenes', 'shots', 'agent_change_set_items']) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const column of ['content_ir_json', 'authoring_ir_json', 'production_authoring_ir_json'])
      expect(columns).not.toContain(column);
  }
  const before = shot;
  expect(migrateDatabase(db)).toBe(77);
  expect(
    db.prepare('SELECT prompt,bindings_json,timing_json,row_version FROM shots').get(),
  ).toEqual(before);
});
it('rolls back the whole conversion when the migration fails and retries with the original data', () => {
  const db = fixture();
  db.exec(
    "CREATE TRIGGER fail_v77 BEFORE INSERT ON schema_migrations WHEN NEW.version=77 BEGIN SELECT RAISE(ABORT,'v77 failure'); END",
  );
  expect(() => migrateDatabase(db)).toThrow('v77 failure');
  expect(getSchemaVersion(db)).toBe(76);
  expect(
    (db.prepare('SELECT authoring_ir_json FROM shots').get() as { authoring_ir_json: string })
      .authoring_ir_json,
  ).toContain('对白留在正文');
  expect(
    (db.prepare('PRAGMA table_info(shots)').all() as { name: string }[]).some(
      (c) => c.name === 'bindings_json',
    ),
  ).toBe(false);
  db.exec('DROP TRIGGER fail_v77');
  expect(migrateDatabase(db)).toBe(77);
});
it('retires pre-rebuild candidates without changing their original result IDs, bytes or hashes', () => {
  const db = fixture();
  const content = '{"revision":4,"entries":[{"authoringIR":{"prompt":"旧候选原文"}}]}';
  const hash = createHash('sha256').update(content).digest('hex');
  db.prepare(
    "INSERT INTO agent_context_results(id,project_id,task_id,call_id,tool_name,status,version,content,content_hash,arguments_json,created_at) VALUES('original-result','p','task','production-bundle:state','production.bundle.state','succeeded',1,?,?,'{}','before')",
  ).run(content, hash);
  migrateDatabase(db);
  expect(
    db.prepare('SELECT id,tool_name,content,content_hash FROM agent_context_results').get(),
  ).toEqual({
    id: 'original-result',
    tool_name: 'production.bundle.retired',
    content,
    content_hash: hash,
  });
});
it('converts pending proposals and staged structures once, retaining text and explicit relationships', () => {
  const db = fixture();
  db.exec(
    "INSERT INTO agent_change_sets(id,project_id,title,status,created_at,updated_at) VALUES('pending','p','待审核','proposed','before','before')",
  );
  db.prepare(
    "INSERT INTO agent_change_set_items(id,change_set_id,project_id,ordinal,entity_type,action,title,status,scene_document_id,scene_bindings_json,created_at,updated_at) VALUES('pending-scene','pending','p',0,'scene','create','场次','pending','setting',?,'before','before')",
  ).run(JSON.stringify({ prompt: '  待审核完整文本。  ', characterDocumentIds: ['character'] }));
  db.exec(
    "INSERT INTO conversations(id,project_id,scope_type,title,created_at,updated_at) VALUES('chat','p','project','会话','before','before')",
  );
  const parts = [
    {
      count: 1,
      scene: {
        title: '场次',
        sceneDocumentId: 'setting',
        characterDocumentIds: ['character'],
        authoringIR: { schemaVersion: 1, kind: 'scene', prompt: ' 暂存场次。 ' },
      },
      shots: [
        {
          title: '镜头',
          authoringIR: {
            schemaVersion: 1,
            kind: 'shot',
            prompt: ' 暂存镜头。 ',
            references: {
              characterDocumentIds: ['character'],
              sceneDocumentIds: ['setting'],
              propDocumentIds: ['prop'],
            },
            timing: { estimatedDurationSeconds: 6 },
          },
        },
      ],
    },
  ];
  db.prepare(
    "INSERT INTO scene_structure_stages(id,project_id,conversation_id,execution_key,title,expected_scene_count,scenes_json,created_at,updated_at) VALUES('stage','p','chat','stage-key','暂存',1,?,'before','before')",
  ).run(JSON.stringify(parts));
  migrateDatabase(db);
  const item = db
    .prepare(
      "SELECT shot_prompt,prompt_bindings_json,status FROM agent_change_set_items WHERE id='pending-scene'",
    )
    .get() as { shot_prompt: string; prompt_bindings_json: string; status: string };
  expect(item.shot_prompt).toBe('  待审核完整文本。  ');
  expect(item.status).toBe('pending');
  expect(JSON.parse(item.prompt_bindings_json)).toEqual({
    schemaVersion: 1,
    sceneDocumentIds: ['setting'],
    characterDocumentIds: ['character'],
  });
  const staged = JSON.parse(
    (
      db.prepare("SELECT scenes_json FROM scene_structure_stages WHERE id='stage'").get() as {
        scenes_json: string;
      }
    ).scenes_json,
  ) as unknown;
  expect(staged).toEqual([
    {
      count: 1,
      scene: {
        title: '场次',
        prompt: ' 暂存场次。 ',
        bindings: {
          schemaVersion: 1,
          sceneDocumentIds: ['setting'],
          characterDocumentIds: ['character'],
        },
      },
      shots: [
        {
          title: '镜头',
          prompt: ' 暂存镜头。 ',
          bindings: {
            schemaVersion: 1,
            characterDocumentIds: ['character'],
            sceneDocumentIds: ['setting'],
            propDocumentIds: ['prop'],
          },
          timing: { estimatedDurationSeconds: 6 },
        },
      ],
    },
  ]);
  expect(
    (db.prepare('PRAGMA table_info(agent_change_set_items)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  ).not.toContain('scene_bindings_json');
  db.prepare(
    "INSERT INTO agent_change_set_items(id,change_set_id,project_id,ordinal,entity_type,action,title,shot_prompt,created_at,updated_at) VALUES('new-scene','pending','p',1,'scene','create','场次','自由文本','after','after')",
  ).run();
});
