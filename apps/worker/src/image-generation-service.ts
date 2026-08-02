import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type {
  AdapterParameters,
  AssetInfo,
  AssetListParams,
  AssetOpenParams,
  AssetPreviewParams,
  AssetRevealParams,
  AssetRevealResult,
  AssetRenameParams,
  ImageAssetKind,
  ImageGenerationCompleteParams,
  ImageGenerationJobInfo,
  ImageGenerationPrepareParams,
  ImageGenerationSavePreviewParams,
  ImagePreviewInfo,
} from '@ai-video/contracts';
import type { AssetRecord, JobRecord } from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { getAdapter, validateAdapterParameters } from '@ai-video/generation-adapters';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface DownloadedImage {
  bytes: Uint8Array;
  contentType: string;
  sourceUrl?: string;
}

type AssetPathOpener = (path: string) => void;

export class ImageGenerationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly openAssetPath: AssetPathOpener = revealPathInFileManager,
    private readonly playAssetPath: AssetPathOpener = openPathWithDefaultApplication,
  ) {}

  prepare(params: ImageGenerationPrepareParams): ImageGenerationJobInfo {
    const adapter = getAdapter(params.adapterKey);
    if (!adapter) throw new Error('Adapter was not found.');
    const validation = validateAdapterParameters(params.adapterKey, params.parameters);
    if (!validation.valid) throw new Error('Image generation parameters are invalid.');
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      if (params.shotId) {
        const shot = repositories.shots.get(params.shotId);
        const scene = shot ? repositories.scenes.get(shot.sceneId) : undefined;
        if (!shot || !scene || scene.projectId !== project.id)
          throw new Error('Shot was not found.');
      }
      const now = new Date().toISOString();
      const record: JobRecord = {
        id: randomUUID(),
        projectId: project.id,
        shotId: params.shotId,
        adapterKey: params.adapterKey,
        status: 'running',
        requestJson: JSON.stringify(redactParameters(params.parameters)),
        createdAt: now,
        updatedAt: now,
      };
      repositories.jobs.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.toInfo(
        record,
        repositories.assets.listByProject(project.id),
        repositories.generationResults.listByJob(record.id),
      );
    });
  }

  async complete(params: ImageGenerationCompleteParams): Promise<ImageGenerationJobInfo> {
    const projectSession = this.projects.current();
    if (!projectSession) throw new Error('No project is open.');
    const job = this.projects.access(false, (database, project) => {
      if (project !== projectSession) throw new Error('Project session changed during generation.');
      const repositories = createRepositories(database);
      const found = repositories.jobs.get(params.jobId);
      if (!found || found.projectId !== project.id)
        throw new Error('Generation job was not found.');
      return found;
    });
    if (job.status !== 'running') return this.get(job.id);
    if (params.providerStatus < 200 || params.providerStatus >= 300) {
      const message =
        params.providerStatus === 401
          ? 'Provider authentication failed with HTTP 401. Check the selected service region and API key.'
          : `Provider request failed with HTTP ${params.providerStatus}.`;
      return this.fail(job.id, message);
    }
    let image: DownloadedImage;
    try {
      image = await downloadImage(extractImageSource(params.providerBody));
    } catch (error) {
      if (this.projects.current() !== projectSession)
        throw new Error('Project session changed during generation.');
      return this.fail(job.id, error instanceof Error ? error.message : 'Image download failed.');
    }

    if (this.projects.current() !== projectSession)
      throw new Error('Project session changed during generation.');
    const activeJob = this.projects.access(false, (database, project) => {
      if (project !== projectSession) throw new Error('Project session changed during generation.');
      const repositories = createRepositories(database);
      const current = repositories.jobs.get(job.id);
      if (!current || current.projectId !== project.id)
        throw new Error('Generation job was not found.');
      return current;
    });
    if (activeJob.status !== 'running') return this.get(activeJob.id);

    const preview = toPreviewInfo(image, { jobId: job.id });
    if (params.saveAsset === false) {
      return this.projects.access(true, (database, project) => {
        if (project !== projectSession)
          throw new Error('Project session changed during generation.');
        const repositories = createRepositories(database);
        const current = repositories.jobs.get(job.id);
        if (!current || current.projectId !== project.id)
          throw new Error('Generation job was not found.');
        const now = new Date().toISOString();
        const completed: JobRecord = { ...current, status: 'succeeded', updatedAt: now };
        repositories.jobs.save(completed);
        repositories.projects.touch(now);
        project.updatedAt = now;
        return {
          ...this.toInfo(completed, [], repositories.generationResults.listByJob(completed.id)),
          preview,
        };
      });
    }

    const persisted = this.persistDownloadedImage(projectSession.rootPath, image, {
      projectId: projectSession.id,
      assetKind: params.assetKind,
    });
    return this.projects.access(true, (database, project) => {
      if (project !== projectSession) throw new Error('Project session changed during generation.');
      const repositories = createRepositories(database);
      const current = repositories.jobs.get(job.id);
      if (!current || current.projectId !== project.id)
        throw new Error('Generation job was not found.');
      const now = new Date().toISOString();
      const asset: AssetRecord = { ...persisted.asset, createdAt: now };
      const completed: JobRecord = { ...current, status: 'succeeded', updatedAt: now };
      const result = {
        id: randomUUID(),
        jobId: current.id,
        assetId: asset.id,
        providerUrl: image.sourceUrl,
        createdAt: now,
      };
      database.transaction(() => {
        repositories.assets.save(asset);
        repositories.generationResults.save(result);
        repositories.jobs.save(completed);
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return {
        ...this.toInfo(completed, [asset], [result]),
        preview: toPreviewInfo(image, { assetId: asset.id, jobId: completed.id }),
      };
    });
  }

  savePreview(params: ImageGenerationSavePreviewParams): ImageGenerationJobInfo {
    const projectSession = this.projects.current();
    if (!projectSession) throw new Error('No project is open.');
    const image = imageFromPreview(params);
    const existing = this.projects.access(false, (database, project) => {
      if (project !== projectSession) throw new Error('Project session changed during generation.');
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(params.jobId);
      if (!job || job.projectId !== project.id) throw new Error('Generation job was not found.');
      if (job.status !== 'succeeded') throw new Error('Generation job is not saveable.');
      const results = repositories.generationResults.listByJob(job.id);
      return {
        job,
        results,
        assets: repositories.assets.listByProject(project.id),
      };
    });
    if (existing.results.some((result) => result.assetId)) {
      return this.toInfo(existing.job, existing.assets, existing.results);
    }

    const persisted = this.persistDownloadedImage(projectSession.rootPath, image, {
      projectId: projectSession.id,
      assetKind: params.assetKind,
    });
    return this.projects.access(true, (database, project) => {
      if (project !== projectSession) throw new Error('Project session changed during generation.');
      const repositories = createRepositories(database);
      const current = repositories.jobs.get(params.jobId);
      if (!current || current.projectId !== project.id)
        throw new Error('Generation job was not found.');
      if (current.status !== 'succeeded') throw new Error('Generation job is not saveable.');
      const currentResults = repositories.generationResults.listByJob(current.id);
      if (currentResults.some((result) => result.assetId)) {
        return this.toInfo(current, repositories.assets.listByProject(project.id), currentResults);
      }
      const now = new Date().toISOString();
      const asset: AssetRecord = { ...persisted.asset, createdAt: now };
      const result = {
        id: randomUUID(),
        jobId: current.id,
        assetId: asset.id,
        createdAt: now,
      };
      database.transaction(() => {
        repositories.assets.save(asset);
        repositories.generationResults.save(result);
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return {
        ...this.toInfo(current, [asset], [result]),
        preview: toPreviewInfo(image, { assetId: asset.id, jobId: current.id }),
      };
    });
  }

  cancel(jobId: string): ImageGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      if (!job || job.projectId !== project.id) throw new Error('Generation job was not found.');
      if (job.status === 'running' || job.status === 'pending') {
        const now = new Date().toISOString();
        const cancelled = { ...job, status: 'cancelled', updatedAt: now };
        repositories.jobs.save(cancelled);
        repositories.projects.touch(now);
        project.updatedAt = now;
        return this.toInfo(cancelled, [], repositories.generationResults.listByJob(job.id));
      }
      return this.toInfo(
        job,
        repositories.assets.listByProject(project.id),
        repositories.generationResults.listByJob(job.id),
      );
    });
  }

  failTransport(jobId: string): ImageGenerationJobInfo {
    return this.fail(jobId, 'Provider transport failed before completion.');
  }

  cancelAll(): number {
    return this.finishActiveJobs('cancelled');
  }

  recoverInterrupted(): number {
    return this.finishActiveJobs('failed', 'Generation was interrupted before completion.');
  }

  get(jobId: string): ImageGenerationJobInfo {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      if (!job || job.projectId !== project.id) throw new Error('Generation job was not found.');
      const assets = repositories.assets.listByProject(project.id);
      return this.toInfo(job, assets, repositories.generationResults.listByJob(job.id));
    });
  }

  listAssets(params: AssetListParams): AssetInfo[] {
    return this.projects.access(false, (database, project) => {
      const records = createRepositories(database).assets.listByProject(project.id);
      return records.filter((asset) => !params.kind || asset.kind === params.kind).map(toAssetInfo);
    });
  }

  previewAsset(params: AssetPreviewParams): ImagePreviewInfo {
    const { asset, path } = this.assetRecordAndPath(params.assetId);
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
      throw new Error('Image size is invalid.');
    const contentType = contentTypeFor(asset.relativePath);
    if (!contentType.startsWith('image/')) throw new Error('Asset is not a previewable image.');
    return toPreviewInfo(
      {
        bytes,
        contentType,
        sourceUrl: asset.sourceUrl,
      },
      { assetId: asset.id },
    );
  }

  revealAsset(params: AssetRevealParams): AssetRevealResult {
    const { path } = this.assetRecordAndPath(params.assetId);
    this.openAssetPath(path);
    return { path };
  }

  openAsset(params: AssetOpenParams): AssetRevealResult {
    const { asset, path } = this.assetRecordAndPath(params.assetId);
    if (!OPENABLE_ASSET_EXTENSIONS.has(extname(asset.relativePath).toLowerCase())) {
      throw new Error('Asset type cannot be opened by the application.');
    }
    this.playAssetPath(path);
    return { path };
  }

  renameAsset(params: AssetRenameParams): AssetInfo {
    const name = basename(params.name.trim());
    if (!name || name !== params.name.trim() || name.includes('..'))
      throw new Error('Asset name is invalid.');
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const asset = repositories.assets.get(params.assetId);
      if (!asset || asset.projectId !== project.id) throw new Error('Asset was not found.');
      const oldPath = resolveProjectRelativePath(project.rootPath, asset.relativePath);
      if (extname(name).toLowerCase() !== extname(asset.relativePath).toLowerCase()) {
        throw new Error('Asset file extension must be preserved.');
      }
      const nextRelative = join(dirname(asset.relativePath), name);
      const nextPath = resolveProjectRelativePath(project.rootPath, nextRelative);
      if (!existsSync(oldPath)) throw new Error('Asset file is missing.');
      if (existsSync(nextPath) && oldPath !== nextPath)
        throw new Error('Asset name already exists.');
      renameSync(oldPath, nextPath);
      try {
        const updated = { ...asset, relativePath: nextRelative };
        repositories.assets.save(updated);
        return toAssetInfo(updated);
      } catch (error) {
        renameSync(nextPath, oldPath);
        throw error;
      }
    });
  }

  deleteAsset(assetId: string): { deleted: true } {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const asset = repositories.assets.get(assetId);
      if (!asset || asset.projectId !== project.id) throw new Error('Asset was not found.');
      const path = resolveProjectRelativePath(project.rootPath, asset.relativePath);
      rmSync(path, { force: true });
      repositories.assets.delete(assetId);
      const now = new Date().toISOString();
      repositories.projects.touch(now);
      project.updatedAt = now;
      return { deleted: true as const };
    });
  }

  private assetRecordAndPath(assetId: string): { asset: AssetRecord; path: string } {
    return this.projects.access(false, (database, project) => {
      const asset = createRepositories(database).assets.get(assetId);
      if (!asset || asset.projectId !== project.id) throw new Error('Asset was not found.');
      const path = resolveProjectRelativePath(project.rootPath, asset.relativePath);
      if (!existsSync(path)) throw new Error('Asset file is missing.');
      return { asset, path };
    });
  }

  private persistDownloadedImage(
    projectRootPath: string,
    image: DownloadedImage,
    params: {
      projectId: string;
      assetKind?: ImageAssetKind;
    },
  ): { asset: AssetRecord } {
    const extension = extensionFor(image.contentType, image.sourceUrl);
    const assetId = randomUUID();
    const relativePath = join('assets', 'images', `${assetId}${extension}`);
    const finalPath = resolveProjectRelativePath(projectRootPath, relativePath);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    mkdirSync(join(projectRootPath, 'assets', 'images'), { recursive: true });
    try {
      writeFileSync(temporaryPath, image.bytes, { flag: 'wx' });
      renameSync(temporaryPath, finalPath);
      const hash = createHash('sha256').update(image.bytes).digest('hex');
      const size = statSync(finalPath).size;
      return {
        asset: {
          id: assetId,
          projectId: params.projectId,
          kind: params.assetKind ?? 'generated-image',
          relativePath,
          contentHash: hash,
          sizeBytes: size,
          sourceUrl: image.sourceUrl,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      rmSync(finalPath, { force: true });
      throw error;
    }
  }

  private fail(jobId: string, message: string): ImageGenerationJobInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const job = repositories.jobs.get(jobId);
      if (!job || job.projectId !== project.id) throw new Error('Generation job was not found.');
      if (job.status !== 'running' && job.status !== 'pending') {
        return this.toInfo(
          job,
          repositories.assets.listByProject(project.id),
          repositories.generationResults.listByJob(job.id),
        );
      }
      const now = new Date().toISOString();
      const failed = {
        ...job,
        status: 'failed',
        errorJson: JSON.stringify({ message }),
        updatedAt: now,
      };
      repositories.jobs.save(failed);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.toInfo(failed, [], repositories.generationResults.listByJob(job.id));
    });
  }

  private finishActiveJobs(status: 'failed' | 'cancelled', message?: string): number {
    const current = this.projects.current();
    if (!current || current.mode !== 'read-write') return 0;
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const active = repositories.jobs
        .listByProject(project.id)
        .filter((job) => job.status === 'running' || job.status === 'pending');
      if (active.length === 0) return 0;
      const now = new Date().toISOString();
      database.transaction(() => {
        for (const job of active) {
          repositories.jobs.save({
            ...job,
            status,
            errorJson: message ? JSON.stringify({ message }) : undefined,
            updatedAt: now,
          });
        }
        repositories.projects.touch(now);
      })();
      project.updatedAt = now;
      return active.length;
    });
  }

  private toInfo(
    job: JobRecord,
    assets: AssetRecord[],
    results: {
      id: string;
      jobId: string;
      assetId?: string;
      providerUrl?: string;
      createdAt: string;
    }[],
  ): ImageGenerationJobInfo {
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    return {
      id: job.id,
      shotId: job.shotId,
      adapterKey: job.adapterKey,
      status: job.status as ImageGenerationJobInfo['status'],
      request: JSON.parse(job.requestJson) as AdapterParameters,
      results: results.map((result) => ({
        ...result,
        asset: result.assetId
          ? assetById.get(result.assetId) && toAssetInfo(assetById.get(result.assetId)!)
          : undefined,
      })),
      error: job.errorJson
        ? (JSON.parse(job.errorJson) as { message?: string }).message
        : undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}

function toAssetInfo(asset: AssetRecord): AssetInfo {
  return { ...asset };
}

function toPreviewInfo(
  image: DownloadedImage,
  params: { assetId?: string; jobId?: string } = {},
): ImagePreviewInfo {
  return {
    ...params,
    dataUrl: `data:${image.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`,
    contentType: image.contentType,
    sourceUrl: image.sourceUrl,
  };
}

function imageFromPreview(params: ImageGenerationSavePreviewParams): DownloadedImage {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(params.dataUrl);
  if (!match) throw new Error('Preview image data is invalid.');
  const contentType = match[1]!.toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('Preview is not a saveable image.');
  if (params.contentType && params.contentType.toLowerCase() !== contentType)
    throw new Error('Preview content type does not match the image data.');
  const bytes = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Preview image size is invalid.');
  return { bytes, contentType };
}

function redactParameters(parameters: AdapterParameters): AdapterParameters {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) => (isEmbeddedImageSource(item) ? 'local-image://omitted' : item))
        : typeof value === 'string' && isEmbeddedImageSource(value)
          ? 'local-image://omitted'
          : value,
    ]),
  );
}

