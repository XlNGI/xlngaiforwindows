import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProductionInstruction, ProductionTarget } from '@ai-video/contracts';
import { AgentProductionQueryService } from './agent-production-query-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import { ProjectService } from './project-service.js';
import { AgentSystemToolService } from './agent-system-tool-service.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.projects.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
const instruction = (summary: string): ProductionInstruction => ({
  version: 1,
  summary,
  subjects: [],
  visual: {},
  beats: [],
  audio: { mode: 'auto' },
  generation: {},
  resources: [],
  continuity: { predecessors: [], before: [], after: [], locked: [], constraints: [] },
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-production-query-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '分页');
  const content = new ContentService(projects);
  const setting = content.saveDocument({
    kind: 'scene',
    title: '车站',
    contentMarkdown: '场景资料',
  });
  const scene = content.saveScene({ title: '雨夜', sceneDocumentId: setting.id });
  const shot = content.saveShot({ sceneId: scene.id, title: '入场' });
  const conversation = content.createConversation({ title: '会话', scopeType: 'project' });
  const identity = {
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    conversationId: conversation.id,
  };
  const production = new ProductionService(projects);
  return {
    directory,
    projects,
    project,
    content,
    setting,
    scene,
    shot,
    identity,
    production,
    query: new AgentProductionQueryService(production),
  };
}

it('evicts old query snapshots and ignores unrelated chat writes while retaining view isolation', async () => {
  const f = await setup();
  const read = vi.spyOn(f.production, 'readForAgent');
  const documents = Array.from({ length: 25 }, (_, i) =>
    f.content.saveDocument({ kind: 'scene', title: `资料${i}`, contentMarkdown: `正文${i}` }),
  );
  const target = { kind: 'setting' as const, id: documents[0]!.id };
  for (const document of documents)
    f.query.read({ kind: 'setting', id: document.id }, { view: 'text' }, f.identity, 'instruction');
  expect(read).toHaveBeenCalledTimes(25);
  const result = f.query.read(target, { view: 'text' }, f.identity, 'instruction');
  expect(read).toHaveBeenCalledTimes(26);
  f.content.createConversation({ scopeType: 'project', title: '无关会话' });
  expect(
    f.query.read(target, { view: 'text', ifVersion: result.version }, f.identity, 'instruction')
      .status,
  ).toBe('unchanged');
  expect(read).toHaveBeenCalledTimes(26);
  expect(
    f.query.read(
      target,
      { view: 'instruction', ifVersion: result.version },
      f.identity,
      'instruction',
    ).status,
  ).toBe('read');
  f.query.read(
    target,
    {},
    { ...f.identity, conversationId: 'another-conversation' },
    'instruction',
  );
  expect(read).toHaveBeenCalledTimes(27);
});

it('shares versioned snapshots across views, pages long Chinese JSON losslessly and invalidates child/manual/reference/default changes', async () => {
  const f = await setup();
  const target = { kind: 'scene' as const, id: f.scene.id };
  const spec = {
    ...instruction('雨中观察'.repeat(750)),
    visual: { environment: '车站月台'.repeat(750), lighting: '冷色顶光'.repeat(750) },
  };
  f.production.execute({
    executionKey: 'long',
    operations: [
      { action: 'set_prompt', target, expectedRowVersion: f.scene.rowVersion, instruction: spec },
    ],
  });
  for (let i = 0; i < 8; i++)
    f.content.saveShot({
      sceneId: f.scene.id,
      title: `镜头${i}`,
      prompt: '长中文动作'.repeat(500),
    });
  const read = vi.spyOn(f.production, 'readForAgent');
  const structure = f.query.read(target, {}, f.identity, 'structure');
  expect(Buffer.byteLength(JSON.stringify(structure))).toBeLessThan(65536);
  expect(JSON.stringify(structure)).not.toContain('长中文动作');
  expect(structure).toMatchObject({ scene: { id: f.scene.id } });
  expect(Array.isArray(structure.shots)).toBe(true);
  let page = f.query.read(
    target,
    { view: 'instruction', ifVersion: structure.version },
    f.identity,
    'instruction',
  );
  expect(page.status).toBe('read'); // A directory never substitutes for the instruction body.
  let assembled = '';
  while (page.contentPage) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
    assembled += page.contentPage.text;
    if (page.complete) break;
    page = f.query.read(
      target,
      { view: 'instruction', offset: page.contentPage.nextOffset, expectedVersion: page.version },
      f.identity,
      'instruction',
    );
  }
  expect(JSON.parse(assembled)).toEqual(spec);
  expect(read).toHaveBeenCalledOnce();
  expect(
    f.query.read(target, { ifVersion: page.version }, f.identity, 'instruction'),
  ).toMatchObject({ status: 'unchanged' });
  f.content.saveShot({
    shotId: f.shot.id,
    sceneId: f.scene.id,
    title: f.shot.title,
    prompt: '手工修改',
    expectedRowVersion: f.shot.rowVersion,
  });
  expect(f.production.read(target).rowVersion).toBe(structure.rowVersion);
  const changed = f.query.read(target, { ifVersion: page.version }, f.identity, 'structure');
  expect(changed.version).not.toBe(page.version);
  expect(read).toHaveBeenCalledTimes(2);
  expect(() =>
    f.query.read(
      target,
      { offset: 4096, expectedVersion: page.version },
      f.identity,
      'instruction',
    ),
  ).toThrow('版本已变化');
  expect(() => f.query.read(target, { offset: 1 }, f.identity, 'instruction')).toThrow(
    'expectedVersion',
  );
  f.content.saveDocument({
    documentId: f.setting.id,
    kind: 'scene',
    title: '车站',
    contentMarkdown: '新场景版本',
  });
  const reference = f.query.read(target, {}, f.identity, 'instruction');
  expect(reference.version).not.toBe(changed.version);
  expect(reference.stale).toBe(true);
  f.production.saveDefaults({ expectedRowVersion: 0, settings: { visual: { style: '水彩' } } });
  expect(f.query.read(target, {}, f.identity, 'instruction').version).not.toBe(reference.version);
});

