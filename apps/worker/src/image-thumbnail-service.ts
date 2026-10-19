import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AssetMediaSourceInfo } from '@ai-video/contracts';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { ImageGenerationService } from './image-generation-service.js';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';

/** Two encodes at a time, with in-flight deduplication and a rebuildable content cache. */
export class ImageThumbnailService {
  private readonly runtime = new FfmpegRuntime();
  private pending = new Map<string, Promise<AssetMediaSourceInfo>>();
  private queue: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
  private slot = 0;
  constructor(
    private projects: ProjectService,
    private images: ImageGenerationService,
  ) {}

  get(assetId: string): Promise<AssetMediaSourceInfo> {
    const project = this.projects.current();
    if (!project) return Promise.reject(new Error('No project is open.'));
    const session = this.projects.currentSessionId();
    let asset;
    let source;
    try {
      asset = this.images.getAssetInfo(assetId);
      if (asset.deletedAt || asset.kind.toLowerCase().includes('video'))
        throw new Error('Image unavailable.');
      source = this.images.assetMediaSource({ assetId });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Image unavailable.'));
    }
    const key = `${session}:${asset.contentHash}`;
    const existing = this.pending.get(key);
    if (existing) return existing.then((media) => ({ ...media, assetId }));
    const path = resolveProjectRelativePath(
      project.rootPath,
      join('cache', 'thumbnails', `${asset.contentHash}.320.v1.png`),
    );
    if (existsSync(path)) return Promise.resolve({ assetId, path, contentType: 'image/png' });
    const slot = this.slot++ % this.queue.length;
    const task = this.queue[slot]!.then(async () => {
      if (this.projects.currentSessionId() !== session) throw new Error('Project changed.');
      if (!existsSync(path)) {
        const temporary = `${path}.${randomUUID()}.png`;
        mkdirSync(dirname(path), { recursive: true });
        try {
          await this.runtime.thumbnail(source.path, temporary);
          if (this.projects.currentSessionId() !== session) throw new Error('Project changed.');
          renameSync(temporary, path);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      return { assetId, path, contentType: 'image/png' };
    });
    this.queue[slot] = task.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(key, task);
    void task.finally(() => this.pending.delete(key)).catch(() => undefined);
    return task;
  }
}
