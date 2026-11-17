import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { AssetInfo } from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { ExecutionPool } from './execution-pool.js';
import { assertStorageCapacity } from './storage-capacity.js';

export type LocalMediaImportTarget =
  { shotId: string; documentId?: never } | { documentId: string; shotId?: never };
async function fileHash(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
export class LocalMediaImportService {
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
  private validateTarget(
    target: LocalMediaImportTarget,
  ): 'character' | 'scene' | 'prop' | undefined {
    return this.projects.access(true, (db, project) => {
      const repo = createRepositories(db);
      if (target.documentId !== undefined) {
        const document = repo.documents.get(target.documentId);
        if (
          !document ||
          document.projectId !== project.id ||
          document.lifecycleStatus !== 'active' ||
          !['character', 'scene', 'prop'].includes(document.kind) ||
          db
            .prepare(
              "SELECT 1 FROM document_bindings WHERE document_id=? AND domain_scope='novel' AND status<>'archived'",
            )
            .get(document.id)
        )
          throw new Error('请选择当前项目有效的角色、场景或道具资料。');
        const version = document.currentVersionId
          ? repo.documents.getVersion(document.currentVersionId)
          : undefined;
        if (
          document.publishedVersionId ||
          (version && !['draft', 'changes_requested'].includes(version.state ?? 'draft'))
        )
          throw new Error('当前资料只读，不能修改图片绑定。');
        return document.kind as 'character' | 'scene' | 'prop';
      }
      const shot = target.shotId ? repo.shots.get(target.shotId) : undefined;
      const scene = shot && repo.scenes.get(shot.sceneId);
      if (!shot || scene?.projectId !== project.id) throw new Error('镜头不存在。');
      return undefined;
    });
  }
  unbindImage(documentId: string, assetId: string): { removed: true } {
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        this.validateTarget({ documentId });
        const linked = db
          .prepare(
            `
          SELECT 1 FROM assets a JOIN generation_results r ON r.asset_id=a.id
          JOIN generation_jobs j ON j.id=r.job_id AND j.project_id=a.project_id
          WHERE a.id=? AND a.project_id=? AND a.deleted_at IS NULL
            AND lower(a.kind) NOT LIKE '%video%'
            AND json_extract(j.task_snapshot_json,'$.sourceDocumentId')=?
        `,
          )
          .get(assetId, project.id, documentId);
        if (!linked) throw new Error('该图片未绑定到当前资料。');
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO document_image_exclusions
          (project_id,document_id,asset_id,removed_at) VALUES(?,?,?,?)`,
        ).run(project.id, documentId, assetId, now);
        createRepositories(db).projects.touch(now);
        return { removed: true as const };
      })(),
    );
  }
  private assertSession(sessionId: string | undefined, signal: AbortSignal) {
    if (signal.aborted || this.projects.currentSessionId() !== sessionId)
      throw new Error('项目运行已结束，请重新打开资料。');
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
    const directory = await mkdtemp(join(parent, 'import-'));
    try {
      return await run(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  /** Explicit user import only; never called by Agent retrieval or ordinary attachment handling. */
  async importFiles(target: LocalMediaImportTarget, sourcePaths: string[]): Promise<AssetInfo[]> {
    this.projects.access(true, () => undefined);
    const documentKind = this.validateTarget(target);
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
          const staged: Array<{
            asset: AssetInfo;
            path: string;
          }> = [];
          const selected: AssetInfo[] = [];
          const created: string[] = [];
          let committed = false;
          try {
            for (const input of sourcePaths) {
              this.assertSession(sessionId, signal);
              const extension = extname(input).toLowerCase();
              const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension);
              if (target.documentId && !image) throw new Error('仅支持 PNG、JPEG、WebP 图片。');
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
                  .get(project.id, contentHash, image ? 0 : 1) as
                  | {
                      id: string;
                    }
                  | undefined;
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
                kind: documentKind
                  ? `${documentKind}-image`
                  : image
                    ? 'reference-image'
                    : 'generated-video',
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
                if (this.validateTarget(target) !== documentKind)
                  throw new Error('资料类型已变化，请重新添加图片。');
                const repo = createRepositories(db);
                const linked = target.documentId
                  ? selected.filter(
                      (asset) =>
                        !db
                          .prepare(
                            "SELECT 1 FROM generation_results r JOIN generation_jobs j ON j.id=r.job_id WHERE r.asset_id=? AND j.project_id=? AND json_extract(j.task_snapshot_json,'$.sourceDocumentId')=?",
                          )
                          .get(asset.id, project.id, target.documentId),
                    )
                  : staged.map((item) => item.asset);
                const now = new Date().toISOString();
                if (target.documentId) {
                  const rebind = db.prepare(
                    'DELETE FROM document_image_exclusions WHERE project_id=? AND document_id=? AND asset_id=?',
                  );
                  for (const asset of selected) rebind.run(project.id, target.documentId, asset.id);
                }
                repo.projects.touch(now);
                if (!linked.length) return;
                const jobId = randomUUID();
                repo.jobs.save({
                  id: jobId,
                  projectId: project.id,
                  adapterKey: target.documentId
                    ? 'local:document-image-import'
                    : 'local:continuity-import',
                  status: 'succeeded',
                  mediaState: 'succeeded',
                  requestJson: '{}',
                  taskSnapshotJson: JSON.stringify({
                    version: 1,
                    localOperation: 'media-import',
                    ...(target.documentId
                      ? { sourceDocumentId: target.documentId, assetKind: documentKind }
                      : {}),
                    fileNames: staged.map((item) => item.asset.alias),
                  }),
                  createdAt: now,
                  updatedAt: now,
                });
                for (const { asset } of staged) repo.assets.save(asset);
                for (const asset of linked) {
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
                  summary: target.documentId
                    ? `用户添加并绑定 ${linked.length} 张资料图片。`
                    : `用户导入 ${staged.length} 项衔接素材。`,
                  createdAt: now,
                });
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
}
