import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SceneInfo, ShotInfo } from '@ai-video/contracts';
import {
  listProjectLibraryCatalog,
  searchProjectLibraryChunks,
  searchProjectStructureNodesPage,
} from '@ai-video/persistence';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import { compileProjectResourceMap } from './project-resource-map.js';
import { validateSessionRequestParams } from './request-validation.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'production-lifecycle-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.create(join(directory, 'project'), 'Lifecycle');
  cleanup.push(async () => {
    projects.close();
    await rm(directory, { recursive: true, force: true });
  });
  const content = new ContentService(projects);
  const change = (item: SceneInfo | ShotInfo, archived: boolean) =>
    content.changeProductionLifecycle({
      target: { kind: 'sceneId' in item ? 'shot' : 'scene', id: item.id },
      expectedRowVersion: item.rowVersion,
      archived,
    });
  return { projects, content, change };
}
describe('recoverable scene and shot lifecycle', () => {
  it('preserves content, bindings, order and individual child state across parent archive/restore', async () => {
    const { content, projects, change } = await setup();
    const location = content.saveDocument({
      kind: 'scene',
      title: '共用场景',
      contentMarkdown: '共用资料',
    });
    const scene = content.saveScene({
      title: '雨夜场次',
      sceneDocumentId: location.id,
      prompt: '雨夜场次正文',
    });
    const shot = content.saveShot({
      sceneId: scene.id,
      title: '雨夜镜头',
      ...{
        prompt: '雨夜镜头正文',
        bindings: {
          schemaVersion: 1 as const,
          ...{ sceneDocumentIds: [location.id] },
        },
      },
    });
    content.saveShotReferenceBindings({
      shotId: shot.id,
      referenceBindings: { sceneBindings: [] },
    });
    const storyboard = content.saveShotStoryboard({
      shotId: shot.id,
      title: '雨夜分镜',
      contentMarkdown: '雨夜分镜正文',
    });
    const savedShot = content.listShots(scene.id)[0]!;
    const separate = content.saveShot({ sceneId: scene.id, title: '单独归档镜头', prompt: '保留' });
    const archivedChild = change(separate, true);
    const archivedScene = change(scene, true);
    expect(content.listScenes()).toEqual([]);
    expect(content.listShots(scene.id)).toEqual([]);
    expect(content.listScenes(true)[0]?.archivedAt).toBeTruthy();
    expect(content.listShots(scene.id, true)).toHaveLength(2);
    expect(content.getDocument(location.id).lifecycleStatus).toBe('active');
    expect(() => change(archivedChild, false)).toThrow('先恢复所属场次');
    expect(() => content.saveShot({ sceneId: scene.id, title: '禁止创建' })).toThrow('已归档');
    expect(() =>
      content.saveScene({
        sceneId: scene.id,
        title: '禁止修改',
        expectedRowVersion: archivedScene.rowVersion,
      }),
    ).toThrow('已归档');
    expect(() =>
      content.saveShotReferenceBindings({ shotId: shot.id, referenceBindings: null }),
    ).toThrow('已归档');
    expect(() =>
      content.saveShotStoryboard({ shotId: shot.id, title: '禁止修改', contentMarkdown: '修改' }),
    ).toThrow('已归档');
    projects.access(true, (database) => {
      expect(() =>
        database.prepare('UPDATE shots SET prompt=? WHERE id=?').run('不可修改', shot.id),
      ).toThrow('archived');
      expect(() =>
        database.prepare('UPDATE documents SET title=? WHERE id=?').run('不可修改', storyboard.id),
      ).toThrow('archived');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM production_lifecycle_events').get(),
      ).toEqual({ count: 2 });
    });
    // New positions account for archived rows, and restoration keeps original ordering.
    expect(content.saveScene({ title: '下一场' }).position).toBe(scene.position + 1);
    const restoredScene = change(archivedScene, false);
    expect(restoredScene).toMatchObject({
      prompt: scene.prompt,
      sceneDocumentId: location.id,
      position: scene.position,
    });
    expect(content.listShots(scene.id)).toEqual([savedShot]);
    expect(content.getDocument(storyboard.id).currentVersion?.contentMarkdown).toBe('雨夜分镜正文');
    expect(content.saveShot({ sceneId: scene.id, title: '下一镜' }).position).toBe(
      separate.position + 1,
    );
    change(archivedChild, false);
    expect(content.listShots(scene.id).map((item) => item.id)).toEqual([
      shot.id,
      separate.id,
      expect.any(String),
    ]);
    const archivedShot = change(savedShot, true);
    expect(() =>
      content.saveShot({
        sceneId: scene.id,
        shotId: shot.id,
        title: shot.title,
        expectedRowVersion: archivedShot.rowVersion,
      }),
    ).toThrow('已归档');
    expect(change(archivedShot, false)).toMatchObject({
      prompt: savedShot.prompt,
      bindings: savedShot.bindings,
      timing: savedShot.timing,
      referenceBindings: savedShot.referenceBindings,
      documentId: savedShot.documentId,
    });
  });
  it('fences stale versions, foreign project IDs, published storyboards and read-only projects', async () => {
    const { content, projects, change } = await setup();
    const scene = content.saveScene({ title: '第一场' });
    const shot = content.saveShot({ sceneId: scene.id, title: '镜头' });
    const storyboard = content.saveShotStoryboard({
      shotId: shot.id,
      title: '分镜',
      contentMarkdown: '正文',
    });
    const savedShot = content.listShots(scene.id)[0]!;
    expect(() => change(shot, true)).toThrow('内容已变化');
    const workflow = new DocumentWorkflowService(projects);
    const published = workflow.selfPublish({
      documentId: storyboard.id,
      expectedDocumentRowVersion: storyboard.rowVersion,
    }).document;
    expect(() => change(scene, true)).toThrow('先取消发布');
    expect(() => change(savedShot, true)).toThrow('先取消发布');
    projects.access(true, (database) => {
      database
        .prepare(
          "INSERT INTO projects(id,name,created_at,updated_at) VALUES('foreign','foreign','now','now')",
        )
        .run();
      database
        .prepare(
          "INSERT INTO scenes(id,project_id,title,position,created_at,updated_at) VALUES('foreign-scene','foreign','other',0,'now','now')",
        )
        .run();
    });
    workflow.unpublish({
      documentId: published.id,
      expectedDocumentRowVersion: published.rowVersion,
    });
    expect(() =>
      content.changeProductionLifecycle({
        target: { kind: 'scene', id: 'foreign-scene' },
        expectedRowVersion: 0,
        archived: true,
      }),
    ).toThrow('当前项目');
    const archived = change(scene, true);
    expect(() => change(scene, false)).toThrow('内容已变化');
    change(archived, false);
    const reader = new ProjectService({
      recentProjectsPath: join(projects.current()!.rootPath, 'reader.json'),
    });
    try {
      reader.open(projects.current()!.rootPath);
      expect(() =>
        new ContentService(reader).changeProductionLifecycle({
          target: { kind: 'scene', id: scene.id },
          archived: true,
          expectedRowVersion: content.listScenes()[0]!.rowVersion,
        }),
      ).toThrow('read-only');
    } finally {
      reader.close();
    }
  });
  it('hides archived production and storyboards from default search and directories and restores discovery', async () => {
    const { content, projects, change } = await setup();
    const scene = content.saveScene({ title: '雨夜场次', prompt: '雨夜场次正文' });
    const shot = content.saveShot({ sceneId: scene.id, title: '雨夜镜头', prompt: '雨夜镜头正文' });
    content.saveShotStoryboard({
      shotId: shot.id,
      title: '雨夜分镜',
      contentMarkdown: '雨夜分镜正文',
    });
    const inspect = () =>
      projects.access(false, (database, project) => ({
        search: searchProjectLibraryChunks(database, {
          projectId: project.id,
          query: '雨夜',
          limit: 20,
        }),
        structure: searchProjectStructureNodesPage(database, {
          projectId: project.id,
          query: '雨夜',
        }).hits,
        catalog: listProjectLibraryCatalog(database, project.id),
        map: compileProjectResourceMap(database, project),
        archivedSearch: searchProjectLibraryChunks(database, {
          projectId: project.id,
          query: '雨夜',
          limit: 20,
          includeArchived: true,
        }),
      }));
    expect(inspect().search).toHaveLength(3);
    const archived = change(scene, true);
    const hidden = inspect();
    expect(hidden.search).toEqual([]);
    expect(content.listDocuments()).toEqual([]);
    expect(hidden.structure).toEqual([]);
    expect(
      hidden.catalog.filter((item) => ['scene', 'shot', 'storyboard'].includes(item.sourceType)),
    ).toEqual([]);
    expect(
      hidden.map.resources.filter((item) => ['scene', 'shot', 'storyboard'].includes(item.kind)),
    ).toEqual([]);
    expect(hidden.archivedSearch).toHaveLength(3);
    change(archived, false);
    expect(inspect().search).toHaveLength(3);
    const currentShot = content.listShots(scene.id)[0]!;
    const archivedShot = change(currentShot, true);
    expect(inspect().search.map((item) => item.chunk.sourceType)).toEqual(['scene']);
    change(archivedShot, false);
    expect(inspect().search).toHaveLength(3);
  });
  it('validates lifecycle payloads and list flags strictly', () => {
    expect(() =>
      validateSessionRequestParams('production.lifecycle.change', {
        target: { kind: 'scene', id: 'one' },
        archived: true,
        expectedRowVersion: 0,
      }),
    ).not.toThrow();
    for (const params of [
      { target: { kind: 'document', id: 'one' }, archived: true, expectedRowVersion: 0 },
      { target: { kind: 'scene', id: 'one' }, archived: 'yes', expectedRowVersion: 0 },
      { target: { kind: 'scene', id: 'one' }, archived: true, expectedRowVersion: -1 },
      {
        target: { kind: 'scene', id: 'one', projectId: 'other' },
        archived: true,
        expectedRowVersion: 0,
      },
    ])
      expect(() => validateSessionRequestParams('production.lifecycle.change', params)).toThrow();
    expect(() => validateSessionRequestParams('scene.list', { includeArchived: 'yes' })).toThrow();
  });
});
