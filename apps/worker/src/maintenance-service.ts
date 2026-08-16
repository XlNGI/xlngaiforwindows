import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  CacheClearResult,
  CacheInspectionResult,
  DiagnosticExportParams,
  DiagnosticExportResult,
  PathResult,
} from '@ai-video/contracts';
import { checkIntegrity } from '@ai-video/persistence';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';

const MAX_DIAGNOSTIC_EVENTS = 50;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_024;
const MAX_REPORT_BYTES = 256 * 1_024;
const DIAGNOSTIC_MANIFEST_VERSION = 1 as const;
const SUMMARY_DIRECTORIES = ['assets', 'cache', 'exports', 'backups'] as const;

interface DiagnosticEvent {
  at: string;
  operation: string;
  message: string;
}

interface MaintenanceServiceOptions {
  openPath?: (path: string) => void;
  now?: () => Date;
}

type TreeSummary = CacheInspectionResult;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function redactDiagnosticText(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  text = text
    .replace(/data:[^\s,;]+;base64,[A-Za-z0-9+/=_-]+/gi, '[REDACTED]')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(
      /\b(?:authorization|api[_-]?key|access[_-]?token|token|secret|cookie)\b\s*[:=]\s*[^\s,;]+/gi,
      '[REDACTED]',
    )
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g, '[REDACTED]')
    .replace(/(^|\s)\/(?:home|Users|tmp|var|etc)\/[^\s"'<>]*/g, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
  return text.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
}

function inspectTree(root: string): TreeSummary {
  const summary: TreeSummary = {
    fileCount: 0,
    directoryCount: 0,
    sizeBytes: 0,
    skippedLinks: 0,
  };
  if (!existsSync(root)) return summary;

  const visit = (directory: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    for (const name of names) {
      const path = join(directory, name);
      try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) {
          summary.skippedLinks += 1;
        } else if (stats.isDirectory()) {
          summary.directoryCount += 1;
          visit(path);
        } else if (stats.isFile()) {
          summary.fileCount += 1;
          summary.sizeBytes += stats.size;
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      }
    }
  };

  visit(root);
  return summary;
}

function clearTree(root: string): CacheClearResult {
  const result: CacheClearResult = {
    removedFiles: 0,
    removedDirectories: 0,
    freedBytes: 0,
    removedLinks: 0,
  };
  if (!existsSync(root)) return result;

  const removeEntry = (path: string, removeDirectory: boolean): void => {
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      unlinkSync(path);
      result.removedLinks += 1;
      return;
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(path)) removeEntry(join(path, name), true);
      if (removeDirectory) {
        rmdirSync(path);
        result.removedDirectories += 1;
      }
      return;
    }
    unlinkSync(path);
    result.removedFiles += 1;
    result.freedBytes += stats.size;
  };

  removeEntry(root, false);
  return result;
}

function openDirectory(path: string): void {
  const command =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const child = spawn(command, [path], { detached: true, stdio: 'ignore' });
  child.unref();
}

function scalarCount(database: Database.Database, sql: string, id: string): number {
  const row = database.prepare(sql).get(id) as { count: number };
  return row.count;
}

export class MaintenanceService {
  private readonly events: DiagnosticEvent[] = [];
  private readonly exportedPaths = new Set<string>();
  private readonly openPath: (path: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly projects: ProjectService,
    options: MaintenanceServiceOptions = {},
  ) {
    this.openPath = options.openPath ?? openDirectory;
    this.now = options.now ?? (() => new Date());
  }

  recordError(operation: string, error: unknown): void {
    this.events.push({
      at: this.now().toISOString(),
      operation: redactDiagnosticText(operation),
      message: redactDiagnosticText(error),
    });
    if (this.events.length > MAX_DIAGNOSTIC_EVENTS) this.events.shift();
  }

  recordRequest(operation: string, requestId: string, ok: boolean, durationMs: number): void {
    this.events.push({
      at: this.now().toISOString(),
      operation: redactDiagnosticText(operation),
      message: redactDiagnosticText(
        `request=${requestId} status=${ok ? 'ok' : 'error'} durationMs=${Math.max(0, Math.round(durationMs))}`,
      ),
    });
    if (this.events.length > MAX_DIAGNOSTIC_EVENTS) this.events.shift();
  }

  resetSession(): void {
    this.events.length = 0;
    this.exportedPaths.clear();
  }

  inspectCache(): CacheInspectionResult {
    return this.projects.access(false, (_database, project) =>
      inspectTree(resolveProjectRelativePath(project.rootPath, 'cache')),
    );
  }

  clearCache(): CacheClearResult {
    return this.projects.access(true, (_database, project) => {
      const cachePath = resolveProjectRelativePath(project.rootPath, 'cache');
      const result = clearTree(cachePath);
      mkdirSync(cachePath, { recursive: true });
      return result;
    });
  }

