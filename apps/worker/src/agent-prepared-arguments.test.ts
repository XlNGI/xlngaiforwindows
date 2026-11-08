import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentContextStore } from '@ai-video/persistence';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { ProjectService } from './project-service.js';
import {
  preparedArgumentsDefinition,
  preservePreparedArguments,
  resolvePreparedArguments,
} from './agent-prepared-arguments.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { AgentProviderToolGateway } from './agent-provider-tool-gateway.js';

it('restores full prepared arguments after restart, verifies scope/hash and validates merged corrections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-arguments-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  const root = join(directory, 'project');
  try {
    projects.create(root, 'Prepared');
    const args = {
      resourceId: 'workspace:documents',
      documentKind: 'plan',
      title: 'Saved candidate',
      contentMarkdown: '完整正文'.repeat(4000),
      expectedRevision: 'original-stale-version',
    };
    const ref = projects.access(true, (db, p) =>
      preservePreparedArguments(
        new AgentContextStore(db),
        p.id,
        'task',
        'document.submit_draft',
        args,
      ),
    );
    projects.close();
    projects.open(root);
    projects.access(true, (db, p) => {
      const store = new AgentContextStore(db);
      const resolve = (task: string, tool: string, input: unknown) =>
        resolvePreparedArguments(store, p.id, task, tool, input);
      const corrected = resolve('task', 'document.submit_draft', {
        preparedArguments: ref,
        title: 'Corrected',
      });
      expect(corrected).toEqual({ ...args, title: 'Corrected' });
      expect(resolve('task', 'document.submit_draft', { preparedArguments: ref })).toEqual(args);
      expect(() =>
        resolve('other-task', 'document.submit_draft', { preparedArguments: ref }),
      ).toThrow('outside');
      expect(() => resolve('task', 'scene.submit_structure', { preparedArguments: ref })).toThrow(
        'outside',
      );
      expect(() =>
        resolve('task', 'document.submit_draft', {
          preparedArguments: { ...ref, argumentsHash: 'damaged' },
        }),
      ).toThrow('INTEGRITY');
      const definition = preparedArgumentsDefinition(
        SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'document.submit_draft')!,
      );
      const validate = (arguments_: unknown): unknown =>
        validateToolArguments(definition, {
          type: 'toolCall',
          id: 'c',
          name: definition.name,
          arguments: arguments_ as Record<string, unknown>,
        }) as unknown;
      expect(validate(corrected)).toEqual(corrected);
      expect(() =>
        validate(resolve('task', definition.name, { preparedArguments: ref, unknown: true })),
      ).toThrow();
      expect(() =>
        validate(
          resolve('task', definition.name, { preparedArguments: ref, contentMarkdown: null }),
        ),
      ).toThrow();
      const executeTools = vi.fn();
      const gateway = new AgentProviderToolGateway(
        {
          executeTools,
          confirmTool: vi.fn(),
          selectMedia: vi.fn(),
          startProviderStep: vi.fn(),
          completeProviderStep: vi.fn(),
          terminateGeneration: vi.fn(),
          resolveToolArguments: (_identity, tool, input) => resolve('task', tool, input),
          preserveToolArguments: (_identity, tool, input) =>
            preservePreparedArguments(store, p.id, 'task', tool, input),
        },
        {
          generationId: 'g',
          attemptId: 'a',
          projectId: p.id,
          projectSessionId: 's',
          conversationId: 'conversation',
        },
        [definition],
        vi.fn(),
        vi.fn(),
      );
      const prepare = gateway.tools()[0]!.prepareArguments!;
      let failure = '';
      try {
        prepare({ ...args, title: null });
      } catch (error) {
        failure = (error as Error).message;
      }
      expect(failure).toContain('preparedArguments');
      const returned = JSON.parse(
        /preparedArguments=(\{[^\n]+?\})/.exec(failure)![1]!,
      ) as typeof ref;
      expect(prepare({ preparedArguments: returned, title: args.title })).toEqual(args);
      expect(() => prepare({ preparedArguments: ref, contentMarkdown: null })).toThrow();
      expect(() => prepare({ preparedArguments: ref, extra: 'invalid' })).toThrow();
      expect(executeTools).not.toHaveBeenCalled();
      expect(store.result(p.id, 'task', ref.resultId)?.arguments).toEqual(args);
      db.prepare('UPDATE agent_context_results SET arguments_json=? WHERE id=?').run(
        '{"title":"tampered"}',
        ref.resultId,
      );
      expect(() => resolve('task', definition.name, { preparedArguments: ref })).toThrow(
        'INTEGRITY',
      );
    });
  } finally {
    projects.close();
    await rm(directory, { recursive: true, force: true });
  }
});
