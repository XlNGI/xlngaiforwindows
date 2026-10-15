import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';

const temporaryDirectories: string[] = [];
const projectServices: ProjectService[] = [];

afterEach(async () => {
  for (const service of projectServices.splice(0)) service.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-content-'));
  temporaryDirectories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projectServices.push(projects);
  projects.create(join(directory, 'project'), 'M2 Project');
  return { projects, content: new ContentService(projects) };
}

describe('ContentService', () => {
  it('saves independent cast bindings with CAS, preserves omitted values and rolls back invalid media', async () => {
    const { projects, content } = await setup();
    const character = content.saveDocument({
      kind: 'character',
      title: '无图片角色',
      contentMarkdown: '# 角色',
    });
    const scene = content.saveScene({
      title: '第一场',
      characterBindings: [{ characterDocumentId: character.id }],
    });
    expect(scene.characterBindings).toEqual([{ characterDocumentId: character.id }]);
    const renamed = content.saveScene({
      sceneId: scene.id,
      title: '改名',
      expectedRowVersion: scene.rowVersion,
    });
    expect(renamed.characterBindings).toEqual(scene.characterBindings);
    for (const characterBindings of [
      [{ characterDocumentId: character.id, imageAssetId: 'missing' }],
      [{ characterDocumentId: character.id, voiceReferenceVersionId: 'missing' }],
      [{ characterDocumentId: character.id }, { characterDocumentId: character.id }],
      [{ characterDocumentId: 'missing' }],
    ])
      expect(() =>
        content.saveScene({
          sceneId: scene.id,
          title: '不应保存',
          expectedRowVersion: renamed.rowVersion,
          characterBindings,
        }),
      ).toThrow();
    expect(content.listScenes()[0]).toMatchObject({
      title: '改名',
      rowVersion: renamed.rowVersion,
      characterBindings: scene.characterBindings,
    });
    expect(() =>
      content.saveScene({
        sceneId: scene.id,
        title: '过期',
        expectedRowVersion: scene.rowVersion,
        characterBindings: [],
      }),
    ).toThrow('SCENE_ROW_VERSION_CONFLICT');
    projects.access(true, (db) =>
      db
        .prepare(
          "INSERT INTO dubbing_cues(id,project_id,scene_id,speaker_kind,character_document_id,text,position,start_ms,created_at,updated_at) VALUES('cue',?,?, 'character',?,'你好',0,0,'now','now')",
        )
        .run(scene.projectId, scene.id, character.id),
    );
    expect(() =>
      content.saveScene({
        sceneId: scene.id,
        title: scene.title,
        expectedRowVersion: renamed.rowVersion,
        characterBindings: [],
      }),
    ).toThrow('仍有本场台词');
    projects.access(true, (db) =>
      db.prepare("UPDATE dubbing_cues SET deleted_at='now' WHERE id='cue'").run(),
    );
    expect(
      content.saveScene({
        sceneId: scene.id,
        title: scene.title,
        expectedRowVersion: renamed.rowVersion,
        characterBindings: [],
      }).characterBindings,
    ).toEqual([]);
  });
  it('persists reusable scene document bindings, preserves them on rename and clears them explicitly', async () => {
    const { content } = await setup();
    const setting = content.saveDocument({
      kind: 'scene',
      title: '庭院',
      contentMarkdown: '# 庭院\n场景提示词',
    });
    const scene = content.saveScene({ title: '晨间相遇', sceneDocumentId: setting.id });
    const evening = content.saveScene({ title: '夜间告别', sceneDocumentId: setting.id });
    expect(content.listScenes().map((item) => item.sceneDocumentId)).toEqual([
      setting.id,
      setting.id,
    ]);
    const renamed = content.saveScene({
      sceneId: scene.id,
      title: '庭院相遇',
      expectedRowVersion: scene.rowVersion,
    });
    expect(renamed.sceneDocumentId).toBe(setting.id);
    expect(() =>
      content.saveScene({
        sceneId: scene.id,
        title: '过期',
        sceneDocumentId: null,
        expectedRowVersion: scene.rowVersion,
      }),
    ).toThrow('SCENE_ROW_VERSION_CONFLICT');
    const unbound = content.saveScene({
      sceneId: renamed.id,
      title: renamed.title,
      sceneDocumentId: null,
      expectedRowVersion: renamed.rowVersion,
    });
    expect(unbound.sceneDocumentId).toBeUndefined();
    expect(content.listScenes().find((item) => item.id === evening.id)?.sceneDocumentId).toBe(
      setting.id,
    );
  });

  it('rejects wrong-kind, archived, novel, missing and foreign scene documents without changing the scene', async () => {
    const { projects, content } = await setup();
    const scene = content.saveScene({ title: '原场次' });
    const character = content.saveDocument({
      kind: 'character',
      title: '人物',
      contentMarkdown: '# 人物',
    });
    const archived = content.saveDocument({
      kind: 'scene',
      title: '归档',
      contentMarkdown: '# 归档',
    });
    const novelSetting = content.saveDocument({
      kind: 'scene',
      title: '小说地点',
      contentMarkdown: '# 小说地点',
    });
    projects.access(true, (database, project) => {
      database
        .prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?")
        .run(archived.id);
      database
        .prepare(
          "INSERT INTO document_bindings (id,project_id,document_id,role,domain_scope,status,row_version,created_at,updated_at) VALUES ('novel-setting-binding',?,?,'world-bible','novel','active',0,'now','now')",
        )
        .run(project.id, novelSetting.id);
      database.exec(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES ('foreign-binding-project','Foreign','now','now'); INSERT INTO documents(id,project_id,kind,title,scope_type,lifecycle_status,row_version,created_at,updated_at) VALUES ('foreign-setting','foreign-binding-project','scene','Foreign','project','active',0,'now','now')",
      );
    });
    for (const sceneDocumentId of [
      character.id,
      archived.id,
      novelSetting.id,
      'missing-setting',
      'foreign-setting',
    ]) {
      expect(() =>
        content.saveScene({
          sceneId: scene.id,
          title: '不能更新',
          sceneDocumentId,
          expectedRowVersion: scene.rowVersion,
        }),
      ).toThrow('制作场景资料');
      expect(content.listScenes()).toMatchObject([
        { id: scene.id, title: '原场次', rowVersion: scene.rowVersion },
      ]);
    }
  });
  it('persists and clears model preferences per conversation and capability', async () => {
    const { content } = await setup();
    const conversation = content.createConversation({ scopeType: 'project' });

    expect(
      content.getConversationModelPreference({
        conversationId: conversation.id,
        capability: 'image',
      }),
    ).toBeNull();
    const saved = content.setConversationModelPreference({
      conversationId: conversation.id,
      capability: 'image',
      providerProfileId: 'profile-image',
      modelId: 'model-image',
    });
    expect(saved).toMatchObject({
      conversationId: conversation.id,
      capability: 'image',
      modelId: 'model-image',
    });
    expect(content.listConversationModelPreferences(conversation.id)).toHaveLength(1);
    expect(
      content.clearConversationModelPreference({
        conversationId: conversation.id,
        capability: 'image',
      }),
    ).toEqual({ cleared: true });
    expect(
      content.clearConversationModelPreference({
        conversationId: conversation.id,
        capability: 'image',
      }),
    ).toEqual({ cleared: false });
  });

  it('creates immutable document versions and restores by creating a new version', async () => {
    const { content } = await setup();
    const first = content.saveDocument({
      kind: 'outline',
      title: '大纲',
      contentMarkdown: '# 第一版',
    });
    const second = content.saveDocument({
      documentId: first.id,
      kind: 'outline',
      title: '大纲',
      contentMarkdown: '# 第二版',
    });
    const restored = content.restoreDocument({
      documentId: first.id,
      versionId: first.currentVersion!.id,
    });

    expect(second.currentVersion?.version).toBe(2);
    expect(restored.currentVersion).toMatchObject({ version: 3, contentMarkdown: '# 第一版' });
    expect(content.listDocumentVersions(first.id)).toHaveLength(3);
  });

  it('keeps project, scene, and shot conversations isolated', async () => {
    const { content } = await setup();
    const scene = content.saveScene({ title: '场次 01' });
    const shot = content.saveShot({ sceneId: scene.id, title: '镜头 01' });
    const projectConversation = content.createConversation({ scopeType: 'project' });
    const sceneConversation = content.createConversation({
      scopeType: 'scene',
      scopeId: scene.id,
    });
    const shotConversation = content.createConversation({
      scopeType: 'shot',
      scopeId: shot.id,
    });

    content.saveMessage({
      conversationId: shotConversation.id,
      role: 'user',
      content: '当前镜头提示词',
    });

    expect(content.listConversations({ scopeType: 'project' })).toMatchObject({
      items: [{ id: projectConversation.id }],
    });
    expect(content.listConversations({ scopeType: 'scene', scopeId: scene.id })).toMatchObject({
      items: [{ id: sceneConversation.id }],
    });
    expect(content.listMessages({ conversationId: shotConversation.id })).toMatchObject({
      items: [{ content: '当前镜头提示词' }],
    });
  });

  it('uses row-version CAS for scene and shot updates', async () => {
    const { content } = await setup();
    const scene = content.saveScene({ title: '场次 01' });
    const shot = content.saveShot({ sceneId: scene.id, title: '镜头 01' });
    expect(scene.rowVersion).toBe(0);
    expect(shot.rowVersion).toBe(0);

    const updatedScene = content.saveScene({
      sceneId: scene.id,
      title: '场次 01 更新',
      expectedRowVersion: scene.rowVersion,
    });
    const updatedShot = content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: '镜头 01 更新',
      expectedRowVersion: shot.rowVersion,
    });
    expect(updatedScene.rowVersion).toBe(1);
    expect(updatedShot.rowVersion).toBe(1);
    expect(() =>
      content.saveScene({
        sceneId: scene.id,
        title: '过期场次更新',
        expectedRowVersion: scene.rowVersion,
      }),
    ).toThrow('SCENE_ROW_VERSION_CONFLICT');
    expect(() =>
      content.saveShot({
        shotId: shot.id,
        sceneId: scene.id,
        title: '过期镜头更新',
        expectedRowVersion: shot.rowVersion,
      }),
    ).toThrow('SHOT_ROW_VERSION_CONFLICT');
  });

  it('saves and updates shot prompts', async () => {
    const { content } = await setup();
    const scene = content.saveScene({ title: '场次 01' });
    const shot = content.saveShot({
      sceneId: scene.id,
      title: '镜头 01',
      prompt: '[场景:旧码头] 全景',
    });
    expect(shot).toMatchObject({ title: '镜头 01', prompt: '[场景:旧码头] 全景' });
    const updated = content.saveShot({
      shotId: shot.id,
      sceneId: scene.id,
      title: '镜头 01',
      prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
      expectedRowVersion: shot.rowVersion,
    });
    expect(updated).toMatchObject({ prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。' });
    expect(content.listShots(scene.id)[0]).toMatchObject({
      prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
    });
    expect(() =>
      content.saveShot({
        sceneId: scene.id,
        title: '镜头 02',
        prompt: 'x'.repeat(2001),
      }),
    ).toThrow('Shot prompt must be at most 2000 characters.');
  });

  it('renames, archives, restores, and filters conversations', async () => {
    const { content } = await setup();
    const conversation = content.createConversation({
      scopeType: 'project',
      title: '大纲讨论',
    });

    const renamed = content.updateConversation({
      conversationId: conversation.id,
      title: '项目会话',
    });
    expect(renamed).toMatchObject({ title: '项目会话' });
    expect(renamed.archivedAt).toBeUndefined();

    const archived = content.archiveConversation({ conversationId: conversation.id });
    expect(archived.archivedAt).toBeTruthy();
    expect(content.listConversations({ scopeType: 'project' })).toEqual({ items: [] });
    expect(content.listConversations({ scopeType: 'project', includeArchived: true })).toEqual({
      items: [expect.objectContaining({ id: conversation.id, title: '项目会话' })],
    });
    expect(content.listConversations({ query: '项目会话' })).toEqual({ items: [] });
    expect(() =>
      content.updateConversation({ conversationId: conversation.id, title: '不可重命名' }),
    ).toThrow('Archived conversations cannot be renamed.');
    expect(() =>
      content.saveMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '归档后写入测试',
      }),
    ).toThrow('Archived conversations cannot be updated.');

    const restored = content.restoreConversation({ conversationId: conversation.id });
    expect(restored.archivedAt).toBeUndefined();
    expect(content.listConversations({ scopeType: 'project', query: '项目' })).toMatchObject({
      items: [{ id: conversation.id, title: '项目会话' }],
    });
  });

  it('pages conversations with a deterministic cursor', async () => {
    const { content } = await setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    const first = content.createConversation({ scopeType: 'project', title: '会话 A' });
    vi.setSystemTime(new Date('2026-08-16T00:00:01.000Z'));
    const second = content.createConversation({ scopeType: 'project', title: '会话 B' });
    vi.setSystemTime(new Date('2026-08-16T00:00:02.000Z'));
    content.saveMessage({ conversationId: first.id, role: 'user', content: '活跃会话' });

    const page = content.listConversations({ scopeType: 'project', limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = content.listConversations({
      scopeType: 'project',
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.items).toMatchObject([{ id: second.id }]);
    expect(next.nextCursor).toBeUndefined();
    vi.useRealTimers();
  });

  it('requires explicit actions to promote chat content', async () => {
    const { content } = await setup();
    const conversation = content.createConversation({ scopeType: 'project' });
    const message = content.saveMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '角色必须始终佩戴红色围巾。',
    });

    expect(content.listDocuments()).toHaveLength(0);
    const document = content.messageToDocument({ messageId: message.id, title: '角色约束' });
    expect(document.currentVersion?.contentMarkdown).toContain('红色围巾');
    expect(content.messageToMemory(message.id).id).toBeTruthy();
    expect(content.messageToConstraint({ messageId: message.id, kind: 'visual' }).id).toBeTruthy();
  });

  it('rejects writes when the project is opened read-only', async () => {
    const { projects } = await setup();
    const reader = new ProjectService({ recentProjectsPath: join(tmpdir(), 'm2-reader.json') });
    projectServices.push(reader);
    reader.open(projects.current()!.rootPath);
    const content = new ContentService(reader);
    expect(() =>
      content.saveDocument({ kind: 'outline', title: '不能写入', contentMarkdown: '' }),
    ).toThrow('read-only');
  });

  it('paginates messages and completes a streaming message in place', async () => {
    const { content } = await setup();
    const conversation = content.createConversation({ scopeType: 'project' });
    const first = content.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '第一条',
    });
    content.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '第二条',
    });
    const streaming = content.saveMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '生成中',
      status: 'streaming',
    });
    const complete = content.saveMessage({
      messageId: streaming.id,
      conversationId: conversation.id,
      role: 'assistant',
      content: '生成完成',
      status: 'complete',
    });

    const latest = content.listMessages({ conversationId: conversation.id, limit: 2 });
    const older = content.listMessages({
      conversationId: conversation.id,
      limit: 2,
      before: latest.nextCursor,
    });
    expect(complete).toMatchObject({ id: streaming.id, content: '生成完成', status: 'complete' });
    expect(latest.items).toHaveLength(2);
    expect([...older.items, ...latest.items].map((message) => message.id)).toEqual(
      expect.arrayContaining([first.id, streaming.id]),
    );
    expect([...older.items, ...latest.items]).toHaveLength(3);
  });

  it('saves a shot storyboard document and attaches it to the shot', async () => {
    const { content } = await setup();
    const scene = content.saveScene({ title: '场次 01' });
    const shot = content.saveShot({ sceneId: scene.id, title: '镜头 01' });

    const storyboard = content.saveShotStoryboard({
      shotId: shot.id,
      title: '镜头 01 分镜',
      contentMarkdown: '# 分镜\n\n1. 远景。',
    });
    expect(storyboard.kind).toBe('storyboard');
    expect(storyboard.scopeType).toBe('shot');
    expect(storyboard.scopeId).toBe(shot.id);
    expect(storyboard.currentVersion?.contentMarkdown).toBe('# 分镜\n\n1. 远景。');
    expect(content.listShots(scene.id).find((item) => item.id === shot.id)?.documentId).toBe(
      storyboard.id,
    );

    const updated = content.saveShotStoryboard({
      shotId: shot.id,
      title: '镜头 01 分镜',
      contentMarkdown: '# 分镜\n\n2. 中景。',
    });
    expect(updated.id).toBe(storyboard.id);
    expect(updated.currentVersion?.version).toBe(2);
    expect(updated.currentVersion?.contentMarkdown).toBe('# 分镜\n\n2. 中景。');
  });

  it('rejects a storyboard save for an unknown shot', async () => {
    const { content } = await setup();
    expect(() =>
      content.saveShotStoryboard({
        shotId: 'missing-shot',
        title: '分镜',
        contentMarkdown: '内容',
      }),
    ).toThrow('Shot was not found.');
  });

  it('lists project constraints promoted from chat messages', async () => {
    const { content } = await setup();
    const conversation = content.createConversation({ scopeType: 'project' });
    const message = content.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '所有镜头必须保持冷色调。',
    });
    content.messageToConstraint({ messageId: message.id });

    const constraints = content.listConstraints();
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({
      scopeType: 'project',
      kind: 'production',
      content: '所有镜头必须保持冷色调。',
    });
  });
});
