import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AgentTaskState = {
  taskId: string;
  taskGoal: string;
  userRequirements: Array<{
    id: string;
    text: string;
    source: string;
    /** Exact provenance, optional for legacy snapshots whose framing is unknown. */
    sourceKey?: string;
    sourceVersion?: string;
    originTaskId?: string;
    originRequirementId?: string;
  }>;
  projectConstraints: string[];
  confirmedDecisions: Array<{ text: string; source: string }>;
  currentStage: string;
  completedSteps: string[];
  pendingSteps: unknown[];
  executionStatus: 'running' | 'recovering' | 'completed' | 'partial' | 'failed' | 'cancelled';
  generatedArtifacts: Array<{ resultId: string; toolName: string; callId: string }>;
  checkpoint?: Record<string, unknown>;
  recoveryState?: Record<string, unknown>;
};

export type StoredToolResult = {
  id: string;
  callId: string;
  toolName: string;
  status: string;
  version: number;
  content: string;
  contentHash: string;
  arguments: unknown;
};

export type AgentEvidenceRef = {
  evidenceId: string;
  sourceKey: string;
  sourceVersion: string;
  rangeKey: string;
  sourceType: string;
  purpose: string;
  resultId: string;
  contentHash: string;
  status: string;
};

export const contextContentHash = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

function validTaskState(
  state: AgentTaskState | undefined,
  taskId: string,
): state is AgentTaskState {
  return Boolean(
    state &&
    state.taskId === taskId &&
    typeof state.taskGoal === 'string' &&
    typeof state.currentStage === 'string' &&
    ['running', 'recovering', 'completed', 'partial', 'failed', 'cancelled'].includes(
      state.executionStatus,
    ) &&
    Array.isArray(state.userRequirements) &&
    state.userRequirements.every(
      (r) =>
        r && typeof r.id === 'string' && typeof r.text === 'string' && typeof r.source === 'string',
    ) &&
    Array.isArray(state.projectConstraints) &&
    state.projectConstraints.every((c) => typeof c === 'string') &&
    Array.isArray(state.confirmedDecisions) &&
    state.confirmedDecisions.every(
      (d) => d && typeof d.text === 'string' && typeof d.source === 'string',
    ) &&
    Array.isArray(state.completedSteps) &&
    state.completedSteps.every((s) => typeof s === 'string') &&
    Array.isArray(state.pendingSteps) &&
    Array.isArray(state.generatedArtifacts) &&
    state.generatedArtifacts.every(
      (a) =>
        a &&
        typeof a.resultId === 'string' &&
        typeof a.callId === 'string' &&
        typeof a.toolName === 'string',
    ),
  );
}

/** Project-local working data, separate from audit summaries and request projections. */
export class AgentContextStore {
  constructor(private readonly db: Database.Database) {}

  private decodeTask(projectId: string, taskId: string, text: string): AgentTaskState | undefined {
    let value = JSON.parse(text) as Record<string, unknown>;
    if (value.format === 'agent-checkpoint-v2')
      value = JSON.parse(
        this.result(projectId, taskId, String(value.stateResultId))!.content,
      ) as Record<string, unknown>;
    const state = value as AgentTaskState;
    return validTaskState(state, taskId) ? state : undefined;
  }

  private decodeRuntime<T>(projectId: string, taskId: string, text: string | null): T | undefined {
    if (!text) return undefined;
    let value = JSON.parse(text) as Record<string, unknown>;
    if (value.format === 'agent-checkpoint-v2') {
      const read = (id: unknown) =>
        JSON.parse(this.result(projectId, taskId, String(id))!.content) as Record<string, unknown>;
      value = {
        ...read(value.metadataResultId),
        runtime: read(value.configResultId),
        messages: read(value.messagesResultId),
      };
    }
    return value &&
      value.runtime &&
      typeof value.runtime === 'object' &&
      Array.isArray(value.messages)
      ? (value as T)
      : undefined;
  }

