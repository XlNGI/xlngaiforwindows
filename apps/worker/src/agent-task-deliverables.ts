import type Database from 'better-sqlite3';
import { isBundleTask } from './production-bundle-state.js';
import { bundleCompletion } from './production-bundle-service.js';
import { TaskRepairError } from './agent-task-repair.js';
import { DELIVERY_TOOLS, isDocumentDeliveryTool } from './agent-delivery-capabilities.js';
import {
  AgentContextStore,
  AgentExecutionStore,
  contextContentHash,
  type StoredToolResult,
} from '@ai-video/persistence';
import {
  currentTaskArtifact,
  currentTargetVersion,
  hasCurrentRead,
  taskArtifactReads,
} from './agent-task-artifacts.js';
import { DOCUMENT_KINDS, validateProductionTiming, type DocumentKind } from '@ai-video/contracts';
import {
  checkTaskCriteria,
  validateTaskCriteria,
  type TaskCriterion,
} from './agent-task-criteria.js';
import {
  compatibleCreationTools,
  CREATION_BINDING_TOOLS,
  isSavedStructureStatus,
} from './agent-saved-production-receipts.js';
export const STRUCTURE_DELIVERABLE_TOOLS: readonly string[] = [
  'scene.structure.stage',
  'scene.submit_structure',
  'novel.episode.submit_structure',
];
export const REFERENCE_DELIVERABLE_TOOLS = [
  'scene.update_shot_prompts',
  ...STRUCTURE_DELIVERABLE_TOOLS,
];
export const DELIVERABLE_TOOLS = DELIVERY_TOOLS;
export type Deliverable = {
  key: string;
  toolName: (typeof DELIVERABLE_TOOLS)[number];
  description?: string;
  documentKind?: string;
  minimumCount: number;
  targetIds?: string[];
  requireReferences?: boolean;
  requiredTexts?: string[];
  revisionReason?: string;
  intent?: 'create' | 'reuse' | 'revise' | 'verify';
  origin?: 'user_requirement' | 'model_inference';
  sourceRequirementIds?: string[];
  dependsOn?: string[];
  criteria?: TaskCriterion[];
  /** Worker-owned registration version; never accepted from tool arguments. */
  baselineVersions?: Record<string, string>;
};
type Audit = {
  tool_name: string;
  result: Record<string, unknown>;
};
const isStructureTool = (tool: string) => STRUCTURE_DELIVERABLE_TOOLS.includes(tool);
function audit(db: Database.Database, projectId: string, generationId: string): Audit[] {
  const rows = db
    .prepare(
      `SELECT tool_name,result_summary_json FROM agent_tool_calls
    WHERE project_id=? AND generation_id=? AND status='succeeded' ORDER BY rowid`,
    )
    .all(projectId, generationId) as Array<{
    tool_name: string;
    result_summary_json: string | null;
  }>;
  return rows.flatMap((row) => {
    try {
      const result: unknown = JSON.parse(row.result_summary_json ?? 'null');
      return result && typeof result === 'object' && !Array.isArray(result)
        ? [
            { tool_name: row.tool_name, result: result as Record<string, unknown> },
            ...((result as Record<string, unknown>).inlinePlan &&
            isDocumentDeliveryTool(row.tool_name)
              ? [
                  {
                    tool_name: 'conversation.task.checkpoint',
                    result: (
                      result as {
                        inlinePlan: Record<string, unknown>;
                      }
                    ).inlinePlan,
                  },
                ]
              : []),
          ]
        : [];
    } catch {
      return [];
    }
  });
}
function currentPlan(rows: Audit[]): Deliverable[] {
  const result = rows
    .filter(
      (row) =>
        row.tool_name === 'conversation.task.checkpoint' && row.result.status === 'task_plan_saved',
    )
    .at(-1)?.result.deliverables;
  // Historical plans advertised script even though storage never supported it.
  // Repair that declaration in memory; obligations and audit rows stay intact.
  return Array.isArray(result)
    ? (result as Deliverable[]).map((item) => {
        const repaired =
          isDocumentDeliveryTool(item.toolName) && item.documentKind === 'script'
            ? { ...item, documentKind: 'plan' }
            : { ...item };
        // A legacy destination page is not an output identity. Preserve the
        // obligation/count and original audit; repair only the invalid locator.
        if (repaired.targetIds?.some((id) => id.startsWith('workspace:'))) {
          const targets = repaired.targetIds.filter((id) => !id.startsWith('workspace:'));
          repaired.targetIds = targets.length ? targets : undefined;
        }
        return repaired;
      })
    : [];
}
/** One durable target graph for completion, review and the context working set. */
export function taskPlanScope(
  db: Database.Database,
  projectId: string,
  generationId: string,
  taskId = generationId,
) {
  const rows = audit(db, projectId, generationId);
  const items = currentPlan(rows);
  const allocation = evaluateDeliverables(db, projectId, rows, items, taskId);
  const pendingByKey = new Map<string, Record<string, unknown>>(
    allocation?.pending.map((item) => [item.key, item]),
  );
  return items.map((item) => {
    const pending = pendingByKey.get(item.key);
    const contentFailures: Record<string, unknown> = Object.fromEntries(
      ['missingTexts', 'criteriaFailures'].flatMap((key) =>
        Array.isArray(pending?.[key]) && pending[key].length ? [[key, pending[key]]] : [],
      ),
    );
    return {
      ...item,
      targetIds: [
        ...new Set([
          ...(item.targetIds ?? []),
          ...(allocation?.assignedOutputs.get(item.key) ?? []),
        ]),
      ],
      ...(Object.keys(contentFailures).length ? { contentFailures } : {}),
    };
  });
}
/** Plans are model declarations, never authorization or proof of persistence. */
export function saveTaskPlan(
  db: Database.Database,
  projectId: string,
  generationId: string,
  input: unknown,
  taskId = generationId,
): Record<string, unknown> {
  if (!Array.isArray(input) || !input.length || input.length > 50)
    throw new Error('Provide 1–50 deliverables.');
  const rows = audit(db, projectId, generationId);
  const requirements = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='agent_context_tasks'")
    .get()
    ? (new AgentContextStore(db).loadTask(projectId, taskId)?.userRequirements ?? [])
    : [];
  const registered = new Map(currentPlan(rows).map((item) => [item.key, item]));
  const merged = new Map(registered);
  const keys = new Set<string>();
  for (const [index, value] of input.entries()) {
    const invalid = (field: string, reason: string): never => {
      throw new Error(`deliverables[${index}]${field ? `.${field}` : ''}: ${reason}`);
    };
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('', 'must be an object.');
    const item = value as Deliverable;
    for (const key of Object.keys(item))
      if (
        ![
          'key',
          'toolName',
          'description',
          'documentKind',
          'minimumCount',
          'targetIds',
          'requireReferences',
          'requiredTexts',
          'revisionReason',
          'intent',
          'origin',
          'sourceRequirementIds',
          'dependsOn',
          'criteria',
        ].includes(key)
      )
        invalid(key, 'unknown field.');
    if (
      typeof item.key !== 'string' ||
      !item.key.trim() ||
      item.key.length > 128 ||
      keys.has(item.key)
    )
      invalid('key', 'must be a unique nonempty string of at most 128 characters.');
    if (!DELIVERABLE_TOOLS.includes(item.toolName))
      invalid('toolName', `must be one of ${DELIVERABLE_TOOLS.join(', ')}.`);
    if (item.intent !== undefined && !['create', 'reuse', 'revise', 'verify'].includes(item.intent))
      invalid('intent', 'must be create, reuse, revise or verify.');
    if (item.origin !== undefined && !['user_requirement', 'model_inference'].includes(item.origin))
      invalid('origin', 'must be user_requirement or model_inference.');
    for (const field of ['sourceRequirementIds', 'dependsOn'] as const) {
      const ids = item[field];
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length > 1000 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256))
      )
        invalid(field, 'must be unique nonempty IDs.');
    }
    if (item.origin === 'user_requirement' && !item.sourceRequirementIds?.length)
      invalid(
        'sourceRequirementIds',
        'user obligations must reference persisted user requirements.',
      );
    if (item.sourceRequirementIds?.some((id) => !requirements.some((r) => r.id === id)))
      invalid('sourceRequirementIds', 'must reference persisted user requirements.');
    if (['reuse', 'verify', 'revise'].includes(item.intent ?? '') && !item.targetIds?.length)
      invalid('targetIds', 'existing-work intents require explicit real output IDs.');
    if (
      item.intent === 'create' &&
      !(
        CREATION_BINDING_TOOLS.includes(item.toolName) ||
        item.toolName === 'novel.episode.submit_structure'
      )
    )
      invalid('intent', 'this tool edits existing targets and cannot create outputs.');
    if (!Number.isSafeInteger(item.minimumCount) || item.minimumCount < 1)
      invalid('minimumCount', 'must be a positive safe integer.');
    if (
      item.description !== undefined &&
      (typeof item.description !== 'string' || item.description.length > 1000)
    )
      invalid('description', 'must be a string of at most 1000 characters.');
    if (
      item.revisionReason !== undefined &&
      (typeof item.revisionReason !== 'string' ||
        !item.revisionReason.trim() ||
        item.revisionReason.length > 2000)
    )
      invalid('revisionReason', 'must explain the model plan correction in 1–2000 characters.');
    if (
      item.documentKind !== undefined &&
      (!isDocumentDeliveryTool(item.toolName) ||
        !DOCUMENT_KINDS.includes(item.documentKind as DocumentKind))
    )
      invalid(
        'documentKind',
        `only document.submit_draft accepts this field; use ${DOCUMENT_KINDS.join(', ')}. Scripts use plan.`,
      );
    if (
      item.requireReferences !== undefined &&
      (typeof item.requireReferences !== 'boolean' ||
        !REFERENCE_DELIVERABLE_TOOLS.includes(item.toolName))
    )
      invalid(
        'requireReferences',
        `only ${REFERENCE_DELIVERABLE_TOOLS.join(', ')} accept this boolean; omit it for other tools.`,
      );
    if (
      item.targetIds !== undefined &&
      (!Array.isArray(item.targetIds) ||
        !item.targetIds.length ||
        item.targetIds.length > 1000 ||
        item.targetIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128) ||
        new Set(item.targetIds).size !== item.targetIds.length)
    )
      invalid(
        'targetIds',
        'must contain 1–1000 unique nonempty output IDs, each at most 128 characters.',
      );
    if (
      item.requiredTexts !== undefined &&
      (!Array.isArray(item.requiredTexts) ||
        !item.requiredTexts.length ||
        item.requiredTexts.length > 200 ||
        item.requiredTexts.some(
          (text) => typeof text !== 'string' || !text.trim() || text.length > 2000,
        ) ||
        new Set(item.requiredTexts).size !== item.requiredTexts.length)
    )
      invalid(
        'requiredTexts',
        'must contain 1–200 distinct verbatim requirements, each 1–2000 characters.',
      );
    validateTaskCriteria(item.criteria, isDocumentDeliveryTool(item.toolName), item.dependsOn);
    keys.add(item.key);
    for (const id of item.targetIds ?? []) {
      const target = isDocumentDeliveryTool(item.toolName)
        ? (db
            .prepare(
              "SELECT kind FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
            )
            .get(id, projectId) as
            | {
                kind: string;
              }
            | undefined)
        : isStructureTool(item.toolName)
          ? db
              .prepare('SELECT id FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL')
              .get(id, projectId)
          : db
              .prepare(
                'SELECT s.id FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=? AND s.archived_at IS NULL AND c.archived_at IS NULL',
              )
              .get(id, projectId);
      if (
        !target ||
        (item.documentKind &&
          (
            target as {
              kind: string;
            }
          ).kind !== item.documentKind)
      )
        invalid(
          'targetIds',
          `${id} is not an existing active output of the requested type in this project. Omit targetIds for new outputs; workspace destinations are not output IDs.`,
        );
    }
    const previous = merged.get(item.key);
    // Model-authored estimates are not user requirements. Correct mistaken
    // quantities/types explicitly; future output identities may not exist yet. Keep
    // exact requirements, bindings and prior targets independently protected.
    const correctsEstimate = Boolean(item.revisionReason);
    const correctsInference =
      correctsEstimate &&
      previous?.origin === 'model_inference' &&
      !previous.sourceRequirementIds?.length;
    if (previous?.origin === 'user_requirement') {
      const field =
        item.origin !== previous.origin
          ? 'origin'
          : (item.intent ?? 'create') !== (previous.intent ?? 'create')
            ? 'intent'
            : previous.sourceRequirementIds?.some((id) => !item.sourceRequirementIds?.includes(id))
              ? 'sourceRequirementIds'
              : undefined;
      if (field)
        throw new TaskRepairError(
          `deliverables[${index}].${field}: confirmed user obligations and their requirement sources cannot be removed. Preserve the registered ${field}; saved work does not change its original intent.`,
          {
            kind: 'plan',
            code: 'TASK_PLAN_USER_OBLIGATION',
            field,
            index,
            planKey: item.key,
            expected: field === 'intent' ? (previous.intent ?? 'create') : previous[field],
            received: item[field] ?? null,
            instruction:
              'Keep this stable key, original intent, requirement sources and final obligations. Bind the saved targetIds without changing create to reuse/revise/verify. Continue current readback, review or binding work; do not recreate saved outputs.',
          },
        );
    }
    if (previous && previous.origin !== 'model_inference' && item.origin === 'model_inference')
      invalid('origin', 'cannot relabel a legacy or user obligation as a model inference.');
    const protectedTexts =
      previous?.requiredTexts?.filter(
        (text) => !correctsInference || requirements.some((r) => r.text.includes(text)),
      ) ?? [];
    if (previous?.requireReferences && !item.requireReferences && !correctsInference)
      throw new TaskRepairError(
        `Cannot weaken deliverables[${index}].requireReferences: this is the final binding obligation, not a prerequisite for initial shot creation or review. Keep requireReferences=true and follow the current phase actions.`,
        {
          kind: 'plan',
          code: 'TASK_PLAN_FINAL_REFERENCES_REQUIRED',
          field: 'requireReferences',
          index,
          planKey: item.key,
          expected: true,
          received: item.requireReferences ?? null,
          instruction:
            'Preserve the registered final binding obligation. Empty initial reference arrays do not conflict with this final requirement. Continue missing shot outputs, current readback and shot review; then create/read/review materials and bind them. Do not revise the plan or create materials early to clear this future obligation.',
        },
      );
    if (!previous && !item.targetIds) {
      const equivalent = [...registered.values()].find(
        (existing) =>
          !existing.targetIds &&
          (existing.toolName === item.toolName ||
            (isStructureTool(existing.toolName) && isStructureTool(item.toolName))) &&
          existing.documentKind === item.documentKind &&
          Boolean(existing.requireReferences) === Boolean(item.requireReferences),
      );
      if (equivalent)
        invalid(
          'key',
          `matches the existing unbound deliverable ${equivalent.key}. Reuse its stable key to refine the total count; do not add the total again as new work after recovery. To add independent work, identify distinct targetIds.`,
        );
    }
    if (
      previous &&
      ((previous.toolName !== item.toolName &&
        !(isStructureTool(previous.toolName) && isStructureTool(item.toolName))) ||
        ((!correctsEstimate || previous.origin === 'user_requirement') &&
          (previous.minimumCount > item.minimumCount ||
            (previous.documentKind && previous.documentKind !== item.documentKind))) ||
        protectedTexts.some((text) => !item.requiredTexts?.includes(text)) ||
        (previous.targetIds?.some((id) => !item.targetIds?.includes(id)) && !correctsInference) ||
        (previous.dependsOn?.some((id) => !item.dependsOn?.includes(id)) && !correctsInference) ||
        (previous.criteria?.some(
          (criterion) =>
            !item.criteria?.some(
              (current) =>
                Object.keys(criterion).length === Object.keys(current).length &&
                Object.entries(criterion).every(
                  ([key, value]) => (current as unknown as Record<string, unknown>)[key] === value,
                ),
            ),
        ) &&
          !correctsInference) ||
        ((previous.intent ?? 'create') !== (item.intent ?? 'create') && !correctsEstimate))
    )
      throw new Error(
        'Cannot weaken registered deliverables. To correct a model-estimated quantity or document kind, reuse the same key and provide revisionReason. Include discovered targetIds; future IDs need not exist yet. Preserve requiredTexts, required references and all prior targets; original user requirements remain binding.',
      );
    merged.set(item.key, {
      ...item,
      ...(item.intent === 'revise'
        ? {
            baselineVersions: Object.fromEntries(
              (item.targetIds ?? []).map((id) => [
                id,
                (previous?.intent === 'revise' ? previous.baselineVersions?.[id] : undefined) ??
                  currentTargetVersion(
                    db,
                    projectId,
                    id,
                    isDocumentDeliveryTool(item.toolName)
                      ? 'document'
                      : isStructureTool(item.toolName)
                        ? 'scene'
                        : 'shot',
                  ),
              ]),
            ),
          }
        : {}),
    });
  }
  if (merged.size > 50) throw new Error('At most 50 deliverables per task.');
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error('Deliverable dependencies must be acyclic.');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of merged.get(key)?.dependsOn ?? []) {
      if (!merged.has(dependency)) throw new Error(`Unknown deliverable dependency: ${dependency}`);
      visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of merged.keys()) visit(key);
  for (const item of merged.values()) {
    if (!item.criteria?.some((c) => c.kind === 'shot_prompt_projection')) continue;
    const seen = new Set<string>();
    const hasShots = (key: string): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      const source = merged.get(key)!;
      return !isDocumentDeliveryTool(source.toolName) || (source.dependsOn ?? []).some(hasShots);
    };
    if (!(item.dependsOn ?? []).some(hasShots))
      throw new Error('shot_prompt_projection must depend on a shot/scene deliverable.');
  }
  if (input.some((item: Deliverable) => item.targetIds?.length)) {
    const before = evaluateDeliverables(db, projectId, rows, [...registered.values()]);
    const after = evaluateDeliverables(db, projectId, rows, [...merged.values()]);
    for (const previous of registered.values()) {
      const current = merged.get(previous.key)!;
      if (
        current.targetIds ||
        current.documentKind !== previous.documentKind ||
        (current.toolName !== previous.toolName &&
          !(isStructureTool(current.toolName) && isStructureTool(previous.toolName)))
      )
        continue;
      const assigned = before?.assignedOutputs.get(previous.key) ?? [];
      const remaining = after?.assignedOutputs.get(previous.key) ?? [];
      if (remaining.length >= Math.min(assigned.length, current.minimumCount)) continue;
      const conflict = [...merged.values()].find(
        (item) => item.key !== previous.key && item.targetIds?.some((id) => assigned.includes(id)),
      );
      if (conflict)
        throw new Error(
          `Outputs in ${conflict.key} are already allocated to existing deliverable ${previous.key}. Reuse its stable key to bind these IDs. If both entries intentionally describe the same saved work, explicitly bind the shared targetIds on each affected existing key in this plan update. Do not recreate outputs or add the completed total again after recovery. No plan changes were saved.`,
        );
    }
  }
  const allocation = evaluateDeliverables(db, projectId, rows, [...merged.values()]);
  const executionStore = new AgentExecutionStore(db);
  const outputBindings = [...merged.values()]
    .filter(
      (item) =>
        (!item.intent || item.intent === 'create') &&
        [...CREATION_BINDING_TOOLS, ...STRUCTURE_DELIVERABLE_TOOLS].includes(item.toolName),
    )
    .flatMap((item) => {
      const outputId = executionStore.registerOutput(
        projectId,
        taskId,
        item.key,
        item.toolName,
        item.minimumCount,
        compatibleCreationTools(item.toolName),
      );
      executionStore.adoptAllocatedOutput(
        projectId,
        taskId,
        outputId,
        allocation?.assignedOutputs.get(item.key) ?? [],
      );
      // Completed compatibility outputs still need durable adoption so another
      // unbound entry cannot claim them after reconstruction. Only unfinished
      // creation work is advertised to the model as a creation binding.
      if ((allocation?.assignedOutputs.get(item.key)?.length ?? 0) >= item.minimumCount) return [];
      return [
        {
          key: item.key,
          outputKey: item.key,
          outputId,
          quantity: item.minimumCount,
          compatibleTools: compatibleCreationTools(item.toolName),
          instruction:
            'Use outputKey (this registered plan key) and a stable zero-based outputIndex for new outputs. outputId remains compatible. Retry the same index; revise saved objects by their real ID and current CAS. Never allocate a new index to repair or replay a saved output.',
        },
      ];
    });
  const result = {
    status: 'task_plan_saved',
    generationId,
    contractHash: contextContentHash(
      JSON.stringify(
        [...merged.values()].map((item) => {
          const contract = { ...item };
          delete contract.revisionReason;
          delete contract.description;
          return contract;
        }),
      ),
    ),
    deliverables: [...merged.values()],
    outputBindings,
    instruction:
      'Execution contract registered, no business work saved. intent=create requires saved outputs; revise requires a changed current version and complete readback; reuse/verify require real explicit targetIds and current complete reads. Only creation-capable tools receive outputBindings. Editing tools use real target IDs and CAS, never outputId. Structure tools count scenes, prompt/timing outputs count shots, document tools count documents. Origin=user_requirement references persisted sourceRequirementIds and cannot be weakened. Mark model assumptions origin=model_inference; correct them on the same key with revisionReason without removing actual user requirements. Legacy obligations stay protected. requiredTexts are literal saved-output checks, not semantic requirements such as duration. dependsOn lists prerequisite deliverable keys. Runtime review is not an extra document. Completion and quality remain Worker checked; never claim pending items completed.',
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024)
    throw new Error(
      'Deliverable plan exceeds the tool result budget; use concise descriptions and target groups.',
    );
  return result;
}
function savedIds(result: Record<string, unknown>): string[] {
  const shots: unknown[] = Array.isArray(result.shots) ? result.shots : [];
  return shots.flatMap((value) =>
    value && typeof value === 'object' && 'shotId' in value && typeof value.shotId === 'string'
      ? [value.shotId]
      : [],
  );
}
function validReferences(db: Database.Database, projectId: string, raw: string | null): boolean {
  try {
    const ir: unknown = JSON.parse(raw ?? 'null');
    if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return false;
    const references = ir as Record<string, unknown>;
    let count = 0;
    for (const [field, kind] of [
      ['characterDocumentIds', 'character'],
      ['sceneDocumentIds', 'scene'],
      ['propDocumentIds', 'prop'],
    ]) {
      const ids = references[field!];
      if (ids === undefined) continue;
      if (!Array.isArray(ids)) return false;
      for (const id of ids) {
        if (
          typeof id !== 'string' ||
          !db
            .prepare(
              "SELECT id FROM documents WHERE id=? AND project_id=? AND kind=? AND lifecycle_status='active' AND current_version_id IS NOT NULL",
            )
            .get(id, projectId, kind)
        )
          return false;
        count++;
      }
    }
    return count > 0;
  } catch {
    return false;
  }
}
/** Check the actual current deliverables, not audit summaries or supplemental IR fields. */
function currentOutputTexts(
  db: Database.Database,
  projectId: string,
  item: Deliverable,
  ids: string[],
): string[] {
  return ids.flatMap((id) => {
    if (isDocumentDeliveryTool(item.toolName)) {
      const row = db
        .prepare(
          `SELECT v.content_markdown FROM documents d JOIN document_versions v
        ON v.id=d.current_version_id AND v.document_id=d.id
        WHERE d.id=? AND d.project_id=? AND d.lifecycle_status='active'`,
        )
        .get(id, projectId) as
        | {
            content_markdown: string;
          }
        | undefined;
      return row ? [row.content_markdown] : [];
    }
    const rows = isStructureTool(item.toolName)
      ? db
          .prepare(
            `SELECT s.prompt FROM shots s JOIN scenes c ON c.id=s.scene_id
          WHERE c.id=? AND c.project_id=? AND c.archived_at IS NULL AND s.archived_at IS NULL`,
          )
          .all(id, projectId)
      : db
          .prepare(
            `SELECT s.prompt FROM shots s JOIN scenes c ON c.id=s.scene_id
          WHERE s.id=? AND c.project_id=? AND c.archived_at IS NULL AND s.archived_at IS NULL`,
          )
          .all(id, projectId);
    return (rows as Array<{ prompt: string | null }>).flatMap((row) =>
      typeof row.prompt === 'string' ? [row.prompt] : [],
    );
  });
}
export function assessTaskDeliverables(
  db: Database.Database,
  projectId: string,
  generationId: string,
  taskId = generationId,
) {
  const rows = audit(db, projectId, generationId);
  const result = evaluateDeliverables(db, projectId, rows, currentPlan(rows), taskId);
  if (!result) return undefined;
  const bindings = rows.filter((row) => row.result.status === 'task_plan_saved').at(-1)
    ?.result.outputBindings;
  const creationBindings = new Map(
    (Array.isArray(bindings) ? bindings : []).flatMap((binding: unknown) => {
      if (!binding || typeof binding !== 'object') return [];
      const value = binding as Record<string, unknown>;
      return typeof value.key === 'string' && typeof value.outputId === 'string'
        ? [[value.key, value] as const]
        : [];
    }),
  );
  return {
    // The plan receipt may leave the model working set. Keep Worker-issued
    // creation identities with the durable pending work instead of asking the
    // model to remember or recreate IDs after compaction/restart.
    pending: result.pending.map((item) => ({
      ...item,
      ...(creationBindings.has(item.key)
        ? { creationBinding: creationBindings.get(item.key) }
        : {}),
    })),
    ...(result.partialReason ? { partialReason: result.partialReason } : {}),
  };
}
/** Reconcile legacy implicit writes using the same persisted allocation as completion. */
export function reconcileTaskOutputAllocations(
  db: Database.Database,
  projectId: string,
  taskId: string,
): void {
  if (
    !db
      .prepare(
        `SELECT 1 FROM agent_execution_commits c WHERE c.project_id=? AND c.task_id=?
    AND c.operation_key LIKE 'output:implicit:%' AND NOT EXISTS (
      SELECT 1 FROM agent_execution_output_adoptions a WHERE a.project_id=c.project_id
      AND a.task_id=c.task_id AND a.operation_key=c.operation_key) LIMIT 1`,
      )
      .get(projectId, taskId)
  )
    return;
  const generation = db
    .prepare(
      'SELECT generation_id FROM agent_task_generations WHERE task_id=? ORDER BY ordinal DESC LIMIT 1',
    )
    .get(taskId) as
    | {
        generation_id: string;
      }
    | undefined;
  if (!generation) return;
  const rows = audit(db, projectId, generation.generation_id);
  const allocation = evaluateDeliverables(db, projectId, rows, currentPlan(rows));
  if (!allocation) return;
  const outputs = db
    .prepare('SELECT id,plan_key FROM agent_execution_outputs WHERE project_id=? AND task_id=?')
    .all(projectId, taskId) as Array<{
    id: string;
    plan_key: string;
  }>;
  const store = new AgentExecutionStore(db);
  for (const output of outputs)
    store.adoptAllocatedOutput(
      projectId,
      taskId,
      output.id,
      allocation.assignedOutputs.get(output.plan_key) ?? [],
    );
}
/** Shared allocation calculation keeps plan validation and completion consistent. */
function evaluateDeliverables(
  db: Database.Database,
  projectId: string,
  rows: Audit[],
  deliverables: Deliverable[],
  taskId?: string,
) {
  const partialReason = rows
    .filter(
      (row) =>
        row.tool_name === 'conversation.task.checkpoint' &&
        row.result.status === 'task_partial_reported',
    )
    .at(-1)?.result.reason;
  if (!deliverables.length && typeof partialReason !== 'string') return undefined;
  const savedDocuments = new Map<string, string>();
  for (const row of rows) {
    if (
      !isDocumentDeliveryTool(row.tool_name) ||
      row.result.status !== 'draft_saved' ||
      typeof row.result.documentId !== 'string' ||
      typeof row.result.documentVersionId !== 'string'
    )
      continue;
    const document = db
      .prepare(
        'SELECT d.kind FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id ' +
          "WHERE d.id=? AND d.project_id=? AND v.id=? AND d.lifecycle_status='active'",
      )
      .get(row.result.documentId, projectId, row.result.documentVersionId) as
      | {
          kind: string;
        }
      | undefined;
    if (document) savedDocuments.set(row.result.documentId, document.kind);
  }
  // Independent unbound deliverables need distinct persisted outputs. One plan
  // document cannot satisfy analysis, storyboard and prompts simultaneously.
  const allocated = new Map<string, Set<string>>();
  const assignedOutputs = new Map<string, string[]>();
  const reserved = new Map<string, Set<string>>();
  const allocationKey = (tool: string) =>
    STRUCTURE_DELIVERABLE_TOOLS.includes(tool) ? 'scene-structure' : tool;
  // Explicit Worker identities take precedence over historical same-kind allocation.
  // Saving storyboard before analysis must never mark analysis completed.
  const outputOwners = new Map<string, string>();
  for (const row of rows) {
    if (row.result.status !== 'task_plan_saved' || !Array.isArray(row.result.outputBindings))
      continue;
    for (const binding of row.result.outputBindings as Array<{
      outputId?: string;
      key?: string;
    }>)
      if (typeof binding.outputId === 'string' && typeof binding.key === 'string')
        outputOwners.set(binding.outputId, binding.key);
  }
  const explicitOwner = (row: (typeof rows)[number]) => {
    const operation = (
      row.result.execution as
        | {
            operationKey?: string;
          }
        | undefined
    )?.operationKey;
    const outputId = operation?.match(/^output:([^:]+):\d+$/)?.[1];
    return outputId ? outputOwners.get(outputId) : undefined;
  };
  // begin binds the stage; later pages use its real ID, not the original outputId.
  // Preserve that binding when pages/finalize create actual scene resources.
  const stageOwners = new Map<string, string>();
  for (const row of rows) {
    const owner = explicitOwner(row);
    if (
      owner &&
      row.tool_name === 'scene.structure.stage' &&
      typeof row.result.stageId === 'string'
    )
      stageOwners.set(row.result.stageId, owner);
  }
  const rowOwner = (row: (typeof rows)[number]) =>
    explicitOwner(row) ??
    (row.tool_name === 'scene.structure.stage' && typeof row.result.stageId === 'string'
      ? stageOwners.get(row.result.stageId)
      : undefined);
  // Ownership is a property of the persisted resource, not just its latest
  // receipt. A CAS edit cannot turn a storyboard into the missing analysis.
  const resourceOwners = new Map<string, string>();
  for (const row of rows) {
    const owner = rowOwner(row);
    if (!owner) continue;
    const ids = isDocumentDeliveryTool(row.tool_name)
      ? [row.result.documentId]
      : isStructureTool(row.tool_name)
        ? row.result.sceneIds
        : savedIds(row.result);
    if (Array.isArray(ids))
      for (const id of ids)
        if (typeof id === 'string')
          resourceOwners.set(`${allocationKey(row.tool_name)}:${id}`, owner);
  }
  for (const item of deliverables) {
    const key = allocationKey(item.toolName);
    const ids = reserved.get(key) ?? new Set<string>();
    for (const id of item.targetIds ?? []) ids.add(id);
    reserved.set(key, ids);
  }
  const pending = deliverables.flatMap((item) => {
    const saved = new Set<string>();
    // Persistence and validation are independent. An invalid binding needs an
    // in-place repair, not another copy of an already committed scene/shot.
    const persisted = new Set<string>();
    const invalidReferences = new Map<
      string,
      {
        outputId: string;
        shotId: string;
      }
    >();
    for (const row of rows) {
      if (item.intent === 'reuse' || item.intent === 'verify') continue;
      const createdShots =
        ['scene.update_shot_prompts', 'scene.update_shot_timings'].includes(item.toolName) &&
        isStructureTool(row.tool_name) &&
        isSavedStructureStatus(row.result.status);
      if (
        (row.tool_name !== item.toolName &&
          !(isStructureTool(row.tool_name) && isStructureTool(item.toolName)) &&
          !createdShots) ||
        row.result.error
      )
        continue;
      const owner = rowOwner(row);
      if (owner && owner !== item.key && !item.targetIds?.length && !createdShots) continue;
      const belongsToItem = (id: string) => {
        const resourceOwner = resourceOwners.get(`${allocationKey(item.toolName)}:${id}`) ?? owner;
        return (
          !resourceOwner ||
          resourceOwner === item.key ||
          createdShots ||
          item.targetIds?.includes(id)
        );
      };
      if (isDocumentDeliveryTool(item.toolName)) {
        const result = row.result;
        if (
          result.status !== 'draft_saved' ||
          typeof result.documentId !== 'string' ||
          typeof result.documentVersionId !== 'string'
        )
          continue;
        const doc = db
          .prepare(
            `SELECT d.kind FROM documents d JOIN document_versions v ON v.document_id=d.id
          WHERE d.id=? AND d.project_id=? AND v.id=? AND d.current_version_id=v.id AND d.lifecycle_status='active'`,
          )
          .get(result.documentId, projectId, result.documentVersionId) as
          | {
              kind: string;
            }
          | undefined;
        if (
          doc &&
          belongsToItem(result.documentId) &&
          (!item.documentKind || doc.kind === item.documentKind)
        ) {
          persisted.add(result.documentId);
          saved.add(result.documentId);
        }
      } else if (STRUCTURE_DELIVERABLE_TOOLS.includes(item.toolName)) {
        // Staging/checkpoint acknowledgements do not prove persisted scene outputs.
        // Partial saves count only the IDs actually committed by the Worker.
        if (!isSavedStructureStatus(row.result.status)) continue;
        const sceneIds = Array.isArray(row.result.sceneIds) ? row.result.sceneIds : [];
        const shotIds = new Set(Array.isArray(row.result.shotIds) ? row.result.shotIds : []);
        for (const id of sceneIds) {
          if (
            typeof id !== 'string' ||
            !belongsToItem(id) ||
            !db
              .prepare('SELECT id FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL')
              .get(id, projectId)
          )
            continue;
          const shots = db
            .prepare('SELECT id,bindings_json FROM shots WHERE scene_id=? AND archived_at IS NULL')
            .all(id) as Array<{
            id: string;
            bindings_json: string | null;
          }>;
          if (shots.length && shots.every((shot) => shotIds.has(shot.id))) {
            persisted.add(id);
            const invalid = item.requireReferences
              ? shots.filter((shot) => !validReferences(db, projectId, shot.bindings_json))
              : [];
            for (const shot of invalid)
              invalidReferences.set(shot.id, { outputId: id, shotId: shot.id });
            if (!invalid.length) saved.add(id);
          }
        }
      } else {
        const expectedStatus =
          item.toolName === 'scene.update_shot_prompts'
            ? 'shot_prompts_saved'
            : 'shot_timings_saved';
        if (!createdShots && row.result.status !== expectedStatus) continue;
        const ids = createdShots
          ? (Array.isArray(row.result.shotIds) ? row.result.shotIds : []).filter(
              (id): id is string => typeof id === 'string',
            )
          : savedIds(row.result);
        for (const id of ids) {
          if (!belongsToItem(id)) continue;
          const shot = db
            .prepare(
              `SELECT s.scene_id,s.prompt,s.timing_json,s.bindings_json FROM shots s JOIN scenes c ON c.id=s.scene_id
               WHERE s.id=? AND c.project_id=? AND s.archived_at IS NULL AND c.archived_at IS NULL`,
            )
            .get(id, projectId) as
            | {
                scene_id: string;
                prompt: string | null;
                timing_json: string | null;
                bindings_json: string | null;
              }
            | undefined;
          if (createdShots) {
            if (
              !shot ||
              !Array.isArray(row.result.sceneIds) ||
              !row.result.sceneIds.includes(shot.scene_id)
            )
              continue;
            try {
              const timing: unknown = JSON.parse(shot.timing_json ?? 'null');
              if (item.toolName === 'scene.update_shot_timings') {
                if (!timing) continue;
                validateProductionTiming(timing);
              } else if (typeof shot.prompt !== 'string' || !shot.prompt.trim()) continue;
            } catch {
              continue;
            }
          }
          if (shot) {
            persisted.add(id);
            if (!item.requireReferences || validReferences(db, projectId, shot.bindings_json))
              saved.add(id);
            else invalidReferences.set(id, { outputId: id, shotId: id });
          }
        }
      }
    }
    const unreadTargetIds: string[] = [];
    if (item.intent === 'reuse' || item.intent === 'verify' || item.intent === 'revise') {
      const reads = taskId ? taskArtifactReads(db, projectId, taskId) : [];
      for (const id of item.targetIds ?? []) {
        const ids = isStructureTool(item.toolName)
          ? (
              db
                .prepare('SELECT id FROM shots WHERE scene_id=? AND archived_at IS NULL')
                .all(id) as Array<{
                id: string;
              }>
            ).map((s) => s.id)
          : [id];
        const artifacts = ids.map((target) =>
          currentTaskArtifact(
            db,
            projectId,
            target,
            isDocumentDeliveryTool(item.toolName) ? 'document' : 'shot',
          ),
        );
        const exists = artifacts.length > 0 && artifacts.every((a) => Boolean(a));
        const completeRead = exists && artifacts.every((a) => hasCurrentRead(a!, reads));
        if (item.intent !== 'revise' && exists) {
          persisted.add(id);
          const refsValid =
            !item.requireReferences ||
            ids.every((shotId) =>
              validReferences(
                db,
                projectId,
                (
                  db.prepare('SELECT bindings_json FROM shots WHERE id=?').get(shotId) as {
                    bindings_json: string;
                  }
                ).bindings_json,
              ),
            );
          if (completeRead && refsValid) saved.add(id);
          else if (!refsValid)
            for (const shotId of ids) invalidReferences.set(shotId, { outputId: id, shotId });
        }
        if (!completeRead) unreadTargetIds.push(id);
        if (
          item.intent === 'revise' &&
          (!completeRead ||
            currentTargetVersion(
              db,
              projectId,
              id,
              isDocumentDeliveryTool(item.toolName)
                ? 'document'
                : isStructureTool(item.toolName)
                  ? 'scene'
                  : 'shot',
            ) === item.baselineVersions?.[id])
        )
          saved.delete(id);
      }
    }
    const missingTargetIds = item.targetIds?.filter((id) => !saved.has(id)) ?? [];
    const missingPersistedTargetIds = item.targetIds?.filter((id) => !persisted.has(id)) ?? [];
    const key = allocationKey(item.toolName);
    const used = allocated.get(key) ?? new Set<string>();
    const candidates = [...persisted].filter((id) => !used.has(id) && !reserved.get(key)?.has(id));
    // Known IDs pin mandatory outputs; a partial list must not hide later
    // committed outputs in the same minimum-count group. Explicitly shared
    // targets remain shareable; additional outputs are allocated only once.
    const pinned = item.targetIds?.filter((id) => persisted.has(id)) ?? [];
    const additional = candidates.slice(
      0,
      Math.max(0, item.minimumCount - (item.targetIds?.length ?? 0)),
    );
    const assigned = [...pinned, ...additional];
    assignedOutputs.set(item.key, assigned);
    const savedCount = assigned.filter((id) => saved.has(id)).length;
    const persistedCount = assigned.length;
    const repairOutputs = [...invalidReferences.values()]
      .filter(({ outputId }) => assigned.includes(outputId))
      .map((output) => ({
        ...output,
        reason:
          'Required references are empty, missing, or do not identify active documents of the matching type.',
        tool: 'production.read',
        arguments: { target: { kind: 'shot', id: output.shotId }, view: 'authoring' },
      }));
    for (const id of additional) used.add(id);
    allocated.set(key, used);
    const textTargets = item.targetIds ? assigned : candidates;
    const texts = item.requiredTexts?.length
      ? currentOutputTexts(db, projectId, item, textTargets)
      : [];
    const missingTexts =
      item.requiredTexts?.filter((text) => !texts.some((body) => body.includes(text))) ?? [];
    const allocatedElsewhere = !item.targetIds
      ? [...persisted].filter((id) => !candidates.includes(id))
      : [];
    // An explicit target group can reserve all already saved outputs from a
    // later unbound review entry. Resolve that identity ambiguity before asking
    // for business writes; ordinary independent unbound work still continues.
    const needsPlanRepair =
      persistedCount < item.minimumCount &&
      allocatedElsewhere.some((id) => reserved.get(key)?.has(id));
    const otherDocumentKinds =
      isDocumentDeliveryTool(item.toolName) && item.documentKind
        ? [...savedDocuments].filter(([, kind]) => kind !== item.documentKind)
        : [];
    return savedCount >= item.minimumCount && !missingTargetIds.length && !missingTexts.length
      ? []
      : [
          {
            ...item,
            savedCount,
            persistedCount,
            remainingCount: Math.max(0, item.minimumCount - persistedCount),
            missingTargetIds,
            ...(unreadTargetIds.length ? { unreadTargetIds } : {}),
            ...(repairOutputs.length ? { repairRequired: true, repairOutputs } : {}),
            countUnit: isStructureTool(item.toolName)
              ? 'scenes'
              : isDocumentDeliveryTool(item.toolName)
                ? 'documents'
                : 'shots',
            planRevision:
              'Correct model estimates on the same key with revisionReason; counts use countUnit. Preserve registered user intent and requirement sources. A create obligation stays create after saving: bind real targetIds and follow the current phase, without recreating outputs. reuse/verify describe work that was already existing when that obligation was first registered, not a transition after creation. persistedCount is saved identity count; savedCount also checks final obligations such as bindings. remainingCount=0 does not mean review or binding passed. Explicit model_inference assumptions may be revised with evidence; a requested revision still needs a changed version and current readback.',
            nextAction: needsPlanRepair
              ? {
                  kind: 'repair_plan',
                  toolName: 'conversation.task.checkpoint',
                  instruction:
                    'Outputs in allocatedElsewhere already exist and are explicitly assigned to another plan entry. Compare this entry with the original requirements and existing plan before creating or rewriting business outputs. If it describes the same saved work, use operation=plan on this existing key and bind the real shared targetIds, preserving requiredTexts and references. If it requires independent work, continue only those genuinely additional outputs. Plan registration does not save business work or satisfy missing text; recheck the current outputs after correcting allocation.',
                }
              : unreadTargetIds.length && ['reuse', 'verify'].includes(item.intent ?? '')
                ? {
                    kind: 'read_outputs',
                    targetIds: unreadTargetIds,
                    instruction:
                      'Read the current complete versions of these existing targets. Do not create or rewrite outputs to obtain a receipt.',
                  }
                : persistedCount < item.minimumCount || missingPersistedTargetIds.length
                  ? {
                      kind: 'continue_outputs',
                      toolName: item.toolName,
                      instruction:
                        'Continue the unfinished outputs in source order. Resume the existing incomplete stage for structure work and preserve saved IDs. missingTexts measures the whole deliverable so far; place each line in its appropriate remaining scene/shot, never insert later scenes into an earlier saved scene just to clear this list. Review the full set after the missing outputs are saved.',
                    }
                  : repairOutputs.length
                    ? {
                        kind: 'repair_outputs',
                        toolName: 'scene.update_shot_prompts',
                        instruction:
                          'The outputs already exist. Follow repairOutputs to read each real shot and its current rowVersion, then repair bindings in place with scene.update_shot_prompts and expectedRowVersion. Preserve prompt text, timing, saved scene/shot IDs and source order. Active draft material documents are valid references; copy exact documentId values from saved receipts or project.structure.read (workspace=characters, kind=document, documentKind identifies character/scene/prop). A rejected ID does not mean drafts are unsupported. Do not remove required bindings or recreate scenes/shots to obtain new receipts.',
                      }
                    : missingTexts.length
                      ? {
                          kind: 'repair_outputs',
                          obligationKey: item.key,
                          planChangeRequired: false,
                          toolName: isDocumentDeliveryTool(item.toolName)
                            ? item.toolName
                            : 'scene.update_shot_prompts',
                          targetIds: textTargets.flatMap((id) =>
                            isStructureTool(item.toolName)
                              ? (
                                  db
                                    .prepare(
                                      'SELECT id FROM shots WHERE scene_id=? AND archived_at IS NULL',
                                    )
                                    .all(id) as Array<{
                                    id: string;
                                  }>
                                ).map((shot) => shot.id)
                              : [id],
                          ),
                          instruction:
                            'Repair the missing text in the relevant existing outputs under this original obligation. The plan records the required outcome, not a restriction to its original creation tool. No new plan, key, intent change or additional deliverable is needed for this repair. Read the relevant current complete authoring and CAS, select the proper targets from targetIds, then edit them in place with the indicated tool. Preserve all original criteria, required references, source order, speakers and saved IDs. Do not recreate outputs or rewrite unaffected content. Recheck this same obligation after saving.',
                        }
                      : {
                          kind: 'review_outputs',
                          instruction:
                            'The required output count is saved. Read the relevant current outputs and correct missing text in the proper scene/shot with current CAS, preserving source order, speakers and existing IDs.',
                        },
            ...(otherDocumentKinds.length
              ? {
                  savedDocumentsOfOtherKinds: otherDocumentKinds
                    .slice(0, 30)
                    .map(([documentId, kind]) => ({ documentId, kind })),
                }
              : {}),
            ...(isStructureTool(item.toolName) && persisted.size
              ? { savedSceneIds: [...persisted].slice(0, 30) }
              : {}),
            ...(allocatedElsewhere.length
              ? {
                  allocatedElsewhere,
                  planRepair:
                    'These outputs are already saved but allocated to another plan entry. Inspect the plan before creating or rewriting outputs. If both entries describe the same work, refine their targetIds to the actual shared output IDs; if they are independent, keep distinct outputs.',
                }
              : {}),
            ...(missingTexts.length ? { missingTexts } : {}),
          },
        ];
  });
  const dependencyDepth = (key: string, visited = new Set<string>()): number => {
    if (visited.has(key)) return 0; // Legacy malformed graphs never recurse forever.
    visited.add(key);
    return (
      1 +
      Math.max(
        0,
        ...(deliverables.find((item) => item.key === key)?.dependsOn ?? []).map((dependency) =>
          dependencyDepth(dependency, new Set(visited)),
        ),
      )
    );
  };
  // Evaluate after allocation, so dependency order in a model plan cannot hide facts.
  const criteriaFailures = new Map(
    deliverables.map((item) => [
      item.key,
      checkTaskCriteria(db, projectId, item, deliverables, assignedOutputs, isStructureTool),
    ]),
  );
  const resultPending = [
    ...pending.map((item) =>
      criteriaFailures.get(item.key)?.length
        ? { ...item, criteriaFailures: criteriaFailures.get(item.key), repairRequired: true }
        : item,
    ),
    ...deliverables
      .filter(
        (item) =>
          !pending.some((p) => p.key === item.key) && criteriaFailures.get(item.key)?.length,
      )
      .map((item) => ({
        ...item,
        savedCount: assignedOutputs.get(item.key)?.length ?? 0,
        persistedCount: assignedOutputs.get(item.key)?.length ?? 0,
        remainingCount: 0,
        missingTargetIds: [],
        repairRequired: true,
        criteriaFailures: criteriaFailures.get(item.key),
        countUnit: isStructureTool(item.toolName)
          ? 'scenes'
          : isDocumentDeliveryTool(item.toolName)
            ? 'documents'
            : 'shots',
        planRevision:
          'Preserve confirmed criteria. Correct only explicit model inferences with revisionReason; do not weaken user obligations.',
        planRepair: undefined,
        missingTexts: undefined,
        nextAction: {
          kind: 'repair_outputs',
          instruction:
            'Saved IDs already exist. Inspect criteriaFailures against current source facts, then repair only affected outputs in place with current CAS. Numeric checks and exact projections cannot be approved by a semantic review or cleared by a no-op write.',
        },
      })),
  ];
  resultPending.sort((a, b) => dependencyDepth(a.key) - dependencyDepth(b.key));
  return {
    pending: resultPending,
    assignedOutputs,
    ...(typeof partialReason === 'string' && (!deliverables.length || resultPending.length)
      ? { partialReason }
      : {}),
  };
}
/** Combine optional model planning with the independently frozen task contract. */
export function assessTaskCompletion(
  db: Database.Database,
  projectId: string,
  generationId: string,
  taskId: string,
):
  | {
      pending: Array<Record<string, unknown>>;
      partialReason?: string;
    }
  | undefined {
  if (isBundleTask(db, taskId)) return { pending: bundleCompletion(db, projectId, taskId) };
  const planned = assessTaskDeliverables(db, projectId, generationId, taskId);
  if (!planned) return undefined;
  const pending = planned.pending;
  const partial = planned?.partialReason
    ? audit(db, projectId, generationId)
        .filter((row) => row.result.status === 'task_partial_reported')
        .at(-1)?.result
    : undefined;
  const blocker =
    typeof partial?.blockedByCallId === 'string'
      ? new AgentContextStore(db).resultForCall(projectId, taskId, partial.blockedByCallId)
      : undefined;
  return {
    pending,
    ...(planned?.partialReason && (!pending.length || isNonRetryableBlocker(blocker))
      ? { partialReason: planned.partialReason }
      : {}),
  };
}
function isNonRetryableBlocker(result?: StoredToolResult): boolean {
  if (result?.status !== 'failed') return false;
  try {
    const value = JSON.parse(result.content) as {
      error?: {
        retryable?: unknown;
      };
    };
    return value.error?.retryable === false;
  } catch {
    return false;
  }
}
/** Any outstanding output or check is work, not proof of an execution blocker. */
export function assertTaskPartialAllowed(
  progress:
    | {
        pending: Array<Record<string, unknown>>;
      }
    | undefined,
  blockingResult?: StoredToolResult,
): void {
  if (!progress?.pending.length) return;
  if (isNonRetryableBlocker(blockingResult)) return;
  throw new Error(
    `TASK_REPAIR_REQUIRED: ${JSON.stringify(progress.pending)}. Missing text or required readback is unfinished work, not a partial-completion blocker. Follow each pending nextAction: repair_plan reconciles saved output identities with the existing plan before business writes; continue_outputs finishes missing outputs first; repair_outputs fixes listed persisted shots in place; review_outputs checks relevant saved text with current CAS. persistedCount includes outputs needing repair; savedCount counts validated outputs. Do not recreate existing outputs. Keep each line in its proper scene/shot and source order. Load a required tool only when its schema is absent; loading needs no user continuation. A genuine non-retryable tool failure may be referenced with blockedByCallId.`,
  );
}