function extractImageSource(body: unknown): string {
  const creation = findCreationImageSource(body);
  if (creation) return creation;

  const embedded = findString(body, isEmbeddedImageSource);
  if (embedded) return embedded;

  const found = findString(body, isRemoteImageSource);
  if (!found) throw new Error('Provider response did not contain an image URL or Base64 image.');
  return found;
}

function isEmbeddedImageSource(value: string): boolean {
  return value.toLowerCase().startsWith('data:image/');
}

function isRemoteImageSource(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

const CREATION_IMAGE_FIELDS = [
  'url',
  'uri',
  'image_url',
  'imageUrl',
  'cover_url',
  'coverUrl',
] as const;

function findCreationImageSource(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCreationImageSource(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const object = value as Record<string, unknown>;
  for (const key of ['creations', 'Creations']) {
    const creations = object[key];
    if (!Array.isArray(creations)) continue;
    for (const creation of creations) {
      const found = findCreationField(creation);
      if (found) return found;
    }
  }
  for (const item of Object.values(object)) {
    const found = findCreationImageSource(item);
    if (found) return found;
  }
  return undefined;
}

function findCreationField(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of CREATION_IMAGE_FIELDS) {
    const candidate = object[key];
    if (
      typeof candidate === 'string' &&
      (isEmbeddedImageSource(candidate) || isRemoteImageSource(candidate))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function findString(value: unknown, predicate: (value: string) => boolean): string | undefined {
  if (typeof value === 'string') return predicate(value) ? value : undefined;
  if (Array.isArray(value))
    for (const item of value) {
      const found = findString(item, predicate);
      if (found) return found;
    }
  if (value && typeof value === 'object')
    for (const item of Object.values(value)) {
      const found = findString(item, predicate);
      if (found) return found;
    }
  return undefined;
}

async function downloadImage(source: string): Promise<DownloadedImage> {
  if (source.startsWith('data:image/')) {
    const match = source.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('Image Base64 input is invalid.');
    const encoded = match[2];
    const contentType = match[1];
    if (!encoded || !contentType) throw new Error('Image Base64 input is invalid.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
      throw new Error('Image size is invalid.');
    return { bytes, contentType };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(source, { signal: controller.signal });
    } catch (error) {
      throw formatImageDownloadError(source, error);
    }
    if (!response.ok)
      throw new Error(
        `Image download failed${sourceHostSuffix(source)} with HTTP ${response.status}.`,
      );
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!contentType.startsWith('image/'))
      throw new Error(`Downloaded result${sourceHostSuffix(source)} is not an image.`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw formatImageDownloadError(source, error, 'while reading the image body');
    }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
      throw new Error('Image size is invalid.');
    return { bytes, contentType, sourceUrl: source };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error(`Image download${sourceHostSuffix(source)} timed out.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sourceHostSuffix(source: string): string {
  try {
    return ` from host ${new URL(source).host}`;
  } catch {
    return '';
  }
}

function formatImageDownloadError(source: string, error: unknown, phase?: string): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`Image download${sourceHostSuffix(source)} timed out.`);
  }
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : 'failed';
  const cause = error instanceof Error ? summarizeCause(error.cause) : undefined;
  const suffix = cause && cause !== message ? ` (${cause})` : '';
  const phaseText = phase ? ` ${phase}` : '';
  return new Error(
    `Image download${sourceHostSuffix(source)} failed${phaseText}: ${message}${suffix}.`,
  );
}

function summarizeCause(cause: unknown): string | undefined {
  if (!cause) return undefined;
  if (typeof cause === 'string') return cause.trim() || undefined;
  if (cause instanceof Error) {
    const code = errorCode(cause);
    if (code) return code;
    return cause.message.trim() || undefined;
  }
  if (typeof cause !== 'object') return undefined;
  const code = 'code' in cause ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && code.trim()) return code.trim();
  const message = 'message' in cause ? (cause as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function errorCode(error: Error): string | undefined {
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function extensionFor(contentType: string, sourceUrl?: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return known[contentType] ?? (extname(sourceUrl ?? '').slice(0, 5) || '.bin');
}

function contentTypeFor(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase();
  const known: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return known[extension] ?? 'application/octet-stream';
}

const OPENABLE_ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.mp4',
  '.webm',
]);

function revealPathInFileManager(path: string): void {
  const command =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? [`/select,${path}`]
      : process.platform === 'darwin'
        ? ['-R', path]
        : [path];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function openPathWithDefaultApplication(path: string): void {
  const command =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const child = spawn(command, [path], { detached: true, stdio: 'ignore' });
  child.unref();
}
