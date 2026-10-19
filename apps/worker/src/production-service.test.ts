import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProductionInstruction,
  ProductionTarget,
  ProductionSource,
} from '@ai-video/contracts';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
  type AgentSettingsToolService,
} from './agent-system-tool-service.js';
import { validateSessionRequestParams } from './request-validation.js';
import { VideoGenerationService } from './video-generation-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ChangeSetService } from './change-set-service.js';
import { parseEpisodeStructureArguments } from './episode-structure.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.projects.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'production-execution-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '制作清单');
  const content = new ContentService(projects);
  const actor = content.saveDocument({
    kind: 'character',
    title: '林澈',
    contentMarkdown: '角色设定',
  });
  const setting = content.saveDocument({
    kind: 'scene',
    title: '车站',
    contentMarkdown: '场景设定',
  });
  const scene = content.saveScene({
    title: '雨夜',
    sceneDocumentId: setting.id,
    characterBindings: [{ characterDocumentId: actor.id }],
  });
  const shot = content.saveShot({ sceneId: scene.id, title: '入场' });
  return {
    projects,
    project,
    content,
    actor,
    setting,
    scene,
    shot,
    service: new ProductionService(projects),
  };
}
function instruction(patch: Partial<ProductionInstruction> = {}): ProductionInstruction {
  return {
    version: 1,
    summary: '雨中的车站',
    subjects: [],
    visual: {},
    beats: [],
    audio: { mode: 'silent' },
    generation: {},
    resources: [],
    continuity: { predecessors: [], before: [], after: [], locked: [], constraints: [] },
    ...patch,
  };
}
function operation(target: ProductionTarget, expectedRowVersion: number, spec = instruction()) {
  return { action: 'set_prompt', target, expectedRowVersion, instruction: spec };
}
const wan = () =>
  getAdapterCatalog().adapters.find(
    (a) =>
      a.contractId === 'cn.qwen.wan3-0-video' &&
      a.capability === 'TEXT_TO_VIDEO' &&
      a.provider === 'wan-video',
  )!;

