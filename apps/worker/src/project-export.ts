import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import { checkIntegrity, openProjectDatabase } from '@ai-video/persistence';
import { assertStorageCapacity } from './storage-capacity.js';

interface ExportFile {
  relativePath: string;
  hash?: string;
  size?: number;
}

interface ExportPackage {
  id: string;
  path: string;
  hash: string;
  format: string;
  mergedPaths: string[];
}

function inside(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Refuse links in every segment, including existing destination ancestors. */
async function noLinks(path: string, allowMissing = false): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Project export rejects links.');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function projectPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (!path || isAbsolute(path) || !inside(root, resolved) || resolved === root)
    throw new Error('Project export reference escapes its project.');
  return resolved;
}

function snapshotReferences(db: Database.Database): ExportFile[] {
  const records = db
    .prepare(
      `
    SELECT CASE WHEN deleted_at IS NOT NULL THEN trash_relative_path ELSE relative_path END AS relativePath,
           content_hash AS hash, size_bytes AS size FROM assets
    UNION ALL
    SELECT CASE WHEN deleted_at IS NOT NULL THEN trash_relative_path ELSE relative_path END,
           content_hash, size_bytes FROM audio_files
    UNION ALL
    SELECT result_relative_path, result_content_hash, NULL FROM dubbing_job_steps
      WHERE result_relative_path IS NOT NULL AND result_content_hash IS NOT NULL
  `,
    )
    .all() as ExportFile[];
  const exports = db
    .prepare(
      `
    SELECT jobs.package_relative_path AS packagePath, items.relative_path AS filePath,
           items.output_hash AS hash, items.byte_size AS size
    FROM markdown_export_jobs jobs JOIN markdown_export_items items ON items.job_id = jobs.id
    WHERE jobs.status = 'succeeded' AND jobs.export_format = 'files'
  `,
    )
    .all() as Array<{ packagePath: string; filePath: string; hash: string; size: number }>;
  for (const item of exports) {
    if (isAbsolute(item.filePath) || relative('.', item.filePath).startsWith('..'))
      throw new Error('Project export item has an invalid relative path.');
    records.push({
      relativePath: join(item.packagePath, item.filePath),
      hash: item.hash,
      size: item.size,
    });
  }
  return records;
}

async function copiedHash(file: string): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hash: hash.digest('hex'), size };
}

