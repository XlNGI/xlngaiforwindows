import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRepositories } from '@ai-video/persistence';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { productionImagesFromParameters } from '@ai-video/contracts';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ShotContinuityService } from './shot-continuity-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { ProductionService } from './production-service.js';
import { validateSessionRequestParams } from './request-validation.js';
const owners: { projects: ProjectService; root: string }[] = [];
afterEach(async () => {
  for (const f of owners.splice(0)) {
    f.projects.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'independent-shot-image-'));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  owners.push({ projects, root });
  const project = projects.create(join(root, 'project'), '本镜参考图');
  const content = new ContentService(projects);
  const scene = content.saveScene({ title: '场次' });
  const shot = content.saveShot({
    sceneId: scene.id,
    title: '首镜',
    prompt: '视频从进门走到窗边。',
    timing: { estimatedDurationSeconds: 8 },
  });
  return {
    projects,
    project,
    content,
    scene,
    shot,
    service: new ShotContinuityService(projects, new ImageGenerationService(projects)),
    production: new ProductionService(projects),
  };
}
const imageAdapter = () =>
  getAdapterCatalog().adapters.find((a) => a.capability === 'TEXT_TO_IMAGE')!;
const videoAdapter = () =>
  getAdapterCatalog().adapters.find((a) => a.capability === 'TEXT_TO_VIDEO')!;
