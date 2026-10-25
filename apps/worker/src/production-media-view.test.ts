import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SceneCharacterRepository } from '@ai-video/persistence';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import { describeProductionAsset, readAssetProvenance } from './production-media-view.js';
import { ProjectService } from './project-service.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  const current = fixtures.splice(0);
  for (const fixture of current) fixture.projects.close();
  await Promise.all(
    current.map((fixture) => rm(fixture.directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'production-media-view-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '媒体视图');
  const content = new ContentService(projects);
  const character = content.saveDocument({
    kind: 'character',
    title: '顾清影',
    contentMarkdown: '角色资料',
  });
  const setting = content.saveDocument({
    kind: 'scene',
    title: '屋外雨坪',
    contentMarkdown: '场景资料',
  });
  const scene = content.saveScene({
    title: '雨夜决战',
    authoringIR: {
      schemaVersion: 1,
      kind: 'scene',
      prompt: '雨坪决战',
      references: { sceneDocumentIds: [setting.id] },
    },
    characterBindings: [{ characterDocumentId: character.id }],
  });
  return { directory, projects, project, content, character, setting, scene };
}

function generatedImage(
  projects: ProjectService,
  assetId: string,
  sourceDocumentId: string,
  extraSnapshot: Record<string, unknown> = {},
) {
  projects.access(true, (db, project) => {
    db.prepare(
      "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,'character',?,?,?,?)",
    ).run(assetId, project.id, `assets/images/${assetId}.png`, 'a'.repeat(64), 1, assetId);
    db.prepare(
      "INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES(?,?,'fixture','succeeded','{}',?,'now','now')",
    ).run(`job-${assetId}`, project.id, JSON.stringify({ sourceDocumentId, ...extraSnapshot }));
    db.prepare(
      "INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES(?,?,?,'now')",
    ).run(`result-${assetId}`, `job-${assetId}`, assetId);
  });
}

it('exposes default character and IR-resolved scene media without adding asset IDs to IR', async () => {
  const fixture = await setup();
  generatedImage(fixture.projects, 'character-image-1', fixture.character.id);
  generatedImage(fixture.projects, 'scene-image-1', fixture.setting.id);
  const imageDirectory = join(fixture.project.rootPath, 'assets', 'images');
  await mkdir(imageDirectory, { recursive: true });
  await Promise.all(
    ['character-image-1', 'scene-image-1'].map((id) =>
      writeFile(join(imageDirectory, `${id}.png`), Buffer.from('test-image')),
    ),
  );

  const view = new ProductionService(fixture.projects).readMediaForAgent({
    kind: 'scene',
    id: fixture.scene.id,
  });
  const characterBinding = view.bindings.find(
    (binding) => binding.role === 'character' && binding.documentId === fixture.character.id,
  );
  const sceneBinding = view.bindings.find(
    (binding) => binding.role === 'scene' && binding.documentId === fixture.setting.id,
  );
  expect(characterBinding?.selectionSource).toBe('auto');
  expect(sceneBinding?.selectionSource).toBe('auto');
  expect(
    characterBinding?.selectedAsset &&
      typeof characterBinding.selectedAsset === 'object' &&
      'availability' in characterBinding.selectedAsset
      ? characterBinding.selectedAsset.availability
      : undefined,
  ).toBe('available');
  expect(
    characterBinding?.candidateAssets && Array.isArray(characterBinding.candidateAssets)
      ? characterBinding.candidateAssets.length
      : 0,
  ).toBe(1);
  expect(
    characterBinding?.selectedAsset &&
      typeof characterBinding.selectedAsset === 'object' &&
      'assetId' in characterBinding.selectedAsset
      ? characterBinding.selectedAsset.assetId
      : undefined,
  ).toBe('character-image-1');
  expect(
    sceneBinding?.selectedAsset &&
      typeof sceneBinding.selectedAsset === 'object' &&
      'assetId' in sceneBinding.selectedAsset
      ? sceneBinding.selectedAsset.assetId
      : undefined,
  ).toBe('scene-image-1');
  expect(JSON.stringify(view)).not.toContain('asset://');
  expect(fixture.content.listScenes()[0]?.authoringIR?.references?.sceneDocumentIds).not.toContain(
    'asset-scene-image-1',
  );
});

it('keeps every IR-referenced location in the media read model', async () => {
  const fixture = await setup();
  const secondSetting = fixture.content.saveDocument({
    kind: 'scene',
    title: '官道岔口',
    contentMarkdown: '第二个场景资料',
  });
  fixture.content.saveScene({
    sceneId: fixture.scene.id,
    title: fixture.scene.title,
    expectedRowVersion: fixture.scene.rowVersion,
    authoringIR: {
      schemaVersion: 1,
      kind: 'scene',
      prompt: '雨坪与官道岔口连续决战',
      references: {
        sceneDocumentIds: [fixture.setting.id, secondSetting.id],
      },
    },
  });
  generatedImage(fixture.projects, 'scene-image-a', fixture.setting.id);
  generatedImage(fixture.projects, 'scene-image-b', secondSetting.id);

  const view = new ProductionService(fixture.projects).readMediaForAgent({
    kind: 'scene',
    id: fixture.scene.id,
  });
  const locations = view.bindings.filter((binding) => binding.role === 'scene');
  expect(locations.map((binding) => binding.documentId)).toEqual(
    expect.arrayContaining([fixture.setting.id, secondSetting.id]),
  );
  expect(locations).toHaveLength(2);
  expect(locations.every((binding) => binding.selectedAsset)).toBe(true);
});

it('reports provenance and keeps empty aliases separate from source identity', async () => {
  const fixture = await setup();
  generatedImage(fixture.projects, 'character-image-2', fixture.character.id);
  const asset = fixture.projects.access(false, (db) =>
    describeProductionAsset(db, fixture.project.id, fixture.project.rootPath, 'character-image-2'),
  );
  expect(asset).toMatchObject({
    assetId: 'character-image-2',
    alias: '',
    availability: 'file-unavailable',
  });
  const provenance = fixture.projects.access(false, (db) =>
    readAssetProvenance(db, fixture.project.id, 'character-image-2'),
  );
  expect(provenance.sources[0]).toMatchObject({
    generationJobId: 'job-character-image-2',
    sourceDocumentId: fixture.character.id,
    inputAssetIds: [],
  });
});

it('keeps manual character image overrides and explicit disabling distinct from defaults', async () => {
  const fixture = await setup();
  generatedImage(fixture.projects, 'character-default', fixture.character.id);
  generatedImage(fixture.projects, 'character-manual', fixture.character.id);
  fixture.projects.access(true, (db) =>
    new SceneCharacterRepository(db).replace(fixture.scene.id, [
      { characterDocumentId: fixture.character.id, imageAssetId: 'character-manual' },
    ]),
  );

  const manual = new ProductionService(fixture.projects).readMediaForAgent({
    kind: 'scene',
    id: fixture.scene.id,
  });
  const manuallySelected = manual.bindings.find(
    (binding) => binding.documentId === fixture.character.id,
  );
  expect(manuallySelected?.selectionSource).toBe('manual');
  expect(
    manuallySelected?.selectedAsset &&
      typeof manuallySelected.selectedAsset === 'object' &&
      'assetId' in manuallySelected.selectedAsset
      ? manuallySelected.selectedAsset.assetId
      : undefined,
  ).toBe('character-manual');

  fixture.projects.access(true, (db) =>
    new SceneCharacterRepository(db).replace(fixture.scene.id, [
      { characterDocumentId: fixture.character.id, imageDisabled: true },
    ]),
  );
  const disabled = new ProductionService(fixture.projects).readMediaForAgent({
    kind: 'scene',
    id: fixture.scene.id,
  });
  const disabledCharacter = disabled.bindings.find(
    (binding) => binding.documentId === fixture.character.id,
  );
  expect(disabledCharacter?.selectionSource).toBe('disabled');
  expect(disabledCharacter?.selectedAsset).toBeUndefined();
  expect(
    disabled.inputs.referenceImages.some((input) => input.assetId === 'character-default'),
  ).toBe(false);
});

it('applies durable shot-level character and scene selections by source document', async () => {
  const fixture = await setup();
  const shot = fixture.content.saveShot({
    sceneId: fixture.scene.id,
    title: '镜头一',
    authoringIR: {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '雨坪近景',
      references: {
        characterDocumentIds: [fixture.character.id],
        sceneDocumentIds: [fixture.setting.id],
      },
    },
  });
  generatedImage(fixture.projects, 'shot-character-image', fixture.character.id);
  generatedImage(fixture.projects, 'shot-scene-image', fixture.setting.id);
  fixture.content.saveShotReferenceBindings({
    shotId: shot.id,
    referenceBindings: {
      characterBindings: [
        { characterDocumentId: fixture.character.id, assetId: 'shot-character-image' },
      ],
      sceneBindings: [{ sourceDocumentId: fixture.setting.id, assetId: 'shot-scene-image' }],
    },
  });

  const view = new ProductionService(fixture.projects).readMediaForAgent({
    kind: 'shot',
    id: shot.id,
  });
  expect(
    view.bindings.find(
      (binding) => binding.role === 'character' && binding.documentId === fixture.character.id,
    ),
  ).toMatchObject({
    selectionSource: 'manual',
    selectedAsset: { assetId: 'shot-character-image' },
  });
  expect(
    view.bindings.find(
      (binding) => binding.role === 'scene' && binding.documentId === fixture.setting.id,
    ),
  ).toMatchObject({
    selectionSource: 'manual',
    selectedAsset: { assetId: 'shot-scene-image' },
  });
  expect(view.inputs.videoGeneration.map((input) => input.assetId)).toEqual([
    'shot-character-image',
    'shot-scene-image',
  ]);
});

it('reports recorded input asset IDs without returning paths, prompt text, or provider details', async () => {
  const fixture = await setup();
  generatedImage(fixture.projects, 'input-image', fixture.character.id);
  generatedImage(fixture.projects, 'output-image', fixture.character.id, {
    inputs: [{ type: 'asset', assetId: 'input-image' }],
    parameters: { prompt: '保密提示词', image: 'project-asset://input-image' },
    providerProfileId: 'private-profile',
  });

  const result = fixture.projects.access(false, (db) =>
    readAssetProvenance(db, fixture.project.id, 'output-image'),
  );
  expect(result.sources[0]).toMatchObject({
    inputsRecorded: true,
    inputAssetIds: ['input-image'],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('relativePath');
  expect(serialized).not.toContain('保密提示词');
  expect(serialized).not.toContain('private-profile');
});
