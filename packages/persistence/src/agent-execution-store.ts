import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { contextContentHash } from './agent-context-store.js';

export interface ExecutionIdentity {
  projectId: string;
  taskId: string;
  operationKey: string;
  toolName: string;
}

/** One synchronous SQLite boundary shared by all Agent gateways. */
export class AgentExecutionStore {
  constructor(private readonly db: Database.Database) {}

  registerOutput(
    projectId: string,
    taskId: string,
    key: string,
    tool: string,
    quantity: number,
    compatibleTools: readonly string[] = [tool],
  ) {
    const existing = this.db
      .prepare(
        'SELECT id,tool_name,quantity FROM agent_execution_outputs WHERE project_id=? AND task_id=? AND plan_key=?',
      )
      .get(projectId, taskId, key) as
      { id: string; tool_name: string; quantity: number } | undefined;
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('OUTPUT_QUANTITY_INVALID');
    if (existing && existing.tool_name !== tool && !compatibleTools.includes(existing.tool_name))
      throw new Error('OUTPUT_IDENTITY_CONFLICT: Use a new plan key for a different output type.');
    if (existing && quantity < existing.quantity) {
      for (let index = quantity; index < existing.quantity; index++) {
        if (
          this.db
            .prepare(
              'SELECT 1 FROM agent_execution_commits WHERE project_id=? AND task_id=? AND operation_key=?',
            )
            .get(projectId, taskId, `output:${existing.id}:${index}`)
        )
          throw new Error('OUTPUT_ALREADY_COMMITTED: Cannot remove committed output slots.');
      }
    }
    const id = existing?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_execution_outputs(id,project_id,task_id,plan_key,tool_name,quantity,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,task_id,plan_key) DO UPDATE SET tool_name=excluded.tool_name,quantity=excluded.quantity`,
      )
      .run(id, projectId, taskId, key, tool, quantity, new Date().toISOString());
    return id;
  }

  output(projectId: string, taskId: string, id: string) {
    return this.db
      .prepare('SELECT * FROM agent_execution_outputs WHERE project_id=? AND task_id=? AND id=?')
      .get(projectId, taskId, id) as
      { id: string; tool_name: string; quantity: number } | undefined;
  }

  outputBindings(projectId: string, taskId: string, tool: string) {
    return this.db
      .prepare(
        'SELECT id AS outputId,plan_key AS planKey,quantity FROM agent_execution_outputs WHERE project_id=? AND task_id=? AND tool_name=? ORDER BY created_at,id',
      )
      .all(projectId, taskId, tool) as Array<{
      outputId: string;
      planKey: string;
      quantity: number;
    }>;
  }

  /** Bind compatibility outputs from actual plan allocation, never from the next call. */
  adoptAllocatedOutput(
    projectId: string,
    taskId: string,
    outputId: string,
    resourceIds: string[],
  ): void {
    if (!resourceIds.length) return;
    const commits = this.db
      .prepare(
        `SELECT c.operation_key,r.result_json FROM agent_execution_commits c
      JOIN agent_write_receipts r ON r.id=c.receipt_id WHERE c.project_id=? AND c.task_id=?
      AND c.operation_key LIKE 'output:implicit:%' ORDER BY c.sequence`,
      )
      .all(projectId, taskId) as Array<{ operation_key: string; result_json: string }>;
    for (const commit of commits) {
      const result = JSON.parse(commit.result_json) as {
        execution?: { resources?: Array<{ id: string }> };
      };
      if (!result.execution?.resources?.some((resource) => resourceIds.includes(resource.id)))
        continue;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO agent_execution_output_adoptions(project_id,task_id,operation_key,output_id) VALUES(?,?,?,?)',
        )
        .run(projectId, taskId, commit.operation_key, outputId);
    }
  }

  /** Only a previously allocated implicit result may be replayed through a slot. */
  outputOperation(
    projectId: string,
    taskId: string,
    outputId: string,
    index: number,
    implicit: string,
  ): string {
    const explicit = `output:${outputId}:${index}`;
    if (index !== 0) return explicit;
    const adopted = this.db
      .prepare(
        'SELECT output_id FROM agent_execution_output_adoptions WHERE project_id=? AND task_id=? AND operation_key=?',
      )
      .get(projectId, taskId, implicit) as { output_id: string } | undefined;
    return adopted?.output_id === outputId ? implicit : explicit;
  }

  changeSequence(projectId: string): number {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence),0) AS n FROM agent_resource_changes WHERE project_id=?',
        )
        .get(projectId) as { n: number }
    ).n;
  }

  /** Attribution for synchronous operations without a replay contract (including legacy tools). */
  withTaskScope<T>(taskId: string, operation: () => T): T {
    return this.db.transaction(() => {
      const previous = this.db
        .prepare('SELECT task_id FROM agent_execution_scope WHERE id=1')
        .get() as { task_id: string } | undefined;
      this.db
        .prepare('INSERT OR REPLACE INTO agent_execution_scope(id,task_id) VALUES(1,?)')
        .run(taskId);
      try {
        return operation();
      } finally {
        this.db.prepare('DELETE FROM agent_execution_scope WHERE id=1').run();
        if (previous)
          this.db
            .prepare('INSERT INTO agent_execution_scope(id,task_id) VALUES(1,?)')
            .run(previous.task_id);
      }
    })();
  }

  execute(
    identity: ExecutionIdentity,
    args: unknown,
    write: () => unknown,
    serialize: (value: unknown) => string,
  ): string {
    return this.db.transaction(() => {
      const { projectId, taskId, operationKey, toolName } = identity;
      const executionKey = `execution:${taskId}:${operationKey}`;
      const request = JSON.stringify(args, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      );
      const requestHash = contextContentHash(request);
      const previous = this.db
        .prepare(
          'SELECT id,request_hash,result_json FROM agent_write_receipts WHERE project_id=? AND execution_key=?',
        )
        .get(projectId, executionKey) as
        { id: string; request_hash: string; result_json: string } | undefined;
      if (previous) {
        const result = JSON.parse(previous.result_json) as Record<string, unknown>;
        if (previous.request_hash !== requestHash)
          return serialize({
            status: 'rejected',
            error: {
              code: 'AGENT_BUSINESS_OPERATION_CONFLICT',
              retryable: true,
              message: 'Output already committed; revise the saved object with current CAS.',
            },
            execution: { operationKey, receiptId: previous.id, effect: 'conflict' },
            savedResult: result,
            instruction:
              'This output already has a committed result. Read its actual IDs/current versions and revise that object using CAS. Register an independent output in the task plan only when the user requested additional work. No write occurred.',
          });
        return serialize({
          ...result,
          execution: {
            ...(result.execution as object),
            replayed: true,
            receiptScope: 'historical_commit',
            instruction:
              'This is the original committed result, not current resource state. No business operation was repeated. Read the saved resource or stage by its exact ID for current progress and CAS before continuing; old pending lists and versions describe the original commit only.',
          },
        });
      }
      const scope = this.db
        .prepare('SELECT task_id FROM agent_execution_scope WHERE id=1')
        .get() as { task_id: string } | undefined;
      this.db
        .prepare('INSERT OR REPLACE INTO agent_execution_scope(id,task_id) VALUES(1,?)')
        .run(taskId);
      const before = this.changeSequence(projectId);
      try {
        const value = write();
        // Validate before commit, including callbacks that bind domain-plan deliverables.
        const result = JSON.parse(serialize(value)) as Record<string, unknown>;
        const changes = this.db
          .prepare(
            'SELECT resource_type,resource_id,operation,MAX(sequence) AS sequence FROM agent_resource_changes WHERE project_id=? AND task_id=? AND sequence>? GROUP BY resource_type,resource_id,operation',
          )
          .all(projectId, taskId, before) as Array<{
          resource_type: string;
          resource_id: string;
          operation: string;
          sequence: number;
        }>;
        const effect = changes.some((c) => c.operation === 'insert')
          ? 'created'
          : changes.length
            ? 'updated'
            : 'unchanged';
        const receiptId = randomUUID();
        const now = new Date().toISOString();
        const sequence = this.changeSequence(projectId);
        const output = serialize({
          ...result,
          execution: {
            ...(changes.length ? { receiptId } : {}),
            operationKey,
            effect,
            replayed: false,
            changeSequence: sequence,
            ...(toolName === 'production.bundle' && changes.length > 100
              ? { resourceCount: changes.length, resourceResultId: result.mappingResultId }
              : {}),
            resources: (toolName === 'production.bundle' && changes.length > 100
              ? changes.slice(0, 20)
              : changes
            ).map((c) => ({
              type: c.resource_type,
              id: c.resource_id,
              operation: c.operation,
            })),
          },
        });
        if (!changes.length) return output;
        this.db
          .prepare(
            'INSERT INTO agent_write_receipts(id,project_id,execution_key,request_hash,request_json,result_json,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(receiptId, projectId, executionKey, requestHash, request, output, now);
        this.db
          .prepare(
            'INSERT INTO agent_execution_commits(project_id,task_id,operation_key,tool_name,receipt_id,effect,change_sequence,created_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(projectId, taskId, operationKey, toolName, receiptId, effect, sequence, now);
        return output;
      } finally {
        this.db.prepare('DELETE FROM agent_execution_scope WHERE id=1').run();
        if (scope)
          this.db
            .prepare('INSERT INTO agent_execution_scope(id,task_id) VALUES(1,?)')
            .run(scope.task_id);
      }
    })();
  }
}
