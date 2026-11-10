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
  type PreparedArgumentsRef,
} from './agent-prepared-arguments.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { AgentProviderToolGateway } from './agent-provider-tool-gateway.js';
it('repairs the observed staging envelope errors without retransmitting or changing authored IR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-stage-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  try {
    projects.create(join(directory, 'project'), 'Stage recovery');
    projects.access(true, (db, p) => {
      const store = new AgentContextStore(db);
      const definition = preparedArgumentsDefinition(
        SYSTEM_AGENT_TOOLS.find((t) => t.name === 'scene.structure.stage')!,
      );
      const ir = {
        prompt: '完整场次正文。'.repeat(1000),
      };
      const args = {
        operation: 'put_scene',
        resourceId: 'workspace:shots',
        stageId: 'stage',
        sceneIndex: 0,
        expectedRowVersion: 7,
        scene: { title: '第一场', ...ir },
        title: '第一场',
        sceneDocumentId: null,
        characterDocumentIds: [],
      };
      const resolve = (tool: string, input: unknown) =>
        resolvePreparedArguments(store, p.id, 'task', tool, input);
      const gateway = new AgentProviderToolGateway(
        {
          executeTools: vi.fn(),
          confirmTool: vi.fn(),
          selectMedia: vi.fn(),
          startProviderStep: vi.fn(),
          completeProviderStep: vi.fn(),
          terminateGeneration: vi.fn(),
          resolveToolArguments: (_identity, tool, input) => resolve(tool, input),
          preserveToolArguments: (_identity, tool, input) =>
            preservePreparedArguments(store, p.id, 'task', tool, input),
        },
        {
          generationId: 'g',
          attemptId: 'a',
          projectId: p.id,
          projectSessionId: 's',
          conversationId: 'c',
        },
        [definition],
        vi.fn(),
        vi.fn(),
      );
      const prepare = gateway.tools()[0]!.prepareArguments!;
      let message = '';
      try {
        prepare(args);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Root title/sceneDocumentId/characterDocumentIds are unsupported');
      expect(message).toContain('No write occurred');
      expect(message).not.toContain(ir.prompt);
      const retry = JSON.parse(
        /preparedArguments=(\{[^\n]+?\})/.exec(message)![1]!,
      ) as PreparedArgumentsRef;
      expect(retry.deleteFields).toEqual(['title', 'sceneDocumentId', 'characterDocumentIds']);
      expect(
        () =>
          validateToolArguments(definition, {
            type: 'toolCall',
            id: 'raw-retry',
            name: definition.name,
            arguments: { preparedArguments: retry },
          }) as unknown,
      ).not.toThrow();
      const fixed = prepare({ preparedArguments: retry });
      expect(fixed).toEqual({
        operation: 'put_scene',
        resourceId: 'workspace:shots',
        stageId: 'stage',
        sceneIndex: 0,
        expectedRowVersion: 7,
        scene: { title: '第一场', ...ir },
      });
      expect(store.result(p.id, 'task', retry.resultId)?.arguments).toEqual(args);
      const missingTitle = { ...args, scene: { ...ir } };
      const ref = preservePreparedArguments(store, p.id, 'task', definition.name, missingTitle);
      expect(
        () =>
          validateToolArguments(definition, {
            type: 'toolCall',
            id: 'raw-nested-retry',
            name: definition.name,
            arguments: {
              preparedArguments: {
                ...ref,
                deleteFields: retry.deleteFields,
                setFields: { 'scene.title': '第一场' },
              },
            },
          }) as unknown,
      ).not.toThrow();
      expect(
        prepare({
          preparedArguments: {
            ...ref,
            deleteFields: retry.deleteFields,
            setFields: { 'scene.title': '第一场' },
          },
        }),
      ).toEqual(fixed);
      expect(store.result(p.id, 'task', ref.resultId)?.arguments).toEqual(missingTitle);
      const definitionRef = (definition.parameters.properties as Record<string, unknown>)
        .preparedArguments;
      expect(definitionRef).toMatchObject({
        properties: { setFields: { additionalProperties: false } },
      });
      for (const setFields of [
        { 'scene.prompt': '覆盖正文' },
        { expectedRowVersion: 8 },
        { stageId: 'other' },
        { 'scene.title': '' },
        { 'scene.title': '改名', scene: {} },
        null,
      ])
        expect(() =>
          resolve(definition.name, { preparedArguments: { ...ref, setFields } }),
        ).toThrow('SET_INVALID');
      expect(() =>
        resolve(definition.name, {
          preparedArguments: { ...ref, setFields: { 'scene.title': '改名' } },
          scene: args.scene,
        }),
      ).toThrow('SET_INVALID');
      expect(() =>
        resolve(definition.name, {
          preparedArguments: { ...ref, setFields: { 'scene.title': '改名' } },
          operation: 'put_shots',
        }),
      ).toThrow('SET_INVALID');
      const docRef = preservePreparedArguments(store, p.id, 'task', 'document.submit_draft', {
        title: '文档',
        contentMarkdown: ir.prompt,
      });
      expect(() =>
        resolve('document.submit_draft', {
          preparedArguments: { ...docRef, deleteFields: ['title'] },
        }),
      ).toThrow('DELETE_INVALID');
      expect(() =>
        resolve('document.submit_draft', {
          preparedArguments: { ...docRef, setFields: { 'scene.title': '改名' } },
        }),
      ).toThrow('SET_INVALID');
      expect(() =>
        resolvePreparedArguments(store, p.id, 'other', definition.name, { preparedArguments: ref }),
      ).toThrow('outside');
      expect(
        resolve(definition.name, { preparedArguments: { ...ref, argumentsHash: 'bad' } }),
      ).toEqual(missingTitle);
      expect(store.result(p.id, 'task', ref.resultId)?.arguments).toEqual(missingTitle);
    });
  } finally {
    projects.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it('restores full prepared arguments after restart, verifies scope and validates merged corrections', async () => {
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
      const chapter = SYSTEM_AGENT_TOOLS.find((t) => t.name === 'novel.chapter.write_draft')!;
      const body = '完整章节正文'.repeat(3000);
      const invalidChapter = {
        resourceId: 'workspace:novel',
        action: 'create_chapter',
        title: '第一章',
        contentMarkdown: body,
        baseVersionId: null,
        expectedDocumentRowVersion: 0,
      };
      const chapterRef = preservePreparedArguments(
        store,
        p.id,
        'task',
        chapter.name,
        invalidChapter,
      );
      const repaired = resolvePreparedArguments(store, p.id, 'task', chapter.name, {
        preparedArguments: {
          ...chapterRef,
          deleteFields: ['baseVersionId', 'expectedDocumentRowVersion'],
        },
      }) as Record<string, unknown>;
      expect(repaired.contentMarkdown).toBe(body);
      expect(
        validateToolArguments(chapter, {
          type: 'toolCall',
          id: 'chapter',
          name: chapter.name,
          arguments: repaired,
        }),
      ).toEqual(repaired);
      expect(() => {
        validateToolArguments(chapter, {
          type: 'toolCall',
          id: 'chapter',
          name: chapter.name,
          arguments: invalidChapter,
        });
      }).toThrow();
      expect(() => {
        validateToolArguments(chapter, {
          type: 'toolCall',
          id: 'chapter',
          name: chapter.name,
          arguments: { ...repaired, action: 'rewrite_chapter' },
        });
      }).toThrow();
      for (const deleteFields of [
        ['contentMarkdown'],
        ['projectId'],
        ['__proto__'],
        ['unknown'],
        ['baseVersionId', 'baseVersionId'],
      ])
        expect(() =>
          resolvePreparedArguments(store, p.id, 'task', chapter.name, {
            preparedArguments: { ...chapterRef, deleteFields },
          }),
        ).toThrow('DELETE_INVALID');
      expect(() =>
        resolvePreparedArguments(store, p.id, 'task', chapter.name, {
          preparedArguments: { ...chapterRef, deleteFields: ['baseVersionId'] },
          baseVersionId: 'new',
        }),
      ).toThrow('DELETE_INVALID');
      expect(store.result(p.id, 'task', chapterRef.resultId)?.arguments).toEqual(invalidChapter);
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
      expect(
        resolve('task', 'document.submit_draft', {
          preparedArguments: { ...ref, argumentsHash: 'damaged' },
        }),
      ).toEqual(args);
      const definition = preparedArgumentsDefinition(
        SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'document.submit_draft')!,
      );
      expect(
        (definition.parameters.properties as Record<string, { required?: string[] }>)
          .preparedArguments?.required,
      ).toEqual(['resultId']);
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
