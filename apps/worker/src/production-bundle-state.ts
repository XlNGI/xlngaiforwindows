import type Database from 'better-sqlite3';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import { estimateTokenCount } from '@ai-video/context';
import {
  PRODUCTION_BUNDLE_LIMITS,
  productionWorkflowVersion,
  validateProductionBundleSources,
  validateProductionBundleManifest,
  validateProductionBundlePart,
  type ProductionBundlePart,
  type ProductionBundleManifest,
  type ProductionBundleSource,
} from '@ai-video/contracts';
import type { ContextRecoverySnapshot } from './agent-context-manager.js';
import {
  bundlePromptReadText,
  bundlePromptIdentity,
  BUNDLE_PROMPT_READ_VIEW,
  BUNDLE_SOURCE_READ_VIEW,
} from './production-bundle-schema.js';
export type BundleEntry = {
  key: string;
  kind: 'document' | 'scene' | 'shot';
  resultId: string;
  hash: string;
  updatedAt: string;
  providerStepId?: string;
};
export type BundleSource = ProductionBundleSource & {
  rowVersion: number;
  kind: string;
  contentHash: string;
  state: string;
};
export type BundleState = {
  bundleId: string;
  revision: number;
  sources: BundleSource[];
  reused: BundleSource[];
  requirementsHash: string;
  entries: BundleEntry[];
  manifest?: ProductionBundleManifest;
  sealedRevision?: number;
  createdAt: string;
  updatedAt: string;
  progressAt?: string;
  budget: {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    outputAllowance: number;
    outputSource: string;
    recommendedMode: 'single' | 'partitioned';
  };
};
export type BundleObject =
  | ProductionBundlePart['documents'][number]
  | ProductionBundlePart['scenes'][number]
  | ProductionBundlePart['shots'][number];
