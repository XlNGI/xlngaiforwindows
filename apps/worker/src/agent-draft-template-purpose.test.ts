import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { PromptTemplateKind } from '@ai-video/contracts';
import { AgentContextManager } from './agent-context-manager.js';
import { AgentDraftSubmissionService } from './agent-draft-submission-service.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { productionBundleFixture } from './test-fixtures/production-bundle-fixture.js';

const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.project.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await productionBundleFixture();
  fixtures.push(f);
  const runtime = f.generations.runtime(f.prepared.stream);
  runtime.tools = [SYSTEM_AGENT_TOOLS.find((t) => t.name === 'document.submit_draft')!];
  runtime.promptTemplateSnapshot = {
    conversationId: f.conversation.id,
    content: '历史通用文字不能用于本次创作',
    policyVersion: 2,
    rowVersion: 7,
    templates: {
      'character-image': '用户自定义角色约束',
      'scene-image': '用户自定义场景约束',
      'prop-image': '',
    },
  };
  const manager = new AgentContextManager(
    f.project,
    f.prepared.stream,
    f.task.taskId,
    runtime.prompt,
  );
  const persistRuntime = () => manager.snapshot(runtime, { messages: [] }, 'document');
  const project = (purpose?: PromptTemplateKind) => {
    runtime.promptWorkflow = purpose;
    persistRuntime();
    return manager.prepare(runtime, { messages: [] }).request;
  };
  const service = new AgentDraftSubmissionService(f.project, f.workflow);
  const submit = (args: Record<string, unknown>) => {
    const toolCallId = randomUUID();
    f.project.access(true, (db, p) =>
      db
        .prepare(
          `INSERT INTO agent_tool_calls
      (id,project_id,task_id,tool_name,arguments_summary_json,normalized_arguments_hash,status,created_at,redaction_state,idempotency_key)
      VALUES (?,?,?,'document.submit_draft',?,'fixture','executing',?,'native',?)`,
        )
        .run(
          toolCallId,
          p.id,
          f.task.taskId,
          JSON.stringify(args),
          new Date().toISOString(),
          toolCallId,
        ),
    );
    return service.submit('document.submit_draft', args, { ...f.identity, toolCallId });
  };
  persistRuntime();
  return { ...f, runtime, manager, persistRuntime, projectRequest: project, submit };
}
const draft = (kind: 'character' | 'scene' | 'prop') => ({
  resourceId: 'workspace:characters',
  documentKind: kind,
  title: `专项${kind}`,
  contentMarkdown: '模型创作的完整可编辑提示词',
});

it.each([
  ['character', 'character-image'],
  ['scene', 'scene-image'],
  ['prop', 'prop-image'],
] as const)(
  'rejects unscoped %s drafts and accepts their actual frozen %s template, including empty text',
  async (kind, purpose) => {
    const f = await fixture();
    const before = f.content.listDocuments().length;
    expect(() => f.submit(draft(kind))).toThrow('PROMPT_TEMPLATE_PURPOSE_REQUIRED');
    f.projectRequest(kind === 'scene' ? 'character-image' : 'scene-image');
    expect(() => f.submit(draft(kind))).toThrow('PROMPT_TEMPLATE_PURPOSE_REQUIRED');
    expect(f.content.listDocuments()).toHaveLength(before);
    const projected = f.projectRequest(purpose);
    expect(projected.prompt).not.toContain('历史通用文字不能用于本次创作');
    if (kind !== 'prop')
      expect(projected.prompt).toContain(f.runtime.promptTemplateSnapshot!.templates![purpose]!);
    expect(f.submit(draft(kind))).toMatchObject({ status: 'draft_saved' });
    const saved = f.content.listDocuments().find((d) => d.title === draft(kind).title)!;
    expect(f.content.getDocument(saved.id).currentVersion!.contentMarkdown).toBe(
      draft(kind).contentMarkdown,
    );
  },
);

it('rejects stale template version or content evidence and supports an explicit CAS edit after recovery', async () => {
  const f = await fixture();
  f.projectRequest('character-image');
  f.runtime.promptTemplateSnapshot!.rowVersion++;
  f.persistRuntime();
  expect(() => f.submit(draft('character'))).toThrow('PROMPT_TEMPLATE_PURPOSE_REQUIRED');
  f.projectRequest('character-image');
  f.runtime.promptTemplateSnapshot!.templates!['character-image'] = '修改后的用户约束';
  f.persistRuntime();
  expect(() => f.submit(draft('character'))).toThrow('PROMPT_TEMPLATE_PURPOSE_REQUIRED');
  f.projectRequest('character-image');
  const saved = f.submit(draft('character'));
  const recovered = new AgentContextManager(
    f.project,
    f.prepared.stream,
    f.task.taskId,
    f.runtime.prompt,
  );
  const recovery = recovered.recovery()!;
  const request = recovered.prepare(recovery.runtime, { messages: [] }).request;
  expect(request.prompt).toContain('修改后的用户约束');
  expect(
    f.submit({
      ...draft('character'),
      resourceId: `document:${String(saved.documentId)}`,
      documentId: saved.documentId,
      expectedDocumentRowVersion: saved.documentRowVersion,
      baseVersionId: saved.documentVersionId,
      contentMarkdown: '按用户修改后的约束修订正文',
    }),
  ).toMatchObject({ status: 'draft_saved', documentId: saved.documentId });
});

it('preserves ordinary documents and novel character references without injecting production templates', async () => {
  const f = await fixture();
  f.projectRequest();
  expect(
    f.submit({
      resourceId: 'workspace:documents',
      documentKind: 'note',
      title: '讨论记录',
      contentMarkdown: '普通文档',
    }),
  ).toMatchObject({ status: 'draft_saved' });
  expect(
    f.submit({
      ...draft('character'),
      resourceId: 'workspace:novel',
      bindingRole: 'character-bible',
    }),
  ).toMatchObject({ status: 'draft_saved', domainScope: 'novel' });
});

it('retains historical task contracts without requiring the new purpose gate', async () => {
  const f = await fixture();
  delete f.runtime.promptTemplateSnapshot!.policyVersion;
  f.persistRuntime();
  expect(f.submit(draft('character'))).toMatchObject({ status: 'draft_saved' });
});
