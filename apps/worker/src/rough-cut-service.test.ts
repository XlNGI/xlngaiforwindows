import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { RoughCutService, roughCutXml } from './rough-cut-service.js';

const owners: { projects: ProjectService; root: string; service: RoughCutService }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await owner.service.stop();
    owner.projects.close();
    await rm(owner.root, { recursive: true, force: true });
  }
});

async function fixture(real = false, withAudio = false) {
  const root = await mkdtemp(join(tmpdir(), 'rough cut 中文 '));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  const project = projects.create(join(root, 'project'), '粗剪验证');
  const content = new ContentService(projects);
  const first = content.saveScene({ title: '第一场' });
  const second = content.saveScene({ title: '第二场' });
  const shot = content.saveShot({ sceneId: first.id, title: '第一镜' });
  const media = new FfmpegRuntime();
  const assets = new ImageGenerationService(
    projects,
    () => undefined,
    () => undefined,
  );
  const service = new RoughCutService(
    projects,
    assets,
    real
      ? media
      : ({
          probe: vi.fn(() =>
            Promise.resolve({
              durationMs: 2000,
              width: 160,
              height: 120,
              hasAudio: false,
              hasVideo: true,
              fps: 30,
            }),
          ),
        } as unknown as FfmpegRuntime),
    undefined,
    () => undefined,
  );
  owners.push({ projects, root, service });
  const addAsset = async (
    sceneId: string,
    shotId?: string,
    createdAt = '2026-10-28T00:00:00.000Z',
  ) => {
    const id = randomUUID();
    const relativePath = `assets/videos/${id}.mp4`;
    const path = join(project.rootPath, relativePath);
    if (real)
      execFileSync(
        resolve('../desktop/src-tauri/resources/ffmpeg/ffmpeg.exe'),
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=160x120:r=30:d=2',
          ...(withAudio
            ? [
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:sample_rate=48000:duration=2',
                '-c:a',
                'aac',
              ]
            : []),
          '-c:v',
          'libopenh264',
          '-b:v',
          '1000000',
          '-pix_fmt',
          'yuv420p',
          path,
        ],
        { windowsHide: true, timeout: 30000 },
      );
    else await writeFile(path, 'clearly labeled synthetic media fixture');
    const bytes = await readFile(path);
    projects.access(true, (db) => {
      const repo = createRepositories(db);
      repo.assets.save({
        id,
        projectId: project.id,
        kind: shotId ? 'shot-video' : 'scene-video',
        alias: `素材 & ${sceneId}`,
        relativePath,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        createdAt,
      });
      const jobId = randomUUID();
      repo.jobs.save({
        id: jobId,
        projectId: project.id,
        shotId,
        adapterKey: 'synthetic-test-fixture',
        status: 'succeeded',
        mediaState: 'succeeded',
        requestJson: '{}',
        taskSnapshotJson: JSON.stringify({ sceneId }),
        createdAt,
        updatedAt: createdAt,
      });
      repo.generationResults.save({ id: randomUUID(), jobId, assetId: id, createdAt });
    });
    return { id, path };
  };
  const a = await addAsset(first.id, shot.id, '2026-10-28T02:00:00.000Z');
  const b = await addAsset(second.id, undefined, '2026-10-27T02:00:00.000Z');
  return { projects, project, root, service, assets, first, second, shot, a, b, addAsset, media };
}

