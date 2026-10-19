import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  NovelStructureChapter,
  NovelStructureGetParams,
  NovelStructureReference,
  NovelStructureSnapshot,
  NovelStructureVolume,
  ProjectStructureGetParams,
  ProjectStructureSnapshot,
  ProjectStructureSource,
} from '@ai-video/contracts';
import type { OpenProject } from '@ai-video/domain';

/**
 * The structure compiler is intentionally read-only. It projects the facts
 * already stored in the project database into a bounded metadata tree. It
 * never reads document_versions.content_markdown (or any other body field).
 */
export class NovelStructureCompiler {
  compile(
    database: Database.Database,
    project: OpenProject,
    params?: NovelStructureGetParams,
  ): NovelStructureSnapshot | null;
  compile(
    project: OpenProject,
    database: Database.Database,
    params?: NovelStructureGetParams,
  ): NovelStructureSnapshot | null;
  compile(
    first: Database.Database | OpenProject,
    second: Database.Database | OpenProject,
    params: NovelStructureGetParams = {},
  ): NovelStructureSnapshot | null {
    const database = isDatabase(first) ? first : (second as Database.Database);
    const project = (isDatabase(first) ? second : first) as OpenProject;
    return this.compileFromDatabase(database, project, params);
  }

  compileFromDatabase(
    database: Database.Database,
    project: OpenProject,
    params: NovelStructureGetParams = {},
  ): NovelStructureSnapshot | null {
    return compileNovelFromDatabase(database, project, params);
  }

  compileNovel(
    database: Database.Database,
    project: OpenProject,
    params: NovelStructureGetParams = {},
  ): NovelStructureSnapshot | null {
    return this.compileFromDatabase(database, project, params);
  }
}

export class ProjectStructureCompiler {
  constructor(private readonly novelCompiler = new NovelStructureCompiler()) {}

  compile(
    database: Database.Database,
    project: OpenProject,
    params?: ProjectStructureGetParams,
  ): ProjectStructureSnapshot;
  compile(
    project: OpenProject,
    database: Database.Database,
    params?: ProjectStructureGetParams,
  ): ProjectStructureSnapshot;
  compile(
    first: Database.Database | OpenProject,
    second: Database.Database | OpenProject,
    params: ProjectStructureGetParams = {},
  ): ProjectStructureSnapshot {
    if (isDatabase(first)) {
      return this.compileFromDatabase(first, second as OpenProject, params);
    }
    return this.compileFromDatabase(second as Database.Database, first, params);
  }

