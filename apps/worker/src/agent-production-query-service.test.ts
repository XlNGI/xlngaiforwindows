import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProductionQueryService } from './agent-production-query-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import { ProjectService } from './project-service.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
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
    schemaVersion: 1 as const,
    kind: 'scene' as const,
    prompt: '雨中观察'.repeat(1000),
    references: { sceneDocumentIds: [setting.id] },
    data: { custom: '原样返回' },
  };
  const scene = content.saveScene({ title: '雨夜', authoringIR: ir });
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
    authoringIR: { schemaVersion: 1, kind: 'shot', prompt: '她从雨中走入。' },
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
  expect(f.production.read(target).authoringIR).toEqual(f.ir);
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
