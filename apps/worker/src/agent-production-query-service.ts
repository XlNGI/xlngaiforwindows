import type { ProductionTarget } from '@ai-video/contracts';
import { ProductionService } from './production-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';

type Snapshot = ReturnType<ProductionService['readForAgent']>;
export interface AgentProductionQueryResult extends Record<string, unknown> {
  status: string;
  target: ProductionTarget;
  rowVersion: number;
  version: string;
  complete?: boolean;
  contentPage?: {
    view: unknown;
    format: string;
    text: string;
    offset: unknown;
    nextOffset?: number;
    totalCharacters: number;
    expectedVersion: string;
  };
}
const MAX_PAGE_CHARACTERS = 4096;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

/** Read models only. Authorization and tool budgets remain in the caller. */
export class AgentProductionQueryService {
  private readonly cache = new Map<
    string,
    { version: string; snapshot: Snapshot; bytes: number; completeViews: Set<string> }
  >();
  private namespace = '';
  private bytes = 0;
  constructor(private readonly production: ProductionService) {}

  read(
    target: ProductionTarget,
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
    defaultView: 'structure' | 'instruction',
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
    if (!['structure', 'instruction', 'text', 'issues'].includes(view as string))
      throw new Error('制作读取 view 无效。');
    if (view === 'structure' && target.kind !== 'scene')
      throw new Error('structure 视图仅用于场次。');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? MAX_PAGE_CHARACTERS;
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > MAX_PAGE_CHARACTERS
    )
      throw new Error('制作读取分页范围无效（limit 1–4096）。');
    const version = this.production.queryVersion(target);
    if (args.expectedVersion !== undefined && args.expectedVersion !== version)
      throw new Error('制作读取版本已变化，请从第一页重新读取。');
    if (offset && !args.expectedVersion)
      throw new Error('续读必须提供 expectedVersion，防止混合不同版本。');
    const id = `${target.kind}:${target.id}`;
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
      rowVersion: snapshot.rowVersion,
      version,
      revision: snapshot.revision,
      stale: snapshot.issues.some((issue) => issue.code === 'STALE_INSTRUCTION'),
      readiness: snapshot.issues.length ? 'needs_attention' : 'ready',
      issueCount: snapshot.issues.length,
      issues: snapshot.issues
        .slice(0, 5)
        .map(({ code, message, target }) => ({ code, message: message.slice(0, 240), target })),
      issuesTruncated:
        snapshot.issues.length > 5 ||
        snapshot.issues.some(
          (issue) => issue.message.length > 240 || issue.changedReferences?.length,
        ),
      issueCodes: [...new Set(snapshot.issues.map((issue) => issue.code))],
      estimatedDurationSeconds: snapshot.estimatedDurationSeconds,
      views: ['instruction', 'text', 'issues', ...(target.kind === 'scene' ? ['structure'] : [])],
    };
    if (args.ifVersion === version && !offset && cached.completeViews.has(view as string))
      return { ...metadata, status: 'unchanged' };
    const value =
      view === 'instruction'
        ? (snapshot.instruction ?? null)
        : view === 'text'
          ? snapshot.currentText
          : view === 'issues'
            ? snapshot.issues
            : { scene: snapshot.scene, shots: snapshot.shots };
    const text = view === 'text' ? (value as string) : JSON.stringify(value);
    if (
      !offset &&
      text.length <= (limit as number) &&
      Buffer.byteLength(JSON.stringify({ ...metadata, [view as string]: value })) < 48 * 1024
    ) {
      cached.completeViews.add(view as string);
      return view === 'structure'
        ? {
            ...metadata,
            complete: true,
            ...(value as { scene: Snapshot['scene']; shots: Snapshot['shots'] }),
          }
        : { ...metadata, complete: true, [view as string]: value };
    }
    if ((offset as number) > text.length) throw new Error('制作读取 offset 超出内容范围。');
    let end = Math.min(text.length, (offset as number) + (limit as number));
    // Avoid splitting a UTF-16 surrogate pair, including a one-character page.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end += 1;
    if (end === text.length) cached.completeViews.add(view as string);
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
        expectedVersion: version,
      },
    };
  }
}
