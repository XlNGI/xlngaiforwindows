import { createHash } from 'node:crypto';
import {
  compileProductionContext,
  extractiveSummary,
  sourceSummaryKey,
  type ContextScope,
  type ContextSourceInput,
  type ProductionContext,
} from '@ai-video/context';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

const SUMMARY_GENERATOR = 'deterministic-extractive-v1';
const SUMMARY_VERSION = 1;
const DEFAULT_NOVEL_BUDGET = 24_000;
const MAX_NOVEL_BUDGET = 80_000;

type NovelChapterContextRow = {
  chapter_id: string;
  position: number;
  display_label: string;
  volume_title: string | null;
  chapter_title: string;
  version_id: string;
  version: number;
  content_markdown: string;
  updated_at: string;
};

export interface NovelConsistencyIssue {
  code:
    | 'missing-published-version'
    | 'duplicate-position'
    | 'duplicate-display-label'
    | 'stale-summary';
  severity: 'warning' | 'error';
  chapterId?: string;
  message: string;
}

export interface NovelConsistencyReport {
  projectId: string;
  generatedAt: string;
  chapterCount: number;
  currentSummaryCount: number;
  staleSummaryCount: number;
  issues: NovelConsistencyIssue[];
}

export function calculateNovelContextBudget(
  sourceCharacters: number,
  selectedChapterCount: number,
  requestedBudget?: number,
): number {
  if (requestedBudget !== undefined) return requestedBudget;
  const sourceAllowance = Math.ceil(Math.max(sourceCharacters, 0) / 4_000) * 1_000;
  const chapterAllowance = Math.max(selectedChapterCount, 0) * 500;
  return Math.min(
    MAX_NOVEL_BUDGET,
    Math.max(DEFAULT_NOVEL_BUDGET, DEFAULT_NOVEL_BUDGET + sourceAllowance + chapterAllowance),
  );
}

export class NovelContextService {
  constructor(private readonly projects: ProjectService) {}

