import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type {
  AssetInfo,
  LlmToolOutput,
  ShotContinuityBinding,
  ShotContinuityConfirmParams,
  ShotContinuityContext,
  ShotContinuityPreviewParams,
  ShotContinuitySelectionParams,
  ShotContinuityReferencesParams,
} from '@ai-video/contracts';
import { continuityReferenceImageIds, continuitySourceImageIds } from '@ai-video/contracts';
import { createRepositories, readShotContinuity, writeShotContinuity } from '@ai-video/persistence';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { ExecutionPool } from './execution-pool.js';
import { ProductionService } from './production-service.js';
import { assertStorageCapacity } from './storage-capacity.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fileHash(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

/** A local, explicit selection. No candidate is adopted and no Provider is called by extraction. */
export class ShotContinuityService {
  private readonly controllers = new Set<AbortController>();
  constructor(
    private readonly projects: ProjectService,
    private readonly assets: ImageGenerationService,
    private readonly ffmpeg = new FfmpegRuntime(),
    private readonly capacity = new ExecutionPool(),
  ) {}

  cancelAll(): void {
    for (const controller of this.controllers) controller.abort();
  }

  resolveAssets(shotId: string, assetIds: string[]): AssetInfo[] {
    this.get(shotId);
    if (assetIds.length > 12 || new Set(assetIds).size !== assetIds.length)
      throw new Error('最多选择 12 项不同素材。');
    return assetIds.map((id) => {
      this.assets.assetMediaSource({ assetId: id });
      return this.assets.getAssetInfo(id);
    });
  }

  get(shotId: string): ShotContinuityContext {
    return this.projects.access(false, (database, project) => {
      const repo = createRepositories(database);
      const shot = repo.shots.get(shotId);
      const scene = shot && repo.scenes.get(shot.sceneId);
      if (!shot || scene?.projectId !== project.id) throw new Error('镜头不存在。');
      const ordered = repo.shots.listByScene(shot.sceneId);
      const previousShot = ordered[ordered.findIndex((item) => item.id === shotId) - 1];
      const state = readShotContinuity(database, project.id, shotId);
      const videos = previousShot
        ? this.assets
            .listAssets({ shotId: previousShot.id, sort: 'created-desc', limit: 200 })
            .filter(
              (asset) =>
                asset.kind.includes('video') &&
                Boolean(
                  database
                    .prepare(
                      `SELECT 1 FROM generation_results r JOIN generation_jobs j ON j.id=r.job_id
             WHERE r.asset_id=? AND j.shot_id=? AND j.project_id=? AND j.status='succeeded'`,
                    )
                    .get(asset.id, previousShot.id, project.id),
                ),
            )
        : [];
      const binding = state.binding;
      const imageIds = binding
        ? [
            ...continuitySourceImageIds(binding),
            ...continuityReferenceImageIds(binding),
            binding.firstFrameAssetId,
          ]
        : [];
      const images = [...new Set(imageIds)].flatMap((id) => {
        const asset = id ? repo.assets.get(id) : undefined;
        return asset && asset.projectId === project.id && !asset.deletedAt ? [asset] : [];
      });
      const source = binding?.sourceVideoAssetId
        ? repo.assets.get(binding.sourceVideoAssetId)
        : undefined;
      const snapshots =
        binding?.selectionVersion === 2
          ? [...(binding.sourceVideos ?? []), ...(binding.sourceImages ?? [])]
          : [];
      const snapshotStale = snapshots.some((snapshot) => {
        const asset = repo.assets.get(snapshot.assetId);
        return (
          !asset ||
          asset.projectId !== project.id ||
          asset.deletedAt ||
          asset.contentHash !== snapshot.contentHash ||
          !existsSync(resolveProjectRelativePath(project.rootPath, asset.relativePath))
        );
      });
      const sourceStale = Boolean(
        binding &&
        ((binding.selectionVersion === 2
          ? snapshotStale
          : previousShot?.id !== binding.sourceShotId ||
            !source ||
            source.deletedAt ||
            source.contentHash !== binding.sourceVideoHash ||
            !videos.some((video) => video.id === source.id) ||
            !existsSync(resolveProjectRelativePath(project.rootPath, source.relativePath))) ||
          imageIds.some(
            (id) =>
              id &&
              !images.some(
                (asset) =>
                  asset.id === id &&
                  existsSync(resolveProjectRelativePath(project.rootPath, asset.relativePath)),
              ),
          )),
      );
      const targetStale = Boolean(binding && binding.targetRowVersion !== shot.rowVersion);
      const stale = targetStale || sourceStale;
      const currentPrompt = new ContentService(this.projects)
        .listShots(shot.sceneId)
        .find((item) => item.id === shotId)?.authoringIR?.prompt;
      return {
        ...state,
        currentShotRowVersion: shot.rowVersion,
        ...(binding ? { binding: { ...binding, videoPrompt: currentPrompt } } : {}),
        previousShot,
        videos,
        images,
        stale,
        reconfirmable: targetStale && !sourceStale,
      };
    });
  }

