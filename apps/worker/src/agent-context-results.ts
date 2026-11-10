import { contextContentHash, type StoredToolResult } from '@ai-video/persistence';
import { AgentToolPolicyError, unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { BUNDLE_PROMPT_READ_VIEW, BUNDLE_SOURCE_READ_VIEW } from './production-bundle-schema.js';

/** History and the current read working set must not carry the same candidate page twice. */
export function projectBundleReadResult(
  result: StoredToolResult,
  currentHashes: Map<string, string>,
  retainedPages: unknown[],
): string | undefined {
  if (result.status !== 'completed' || result.toolName !== 'production.bundle') return;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
    return;
  }
  if (value?.status === 'bundle_source_read' && value.view !== BUNDLE_SOURCE_READ_VIEW)
    return JSON.stringify({
      status: 'source_page_superseded',
      documentId: value.documentId,
      instruction:
        'Read the current ordinary source view. Historical encoded pages remain archived.',
    });
  if (!['bundle_candidate_read', 'bundle_candidates_read'].includes(String(value?.status))) return;
  if (!fitsResult(value)) return;
  if (value.status === 'bundle_candidates_read' && !Array.isArray(value.reads)) return;
  const identity = (page: Record<string, unknown>) =>
    JSON.stringify([page.localKey, page.hash, page.contentPage]);
  const retained = new Set(retainedPages.map((page) => identity(page as Record<string, unknown>)));
  const project = (page: Record<string, unknown>) => {
    const currentHash = currentHashes.get(String(page.localKey));
    if (!currentHash) return page;
    const stale = currentHash !== page.hash || page.view !== BUNDLE_PROMPT_READ_VIEW;
    if (!stale && !retained.has(identity(page))) return page;
    return {
      status: stale ? 'candidate_page_superseded' : 'candidate_page_included',
      localKey: page.localKey,
      hash: page.hash,
      instruction: stale
        ? 'Historical page superseded. Read the current candidate if needed; this page remains in Result Store.'
        : 'This exact page is already in taskState.workingData. Use it there without rereading.',
    };
  };
  return JSON.stringify(
    value.status === 'bundle_candidates_read'
      ? { ...value, reads: (value.reads as Record<string, unknown>[]).map(project) }
      : project(value),
  );
}

/** Deduplicate only exact text already supplied in this request. The stored result is immutable. */
export function projectTaskStateResult(
  result: StoredToolResult,
  currentPrompt: string,
  currentPending?: unknown[],
): string {
  if (
    result.status === 'failed' ||
    result.toolName !== 'conversation.task.checkpoint' ||
    (result.arguments as Record<string, unknown>)?.operation !== 'state'
  )
    return result.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return result.content;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).status !== 'task_state_read' ||
    !Array.isArray((parsed as Record<string, unknown>).records)
  )
    return result.content;
  const value = parsed as Record<string, unknown>;
  const reference = (text: unknown) =>
    typeof text === 'string' && text.length > 0 && currentPrompt.includes(text)
      ? { alreadyIncluded: 'current_user_request', contentHash: contextContentHash(text) }
      : undefined;
  const goalReference = reference(value.taskGoal);
  const records = Array.isArray(value.records)
    ? value.records.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const record = item as Record<string, unknown>;
        if (record.kind !== 'userRequirement') return record;
        const included = reference(record.text);
        if (!included) return record;
        const metadata = { ...record };
        delete metadata.text;
        return { ...metadata, ...included };
      })
    : value.records;
  return JSON.stringify({
    ...value,
    ...(goalReference ? { taskGoal: undefined, taskGoalReference: goalReference } : {}),
    ...(currentPending
      ? { pendingActions: undefined, pendingActionsReference: 'taskState.pendingSteps' }
      : {}),
    records:
      currentPending && Array.isArray(records)
        ? records.filter((item: Record<string, unknown>) => item.kind !== 'pending')
        : records,
    originalResult: {
      resultId: result.id,
      contentHash: result.contentHash,
      instruction:
        'Archive reference only. Requirements already included in the current user request need no additional result read. Use the state records below for task progress.',
    },
  });
}

