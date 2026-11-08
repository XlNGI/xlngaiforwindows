import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, readShotContinuity } from '@ai-video/persistence';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { ShotContinuityService } from './shot-continuity-service.js';
import { ProductionService } from './production-service.js';
import { validateSessionRequestParams } from './request-validation.js';
import type { WorkerMethod, WorkerMethodMap } from '@ai-video/contracts';

const owners: { projects: ProjectService; root: string }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.projects.close();
    await rm(owner.root, { recursive: true, force: true });
  }
});
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const executable = resolve('../desktop/src-tauri/resources/ffmpeg/ffmpeg.exe');
async function fixture(width = 160, height = 120) {
  const root = await mkdtemp(join(tmpdir(), 'shot continuity 中文 '));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  owners.push({ projects, root });
  const project = projects.create(join(root, 'project'), '桥上的人');
  const content = new ContentService(projects);
  const scene = content.saveScene({ title: '桥上' });
  const previous = content.saveShot({ sceneId: scene.id, title: '站在第三根桥柱旁' });
  const shot = content.saveShot({
    sceneId: scene.id,
    title: '转头',
    prompt: '人物双脚保持原位，缓慢转头。',
  });
  const id = randomUUID();
  const relativePath = `assets/videos/${id}.mp4`;
  const source = join(project.rootPath, relativePath);
  await mkdir(join(project.rootPath, 'assets', 'videos'), { recursive: true });
  execFileSync(
    executable,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${width}x${height}:r=25:d=2`,
      '-c:v',
      'libopenh264',
      '-b:v',
      '1000000',
      '-pix_fmt',
      'yuv420p',
      source,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const bytes = await readFile(source);
  projects.access(true, (db) => {
    const repo = createRepositories(db);
    const now = new Date().toISOString();
    repo.assets.save({
      id,
      projectId: project.id,
      kind: 'shot-video',
      relativePath,
      contentHash: digest(bytes),
      sizeBytes: bytes.length,
      createdAt: now,
    });
    repo.jobs.save({
      id: 'source-job',
      projectId: project.id,
      shotId: previous.id,
      adapterKey: 'fixture',
      status: 'succeeded',
      mediaState: 'succeeded',
      requestJson: '{}',
      createdAt: now,
      updatedAt: now,
    });
    repo.generationResults.save({
      id: 'source-result',
      jobId: 'source-job',
      assetId: id,
      createdAt: now,
    });
  });
  const assets = new ImageGenerationService(projects);
  const prepare = vi.fn(() => ({ stream: { generationId: 'llm' } }));
  const service = new ShotContinuityService(projects, assets);
  const preview = () => service.preview({ shotId: shot.id, videoAssetId: id, timeMs: 1000 });
  const confirm = async (
    mode: 'reference' | 'continue' | 'reframe' = 'continue',
    expectedRowVersion = 0,
  ) =>
    service.confirm({
      shotId: shot.id,
      videoAssetId: id,
      sourceToken: (await preview()).sourceToken,
      timesMs: [240, 1000],
      anchorTimeMs: 1000,
      mode,
      notes: '人物仍在第三根桥柱旁，脚不移动。',
      expectedRowVersion,
    });
  return {
    root,
    project,
    projects,
    content,
    previous,
    shot,
    id,
    source,
    assets,
    service,
    prepare,
    preview,
    confirm,
  };
}

describe.runIf(process.platform === 'win32')('manual shot continuity with real local video', () => {
  it.each([
    [1920, 1080],
    [1080, 1920],
  ])(
    'preserves HD detail in preview, saved pixels and Agent images (%i×%i)',
    async (width, height) => {
      const f = await fixture(width, height);
      const before = digest(await readFile(f.source));
      const preview = await f.preview();
      const candidate = join(f.root, 'candidate.jpg');
      await writeFile(candidate, Buffer.from(preview.dataUrl.split(',')[1]!, 'base64'));
      const imageInfo = (path: string) => {
        const info = JSON.parse(
          execFileSync(
            resolve('../desktop/src-tauri/resources/ffmpeg/ffprobe.exe'),
            ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', path],
            { encoding: 'utf8', windowsHide: true },
          ),
        ) as { streams: { width: number; height: number; pix_fmt: string }[] };
        return info.streams[0];
      };
      const pixels = (path: string, time?: string) =>
        execFileSync(
          executable,
          [
            '-v',
            'error',
            ...(time ? ['-ss', time] : []),
            '-i',
            path,
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            '-',
          ],
          { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        );
      expect(imageInfo(candidate)).toEqual({ width, height, pix_fmt: 'yuvj444p' });
      const expected = pixels(f.source, '1');
      const actual = pixels(candidate);
      expect(actual.length).toBe(expected.length);
      let squaredError = 0;
      for (let index = 0; index < actual.length; index++)
        squaredError += (actual[index]! - expected[index]!) ** 2;
      const psnr = 10 * Math.log10((255 ** 2 * actual.length) / squaredError);
      expect(psnr).toBeGreaterThan(38);

      const confirmed = await f.confirm('reference');
      const anchor = confirmed.images.find(
        (image) => image.id === confirmed.binding!.anchorAssetId,
      )!;
      const original = join(f.project.rootPath, anchor.relativePath);
      expect(imageInfo(original)).toEqual({ width, height, pix_fmt: 'rgb24' });
      expect(digest(pixels(original))).toBe(digest(expected));
      const context = f.service.readForAgent(f.shot.id);
      const images = await f.service.imagesForAgent(f.shot.id, 1, context.sourceToken);
      expect(images.reduce((size, image) => size + image.data.length, 0)).toBeLessThanOrEqual(
        1200000,
      );
      const agentImage = join(f.root, 'agent.jpg');
      await writeFile(agentImage, Buffer.from(images[0]!.data, 'base64'));
      expect(imageInfo(agentImage)).toEqual({ width, height, pix_fmt: 'yuvj444p' });
      expect(digest(await readFile(f.source))).toBe(before);
      expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
    },
  );

  it('previews without adoption, then persists exact full-size selected frames and first-frame production inputs', async () => {
    const f = await fixture();
    expect(f.service.get(f.previous.id).previousShot).toBeUndefined();
    const preview = await f.preview();
    expect(preview).toMatchObject({ timeMs: 1000, durationMs: 2000, fps: 25 });
    expect(preview.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    expect(f.assets.listAssets({})).toHaveLength(1);
    expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
    const confirmed = await f.confirm();
    expect(confirmed).toMatchObject({
      rowVersion: 1,
      stale: false,
      binding: { mode: 'continue', sourceShotId: f.previous.id, sourceVideoAssetId: f.id },
    });
    const anchor = confirmed.images.find(
      (asset) => asset.id === confirmed.binding?.firstFrameAssetId,
    )!;
    const png = await readFile(join(f.project.rootPath, anchor.relativePath));
    expect(png.readUInt32BE(16)).toBe(160);
    expect(png.readUInt32BE(20)).toBe(120);
    const extractedRaw = execFileSync(
      executable,
      [
        '-v',
        'error',
        '-i',
        join(f.project.rootPath, anchor.relativePath),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { windowsHide: true },
    );
    const sourceRaw = execFileSync(
      executable,
      [
        '-v',
        'error',
        '-ss',
        '1',
        '-i',
        f.source,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { windowsHide: true },
    );
    expect(digest(extractedRaw)).toBe(digest(sourceRaw));
    const adapter = getAdapterCatalog().adapters.find(
      (item) => item.capability === 'IMAGE_TO_VIDEO',
    )!;
    const production = new ProductionService(f.projects);
    const compiled = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: adapter.key,
    });
    expect(compiled.issues).toEqual([]);
    expect(JSON.stringify(compiled.parameters)).toContain(anchor.id);
    expect(compiled.source?.inputImages).toContainEqual({
      assetId: anchor.id,
      role: 'first-frame',
    });
    expect(() =>
      production.compile({
        target: { kind: 'shot', id: f.shot.id },
        adapterKey: adapter.key,
        expectedToken: compiled.source?.token,
      }),
    ).not.toThrow();
    const path = f.project.rootPath;
    f.projects.close();
    f.projects.open(path);
    expect(f.service.get(f.shot.id).binding?.firstFrameAssetId).toBe(anchor.id);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('allows project video on the first shot and rejects missing selections, out of range times and modified bytes', async () => {
    const f = await fixture();
    await expect(
      f.service.preview({ shotId: f.previous.id, videoAssetId: f.id, timeMs: 0 }),
    ).resolves.toMatchObject({ timeMs: 0, durationMs: 2000 });
    await expect(f.service.imagesForAgent(f.shot.id, 0)).rejects.toThrow('确认');
    await expect(
      f.service.preview({ shotId: f.shot.id, videoAssetId: f.id, timeMs: 2000 }),
    ).rejects.toThrow('时间点');
    await f.confirm('reference');
    await writeFile(f.source, 'modified source');
    await expect(f.preview()).rejects.toThrow('来源视频');
    await expect(f.service.imagesForAgent(f.shot.id, 1)).rejects.toThrow('来源视频');
  });

  it('confirms mixed frames from multiple project videos and images with explicit provenance', async () => {
    const f = await fixture();
    const seed = await f.confirm('reference');
    const image = seed.images[0]!;
    await writeFile(join(f.project.rootPath, 'assets/videos/second.mp4'), await readFile(f.source));
    f.projects.access(true, (db) =>
      createRepositories(db).assets.save({
        ...f.assets.getAssetInfo(f.id),
        id: 'second-video',
        kind: 'generated-video',
        relativePath: 'assets/videos/second.mp4',
      }),
    );
    const first = await f.service.preview({
      shotId: f.previous.id,
      videoAssetId: f.id,
      timeMs: 240,
    });
    const second = await f.service.preview({
      shotId: f.previous.id,
      videoAssetId: 'second-video',
      timeMs: 1000,
    });
    const selected = await f.service.confirmSelection({
      shotId: f.previous.id,
      expectedRowVersion: 0,
      notes: '混合来源',
      frames: [
        { videoAssetId: f.id, timeMs: 240, sourceToken: first.sourceToken },
        { videoAssetId: 'second-video', timeMs: 1000, sourceToken: second.sourceToken },
      ],
      imageAssetIds: [image.id],
      anchor: { assetId: image.id },
    });
    expect(selected).toMatchObject({
      stale: false,
      binding: {
        selectionVersion: 2,
        anchorAssetId: image.id,
        sourceVideos: [{ assetId: f.id }, { assetId: 'second-video' }],
        sourceImages: [{ assetId: image.id, contentHash: image.contentHash }],
        frames: [
          { sourceVideoAssetId: f.id, timeMs: 240 },
          { sourceVideoAssetId: 'second-video', timeMs: 1000 },
        ],
      },
    });
    expect(f.service.readForAgent(f.previous.id).visualInputs).toHaveLength(3);
    expect(await f.service.imagesForAgent(f.previous.id, selected.rowVersion)).toHaveLength(3);
    expect(() => f.assets.deleteAsset('second-video')).toThrow('referenced');
    const root = f.project.rootPath;
    f.projects.close();
    f.projects.open(root);
    expect(f.service.get(f.previous.id).binding).toEqual(selected.binding);
  });

  it('supports image-only selection on the first shot, multi-image output and explicit reconfirmation', async () => {
    const f = await fixture();
    const seed = await f.confirm('reference');
    const ids = seed.images.map((image) => image.id);
    const selected = await f.service.confirmSelection({
      shotId: f.previous.id,
      expectedRowVersion: 0,
      notes: '',
      frames: [],
      imageAssetIds: ids,
      anchor: { assetId: ids[1]! },
    });
    expect(selected.stale).toBe(false);
    expect(selected.binding?.frames).toEqual([]);
    expect(await f.service.imagesForAgent(f.previous.id, selected.rowVersion)).toHaveLength(2);
    const bound = f.service.references({
      shotId: f.previous.id,
      expectedRowVersion: selected.rowVersion,
      assetIds: ids,
    });
    expect(bound.binding?.referenceAssetIds).toEqual(ids);
    const production = new ProductionService(f.projects);
    const adapter = getAdapterCatalog().adapters.find(
      (item) => item.capability === 'TEXT_TO_IMAGE',
    )!;
    // The compiler's source preserves all image-only references in their confirmed order.
    expect(
      production.compile({ target: { kind: 'shot', id: f.previous.id }, adapterKey: adapter.key })
        .source?.inputImages,
    ).toEqual(ids.map((assetId) => ({ assetId, role: 'reference' })));
    const edited = f.content.saveShot({
      shotId: f.previous.id,
      sceneId: f.previous.sceneId,
      title: f.previous.title,
      prompt: '首镜修改',
      expectedRowVersion: f.previous.rowVersion,
    });
    expect(f.service.get(f.previous.id).reconfirmable).toBe(true);
    const kept = await f.service.reconfirm(f.previous.id, bound.rowVersion, edited.rowVersion);
    expect(kept.stale).toBe(false);
    expect(kept.binding?.sourceImages).toEqual(selected.binding?.sourceImages);
    f.assets.deleteAsset(ids[0]!, true);
    expect(f.service.get(f.previous.id)).toMatchObject({ stale: true, reconfirmable: false });
  });

  it('rejects duplicate or unanchored mixed selections, stale tokens and cross-project images without adopting frames', async () => {
    const f = await fixture();
    const preview = await f.preview();
    const frame = { videoAssetId: f.id, timeMs: 1000, sourceToken: preview.sourceToken };
    const params = {
      shotId: f.shot.id,
      expectedRowVersion: 0,
      frames: [frame],
      imageAssetIds: [],
      anchor: { videoAssetId: f.id, timeMs: 1000 },
      notes: '',
    };
    await expect(f.service.confirmSelection({ ...params, frames: [frame, frame] })).rejects.toThrow(
      '不同',
    );
    await expect(
      f.service.confirmSelection({ ...params, anchor: { assetId: 'missing' } }),
    ).rejects.toThrow('基准');
    await expect(
      f.service.confirmSelection({
        ...params,
        frames: [{ ...frame, sourceToken: 'a'.repeat(64) }],
      }),
    ).rejects.toThrow('已变化');
    await expect(
      f.service.confirmSelection({ ...params, imageAssetIds: ['foreign'] }),
    ).rejects.toThrow('not found');
    expect(f.assets.listAssets({})).toHaveLength(1);
    expect(f.service.get(f.shot.id).rowVersion).toBe(0);
  });

  it('explicitly imports local images and videos atomically, deduplicates and preserves original bytes', async () => {
    const f = await fixture();
    const seed = await f.confirm('reference');
    const originalImage = seed.images[0]!;
    const externalImage = join(f.root, '电脑参考图.png');
    const externalVideo = join(f.root, '电脑视频.mov');
    const imageBytes = await readFile(join(f.project.rootPath, originalImage.relativePath));
    await writeFile(externalImage, imageBytes);
    await writeFile(externalVideo, await readFile(f.source));
    // Remove the source image's library record only in this isolated fixture to exercise a fresh import.
    f.service.clear(f.shot.id, seed.rowVersion);
    f.assets.deleteAsset(originalImage.id, true);
    const imported = await f.service.importFiles(f.previous.id, [externalImage, externalVideo]);
    expect(imported).toHaveLength(2);
    expect(imported[0]?.relativePath).toMatch(/^assets\/images\//);
    expect(imported[1]?.id).toBe(f.id); // existing identical video is reused, without copying.
    expect(await readFile(join(f.project.rootPath, imported[0]!.relativePath))).toEqual(imageBytes);
    expect(await readFile(externalImage)).toEqual(imageBytes);
    expect(await f.service.importFiles(f.previous.id, [externalImage])).toEqual([
      expect.objectContaining({ id: imported[0]!.id }),
    ]);
    expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
    expect(f.service.get(f.previous.id).binding).toBeUndefined(); // importing never silently confirms a selection.
    expect(f.assets.locateAssetSource(imported[0]!.id)).toMatchObject({ assetId: imported[0]!.id });
  });

  it('imports fresh JPEG and MOV files without overwriting originals and exposes their media types', async () => {
    const f = await fixture();
    const imagePath = join(f.root, '本地照片.jpg');
    const videoPath = join(f.root, '本地视频.mov');
    execFileSync(executable, ['-v', 'error', '-i', f.source, '-frames:v', '1', imagePath], {
      windowsHide: true,
    });
    execFileSync(executable, ['-v', 'error', '-i', f.source, '-c', 'copy', videoPath], {
      windowsHide: true,
    });
    const imported = await f.service.importFiles(f.previous.id, [imagePath, videoPath]);
    expect(imported).toHaveLength(2);
    for (const [index, original] of [imagePath, videoPath].entries()) {
      expect(await readFile(join(f.project.rootPath, imported[index]!.relativePath))).toEqual(
        await readFile(original),
      );
    }
    expect(f.assets.assetMediaSource({ assetId: imported[0]!.id }).contentType).toBe('image/jpeg');
    expect(f.assets.assetMediaSource({ assetId: imported[1]!.id }).contentType).toBe(
      'video/quicktime',
    );
    expect((await f.service.probe(f.previous.id, imported[1]!.id)).durationMs).toBeGreaterThan(0);
    expect(f.assets.locateAssetSource(imported[1]!.id)).toMatchObject({
      assetId: imported[1]!.id,
    });
  });

  it('rejects invalid local media and rolls back the whole import batch on a database error', async () => {
    const f = await fixture();
    const invalid = join(f.root, '伪装.png');
    await writeFile(invalid, 'not an image');
    await expect(f.service.importFiles(f.shot.id, [invalid])).rejects.toThrow();
    const external = join(f.root, '外部.png');
    execFileSync(executable, ['-v', 'error', '-i', f.source, '-frames:v', '1', external], {
      windowsHide: true,
    });
    f.projects.access(true, (db) =>
      db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON assets
      BEGIN SELECT RAISE(ABORT, 'import write failed'); END`),
    );
    await expect(f.service.importFiles(f.shot.id, [external])).rejects.toThrow(
      'import write failed',
    );
    expect(f.assets.listAssets({})).toHaveLength(1);
    expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toEqual([]);
    expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
  });

  it('reads actual confirmed pixels for Agent and saves an independent static image prompt with CAS', async () => {
    const f = await fixture();
    await f.confirm('reference');
    const read = f.service.readForAgent(f.shot.id);
    expect(read.currentShot?.prompt).toContain('人物双脚保持原位');
    expect(read.binding?.notes).toContain('脚不移动');
    expect(read.visualInputs).toHaveLength(2);
    const images = await f.service.imagesForAgent(f.shot.id, 1, read.sourceToken);
    expect(images).toHaveLength(2);
    expect(images[0]?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(images[0]!.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    const original = f.content.listShots(f.shot.sceneId).find((shot) => shot.id === f.shot.id)!;
    const saved = f.service.saveForAgent(
      f.shot.id,
      1,
      read.sourceToken,
      '转身后的侧面中景',
      '人物已转身，保持原站位。',
    );
    expect(saved.binding?.imagePrompt).toBe('人物已转身，保持原站位。');
    expect(saved.binding?.notes).toBe('转身后的侧面中景');
    expect(f.content.listShots(f.shot.sceneId).find((shot) => shot.id === f.shot.id)).toEqual(
      original,
    );
    expect(() =>
      f.service.saveForAgent(f.shot.id, 1, read.sourceToken, '旧目标', '迟到输出'),
    ).toThrow('已变化');
    expect(() =>
      f.service.savePrompt(f.shot.id, saved.rowVersion, 'video', '不能覆盖视频'),
    ).toThrow('镜头正文');
    f.content.saveShot({
      shotId: f.shot.id,
      sceneId: f.shot.sceneId,
      title: f.shot.title,
      prompt: '人物走下桥。',
      expectedRowVersion: original.rowVersion,
    });
    expect(f.service.get(f.shot.id).stale).toBe(true);
    expect(() => f.service.savePrompt(f.shot.id, saved.rowVersion, 'image', '迟到输出')).toThrow(
      '重新确认',
    );
  });

  it('rolls back both intent and prompt if the second Agent write fails', async () => {
    const f = await fixture();
    await f.confirm('reference');
    const before = f.service.get(f.shot.id);
    const read = f.service.readForAgent(f.shot.id);
    f.projects.access(true, (db) =>
      db.exec(`CREATE TRIGGER fail_continuity_prompt BEFORE UPDATE ON shot_continuity
      WHEN json_extract(NEW.binding_json,'$.imagePrompt') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'continuity write failed'); END`),
    );
    expect(() =>
      f.service.saveForAgent(f.shot.id, 1, read.sourceToken, '不能保存的新目标', '不应保存'),
    ).toThrow('continuity write failed');
    expect(f.service.get(f.shot.id)).toEqual(before);
  });

  it('keeps reframing separate from final first-frame adoption and invalidates prior production on a changed selection', async () => {
    const f = await fixture();
    const first = await f.confirm('reframe');
    expect(first.binding?.firstFrameAssetId).toBeUndefined();
    expect(() => f.service.savePrompt(f.shot.id, 1, 'video', '转头')).toThrow('镜头正文');
    const adapter = getAdapterCatalog().adapters.find(
      (item) => item.capability === 'IMAGE_TO_VIDEO',
    )!;
    const production = new ProductionService(f.projects);
    expect(
      production
        .compile({ target: { kind: 'shot', id: f.shot.id }, adapterKey: adapter.key })
        .issues.some((issue) => issue.code.startsWith('CONTINUITY_')),
    ).toBe(false);
    const direct = await f.confirm('continue', 1);
    const compiled = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: adapter.key,
    });
    f.service.savePrompt(f.shot.id, direct.rowVersion, 'image', '参考选帧生成下一镜头首帧。');
    expect(() =>
      production.compile({
        target: { kind: 'shot', id: f.shot.id },
        adapterKey: adapter.key,
        expectedToken: compiled.source?.token,
      }),
    ).toThrow('来源已变化');
    expect(() => f.assets.deleteAsset(f.id)).toThrow('referenced');
    f.assets.deleteAsset(f.id, true);
    expect(f.service.get(f.shot.id).stale).toBe(true);
    expect(() => f.assets.purgeAsset(f.id, true)).toThrow('镜头衔接');
  });

  it('requires explicit reconfirmation after a shot prompt edit without extracting frames again', async () => {
    const f = await fixture();
    const confirmed = await f.confirm('reference');
    const selectedAssets = confirmed.images.map((asset) => asset.id);
    const edited = f.content.saveShot({
      shotId: f.shot.id,
      sceneId: f.shot.sceneId,
      title: f.shot.title,
      prompt: '改写后仍沿用桥柱旁的已选画面。',
      expectedRowVersion: f.shot.rowVersion,
    });
    const latest = f.content.saveShot({
      shotId: f.shot.id,
      sceneId: f.shot.sceneId,
      title: f.shot.title,
      prompt: '再次改写镜头提示词，仍沿用已选画面。',
      expectedRowVersion: edited.rowVersion,
    });
    expect(f.service.get(f.shot.id)).toMatchObject({
      stale: true,
      reconfirmable: true,
      currentShotRowVersion: latest.rowVersion,
    });
    const accepted = await f.service.reconfirm(f.shot.id, confirmed.rowVersion, latest.rowVersion);
    expect(accepted).toMatchObject({
      stale: false,
      rowVersion: confirmed.rowVersion + 1,
      binding: { targetRowVersion: latest.rowVersion, frames: confirmed.binding!.frames },
    });
    expect(accepted.binding?.anchorAssetId).toBe(confirmed.binding?.anchorAssetId);
    expect(accepted.images.map((asset) => asset.id)).toEqual(selectedAssets);
    await expect(
      f.service.reconfirm(f.shot.id, confirmed.rowVersion, latest.rowVersion),
    ).rejects.toThrow();
  });

  it('does not reconfirm when the source video file changed after a prompt edit', async () => {
    const f = await fixture();
    const confirmed = await f.confirm('reference');
    const edited = f.content.saveShot({
      shotId: f.shot.id,
      sceneId: f.shot.sceneId,
      title: f.shot.title,
      prompt: '新的画面目标。',
      expectedRowVersion: f.shot.rowVersion,
    });
    await writeFile(f.source, Buffer.from('changed source video'));
    await expect(
      f.service.reconfirm(f.shot.id, confirmed.rowVersion, edited.rowVersion),
    ).rejects.toThrow('来源视频或镜头内容已变化');
    expect(f.service.get(f.shot.id).stale).toBe(true);
  });

  it('does not reconfirm when a saved selected frame has been changed on disk', async () => {
    const f = await fixture();
    const confirmed = await f.confirm('reference');
    const edited = f.content.saveShot({
      shotId: f.shot.id,
      sceneId: f.shot.sceneId,
      title: f.shot.title,
      prompt: '新的画面目标。',
      expectedRowVersion: f.shot.rowVersion,
    });
    await writeFile(
      join(f.project.rootPath, confirmed.images[0]!.relativePath),
      Buffer.from('changed selected frame'),
    );
    await expect(
      f.service.reconfirm(f.shot.id, confirmed.rowVersion, edited.rowVersion),
    ).rejects.toThrow('已选图片内容已变化');
    expect(f.service.get(f.shot.id).stale).toBe(true);
  });

  it('rolls back files, assets, results and selection together after a database failure', async () => {
    const f = await fixture();
    f.projects.access(true, (db) =>
      db.exec(
        "CREATE TRIGGER fail_frame BEFORE INSERT ON assets WHEN NEW.kind='first-frame' BEGIN SELECT RAISE(ABORT,'fixture frame failure'); END",
      ),
    );
    await expect(f.confirm()).rejects.toThrow('fixture frame failure');
    expect(f.service.get(f.shot.id).rowVersion).toBe(0);
    expect(f.assets.listAssets({})).toHaveLength(1);
    expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toEqual([]);
    expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
  });

  it('cancels extraction on shutdown without adopting anything', async () => {
    const f = await fixture();
    const pending = f.preview();
    f.service.cancelAll();
    await expect(pending).rejects.toThrow('运行已结束');
    expect(f.service.get(f.shot.id).rowVersion).toBe(0);
    expect(f.assets.listAssets({})).toHaveLength(1);
  });

  it('preserves committed frame files if the result view fails after the transaction', async () => {
    const f = await fixture();
    const original = f.service.get.bind(f.service);
    const view = vi.spyOn(f.service, 'get').mockImplementation((shotId) => {
      const version = f.projects.access(
        false,
        (db, project) => readShotContinuity(db, project.id, shotId).rowVersion,
      );
      if (version > 0) throw new Error('fixture result read failure');
      return original(shotId);
    });
    await expect(f.confirm()).rejects.toThrow('fixture result read failure');
    view.mockRestore();
    expect(f.service.get(f.shot.id).stale).toBe(false);
    expect(f.service.get(f.shot.id).rowVersion).toBe(1);
    expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toHaveLength(2);
  });

  it('preserves legacy bindings and allows explicit normal-reference use without a forced first frame', async () => {
    const f = await fixture();
    const legacy = await f.confirm('continue');
    const reopened = f.service.get(f.shot.id);
    expect(reopened.binding?.firstFrameAssetId).toBe(legacy.binding?.anchorAssetId);
    const bound = f.service.reference(
      f.shot.id,
      reopened.rowVersion,
      legacy.binding!.anchorAssetId,
      'reference',
    );
    expect(bound.binding?.firstFrameAssetId).toBeUndefined();
    expect(bound.binding?.referenceAssetId).toBe(legacy.binding!.anchorAssetId);
    const adapter = getAdapterCatalog().adapters.find(
      (item) => item.capability === 'REFERENCE_TO_VIDEO',
    )!;
    const compiled = new ProductionService(f.projects).compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: adapter.key,
    });
    expect(compiled.issues.filter((issue) => issue.code.startsWith('CONTINUITY_'))).toEqual([]);
    expect(JSON.stringify(compiled.parameters)).toContain(bound.binding!.referenceAssetId);
    expect(compiled.parameters.prompt).toContain('人物双脚保持原位');
    const cleared = f.service.reference(f.shot.id, bound.rowVersion, undefined, 'reference');
    expect(cleared.binding?.referenceAssetId).toBeUndefined();
    expect(cleared.binding?.frames).toEqual(legacy.binding?.frames);
  });

  it('binds generated references with explicit roles, guards assets and keeps image/video prompts separate', async () => {
    const f = await fixture();
    const selected = await f.confirm('reference');
    const anchor = selected.images.find((asset) => asset.id === selected.binding?.anchorAssetId)!;
    const id = randomUUID();
    const relativePath = `assets/images/${id}.png`;
    await writeFile(
      join(f.project.rootPath, relativePath),
      await readFile(join(f.project.rootPath, anchor.relativePath)),
    );
    f.projects.access(true, (db) =>
      createRepositories(db).assets.save({ ...anchor, id, relativePath }),
    );
    const bound = f.service.reference(f.shot.id, 1, id, 'reference');
    expect(bound.binding?.firstFrameAssetId).toBeUndefined();
    expect(() => f.assets.deleteAsset(id)).toThrow('referenced');
    expect(() => f.service.reference(f.shot.id, 1, id, 'first-frame')).toThrow('确认');
    expect(() => f.service.reference(f.shot.id, bound.rowVersion, f.id, 'reference')).toThrow(
      '参考图片',
    );
    const first = f.service.reference(f.shot.id, bound.rowVersion, id, 'first-frame');
    expect(first.binding?.firstFrameAssetId).toBe(id);
    const saved = f.service.savePrompt(
      f.shot.id,
      first.rowVersion,
      'image',
      '只用于静态图片的提示词',
    );
    const production = new ProductionService(f.projects);
    const imageAdapter = getAdapterCatalog().adapters.find(
      (adapter) => adapter.capability === 'REFERENCE_TO_IMAGE',
    )!;
    const imageDraft = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: imageAdapter.key,
    });
    expect(imageDraft.parameters.prompt).toContain('只用于静态图片的提示词');
    expect(JSON.stringify(imageDraft.parameters)).toContain(saved.binding!.anchorAssetId);
    const videoAdapter = getAdapterCatalog().adapters.find(
      (adapter) => adapter.capability === 'IMAGE_TO_VIDEO',
    )!;
    const videoDraft = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: videoAdapter.key,
    });
    expect(videoDraft.parameters.prompt).toContain('人物双脚保持原位');
    expect(videoDraft.parameters.prompt).not.toContain('只用于静态图片');
    expect(JSON.stringify(videoDraft.parameters)).toContain(id);
    f.assets.deleteAsset(id, true);
    expect(f.service.get(f.shot.id).stale).toBe(true);
    expect(() => f.assets.purgeAsset(id, true)).toThrow('镜头衔接');
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'uses the existing authorized Agent loop with transient pixels and persisted prompt (%s)',
    async (protocol) => {
      const f = await fixture();
      await f.confirm('reference');
      const { GenerationService } = await import('./generation-service.js');
      const { ContextService } = await import('./context-service.js');
      const { DocumentWorkflowService } = await import('./document-workflow-service.js');
      const { AgentSystemToolService } = await import('./agent-system-tool-service.js');
      const { AgentProviderLoopService } = await import('./agent-provider-loop-service.js');
      const conversation = f.content.createConversation({ scopeType: 'shot', scopeId: f.shot.id });
      const generations = new GenerationService(
        f.projects,
        f.content,
        new ContextService(f.projects),
        {
          status: () => ({ key: 'mock', name: 'Mock', model: 'vision', configured: false }),
          stream: () => Promise.reject(new Error('No network in this test')),
        },
        {
          selectionResolver: {
            resolveLlmSelection: () => ({
              providerProfileId: 'profile',
              providerName: 'Mock',
              modelId: 'vision',
              modelName: 'Vision',
              remoteModelId: 'vision',
              protocol,
              baseUrl: 'https://mock.invalid/v1',
            }),
          },
        },
      );
      const workflow = new DocumentWorkflowService(f.projects);
      let vision = true;
      const system = new AgentSystemToolService(
        f.projects,
        f.content,
        f.assets,
        {
          listProfiles: () => [],
          listModels: () => [
            {
              id: 'vision',
              capabilities: { vision },
            } as import('@ai-video/contracts').ProviderModelInfo,
          ],
        },
        undefined,
        workflow,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service,
      );
      const loop = new AgentProviderLoopService(
        f.projects,
        workflow,
        undefined,
        undefined,
        undefined,
        undefined,
        system,
      );
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt: '生成转身后的中间画面参考图',
        providerProfileId: 'profile',
        modelId: 'vision',
      });
      const task = loop.prepare(prepared.stream, '生成转身后的中间画面参考图', undefined, {
        operation: 'document.list',
      });
      let tools = task.tools;
      let ordinal = 0;
      const invoke = async (name: string, args: Record<string, unknown>) => {
        loop.startProviderStep(prepared.stream);
        const result = await loop.executeTools({
          ...prepared.stream,
          providerResponseId: `response-${ordinal}`,
          calls: [
            {
              id: `call-${ordinal++}`,
              name,
              argumentsJson: JSON.stringify(args),
              authorizationHandle: tools.find((tool) => tool.name === name)!.authorizationHandle,
            },
          ],
        });
        tools = result.tools!;
        return result;
      };
      const read = await invoke('shot.continuity.read', { shotId: f.shot.id });
      expect(read.continuation!.outputs[0]!.images).toBeUndefined();
      const visualRead = await invoke('shot.continuity.read', {
        shotId: f.shot.id,
        includeImages: true,
      });
      const output = visualRead.continuation!.outputs[0]!;
      expect(output.images).toHaveLength(2);
      expect(output.output).not.toContain('base64');
      const metadata = JSON.parse(output.output) as { rowVersion: number; sourceToken: string };
      const saved = await invoke('shot.continuity.save', {
        shotId: f.shot.id,
        expectedRowVersion: metadata.rowVersion,
        sourceToken: metadata.sourceToken,
        intent: '已转身的侧面中景',
        prompt: '保持服装和站位，人物已转身，侧面中景。',
      });
      expect(
        (JSON.parse(saved.continuation!.outputs[0]!.output) as { status: string }).status,
      ).toBe('shot_reference_prompt_saved');
      expect(workflow.getTask({ taskId: task.taskId }).productionUpdated).toBe(true);
      expect(workflow.getTask({ taskId: task.taskId }).savedProductionReceipts?.receipts).toEqual([
        expect.objectContaining({
          generationId: prepared.stream.generationId,
          toolName: 'shot.continuity.save',
          result: expect.objectContaining({
            status: 'shot_reference_prompt_saved',
            shotId: f.shot.id,
          }) as unknown,
        }),
      ]);
      expect(f.service.get(f.shot.id).binding?.imagePrompt).toContain('侧面中景');
      const audit = f.projects.access(false, (db) =>
        db
          .prepare('SELECT result_summary_json FROM agent_tool_calls WHERE task_id=?')
          .all(task.taskId),
      );
      expect(JSON.stringify(audit)).not.toContain(output.images![0]!.data);
      expect(JSON.stringify(audit)).not.toContain('data:image');
      vision = false;
      await expect(
        invoke('shot.continuity.read', { shotId: f.shot.id, includeImages: true }),
      ).rejects.toThrow('支持看图');
    },
  );

  it('routes the public IPC through the owning project runtime', async () => {
    const f = await fixture();
    f.projects.close();
    process.env.AI_VIDEO_APP_DATA_DIR = await mkdtemp(
      join(tmpdir(), 'shot-continuity-rpc-settings-'),
    );
    const { handleRequest, parseRequest } = await import('./handler.js');
    async function rpc<M extends WorkerMethod>(method: M, params: WorkerMethodMap[M]['params']) {
      const parsed = parseRequest({ id: randomUUID(), protocolVersion: 1, method, params });
      const response = 'ok' in parsed ? parsed : await handleRequest(parsed);
      if (!response.ok) throw new Error(response.error.message);
      return response.result as WorkerMethodMap[M]['result'];
    }
    try {
      await rpc('project.open', { rootPath: f.project.rootPath });
      expect((await rpc('shot.continuity.get', { shotId: f.shot.id })).previousShot?.id).toBe(
        f.previous.id,
      );
      const preview = await rpc('shot.continuity.preview', {
        shotId: f.shot.id,
        videoAssetId: f.id,
        timeMs: 1000,
      });
      const selection = await rpc('shot.continuity.confirm', {
        shotId: f.shot.id,
        videoAssetId: f.id,
        sourceToken: preview.sourceToken,
        timesMs: [1000],
        anchorTimeMs: 1000,
        mode: 'continue',
        notes: '',
        expectedRowVersion: 0,
      });
      expect(selection.binding?.firstFrameAssetId).toBeTruthy();
      const saved = await rpc('shot.continuity.prompt.save', {
        shotId: f.shot.id,
        expectedRowVersion: selection.rowVersion,
        kind: 'image',
        prompt: '保持原位，转头后的静态画面。',
      });
      expect(saved.binding?.imagePrompt).toBe('保持原位，转头后的静态画面。');
      const reference = await rpc('shot.continuity.reference', {
        shotId: f.shot.id,
        expectedRowVersion: saved.rowVersion,
        role: 'reference',
        assetId: selection.binding!.anchorAssetId,
      });
      expect(reference.binding?.firstFrameAssetId).toBeUndefined();
      const intent = await rpc('shot.continuity.intent.save', {
        shotId: f.shot.id,
        expectedRowVersion: reference.rowVersion,
        notes: '表现中间时刻',
      });
      expect(intent.binding?.notes).toBe('表现中间时刻');
      const edited = await rpc('shot.save', {
        shotId: f.shot.id,
        sceneId: f.shot.sceneId,
        title: f.shot.title,
        prompt: '人物转头后的新提示词。',
        expectedRowVersion: f.shot.rowVersion,
      });
      expect((await rpc('shot.continuity.get', { shotId: f.shot.id })).reconfirmable).toBe(true);
      const renewed = await rpc('shot.continuity.reconfirm', {
        shotId: f.shot.id,
        expectedRowVersion: intent.rowVersion,
        expectedTargetRowVersion: edited.rowVersion,
      });
      expect(renewed).toMatchObject({
        stale: false,
        binding: {
          targetRowVersion: edited.rowVersion,
          anchorAssetId: intent.binding!.anchorAssetId,
        },
      });
    } finally {
      await rpc('project.close', {});
    }
  });
});

