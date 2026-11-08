import { createHash } from 'node:crypto';

export function isVersionedProductionRead(result: Record<string, unknown>): boolean {
  const target = result.target as { kind?: unknown; id?: unknown } | undefined;
  return (
    result.status === 'read' &&
    typeof target?.kind === 'string' &&
    typeof target.id === 'string' &&
    typeof result.version === 'string' &&
    /^[a-f0-9]{64}$/i.test(result.version) &&
    typeof result.view === 'string'
  );
}

/** Compare actual evidence, including ranges/IR, independently of temporary search handles. */
export function readEvidenceKey(result: Record<string, unknown>): string | undefined {
  if (result.status === 'identical_result' && typeof result.evidenceKey === 'string')
    return result.evidenceKey;
  if (
    result.status !== 'read' ||
    (!isVersionedProductionRead(result) &&
      (typeof result.sourceId !== 'string' ||
        typeof result.versionId !== 'string' ||
        typeof result.content !== 'string')) ||
    result.contextCompaction
  )
    return undefined;
  const evidence = { ...result };
  delete evidence.sourceHandle;
  delete evidence.citationLabel;
  return createHash('sha256')
    .update(JSON.stringify(canonical(evidence)))
    .digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/** Keep the first full result in history and shorten only later identical reads. */
export class RepeatedReadResults {
  private readonly firstCopies = new Map<string, string>();

  use(callId: string, output: string): string {
    if (output.length <= 2000) return output;
    let result: Record<string, unknown> | undefined;
    try {
      result = JSON.parse(output) as Record<string, unknown>;
    } catch {
      /* Non-JSON results use exact matching. */
    }
    const evidenceKey = result && readEvidenceKey(result);
    const hash = evidenceKey ?? createHash('sha256').update(output).digest('hex');
    const first = this.firstCopies.get(hash);
    if (first)
      return JSON.stringify({
        status: 'identical_result',
        fullResultCallId: first,
        contentHash: hash,
        ...(evidenceKey
          ? {
              evidenceKey,
              ...Object.fromEntries(
                [
                  'sourceHandle',
                  'citationLabel',
                  'sourceType',
                  'sourceId',
                  'versionId',
                  'sourceStatus',
                  'readMode',
                  'startOffset',
                  'endOffset',
                  'truncated',
                  'nextOffset',
                  'target',
                  'view',
                  'version',
                  'rowVersion',
                  'sceneId',
                  'shotId',
                ].flatMap((key) => (result![key] === undefined ? [] : [[key, result![key]]])),
              ),
            }
          : {}),
        instruction:
          'Reuse the exact full result at the earlier tool call. Its version and content are unchanged. Continue the requested work; do not reread this unchanged range.',
      });
    if (this.firstCopies.size >= 64) this.firstCopies.delete(this.firstCopies.keys().next().value!);
    this.firstCopies.set(hash, callId);
    return output;
  }

  clear(omittedCallIds?: ReadonlySet<string>): void {
    if (!omittedCallIds) this.firstCopies.clear();
    else
      for (const [key, callId] of this.firstCopies)
        if (omittedCallIds.has(callId)) this.firstCopies.delete(key);
  }
}