  private source(shotId: string, videoAssetId: string) {
    const context = this.get(shotId);
    const asset = this.assets.getAssetInfo(videoAssetId);
    if (asset.deletedAt || !asset.kind.includes('video'))
      throw new Error('请选择当前项目可用的视频。');
    this.projects.access(false, (db) => {
      if (
        db
          .prepare(
            `SELECT 1 FROM generation_results r JOIN generation_jobs j ON j.id=r.job_id
        WHERE r.asset_id=? AND j.status<>'succeeded'`,
          )
          .get(videoAssetId)
      )
        throw new Error('请选择已成功保存的视频。');
    });
    const project = this.projects.current()!;
    const sessionId = this.projects.currentSessionId();
    const sceneId = this.projects.access(
      false,
      (db) => createRepositories(db).shots.get(shotId)!.sceneId,
    );
    const shot = new ContentService(this.projects)
      .listShots(sceneId)
      .find((item) => item.id === shotId)!;
    const media = this.assets.assetMediaSource({ assetId: asset.id });
    return {
      context,
      asset,
      shot,
      path: media.path,
      root: project.rootPath,
      projectId: project.id,
      sessionId,
      token: hash([shot, asset.id, asset.contentHash, asset.relativePath, asset.sizeBytes]),
    };
  }

  async probe(shotId: string, videoAssetId: string) {
    return this.work(async (signal) => {
      const source = this.source(shotId, videoAssetId);
      await this.verifySource(source, signal);
      const probe = await this.capacity.run('ffmpeg', source.projectId, signal, () =>
        this.ffmpeg.probe(source.path, signal),
      );
      if (!probe.hasVideo) throw new Error('所选文件没有可用视频画面。');
      await this.verifySource(source, signal);
      return { durationMs: probe.durationMs, fps: probe.fps!, sourceToken: source.token };
    });
  }

  private async verifyBindingFiles(context: ShotContinuityContext, signal: AbortSignal) {
    const binding = context.binding!;
    const sessionId = this.projects.currentSessionId();
    const videos =
      binding.selectionVersion === 2
        ? (binding.sourceVideos ?? [])
        : binding.sourceVideoAssetId
          ? [{ assetId: binding.sourceVideoAssetId, contentHash: binding.sourceVideoHash }]
          : [];
    for (const video of videos) {
      const source = this.source(context.shotId, video.assetId);
      if (source.asset.contentHash !== video.contentHash)
        throw new Error('来源视频已变化，请重新选择。');
      await this.verifySource(source, signal);
    }
    for (const asset of context.images) {
      const media = this.assets.assetMediaSource({ assetId: asset.id });
      if ((await fileHash(media.path)) !== asset.contentHash)
        throw new Error('已选图片内容已变化，请重新选择。');
      this.assertSession(sessionId, signal);
    }
    this.assertSession(sessionId, signal);
  }

  private assertSession(sessionId: string | undefined, signal?: AbortSignal) {
    if (signal?.aborted || this.projects.currentSessionId() !== sessionId)
      throw new Error('项目运行已结束，请重新打开镜头。');
  }

  private async verifySource(
    source: ReturnType<ShotContinuityService['source']>,
    signal: AbortSignal,
  ) {
    this.assertSession(source.sessionId, signal);
    const latest = this.source(source.shot.id, source.asset.id);
    if (latest.token !== source.token || (await fileHash(source.path)) !== source.asset.contentHash)
      throw new Error('来源视频或镜头内容已变化，请重新选帧。');
    this.assertSession(source.sessionId, signal);
  }