/** Backup and referenced files are published together; no live project write lock spans IO. */
export async function exportProjectSnapshot(options: {
  root: string;
  destination: string;
  nativeBinding?: object;
  backup(path: string): Promise<unknown>;
  assertCurrent: () => void;
}): Promise<string> {
  const { root, destination, assertCurrent } = options;
  await noLinks(root);
  await noLinks(destination, true);
  const actualRoot = await realpath(root);
  if (inside(actualRoot, destination) || inside(destination, actualRoot))
    throw new Error('Export destination must be outside the project directory.');
  const originalTarget = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (originalTarget && (!originalTarget.isDirectory() || (await readdir(destination)).length))
    throw new Error('Export destination must be empty.');
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.project-export-'));
  // The path comes from mkdtemp under this exact parent; cleanup never touches the destination.
  if (
    !inside(dirname(destination), staging) ||
    !staging.startsWith(join(dirname(destination), '.project-export-'))
  )
    throw new Error('Unexpected project export staging path.');
  let removedEmptyTarget = false;
  try {
    assertCurrent();
    await options.backup(join(staging, 'project.sqlite'));
    assertCurrent();
    const snapshot = openProjectDatabase(join(staging, 'project.sqlite'), {
      readonly: true,
      nativeBinding: options.nativeBinding,
    });
    let references: ExportFile[];
    let packages: ExportPackage[];
    let snapshotProjectId: string;
    let historicalMediaJobIds: string[];
    try {
      const integrity = checkIntegrity(snapshot);
      if (!integrity.ok) throw new Error('Project export database integrity check failed.');
      references = snapshotReferences(snapshot);
      snapshotProjectId = (
        snapshot.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }
      ).id;
      historicalMediaJobIds = (
        snapshot.prepare('SELECT id FROM generation_jobs').all() as Array<{ id: string }>
      ).map((job) => job.id);
      packages = (
        snapshot
          .prepare(
            `SELECT id, package_relative_path AS path,
        manifest_hash AS hash, export_format AS format FROM markdown_export_jobs
        WHERE status = 'succeeded'`,
          )
          .all() as ExportPackage[]
      ).map((entry) => ({
        ...entry,
        mergedPaths: (
          snapshot
            .prepare(
              'SELECT DISTINCT relative_path AS path FROM markdown_export_items WHERE job_id = ?',
            )
            .all(entry.id) as Array<{ path: string }>
        ).map((item) => item.path),
      }));
    } finally {
      snapshot.close();
    }

    const copied = new Map<string, { hash: string; size: number }>();
    const copy = async (relativePath: string) => {
      assertCurrent();
      const source = projectPath(root, relativePath);
      await noLinks(source);
      const info = await lstat(source);
      if (!info.isFile()) throw new Error('Project export requires regular files.');
      const target = projectPath(staging, relativePath);
      await mkdir(dirname(target), { recursive: true });
      assertStorageCapacity(dirname(target), info.size);
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(
        createReadStream(source),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            try {
              assertCurrent();
              assertStorageCapacity(dirname(target), chunk.length);
              hash.update(chunk);
              size += chunk.length;
              callback(null, chunk);
            } catch (error) {
              callback(error as Error);
            }
          },
        }),
        createWriteStream(target, { flags: 'wx' }),
      );
      assertCurrent();
      await noLinks(source);
      // Verify the bytes actually staged as well as those read from the source stream.
      const result = await copiedHash(target);
      if (result.hash !== hash.digest('hex') || result.size !== size)
        throw new Error('Project export copy verification failed.');
      copied.set(relative(staging, target), result);
    };
    const tree = async (path: string) => {
      const source = projectPath(root, path);
      try {
        await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await noLinks(source);
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Project export rejects links.');
        if (entry.isDirectory()) await tree(child);
        else await copy(child);
      }
    };
    await tree('assets');
    await tree('exports');
    for (const item of packages) {
      const manifestPath = projectPath(staging, join(item.path, 'manifest.json'));
      if ((await lstat(manifestPath)).size > 16 * 1024 * 1024)
        throw new Error('Project export manifest exceeds its size limit.');
      const manifest = (await readFile(manifestPath, 'utf8')).trimEnd();
      const digest = createHash('sha256').update(manifest).digest('hex');
      const recorded = (
        await readFile(projectPath(staging, join(item.path, 'manifest.sha256')), 'utf8')
      ).trim();
      if (digest !== item.hash || recorded !== digest)
        throw new Error('Project export manifest changed; retry the export.');
      if (item.format === 'merged') {
        const parsed = JSON.parse(manifest) as { mergedOutputHash?: string };
        if (item.mergedPaths.length !== 1 || !/^[a-f0-9]{64}$/i.test(parsed.mergedOutputHash ?? ''))
          throw new Error('Project export merged output is invalid.');
        references.push({
          relativePath: join(item.path, item.mergedPaths[0]!),
          hash: parsed.mergedOutputHash,
        });
      }
    }
    for (const file of references) {
      const path = projectPath(staging, file.relativePath);
      const key = relative(staging, path);
      if (!copied.has(key)) await copy(file.relativePath);
      const result = copied.get(key)!;
      if (
        (file.hash && result.hash !== file.hash) ||
        (file.size != null && result.size !== file.size)
      )
        throw new Error('Project export source changed; retry the export.');
    }
    for (const folder of [
      'assets/images',
      'assets/videos',
      'assets/audio',
      'cache',
      'exports',
      'backups',
    ])
      await mkdir(join(staging, folder), { recursive: true });
    await writeFile(
      join(staging, 'project-snapshot.json'),
      JSON.stringify({
        version: 1,
        kind: 'project-history',
        projectId: snapshotProjectId,
        exportedAt: new Date().toISOString(),
        historicalMediaJobIds,
      }),
      { flag: 'wx' },
    );
    assertCurrent();
    await noLinks(destination, true);
    const currentTarget = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (currentTarget) {
      if (
        !originalTarget ||
        currentTarget.ino !== originalTarget.ino ||
        currentTarget.dev !== originalTarget.dev ||
        !currentTarget.isDirectory() ||
        (await readdir(destination)).length
      )
        throw new Error('Export destination changed while exporting.');
      await rmdir(destination); // Nonrecursive: a concurrent user file makes publication fail safely.
      removedEmptyTarget = true;
    } else if (originalTarget) throw new Error('Export destination changed while exporting.');
    assertCurrent();
    await rename(staging, destination);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (removedEmptyTarget) await mkdir(destination).catch(() => undefined);
    throw new Error(
      `Project export failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
