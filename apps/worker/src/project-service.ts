import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IntegrityReport, OpenProject, RecentProject } from '@ai-video/domain';
import {
  checkIntegrity,
  checkpoint,
  CURRENT_SCHEMA_VERSION,
  createRepositories,
  getSchemaVersion,
  migrateDatabase,
  openProjectDatabase,
} from '@ai-video/persistence';

const PROJECT_DIRECTORIES = [
  'assets/images',
  'assets/videos',
  'assets/audio',
  'cache',
  'exports',
  'backups',
] as const;
const DATABASE_NAME = 'project.sqlite';
const LOCK_NAME = '.ai-video.lock';

interface LockContents {
  pid: number;
  token: string;
  createdAt: string;
}

interface ProjectSession {
  database: Database.Database;
  project: OpenProject;
  lockPath?: string;
  lockToken?: string;
}

export interface ProjectServiceOptions {
  nativeBinding?: object;
  recentProjectsPath?: string;
}

function ensureRootPath(rootPath: string): string {
  if (!rootPath.trim()) throw new Error('Project path is required.');
  if (!isAbsolute(rootPath)) throw new Error('Project path must be absolute.');
  const resolved = resolve(rootPath);
  return resolved;
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath: string): LockContents | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
  } catch {
    return undefined;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function tryAcquireLock(rootPath: string): { path: string; token: string } | undefined {
  const lockPath = join(rootPath, LOCK_NAME);
  const token = randomUUID();
  const temporaryPath = `${lockPath}.${process.pid}.${token}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
    { encoding: 'utf8', flag: 'wx' },
  );

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // A hard link publishes only a fully written lock and fails atomically when a lock exists.
        linkSync(temporaryPath, lockPath);
        return { path: lockPath, token };
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
        const lock = readLock(lockPath);
        if (lock && isProcessAlive(lock.pid)) return undefined;
        try {
          rmSync(lockPath);
        } catch (removeError) {
          if (!hasErrorCode(removeError, 'ENOENT')) return undefined;
        }
      }
    }
    // Contention that cannot be resolved safely fails closed as read-only.
    return undefined;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function releaseLock(session: ProjectSession): void {
  if (!session.lockPath || !session.lockToken) return;
  const lock = readLock(session.lockPath);
  if (lock?.token === session.lockToken) rmSync(session.lockPath, { force: true });
}

export class ProjectService {
  private session?: ProjectSession;
  private readonly nativeBinding?: object;
  private readonly recentProjectsPath: string;

  constructor(options: ProjectServiceOptions = {}) {
    this.nativeBinding = options.nativeBinding;
    this.recentProjectsPath =
      options.recentProjectsPath ??
      join(homedir(), 'AppData', 'Local', 'AI Video Workspace', 'recent-projects.json');
  }

  create(rootPath: string, name: string): OpenProject {
    const root = ensureRootPath(rootPath);
    const projectName = name.trim();
    if (!projectName) throw new Error('Project name is required.');
    if (existsSync(join(root, DATABASE_NAME))) throw new Error('A project already exists here.');

    this.close();
    mkdirSync(root, { recursive: true });
    for (const directory of PROJECT_DIRECTORIES)
      mkdirSync(join(root, directory), { recursive: true });
    const lock = tryAcquireLock(root);
    if (!lock) throw new Error('Project is already open for writing.');

    const database = openProjectDatabase(join(root, DATABASE_NAME), {
      nativeBinding: this.nativeBinding,
    });
    try {
      const schemaVersion = migrateDatabase(database);
      const now = new Date().toISOString();
      const id = randomUUID();
      database
        .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, projectName, now, now);
      this.session = {
        database,
        lockPath: lock.path,
        lockToken: lock.token,
        project: {
          id,
          name: projectName,
          rootPath: root,
          createdAt: now,
          updatedAt: now,
          mode: 'read-write',
          schemaVersion,
        },
      };
      this.rememberBestEffort(this.session.project);
      return this.session.project;
    } catch (error) {
      if (this.session?.database === database) this.session = undefined;
      database.close();
      rmSync(lock.path, { force: true });
      throw error;
    }
  }

  open(rootPath: string): OpenProject {
    const root = ensureRootPath(rootPath);
    const databasePath = join(root, DATABASE_NAME);
    if (!existsSync(databasePath)) throw new Error('project.sqlite was not found.');
    this.close();

    const lock = tryAcquireLock(root);
    const readonly = !lock;
    let database = openProjectDatabase(databasePath, {
      readonly,
      nativeBinding: this.nativeBinding,
    });
    try {
      let openReadonly = readonly;
      let schemaVersion = getSchemaVersion(database);
      if (!readonly && schemaVersion > CURRENT_SCHEMA_VERSION) {
        database.close();
        if (lock) rmSync(lock.path, { force: true });
        database = openProjectDatabase(databasePath, {
          readonly: true,
          nativeBinding: this.nativeBinding,
        });
        openReadonly = true;
        schemaVersion = getSchemaVersion(database);
      } else if (!readonly) {
        schemaVersion = migrateDatabase(database);
      }
      const metadata = createRepositories(database).projects.get();
      this.session = {
        database,
        lockPath: lock?.path,
        lockToken: lock?.token,
        project: {
          ...metadata,
          rootPath: root,
          mode: openReadonly ? 'read-only' : 'read-write',
          schemaVersion,
        },
      };
      this.rememberBestEffort(this.session.project);
      return this.session.project;
    } catch (error) {
      if (this.session?.database === database) this.session = undefined;
      database.close();
      if (lock) rmSync(lock.path, { force: true });
      throw error;
    }
  }

  close(): void {
    if (!this.session) return;
    const session = this.session;
    this.session = undefined;
    try {
      if (session.project.mode === 'read-write') checkpoint(session.database);
      session.database.close();
    } finally {
      releaseLock(session);
    }
  }

  current(): OpenProject | undefined {
    return this.session?.project;
  }

  access<T>(
    writable: boolean,
    operation: (database: Database.Database, project: OpenProject) => T,
  ): T {
    const session = writable ? this.requireWritableSession() : this.requireSession();
    return operation(session.database, session.project);
  }

  integrity(): IntegrityReport {
    if (!this.session) throw new Error('No project is open.');
    return checkIntegrity(this.session.database);
  }

  async backup(destinationPath?: string): Promise<string> {
    const session = this.requireWritableSession();
    checkpoint(session.database);
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const destination = resolve(
      destinationPath ?? join(session.project.rootPath, 'backups', `project-${timestamp}.sqlite`),
    );
    if (!isInside(session.project.rootPath, destination)) {
      throw new Error('Backup destination must stay inside the project directory.');
    }
    mkdirSync(dirname(destination), { recursive: true });
    await session.database.backup(destination);
    return destination;
  }

  async exportProject(destinationRoot: string): Promise<string> {
    const session = this.requireWritableSession();
    const destination = ensureRootPath(destinationRoot);
    if (
      isInside(session.project.rootPath, destination) ||
      isInside(destination, session.project.rootPath)
    ) {
      throw new Error('Export destination must be outside the project directory.');
    }
    if (existsSync(destination) && readdirSync(destination).length > 0) {
      throw new Error('Export destination must be empty.');
    }
    mkdirSync(destination, { recursive: true });
    for (const directory of PROJECT_DIRECTORIES)
      mkdirSync(join(destination, directory), { recursive: true });
    checkpoint(session.database);
    await session.database.backup(join(destination, DATABASE_NAME));
    for (const directory of ['assets', 'exports'] as const) {
      const source = join(session.project.rootPath, directory);
      if (existsSync(source)) cpSync(source, join(destination, directory), { recursive: true });
    }
    return destination;
  }

  restore(backupPath: string, destinationRoot: string): OpenProject {
    const backup = resolve(backupPath);
    const destination = ensureRootPath(destinationRoot);
    if (!isAbsolute(backupPath)) throw new Error('Backup path must be absolute.');
    if (!existsSync(backup)) throw new Error('Backup database was not found.');
    if (existsSync(destination) && readdirSync(destination).length > 0) {
      throw new Error('Restore destination must be empty.');
    }

    this.close();
    mkdirSync(destination, { recursive: true });
    for (const directory of PROJECT_DIRECTORIES) {
      mkdirSync(join(destination, directory), { recursive: true });
    }
    const restoredDatabase = join(destination, DATABASE_NAME);
    cpSync(backup, restoredDatabase);
    try {
      let probe: Database.Database | undefined;
      let report: IntegrityReport;
      try {
        probe = openProjectDatabase(restoredDatabase, {
          readonly: true,
          nativeBinding: this.nativeBinding,
        });
        report = checkIntegrity(probe);
      } finally {
        probe?.close();
      }
      if (!report.ok)
        throw new Error(`Backup integrity check failed: ${report.messages.join('; ')}`);
      return this.open(destination);
    } catch (error) {
      try {
        rmSync(destination, { recursive: true, force: true });
      } catch (cleanupError) {
        const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if (error instanceof Error) {
          error.message = `${error.message} Restore cleanup also failed: ${reason}`;
        }
      }
      throw error;
    }
  }

  listRecent(): RecentProject[] {
    try {
      const value = JSON.parse(readFileSync(this.recentProjectsPath, 'utf8')) as RecentProject[];
      return value.filter((item) => existsSync(join(item.rootPath, DATABASE_NAME))).slice(0, 10);
    } catch {
      return [];
    }
  }

  private requireWritableSession(): ProjectSession {
    const session = this.requireSession();
    if (session.project.mode !== 'read-write') throw new Error('Project is open read-only.');
    return session;
  }

  private requireSession(): ProjectSession {
    if (!this.session) throw new Error('No project is open.');
    return this.session;
  }

  private rememberBestEffort(project: OpenProject): void {
    try {
      this.remember(project);
    } catch {
      // Recent-project history is auxiliary metadata and must not invalidate an open database.
    }
  }

  private remember(project: OpenProject): void {
    const recent = this.listRecent().filter((item) => item.rootPath !== project.rootPath);
    recent.unshift({
      name: project.name,
      rootPath: project.rootPath,
      lastOpenedAt: new Date().toISOString(),
    });
    mkdirSync(dirname(this.recentProjectsPath), { recursive: true });
    const temporary = `${this.recentProjectsPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(recent.slice(0, 10), null, 2), 'utf8');
      renameSync(temporary, this.recentProjectsPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function resolveProjectRelativePath(rootPath: string, relativePath: string): string {
  if (!relativePath.trim()) throw new Error('Relative path is required.');
  if (isAbsolute(relativePath)) throw new Error('Asset path must be relative.');
  const root = ensureRootPath(rootPath);
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error('Asset path escapes the project directory.');
  return candidate;
}