/** Persisted contracts remain complete; identical fields need appear only once per request. */
export function projectTaskPending(
  pending: unknown[],
  contracts: Array<{ key: string }>,
): unknown[] {
  const byKey = new Map(contracts.map((item) => [item.key, item as Record<string, unknown>]));
  return pending.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const value = item as Record<string, unknown>,
      contract = byKey.get(String(value.key));
    if (!contract) return value;
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, content]) =>
          key === 'key' ||
          !(key in contract) ||
          JSON.stringify(content) !== JSON.stringify(contract[key]),
      ),
    );
  });
}

export function savedArtifactReceipt(result: StoredToolResult): Record<string, unknown> {
  const value = JSON.parse(result.content) as Record<string, unknown>;
  return Object.fromEntries(
    [
      'status',
      'documentId',
      'documentVersionId',
      'documentRowVersion',
      'resourceId',
      'sceneId',
      'sceneIds',
      'shotIds',
      'stageId',
      'rowVersion',
      'missingShots',
      'execution',
    ]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

/** Small receipts remain wire-compatible; large bodies have an explicit range-read contract. */
export function modelResultReceipt(result: StoredToolResult, maxInlineCharacters = 6000): string {
  // Range reads are already bounded. A receipt for a range creates recursive
  // paging instead of delivering the requested text and its next cursor.
  if (
    ['production.bundle', 'conversation.task.checkpoint'].includes(result.toolName) &&
    Buffer.byteLength(result.content) <= 48 * 1024
  ) {
    let page: Record<string, unknown> = {};
    try {
      page = JSON.parse(result.content) as Record<string, unknown>;
    } catch {
      /* Historical opaque results use the ordinary receipt path. */
    }
    if (
      page &&
      (result.toolName === 'production.bundle'
        ? ['bundle_source_read', 'bundle_candidate_read', 'bundle_candidates_read'].includes(
            String(page.status),
          )
        : page.status === 'task_result_read') &&
      fitsResult(page)
    )
      return result.content;
  }
  if (
    result.content.length <= maxInlineCharacters &&
    (result.toolName !== 'tools.load' || result.status === 'failed')
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      // Historical opaque errors remain readable through the existing path.
      return result.content;
    }
    if (fitsResult(parsed)) return result.content;
  }
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(result.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>;
  } catch {
    /* opaque complete data is still readable */
  }
  const fields = Object.fromEntries(
    Object.entries(value).filter(
      ([key, v]) =>
        ![
          'content',
          'contentMarkdown',
          'text',
          'instructions',
          'resultJson',
          'prompt',
          'dataUrl',
        ].includes(key) &&
        ((['names', 'loaded', 'newlyLoaded', 'reused'].includes(key) &&
          Array.isArray(v) &&
          v.length <= 64 &&
          v.every((item) => typeof item === 'string' && item.length <= 128)) ||
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          v === null ||
          (typeof v === 'string' && v.length <= 256)),
    ),
  );
  // These are decision facts, not large working bodies. Keep them on the model path.
  for (const key of [
    'execution',
    'error',
    'sceneIds',
    'shotIds',
    'missing',
    'pending',
    'legacyOutputs',
    'pendingActions',
    'reviewedTargetIds',
    'rejectedTargetIds',
    'assessmentErrors',
    'inspectionSummary',
    'historyPage',
  ])
    if (value[key] !== undefined) fields[key] = value[key];
  if (value.status === 'task_review_recorded') {
    // Keep actionable issue identities on the model path even when citations
    // externalize the full assessment. Full evidence remains range-readable.
    if (Array.isArray(value.issues))
      fields.issues = value.issues.map((item: Record<string, unknown>) => ({
        issueId: item.issueId,
        targetId: item.targetId,
        targetVersion: item.targetVersion,
        category: item.category,
        description: item.description,
        evidenceStatus: item.evidenceStatus,
        evidenceError: item.evidenceError,
      }));
    if (Array.isArray(value.resolutions))
      fields.resolutions = value.resolutions.map((item: Record<string, unknown>) => ({
        issueId: item.issueId,
        disposition: item.disposition,
        reason: item.reason,
      }));
  }
  if (Array.isArray(value.shots))
    fields.shots = value.shots.map((shot: unknown) => {
      if (!shot || typeof shot !== 'object') return shot;
      const item = shot as Record<string, unknown>;
      return Object.fromEntries(
        ['shotId', 'sceneId', 'rowVersion', 'changed', 'error', 'status']
          .filter((k) => item[k] !== undefined)
          .map((k) => [k, item[k]]),
      );
    });
  if (value.savedResult && typeof value.savedResult === 'object') {
    const saved = value.savedResult as Record<string, unknown>;
    fields.savedResult = Object.fromEntries(
      [
        'status',
        'documentId',
        'documentVersionId',
        'documentRowVersion',
        'resourceId',
        'sceneIds',
        'execution',
      ]
        .filter((k) => saved[k] !== undefined)
        .map((k) => [k, saved[k]]),
    );
    if (Array.isArray(saved.shots))
      (fields.savedResult as Record<string, unknown>).shots = saved.shots.map(
        (shot: Record<string, unknown>) =>
          Object.fromEntries(
            ['shotId', 'sceneId', 'rowVersion', 'changed', 'error', 'status']
              .filter((k) => shot[k] !== undefined)
              .map((k) => [k, shot[k]]),
          ),
      );
  }
  if (
    result.toolName === 'project.structure.get' &&
    value.resourceMap &&
    typeof value.resourceMap === 'object'
  ) {
    const map = value.resourceMap as Record<string, unknown>;
    const resources = Array.isArray(map.resources)
      ? (map.resources as Array<Record<string, unknown>>)
          .slice(0, 30)
          .map(({ id, kind, title, locator, writeTool }) => ({
            id,
            kind,
            title,
            locator,
            writeTool,
          }))
      : [];
    fields.resourceMap = {
      version: map.version,
      projectId: map.projectId,
      projectName: map.projectName,
      revision: map.revision,
      resources,
    };
  }
  if (result.toolName === 'tools.load' && value.status === 'tools_loaded')
    return JSON.stringify({
      ...fields,
      resultId: result.id,
      status: 'tools_loaded',
      instruction:
        'Listed tools are ready. Active policies are already included in system instructions; continue the business task without rereading this policy receipt.',
    });
  // Decision facts can themselves exceed a collection or byte limit. Defer
  // entire fields with an explicit pointer to the complete immutable result;
  // never return a silently truncated assessment or drop its durable evidence.
  const externalizedFields: string[] = [];
  for (const [key, value] of Object.entries(fields))
    if (!fitsResult({ [key]: value })) {
      delete fields[key];
      externalizedFields.push(key);
    }
  const receipt = {
    status: value.status ?? result.status,
    resultId: result.id,
    resultVersion: result.version,
    contentHash: result.contentHash,
    totalCharacters: result.content.length,
    externalized: true,
    read: {
      tool: 'conversation.task.checkpoint',
      operation: 'result',
      resultId: result.id,
      expectedHash: result.contentHash,
      resultOffset: 0,
      resultLimit: 4096,
    },
    instruction:
      'Complete immutable result is persisted. Read only needed ranges with operation=result; concatenate pages before parsing JSON. Do not repeat the original business call to recover this data.',
  };
  const output = () => ({
    ...fields,
    ...receipt,
    ...(externalizedFields.length ? { externalizedFields } : {}),
  });
  for (const [key] of Object.entries(fields).sort(
    ([, a], [, b]) => JSON.stringify(b).length - JSON.stringify(a).length,
  )) {
    if (fitsResult(output())) break;
    delete fields[key];
    externalizedFields.push(key);
  }
  return unifiedAgentToolRegistry.serializeResult(output());
}

function fitsResult(value: unknown): boolean {
  try {
    unifiedAgentToolRegistry.assertResultValue(value);
    return true;
  } catch (error) {
    if (!(error instanceof AgentToolPolicyError) || error.code !== 'AGENT_TOOL_RESULT_TOO_LARGE')
      throw error;
    return false;
  }
}