it('fills bound character and scene images until video inputs are explicitly confirmed, including after reopening', async () => {
  const f = await fixture();
  const character = f.content.saveDocument({
    kind: 'character',
    title: '人物',
    contentMarkdown: '人物资料',
  });
  const setting = f.content.saveDocument({
    kind: 'scene',
    title: '场景',
    contentMarkdown: '场景资料',
  });
  await mkdir(join(f.project.rootPath, 'assets/images'), { recursive: true });
  for (const id of ['character-image', 'scene-image', 'candidate']) {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
      'base64',
    );
    const relativePath = `assets/images/${id}.png`;
    await writeFile(join(f.project.rootPath, relativePath), bytes);
    f.projects.access(true, (db) =>
      createRepositories(db).assets.save({
        id,
        projectId: f.project.id,
        kind: 'generated-image',
        relativePath,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        createdAt: 'now',
      }),
    );
  }
  f.content.saveShot({
    shotId: f.shot.id,
    sceneId: f.scene.id,
    title: f.shot.title,
    expectedRowVersion: f.shot.rowVersion,
    bindings: {
      schemaVersion: 1,
      characterDocumentIds: [character.id],
      sceneDocumentIds: [setting.id],
    },
  });
  f.content.saveShotReferenceBindings({
    shotId: f.shot.id,
    referenceBindings: {
      characterBindings: [{ characterDocumentId: character.id, assetId: 'character-image' }],
      sceneBindings: [{ sourceDocumentId: setting.id, assetId: 'scene-image' }],
    },
  });
  const descriptor = getAdapterCatalog().adapters.find(
    (a) => a.capability === 'REFERENCE_TO_VIDEO' && a.parameterSchema.properties.content,
  )!;
  const check = () => {
    expect(f.service.imageContext(f.shot.id).videoImages.selections).toBeUndefined();
    const preview = f.production.promptPreview(f.shot.id, 'video');
    expect(preview.inputImages.map((i) => i.assetId).sort()).toEqual([
      'character-image',
      'scene-image',
    ]);
    expect(preview.prompt).toContain('本段传入2张参考图');
    const compiled = f.production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: descriptor.key,
    });
    expect(
      productionImagesFromParameters(descriptor, compiled.parameters)
        .map((i) => i.url)
        .sort(),
    ).toEqual(['project-asset://character-image', 'project-asset://scene-image']);
  };
  check();
  f.projects.close();
  f.projects.open(f.project.rootPath);
  check();
  f.service.saveVideoImages(f.shot.id, 0, [{ assetId: 'candidate', role: 'reference' }]);
  expect(f.production.videoInputs(f.shot.id)).toEqual([
    { assetId: 'candidate', role: 'reference' },
  ]);
  f.service.saveVideoImages(f.shot.id, 1, []);
  f.projects.close();
  f.projects.open(f.project.rootPath);
  expect(f.production.videoInputs(f.shot.id)).toEqual([]);
  const empty = f.production.compile({
    target: { kind: 'shot', id: f.shot.id },
    adapterKey: descriptor.key,
  });
  expect(productionImagesFromParameters(descriptor, empty.parameters)).toEqual([]);
});
it('authors a first-shot still without sources and never falls back between image/video bodies', async () => {
  const f = await fixture();
  const original = f.service.imageContext(f.shot.id);
  expect(original.prompt).toBe('');
  expect(original.inputImages).toEqual([]);
  const blank = f.production.compile({
    target: { kind: 'shot', id: f.shot.id },
    adapterKey: imageAdapter().key,
  });
  expect(blank.parameters).toEqual({});
  expect(blank.issues).toContainEqual(expect.objectContaining({ code: 'MISSING_PROMPT' }));
  const saved = f.service.saveImage({
    shotId: f.shot.id,
    expectedRowVersion: 0,
    sourceToken: original.currentSourceToken,
    prompt: '人物在门边停下的瞬间。',
    purpose: 'first-frame',
    intent: '开场瞬间',
    bindings: { schemaVersion: 1, characterDocumentIds: [] },
  });
  expect(saved.videoImages.selections).toBeUndefined();
  expect(saved.stale).toBe(false);
  const image = f.production.compile({
    target: { kind: 'shot', id: f.shot.id },
    adapterKey: imageAdapter().key,
  });
  expect(JSON.stringify(image.parameters)).toContain(saved.prompt);
  expect(JSON.stringify(image.parameters)).not.toContain('走到窗边');
  const video = f.production.compile({
    target: { kind: 'shot', id: f.shot.id },
    adapterKey: videoAdapter().key,
  });
  expect(JSON.stringify(video.parameters)).toContain('走到窗边');
  f.service.saveImage({
    shotId: f.shot.id,
    expectedRowVersion: saved.rowVersion,
    sourceToken: saved.currentSourceToken,
    prompt: '',
    purpose: 'last-frame',
    intent: '',
  });
  expect(() =>
    f.production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: videoAdapter().key,
      expectedToken: video.source!.token,
    }),
  ).not.toThrow();
  expect(
    f.production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: imageAdapter().key,
    }).parameters,
  ).toEqual({});
  expect(f.content.listShots(f.scene.id)[0]?.prompt).toBe(f.shot.prompt);
});
it('protects CAS, source changes, explicit scope, cross-project and archived writes', async () => {
  const f = await fixture();
  const before = f.service.imageContext(f.shot.id);
  const params = {
    shotId: f.shot.id,
    expectedRowVersion: 0,
    sourceToken: before.currentSourceToken,
    prompt: '静态画面',
    purpose: 'composition' as const,
    intent: '',
  };
  const saved = f.service.saveImage(params);
  expect(() => f.service.saveImage(params)).toThrow('已更新');
  expect(() =>
    f.service.saveImage({
      ...params,
      expectedRowVersion: saved.rowVersion,
      sourceToken: saved.currentSourceToken,
      bindings: { schemaVersion: 1, characterDocumentIds: ['missing'] },
    }),
  ).toThrow();
  f.content.saveShot({
    shotId: f.shot.id,
    sceneId: f.scene.id,
    title: f.shot.title,
    prompt: '新的剧情状态',
    expectedRowVersion: f.shot.rowVersion,
  });
  expect(f.service.imageContext(f.shot.id).stale).toBe(true);
  expect(() =>
    f.service.saveImage({
      ...params,
      expectedRowVersion: saved.rowVersion,
      sourceToken: saved.currentSourceToken,
    }),
  ).toThrow('来源已变化');
  expect(() =>
    f.production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: imageAdapter().key,
    }),
  ).toThrow('创作依据已变化');
  f.projects.access(true, (db) =>
    db.prepare("UPDATE shots SET archived_at='now' WHERE id=?").run(f.shot.id),
  );
  expect(() => f.service.saveImage({ ...params, expectedRowVersion: saved.rowVersion })).toThrow(
    '归档',
  );
  f.projects.close();
  f.projects.create(join(f.project.rootPath, '..', 'other'), '其他项目');
  expect(() => f.service.imageContext(f.shot.id)).toThrow('镜头不存在');
});
it('invalidates still authoring when an explicitly referenced document changes without an image change', async () => {
  const f = await fixture();
  const character = f.content.saveDocument({
    kind: 'character',
    title: '人物',
    contentMarkdown: '站姿平静',
  });
  const original = f.service.imageContext(f.shot.id);
  const saved = f.service.saveImage({
    shotId: f.shot.id,
    expectedRowVersion: 0,
    sourceToken: original.currentSourceToken,
    prompt: '人物站在门边',
    purpose: 'composition',
    intent: '',
    bindings: { schemaVersion: 1, characterDocumentIds: [character.id] },
  });
  expect(saved.stale).toBe(false);
  f.content.saveDocument({
    documentId: character.id,
    kind: 'character',
    title: '人物',
    contentMarkdown: '站姿紧张',
  });
  const changed = f.service.imageContext(f.shot.id);
  expect(changed.inputImages).toEqual(saved.inputImages);
  expect(changed.stale).toBe(true);
  expect(changed.prompt).toBe(saved.prompt);
  expect(() =>
    f.production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: imageAdapter().key,
    }),
  ).toThrow('创作依据已变化');
});
it('adopts ordered outputs independently of source frames and keeps explicit empty inputs empty', async () => {
  const f = await fixture();
  await mkdir(join(f.project.rootPath, 'assets/images'), { recursive: true });
  for (const id of ['a', 'b']) {
    const relativePath = `assets/images/${id}.png`;
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(f.project.rootPath, relativePath), bytes);
    f.projects.access(true, (db) =>
      createRepositories(db).assets.save({
        id,
        projectId: f.project.id,
        kind: 'generated-image',
        relativePath,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        createdAt: 'now',
      }),
    );
  }
  const initial = f.service.imageContext(f.shot.id);
  const bound = f.service.saveVideoImages(f.shot.id, 0, [
    { assetId: 'b', role: 'reference' },
    { assetId: 'a', role: 'first-frame' },
  ]);
  expect(bound.inputImages).toEqual([]);
  expect(bound.currentSourceToken).toBe(initial.currentSourceToken);
  expect(f.service.get(f.shot.id).binding).toBeUndefined();
  expect(f.production.videoInputs(f.shot.id).map((i) => i.assetId)).toEqual(['b', 'a']);
  const preview = f.production.promptPreview(f.shot.id, 'video');
  expect(preview.prompt).toContain('本段传入2张参考图');
  expect(preview.inputImages[1]?.role).toBe('first-frame');
  expect(() => f.service.saveVideoImages(f.shot.id, 0, [])).toThrow('已更新');
  expect(() =>
    f.service.saveVideoImages(f.shot.id, 1, [
      { assetId: 'a', role: 'first-frame' },
      { assetId: 'b', role: 'first-frame' },
    ]),
  ).toThrow('一个显式首帧');
  f.service.saveVideoImages(f.shot.id, 1, []);
  expect(f.production.videoInputs(f.shot.id)).toEqual([]);
  const video = f.production.compile({
    target: { kind: 'shot', id: f.shot.id },
    adapterKey: videoAdapter().key,
  });
  await f.service.confirmSelection({
    shotId: f.shot.id,
    expectedRowVersion: 0,
    frames: [],
    imageAssetIds: ['a'],
    anchor: { assetId: 'a' },
    notes: '',
  });
  expect(f.production.imageInputs(f.shot.id).map((image) => image.assetId)).toEqual(['a']);
  expect(f.production.videoInputs(f.shot.id)).toEqual([]);
  expect(() =>
    f.production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: videoAdapter().key,
      expectedToken: video.source!.token,
    }),
  ).not.toThrow();
});
it('strictly validates new IPC and explicit authoring workflow without accepting provider fields', () => {
  const input = {
    shotId: 'shot',
    expectedRowVersion: 0,
    sourceToken: 'a'.repeat(64),
    prompt: '',
    purpose: 'composition',
    intent: '',
  };
  expect(() => validateSessionRequestParams('shot.image.save', input)).not.toThrow();
  expect(() =>
    validateSessionRequestParams('shot.image.save', { ...input, apiKey: 'no' }),
  ).toThrow();
  expect(() =>
    validateSessionRequestParams('shot.videoImages.save', {
      shotId: 'shot',
      expectedRowVersion: 0,
      selections: [
        { assetId: 'a', role: 'first-frame' },
        { assetId: 'b', role: 'first-frame' },
      ],
    }),
  ).toThrow();
});
