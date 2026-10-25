import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ChangeSetService } from './change-set-service.js';
import { repairIRSceneBindings } from './production-ir-bindings.js';
import { VoiceReferenceRepository } from '@ai-video/persistence';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const { projects, directory } of fixtures.splice(0)) {
    projects.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'production-ir-bindings-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), 'IR bindings');
  const content = new ContentService(projects);
  const actor = content.saveDocument({
    kind: 'character',
    title: '司机',
    contentMarkdown: '司机资料',
  });
  const setting = content.saveDocument({
    kind: 'scene',
    title: '车厢',
    contentMarkdown: '车厢资料',
  });
  const ir = {
    schemaVersion: 1 as const,
    kind: 'scene' as const,
    prompt: '司机望向空车厢。',
    references: { characterDocumentIds: [actor.id], sceneDocumentIds: [setting.id] },
  };
  return { projects, project, content, actor, setting, ir };
}

it('projects IR IDs into UI bindings and preserves explicit media settings through Agent revisions', async () => {
  const f = await setup();
  const scene = f.content.saveScene({ title: '车内', authoringIR: f.ir });
  const edited = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: scene.rowVersion,
    characterBindings: [
      { characterDocumentId: f.actor.id, imageDisabled: true, voiceDisabled: true },
    ],
  });
  const saved = new ChangeSetService(f.projects).saveDraft({
    title: '修改场次',
    items: [
      {
        entityType: 'scene',
        action: 'update',
        targetId: scene.id,
        expectedRowVersion: edited.rowVersion,
        title: '车内修改',
        authoringIR: { ...f.ir, prompt: '司机回头。' },
      },
    ],
  });
  expect(saved.status).toBe('applied');
  expect(f.content.listScenes()[0]).toMatchObject({
    sceneDocumentId: f.setting.id,
    characterBindings: edited.characterBindings,
    videoPrompt: '司机回头。',
  });
});

it('preserves manually selected character images, historical voice versions and setting images', async () => {
  const f = await setup();
  const voice = f.projects.access(true, (db, project) => {
    for (const id of ['actor-image', 'setting-image'])
      db.prepare(
        "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,'generated-image',?,'original',7,'now')",
      ).run(id, project.id, `assets/${id}.png`);
    db.prepare(
      "INSERT INTO audio_files(id,project_id,kind,name,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,channels,created_at) VALUES('sample',?,'reference','司机','assets/audio/reference/sample.wav','audio/wav',100,?,3000,48000,1,'now')",
    ).run(project.id, 'a'.repeat(64));
    const voices = new VoiceReferenceRepository(db, project.id);
    const first = voices.save({ characterDocumentId: f.actor.id, audioId: 'sample' });
    voices.save({
      characterDocumentId: f.actor.id,
      audioId: 'sample',
      expectedRowVersion: first.rowVersion,
    });
    return first;
  });
  const scene = f.content.saveScene({
    title: '手选素材',
    sceneDocumentId: f.setting.id,
    characterBindings: [
      {
        characterDocumentId: f.actor.id,
        imageAssetId: 'actor-image',
        voiceReferenceVersionId: voice.versionId,
      },
    ],
    materialBindings: [
      {
        id: 'manual-setting',
        role: 'scene',
        label: '指定场景',
        assetId: 'setting-image',
        source: 'manual',
        sourceDocumentId: f.setting.id,
      },
    ],
  });
  const next = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: scene.rowVersion,
    authoringIR: f.ir,
  });
  expect(next.characterBindings).toEqual(scene.characterBindings);
  expect(next.materialBindings).toEqual(scene.materialBindings);
  new ChangeSetService(f.projects).saveDraft({
    title: 'Agent 修订',
    items: [
      {
        entityType: 'scene',
        action: 'update',
        targetId: scene.id,
        expectedRowVersion: next.rowVersion,
        title: scene.title,
        authoringIR: f.ir,
      },
    ],
  });
  expect(f.content.listScenes()[0]!.characterBindings).toEqual(scene.characterBindings);
  expect(f.content.listScenes()[0]!.materialBindings).toEqual(scene.materialBindings);
});

