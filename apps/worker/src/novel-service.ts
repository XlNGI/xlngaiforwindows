import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DocumentBindingDomain,
  DocumentBindingRole,
  NovelBindingInfo,
  NovelBindingListParams,
  NovelBindingSaveParams,
  NovelChapterArchiveParams,
  NovelChapterInfo,
  NovelChapterListParams,
  NovelChapterRestoreParams,
  NovelChapterSaveParams,
  NovelImportParams,
  NovelImportResult,
  NovelProfileGetParams,
  NovelProfileInfo,
  NovelProfileUpdateParams,
  NovelVolumeInfo,
  NovelVolumeListParams,
  NovelVolumeSaveParams,
} from '@ai-video/contracts';
import type {
  DocumentBindingRecord,
  NovelChapterRecord,
  NovelProfileRecord,
  NovelVolumeRecord,
} from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

const bindingRoles = new Set<DocumentBindingRole>([
  'work-outline',
  'volume-outline',
  'character-bible',
  'world-bible',
  'timeline',
  'style-guide',
  'adaptation-proposal',
  'screenplay',
  'scene-outline',
  'shot-plan',
  'research',
  'note',
]);
const bindingDomains = new Set<DocumentBindingDomain>(['shared', 'novel', 'short-drama']);
const MAX_IMPORT_CHAPTER_BYTES = 1_048_576;
const MAX_IMPORT_TOTAL_BYTES = 32 * 1024 * 1024;

function required(value: string, label: string, limit = 200): string {
  const result = value.trim();
  if (!result) throw new NovelServiceError('INVALID_PARAMETERS', `${label} is required.`);
  if (result.length > limit)
    throw new NovelServiceError(
      'INVALID_PARAMETERS',
      `${label} must be at most ${limit} characters.`,
    );
  return result;
}

function conflict(message: string): never {
  throw new NovelServiceError('CONFLICT', message);
}

function profileInfo(record: NovelProfileRecord, projectName: string): NovelProfileInfo {
  return { ...record, projectName };
}

function volumeInfo(record: NovelVolumeRecord): NovelVolumeInfo {
  return record;
}

function bindingInfo(record: DocumentBindingRecord): NovelBindingInfo {
  return record;
}