  compileFromDatabase(
    database: Database.Database,
    project: OpenProject,
    params: ProjectStructureGetParams = {},
  ): ProjectStructureSnapshot {
    const includeArchived = params.includeArchived === true;
    const novel = this.novelCompiler.compileFromDatabase(database, project, { includeArchived });
    const documents = listDocumentRows(database, project.id, includeArchived);
    const bindingByDocumentId = new Map(
      listBindingMetadata(database, project.id, includeArchived).map((binding) => [
        binding.document_id,
        binding,
      ]),
    );
    const chapters = novel
      ? [...novel.volumes.flatMap((volume) => volume.chapters), ...novel.unassignedChapters]
      : [];
    const chapterDocumentIds = new Set(chapters.map((chapter) => chapter.documentId));
    const referenceDocumentIds = new Set(
      novel?.references.map((reference) => reference.documentId),
    );
    const sources: ProjectStructureSource[] = [];

    // Chapter and reference sources have more useful domain metadata than a
    // generic document source. Keep the generic catalog for documents that
    // are not already represented by either projection.
    for (const document of documents) {
      if (chapterDocumentIds.has(document.id) || referenceDocumentIds.has(document.id)) continue;
      sources.push(documentSource(document, bindingByDocumentId.get(document.id)));
    }
    for (const chapter of chapters) {
      sources.push({
        id: `novel-chapter:${chapter.id}`,
        type: 'novel-chapter',
        sourceId: chapter.id,
        title: chapter.title,
        role: 'chapter',
        kind: 'chapter',
        status: chapter.status,
        documentId: chapter.documentId,
        ...(chapter.volumeId ? { scopeId: chapter.volumeId } : {}),
        versionId: chapter.draftVersionId ?? chapter.canonicalVersionId,
        draftVersionId: chapter.draftVersionId,
        canonicalVersionId: chapter.canonicalVersionId,
        updatedAt: chapter.updatedAt,
      });
    }
    for (const reference of novel?.references ?? []) {
      sources.push({
        id: `novel-reference:${reference.documentId}`,
        type: 'novel-reference',
        sourceId: reference.documentId,
        title: reference.title,
        role: reference.role,
        kind: reference.domainScope,
        status: reference.status,
        documentId: reference.documentId,
        versionId: reference.draftVersionId ?? reference.canonicalVersionId,
        draftVersionId: reference.draftVersionId,
        canonicalVersionId: reference.canonicalVersionId,
        scopeId: reference.volumeId,
        updatedAt: reference.updatedAt,
      });
    }

    // Stable ordering makes the derived revision reproducible across reads.
    sources.sort((left, right) => left.id.localeCompare(right.id));
    const sceneCount = scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM scenes WHERE project_id = ?',
      project.id,
    );
    const shotCount = scalarCount(
      database,
      `SELECT COUNT(*) AS count
       FROM shots
       INNER JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.project_id = ?`,
      project.id,
    );
    const assetCount = scalarCount(
      database,
      'SELECT COUNT(*) AS count FROM assets WHERE project_id = ?',
      project.id,
    );

    const domains: ProjectStructureSnapshot['domains'] = {
      documents: { enabled: documents.length > 0, count: documents.length },
      shortDrama: {
        enabled: sceneCount > 0 || shotCount > 0,
        sceneCount,
        shotCount,
      },
      assets: { enabled: assetCount > 0, count: assetCount },
    };
    if (novel) {
      domains.novel = {
        enabled: true,
        novelId: novel.novelId,
        volumeCount: novel.volumes.length,
        chapterCount: chapters.length,
      };
    }
    const snapshotWithoutRevision = {
      version: 1 as const,
      project: {
        id: project.id,
        name: project.name,
        mode: project.mode,
        schemaVersion: project.schemaVersion,
        updatedAt: project.updatedAt,
      },
      domains,
      sources,
      ...(novel ? { novel } : {}),
    };
    return {
      ...snapshotWithoutRevision,
      revision: deriveRevision(snapshotWithoutRevision),
    };
  }

  compileNovel(
    database: Database.Database,
    project: OpenProject,
    params?: NovelStructureGetParams,
  ): NovelStructureSnapshot | null;
  compileNovel(
    project: OpenProject,
    database: Database.Database,
    params?: NovelStructureGetParams,
  ): NovelStructureSnapshot | null;
  compileNovel(
    first: Database.Database | OpenProject,
    second: Database.Database | OpenProject,
    params: NovelStructureGetParams = {},
  ): NovelStructureSnapshot | null {
    const database = isDatabase(first) ? first : (second as Database.Database);
    const project = (isDatabase(first) ? second : first) as OpenProject;
    return this.novelCompiler.compileFromDatabase(database, project, params);
  }
}