  /** Resolve state and runtime together. A valid terminal current state always wins. */
  loadSnapshot<T>(
    projectId: string,
    taskId: string,
  ): { state: AgentTaskState; runtime?: T } | undefined {
    const row = this.db
      .prepare(
        'SELECT state_json,runtime_json FROM agent_context_tasks WHERE project_id=? AND task_id=?',
      )
      .get(projectId, taskId) as { state_json: string; runtime_json: string | null } | undefined;
    let current: AgentTaskState | undefined;
    try {
      if (row) current = this.decodeTask(projectId, taskId, row.state_json);
    } catch {
      /* Inspect immutable checkpoints. */
    }
    if (current && !['running', 'recovering'].includes(current.executionStatus)) {
      try {
        return {
          state: current,
          runtime: this.decodeRuntime<T>(projectId, taskId, row!.runtime_json),
        };
      } catch {
        return { state: current };
      }
    }
    if (current) {
      try {
        const runtime = this.decodeRuntime<T>(projectId, taskId, row!.runtime_json);
        if (runtime) return { state: current, runtime };
      } catch {
        /* Fall back as one snapshot, never combine two checkpoint revisions. */
      }
    }
    for (const checkpoint of this.checkpoints(projectId, taskId)) {
      try {
        const state = this.decodeTask(projectId, taskId, checkpoint.state_json);
        const runtime = this.decodeRuntime<T>(projectId, taskId, checkpoint.runtime_json);
        if (!state || !runtime) continue;
        // Newer explicit requirements survive fallback; progress comes from the valid pair.
        if (current) {
          state.userRequirements = current.userRequirements;
          state.projectConstraints = current.projectConstraints;
          state.confirmedDecisions = current.confirmedDecisions;
        }
        return { state, runtime };
      } catch {
        /* One damaged task/checkpoint does not hide healthy candidates. */
      }
    }
    return current ? { state: current } : undefined;
  }

  loadTask(projectId: string, taskId: string): AgentTaskState | undefined {
    return this.loadSnapshot(projectId, taskId)?.state;
  }

  taskForGeneration(
    projectId: string,
    conversationId: string,
    generationId: string,
  ): AgentTaskState | undefined {
    const row = this.db
      .prepare(
        'SELECT task_id FROM agent_context_tasks WHERE project_id=? AND conversation_id=? AND generation_id=?',
      )
      .get(projectId, conversationId, generationId) as { task_id: string } | undefined;
    return row ? this.loadTask(projectId, row.task_id) : undefined;
  }

