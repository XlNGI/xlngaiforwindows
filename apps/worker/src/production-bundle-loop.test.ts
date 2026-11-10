import { afterEach, expect, it } from 'vitest';
import { PRODUCTION_BUNDLE_SKILL_REVISION } from '@ai-video/contracts';
import { rm } from 'node:fs/promises';
import {
  productionBundleFixture,
  bundleSubmissionFixture,
} from './test-fixtures/production-bundle-fixture.js';
import { inspectAgentTask } from './agent-task-inspection.js';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.project.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'saves a complete structured bundle and independently reads it back (%s)',
  async (protocol) => {
    const fixture = await productionBundleFixture(protocol);
    fixtures.push(fixture);
    let tools = fixture.task.tools;
    let index = 0;

    expect(tools.some((tool) => tool.name === 'production.bundle')).toBe(true);
    expect(tools.some((tool) => tool.name === 'production.bundle.submit')).toBe(true);
    expect(
      tools.some((tool) =>
        [
          'document.submit_draft',
          'document.create_draft',
          'scene.structure.stage',
          'conversation.ask',
        ].includes(tool.name),
      ),
    ).toBe(false);
    const checkpoint = tools.find((tool) => tool.name === 'conversation.task.checkpoint')!;
    const properties = checkpoint.parameters.properties as Record<string, unknown>;
    expect(properties.operation).toMatchObject({
      enum: ['result', 'state', 'partial'],
    });

    const execute = async (name: string, args: Record<string, unknown>) => {
      fixture.loop.startProviderStep(fixture.prepared.stream);
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool).toBeDefined();
      const id = `bundle-loop-${index++}`;
      const result = await fixture.loop.executeTools({
        ...fixture.prepared.stream,
        providerResponseId: `response-${id}`,
        calls: [
          {
            id,
            name,
            authorizationHandle: tool.authorizationHandle,
            argumentsJson: JSON.stringify(args),
          },
        ],
      });
      tools = result.tools ?? tools;
      const output = result.continuation!.outputs[0]!.output;
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed.error).toBeUndefined();
      return parsed;
    };

    expect(await execute('production.skill.read', { skillId: 'script-to-media' })).toMatchObject({
      revision: PRODUCTION_BUNDLE_SKILL_REVISION,
    });
    await execute('production.bundle', { operation: 'begin', estimatedOutputTokens: 4000 });
    await execute('production.bundle', {
      operation: 'source',
      documentId: fixture.source.id,
    });
    const { submission } = bundleSubmissionFixture();
    const saved = await execute('production.bundle.submit', {
      partKey: 'all',
      expectedRevision: 0,
      ...submission,
      complete: true,
    });
    expect(saved).toMatchObject({
      status: 'bundle_readback_verified',
      verified: true,
      businessSaved: true,
      objectCount: 8,
      counts: { character: 2, voice: 2, prop: 1, scene: 1, shot: 1 },
    });

    fixture.loop.completeProviderStep({
      ...fixture.prepared.stream,
      providerResponseId: 'finished',
      finishReason: 'stop',
    });
    const detail = fixture.workflow.getTask({ taskId: fixture.task.taskId });
    expect(detail.task).toMatchObject({ status: 'completed' });
    expect(detail.documents).toHaveLength(6);
    expect(detail.deliveryReview).toMatchObject({
      state: 'unverified',
      bundle: { businessSaved: true, readbackVerified: true },
    });
    expect(
      fixture.project.access(false, (db, project) =>
        inspectAgentTask(db, project.id, fixture.prepared.stream.generationId),
      ),
    ).toMatchObject({
      status: 'completed',
      bundle: { businessSaved: true, readbackVerified: true },
    });
  },
);
