import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  productionBundleFixture,
  bundleSubmissionFixture,
} from './test-fixtures/production-bundle-fixture.js';
import { ProductionBundleService, bundleCompletion } from './production-bundle-service.js';
import { loadBundle } from './production-bundle-state.js';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.project.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function setup() {
  const fixture = await productionBundleFixture();
  fixtures.push(fixture);
  const service = new ProductionBundleService(
    fixture.project,
    fixture.content,
    fixture.workflow,
    (value) => unifiedAgentToolRegistry.serializeResult(value),
  );
  const call = (args: Record<string, unknown>) =>
    service.execute(
      args,
      {
        ...fixture.identity,
        projectSessionId: fixture.project.currentSessionId()!,
      },
      !('operation' in args),
    );
  call({ operation: 'begin', estimatedOutputTokens: 4000 });
  call({ operation: 'source', documentId: fixture.source.id });
  return { fixture, call };
}

const submission = (complete = true) => ({
  partKey: complete ? 'complete' : 'draft',
  expectedRevision: 0,
  ...bundleSubmissionFixture().submission,
  ...(complete ? { complete: true } : {}),
});

it('blocks a structurally invalid package and offers only affected prompt keys for repair', async () => {
  const { fixture, call } = await setup();
  const invalid = bundleSubmissionFixture().submission.prompts;
  invalid.find((prompt) => prompt.kind === 'shot')!.sceneKey = 'missing-scene';

  const result = call({
    partKey: 'invalid',
    expectedRevision: 0,
    prompts: invalid,
    complete: true,
  });
  expect(result).toMatchObject({
    businessSaved: false,
    structureCheck: {
      structureReady: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ key: 'scene-1', field: 'shots' }),
        expect.objectContaining({ key: 'shot-1', field: 'sceneKey' }),
      ]) as unknown,
    },
  });
  expect(fixture.content.listScenes()).toHaveLength(0);

  const pending = fixture.project.access(
    false,
    (db, project) => bundleCompletion(db, project.id, fixture.task.taskId)[0],
  );
  expect(pending).toMatchObject({
    structureReady: false,
    nextAction: {
      toolName: 'production.bundle.submit',
      expectedRevision: 1,
      repairKeys: ['scene-1', 'shot-1'],
    },
  });
  expect(pending).not.toHaveProperty('semanticReview');
  expect(pending).not.toHaveProperty('unread');

  const repairedShot = bundleSubmissionFixture().submission.prompts.find(
    (prompt) => prompt.kind === 'shot',
  )!;
  const repaired = call({
    partKey: 'repair-shot',
    expectedRevision: 1,
    prompts: [repairedShot],
  });
  expect(repaired).toMatchObject({
    status: 'bundle_readback_verified',
    verified: true,
    businessSaved: true,
    counts: { shot: 1, scene: 1 },
  });
  expect(fixture.content.listScenes()).toHaveLength(1);
  expect(fixture.content.listShots(fixture.content.listScenes()[0]!.id)).toHaveLength(1);
  fixture.project.access(false, (db, project) =>
    expect(bundleCompletion(db, project.id, fixture.task.taskId)).toEqual([]),
  );
});

it('commits completed candidates once and independently verifies persisted records', async () => {
  const { fixture, call } = await setup();
  const args = submission();
  const first = call(args);
  expect(first).toMatchObject({ status: 'bundle_readback_verified', verified: true });

  const replay = call(args);
  expect(replay).toMatchObject({
    status: 'bundle_readback_verified',
    verified: true,
    mappingResultId: first.mappingResultId,
  });
  expect(fixture.content.listDocuments()).toHaveLength(7);
  expect(fixture.content.listScenes()).toHaveLength(1);
  expect(fixture.content.listShots(fixture.content.listScenes()[0]!.id)).toHaveLength(1);

  fixture.project.access(false, (db, project) => {
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM agent_context_results WHERE task_id=? AND tool_name='production.bundle.read'",
        )
        .get(fixture.task.taskId),
    ).toEqual({ n: 0 });
    expect(bundleCompletion(db, project.id, fixture.task.taskId)).toEqual([]);
  });
});

it('preserves the previous candidate revision when a commit transaction fails, then retries safely', async () => {
  const { fixture, call } = await setup();
  const draft = submission(false);
  call(draft);
  expect(fixture.content.listScenes()).toHaveLength(0);

  fixture.project.access(true, (db) =>
    db.exec(
      "CREATE TRIGGER bundle_test_fail BEFORE INSERT ON shots BEGIN SELECT RAISE(ABORT,'injected shot failure'); END",
    ),
  );
  expect(() => call({ partKey: 'finish-failed', expectedRevision: 1, complete: true })).toThrow(
    'injected shot failure',
  );
  expect(fixture.content.listDocuments()).toHaveLength(1);
  expect(fixture.content.listScenes()).toHaveLength(0);
  fixture.project.access(true, (db, project) => {
    const state = loadBundle(db, project.id, fixture.task.taskId)!;
    expect(state).toMatchObject({
      revision: 1,
      entries: expect.arrayContaining([expect.objectContaining({ key: 'shot-1' })]) as unknown,
    });
    expect(state).not.toHaveProperty('sealedRevision');
    expect(db.prepare('SELECT COUNT(*) n FROM agent_execution_commits').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER bundle_test_fail');
  });

  expect(call({ partKey: 'finish-retry', expectedRevision: 1, complete: true })).toMatchObject({
    status: 'bundle_readback_verified',
    verified: true,
  });
  expect(fixture.content.listScenes()).toHaveLength(1);
});

it('reports a changed saved record as unverified and asks for another independent readback', async () => {
  const { fixture, call } = await setup();
  call(submission());
  const scene = fixture.content.listScenes()[0]!;
  const shot = fixture.content.listShots(scene.id)[0]!;
  fixture.project.access(true, (db) =>
    db.prepare('UPDATE shots SET prompt=? WHERE id=?').run('外部修改', shot.id),
  );

  expect(call({ operation: 'readback' })).toMatchObject({
    status: 'bundle_saved_unverified',
    verified: false,
    businessSaved: true,
  });
  fixture.project.access(false, (db, project) =>
    expect(bundleCompletion(db, project.id, fixture.task.taskId)).toMatchObject([
      {
        key: 'production-bundle-readback',
        businessSaved: true,
        nextAction: { toolName: 'production.bundle', arguments: { operation: 'readback' } },
      },
    ]),
  );
});
