import { contextContentHash, type StoredToolResult } from '@ai-video/persistence';

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
  if (
    result.content.length <= maxInlineCharacters &&
    (result.toolName !== 'tools.load' || result.status === 'failed')
  )
    return result.content;
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
  return JSON.stringify({
    ...fields,
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
  });
}