it('treats absent references as unchanged, explicit empty arrays as unbinding, and ignores names in prompt/data', async () => {
  const f = await setup();
  let scene = f.content.saveScene({ title: '车内', authoringIR: f.ir });
  scene = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: scene.rowVersion,
    authoringIR: { ...f.ir, references: undefined },
  });
  expect(scene.characterBindings).toEqual([{ characterDocumentId: f.actor.id }]);
  expect(scene.sceneDocumentId).toBe(f.setting.id);
  scene = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: scene.rowVersion,
    authoringIR: {
      ...f.ir,
      references: { characterDocumentIds: [], sceneDocumentIds: [] },
      data: { references: { characterDocumentIds: [f.actor.id] } },
    },
  });
  expect(scene.characterBindings).toEqual([]);
  expect(scene.sceneDocumentId).toBeUndefined();
});

it('allows no props and rejects character or setting documents used as props without changing saved bindings', async () => {
  const f = await setup();
  const ir = { ...f.ir, references: { ...f.ir.references, propDocumentIds: [] } };
  const scene = f.content.saveScene({ title: '无道具剧情', authoringIR: ir });
  expect(scene.authoringIR?.references?.propDocumentIds).toEqual([]);
  expect(f.content.listDocuments().filter((item) => item.kind === 'prop')).toEqual([]);
  for (const document of [f.actor, f.setting]) {
    expect(() =>
      f.content.saveScene({
        sceneId: scene.id,
        title: scene.title,
        expectedRowVersion: scene.rowVersion,
        authoringIR: {
          ...ir,
          references: { ...ir.references, propDocumentIds: [document.id] },
        },
      }),
    ).toThrow('not an active prop document');
    expect(f.content.listScenes()[0]).toEqual(scene);
  }
});

it('does not choose an arbitrary primary setting from multiple referenced locations', async () => {
  const f = await setup();
  const other = f.content.saveDocument({
    kind: 'scene',
    title: '站台',
    contentMarkdown: '站台资料',
  });
  const ir = { ...f.ir, references: { sceneDocumentIds: [other.id, f.setting.id] } };
  let scene = f.content.saveScene({ title: '场景切换', authoringIR: ir });
  expect(scene.sceneDocumentId).toBeUndefined();
  expect(scene.sceneDocumentIds).toEqual([other.id, f.setting.id]);
  expect(f.content.listScenes()[0]?.sceneDocumentIds).toEqual([other.id, f.setting.id]);
  scene = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: scene.rowVersion,
    sceneDocumentId: f.setting.id,
  });
  scene = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: scene.rowVersion,
    authoringIR: ir,
  });
  expect(scene.sceneDocumentId).toBe(f.setting.id);
});

it('repairs IR-only data on writable reopen exactly once and retains later explicit unbinding', async () => {
  const f = await setup();
  const scene = f.content.saveScene({ title: '旧场次' });
  f.projects.access(true, (db) =>
    db
      .prepare(
        'UPDATE scenes SET authoring_ir_json=?,video_prompt=?,authoring_bindings_applied=0 WHERE id=?',
      )
      .run(JSON.stringify(f.ir), f.ir.prompt, scene.id),
  );
  f.projects.close();
  f.projects.open(f.project.rootPath);
  const repaired = f.content.listScenes()[0]!;
  expect(repaired).toMatchObject({
    authoringIR: f.ir,
    videoPrompt: f.ir.prompt,
    sceneDocumentId: f.setting.id,
    characterBindings: [{ characterDocumentId: f.actor.id }],
    rowVersion: scene.rowVersion + 1,
  });
  f.projects.access(true, (db) => repairIRSceneBindings(db));
  expect(f.content.listScenes()[0]).toEqual(repaired);
  const unbound = f.content.saveScene({
    sceneId: scene.id,
    title: scene.title,
    expectedRowVersion: repaired.rowVersion,
    characterBindings: [],
    sceneDocumentId: null,
  });
  f.projects.close();
  f.projects.open(f.project.rootPath);
  expect(f.content.listScenes()[0]).toEqual(unbound);
  expect(unbound.characterBindings).toEqual([]);
  expect(unbound.sceneDocumentId).toBeUndefined();
});