  saveTask(
    projectId: string,
    generationId: string,
    conversationId: string,
    state: AgentTaskState,
    runtime?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_context_tasks(project_id,task_id,generation_id,conversation_id,state_json,runtime_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET
      generation_id=excluded.generation_id,revision=agent_context_tasks.revision+1,
      state_json=excluded.state_json,runtime_json=COALESCE(excluded.runtime_json,agent_context_tasks.runtime_json),updated_at=excluded.updated_at`,
      )
      .run(
        projectId,
        state.taskId,
        generationId,
        conversationId,
        JSON.stringify(state),
        runtime === undefined ? null : JSON.stringify(runtime),
        new Date().toISOString(),
      );
  }

  loadRuntime<T>(projectId: string, taskId: string): T | undefined {
    return this.loadSnapshot<T>(projectId, taskId)?.runtime;
  }

  private checkpoints(projectId: string, taskId: string) {
    return this.db
      .prepare(
        'SELECT state_json,runtime_json FROM agent_context_checkpoints WHERE project_id=? AND task_id=? ORDER BY revision DESC,rowid DESC',
      )
      .iterate(projectId, taskId) as Iterable<{ state_json: string; runtime_json: string | null }>;
  }

  recoverable(
    projectId: string,
  ): Array<{ taskId: string; generationId: string; conversationId: string }> {
    return (
      this.db
        .prepare(
          `SELECT task_id,generation_id,conversation_id FROM agent_context_tasks
      WHERE project_id=?`,
        )
        .all(projectId) as Array<{
        task_id: string;
        generation_id: string;
        conversation_id: string;
      }>
    ).flatMap((r) => {
      const snapshot = this.loadSnapshot(projectId, r.task_id);
      return snapshot?.runtime && ['running', 'recovering'].includes(snapshot.state.executionStatus)
        ? [{ taskId: r.task_id, generationId: r.generation_id, conversationId: r.conversation_id }]
        : [];
    });
  }

  putResult(
    projectId: string,
    taskId: string,
    callId: string,
    toolName: string,
    content: string,
    args: unknown = {},
    status = 'completed',
  ): StoredToolResult {
    return this.db.transaction(() => {
      const hash = contextContentHash(content);
      const existing = this.db
        .prepare(
          'SELECT id FROM agent_context_results WHERE project_id=? AND task_id=? AND call_id=? AND content_hash=?',
        )
        .get(projectId, taskId, callId, hash) as { id: string } | undefined;
      if (existing) return this.result(projectId, taskId, existing.id)!;
      const version = (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(version),0)+1 AS n FROM agent_context_results WHERE project_id=? AND task_id=? AND call_id=?',
          )
          .get(projectId, taskId, callId) as { n: number }
      ).n;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO agent_context_results(id,project_id,task_id,call_id,tool_name,status,version,content,content_hash,arguments_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          projectId,
          taskId,
          callId,
          toolName,
          status,
          version,
          content,
          hash,
          JSON.stringify(args ?? {}),
          new Date().toISOString(),
        );
      return { id, callId, toolName, status, version, content, contentHash: hash, arguments: args };
    })();
  }

  result(projectId: string, taskId: string, id: string): StoredToolResult | undefined {
    const r = this.db
      .prepare('SELECT * FROM agent_context_results WHERE id=? AND project_id=? AND task_id=?')
      .get(id, projectId, taskId) as
      | {
          id: string;
          call_id: string;
          tool_name: string;
          status: string;
          version: number;
          content: string;
          content_hash: string;
          arguments_json: string;
        }
      | undefined;
    if (!r) return undefined;
    if (contextContentHash(r.content) !== r.content_hash)
      throw new Error('CONTEXT_RESULT_INTEGRITY_FAILED');
    return {
      id: r.id,
      callId: r.call_id,
      toolName: r.tool_name,
      status: r.status,
      version: r.version,
      content: r.content,
      contentHash: r.content_hash,
      arguments: JSON.parse(r.arguments_json),
    };
  }

  resultForCall(projectId: string, taskId: string, callId: string): StoredToolResult | undefined {
    const r = this.db
      .prepare(
        'SELECT id FROM agent_context_results WHERE project_id=? AND task_id=? AND call_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(projectId, taskId, callId) as { id: string } | undefined;
    return r ? this.result(projectId, taskId, r.id) : undefined;
  }

  readResult(
    projectId: string,
    taskId: string,
    id: string,
    offset = 0,
    limit = 4096,
    expectedHash?: string,
    resultView: 'content' | 'arguments' = 'content',
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 16384
    )
      throw new Error('Invalid result range; offsets use UTF-16 characters and limit is 1–16384.');
    const result = this.result(projectId, taskId, id);
    if (!result) throw new Error('Result is outside this task or unavailable.');
    if (!['content', 'arguments'].includes(resultView)) throw new Error('Invalid result view.');
    const content = resultView === 'arguments' ? JSON.stringify(result.arguments) : result.content;
    const hash = contextContentHash(content);
    if (expectedHash && expectedHash !== hash) throw new Error('CONTEXT_RESULT_VERSION_CONFLICT');
    if (offset > content.length) throw new Error('Result offset exceeds content.');
    const end = Math.min(content.length, offset + limit);
    return {
      status: 'task_result_read',
      resultId: id,
      version: result.version,
      contentHash: hash,
      resultView,
      toolName: result.toolName,
      offset,
      endOffset: end,
      totalCharacters: content.length,
      content: content.slice(offset, end),
      nextOffset: end < content.length ? end : null,
    };
  }

  putEvidence(
    projectId: string,
    taskId: string,
    result: StoredToolResult,
    source: { key: string; version: string; range?: string; type: string; purpose: string },
  ): AgentEvidenceRef {
    return this.db.transaction(() => {
      const now = new Date().toISOString(),
        range = source.range ?? '';
      const known = this.db
        .prepare(
          `SELECT id,status,result_id FROM agent_context_evidence WHERE project_id=? AND task_id=? AND source_key=? AND source_version=? AND range_key=? AND content_hash=?`,
        )
        .get(projectId, taskId, source.key, source.version, range, result.contentHash) as
        { id: string; status: string; result_id: string } | undefined;
      // Observing an archived result again must never roll the active version backwards.
      if (known)
        return {
          evidenceId: known.id,
          sourceKey: source.key,
          sourceVersion: source.version,
          rangeKey: range,
          sourceType: source.type,
          purpose: source.purpose,
          resultId: known.result_id,
          contentHash: result.contentHash,
          status: known.status,
        };
      const retiredVersion = this.db
        .prepare(
          "SELECT 1 FROM agent_context_evidence e WHERE project_id=? AND task_id=? AND source_key=? AND source_version=? AND status IN ('superseded','retired') AND NOT EXISTS (SELECT 1 FROM agent_context_evidence a WHERE a.project_id=e.project_id AND a.task_id=e.task_id AND a.source_key=e.source_key AND a.source_version=e.source_version AND a.status='active')",
        )
        .get(projectId, taskId, source.key, source.version);
      if (retiredVersion) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO agent_context_evidence(id,project_id,task_id,source_key,source_version,range_key,source_type,purpose,result_id,content_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'superseded',?,?)`,
          )
          .run(
            id,
            projectId,
            taskId,
            source.key,
            source.version,
            range,
            source.type,
            source.purpose,
            result.id,
            result.contentHash,
            now,
            now,
          );
        return {
          evidenceId: id,
          sourceKey: source.key,
          sourceVersion: source.version,
          rangeKey: range,
          sourceType: source.type,
          purpose: source.purpose,
          resultId: result.id,
          contentHash: result.contentHash,
          status: 'superseded',
        };
      }
      this.db
        .prepare(
          `UPDATE agent_context_evidence SET status='superseded',updated_at=?
        WHERE project_id=? AND task_id=? AND source_key=? AND status='active' AND source_version<>?`,
        )
        .run(now, projectId, taskId, source.key, source.version);
      // A changed same-version result replaces only the same range, preserving other pages.
      this.db
        .prepare(
          `UPDATE agent_context_evidence SET status='superseded',updated_at=?
        WHERE project_id=? AND task_id=? AND source_key=? AND source_version=? AND range_key=? AND status='active' AND content_hash<>?`,
        )
        .run(now, projectId, taskId, source.key, source.version, range, result.contentHash);
      const old = this.db
        .prepare(
          `SELECT id FROM agent_context_evidence WHERE project_id=? AND task_id=? AND source_key=? AND source_version=? AND range_key=? AND content_hash=?`,
        )
        .get(projectId, taskId, source.key, source.version, range, result.contentHash) as
        { id: string } | undefined;
      const id = old?.id ?? randomUUID();
      if (!old)
        this.db
          .prepare(
            `INSERT INTO agent_context_evidence(id,project_id,task_id,source_key,source_version,range_key,source_type,purpose,result_id,content_hash,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
          )
          .run(
            id,
            projectId,
            taskId,
            source.key,
            source.version,
            range,
            source.type,
            source.purpose,
            result.id,
            result.contentHash,
            now,
            now,
          );
      return {
        evidenceId: id,
        sourceKey: source.key,
        sourceVersion: source.version,
        rangeKey: range,
        sourceType: source.type,
        purpose: source.purpose,
        resultId: result.id,
        contentHash: result.contentHash,
        status: old ? 'existing' : 'active',
      };
    })();
  }

  retireEvidence(
    projectId: string,
    taskId: string,
    sourcePrefixes: string[],
    beforeResultId: string,
  ): void {
    for (const prefix of sourcePrefixes)
      this.db
        .prepare(
          `UPDATE agent_context_evidence SET status='retired',updated_at=?
        WHERE project_id=? AND task_id=? AND status='active' AND substr(source_key,1,?)=?
        AND result_id IN (SELECT id FROM agent_context_results WHERE project_id=? AND task_id=?
          AND rowid < (SELECT rowid FROM agent_context_results WHERE id=? AND project_id=? AND task_id=?))`,
        )
        .run(
          new Date().toISOString(),
          projectId,
          taskId,
          prefix.length,
          prefix,
          projectId,
          taskId,
          beforeResultId,
          projectId,
          taskId,
        );
  }

  evidence(projectId: string, taskId: string, includeHistory = false): AgentEvidenceRef[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_context_evidence WHERE project_id=? AND task_id=? ${includeHistory ? '' : "AND status='active'"} ORDER BY rowid`,
      )
      .all(projectId, taskId) as Array<Record<string, string>>;
    return rows.map((r) => ({
      evidenceId: r.id!,
      sourceKey: r.source_key!,
      sourceVersion: r.source_version!,
      rangeKey: r.range_key!,
      sourceType: r.source_type!,
      purpose: r.purpose!,
      resultId: r.result_id!,
      contentHash: r.content_hash!,
      status: r.status!,
    }));
  }

  resultRefs(
    projectId: string,
    taskId: string,
  ): Array<{
    resultId: string;
    callId: string;
    toolName: string;
    status: string;
    version: number;
    contentHash: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT r.id,r.call_id,r.tool_name,r.status,r.version,r.content_hash FROM agent_context_results r WHERE r.project_id=? AND r.task_id=? AND r.tool_name<>'runtime.assistant' AND r.call_id NOT LIKE '%:images' AND r.version=(SELECT MAX(v.version) FROM agent_context_results v WHERE v.project_id=r.project_id AND v.task_id=r.task_id AND v.call_id=r.call_id) ORDER BY r.rowid`,
        )
        .all(projectId, taskId) as Array<Record<string, unknown>>
    ).map((r) => ({
      resultId: String(r.id),
      callId: String(r.call_id),
      toolName: String(r.tool_name),
      status: String(r.status),
      version: Number(r.version),
      contentHash: String(r.content_hash),
    }));
  }

  checkpoint(projectId: string, taskId: string, id: string): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT revision,state_json,runtime_json FROM agent_context_tasks WHERE project_id=? AND task_id=?',
        )
        .get(projectId, taskId) as
        { revision: number; state_json: string; runtime_json: string | null } | undefined;
      if (!row) return;
      const hash = contextContentHash(JSON.stringify([row.state_json, row.runtime_json]));
      const checkpointId = `${id}:${hash}`;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM agent_context_checkpoints WHERE project_id=? AND task_id=? AND (id=? OR json_extract(state_json,'$.snapshotHash')=?)",
          )
          .get(projectId, taskId, checkpointId, hash)
      )
        return;
      const count = (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM agent_context_checkpoints WHERE project_id=? AND task_id=?',
          )
          .get(projectId, taskId) as { n: number }
      ).n;
      let stateJson = row.state_json,
        runtimeJson = row.runtime_json;
      if (count % 16 !== 0) {
        const ref = (kind: string, content: string) =>
          this.putResult(
            projectId,
            taskId,
            `checkpoint:${kind}:${contextContentHash(content)}`,
            `runtime.checkpoint.${kind}`,
            content,
          ).id;
        stateJson = JSON.stringify({
          format: 'agent-checkpoint-v2',
          snapshotHash: hash,
          stateResultId: ref('state', row.state_json),
        });
        if (row.runtime_json) {
          const { runtime, messages, ...metadata } = JSON.parse(row.runtime_json) as Record<
            string,
            unknown
          >;
          runtimeJson = JSON.stringify({
            format: 'agent-checkpoint-v2',
            configResultId: ref('config', JSON.stringify(runtime)),
            messagesResultId: ref('messages', JSON.stringify(messages)),
            metadataResultId: ref('metadata', JSON.stringify(metadata)),
          });
        }
      }
      this.db
        .prepare(
          'INSERT OR IGNORE INTO agent_context_checkpoints(id,project_id,task_id,revision,state_json,runtime_json,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          checkpointId,
          projectId,
          taskId,
          row.revision,
          stateJson,
          runtimeJson,
          new Date().toISOString(),
        );
    })();
  }

  diagnose(projectId: string, taskId: string, details: unknown): void {
    this.db
      .prepare(
        'INSERT INTO agent_context_diagnostics(id,project_id,task_id,details_json,created_at) VALUES(?,?,?,?,?)',
      )
      .run(randomUUID(), projectId, taskId, JSON.stringify(details), new Date().toISOString());
  }
}
