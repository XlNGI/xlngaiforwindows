import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentPendingIntentInfo,
  NovelPendingIntentCancelParams,
  NovelPendingIntentListParams,
  NovelWritingAction,
  NovelWritingIntent,
} from '@ai-video/contracts';
import { ProjectService } from './project-service.js';

const PENDING_INTENT_TTL_MS = 24 * 60 * 60_000;

export interface NovelTaskPreparation {
  taskId: string;
  chapterId: string;
  documentId: string;
  documentIntent: {
    operation: 'novel.chapter.submit_draft';
    documentId: string;
  };
}

export class AgentOrchestrationError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_PARAMETERS' | 'INVALID_STATE' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

type PendingRow = {
  id: string;
  project_id: string;
  conversation_id: string;
  requested_action: NovelWritingAction | null;
  reason_code: AgentPendingIntentInfo['reasonCode'];
  status: AgentPendingIntentInfo['status'];
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredText(value: string | undefined, label: string, maximum: number): string {
  const normalized = value?.normalize('NFC').trim();
  if (!normalized) throw new AgentOrchestrationError('INVALID_PARAMETERS', `${label} is required.`);
  if (normalized.length > maximum) {
    throw new AgentOrchestrationError(
      'INVALID_PARAMETERS',
      `${label} must be at most ${maximum} characters.`,
    );
  }
  return normalized;
}

function pendingInfo(row: PendingRow): AgentPendingIntentInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    requestedAction: row.requested_action ?? undefined,
    reasonCode: row.reason_code,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inferAction(prompt: string): NovelWritingAction | undefined {
  if (/(续写|继续写|继续创作)/u.test(prompt)) return 'continue_chapter';
  if (/(重写|改写|改编)/u.test(prompt)) return 'rewrite_chapter';
  if (/(保存|存入|写入|提交)/u.test(prompt)) return 'rewrite_chapter';
  if (/(新建章节|创建章节|写第|写一章|创作章节)/u.test(prompt)) return 'create_chapter';
  return undefined;
}

function chapterNumber(value: string): number | undefined {
  const match = value.match(/第\s*([0-9]+|[零〇一二三四五六七八九十百千万两]+)\s*章/u);
  if (!match) return undefined;
  if (/^[0-9]+$/u.test(match[1]!)) return Number(match[1]);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    两: 2,
  };
  let total = 0;
  let current = 0;
  for (const character of match[1]!) {
    if (character === '十' || character === '百' || character === '千' || character === '万') {
      const unit = { 十: 10, 百: 100, 千: 1_000, 万: 10_000 }[character];
      if (unit === 10_000) {
        total = (total + current || 1) * unit;
        current = 0;
      } else {
        total += (current || 1) * unit;
        current = 0;
      }
    } else {
      current = digits[character] ?? 0;
    }
  }
  const result = total + current;
  return result > 0 ? result : undefined;
}

function chapterDisplayLabel(value: string): string | undefined {
  const match = value.match(/第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章/u);
  return match?.[0].replace(/\s+/gu, '');
}

function containsNegatedAction(prompt: string): boolean {
  return /(不要|不需要|取消|别)(?:再)?(?:创建|新建|续写|继续写|重写|改写|创作)/u.test(prompt);
}

export class AgentOrchestrationService {
  constructor(private readonly projects: ProjectService) {}