/** Candidate bodies stay in Result Store; requests receive only current key/hash references. */
export function bundleCurrentHashes(db: Database.Database, projectId: string, taskId: string) {
  if (!isBundleTask(db, taskId) || retiredBundleStatus(db, projectId, taskId))
    return new Map<string, string>();
  const state = loadBundle(db, projectId, taskId);
  return new Map(state?.entries.map((entry) => [entry.key, entry.hash]) ?? []);
}
const STATE_CALL = 'production-bundle:state';
export function bundleTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
  active = false,
) {
  const task = db
    .prepare('SELECT request_snapshot_json,status FROM agent_tasks WHERE id=? AND project_id=?')
    .get(taskId, projectId) as
    | {
        request_snapshot_json: string;
        status: string;
      }
    | undefined;
  if (!task || (active && task.status !== 'running')) throw new Error('BUNDLE_TASK_INACTIVE');
  const snapshot = JSON.parse(task.request_snapshot_json) as Record<string, unknown>;
  if (productionWorkflowVersion(snapshot) !== 2)
    throw new Error('BUNDLE_WORKFLOW_REQUIRED: this task is not script-to-media.');
  return snapshot;
}
export function isBundleTask(db: Database.Database, taskId: string): boolean {
  const row = db.prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id=?').get(taskId) as
    | {
        request_snapshot_json: string;
      }
    | undefined;
  return (
    !!row &&
    productionWorkflowVersion(JSON.parse(row.request_snapshot_json) as Record<string, unknown>) ===
      2
  );
}
export function loadBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
): BundleState | undefined {
  const result = new AgentContextStore(db).resultForCall(projectId, taskId, STATE_CALL);
  if (result?.toolName === 'production.bundle.retired')
    throw new Error(
      `BUNDLE_CANDIDATE_RETIRED: Candidate result ${result.id} preserves the original pre-rebuild package. Start a new production task and review candidates under the current prompt/binding contract. Already saved drafts retain their IDs and content.`,
    );
  return result ? (JSON.parse(result.content) as BundleState) : undefined;
}
/** Historical packages remain inspectable, but never execute the retired contract. */
export function retiredBundleStatus(db: Database.Database, projectId: string, taskId: string) {
  const result = db
    .prepare(
      'SELECT id,tool_name FROM agent_context_results WHERE project_id=? AND task_id=? AND call_id=? ORDER BY version DESC LIMIT 1',
    )
    .get(projectId, taskId, STATE_CALL) as { id: string; tool_name: string } | undefined;
  return result?.tool_name === 'production.bundle.retired'
    ? {
        key: 'production-bundle-retired',
        status: 'bundle_candidate_retired',
        resultId: result.id,
        nextAction: {
          kind: 'start_new_task',
          instruction:
            'Start a new production task and review candidates under the current prompt/binding contract. Original candidate evidence and saved drafts are preserved.',
        },
      }
    : undefined;
}
export function saveBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
  state: BundleState,
): string {
  return new AgentContextStore(db).putResult(
    projectId,
    taskId,
    STATE_CALL,
    'production.bundle.state',
    JSON.stringify(state),
  ).id;
}
export function bundleRequirements(db: Database.Database, projectId: string, taskId: string) {
  const task = new AgentContextStore(db).loadTask(projectId, taskId);
  if (!task) throw new Error('BUNDLE_CONTEXT_MISSING');
  const originals = task.userRequirements.map(({ id, text }) => ({ id, text }));
  return {
    originalRequirements: originals,
    decisions: task.confirmedDecisions,
  };
}
export function readBundleSource(
  db: Database.Database,
  projectId: string,
  source: ProductionBundleSource,
): BundleSource {
  const row = db
    .prepare(
      `SELECT d.row_version,d.kind,v.content_markdown,v.bindings_json,v.sample_text,v.state FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id WHERE d.id=? AND d.project_id=? AND d.lifecycle_status='active' AND v.id=?`,
    )
    .get(source.documentId, projectId, source.versionId) as
    | {
        row_version: number;
        kind: string;
        content_markdown: string;
        bindings_json: string | null;
        sample_text: string | null;
        state: string;
      }
    | undefined;
  if (!row)
    throw new Error(
      `BUNDLE_SOURCE_CONFLICT: ${source.documentId} current version differs or is inactive.`,
    );
  return {
    ...source,
    rowVersion: row.row_version,
    kind: row.kind,
    contentHash: contextContentHash(
      JSON.stringify([row.content_markdown, row.bindings_json, row.sample_text]),
    ),
    state: row.state,
  };
}
export function assertBundleInputs(
  db: Database.Database,
  projectId: string,
  taskId: string,
  state: BundleState,
): void {
  for (const source of [...state.sources, ...state.reused])
    if (JSON.stringify(readBundleSource(db, projectId, source)) !== JSON.stringify(source))
      throw new Error(`BUNDLE_SOURCE_CONFLICT: ${source.documentId}`);
  if (
    contextContentHash(JSON.stringify(bundleRequirements(db, projectId, taskId))) !==
    state.requirementsHash
  )
    throw new Error(
      'BUNDLE_REQUIREMENTS_CHANGED: preserve candidates and rebase to current requirements.',
    );
}
export function bundleObjects(
  db: Database.Database,
  projectId: string,
  taskId: string,
  state: BundleState,
): Map<string, BundleObject> {
  const store = new AgentContextStore(db),
    parts = new Map<string, ProductionBundlePart>(),
    objects = new Map<string, BundleObject>();
  for (const e of state.entries) {
    if (!parts.has(e.resultId)) {
      const result = store.result(projectId, taskId, e.resultId);
      if (!result || result.toolName !== 'production.bundle.part')
        throw new Error('BUNDLE_PART_MISSING');
      parts.set(e.resultId, validateProductionBundlePart(JSON.parse(result.content)));
    }
    const part = parts.get(e.resultId)!;
    const item = [...part.documents, ...part.scenes, ...part.shots].find(
      (item) => item.localKey === e.key,
    );
    if (!item || contextContentHash(JSON.stringify(item)) !== e.hash)
      throw new Error('BUNDLE_OBJECT_INTEGRITY_FAILED');
    objects.set(e.key, item);
  }
  return objects;
}
export function bundleSummary(state: BundleState, objects: Map<string, BundleObject>, offset = 0) {
  const page = state.entries.slice(offset, offset + 20);
  const requiresReseal = !!state.manifest && state.sealedRevision !== state.revision;
  return {
    status:
      state.sealedRevision === state.revision
        ? 'bundle_candidate_ready'
        : 'bundle_candidate_incomplete',
    bundleId: state.bundleId,
    revision: state.revision,
    objectCount: state.entries.length,
    budget: state.budget,
    sources: state.sources,
    reused: state.reused,
    objects: page.map(({ key, kind, hash }) => ({
      ...bundlePromptIdentity(objects.get(key)!, kind),
      hash,
    })),
    ...(offset + page.length < state.entries.length ? { nextOffset: offset + page.length } : {}),
    businessSaved: false,
    ...(requiresReseal ? { requiresReseal: true } : {}),
    instruction:
      state.sealedRevision === state.revision
        ? 'The candidate set is sealed. The Worker performs structural validation, atomic save and independent readback. Candidate persistence alone is not a business save.'
        : requiresReseal
          ? 'The candidate set changed. Existing keys and unaffected candidates are preserved. Submit affected complete prompt objects; the Worker reseals and reruns structural checks automatically.'
          : 'Continue submitting complete prompt objects with stable localKeys. location means a location prompt; scene means a story scene; shot.sceneKey establishes membership, while bindings.sceneDocumentIds references locations. Set complete=true when all prompt objects have been submitted. No business objects have been saved.',
  };
}
/** Only writes immutable Result Store candidates. It never creates project documents or shots. */
export function stageBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
  args: Record<string, unknown>,
  providerStepId?: string,
): Record<string, unknown> {
  const snapshot = bundleTask(db, projectId, taskId, true),
    store = new AgentContextStore(db);
  let state = loadBundle(db, projectId, taskId);
  const summary = (current: BundleState, offset = 0) =>
    bundleSummary(current, bundleObjects(db, projectId, taskId, current), offset);
  if (args.operation === 'begin') {
    if (state) {
      assertBundleInputs(db, projectId, taskId, state);
      return summary(state);
    }
    const sources = validateProductionBundleSources(snapshot.productionSources).map((s) =>
      readBundleSource(db, projectId, s),
    );
    const reused =
      args.reused === undefined
        ? []
        : validateProductionBundleSources(args.reused).map((s) =>
            readBundleSource(db, projectId, s),
          );
    const requirements = bundleRequirements(db, projectId, taskId);
    if (!Number.isSafeInteger(args.estimatedOutputTokens) || Number(args.estimatedOutputTokens) < 1)
      throw new Error('BUNDLE_INVALID: estimatedOutputTokens required.');
    const runtime = store.loadRuntime<ContextRecoverySnapshot>(projectId, taskId)?.runtime;
    const configured = runtime?.inferenceSettings?.maxOutputTokens;
    const verified = runtime?.contextWindowSource === 'contract';
    const declared = verified ? runtime?.modelCapabilities?.maxOutputTokens : undefined;
    const outputAllowance = Math.min(configured ?? declared ?? 16384, declared ?? Infinity);
    const bodies = [...sources, ...reused].map(
      (s) =>
        (
          db
            .prepare('SELECT content_markdown FROM document_versions WHERE id=? AND document_id=?')
            .get(s.versionId, s.documentId) as {
            content_markdown: string;
          }
        ).content_markdown,
    );
    const now = new Date().toISOString();
    state = {
      bundleId: taskId,
      revision: 0,
      sources,
      reused,
      requirementsHash: contextContentHash(JSON.stringify(requirements)),
      entries: [],
      createdAt: now,
      updatedAt: now,
      progressAt: now,
      budget: {
        estimatedInputTokens: estimateTokenCount(JSON.stringify([requirements, ...bodies])),
        estimatedOutputTokens: Number(args.estimatedOutputTokens),
        outputAllowance,
        outputSource: configured
          ? 'configured'
          : declared
            ? 'verified-model'
            : 'conservative-fallback',
        recommendedMode:
          Number(args.estimatedOutputTokens) * 1.25 <= outputAllowance ? 'single' : 'partitioned',
      },
    };
    saveBundle(db, projectId, taskId, state);
    return summary(state);
  }
  if (!state) throw new Error('BUNDLE_NOT_STARTED: begin with an output budget first.');
  if (args.operation === 'rebase') {
    for (const source of [...state.sources, ...state.reused])
      readBundleSource(db, projectId, source);
    if (committedBundle(db, projectId, taskId)) throw new Error('BUNDLE_ALREADY_COMMITTED');
    if (args.expectedRevision !== state.revision)
      throw new Error(`BUNDLE_REVISION_CONFLICT: expectedRevision=${state.revision}`);
    const additions =
      args.reused === undefined
        ? []
        : validateProductionBundleSources(args.reused).map((s) =>
            readBundleSource(db, projectId, s),
          );
    const reused = new Map(state.reused.map((s) => [s.documentId, s]));
    for (const s of additions) {
      if (reused.has(s.documentId) && reused.get(s.documentId)!.versionId !== s.versionId)
        throw new Error('BUNDLE_SOURCE_CONFLICT');
      reused.set(s.documentId, s);
    }
    state = {
      ...state,
      reused: [...reused.values()],
      requirementsHash: contextContentHash(
        JSON.stringify(bundleRequirements(db, projectId, taskId)),
      ),
      revision: state.revision + 1,
      updatedAt: new Date().toISOString(),
      progressAt: new Date().toISOString(),
    };
    saveBundle(db, projectId, taskId, state);
    return summary(state);
  }
  assertBundleInputs(db, projectId, taskId, state);
  if (args.operation === 'source') {
    const source = [...state.sources, ...state.reused].find(
      (s) => s.documentId === args.documentId,
    );
    if (!source) throw new Error('BUNDLE_SOURCE_NOT_SELECTED');
    const row = db
      .prepare(
        'SELECT content_markdown,bindings_json,sample_text FROM document_versions WHERE id=? AND document_id=?',
      )
      .get(source.versionId, source.documentId) as {
      content_markdown: string;
      bindings_json: string | null;
      sample_text: string | null;
    };
    const metadata = {
      sampleText: row.sample_text,
      bindings: row.bindings_json ? (JSON.parse(row.bindings_json) as unknown) : null,
    };
    const full = `${JSON.stringify(metadata, null, 2)}\n\ncontentMarkdown:\n${row.content_markdown}`;
    const offset = integer(args.offset ?? 0, 0, full.length),
      limit = integer(args.limit ?? 8000, 1, 10000),
      page = full.slice(offset, offset + limit);
    const result = {
      status: 'bundle_source_read',
      documentId: source.documentId,
      versionId: source.versionId,
      hash: source.contentHash,
      state: source.state,
      view: BUNDLE_SOURCE_READ_VIEW,
      contentPage: {
        offset,
        text: page,
        totalCharacters: full.length,
        ...(offset + page.length < full.length ? { nextOffset: offset + page.length } : {}),
      },
    };
    store.putResult(
      projectId,
      taskId,
      `bundle-source:${source.documentId}:${source.contentHash}:${offset}`,
      'production.bundle.source',
      JSON.stringify(result),
    );
    return result;
  }
  if (args.operation === 'state') return summary(state, integer(args.offset ?? 0, 0, 1000));
  if (args.operation === 'read' || args.operation === 'read_many') {
    const current = state;
    const readObject = (input: Record<string, unknown>) => {
      if (typeof input.localKey !== 'string') throw new Error('BUNDLE_KEY_REQUIRED');
      const key = input.localKey,
        entry = current.entries.find((e) => e.key === key);
      if (!entry) throw new Error('BUNDLE_KEY_NOT_FOUND');
      if (input.expectedHash !== undefined && input.expectedHash !== entry.hash)
        throw new Error(
          `BUNDLE_READ_STALE: localKey=${key}, expectedHash=${entry.hash}. For read_many omit expectedHash and use the current expectedRevision; no page was recorded.`,
        );
      const saved = store.result(projectId, taskId, entry.resultId);
      if (!saved || saved.toolName !== 'production.bundle.part')
        throw new Error('BUNDLE_PART_MISSING');
      const part = JSON.parse(saved.content) as ProductionBundlePart;
      const item = [...part.documents, ...part.scenes, ...part.shots].find(
        (item) => item.localKey === key,
      );
      if (!item || contextContentHash(JSON.stringify(item)) !== entry.hash)
        throw new Error('BUNDLE_OBJECT_INTEGRITY_FAILED');
      const full = bundlePromptReadText(item, entry.kind),
        offset = integer(input.offset ?? 0, 0, full.length);
      return { key, entry, full, offset };
    };
    const pageFor = (item: ReturnType<typeof readObject>, length: number) => {
      const { key, entry, full, offset } = item,
        page = full.slice(offset, offset + length);
      return {
        status: 'bundle_candidate_read',
        bundleId: current.bundleId,
        localKey: key,
        hash: entry.hash,
        view: BUNDLE_PROMPT_READ_VIEW,
        revision: current.revision,
        contentPage: {
          offset,
          text: page,
          totalCharacters: full.length,
          ...(offset + page.length < full.length ? { nextOffset: offset + page.length } : {}),
        },
      };
    };
    const saveRead = (result: ReturnType<typeof pageFor>) =>
      store.putResult(
        projectId,
        taskId,
        `bundle-read:${result.localKey}:${result.hash}:${result.contentPage.offset}`,
        'production.bundle.read',
        JSON.stringify(result),
      );
    if (args.operation === 'read') {
      const result = pageFor(readObject(args), integer(args.limit ?? 8000, 1, 10000));
      saveRead(result);
      return result;
    }
    if (args.expectedRevision !== state.revision)
      throw new Error(`BUNDLE_REVISION_CONFLICT: expectedRevision=${state.revision}`);
    if (!Array.isArray(args.items) || !args.items.length || args.items.length > 20)
      throw new Error('BUNDLE_ARGUMENTS_INVALID: read_many requires 1–20 items.');
    const items = args.items.map((input: unknown) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('BUNDLE_ARGUMENTS_INVALID: read_many item must be an object.');
      return readObject(input as Record<string, unknown>);
    });
    if (new Set(items.map((i) => i.key)).size !== items.length)
      throw new Error('BUNDLE_ARGUMENTS_INVALID: read_many localKeys must be distinct.');
    let budget = integer(args.limit ?? 10000, 1, 10000);
    const reads: Array<ReturnType<typeof pageFor>> = [];
    const remaining = items.map((i) => ({
      localKey: i.key,
      offset: i.offset,
    }));
    const result = {
      status: 'bundle_candidates_read',
      bundleId: state.bundleId,
      revision: state.revision,
      reads,
      remaining,
    };
    for (const item of items) {
      if (!budget) break;
      let size = Math.min(budget, item.full.length - item.offset);
      // Enforce serialized UTF-8 size as well as the total character limit.
      const fits = (length: number) =>
        Buffer.byteLength(
          JSON.stringify({
            ...result,
            reads: [...reads, pageFor(item, length)],
          }),
          'utf8',
        ) <=
        48 * 1024;
      if (!fits(size)) {
        let low = 0,
          high = size;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(mid)) low = mid;
          else high = mid - 1;
        }
        size = low;
      }
      if (!size && item.offset < item.full.length) break;
      const page = pageFor(item, size);
      reads.push(page);
      const pending = remaining.findIndex((i) => i.localKey === item.key);
      if (page.contentPage.nextOffset === undefined) remaining.splice(pending, 1);
      else remaining[pending]!.offset = page.contentPage.nextOffset;
      budget -= page.contentPage.text.length;
      if (page.contentPage.nextOffset !== undefined) break;
    }
    // Persist only pages actually returned. Stale/missing later items cannot create false coverage.
    for (const read of reads) saveRead(read);
    return result;
  }
  if (committedBundle(db, projectId, taskId))
    throw new Error(
      'BUNDLE_ALREADY_COMMITTED: readback the existing receipt; never create a second package.',
    );
  if (args.operation === 'put') {
    if (typeof args.partKey !== 'string' || !args.partKey.trim() || args.partKey.length > 200)
      throw new Error('BUNDLE_INVALID: stable partKey required.');
    const part = validateProductionBundlePart(args.part),
      content = JSON.stringify(part),
      callId = `bundle-part:${args.partKey}`;
    const previous = store.resultForCall(projectId, taskId, callId);
    if (previous && previous.content !== content)
      throw new Error(
        'BUNDLE_PART_CONFLICT: use a new partKey for a repair, preserving stable object keys.',
      );
    if (previous) return summary(state);
    if (args.expectedRevision !== state.revision)
      throw new Error(`BUNDLE_REVISION_CONFLICT: expectedRevision=${state.revision}`);
    const count = db
      .prepare(
        "SELECT COUNT(DISTINCT call_id) n FROM agent_context_results WHERE project_id=? AND task_id=? AND tool_name='production.bundle.part'",
      )
      .get(projectId, taskId) as {
      n: number;
    };
    if (count.n >= PRODUCTION_BUNDLE_LIMITS.parts) throw new Error('BUNDLE_PART_LIMIT');
    const now = new Date().toISOString(),
      result = store.putResult(projectId, taskId, callId, 'production.bundle.part', content);
    const entries = new Map(state.entries.map((e) => [e.key, e]));
    let changed = false;
    for (const [kind, items] of [
      ['document', part.documents],
      ['scene', part.scenes],
      ['shot', part.shots],
    ] as const)
      for (const item of items) {
        const hash = contextContentHash(JSON.stringify(item)),
          prior = entries.get(item.localKey);
        if (prior?.hash === hash) continue;
        entries.set(item.localKey, {
          key: item.localKey,
          kind,
          resultId: result.id,
          hash,
          updatedAt: now,
          ...(providerStepId ? { providerStepId } : {}),
        });
        changed = true;
      }
    if (!changed) return summary(state);
    state = {
      ...state,
      entries: [...entries.values()],
      revision: state.revision + 1,
      updatedAt: now,
      progressAt: now,
    };
    const objects = bundleObjects(db, projectId, taskId, state);
    if (
      objects.size > PRODUCTION_BUNDLE_LIMITS.objects ||
      Buffer.byteLength(JSON.stringify([...objects.values()])) >
        PRODUCTION_BUNDLE_LIMITS.bundleBytes
    )
      throw new Error('BUNDLE_TOTAL_LIMIT');
    saveBundle(db, projectId, taskId, state);
    return { ...summary(state), candidateChanged: true };
  }
  if (args.operation === 'seal') {
    if (args.expectedRevision !== state.revision)
      throw new Error(`BUNDLE_REVISION_CONFLICT: expectedRevision=${state.revision}`);
    const manifest = validateProductionBundleManifest(args.manifest);
    for (const [kind, keys] of [
      ['document', manifest.documentKeys],
      ['scene', manifest.sceneKeys],
      ['shot', manifest.shotKeys],
    ] as const) {
      const actual = state.entries.filter((e) => e.kind === kind).map((e) => e.key);
      if (actual.length !== keys.length || keys.some((k) => !actual.includes(k)))
        throw new Error(`BUNDLE_MANIFEST_INCOMPLETE: ${kind}`);
    }
    state = {
      ...state,
      manifest,
      sealedRevision: state.revision,
      updatedAt: new Date().toISOString(),
    };
    saveBundle(db, projectId, taskId, state);
    return summary(state);
  }
  throw new Error('BUNDLE_INVALID_OPERATION');
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error('BUNDLE_INVALID_RANGE');
  return Number(value);
}
export function committedBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
): Record<string, unknown> | undefined {
  const result = db
    .prepare(
      `SELECT r.result_json FROM agent_execution_commits c JOIN agent_write_receipts r ON r.id=c.receipt_id WHERE c.project_id=? AND c.task_id=? AND c.operation_key='production-bundle:commit'`,
    )
    .get(projectId, taskId) as
    | {
        result_json: string;
      }
    | undefined;
  return result ? (JSON.parse(result.result_json) as Record<string, unknown>) : undefined;
}