  private async work<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await run(controller.signal);
    } finally {
      this.controllers.delete(controller);
    }
  }

  private async temporary<T>(root: string, run: (directory: string) => Promise<T>): Promise<T> {
    const parent = resolveProjectRelativePath(root, 'cache/shot-continuity');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'frames-'));
    try {
      return await run(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Explicit user import only; never called by Agent retrieval or ordinary attachment handling. */
  async importFiles(shotId: string, sourcePaths: string[]): Promise<AssetInfo[]> {
    this.projects.access(true, () => undefined);
    this.get(shotId);
    if (
      !sourcePaths.length ||
      sourcePaths.length > 12 ||
      new Set(sourcePaths).size !== sourcePaths.length
    )
      throw new Error('每次请选择 1–12 个不同的本地文件。');
    const project = this.projects.current()!;
    const sessionId = this.projects.currentSessionId();
    return this.work((signal) =>
      this.capacity.run('ffmpeg', project.id, signal, () =>
        this.temporary(project.rootPath, async (directory) => {
          const staged: Array<{ asset: AssetInfo; path: string }> = [];
          const selected: AssetInfo[] = [];
          const created: string[] = [];
          let committed = false;
          try {
            for (const input of sourcePaths) {
              this.assertSession(sessionId, signal);
              const extension = extname(input).toLowerCase();
              const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension);
              if (!image && !['.mp4', '.m4v', '.mov', '.mkv', '.webm'].includes(extension))
                throw new Error('仅支持 PNG、JPEG、WebP 图片和 MP4、MOV、M4V、MKV、WebM 视频。');
              if (!isAbsolute(input) || input.includes('\0')) throw new Error('请选择本地文件。');
              const canonical = await realpath(input);
              if (
                resolve(input).toLowerCase() !== canonical.toLowerCase() ||
                !(await lstat(input)).isFile()
              )
                throw new Error('请选择普通本地文件，不能使用符号链接或目录。');
              const size = (await stat(canonical)).size;
              if (!size || size > (image ? 20 : 512) * 1024 * 1024)
                throw new Error(
                  image
                    ? '图片须为非空文件且不超过 20 MiB。'
                    : '视频须为非空文件且不超过 512 MiB。',
                );
              assertStorageCapacity(directory, size);
              const id = randomUUID();
              const path = join(directory, `${id}${extension}`);
              await copyFile(canonical, path, constants.COPYFILE_EXCL);
              if (
                (await stat(path)).size !== size ||
                (await fileHash(path)) !== (await fileHash(canonical))
              )
                throw new Error('导入期间源文件已变化，请重新拖入。');
              if (image) {
                const bytes = await readFile(path);
                const matches =
                  extension === '.png'
                    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                    : extension === '.webp'
                      ? bytes.subarray(0, 4).toString() === 'RIFF' &&
                        bytes.subarray(8, 12).toString() === 'WEBP'
                      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
                if (!matches) throw new Error('图片内容与文件扩展名不一致。');
                await this.ffmpeg.previewImage(path, join(directory, `${id}-preview.jpg`), signal);
              } else if (!(await this.ffmpeg.probe(path, signal)).hasVideo)
                throw new Error('所选文件没有可用视频画面。');
              this.assertSession(sessionId, signal);
              const contentHash = await fileHash(path);
              const inBatch = selected.find(
                (asset) =>
                  asset.contentHash === contentHash && asset.kind.includes('video') === !image,
              );
              if (inBatch) continue;
              const duplicate = this.projects.access(false, (db) => {
                const row = db
                  .prepare(
                    `SELECT id FROM assets WHERE project_id=? AND content_hash=? AND deleted_at IS NULL
                  AND (kind LIKE '%video%')=? LIMIT 1`,
                  )
                  .get(project.id, contentHash, image ? 0 : 1) as { id: string } | undefined;
                if (!row) return undefined;
                try {
                  this.assets.assetMediaSource({ assetId: row.id });
                  return this.assets.getAssetInfo(row.id);
                } catch {
                  return undefined;
                }
              });
              if (
                duplicate &&
                (await fileHash(this.assets.assetMediaSource({ assetId: duplicate.id }).path)) ===
                  contentHash
              ) {
                selected.push(duplicate);
                continue;
              }
              const asset: AssetInfo = {
                id,
                projectId: project.id,
                kind: image ? 'reference-image' : 'generated-video',
                alias: basename(input).normalize('NFKC').slice(0, 120),
                relativePath: `assets/${image ? 'images' : 'videos'}/${id}${extension}`,
                contentHash,
                sizeBytes: size,
                createdAt: new Date().toISOString(),
              };
              staged.push({ asset, path });
              selected.push(asset);
            }
            for (const item of staged) {
              this.assertSession(sessionId, signal);
              const final = resolveProjectRelativePath(project.rootPath, item.asset.relativePath);
              await mkdir(dirname(final), { recursive: true });
              assertStorageCapacity(dirname(final), item.asset.sizeBytes);
              await copyFile(item.path, final, constants.COPYFILE_EXCL);
              created.push(final);
            }
            this.assertSession(sessionId, signal);
            this.projects.access(true, (db) =>
              db.transaction(() => {
                this.get(shotId);
                const repo = createRepositories(db);
                if (!staged.length) return;
                const jobId = randomUUID();
                const now = new Date().toISOString();
                repo.jobs.save({
                  id: jobId,
                  projectId: project.id,
                  adapterKey: 'local:continuity-import',
                  status: 'succeeded',
                  mediaState: 'succeeded',
                  requestJson: '{}',
                  taskSnapshotJson: JSON.stringify({
                    version: 1,
                    localOperation: 'media-import',
                    fileNames: staged.map((item) => item.asset.alias),
                  }),
                  createdAt: now,
                  updatedAt: now,
                });
                for (const { asset } of staged) {
                  repo.assets.save(asset);
                  repo.generationResults.save({
                    id: randomUUID(),
                    jobId,
                    assetId: asset.id,
                    createdAt: now,
                  });
                }
                repo.generationJobEvents.append({
                  id: randomUUID(),
                  jobId,
                  projectId: project.id,
                  phase: 'complete',
                  status: 'succeeded',
                  summary: `用户导入 ${staged.length} 项衔接素材。`,
                  createdAt: now,
                });
                repo.projects.touch(now);
              })(),
            );
            committed = true;
            return selected;
          } finally {
            if (!committed) for (const path of created) await rm(path, { force: true });
          }
        }),
      ),
    );
  }

  async preview(params: ShotContinuityPreviewParams) {
    return this.work(async (signal) => {
      const source = this.source(params.shotId, params.videoAssetId);
      await this.verifySource(source, signal);
      return this.capacity.run('ffmpeg', source.projectId, signal, () =>
        this.temporary(source.root, async (directory) => {
          const path = join(directory, 'preview.jpg');
          const probe = await this.ffmpeg.extractFrame(
            source.path,
            path,
            params.timeMs,
            true,
            signal,
          );
          const bytes = await readFile(path);
          await this.verifySource(source, signal);
          return {
            dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
            sourceToken: source.token,
            timeMs: params.timeMs,
            durationMs: probe.durationMs,
            fps: probe.fps!,
          };
        }),
      );
    });
  }

  async confirm(params: ShotContinuityConfirmParams): Promise<ShotContinuityContext> {
    if (
      !params.timesMs.length ||
      params.timesMs.length > 4 ||
      new Set(params.timesMs).size !== params.timesMs.length ||
      !params.timesMs.every((time) => Number.isSafeInteger(time) && time >= 0) ||
      !params.timesMs.includes(params.anchorTimeMs) ||
      !['reference', 'continue', 'reframe'].includes(params.mode) ||
      params.notes.length > 4000
    )
      throw new Error('请选择 1–4 个不同时间点，并人工指定一张衔接基准。');
    const context = this.get(params.shotId);
    if (!context.previousShot || !context.videos.some((video) => video.id === params.videoAssetId))
      throw new Error('请选择上一镜头已成功保存的视频。');
    return this.confirmSelection(
      {
        shotId: params.shotId,
        expectedRowVersion: params.expectedRowVersion,
        frames: params.timesMs.map((timeMs) => ({
          videoAssetId: params.videoAssetId,
          sourceToken: params.sourceToken,
          timeMs,
        })),
        imageAssetIds: [],
        anchor: { videoAssetId: params.videoAssetId, timeMs: params.anchorTimeMs },
        notes: params.notes,
      },
      params,
    );
  }

  async confirmSelection(
    params: ShotContinuitySelectionParams,
    legacy?: ShotContinuityConfirmParams,
  ): Promise<ShotContinuityContext> {
    const keys = params.frames.map((frame) => `${frame.videoAssetId}:${frame.timeMs}`);
    const anchor = params.anchor;
    if (
      (!params.frames.length && !params.imageAssetIds.length) ||
      params.frames.length + params.imageAssetIds.length > 12 ||
      new Set(keys).size !== keys.length ||
      new Set(params.imageAssetIds).size !== params.imageAssetIds.length ||
      params.frames.some(
        (frame) =>
          !Number.isSafeInteger(frame.timeMs) ||
          frame.timeMs < 0 ||
          frame.timeMs > 7200000 ||
          !/^[a-f0-9]{64}$/.test(frame.sourceToken),
      ) ||
      !('assetId' in anchor
        ? params.imageAssetIds.includes(anchor.assetId)
        : keys.includes(`${anchor.videoAssetId}:${anchor.timeMs}`)) ||
      params.notes.length > 4000
    )
      throw new Error('请选择 1–12 张不同的参考画面，并人工指定一张衔接基准。');
    this.projects.access(true, () => undefined);
    return this.work(async (signal) => {
      const context = this.get(params.shotId);
      const project = this.projects.current()!;
      const sessionId = this.projects.currentSessionId();
      const target = this.projects.access(false, (db) =>
        createRepositories(db).shots.get(params.shotId)!,
      );
      if (context.rowVersion !== params.expectedRowVersion)
        throw new Error('选帧来源或衔接设置已变化，请重新读取。');
      const sources = new Map<string, ReturnType<ShotContinuityService['source']>>();
      for (const frame of params.frames) {
        const source =
          sources.get(frame.videoAssetId) ?? this.source(params.shotId, frame.videoAssetId);
        if (frame.sourceToken !== source.token) throw new Error('选帧来源已变化，请重新抽帧。');
        sources.set(frame.videoAssetId, source);
      }
      const sourceImages = params.imageAssetIds.map((assetId) => {
        const asset = this.assets.getAssetInfo(assetId);
        if (
          asset.deletedAt ||
          !this.assets.assetMediaSource({ assetId }).contentType.startsWith('image/')
        )
          throw new Error('请选择当前项目可用的参考图片。');
        return asset;
      });
      const verify = async () => {
        this.assertSession(sessionId, signal);
        for (const source of sources.values()) await this.verifySource(source, signal);
        for (const asset of sourceImages) {
          const latest = this.assets.getAssetInfo(asset.id);
          if (
            latest.deletedAt ||
            latest.contentHash !== asset.contentHash ||
            (await fileHash(this.assets.assetMediaSource({ assetId: asset.id }).path)) !==
              asset.contentHash
          )
            throw new Error('参考图片已变化，请重新选择。');
        }
        this.assertSession(sessionId, signal);
      };
      await verify();
      return this.capacity.run('ffmpeg', project.id, signal, () =>
        this.temporary(project.rootPath, async (directory) => {
          const frames: Array<{
            asset: AssetInfo;
            path: string;
            timeMs: number;
            sourceVideoAssetId: string;
          }> = [];
          const created: string[] = [];
          let committed = false;
          try {
            for (const input of params.frames) {
              const source = sources.get(input.videoAssetId)!;
              const timeMs = input.timeMs;
              const id = randomUUID();
              const path = join(directory, `${id}.png`);
              await this.ffmpeg.extractFrame(source.path, path, timeMs, false, signal);
              const bytes = await readFile(path);
              frames.push({
                path,
                timeMs,
                sourceVideoAssetId: source.asset.id,
                asset: {
                  id,
                  projectId: source.projectId,
                  kind: 'first-frame',
                  relativePath: `assets/images/${id}.png`,
                  alias:
                    `${source.asset.alias || source.context.previousShot?.title || '视频'} · ${(timeMs / 1000).toFixed(3)}s 衔接帧`.slice(
                      0,
                      120,
                    ),
                  contentHash: createHash('sha256').update(bytes).digest('hex'),
                  sizeBytes: bytes.length,
                  createdAt: new Date().toISOString(),
                },
              });
            }
            await verify();
            for (const frame of frames) {
              const final = resolveProjectRelativePath(project.rootPath, frame.asset.relativePath);
              await mkdir(join(project.rootPath, 'assets', 'images'), { recursive: true });
              assertStorageCapacity(
                join(project.rootPath, 'assets', 'images'),
                frame.asset.sizeBytes,
              );
              await copyFile(frame.path, final, constants.COPYFILE_EXCL);
              created.push(final);
            }
            this.assertSession(sessionId, signal);
            this.projects.access(true, (database, project) =>
              database.transaction(() => {
                const repo = createRepositories(database);
                if (
                  repo.shots.get(params.shotId)?.rowVersion !== target.rowVersion ||
                  [...sources.values()].some(
                    (source) => this.source(params.shotId, source.asset.id).token !== source.token,
                  ) ||
                  sourceImages.some((image) => {
                    const latest = repo.assets.get(image.id);
                    return !latest || latest.deletedAt || latest.contentHash !== image.contentHash;
                  })
                )
                  throw new Error('镜头来源已变化，请重新选帧。');
                const jobId = randomUUID();
                const now = new Date().toISOString();
                if (frames.length)
                  repo.jobs.save({
                    id: jobId,
                    projectId: project.id,
                    shotId: params.shotId,
                    adapterKey: 'local:shot-frame',
                    status: 'succeeded',
                    mediaState: 'succeeded',
                    requestJson: JSON.stringify({
                      frames: params.frames,
                    }),
                    taskSnapshotJson: JSON.stringify({
                      version: 1,
                      capability: 'image',
                      localOperation: 'frame-extraction',
                      sources: [...sources.values()].map((source) => ({
                        assetId: source.asset.id,
                        contentHash: source.asset.contentHash,
                      })),
                      frames: frames.map((frame) => ({
                        assetId: frame.asset.id,
                        sourceVideoAssetId: frame.sourceVideoAssetId,
                        timeMs: frame.timeMs,
                      })),
                    }),
                    createdAt: now,
                    updatedAt: now,
                  });
                for (const frame of frames) {
                  repo.assets.save(frame.asset);
                  repo.generationResults.save({
                    id: randomUUID(),
                    jobId,
                    assetId: frame.asset.id,
                    createdAt: now,
                  });
                }
                if (frames.length)
                  repo.generationJobEvents.append({
                    id: randomUUID(),
                    jobId,
                    projectId: project.id,
                    phase: 'complete',
                    status: 'succeeded',
                    summary: `人工确认 ${frames.length} 张衔接帧；原视频保持不变。`,
                    createdAt: now,
                  });
                const anchorAssetId =
                  'assetId' in anchor
                    ? anchor.assetId
                    : frames.find(
                        (frame) =>
                          frame.sourceVideoAssetId === anchor.videoAssetId &&
                          frame.timeMs === anchor.timeMs,
                      )!.asset.id;
                const first = sources.values().next().value;
                writeShotContinuity(
                  database,
                  project.id,
                  params.shotId,
                  params.expectedRowVersion,
                  {
                    ...(legacy
                      ? {
                          sourceShotId: context.previousShot!.id,
                          sourceVideoAssetId: first!.asset.id,
                          sourceVideoHash: first!.asset.contentHash,
                        }
                      : {
                          selectionVersion: 2 as const,
                          sourceVideos: [...sources.values()].map((source) => ({
                            assetId: source.asset.id,
                            contentHash: source.asset.contentHash,
                          })),
                          sourceImages: sourceImages.map((asset) => ({
                            assetId: asset.id,
                            contentHash: asset.contentHash,
                          })),
                        }),
                    targetRowVersion: target.rowVersion,
                    mode: legacy?.mode ?? 'reference',
                    notes: params.notes.trim(),
                    frames: frames.map((frame) => ({
                      assetId: frame.asset.id,
                      timeMs: frame.timeMs,
                      ...(!legacy ? { sourceVideoAssetId: frame.sourceVideoAssetId } : {}),
                    })),
                    anchorAssetId,
                    ...(legacy?.mode === 'continue' ? { firstFrameAssetId: anchorAssetId } : {}),
                  },
                );
                repo.projects.touch(now);
              })(),
            );
            committed = true;
            return this.get(params.shotId);
          } catch (error) {
            if (!committed) for (const path of created) await rm(path, { force: true });
            throw error;
          }
        }),
      );
    });
  }

  async reconfirm(
    shotId: string,
    expectedRowVersion: number,
    expectedTargetRowVersion: number,
  ): Promise<ShotContinuityContext> {
    this.projects.access(true, () => undefined);
    return this.work(async (signal) => {
      const context = this.get(shotId);
      if (context.rowVersion !== expectedRowVersion || !context.reconfirmable || !context.binding)
        throw new Error('选帧或镜头已变化，请重新读取并核对。');
      const sessionId = this.projects.currentSessionId();
      if (context.currentShotRowVersion !== expectedTargetRowVersion)
        throw new Error('镜头提示词已变化，请重新读取并核对。');
      await this.verifyBindingFiles(context, signal);
      this.assertSession(sessionId, signal);
      this.projects.access(true, (database, project) =>
        database.transaction(() => {
          const latest = this.get(shotId);
          const shot = createRepositories(database).shots.get(shotId);
          if (
            latest.rowVersion !== expectedRowVersion ||
            !latest.reconfirmable ||
            !latest.binding ||
            shot?.rowVersion !== expectedTargetRowVersion
          )
            throw new Error('选帧或镜头已变化，请重新读取并核对。');
          writeShotContinuity(database, project.id, shotId, expectedRowVersion, {
            ...latest.binding,
            targetRowVersion: expectedTargetRowVersion,
            videoPrompt: undefined,
          });
          createRepositories(database).projects.touch(new Date().toISOString());
        })(),
      );
      return this.get(shotId);
    });
  }

  clear(shotId: string, expectedRowVersion: number) {
    this.projects.access(true, (database, project) => {
      this.get(shotId);
      writeShotContinuity(database, project.id, shotId, expectedRowVersion, undefined);
    });
    return this.get(shotId);
  }

  private binding(shotId: string, expectedRowVersion: number): ShotContinuityBinding {
    const context = this.get(shotId);
    if (!context.binding || context.rowVersion !== expectedRowVersion || context.stale)
      throw new Error('请先确认当前镜头的选帧；剧情或衔接设置变化后需要重新确认。');
    return context.binding;
  }

  firstFrame(shotId: string, expectedRowVersion: number, assetId: string) {
    return this.reference(shotId, expectedRowVersion, assetId, 'first-frame');
  }

  reference(
    shotId: string,
    expectedRowVersion: number,
    assetId: string | undefined,
    role: 'reference' | 'first-frame',
  ) {
    if (!['reference', 'first-frame'].includes(role)) throw new Error('请选择图片用途。');
    this.projects.access(true, (database, project) => {
      const binding = this.binding(shotId, expectedRowVersion);
      if (assetId) {
        const asset = createRepositories(database).assets.get(assetId);
        if (
          !asset ||
          asset.projectId !== project.id ||
          asset.deletedAt ||
          asset.kind.includes('video')
        )
          throw new Error('请选择当前项目可用的参考图片。');
        if (!this.assets.assetMediaSource({ assetId }).contentType.startsWith('image/'))
          throw new Error('请选择当前项目可用的参考图片。');
      }
      writeShotContinuity(database, project.id, shotId, expectedRowVersion, {
        ...binding,
        mode: 'reference',
        referenceAssetId: assetId,
        referenceAssetIds:
          role === 'reference'
            ? assetId
              ? [assetId]
              : []
            : continuityReferenceImageIds(binding).filter((id) => id !== assetId),
        referenceRole: role,
        firstFrameAssetId: role === 'first-frame' ? assetId : undefined,
        videoPrompt: undefined,
      });
    });
    return this.get(shotId);
  }

  references(params: ShotContinuityReferencesParams) {
    if (
      params.assetIds.length > 12 ||
      new Set(params.assetIds).size !== params.assetIds.length ||
      (params.firstFrameAssetId && !params.assetIds.includes(params.firstFrameAssetId))
    )
      throw new Error('最多选择 12 张不同的图片，首帧必须属于所选图片。');
    this.projects.access(true, (database, project) => {
      const binding = this.binding(params.shotId, params.expectedRowVersion);
      for (const assetId of params.assetIds) {
        const asset = this.assets.getAssetInfo(assetId);
        if (
          asset.deletedAt ||
          !this.assets.assetMediaSource({ assetId }).contentType.startsWith('image/')
        )
          throw new Error('请选择当前项目可用的参考图片。');
      }
      writeShotContinuity(database, project.id, params.shotId, params.expectedRowVersion, {
        ...binding,
        mode: 'reference',
        referenceAssetIds: params.assetIds.filter((id) => id !== params.firstFrameAssetId),
        referenceAssetId: undefined,
        referenceRole: undefined,
        firstFrameAssetId: params.firstFrameAssetId,
        videoPrompt: undefined,
      });
    });
    return this.get(params.shotId);
  }

  saveIntent(shotId: string, expectedRowVersion: number, notes: string) {
    if (notes.length > 4000) throw new Error('参考图生成要求不能超过 4000 字符。');
    this.projects.access(true, (database, project) => {
      const binding = this.binding(shotId, expectedRowVersion);
      writeShotContinuity(database, project.id, shotId, expectedRowVersion, {
        ...binding,
        notes: notes.trim(),
        imagePrompt: notes.trim() === binding.notes ? binding.imagePrompt : undefined,
        videoPrompt: undefined,
      });
    });
    return this.get(shotId);
  }

  savePrompt(shotId: string, expectedRowVersion: number, kind: 'image' | 'video', prompt: string) {
    if (kind !== 'image') throw new Error('请在镜头正文中编辑视频提示词；衔接仅准备参考图。');
    if (!prompt.trim() || prompt.length > 20000) throw new Error('提示词需要为 1–20000 字符。');
    this.projects.access(true, (database, project) => {
      const binding = this.binding(shotId, expectedRowVersion);
      writeShotContinuity(database, project.id, shotId, expectedRowVersion, {
        ...binding,
        imagePrompt: prompt,
        videoPrompt: undefined,
      });
    });
    return this.get(shotId);
  }

  /** Compatibility endpoint: prompt authoring now belongs to the unified Agent. */
  preparePrompt(): never {
    throw new Error('请通过会话 Agent 编写参考图提示词，或在镜头页面直接填写。');
  }

  readForAgent(shotId: string) {
    const context = this.get(shotId);
    const production = new ProductionService(this.projects);
    const media = production.readMediaForAgent({ kind: 'shot', id: shotId });
    return {
      sourceToken: hash([context, media]),
      shotId,
      rowVersion: context.rowVersion,
      stale: context.stale,
      previousShot: context.previousShot && {
        id: context.previousShot.id,
        title: context.previousShot.title,
      },
      binding: context.binding,
      currentShot: production.read({ kind: 'shot', id: shotId }).authoringIR,
      references: media.inputs.referenceImages,
      visualInputs: this.visualInputs(context, media),
    };
  }

  saveForAgent(
    shotId: string,
    expectedRowVersion: number,
    sourceToken: string,
    intent: string,
    prompt: string,
  ) {
    return this.projects.access(true, (database) =>
      database.transaction(() => {
        if (this.readForAgent(shotId).sourceToken !== sourceToken)
          throw new Error('选帧、镜头或参考绑定已变化，请重新读取并核对生成目标。');
        const updated = this.saveIntent(shotId, expectedRowVersion, intent);
        return this.savePrompt(shotId, updated.rowVersion, 'image', prompt);
      })(),
    );
  }

  private visualInputs(
    context: ShotContinuityContext,
    media = new ProductionService(this.projects).readMediaForAgent({
      kind: 'shot',
      id: context.shotId,
    }),
  ) {
    const inputs = new Map<string, { assetId: string; label: string }>();
    const binding = context.binding;
    for (const [index, assetId] of (binding ? continuitySourceImageIds(binding) : []).entries()) {
      const frame = binding?.frames.find((item) => item.assetId === assetId);
      inputs.set(assetId, {
        assetId,
        label: `来源参考${index + 1}${frame ? ` ${(frame.timeMs / 1000).toFixed(3)}s` : ''}${assetId === binding?.anchorAssetId ? ' 人工指定衔接基准' : ''}`,
      });
    }
    for (const image of media.inputs.referenceImages)
      if (image.availability === 'available' && !inputs.has(image.assetId))
        inputs.set(image.assetId, { assetId: image.assetId, label: image.label || image.role });
    for (const selected of binding
      ? [...continuityReferenceImageIds(binding), binding.firstFrameAssetId]
      : [])
      if (selected && !inputs.has(selected))
        inputs.set(selected, { assetId: selected, label: '当前已绑定图片' });
    if (inputs.size > 36) throw new Error('当前参考图片超过 36 张，请先缩小镜头参考范围。');
    return [...inputs.values()];
  }

  /** Pixels leave only as transient image content after Worker tool authorization. */
  async imagesForAgent(
    shotId: string,
    expectedRowVersion: number,
    sourceToken = this.readForAgent(shotId).sourceToken,
  ): Promise<NonNullable<LlmToolOutput['images']>> {
    this.binding(shotId, expectedRowVersion);
    if (this.readForAgent(shotId).sourceToken !== sourceToken)
      throw new Error('参考资料已变化，请重新读取。');
    return this.work(async (signal) => {
      const context = this.get(shotId);
      const project = this.projects.current()!;
      const sessionId = this.projects.currentSessionId();
      await this.verifyBindingFiles(context, signal);
      const inputs = this.visualInputs(context);
      // Share the bounded JSONL payload across images without always reducing every image to 640px.
      const maxImageBytes = Math.floor(899000 / inputs.length);
      const images = await this.capacity.run('ffmpeg', project.id, signal, () =>
        this.temporary(project.rootPath, async (directory) => {
          const result: NonNullable<LlmToolOutput['images']> = [];
          for (const [index, input] of inputs.entries()) {
            const path = join(directory, `${index}.jpg`);
            const media = this.assets.assetMediaSource({ assetId: input.assetId });
            await this.ffmpeg.previewImage(media.path, path, signal, {
              maxDimension: 2048,
              maxBytes: maxImageBytes,
            });
            result.push({
              mimeType: 'image/jpeg',
              data: (await readFile(path)).toString('base64'),
            });
            if (result.reduce((size, item) => size + item.data.length, 0) > 1200000)
              throw new Error('参考图片发送体积过大，请减少当前绑定图片。');
          }
          return result;
        }),
      );
      this.assertSession(sessionId, signal);
      await this.verifyBindingFiles(context, signal);
      this.binding(shotId, expectedRowVersion);
      if (this.readForAgent(shotId).sourceToken !== sourceToken)
        throw new Error('参考资料已变化，请重新读取。');
      return images;
    });
  }
}