describe('local rough cut service', () => {
  it('discovers explicit episode scene membership, combines staged saves and prefers saved manual grouping', async () => {
    const f = await fixture();
    const record = (title: string, sceneId: string, status = 'applied') =>
      f.projects.access(true, (db) => {
        const changeId = randomUUID();
        const now = '2026-10-28T00:00:00Z';
        db.prepare(
          'INSERT INTO agent_change_sets(id,project_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        ).run(changeId, f.project.id, title, status, now, now);
        db.prepare(
          "INSERT INTO agent_change_set_items(id,change_set_id,project_id,ordinal,entity_type,action,title,status,applied_entity_id,created_at,updated_at) VALUES(?,?,?,0,'scene','create',?,?,?,?,?)",
        ).run(
          randomUUID(),
          changeId,
          f.project.id,
          'Synthetic test scene',
          status === 'applied' ? 'applied' : 'pending',
          sceneId,
          now,
          now,
        );
      });
    record('第十二集 · 明确分集', f.second.id);
    record('第 12 集 · 分段保存', f.first.id);
    record('第2集 · 未应用', f.first.id, 'proposed');
    record('没有集数的记录', f.first.id);
    expect(
      f.service.episodes().map(({ number, sceneIds, source }) => ({ number, sceneIds, source })),
    ).toEqual([
      {
        number: 12,
        sceneIds: [f.first.id, f.second.id],
        source: 'structure',
      },
    ]);
    const sequence = await f.service.save({
      name: '第12集 · 手动关联',
      expectedRowVersion: 0,
      sceneIds: [f.second.id],
      clips: [],
    });
    expect(f.service.episodes()).toEqual([
      { number: 12, title: sequence.sequence.name, sceneIds: [f.second.id], source: 'sequence' },
    ]);
    const episode = f.service.episodes()[0]!;
    const prepared = await f.service.prepare({ sceneIds: episode.sceneIds });
    expect(prepared.clips.map((clip) => clip.assetId)).toEqual([f.b.id]);
    f.projects.create(join(f.root, 'other'), 'Isolated synthetic project');
    expect(f.service.episodes()).toEqual([]);
  });
  it('writes source rates, audio links and fit transforms without treating low integer fps as NTSC', async () => {
    const f = await fixture();
    const prepared = await f.service.prepare({ assetIds: [f.a.id, f.b.id] });
    const sequence = {
      id: 'xml',
      projectId: f.project.id,
      name: 'XML',
      sceneIds: [],
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
      clips: prepared.clips.map((clip, index) => ({
        ...clip,
        fps: index ? 30000 / 1001 : 12,
        hasAudio: true,
        audioChannels: index ? 2 : 1,
        muted: !!index,
        fit: 'cover' as const,
      })),
    };
    const xml = roughCutXml(
      sequence,
      new Map([
        [f.a.id, f.a.path],
        [f.b.id, f.b.path],
      ]),
    );
    expect(xml).toContain('<timebase>12</timebase><ntsc>FALSE</ntsc>');
    expect(xml).toContain('<timebase>30</timebase><ntsc>TRUE</ntsc>');
    expect(xml).toContain('<linkclipref>audio-1-1</linkclipref>');
    expect(xml).toContain('<parameterid>scale</parameterid>');
    expect(xml).toContain('<enabled>FALSE</enabled>');
  });
  it('orders selected materials by story and freezes versions; episode selection prefers scene videos', async () => {
    const f = await fixture();
    const prepared = await f.service.prepare({ assetIds: [f.b.id, f.a.id] });
    expect(prepared.clips.map((clip) => clip.assetId)).toEqual([f.a.id, f.b.id]);
    const saved = await f.service.save({
      name: '第一集',
      expectedRowVersion: 0,
      sceneIds: [f.first.id, f.second.id],
      clips: prepared.clips,
    });
    const newer = await f.addAsset(f.first.id, undefined, '2026-10-28T04:00:00.000Z');
    const episode = await f.service.prepare({ sceneIds: [f.second.id, f.first.id] });
    expect(episode.clips.map((clip) => clip.assetId)).toEqual([newer.id, f.b.id]);
    expect(f.service.get(saved.sequence.id).sequence.clips[0]?.assetId).toBe(f.a.id);
    await expect(f.service.save({ ...saved.sequence, expectedRowVersion: 0 })).rejects.toThrow(
      '已更新',
    );
    await expect(
      f.service.save({
        ...saved.sequence,
        expectedRowVersion: 1,
        clips: [{ ...prepared.clips[0]!, outMs: 99999 }],
      }),
    ).rejects.toThrow('起止点');
  });

  it('reports incomplete scene selection, rejects foreign sources and protects referenced media', async () => {
    const f = await fixture();
    const empty = new ContentService(f.projects).saveScene({ title: '尚未制作' });
    expect((await f.service.prepare({ sceneIds: [empty.id] })).missingSceneIds).toEqual([empty.id]);
    await expect(f.service.prepare({ sceneIds: ['foreign-scene'] })).rejects.toThrow('不属于');
    await expect(f.service.prepare({ assetIds: ['foreign-asset'] })).rejects.toThrow('not found');
    const prepared = await f.service.prepare({ assetIds: [f.a.id] });
    const saved = await f.service.save({
      name: '引用检查',
      expectedRowVersion: 0,
      sceneIds: [],
      clips: prepared.clips,
    });
    expect(() => f.assets.deleteAsset(f.a.id)).toThrow('referenced');
    f.assets.deleteAsset(f.a.id, true);
    expect(f.service.get(saved.sequence.id).unavailableClipIds).toEqual([prepared.clips[0]!.id]);
    expect(() => f.assets.purgeAsset(f.a.id, true)).toThrow('粗剪序列引用');
    f.assets.restoreAsset(f.a.id);
    expect(f.service.get(saved.sequence.id).unavailableClipIds).toEqual([]);
    f.service.delete(saved.sequence.id, 1);
    expect(f.service.list()).toEqual([]);
  });

  it('exports editable XML plus media copies without creating a sequence from the library', async () => {
    const f = await fixture();
    const job = await f.service.exportAssets([f.b.id, f.a.id]);
    await vi.waitFor(() => expect(f.service.exportJob(job.id).status).toBe('succeeded'));
    const result = f.service.exportJob(job.id);
    const xml = await readFile(join(result.path!, 'timeline.xml'), 'utf8');
    expect(xml).toContain('<xmeml version="5">');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('<start>0</start><end>60</end>');
    expect(await readdir(join(result.path!, 'media'))).toHaveLength(2);
    expect(await readFile(join(result.path!, 'media', `${f.a.id}.mp4`))).toEqual(
      await readFile(f.a.path),
    );
    expect(f.service.list()).toEqual([]);
    expect(
      (await readdir(join(f.project.rootPath, 'exports'))).filter((path) =>
        path.startsWith('.rough-cut-'),
      ),
    ).toEqual([]);
  });

  it('cancels an export and removes the incomplete package', async () => {
    const f = await fixture();
    const job = await f.service.exportAssets([f.a.id]);
    f.service.cancelExport(job.id);
    await vi.waitFor(() => expect(f.service.exportJob(job.id).status).toBe('cancelled'));
    expect(await readdir(join(f.project.rootPath, 'exports'))).toEqual([]);
  });

  it('does not export a file that changed after selection and leaves no partial artifacts', async () => {
    const f = await fixture();
    const prepared = await f.service.prepare({ assetIds: [f.a.id] });
    const saved = await f.service.save({
      name: '不自动替换',
      expectedRowVersion: 0,
      sceneIds: [],
      clips: prepared.clips,
    });
    await writeFile(f.a.path, 'changed synthetic fixture');
    const job = f.service.startExport({
      sequenceId: saved.sequence.id,
      expectedRowVersion: 1,
      format: 'xml',
    });
    await vi.waitFor(() => expect(f.service.exportJob(job.id).status).toBe('failed'));
    expect(f.service.exportJob(job.id).error).toContain('内容已变化');
    expect(await readdir(join(f.project.rootPath, 'exports'))).toEqual([]);
  });

  it('renders real trimmed clips with silent audio using bundled FFmpeg', async () => {
    const f = await fixture(true);
    const prepared = await f.service.prepare({ assetIds: [f.a.id, f.b.id] });
    const saved = await f.service.save({
      name: '真实渲染',
      expectedRowVersion: 0,
      sceneIds: [],
      clips: prepared.clips.map((clip) => ({ ...clip, inMs: 500, outMs: 1000, muted: true })),
    });
    const job = f.service.startExport({
      sequenceId: saved.sequence.id,
      expectedRowVersion: 1,
      format: 'mp4',
    });
    await vi.waitFor(() => expect(f.service.exportJob(job.id).status).not.toBe('running'), {
      timeout: 15000,
    });
    const result = f.service.exportJob(job.id);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('succeeded');
    const probe = await f.media.probe(join(result.path!, 'rough-cut.mp4'));
    expect(probe.hasAudio && probe.hasVideo).toBe(true);
    expect(Math.abs(probe.durationMs - 1000)).toBeLessThan(150);
  });
  it('exports real MP4 with source audio, reports its file location and surfaces folder-opening failures', async () => {
    const f = await fixture(true, true);
    const prepared = await f.service.prepare({ assetIds: [f.a.id, f.b.id] });
    const saved = await f.service.save({
      name: '合成音视频导出验证',
      expectedRowVersion: 0,
      sceneIds: [],
      clips: prepared.clips.map((clip) => ({ ...clip, inMs: 250, outMs: 1250 })),
    });
    const job = f.service.startExport({
      sequenceId: saved.sequence.id,
      expectedRowVersion: 1,
      format: 'mp4',
    });
    await vi.waitFor(() => expect(f.service.exportJob(job.id).status).not.toBe('running'), {
      timeout: 15000,
    });
    const result = f.service.exportJob(job.id);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('succeeded');
    const output = join(result.path!, 'rough-cut.mp4');
    expect((await readFile(output)).length).toBeGreaterThan(1000);
    const probe = await f.media.probe(output);
    expect(probe.hasAudio && probe.hasVideo).toBe(true);
    expect(Math.abs(probe.durationMs - 2000)).toBeLessThan(150);
    expect(await f.service.revealExport(job.id)).toEqual({ path: result.path });
    const failedReveal = new RoughCutService(f.projects, f.assets, f.media, undefined, () =>
      Promise.reject(new Error('Synthetic folder launch failure')),
    );
    owners.push({ projects: f.projects, root: f.root, service: failedReveal });
    const xml = await failedReveal.exportAssets([f.a.id]);
    await vi.waitFor(() => expect(failedReveal.exportJob(xml.id).status).toBe('succeeded'));
    await expect(failedReveal.revealExport(xml.id)).rejects.toThrow(
      'Synthetic folder launch failure',
    );
  });
});
