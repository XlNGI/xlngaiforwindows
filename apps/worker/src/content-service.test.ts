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
});
