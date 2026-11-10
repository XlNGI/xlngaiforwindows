import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  productionBundleFixture,
  bundlePart,
  bundleManifest,
} from './test-fixtures/production-bundle-fixture.js';
import { loadBundle, bundleObjects } from './production-bundle-state.js';
import { AgentContextStore } from '@ai-video/persistence';
import { inspectAgentTask } from './agent-task-inspection.js';
import { bundleCompletion, ProductionBundleService } from './production-bundle-service.js';
import { AgentContextManager } from './agent-context-manager.js';
import { readProductionSkill } from './production-skill-service.js';
import type { Context } from '@earendil-works/pi-ai';
const fixtures: Awaited<ReturnType<typeof productionBundleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.project.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
const setup = async () => {
  const f = await productionBundleFixture();
  fixtures.push(f);
  return f;
};
it('reads source prose with exact quotes and newlines in contiguous ordinary text pages', async () => {
  const f = await setup();
  const text = '  原文“引号”\r\n下一行\n字面\\n和😀尾部  ';
  const doc = f.content.saveDocument({ kind: 'plan', title: '复用输入', contentMarkdown: text });
  f.stage({
    operation: 'begin',
    estimatedOutputTokens: 1000,
    reused: [{ documentId: doc.id, versionId: doc.currentVersion!.id }],
  });
  let offset = 0,
    full = '';
  for (;;) {
    const page = f.stage({ operation: 'source', documentId: doc.id, offset, limit: 13 }) as {
      view: string;
      contentPage: { text: string; nextOffset?: number };
    };
    expect(page.view).toBe('ordinary-source-text-v1');
    full += page.contentPage.text;
    if (page.contentPage.nextOffset === undefined) break;
    offset = page.contentPage.nextOffset;
  }
  expect(full.slice(full.indexOf('\n\ncontentMarkdown:\n') + '\n\ncontentMarkdown:\n'.length)).toBe(
    text,
  );
});
it('keeps explicit source and skill result references after history clears without reinjecting bodies', async () => {
  const f = await setup();
  f.content.saveDocument({ title: '未读取', contentMarkdown: 'UNREAD_BODY_MUST_STAY_OUT' });
  const runtime = { ...f.generations.runtime(f.prepared.stream), tools: f.task.tools };
  const manager = new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt);
  const before = manager.prepare(runtime, { messages: [] }).request;
  expect(before.tools?.map((tool) => tool.name)).toContain('production.skill.read');
  expect(JSON.stringify(before)).not.toContain('EXPLICITLY_READ_SUPPLEMENT');
  const messages: Context['messages'] = [];
  for (const [id, name, args, result] of [
    [
      'extra-source',
      'library.read',
      { sourceHandle: 'returned-handle' },
      {
        sourceType: 'novel-chapter',
        sourceId: 'explicit-source',
        versionId: 'v1',
        sourceStatus: 'draft',
        title: '按需补充的章节',
        content: 'EXPLICITLY_READ_SUPPLEMENT',
      },
    ],
    [
      'skill',
      'production.skill.read',
      { skillId: 'script-to-media' },
      readProductionSkill({ skillId: 'script-to-media' }),
    ],
  ] as const) {
    messages.push({
      role: 'assistant',
      api: 'openai-responses',
      provider: 'mock',
      model: 'mock',
      stopReason: 'toolUse',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: 'toolCall', id, name, arguments: args }],
      timestamp: 1,
    });
    messages.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      timestamp: 2,
    });
  }
  manager.observe({ messages });
  const after = new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt).prepare(
    runtime,
    { messages: [] },
  ).request;
  const sourceResult = f.project.access(false, (db, project) =>
    new AgentContextStore(db).resultForCall(project.id, f.task.taskId, 'extra-source'),
  );
  expect(sourceResult).toBeDefined();
  expect(JSON.stringify(after)).toContain(sourceResult!.id);
  expect(JSON.stringify(after)).not.toContain('EXPLICITLY_READ_SUPPLEMENT');
  expect(JSON.stringify(after)).not.toContain('UNREAD_BODY_MUST_STAY_OUT');
  expect(JSON.stringify(after)).not.toContain(
    readProductionSkill({ skillId: 'script-to-media' }).instructions,
  );
  expect(after.tools?.map((tool) => tool.name)).not.toContain('production.skill.read');
  expect(after.prompt).toContain('activeSkills');
});
it.each(['openai-responses', 'openai-chat-completions'] as const)(
  'sends current batch-read candidate text once and removes stale history after repair (%s)',
  async (protocol) => {
    const f = await productionBundleFixture(protocol);
    fixtures.push(f);
    const part = bundlePart();
    f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
    f.stage({ operation: 'put', partKey: 'first', expectedRevision: 0, part });
    const args = {
      operation: 'read_many',
      expectedRevision: 1,
      items: [{ localKey: 'hero' }, { localKey: 'room' }],
    };
    const result = f.stage(args);
    const context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'read-batch', name: 'production.bundle', arguments: args },
          ],
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'read-batch',
          toolName: 'production.bundle',
          isError: false,
          timestamp: 2,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        },
      ],
    } as Context;
    const runtime = f.generations.runtime(f.prepared.stream);
    const request = () =>
      JSON.stringify(
        new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt).prepare(
          runtime,
          context,
        ).request,
      );
    expect(request().split('主角的完整提示词。')).toHaveLength(2);
    expect(request().split('房间的完整提示词。')).toHaveLength(2);
    part.documents[0]!.contentMarkdown = '尚未读取的新角色正文。';
    f.stage({
      operation: 'put',
      partKey: 'repair',
      expectedRevision: 1,
      part: { documents: [part.documents[0]!], scenes: [], shots: [] },
    });
    const after = request();
    expect(after).not.toContain('主角的完整提示词。');
    expect(after).not.toContain('尚未读取的新角色正文。');
    expect(after.split('房间的完整提示词。')).toHaveLength(2);
    const currentRead = f.stage({ operation: 'read', localKey: 'hero' }) as {
      contentPage: { text: string };
    };
    expect(currentRead.contentPage.text).toContain('尚未读取的新角色正文。');
    expect(request()).not.toContain('尚未读取的新角色正文。');
    f.project.access(false, (db, p) => {
      expect(
        new AgentContextStore(db).resultForCall(p.id, f.task.taskId, 'read-batch')?.content,
      ).toBe(JSON.stringify(result));
    });
  },
);
it('keeps candidate pages in Result Store and injects them only when the current turn reads them', async () => {
  const f = await setup(),
    part = bundlePart();
  f.stage({ operation: 'begin', estimatedOutputTokens: 4000 });
  const staged = f.stage({ operation: 'put', partKey: 'first', expectedRevision: 0, part });
  expect(staged).toMatchObject({
    objects: expect.arrayContaining([
      expect.objectContaining({ localKey: 'room', kind: 'location', title: '房间' }),
      expect.objectContaining({ localKey: 'scene-1', kind: 'scene', title: '接听电话' }),
      expect.objectContaining({ localKey: 'shot-1', kind: 'shot', sceneKey: 'scene-1' }),
    ]) as unknown,
  });
  expect(JSON.stringify(staged)).not.toContain('主角的完整提示词。');
  const pending = f.project.access(false, (db, p) => bundleCompletion(db, p.id, f.task.taskId));
  expect(pending[0]).toMatchObject({
    candidateTotal: 8,
    candidates: expect.arrayContaining([
      { localKey: 'room', kind: 'location', title: '房间' },
    ]) as unknown,
  });
  expect(pending[0]).not.toHaveProperty('semanticReview');
  expect(JSON.stringify(pending)).not.toContain('主角的完整提示词。');
  expect(JSON.stringify(pending)).not.toContain('review text across the full deliverable');
  const firstRead = f.stage({ operation: 'read', localKey: 'hero' }) as {
    contentPage: { text: string };
  };
  expect(firstRead.contentPage.text).toContain('主角的完整提示词。');
  const runtime = f.generations.runtime(f.prepared.stream);
  const request = () =>
    new AgentContextManager(f.project, runtime, f.task.taskId, runtime.prompt).prepare(runtime, {
      messages: [],
    }).request;
  expect(request().prompt).not.toContain('主角的完整提示词。');
  expect(request().prompt).not.toContain('客服的完整提示词。');
  part.documents[0]!.contentMarkdown = '尚未读取的新角色正文。';
  f.stage({
    operation: 'put',
    partKey: 'changed',
    expectedRevision: 1,
    part: {
      documents: [part.documents[0]!],
      scenes: [],
      shots: [],
    },
  });
  expect(request().prompt).not.toContain('主角的完整提示词。');
  expect(request().prompt).not.toContain('尚未读取的新角色正文。');
  const revisedRead = f.stage({ operation: 'read', localKey: 'hero' }) as {
    contentPage: { text: string };
  };
  expect(revisedRead.contentPage.text).toContain('尚未读取的新角色正文。');
  expect(request().prompt).not.toContain('尚未读取的新角色正文。');
});
it('directs an unfinished package to source reads and creation without semantic review state', async () => {
  const f = await setup();
  f.stage({ operation: 'begin', estimatedOutputTokens: 1000 });
  const pending = () =>
    f.project.access(false, (db, p) => bundleCompletion(db, p.id, f.task.taskId)[0]!);
  expect(pending()).not.toHaveProperty('semanticReview');
  expect(pending()).not.toHaveProperty('unread');
  const service = new ProductionBundleService(f.project, f.content, f.workflow, JSON.stringify);
  expect(service.execute({ operation: 'check' }, f.identity)).not.toHaveProperty('semanticReview');
  expect(pending()).toMatchObject({
    nextAction: { arguments: { operation: 'source', documentId: f.source.id } },
  });
  f.stage({ operation: 'source', documentId: f.source.id });
  expect(pending()).toMatchObject({
    nextAction: { toolName: 'production.bundle.submit', expectedRevision: 0 },
  });
  expect(
    f.project.access(false, (db) =>
      db
        .prepare(
          "SELECT COUNT(*) n FROM agent_context_results WHERE tool_name='task.review.snapshot'",
        )
        .get(),
    ),
  ).toEqual({ n: 0 });
});
it('preserves retired candidate evidence and requires a new task', async () => {
  const f = await setup();
  f.stage({ operation: 'begin', estimatedOutputTokens: 1000 });
  f.project.access(true, (db, p) => {
    const store = new AgentContextStore(db);
    const before = store.resultForCall(p.id, f.task.taskId, 'production-bundle:state')!;
    db.prepare(
      "UPDATE agent_context_results SET tool_name='production.bundle.retired' WHERE id=?",
    ).run(before.id);
    expect(() => loadBundle(db, p.id, f.task.taskId)).toThrow(
      `BUNDLE_CANDIDATE_RETIRED: Candidate result ${before.id}`,
    );
    expect(store.result(p.id, f.task.taskId, before.id)).toMatchObject({
      content: before.content,
      contentHash: before.contentHash,
    });
    expect(inspectAgentTask(db, p.id, f.prepared.stream.generationId)).toMatchObject({
      available: true,
      retiredBundle: { status: 'bundle_candidate_retired', resultId: before.id },
    });
  });
  expect(() => f.stage({ operation: 'begin', estimatedOutputTokens: 1000 })).toThrow(
    'BUNDLE_CANDIDATE_RETIRED',
  );
  expect(f.content.listDocuments()).toHaveLength(1);
  expect(f.content.listScenes()).toHaveLength(0);
  expect(f.workflow.getTask({ taskId: f.task.taskId }).deliveryReview?.state).toBe('unverified');
});
it('invalidates a reused voice when only audition text changes', async () => {
  const f = await setup();
  const voice = f.content.saveDocument({
    kind: 'voice',
    title: '复用音色',
    contentMarkdown: '音色描述',
    sampleText: '原试音',
  });
  f.stage({
    operation: 'begin',
    estimatedOutputTokens: 1000,
    reused: [{ documentId: voice.id, versionId: voice.currentVersion!.id }],
  });
  f.project.access(true, (db) =>
    db
      .prepare('UPDATE document_versions SET sample_text=? WHERE id=?')
      .run('用户修改试音', voice.currentVersion!.id),
  );
  expect(() =>
    f.stage({ operation: 'put', expectedRevision: 0, partKey: 'whole', part: bundlePart() }),
  ).toThrow('BUNDLE_SOURCE_CONFLICT');
});
it('stages complete candidates without saving business objects, resumes and replays a lost acknowledgement', async () => {
  const f = await setup(),
    part = bundlePart();
  expect(f.stage({ operation: 'begin', estimatedOutputTokens: 50000 })).toMatchObject({
    revision: 0,
    businessSaved: false,
    budget: { recommendedMode: 'partitioned' },
  });
  const put = { operation: 'put', partKey: 'first', expectedRevision: 0, part };
  const unfinished = f.stage(put);
  expect(unfinished).toMatchObject({ revision: 1, objectCount: 8 });
  expect(unfinished.instruction).toContain('Continue submitting complete prompt objects');
  expect(f.stage(put)).toMatchObject({ revision: 1 });
  expect(f.content.listDocuments()).toHaveLength(1);
  expect(f.content.listScenes()).toHaveLength(0);
  f.project.close();
  f.project.open(`${f.root}/project`);
  expect(f.stage({ operation: 'state' })).toMatchObject({ revision: 1, objectCount: 8 });
  const sealed = f.stage({ operation: 'seal', expectedRevision: 1, manifest: bundleManifest() });
  expect(sealed).toMatchObject({ status: 'bundle_candidate_ready', businessSaved: false });
  expect(sealed.instruction).toContain('sealed');
  f.project.access(false, (db, p) => {
    const s = loadBundle(db, p.id, f.task.taskId)!;
    expect(bundleObjects(db, p.id, f.task.taskId, s).get('shot-1')).toEqual(part.shots[0]);
  });
});
it('rejects missing output, changed transport slot, stale read and wrong revision', async () => {
  const f = await setup();
  f.stage({ operation: 'begin', estimatedOutputTokens: 1000 });
  f.stage({ operation: 'put', partKey: 'a', expectedRevision: 0, part: bundlePart() });
  expect(() =>
    f.stage({
      operation: 'seal',
      expectedRevision: 1,
      manifest: { ...bundleManifest(), shotKeys: ['missing'] },
    }),
  ).toThrow('INCOMPLETE');
  expect(() =>
    f.stage({
      operation: 'put',
      partKey: 'a',
      expectedRevision: 1,
      part: { documents: [], scenes: [], shots: [] },
    }),
  ).toThrow('PART_CONFLICT');
  expect(() => f.stage({ operation: 'read', localKey: 'shot-1', expectedHash: 'old' })).toThrow(
    'READ_STALE',
  );
  expect(() =>
    f.stage({ operation: 'seal', expectedRevision: 0, manifest: bundleManifest() }),
  ).toThrow('REVISION_CONFLICT');
  expect(f.stage({ operation: 'read', localKey: 'shot-1', limit: 20 })).toMatchObject({
    contentPage: { offset: 0, nextOffset: 20 },
  });
});
it('protects original source versions and rejects candidates for a cancelled task', async () => {
  const f = await setup();
  f.stage({ operation: 'begin', estimatedOutputTokens: 1000 });
  f.content.saveDocument({
    documentId: f.source.id,
    title: f.source.title,
    contentMarkdown: '人工改稿',
    expectedDocumentRowVersion: f.source.rowVersion,
  });
  expect(() => f.stage({ operation: 'state' })).toThrow('SOURCE_CONFLICT');
  f.project.access(true, (db) =>
    db.prepare("UPDATE agent_tasks SET status='cancelled' WHERE id=?").run(f.task.taskId),
  );
  expect(() =>
    f.stage({ operation: 'put', partKey: 'a', expectedRevision: 0, part: bundlePart() }),
  ).toThrow('INACTIVE');
});
