import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  assessTaskDeliverables,
  saveTaskPlan,
  STRUCTURE_DELIVERABLE_TOOLS,
  assertTaskPartialAllowed,
} from './agent-task-deliverables.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { validateToolArguments } from '@earendil-works/pi-ai';
const databases: Database.Database[] = [];
function shotFields(value: unknown): [string | null, string | null, string | null] {
  if (!value || typeof value !== 'object') return [null, null, null];
  const record = value as Record<string, unknown>;
  return [
    typeof record.prompt === 'string' ? record.prompt : null,
    record.timing ? JSON.stringify(record.timing) : null,
    record.bindings ? JSON.stringify(record.bindings) : null,
  ];
}
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE agent_tool_calls (project_id TEXT,generation_id TEXT,tool_name TEXT,status TEXT,result_summary_json TEXT);
    CREATE TABLE agent_execution_outputs(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,plan_key TEXT,tool_name TEXT,quantity INTEGER,created_at TEXT,UNIQUE(project_id,task_id,plan_key));
    CREATE TABLE agent_execution_commits(project_id TEXT,task_id TEXT,operation_key TEXT,receipt_id TEXT,sequence INTEGER);
    CREATE TABLE agent_write_receipts(id TEXT,result_json TEXT);
    CREATE TABLE documents (id TEXT,project_id TEXT,kind TEXT,current_version_id TEXT,lifecycle_status TEXT);
    CREATE TABLE document_versions (id TEXT,document_id TEXT,content_markdown TEXT DEFAULT '');
    CREATE TABLE scenes (id TEXT,project_id TEXT,archived_at TEXT);
    CREATE TABLE shots (id TEXT,scene_id TEXT,prompt TEXT,timing_json TEXT,bindings_json TEXT,archived_at TEXT);`);
  const receipt = (tool: string, result: unknown, status = 'succeeded', generation = 'g') =>
    db
      .prepare('INSERT INTO agent_tool_calls VALUES (?,?,?,?,?)')
      .run('p', generation, tool, status, JSON.stringify(result));
  const plan = (deliverables: unknown[]) => {
    const saved = saveTaskPlan(db, 'p', 'g', deliverables);
    receipt('conversation.task.checkpoint', saved);
    return saved;
  };
  const document = (id: string, kind: string, generation = 'g') => {
    db.prepare("INSERT INTO documents VALUES (?,?,?,?,'active')").run(id, 'p', kind, `v-${id}`);
    db.prepare('INSERT INTO document_versions (id,document_id) VALUES (?,?)').run(`v-${id}`, id);
    receipt(
      'document.submit_draft',
      { status: 'draft_saved', documentId: id, documentVersionId: `v-${id}` },
      'succeeded',
      generation,
    );
  };
  return { db, receipt, plan, document, assess: () => assessTaskDeliverables(db, 'p', 'g') };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it('rejects summaries, reordered or stale whole-scene projections while preserving actual prompt text', () => {
  const f = fixture();
  f.db.exec(
    'ALTER TABLE scenes ADD COLUMN video_prompt TEXT; ALTER TABLE shots ADD COLUMN position INTEGER',
  );
  const first = '0–2秒：甲说“留下”。2–4秒：甲收好信件。';
  const second = '0–3秒：乙回头，说“我等你”。';
  f.db.prepare('INSERT INTO scenes VALUES(?,?,NULL,?)').run('scene', 'p', '两人交谈后分开。');
  for (const [index, prompt] of [first, second].entries())
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json,archived_at,position) VALUES (?,?,?,?,?,NULL,?)',
      )
      .run(`s${index}`, 'scene', ...shotFields({ prompt }), index);
  f.receipt('scene.submit_structure', {
    status: 'scene_structure_saved',
    sceneIds: ['scene'],
    shotIds: ['s0', 's1'],
  });
  f.plan([
    {
      key: 'scene',
      toolName: 'scene.submit_structure',
      minimumCount: 1,
      targetIds: ['scene'],
      criteria: [{ kind: 'scene_prompt_projection' }],
    },
  ]);
  const write = (prompt: string) => f.db.prepare('UPDATE scenes SET video_prompt=?').run(prompt);
  for (const prompt of ['两人交谈后分开。', `${second}\n${first}`, first]) {
    write(prompt);
    expect(f.assess()?.pending).toHaveLength(1);
  }
  const full = `${first}\n${second}`;
  write(full);
  expect(f.assess()?.pending).toEqual([]);
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields({ prompt: '乙转身离开。' }), 's1');
  expect(f.assess()?.pending).toHaveLength(1);
  expect(f.db.prepare('SELECT video_prompt FROM scenes').get()).toEqual({ video_prompt: full });
});
it('registers chapter creation and counts only its current committed document receipt', () => {
  const f = fixture();
  f.plan([
    { key: 'chapter', toolName: 'novel.chapter.write_draft', minimumCount: 1, intent: 'create' },
  ]);
  expect(f.assess()?.pending).toHaveLength(1);
  f.db.prepare("INSERT INTO documents VALUES ('chapter','p','novel-chapter','v1','active')").run();
  f.db.prepare("INSERT INTO document_versions VALUES ('v1','chapter','完整正文')").run();
  f.receipt('novel.chapter.write_draft', {
    status: 'draft_saved',
    documentId: 'chapter',
    documentVersionId: 'v1',
  });
  expect(f.assess()?.pending).toEqual([]);
  f.db.prepare("UPDATE documents SET current_version_id='v2'").run();
  expect(f.assess()?.pending).toHaveLength(1);
});
it('checks typed duration and derived prompt documents against current saved facts', () => {
  const f = fixture();
  f.db.prepare("INSERT INTO scenes VALUES('scene','p',NULL)").run();
  const ir = (prompt: string, seconds: number) => ({
    prompt,
    timing: { estimatedDurationSeconds: seconds },
  });
  const first = ir('近景：人物接过信件。', 4);
  let second = ir('人物转身。', 3);
  for (const [id, value] of [
    ['s1', first],
    ['s2', second],
  ] as const)
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json,archived_at) VALUES (?,?,?,?,?,NULL)',
      )
      .run(id, 'scene', ...shotFields(value));
  f.receipt('scene.submit_structure', {
    status: 'scene_structure_saved',
    sceneIds: ['scene'],
    shotIds: ['s1', 's2'],
  });
  f.document('prompts', 'plan');
  f.document('independent', 'note');
  f.db
    .prepare('UPDATE document_versions SET content_markdown=? WHERE document_id=?')
    .run('原先的提示词版本', 'prompts');
  const document = {
    key: 'prompts',
    toolName: 'document.submit_draft',
    documentKind: 'plan',
    minimumCount: 1,
    targetIds: ['prompts'],
    dependsOn: ['shots'],
    criteria: [{ kind: 'shot_prompt_projection' }],
  };
  const shots = {
    key: 'shots',
    toolName: 'scene.submit_structure',
    minimumCount: 1,
    targetIds: ['scene'],
    criteria: [{ kind: 'total_duration', seconds: 10, toleranceSeconds: 0 }],
  };
  // Consumer deliberately precedes its source in plan order.
  f.plan([document, shots]);
  expect(f.assess()?.pending.map((p) => p.key)).toEqual(['shots', 'prompts']);
  expect(JSON.stringify(f.assess())).toContain('actualSeconds');
  expect(() => f.plan([{ ...shots, criteria: [] }])).toThrow();
  expect(() => f.plan([{ ...shots, criteria: undefined, revisionReason: '想跳过验收' }])).toThrow(
    'Cannot weaken',
  );
  second = ir('双人中景：人物转身。', 6);
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields(second), 's2');
  expect(f.assess()?.pending.map((p) => p.key)).toEqual(['prompts']);
  const full = `# 完整提示词\n\n${first.prompt}\n\n${second.prompt}`;
  f.db.prepare('INSERT INTO document_versions VALUES (?,?,?)').run('v2', 'prompts', full);
  f.db.prepare('UPDATE documents SET current_version_id=? WHERE id=?').run('v2', 'prompts');
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'prompts',
    documentVersionId: 'v2',
  });
  expect(f.assess()?.pending).toEqual([]);
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields({ ...second, prompt: '双人中景：人物向后退半步。' }), 's2');
  expect(f.assess()?.pending.map((p) => p.key)).toEqual(['prompts']);
  expect(
    f.db
      .prepare("SELECT content_markdown FROM document_versions WHERE document_id='independent'")
      .get(),
  ).toEqual({ content_markdown: '' });
});
it('rejects unsafe, unknown or unbound program criteria without changing the plan', () => {
  const f = fixture();
  const item = { key: 'shots', toolName: 'scene.submit_structure', minimumCount: 1 };
  for (const criteria of [
    [{ kind: 'total_duration', seconds: 60, toleranceSeconds: 60 }],
    [{ kind: 'shot_field', path: 'data.constructor.name', inPrompt: true }],
    [{ kind: 'shot_field', path: 'prompt', inPrompt: true }],
    [{ kind: 'unknown' }],
  ])
    expect(() => f.plan([{ ...item, criteria }])).toThrow();
  expect(() =>
    f.plan([
      {
        key: 'doc',
        toolName: 'document.submit_draft',
        minimumCount: 1,
        criteria: [{ kind: 'shot_prompt_projection' }],
      },
    ]),
  ).toThrow('dependsOn');
  expect(f.assess()).toBeUndefined();
});
it('requires a separate saved prompt occurrence for every shot and rejects malformed IR without throwing', () => {
  const f = fixture();
  f.db.prepare("INSERT INTO scenes VALUES('scene','p',NULL)").run();
  for (const id of ['s1', 's2'])
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json,archived_at) VALUES (?,?,?,?,?,NULL)',
      )
      .run(
        id,
        'scene',
        ...shotFields({
          prompt: '近景：接过信件。',
          data: { shotScale: '近景' },
        }),
      );
  f.receipt('scene.submit_structure', {
    status: 'scene_structure_saved',
    sceneIds: ['scene'],
    shotIds: ['s1', 's2'],
  });
  f.document('prompts', 'plan');
  f.plan([
    {
      key: 'shots',
      toolName: 'scene.submit_structure',
      minimumCount: 1,
      targetIds: ['scene'],
      requiredTexts: ['近景：接过信件。'],
    },
    {
      key: 'prompts',
      toolName: 'document.submit_draft',
      minimumCount: 1,
      targetIds: ['prompts'],
      dependsOn: ['shots'],
      criteria: [{ kind: 'shot_prompt_projection' }],
    },
  ]);
  f.db.prepare('UPDATE document_versions SET content_markdown=?').run('近景：接过信件。');
  expect(f.assess()?.pending.map((p) => p.key)).toEqual(['prompts']);
  f.db
    .prepare('UPDATE document_versions SET content_markdown=?')
    .run('近景：接过信件。\n\n近景：接过信件。');
  expect(f.assess()?.pending).toEqual([]);
  for (const malformed of [
    { data: { shotScale: '近景' } },
    { prompt: 42, data: { shotScale: '近景' } },
    null,
    'invalid IR',
  ]) {
    f.db
      .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
      .run(...shotFields(malformed), 's2');
    expect(f.assess()?.pending.map((p) => p.key)).toEqual(['prompts']);
  }
});
it('validates typed criteria through the actual tool argument schema', () => {
  const definition = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'conversation.task.checkpoint')!;
  const validate = (criteria: unknown): void => {
    validateToolArguments(definition, {
      type: 'toolCall',
      id: 'plan',
      name: definition.name,
      arguments: {
        operation: 'plan',
        deliverables: [
          { key: 'shots', toolName: 'scene.submit_structure', minimumCount: 1, criteria },
        ],
      },
    });
  };
  expect(() =>
    validate([{ kind: 'total_duration', seconds: 60, toleranceSeconds: 0.5 }]),
  ).not.toThrow();
  for (const criterion of [
    { kind: 'total_duration', seconds: -1, toleranceSeconds: 0 },
    { kind: 'shot_field', path: 'prompt', inPrompt: true },
    { kind: 'shot_field', path: 'data.shotScale', inPrompt: 'invalid-boolean' },
    { kind: 'unknown' },
  ])
    expect(() => validate([criterion]), JSON.stringify(criterion)).toThrow();
});
it('allocates explicitly bound outputs to their own plan item regardless of save order', () => {
  const f = fixture();
  const plan = f.plan([
    { key: 'analysis', toolName: 'document.submit_draft', documentKind: 'plan', minimumCount: 1 },
    { key: 'storyboard', toolName: 'document.submit_draft', documentKind: 'plan', minimumCount: 1 },
  ]);
  const binding = (
    plan.outputBindings as Array<{
      key: string;
      outputId: string;
    }>
  ).find((b) => b.key === 'storyboard')!;
  f.db
    .prepare("INSERT INTO documents VALUES ('storyboard','p','plan','v-storyboard','active')")
    .run();
  f.db
    .prepare("INSERT INTO document_versions(id,document_id) VALUES('v-storyboard','storyboard')")
    .run();
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'storyboard',
    documentVersionId: 'v-storyboard',
    execution: { operationKey: `output:${binding.outputId}:0`, effect: 'created' },
  });
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['analysis']);
});
it('shares only explicit target IDs and does not fill a partial target group with another output', () => {
  const f = fixture();
  f.document('pinned', 'plan');
  const plan = f.plan([
    {
      key: 'analysis',
      toolName: 'document.submit_draft',
      documentKind: 'plan',
      minimumCount: 2,
      targetIds: ['pinned'],
    },
    { key: 'storyboard', toolName: 'document.submit_draft', documentKind: 'plan', minimumCount: 1 },
  ]);
  const binding = (
    plan.outputBindings as Array<{
      key: string;
      outputId: string;
    }>
  ).find((b) => b.key === 'storyboard')!;
  f.db
    .prepare("INSERT INTO documents VALUES ('storyboard','p','plan','v-storyboard','active')")
    .run();
  f.db
    .prepare("INSERT INTO document_versions(id,document_id) VALUES('v-storyboard','storyboard')")
    .run();
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'storyboard',
    documentVersionId: 'v-storyboard',
    execution: { operationKey: `output:${binding.outputId}:0`, effect: 'created' },
  });
  expect(f.assess()?.pending).toEqual([
    expect.objectContaining({ key: 'analysis', savedCount: 1, remainingCount: 1 }),
  ]);
  f.plan([
    {
      key: 'analysis',
      toolName: 'document.submit_draft',
      documentKind: 'plan',
      minimumCount: 2,
      targetIds: ['pinned', 'storyboard'],
    },
    {
      key: 'storyboard',
      toolName: 'document.submit_draft',
      documentKind: 'plan',
      minimumCount: 1,
      targetIds: ['storyboard'],
    },
  ]);
  expect(f.assess()?.pending).toEqual([]);
});
it('preserves output ownership when a bound document is later updated through its real target ID', () => {
  const f = fixture();
  const plan = f.plan([
    { key: 'analysis', toolName: 'document.submit_draft', documentKind: 'plan', minimumCount: 1 },
    { key: 'storyboard', toolName: 'document.submit_draft', documentKind: 'plan', minimumCount: 1 },
  ]);
  const outputId = (
    plan.outputBindings as Array<{
      key: string;
      outputId: string;
    }>
  ).find((b) => b.key === 'storyboard')!.outputId;
  f.db.prepare("INSERT INTO documents VALUES ('storyboard','p','plan','v2','active')").run();
  f.db
    .prepare(
      "INSERT INTO document_versions(id,document_id) VALUES('v1','storyboard'),('v2','storyboard')",
    )
    .run();
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'storyboard',
    documentVersionId: 'v1',
    execution: { operationKey: `output:${outputId}:0` },
  });
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'storyboard',
    documentVersionId: 'v2',
    execution: { operationKey: 'document:storyboard:v1:0' },
  });
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['analysis']);
});
it('keeps staged outputs with their planned owner when another stage finishes first', () => {
  const f = fixture();
  const plan = f.plan([
    { key: 'first', toolName: 'scene.structure.stage', minimumCount: 1 },
    { key: 'second', toolName: 'scene.structure.stage', minimumCount: 1 },
  ]);
  for (const binding of plan.outputBindings as Array<{
    key: string;
    outputId: string;
  }>)
    f.receipt('scene.structure.stage', {
      status: 'scene_structure_staging',
      stageId: `stage-${binding.key}`,
      execution: { operationKey: `output:${binding.outputId}:0` },
    });
  f.db.prepare("INSERT INTO scenes(id,project_id) VALUES('second','p')").run();
  f.db
    .prepare('INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)')
    .run('shot-second', 'second', ...shotFields({ prompt: '第二场正文' }));
  f.receipt('scene.structure.stage', {
    status: 'scene_structure_saved',
    stageId: 'stage-second',
    sceneIds: ['second'],
    shotIds: ['shot-second'],
    execution: { operationKey: 'scene.structure.stage:stage-second:put_shots:0:0:1' },
  });
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['first']);
  f.receipt('scene.submit_structure', {
    status: 'scene_structure_saved',
    sceneIds: ['second'],
    shotIds: ['shot-second'],
    execution: { operationKey: 'scene.submit_structure:targets:revision' },
  });
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['first']);
});
it('continues missing scenes before auditing whole-episode text instead of forcing it into the first scene', () => {
  const f = fixture();
  f.plan([
    {
      key: 'episode',
      toolName: 'scene.structure.stage',
      minimumCount: 4,
      requiredTexts: ['开场对白。', '结尾对白。'],
    },
  ]);
  const saveScene = (id: string, prompt: string) => {
    f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
      )
      .run(`shot-${id}`, id, ...shotFields({ prompt }));
    f.receipt('scene.structure.stage', {
      status: 'scene_structure_saved',
      sceneIds: [id],
      shotIds: [`shot-${id}`],
    });
  };
  saveScene('first', '开场对白。');
  expect(f.assess()?.pending[0]).toMatchObject({
    savedCount: 1,
    remainingCount: 3,
    missingTexts: ['结尾对白。'],
    nextAction: { kind: 'continue_outputs', toolName: 'scene.structure.stage' },
  });
  try {
    assertTaskPartialAllowed(f.assess());
  } catch (error) {
    expect((error as Error).message).toContain('Continue the unfinished outputs');
    expect((error as Error).message).not.toContain('repair existing outputs, then recheck');
  }
  for (const id of ['second', 'third', 'fourth']) saveScene(id, '该场独立动作。');
  expect(f.assess()?.pending[0]).toMatchObject({
    savedCount: 4,
    remainingCount: 0,
    missingTexts: ['结尾对白。'],
    nextAction: { kind: 'repair_outputs', planChangeRequired: false },
  });
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields({ prompt: '结尾对白。' }), 'shot-fourth');
  expect(f.assess()?.pending).toEqual([]);
});
it.each(STRUCTURE_DELIVERABLE_TOOLS)(
  'repairs persisted scenes from %s instead of reporting them as missing outputs',
  (toolName) => {
    const f = fixture();
    f.document('actor', 'character');
    f.plan([
      {
        key: 'episode',
        toolName,
        minimumCount: 2,
        requireReferences: true,
        requiredTexts: ['首场对白。', '末场对白。'],
      },
    ]);
    for (const id of ['first', 'second']) {
      f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
      f.db
        .prepare(
          'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
        )
        .run(
          `shot-${id}`,
          id,
          ...shotFields({
            prompt: id === 'first' ? '首场对白。' : '末场对白。',
            bindings: { schemaVersion: 1, characterDocumentIds: id === 'first' ? ['actor'] : [] },
          }),
        );
      f.receipt(toolName, {
        status: 'scene_structure_partially_saved',
        sceneIds: [id],
        shotIds: [`shot-${id}`],
      });
    }
    expect(f.assess()?.pending[0]).toMatchObject({
      savedCount: 1,
      persistedCount: 2,
      remainingCount: 0,
      savedSceneIds: ['first', 'second'],
      repairRequired: true,
      repairOutputs: [
        {
          outputId: 'second',
          shotId: 'shot-second',
          tool: 'production.read',
          arguments: { target: { kind: 'shot', id: 'shot-second' }, view: 'authoring' },
        },
      ],
      nextAction: { kind: 'repair_outputs', toolName: 'scene.update_shot_prompts' },
    });
    expect(f.assess()?.pending[0]).not.toHaveProperty('missingTexts');
    // Repair in place is sufficient: no new scene or structure receipt is needed.
    f.db.prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?').run(
      ...shotFields({
        prompt: '末场对白。',
        bindings: { schemaVersion: 1, characterDocumentIds: ['actor'] },
      }),
      'shot-second',
    );
    expect(f.assess()?.pending).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) n FROM scenes').get()).toEqual({ n: 2 });
  },
);
it('repairs existing target-shot references without requesting new outputs or weakening the plan', () => {
  const f = fixture();
  f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('scene','p')").run();
  f.db
    .prepare(
      "INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES ('shot','scene',?,?,?)",
    )
    .run(...shotFields({ prompt: '已保存的对白。', bindings: { schemaVersion: 1 } }));
  f.plan([
    {
      key: 'shot',
      toolName: 'scene.update_shot_prompts',
      minimumCount: 1,
      targetIds: ['shot'],
      requireReferences: true,
      requiredTexts: ['已保存的对白。'],
    },
  ]);
  f.receipt('scene.update_shot_prompts', {
    status: 'shot_prompts_saved',
    shots: [{ shotId: 'shot' }],
  });
  expect(f.assess()?.pending[0]).toMatchObject({
    savedCount: 0,
    persistedCount: 1,
    remainingCount: 0,
    missingTargetIds: ['shot'],
    repairOutputs: [{ outputId: 'shot', shotId: 'shot' }],
    nextAction: { kind: 'repair_outputs' },
  });
  expect(f.assess()?.pending[0]).not.toHaveProperty('missingTexts');
});
it('recognizes the actual episode_structure_saved receipt for scenes, prompts and timing', () => {
  const f = fixture();
  f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('scene','p')").run();
  f.db
    .prepare(
      "INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES ('shot','scene',?,?,?)",
    )
    .run(
      ...shotFields({
        prompt: '完整正文。',
        timing: { estimatedDurationSeconds: 3 },
      }),
    );
  f.plan([
    { key: 'episode', toolName: 'novel.episode.submit_structure', minimumCount: 1 },
    { key: 'prompts', toolName: 'scene.update_shot_prompts', minimumCount: 1 },
    { key: 'timing', toolName: 'scene.update_shot_timings', minimumCount: 1 },
  ]);
  f.receipt('novel.episode.submit_structure', {
    status: 'episode_structure_saved',
    sceneIds: ['scene'],
    shotIds: ['shot'],
  });
  expect(f.assess()?.pending).toEqual([]);
});
it.each(STRUCTURE_DELIVERABLE_TOOLS)(
  'recognizes committed shots from %s without requiring redundant prompt edits',
  (toolName) => {
    const f = fixture();
    f.document('actor', 'character');
    f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('scene','p')").run();
    const ir = {
      prompt: '桥边有人。',
      bindings: {
        schemaVersion: 1 as const,
        ...{ characterDocumentIds: ['actor'], sceneDocumentIds: [], propDocumentIds: [] },
      },
      timing: { estimatedDurationSeconds: 4 },
    };
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
      )
      .run('shot', 'scene', ...shotFields(ir));
    f.plan([
      {
        key: 'prompts',
        toolName: 'scene.update_shot_prompts',
        minimumCount: 1,
        targetIds: ['shot'],
        requireReferences: true,
        requiredTexts: ['桥边有人。'],
      },
      {
        key: 'timing',
        toolName: 'scene.update_shot_timings',
        minimumCount: 1,
        targetIds: ['shot'],
      },
    ]);
    const saved = {
      status: 'scene_structure_partially_saved',
      sceneIds: ['scene'],
      shotIds: ['shot'],
    };
    f.receipt(toolName, { ...saved, status: 'scene_structure_staging' });
    f.receipt(toolName, saved, 'failed');
    f.receipt(toolName, saved, 'succeeded', 'another-generation');
    expect(f.assess()?.pending).toHaveLength(2);
    f.receipt(toolName, saved);
    expect(f.assess()?.pending).toEqual([]);
    // A receipt does not validate removed timing or an archived current output.
    f.db
      .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=?')
      .run(...shotFields({ ...ir, timing: undefined }));
    expect(f.assess()?.pending.map((p) => p.key)).toEqual(['timing']);
    f.db.prepare("UPDATE shots SET archived_at='archived'").run();
    expect(f.assess()?.pending).toHaveLength(2);
  },
);
it('does not count a structure receipt for shots outside its committed scene IDs', () => {
  const f = fixture();
  for (const id of ['committed', 'unrelated'])
    f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
  f.db
    .prepare('INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)')
    .run('shot', 'unrelated', ...shotFields({ prompt: '正文' }));
  f.plan([{ key: 'prompts', toolName: 'scene.update_shot_prompts', minimumCount: 1 }]);
  f.receipt('scene.structure.stage', {
    status: 'scene_structure_saved',
    sceneIds: ['committed'],
    shotIds: ['shot'],
  });
  expect(f.assess()?.pending[0]).toMatchObject({ savedCount: 0 });
});
it('keeps discovered targets mandatory while completing the rest of a minimum-count group from saved outputs', () => {
  const f = fixture();
  f.document('first', 'plan');
  f.plan([
    {
      key: 'episode',
      toolName: 'document.submit_draft',
      minimumCount: 3,
      targetIds: ['first'],
      requiredTexts: ['最后一句。'],
    },
  ]);
  expect(f.assess()?.pending[0]).toMatchObject({ savedCount: 1, minimumCount: 3 });
  f.document('second', 'plan');
  f.document('third', 'plan');
  f.db
    .prepare("UPDATE document_versions SET content_markdown='最后一句。' WHERE document_id='third'")
    .run();
  expect(f.assess()?.pending).toEqual([]);
  f.db.prepare("UPDATE documents SET lifecycle_status='archived' WHERE id='first'").run();
  f.document('replacement', 'plan');
  expect(f.assess()?.pending[0]).toMatchObject({ missingTargetIds: ['first'] });
});
it('shares saveable document kinds and field combination rules with the provider schema', () => {
  const f = fixture();
  const definition = SYSTEM_AGENT_TOOLS.find(
    (tool) => tool.name === 'conversation.task.checkpoint',
  )!;
  const validate = (deliverable: Record<string, unknown>): void => {
    validateToolArguments(definition, {
      type: 'toolCall',
      id: 'plan',
      name: definition.name,
      arguments: { operation: 'plan', deliverables: [deliverable] },
    });
  };
  const base = { key: 'script', toolName: 'document.submit_draft', minimumCount: 1 };
  for (const documentKind of ['plan', 'storyboard']) {
    expect(() => validate({ ...base, documentKind })).not.toThrow();
    expect(() => f.plan([{ ...base, key: documentKind, documentKind }])).not.toThrow();
  }
  for (const extra of [{ documentKind: 'script' }, { requireReferences: false }]) {
    expect(() => validate({ ...base, ...extra })).toThrow();
    expect(() => f.plan([{ ...base, ...extra }])).toThrow(
      /deliverables\[0\]\.(documentKind|requireReferences)/,
    );
  }
  expect(() =>
    validate({ ...base, toolName: 'scene.update_shot_timings', documentKind: 'plan' }),
  ).toThrow();
  for (const toolName of STRUCTURE_DELIVERABLE_TOOLS) {
    const item = {
      key: `structure:${toolName}`,
      toolName,
      minimumCount: 4,
      requireReferences: true,
    };
    expect(() => validate(item)).not.toThrow();
    expect(() => fixture().plan([item])).not.toThrow();
  }
});
it('keeps discussion unplanned but detects an action plan with zero writes', () => {
  const f = fixture();
  expect(f.assess()).toBeUndefined();
  f.plan([
    {
      key: 'characters',
      toolName: 'document.submit_draft',
      documentKind: 'character',
      minimumCount: 1,
    },
  ]);
  expect(f.assess()?.pending).toHaveLength(1);
  f.receipt('conversation.task.checkpoint', { status: 'task_checkpoint_saved' });
  f.receipt('project.structure.get', { status: 'read' });
  expect(f.assess()?.pending).toHaveLength(1);
});
it('can repair a historical script plan without weakening obligations or rewriting its audit', () => {
  const f = fixture();
  const legacy = {
    key: 'episode',
    toolName: 'document.submit_draft',
    documentKind: 'script',
    minimumCount: 1,
  };
  f.receipt('conversation.task.checkpoint', { status: 'task_plan_saved', deliverables: [legacy] });
  expect(f.assess()?.pending[0]).toMatchObject({ documentKind: 'plan', minimumCount: 1 });
  expect(() => f.plan([{ ...legacy, documentKind: 'plan' }])).not.toThrow();
  f.document('script-draft', 'plan');
  expect(f.assess()?.pending).toEqual([]);
  const audit = f.db
    .prepare('SELECT result_summary_json FROM agent_tool_calls ORDER BY rowid LIMIT 1')
    .get() as {
    result_summary_json: string;
  };
  const original = JSON.parse(audit.result_summary_json) as {
    deliverables: Array<{
      documentKind: string;
    }>;
  };
  expect(original.deliverables[0]!.documentKind).toBe('script');
});
it('checks actual document kinds and distinct current-generation persisted documents', () => {
  const f = fixture();
  f.plan([
    {
      key: 'characters',
      toolName: 'document.submit_draft',
      documentKind: 'character',
      minimumCount: 2,
    },
  ]);
  f.document('location', 'scene');
  f.document('old-character', 'character', 'other-generation');
  f.document('actor', 'character');
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'actor',
    documentVersionId: 'v-actor',
  });
  f.receipt('document.submit_draft', {
    status: 'draft_saved',
    documentId: 'invented',
    documentVersionId: 'invented',
  });
  expect(f.assess()?.pending[0]).toMatchObject({ savedCount: 1, minimumCount: 2 });
  f.document('actor2', 'character');
  expect(f.assess()?.pending).toEqual([]);
});
it('requires independent saved outputs for several unbound deliverables of the same kind', () => {
  const f = fixture();
  f.plan(
    ['analysis', 'storyboard', 'prompts'].map((key) => ({
      key,
      toolName: 'document.submit_draft',
      documentKind: 'plan',
      minimumCount: 1,
    })),
  );
  f.document('analysis', 'plan');
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['storyboard', 'prompts']);
  expect(f.assess()?.pending.every((item) => item.nextAction.kind === 'continue_outputs')).toBe(
    true,
  );
  f.document('storyboard', 'plan');
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['prompts']);
  f.document('prompts', 'plan');
  expect(f.assess()?.pending).toEqual([]);
});
it('rejects renamed re-registration after recovery while allowing stable refinements and distinct targets', () => {
  const f = fixture();
  const item = {
    key: 'characters',
    toolName: 'document.submit_draft',
    documentKind: 'character',
    minimumCount: 4,
  };
  f.plan([item]);
  f.document('actor', 'character');
  expect(() =>
    f.plan([{ ...item, key: 'restored.characters', description: 'same work after restart' }]),
  ).toThrow(/existing unbound deliverable characters/);
  for (const minimumCount of [1, 3, 5])
    expect(() => f.plan([{ ...item, key: 'restored.characters', minimumCount }])).toThrow(
      /existing unbound deliverable characters/,
    );
  expect(f.assess()?.pending).toHaveLength(1);
  expect(f.assess()?.pending[0]?.savedCount).toBe(1);
  expect(() =>
    f.plan([{ ...item, description: 'continue three remaining characters' }]),
  ).not.toThrow();
  expect(() => f.plan([{ ...item, minimumCount: 5 }])).not.toThrow();
  expect(f.assess()?.pending[0]?.minimumCount).toBe(5);
  f.document('other-actor', 'character', 'previous-generation');
  expect(() => f.plan([{ ...item, key: 'independent', targetIds: ['other-actor'] }])).not.toThrow();
  expect(f.assess()?.pending).toHaveLength(2);
});
it('diagnoses historical plan allocation conflicts and repairs shared identities without new writes', () => {
  const f = fixture();
  const base = { toolName: 'document.submit_draft', documentKind: 'plan' };
  const legacy = [
    { ...base, key: 'initial-total', minimumCount: 1 },
    { ...base, key: 'refined-total', minimumCount: 2 },
  ];
  f.receipt('conversation.task.checkpoint', { status: 'task_plan_saved', deliverables: legacy });
  f.document('first', 'plan');
  f.document('last', 'plan');
  expect(f.assess()?.pending[0]).toMatchObject({
    key: 'refined-total',
    savedCount: 1,
    allocatedElsewhere: ['first'],
  });
  expect(f.assess()?.pending[0]?.planRepair).toContain('already saved');
  f.plan(legacy.map((item) => ({ ...item, targetIds: ['first', 'last'] })));
  expect(f.assess()?.pending).toEqual([]);
  expect(f.db.prepare('SELECT count(*) n FROM documents').get()).toEqual({ n: 2 });
  const original = f.db
    .prepare('SELECT result_summary_json FROM agent_tool_calls ORDER BY rowid LIMIT 1')
    .get() as {
    result_summary_json: string;
  };
  expect(JSON.parse(original.result_summary_json) as unknown).toMatchObject({
    deliverables: legacy,
  });
});
it.each(['document.submit_draft', 'scene.update_shot_prompts'] as const)(
  'reconciles an explicitly allocated %s output before requesting more business writes',
  (toolName) => {
    const f = fixture();
    const setText = (text: string) => {
      if (toolName === 'document.submit_draft')
        f.db.prepare('UPDATE document_versions SET content_markdown=?').run(text);
      else
        f.db
          .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=?')
          .run(...shotFields({ prompt: text }));
    };
    if (toolName === 'document.submit_draft') f.document('saved', 'plan');
    else {
      f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('scene','p')").run();
      f.db.prepare("INSERT INTO shots (id,scene_id) VALUES ('saved','scene')").run();
      f.receipt(toolName, { status: 'shot_prompts_saved', shots: [{ shotId: 'saved' }] });
    }
    setText('已保存对白。');
    f.plan([{ key: 'saved-work', toolName, minimumCount: 1, targetIds: ['saved'] }]);
    const review = {
      key: 'final-review',
      toolName,
      minimumCount: 1,
      requiredTexts: ['已保存对白。', '尚未保存对白。'],
    };
    f.plan([review]);
    expect(f.assess()?.pending[0]).toMatchObject({
      key: review.key,
      persistedCount: 0,
      allocatedElsewhere: ['saved'],
      requiredTexts: review.requiredTexts,
      nextAction: { kind: 'repair_plan', toolName: 'conversation.task.checkpoint' },
    });
    // Pinning the shared output fixes allocation, not the actual missing text.
    f.plan([{ ...review, targetIds: ['saved'] }]);
    expect(f.assess()?.pending[0]).toMatchObject({
      persistedCount: 1,
      remainingCount: 0,
      missingTexts: ['尚未保存对白。'],
      nextAction: { kind: 'repair_outputs', planChangeRequired: false },
    });
    setText('已保存对白。尚未保存对白。');
    expect(f.assess()?.pending).toEqual([]);
    expect(
      f.db
        .prepare(
          `SELECT count(*) n FROM ${toolName === 'document.submit_draft' ? 'documents' : 'shots'}`,
        )
        .get(),
    ).toEqual({ n: 1 });
  },
);
it.each(['document.submit_draft', 'scene.structure.stage'] as const)(
  'rejects retrospective target groups that take saved outputs away from an existing %s obligation',
  (toolName) => {
    const f = fixture();
    const original = { key: 'original', toolName, minimumCount: 1 };
    f.plan([original]);
    if (toolName === 'document.submit_draft') f.document('saved', 'character');
    else {
      f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('saved','p')").run();
      f.db.prepare("INSERT INTO shots (id,scene_id) VALUES ('shot','saved')").run();
      f.receipt(toolName, {
        status: 'scene_structure_saved',
        sceneIds: ['saved'],
        shotIds: ['shot'],
      });
    }
    expect(f.assess()?.pending).toEqual([]);
    const renamed = { ...original, key: 'restored-summary', targetIds: ['saved'] };
    expect(() => f.plan([renamed])).toThrow(/already allocated.*original/);
    expect(f.assess()?.pending).toEqual([]);
    // Explicitly sharing the actual identity is allowed, without new writes.
    f.plan([{ ...original, targetIds: ['saved'] }, renamed]);
    expect(f.assess()?.pending).toEqual([]);
  },
);
it('checks all 16 target shots and actual nonempty, correctly typed references', () => {
  const f = fixture();
  const ids = Array.from({ length: 16 }, (_, i) => `s${i}`);
  f.document('actor', 'character');
  f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run('scene', 'p');
  for (const id of ids)
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
      )
      .run(
        id,
        'scene',
        ...shotFields({ bindings: { schemaVersion: 1, characterDocumentIds: ['actor'] } }),
      );
  f.plan([
    {
      key: 'bindings',
      toolName: 'scene.update_shot_prompts',
      minimumCount: 16,
      targetIds: ids,
      requireReferences: true,
    },
  ]);
  f.receipt('scene.update_shot_prompts', {
    status: 'shot_prompts_saved',
    shots: ids.slice(0, 15).map((shotId) => ({ shotId })),
  });
  expect(f.assess()?.pending[0]?.missingTargetIds).toEqual(['s15']);
  f.receipt('scene.update_shot_prompts', {
    status: 'shot_prompts_saved',
    shots: [{ shotId: 's15' }],
  });
  expect(f.assess()?.pending).toEqual([]);
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields({ bindings: { schemaVersion: 1 } }), 's15');
  expect(f.assess()?.pending[0]?.missingTargetIds).toEqual(['s15']);
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields({ bindings: { schemaVersion: 1, propDocumentIds: ['actor'] } }), 's15');
  expect(f.assess()?.pending[0]?.missingTargetIds).toEqual(['s15']);
});
it('cannot weaken or remove registered obligations and keeps explicit partial reasons', () => {
  const f = fixture();
  f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('scene','p')").run();
  for (const id of ['s1', 's2'])
    f.db.prepare('INSERT INTO shots (id,scene_id) VALUES (?,?)').run(id, 'scene');
  const step = {
    key: 'bindings',
    toolName: 'scene.update_shot_prompts',
    minimumCount: 2,
    targetIds: ['s1', 's2'],
    requireReferences: true,
  };
  f.plan([step]);
  expect(() => f.plan([{ ...step, minimumCount: 1 }])).toThrow('weaken');
  expect(() => f.plan([{ ...step, requireReferences: false }])).toThrow('weaken');
  f.plan([{ key: 'characters', toolName: 'document.submit_draft', minimumCount: 1 }]);
  expect(f.assess()?.pending).toHaveLength(2);
  f.receipt('conversation.task.checkpoint', {
    status: 'task_partial_reported',
    reason: '目标工具当前不可用',
  });
  expect(f.assess()?.partialReason).toBe('目标工具当前不可用');
  expect(f.assess()?.pending).toHaveLength(2);
});
it('corrects model-estimated scene counts using actual targets without losing text or binding requirements', () => {
  const f = fixture();
  const item = {
    key: 'episode',
    toolName: 'scene.structure.stage',
    minimumCount: 16,
    requireReferences: true,
    requiredTexts: ['桥边有人。'],
  };
  f.plan([item]);
  f.document('actor', 'character');
  const ids = ['one', 'two', 'three', 'four'];
  for (const id of ids) {
    f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
      )
      .run(
        'shot-' + id,
        id,
        ...shotFields({
          prompt: id === 'one' ? '桥边有人。' : '继续',
          bindings: { schemaVersion: 1, characterDocumentIds: ['actor'] },
        }),
      );
  }
  const correction = {
    ...item,
    minimumCount: 4,
    targetIds: ids,
    revisionReason: '源计划为四场，16是预计镜头数。使用已核实四场ID继续，不创建多余场次。',
  };
  expect(
    validateToolArguments(
      SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'conversation.task.checkpoint')!,
      {
        type: 'toolCall',
        id: 'plan-correction',
        name: 'conversation.task.checkpoint',
        arguments: { operation: 'plan', deliverables: [correction] },
      },
    ),
  ).toMatchObject({ operation: 'plan', deliverables: [correction] });
  expect(() => f.plan([{ ...correction, revisionReason: undefined }])).toThrow('weaken');
  expect(() => f.plan([{ ...correction, targetIds: ['invented'] }])).toThrow('existing active');
  expect(() => f.plan([{ ...correction, requiredTexts: [] }])).toThrow();
  expect(() => f.plan([{ ...correction, requireReferences: false }])).toThrow('weaken');
  // A partially completed task can correct its estimate before all future
  // output IDs exist. The corrected plan still requires the remaining saves.
  f.plan([{ ...correction, targetIds: ids.slice(0, 2) }]);
  expect(f.assess()?.pending[0]).toMatchObject({ minimumCount: 4, savedCount: 0 });
  f.plan([correction]);
  // Existing IDs and a corrected plan still cannot substitute for successful saves.
  expect(f.assess()?.pending[0]).toMatchObject({ savedCount: 0, countUnit: 'scenes' });
  f.receipt('scene.structure.stage', {
    status: 'scene_structure_saved',
    sceneIds: ids,
    shotIds: ids.map((id) => 'shot-' + id),
  });
  expect(f.assess()?.pending).toEqual([]);
  expect(() => f.plan([{ ...correction, targetIds: ids.slice(1) }])).toThrow('weaken');
  const original = f.db
    .prepare('SELECT result_summary_json FROM agent_tool_calls ORDER BY rowid LIMIT 1')
    .get() as {
    result_summary_json: string;
  };
  expect(JSON.parse(original.result_summary_json) as unknown).toMatchObject({
    deliverables: [{ minimumCount: 16 }],
  });
});
it('corrects a model plan before creating outputs without treating the revision as a save', () => {
  const f = fixture();
  const item = {
    key: 'references',
    toolName: 'document.submit_draft',
    minimumCount: 4,
    documentKind: 'plan',
    requiredTexts: ['用户原文。'],
  };
  f.plan([item]);
  f.plan([
    {
      ...item,
      minimumCount: 1,
      documentKind: undefined,
      revisionReason: '类型和数量是模型的估计；源任务只需要一份角色草稿。',
    },
  ]);
  expect(f.assess()?.pending[0]).toMatchObject({
    minimumCount: 1,
    savedCount: 0,
    missingTexts: ['用户原文。'],
  });
  f.document('actor', 'character');
  expect(f.assess()?.pending[0]).toMatchObject({
    savedCount: 1,
    missingTexts: ['用户原文。'],
  });
  f.db
    .prepare("UPDATE document_versions SET content_markdown='用户原文。' WHERE document_id='actor'")
    .run();
  expect(f.assess()?.pending).toEqual([]);
});
it('corrects a mistaken homogeneous document plan against the actual saved mixed reference set', () => {
  const f = fixture();
  const item = {
    key: 'references',
    toolName: 'document.submit_draft',
    minimumCount: 1,
    documentKind: 'plan',
  };
  f.plan([item]);
  f.document('actor', 'character');
  f.document('place', 'scene');
  f.document('prop', 'prop');
  f.document('unrelated', 'character', 'other-generation');
  expect(f.assess()?.pending[0]).toMatchObject({
    savedCount: 0,
    savedDocumentsOfOtherKinds: [
      { documentId: 'actor', kind: 'character' },
      { documentId: 'place', kind: 'scene' },
      { documentId: 'prop', kind: 'prop' },
    ],
  });
  f.plan([
    {
      ...item,
      minimumCount: 3,
      documentKind: undefined,
      targetIds: ['actor', 'place', 'prop'],
      revisionReason: '源任务需要角色、场景和道具，不是额外的一份plan文档；逐个核对真实保存对象。',
    },
  ]);
  expect(f.assess()?.pending).toEqual([]);
  expect(f.db.prepare('SELECT count(*) n FROM documents').get()).toEqual({ n: 4 });
});
it.each(STRUCTURE_DELIVERABLE_TOOLS)(
  'counts real committed scenes for %s, never staged or duplicate receipts',
  (toolName) => {
    const f = fixture();
    f.plan([{ key: 'episode', toolName, minimumCount: 2, requireReferences: true }]);
    f.document('actor', 'character');
    const ids = ['first', 'second'];
    for (const id of ids) {
      f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
      f.db
        .prepare(
          'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
        )
        .run(
          `shot-${id}`,
          id,
          ...shotFields({ bindings: { schemaVersion: 1, characterDocumentIds: ['actor'] } }),
        );
    }
    const saved = { sceneIds: ids, shotIds: ids.map((id) => `shot-${id}`) };
    for (const status of [
      'scene_structure_staging',
      'scene_structure_checkpointed',
      'scene_structure_conflicted',
    ]) {
      f.receipt(toolName, { status, ...saved });
    }
    f.receipt(toolName, { status: 'scene_structure_saved', ...saved }, 'failed');
    expect(f.assess()?.pending[0]?.savedCount).toBe(0);
    for (let i = 0; i < 2; i++)
      f.receipt(toolName, {
        status: 'scene_structure_partially_saved',
        sceneIds: ['first', 'invented'],
        shotIds: ['shot-first'],
      });
    expect(f.assess()?.pending[0]?.savedCount).toBe(1);
    f.receipt(toolName, { status: 'scene_structure_saved', ...saved });
    expect(f.assess()?.pending).toEqual([]);
    f.db
      .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
      .run(
        ...shotFields({ bindings: { schemaVersion: 1, sceneDocumentIds: ['actor'] } }),
        'shot-second',
      );
    expect(f.assess()?.pending[0]?.savedCount).toBe(1);
    f.db.prepare("UPDATE scenes SET archived_at='archived' WHERE id='first'").run();
    expect(f.assess()?.pending[0]?.savedCount).toBe(0);
  },
);
it('reserves explicit scene targets and allocates unbound outputs across structure tools only once', () => {
  const f = fixture();
  f.db.prepare("INSERT INTO scenes (id,project_id) VALUES ('first','p')").run();
  f.db.prepare("INSERT INTO shots (id,scene_id) VALUES ('shot-first','first')").run();
  f.plan([
    { key: 'first', toolName: 'scene.structure.stage', minimumCount: 1, targetIds: ['first'] },
    { key: 'second', toolName: 'scene.submit_structure', minimumCount: 1 },
  ]);
  for (const tool of STRUCTURE_DELIVERABLE_TOOLS)
    f.receipt(tool, {
      status: 'scene_structure_saved',
      sceneIds: ['first'],
      shotIds: ['shot-first'],
    });
  expect(f.assess()?.pending.map((item) => item.key)).toEqual(['second']);
});
it('validates output targets before registration and repairs only legacy workspace locators without erasing obligations', () => {
  const f = fixture();
  const item = {
    key: 'episode',
    toolName: 'scene.submit_structure',
    minimumCount: 2,
    requireReferences: true,
  };
  for (const id of ['workspace:shots', 'invented'])
    expect(() => f.plan([{ ...item, targetIds: [id] }])).toThrow(/existing active output/);
  f.receipt('conversation.task.checkpoint', {
    status: 'task_plan_saved',
    deliverables: [{ ...item, targetIds: ['workspace:shots'] }],
  });
  expect(f.assess()?.pending).toMatchObject([
    { key: 'episode', minimumCount: 2, requireReferences: true, savedCount: 0 },
  ]);
  expect(f.assess()?.pending[0]?.targetIds).toBeUndefined();
  expect(() => f.plan([{ ...item, toolName: 'scene.structure.stage' }])).not.toThrow();
  expect(() => f.plan([{ ...item, minimumCount: 1 }])).toThrow(/weaken/);
  f.document('actor', 'character');
  for (const id of ['a', 'b']) {
    f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
      )
      .run(
        `shot-${id}`,
        id,
        ...shotFields({ bindings: { schemaVersion: 1, characterDocumentIds: ['actor'] } }),
      );
  }
  f.receipt('scene.submit_structure', {
    status: 'scene_structure_saved',
    sceneIds: ['a', 'b'],
    shotIds: ['shot-a', 'shot-b'],
  });
  expect(f.assess()?.pending).toEqual([]);
});
it.each([false, true])(
  'requires a real non-retryable blocker for missing outputs or text (text=%s)',
  (text) => {
    const f = fixture();
    f.plan([
      {
        key: 'missing',
        toolName: 'scene.structure.stage',
        minimumCount: 1,
        ...(text ? { requiredTexts: ['对白。'] } : {}),
      },
    ]);
    const progress = f.assess();
    expect(progress?.pending[0]?.remainingCount).toBe(1);
    expect(() => assertTaskPartialAllowed(progress)).toThrow('TASK_REPAIR_REQUIRED');
    for (const retryable of [true, false]) {
      const blocker = {
        id: 'r',
        callId: 'c',
        toolName: 'scene.structure.stage',
        version: 1,
        contentHash: 'hash',
        arguments: {},
        status: 'failed',
        content: JSON.stringify({ error: { retryable } }),
      };
      if (retryable)
        expect(() => assertTaskPartialAllowed(progress, blocker)).toThrow('TASK_REPAIR_REQUIRED');
      else expect(() => assertTaskPartialAllowed(progress, blocker)).not.toThrow();
    }
  },
);
it('checks verbatim requirements against current saved Markdown and never weakens the persisted checklist', () => {
  const f = fixture();
  const item = {
    key: 'text',
    toolName: 'document.submit_draft',
    minimumCount: 1,
    requiredTexts: ['原文对白。'],
  };
  f.plan([item]);
  f.document('draft', 'plan');
  f.receipt('conversation.task.checkpoint', {
    status: 'task_checkpoint_saved',
    workingNotes: '原文对白。',
  });
  expect(f.assess()?.pending[0]).toMatchObject({ savedCount: 1, missingTexts: ['原文对白。'] });
  expect(() => assertTaskPartialAllowed(f.assess())).toThrow(/TASK_REPAIR_REQUIRED/);
  for (const result of [
    { status: 'completed', content: JSON.stringify({ error: { retryable: false } }) },
    { status: 'failed', content: JSON.stringify({ error: { retryable: true } }) },
    { status: 'failed', content: 'Validation failed' },
  ])
    expect(() =>
      assertTaskPartialAllowed(f.assess(), {
        ...result,
        id: 'r',
        callId: 'c',
        toolName: 'tools.load',
        version: 1,
        contentHash: 'hash',
        arguments: {},
      }),
    ).toThrow(/TASK_REPAIR_REQUIRED/);
  expect(() =>
    assertTaskPartialAllowed(f.assess(), {
      status: 'failed',
      content: JSON.stringify({ error: { retryable: false } }),
      id: 'r',
      callId: 'c',
      toolName: 'document.submit_draft',
      version: 1,
      contentHash: 'hash',
      arguments: {},
    }),
  ).not.toThrow();
  expect(() => f.plan([{ ...item, requiredTexts: undefined }])).toThrow(/weaken/);
  f.db
    .prepare('UPDATE document_versions SET content_markdown=? WHERE id=?')
    .run('人物说：“原文对白。”', 'v-draft');
  expect(f.assess()?.pending).toEqual([]);
  f.db
    .prepare('UPDATE document_versions SET content_markdown=? WHERE id=?')
    .run('修改后漏了对白', 'v-draft');
  expect(f.assess()?.pending[0]?.missingTexts).toEqual(['原文对白。']);
});
it.each(STRUCTURE_DELIVERABLE_TOOLS)(
  'verifies all source lines across real shot prompts for %s, excluding audio metadata',
  (toolName) => {
    const f = fixture();
    const requiredTexts = ['第一句。', '第二句。'];
    f.plan([{ key: 'episode', toolName, minimumCount: 2, requiredTexts }]);
    for (const id of ['first', 'second']) {
      f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
      f.db
        .prepare(
          'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
        )
        .run(
          `shot-${id}`,
          id,
          ...shotFields({
            prompt: id === 'first' ? '第一句。' : '遗漏正文',
            data: { audioPlan: { line: '第二句。' } },
          }),
        );
    }
    f.receipt(toolName, {
      status: 'scene_structure_saved',
      sceneIds: ['first', 'second'],
      shotIds: ['shot-first', 'shot-second'],
    });
    expect(f.assess()?.pending[0]).toMatchObject({
      savedCount: 2,
      missingTexts: ['第二句。'],
      nextAction: {
        kind: 'repair_outputs',
        toolName: 'scene.update_shot_prompts',
        targetIds: ['shot-first', 'shot-second'],
        obligationKey: 'episode',
        planChangeRequired: false,
      },
    });
    f.db
      .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
      .run(...shotFields({ prompt: '第二句。' }), 'shot-second');
    expect(f.assess()?.pending).toEqual([]);
    f.db.prepare("UPDATE shots SET archived_at='archived' WHERE id='shot-second'").run();
    expect(f.assess()?.pending[0]?.missingTexts).toEqual(['第二句。']);
  },
);
it('checks required text across every scene in one deliverable even when its minimum count is one', () => {
  const f = fixture();
  f.plan([
    {
      key: 'whole-episode',
      toolName: 'scene.structure.stage',
      minimumCount: 1,
      requiredTexts: ['开场原句。', '结尾原句。'],
    },
  ]);
  for (const [id, prompt] of [
    ['first', '开场原句。'],
    ['last', '结尾原句。'],
  ]) {
    f.db.prepare('INSERT INTO scenes (id,project_id) VALUES (?,?)').run(id, 'p');
    f.db
      .prepare(
        'INSERT INTO shots (id,scene_id,prompt,timing_json,bindings_json) VALUES (?,?,?,?,?)',
      )
      .run(`shot-${id}`, id, ...shotFields({ prompt }));
  }
  f.receipt('scene.structure.stage', {
    status: 'scene_structure_saved',
    sceneIds: ['first', 'last'],
    shotIds: ['shot-first', 'shot-last'],
  });
  expect(f.assess()?.pending).toEqual([]);
  f.db
    .prepare('UPDATE shots SET prompt=?,timing_json=?,bindings_json=? WHERE id=?')
    .run(...shotFields({ prompt: '漏掉结尾' }), 'shot-last');
  expect(f.assess()?.pending[0]?.missingTexts).toEqual(['结尾原句。']);
  expect(f.assess()?.pending[0]?.nextAction).toMatchObject({
    kind: 'repair_outputs',
    targetIds: ['shot-first', 'shot-last'],
    planChangeRequired: false,
  });
});
it('keeps exact-text schema validation aligned with runtime and accepts compatible plans without it', () => {
  const f = fixture();
  const definition = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'conversation.task.checkpoint')!;
  const base = { key: 'text', toolName: 'document.submit_draft', minimumCount: 1 };
  const validate = (requiredTexts: unknown): void => {
    validateToolArguments(definition, {
      type: 'toolCall',
      id: 'plan',
      name: definition.name,
      arguments: { operation: 'plan', deliverables: [{ ...base, requiredTexts }] },
    });
  };
  expect(() => validate(['逐字原文'])).not.toThrow();
  expect(() => f.plan([{ ...base, requiredTexts: ['逐字原文'] }])).not.toThrow();
  for (const requiredTexts of [[], ['重复', '重复'], [{}], ['x'.repeat(2001)]]) {
    expect(() => {
      validate(requiredTexts);
    }).toThrow();
    expect(() => saveTaskPlan(f.db, 'p', 'other', [{ ...base, requiredTexts }])).toThrow(
      /requiredTexts/,
    );
  }
});