export function renderProjectStructure(snapshot: ProjectStructureSnapshot): string {
  const lines = [
    `当前项目：${snapshot.project.name}`,
    `项目模式：${snapshot.project.mode ?? 'unknown'}`,
    `资料文档：${snapshot.domains.documents.count}`,
  ];
  const novel = snapshot.novel;
  if (novel) {
    const chapterCount =
      novel.volumes.reduce((total, volume) => total + volume.chapters.length, 0) +
      novel.unassignedChapters.length;
    lines.push(`小说：${novel.profile.title}（${novel.volumes.length} 卷，${chapterCount} 章）`);
    for (const volume of novel.volumes) {
      lines.push(`  ${volume.title}：${volume.chapters.length} 章`);
    }
    if (novel.unassignedChapters.length > 0) {
      lines.push(`  未分卷：${novel.unassignedChapters.length} 章`);
    }
    if (novel.references.length > 0) {
      lines.push(`小说参考资料：${novel.references.length} 份`);
    }
  } else {
    lines.push('小说：未建立');
  }
  if (snapshot.domains.shortDrama) {
    lines.push(
      `短剧：${snapshot.domains.shortDrama.sceneCount} 场，${snapshot.domains.shortDrama.shotCount} 镜头`,
    );
  }
  if (snapshot.domains.assets) lines.push(`素材：${snapshot.domains.assets.count} 个`);
  return lines.join('\n');
}

interface DocumentRow {
  id: string;
  kind: string;
  title: string;
  scope_type: string;
  scope_id: string | null;
  current_version_id: string | null;
  published_version_id: string | null;
  lifecycle_status: string;
  row_version: number;
  updated_at: string;
}

interface ChapterRow {
  id: string;
  volume_id: string | null;
  document_id: string;
  position: number;
  display_label: string;
  lifecycle_status: string;
  archive_reason: string | null;
  updated_at: string;
  title: string | null;
  current_version_id: string | null;
  published_version_id: string | null;
  document_row_version: number | null;
  document_lifecycle_status: string | null;
  document_updated_at: string | null;
}

interface VolumeRow {
  id: string;
  title: string;
  position: number;
  status: string;
}

interface ReferenceRow {
  id: string;
  document_id: string;
  volume_id: string | null;
  role: string;
  domain_scope: string;
  status: string;
  title: string;
  current_version_id: string | null;
  published_version_id: string | null;
  updated_at: string;
}

function compileNovelFromDatabase(
  database: Database.Database,
  project: OpenProject,
  params: NovelStructureGetParams,
): NovelStructureSnapshot | null {
  if (!hasTable(database, 'novel_profiles')) return null;
  if (params.novelId && params.novelId !== project.id) return null;
  const profile = database
    .prepare(
      `SELECT project_id, language, status
       FROM novel_profiles WHERE project_id = ?`,
    )
    .get(project.id) as { project_id: string; language: string; status: string } | undefined;
  if (!profile || (profile.status === 'archived' && params.includeArchived !== true)) return null;

  const includeArchived = params.includeArchived === true;
  const volumeRows = listVolumeRows(database, project.id, includeArchived);
  const chapterRows = listChapterRows(database, project.id, includeArchived);
  const documentById = new Map(
    listDocumentRows(database, project.id, true).map((document) => [document.id, document]),
  );
  const volumes: NovelStructureVolume[] = volumeRows.map((volume) => ({
    id: volume.id,
    title: volume.title,
    position: volume.position,
    status: volume.status,
    chapters: [],
  }));
  const volumeById = new Map(volumes.map((volume) => [volume.id, volume]));
  const unassignedChapters: NovelStructureChapter[] = [];
  for (const row of chapterRows) {
    const document = documentById.get(row.document_id);
    const chapter = mapChapter(row, document);
    const volume = row.volume_id ? volumeById.get(row.volume_id) : undefined;
    if (volume) volume.chapters.push(chapter);
    else unassignedChapters.push(chapter);
  }
  for (const volume of volumes) volume.chapters.sort(compareChapter);
  unassignedChapters.sort(compareChapter);

  const references = listReferenceRows(database, project.id, includeArchived).map(mapReference);
  const snapshotWithoutRevision = {
    version: 1 as const,
    novelId: project.id,
    profile: {
      id: project.id,
      title: project.name,
      language: profile.language,
      status: profile.status,
    },
    volumes,
    unassignedChapters,
    references,
  };
  return {
    ...snapshotWithoutRevision,
    revision: deriveRevision(snapshotWithoutRevision),
  };
}

