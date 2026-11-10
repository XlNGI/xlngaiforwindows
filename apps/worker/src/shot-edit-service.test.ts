import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ShotEditService } from './shot-edit-service.js';
import { ProductionService } from './production-service.js';

const fixtures: Array<{ root: string; projects: ProjectService }> = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'prompt-bindings-'));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  const project = projects.create(join(root, 'project'), 'Bindings');
  const content = new ContentService(projects);
  const character = content.saveDocument({
    kind: 'character',
    title: '角色',
    contentMarkdown: '任意格式的角色提示词',
  });
  const prop = content.saveDocument({
    kind: 'prop',
    title: '道具',
    contentMarkdown: '任意格式的道具提示词',
  });
  const scene = content.saveScene({ title: '场次' });
  const bindings = {
    schemaVersion: 1 as const,
    characterDocumentIds: [character.id],
    propDocumentIds: [prop.id],
  };
  const shots = [0, 1].map((i) =>
    content.saveShot({
      sceneId: scene.id,
      title: `镜头${i}`,
      prompt: ` 原文${i}。\n对白、运镜全部留在这里。 `,
      bindings,
      timing: { estimatedDurationSeconds: 3 },
    }),
  );
  const identity = {
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    taskId: 'task',
    toolCallId: 'call',
    generationId: 'generation',
    attemptId: 'attempt',
    conversationId: 'conversation',
  };
  const fixture = {
    root,
    projects,
    content,
    character,
    prop,
    scene,
    shots,
    identity,
    editor: new ShotEditService(projects),
  };
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.projects.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it('preserves exact text, bindings and duration independently through edits and compilation', async () => {
  const f = await setup(),
    shot = f.shots[0]!;
  const text = '  只有一句普通文本。\n角色说“你好”，镜头缓慢后退。  ';
  f.editor.updatePrompts(
    { shots: [{ shotId: shot.id, expectedRowVersion: shot.rowVersion, prompt: text }] },
    f.identity,
  );
  let saved = f.content.listShots(f.scene.id)[0]!;
  expect(saved.prompt).toBe(text);
  expect(saved.bindings).toEqual(shot.bindings);
  expect(saved.timing).toEqual(shot.timing);
  f.editor.updateTimings(
    {
      shots: [
        { shotId: saved.id, expectedRowVersion: saved.rowVersion, estimatedDurationSeconds: 8 },
      ],
    },
    f.identity,
  );
  saved = f.content.listShots(f.scene.id)[0]!;
  expect(saved.prompt).toBe(text);
  expect(saved.bindings).toEqual(shot.bindings);
  expect(saved.timing).toEqual({ estimatedDurationSeconds: 8 });
  expect(new ProductionService(f.projects).read({ kind: 'shot', id: shot.id })).toMatchObject({
    prompt: text,
    compiledPrompt: text,
    bindings: shot.bindings,
    estimatedDurationSeconds: 8,
  });
});
it('merges omitted binding scopes and clears only explicit scopes', async () => {
  const f = await setup(),
    shot = f.shots[0]!;
  f.editor.updatePrompts(
    {
      shots: [
        {
          shotId: shot.id,
          expectedRowVersion: shot.rowVersion,
          bindings: { schemaVersion: 1, propDocumentIds: [] },
        },
      ],
    },
    f.identity,
  );
  const saved = f.content.listShots(f.scene.id)[0]!;
  expect(saved.prompt).toBe(shot.prompt);
  expect(saved.bindings).toEqual({ ...shot.bindings, propDocumentIds: [] });
});
it('rejects wrong document kinds, sessions and stale CAS without partial writes', async () => {
  const f = await setup(),
    a = f.shots[0]!,
    b = f.shots[1]!;
  const batch = {
    shots: [
      { shotId: a.id, expectedRowVersion: a.rowVersion, prompt: '先改第一镜' },
      {
        shotId: b.id,
        expectedRowVersion: b.rowVersion,
        bindings: { schemaVersion: 1, propDocumentIds: [f.character.id] },
      },
    ],
  };
  expect(() => f.editor.updatePrompts(batch, f.identity)).toThrow('INVALID_BINDING_REFERENCE');
  expect(f.content.listShots(f.scene.id)).toEqual(f.shots);
  expect(() =>
    f.editor.updatePrompts(
      { shots: [{ shotId: a.id, expectedRowVersion: a.rowVersion - 1, prompt: '更新' }] },
      f.identity,
    ),
  ).toThrow();
  expect(() =>
    f.editor.updatePrompts(batch, { ...f.identity, projectSessionId: 'other' }),
  ).toThrow();
  expect(f.content.listShots(f.scene.id)).toEqual(f.shots);
});
it('rolls back earlier writes and the project timestamp when a later save fails', async () => {
  const f = await setup(),
    timestamp = f.projects.current()!.updatedAt;
  f.projects.access(true, (db) =>
    db.exec(
      `CREATE TRIGGER fail_second BEFORE UPDATE ON shots WHEN OLD.id='${f.shots[1]!.id}' BEGIN SELECT RAISE(ABORT,'injected'); END`,
    ),
  );
  expect(() =>
    f.editor.updatePrompts(
      {
        shots: f.shots.map((s) => ({
          shotId: s.id,
          expectedRowVersion: s.rowVersion,
          prompt: '新正文',
        })),
      },
      f.identity,
    ),
  ).toThrow('injected');
  expect(f.content.listShots(f.scene.id)).toEqual(f.shots);
  expect(f.projects.current()!.updatedAt).toBe(timestamp);
});
it('respects locked durations and never derives bindings from prompt names', async () => {
  const f = await setup(),
    shot = f.shots[0]!;
  const locked = f.content.saveShot({
    sceneId: f.scene.id,
    shotId: shot.id,
    title: shot.title,
    expectedRowVersion: shot.rowVersion,
    timing: { estimatedDurationSeconds: 3, locked: true },
  });
  expect(() =>
    f.editor.updateTimings(
      {
        shots: [
          { shotId: shot.id, expectedRowVersion: locked.rowVersion, estimatedDurationSeconds: 6 },
        ],
      },
      f.identity,
    ),
  ).toThrow('LOCKED');
  const plain = f.content.saveShot({
    sceneId: f.scene.id,
    title: '纯文本',
    prompt: '提到角色和道具并不创建关系',
  });
  expect(plain.bindings).toBeUndefined();
});
