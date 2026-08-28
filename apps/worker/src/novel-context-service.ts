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
  published_version_id: string | null;
  version_id: string;
  version: number;
  content_markdown: string;
  updated_at: string;
};

type NovelRagChunkRow = {
  id: string;
  chapter_id: string;
  ordinal: number;
  content_text: string;
};

export interface NovelConsistencyIssue {
  code:
    | 'missing-rag-index'
    | 'stale-rag-index'
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
  indexedChunkCount: number;
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
    selectedChapterIds?: string[],
    mode: 'novel' | 'short-drama' = 'novel',
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

      const domainScope =
        mode === 'short-drama' ? "('shared', 'short-drama')" : "('shared', 'novel')";
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
             AND bindings.domain_scope IN ${domainScope}
             AND documents.lifecycle_status = 'active'
           ORDER BY CASE bindings.domain_scope WHEN 'novel' THEN 0 WHEN 'short-drama' THEN 1 ELSE 2 END,
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
          label: mode === 'short-drama' ? `短剧资料：${row.title}` : `小说资料：${row.title}`,
          content: row.content_markdown,
          version: row.version,
          versionId: row.version_id,
          updatedAt: row.updated_at,
          priority: row.domain_scope === 'novel' ? 0 : 8,
        });
      }

      if (mode === 'short-drama') {
        // Published character/scene prompt documents are the reference chain for
        // episode generation even when they have no document_bindings row (the
        // UI has no binding editor). This mirrors validateEpisodeReferences, so
        // the model sees the same names the Worker will accept.
        const boundIds = new Set(bindingRows.map((row) => row.document_id));
        const promptRows = database
          .prepare(
            `SELECT documents.id AS document_id, documents.kind AS kind,
                    documents.title AS title, documents.updated_at AS updated_at,
                    versions.version AS version, versions.id AS version_id,
                    versions.content_markdown AS content_markdown
             FROM documents
             INNER JOIN document_versions versions ON versions.id = documents.published_version_id
             WHERE documents.project_id = ? AND documents.lifecycle_status = 'active'
               AND documents.kind IN ('character', 'scene')
             ORDER BY documents.created_at, documents.id`,
          )
          .all(project.id) as Array<{
          document_id: string;
          kind: string;
          title: string;
          updated_at: string;
          version: number;
          version_id: string;
          content_markdown: string;
        }>;
        for (const row of promptRows) {
          if (boundIds.has(row.document_id)) continue;
          sources.push({
            id: `prompt:${row.document_id}`,
            type: 'document',
            scopeType: 'project',
            label:
              row.kind === 'character' ? `角色提示词：${row.title}` : `场景提示词：${row.title}`,
            content: row.content_markdown,
            version: row.version,
            versionId: row.version_id,
            updatedAt: row.updated_at,
            priority: 6,
          });
        }
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
           INNER JOIN document_versions versions ON versions.id = documents.current_version_id
           LEFT JOIN novel_volumes volumes ON volumes.id = chapters.volume_id
           WHERE chapters.project_id = ? AND chapters.lifecycle_status = 'active'
           ORDER BY chapters.position, chapters.id`,
        )
        .all(project.id) as NovelChapterContextRow[];
      const selectedChapters =
        mode === 'short-drama'
          ? selectShortDramaChapters(chapterRows, selectedChapterIds)
          : selectChapters(chapterRows, recentConversation, focusChapterId);
      let selectedNovelChunkCount = 0;
      for (const [index, row] of selectedChapters.entries()) {
        const chunkRows = database
          .prepare(
            `SELECT id, chapter_id, ordinal, content_text
             FROM novel_rag_chunks
             WHERE project_id = ? AND chapter_id = ? AND source_document_version_id = ?
             ORDER BY ordinal`,
          )
          .all(project.id, row.chapter_id, row.version_id) as NovelRagChunkRow[];
        const selectedChunks = selectRelevantChunks(chunkRows, recentConversation, mode);
        selectedNovelChunkCount += selectedChunks.length;
        for (const chunk of selectedChunks) {
          sources.push({
            id: `novel-rag-chunk:${row.chapter_id}:${chunk.id}`,
            type: 'document',
            scopeType: 'project',
            label:
              mode === 'short-drama'
                ? `本集章节：${row.display_label} ${row.chapter_title} · 切片 ${chunk.ordinal + 1}`
                : `小说草稿：${row.display_label} ${row.chapter_title} · 切片 ${chunk.ordinal + 1}`,
            content: chunk.content_text,
            version: row.version,
            versionId: row.version_id,
            updatedAt: row.updated_at,
            priority:
              mode === 'short-drama'
                ? index + chunk.ordinal / 10_000
                : novelChunkPriority(chunk, recentConversation, row.chapter_id === focusChapterId),
          });
        }
        if (row.published_version_id === row.version_id) {
          const summary = ensureSummary(database, project.id, row);
          sources.push({
            id: `chapter-summary:${row.chapter_id}`,
            type: 'document',
            scopeType: 'project',
            label: `已发布摘要：${row.display_label} ${row.chapter_title}`,
            content: summary,
            version: row.version,
            versionId: row.version_id,
            updatedAt: row.updated_at,
            priority: 40 + row.position / 10_000,
          });
        }
      }
      if (mode === 'short-drama' && selectedNovelChunkCount === 0) {
        throw new Error('所选章节没有可用切片，请先保存草稿后再生成。');
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
          mode === 'short-drama'
            ? '你是短剧分集创作助手。用户已保存的小说草稿切片是本次改编的权威源材料；只使用本次上下文中的所选小说切片、短剧资料（角色/场景提示词、本集整体把控、风格指南）、生产约束和相关会话。已发布摘要只是派生资料。人物名、称谓、时间线、地点必须与源材料和角色/场景提示词一致；引用已发布角色/场景时使用 [角色:名称] / [场景:名称] 占位符；发现冲突必须明确报告，不得静默改写。'
            : '你是长篇小说创作助手。用户已保存的小说草稿切片是可检索的权威创作源材料；只使用本次上下文中的小说草稿切片、小说资料、生产约束和相关会话。已发布摘要只是派生资料。保持人物、时间线和称谓连续，发现冲突时明确报告。',
      });
    });
  }

  compileShortDrama(
    conversationId: string,
    budgetTokens?: number,
    selectedChapterIds?: string[],
  ): ProductionContext {
    return this.compile(conversationId, budgetTokens, undefined, selectedChapterIds, 'short-drama');
  }

  consistencyReport(): NovelConsistencyReport {
    return this.projects.access(false, (database, project) => {
      const issues: NovelConsistencyIssue[] = [];
      const chapterRows = database
        .prepare(
          `SELECT chapters.id, chapters.position, chapters.display_label,
                  chapters.lifecycle_status, documents.current_version_id,
                  versions.content_markdown,
                  COUNT(chunks.id) AS chunk_count
           FROM novel_chapters chapters
           INNER JOIN documents ON documents.id = chapters.document_id
           LEFT JOIN document_versions versions ON versions.id = documents.current_version_id
           LEFT JOIN novel_rag_chunks chunks
             ON chunks.chapter_id = chapters.id
            AND chunks.source_document_version_id = documents.current_version_id
           WHERE chapters.project_id = ? AND chapters.lifecycle_status = 'active'
           GROUP BY chapters.id, chapters.position, chapters.display_label,
                    chapters.lifecycle_status, documents.current_version_id,
                    versions.content_markdown`,
        )
        .all(project.id) as Array<{
        id: string;
        position: number;
        display_label: string;
        lifecycle_status: string;
        current_version_id: string | null;
        content_markdown: string | null;
        chunk_count: number;
      }>;
      for (const row of chapterRows.filter(
        (chapter) =>
          !chapter.current_version_id ||
          (!!chapter.content_markdown?.trim() && chapter.chunk_count === 0),
      )) {
        issues.push({
          code: 'missing-rag-index',
          severity: 'warning',
          chapterId: row.id,
          message: `Active chapter ${row.display_label} has no current RAG index.`,
        });
      }
      const indexedChunkCount = chapterRows.reduce((total, row) => total + row.chunk_count, 0);
      const staleChunkRows = database
        .prepare(
          `SELECT DISTINCT chunks.chapter_id
           FROM novel_rag_chunks chunks
           INNER JOIN novel_chapters chapters ON chapters.id = chunks.chapter_id
           INNER JOIN documents ON documents.id = chapters.document_id
           WHERE chunks.project_id = ? AND chapters.lifecycle_status = 'active'
             AND chunks.source_document_version_id != documents.current_version_id`,
        )
        .all(project.id) as Array<{ chapter_id: string }>;
      for (const row of staleChunkRows) {
        issues.push({
          code: 'stale-rag-index',
          severity: 'warning',
          chapterId: row.chapter_id,
          message: 'A RAG chunk set does not match the current saved draft.',
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
        indexedChunkCount,
        currentSummaryCount,
        staleSummaryCount,
        issues,
      };
    });
  }
}

/**
 * Short-drama episode scope: only the user-selected, saved chapter drafts enter
 * the context (in selection order). Unrelated chapters are never included.
 */
function selectShortDramaChapters(
  rows: NovelChapterContextRow[],
  selectedChapterIds?: string[],
): NovelChapterContextRow[] {
  if (!selectedChapterIds || selectedChapterIds.length === 0) {
    throw new Error('Short-drama generation requires selected chapters.');
  }
  const byId = new Map(rows.map((row) => [row.chapter_id, row]));
  const selected = selectedChapterIds
    .map((chapterId) => byId.get(chapterId))
    .filter((row): row is NovelChapterContextRow => row !== undefined);
  if (selected.length === 0) {
    throw new Error('所选章节尚未保存，请先保存草稿并完成切片后再生成。');
  }
  return selected;
}

function selectRelevantChunks(
  rows: NovelRagChunkRow[],
  query: string,
  mode: 'novel' | 'short-drama',
): NovelRagChunkRow[] {
  const limit = mode === 'short-drama' ? 24 : 10;
  if (rows.length <= limit) return rows;
  const anchored =
    mode === 'short-drama' ? [...rows.slice(0, 3), ...rows.slice(-2)] : [rows[0]!, rows.at(-1)!];
  const selected = new Map(anchored.map((row) => [row.id, row]));
  const ranked = rows
    .filter((row) => !selected.has(row.id))
    .map((row) => ({ row, score: novelChunkScore(row.content_text, query) }))
    .sort((left, right) => right.score - left.score || left.row.ordinal - right.row.ordinal);
  for (const candidate of ranked) {
    if (selected.size >= limit) break;
    selected.set(candidate.row.id, candidate.row);
  }
  return [...selected.values()].sort((left, right) => left.ordinal - right.ordinal);
}

function novelChunkPriority(chunk: NovelRagChunkRow, query: string, focused: boolean): number {
  const relevance = Math.min(novelChunkScore(chunk.content_text, query), 9);
  return (focused ? 0 : 10) - relevance + chunk.ordinal / 10_000;
}

function novelChunkScore(content: string, query: string): number {
  if (!query.trim()) return 0;
  const haystack = content.toLocaleLowerCase('zh-CN');
  return ragQueryTerms(query).reduce(
    (score, term) => score + (haystack.includes(term) ? Math.min(term.length, 6) : 0),
    0,
  );
}

function ragQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  const segments = query.toLocaleLowerCase('zh-CN').match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/u.test(segment)) {
      for (let index = 0; index < segment.length - 1 && terms.size < 64; index += 1) {
        terms.add(segment.slice(index, index + 2));
      }
    } else if (segment.length >= 2) {
      terms.add(segment);
    }
    if (terms.size >= 64) break;
  }
  return [...terms];
}

function selectChapters(
  rows: NovelChapterContextRow[],
  recentConversation: string,
  focusChapterId?: string,
  selectedChapterIds?: string[],
): NovelChapterContextRow[] {
  const explicit = rows.filter((row) => selectedChapterIds?.includes(row.chapter_id) ?? false);
  if (rows.length <= 12) return rows;
  const focal = rows.find((row) => row.chapter_id === focusChapterId) ?? rows[rows.length - 1]!;
  const opening = rows.slice(0, 4);
  const prior = rows.filter((row) => row.position < focal.position).slice(-4);
  const fixed = new Set([...opening, ...prior, focal, ...explicit].map((row) => row.chapter_id));
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
