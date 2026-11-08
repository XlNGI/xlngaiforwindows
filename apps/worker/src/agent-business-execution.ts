import type Database from 'better-sqlite3';
import { AgentExecutionStore } from '@ai-video/persistence';
import { hashAgentToolArguments, unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { reconcileTaskOutputAllocations } from './agent-task-deliverables.js';
import {
  CREATION_BINDING_TOOLS,
  compatibleCreationTools,
} from './agent-saved-production-receipts.js';

const CREATES = CREATION_BINDING_TOOLS;
const keyPart = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('Invalid business identity component.');
  return String(value);
};

/** Business identity belongs to the Worker; transport call IDs never select a new output. */
export function executeAgentBusiness(
  db: Database.Database,
  projectId: string,
  taskId: string,
  tool: string,
  input: Record<string, unknown>,
  write: (args: Record<string, unknown>) => unknown,
): string {
  return db.transaction(() => executeBusiness(db, projectId, taskId, tool, input, write))();
}

function executeBusiness(
  db: Database.Database,
  projectId: string,
  taskId: string,
  tool: string,
  input: Record<string, unknown>,
  write: (args: Record<string, unknown>) => unknown,
): string {
  const store = new AgentExecutionStore(db);
  const { outputKey, outputIndex, outputId: suppliedOutputId, ...args } = input;
  let outputId = suppliedOutputId;
  if (outputKey !== undefined) {
    if (!CREATES.includes(tool) || typeof outputKey !== 'string')
      throw new Error('OUTPUT_KEY_INVALID: outputKey must name a registered creation plan key.');
    const matches = compatibleCreationTools(tool).flatMap((name) =>
      store
        .outputBindings(projectId, taskId, name)
        .filter((binding) => binding.planKey === outputKey),
    );
    if (matches.length !== 1 || (outputId !== undefined && outputId !== matches[0]!.outputId))
      throw new Error(
        'OUTPUT_KEY_INVALID: No matching output for this task/tool, or outputId disagrees. No write occurred.',
      );
    outputId = matches[0]!.outputId;
  }
  let key: string | undefined;
  if (tool === 'document.submit_draft' && args.documentId) {
    key = `document:${keyPart(args.documentId)}:${keyPart(args.baseVersionId)}:${keyPart(args.expectedDocumentRowVersion)}`;
  } else if (tool === 'scene.update_shot_prompts' || tool === 'scene.update_shot_timings') {
    const targets = (args.shots as Array<Record<string, unknown>>).map((s) => [
      s.shotId,
      s.expectedRowVersion,
    ]);
    key = `${tool}:${hashAgentToolArguments(targets.sort(([a], [b]) => String(a).localeCompare(String(b))))}`;
  } else if (tool === 'scene.structure.stage' && args.operation !== 'begin') {
    if (args.operation !== 'get')
      key = `${tool}:${keyPart(args.stageId)}:${keyPart(args.operation)}:${keyPart(args.sceneIndex)}:${keyPart(args.shotOffset)}:${keyPart(args.expectedRowVersion ?? 'observed')}`;
  } else if (
    tool === 'scene.submit_structure' &&
    Array.isArray(args.scenes) &&
    args.scenes.length &&
    args.scenes.every((s: Record<string, unknown>) => s.sceneId)
  ) {
    key = `${tool}:targets:${hashAgentToolArguments(args.scenes.map((s: Record<string, unknown>) => [s.sceneId, s.expectedRowVersion]))}`;
  } else if (CREATES.includes(tool)) {
    reconcileTaskOutputAllocations(db, projectId, taskId);
    const compatibleTools = compatibleCreationTools(tool);
    const implicitCandidates = compatibleTools.map(
      (name) =>
        `output:implicit:${name}:${keyPart(args.documentKind ?? '')}:${keyPart(args.bindingRole ?? '')}`,
    );
    // Preserve an existing legacy alias binding. New aliases share one identity.
    const priorImplicit = db
      .prepare(
        `SELECT operation_key FROM agent_execution_commits
      WHERE project_id=? AND task_id=? AND operation_key IN (${implicitCandidates.map(() => '?').join(',')})
      ORDER BY sequence LIMIT 1`,
      )
      .get(projectId, taskId, ...implicitCandidates) as { operation_key: string } | undefined;
    const implicit = priorImplicit?.operation_key ?? implicitCandidates[0]!;
    if (outputId !== undefined) {
      const output =
        typeof outputId === 'string' ? store.output(projectId, taskId, outputId) : undefined;
      const index = outputIndex ?? 0;
      if (
        !output ||
        !compatibleTools.includes(output.tool_name) ||
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= output.quantity
      )
        throw new Error(
          'OUTPUT_ID_INVALID: Use the Worker-issued outputId and a zero-based index below quantity. No write occurred. Current bindings for this tool: ' +
            JSON.stringify(
              compatibleTools.flatMap((name) => store.outputBindings(projectId, taskId, name)),
            ),
        );
      key = store.outputOperation(projectId, taskId, output.id, index as number, implicit);
    } else {
      // Backward-compatible single output; additional independent work requires an explicit plan slot.
      key = implicit;
    }
    if (tool === 'scene.structure.stage') args.executionKey = `${taskId}:${key}`;
  }
  if (outputId !== undefined && !CREATES.includes(tool))
    throw new Error('outputId is only valid for creating a planned output.');
  const serialize = (value: unknown) => unifiedAgentToolRegistry.serializeResult(value);
  // Historical tasks have artifacts but no operation binding. Preserve them and require
  // explicit current IDs; never infer independent output identity from a title/body.
  const alreadyBound =
    key &&
    db
      .prepare(
        'SELECT 1 FROM agent_execution_commits WHERE project_id=? AND task_id=? AND operation_key=?',
      )
      .get(projectId, taskId, key);
  if (tool === 'document.submit_draft' && !args.documentId && !outputId && !alreadyBound) {
    const legacy = db
      .prepare(
        `SELECT d.id,d.current_version_id,d.row_version FROM documents d
      JOIN document_versions v ON v.id=d.current_version_id
      JOIN agent_tasks t ON t.id=v.source_task_id
      WHERE d.project_id=? AND d.kind=? AND (json_extract(t.request_snapshot_json,'$.parentTaskId')=?
        OR EXISTS(SELECT 1 FROM agent_task_document_artifacts a WHERE a.task_id=? AND a.document_id=d.id))
      AND NOT EXISTS(SELECT 1 FROM agent_resource_changes c WHERE c.task_id=? AND c.resource_id=d.id AND c.operation='insert')`,
      )
      .all(projectId, args.documentKind, taskId, taskId, taskId);
    if (legacy.length)
      return serialize({
        status: 'execution_conflict',
        legacyOutputs: legacy,
        instruction:
          'Historical outputs have no stable operation binding. Locate the intended saved output and submit its actual documentId, baseVersionId and expectedDocumentRowVersion. No new document was created.',
      });
  }
  return key
    ? store.execute(
        { projectId, taskId, operationKey: key, toolName: tool },
        args,
        () => write(args),
        serialize,
      )
    : store.withTaskScope(taskId, () => serialize(write(args)));
}
