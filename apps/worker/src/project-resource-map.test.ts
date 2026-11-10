import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';
import { compileProjectResourceMap } from './project-resource-map.js';
import { AgentSystemToolService } from './agent-system-tool-service.js';
import { ProjectStructureCompiler } from './structure-compiler.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { validateToolArguments } from '@earendil-works/pi-ai';
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
  const directory = await mkdtemp(join(tmpdir(), 'resource-map-page-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  projects.create(join(directory, 'project'), '分页定位');
  return { projects, content: new ContentService(projects) };
}
it('filters before pagination, reaches shots beyond the old preview and retains parent IDs/CAS', async () => {
  const f = await setup();
  const scene = f.content.saveScene({
    title: '走廊',
    ...{ prompt: '私有场次正文' },
  });
  const shots = Array.from({ length: 45 }, (_, index) =>
    f.content.saveShot({
      sceneId: scene.id,
      title: `镜头${index}`,
      ...{ prompt: '私有镜头正文' },
    }),
  );
  const read = (options: Record<string, unknown>) =>
    f.projects.access(false, (db, project) =>
      compileProjectResourceMap(db, project, false, options),
    );
  const first = read({ workspace: 'shots', kind: 'shot', parentId: `scene:${scene.id}`, limit: 7 });
  expect(first.resources).toHaveLength(7);
  expect(first.totalResources).toBe(45);
  const ids = first.resources.map((r) => r.id);
  let page = first;
  while (page.nextOffset !== undefined) {
    page = read({
      workspace: 'shots',
      kind: 'shot',
      parentId: `scene:${scene.id}`,
      limit: 7,
      offset: page.nextOffset,
      expectedRevision: first.revision,
    });
    expect(
      page.resources.every((r) => r.locator.sceneId === scene.id && r.rowVersion !== undefined),
    ).toBe(true);
    ids.push(...page.resources.map((r) => r.id));
  }
  expect(new Set(ids).size).toBe(45);
  expect(ids).toEqual(shots.map((s) => `shot:${s.id}`));
  expect(JSON.stringify(first)).not.toContain('私有');
  expect(read({ kind: 'shot', query: '镜头44' }).resources.map((r) => r.id)).toEqual([
    `shot:${shots[44]!.id}`,
  ]);
  expect(() => read({ offset: 7 })).toThrow('expectedRevision');
  f.content.saveShot({
    sceneId: scene.id,
    title: '新增',
    ...{ prompt: '新镜头' },
  });
  expect(() => read({ offset: 7, expectedRevision: first.revision })).toThrow('revision');
});
it('advances byte-bounded pages by the actual count without losing documents', async () => {
  const f = await setup();
  const docs = Array.from({ length: 28 }, (_, i) =>
    f.content.saveDocument({
      kind: 'note',
      title: `${i} ${'长标题'.repeat(45)}`,
      contentMarkdown: '不进入目录的正文',
    }),
  );
  const read = (options: Record<string, unknown>) =>
    f.projects.access(false, (db, project) =>
      compileProjectResourceMap(db, project, false, options),
    );
  let page = read({ kind: 'document', limit: 20 });
  const seen: string[] = [];
  expect(page.resources.length).toBeLessThan(20);
  do {
    expect(Buffer.byteLength(JSON.stringify(page.resources))).toBeLessThanOrEqual(8000);
    seen.push(...page.resources.map((r) => r.documentId!));
    if (page.nextOffset === undefined) break;
    expect(page.nextOffset).toBe(seen.length);
    page = read({
      kind: 'document',
      offset: page.nextOffset,
      expectedRevision: page.revision,
      limit: 20,
    });
  } while (seen.length < (page.totalResources ?? 0));
  expect([...new Set(seen)].sort()).toEqual(docs.map((d) => d.id).sort());
  expect(read({}).resources.length).toBeLessThanOrEqual(20);
});
it('exposes and validates paginated lookup through the authorized system tool', async () => {
  const f = await setup();
  const scene = f.content.saveScene({
    title: '实际场次',
    ...{ prompt: '完整正文不注入目录' },
  });
  const conversation = f.content.createConversation({ scopeType: 'project' });
  const service = new AgentSystemToolService(
    f.projects,
    f.content,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    new ProjectStructureCompiler(),
  );
  const identity = {
    projectId: f.projects.current()!.id,
    projectSessionId: f.projects.currentSessionId()!,
    conversationId: conversation.id,
  };
  const args = { workspace: 'shots', kind: 'scene', query: '实际', limit: 1 };
  const definition = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'project.structure.get')!;
  expect(
    validateToolArguments(definition, {
      type: 'toolCall',
      id: 'lookup',
      name: definition.name,
      arguments: args,
    }),
  ).toEqual(args);
  for (const invalid of [{ workspace: 'unknown' }, { kind: 'unknown' }])
    expect(() => {
      validateToolArguments(definition, {
        type: 'toolCall',
        id: 'invalid-lookup',
        name: definition.name,
        arguments: invalid,
      });
    }).toThrow();
  const result = service.execute('project.structure.get', args, identity);
  expect(result).toMatchObject({
    detail: 'compact',
    resourceMap: {
      totalResources: 1,
      resources: [
        { id: `scene:${scene.id}`, rowVersion: scene.rowVersion, locator: { sceneId: scene.id } },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain('完整正文不注入目录');
  expect(() => service.execute('project.structure.get', { limit: 21 }, identity)).toThrow('limit');
  expect(() =>
    service.execute('project.structure.get', { workspace: 'unknown' }, identity),
  ).toThrow('workspace');
  expect(() => service.execute('project.structure.get', { offset: 1 }, identity)).toThrow(
    'expectedRevision',
  );
});
