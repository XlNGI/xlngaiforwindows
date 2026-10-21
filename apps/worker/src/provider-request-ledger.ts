import type Database from 'better-sqlite3';
import type {
  LlmGenerationIdentity,
  LlmPricingSnapshotInfo,
  LlmRequestUsageInfo,
  LlmUsageAccounting,
  NormalizedLlmUsage,
} from '@ai-video/contracts';
import { calculateEstimatedCost } from './usage-cost.js';

const terminalStages = new Set(['complete', 'failed', 'cancelled']);
const metadataKeys = [
  'inputHash',
  'inputBytes',
  'toolCount',
  'inferenceSettings',
  'argumentBytes',
  'toolName',
  'receivedBytes',
  'finishReason',
  'errorCode',
  'requestBodyHash',
  'requestBodyBytes',
  'purpose',
  'context',
] as const;

type RequestRow = {
  id: string;
  stage: string;
  created_at: string;
  completed_at: string | null;
  metadata_json: string;
};
type RequestMetadata = Record<string, unknown> & {
  requestKind?: 'model';
  firstSeen?: Record<string, string>;
  usage?: NormalizedLlmUsage;
  purpose?: LlmRequestUsageInfo['purpose'];
  context?: LlmRequestUsageInfo['context'];
};

/** Existing local request JSON stores only normalized numbers and bounded diagnostics, never bodies. */
export function updateModelRequest(
  database: Database.Database,
  identity: LlmGenerationIdentity,
  requestId: string,
  stage: string,
  metadata: Record<string, unknown>,
  usage?: NormalizedLlmUsage,
): boolean {
  const owner = database
    .prepare(
      `SELECT g.status FROM llm_generations g
    JOIN llm_generation_attempts a ON a.generation_id=g.id
    WHERE g.id=? AND a.id=? AND g.project_id=? AND g.project_session_id=? AND g.conversation_id=?`,
    )
    .get(
      identity.generationId,
      identity.attemptId,
      identity.projectId,
      identity.projectSessionId,
      identity.conversationId,
    );
  if (!owner) return false;
  const row = database.prepare('SELECT * FROM llm_provider_requests WHERE id=?').get(requestId) as
    | (RequestRow & { generation_id: string; attempt_id: string; project_session_id: string })
    | undefined;
  if (
    row &&
    (row.generation_id !== identity.generationId ||
      row.attempt_id !== identity.attemptId ||
      row.project_session_id !== identity.projectSessionId)
  )
    throw new Error('Provider request belongs to another generation.');
  const previous = JSON.parse(row?.metadata_json ?? '{}') as RequestMetadata;
  const now = new Date().toISOString();
  const next: RequestMetadata = {
    ...previous,
    requestKind: 'model',
    firstSeen: { ...previous.firstSeen },
  };
  // Usage can arrive after cancellation; it must not reopen the request.
  const nextStage = row && terminalStages.has(row.stage) ? row.stage : stage;
  next.firstSeen![stage] ??= now;
  for (const key of metadataKeys)
    if (metadata[key] !== undefined) (next as Record<string, unknown>)[key] = metadata[key];
  if (usage) {
    const safeUsage = { ...usage };
    delete safeUsage.raw;
    next.usage = {
      ...previous.usage,
      ...Object.fromEntries(Object.entries(safeUsage).filter(([, value]) => value !== undefined)),
    };
  }
  const serialized = JSON.stringify(next);
  if (serialized.length > 16000) throw new Error('Provider request accounting exceeds limit.');
  if (row?.metadata_json === serialized && row.stage === nextStage) return false;
  database
    .prepare(
      `INSERT INTO llm_provider_requests
    (id,project_id,generation_id,attempt_id,project_session_id,stage,created_at,updated_at,completed_at,metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,
    updated_at=excluded.updated_at,completed_at=excluded.completed_at,metadata_json=excluded.metadata_json`,
    )
    .run(
      requestId,
      identity.projectId,
      identity.generationId,
      identity.attemptId,
      identity.projectSessionId,
      nextStage,
      row?.created_at ?? now,
      now,
      row?.completed_at ?? (terminalStages.has(nextStage) ? now : null),
      serialized,
    );
  return true;
}

export function readRequestAccounting(
  database: Database.Database,
  identity: LlmGenerationIdentity,
  pricing?: LlmPricingSnapshotInfo,
): LlmUsageAccounting {
  const rows = database
    .prepare(
      `SELECT * FROM llm_provider_requests
    WHERE generation_id=? AND attempt_id=? AND project_id=? AND project_session_id=? ORDER BY created_at,id`,
    )
    .all(
      identity.generationId,
      identity.attemptId,
      identity.projectId,
      identity.projectSessionId,
    ) as RequestRow[];
  const requests: LlmRequestUsageInfo[] = [];
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json) as RequestMetadata;
    if (metadata.requestKind !== 'model') continue;
    const usage = metadata.usage;
    requests.push({
      requestId: row.id,
      stage: row.stage,
      purpose: metadata.purpose ?? 'continuation',
      dispatched: metadata.firstSeen?.dispatching !== undefined || usage !== undefined,
      sent: metadata.firstSeen?.sent !== undefined,
      startedAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      usage,
      usageSource: usage ? 'provider_reported' : undefined,
      coverage:
        usage?.inputTokens !== undefined && usage.outputTokens !== undefined
          ? 'complete'
          : usage
            ? 'partial'
            : 'unknown',
      estimatedCost: calculateEstimatedCost(usage, pricing),
      currency: pricing?.currency,
      context: metadata.context,
    });
  }
  const dispatched = requests.filter((request) => request.dispatched);
  const reported = dispatched.filter((request) => request.usage);
  const complete = reported.filter((request) => request.coverage === 'complete');
  const cacheReported = reported.filter(
    (request) =>
      request.usage?.inputTokens !== undefined &&
      request.usage.cachedInputTokens !== undefined &&
      request.usage.cachedInputTokens <= request.usage.inputTokens,
  );
  const priced = reported.filter((request) => request.estimatedCost !== undefined);
  return {
    version: 1,
    generationId: identity.generationId,
    conversationId: identity.conversationId,
    requests,
    requestCount: dispatched.length,
    reportedRequests: reported.length,
    completeRequests: complete.length,
    coverage:
      dispatched.length && complete.length === dispatched.length
        ? 'complete'
        : reported.length
          ? 'partial'
          : 'unknown',
    cacheInputTokens: cacheReported.reduce((sum, request) => sum + request.usage!.inputTokens!, 0),
    cacheReadTokens: cacheReported.reduce(
      (sum, request) => sum + request.usage!.cachedInputTokens!,
      0,
    ),
    cacheReportedRequests: cacheReported.length,
    estimatedCostCoverage: !priced.length
      ? 'unknown'
      : complete.length === dispatched.length &&
          priced.length === dispatched.length &&
          (pricing?.cachedInputPrice === undefined || cacheReported.length === dispatched.length)
        ? 'complete'
        : 'partial',
  };
}