function mapChapter(row: ChapterRow, document?: DocumentRow): NovelStructureChapter {
  const currentVersionId = row.current_version_id ?? document?.current_version_id ?? null;
  const publishedVersionId = row.published_version_id ?? document?.published_version_id ?? null;
  const status = chapterVersionStatus(currentVersionId, publishedVersionId);
  return {
    id: row.id,
    ...(row.volume_id ? { volumeId: row.volume_id } : {}),
    displayLabel: row.display_label,
    title: row.title ?? document?.title ?? row.display_label,
    position: row.position,
    documentId: row.document_id,
    ...(status === 'draft' && currentVersionId ? { draftVersionId: currentVersionId } : {}),
    ...(publishedVersionId ? { canonicalVersionId: publishedVersionId } : {}),
    status,
    lifecycleStatus: row.lifecycle_status,
    ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
    ...((row.document_row_version ?? document?.row_version)
      ? { documentRowVersion: row.document_row_version ?? document?.row_version }
      : {}),
    updatedAt: row.updated_at ?? document?.updated_at,
  };
}

function mapReference(row: ReferenceRow): NovelStructureReference {
  const status = chapterVersionStatus(row.current_version_id, row.published_version_id);
  return {
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    role: row.role,
    domainScope: row.domain_scope,
    status: row.status,
    ...(row.volume_id ? { volumeId: row.volume_id } : {}),
    ...(status === 'draft' && row.current_version_id
      ? { draftVersionId: row.current_version_id }
      : {}),
    ...(row.published_version_id ? { canonicalVersionId: row.published_version_id } : {}),
    updatedAt: row.updated_at,
  };
}

interface BindingMetadataRow {
  document_id: string;
  volume_id: string | null;
  role: string;
  domain_scope: string;
  status: string;
}

function documentSource(
  document: DocumentRow,
  binding?: BindingMetadataRow,
): ProjectStructureSource {
  const status = chapterVersionStatus(document.current_version_id, document.published_version_id);
  const type =
    binding?.domain_scope === 'novel' && binding.status === 'active'
      ? 'novel-reference'
      : 'document';
  return {
    id: `${type}:${document.id}`,
    type,
    sourceId: document.id,
    title: document.title,
    kind: document.kind,
    status: document.lifecycle_status === 'archived' ? 'archived' : status,
    documentId: document.id,
    versionId: document.current_version_id ?? document.published_version_id ?? undefined,
    ...(status === 'draft' && document.current_version_id
      ? { draftVersionId: document.current_version_id }
      : {}),
    ...(document.published_version_id ? { canonicalVersionId: document.published_version_id } : {}),
    scopeType: document.scope_type as ProjectStructureSource['scopeType'],
    ...(document.scope_id ? { scopeId: document.scope_id } : {}),
    ...(binding?.role ? { role: binding.role } : {}),
    ...(binding?.volume_id ? { scopeId: binding.volume_id } : {}),
    updatedAt: document.updated_at,
  };
}

function listBindingMetadata(
  database: Database.Database,
  projectId: string,
  includeArchived: boolean,
): BindingMetadataRow[] {
  if (!hasTable(database, 'document_bindings')) return [];
  return database
    .prepare(
      `SELECT document_id, volume_id, role, domain_scope, status
       FROM document_bindings
       WHERE project_id = ? ${includeArchived ? '' : "AND status != 'archived'"}`,
    )
    .all(projectId) as BindingMetadataRow[];
}

function chapterVersionStatus(
  currentVersionId: string | null | undefined,
  publishedVersionId: string | null | undefined,
): 'empty' | 'draft' | 'canonical' {
  if (!currentVersionId) return 'empty';
  if (currentVersionId === publishedVersionId) return 'canonical';
  return 'draft';
}

