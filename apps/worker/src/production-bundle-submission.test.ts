import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { AgentContextStore } from '@ai-video/persistence';
import {
  productionBundleFixture,
  bundleSubmissionFixture,
} from './test-fixtures/production-bundle-fixture.js';
import { projectBundleSubmission } from './production-bundle-submission.js';
import { preservePreparedArguments, resolvePreparedArguments } from './agent-prepared-arguments.js';
import {
  MAX_BUNDLE_PROMPTS_PER_SUBMISSION,
  PRODUCTION_BUNDLE_SUBMIT_SCHEMA,
} from './production-bundle-schema.js';
import { readProductionSkill } from './production-skill-service.js';
import { PRODUCTION_BUNDLE_SKILL_REVISION } from '@ai-video/contracts';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.project.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

const request = () => ({
  partKey: 'all',
  expectedRevision: 0,
  ...bundleSubmissionFixture().submission,
  complete: true,
});

it('accepts only the boolean completion marker and projects prompts to ordinary text records', () => {
  const args = request();
  const { part, complete } = projectBundleSubmission(args);
  expect(complete).toBe(true);
  expect(part.documents.find((item) => item.localKey === 'room')).toMatchObject({
    kind: 'scene',
    contentMarkdown: '房间的完整提示词。',
  });
  expect(part.shots[0]).toMatchObject({
    prompt: '主角拿起手机。画外客服说“订单正常”。主角说“谢谢”。',
    sceneKey: 'scene-1',
    bindings: { propDocumentIds: [{ localKey: 'phone' }] },
  });
  expect(() => projectBundleSubmission({ ...args, complete: { props: '手机' } })).toThrow(
    'complete must be true',
  );
  expect(() =>
    projectBundleSubmission({
      partKey: args.partKey,
      expectedRevision: args.expectedRevision,
      prompts: [],
    }),
  ).toThrow('complete=true');
});

it('caps each model submission at 12 prompts while allowing the package to span ordered parts', () => {
  const args = request();
  const prompts = args.prompts as Record<string, unknown>[];
  const tooMany = Array.from({ length: MAX_BUNDLE_PROMPTS_PER_SUBMISSION + 1 }, (_, index) => ({
    ...prompts[index % prompts.length],
    localKey: `part-${index}`,
  }));
  const schema = PRODUCTION_BUNDLE_SUBMIT_SCHEMA as unknown as {
    properties: { prompts: { maxItems: number } };
  };

  expect(schema.properties.prompts.maxItems).toBe(MAX_BUNDLE_PROMPTS_PER_SUBMISSION);
  expect(() => projectBundleSubmission({ ...args, prompts: tooMany })).toThrow(
    'at most 12 objects per submission',
  );
});

it.each([
  'nested-shots',
  'unknown-root',
  'missing-bindings',
  'invalid-sample',
  'null-list',
  'unknown-kind',
  'wrong-kind-fields',
  'old-collections',
  'candidate-as-saved-target',
])('rejects malformed bundle payloads: %s', (mode) => {
  const args = request() as Record<string, unknown>;
  const prompts = args.prompts as Record<string, unknown>[];
  if (mode === 'nested-shots') prompts.find((item) => item.kind === 'scene')!.shots = [];
  if (mode === 'unknown-root') args.patch = {};
  if (mode === 'missing-bindings') delete prompts.find((item) => item.kind === 'shot')!.bindings;
  if (mode === 'invalid-sample')
    prompts.find((item) => item.kind === 'voice')!.sampleText = { invalid: true };
  if (mode === 'null-list') args.prompts = null;
  if (mode === 'unknown-kind') prompts[0]!.kind = 'inferred-character';
  if (mode === 'wrong-kind-fields') prompts[0]!.sceneKey = 'scene-1';
  if (mode === 'old-collections') args.documents = [];
  if (mode === 'candidate-as-saved-target')
    prompts.find((item) => item.kind === 'shot')!.existing = {
      id: 'candidate:shot-1',
      rowVersion: 1,
    };
  expect(() => projectBundleSubmission(args)).toThrow(/BUNDLE_(SUBMIT_INVALID|INVALID)/);
});

it('preserves ordinary prompt bytes without imposing creative fields or mandatory timing', () => {
  const args = request();
  const shot = (args.prompts as Record<string, unknown>[]).find((item) => item.kind === 'shot')!;
  delete shot.timing;
  shot.prompt = '  原样\r\n😀 e\u0301\n\n';
  expect(projectBundleSubmission(args).part.shots[0]!.prompt).toBe(shot.prompt);
  expect(projectBundleSubmission(args).part.documents[0]!.contentMarkdown).toBe(
    (args.prompts as Record<string, unknown>[])[0]!.prompt,
  );
});

it('patches only explicit submit fields while preserving content, part key and revision', async () => {
  const fixture = await productionBundleFixture();
  fixtures.push(fixture);
  fixture.project.access(true, (db, project) => {
    const store = new AgentContextStore(db);
    const args = { ...request(), patch: 'misplaced' };
    const ref = preservePreparedArguments(
      store,
      project.id,
      fixture.task.taskId,
      'production.bundle.submit',
      args,
    );
    const corrections = {
      partKey: args.partKey,
      expectedRevision: args.expectedRevision,
      preparedArguments: {
        ...ref,
        argumentsHash: 'copied-with-a-typo',
        patches: [
          { op: 'remove' as const, path: '/patch' },
          {
            op: 'set' as const,
            path: `/prompts/${args.prompts.findIndex((item) => item.kind === 'shot')}/bindings/voiceBindings/0/voiceDocumentId`,
            value: { localKey: 'voice-operator' },
          },
        ],
      },
    };
    const resolved = resolvePreparedArguments(
      store,
      project.id,
      fixture.task.taskId,
      'production.bundle.submit',
      corrections,
    );
    const projected = projectBundleSubmission(resolved as Record<string, unknown>);
    expect(projected.complete).toBe(true);
    expect(projected.part.shots[0]!.prompt).toBe(bundleSubmissionFixture().part.shots[0]!.prompt);
    expect(() =>
      resolvePreparedArguments(store, project.id, fixture.task.taskId, 'production.bundle.submit', {
        preparedArguments: ref,
        expectedRevision: 1,
      }),
    ).toThrow('PATCH_INVALID');
  });
});

it('uses the current declaration for resumed tasks', () => {
  expect(readProductionSkill({ skillId: 'script-to-media' }).revision).toBe(
    PRODUCTION_BUNDLE_SKILL_REVISION,
  );
});
