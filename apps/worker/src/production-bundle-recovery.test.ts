import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentContextStore } from '@ai-video/persistence';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { validateProductionBundlePart } from '@ai-video/contracts';
import { AgentProviderToolGateway, boundedValidationError } from './agent-provider-tool-gateway.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import type { LlmGenerationIdentity } from '@ai-video/contracts';
import {
  preparedArgumentsDefinition,
  preservePreparedArguments,
  resolvePreparedArguments,
  type PreparedArgumentsRef,
} from './agent-prepared-arguments.js';
import { bundlePart, productionBundleFixture } from './test-fixtures/production-bundle-fixture.js';
const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.project.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
const definition = preparedArgumentsDefinition(
  SYSTEM_AGENT_TOOLS.find((t) => t.name === 'production.bundle')!,
);
it('locates missing shot bindings hidden by conditional schema errors without echoing prompt text', () => {
  const submit = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'production.bundle.submit')!;
  const args = {
    partKey: 'part',
    expectedRevision: 0,
    prompts: [
      { localKey: 'scene', kind: 'scene', title: 'Scene', prompt: 'Private scene text' },
      {
        localKey: 'shot',
        kind: 'shot',
        title: 'Shot',
        sceneKey: 'scene',
        prompt: 'Private shot text',
      },
    ],
  };
  let failure: unknown;
  try {
    validateToolArguments(submit, {
      type: 'toolCall',
      id: 'bad',
      name: submit.name,
      arguments: args,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const reason = boundedValidationError(failure, submit, args);
  expect(reason).toContain('prompts[1]');
  expect(reason).toContain('bindings.characterDocumentIds required');
  expect(reason).not.toContain('Private');
  expect(reason.length).toBeLessThanOrEqual(1600);
});
it('returns legal review conclusions for the real partial-batch validation failure without echoing content', () => {
  const checkpoint = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'conversation.task.checkpoint')!;
  const reason = boundedValidationError(
    new Error(
      'conclusion: must be equal to one of the allowed values\nReceived arguments: private assessment',
    ),
    checkpoint,
    { operation: 'review', conclusion: 'partial' },
  );
  expect(reason).toContain('"passed" or "needs_revision", never "partial"');
  expect(reason).toContain('partial batch uses reviewedTargetIds');
  expect(reason).toContain('issues is required');
  expect(reason).not.toContain('private assessment');
  expect(reason.length).toBeLessThanOrEqual(1600);
});
it('identifies the actual candidate and cue without changing offscreen character semantics', () => {
  const part = bundlePart();
  (part.shots[0]!.bindings as unknown as Record<string, unknown>).speech = [];
  expect(() => validateProductionBundlePart(part)).toThrow(/part.shots\[0\].*bindings/);
  const voice = part.documents.find((d) => d.kind === 'voice')!;
  (voice as unknown as Record<string, unknown>).sampleText = { bad: 'value' };
  expect(() => validateProductionBundlePart(part)).toThrow(/part.documents\[\d+\].*sampleText/);
});
it('repairs a rejected large bundle by explicit fields, retaining all other text and rechecking the schema', async () => {
  const f = await productionBundleFixture();
  fixtures.push(f);
  f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
  f.project.access(true, (db, p) => {
    const store = new AgentContextStore(db),
      part = bundlePart();
    part.shots[0]!.prompt = '完整原文，不因参数修正改变。'.repeat(500);
    const args = { operation: 'put', expectedRevision: 0, partKey: 'all', part };
    const bad = structuredClone(args);
    delete (bad.part as Partial<typeof part>).scenes;
    bad.part.shots[0]!.bindings.voiceBindings![0]!.voiceDocumentId = { localKey: '' };
    const ref = preservePreparedArguments(store, p.id, f.task.taskId, definition.name, bad);
    const retry = {
      preparedArguments: {
        ...ref,
        patches: [
          { op: 'set', path: '/part/scenes', value: part.scenes },
          {
            op: 'set',
            path: '/part/shots/0/bindings/voiceBindings/0/voiceDocumentId',
            value: part.shots[0]!.bindings.voiceBindings![0]!.voiceDocumentId,
          },
        ],
      },
    };
    expect(
      () =>
        validateToolArguments(definition, {
          type: 'toolCall',
          id: 'retry',
          name: definition.name,
          arguments: retry,
        }) as unknown,
    ).not.toThrow();
    const resolved = resolvePreparedArguments(store, p.id, f.task.taskId, definition.name, retry);
    expect(resolved).toEqual(args);
    expect(store.result(p.id, f.task.taskId, ref.resultId)!.arguments).toEqual(bad);
    expect(
      () =>
        validateToolArguments(definition, {
          type: 'toolCall',
          id: 'resolved',
          name: definition.name,
          arguments: resolved as Record<string, unknown>,
        }) as unknown,
    ).not.toThrow();
    const stillInvalid = resolvePreparedArguments(store, p.id, f.task.taskId, definition.name, {
      preparedArguments: { ...ref, patches: [{ op: 'set', path: '/part/scenes', value: [] }] },
    });
    expect(
      () =>
        validateToolArguments(definition, {
          type: 'toolCall',
          id: 'invalid',
          name: definition.name,
          arguments: stillInvalid as Record<string, unknown>,
        }) as unknown,
    ).toThrow();
    for (const path of [
      '/expectedRevision',
      '/part/shots/-',
      '/part/shots/0/__proto__/polluted',
      '/part/shots/0/constructor',
      '/part/shots/99/title',
      '/part/shots/0/noParent/value',
      '/part/shots/0/~2',
    ])
      expect(() =>
        resolvePreparedArguments(store, p.id, f.task.taskId, definition.name, {
          preparedArguments: { ...ref, patches: [{ op: 'set', path, value: 'bad' }] },
        }),
      ).toThrow('PATCH_INVALID');
    for (const extra of [{ part }, { operation: 'commit' }])
      expect(() =>
        resolvePreparedArguments(store, p.id, f.task.taskId, definition.name, {
          ...retry,
          ...extra,
        }),
      ).toThrow('PATCH_INVALID');
    expect(() =>
      resolvePreparedArguments(store, p.id, f.task.taskId, definition.name, {
        preparedArguments: { ...ref, deleteFields: ['expectedRevision'] },
      }),
    ).toThrow('DELETE_INVALID');
    expect(() =>
      resolvePreparedArguments(store, p.id, 'another-task', definition.name, retry),
    ).toThrow('outside');
    expect(() =>
      resolvePreparedArguments(store, p.id, f.task.taskId, 'document.submit_draft', retry),
    ).toThrow('outside');
    expect(
      resolvePreparedArguments(store, p.id, f.task.taskId, definition.name, {
        preparedArguments: { ...ref, argumentsHash: 'wrong' },
      }),
    ).toEqual(bad);
    f.stage(resolved as Record<string, unknown>);
    expect(() => f.stage({ ...(resolved as object), partKey: 'stale' })).toThrow(
      'REVISION_CONFLICT',
    );
  });
});
it('records preflight and invalid recovery failures and stops before another provider request', async () => {
  const f = await productionBundleFixture();
  fixtures.push(f);
  f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
  const preserve = vi.fn((identity: LlmGenerationIdentity, tool: string, args: unknown) =>
    f.loop.preserveToolArguments(identity, tool, args),
  );
  const gateway = new AgentProviderToolGateway(
    {
      executeTools: vi.fn(),
      confirmTool: vi.fn(),
      selectMedia: vi.fn(),
      startProviderStep: vi.fn(),
      completeProviderStep: vi.fn(),
      terminateGeneration: vi.fn(),
      resolveToolArguments: (identity, tool, args) =>
        f.loop.resolveToolArguments(identity, tool, args),
      preserveToolArguments: preserve,
      recordValidationFailure: (identity, tool, bytes, reason) =>
        f.loop.recordValidationFailure(identity, tool, bytes, reason),
    },
    f.prepared.stream,
    [definition],
    vi.fn(),
    vi.fn(),
  );
  const prepare = gateway.tools()[0]!.prepareArguments!;
  let message = '';
  try {
    prepare({ operation: 'put', expectedRevision: 0, partKey: 'all', part: { documents: [] } });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('patches=');
  const ref = JSON.parse(
    /preparedArguments=(\{[^\n]+?\})/.exec(message)![1]!,
  ) as PreparedArgumentsRef;
  const retry = { preparedArguments: { ...ref, argumentsHash: 'wrong' } };
  let priorFailure = '';
  for (let i = 0; i < 3; i++) {
    try {
      prepare(retry);
    } catch (error) {
      const failure = (error as Error).message;
      expect(failure).not.toContain('INTEGRITY_FAILED');
      if (priorFailure) expect(failure).toBe(priorFailure);
      priorFailure = failure;
    }
  }
  expect(preserve).toHaveBeenCalledTimes(4);
  expect(() => f.loop.startProviderStep(f.prepared.stream)).toThrow('BUNDLE_NO_PROGRESS_LIMIT');
  f.project.access(false, (db) => {
    expect(
      db.prepare('SELECT COUNT(*) n FROM agent_tool_calls WHERE task_id=?').get(f.task.taskId),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM agent_task_events WHERE task_id=? AND event_type='tool_validation_failed'",
        )
        .get(f.task.taskId),
    ).toEqual({ n: 4 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM agent_context_results WHERE task_id=? AND call_id LIKE 'prepared:%'",
        )
        .get(f.task.taskId),
    ).toEqual({ n: 1 });
  });
});
