import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.projects.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'production-ir-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  projects.create(join(directory, 'project'), '制作 IR');
  const content = new ContentService(projects);
  const scene = content.saveScene({
    title: '雨夜',
    authoringIR: { schemaVersion: 1, kind: 'scene', prompt: '古道雨夜。' },
  });
  return { projects, content, scene, service: new ProductionService(projects) };
}
const wan = () =>
  getAdapterCatalog().adapters.find(
    (a) =>
      a.contractId === 'cn.qwen.wan3-0-video' &&
      a.capability === 'TEXT_TO_VIDEO' &&
      a.provider === 'wan-video',
  )!;

it('compiles the verbatim IR prompt and explicit timing without interpreting open data', async () => {
  const f = await setup();
  const ir = {
    schemaVersion: 1 as const,
    kind: 'shot' as const,
    prompt: '  她在发丝缝隙间看向镜头。\n保留雨声，无配乐。  ',
    timing: { estimatedDurationSeconds: 5, rationale: '反手制敌和转身' },
    data: { timing: { estimatedDurationSeconds: 999 }, audio: '这是开放描述，不是执行字段' },
  };
  const shot = f.content.saveShot({ sceneId: f.scene.id, title: '回身', authoringIR: ir });
  const target = { kind: 'shot' as const, id: shot.id };
  expect(f.service.read(target)).toMatchObject({
    authoringIR: ir,
    compiledPrompt: ir.prompt,
    estimatedDurationSeconds: 5,
  });
  const compiled = f.service.compile({ target, adapterKey: wan().key });
  expect(compiled.parameters.prompt).toBe(ir.prompt);
  expect(Number(compiled.parameters.duration)).toBe(5);
  expect(JSON.stringify(compiled.parameters)).not.toContain('开放描述');
  expect(f.service.read({ kind: 'scene', id: f.scene.id })).toMatchObject({
    compiledPrompt: '古道雨夜。',
    timeline: [{ shotId: shot.id, startSeconds: 0, endSeconds: 5 }],
  });
});

it('rejects conflicting prompt projections and stale CAS without changing the saved IR', async () => {
  const f = await setup();
  const ir = { schemaVersion: 1 as const, kind: 'shot' as const, prompt: '原始提示词' };
  const shot = f.content.saveShot({ sceneId: f.scene.id, title: '回身', authoringIR: ir });
  const update = {
    shotId: shot.id,
    sceneId: shot.sceneId,
    title: shot.title,
    expectedRowVersion: shot.rowVersion,
    authoringIR: ir,
  };
  expect(() => f.content.saveShot({ ...update, prompt: '不同正文' })).toThrow('must match');
  expect(() =>
    f.content.saveShot({ ...update, authoringIR: null, prompt: '不能同时清除和写入正文' }),
  ).toThrow('must be empty');
  expect(() =>
    f.content.saveScene({
      sceneId: f.scene.id,
      title: f.scene.title,
      expectedRowVersion: f.scene.rowVersion,
      authoringIR: null,
      videoPrompt: '冲突正文',
    }),
  ).toThrow('must be empty');
  expect(() => f.content.saveShot({ ...update, expectedRowVersion: shot.rowVersion - 1 })).toThrow(
    'SHOT_ROW_VERSION_CONFLICT',
  );
  expect(f.service.read({ kind: 'shot', id: shot.id }).authoringIR).toEqual(ir);
});

it('does not revive prompt-column or archive rendering when the authoritative IR is absent', async () => {
  const f = await setup();
  const shot = f.content.saveShot({ sceneId: f.scene.id, title: '空镜头' });
  f.projects.access(true, (db) =>
    db.prepare('UPDATE shots SET prompt=? WHERE id=?').run('仅存于投影列', shot.id),
  );
  const compiled = f.service.compile({
    target: { kind: 'shot', id: shot.id },
    adapterKey: wan().key,
  });
  expect(compiled.compiledPrompt).toBeUndefined();
  expect(compiled.parameters).toEqual({});
});

it('keeps provider defaults independent, enforces CAS and invalidates compiled form tokens', async () => {
  const f = await setup();
  const target = { kind: 'scene' as const, id: f.scene.id };
  const before = f.service.compile({ target, adapterKey: wan().key });
  f.service.saveDefaults({ expectedRowVersion: 0, settings: { generation: { watermark: false } } });
  expect(() => f.service.saveDefaults({ expectedRowVersion: 0, settings: {} })).toThrow('已变化');
  expect(() =>
    f.service.saveDefaults({ expectedRowVersion: 1, settings: { style: '写实' } as never }),
  ).toThrow('无效');
  expect(() =>
    f.service.compile({ target, adapterKey: wan().key, expectedToken: before.source!.token }),
  ).toThrow('已变化');
  expect(f.service.compile({ target, adapterKey: wan().key }).parameters).toMatchObject({
    prompt: '古道雨夜。',
    watermark: false,
  });
});

