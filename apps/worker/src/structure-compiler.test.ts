import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { NovelService } from './novel-service.js';
import { ProjectService } from './project-service.js';
import { ProjectStructureCompiler, renderProjectStructure } from './structure-compiler.js';

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
        expect.objectContaining({ type: 'novel-reference', sourceId: binding.id }),
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
