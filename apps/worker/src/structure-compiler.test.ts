import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';
import { ProjectStructureCompiler, renderProjectStructure } from './structure-compiler.js';
import { compileProjectResourceMap, resolveWriteResource } from './project-resource-map.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(name = 'Structure Project') {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-structure-compiler-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), name);
  return {
    project,
    novel: new NovelService(project),
    content: new ContentService(project),
    workflow: new DocumentWorkflowService(project),
    compiler: new ProjectStructureCompiler(),
  };
}

describe('ProjectStructureCompiler', () => {
  it('keeps novel-reference source types consistent before a novel profile exists', async () => {
    const { project, novel, content, compiler } = await setup();
    const reference = content.saveDocument({
      kind: 'outline',
      title: '小说大纲：清风',
      contentMarkdown: '# 大纲\n私有正文',
    });
    novel.saveBinding({ documentId: reference.id, role: 'work-outline', domainScope: 'novel' });
    project.access(false, (database, opened) => {
      const snapshot = compiler.compileFromDatabase(database, opened);
      expect(snapshot.novel).toBeUndefined();
      expect(snapshot.sources.find((source) => source.documentId === reference.id)).toMatchObject({
        type: 'novel-reference',
        sourceId: reference.id,
      });
      expect(
        compileProjectResourceMap(database, opened).resources.find(
          (resource) => resource.documentId === reference.id,
        )?.sourceType,
      ).toBe('novel-reference');
      expect(JSON.stringify(snapshot)).not.toContain('私有正文');
    });
  });

  it('describes the scene page and gives shots their actual scene parent without bodies', async () => {
    const { project } = await setup();
    const content = new ContentService(project);
    const setting = content.saveDocument({
      kind: 'scene',
      title: '庭院设定',
      contentMarkdown: '# 庭院\n场景设定私有正文',
    });
    const scene = content.saveScene({ title: '庭院', sceneDocumentId: setting.id });
    const shot = content.saveShot({
      sceneId: scene.id,
      title: '远景',
      prompt: '不应进入目录的提示词正文',
    });
    project.access(false, (database, opened) => {
      const map = compileProjectResourceMap(database, opened);
      const page = map.resources.find((resource) => resource.id === 'workspace:shots');
      expect(page).toMatchObject({
        writeTool: 'scene.submit_structure',
      });
      expect(page?.contentModel).toContain('自动保存为可编辑草稿');
      expect(page?.contentModel).toContain('无需用户确认');
      expect(map.resources.find((resource) => resource.id === `shot:${shot.id}`)).toMatchObject({
        parentId: `scene:${scene.id}`,
        locator: {
          workspace: 'shots',
          sceneId: scene.id,
          shotId: shot.id,
          sceneDocumentId: setting.id,
        },
      });
      expect(
        map.resources.find((resource) => resource.id === `scene:${scene.id}`)?.locator
          .sceneDocumentId,
      ).toBe(setting.id);
      expect(JSON.stringify(map)).not.toContain(shot.prompt);
      expect(JSON.stringify(map)).not.toContain('场景设定私有正文');
    });
  });
  it('keeps page IDs usable when the catalog is truncated and validates revisions beyond the preview', async () => {
    const { project, workflow } = await setup();
    const omitted = workflow.saveDraft({ title: '旧资料', contentMarkdown: '不注入正文' });
    project.access(true, (database) =>
      database.transaction(() => {
        database
          .prepare("UPDATE documents SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?")
          .run(omitted.id);
        for (let index = 0; index < 105; index++)
          workflow.saveDraft({ title: `新资料${index}`, contentMarkdown: '# 标题\n正文' });
      })(),
    );
    const before = project.access(false, (database, opened) => {
      const map = compileProjectResourceMap(database, opened);
      expect(map.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(map), 'utf8')).toBeLessThan(31_000);
      expect(map.resources.some((item) => item.documentId === omitted.id)).toBe(false);
      expect(
        resolveWriteResource(database, opened, { resourceId: `document:${omitted.id}` })
          ?.documentId,
      ).toBe(omitted.id);
      return map.revision;
    });
    project.access(true, (database) =>
      database
        .prepare('UPDATE documents SET row_version = row_version + 1 WHERE id = ?')
        .run(omitted.id),
    );
    project.access(false, (database, opened) => {
      expect(compileProjectResourceMap(database, opened).revision).not.toBe(before);
      expect(() =>
        resolveWriteResource(database, opened, {
          resourceId: `document:${omitted.id}`,
          expectedRevision: before,
        }),
      ).toThrow('revision is stale');
    });
  });
  it('exposes every empty page and keeps novel references in 小说 before a novel profile exists', async () => {
    const { project, novel, workflow } = await setup();
    const reference = workflow.saveDraft({
      title: '同名大纲',
      kind: 'outline',
      contentMarkdown: '# 设定\n小说私有正文',
    });
    novel.saveBinding({ documentId: reference.id, role: 'work-outline', domainScope: 'novel' });
    const script = workflow.saveDraft({
      title: '同名大纲',
      kind: 'outline',
      contentMarkdown: '# 设定\n短剧私有正文',
    });
    project.access(false, (database, opened) => {
      const map = compileProjectResourceMap(database, opened);
      expect(map.resources.filter((item) => item.kind === 'workspace')).toHaveLength(7);
      expect(
        map.resources.find((item) => item.id === `document:${reference.id}`)?.locator.workspace,
      ).toBe('novel');
      expect(
        map.resources.find((item) => item.id === `document:${script.id}`)?.locator.workspace,
      ).toBe('documents');
      expect(JSON.stringify(map)).not.toContain('私有正文');
      expect(() =>
        resolveWriteResource(database, opened, {
          resourceId: `document:${reference.id}`,
          documentId: script.id,
        }),
      ).toThrow('documentId does not match');
      expect(() =>
        resolveWriteResource(database, opened, {
          resourceId: `document:${script.id}`,
          versionId: reference.currentVersionId,
        }),
      ).toThrow('versionId does not match');
      expect(() =>
        resolveWriteResource(database, opened, {
          resourceId: `document:${script.id}`,
          expectedRevision: 'stale',
        }),
      ).toThrow('revision is stale');
    });
  });

  it('rejects cross-project, archived, and stale-node resource locators', async () => {
    const local = await setup();
    const foreign = await setup();
    const remote = foreign.workflow.saveDraft({ title: '外部', contentMarkdown: '外部正文' });
    const original = local.workflow.saveDraft({ title: '草稿', contentMarkdown: '# 标题\n原文' });
    const node = local.project.access(false, (database, opened) =>
      compileProjectResourceMap(database, opened).resources.find(
        (item) => item.kind === 'structure-node' && item.documentId === original.id,
      )!,
    );
    local.workflow.saveDraft({
      documentId: original.id,
      title: '草稿',
      contentMarkdown: '# 新标题\n修订正文',
      expectedDocumentRowVersion: original.rowVersion,
    });
    local.project.access(false, (database, opened) => {
      expect(() =>
        resolveWriteResource(database, opened, { resourceId: `document:${remote.id}` }),
      ).toThrow('not found');
      expect(() => resolveWriteResource(database, opened, { resourceId: node.id })).toThrow();
    });
    local.project.access(true, (database) =>
      database
        .prepare("UPDATE documents SET lifecycle_status = 'archived' WHERE id = ?")
        .run(original.id),
    );
    local.project.access(false, (database, opened) => {
      expect(
        compileProjectResourceMap(database, opened).resources.some(
          (item) => item.documentId === original.id,
        ),
      ).toBe(false);
      expect(() =>
        resolveWriteResource(database, opened, { resourceId: `document:${original.id}` }),
      ).toThrow('not found');
    });
  });
  it('compiles an empty project without inventing a novel structure', async () => {
    const { project, compiler } = await setup('空项目');
    const snapshot = project.access(false, (database, opened) =>
      compiler.compileFromDatabase(database, opened),
    );

    expect(snapshot.project).toMatchObject({ id: project.current()!.id, name: '空项目' });
    expect(snapshot.domains.documents).toEqual({ enabled: false, count: 0 });
    expect(snapshot.novel).toBeUndefined();
    expect(snapshot.domains.novel).toBeUndefined();
    expect(snapshot.revision).toEqual(
      project.access(
        false,
        (database, opened) => compiler.compileFromDatabase(database, opened).revision,
      ),
    );
    expect(renderProjectStructure(snapshot)).toContain('小说：未建立');
  });

  it('projects volume/chapter/reference metadata while omitting document bodies', async () => {
    const { project, novel, content, compiler } = await setup('雾港纪事');
    const imported = novel.importNovel({
      volumeTitle: '第一卷 雾港',
      chapters: [
        {
          title: '雨夜来客',
          displayLabel: '第一章',
          contentMarkdown: '这是不能进入结构快照的正文。',
        },
        { title: '灯塔', contentMarkdown: '灯塔亮起。' },
      ],
    });
    const emptyChapter = novel.saveChapter({ title: '序章', displayLabel: '序幕' });
    const referenceDocument = content.saveDocument({
      kind: 'character',
      title: '林澈人物设定',
      contentMarkdown: '林澈是一名灯塔守望员，正文不可注入。',
    });
    const binding = novel.saveBinding({
      documentId: referenceDocument.id,
      role: 'character-bible',
      domainScope: 'novel',
    });
    const firstImported = imported.chapters[0]!;
    const secondImported = imported.chapters[1]!;

    const snapshot = project.access(false, (database, opened) =>
      compiler.compileFromDatabase(database, opened),
    );
    const novelSnapshot = snapshot.novel!;
    const volume = novelSnapshot.volumes.find((item) => item.title === '第一卷 雾港')!;

    expect(novelSnapshot.profile).toMatchObject({ id: project.current()!.id, title: '雾港纪事' });
    expect(volume.chapters.map((chapter) => chapter.title)).toEqual(['雨夜来客', '灯塔']);
    expect(novelSnapshot.unassignedChapters).toEqual([
      expect.objectContaining({
        id: emptyChapter.id,
        title: '序章',
        documentId: emptyChapter.documentId,
        status: 'empty',
      }),
    ]);
    expect(volume.chapters).toEqual([
      expect.objectContaining({
        id: firstImported.id,
        documentId: firstImported.documentId,
        displayLabel: '第一章',
        status: 'draft',
      }),
      expect.objectContaining({
        id: secondImported.id,
        status: 'draft',
      }),
    ]);
    expect(typeof volume.chapters[0]?.draftVersionId).toBe('string');
    expect(typeof volume.chapters[1]?.draftVersionId).toBe('string');
    expect(novelSnapshot.references).toEqual([
      expect.objectContaining({
        id: binding.id,
        documentId: referenceDocument.id,
        title: '林澈人物设定',
        role: 'character-bible',
        domainScope: 'novel',
        status: 'active',
      }),
    ]);
    expect(typeof novelSnapshot.references[0]?.draftVersionId).toBe('string');
    expect(snapshot.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'novel-chapter', sourceId: firstImported.id }),
        expect.objectContaining({ type: 'novel-reference', sourceId: referenceDocument.id }),
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toContain('这是不能进入结构快照的正文');
    expect(JSON.stringify(snapshot)).not.toContain('正文不可注入');
  });

  it('marks a chapter canonical only after publication and changes revision on facts', async () => {
    const { project, novel, workflow, compiler } = await setup();
    const imported = novel.importNovel({
      chapters: [{ title: '第一章', contentMarkdown: '草稿正文。' }],
    });
    const chapter = imported.chapters[0]!;
    const before = project.access(false, (database, opened) =>
      compiler.compileNovel(database, opened),
    )!;
    expect(before.volumes).toHaveLength(0);
    expect(before.unassignedChapters[0]).toMatchObject({ status: 'draft' });

    const published = workflow.selfPublish({
      documentId: chapter.documentId,
      expectedDocumentRowVersion: chapter.documentRowVersion,
      expectedPublishedVersionId: undefined,
    });
    const after = project.access(false, (database, opened) =>
      compiler.compileNovel(database, opened),
    )!;
    expect(after.revision).not.toBe(before.revision);
    expect(after.unassignedChapters[0]).toMatchObject({
      id: chapter.id,
      status: 'canonical',
      canonicalVersionId: published.document.currentVersion!.id,
    });

    const stable = project.access(false, (database, opened) =>
      compiler.compileFromDatabase(database, opened),
    );
    const stableAgain = project.access(false, (database, opened) =>
      compiler.compileFromDatabase(database, opened),
    );
    expect(stable.revision).toBe(stableAgain.revision);
    expect(stable.revision).toBe(
      project.access(false, (database, opened) => compiler.compile(database, opened).revision),
    );
  });
});