function listDocumentRows(
  database: Database.Database,
  projectId: string,
  includeArchived: boolean,
): DocumentRow[] {
  if (!hasTable(database, 'documents')) return [];
  return database
    .prepare(
      `SELECT id, kind, title, scope_type, scope_id, current_version_id,
              published_version_id, lifecycle_status, row_version, updated_at
       FROM documents
       WHERE project_id = ? ${includeArchived ? '' : "AND lifecycle_status != 'archived'"}
       ORDER BY updated_at, id`,
    )
    .all(projectId) as DocumentRow[];
}

function listVolumeRows(
  database: Database.Database,
  projectId: string,
  includeArchived: boolean,
): VolumeRow[] {
  if (!hasTable(database, 'novel_volumes')) return [];
  return database
    .prepare(
      `SELECT id, title, position, status
       FROM novel_volumes
       WHERE project_id = ? ${includeArchived ? '' : "AND status != 'archived'"}
       ORDER BY position, id`,
    )
    .all(projectId) as VolumeRow[];
}

function listChapterRows(
  database: Database.Database,
  projectId: string,
  includeArchived: boolean,
): ChapterRow[] {
  if (!hasTable(database, 'novel_chapters')) return [];
  return database
    .prepare(
      `SELECT chapters.id, chapters.volume_id, chapters.document_id, chapters.position,
              chapters.display_label, chapters.lifecycle_status, chapters.archive_reason,
              chapters.updated_at, documents.title,
              documents.current_version_id, documents.published_version_id,
              documents.row_version AS document_row_version,
              documents.lifecycle_status AS document_lifecycle_status,
              documents.updated_at AS document_updated_at
       FROM novel_chapters AS chapters
       LEFT JOIN documents ON documents.id = chapters.document_id
       WHERE chapters.project_id = ?
         ${includeArchived ? '' : "AND chapters.lifecycle_status != 'archived'"}
         ${includeArchived ? '' : "AND (documents.lifecycle_status IS NULL OR documents.lifecycle_status != 'archived')"}
       ORDER BY CASE WHEN chapters.volume_id IS NULL THEN 1 ELSE 0 END,
                chapters.volume_id, chapters.position, chapters.id`,
    )
    .all(projectId) as ChapterRow[];
}

function listReferenceRows(
  database: Database.Database,
  projectId: string,
  includeArchived: boolean,
): ReferenceRow[] {
  if (!hasTable(database, 'document_bindings') || !hasTable(database, 'documents')) return [];
  return database
    .prepare(
      `SELECT bindings.id, bindings.document_id, bindings.volume_id, bindings.role,
              bindings.domain_scope, bindings.status, documents.title,
              documents.current_version_id, documents.published_version_id,
              documents.updated_at
       FROM document_bindings AS bindings
       INNER JOIN documents ON documents.id = bindings.document_id
       WHERE bindings.project_id = ?
         AND bindings.domain_scope IN ('novel', 'shared')
         AND bindings.chapter_id IS NULL
         AND bindings.scene_id IS NULL
         AND bindings.shot_id IS NULL
         ${includeArchived ? '' : "AND bindings.status != 'archived'"}
         ${includeArchived ? '' : "AND documents.lifecycle_status != 'archived'"}
       ORDER BY bindings.created_at, bindings.id`,
    )
    .all(projectId) as ReferenceRow[];
}

function compareChapter(left: NovelStructureChapter, right: NovelStructureChapter): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function scalarCount(database: Database.Database, sql: string, projectId: string): number {
  try {
    const row = database.prepare(sql).get(projectId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

function hasTable(database: Database.Database, name: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function isDatabase(value: Database.Database | OpenProject): value is Database.Database {
  return typeof (value as Database.Database).prepare === 'function';
}

function deriveRevision(value: unknown): number {
  const digest = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  // 13 hex digits fit safely in a JavaScript integer; the modulus keeps the
  // public revision compact while retaining deterministic change detection.
  return Number.parseInt(digest.slice(0, 13), 16) % 2_147_483_647 || 1;
}
