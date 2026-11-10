import type Database from 'better-sqlite3';
import type { AgentSavedProductionReceiptPage } from '@ai-video/contracts';
import { CREATION_DELIVERY_TOOLS } from './agent-delivery-capabilities.js';

/** Shared execution capability: editing tools never receive creation identities. */
export const CREATION_BINDING_TOOLS: readonly string[] = CREATION_DELIVERY_TOOLS;

/** Transport size selects an entry point, never an independent business output. */
export function compatibleCreationTools(tool: string): readonly string[] {
  const sceneCreation = ['scene.submit_structure', 'scene.structure.stage'];
  return sceneCreation.includes(tool) ? sceneCreation : [tool];
}

/** Only committed structure receipts, never staging/readiness acknowledgements. */
export function isSavedStructureStatus(status: unknown): boolean {
  return (
    status === 'scene_structure_saved' ||
    status === 'scene_structure_partially_saved' ||
    status === 'episode_structure_saved'
  );
}

const TOOLS = [
  'scene.update_shot_prompts',
  'scene.update_shot_timings',
  'scene.submit_structure',
  'novel.episode.submit_structure',
  'scene.structure.stage',
  'shot.continuity.save',
  'production.bundle',
];
const FIELDS = [
  'executionId',
  'executionKey',
  'stageId',
  'rowVersion',
  'sceneId',
  'sceneIds',
  'shotId',
  'shotIds',
  'shots',
  'changedCount',
  'unchangedCount',
  'paidRequests',
  'nextSceneIndex',
  'minimumRemainingWrites',
  'savedSceneThisCall',
  'complete',
  'bundleId',
  'revision',
  'mappingResultId',
  'objectCount',
  'counts',
  'businessSaved',
  'readbackVerified',
];

/** Successful Worker audit only. Never derives persistence from assistant prose. */
export function savedProductionReceipts(
  db: Database.Database,
  projectId: string,
  scope: { taskId: string } | { generationId: string },
  offset = 0,
  limit = 20,
): AgentSavedProductionReceiptPage {
  const column = 'taskId' in scope ? 'task_id' : 'generation_id';
  const id = 'taskId' in scope ? scope.taskId : scope.generationId;
  const rows = db
    .prepare(
      `SELECT id,generation_id,tool_name,completed_at,result_summary_json
    FROM agent_tool_calls WHERE project_id=? AND ${column}=? AND generation_id IS NOT NULL AND status='succeeded'
    AND tool_name IN (${TOOLS.map(() => '?').join(',')})
    AND CASE WHEN json_valid(result_summary_json) THEN
      (substr(json_extract(result_summary_json,'$.status'),-6)='_saved' OR json_extract(result_summary_json,'$.savedSceneThisCall')=1
        OR (tool_name='production.bundle' AND json_extract(result_summary_json,'$.status')='bundle_committed'))
      ELSE 0 END
    ORDER BY created_at,id LIMIT ? OFFSET ?`,
    )
    .all(projectId, id, ...TOOLS, limit + 1, offset) as Array<{
    id: string;
    generation_id: string;
    tool_name: string;
    completed_at: string;
    result_summary_json: string | null;
  }>;
  const receipts: AgentSavedProductionReceiptPage['receipts'] = [];
  let consumed = 0;
  for (const row of rows.slice(0, limit)) {
    try {
      const result = JSON.parse(row.result_summary_json ?? '{}') as Record<string, unknown>;
      if (
        typeof result.status !== 'string' ||
        (!result.status.endsWith('_saved') &&
          result.savedSceneThisCall !== true &&
          !(row.tool_name === 'production.bundle' && result.status === 'bundle_committed'))
      ) {
        consumed++;
        continue;
      }
      const receipt = {
        callId: row.id,
        generationId: row.generation_id,
        toolName: row.tool_name,
        completedAt: row.completed_at,
        result: {
          status: result.status,
          ...Object.fromEntries(
            FIELDS.flatMap((field) =>
              result[field] === undefined ? [] : [[field, result[field]]],
            ),
          ),
        },
      };
      if (receipts.length && Buffer.byteLength(JSON.stringify([...receipts, receipt])) > 16 * 1024)
        break;
      receipts.push(receipt);
    } catch {
      // Malformed legacy audit is not evidence of a successful save.
    }
    consumed++;
  }
  return {
    receipts,
    offset,
    ...(rows.length > consumed ? { nextOffset: offset + consumed } : {}),
    instruction:
      'These operations already saved. This is historical evidence, not current CAS. Check current state only before further edits; finish the response when the requested work is already done. Inspect further pages if nextOffset is present.',
  };
}
