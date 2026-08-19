import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  fstatSync,
  openSync,
  closeSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  NovelMarkdownExportFormat,
  NovelMarkdownExportJobInfo,
  NovelMarkdownExportPrepareParams,
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
  constructor(private readonly projects: ProjectService) {}

  reconcile(): { succeeded: number; failed: number } {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const jobs = database
          .prepare(
            `SELECT id, export_format, package_relative_path, staging_relative_path
         FROM markdown_export_jobs
         WHERE project_id = ? AND status IN ('writing', 'verifying')`,
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
                    item.relativePath !== 'merged.md' &&
                    hash(readFileSync(outputPath).toString('utf8')) !== item.outputHash
                  ) {
                    valid = false;
                    break;
                  }
                }
                if (valid && job.export_format === 'merged') {
                  const mergedPath = join(packagePath, 'merged.md');
                  valid =
                    typeof parsed.mergedOutputHash === 'string' &&
                    existsSync(mergedPath) &&
                    hash(readFileSync(mergedPath).toString('utf8')) === parsed.mergedOutputHash;
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

  prepare(params: NovelMarkdownExportPrepareParams): NovelMarkdownExportJobInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const format = params.exportFormat ?? 'files';
        const rows = this.selectRows(database, project.id, params);
        if (rows.length === 0) throw new Error('No exportable novel chapters were selected.');
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
            this.relativePath(row, ordinal, format),
            now,
          );
        });

        const stagingPath = join(project.rootPath, stagingRelative);
        const packagePath = join(project.rootPath, packageRelative);
        try {
          const exportsPath = join(project.rootPath, 'exports');
          mkdirSync(exportsPath, { recursive: true });
          assertNoSymlinkSegments(project.rootPath, 'exports');
          assertNoSymlinkSegments(project.rootPath, stagingRelative);
          assertNoSymlinkSegments(project.rootPath, packageRelative);
          const projectIdentity = fileIdentity(project.rootPath);
          const exportsIdentity = fileIdentity(exportsPath);
          if (existsSync(packagePath)) throw new Error('Export package path already exists.');
          database
            .prepare(
              "UPDATE markdown_export_jobs SET status = 'writing', started_at = ? WHERE id = ?",
            )
            .run(now, id);
          mkdirSync(stagingPath, { recursive: true });
          const manifestItems: Array<Record<string, unknown>> = [];
          let merged = '';
          rows.forEach((row, ordinal) => {
            const relativePath = this.relativePath(row, ordinal, format);
            const body = `# ${row.display_label} ${row.chapter_title}\n\n${row.content_markdown.trim()}\n`;
            if (format === 'files') {
              const outputPath = join(stagingPath, relativePath);
              mkdirSync(resolve(outputPath, '..'), { recursive: true });
              writeFileSync(outputPath, body, { encoding: 'utf8', flag: 'wx' });
            } else merged += `${body}\n`;
            const outputHash = hash(body);
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
              outputHash,
              publicationNo: row.publication_no,
              documentVersion: row.version_no,
              relativePath,
            });
          });
          const mergedOutputHash = format === 'merged' ? hash(merged) : undefined;
          if (format === 'merged')
            writeFileSync(join(stagingPath, 'merged.md'), merged, {
              encoding: 'utf8',
              flag: 'wx',
            });
          const manifest = JSON.stringify(
            {
              version: 1,
              jobId: id,
              exportType: params.exportType,
              exportFormat: format,
              ...(mergedOutputHash ? { mergedOutputHash } : {}),
              items: manifestItems,
            },
            null,
            2,
          );
          writeFileSync(join(stagingPath, 'manifest.json'), `${manifest}\n`, {
            encoding: 'utf8',
            flag: 'wx',
          });
          database
            .prepare("UPDATE markdown_export_jobs SET status = 'verifying' WHERE id = ?")
            .run(id);
          itemIds.forEach((itemId, ordinal) => {
            const item = database
              .prepare('SELECT relative_path FROM markdown_export_items WHERE id = ?')
              .get(itemId) as { relative_path: string };
            const path = join(stagingPath, item.relative_path);
            if (format === 'files' && !existsSync(path))
              throw new Error('Export item was not written.');
            if (format === 'files') assertRegularSingleLinkFile(path);
            const row = rows[ordinal]!;
            const output =
              format === 'files'
                ? readFileSync(path)
                : Buffer.from(
                    `# ${row.display_label} ${row.chapter_title}\n\n${row.content_markdown.trim()}\n`,
                    'utf8',
                  );
            database
              .prepare(
                "UPDATE markdown_export_items SET status = 'succeeded', byte_size = ?, output_hash = ? WHERE id = ?",
              )
              .run(output.byteLength, hash(output.toString('utf8')), itemId);
          });
          const manifestHash = hash(manifest);
          writeFileSync(join(stagingPath, 'manifest.sha256'), `${manifestHash}\n`, {
            encoding: 'utf8',
            flag: 'wx',
          });
          assertSameIdentity(project.rootPath, projectIdentity);
          assertSameIdentity(exportsPath, exportsIdentity);
          assertNoSymlinkSegments(project.rootPath, stagingRelative);
          renameSync(stagingPath, packagePath);
          assertSameIdentity(project.rootPath, projectIdentity);
          assertSameIdentity(exportsPath, exportsIdentity);
          assertNoSymlinkSegments(project.rootPath, packageRelative);
          database
            .prepare(
              "UPDATE markdown_export_jobs SET status = 'succeeded', manifest_hash = ?, completed_at = ? WHERE id = ?",
            )
            .run(manifestHash, new Date().toISOString(), id);
        } catch (error) {
          rmSync(stagingPath, { recursive: true, force: true });
          database
            .prepare(
              "UPDATE markdown_export_jobs SET status = 'failed', error_code = 'EXPORT_FAILED', error_message = ?, completed_at = ? WHERE id = ?",
            )
            .run(
              error instanceof Error ? error.message.slice(0, 500) : 'Export failed.',
              new Date().toISOString(),
              id,
            );
          throw error;
        }
        return exportInfo(
          database.prepare('SELECT * FROM markdown_export_jobs WHERE id = ?').get(id) as never,
          project.rootPath,
        );
      })(),
    );
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

  private relativePath(row: ExportRow, ordinal: number, format: NovelMarkdownExportFormat): string {
    if (format === 'merged') return 'merged.md';
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
