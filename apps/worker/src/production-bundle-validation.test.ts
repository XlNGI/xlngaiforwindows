import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  productionBundleFixture,
  bundlePart,
  bundleManifest,
} from './test-fixtures/production-bundle-fixture.js';
import { checkBundle, assertBundleRunBudget } from './production-bundle-validation.js';
import { loadBundle } from './production-bundle-state.js';
const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.project.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function setup(part = bundlePart()) {
  const f = await productionBundleFixture();
  fixtures.push(f);
  f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
  f.stage({ operation: 'put', partKey: 'all', expectedRevision: 0, part });
  f.stage({ operation: 'seal', expectedRevision: 1, manifest: bundleManifest(part) });
  const check = () => f.project.access(false, (db, p) => checkBundle(db, p.id, f.task.taskId));
  return { f, check };
}
it.each(['scene', 'shot'] as const)(
  'rejects a manifest that silently reorders existing %ss after appended objects',
  async (kind) => {
    const f = await productionBundleFixture();
    fixtures.push(f);
    const existingScene = f.content.saveScene({ title: '已有场次' });
    const existingShot = f.content.saveShot({ sceneId: existingScene.id, title: '已有镜头' });
    const part = bundlePart();
    part.scenes[0]!.existing = { id: existingScene.id, rowVersion: existingScene.rowVersion };
    part.shots[0]!.existing = { id: existingShot.id, rowVersion: existingShot.rowVersion };
    if (kind === 'scene') {
      part.scenes.unshift({
        ...structuredClone(part.scenes[0]!),
        localKey: 'new-scene',
        existing: undefined,
      });
      part.shots.unshift({
        ...structuredClone(part.shots[0]!),
        localKey: 'new-shot',
        sceneKey: 'new-scene',
        existing: undefined,
      });
    } else
      part.shots.unshift({
        ...structuredClone(part.shots[0]!),
        localKey: 'new-shot',
        existing: undefined,
      });
    f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
    f.stage({ operation: 'put', partKey: 'all', expectedRevision: 0, part });
    f.stage({ operation: 'seal', expectedRevision: 1, manifest: bundleManifest(part) });
    const errors = f.project.access(false, (db, p) => checkBundle(db, p.id, f.task.taskId).errors);
    expect(errors.some((e) => e.reason.includes('BUNDLE_ORDER_CONFLICT'))).toBe(true);
    expect(f.content.listShots(existingScene.id)).toHaveLength(1);
  },
);
it.each(['cas', 'published', 'foreign', 'locked'] as const)(
  'protects target %s before business commit',
  async (mode) => {
    const f = await productionBundleFixture();
    fixtures.push(f);
    const part = bundlePart();
    if (mode === 'locked') {
      const scene = f.content.saveScene({ title: '锁定场次' });
      const ir = structuredClone(part.shots[0]!);
      ir.timing!.locked = true;
      const shot = f.content.saveShot({
        sceneId: scene.id,
        title: '锁定镜头',
        prompt: ir.prompt,
        timing: ir.timing,
      });
      part.scenes[0]!.existing = { id: scene.id, rowVersion: scene.rowVersion };
      part.shots[0]!.existing = { id: shot.id, rowVersion: shot.rowVersion };
    } else {
      const d = f.workflow.saveDraft({
        kind: 'prop',
        title: '手机',
        contentMarkdown: '原正文',
        authorType: 'user',
      });
      part.documents.find((d) => d.kind === 'prop')!.existing = {
        id: d.id,
        rowVersion: mode === 'cas' ? d.rowVersion + 1 : d.rowVersion,
        versionId: d.currentVersion!.id,
      };
      if (mode === 'published')
        f.workflow.selfPublish({ documentId: d.id, expectedDocumentRowVersion: d.rowVersion });
      if (mode === 'foreign')
        part.documents.find((d) => d.kind === 'prop')!.existing!.id = 'another-project-document';
    }
    f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
    f.stage({ operation: 'put', partKey: 'all', expectedRevision: 0, part });
    f.stage({ operation: 'seal', expectedRevision: 1, manifest: bundleManifest(part) });
    const errors = f.project.access(false, (db, p) => checkBundle(db, p.id, f.task.taskId).errors);
    expect(
      errors.some((e) => (mode === 'locked' ? e.field === 'timing' : e.field === 'existing')),
    ).toBe(true);
  },
);
it('keeps frozen source page reads on demand and independent of structural readiness', async () => {
  const { f, check } = await setup();
  expect(check().structureReady).toBe(true);
  expect(check()).not.toHaveProperty('unreadSources');
  f.stage({ operation: 'source', documentId: f.source.id, limit: 10 });
  f.stage({ operation: 'source', documentId: f.source.id, offset: 11 });
  expect(check().structureReady).toBe(true);
  f.stage({ operation: 'source', documentId: f.source.id, offset: 10, limit: 1 });
  expect(check().structureReady).toBe(true);
  f.project.access(false, (db) => {
    const before = db.prepare('SELECT total_changes() n').get();
    check();
    check();
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
  });
});
it('does not combine old encoded source offsets with the ordinary source view', async () => {
  const { f, check } = await setup();
  f.stage({ operation: 'source', documentId: f.source.id });
  expect(check().structureReady).toBe(true);
  f.project.access(true, (db) => {
    db.prepare(
      "UPDATE agent_context_results SET content=json_remove(content,'$.view') WHERE task_id=? AND tool_name='production.bundle.source'",
    ).run(f.task.taskId);
  });
  expect(check().structureReady).toBe(true);
  f.stage({ operation: 'source', documentId: f.source.id, limit: 10 });
  expect(check().structureReady).toBe(true);
  f.stage({ operation: 'source', documentId: f.source.id, offset: 10 });
  expect(check().structureReady).toBe(true);
});
it('pages candidate text on demand without making full candidate rereads a commit requirement', async () => {
  const part = bundlePart();
  part.documents[0]!.contentMarkdown = '正文\\"'.repeat(15000);
  const { f, check } = await setup(part);
  f.stage({ operation: 'source', documentId: f.source.id });
  expect(check().structureReady).toBe(true);
  const keys = [...part.documents, ...part.scenes, ...part.shots].map((i) => i.localKey);
  const items = keys.map((localKey) => ({ localKey }));
  const read = (entries: unknown, expectedRevision = 1) =>
    f.stage({ operation: 'read_many', expectedRevision, items: entries });
  expect(() => read(items, 0)).toThrow('REVISION_CONFLICT');
  expect(() => read([...items.slice(0, 1), { localKey: keys[1], expectedHash: 'stale' }])).toThrow(
    'READ_STALE',
  );
  let pending: unknown = items;
  let count = 0;
  const texts = new Map<string, string>();
  do {
    const result = read(pending) as {
      reads: Array<{
        localKey: string;
        contentPage: {
          offset: number;
          text: string;
        };
      }>;
      remaining: unknown[];
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024);
    expect(result.reads.reduce((n, r) => n + r.contentPage.text.length, 0)).toBeLessThanOrEqual(
      10000,
    );
    expect(result.reads.length).toBeGreaterThan(0);
    expect(result.remaining.every((item) => !Object.hasOwn(item as object, 'expectedHash'))).toBe(
      true,
    );
    for (const r of result.reads) {
      const before = texts.get(r.localKey) ?? '';
      expect(r.contentPage.offset).toBe(before.length);
      texts.set(r.localKey, before + r.contentPage.text);
    }
    pending = result.remaining;
    if (++count > 30) throw new Error('Paging failed to make progress');
  } while ((pending as unknown[]).length);
  expect(check().structureReady).toBe(true);
  const decoded = (key: string) => {
    const full = texts.get(key)!;
    const split = full.indexOf('\n\nprompt:\n');
    expect(split).toBeGreaterThan(0);
    return {
      ...(JSON.parse(full.slice(0, split)) as Record<string, unknown>),
      prompt: full.slice(split + '\n\nprompt:\n'.length),
    };
  };
  for (const { contentMarkdown, kind, ...item } of part.documents)
    expect(decoded(item.localKey)).toEqual({
      ...item,
      kind: kind === 'scene' ? 'location' : kind,
      prompt: contentMarkdown,
    });
  for (const [kind, items] of [
    ['scene', part.scenes],
    ['shot', part.shots],
  ] as const)
    for (const item of items) expect(decoded(item.localKey)).toEqual({ ...item, kind });
  const revision = structuredClone(part);
  revision.documents[0]!.contentMarkdown += '修改';
  f.stage({
    operation: 'put',
    partKey: 'repair',
    expectedRevision: 1,
    part: { documents: [revision.documents[0]!], scenes: [], shots: [] },
  });
  expect(() => read(items)).toThrow('REVISION_CONFLICT');
  expect(check().structureReady).toBe(false);
});
it('distinguishes unrelated preflight fields and resets failure history on a candidate revision', async () => {
  const { f } = await setup();
  const record = (reason: string) =>
    f.loop.recordValidationFailure(f.prepared.stream, 'production.bundle', 200, reason);
  for (const field of ['part.scenes', 'part.shots', 'part.documents'])
    record(`AGENT_TOOL_ARGUMENTS_INVALID: ${field} required`);
  expect(() => f.loop.startProviderStep(f.prepared.stream)).not.toThrow();
  for (let i = 0; i < 3; i++)
    record('AGENT_TOOL_ARGUMENTS_INVALID: part.shots[0].speech[0].character required');
  expect(() => f.loop.startProviderStep(f.prepared.stream)).toThrow('NO_PROGRESS_LIMIT');
  f.stage({ operation: 'seal', expectedRevision: 1, manifest: bundleManifest() });
  expect(() => f.loop.startProviderStep(f.prepared.stream)).toThrow('NO_PROGRESS_LIMIT');
  const part = bundlePart();
  part.documents[0]!.contentMarkdown += '局部修订';
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 1000);
    f.stage({
      operation: 'put',
      partKey: 'repair',
      expectedRevision: 1,
      part: { documents: [part.documents[0]!], scenes: [], shots: [] },
    });
  } finally {
    vi.useRealTimers();
  }
  expect(() => f.loop.startProviderStep(f.prepared.stream)).not.toThrow();
});
it.each(['wrong-type', 'story-scene', 'missing', 'unsnapshotted'])(
  'rejects an explicit invalid relationship: %s',
  async (mode) => {
    const part = bundlePart();
    if (mode === 'wrong-type') part.shots[0]!.bindings.propDocumentIds = [{ localKey: 'room' }];
    if (mode === 'story-scene')
      part.shots[0]!.bindings.sceneDocumentIds = [{ localKey: 'scene-1' }];
    if (mode === 'missing')
      part.shots[0]!.bindings.characterDocumentIds = [{ localKey: 'missing' }];
    if (mode === 'unsnapshotted')
      part.shots[0]!.bindings.propDocumentIds = [{ existingId: 'foreign-or-unselected' }];
    const { f, check } = await setup(part);
    expect(check().errors).not.toHaveLength(0);
    expect(check().structureReady).toBe(false);
    if (mode === 'story-scene') {
      expect(check().errors).toContainEqual({
        key: 'shot-1',
        field: 'bindings.sceneDocumentIds',
        reason: expect.stringContaining('Available location localKeys: ["room"]') as unknown,
      });
      expect(check().errors[0]!.reason).toContain('sceneKey');
      expect(
        f.project.access(false, (db, p) => loadBundle(db, p.id, f.task.taskId)!.revision),
      ).toBe(1);
      expect(part.shots[0]!.bindings.sceneDocumentIds).toEqual([{ localKey: 'scene-1' }]);
      expect(f.content.listScenes()).toEqual([]);
    }
  },
);
it('protects a reused exact version against subsequent edits', async () => {
  const { f } = await setup();
  const reused = f.content.saveDocument({
    kind: 'prop',
    title: '备用手机',
    contentMarkdown: '手机外观',
  });
  f.stage({
    operation: 'rebase',
    expectedRevision: 1,
    reused: [{ documentId: reused.id, versionId: reused.currentVersion!.id }],
  });
  f.content.saveDocument({
    documentId: reused.id,
    title: reused.title,
    contentMarkdown: '人工改动',
    expectedDocumentRowVersion: reused.rowVersion,
  });
  expect(() => f.stage({ operation: 'state' })).toThrow('SOURCE_CONFLICT');
});
it.each(['turn_count', 'output_tokens'] as const)(
  'stops at the frozen %s budget without losing candidates',
  async (field) => {
    const { f } = await setup();
    f.project.access(true, (db, p) => {
      db.prepare(`UPDATE agent_tasks SET ${field}=? WHERE id=?`).run(3000000, f.task.taskId);
      expect(() => assertBundleRunBudget(db, p.id, f.task.taskId)).toThrow('BUDGET_EXHAUSTED');
      expect(loadBundle(db, p.id, f.task.taskId)!.entries).toHaveLength(8);
    });
  },
);
it('does not stop at cumulative input usage, including a legacy frozen input cap', async () => {
  const { f } = await setup();
  f.project.access(true, (db, p) => {
    const task = db
      .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id=?')
      .get(f.task.taskId) as { request_snapshot_json: string };
    const snapshot = JSON.parse(task.request_snapshot_json) as Record<string, unknown>;
    snapshot.productionBundleLimits = { taskInputTokens: 2000000 };
    db.prepare('UPDATE agent_tasks SET request_snapshot_json=?,input_tokens=? WHERE id=?').run(
      JSON.stringify(snapshot),
      3000000,
      f.task.taskId,
    );
    expect(() => assertBundleRunBudget(db, p.id, f.task.taskId)).not.toThrow();
    expect(loadBundle(db, p.id, f.task.taskId)!.entries).toHaveLength(8);
  });
});
it('stops repeated parameter errors until a candidate revision makes progress', async () => {
  const { f } = await setup();
  f.project.access(true, (db, p) => {
    const add = (status: string, error: string | null, result: unknown) => {
      const id = crypto.randomUUID(),
        at = new Date().toISOString();
      db.prepare(
        `INSERT INTO agent_tool_calls(id,project_id,task_id,tool_name,normalized_arguments_hash,arguments_summary_json,result_summary_json,status,idempotency_key,error_message,created_at,completed_at,redaction_state) VALUES(?,?,?,'production.bundle','hash','{}',?,?,?,?,?,?,'native')`,
      ).run(id, p.id, f.task.taskId, JSON.stringify(result), status, id, error, at, at);
    };
    for (let i = 0; i < 2; i++) {
      add('failed', 'BUNDLE_INVALID: wrong field', {});
      add('succeeded', null, { status: 'bundle_state' });
    }
    expect(() => assertBundleRunBudget(db, p.id, f.task.taskId)).not.toThrow();
    add('failed', 'BUNDLE_INVALID: wrong field', {});
    expect(() => assertBundleRunBudget(db, p.id, f.task.taskId)).toThrow('NO_PROGRESS_LIMIT');
  });
  const part = bundlePart();
  part.documents[0]!.contentMarkdown += '完成局部修复';
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 1000);
    f.stage({
      operation: 'put',
      partKey: 'progress',
      expectedRevision: 1,
      part: { documents: [part.documents[0]!], scenes: [], shots: [] },
    });
  } finally {
    vi.useRealTimers();
  }
  expect(() => f.loop.startProviderStep(f.prepared.stream)).not.toThrow();
});