  prepareNovelTask(input: {
    conversationId: string;
    projectSessionId: string;
    prompt: string;
    title?: string;
    intent?: NovelWritingIntent;
    idempotencyKey?: string;
  }): NovelTaskPreparation | { pendingIntent: AgentPendingIntentInfo } {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const prompt = requiredText(input.prompt, 'Prompt', 100_000);
        const conversation = database
          .prepare('SELECT id, archived_at FROM conversations WHERE id = ? AND project_id = ?')
          .get(input.conversationId, project.id) as
          { id: string; archived_at: string | null } | undefined;
        if (!conversation)
          throw new AgentOrchestrationError('NOT_FOUND', 'Conversation was not found.');
        if (conversation.archived_at)
          throw new AgentOrchestrationError(
            'CONFLICT',
            'Archived conversations cannot be updated.',
          );

        const requestHash = sha256(
          JSON.stringify({
            prompt,
            intent: input.intent ?? null,
            title: input.title?.normalize('NFC').trim() ?? null,
          }),
        );
        if (input.idempotencyKey) {
          const existing = database
            .prepare(
              'SELECT id, request_hash FROM agent_tasks WHERE project_id = ? AND idempotency_key = ?',
            )
            .get(project.id, input.idempotencyKey) as
            { id: string; request_hash: string } | undefined;
          if (existing) {
            if (existing.request_hash !== requestHash) {
              throw new AgentOrchestrationError(
                'CONFLICT',
                'IDEMPOTENCY_KEY_REUSED: request content changed.',
              );
            }
            const target = database
              .prepare(
                `SELECT chapter_id, document_id FROM agent_task_targets
                 WHERE task_id = ? AND target_kind = 'novel-chapter'`,
              )
              .get(existing.id) as { chapter_id: string; document_id: string } | undefined;
            if (!target)
              throw new AgentOrchestrationError('CONFLICT', 'Existing task has no novel target.');
            return this.prepared(existing.id, target.chapter_id, target.document_id);
          }
        }

        let action = input.intent?.action ?? inferAction(prompt);
        const resolution =
          action && action !== 'create_chapter'
            ? this.resolveExistingChapterIntent(database, project.id, prompt, input.intent)
            : { intent: input.intent, ambiguous: false, empty: false };
        let intent = resolution.intent;
        if (action && action !== 'create_chapter' && resolution.empty && !resolution.ambiguous) {
          const displayLabel = chapterDisplayLabel(prompt);
          if (displayLabel) {
            action = 'create_chapter';
            intent = {
              ...(intent ?? {}),
              action,
              chapterTitle: intent?.chapterTitle ?? displayLabel,
              displayLabel: intent?.displayLabel ?? displayLabel,
            };
          }
        }
        const pending = this.pendingReason(prompt, action, intent, resolution.ambiguous);
        if (pending) {
          return {
            pendingIntent: this.createPending(
              database,
              project.id,
              input.conversationId,
              requestHash,
              action,
              intent,
              pending,
            ),
          };
        }

        const now = new Date().toISOString();
        const target =
          action === 'create_chapter'
            ? this.createChapterTarget(database, project.id, intent!, now)
            : this.existingChapterTarget(database, project.id, intent!.chapterId!);
        const taskId = randomUUID();
        database
          .prepare(
            `INSERT INTO agent_tasks
             (id, project_id, project_session_id, conversation_id, task_type, scope_type, title,
              request_snapshot_json, request_hash, status, idempotency_key, created_at, updated_at,
              phase, row_version, tool_call_limit)
             VALUES (?, ?, ?, ?, 'document-update', 'project', ?, ?, ?, 'queued', ?, ?, ?,
                     'intent_resolving', 0, 16)`,
          )
          .run(
            taskId,
            project.id,
            input.projectSessionId,
            input.conversationId,
            input.title ? requiredText(input.title, 'Task title', 200) : target.title,
            JSON.stringify({
              version: 1,
              // Chapter targeting is a resolver hint, not a separate Agent
              // persona. Every project task runs through the System Agent.
              agentMode: 'document',
              action,
              promptHash: sha256(prompt),
              chapterId: target.chapterId,
              documentId: target.documentId,
            }),
            requestHash,
            input.idempotencyKey ?? null,
            now,
            now,
          );
        database
          .prepare(
            `INSERT INTO agent_task_targets
             (task_id, project_id, target_kind, chapter_id, document_id, action, created_placeholder, created_at)
             VALUES (?, ?, 'novel-chapter', ?, ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            project.id,
            target.chapterId,
            target.documentId,
            action,
            target.createdPlaceholder ? 1 : 0,
            now,
          );
        try {
          database
            .prepare(
              `INSERT INTO novel_chapter_task_locks (chapter_id, project_id, task_id, acquired_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(target.chapterId, project.id, taskId, now);
        } catch (error) {
          if (String(error).includes('UNIQUE constraint failed')) {
            throw new AgentOrchestrationError(
              'CONFLICT',
              'This chapter already has an active writing task.',
            );
          }
          throw error;
        }
        this.appendEvent(
          database,
          project.id,
          taskId,
          'agent.novel.task.created',
          'Novel writing task created with a locked chapter target.',
          now,
        );
        return this.prepared(taskId, target.chapterId, target.documentId);
      })(),
    );
  }

  markTaskGenerationStarted(taskId: string): void {
    this.projects.access(true, (database, project) => {
      const now = new Date().toISOString();
      const result = database
        .prepare(
          `UPDATE agent_tasks SET status = 'running', phase = 'model_running', started_at = ?, updated_at = ?,
           row_version = row_version + 1 WHERE id = ? AND project_id = ? AND status = 'queued'`,
        )
        .run(now, now, taskId, project.id);
      if (result.changes !== 1)
        throw new AgentOrchestrationError('INVALID_STATE', 'Novel task is no longer queued.');
      this.appendEvent(
        database,
        project.id,
        taskId,
        'agent.novel.task.started',
        'Novel writing task started.',
        now,
      );
    });
  }

  failTaskBeforeGeneration(taskId: string, message: string): void {
    this.projects.access(true, (database, project) => {
      database.transaction(() => {
        const now = new Date().toISOString();
        const failed = database
          .prepare(
            `UPDATE agent_tasks SET status = 'failed', error_code = 'GENERATION_PREPARE_FAILED', error_message = ?,
             completed_at = ?, updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND project_id = ? AND status IN ('queued', 'running')`,
          )
          .run(message.slice(0, 500), now, now, taskId, project.id);
        if (failed.changes !== 1) return;
        const placeholder = database
          .prepare(
            `SELECT targets.chapter_id, targets.document_id FROM agent_task_targets targets
             WHERE targets.task_id = ? AND targets.project_id = ? AND targets.created_placeholder = 1
               AND NOT EXISTS (
                 SELECT 1 FROM document_versions versions WHERE versions.document_id = targets.document_id
               )`,
          )
          .get(taskId, project.id) as { chapter_id: string; document_id: string } | undefined;
        if (!placeholder) return;
        database
          .prepare(
            `UPDATE novel_chapters SET lifecycle_status = 'archived', archive_reason = 'generation_placeholder',
             updated_at = ?, row_version = row_version + 1 WHERE id = ? AND project_id = ?`,
          )
          .run(now, placeholder.chapter_id, project.id);
        database
          .prepare(
            `UPDATE documents SET lifecycle_status = 'archived', updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND project_id = ?`,
          )
          .run(now, placeholder.document_id, project.id);
      })();
    });
  }

  listPending(params: NovelPendingIntentListParams = {}): AgentPendingIntentInfo[] {
    return this.projects.access(false, (database, project) => {
      const now = new Date().toISOString();
      const rows = database
        .prepare(
          `SELECT * FROM agent_pending_intents WHERE project_id = ?
           ${params.includeResolved ? '' : "AND status = 'pending' AND expires_at > ?"}
           ORDER BY created_at DESC, id DESC`,
        )
        .all(...(params.includeResolved ? [project.id] : [project.id, now])) as PendingRow[];
      return rows.map(pendingInfo);
    });
  }

  cancelPending(params: NovelPendingIntentCancelParams): AgentPendingIntentInfo {
    return this.projects.access(true, (database, project) => {
      const now = new Date().toISOString();
      const result = database
        .prepare(
          `UPDATE agent_pending_intents SET status = 'cancelled', cancelled_at = ?, updated_at = ?
           WHERE id = ? AND project_id = ? AND status = 'pending'`,
        )
        .run(now, now, params.intentId, project.id);
      if (result.changes !== 1)
        throw new AgentOrchestrationError('NOT_FOUND', 'Pending novel intent was not found.');
      return pendingInfo(
        database
          .prepare('SELECT * FROM agent_pending_intents WHERE id = ?')
          .get(params.intentId) as PendingRow,
      );
    });
  }

  private pendingReason(
    prompt: string,
    action: NovelWritingAction | undefined,
    intent: NovelWritingIntent | undefined,
    ambiguousTarget = false,
  ): AgentPendingIntentInfo['reasonCode'] | undefined {
    if (containsNegatedAction(prompt)) return 'NEGATED_ACTION';
    if (!action) return 'AMBIGUOUS_ACTION';
    if (action === 'create_chapter' && !intent?.chapterTitle?.trim()) return 'TARGET_REQUIRED';
    if (ambiguousTarget) return 'TARGET_NOT_UNIQUE';
    if (action !== 'create_chapter' && !intent?.chapterId) return 'TARGET_REQUIRED';
    return undefined;
  }

  private resolveExistingChapterIntent(
    database: Database.Database,
    projectId: string,
    prompt: string,
    intent?: NovelWritingIntent,
  ): { intent?: NovelWritingIntent; ambiguous: boolean; empty: boolean } {
    if (intent?.chapterId) return { intent, ambiguous: false, empty: false };
    const rows = database
      .prepare(
        `SELECT chapters.id, chapters.display_label, chapters.position, documents.title
         FROM novel_chapters chapters INNER JOIN documents ON documents.id = chapters.document_id
         WHERE chapters.project_id = ? AND chapters.lifecycle_status IN ('reserved', 'active')
         ORDER BY chapters.position, chapters.id`,
      )
      .all(projectId) as Array<{
      id: string;
      display_label: string;
      position: number;
      title: string;
    }>;
    if (rows.length === 0) return { intent, ambiguous: false, empty: true };
    const normalizedPrompt = prompt.normalize('NFC').trim();
    const normalizedLabel = intent?.displayLabel?.normalize('NFC').trim();
    const normalizedTitle = intent?.chapterTitle?.normalize('NFC').trim();
    let candidates = rows;
    if (normalizedLabel || normalizedTitle) {
      const exact = rows.filter(
        (row) =>
          (normalizedLabel && row.display_label === normalizedLabel) ||
          (normalizedTitle && row.title === normalizedTitle),
      );
      if (exact.length > 0) candidates = exact;
    }
    const number = chapterNumber(
      [normalizedLabel, normalizedTitle, normalizedPrompt].filter(Boolean).join(' '),
    );
    if (number !== undefined) {
      const numbered = candidates.filter(
        (row) => row.position === number - 1 || chapterNumber(row.display_label) === number,
      );
      if (numbered.length > 0) candidates = numbered;
    }
    if (candidates.length !== 1) {
      return { intent, ambiguous: candidates.length > 1, empty: false };
    }
    return {
      intent: { ...(intent ?? {}), chapterId: candidates[0]!.id },
      ambiguous: false,
      empty: false,
    };
  }

  private createPending(
    database: Database.Database,
    projectId: string,
    conversationId: string,
    requestHash: string,
    action: NovelWritingAction | undefined,
    intent: NovelWritingIntent | undefined,
    reasonCode: AgentPendingIntentInfo['reasonCode'],
  ): AgentPendingIntentInfo {
    const now = new Date().toISOString();
    const row: PendingRow = {
      id: randomUUID(),
      project_id: projectId,
      conversation_id: conversationId,
      requested_action: action ?? null,
      reason_code: reasonCode,
      status: 'pending',
      expires_at: new Date(Date.now() + PENDING_INTENT_TTL_MS).toISOString(),
      created_at: now,
      updated_at: now,
    };
    database
      .prepare(
        `INSERT INTO agent_pending_intents
         (id, project_id, conversation_id, request_hash, requested_action, request_snapshot_json,
          reason_code, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.conversation_id,
        requestHash,
        row.requested_action,
        JSON.stringify({ version: 1, intent: intent ?? null }),
        row.reason_code,
        row.status,
        row.expires_at,
        row.created_at,
        row.updated_at,
      );
    return pendingInfo(row);
  }

  private createChapterTarget(
    database: Database.Database,
    projectId: string,
    intent: NovelWritingIntent,
    now: string,
  ): { chapterId: string; documentId: string; title: string; createdPlaceholder: true } {
    const title = requiredText(intent.chapterTitle, 'Chapter title', 200);
    if (intent.volumeId) {
      const volume = database
        .prepare('SELECT id FROM novel_volumes WHERE id = ? AND project_id = ? AND status = ?')
        .get(intent.volumeId, projectId, 'active');
      if (!volume) throw new AgentOrchestrationError('NOT_FOUND', 'Novel volume was not found.');
    }
    const position = database
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS value FROM novel_chapters
         WHERE project_id = ? AND volume_id IS ?`,
      )
      .get(projectId, intent.volumeId ?? null) as { value: number };
    const documentId = randomUUID();
    const chapterId = randomUUID();
    database
      .prepare(
        `INSERT INTO documents (id, project_id, kind, title, scope_type, lifecycle_status, row_version, created_at, updated_at)
         VALUES (?, ?, 'note', ?, 'project', 'active', 0, ?, ?)`,
      )
      .run(documentId, projectId, title, now, now);
    database
      .prepare(
        `INSERT INTO novel_chapters
         (id, project_id, volume_id, document_id, position, display_label, lifecycle_status, row_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', 0, ?, ?)`,
      )
      .run(
        chapterId,
        projectId,
        intent.volumeId ?? null,
        documentId,
        position.value,
        intent.displayLabel
          ? requiredText(intent.displayLabel, 'Chapter display label', 80)
          : `第 ${position.value + 1} 章`,
        now,
        now,
      );
    return { chapterId, documentId, title, createdPlaceholder: true };
  }

  private existingChapterTarget(
    database: Database.Database,
    projectId: string,
    chapterId: string,
  ): { chapterId: string; documentId: string; title: string; createdPlaceholder: false } {
    const row = database
      .prepare(
        `SELECT chapters.id AS chapter_id, chapters.document_id, documents.title
         FROM novel_chapters chapters INNER JOIN documents ON documents.id = chapters.document_id
         WHERE chapters.id = ? AND chapters.project_id = ?
           AND chapters.lifecycle_status IN ('reserved', 'active')`,
      )
      .get(chapterId, projectId) as
      { chapter_id: string; document_id: string; title: string } | undefined;
    if (!row)
      throw new AgentOrchestrationError(
        'NOT_FOUND',
        'A writable novel chapter target is required.',
      );
    return {
      chapterId: row.chapter_id,
      documentId: row.document_id,
      title: row.title,
      createdPlaceholder: false,
    };
  }

  private prepared(taskId: string, chapterId: string, documentId: string): NovelTaskPreparation {
    return {
      taskId,
      chapterId,
      documentId,
      documentIntent: { operation: 'novel.chapter.submit_draft', documentId },
    };
  }

  private appendEvent(
    database: Database.Database,
    projectId: string,
    taskId: string,
    eventType: string,
    summary: string,
    createdAt: string,
  ): void {
    const next = database
      .prepare(
        'SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM agent_task_events WHERE task_id = ?',
      )
      .get(taskId) as { value: number };
    database
      .prepare(
        `INSERT INTO agent_task_events (id, task_id, project_id, sequence, event_type, level, summary, created_at)
         VALUES (?, ?, ?, ?, ?, 'info', ?, ?)`,
      )
      .run(randomUUID(), taskId, projectId, next.value, eventType, summary, createdAt);
  }
}
