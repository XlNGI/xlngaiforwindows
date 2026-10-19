import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { ExecutionPool } from './execution-pool.js';
import { assertProjectTaskAdmission } from './task-admission.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, fstatSync, openSync, closeSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  NovelMarkdownExportFormat,
  NovelMarkdownExportJobInfo,
  NovelMarkdownExportPrepareParams,
  PathResult,
} from '@ai-video/contracts';
import { ProjectService } from './project-service.js';

type ExportRow = {
  chapter_id: string;
  document_id: string;
  document_version_id: string;
  version_no: number;
  content_markdown: string;
  content_hash: string | null;
  source_state: 'published' | 'draft';
  publication_no: number | null;
  work_title: string;
  volume_title: string | null;
  position: number;
  display_label: string;
  chapter_title: string;
};

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function openExportDirectory(path: string): Promise<void> {
  return new Promise((resolveOpened, reject) => {
    const command =
      process.platform === 'win32'
        ? 'explorer.exe'
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open';
    const child = spawn(command, [path], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveOpened();
    });
  });
}

const WINDOWS_INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]/;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function replaceUnsafeFilenameCharacters(value: string): string {
  return Array.from(value, (character) =>
    hasControlCharacter(character) || WINDOWS_INVALID_FILENAME_CHARACTERS.test(character)
      ? '_'
      : character,
  ).join('');
}

function safeSegment(value: string, fallback: string): string {
  const normalized = replaceUnsafeFilenameCharacters(value.normalize('NFC').trim());
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized);
  const result = (reserved ? `_${normalized}` : normalized).replace(/[ .]+$/g, '').slice(0, 100);
  return result || fallback;
}

function assertSafeRelativePath(value: string): void {
  if (
    !value ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  ) {
    throw new Error('Export path must be a relative project path.');
  }
  for (const segment of value.split(/[\\/]+/)) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      hasControlCharacter(segment)
    ) {
      throw new Error('Export path contains an unsafe segment.');
    }
    if (/[ .]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new Error('Export path contains a Windows-reserved segment.');
    }
  }
}

function assertNoSymlinkSegments(rootPath: string, relativePath: string): void {
  assertSafeRelativePath(relativePath);
  const root = resolve(rootPath);
  let current = root;
  for (const segment of relativePath.split(/[\\/]+/)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Export path contains a symbolic link.');
  }
}

type FileIdentity = { dev: bigint; ino: bigint };

function fileIdentity(path: string): FileIdentity {
  const descriptor = openSync(path, 'r');
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(descriptor);
  }
}

function assertSameIdentity(path: string, expected: FileIdentity): void {
  const current = fileIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('Export directory identity changed during writing.');
  }
}

function assertRegularSingleLinkFile(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('Export output must be a regular file with a single filesystem link.');
  }
}

