import { createHash } from 'node:crypto';
import type { ProductionTarget } from '@ai-video/contracts';
import { ProductionService, summarizeProductionNotices } from './production-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';

type Snapshot = ReturnType<ProductionService['readForAgent']>;
export interface AgentProductionQueryResult extends Record<string, unknown> {
  status: string;
  target: ProductionTarget;
  rowVersion: number;
  version: string;
  complete?: boolean;
  recordPage?: {
    view: string;
    unit: 'records';
    records: Array<{ path: Array<string | number>; value: unknown }>;
    context: unknown;
    offset: number;
    nextOffset?: number;
    totalRecords: number;
    expectedVersion: string;
  };
  contentPage?: {
    view: unknown;
    format: string;
    text: string;
    offset: unknown;
    nextOffset?: number;
    totalCharacters: number;
    unit: 'utf16-characters';
    expectedVersion: string;
  };
}
const MAX_PAGE_CHARACTERS = 4096;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

/** Read models only. Authorization and batch limits remain in the caller. */
export class AgentProductionQueryService {
  private readonly cache = new Map<
    string,
    {
      version: string;
      snapshot: Snapshot;
      bytes: number;
      completeViews: Set<string>;
      coverage: Map<string, number>;
    }
  >();
  private namespace = '';
  private bytes = 0;
  constructor(private readonly production: ProductionService) {}

