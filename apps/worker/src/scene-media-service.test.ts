import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_PROTOCOL_VERSION } from '@ai-video/contracts';
import { SceneCharacterRepository, VoiceReferenceRepository } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { resolveSceneMedia } from './scene-media-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { parseRequest } from './handler.js';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.AI_VIDEO_APP_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scene-media-settings-'),
  );
});
const directories: string[] = [];
const projects: ProjectService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) p.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scene-media-'));
  directories.push(directory);
  const service = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(service);
  const project = service.create(join(directory, 'project'), '预览');
  const content = new ContentService(service);
  const actor = content.saveDocument({
    kind: 'character',
    title: '同名角色',
    contentMarkdown: '提示词',
  });
  const other = content.saveDocument({
    kind: 'character',
    title: '同名角色',
    contentMarkdown: '另一个角色',
  });
  return { service, project, content, actor, other, directory };
}
function image(
  service: ProjectService,
  id: string,
  documentId?: string,
  hash = 'a'.repeat(64),
  size = 100,
) {
  service.access(true, (db, project) => {
    db.prepare(
      "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,'character',?,?,?,?)",
    ).run(id, project.id, `assets/images/${id}.png`, hash, size, id);
    if (documentId) {
      db.prepare(
        "INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES(?,?,'fixture','succeeded','{}',?,'now','now')",
      ).run(`job-${id}`, project.id, JSON.stringify({ sourceDocumentId: documentId }));
      db.prepare(
        "INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES(?,?,?,'now')",
      ).run(`result-${id}`, `job-${id}`, id);
    }
  });
}

describe('bounded scene media resolution', () => {
  it('registers validated scene media RPC methods at the real ingress', () => {
    for (const [method, params] of [['scene.media.resolve', { characterDocumentIds: [] }]])
      expect(
        parseRequest({ id: 'rpc', protocolVersion: IPC_PROTOCOL_VERSION, method, params }),
      ).toMatchObject({ method, params });
  });
  it('resolves late images beyond page 60 by stable document IDs and retains pinned choices on refresh', async () => {
    const { service, actor, other, content, project } = await fixture();
    const scene = content.saveScene({
      title: '先绑定',
      characterBindings: [{ characterDocumentId: actor.id }],
    });
    expect(
      resolveSceneMedia(service, { characterDocumentIds: [actor.id] }).characters[0]?.defaultImage,
    ).toBeUndefined();
    for (let i = 0; i < 70; i++) image(service, `a-${i}`);
    image(service, 'role-first', actor.id);
    image(service, 'role-later', actor.id);
    image(service, 'other-role', other.id);
    const inputs = { characterDocumentIds: [actor.id], assetIds: ['role-later', 'foreign-image'] };
    const result = resolveSceneMedia(service, inputs);
    expect(result.characters[0]?.defaultImage?.id).toBe('role-first');
    expect(result.characters[0]?.images?.map((a) => a.id).sort()).toEqual([
      'role-first',
      'role-later',
    ]);
    expect(result.assets.map((a) => a.id).sort()).toEqual(['role-first', 'role-later']);
    expect(content.listScenes()[0]?.rowVersion).toBe(scene.rowVersion);
    expect(content.listScenes()[0]?.characterBindings).toEqual([{ characterDocumentId: actor.id }]);
    service.access(true, (db) =>
      new SceneCharacterRepository(db).replace(scene.id, [
        { characterDocumentId: actor.id, imageAssetId: 'role-later', voiceDisabled: true },
      ]),
    );
    image(service, 'role-newest', actor.id);
    resolveSceneMedia(service, inputs);
    expect(content.listScenes()[0]?.characterBindings).toEqual([
      { characterDocumentId: actor.id, imageAssetId: 'role-later', voiceDisabled: true },
    ]);
    expect(new ImageGenerationService(service).listAssets({})).toHaveLength(60);
    const plan = service.access(false, (db) =>
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM generation_jobs WHERE project_id=? AND json_extract(task_snapshot_json,'$.sourceDocumentId')=?",
        )
        .all(project.id, actor.id),
    );
    expect(JSON.stringify(plan)).toContain('generation_jobs_source_document');
    const reader = new ProjectService({
      recentProjectsPath: join(project.rootPath, 'reader-recent.json'),
    });
    projects.push(reader);
    expect(reader.open(project.rootPath).mode).toBe('read-only');
    expect(resolveSceneMedia(reader, inputs).characters[0]?.defaultImage?.id).toBe('role-first');
  });
  it('returns a selected historical voice without substituting it for an unavailable current voice, and isolates projects', async () => {
    const { service, project, actor, other, directory } = await fixture();
    service.access(true, (db) => {
      for (const id of ['one', 'two'])
        db.prepare(
          "INSERT INTO audio_files(id,project_id,kind,name,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,channels,created_at) VALUES(?,?,'reference',?,?,'audio/wav',100,?,3000,48000,1,'now')",
        ).run(id, project.id, id, `assets/audio/${id}.wav`, 'a'.repeat(64));
    });
    const voices = service.access(false, (db) => new VoiceReferenceRepository(db, project.id));
    const first = voices.save({ characterDocumentId: actor.id, audioId: 'one' });
    const second = voices.save({
      characterDocumentId: actor.id,
      audioId: 'two',
      expectedRowVersion: first.rowVersion,
    });
    const inputs = { characterDocumentIds: [actor.id], voiceVersionIds: [first.versionId] };
    expect(resolveSceneMedia(service, inputs)).toMatchObject({
      characters: [{ voice: { versionId: second.versionId } }],
      voices: [{ versionId: second.versionId }, { versionId: first.versionId }],
    });
    expect(
      resolveSceneMedia(service, { ...inputs, characterDocumentIds: [other.id] }).voices,
    ).toEqual([]);
    service.access(true, (db) =>
      db.prepare("UPDATE audio_files SET deleted_at='now' WHERE id='two'").run(),
    );
    const unavailable = resolveSceneMedia(service, inputs);
    expect(unavailable.characters[0]?.voice).toBeUndefined();
    expect(unavailable.voices[0]?.versionId).toBe(first.versionId);
    service.close();
    service.create(join(directory, 'different'), '另一个项目');
    expect(resolveSceneMedia(service, inputs).voices).toEqual([]);
  });
});