describe('continuity IPC boundaries', () => {
  it('bounds multi-source selection, image bindings and local imports independently of provider fields', () => {
    const selected = {
      shotId: 'shot',
      expectedRowVersion: 0,
      frames: [],
      imageAssetIds: ['one', 'two'],
      anchor: { assetId: 'two' },
      notes: '',
    };
    expect(validateSessionRequestParams('shot.continuity.selection.confirm', selected)).toEqual(
      selected,
    );
    expect(() =>
      validateSessionRequestParams('shot.continuity.selection.confirm', {
        ...selected,
        anchor: { assetId: 'missing' },
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.selection.confirm', {
        ...selected,
        imageAssetIds: ['one', 'one'],
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.selection.confirm', {
        ...selected,
        providerProfileId: 'p',
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.references', {
        shotId: 's',
        expectedRowVersion: 0,
        assetIds: ['one'],
        firstFrameAssetId: 'missing',
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.import', {
        shotId: 's',
        sourcePaths: Array.from({ length: 13 }, () => 'E:/video.mp4'),
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.probe', {
        shotId: 's',
        videoAssetId: 'v',
        path: 'E:/x.mp4',
      }),
    ).toThrow();
  });
  it('requires both continuity and shot versions for explicit reconfirmation', () => {
    const params = { shotId: 'shot', expectedRowVersion: 2, expectedTargetRowVersion: 5 };
    expect(validateSessionRequestParams('shot.continuity.reconfirm', params)).toEqual(params);
    expect(() =>
      validateSessionRequestParams('shot.continuity.reconfirm', {
        ...params,
        expectedTargetRowVersion: -1,
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.reconfirm', { ...params, assetId: 'x' }),
    ).toThrow();
  });
  it('rejects unchosen anchors, excess frames and provider fields on local extraction', () => {
    const params = {
      shotId: 'shot',
      videoAssetId: 'video',
      sourceToken: 'a'.repeat(64),
      timesMs: [100],
      anchorTimeMs: 100,
      mode: 'continue',
      notes: '',
      expectedRowVersion: 0,
    };
    expect(validateSessionRequestParams('shot.continuity.confirm', params)).toEqual(params);
    expect(() =>
      validateSessionRequestParams('shot.continuity.confirm', { ...params, anchorTimeMs: 99 }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.confirm', {
        ...params,
        timesMs: [1, 2, 3, 4, 5],
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.preview', {
        shotId: 's',
        videoAssetId: 'v',
        timeMs: 0,
        providerProfileId: 'p',
      }),
    ).toThrow();
  });
});
