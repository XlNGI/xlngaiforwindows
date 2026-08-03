import type { VideoGenerationCostInfo } from '@ai-video/contracts';

type VideoCostExtractor = (body: unknown) => VideoGenerationCostInfo | undefined;

const costFieldPriority = [
  ['credits_used', 'credits'],
  ['creditsUsed', 'credits'],
  ['credits', 'credits'],
  ['cost', 'unknown'],
] as const satisfies ReadonlyArray<
  readonly [string, VideoGenerationCostInfo['unit']]
>;

function parseCostAmount(value: unknown): number | undefined {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : undefined;
  if (amount === undefined || !Number.isFinite(amount) || amount < 0) return undefined;
  return amount;
}

function extractNestedVideoCost(body: unknown): VideoGenerationCostInfo | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = extractNestedVideoCost(item);
      if (found) return found;
    }
    return undefined;
  }
  const object = body as Record<string, unknown>;
  for (const [key, unit] of costFieldPriority) {
    const amount = parseCostAmount(object[key]);
    if (amount !== undefined) return { amount, unit };
  }
  for (const value of Object.values(object)) {
    const found = extractNestedVideoCost(value);
    if (found) return found;
  }
  return undefined;
}

const videoCostExtractors: Record<string, VideoCostExtractor> = {
  vidu: extractNestedVideoCost,
};

export function extractVideoCost(
  provider: string,
  body: unknown,
): VideoGenerationCostInfo | undefined {
  const extractor = videoCostExtractors[provider];
  if (!extractor) return undefined;
  return extractor(body);
}

export type { VideoGenerationCostInfo };
