import type Database from 'better-sqlite3';
import type { LlmToolDefinition } from '@ai-video/contracts';
import { compatibleCreationTools } from './agent-saved-production-receipts.js';

export function taskOutputBindings(db: Database.Database, projectId: string, taskId: string) {
  const bindings = db
    .prepare(
      `SELECT id AS outputId,plan_key AS planKey,tool_name AS toolName,quantity
    FROM agent_execution_outputs WHERE project_id=? AND task_id=? ORDER BY created_at,id`,
    )
    .all(projectId, taskId) as Array<{
    outputId: string;
    planKey: string;
    toolName: string;
    quantity: number;
  }>;
  const operations = db
    .prepare(`SELECT operation_key FROM agent_execution_commits WHERE project_id=? AND task_id=?`)
    .all(projectId, taskId) as Array<{ operation_key: string }>;
  const adoptions = db
    .prepare(
      `SELECT output_id FROM agent_execution_output_adoptions WHERE project_id=? AND task_id=?`,
    )
    .all(projectId, taskId) as Array<{ output_id: string }>;
  const committed = new Set(operations.map((row) => row.operation_key));
  return bindings.map((binding) => ({
    ...binding,
    committedIndices: Array.from({ length: binding.quantity }, (_, i) => i).filter(
      (i) =>
        committed.has(`output:${binding.outputId}:${i}`) ||
        (i === 0 && adoptions.some((a) => a.output_id === binding.outputId)),
    ),
  }));
}

export function outputSlotsDefinition(
  definition: LlmToolDefinition,
  bindings: ReturnType<typeof taskOutputBindings>,
): LlmToolDefinition {
  const properties = definition.parameters.properties as Record<string, unknown> | undefined;
  if (!properties?.outputKey) return definition;
  const current = bindings
    .filter((binding) => compatibleCreationTools(definition.name).includes(binding.toolName))
    .map(({ outputId, planKey, toolName, quantity }) => ({
      outputId,
      planKey,
      toolName,
      quantity,
    }));
  if (!current.length) return definition;
  const result = structuredClone(definition);
  const fields = result.parameters.properties as Record<string, Record<string, unknown>>;
  fields.outputKey!.description =
    (typeof fields.outputKey!.description === 'string' ? fields.outputKey!.description : '').split(
      '\n[CURRENT TASK OUTPUT SLOTS]\n',
    )[0] +
    '\n[CURRENT TASK OUTPUT SLOTS]\n' +
    JSON.stringify(current) +
    '. When multiple independent outputs are planned, supply outputKey and outputIndex on every create. Current saved indices are in taskState.outputBindings.committedIndices. Retry saved slots with the identical request or edit the saved object with current CAS; select an uncommitted slot only for distinct requested work.';
  return result;
}
