import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProductionQueryService } from './agent-production-query-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import { ProjectService } from './project-service.js';
const fixtures: Array<{
  projects: ProjectService;
  directory: string;
}> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.projects.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-production-query-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '分页');
  const content = new ContentService(projects);
  const setting = content.saveDocument({
    kind: 'scene',
    title: '古道',
    contentMarkdown: '古道资料',
  });
  const ir = {
    prompt: '雨中观察'.repeat(1000),
    bindings: {
      schemaVersion: 1 as const,
      ...{ sceneDocumentIds: [setting.id] },
    },
  };
  const scene = content.saveScene({ title: '雨夜', ...ir });
  const conversation = content.createConversation({ scopeType: 'project' });
  const identity = {
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    conversationId: conversation.id,
  };
  const production = new ProductionService(projects);
  return {
    projects,
    content,
    setting,
    scene,
    ir,
    identity,
    production,
    query: new AgentProductionQueryService(production),
  };
}
it('keeps structure reads body-free and pages the exact IR with view-specific unchanged responses', async () => {
  const f = await setup();
  const target = { kind: 'scene' as const, id: f.scene.id };
  const read = vi.spyOn(f.production, 'readForAgent');
  const structure = f.query.read(target, {}, f.identity, 'structure');
  expect(JSON.stringify(structure)).not.toContain(f.ir.prompt);
  let page = f.query.read(
    target,
    { view: 'authoring', ifVersion: structure.version, limit: 512 },
    f.identity,
    'authoring',
  );
  expect(page.status).toBe('read');
  let assembled = '';
  while (page.contentPage) {
    assembled += page.contentPage.text;
    if (page.complete) break;
    page = f.query.read(
      target,
      {
        view: 'authoring',
        offset: page.contentPage.nextOffset,
        expectedVersion: page.version,
        limit: 512,
      },
      f.identity,
      'authoring',
    );
  }
  expect(JSON.parse(assembled)).toEqual(f.ir);
  expect(read).toHaveBeenCalledOnce();
  expect(f.query.read(target, { ifVersion: page.version }, f.identity, 'authoring').status).toBe(
    'unchanged',
  );
  expect(() => f.query.read(target, { offset: 1 }, f.identity, 'authoring')).toThrow(
    'expectedVersion',
  );
  expect(() => f.query.read(target, { view: 'instruction' }, f.identity, 'authoring')).toThrow(
    'view',
  );
});
it('invalidates child IR, reference versions and provider defaults while preserving prompt text', async () => {
  const f = await setup();
  const target = { kind: 'scene' as const, id: f.scene.id };
  const first = f.query.read(target, {}, f.identity, 'structure');
  f.content.saveShot({
    sceneId: f.scene.id,
    title: '入场',
    ...{ prompt: '她从雨中走入。' },
  });
  const child = f.query.read(target, {}, f.identity, 'structure');
  expect(child.version).not.toBe(first.version);
  expect(() =>
    f.query.read(target, { offset: 1, expectedVersion: first.version }, f.identity, 'authoring'),
  ).toThrow('版本已变化');
  f.content.saveDocument({
    documentId: f.setting.id,
    kind: 'scene',
    title: f.setting.title,
    contentMarkdown: '资料新版本',
  });
  const reference = f.query.read(target, {}, f.identity, 'structure');
  expect(reference.version).not.toBe(child.version);
  f.production.saveDefaults({
    expectedRowVersion: 0,
    settings: { generation: { watermark: false } },
  });
  expect(f.query.read(target, {}, f.identity, 'structure').version).not.toBe(reference.version);
  expect(f.production.read(target)).toMatchObject(f.ir);
});
it('keeps an unchanged shot page valid after sibling edits while invalidating actual dependencies', async () => {
  const f = await setup();
  const makeShot = (title: string) =>
    f.content.saveShot({
      sceneId: f.scene.id,
      title,
      ...{
        prompt: title.repeat(400),
        bindings: {
          schemaVersion: 1 as const,
          ...{ sceneDocumentIds: [f.setting.id] },
        },
      },
    });
  const first = makeShot('第一镜');
  const second = makeShot('第二镜');
  const target = { kind: 'shot' as const, id: second.id };
  const sceneTarget = { kind: 'scene' as const, id: f.scene.id };
  const page = f.query.read(target, { limit: 512 }, f.identity, 'authoring');
  const sceneVersion = f.production.queryVersion(sceneTarget);
  f.content.saveShot({
    shotId: first.id,
    sceneId: first.sceneId,
    title: first.title,
    expectedRowVersion: first.rowVersion,
    ...{ prompt: '第一镜修订' },
  });
  expect(f.production.queryVersion(sceneTarget)).not.toBe(sceneVersion);
  expect(f.production.queryVersion(target)).toBe(page.version);
  expect(() =>
    f.query.read(
      target,
      { offset: page.contentPage!.nextOffset, expectedVersion: page.version, limit: 512 },
      f.identity,
      'authoring',
    ),
  ).not.toThrow();
  f.content.saveShot({
    shotId: second.id,

    expectedRowVersion: second.rowVersion,
    ...{ ...second, prompt: '第二镜自身修订' },
  });
  const ownVersion = f.production.queryVersion(target);
  expect(ownVersion).not.toBe(page.version);
  expect(() =>
    f.query.read(target, { expectedVersion: page.version }, f.identity, 'authoring'),
  ).toThrow('版本已变化');
  f.content.saveDocument({
    documentId: f.setting.id,
    kind: 'scene',
    title: f.setting.title,
    contentMarkdown: '当前镜引用的资料发生变化',
  });
  const referenceVersion = f.production.queryVersion(target);
  expect(referenceVersion).not.toBe(ownVersion);
  f.content.saveScene({
    sceneId: f.scene.id,
    title: '父场次修订',
    expectedRowVersion: f.scene.rowVersion,
  });
  const parentVersion = f.production.queryVersion(target);
  expect(parentVersion).not.toBe(referenceVersion);
  f.production.saveDefaults({
    expectedRowVersion: 0,
    settings: { generation: { watermark: false } },
  });
  expect(f.production.queryVersion(target)).not.toBe(parentVersion);
});
it('isolates cached snapshots across conversations and evicts older entries', async () => {
  const f = await setup();
  const read = vi.spyOn(f.production, 'readForAgent');
  const documents = Array.from({ length: 25 }, (_, i) =>
    f.content.saveDocument({ kind: 'scene', title: `资料${i}`, contentMarkdown: `正文${i}` }),
  );
  for (const document of documents)
    f.query.read({ kind: 'setting', id: document.id }, { view: 'text' }, f.identity, 'authoring');
  const target = { kind: 'setting' as const, id: documents[0]!.id };
  const result = f.query.read(target, { view: 'text' }, f.identity, 'authoring');
  expect(read).toHaveBeenCalledTimes(26);
  expect(
    f.query.read(target, { view: 'text', ifVersion: result.version }, f.identity, 'authoring')
      .status,
  ).toBe('unchanged');
  f.query.read(target, { view: 'text' }, { ...f.identity, conversationId: 'another' }, 'authoring');
  expect(read).toHaveBeenCalledTimes(27);
});
it('reads one shot with its scene and CAS and pages whole structure records with version checks', async () => {
  const f = await setup();
  const shots = Array.from({ length: 25 }, (_, i) =>
    f.content.saveShot({
      sceneId: f.scene.id,
      title: `镜头${i + 1}`,
      ...{
        prompt: `动作${i}`,
        bindings: {
          schemaVersion: 1 as const,
          ...{ sceneDocumentIds: [f.setting.id] },
        },
      },
    }),
  );
  const single = f.query.read({ kind: 'shot', id: shots[6]!.id }, {}, f.identity, 'authoring');
  expect(single).toMatchObject({
    shotId: shots[6]!.id,
    sceneId: f.scene.id,
    rowVersion: shots[6]!.rowVersion,
    authoring: { prompt: '动作6' },
    view: 'authoring',
  });
  const target = { kind: 'scene' as const, id: f.scene.id };
  const first = f.query.read(target, { recordLimit: 10 }, f.identity, 'structure');
  expect(first.contentPage).toBeUndefined();
  expect(first.recordPage).toMatchObject({
    offset: 0,
    nextOffset: 10,
    totalRecords: 25,
    unit: 'records',
  });
  const collected = [...first.recordPage!.records];
  let page = first;
  while (page.recordPage?.nextOffset !== undefined) {
    page = f.query.read(
      target,
      { recordOffset: page.recordPage.nextOffset, recordLimit: 10, expectedVersion: first.version },
      f.identity,
      'structure',
    );
    collected.push(...page.recordPage!.records);
  }
  expect(
    collected.map(
      (record) =>
        (
          record.value as {
            id: string;
          }
        ).id,
    ),
  ).toEqual(shots.map((shot) => shot.id));
  expect(() => f.query.read(target, { recordOffset: 10 }, f.identity, 'structure')).toThrow(
    'expectedVersion',
  );
  expect(() => f.query.read(target, { recordLimit: 21 }, f.identity, 'structure')).toThrow('1–20');
  const tailOnly = new AgentProductionQueryService(f.production);
  tailOnly.read(
    target,
    { recordOffset: 20, expectedVersion: first.version },
    f.identity,
    'structure',
  );
  expect(tailOnly.read(target, { ifVersion: first.version }, f.identity, 'structure').status).toBe(
    'read',
  );
  const media = f.query.read(target, { view: 'media', recordLimit: 1 }, f.identity, 'structure');
  expect(media.recordPage?.records[0]).toMatchObject({
    path: ['bindings', 0],
    value: { documentId: f.setting.id },
  });
  expect(media.contentPage).toBeUndefined();
  expect(() =>
    f.query.read(target, { view: 'media', recordLimit: 1, limit: 100 }, f.identity, 'structure'),
  ).toThrow('不能与字符');
  f.content.saveShot({
    shotId: shots[0]!.id,
    sceneId: f.scene.id,
    title: '已修改',
    expectedRowVersion: shots[0]!.rowVersion,
  });
  expect(() =>
    f.query.read(
      target,
      { recordOffset: 10, expectedVersion: first.version },
      f.identity,
      'structure',
    ),
  ).toThrow('版本已变化');
});