  compile(
    conversationId: string,
    budgetTokens?: number,
    focusChapterId?: string,
  ): ProductionContext {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      const scope = resolveScope(
        repositories,
        project.id,
        conversation.scopeType,
        conversation.scopeId,
      );
      const sources: ContextSourceInput[] = [];

      for (const constraint of repositories.constraints.listByProject(project.id)) {
        sources.push({
          id: constraint.id,
          type: 'constraint',
          scopeType: constraint.scopeType as ContextSourceInput['scopeType'],
          scopeId: constraint.scopeId,
          label: `生产约束：${constraint.kind}`,
          content: constraint.content,
          updatedAt: constraint.updatedAt,
          priority: -100,
        });
      }

      const bindingRows = database
        .prepare(
          `SELECT bindings.document_id, bindings.role, bindings.domain_scope,
                  documents.title, documents.updated_at,
                  documents.published_version_id, versions.version,
                  versions.id AS version_id, versions.content_markdown
           FROM document_bindings bindings
           INNER JOIN documents ON documents.id = bindings.document_id
           INNER JOIN document_versions versions ON versions.id = documents.published_version_id
           WHERE bindings.project_id = ? AND bindings.status = 'active'
             AND bindings.domain_scope IN ('shared', 'novel')
             AND documents.lifecycle_status = 'active'
           ORDER BY CASE bindings.domain_scope WHEN 'novel' THEN 0 ELSE 1 END,
                    bindings.role, bindings.document_id`,
        )
        .all(project.id) as Array<{
        document_id: string;
        role: string;
        domain_scope: string;
        title: string;
        updated_at: string;
        version: number;
        version_id: string;
        content_markdown: string;
      }>;
      for (const row of bindingRows) {
        sources.push({
          id: row.document_id,
          type: 'document',
          scopeType: 'project',
          label: `小说资料：${row.title}`,
          content: row.content_markdown,
          version: row.version,
          versionId: row.version_id,
          updatedAt: row.updated_at,
          priority: row.domain_scope === 'novel' ? 0 : 8,
        });
      }

      const messages = repositories.chatMessages.listPage(conversation.id, 12).reverse();
      const recentConversation = messages.map((message) => message.content).join('\n');
      const chapterRows = database
        .prepare(
          `SELECT chapters.id AS chapter_id, chapters.position, chapters.display_label,
                  volumes.title AS volume_title, documents.title AS chapter_title,
                  documents.published_version_id, versions.id AS version_id,
                  versions.version, versions.content_markdown, documents.updated_at
           FROM novel_chapters chapters
           INNER JOIN documents ON documents.id = chapters.document_id
           INNER JOIN document_versions versions ON versions.id = documents.published_version_id
           LEFT JOIN novel_volumes volumes ON volumes.id = chapters.volume_id
           WHERE chapters.project_id = ? AND chapters.lifecycle_status = 'active'
           ORDER BY chapters.position, chapters.id`,
        )
        .all(project.id) as NovelChapterContextRow[];
      const selectedChapters = selectChapters(chapterRows, recentConversation, focusChapterId);
      for (const row of selectedChapters) {
        const summary = ensureSummary(database, project.id, row);
        sources.push({
          id: `chapter-summary:${row.chapter_id}`,
          type: 'document',
          scopeType: 'project',
          label: `章节摘要：${row.display_label} ${row.chapter_title}`,
          content: summary,
          version: row.version,
          versionId: row.version_id,
          updatedAt: row.updated_at,
          priority:
            row.position === selectedChapters[selectedChapters.length - 1]?.position
              ? 10
              : 20 + row.position / 10_000,
        });
      }

      for (const memory of repositories.memories.listByProject(project.id)) {
        sources.push({
          id: memory.id,
          type: 'memory',
          scopeType: memory.scopeType as ContextSourceInput['scopeType'],
          scopeId: memory.scopeId,
          label: '项目记忆',
          content: memory.content,
          updatedAt: memory.updatedAt,
          priority: 50,
        });
      }

      if (messages.length) {
        sources.push({
          id: conversation.id,
          type: 'conversation',
          scopeType: conversation.scopeType,
          scopeId: conversation.scopeId,
          label: '最近相关会话',
          content: messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
          updatedAt: conversation.updatedAt,
          priority: 60,
        });
      }

      const sourceCharacters = sources.reduce((total, source) => total + source.content.length, 0);
      const summaries: Record<string, string> = {};
      for (const source of sources) {
        if (source.type === 'constraint' || source.content.length <= 8_000) continue;
        summaries[sourceSummaryKey(source)] = extractiveSummary(source.content);
      }
      return compileProductionContext({
        projectId: project.id,
        projectName: project.name,
        scope,
        sources,
        budgetTokens: calculateNovelContextBudget(
          sourceCharacters,
          selectedChapters.length,
          budgetTokens,
        ),
        summaries,
        systemInstruction:
          '你是长篇小说创作助手。只使用本次上下文中的小说资料、已发布章节摘要、生产约束和相关会话。章节摘要是派生资料，不是权威正文；不得把草稿或未发布内容当作事实。保持人物、时间线和称谓连续，发现冲突时明确报告。',
      });
    });
  }

  consistencyReport(): NovelConsistencyReport {
    return this.projects.access(false, (database, project) => {
      const issues: NovelConsistencyIssue[] = [];
      const chapterRows = database
        .prepare(
          `SELECT chapters.id, chapters.position, chapters.display_label,
                  chapters.lifecycle_status, documents.published_version_id
           FROM novel_chapters chapters
           INNER JOIN documents ON documents.id = chapters.document_id
           WHERE chapters.project_id = ? AND chapters.lifecycle_status = 'active'`,
        )
        .all(project.id) as Array<{
        id: string;
        position: number;
        display_label: string;
        lifecycle_status: string;
        published_version_id: string | null;
      }>;
      for (const row of chapterRows.filter((chapter) => !chapter.published_version_id)) {
        issues.push({
          code: 'missing-published-version',
          severity: 'warning',
          chapterId: row.id,
          message: `Active chapter ${row.display_label} has no published version.`,
        });
      }
      for (const row of duplicateRows(database, project.id, 'position')) {
        issues.push({
          code: 'duplicate-position',
          severity: 'error',
          message: `Active chapters share position ${row.value} (${row.count} rows).`,
        });
      }
      for (const row of duplicateRows(database, project.id, 'display_label')) {
        issues.push({
          code: 'duplicate-display-label',
          severity: 'error',
          message: `Active chapters share display label ${row.value} (${row.count} rows).`,
        });
      }
      const summaryCounts = database
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM novel_chapter_summaries WHERE project_id = ? GROUP BY status`,
        )
        .all(project.id) as Array<{ status: 'current' | 'stale'; count: number }>;
      const currentSummaryCount = summaryCounts.find((row) => row.status === 'current')?.count ?? 0;
      const staleSummaryCount = summaryCounts.find((row) => row.status === 'stale')?.count ?? 0;
      const currentSummaryRows = database
        .prepare(
          `SELECT summaries.chapter_id, summaries.source_document_version_id,
                  documents.published_version_id
           FROM novel_chapter_summaries summaries
           INNER JOIN novel_chapters chapters ON chapters.id = summaries.chapter_id
           INNER JOIN documents ON documents.id = chapters.document_id
           WHERE summaries.project_id = ? AND summaries.status = 'current'`,
        )
        .all(project.id) as Array<{
        chapter_id: string;
        source_document_version_id: string;
        published_version_id: string | null;
      }>;
      for (const row of currentSummaryRows) {
        if (row.source_document_version_id !== row.published_version_id) {
          issues.push({
            code: 'stale-summary',
            severity: 'warning',
            chapterId: row.chapter_id,
            message: 'A current summary does not match the chapter published version.',
          });
        }
      }
      return {
        projectId: project.id,
        generatedAt: new Date().toISOString(),
        chapterCount: chapterRows.length,
        currentSummaryCount,
        staleSummaryCount,
        issues,
      };
    });
  }
}

function selectChapters(
  rows: NovelChapterContextRow[],
  recentConversation: string,
  focusChapterId?: string,
): NovelChapterContextRow[] {
  if (rows.length <= 12) return rows;
  const focal = rows.find((row) => row.chapter_id === focusChapterId) ?? rows[rows.length - 1]!;
  const opening = rows.slice(0, 4);
  const prior = rows.filter((row) => row.position < focal.position).slice(-4);
  const fixed = new Set([...opening, ...prior, focal].map((row) => row.chapter_id));
  const related = rows
    .filter((row) => !fixed.has(row.chapter_id))
    .filter(
      (row) =>
        recentConversation.includes(row.chapter_title) ||
        recentConversation.includes(row.display_label),
    )
    .slice(0, 4);
  const selected = new Map<string, (typeof rows)[number]>();
  for (const row of [...opening, ...prior, ...related, focal]) selected.set(row.chapter_id, row);
  return rows.filter((row) => selected.has(row.chapter_id));
}

function duplicateRows(
  database: import('better-sqlite3').Database,
  projectId: string,
  column: 'position' | 'display_label',
): Array<{ value: string | number; count: number }> {
  return database
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count
       FROM novel_chapters
       WHERE project_id = ? AND lifecycle_status = 'active'
       GROUP BY ${column} HAVING COUNT(*) > 1`,
    )
    .all(projectId) as Array<{ value: string | number; count: number }>;
}

function ensureSummary(
  database: import('better-sqlite3').Database,
  projectId: string,
  row: {
    chapter_id: string;
    version_id: string;
    version: number;
    content_markdown: string;
  },
): string {
  const contentHash = createHash('sha256').update(row.content_markdown, 'utf8').digest('hex');
  const existing = database
    .prepare(
      `SELECT summary_text FROM novel_chapter_summaries
       WHERE chapter_id = ? AND source_document_version_id = ? AND source_content_hash = ?
         AND summary_version = ? AND status = 'current'`,
    )
    .get(row.chapter_id, row.version_id, contentHash, SUMMARY_VERSION) as
    { summary_text: string } | undefined;
  if (existing) return existing.summary_text;
  const summary = extractiveSummary(row.content_markdown, 2_400);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR REPLACE INTO novel_chapter_summaries
       (chapter_id, project_id, source_document_version_id, source_content_hash,
        summary_version, summary_text, generator, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
    )
    .run(
      row.chapter_id,
      projectId,
      row.version_id,
      contentHash,
      SUMMARY_VERSION,
      summary,
      SUMMARY_GENERATOR,
      now,
      now,
    );
  return summary;
}

function resolveScope(
  repositories: ReturnType<typeof createRepositories>,
  projectId: string,
  scopeType: string,
  scopeId?: string,
): ContextScope {
  if (scopeType === 'project') return { type: 'project', label: '小说项目' };
  if (scopeType === 'scene' && scopeId) {
    const scene = repositories.scenes.get(scopeId);
    if (!scene || scene.projectId !== projectId) throw new Error('Scene was not found.');
    return { type: 'scene', id: scene.id, label: scene.title };
  }
  if (scopeType === 'shot' && scopeId) {
    const shot = repositories.shots.get(scopeId);
    const scene = shot ? repositories.scenes.get(shot.sceneId) : undefined;
    if (!shot || !scene || scene.projectId !== projectId) throw new Error('Shot was not found.');
    return {
      type: 'shot',
      id: shot.id,
      sceneId: scene.id,
      label: `${scene.title} / ${shot.title}`,
    };
  }
  throw new Error('Conversation scope is invalid.');
}