it('invalidates external predecessor and asset-file changes, scopes cache to sessions and preserves current text on stale instructions', async () => {
  const f = await setup();
  const prior = f.content.saveScene({ title: '前场' });
  const predecessor = { kind: 'scene' as const, id: prior.id };
  const target: ProductionTarget = { kind: 'shot', id: f.shot.id };
  const path = join(f.project.rootPath, 'assets/images/reference.png');
  await writeFile(path, 'image');
  f.projects.access(true, (db, project) =>
    db
      .prepare(
        "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES('reference',?,'generated-image','assets/images/reference.png','hash',5,'now')",
      )
      .run(project.id),
  );
  const spec = instruction('当前镜头');
  spec.resources = [
    { kind: 'prop-image', assetId: 'reference', required: true, purpose: '道具参考' },
  ];
  spec.continuity.predecessors = [predecessor];
  spec.continuity.before = [{ key: 'door', value: 'open' }];
  const priorInstruction = instruction('前场内容');
  priorInstruction.continuity.after = [{ key: 'door', value: 'open' }];
  f.production.execute({
    executionKey: 'dependency',
    operations: [
      {
        action: 'set_prompt',
        target: predecessor,
        expectedRowVersion: prior.rowVersion,
        instruction: priorInstruction,
      },
      { action: 'set_prompt', target, expectedRowVersion: f.shot.rowVersion, instruction: spec },
    ],
  });
  const first = f.query.read(target, {}, f.identity, 'instruction');
  expect(first.issueCount).toBe(0);
  expect(f.production.read({ kind: 'scene', id: f.scene.id }).issues).toEqual([]);
  f.production.execute({
    executionKey: 'predecessor-change',
    operations: [
      {
        action: 'set_prompt',
        target: predecessor,
        expectedRowVersion: f.production.read(predecessor).rowVersion,
        instruction: instruction('前场新内容'),
      },
    ],
  });
  const next = f.query.read(target, { ifVersion: first.version }, f.identity, 'instruction');
  expect(next.version).not.toBe(first.version);
  await unlink(path);
  const removed = f.query.read(target, {}, f.identity, 'instruction');
  expect(removed.version).not.toBe(next.version);
  f.content.saveShot({
    shotId: f.shot.id,
    sceneId: f.scene.id,
    title: f.shot.title,
    prompt: '手工保留',
    expectedRowVersion: first.rowVersion,
  });
  expect(f.query.read(target, { view: 'text' }, f.identity, 'instruction')).toMatchObject({
    text: '手工保留',
    stale: true,
  });
  const tools = new AgentSystemToolService(f.projects, f.content, {} as never, {} as never);
  tools.execute('production.read', { target }, f.identity);
  f.projects.close();
  f.projects.open(join(f.directory, 'project'));
  expect(() => tools.execute('production.read', { target }, f.identity)).toThrow(
    'current project session',
  );
  expect(
    tools.execute(
      'production.read',
      { target },
      { ...f.identity, projectSessionId: f.projects.currentSessionId()! },
    ),
  ).toMatchObject({ target, stale: true });
  f.projects.close();
  f.projects.create(join(f.directory, 'other'), '另一个项目');
  expect(() => tools.execute('production.read', { target }, f.identity)).toThrow(
    'current project session',
  );
});
