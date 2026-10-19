import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentGenerationPrepareParams,
  LlmGenerationPrepareResult,
  NovelBatchInfo,
  NovelWritingIntent,
} from '@ai-video/contracts';
import { ProjectService } from './project-service.js';
import {
  AgentOrchestrationService,
  type NovelTaskPreparation,
} from './agent-orchestration-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { resolveWriteResource } from './project-resource-map.js';

interface ChapterRequest {
  key: string;
  title: string;
  prompt: string;
  action: NonNullable<NovelWritingIntent['action']>;
  chapterId?: string;
  volumeId?: string;
  displayLabel?: string;
  expectedChapterRowVersion?: number;
  expectedDocumentRowVersion?: number;
  baseVersionId?: string | null;
  dependsOn: Array<{ key: string; milestone: 'draft' | 'published' }>;
}
interface BatchRuntime {
  available(): boolean;
  prepare(
    params: AgentGenerationPrepareParams,
    target: NovelTaskPreparation,
  ): LlmGenerationPrepareResult & { agentTaskId: string };
  start(prepared: LlmGenerationPrepareResult & { agentTaskId: string }): Promise<void>;
  cancel(generationId: string): Promise<void>;
  discardUncommitted(): void;
}

/** A trusted model manifest creates one locked Agent owner per chapter, then starts outside the transaction. */
export class NovelBatchService {
  constructor(
    private readonly projects: ProjectService,
    private readonly runtime: BatchRuntime,
  ) {}