it('uses the complete scene prompt once and keeps ranges within selected shot prompts and timing', async () => {
  const f = await setup();
  f.content.saveScene({
    sceneId: f.scene.id,
    title: f.scene.title,
    expectedRowVersion: f.scene.rowVersion,
    authoringIR: {
      schemaVersion: 1,
      kind: 'scene',
      prompt: '整场最终正文，包括结尾。',
      timing: { estimatedDurationSeconds: 20, rationale: '完整剧情' },
      data: { sharedPrompt: '不得从开放数据渲染' },
    },
  });
  const shots = [1, 2].map((i) =>
    f.content.saveShot({
      sceneId: f.scene.id,
      title: `镜${i}`,
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: `第${i}镜完整正文`,
        timing: { estimatedDurationSeconds: 4, rationale: '本镜动作' },
      },
    }),
  );
  const target = { kind: 'scene' as const, id: f.scene.id };
  expect(f.service.compile({ target, adapterKey: wan().key }).parameters.prompt).toBe(
    '整场最终正文，包括结尾。',
  );
  const range = f.service.compile({ target, adapterKey: wan().key, shotIds: [shots[0]!.id] });
  expect(range.parameters.prompt).toBe('第1镜完整正文');
  expect(range.estimatedDurationSeconds).toBe(4);
  expect(range.timeline).toMatchObject([{ shotId: shots[0]!.id, startSeconds: 0, endSeconds: 4 }]);
});

it('invalidates scene structure reads on child edits and shot forms on parent binding edits', async () => {
  const f = await setup();
  const shot = f.content.saveShot({ sceneId: f.scene.id, title: '镜头', prompt: '镜头正文' });
  const target = { kind: 'scene' as const, id: f.scene.id };
  const version = f.service.queryVersion(target);
  f.content.saveShot({
    shotId: shot.id,
    sceneId: shot.sceneId,
    title: '新标题',
    expectedRowVersion: shot.rowVersion,
  });
  expect(f.service.queryVersion(target)).not.toBe(version);
  const shotTarget = { kind: 'shot' as const, id: shot.id };
  const token = f.service.compile({ target: shotTarget, adapterKey: wan().key }).source!.token;
  f.content.saveScene({
    sceneId: f.scene.id,
    title: '新的场次名称',
    expectedRowVersion: f.scene.rowVersion,
  });
  expect(() =>
    f.service.compile({ target: shotTarget, adapterKey: wan().key, expectedToken: token }),
  ).toThrow('已变化');
});

it('revalidates child IR references and does not report out-of-range references', async () => {
  const f = await setup();
  const actor = f.content.saveDocument({
    kind: 'character',
    title: '角色',
    contentMarkdown: '角色资料',
  });
  const first = f.content.saveShot({ sceneId: f.scene.id, title: '第一镜', prompt: '空镜' });
  const second = f.content.saveShot({
    sceneId: f.scene.id,
    title: '第二镜',
    authoringIR: {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '角色回头',
      references: { characterDocumentIds: [actor.id] },
    },
  });
  f.projects.access(true, (db) =>
    db.prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?").run(actor.id),
  );
  const target = { kind: 'scene' as const, id: f.scene.id };
  expect(f.service.read(target).issues).toMatchObject([
    { code: 'INVALID_IR_REFERENCE', target: { kind: 'shot', id: second.id } },
  ]);
  expect(f.service.read(target, [first.id]).issues).toEqual([]);
});

it('inherits scene cast for unscoped shots without inventing segments across unknown timing', async () => {
  const f = await setup();
  const actor = f.content.saveDocument({
    kind: 'character',
    title: '角色',
    contentMarkdown: '资料',
  });
  f.content.saveScene({
    sceneId: f.scene.id,
    title: f.scene.title,
    expectedRowVersion: f.scene.rowVersion,
    characterBindings: [
      { characterDocumentId: actor.id, imageDisabled: true, voiceDisabled: true },
    ],
  });
  const first = f.content.saveShot({
    sceneId: f.scene.id,
    title: '空镜',
    authoringIR: {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '空镜正文',
      references: { characterDocumentIds: [] },
      timing: { estimatedDurationSeconds: 4, rationale: '空镜时长' },
    },
  });
  const second = f.content.saveShot({ sceneId: f.scene.id, title: '继承角色', prompt: '人物出现' });
  const target = { kind: 'scene' as const, id: f.scene.id };
  const range = f.service.compile({
    target,
    adapterKey: wan().key,
    shotIds: [first.id, second.id],
  });
  expect(range.sceneInputs?.scene.characterBindings).toHaveLength(1);
  expect(range.segments).toEqual([]);
  const empty = f.service.compile({ target, adapterKey: wan().key, shotIds: [first.id] });
  expect(empty.sceneInputs?.scene.characterBindings).toEqual([]);
});