describe('production execution in the project store', () => {
  it('adapts an unselected recording preference without rewriting the creative instruction', async () => {
    const f = await setup();
    const target = { kind: 'shot' as const, id: f.shot.id };
    f.service.execute({
      executionKey: 'unselected-recording',
      operations: [
        operation(
          target,
          f.shot.rowVersion,
          instruction({
            audio: { mode: 'dialogue-driven', ambience: '雨声' },
            generation: { duration: 8 },
          }),
        ),
      ],
    });
    const before = f.service.read(target);
    const adapter = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.1.r2v',
    )!;
    const compiled = f.service.compile({ target, adapterKey: adapter.key });
    expect(compiled.issues).toEqual([]);
    expect(compiled.instruction?.audio.mode).toBe('auto');
    expect(compiled.notices?.map((n) => n.code)).toContain('AUDIO_METHOD_ADAPTED');
    expect(compiled.parameters.prompt).toContain('雨声');
    expect(f.service.read(target)).toEqual(before);
    expect(before.instruction?.audio.mode).toBe('dialogue-driven');
    expect(() =>
      f.service.assertSource(compiled.source, target, adapter.key, {
        parameters: compiled.parameters,
      }),
    ).not.toThrow();
    expect(() =>
      f.service.assertSource(compiled.source, target, adapter.key, {
        parameters: { ...compiled.parameters, duration: 5 },
      }),
    ).toThrow('实际提交时长');
  });
  it('preserves selected image roles in the source and rejects changed selections or asset versions', async () => {
    const f = await setup();
    const target = { kind: 'shot' as const, id: f.shot.id };
    for (const id of ['board', 'frame']) {
      await writeFile(join(f.project.rootPath, `assets/${id}.png`), 'fixture');
      f.projects.access(true, (db, p) =>
        db
          .prepare(
            "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,'generated-image',?,'original',7,'now')",
          )
          .run(id, p.id, `assets/${id}.png`),
      );
    }
    f.service.execute({
      executionKey: 'roles',
      operations: [
        operation(target, f.shot.rowVersion, instruction({ generation: { duration: 8 } })),
      ],
    });
    const adapter = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.1.i2v',
    )!;
    const inputImages = [
      { assetId: 'board', role: 'character' as const },
      { assetId: 'frame', role: 'first-frame' as const },
    ];
    const prepared = f.service.compile({ target, adapterKey: adapter.key, inputImages });
    expect(prepared.issues).toEqual([]);
    expect(prepared.parameters.images).toEqual(['project-asset://frame']);
    expect(prepared.source?.inputImages).toEqual(inputImages);
    expect(() =>
      f.service.assertSource(prepared.source, target, adapter.key, {
        parameters: { ...prepared.parameters, images: ['https://example.com/another-frame.png'] },
      }),
    ).toThrow('本镜首帧');
    expect(() =>
      f.service.assertSource(prepared.source, target, adapter.key, {
        parameters: prepared.parameters,
      }),
    ).not.toThrow();
    const withoutFrame = f.service.compile({
      target,
      adapterKey: adapter.key,
      inputImages: inputImages.slice(0, 1),
    });
    expect(withoutFrame.issues.map((i) => i.code)).toContain('INPUT_SELECTION_CONFLICT');
    expect(() =>
      f.service.compile({
        target,
        adapterKey: adapter.key,
        inputImages: inputImages.slice(0, 1),
        expectedToken: prepared.source!.token,
      }),
    ).toThrow('制作来源已变化');
    f.projects.access(true, (db) =>
      db.prepare("UPDATE assets SET content_hash='changed' WHERE id='frame'").run(),
    );
    expect(() => f.service.assertSource(prepared.source, target, adapter.key)).toThrow('制作来源');
  });
  it('keeps video editing independent of generation-duration segment planning', async () => {
    const f = await setup();
    const second = f.content.saveShot({ sceneId: f.scene.id, title: '第二镜' });
    const target = { kind: 'scene' as const, id: f.scene.id };
    f.service.execute({
      executionKey: 'editing',
      operations: [
        operation(target, f.scene.rowVersion),
        operation(
          { kind: 'shot', id: f.shot.id },
          f.shot.rowVersion,
          instruction({ generation: { duration: 8 } }),
        ),
        operation(
          { kind: 'shot', id: second.id },
          second.rowVersion,
          instruction({ generation: { duration: 15 } }),
        ),
      ],
    });
    const adapter = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.0.video-edit',
    )!;
    const compiled = f.service.compile({ target, adapterKey: adapter.key });
    expect(compiled.timeline).toHaveLength(2);
    expect(compiled.estimatedDurationSeconds).toBe(23);
    expect(compiled.segments).toEqual([]);
    expect(compiled.issues.some((i) => i.code === 'SCENE_REQUIRES_SEGMENTS')).toBe(false);
  });
  it('keeps unspecified legacy audio on the selected model defaults instead of forcing silent output', async () => {
    const f = await setup();
    f.service.saveDefaults({
      expectedRowVersion: 0,
      settings: { generation: { resolution: '720p' } },
    });
    const target = { kind: 'shot' as const, id: f.shot.id };
    const result = f.service.compile({ target, adapterKey: wan().key });
    expect(result.instruction?.audio.mode).toBe('auto');
    expect(result.parameters).not.toHaveProperty('audio');
    expect(JSON.stringify(result.parameters)).not.toContain('无声音');
    expect(result.issues).toEqual([]);
  });
  it('adapts shared output preferences to the selected schema while guarding actual required audio inputs', async () => {
    const f = await setup();
    f.service.saveDefaults({
      expectedRowVersion: 0,
      settings: {
        generation: { ratio: '9:16', resolution: '1080p', promptExtend: true, watermark: false },
      },
    });
    const target = { kind: 'shot' as const, id: f.shot.id };
    const spec = instruction({
      audio: { mode: 'native', ambience: '雨声' },
      generation: { duration: 8, seed: -1 },
    });
    f.service.execute({
      executionKey: 'schema-native',
      operations: [operation(target, f.shot.rowVersion, spec)],
    });
    const original = f.service.read(target);
    const model = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.1.i2v',
    )!;
    const result = f.service.compile({ target, adapterKey: model.key });
    expect(result.issues).toEqual([]);
    expect(result.notices?.length).toBeGreaterThan(0);
    expect(result.parameters).toMatchObject({ duration: 8, resolution: '1080P', watermark: false });
    expect(result.parameters).not.toHaveProperty('ratio');
    expect(result.parameters).not.toHaveProperty('seed');
    expect(result.parameters).not.toHaveProperty('prompt_extend');
    expect(result.parameters.prompt).toContain('雨声');
    expect(() =>
      f.service.assertSource(result.source, target, model.key, {
        parameters: { ...result.parameters, images: ['https://example.com/frame.png'] },
      }),
    ).not.toThrow();
    expect(f.service.read(target)).toEqual(original);
    f.service.execute({
      executionKey: 'schema-driving',
      operations: [
        operation(target, original.rowVersion, {
          ...spec,
          audio: { mode: 'dialogue-driven' },
          resources: [
            { kind: 'dialogue-audio', required: true, purpose: '用户指定的完整对白录音' },
          ],
        }),
      ],
    });
    const required = f.service.compile({ target, adapterKey: model.key });
    expect(required.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['UNSUPPORTED_DIALOGUE_AUDIO', 'MISSING_DIALOGUE']),
    );
    expect(() => f.service.assertSource(required.source, target, model.key)).toThrow('完整对白');
  });
  it.each([true, false])(
    'adapts a saved prompt expansion default when switching models without rewriting the shot (enabled=%s)',
    async (enabled) => {
      const f = await setup();
      f.service.saveDefaults({
        expectedRowVersion: 0,
        settings: { generation: { promptExtend: enabled } },
      });
      const target = { kind: 'shot' as const, id: f.shot.id };
      f.service.execute({
        executionKey: 'prompt-expansion',
        operations: [
          operation(
            target,
            f.shot.rowVersion,
            instruction({ generation: { duration: 8, ratio: '16:9' } }),
          ),
        ],
      });
      const before = f.service.read(target);
      const happyhorse = getAdapterCatalog().adapters.find(
        (model) => model.contractId === 'cn.happyhorse.1.1.r2v' && model.provider === 'unicompapi',
      )!;
      const compiled = f.service.compile({ target, adapterKey: happyhorse.key });
      expect(compiled.issues).toEqual([]);
      expect(compiled.parameters).toMatchObject({ duration: 8, ratio: '16:9' });
      expect(compiled.parameters).not.toHaveProperty('prompt_extend');
      expect(compiled.parameters).not.toHaveProperty('promptExtend');
      const supported = f.service.compile({ target, adapterKey: wan().key });
      expect(supported.issues).toEqual([]);
      expect(supported.parameters.prompt_extend).toBe(enabled);
      expect(f.service.read(target)).toEqual(before);
      expect(f.service.getDefaults().settings.generation?.promptExtend).toBe(enabled);
    },
  );
  it('reviews complete scene/shot instructions atomically, derives 23 story seconds and fills every shot for two providers', async () => {
    const f = await setup();
    const shared = instruction({
      version: 2,
      narrative: { purpose: '等待、发现线索并决定离开' },
      storyTime: { era: '现代', season: '深秋', timeOfDay: '傍晚' },
      location: { description: '车站候车厅' },
      style: { medium: '二维动画', technique: '赛璐璐' },
      subjects: [{ documentId: f.actor.id, wardrobe: '蓝色外套' }],
      generation: { ratio: '16:9', resolution: '720p' },
    });
    const detail = (title: string, seconds: number): ProductionInstruction =>
      instruction({
        version: 2,
        summary: title,
        narrative: { purpose: title },
        timing: {
          estimatedDurationSeconds: seconds,
          rationale: '依据动作完成、观察反应和自然停顿',
        },
        camera: { framing: '中景', angle: '平视', movement: '缓慢前推' },
        subjects: [{ documentId: f.actor.id }],
        beats: [{ id: 'action', action: title, characterDocumentIds: [f.actor.id], dialogue: [] }],
        stillFrame: `${title}开始前的画面`,
      });
    const structure = parseEpisodeStructureArguments(
      JSON.stringify({
        episodeTitle: '按剧情编排',
        scenes: [
          {
            title: '线索',
            sceneDocumentId: f.setting.id,
            characterDocumentIds: [f.actor.id],
            instruction: shared,
            shots: [
              { title: '观察线索', instruction: detail('观察线索', 8) },
              { title: '确认后离开', instruction: detail('确认后离开', 15) },
            ],
          },
        ],
      }),
    );
    const spec = structure.scenes[0]!;
    const changes = new ChangeSetService(f.projects);
    const proposal = changes.create({
      title: '剧情方案',
      items: [
        {
          entityType: 'scene',
          action: 'create',
          title: spec.title,
          sceneDocumentId: spec.sceneDocumentId,
          characterDocumentIds: spec.characterDocumentIds,
          videoPrompt: spec.videoPrompt,
          instruction: spec.instruction,
        },
        ...spec.shots.map((shot) => ({
          entityType: 'shot' as const,
          action: 'create' as const,
          parentItemOrdinal: 0,
          ...shot,
        })),
      ],
    });
    expect(f.content.listScenes()).toHaveLength(1);
    expect(proposal.items[1]?.instruction?.timing?.estimatedDurationSeconds).toBe(8);
    const applied = changes.apply({
      changeSetId: proposal.id,
      expectedRowVersion: proposal.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const sceneId = applied.items[0]!.appliedEntityId!;
    const compiled = f.service.compile({
      target: { kind: 'scene', id: sceneId },
      adapterKey: wan().key,
    });
    expect(compiled.issues).toEqual([]);
    expect(compiled.estimatedDurationSeconds).toBe(23);
    expect(compiled.requestedDurationSeconds).toBe(23);
    expect(compiled.parameters).toMatchObject({
      duration: 23,
      ratio: '16:9',
      resolution: '720P',
      audio: false,
    });
    expect(compiled.parameters.prompt).toContain('0—8秒');
    expect(compiled.parameters.prompt).toContain('8—23秒');
    expect(compiled.parameters.prompt).toContain('确认后离开');
    expect(compiled.parameters.prompt).toContain('深秋');
    expect(compiled.parameters.prompt).toContain('蓝色外套');
    const seedance = getAdapterCatalog().adapters.find(
      (a) =>
        a.contractId === 'cn.bytedance.seedance2-0.video' &&
        a.provider === 'seedance-video' &&
        a.capability === 'REFERENCE_TO_VIDEO',
    )!;
    const limited = f.service.compile({
      target: { kind: 'scene', id: sceneId },
      adapterKey: seedance.key,
    });
    expect(limited.issues.map((issue) => issue.code)).toContain('SCENE_REQUIRES_SEGMENTS');
    expect(limited.parameters.content).toEqual([{ type: 'text', text: compiled.compiledPrompt }]);
    expect(limited.segments?.map((segment) => segment.estimatedDurationSeconds)).toEqual([8, 15]);
    expect(limited.parameters.duration).toBeUndefined();
    const segment = f.service.compile({
      target: { kind: 'scene', id: sceneId },
      adapterKey: seedance.key,
      shotIds: limited.segments![0]!.shotIds,
    });
    expect(segment.issues).toEqual([]);
    expect(segment.parameters.duration).toBe(8);
    expect(segment.source?.shotIds).toEqual(limited.segments![0]!.shotIds);
    expect(() =>
      f.service.assertSource(segment.source, { kind: 'scene', id: sceneId }, seedance.key),
    ).not.toThrow();
    expect(() =>
      f.service.compile({
        target: { kind: 'scene', id: sceneId },
        adapterKey: seedance.key,
        shotIds: [limited.segments![1]!.shotIds[0]!, limited.segments![0]!.shotIds[0]!],
      }),
    ).toThrow('按顺序连续');
    f.projects.close();
    f.projects.open(f.project.rootPath);
    expect(
      f.service.compile({ target: { kind: 'scene', id: sceneId }, adapterKey: wan().key }).source,
    ).toEqual(compiled.source);
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get(),
      ),
    ).toEqual({ n: 0 });
    const changed = f.content.listShots(sceneId)[0]!;
    f.content.saveShot({
      shotId: changed.id,
      sceneId,
      title: changed.title,
      prompt: '手工修改后的当前剧情',
      expectedRowVersion: changed.rowVersion,
    });
    const current = f.service.read({ kind: 'scene', id: sceneId });
    expect(current.compiledPrompt).toContain('手工修改后的当前剧情');
    expect(current.issues.map((issue) => issue.code)).toContain('STALE_INSTRUCTION');
    expect(current.estimatedDurationSeconds).toBeUndefined();
  });
  it('tracks edits, added/reordered/deleted shots and project style in the whole-scene source without rewriting story timing', async () => {
    const f = await setup();
    f.service.saveDefaults({
      expectedRowVersion: 0,
      settings: {
        style: { medium: '二维动画', linework: '清晰细线' },
        generation: { ratio: '9:16' },
      },
    });
    const shot = f.content.saveShot({
      sceneId: f.scene.id,
      title: '第二镜',
      prompt: '保留全部镜头文本',
    });
    const target = { kind: 'scene' as const, id: f.scene.id };
    const first = f.service.read(target);
    expect(first.compiledPrompt).toContain('保留全部镜头文本');
    expect(first.compiledPrompt).toContain('清晰细线');
    expect(first.estimatedDurationSeconds).toBeUndefined();
    expect(
      f.service.compile({ target, adapterKey: wan().key }).parameters.duration,
    ).toBeUndefined();
    f.content.saveShot({
      shotId: shot.id,
      sceneId: f.scene.id,
      title: shot.title,
      prompt: '修改后的镜头',
      expectedRowVersion: shot.rowVersion,
    });
    const edited = f.service.read(target);
    expect(edited.source?.token).not.toBe(first.source?.token);
    expect(edited.compiledPrompt).toContain('修改后的镜头');
    f.projects.access(true, (db) => {
      db.prepare('UPDATE shots SET position=2 WHERE id=?').run(f.shot.id);
      db.prepare('UPDATE shots SET position=0 WHERE id=?').run(shot.id);
    });
    const reordered = f.service.read(target);
    expect(reordered.timeline?.[0]?.shotId).toBe(shot.id);
    expect(reordered.source?.token).not.toBe(edited.source?.token);
    f.projects.access(true, (db) => db.prepare('DELETE FROM shots WHERE id=?').run(shot.id));
    expect(f.service.read(target).source?.token).not.toBe(reordered.source?.token);
    const previous = f.service.read(target).source;
    f.service.saveDefaults({
      expectedRowVersion: 1,
      settings: { style: { medium: '二维动画', linework: '粗线' } },
    });
    expect(f.service.read(target).source?.token).not.toBe(previous?.token);
    expect(() => f.service.assertSource(previous, target, wan().key)).toThrow('制作来源');
    expect(() => f.service.saveDefaults({ expectedRowVersion: 1, settings: {} })).toThrow('已变化');
  });
  it('rejects a missing shot duration and rolls back reviewed instructions when a late database write fails', async () => {
    const f = await setup();
    const detail = instruction({
      version: 2,
      narrative: { purpose: '自然完成动作' },
      camera: { framing: '中景' },
      beats: [{ id: 'b', action: '回头', characterDocumentIds: [], dialogue: [] }],
    });
    expect(() =>
      parseEpisodeStructureArguments(
        JSON.stringify({
          episodeTitle: '测试',
          scenes: [{ title: '场次', shots: [{ title: '分镜', instruction: detail }] }],
        }),
      ),
    ).toThrow('预计时长');
    const changes = new ChangeSetService(f.projects);
    const proposal = changes.create({
      title: '审核原子性',
      items: [
        {
          entityType: 'shot',
          action: 'create',
          parentSceneId: f.scene.id,
          title: '回头',
          instruction: {
            ...detail,
            timing: { estimatedDurationSeconds: 3, rationale: '回头观察' },
          },
          prompt: '回头',
        },
      ],
    });
    f.projects.access(true, (db) =>
      db.exec(
        "CREATE TRIGGER fail_scene_instruction BEFORE INSERT ON production_instruction_versions BEGIN SELECT RAISE(ABORT,'instruction failure'); END",
      ),
    );
    expect(() => changes.apply({ changeSetId: proposal.id, expectedRowVersion: 0 })).toThrow(
      'instruction failure',
    );
    expect(f.content.listShots(f.scene.id)).toHaveLength(1);
    expect(changes.list()[0]?.items[0]?.status).toBe('pending');
  });
  it('atomically projects both pages, persists history across reopen, and replays only identical keys', async () => {
    const f = await setup();
    const list = {
      executionKey: 'all-pages',
      operations: [
        operation({ kind: 'scene', id: f.scene.id }, f.scene.rowVersion),
        operation({ kind: 'character', id: f.actor.id }, f.actor.rowVersion),
        operation({ kind: 'setting', id: f.setting.id }, f.setting.rowVersion),
        operation(
          { kind: 'shot', id: f.shot.id },
          f.shot.rowVersion,
          instruction({ visual: { environment: '雨'.repeat(3000) } }),
        ),
      ],
    };
    const result = f.service.execute(list);
    expect(result).toMatchObject({ status: 'applied', paidRequests: 0 });
    expect(f.service.execute(list)).toEqual(result);
    expect(() => f.service.execute({ ...list, operations: list.operations.slice(1) })).toThrow(
      '执行键',
    );
    expect(f.content.getDocument(f.actor.id).currentVersion?.state).toBe('draft');
    expect(f.content.getDocument(f.actor.id).currentVersion?.contentMarkdown).toContain(
      '雨中的车站',
    );
    expect(f.content.listScenes()[0]?.videoPrompt).toContain('雨中的车站');
    expect(f.service.read({ kind: 'scene', id: f.scene.id }).issues).toEqual([]);
    expect(f.content.listShots(f.scene.id)[0]?.prompt?.length).toBeGreaterThan(3000);
    const source = f.service.read({ kind: 'shot', id: f.shot.id }).source;
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
    f.projects.close();
    f.projects.open(f.project.rootPath);
    expect(f.service.read({ kind: 'shot', id: f.shot.id }).source).toEqual(source);
    expect(f.service.execute(list)).toEqual(result);
    f.content.saveDocument({
      documentId: f.actor.id,
      kind: 'character',
      title: f.actor.title,
      contentMarkdown: '角色造型已修改',
    });
    expect(
      f.service.read({ kind: 'scene', id: f.scene.id }).issues.map((issue) => issue.code),
    ).toContain('STALE_INSTRUCTION');
  });
  it('rolls back all operations on stale versions, duplicate targets, invalid references and late write failure', async () => {
    const f = await setup();
    const target = { kind: 'scene' as const, id: f.scene.id };
    const op = operation(target, f.scene.rowVersion);
    expect(() =>
      f.service.execute({
        executionKey: 'cas',
        operations: [op, operation({ kind: 'shot', id: f.shot.id }, 99)],
      }),
    ).toThrow('已被修改');
    expect(() => f.service.execute({ executionKey: 'duplicate', operations: [op, op] })).toThrow(
      '重复',
    );
    expect(() =>
      f.service.execute({
        executionKey: 'references',
        operations: [
          { ...op, instruction: instruction({ subjects: [{ documentId: 'other-project' }] }) },
        ],
      }),
    ).toThrow();
    expect(() =>
      f.service.execute({
        executionKey: 'late',
        operations: [
          op,
          operation(
            { kind: 'shot', id: f.shot.id },
            f.shot.rowVersion,
            instruction({
              visual: Object.fromEntries(
                ['environment', 'composition', 'lighting', 'style', 'palette', 'lens'].map((k) => [
                  k,
                  '雨'.repeat(4000),
                ]),
              ),
            }),
          ),
        ],
      }),
    ).toThrow('20000');
    expect(f.content.listScenes()[0]?.rowVersion).toBe(f.scene.rowVersion);
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM production_execution_lists').get(),
      ),
    ).toEqual({ count: 0 });
    expect(() =>
      f.service.execute({
        executionKey: 'missing',
        operations: [operation({ kind: 'scene', id: 'foreign' }, 0)],
      }),
    ).toThrow();
  });
  it('combines predecessor states, inherits locks transitively and rejects cycles or ambiguous branch states', async () => {
    const f = await setup();
    const a = { kind: 'scene' as const, id: f.scene.id };
    const b = { kind: 'shot' as const, id: f.shot.id };
    const third = f.content.saveShot({ sceneId: f.scene.id, title: '后续' });
    const c = { kind: 'shot' as const, id: third.id };
    const continuity = (patch: Partial<ProductionInstruction['continuity']>) => ({
      predecessors: [],
      before: [],
      after: [],
      locked: [],
      constraints: [],
      ...patch,
    });
    f.service.execute({
      executionKey: 'graph',
      operations: [
        operation(
          a,
          f.scene.rowVersion,
          instruction({
            continuity: continuity({
              after: [{ key: 'door', value: 'open' }],
              locked: [{ key: 'coat', value: 'blue' }],
            }),
          }),
        ),
        operation(
          b,
          f.shot.rowVersion,
          instruction({ continuity: continuity({ after: [{ key: 'weather', value: 'rain' }] }) }),
        ),
        operation(
          c,
          third.rowVersion,
          instruction({
            continuity: continuity({
              predecessors: [a, b],
              before: [
                { key: 'door', value: 'open' },
                { key: 'weather', value: 'rain' },
              ],
            }),
          }),
        ),
      ],
    });
    expect(f.service.read(c).issues).toEqual([]);
    expect(() =>
      f.service.execute({
        executionKey: 'changed-canonical-dependency',
        operations: [
          operation(
            { kind: 'character', id: f.actor.id },
            f.actor.rowVersion,
            instruction({ summary: '角色的新设定' }),
          ),
          operation(c, f.service.read(c).rowVersion, f.service.read(c).instruction),
        ],
      }),
    ).toThrow('角色/场景资料');
    expect(f.content.getDocument(f.actor.id).currentVersion?.contentMarkdown).toBe('角色设定');
    const fourth = f.content.saveShot({ sceneId: f.scene.id, title: '破坏锁定' });
    expect(() =>
      f.service.execute({
        executionKey: 'lock',
        operations: [
          operation(
            { kind: 'shot', id: fourth.id },
            fourth.rowVersion,
            instruction({
              continuity: continuity({ predecessors: [c], after: [{ key: 'coat', value: 'red' }] }),
            }),
          ),
        ],
      }),
    ).toThrow('锁定');
    expect(() =>
      f.service.execute({
        executionKey: 'cycle',
        operations: [
          operation(
            a,
            f.service.read(a).rowVersion,
            instruction({ continuity: continuity({ predecessors: [c] }) }),
          ),
        ],
      }),
    ).toThrow('循环');
    expect(() =>
      f.service.execute({
        executionKey: 'branch',
        operations: [
          operation(
            b,
            f.service.read(b).rowVersion,
            instruction({ continuity: continuity({ after: [{ key: 'door', value: 'closed' }] }) }),
          ),
          operation(c, f.service.read(c).rowVersion, f.service.read(c).instruction),
        ],
      }),
    ).toThrow('冲突');
    f.content.saveScene({
      sceneId: f.scene.id,
      title: f.scene.title,
      videoPrompt: '人工改写',
      expectedRowVersion: f.service.read(a).rowVersion,
    });
    expect(f.service.read(c).issues.map((i) => i.code)).toContain('STALE_INSTRUCTION');
  });
  it('invalidates effective input changes, ignores unused images, and guards prepare without any paid request', async () => {
    const f = await setup();
    const target = { kind: 'scene' as const, id: f.scene.id };
    f.service.execute({
      executionKey: 'first',
      operations: [operation(target, f.scene.rowVersion)],
    });
    const original = f.service.read(target).source!;
    const addImage = async (id: string) => {
      await writeFile(join(f.project.rootPath, `assets/images/${id}.png`), 'fixture');
      f.projects.access(true, (db, p) => {
        db.prepare(
          "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,'character',?,?,7,?)",
        ).run(id, p.id, `assets/images/${id}.png`, 'a'.repeat(64), id);
        db.prepare(
          "INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES(?,?,'fixture','succeeded','{}',?,'now','now')",
        ).run(`job-${id}`, p.id, JSON.stringify({ sourceDocumentId: f.actor.id }));
        db.prepare(
          "INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES(?,?,?,'now')",
        ).run(`result-${id}`, `job-${id}`, id);
      });
    };
    await addImage('first');
    expect(f.service.read(target).source?.token).not.toBe(original.token);
    const selected = f.service.read(target).source!;
    await addImage('second');
    expect(f.service.read(target).source?.token).toBe(selected.token);
    f.service.execute({
      executionKey: 'required-input',
      operations: [
        operation(
          target,
          f.service.read(target).rowVersion,
          instruction({
            resources: [
              {
                kind: 'character-image',
                documentId: f.actor.id,
                required: true,
                purpose: '保持角色外观',
              },
            ],
          }),
        ),
      ],
    });
    const requiredSource = f.service.read(target).source!;
    expect(() =>
      f.service.assertSource(requiredSource, target, wan().key, {
        parameters: { prompt: 'project-asset://first' },
      }),
    ).toThrow('提交参数缺少');
    expect(() =>
      f.service.assertSource(requiredSource, target, wan().key, {
        parameters: { media: [{ type: 'reference_image', url: 'project-asset://first' }] },
      }),
    ).not.toThrow();
    f.service.execute({
      executionKey: 'optional-again',
      operations: [operation(target, f.service.read(target).rowVersion)],
    });
    const currentSource = f.service.read(target).source!;
    const videos = new VideoGenerationService(f.projects);
    const params = {
      adapterKey: wan().key,
      sceneId: f.scene.id,
      parameters: {
        prompt: '用户确认的文字',
        duration: 5,
        resolution: '720P',
        ratio: '16:9',
        audio: false,
      },
      providerRegion: 'cn' as const,
    };
    expect(() => videos.prepare(params)).toThrow('制作来源');
    expect(() => videos.prepare({ ...params, productionSource: original })).toThrow('制作来源');
    const prepared = videos.prepare({ ...params, productionSource: currentSource });
    const snapshot = f.projects.access(false, (db) =>
      db.prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id=?').get(prepared.id),
    ) as { task_snapshot_json: string };
    expect(
      (JSON.parse(snapshot.task_snapshot_json) as { productionSource: ProductionSource })
        .productionSource,
    ).toEqual(currentSource);
    f.content.saveScene({
      sceneId: f.scene.id,
      title: f.scene.title,
      characterBindings: [{ characterDocumentId: f.actor.id, imageDisabled: true }],
      expectedRowVersion: f.service.read(target).rowVersion,
    });
    expect(() => f.service.assertSource(currentSource, target, wan().key)).toThrow('制作来源');
    expect(
      (JSON.parse(snapshot.task_snapshot_json) as { productionSource: ProductionSource })
        .productionSource,
    ).toEqual(currentSource);
  });
  it('validates RPC source shape and refuses execution without a current Agent call', async () => {
    const f = await setup();
    const target = { kind: 'scene' as const, id: f.scene.id };
    expect(() => validateSessionRequestParams('production.read', { target })).not.toThrow();
    expect(() =>
      validateSessionRequestParams('production.compile', {
        target,
        adapterKey: wan().key,
        paid: true,
      }),
    ).toThrow();
    const params = {
      adapterKey: wan().key,
      parameters: {},
      providerProfileId: 'p',
      modelId: 'm',
      providerRegion: 'cn',
      productionSource: { target, instructionId: 'i', revision: 1, token: 'pretend' },
    };
    expect(() => validateSessionRequestParams('video.generate.prepare', params)).toThrow();
    const conversation = f.content.createConversation({ scopeType: 'project', title: '制作' });
    const tools = new AgentSystemToolService(
      f.projects,
      f.content,
      {} as AgentAssetToolService,
      {} as AgentSettingsToolService,
    );
    const identity = {
      projectId: f.project.id,
      projectSessionId: f.projects.currentSessionId()!,
      conversationId: conversation.id,
    };
    expect(tools.execute('production.read', { target }, identity)).toMatchObject({
      target,
      rowVersion: f.scene.rowVersion,
    });
    expect(() =>
      tools.execute(
        'production.execute',
        { executionKey: 'not-running', operations: [operation(target, f.scene.rowVersion)] },
        identity,
      ),
    ).toThrow('正在执行');
    f.projects.access(true, (db, p) => {
      db.prepare(
        `INSERT INTO agent_tasks(id,project_id,project_session_id,conversation_id,task_type,scope_type,title,request_snapshot_json,request_hash,status,created_at,started_at,updated_at,phase,row_version,tool_call_limit) VALUES('task',?,?,?,'document-create','project','制作清单','{}','hash','running','now','now','now','model_running',0,16)`,
      ).run(p.id, identity.projectSessionId, conversation.id);
      db.prepare(
        `INSERT INTO agent_tool_calls(id,project_id,task_id,tool_name,arguments_summary_json,normalized_arguments_hash,status,created_at,idempotency_key,redaction_state) VALUES('call',?,'task','production.execute','{}','hash','executing','now','call-key','native')`,
      ).run(p.id);
    });
    expect(
      tools.execute(
        'production.execute',
        {
          executionKey: 'gateway',
          operations: [
            operation(target, f.scene.rowVersion),
            operation({ kind: 'character', id: f.actor.id }, f.actor.rowVersion),
            operation({ kind: 'setting', id: f.setting.id }, f.setting.rowVersion),
          ],
        },
        { ...identity, taskId: 'task', toolCallId: 'call' },
      ),
    ).toMatchObject({ status: 'applied' });
    const workflow = new DocumentWorkflowService(f.projects);
    const parent = workflow.getTask({ taskId: 'task' });
    expect(parent.documents).toHaveLength(2);
    const sourceTaskId = f.content.getDocument(f.actor.id).currentVersion?.sourceTaskId;
    expect(sourceTaskId).not.toBe('task');
    expect(workflow.getTask({ taskId: sourceTaskId! }).task.status).toBe('waiting_review');
    expect(workflow.getTask({ taskId: 'task' }).productionUpdated).toBeUndefined();
    f.projects.access(true, (db) =>
      db.prepare("UPDATE agent_tool_calls SET status='succeeded' WHERE id='call'").run(),
    );
    expect(workflow.getTask({ taskId: 'task' }).productionUpdated).toBe(true);
  });
});