  read(
    target: ProductionTarget,
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
    defaultView: 'structure' | 'authoring',
  ): AgentProductionQueryResult {
    const namespace = JSON.stringify([
      identity.projectId,
      identity.projectSessionId,
      identity.conversationId,
    ]);
    if (this.namespace !== namespace) {
      this.cache.clear();
      this.bytes = 0;
      this.namespace = namespace;
    }
    const view = args.view ?? defaultView;
    if (
      typeof view !== 'string' ||
      !['structure', 'authoring', 'text', 'issues', 'media'].includes(view)
    )
      throw new Error('制作读取 view 无效。');
    if (view === 'structure' && target.kind !== 'scene')
      throw new Error('structure 视图仅用于场次。');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? MAX_PAGE_CHARACTERS;
    const recordOffset = args.recordOffset ?? 0;
    const recordLimit = args.recordLimit ?? 20;
    const recordsView = ['structure', 'media', 'issues'].includes(view);
    const recordMode = recordsView && args.offset === undefined && args.limit === undefined;
    if ((args.recordOffset !== undefined || args.recordLimit !== undefined) && !recordMode)
      throw new Error('记录分页仅用于 structure/media/issues，不能与字符 offset/limit 混用。');
    if (
      !Number.isSafeInteger(recordOffset) ||
      (recordOffset as number) < 0 ||
      !Number.isSafeInteger(recordLimit) ||
      (recordLimit as number) < 1 ||
      (recordLimit as number) > 20
    )
      throw new Error('制作记录分页范围无效（recordLimit 1–20 条）。');
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > MAX_PAGE_CHARACTERS
    )
      throw new Error('制作读取分页范围无效（limit 1–4096）。');
    const media = view === 'media' ? this.production.readMediaForAgent(target) : undefined;
    const baseVersion = this.production.queryVersion(target);
    const version = media
      ? createHash('sha256')
          .update(JSON.stringify([baseVersion, media]))
          .digest('hex')
      : baseVersion;
    if (args.expectedVersion !== undefined && args.expectedVersion !== version)
      throw new Error('制作读取版本已变化，请从第一页重新读取。');
    if ((offset || recordOffset) && !args.expectedVersion)
      throw new Error('续读必须提供 expectedVersion，防止混合不同版本。');
    const id = `${target.kind}:${target.id}:${media ? 'media' : 'content'}`;
    let cached = this.cache.get(id);
    if (!cached || cached.version !== version) {
      const snapshot = this.production.readForAgent(target);
      if (cached) {
        this.cache.delete(id);
        this.bytes -= cached.bytes;
      }
      cached = {
        version,
        snapshot,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
        completeViews: new Set(),
        coverage: new Map(),
      };
      if (cached.bytes <= MAX_CACHE_BYTES) {
        while (this.cache.size >= 24 || this.bytes + cached.bytes > MAX_CACHE_BYTES) {
          const oldest = this.cache.keys().next().value!;
          this.bytes -= this.cache.get(oldest)!.bytes;
          this.cache.delete(oldest);
        }
        this.cache.set(id, cached);
        this.bytes += cached.bytes;
      }
    } else {
      this.cache.delete(id);
      this.cache.set(id, cached);
    }
    const snapshot = cached.snapshot;
    const metadata = {
      status: 'read',
      target,
      view,
      ...(snapshot.scene ? { sceneId: snapshot.scene.id } : {}),
      ...(target.kind === 'shot' ? { shotId: target.id } : {}),
      rowVersion: snapshot.rowVersion,
      version,
      readiness: snapshot.issues.length ? 'needs_attention' : 'ready',
      issueCount: snapshot.issues.length,
      issues: snapshot.issues
        .slice(0, 5)
        .map(({ code, message, target }) => ({ code, message: message.slice(0, 240), target })),
      issuesTruncated:
        snapshot.issues.length > 5 || snapshot.issues.some((issue) => issue.message.length > 240),
      issueCodes: [...new Set(snapshot.issues.map((issue) => issue.code))],
      ...summarizeProductionNotices(snapshot.notices ?? []),
      estimatedDurationSeconds: snapshot.estimatedDurationSeconds,
      contentFormat: snapshot.contentFormat,
      views: [
        'authoring',
        'text',
        'issues',
        ...(['scene', 'shot'].includes(target.kind) ? ['media'] : []),
        ...(target.kind === 'scene' ? ['structure'] : []),
      ],
    };
    if (args.ifVersion === version && !offset && !recordOffset && cached.completeViews.has(view))
      return { ...metadata, status: 'unchanged' };
    const value =
      view === 'media'
        ? media
        : view === 'authoring'
          ? (snapshot.authoringIR ?? null)
          : view === 'text'
            ? snapshot.currentText
            : view === 'issues'
              ? snapshot.issues
              : { scene: snapshot.scene, shots: snapshot.shots };
    const text = view === 'text' ? (value as string) : JSON.stringify(value);
    const markCoverage = (mode: string, start: number, end: number, total: number) => {
      const key = `${view}:${mode}`;
      const covered = cached.coverage.get(key) ?? 0;
      if (start <= covered) {
        cached.coverage.set(key, Math.max(covered, end));
        if (end === total) cached.completeViews.add(view);
      }
    };
    if (recordMode) {
      const { records, context } = productionRecords(view, value);
      const start = recordOffset as number;
      if (start > records.length) throw new Error('制作读取 recordOffset 超出记录范围。');
      if (
        !start &&
        args.recordLimit === undefined &&
        args.recordOffset === undefined &&
        records.length <= (recordLimit as number) &&
        Buffer.byteLength(text) < 8000
      ) {
        cached.completeViews.add(view);
        return view === 'structure'
          ? {
              ...metadata,
              complete: true,
              ...(value as { scene: Snapshot['scene']; shots: Snapshot['shots'] }),
            }
          : { ...metadata, complete: true, [view]: value };
      }
      const selected: typeof records = [];
      let end = start;
      while (end < records.length && selected.length < (recordLimit as number)) {
        const candidate = [...selected, records[end]!];
        const size = Buffer.byteLength(
          JSON.stringify({ ...metadata, context, records: candidate }),
        );
        if (selected.length && size > 8000) break;
        if (size > 48 * 1024)
          throw new Error('单条制作记录过大，请使用 offset/limit 字符分页读取此视图。');
        selected.push(records[end++]!);
      }
      markCoverage('records', start, end, records.length);
      return {
        ...metadata,
        complete: end === records.length,
        recordPage: {
          view: view,
          unit: 'records',
          records: selected,
          context,
          offset: start,
          nextOffset: end < records.length ? end : undefined,
          totalRecords: records.length,
          expectedVersion: version,
        },
      };
    }
    if (
      !offset &&
      text.length <= (limit as number) &&
      Buffer.byteLength(JSON.stringify({ ...metadata, [view]: value })) < 48 * 1024
    ) {
      cached.completeViews.add(view);
      return view === 'structure'
        ? {
            ...metadata,
            complete: true,
            ...(value as { scene: Snapshot['scene']; shots: Snapshot['shots'] }),
          }
        : { ...metadata, complete: true, [view]: value };
    }
    if ((offset as number) > text.length) throw new Error('制作读取 offset 超出内容范围。');
    let end = Math.min(text.length, (offset as number) + (limit as number));
    // Avoid splitting a UTF-16 surrogate pair, including a one-character page.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end += 1;
    markCoverage('characters', offset as number, end, text.length);
    return {
      ...metadata,
      complete: end === text.length,
      contentPage: {
        view,
        format: view === 'text' ? 'text' : 'json',
        text: text.slice(offset as number, end),
        offset,
        nextOffset: end < text.length ? end : undefined,
        totalCharacters: text.length,
        unit: 'utf16-characters',
        expectedVersion: version,
      },
    };
  }
}

/** Whole entities keep their IDs, CAS and bindings together; paths allow exact reconstruction. */
function productionRecords(view: string, value: unknown) {
  const records: Array<{ path: Array<string | number>; value: unknown }> = [];
  if (view === 'structure') {
    const structure = value as { scene: unknown; shots: unknown[] };
    structure.shots.forEach((shot, i) => records.push({ path: ['shots', i], value: shot }));
    return { records, context: { scene: structure.scene, shots: [] } };
  }
  if (view === 'issues') {
    (value as unknown[]).forEach((issue, i) => records.push({ path: [i], value: issue }));
    return { records, context: [] };
  }
  const media = value as { bindings: unknown[]; inputs: Record<string, unknown[]> };
  media.bindings.forEach((binding, i) => records.push({ path: ['bindings', i], value: binding }));
  for (const [name, inputs] of Object.entries(media.inputs))
    inputs.forEach((input, i) => records.push({ path: ['inputs', name, i], value: input }));
  return {
    records,
    context: {
      ...media,
      bindings: [],
      inputs: Object.fromEntries(Object.keys(media.inputs).map((name) => [name, []])),
    },
  };
}
