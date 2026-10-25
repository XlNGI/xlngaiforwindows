import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeSetService } from './change-set-service.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';
import { VoiceReferenceRepository } from '@ai-video/persistence';

const directories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(name = 'change-set') {
  const directory = await mkdtemp(join(tmpdir(), `ai-video-${name}-`));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  services.push(projects);
  projects.create(join(directory, 'project'), 'Change Set Project');
  return {
    projects,
    content: new ContentService(projects),
    changeSets: new ChangeSetService(projects),
  };
}

describe('ChangeSetService', () => {
  it('normalizes manual text proposals to the same IR and preserves open fields and whitespace', async () => {
    const { content, changeSets } = await setup();
    const sceneIR = {
      schemaVersion: 1 as const,
      kind: 'scene' as const,
      prompt: '  场次原文\n',
      data: { weather: '雨' },
    };
    const scene = content.saveScene({ title: '场次', authoringIR: sceneIR });
    const shotIR = {
      schemaVersion: 1 as const,
      kind: 'shot' as const,
      prompt: '镜头原文',
      references: { characterDocumentIds: [] },
      timing: { estimatedDurationSeconds: 4, rationale: '动作时长' },
      data: { beats: ['转身'] },
    };
    const shot = content.saveShot({ sceneId: scene.id, title: '镜头', authoringIR: shotIR });
    const scenePrompt = '  场次修订\n';
    const shotPrompt = '  镜头修订\n';
    const result = changeSets.saveDraft({
      title: '手工正文修订',
      items: [
        {
          entityType: 'scene',
          action: 'update',
          targetId: scene.id,
          expectedRowVersion: scene.rowVersion,
          title: scene.title,
          videoPrompt: scenePrompt,
          sceneDocumentId: null,
          characterDocumentIds: [],
        },
        {
          entityType: 'shot',
          action: 'update',
          targetId: shot.id,
          expectedRowVersion: shot.rowVersion,
          title: shot.title,
          prompt: shotPrompt,
        },
      ],
    });
    expect(result.status).toBe('applied');
    expect(content.listScenes()[0]).toMatchObject({
      videoPrompt: scenePrompt,
      authoringIR: { ...sceneIR, prompt: scenePrompt },
    });
    expect(content.listShots(scene.id)[0]).toMatchObject({
      prompt: shotPrompt,
      authoringIR: { ...shotIR, prompt: shotPrompt },
    });
  });
  it('persists Agent-authored scene and shot IR through a change set without rewriting prompts', async () => {
    const { content, changeSets } = await setup();
    const actor = content.saveDocument({
      kind: 'character',
      title: '江晚',
      contentMarkdown: '# 江晚',
    });
    const prop = content.saveDocument({
      kind: 'prop',
      title: '铁木杖',
      contentMarkdown: '# 铁木杖',
    });
    const sceneIR = {
      schemaVersion: 1 as const,
      kind: 'scene' as const,
      prompt: '土墙茅顶的铁匠铺，炉火正旺，门外山雾渐浓。',
      references: { characterDocumentIds: [actor.id] },
      data: { placement: { 江晚: '前景炉旁', 老瞎子: '东侧门口' } },
    };
    const shotIR = {
      schemaVersion: 1 as const,
      kind: 'shot' as const,
      prompt: '老瞎子以铁木杖探地，跛行离开铁匠铺。',
      references: { characterDocumentIds: [actor.id], propDocumentIds: [prop.id] },
      data: { action: ['杖尖点地', '左脚探步', '右足拖行'] },
    };
    const proposed = changeSets.create({
      title: '场次与镜头 IR',
      items: [
        { entityType: 'scene', action: 'create', title: '离去', authoringIR: sceneIR },
        {
          entityType: 'shot',
          action: 'create',
          parentItemOrdinal: 0,
          title: '雾中离去',
          authoringIR: shotIR,
        },
      ],
    });
    expect(proposed.items.map((item) => item.authoringIR)).toEqual([sceneIR, shotIR]);
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const scene = content.listScenes()[0]!;
    const shot = content.listShots(scene.id)[0]!;
    expect(scene).toMatchObject({ videoPrompt: sceneIR.prompt, authoringIR: sceneIR });
    expect(scene.characterBindings).toEqual([{ characterDocumentId: actor.id }]);
    expect(shot).toMatchObject({ prompt: shotIR.prompt, authoringIR: shotIR });
  });

  it('saves generated documents, scenes and shots as editable drafts without approval', async () => {
    const { projects, content, changeSets } = await setup();
    const saved = changeSets.saveDraft({
      title: '自动保存',
      items: [
        {
          entityType: 'document',
          action: 'create',
          title: '角色',
          documentKind: 'character',
          contentMarkdown: '角色草稿',
        },
        { entityType: 'scene', action: 'create', title: '庭院' },
        {
          entityType: 'shot',
          action: 'create',
          title: '远景',
          parentItemOrdinal: 1,
          prompt: '清晨庭院',
        },
      ],
    });
    expect(saved.status).toBe('applied');
    expect(changeSets.list()).toHaveLength(0);
    const documentId = saved.items[0]!.appliedEntityId!;
    const document = content.getDocument(documentId);
    expect(document.currentVersion?.state).toBe('draft');
    const scene = content.listScenes()[0]!;
    const shot = content.listShots(scene.id)[0]!;
    expect(shot).toMatchObject({ status: 'draft', prompt: '清晨庭院' });
    content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: shot.title,
      prompt: '用户后期修改',
      expectedRowVersion: shot.rowVersion,
    });
    const path = projects.access(false, (_db, project) => project.rootPath);
    projects.close();
    projects.open(path);
    expect(content.listShots(scene.id)[0]?.prompt).toBe('用户后期修改');
    expect(content.getDocument(documentId).currentVersion?.state).toBe('draft');
  });

  it('rolls back the whole draft save on a stale update without leaving a pending approval', async () => {
    const { content, changeSets } = await setup();
    const scene = content.saveScene({ title: '手动保存' });
    content.saveScene({
      sceneId: scene.id,
      title: '最新内容',
      expectedRowVersion: scene.rowVersion,
    });
    expect(() =>
      changeSets.saveDraft({
        title: '旧版本生成',
        items: [
          { entityType: 'scene', action: 'create', title: '不能部分保存' },
          {
            entityType: 'scene',
            action: 'update',
            targetId: scene.id,
            expectedRowVersion: scene.rowVersion,
            title: '过期内容',
          },
        ],
      }),
    ).toThrow('DRAFT_SAVE_CONFLICT');
    expect(content.listScenes().map((item) => item.title)).toEqual(['最新内容']);
    expect(changeSets.list({ includeTerminal: true })).toHaveLength(0);
  });

  it('reviews LLM scene/cast IDs and follows character defaults, preserving explicit selections on revision', async () => {
    const { projects, content, changeSets } = await setup();
    const setting = content.saveDocument({
      kind: 'scene',
      title: '庭院',
      contentMarkdown: '# 庭院',
    });
    const actor = content.saveDocument({
      kind: 'character',
      title: '角色：老周（司机）',
      contentMarkdown: '# 老周',
    });
    const voice = projects.access(true, (db, project) => {
      db.prepare(
        "INSERT INTO audio_files(id,project_id,kind,name,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,channels,created_at) VALUES('sample',?,'reference','司机','assets/audio/reference/sample.wav','audio/wav',100,?,3000,48000,1,'now')",
      ).run(project.id, 'a'.repeat(64));
      for (const [id, documentId, kind] of [
        ['actor-image', actor.id, 'character'],
        ['scene-image', setting.id, 'scene'],
      ]) {
        db.prepare(
          'INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,?,?,?,100,?)',
        ).run(id, project.id, kind, `assets/${id}.png`, 'a'.repeat(64), 'now');
        db.prepare(
          "INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES(?,?,'fixture','succeeded','{}',?,'now','now')",
        ).run(`job-${id}`, project.id, JSON.stringify({ sourceDocumentId: documentId }));
        db.prepare(
          "INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES(?,?,?,'now')",
        ).run(`result-${id}`, `job-${id}`, id);
      }
      return new VoiceReferenceRepository(db, project.id).save({
        characterDocumentId: actor.id,
        audioId: 'sample',
      });
    });
    const item = {
      entityType: 'scene' as const,
      action: 'create' as const,
      title: '相遇',
      sceneDocumentId: setting.id,
      videoPrompt: '司机转身，他没有开口。',
      characterDocumentIds: [actor.id],
    };
    const proposal = changeSets.create({ title: 'LLM 方案', items: [item] });
    expect(content.listScenes()).toHaveLength(0);
    expect(changeSets.list()[0]?.items[0]).toMatchObject({
      videoPrompt: item.videoPrompt,
      characterDocumentIds: [actor.id],
    });
    expect(
      changeSets.apply({ changeSetId: proposal.id, expectedRowVersion: proposal.rowVersion })
        .status,
    ).toBe('applied');
    const scene = content.listScenes()[0]!;
    expect(scene).toMatchObject({
      videoPrompt: item.videoPrompt,
      sceneDocumentId: setting.id,
      characterBindings: [
        {
          characterDocumentId: actor.id,
        },
      ],
      materialBindings: [{ assetId: 'scene-image', sourceDocumentId: setting.id }],
    });
    projects.access(true, (db, project) =>
      new VoiceReferenceRepository(db, project.id).save({
        characterDocumentId: actor.id,
        audioId: 'sample',
        expectedRowVersion: voice.rowVersion,
      }),
    );
    const revised = changeSets.create({
      title: '修订',
      items: [
        {
          ...item,
          action: 'update',
          targetId: scene.id,
          expectedRowVersion: scene.rowVersion,
          videoPrompt: '他独自坐下。',
        },
      ],
    });
    expect(
      changeSets.apply({ changeSetId: revised.id, expectedRowVersion: revised.rowVersion }).status,
    ).toBe('applied');
    expect(content.listScenes()[0]?.characterBindings).toEqual(scene.characterBindings);
    const current = content.listScenes()[0]!;
    const cleared = content.saveScene({
      sceneId: current.id,
      title: current.title,
      expectedRowVersion: current.rowVersion,
      characterBindings: [{ characterDocumentId: actor.id }],
    });
    const clearScene = changeSets.create({
      title: '清除场景',
      items: [
        {
          ...item,
          action: 'update',
          targetId: scene.id,
          expectedRowVersion: cleared.rowVersion,
          sceneDocumentId: null,
          videoPrompt: '他走进空白空间。',
        },
      ],
    });
    expect(
      changeSets.apply({ changeSetId: clearScene.id, expectedRowVersion: clearScene.rowVersion })
        .status,
    ).toBe('applied');
    expect(content.listScenes()[0]?.sceneDocumentId).toBeUndefined();
    expect(content.listScenes()[0]?.materialBindings).toEqual([]);
    expect(content.listScenes()[0]?.characterBindings).toEqual([{ characterDocumentId: actor.id }]);
  });

  it('rejects invalid structured cast without partial proposals and revalidates archived roles at approval', async () => {
    const { projects, content, changeSets } = await setup();
    const actor = content.saveDocument({
      kind: 'character',
      title: '同名角色',
      contentMarkdown: '# 角色',
    });
    const setting = content.saveDocument({
      kind: 'scene',
      title: '同名角色',
      contentMarkdown: '# 地点',
    });
    const novel = content.saveDocument({
      kind: 'character',
      title: '小说人物',
      contentMarkdown: '# 小说人物',
    });
    projects.access(true, (db, project) => {
      db.prepare(
        "INSERT INTO document_bindings(id,project_id,document_id,role,domain_scope,status,row_version,created_at,updated_at) VALUES('novel-character-binding',?,?,'character-bible','novel','active',0,'now','now')",
      ).run(project.id, novel.id);
      db.exec(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES('foreign','Foreign','now','now'); INSERT INTO documents(id,project_id,kind,title,created_at,updated_at) VALUES('foreign-role','foreign','character','同名角色','now','now');",
      );
    });
    for (const ids of [
      ['missing'],
      [setting.id],
      [actor.id, actor.id],
      [novel.id],
      ['foreign-role'],
    ]) {
      expect(() =>
        changeSets.create({
          title: '无效',
          items: [
            {
              entityType: 'scene',
              action: 'create',
              title: '第一场',
              sceneDocumentId: setting.id,
              videoPrompt: '他转身。',
              characterDocumentIds: ids,
            },
          ],
        }),
      ).toThrow();
      expect(changeSets.list()).toEqual([]);
    }
    const proposal = changeSets.create({
      title: '待审核',
      items: [
        {
          entityType: 'scene',
          action: 'create',
          title: '第一场',
          sceneDocumentId: setting.id,
          videoPrompt: '他转身。',
          characterDocumentIds: [actor.id],
        },
      ],
    });
    projects.access(true, (db) =>
      db.prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?").run(actor.id),
    );
    expect(
      changeSets.apply({ changeSetId: proposal.id, expectedRowVersion: proposal.rowVersion })
        .status,
    ).toBe('conflicted');
    expect(content.listScenes()).toEqual([]);
  });

  it('rolls back prompt and bindings when a proposal is stale or removes a speaking role', async () => {
    const { projects, content, changeSets } = await setup();
    const actor = content.saveDocument({
      kind: 'character',
      title: '角色',
      contentMarkdown: '# 角色',
    });
    const scene = content.saveScene({
      title: '第一场',
      videoPrompt: '原提示词',
      characterBindings: [{ characterDocumentId: actor.id }],
    });
    const propose = () =>
      changeSets.create({
        title: '修订',
        items: [
          {
            entityType: 'scene',
            action: 'update',
            targetId: scene.id,
            expectedRowVersion: scene.rowVersion,
            title: scene.title,
            sceneDocumentId: null,
            videoPrompt: '新提示词',
            characterDocumentIds: [],
          },
        ],
      });
    const speaking = propose();
    projects.access(true, (db, project) =>
      db
        .prepare(
          "INSERT INTO dubbing_cues(id,project_id,scene_id,speaker_kind,character_document_id,text,position,start_ms,created_at,updated_at) VALUES('cue',?,?,'character',?,'你好',0,0,'now','now')",
        )
        .run(project.id, scene.id, actor.id),
    );
    expect(
      changeSets.apply({ changeSetId: speaking.id, expectedRowVersion: speaking.rowVersion })
        .status,
    ).toBe('conflicted');
    expect(content.listScenes()[0]).toMatchObject({
      videoPrompt: '原提示词',
      rowVersion: scene.rowVersion,
      characterBindings: scene.characterBindings,
    });
    const stale = propose();
    content.saveScene({
      sceneId: scene.id,
      title: '人工改名',
      expectedRowVersion: scene.rowVersion,
    });
    expect(
      changeSets.apply({ changeSetId: stale.id, expectedRowVersion: stale.rowVersion }).status,
    ).toBe('conflicted');
    expect(content.listScenes()[0]?.videoPrompt).toBe('原提示词');
  });
  it('preserves scene bindings in proposals and rejects a scene document archived before approval', async () => {
    const { projects, content, changeSets } = await setup();
    const setting = content.saveDocument({
      kind: 'scene',
      title: '庭院',
      contentMarkdown: '# 庭院',
    });
    const proposal = changeSets.create({
      title: '相遇',
      items: [
        { entityType: 'scene', action: 'create', title: '晨间相遇', sceneDocumentId: setting.id },
        {
          entityType: 'shot',
          action: 'create',
          title: '远景',
          parentItemOrdinal: 0,
          prompt: '庭院相遇',
        },
      ],
    });
    expect(changeSets.list()[0]?.items[0]?.sceneDocumentId).toBe(setting.id);
    expect(content.listScenes()).toHaveLength(0);
    projects.access(true, (database) =>
      database
        .prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?")
        .run(setting.id),
    );
    const conflicted = changeSets.apply({
      changeSetId: proposal.id,
      expectedRowVersion: proposal.rowVersion,
    });
    expect(conflicted.status).toBe('conflicted');
    expect(content.listScenes()).toHaveLength(0);
    projects.access(true, (database) =>
      database.prepare("UPDATE documents SET lifecycle_status='active' WHERE id=?").run(setting.id),
    );
    const next = changeSets.create({
      title: '再相遇',
      items: [
        { entityType: 'scene', action: 'create', title: '晨间相遇', sceneDocumentId: setting.id },
      ],
    });
    changeSets.apply({ changeSetId: next.id, expectedRowVersion: next.rowVersion });
    expect(content.listScenes()[0]?.sceneDocumentId).toBe(setting.id);
  });
  it('creates and applies a scene plus dependent shot proposal', async () => {
    const { changeSets } = await setup();
    const proposed = changeSets.create({
      title: 'Opening sequence',
      items: [
        { entityType: 'scene', action: 'create', title: 'Scene 01' },
        {
          entityType: 'shot',
          action: 'create',
          parentItemOrdinal: 0,
          title: 'Wide establishing shot',
          shotStatus: 'planned',
        },
      ],
    });
    expect(proposed.status).toBe('proposed');
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(applied.status).toBe('applied');
    expect(applied.items).toMatchObject([
      { entityType: 'scene', status: 'applied' },
      { entityType: 'shot', status: 'applied' },
    ]);
    expect(applied.items[1]!.appliedEntityId).toBeTruthy();
  });

  it('applies shot prompts into shots.prompt when approved', async () => {
    const { changeSets, content } = await setup();
    const proposed = changeSets.create({
      title: 'Episode scenes with shot prompts',
      items: [
        { entityType: 'scene', action: 'create', title: '旧码头 · 台风前夜' },
        {
          entityType: 'shot',
          action: 'create',
          parentItemOrdinal: 0,
          title: '海雾中的码头',
          prompt: '[场景:旧码头] 全景，台风前夜，海雾低垂。',
        },
      ],
    });
    expect(proposed.items[1]).toMatchObject({ prompt: '[场景:旧码头] 全景，台风前夜，海雾低垂。' });
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const scene = content.listScenes()[0]!;
    const shots = content.listShots(scene.id);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      title: '海雾中的码头',
      prompt: '[场景:旧码头] 全景，台风前夜，海雾低垂。',
    });
  });

  it('rejects shot prompts on scene proposals', async () => {
    const { changeSets } = await setup();
    expect(() =>
      changeSets.create({
        title: 'Invalid',
        items: [{ entityType: 'scene', action: 'create', title: 'Scene', prompt: 'not allowed' }],
      }),
    ).toThrow(/Scene proposals cannot include shot parent, status or prompt fields/);
  });

  it('rejects shot prompts on document proposals', async () => {
    const { changeSets } = await setup();
    expect(() =>
      changeSets.create({
        title: 'Invalid',
        items: [
          {
            entityType: 'document',
            action: 'create',
            title: 'Notes',
            documentKind: 'note',
            contentMarkdown: '# Notes',
            prompt: 'not allowed',
          },
        ],
      }),
    ).toThrow(/Document proposals cannot include a shot prompt/);
  });

  it('supports selected partial apply and reject', async () => {
    const { changeSets } = await setup();
    const proposed = changeSets.create({
      title: 'Two scenes',
      items: [
        { entityType: 'scene', action: 'create', title: 'Scene A' },
        { entityType: 'scene', action: 'create', title: 'Scene B' },
      ],
    });
    const first = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
      itemIds: [proposed.items[0]!.id],
    });
    expect(first.status).toBe('partially_applied');
    const rejected = changeSets.reject({
      changeSetId: first.id,
      expectedRowVersion: first.rowVersion,
      itemIds: [first.items[1]!.id],
    });
    expect(rejected.status).toBe('partially_applied');
    expect(rejected.items.map((item) => item.status)).toEqual(['applied', 'rejected']);
  });

  it('marks all selected items conflicted and rolls back when CAS fails', async () => {
    const { changeSets, content } = await setup();
    const scene = content.saveScene({ title: 'Existing' });
    const proposed = changeSets.create({
      title: 'Rename existing scene',
      items: [
        {
          entityType: 'scene',
          action: 'update',
          targetId: scene.id,
          expectedRowVersion: scene.rowVersion,
          title: 'Proposed name',
        },
        { entityType: 'scene', action: 'create', title: 'New scene' },
      ],
    });
    content.saveScene({ sceneId: scene.id, title: 'Concurrent name', expectedRowVersion: 0 });
    const conflicted = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(conflicted.status).toBe('conflicted');
    expect(conflicted.items.every((item) => item.status === 'conflicted')).toBe(true);
    expect(content.listScenes()).toMatchObject([{ id: scene.id, title: 'Concurrent name' }]);
  });

  it('applies a document and scene together in one transaction', async () => {
    const { changeSets, content } = await setup();
    const proposed = changeSets.create({
      title: 'Scene package with notes',
      items: [
        {
          entityType: 'document',
          action: 'create',
          title: 'Scene notes',
          documentKind: 'scene',
          contentMarkdown: '# Scene notes\n\nBlocking action.',
        },
        { entityType: 'scene', action: 'create', title: 'Scene 01' },
      ],
    });
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const document = content.getDocument(applied.items[0]!.appliedEntityId!);
    expect(document.title).toBe('Scene notes');
    expect(document.currentVersion?.contentMarkdown).toContain('Blocking action.');
    expect(content.listScenes()).toHaveLength(1);
  });

  it('rolls back scene changes when an associated document CAS conflicts', async () => {
    const { changeSets, content } = await setup();
    const document = content.saveDocument({
      kind: 'scene',
      title: 'Existing notes',
      contentMarkdown: '# Before',
    });
    const proposed = changeSets.create({
      title: 'Update notes and add scene',
      items: [
        {
          entityType: 'document',
          action: 'update',
          targetId: document.id,
          expectedRowVersion: document.rowVersion,
          expectedCurrentVersionId: document.currentVersion!.id,
          title: 'Proposed notes',
          documentKind: 'scene',
          contentMarkdown: '# Proposed',
        },
        { entityType: 'scene', action: 'create', title: 'Must roll back' },
      ],
    });
    content.saveDocument({
      documentId: document.id,
      kind: 'scene',
      title: 'Concurrent notes',
      contentMarkdown: '# Concurrent',
      expectedDocumentRowVersion: document.rowVersion,
    });
    const conflicted = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(conflicted.status).toBe('conflicted');
    expect(content.listScenes()).toHaveLength(0);
    expect(content.getDocument(document.id).title).toBe('Concurrent notes');
  });

  it('rejects cross-project access', async () => {
    const first = await setup('first');
    const proposed = first.changeSets.create({
      title: 'Private proposal',
      items: [{ entityType: 'scene', action: 'create', title: 'Private scene' }],
    });
    const second = await setup('second');
    expect(() =>
      second.changeSets.apply({ changeSetId: proposed.id, expectedRowVersion: 0 }),
    ).toThrow('Change set is not available for review.');
    expect(second.changeSets.list()).toEqual([]);
  });

  it('rejects stale repeated application', async () => {
    const { changeSets } = await setup();
    const proposed = changeSets.create({
      title: 'Single scene',
      items: [{ entityType: 'scene', action: 'create', title: 'Scene' }],
    });
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(() =>
      changeSets.apply({ changeSetId: applied.id, expectedRowVersion: proposed.rowVersion }),
    ).toThrow('Change set is not available for review.');
  });
});
