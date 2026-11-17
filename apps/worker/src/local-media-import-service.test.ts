import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@ai-video/persistence';
import { LocalMediaImportService } from './local-media-import-service.js';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { productionReferenceImage, validateProductionImageBinding } from './scene-cast-binding.js';
import { resolveSceneMedia } from './scene-media-service.js';
import { validateSessionRequestParams } from './request-validation.js';
import { DocumentWorkflowService } from './document-workflow-service.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8JcAAAAASUVORK5CYII=',
  'base64',
);
const owners: Array<{ projects: ProjectService; root: string }> = [];
afterEach(async () => {
  for (const { projects, root } of owners.splice(0)) {
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'document images 中文 '));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  owners.push({ projects, root });
  const project = projects.create(join(root, 'project'), '资料图片');
  const content = new ContentService(projects);
  const assets = new ImageGenerationService(projects);
  const file = join(root, '自定义图片.PNG');
  await writeFile(file, png);
  return {
    root,
    projects,
    project,
    content,
    assets,
    file,
    service: new LocalMediaImportService(projects, assets),
  };
}

describe.runIf(process.platform === 'win32')(
  'explicit document image import with real decoding',
  () => {
    it.each(['character', 'scene', 'prop'] as const)(
      'persists a local %s image and makes it available to normal production binding after reopening',
      async (kind) => {
        const f = await fixture();
        const document = f.content.saveDocument({
          kind,
          title: '资料',
          contentMarkdown: '已有提示词',
        });
        const [asset] = await f.service.importFiles({ documentId: document.id }, [f.file]);
        expect(asset).toMatchObject({
          kind: `${kind}-image`,
          projectId: f.project.id,
          alias: '自定义图片.PNG',
        });
        expect(await readFile(join(f.project.rootPath, asset!.relativePath))).toEqual(png);
        expect(await readFile(f.file)).toEqual(png);
        expect(f.assets.listAssets({ sourceDocumentId: document.id })).toMatchObject([
          { id: asset!.id },
        ]);
        f.projects.access(false, (db) => {
          expect(productionReferenceImage(db, f.project.id, document.id)).toEqual({
            id: asset!.id,
          });
          expect(() =>
            validateProductionImageBinding(db, f.project.id, asset!.id, document.id, kind),
          ).not.toThrow();
        });
        if (kind === 'character')
          expect(
            resolveSceneMedia(f.projects, { characterDocumentIds: [document.id] }).characters[0]
              ?.defaultImage?.id,
          ).toBe(asset!.id);
        const job = f.assets.locateAssetSource(asset!.id);
        expect(job?.jobId).toBeTruthy();
        expect(await f.service.importFiles({ documentId: document.id }, [f.file])).toMatchObject([
          { id: asset!.id },
        ]);
        expect(f.assets.listAssets({ sourceDocumentId: document.id })).toHaveLength(1);
        const rootPath = f.project.rootPath;
        f.projects.close();
        f.projects.open(rootPath);
        expect(f.assets.listAssets({ sourceDocumentId: document.id })).toMatchObject([
          { id: asset!.id },
        ]);
        const history = () =>
          f.projects.access(false, (db) => ({
            jobs: db.prepare('SELECT * FROM generation_jobs ORDER BY id').all(),
            results: db.prepare('SELECT * FROM generation_results ORDER BY id').all(),
          }));
        const before = history();
        expect(f.service.unbindImage(document.id, asset!.id)).toEqual({ removed: true });
        expect(f.service.unbindImage(document.id, asset!.id)).toEqual({ removed: true });
        expect(f.assets.listAssets({ sourceDocumentId: document.id })).toEqual([]);
        expect(f.assets.listAssets({})).toMatchObject([{ id: asset!.id, deletedAt: undefined }]);
        expect(await readFile(join(rootPath, asset!.relativePath))).toEqual(png);
        expect(history()).toEqual(before);
        f.projects.access(false, (db) => {
          expect(productionReferenceImage(db, f.project.id, document.id)).toBeUndefined();
          expect(() =>
            validateProductionImageBinding(db, f.project.id, asset!.id, document.id, kind),
          ).not.toThrow();
        });
        if (kind === 'character') {
          const resolved = resolveSceneMedia(f.projects, {
            characterDocumentIds: [document.id],
            assetIds: [asset!.id],
          });
          expect(resolved.characters[0]?.defaultImage).toBeUndefined();
          expect(resolved.characters[0]?.images).toEqual([]);
          expect(resolved.assets).toMatchObject([{ id: asset!.id }]);
        }
        f.projects.close();
        f.projects.open(rootPath);
        expect(f.assets.listAssets({ sourceDocumentId: document.id })).toEqual([]);
        await f.service.importFiles({ documentId: document.id }, [f.file]);
        expect(f.assets.listAssets({ sourceDocumentId: document.id })).toMatchObject([
          { id: asset!.id },
        ]);
        expect(history()).toEqual(before);
        expect(await readdir(join(rootPath, 'cache', 'shot-continuity'))).toEqual([]);
      },
    );
    it('binds an existing identical image to a second document without copying or losing its first binding', async () => {
      const f = await fixture();
      const first = f.content.saveDocument({
        kind: 'character',
        title: '角色',
        contentMarkdown: '角色资料',
      });
      const second = f.content.saveDocument({
        kind: 'prop',
        title: '道具',
        contentMarkdown: '道具资料',
      });
      const [a] = await f.service.importFiles({ documentId: first.id }, [f.file]);
      const [b] = await f.service.importFiles({ documentId: second.id }, [f.file]);
      expect(b?.id).toBe(a?.id);
      expect(f.assets.listAssets({})).toHaveLength(1);
      expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toHaveLength(1);
      for (const documentId of [first.id, second.id])
        expect(f.assets.listAssets({ sourceDocumentId: documentId })).toMatchObject([
          { id: a!.id },
        ]);
      f.service.unbindImage(first.id, a!.id);
      expect(f.assets.listAssets({ sourceDocumentId: first.id })).toEqual([]);
      expect(f.assets.listAssets({ sourceDocumentId: second.id })).toMatchObject([{ id: a!.id }]);
      expect(f.assets.listAssets({})).toHaveLength(1);
      expect(await readFile(f.file)).toEqual(png);
      expect(await readFile(join(f.project.rootPath, a!.relativePath))).toEqual(png);
    });
    it('rejects corrupt images, videos, relative paths, empty and oversized files without partial imports', async () => {
      const f = await fixture();
      const document = f.content.saveDocument({
        kind: 'scene',
        title: '场景',
        contentMarkdown: '场景资料',
      });
      for (const [name, bytes] of [
        ['坏图.jpg', png],
        ['视频.mp4', png],
        ['空图.png', Buffer.alloc(0)],
        ['过大.png', Buffer.alloc(20 * 1024 * 1024 + 1)],
      ] as const) {
        const bad = join(f.root, name);
        await writeFile(bad, bytes);
        await expect(
          f.service.importFiles({ documentId: document.id }, [f.file, bad]),
        ).rejects.toThrow();
        expect(f.assets.listAssets({})).toHaveLength(0);
      }
      await expect(
        f.service.importFiles({ documentId: document.id }, ['relative.png']),
      ).rejects.toThrow('本地文件');
      const corrupt = join(f.root, '无法解码.png');
      await writeFile(corrupt, png.subarray(0, 12));
      await expect(f.service.importFiles({ documentId: document.id }, [corrupt])).rejects.toThrow();
      expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
    });
    it('rolls back project copies and local task records if database binding fails', async () => {
      const f = await fixture();
      const document = f.content.saveDocument({
        kind: 'prop',
        title: '道具',
        contentMarkdown: '道具资料',
      });
      f.projects.access(true, (db) =>
        db.exec(
          "CREATE TRIGGER fail_binding BEFORE INSERT ON generation_results BEGIN SELECT RAISE(FAIL,'binding failed'); END",
        ),
      );
      await expect(f.service.importFiles({ documentId: document.id }, [f.file])).rejects.toThrow(
        'binding failed',
      );
      expect(f.assets.listAssets({})).toHaveLength(0);
      expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toEqual([]);
      f.projects.access(false, (db) =>
        expect(
          db
            .prepare(
              "SELECT id FROM generation_jobs WHERE adapter_key='local:document-image-import'",
            )
            .all(),
        ).toHaveLength(0),
      );
    });
    it('rejects wrong, archived, published, novel and unavailable document targets', async () => {
      const f = await fixture();
      const wrong = f.content.saveDocument({
        kind: 'voice',
        title: '音色',
        contentMarkdown: '音色',
      });
      await expect(f.service.importFiles({ documentId: wrong.id }, [f.file])).rejects.toThrow(
        '有效',
      );
      expect(() => f.service.unbindImage(wrong.id, 'asset')).toThrow('有效');
      expect(() => f.service.unbindImage('foreign', 'asset')).toThrow('有效');
      await expect(f.service.importFiles({ documentId: 'foreign' }, [f.file])).rejects.toThrow(
        '有效',
      );
      const document = f.content.saveDocument({
        kind: 'character',
        title: '角色',
        contentMarkdown: '资料',
      });
      const workflow = new DocumentWorkflowService(f.projects);
      expect(() => f.service.unbindImage(document.id, 'unrelated')).toThrow('未绑定');
      const published = workflow.selfPublish({
        documentId: document.id,
        expectedDocumentRowVersion: document.rowVersion,
      });
      await expect(f.service.importFiles({ documentId: document.id }, [f.file])).rejects.toThrow(
        '只读',
      );
      expect(() => f.service.unbindImage(document.id, 'asset')).toThrow('只读');
      workflow.unpublish({
        documentId: document.id,
        expectedDocumentRowVersion: published.document.rowVersion,
      });
      f.projects.access(true, (db) =>
        db.prepare("UPDATE documents SET lifecycle_status='archived' WHERE id=?").run(document.id),
      );
      await expect(f.service.importFiles({ documentId: document.id }, [f.file])).rejects.toThrow(
        '有效',
      );
      expect(() => f.service.unbindImage(document.id, 'asset')).toThrow('有效');
      f.projects.access(true, (db) => {
        db.prepare("UPDATE documents SET lifecycle_status='active' WHERE id=?").run(document.id);
        createRepositories(db).documentBindings.save({
          id: 'novel-binding',
          projectId: f.project.id,
          documentId: document.id,
          role: 'character-bible',
          domainScope: 'novel',
          status: 'active',
          rowVersion: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
      await expect(f.service.importFiles({ documentId: document.id }, [f.file])).rejects.toThrow(
        '有效',
      );
      expect(f.assets.listAssets({})).toHaveLength(0);
      expect(() => f.service.unbindImage(document.id, 'asset')).toThrow('有效');
    });
    it('rolls back failed unbind and rebind writes without changing files or history', async () => {
      const f = await fixture();
      const document = f.content.saveDocument({
        kind: 'character',
        title: '角色',
        contentMarkdown: '资料',
      });
      const [asset] = await f.service.importFiles({ documentId: document.id }, [f.file]);
      f.projects.access(true, (db) =>
        db.exec(
          "CREATE TRIGGER fail_unbind BEFORE UPDATE ON projects BEGIN SELECT RAISE(FAIL,'save failed'); END",
        ),
      );
      expect(() => f.service.unbindImage(document.id, asset!.id)).toThrow('save failed');
      expect(f.assets.listAssets({ sourceDocumentId: document.id })).toHaveLength(1);
      f.projects.access(true, (db) => db.exec('DROP TRIGGER fail_unbind'));
      f.service.unbindImage(document.id, asset!.id);
      f.projects.access(true, (db) =>
        db.exec(
          "CREATE TRIGGER fail_rebind BEFORE DELETE ON document_image_exclusions BEGIN SELECT RAISE(FAIL,'rebind failed'); END",
        ),
      );
      await expect(f.service.importFiles({ documentId: document.id }, [f.file])).rejects.toThrow(
        'rebind failed',
      );
      expect(f.assets.listAssets({ sourceDocumentId: document.id })).toEqual([]);
      expect(f.assets.listAssets({})).toHaveLength(1);
      expect(await readFile(join(f.project.rootPath, asset!.relativePath))).toEqual(png);
      f.projects.access(false, (db) =>
        expect(db.prepare('SELECT * FROM generation_results').all()).toHaveLength(1),
      );
    });
    it('discards an in-flight import when the project is unloaded', async () => {
      const f = await fixture();
      const document = f.content.saveDocument({
        kind: 'scene',
        title: '场景',
        contentMarkdown: '资料',
      });
      let release!: () => void;
      const decoding = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ffmpeg = new FfmpegRuntime();
      const preview = vi.spyOn(ffmpeg, 'previewImage').mockImplementation(async () => {
        await decoding;
      });
      const service = new LocalMediaImportService(f.projects, f.assets, ffmpeg);
      const pending = service.importFiles({ documentId: document.id }, [f.file]);
      const rejected = expect(pending).rejects.toThrow('项目运行已结束');
      await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
      service.cancelAll();
      release();
      await rejected;
      expect(f.assets.listAssets({})).toHaveLength(0);
    });
  },
);

it('validates the document import IPC boundary before accessing files', () => {
  const valid = { documentId: 'document', sourcePaths: ['E:/图片.png'] };
  expect(validateSessionRequestParams('document.images.import', valid)).toEqual(valid);
  for (const invalid of [
    { ...valid, sourcePaths: [] },
    { ...valid, sourcePaths: Array(13).fill('E:/图片.png') },
    { ...valid, sourcePaths: [null] },
    { ...valid, documentId: '' },
    { ...valid, unexpected: true },
  ])
    expect(() => validateSessionRequestParams('document.images.import', invalid)).toThrow();
});

it('validates unbind IDs and refuses global deletion flags at the IPC boundary', () => {
  const valid = { documentId: 'document', assetId: 'image' };
  expect(validateSessionRequestParams('document.images.unbind', valid)).toEqual(valid);
  for (const invalid of [
    { ...valid, documentId: '' },
    { ...valid, assetId: null },
    { ...valid, confirm: true },
    { assetId: 'image' },
  ])
    expect(() => validateSessionRequestParams('document.images.unbind', invalid)).toThrow();
});
