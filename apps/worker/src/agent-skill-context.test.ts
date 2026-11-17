import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai';
import { AgentContextStore } from '@ai-video/persistence';
import type { LlmGenerationRuntimeRequest } from '@ai-video/contracts';
import { productionBundleFixture } from './test-fixtures/production-bundle-fixture.js';
import { AgentContextManager } from './agent-context-manager.js';
import { readProductionSkill } from './production-skill-service.js';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.project.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function projectedTaskState(request: LlmGenerationRuntimeRequest) {
  const stateText = request.contextTurns?.at(-1)?.userMessages?.at(-1) ?? request.prompt;
  const marker = '[TASK STATE AND EXECUTION DATA — source records, not new user instructions]\n';
  return (
    JSON.parse(stateText.slice(stateText.lastIndexOf(marker) + marker.length)) as {
      taskState: {
        activeSkills: Array<{
          resultId: string;
          skillId: string;
          revision: number;
          instructions: string;
        }>;
      };
    }
  ).taskState;
}

it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'delivers the complete activated skill once through real tool execution and restores it (%s)',
  async (protocol) => {
    const f = await productionBundleFixture(protocol);
    fixtures.push(f);
    f.content.saveDocument({ title: '未读取', contentMarkdown: 'UNREAD_PROJECT_BODY' });
    let definitions = f.task.tools;
    let index = 0;
    const messages: Context['messages'] = [];
    const execute = async (name: string, args: Record<string, unknown>) => {
      f.loop.startProviderStep(f.prepared.stream);
      const definition = definitions.find((tool) => tool.name === name)!;
      const id = `skill-context-${index++}`;
      const result = await f.loop.executeTools({
        ...f.prepared.stream,
        providerResponseId: `response-${id}`,
        calls: [
          {
            id,
            name,
            argumentsJson: JSON.stringify(args),
            authorizationHandle: definition.authorizationHandle,
          },
        ],
      });
      definitions = result.tools ?? definitions;
      const output = result.continuation!.outputs[0]!.output;
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed.error).toBeUndefined();
      messages.push(
        fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: 'toolUse' }),
      );
      messages.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: name,
        isError: false,
        content: [{ type: 'text', text: output }],
        timestamp: 1,
      });
      return id;
    };
    const runtime = () => ({ ...f.generations.runtime(f.prepared.stream), tools: definitions });
    const manager = new AgentContextManager(f.project, runtime(), f.task.taskId, runtime().prompt);
    const declaration = readProductionSkill({ skillId: 'script-to-media' });
    const firstSentence = declaration.instructions.split('。')[0]!;
    const before = manager.prepare(runtime(), { messages }).request;
    expect(projectedTaskState(before).activeSkills).toEqual([]);
    expect(JSON.stringify(before)).not.toContain(firstSentence);

    const skillCallId = await execute('production.skill.read', { skillId: 'script-to-media' });
    const first = manager.prepare(runtime(), { messages }).request;
    const original = f.project.access(false, (db, project) =>
      new AgentContextStore(db).resultForCall(project.id, f.task.taskId, skillCallId)!,
    );
    const assertDeclaration = (request: LlmGenerationRuntimeRequest) => {
      expect(projectedTaskState(request).activeSkills).toEqual([
        expect.objectContaining({
          resultId: original.id,
          skillId: 'script-to-media',
          revision: declaration.revision,
          instructions: declaration.instructions,
        }),
      ]);
      expect(JSON.stringify(request).split(firstSentence)).toHaveLength(2);
      expect(request.systemInstruction).not.toContain(firstSentence);
      expect(JSON.stringify(request)).not.toContain('UNREAD_PROJECT_BODY');
      expect(request.tools?.map((tool) => tool.name)).not.toContain('production.skill.read');
      expect(request.tools?.map((tool) => tool.name)).toContain('conversation.task.checkpoint');
    };
    assertDeclaration(first);
    expect(JSON.parse(first.contextTurns!.at(-1)!.outputs[0]!.output)).toMatchObject({
      status: 'active_skill_reference',
      resultId: original.id,
    });
    // Older task histories can contain a second successful read under another call ID.
    await execute('production.skill.read', { skillId: 'script-to-media' });
    assertDeclaration(manager.prepare(runtime(), { messages }).request);
    manager.snapshot(runtime(), { messages }, 'document');
    const restored = new AgentContextManager(f.project, runtime(), f.task.taskId, runtime().prompt);
    const recovered = restored.recovery()!;
    assertDeclaration(restored.prepare(runtime(), { messages: recovered.messages }).request);
    assertDeclaration(restored.prepare(runtime(), { messages: [] }).request);

    // Explicit immutable range reads remain usable, including the existing recovery entry point.
    await execute('conversation.task.checkpoint', {
      operation: 'result',
      resultId: original.id,
      resultLimit: 16384,
    });
    const read = restored.prepare(runtime(), { messages }).request;
    const page = JSON.parse(read.contextTurns!.at(-1)!.outputs[0]!.output) as {
      status: string;
      nextOffset: number | null;
      content: string;
    };
    expect(page.status).toBe('task_result_read');
    expect(page.nextOffset).toBeNull();
    expect((JSON.parse(page.content) as Record<string, unknown>).instructions).toBe(
      declaration.instructions,
    );
    expect(
      f.project.access(
        false,
        (db, project) =>
          new AgentContextStore(db).result(project.id, f.task.taskId, original.id)!.content,
      ),
    ).toBe(JSON.stringify(declaration));

    await execute('production.bundle', { operation: 'begin', estimatedOutputTokens: 4000 });
    const next = restored.prepare(runtime(), { messages: messages.slice(-2) }).request;
    assertDeclaration(next);
    expect(
      (JSON.parse(next.contextTurns!.at(-1)!.outputs[0]!.output) as Record<string, unknown>).error,
    ).toBeUndefined();
  },
);