function exportInfo(
  row: {
    id: string;
    project_id: string;
    export_type: NovelMarkdownExportJobInfo['exportType'];
    export_format: NovelMarkdownExportFormat;
    package_relative_path: string;
    status: NovelMarkdownExportJobInfo['status'];
    item_count: number;
    manifest_hash: string | null;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
  },
  rootPath: string,
): NovelMarkdownExportJobInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    exportType: row.export_type,
    exportFormat: row.export_format,
    packagePath: join(rootPath, row.package_relative_path),
    status: row.status,
    itemCount: row.item_count,
    manifestHash: row.manifest_hash ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class MarkdownExportService {
  private readonly running = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  constructor(
    private readonly projects: ProjectService,
    private readonly openDirectory: (path: string) => void | Promise<void> = openExportDirectory,
    private readonly capacity = new ExecutionPool(),
  ) {}

  async reveal(params: { jobId: string }): Promise<PathResult> {
    const path = this.projects.access(false, (database, project) => {
      const job = database
        .prepare(
          'SELECT package_relative_path, status FROM markdown_export_jobs WHERE id = ? AND project_id = ?',
        )
        .get(params.jobId, project.id) as
        { package_relative_path: string; status: string } | undefined;
      if (!job || job.status !== 'succeeded') throw new Error('没有找到已完成的小说导出。');
      const packagePath = this.resolveProjectPath(project.rootPath, job.package_relative_path);
      const insideExports = packagePath
        ? relative(resolve(project.rootPath, 'exports'), packagePath)
        : undefined;
      if (
        !packagePath ||
        !insideExports ||
        insideExports === '..' ||
        insideExports.startsWith(`..${sep}`) ||
        isAbsolute(insideExports)
      ) {
        throw new Error('小说导出目录无效，请重新导出。');
      }
      if (!existsSync(packagePath) || !lstatSync(packagePath).isDirectory()) {
        throw new Error('导出文件夹已被移动或删除，请重新导出。');
      }
      return packagePath;
    });
    await this.openDirectory(path);
    return { path };
  }

  reconcile(): { succeeded: number; failed: number } {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const jobs = database
          .prepare(
            `SELECT id, export_format, package_relative_path, staging_relative_path
         FROM markdown_export_jobs
         WHERE project_id = ? AND status IN ('queued','writing', 'verifying')`,
          )
          .all(project.id) as Array<{
          id: string;
          export_format: NovelMarkdownExportFormat;
          package_relative_path: string;
          staging_relative_path: string;
        }>;
        let succeeded = 0;
        let failed = 0;
        for (const job of jobs) {
          const now = new Date().toISOString();
          const fail = (message: string) => {
            database
              .prepare(
                `UPDATE markdown_export_jobs SET status = 'failed', error_code = 'EXPORT_RECOVERY_FAILED',
             error_message = ?, completed_at = ? WHERE id = ?`,
              )
              .run(message, now, job.id);
            database
              .prepare(
                `UPDATE markdown_export_items SET status = 'failed', error_code = 'EXPORT_RECOVERY_FAILED',
             error_message = ? WHERE job_id = ? AND status IN ('queued', 'writing', 'verifying')`,
              )
              .run(message, job.id);
            failed += 1;
          };
          const packagePath = this.resolveProjectPath(project.rootPath, job.package_relative_path);
          const stagingPath = this.resolveProjectPath(project.rootPath, job.staging_relative_path);
          if (!packagePath || !stagingPath) {
            fail('Export recovery found an invalid stored path.');
            continue;
          }
          const manifestPath = join(packagePath, 'manifest.json');
          const manifestHashPath = join(packagePath, 'manifest.sha256');
          let manifest: string | undefined;
          let expectedHash: string | undefined;
          try {
            manifest =
              existsSync(manifestPath) && existsSync(manifestHashPath)
                ? readFileSync(manifestPath, 'utf8').trimEnd()
                : undefined;
            expectedHash = manifest ? readFileSync(manifestHashPath, 'utf8').trim() : undefined;
          } catch {
            fail('Export recovery could not read the final package manifest.');
            continue;
          }
          let valid = false;
          if (manifest && expectedHash === hash(manifest)) {
            try {
              const parsed = JSON.parse(manifest) as {
                jobId?: unknown;
                exportFormat?: unknown;
                mergedOutputHash?: unknown;
                items?: Array<{ ordinal?: unknown; relativePath?: unknown; outputHash?: unknown }>;
              };
              const itemCount = database
                .prepare('SELECT COUNT(*) AS value FROM markdown_export_items WHERE job_id = ?')
                .get(job.id) as { value: number };
              const storedItems = database
                .prepare(
                  'SELECT ordinal, relative_path, output_hash FROM markdown_export_items WHERE job_id = ? ORDER BY ordinal',
                )
                .all(job.id) as Array<{
                ordinal: number;
                relative_path: string;
                output_hash: string | null;
              }>;
              const manifestItems = parsed.items;
              valid =
                parsed.jobId === job.id &&
                parsed.exportFormat === job.export_format &&
                Array.isArray(manifestItems) &&
                manifestItems.length === itemCount.value &&
                manifestItems.every(
                  (item, index) =>
                    item.ordinal === storedItems[index]?.ordinal &&
                    item.relativePath === storedItems[index]?.relative_path &&
                    item.outputHash === storedItems[index]?.output_hash,
                );
              if (valid && Array.isArray(manifestItems)) {
                for (const item of manifestItems) {
                  if (
                    typeof item.relativePath !== 'string' ||
                    typeof item.outputHash !== 'string'
                  ) {
                    valid = false;
                    break;
                  }
                  assertSafeRelativePath(item.relativePath);
                  const outputPath = resolve(packagePath, item.relativePath);
                  const outputRelative = relative(packagePath, outputPath);
                  if (
                    outputRelative === '..' ||
                    outputRelative.startsWith(`..${sep}`) ||
                    isAbsolute(outputRelative)
                  ) {
                    valid = false;
                    break;
                  }
                  if (!existsSync(outputPath)) {
                    valid = false;
                    break;
                  }
                  assertNoSymlinkSegments(
                    project.rootPath,
                    join(job.package_relative_path, item.relativePath),
                  );
                  assertRegularSingleLinkFile(outputPath);
                  if (
                    job.export_format === 'files' &&
                    hash(readFileSync(outputPath).toString('utf8')) !== item.outputHash
                  ) {
                    valid = false;
                    break;
                  }
                }
                if (valid && job.export_format === 'merged') {
                  const mergedRelativePath = storedItems[0]?.relative_path;
                  valid =
                    typeof mergedRelativePath === 'string' &&
                    storedItems.every((item) => item.relative_path === mergedRelativePath) &&
                    typeof parsed.mergedOutputHash === 'string' &&
                    existsSync(join(packagePath, mergedRelativePath)) &&
                    hash(readFileSync(join(packagePath, mergedRelativePath)).toString('utf8')) ===
                      parsed.mergedOutputHash;
                }
              }
            } catch {
              valid = false;
            }
          }
          if (valid) {
            database
              .prepare(
                `UPDATE markdown_export_jobs SET status = 'succeeded', manifest_hash = ?, completed_at = ?,
             error_code = NULL, error_message = NULL WHERE id = ?`,
              )
              .run(expectedHash, now, job.id);
            database
              .prepare(
                "UPDATE markdown_export_items SET status = 'succeeded' WHERE job_id = ? AND status IN ('queued', 'writing', 'verifying')",
              )
              .run(job.id);
            succeeded += 1;
            continue;
          }
          const message = existsSync(stagingPath)
            ? 'Export recovery found an incomplete staging package.'
            : 'Export recovery could not verify the final package manifest.';
          fail(message);
        }
        return { succeeded, failed };
      })(),
    );
  }

  start(params: NovelMarkdownExportPrepareParams): NovelMarkdownExportJobInfo {
    const epoch = this.projects.currentSessionId();
    const prepared = this.projects.access(true, (database, project) =>
      database.transaction(() => {
        assertProjectTaskAdmission(database);
        const format = params.exportFormat ?? 'files';
        const rows = this.selectRows(database, project.id, params);
        if (rows.length === 0) {
          throw new Error(
            params.includeDraft
              ? '所选章节没有已保存的正文，请先保存后再导出。'
              : '所选范围没有已发布章节。若要导出草稿，请勾选“包含草稿”。',
          );
        }
        const mergedFilename = rows.some((row) => row.source_state === 'draft')
          ? 'merged.draft.md'
          : 'merged.md';
        const id = randomUUID();
        const now = new Date().toISOString();
        const packageRelative = join(
          'exports',
          `novel-${now.replace(/[-:.TZ]/g, '')}-${id.slice(0, 8)}`,
        );
        const stagingRelative = join('exports', `.staging-${id}`);
        database
          .prepare(
            `INSERT INTO markdown_export_jobs
         (id, project_id, export_type, export_format, destination_root, package_relative_path,
          staging_relative_path, status, requested_by_type, requested_by_id, item_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'user', 'local-user', ?, ?)`,
          )
          .run(
            id,
            project.id,
            params.exportType,
            format,
            project.rootPath,
            packageRelative,
            stagingRelative,
            rows.length,
            now,
          );

        const insertItem = database.prepare(
          `INSERT INTO markdown_export_items
         (id, job_id, project_id, ordinal, chapter_id, document_id, document_version_id, source_state,
          source_content_hash, work_title_snapshot, volume_title_snapshot, position_snapshot,
          display_label_snapshot, chapter_title_snapshot, publication_no, document_version_no,
          relative_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        );
        const itemIds: string[] = [];
        rows.forEach((row, ordinal) => {
          const itemId = randomUUID();
          itemIds.push(itemId);
          insertItem.run(
            itemId,
            id,
            project.id,
            ordinal,
            row.chapter_id,
            row.document_id,
            row.document_version_id,
            row.source_state,
            row.content_hash ?? hash(row.content_markdown),
            row.work_title,
            row.volume_title,
            row.position,
            row.display_label,
            row.chapter_title,
            row.publication_no,
            row.version_no,
            this.relativePath(row, ordinal, format, mergedFilename),
            now,
          );
        });

        return {
          id,
          rows,
          itemIds,
          format,
          mergedFilename,
          stagingRelative,
          packageRelative,
          root: project.rootPath,
          projectId: project.id,
          exportType: params.exportType,
        };
      })(),
    );
    const controller = new AbortController();
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (this.projects.currentSessionId() !== epoch)
        throw new Error('Project session changed during Markdown export.');
    };
    const completion = this.capacity
      .run('file-io', prepared.projectId, controller.signal, () =>
        this.write(prepared, assertCurrent),
      )
      .catch((error: unknown) => {
        if (this.projects.currentSessionId() !== epoch) return;
        this.projects.access(true, (database) =>
          database.transaction(() => {
            const message = error instanceof Error ? error.message.slice(0, 500) : 'Export failed.';
            database
              .prepare(
                "UPDATE markdown_export_jobs SET status=?,error_code=?,error_message=?,completed_at=? WHERE id=? AND status IN('queued','writing','verifying')",
              )
              .run(
                controller.signal.aborted ? 'cancelled' : 'failed',
                controller.signal.aborted ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED',
                message,
                new Date().toISOString(),
                prepared.id,
              );
            database
              .prepare(
                "UPDATE markdown_export_items SET status='failed',error_code=?,error_message=? WHERE job_id=? AND status IN('queued','writing','verifying')",
              )
              .run(
                controller.signal.aborted ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED',
                message,
                prepared.id,
              );
          })(),
        );
      })
      .finally(() => {
        if (this.running.get(prepared.id)?.controller === controller)
          this.running.delete(prepared.id);
      });
    this.running.set(prepared.id, { controller, completion });
    return this.get(prepared.id);
  }

  async prepare(params: NovelMarkdownExportPrepareParams): Promise<NovelMarkdownExportJobInfo> {
    const job = this.start(params);
    await this.wait(job.id);
    const result = this.get(job.id);
    if (result.status !== 'succeeded')
      throw new Error(result.errorMessage ?? 'Markdown export failed.');
    return result;
  }
  get(id: string): NovelMarkdownExportJobInfo {
    return this.projects.access(false, (database, project) => {
      const row = database
        .prepare('SELECT * FROM markdown_export_jobs WHERE id=? AND project_id=?')
        .get(id, project.id);
      if (!row) throw new Error('Markdown export was not found in this project.');
      return exportInfo(row as never, project.rootPath);
    });
  }
  list(): NovelMarkdownExportJobInfo[] {
    return this.projects.access(false, (database, project) =>
      database
        .prepare(
          'SELECT * FROM markdown_export_jobs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
        )
        .all(project.id)
        .map((row) => exportInfo(row as never, project.rootPath)),
    );
  }
  async wait(id: string): Promise<void> {
    await this.running.get(id)?.completion;
  }
  async cancel(id: string): Promise<NovelMarkdownExportJobInfo> {
    this.get(id);
    const entry = this.running.get(id);
    if (entry) {
      entry.controller.abort(new Error('Markdown export cancelled.'));
      await entry.completion;
    }
    return this.get(id);
  }
  async stop(): Promise<void> {
    for (const entry of this.running.values())
      entry.controller.abort(new Error('Project export stopped.'));
    await Promise.allSettled([...this.running.values()].map((entry) => entry.completion));
  }

  private async write(
    prepared: {
      id: string;
      rows: ExportRow[];
      itemIds: string[];
      format: NovelMarkdownExportFormat;
      mergedFilename: string;
      stagingRelative: string;
      packageRelative: string;
      root: string;
      projectId: string;
      exportType: NovelMarkdownExportJobInfo['exportType'];
    },
    assertCurrent: () => void,
  ): Promise<void> {
    const { id, rows, itemIds, format, mergedFilename, stagingRelative, packageRelative, root } =
      prepared;
    const stagingPath = join(root, stagingRelative),
      packagePath = join(root, packageRelative),
      exportsPath = join(root, 'exports');
    let ownedStaging = false,
      published = false;
    let stagingIdentity: FileIdentity | undefined;
    try {
      assertCurrent();
      await mkdir(exportsPath, { recursive: true });
      assertNoSymlinkSegments(root, 'exports');
      assertNoSymlinkSegments(root, stagingRelative);
      assertNoSymlinkSegments(root, packageRelative);
      const projectIdentity = fileIdentity(root),
        exportsIdentity = fileIdentity(exportsPath);
      if (existsSync(packagePath) || existsSync(stagingPath))
        throw new Error('Export package path already exists.');
      await mkdir(stagingPath);
      ownedStaging = true;
      stagingIdentity = fileIdentity(stagingPath);
      this.projects.access(true, (database) =>
        database
          .prepare(
            "UPDATE markdown_export_jobs SET status='writing',started_at=? WHERE id=? AND status='queued'",
          )
          .run(new Date().toISOString(), id),
      );
      const manifestItems: Array<Record<string, unknown>> = [];
      const verified: Array<{ id: string; bytes: number; hash: string }> = [];
      const mergedHash = createHash('sha256');
      const mergedFile =
        format === 'merged' ? await open(join(stagingPath, mergedFilename), 'wx') : undefined;
      try {
        for (const [ordinal, row] of rows.entries()) {
          assertCurrent();
          assertSameIdentity(root, projectIdentity);
          assertSameIdentity(exportsPath, exportsIdentity);
          assertSameIdentity(stagingPath, stagingIdentity);
          const relativePath = this.relativePath(row, ordinal, format, mergedFilename),
            body = `# ${row.display_label} ${row.chapter_title}\n\n${row.content_markdown.trim()}\n`;
          const expected = hash(body),
            outputPath = join(stagingPath, relativePath);
          if (format === 'files') {
            await mkdir(dirname(outputPath), { recursive: true });
            assertNoSymlinkSegments(root, join(stagingRelative, relativePath));
            const output = await open(outputPath, 'wx');
            try {
              await output.writeFile(body, 'utf8');
            } finally {
              await output.close();
            }
            assertRegularSingleLinkFile(outputPath);
            const actual = await readFile(outputPath);
            if (hash(actual.toString('utf8')) !== expected)
              throw new Error('Export item content verification failed.');
          } else {
            await mergedFile!.writeFile(body + '\n', 'utf8');
            mergedHash.update(body + '\n');
          }
          verified.push({ id: itemIds[ordinal]!, bytes: Buffer.byteLength(body), hash: expected });
          manifestItems.push({
            ordinal,
            chapterId: row.chapter_id,
            documentId: row.document_id,
            documentVersionId: row.document_version_id,
            sourceState: row.source_state,
            sourceContentHash: row.content_hash ?? hash(row.content_markdown),
            workTitle: row.work_title,
            volumeTitle: row.volume_title,
            position: row.position,
            displayLabel: row.display_label,
            chapterTitle: row.chapter_title,
            outputHash: expected,
            publicationNo: row.publication_no,
            documentVersion: row.version_no,
            relativePath,
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await mergedFile?.close();
      }
      const mergedOutputHash = format === 'merged' ? mergedHash.digest('hex') : undefined;
      if (
        mergedOutputHash &&
        hash((await readFile(join(stagingPath, mergedFilename))).toString('utf8')) !==
          mergedOutputHash
      )
        throw new Error('Merged export verification failed.');
      const manifest = JSON.stringify(
          {
            version: 1,
            jobId: id,
            exportType: prepared.exportType,
            exportFormat: format,
            ...(mergedOutputHash ? { mergedOutputHash } : {}),
            items: manifestItems,
          },
          null,
          2,
        ),
        manifestHash = hash(manifest);
      const manifestFile = await open(join(stagingPath, 'manifest.json'), 'wx');
      try {
        await manifestFile.writeFile(manifest + '\n', 'utf8');
      } finally {
        await manifestFile.close();
      }
      const hashFile = await open(join(stagingPath, 'manifest.sha256'), 'wx');
      try {
        await hashFile.writeFile(manifestHash + '\n', 'utf8');
      } finally {
        await hashFile.close();
      }
      assertCurrent();
      this.projects.access(true, (database) =>
        database.transaction(() => {
          database.prepare("UPDATE markdown_export_jobs SET status='verifying' WHERE id=?").run(id);
          for (const item of verified)
            database
              .prepare(
                "UPDATE markdown_export_items SET status='verifying',byte_size=?,output_hash=? WHERE id=?",
              )
              .run(item.bytes, item.hash, item.id);
        })(),
      );
      assertCurrent();
      assertSameIdentity(root, projectIdentity);
      assertSameIdentity(exportsPath, exportsIdentity);
      assertNoSymlinkSegments(root, stagingRelative);
      assertSameIdentity(stagingPath, stagingIdentity);
      if (existsSync(packagePath)) throw new Error('Export package path already exists.');
      await rename(stagingPath, packagePath);
      published = true;
      assertCurrent();
      assertSameIdentity(root, projectIdentity);
      assertSameIdentity(exportsPath, exportsIdentity);
      assertNoSymlinkSegments(root, packageRelative);
      assertSameIdentity(packagePath, stagingIdentity);
      this.projects.access(true, (database) =>
        database.transaction(() => {
          database
            .prepare(
              "UPDATE markdown_export_jobs SET status='succeeded',manifest_hash=?,completed_at=? WHERE id=? AND status='verifying'",
            )
            .run(manifestHash, new Date().toISOString(), id);
          database
            .prepare(
              "UPDATE markdown_export_items SET status='succeeded' WHERE job_id=? AND status='verifying'",
            )
            .run(id);
        })(),
      );
    } catch (error) {
      if (ownedStaging && stagingIdentity) {
        const owned = published ? packagePath : stagingPath;
        const actual = await lstat(owned, { bigint: true }).catch(() => undefined);
        if (
          actual &&
          !actual.isSymbolicLink() &&
          actual.dev === stagingIdentity.dev &&
          actual.ino === stagingIdentity.ino
        ) {
          assertNoSymlinkSegments(root, published ? packageRelative : stagingRelative);
          await rm(owned, { recursive: true, force: true });
        }
      }
      throw error;
    }
  }

  private selectRows(
    database: Database.Database,
    projectId: string,
    params: NovelMarkdownExportPrepareParams,
  ): ExportRow[] {
    const conditions = ['chapters.project_id = ?', "chapters.lifecycle_status = 'active'"];
    const values: unknown[] = [projectId];
    if (params.exportType === 'chapter') {
      if (!params.chapterId) throw new Error('chapterId is required for chapter export.');
      conditions.push('chapters.id = ?');
      values.push(params.chapterId);
    } else if (params.exportType === 'selection') {
      if (!params.chapterIds?.length)
        throw new Error('chapterIds are required for selection export.');
      conditions.push(`chapters.id IN (${params.chapterIds.map(() => '?').join(',')})`);
      values.push(...params.chapterIds);
    } else if (params.exportType === 'volume') {
      if (!params.volumeId) throw new Error('volumeId is required for volume export.');
      conditions.push('chapters.volume_id = ?');
      values.push(params.volumeId);
    }
    const versionExpression = params.includeDraft
      ? 'COALESCE(documents.current_version_id, documents.published_version_id)'
      : 'documents.published_version_id';
    return database
      .prepare(
        `SELECT chapters.id AS chapter_id, chapters.document_id, versions.id AS document_version_id,
              versions.version AS version_no, versions.content_markdown, versions.content_hash,
              CASE WHEN versions.id = documents.published_version_id THEN 'published' ELSE 'draft' END AS source_state,
              publications.publication_no, projects.name AS work_title, volumes.title AS volume_title,
              chapters.position, chapters.display_label, versions.title_snapshot AS chapter_title
       FROM novel_chapters chapters
       INNER JOIN documents documents ON documents.id = chapters.document_id
       INNER JOIN document_versions versions ON versions.id = ${versionExpression}
       INNER JOIN projects projects ON projects.id = chapters.project_id
       LEFT JOIN novel_volumes volumes ON volumes.id = chapters.volume_id
       LEFT JOIN document_publications publications ON publications.document_version_id = versions.id
       WHERE ${conditions.join(' AND ')} ORDER BY chapters.position, chapters.id`,
      )
      .all(...values) as ExportRow[];
  }

  private relativePath(
    row: ExportRow,
    ordinal: number,
    format: NovelMarkdownExportFormat,
    mergedFilename: string,
  ): string {
    if (format === 'merged') return mergedFilename;
    const version =
      row.source_state === 'published' ? `v${row.publication_no ?? 0}` : `draft.v${row.version_no}`;
    const name = `${String(ordinal + 1).padStart(3, '0')}-${safeSegment(row.display_label, 'chapter')}-${safeSegment(row.chapter_title, 'untitled')}.${version}.md`;
    return row.volume_title
      ? join(
          `${String(row.position + 1).padStart(3, '0')}-${safeSegment(row.volume_title, 'volume')}`,
          name,
        )
      : name;
  }

  private resolveProjectPath(rootPath: string, storedRelativePath: string): string | undefined {
    if (!storedRelativePath || isAbsolute(storedRelativePath)) {
      return undefined;
    }
    try {
      assertNoSymlinkSegments(rootPath, storedRelativePath);
    } catch {
      return undefined;
    }
    const root = resolve(rootPath);
    const candidate = resolve(root, storedRelativePath);
    const pathRelative = relative(root, candidate);
    if (pathRelative === '..' || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
      return undefined;
    }
    return candidate;
  }
}
