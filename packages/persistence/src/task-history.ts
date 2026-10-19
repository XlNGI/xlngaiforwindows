import type Database from 'better-sqlite3';

export interface TaskHistoryBoundary {
  cutoff: number;
  excludedGenerationIds: string[];
}

export function captureTaskHistory(database: Database.Database): TaskHistoryBoundary {
  return {
    cutoff: (
      database
        .prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM conversation_message_sequences')
        .get() as { n: number }
    ).n,
    excludedGenerationIds: (
      database
        .prepare("SELECT id FROM llm_generations WHERE status IN ('prepared','streaming')")
        .all() as { id: string }[]
    ).map((row) => row.id),
  };
}

export function taskHistoryMessageIds(
  database: Database.Database,
  conversationId: string,
  boundary = captureTaskHistory(database),
): string[] {
  return (
    database
      .prepare(
        `SELECT messages.id FROM chat_messages messages
    JOIN conversation_message_sequences seq ON seq.message_id=messages.id
    WHERE messages.conversation_id=? AND messages.status='complete' AND seq.sequence<=?
      AND NOT EXISTS(SELECT 1 FROM llm_generations other
        WHERE other.id IN (SELECT value FROM json_each(?))
          AND (other.user_message_id=messages.id OR other.assistant_message_id=messages.id))
      AND NOT EXISTS(SELECT 1 FROM generation_supplements extra WHERE extra.message_id=messages.id
        AND extra.generation_id IN(SELECT value FROM json_each(?)))
    ORDER BY seq.sequence DESC LIMIT 12`,
      )
      .all(
        conversationId,
        boundary.cutoff,
        JSON.stringify(boundary.excludedGenerationIds),
        JSON.stringify(boundary.excludedGenerationIds),
      ) as { id: string }[]
  )
    .reverse()
    .map((row) => row.id);
}

/** Apply inside the source query, before ranking/limits. Identifiers are internal fixed aliases. */
export function taskLibraryVisibility(alias = 'chunks'): string {
  return `NOT EXISTS(SELECT 1 FROM generation_branches boundary WHERE boundary.generation_id=? AND (
    (${alias}.source_type='conversation' AND NOT (
      ${alias}.source_id=boundary.input_message_id OR
      EXISTS(SELECT 1 FROM generation_supplements extra WHERE extra.generation_id=boundary.generation_id AND extra.message_id=${alias}.source_id) OR
      EXISTS(SELECT 1 FROM llm_generations parent WHERE parent.id=boundary.dependency_generation_id AND boundary.dependency_snapshot_json IS NOT NULL
        AND ${alias}.source_id IN (parent.user_message_id,parent.assistant_message_id)) OR
      EXISTS(SELECT 1 FROM conversation_message_sequences seq WHERE seq.message_id=${alias}.source_id AND seq.sequence<=boundary.history_cutoff
        AND NOT EXISTS(SELECT 1 FROM llm_generations other WHERE other.id IN (SELECT value FROM json_each(boundary.excluded_generation_ids_json))
          AND ${alias}.source_id IN (other.user_message_id,other.assistant_message_id))
        AND NOT EXISTS(SELECT 1 FROM generation_supplements extra WHERE extra.message_id=${alias}.source_id
          AND extra.generation_id IN(SELECT value FROM json_each(boundary.excluded_generation_ids_json))))
    )) OR
    (${alias}.version_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM document_versions version JOIN agent_tasks source_task ON source_task.id=version.source_task_id
      JOIN agent_task_generations owner ON owner.task_id=source_task.id OR owner.task_id=json_extract(source_task.request_snapshot_json,'$.parentTaskId')
      JOIN llm_generations other ON other.id=owner.generation_id
      JOIN conversation_message_sequences seq ON seq.message_id=other.user_message_id
      WHERE version.id=${alias}.version_id AND other.id<>boundary.generation_id
        AND (seq.sequence>boundary.history_cutoff OR other.id IN(SELECT value FROM json_each(boundary.excluded_generation_ids_json)))
    ))
  ))`;
}