  submit(
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    if (!this.runtime.available())
      throw new Error('Chapter batches require the Worker-owned Pi runtime.');
    keys(args, ['resourceId', 'expectedRevision', 'executionKey', 'chapters', 'references']);
    const executionKey = text(args.executionKey, 'executionKey', 128);
    const chapters = parseChapters(args.chapters);
    const sources = parseSources(args.references);
    const hash = createHash('sha256').update(JSON.stringify({ chapters, sources })).digest('hex');
    const prepared: Array<LlmGenerationPrepareResult & { agentTaskId: string }> = [];
    let batchId: string;
    try {
      batchId = this.projects.access(true, (database, project) =>
        database.transaction(() => {
          const parent = database
            .prepare(
              `SELECT task.id, task.conversation_id AS conversationId,
          attempt.provider_profile_id AS providerProfileId, attempt.model_id AS modelId
          FROM agent_tasks task JOIN agent_tool_calls call ON call.task_id=task.id
          JOIN llm_generation_attempts attempt ON attempt.id=call.attempt_id
          WHERE task.id=? AND task.project_id=? AND task.project_session_id=? AND task.status='running'
            AND call.id=? AND call.tool_name='novel.chapter.batch.submit' AND call.status='executing'`,
            )
            .get(identity.taskId, project.id, identity.projectSessionId, identity.toolCallId) as
            | { id: string; conversationId: string; providerProfileId: string; modelId: string }
            | undefined;
          if (!parent?.providerProfileId || !parent.modelId)
            throw new Error(
              'Batch submission requires an executing, model-bound parent tool call.',
            );
          const existing = database
            .prepare(
              'SELECT id,request_hash AS hash FROM novel_task_batches WHERE project_id=? AND parent_task_id=? AND execution_key=?',
            )
            .get(project.id, parent.id, executionKey) as { id: string; hash: string } | undefined;
          if (existing) {
            if (existing.hash !== hash) throw new Error('Batch execution key has different input.');
            return existing.id;
          }
          const resource = resolveWriteResource(database, project, args)!;
          if (resource.kind !== 'workspace' || resource.locator.workspace !== 'novel')
            throw new Error('Chapter batches require the 小说 workspace resourceId.');
          const count = database
            .prepare(
              "SELECT COUNT(*) AS n FROM llm_generations WHERE status IN ('prepared','streaming')",
            )
            .get() as { n: number };
          if (count.n + chapters.length > 32)
            throw new Error('Project text task queue is full (32).');
          const id = randomUUID(),
            now = new Date().toISOString();
          // Validate all immutable source versions before allocating placeholders or targets.
          for (const source of sources) {
            const version = database
              .prepare(
                `SELECT versions.id, documents.current_version_id AS currentId,documents.published_version_id AS publishedId
            FROM document_versions versions JOIN documents ON documents.id=versions.document_id
            WHERE versions.id=? AND documents.id=? AND documents.project_id=? AND documents.lifecycle_status='active'`,
              )
              .get(source.versionId, source.documentId, project.id) as
              { id: string; currentId: string | null; publishedId: string | null } | undefined;
            if (
              !version ||
              (source.milestone === 'published'
                ? version.publishedId !== version.id
                : version.currentId !== version.id)
            )
              throw new Error(
                'Batch reference must match the selected current draft or published version.',
              );
          }
          database
            .prepare(
              'INSERT INTO novel_task_batches(id,project_id,parent_task_id,execution_key,request_hash,created_at) VALUES(?,?,?,?,?,?)',
            )
            .run(id, project.id, parent.id, executionKey, hash, now);
          for (const [ordinal, chapter] of chapters.entries()) {
            if (chapter.action !== 'create_chapter') {
              const target = database
                .prepare(
                  `SELECT chapters.row_version AS chapterVersion, documents.row_version AS documentVersion,documents.current_version_id AS versionId
              FROM novel_chapters chapters JOIN documents ON documents.id=chapters.document_id WHERE chapters.id=? AND chapters.project_id=? AND chapters.lifecycle_status='active'`,
                )
                .get(chapter.chapterId, project.id) as
                | { chapterVersion: number; documentVersion: number; versionId: string | null }
                | undefined;
              if (
                !target ||
                target.chapterVersion !== chapter.expectedChapterRowVersion ||
                target.documentVersion !== chapter.expectedDocumentRowVersion ||
                target.versionId !== chapter.baseVersionId
              )
                throw new Error('Chapter batch target baseline is stale.');
            }
            const target = new AgentOrchestrationService(this.projects).prepareNovelTask({
              conversationId: parent.conversationId,
              projectSessionId: identity.projectSessionId,
              structured: true,
              title: chapter.title,
              prompt: chapter.prompt,
              idempotencyKey: `batch:${id}:${chapter.key}`,
              intent: {
                action: chapter.action,
                chapterId: chapter.chapterId,
                chapterTitle: chapter.title,
                displayLabel: chapter.displayLabel,
                volumeId: chapter.volumeId,
              },
            });
            if ('pendingIntent' in target)
              throw new Error('Typed chapter tasks cannot create pending intent.');
            database
              .prepare(
                `UPDATE agent_tasks SET request_snapshot_json=json_set(request_snapshot_json,'$.parentTaskId',?,'$.batchId',?,'$.childKey',?) WHERE id=?`,
              )
              .run(parent.id, id, chapter.key, target.taskId);
            const prompt = `${chapter.prompt}\n\n[可信批次目标]\nbatchId=${id}; childKey=${chapter.key}; chapterId=${target.chapterId}; documentId=${target.documentId}.\n只为这个目标生成一个完整章节草稿；使用已有授权的 novel.chapter.submit_draft。不要创建或替换其他章节。\n明确来源版本及前置章节结果请按需调用 novel.chapter.batch.source.read；批次创建不等于已生成或发布。`;
            const child = this.runtime.prepare(
              {
                conversationId: parent.conversationId,
                prompt,
                providerProfileId: parent.providerProfileId,
                modelId: parent.modelId,
                agentMode: 'novel-writing',
                taskExecution: 'parallel',
                idempotencyKey: `batch:${id}:${chapter.key}`,
                documentIntent: target.documentIntent,
              },
              target,
            );
            prepared.push(child);
            const baseline = database
              .prepare(
                'SELECT current_version_id AS versionId,row_version AS rowVersion FROM documents WHERE id=?',
              )
              .get(target.documentId) as { versionId: string | null; rowVersion: number };
            database
              .prepare(
                `INSERT INTO novel_batch_children(batch_id,child_key,ordinal,task_id,generation_id,chapter_id,document_id,base_version_id,expected_document_row_version)
            VALUES(?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                id,
                chapter.key,
                ordinal,
                target.taskId,
                child.stream.generationId,
                target.chapterId,
                target.documentId,
                baseline.versionId,
                baseline.rowVersion,
              );
            for (const dependency of chapter.dependsOn)
              database
                .prepare(
                  'INSERT INTO novel_batch_dependencies(batch_id,child_key,upstream_key,milestone) VALUES(?,?,?,?)',
                )
                .run(id, chapter.key, dependency.key, dependency.milestone);
            for (const source of sources)
              database
                .prepare(
                  'INSERT INTO novel_batch_sources(batch_id,task_id,document_id,version_id,milestone) VALUES(?,?,?,?,?)',
                )
                .run(id, target.taskId, source.documentId, source.versionId, source.milestone);
          }
          return id;
        })(),
      );
    } catch (error) {
      this.runtime.discardUncommitted();
      throw error;
    }
    // AgentSystemToolService's outer short write transaction commits before this microtask.
    queueMicrotask(() => {
      if (this.projects.currentSessionId() !== identity.projectSessionId) return;
      const committed = this.projects.access(false, (database) =>
        Boolean(database.prepare('SELECT 1 FROM novel_task_batches WHERE id=?').get(batchId)),
      );
      if (!committed) {
        this.runtime.discardUncommitted();
        return;
      }
      for (const child of prepared) void this.runtime.start(child).catch(() => undefined);
    });
    return { status: 'submitted', ...this.get(batchId) };
  }

  get(batchId: string): NovelBatchInfo {
    return this.projects.access(false, (database, project) => {
      const batch = database
        .prepare(
          'SELECT id,parent_task_id AS parentTaskId FROM novel_task_batches WHERE id=? AND project_id=?',
        )
        .get(batchId, project.id) as { id: string; parentTaskId: string } | undefined;
      if (!batch) throw new Error('Chapter batch was not found in this project.');
      const rows = database
        .prepare(
          `SELECT child.child_key AS key,child.task_id AS taskId,child.generation_id AS generationId,child.chapter_id AS chapterId,child.document_id AS documentId,
        child.conflict_artifact_id AS conflictArtifactId, task.status,generation.status AS generationStatus,
        (SELECT document_version_id FROM agent_task_document_artifacts artifact WHERE artifact.task_id=child.task_id AND artifact.artifact_role='primary' LIMIT 1) AS documentVersionId
        FROM novel_batch_children child JOIN agent_tasks task ON task.id=child.task_id JOIN llm_generations generation ON generation.id=child.generation_id WHERE child.batch_id=? ORDER BY child.ordinal`,
        )
        .all(batchId) as Array<Omit<NovelBatchInfo['children'][number], 'dependsOn'>>;
      return {
        batchId,
        parentTaskId: batch.parentTaskId,
        children: rows.map((row) => ({
          ...row,
          status: row.conflictArtifactId ? 'conflict' : row.status,
          dependsOn: database
            .prepare(
              'SELECT upstream_key AS key,milestone,frozen_version_id AS versionId FROM novel_batch_dependencies WHERE batch_id=? AND child_key=? ORDER BY upstream_key',
            )
            .all(batchId, row.key) as NovelBatchInfo['children'][number]['dependsOn'],
        })),
      };
    });
  }

  async cancel(batchId: string): Promise<NovelBatchInfo> {
    const batch = this.get(batchId);
    await Promise.all(
      batch.children
        .filter((child) => ['prepared', 'streaming'].includes(child.generationStatus))
        .map((child) => this.runtime.cancel(child.generationId)),
    );
    return this.get(batchId);
  }

  readSource(
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    keys(args, ['versionId', 'offset', 'maxChars']);
    const offset = integer(args.offset ?? 0, 'offset'),
      maxChars = Math.min(integer(args.maxChars ?? 20000, 'maxChars'), 20000);
    return this.projects.access(false, (database, project) => {
      const rows = database
        .prepare(
          `SELECT source.document_id AS documentId,source.version_id AS versionId,source.milestone AS sourceStatus,version.content_markdown AS content
        FROM novel_batch_sources source JOIN novel_task_batches batch ON batch.id=source.batch_id JOIN document_versions version ON version.id=source.version_id
        WHERE source.task_id=? AND batch.project_id=? ORDER BY source.version_id`,
        )
        .all(identity.taskId, project.id) as Array<{
        documentId: string;
        versionId: string;
        sourceStatus: string;
        content: string;
      }>;
      if (args.versionId === undefined)
        return {
          status: 'listed',
          sources: rows.map(({ content, ...source }) => ({
            ...source,
            totalCharacters: content.length,
          })),
        };
      const source = rows.find((row) => row.versionId === text(args.versionId, 'versionId', 128));
      if (!source)
        throw new Error('This version is not an immutable source of the current chapter task.');
      let content = source.content.slice(offset, offset + maxChars);
      while (Buffer.byteLength(JSON.stringify(content), 'utf8') > 48000)
        content = content.slice(0, Math.floor(content.length * 0.8));
      const nextOffset = offset + content.length;
      return {
        ...source,
        status: 'read',
        content,
        startOffset: offset,
        endOffset: nextOffset,
        totalCharacters: source.content.length,
        truncated: nextOffset < source.content.length,
        ...(nextOffset < source.content.length ? { nextOffset } : {}),
        ...(source.sourceStatus === 'draft'
          ? { notice: '未审核候选资料，不能当作已发布权威' }
          : {}),
      };
    });
  }
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unknown chapter batch field.');
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid ${name}.`);
  return value.trim();
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${name}.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a chapter batch object.');
  return value as Record<string, unknown>;
}
function milestone(value: unknown): 'draft' | 'published' {
  if (value !== 'draft' && value !== 'published')
    throw new Error('Dependency/source must explicitly select draft or published.');
  return value;
}
function parseSources(
  value: unknown,
): Array<{ documentId: string; versionId: string; milestone: 'draft' | 'published' }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16)
    throw new Error('At most sixteen frozen sources are allowed.');
  const result = value.map((entry) => {
    const row = object(entry);
    keys(row, ['documentId', 'versionId', 'milestone']);
    return {
      documentId: text(row.documentId, 'documentId', 128),
      versionId: text(row.versionId, 'versionId', 128),
      milestone: milestone(row.milestone),
    };
  });
  if (new Set(result.map((row) => row.versionId)).size !== result.length)
    throw new Error('Duplicate batch source.');
  return result;
}
function parseChapters(value: unknown): ChapterRequest[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16)
    throw new Error('A chapter batch requires one to sixteen tasks.');
  const previous = new Set<string>(),
    targets = new Set<string>();
  return value.map((entry) => {
    const row = object(entry);
    keys(row, [
      'key',
      'title',
      'prompt',
      'action',
      'chapterId',
      'volumeId',
      'displayLabel',
      'expectedChapterRowVersion',
      'expectedDocumentRowVersion',
      'baseVersionId',
      'dependsOn',
    ]);
    const key = text(row.key, 'key', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || previous.has(key))
      throw new Error('Chapter keys must be distinct identifiers.');
    const action = text(row.action, 'action', 40) as ChapterRequest['action'];
    if (!['create_chapter', 'continue_chapter', 'rewrite_chapter'].includes(action))
      throw new Error('Invalid chapter action.');
    const dependsOn = (row.dependsOn ?? []) as unknown;
    if (!Array.isArray(dependsOn) || dependsOn.length > 16)
      throw new Error('Invalid chapter dependencies.');
    const dependencies = dependsOn.map((entry) => {
      const dependency = object(entry);
      keys(dependency, ['key', 'milestone']);
      const upstream = text(dependency.key, 'dependency key', 64);
      if (!previous.has(upstream))
        throw new Error('Dependencies must refer to an earlier chapter in this batch.');
      return { key: upstream, milestone: milestone(dependency.milestone) };
    });
    if (new Set(dependencies.map((entry) => entry.key)).size !== dependencies.length)
      throw new Error('Duplicate dependency.');
    previous.add(key);
    const base: ChapterRequest = {
      key,
      action,
      title: text(row.title, 'title', 200),
      prompt: text(row.prompt, 'prompt', 80000),
      dependsOn: dependencies,
    };
    if (action === 'create_chapter') {
      if (
        [
          'chapterId',
          'expectedChapterRowVersion',
          'expectedDocumentRowVersion',
          'baseVersionId',
        ].some((key) => row[key] !== undefined)
      )
        throw new Error('New chapter tasks cannot name an existing target or CAS.');
      if (row.volumeId !== undefined) base.volumeId = text(row.volumeId, 'volumeId', 128);
      if (row.displayLabel !== undefined)
        base.displayLabel = text(row.displayLabel, 'displayLabel', 80);
    } else {
      base.chapterId = text(row.chapterId, 'chapterId', 128);
      if (targets.has(base.chapterId))
        throw new Error('A chapter can have only one task in a batch.');
      targets.add(base.chapterId);
      base.expectedChapterRowVersion = integer(
        row.expectedChapterRowVersion,
        'expectedChapterRowVersion',
      );
      base.expectedDocumentRowVersion = integer(
        row.expectedDocumentRowVersion,
        'expectedDocumentRowVersion',
      );
      base.baseVersionId =
        row.baseVersionId === null ? null : text(row.baseVersionId, 'baseVersionId', 128);
      if (row.volumeId !== undefined || row.displayLabel !== undefined)
        throw new Error('Existing chapter tasks cannot move or relabel chapters.');
    }
    return base;
  });
}
