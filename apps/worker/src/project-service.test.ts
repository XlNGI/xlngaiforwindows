import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, truncateSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive, ProjectService, resolveProjectRelativePath } from './project-service.js';
import Database from 'better-sqlite3';

const temporaryDirectories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryRoot(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `ai-video-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function service(recentProjectsPath: string) {
  const result = new ProjectService({ recentProjectsPath });
  services.push(result);
  return result;
}

async function waitForFiles(paths: string[]): Promise<void> {
  await expect.poll(() => paths.every((path) => existsSync(path)), { timeout: 10_000 }).toBe(true);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let diagnostics = '';
    child.stderr?.on('data', (chunk) => (diagnostics += String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Contender exited ${code}: ${diagnostics}`)),
    );
  });
}

describe('ProjectService', () => {
  it('creates the project container and reopens it', async () => {
    const base = await temporaryRoot('create');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    const first = service(recent);
    const created = first.create(root, 'First Project');
    expect(created).toMatchObject({ name: 'First Project', mode: 'read-write', schemaVersion: 36 });
    for (const path of [
      'project.sqlite',
      'assets/images',
      'assets/videos',
      'cache',
      'exports',
      'backups',
    ]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
    first.close();
    expect(service(recent).open(root)).toMatchObject({ id: created.id, mode: 'read-write' });
  });

  it('opens a second service read-only while the writer lock is alive', async () => {
    const base = await temporaryRoot('readonly');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    service(recent).create(root, 'Locked Project');
    const reader = service(recent);
    expect(reader.open(root).mode).toBe('read-only');
    await expect(reader.backup()).rejects.toThrow('read-only');
  });

  it('atomically chooses one writer when separate processes open together', async () => {
    const base = await temporaryRoot('lock-race');
    const root = join(base, 'project');
    const creator = service(join(base, 'creator-recent.json'));
    creator.create(root, 'Contended Project');
    creator.close();

    const startPath = join(base, 'start');
    const releasePath = join(base, 'release');
    const fixturePath = fileURLToPath(
      new URL('./fixtures/project-open-contender.ts', import.meta.url),
    );
    const children = Array.from({ length: 8 }, (_, index) => {
      const readyPath = join(base, `ready-${index}`);
      const resultPath = join(base, `result-${index}.json`);
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fixturePath,
          root,
          join(base, `recent-${index}.json`),
          readyPath,
          startPath,
          resultPath,
          releasePath,
        ],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe'] },
      );
      return { child, readyPath, resultPath };
    });

    await waitForFiles(children.map(({ readyPath }) => readyPath));
    await writeFile(startPath, 'start');
    await waitForFiles(children.map(({ resultPath }) => resultPath));
    const results = await Promise.all(
      children.map(
        async ({ resultPath }) =>
          JSON.parse(await readFile(resultPath, 'utf8')) as { mode?: string; error?: string },
      ),
    );
    await writeFile(releasePath, 'release');
    await Promise.all(children.map(({ child }) => waitForExit(child)));

    expect(results.filter(({ mode }) => mode === 'read-write')).toHaveLength(1);
    expect(results.filter(({ mode }) => mode === 'read-only')).toHaveLength(7);
    expect(results.every(({ error }) => error === undefined)).toBe(true);
  }, 20_000);

  it('treats a reused PID with a mismatched process start as stale', () => {
    const now = new Date();
    const sameStart = () => now.toISOString();
    const oldStart = () => new Date(now.getTime() - 3_600_000).toISOString();
    expect(isProcessAlive(process.pid, now.toISOString(), sameStart)).toBe(true);
    expect(isProcessAlive(process.pid, now.toISOString(), oldStart)).toBe(false);
    expect(isProcessAlive(2147483647, now.toISOString(), sameStart)).toBe(false);
    expect(isProcessAlive(process.pid, undefined, oldStart)).toBe(true);
  });

  it('writes process start metadata into the project lock', async () => {
    const base = await temporaryRoot('lock-metadata');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    const writer = service(recent);
    writer.create(root, 'Metadata Project');
    const lock = JSON.parse(await readFile(join(root, '.ai-video.lock'), 'utf8')) as {
      pid: number;
      token: string;
      createdAt: string;
      processStart?: string;
    };
    expect(lock.pid).toBe(process.pid);
    expect(lock.processStart).toBeTruthy();
    expect(Number.isNaN(Date.parse(lock.processStart!))).toBe(false);
  });

  it('recovers an abandoned lock', async () => {
    const base = await temporaryRoot('stale-lock');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    const creator = service(recent);
    creator.create(root, 'Recovered Project');
    creator.close();
    await writeFile(
      join(root, '.ai-video.lock'),
      JSON.stringify({ pid: 2147483647, token: 'stale', createdAt: 'now' }),
    );
    expect(service(recent).open(root).mode).toBe('read-write');
  });

  it('opens a newer schema read-only', async () => {
    const base = await temporaryRoot('newer-schema');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    const creator = service(recent);
    creator.create(root, 'Future Project');
    creator.close();
    const database = new Database(join(root, 'project.sqlite'));
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(99, 'now');
    database.close();
    expect(service(recent).open(root)).toMatchObject({ mode: 'read-only', schemaVersion: 99 });
  });

  it('creates a consistent backup and export that can be opened', async () => {
    const base = await temporaryRoot('backup');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    const writer = service(recent);
    writer.create(root, 'Portable Project');
    const backup = await writer.backup();
    expect(existsSync(backup)).toBe(true);
    const exported = join(base, 'exported');
    await writer.exportProject(exported);
    writer.close();
    expect(service(recent).open(exported)).toMatchObject({
      name: 'Portable Project',
      schemaVersion: 36,
    });
  });

  it('restores a database backup into a new project directory', async () => {
    const base = await temporaryRoot('restore');
    const root = join(base, 'project');
    const recent = join(base, 'recent.json');
    const writer = service(recent);
    const created = writer.create(root, 'Restored Project');
    const backup = await writer.backup();
    writer.close();
    const restored = service(recent).restore(backup, join(base, 'restored'));
    expect(restored).toMatchObject({
      id: created.id,
      name: 'Restored Project',
      mode: 'read-write',
    });
  });

  it('preserves a corrupt backup error and removes the failed restore directory', async () => {
    const base = await temporaryRoot('restore-corrupt');
    const root = join(base, 'project');
    const writer = service(join(base, 'recent.json'));
    writer.create(root, 'Corrupt Restore Project');
    const backup = await writer.backup();
    writer.close();
    truncateSync(backup, 512);
    const destination = join(base, 'failed-restore');

    expect(() => service(join(base, 'restore-recent.json')).restore(backup, destination)).toThrow(
      /database|malformed|integrity/i,
    );
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects exporting inside the active project', async () => {
    const base = await temporaryRoot('boundary');
    const root = join(base, 'project');
    const writer = service(join(base, 'recent.json'));
    writer.create(root, 'Boundary Project');
    await expect(writer.exportProject(join(root, 'exports', 'copy'))).rejects.toThrow('outside');
  });

  it('stores recent projects without lock metadata', async () => {
    const base = await temporaryRoot('recent');
    const recent = join(base, 'recent.json');
    service(recent).create(join(base, 'project'), 'Recent Project');
    const contents = await readFile(recent, 'utf8');
    expect(contents).toContain('Recent Project');
    expect(contents).not.toContain('token');
  });

  it('keeps create and open sessions usable when recent-project metadata cannot be written', async () => {
    const base = await temporaryRoot('recent-write-failure');
    const root = join(base, 'project');
    const blockedParent = join(base, 'blocked-parent');
    const recent = join(blockedParent, 'recent.json');
    await writeFile(blockedParent, 'not-a-directory');

    const creator = service(recent);
    expect(creator.create(root, 'Usable Project')).toMatchObject({ mode: 'read-write' });
    expect(creator.current()).toMatchObject({ name: 'Usable Project', mode: 'read-write' });
    expect(creator.integrity().ok).toBe(true);
    creator.close();

    const opener = service(recent);
    expect(opener.open(root)).toMatchObject({ name: 'Usable Project', mode: 'read-write' });
    expect(opener.current()).toMatchObject({ name: 'Usable Project', mode: 'read-write' });
    expect(opener.integrity().ok).toBe(true);
  });

  it('rejects relative project paths', async () => {
    const base = await temporaryRoot('relative');
    expect(() => service(join(base, 'recent.json')).create('relative/project', 'Relative')).toThrow(
      'absolute',
    );
  });

  it('keeps asset paths inside the project root', async () => {
    const base = await temporaryRoot('asset-path');
    expect(resolveProjectRelativePath(base, 'assets/images/frame.png')).toBe(
      join(base, 'assets', 'images', 'frame.png'),
    );
    expect(() => resolveProjectRelativePath(base, '../outside.png')).toThrow('escapes');
    expect(() => resolveProjectRelativePath(base, join(base, 'absolute.png'))).toThrow('relative');
  });
});