export class NovelServiceError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_PARAMETERS' | 'INVALID_STATE' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export class NovelService {
  constructor(private readonly projects: ProjectService) {}

  getProfile(params: NovelProfileGetParams = {}): NovelProfileInfo | undefined {
    const createIfMissing = params.createIfMissing ?? true;
    return this.projects.access(createIfMissing, (database, project) => {
      const repositories = createRepositories(database);
      let profile = repositories.novelProfiles.get(project.id);
      if (!profile && createIfMissing) {
        const now = new Date().toISOString();
        repositories.novelProfiles.save({
          projectId: project.id,
          language: 'zh-CN',
          status: 'active',
          rowVersion: 0,
          createdAt: now,
          updatedAt: now,
        });
        repositories.projects.touch(now);
        project.updatedAt = now;
        profile = repositories.novelProfiles.get(project.id);
      }
      return profile ? profileInfo(profile, project.name) : undefined;
    });
  }

  updateProfile(params: NovelProfileUpdateParams): NovelProfileInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = repositories.novelProfiles.get(project.id);
      if (!existing)
        throw new NovelServiceError('NOT_FOUND', 'Novel workspace was not initialized.');
      const now = new Date().toISOString();
      const language = params.language
        ? required(params.language, 'Language', 35)
        : existing.language;
      const status = params.status ?? existing.status;
      if (
        !repositories.novelProfiles.save(
          { ...existing, language, status, updatedAt: now },
          params.expectedRowVersion,
        )
      ) {
        conflict('Novel profile was updated elsewhere.');
      }
      repositories.projects.touch(now);
      project.updatedAt = now;
      return profileInfo(repositories.novelProfiles.get(project.id)!, project.name);
    });
  }

  listVolumes(params: NovelVolumeListParams = {}): NovelVolumeInfo[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database).novelVolumes.listByProject(project.id, params.includeArchived),
    );
  }

  saveVolume(params: NovelVolumeSaveParams): NovelVolumeInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = params.volumeId ? repositories.novelVolumes.get(params.volumeId) : undefined;
      if (params.volumeId && (!existing || existing.projectId !== project.id)) {
        throw new NovelServiceError('NOT_FOUND', 'Novel volume was not found.');
      }
      if (existing && params.expectedRowVersion === undefined) {
        throw new NovelServiceError(
          'INVALID_PARAMETERS',
          'expectedRowVersion is required when updating a volume.',
        );
      }
      const now = new Date().toISOString();
      const active = repositories.novelVolumes.listByProject(project.id, true);
      const record: NovelVolumeRecord = {
        id: existing?.id ?? randomUUID(),
        projectId: project.id,
        title: required(params.title, 'Volume title'),
        position: params.position ?? existing?.position ?? active.length,
        status: params.status ?? existing?.status ?? 'active',
        rowVersion: existing?.rowVersion ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      database.transaction(() => {
        if (existing && existing.position !== record.position) {
          const maximum = database
            .prepare(
              'SELECT COALESCE(MAX(position), -1) AS value FROM novel_volumes WHERE project_id = ?',
            )
            .get(project.id) as { value: number };
          database
            .prepare('UPDATE novel_volumes SET position = ? WHERE id = ?')
            .run(maximum.value + 1, existing.id);
        }
        if (!existing || existing.position !== record.position) {
          database
            .prepare(
              `UPDATE novel_volumes SET position = position + 1
               WHERE project_id = ? AND position >= ? AND id != ?`,
            )
            .run(project.id, record.position, record.id);
        }
        if (!repositories.novelVolumes.save(record, params.expectedRowVersion)) {
          conflict('Novel volume was updated elsewhere.');
        }
      })();
      repositories.projects.touch(now);
      project.updatedAt = now;
      return volumeInfo(repositories.novelVolumes.get(record.id)!);
    });
  }

  listChapters(params: NovelChapterListParams = {}): NovelChapterInfo[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      return repositories.novelChapters
        .listByProject(project.id, params.includeArchived)
        .filter((chapter) => params.volumeId === undefined || chapter.volumeId === params.volumeId)
        .map((chapter) => this.chapterInfo(chapter, database));
    });
  }

  saveChapter(params: NovelChapterSaveParams): NovelChapterInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = params.chapterId
        ? repositories.novelChapters.get(params.chapterId)
        : undefined;
      if (params.chapterId && (!existing || existing.projectId !== project.id)) {
        throw new NovelServiceError('NOT_FOUND', 'Novel chapter was not found.');
      }
      if (existing && params.expectedRowVersion === undefined) {
        throw new NovelServiceError(
          'INVALID_PARAMETERS',
          'expectedRowVersion is required when updating a chapter.',
        );
      }
      if (params.volumeId) {
        const volume = repositories.novelVolumes.get(params.volumeId);
        if (!volume || volume.projectId !== project.id) {
          throw new NovelServiceError('NOT_FOUND', 'Novel volume was not found.');
        }
      }
      const now = new Date().toISOString();
      const title = required(params.title, 'Chapter title');
      const position =
        params.position ??
        existing?.position ??
        this.nextChapterPosition(
          repositories.novelChapters.listByProject(project.id, true),
          params.volumeId,
        );
      const lifecycleStatus = params.lifecycleStatus ?? existing?.lifecycleStatus ?? 'active';
      const archiveReason =
        lifecycleStatus === 'archived'
          ? (params.archiveReason ?? existing?.archiveReason ?? 'user_archive')
          : undefined;
      const documentId = existing?.documentId ?? randomUUID();
      let record!: NovelChapterRecord;
      database.transaction(() => {
        if (!existing) {
          repositories.documents.save({
            id: documentId,
            projectId: project.id,
            kind: 'note',
            title,
            scopeType: 'project',
            lifecycleStatus: lifecycleStatus === 'archived' ? 'archived' : 'active',
            rowVersion: 0,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          const document = repositories.documents.get(documentId);
          if (!document || document.projectId !== project.id) {
            throw new NovelServiceError('INVALID_STATE', 'Chapter document is missing.');
          }
          database
            .prepare(
              `UPDATE documents SET title = ?, lifecycle_status = ?, updated_at = ?, row_version = row_version + 1
               WHERE id = ?`,
            )
            .run(title, lifecycleStatus === 'archived' ? 'archived' : 'active', now, documentId);
        }
        record = {
          id: existing?.id ?? randomUUID(),
          projectId: project.id,
          volumeId: params.volumeId ?? existing?.volumeId,
          documentId,
          position,
          displayLabel:
            params.displayLabel !== undefined
              ? required(params.displayLabel, 'Chapter display label', 80)
              : (existing?.displayLabel ?? `第 ${position + 1} 章`),
          lifecycleStatus,
          archiveReason,
          rowVersion: existing?.rowVersion ?? 0,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const moved =
          existing &&
          (existing.position !== record.position || existing.volumeId !== record.volumeId);
        if (moved) {
          const maximum = database
            .prepare(
              'SELECT COALESCE(MAX(position), -1) AS value FROM novel_chapters WHERE project_id = ?',
            )
            .get(project.id) as { value: number };
          database
            .prepare('UPDATE novel_chapters SET position = ? WHERE id = ?')
            .run(maximum.value + 1, existing.id);
        }
        if (!existing || moved) {
          database
            .prepare(
              `UPDATE novel_chapters SET position = position + 1
               WHERE project_id = ? AND volume_id IS ? AND position >= ? AND id != ?`,
            )
            .run(project.id, record.volumeId ?? null, record.position, record.id);
        }
        if (!repositories.novelChapters.save(record, params.expectedRowVersion)) {
          conflict('Novel chapter was updated elsewhere.');
        }
      })();
      repositories.projects.touch(now);
      project.updatedAt = now;
      return this.chapterInfo(repositories.novelChapters.get(record.id)!, database);
    });
  }

  importNovel(params: NovelImportParams): NovelImportResult {
    return this.projects.access(true, (database, project) => {
      const chapters = params.chapters ?? [];
      if (chapters.length < 1 || chapters.length > 200) {
        throw new NovelServiceError(
          'INVALID_PARAMETERS',
          'Import must contain between one and 200 chapters.',
        );
      }
      const totalBytes = chapters.reduce(
        (sum, chapter) => sum + Buffer.byteLength(chapter.contentMarkdown, 'utf8'),
        0,
      );
      if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
        throw new NovelServiceError(
          'INVALID_PARAMETERS',
          'Imported novel exceeds the 32 MiB limit.',
        );
      }
      for (const chapter of chapters) {
        if (Buffer.byteLength(chapter.contentMarkdown, 'utf8') > MAX_IMPORT_CHAPTER_BYTES) {
          throw new NovelServiceError(
            'INVALID_PARAMETERS',
            'Imported chapter exceeds the 1 MiB limit.',
          );
        }
      }
      const repositories = createRepositories(database);
      const now = new Date().toISOString();
      const volumeTitle = params.volumeTitle?.trim();
      const validatedVolumeTitle = volumeTitle ? required(volumeTitle, 'Volume title') : undefined;
      const volumeId = volumeTitle ? randomUUID() : undefined;
      const imported: NovelChapterRecord[] = [];
      database.transaction(() => {
        if (!repositories.novelProfiles.get(project.id)) {
          database
            .prepare(
              `INSERT INTO novel_profiles (project_id, language, status, row_version, created_at, updated_at)
             VALUES (?, 'zh-CN', 'active', 0, ?, ?)`,
            )
            .run(project.id, now, now);
        }
        if (volumeId) {
          database
            .prepare(
              `INSERT INTO novel_volumes (id, project_id, title, position, status, row_version, created_at, updated_at)
             VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM novel_volumes WHERE project_id = ?), 'active', 0, ?, ?)`,
            )
            .run(volumeId, project.id, validatedVolumeTitle, project.id, now, now);
        }
        const positionRow = database
          .prepare(
            'SELECT COALESCE(MAX(position), -1) AS value FROM novel_chapters WHERE project_id = ? AND volume_id IS ?',
          )
          .get(project.id, volumeId ?? null) as { value: number };
        let position = positionRow.value + 1;
        for (const input of chapters) {
          const title = required(input.title, 'Chapter title');
          const content = input.contentMarkdown.trim();
          if (!content)
            throw new NovelServiceError(
              'INVALID_PARAMETERS',
              `Chapter ${title} has empty content.`,
            );
          const documentId = randomUUID();
          const chapterId = randomUUID();
          const versionId = randomUUID();
          const hash = createHash('sha256').update(content, 'utf8').digest('hex');
          const displayLabel = input.displayLabel?.trim() || `第 ${position + 1} 章`;
          database
            .prepare(
              `INSERT INTO documents (id, project_id, kind, title, scope_type, scope_id, lifecycle_status, row_version, created_at, updated_at)
             VALUES (?, ?, 'note', ?, 'project', NULL, 'active', 0, ?, ?)`,
            )
            .run(documentId, project.id, title, now, now);
          database
            .prepare(
              `INSERT INTO document_versions
             (id, document_id, version, content_markdown, state, title_snapshot, scope_type_snapshot,
              author_type, content_hash, state_updated_at, created_at)
             VALUES (?, ?, 1, ?, 'draft', ?, 'project', 'import', ?, ?, ?)`,
            )
            .run(versionId, documentId, content, title, hash, now, now);
          database
            .prepare(`UPDATE documents SET current_version_id = ?, updated_at = ? WHERE id = ?`)
            .run(versionId, now, documentId);
          database
            .prepare(
              `INSERT INTO novel_chapters
             (id, project_id, volume_id, document_id, position, display_label, lifecycle_status,
              archive_reason, row_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, 0, ?, ?)`,
            )
            .run(
              chapterId,
              project.id,
              volumeId ?? null,
              documentId,
              position,
              displayLabel,
              now,
              now,
            );
          imported.push({
            id: chapterId,
            projectId: project.id,
            volumeId,
            documentId,
            position,
            displayLabel,
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: now,
            updatedAt: now,
          });
          position += 1;
        }
        database.prepare('UPDATE projects SET updated_at = ?').run(now);
      })();
      const result: NovelImportResult = {
        volume: volumeId ? repositories.novelVolumes.get(volumeId) : undefined,
        chapters: imported.map((chapter) => this.chapterInfo(chapter, database)),
        importedCount: imported.length,
      };
      project.updatedAt = now;
      return result;
    });
  }

  archiveChapter(params: NovelChapterArchiveParams): NovelChapterInfo {
    return this.saveChapter({
      chapterId: params.chapterId,
      title: this.projects.access(false, (database, project) => {
        const chapter = createRepositories(database).novelChapters.get(params.chapterId);
        if (!chapter || chapter.projectId !== project.id) {
          throw new NovelServiceError('NOT_FOUND', 'Novel chapter was not found.');
        }
        return createRepositories(database).documents.get(chapter.documentId)?.title ?? '';
      }),
      expectedRowVersion: params.expectedRowVersion,
      lifecycleStatus: 'archived',
      archiveReason: params.reason ?? 'user_archive',
    });
  }

  restoreChapter(params: NovelChapterRestoreParams): NovelChapterInfo {
    const { title } = this.projects.access(false, (database, project) => {
      const chapter = createRepositories(database).novelChapters.get(params.chapterId);
      if (!chapter || chapter.projectId !== project.id) {
        throw new NovelServiceError('NOT_FOUND', 'Novel chapter was not found.');
      }
      const title = createRepositories(database).documents.get(chapter.documentId)?.title;
      if (!title) throw new NovelServiceError('INVALID_STATE', 'Chapter document is missing.');
      return { title };
    });
    return this.saveChapter({
      chapterId: params.chapterId,
      title,
      expectedRowVersion: params.expectedRowVersion,
      lifecycleStatus: 'active',
    });
  }

  listBindings(params: NovelBindingListParams = {}): NovelBindingInfo[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database).documentBindings.listByProject(
        project.id,
        params.includeNeedsReview,
      ),
    );
  }

  saveBinding(params: NovelBindingSaveParams): NovelBindingInfo {
    return this.projects.access(true, (database, project) => {
      if (!bindingRoles.has(params.role) || !bindingDomains.has(params.domainScope)) {
        throw new NovelServiceError(
          'INVALID_PARAMETERS',
          'Document binding role or domain is invalid.',
        );
      }
      const repositories = createRepositories(database);
      const existing = params.bindingId
        ? repositories.documentBindings.get(params.bindingId)
        : undefined;
      if (params.bindingId && (!existing || existing.projectId !== project.id)) {
        throw new NovelServiceError('NOT_FOUND', 'Document binding was not found.');
      }
      if (existing && params.expectedRowVersion === undefined) {
        throw new NovelServiceError(
          'INVALID_PARAMETERS',
          'expectedRowVersion is required when updating a binding.',
        );
      }
      const document = repositories.documents.get(params.documentId);
      if (!document || document.projectId !== project.id) {
        throw new NovelServiceError('NOT_FOUND', 'Document was not found.');
      }
      const now = new Date().toISOString();
      const record: DocumentBindingRecord = {
        id: existing?.id ?? randomUUID(),
        projectId: project.id,
        documentId: params.documentId,
        volumeId: params.volumeId,
        chapterId: params.chapterId,
        sceneId: params.sceneId,
        shotId: params.shotId,
        role: params.role,
        domainScope: params.domainScope,
        status: params.status ?? existing?.status ?? 'active',
        rowVersion: existing?.rowVersion ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (!repositories.documentBindings.save(record, params.expectedRowVersion)) {
        conflict('Document binding was updated elsewhere.');
      }
      repositories.projects.touch(now);
      project.updatedAt = now;
      return bindingInfo(repositories.documentBindings.get(record.id)!);
    });
  }

  private nextChapterPosition(chapters: NovelChapterRecord[], volumeId?: string): number {
    return (
      chapters
        .filter((chapter) => chapter.volumeId === volumeId)
        .reduce((maximum, chapter) => Math.max(maximum, chapter.position), -1) + 1
    );
  }

  private chapterInfo(chapter: NovelChapterRecord, database: Database.Database): NovelChapterInfo {
    const document = createRepositories(database).documents.get(chapter.documentId);
    if (!document) throw new NovelServiceError('INVALID_STATE', 'Chapter document is missing.');
    return {
      ...chapter,
      title: document.title,
      documentRowVersion: document.rowVersion ?? 0,
    };
  }
}
