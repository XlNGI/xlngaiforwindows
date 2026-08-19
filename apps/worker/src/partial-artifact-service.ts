import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentPartialArtifactDiscardParams,
  AgentPartialArtifactInfo,
  AgentPartialArtifactListParams,
  AgentPartialArtifactRecoverParams,
  DocumentDetail,
  LlmGenerationIdentity,
} from '@ai-video/contracts';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';

const TERMINAL_CONTENT = '[removed]';

type PartialRow = {
  id: string;
  project_id: string;
  task_id: string;
  target_kind: AgentPartialArtifactInfo['targetKind'];
  chapter_id: string | null;
  document_id: string | null;
  content_text: string;
  content_hash: string;
  content_length: number;
  status: AgentPartialArtifactInfo['status'];
  row_version: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function info(row: PartialRow): AgentPartialArtifactInfo {
  return {
    id: row.id,
    taskId: row.task_id,
    targetKind: row.target_kind,
    chapterId: row.chapter_id ?? undefined,
    documentId: row.document_id ?? undefined,
    contentLength: row.content_length,
    status: row.status,
    rowVersion: row.row_version,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function appendTaskEvent(
  database: Database.Database,
  projectId: string,
  taskId: string,
  eventType: string,
  summary: string,
  level: 'info' | 'warning' | 'error' = 'info',
) {
  const now = new Date().toISOString();
  const sequence = (
    database
      .prepare(
        'SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM agent_task_events WHERE task_id = ?',
      )
      .get(taskId) as { value: number }
  ).value;
  database
    .prepare(
      `INSERT INTO agent_task_events (id, task_id, project_id, sequence, event_type, level, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), taskId, projectId, sequence, eventType, level, summary, now);
}

export class PartialArtifactService {
  constructor(
    private readonly projects: ProjectService,
    private readonly documents: DocumentWorkflowService,
  ) {}

  captureInterrupted(
    identity: LlmGenerationIdentity,
    contentText: string,
  ): AgentPartialArtifactInfo | undefined {
    const content = contentText.trim();
    if (!content) return undefined;
    const contentLength = Buffer.byteLength(content, 'utf8');
    if (contentLength > 1_048_576) return undefined;
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const target = database
          .prepare(
            `SELECT tasks.id AS task_id, targets.target_kind, targets.chapter_id, targets.document_id
         FROM agent_tasks tasks INNER JOIN agent_task_generations links ON links.task_id = tasks.id
         INNER JOIN agent_task_targets targets ON targets.task_id = tasks.id
         WHERE tasks.project_id = ? AND links.generation_id = ? AND tasks.status = 'running' LIMIT 1`,
          )
          .get(project.id, identity.generationId) as
          | {
              task_id: string;
              target_kind: 'novel-chapter' | 'novel-reference';
              chapter_id: string | null;
              document_id: string;
            }
          | undefined;
        if (!target) return undefined;
        const step = database
          .prepare(
            `SELECT id FROM llm_provider_steps WHERE project_id = ? AND generation_id = ? AND attempt_id = ?
         AND status IN ('prepared', 'in_flight') ORDER BY ordinal DESC LIMIT 1`,
          )
          .get(project.id, identity.generationId, identity.attemptId) as { id: string } | undefined;
        if (!step) return undefined;
        const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
        const existing = database
          .prepare(
            `SELECT * FROM agent_partial_artifacts
         WHERE project_id = ? AND task_id = ? AND generation_id = ? AND attempt_id = ?
           AND provider_step_id = ? AND content_hash = ? AND status = 'recoverable'
         ORDER BY source_ordinal DESC LIMIT 1`,
          )
          .get(
            project.id,
            target.task_id,
            identity.generationId,
            identity.attemptId,
            step.id,
            contentHash,
          ) as PartialRow | undefined;
        if (existing) return info(existing);
        const quota = database
          .prepare(
            `SELECT COALESCE(SUM(content_length), 0) AS bytes FROM agent_partial_artifacts
         WHERE project_id = ? AND status = 'recoverable'`,
          )
          .get(project.id) as { bytes: number };
        if (quota.bytes + contentLength > 33_554_432) return undefined;
        const toolCall = database
          .prepare(
            `SELECT id FROM agent_tool_calls
         WHERE project_id = ? AND task_id = ? AND generation_id = ? AND attempt_id = ?
           AND provider_step_id = ? AND status = 'executing'
         ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
          .get(project.id, target.task_id, identity.generationId, identity.attemptId, step.id) as
          { id: string } | undefined;
        const now = new Date().toISOString();
        const row: PartialRow = {
          id: randomUUID(),
          project_id: project.id,
          task_id: target.task_id,
          target_kind: target.target_kind === 'novel-chapter' ? 'chapter' : 'reference-update',
          chapter_id: target.chapter_id,
          document_id: target.document_id,
          content_text: content,
          content_hash: contentHash,
          content_length: contentLength,
          status: 'recoverable',
          row_version: 0,
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          created_at: now,
          updated_at: now,
        };
        database
          .prepare(
            `INSERT INTO agent_partial_artifacts
         (id, project_id, task_id, generation_id, attempt_id, provider_step_id, tool_call_id, source_ordinal,
          target_kind, chapter_id, document_id, content_text, content_hash, content_length, format,
          status, expires_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(source_ordinal), -1) + 1, ?, ?, ?, ?, ?, ?,
                'validated-text', 'recoverable', ?, ?, ?
         FROM agent_partial_artifacts WHERE provider_step_id = ?`,
          )
          .run(
            row.id,
            project.id,
            row.task_id,
            identity.generationId,
            identity.attemptId,
            step.id,
            toolCall?.id ?? null,
            row.target_kind,
            row.chapter_id,
            row.document_id,
            row.content_text,
            row.content_hash,
            row.content_length,
            row.expires_at,
            now,
            now,
            step.id,
          );
        appendTaskEvent(
          database,
          project.id,
          row.task_id,
          'agent.partial.captured',
          'A validated partial artifact was retained for recovery.',
          'warning',
        );
        return info(row);
      })(),
    );
  }

  captureInterruptedByGeneration(
    generationId: string,
    contentText: string,
  ): AgentPartialArtifactInfo | undefined {
    const identity = this.projects.access(
      false,
      (database) =>
        database
          .prepare(
            `SELECT generations.id AS generationId, attempts.id AS attemptId,
              generations.project_id AS projectId, generations.project_session_id AS projectSessionId,
              generations.conversation_id AS conversationId
       FROM llm_generations generations INNER JOIN llm_generation_attempts attempts
         ON attempts.generation_id = generations.id
       WHERE generations.id = ? ORDER BY attempts.ordinal DESC LIMIT 1`,
          )
          .get(generationId) as LlmGenerationIdentity | undefined,
    );
    return identity ? this.captureInterrupted(identity, contentText) : undefined;
  }

  recoverInterrupted(): number {
    const candidates = this.projects.access(
      false,
      (database, project) =>
        database
          .prepare(
            `SELECT generations.id AS generationId, attempts.id AS attemptId,
              generations.project_id AS projectId,
              generations.project_session_id AS projectSessionId,
              generations.conversation_id AS conversationId,
              messages.content AS content
             FROM llm_generations generations
             INNER JOIN llm_generation_attempts attempts
               ON attempts.generation_id = generations.id
              AND attempts.assistant_message_id = generations.assistant_message_id
             INNER JOIN chat_messages messages ON messages.id = generations.assistant_message_id
             INNER JOIN agent_task_generations links ON links.generation_id = generations.id
             INNER JOIN agent_tasks tasks ON tasks.id = links.task_id
             INNER JOIN agent_task_targets targets ON targets.task_id = tasks.id
             WHERE generations.project_id = ?
               AND generations.status IN ('prepared', 'streaming')
               AND attempts.status IN ('prepared', 'streaming')
               AND tasks.status = 'running'
               AND targets.target_kind IN ('novel-chapter', 'novel-reference')
               AND length(trim(messages.content)) > 0`,
          )
          .all(project.id) as Array<LlmGenerationIdentity & { content: string }>,
    );
    const existingIds = new Set(this.list({ includeTerminal: true }).map((item) => item.id));
    let recovered = 0;
    for (const candidate of candidates) {
      const captured = this.captureInterrupted(candidate, candidate.content);
      if (captured && !existingIds.has(captured.id)) {
        existingIds.add(captured.id);
        recovered += 1;
      }
    }
    return recovered;
  }

  list(params: AgentPartialArtifactListParams = {}): AgentPartialArtifactInfo[] {
    return this.projects.access(false, (database, project) =>
      (
        database
          .prepare(
            `SELECT * FROM agent_partial_artifacts WHERE project_id = ?
         ${params.includeTerminal ? '' : "AND status = 'recoverable' AND expires_at > ?"}
         ORDER BY created_at DESC, id DESC`,
          )
          .all(
            ...(params.includeTerminal ? [project.id] : [project.id, new Date().toISOString()]),
          ) as PartialRow[]
      ).map(info),
    );
  }

  expire(): number {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const now = new Date().toISOString();
        const changed = database
          .prepare(
            `UPDATE agent_partial_artifacts SET status = 'expired', content_text = ?, updated_at = ?, row_version = row_version + 1
         WHERE project_id = ? AND status = 'recoverable' AND expires_at <= ?`,
          )
          .run(TERMINAL_CONTENT, now, project.id, now).changes;
        if (changed > 0) {
          const tasks = database
            .prepare(
              `SELECT task_id, COUNT(*) AS count FROM agent_partial_artifacts
           WHERE project_id = ? AND status = 'expired' AND updated_at = ? GROUP BY task_id`,
            )
            .all(project.id, now) as Array<{ task_id: string; count: number }>;
          for (const task of tasks)
            appendTaskEvent(
              database,
              project.id,
              task.task_id,
              'agent.partial.expired',
              `${task.count} recoverable partial artifact(s) expired during maintenance.`,
              'warning',
            );
        }
        return changed;
      })(),
    );
  }

  discard(params: AgentPartialArtifactDiscardParams): AgentPartialArtifactInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const now = new Date().toISOString();
        const changed = database
          .prepare(
            `UPDATE agent_partial_artifacts SET status = 'discarded', content_text = ?, updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND project_id = ? AND status = 'recoverable' AND row_version = ? AND expires_at > ?`,
          )
          .run(
            TERMINAL_CONTENT,
            now,
            params.artifactId,
            project.id,
            params.expectedRowVersion,
            now,
          );
        if (changed.changes !== 1) throw new Error('AGENT_PARTIAL_ARTIFACT_UNAVAILABLE');
        const discarded = database
          .prepare('SELECT * FROM agent_partial_artifacts WHERE id = ?')
          .get(params.artifactId) as PartialRow;
        appendTaskEvent(
          database,
          project.id,
          discarded.task_id,
          'agent.partial.discarded',
          'A recoverable partial artifact was discarded by the user.',
        );
        return info(discarded);
      })(),
    );
  }

  recover(params: AgentPartialArtifactRecoverParams): DocumentDetail {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const now = new Date().toISOString();
        const row = database
          .prepare(
            `SELECT * FROM agent_partial_artifacts WHERE id = ? AND project_id = ?
         AND status = 'recoverable' AND row_version = ? AND expires_at > ?`,
          )
          .get(params.artifactId, project.id, params.expectedRowVersion, now) as
          PartialRow | undefined;
        if (!row || !row.document_id) throw new Error('AGENT_PARTIAL_ARTIFACT_UNAVAILABLE');
        database
          .prepare(
            `UPDATE documents SET lifecycle_status = 'active', updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND project_id = ? AND lifecycle_status = 'archived'`,
          )
          .run(now, row.document_id, project.id);
        if (row.chapter_id)
          database
            .prepare(
              `UPDATE novel_chapters SET lifecycle_status = 'active', archive_reason = NULL, updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND project_id = ? AND lifecycle_status = 'archived'`,
            )
            .run(now, row.chapter_id, project.id);
        const document = this.documents.writeRecoveredUserDraftInTransaction(database, project, {
          documentId: row.document_id,
          title: (
            database.prepare('SELECT title FROM documents WHERE id = ?').get(row.document_id) as {
              title: string;
            }
          ).title,
          contentMarkdown: row.content_text,
          expectedDocumentRowVersion: params.expectedDocumentRowVersion,
        });
        const version = document.currentVersion;
        if (!version) throw new Error('AGENT_PARTIAL_ARTIFACT_UNAVAILABLE');
        const recoveredUpdate = database
          .prepare(
            `UPDATE agent_partial_artifacts SET status = 'recovered', content_text = ?, recovered_document_id = ?,
         recovered_document_version_id = ?, recovered_by_type = 'user', recovered_by_id = 'local-user',
         recovered_at = ?, updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND status = 'recoverable' AND row_version = ? AND expires_at > ?`,
          )
          .run(
            TERMINAL_CONTENT,
            document.id,
            version.id,
            now,
            now,
            row.id,
            params.expectedRowVersion,
            now,
          );
        if (recoveredUpdate.changes !== 1) {
          throw new Error('AGENT_PARTIAL_ARTIFACT_UNAVAILABLE');
        }
        appendTaskEvent(
          database,
          project.id,
          row.task_id,
          'agent.partial.recovered',
          'A partial artifact was recovered into a user-owned draft.',
        );
        return document;
      })(),
    );
  }
}