it('keeps existing manual bindings when repairing and skips stale or invalid historical IR', async () => {
  const f = await setup();
  const manual = f.content.saveDocument({
    kind: 'character',
    title: '乘客',
    contentMarkdown: '乘客',
  });
  const first = f.content.saveScene({
    title: '手动角色',
    characterBindings: [{ characterDocumentId: manual.id, imageDisabled: true }],
  });
  const stale = f.content.saveScene({ title: '已改正文', videoPrompt: '新的正文' });
  const invalid = f.content.saveScene({ title: '引用失效' });
  f.projects.access(true, (db) => {
    db.prepare(
      'UPDATE scenes SET authoring_ir_json=?,video_prompt=?,authoring_bindings_applied=0 WHERE id=?',
    ).run(JSON.stringify(f.ir), f.ir.prompt, first.id);
    db.prepare('UPDATE scenes SET authoring_ir_json=?,authoring_bindings_applied=0 WHERE id=?').run(
      JSON.stringify(f.ir),
      stale.id,
    );
    db.prepare(
      'UPDATE scenes SET authoring_ir_json=?,video_prompt=?,authoring_bindings_applied=0 WHERE id=?',
    ).run(
      JSON.stringify({ ...f.ir, references: { characterDocumentIds: ['missing'] } }),
      f.ir.prompt,
      invalid.id,
    );
    repairIRSceneBindings(db);
  });
  const scenes = f.content.listScenes();
  expect(scenes[0]!.characterBindings).toEqual(first.characterBindings);
  expect(scenes[0]!.sceneDocumentId).toBe(f.setting.id);
  for (const scene of scenes.slice(1)) {
    expect(scene.characterBindings).toEqual([]);
    expect(scene.sceneDocumentId).toBeUndefined();
  }
});

it('rolls back IR, prompt and bindings together on save conflicts or protected dialogue cast removal', async () => {
  const f = await setup();
  const scene = f.content.saveScene({ title: '保护对白', authoringIR: f.ir });
  f.projects.access(true, (db, project) =>
    db
      .prepare(
        "INSERT INTO dubbing_cues(id,project_id,scene_id,speaker_kind,character_document_id,text,position,start_ms,created_at,updated_at) VALUES('cue',?,?,'character',?,'你好',0,0,'now','now')",
      )
      .run(project.id, scene.id, f.actor.id),
  );
  expect(() =>
    f.content.saveScene({
      sceneId: scene.id,
      title: '不应保存',
      expectedRowVersion: scene.rowVersion,
      authoringIR: { ...f.ir, references: { characterDocumentIds: [] } },
    }),
  ).toThrow('仍有本场台词');
  expect(() =>
    f.content.saveScene({
      sceneId: scene.id,
      title: '过期',
      expectedRowVersion: -1,
      authoringIR: f.ir,
    }),
  ).toThrow('SCENE_ROW_VERSION_CONFLICT');
  expect(f.content.listScenes()[0]).toEqual(scene);
});

it('revalidates approved IR references and atomically conflicts the draft if a document was archived', async () => {
  const f = await setup();
  const changes = new ChangeSetService(f.projects);
  const proposal = changes.create({
    title: '审批前失效',
    items: [
      { entityType: 'scene', action: 'create', title: '不能保存', authoringIR: f.ir },
      {
        entityType: 'shot',
        action: 'create',
        parentItemOrdinal: 0,
        title: '不能保存镜头',
        authoringIR: { ...f.ir, kind: 'shot' },
      },
    ],
  });
  f.projects.access(true, (db) =>
    db.prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?").run(f.actor.id),
  );
  expect(
    changes.apply({ changeSetId: proposal.id, expectedRowVersion: proposal.rowVersion }).status,
  ).toBe('conflicted');
  expect(f.content.listScenes()).toEqual([]);
  expect(
    f.projects.access(false, (db) =>
      db.prepare('SELECT COUNT(*) AS count FROM scene_character_bindings').get(),
    ),
  ).toEqual({ count: 0 });
});