  exportDiagnostics(params: DiagnosticExportParams = {}): DiagnosticExportResult {
    const createdAt = this.now().toISOString();
    return this.projects.access(false, (database, project) => {
      const destinationRoot = params.destinationRoot
        ? resolve(params.destinationRoot)
        : resolveProjectRelativePath(project.rootPath, 'exports');
      if (params.destinationRoot && !isAbsolute(params.destinationRoot)) {
        throw new Error('Diagnostic destination must be absolute.');
      }
      mkdirSync(destinationRoot, { recursive: true });
      const timestamp = createdAt.replaceAll(':', '-');
      const finalPath = join(
        destinationRoot,
        `diagnostics-${timestamp}-${randomUUID().slice(0, 8)}`,
      );
      const temporaryPath = `${finalPath}.tmp`;
      mkdirSync(temporaryPath);

      try {
        const integrity = checkIntegrity(database);
        const tableCounts = {
          documents: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM documents WHERE project_id = ?',
            project.id,
          ),
          scenes: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM scenes WHERE project_id = ?',
            project.id,
          ),
          shots: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM shots WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)',
            project.id,
          ),
          conversations: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM conversations WHERE project_id = ?',
            project.id,
          ),
          messages: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)',
            project.id,
          ),
          assets: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM assets WHERE project_id = ?',
            project.id,
          ),
          jobs: scalarCount(
            database,
            'SELECT COUNT(*) AS count FROM generation_jobs WHERE project_id = ?',
            project.id,
          ),
        };
        const jobStates = database
          .prepare(
            'SELECT status, COUNT(*) AS count FROM generation_jobs WHERE project_id = ? GROUP BY status ORDER BY status',
          )
          .all(project.id) as Array<{ status: string; count: number }>;
        const assetKinds = database
          .prepare(
            'SELECT kind, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS sizeBytes FROM assets WHERE project_id = ? GROUP BY kind ORDER BY kind',
          )
          .all(project.id) as Array<{ kind: string; count: number; sizeBytes: number }>;
        const directories = Object.fromEntries(
          SUMMARY_DIRECTORIES.map((name) => [
            name,
            inspectTree(resolveProjectRelativePath(project.rootPath, name)),
          ]),
        );
        const report = {
          formatVersion: DIAGNOSTIC_MANIFEST_VERSION,
          createdAt,
          runtime: {
            workerVersion: '0.1.0',
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
          },
          project: {
            mode: project.mode,
            schemaVersion: project.schemaVersion,
            databaseBytes: statSync(join(project.rootPath, 'project.sqlite')).size,
            integrity: {
              ok: integrity.ok,
              messages: integrity.messages.map(redactDiagnosticText),
            },
            tableCounts,
            jobStates,
            assetKinds,
            directories,
          },
          events: [...this.events],
        };
        let reportText = JSON.stringify(report, null, 2);
        while (Buffer.byteLength(reportText) > MAX_REPORT_BYTES && report.events.length > 0) {
          report.events.shift();
          reportText = JSON.stringify(report, null, 2);
        }
        if (Buffer.byteLength(reportText) > MAX_REPORT_BYTES) {
          throw new Error('Diagnostic report exceeds the size limit.');
        }
        const reportBytes = Buffer.from(reportText);
        const reportHash = createHash('sha256').update(reportBytes).digest('hex');
        const manifest = {
          format: 'ai-video-diagnostics',
          version: DIAGNOSTIC_MANIFEST_VERSION,
          createdAt,
          files: [
            {
              name: 'report.json',
              sizeBytes: reportBytes.length,
              sha256: reportHash,
            },
          ],
        };
        writeFileSync(join(temporaryPath, 'report.json'), reportBytes, { flag: 'wx' });
        writeFileSync(join(temporaryPath, 'manifest.json'), JSON.stringify(manifest, null, 2), {
          encoding: 'utf8',
          flag: 'wx',
        });
        renameSync(temporaryPath, finalPath);
        this.exportedPaths.add(resolve(finalPath));
        return {
          path: finalPath,
          createdAt,
          manifestVersion: DIAGNOSTIC_MANIFEST_VERSION,
          fileCount: 2,
        };
      } catch (error) {
        rmSync(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    });
  }

  revealDiagnostics(path: string): PathResult {
    const resolvedPath = resolve(path);
    if (!this.exportedPaths.has(resolvedPath)) {
      throw new Error('Diagnostic path was not created by this Worker session.');
    }
    if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isDirectory()) {
      throw new Error('Diagnostic directory was not found.');
    }
    this.openPath(resolvedPath);
    return { path: resolvedPath };
  }
}
