import type { LlmPricingSnapshotInfo, NormalizedLlmUsage } from '@ai-video/contracts';

const MAX_PRICE_INTEGER_DIGITS = 12;
const MAX_PRICE_FRACTION_DIGITS = 12;
const COST_SCALE = 12;

export function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) {
    throw new Error('Currency must contain 3-8 uppercase letters.');
  }
  return currency;
}

export function normalizeDecimalPrice(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${label} must be a non-negative decimal number.`);
  }
  const [integer = '0', fraction = ''] = normalized.split('.');
  if (integer.length > MAX_PRICE_INTEGER_DIGITS || fraction.length > MAX_PRICE_FRACTION_DIGITS) {
    throw new Error(
      `${label} supports at most ${MAX_PRICE_INTEGER_DIGITS} integer and ${MAX_PRICE_FRACTION_DIGITS} fractional digits.`,
    );
  }
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
}

export function calculateEstimatedCost(
  usage: NormalizedLlmUsage | undefined,
  pricing: LlmPricingSnapshotInfo | undefined,
): string | undefined {
  if (!usage || !pricing) return undefined;
  const hasBillableUsage =
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== undefined;
  if (!hasBillableUsage) return undefined;
  const inputTokens = safeTokenCount(usage.inputTokens);
  const cachedInputTokens = Math.min(safeTokenCount(usage.cachedInputTokens), inputTokens);
  const regularInputTokens = inputTokens - cachedInputTokens;
  const outputTokens = safeTokenCount(usage.outputTokens);
  const cachedPrice = pricing.cachedInputPrice ?? pricing.inputPrice;
  const scaled =
    scaledCost(regularInputTokens, pricing.inputPrice, pricing.unitTokens) +
    scaledCost(cachedInputTokens, cachedPrice, pricing.unitTokens) +
    scaledCost(outputTokens, pricing.outputPrice, pricing.unitTokens);
  return formatScaled(scaled, COST_SCALE);
}

export function addDecimalStrings(values: string[]): string {
  const parsed = values.map(parseDecimal);
  const scale = parsed.reduce((maximum, value) => Math.max(maximum, value.scale), 0);
  const total = parsed.reduce(
    (sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale),
    0n,
  );
  return formatScaled(total, scale);
}

function safeTokenCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Provider usage contains an invalid token count.');
  }
  return value;
}

function scaledCost(tokens: number, price: string, unitTokens: number): bigint {
  if (!Number.isSafeInteger(unitTokens) || unitTokens <= 0) {
    throw new Error('Pricing token unit is invalid.');
  }
  const decimal = parseDecimal(price);
  if (decimal.scale > COST_SCALE) {
    throw new Error('Pricing precision exceeds the supported cost precision.');
  }
  const numerator =
    BigInt(tokens) * decimal.coefficient * 10n ** BigInt(COST_SCALE - decimal.scale);
  const denominator = BigInt(unitTokens);
  return (numerator + denominator / 2n) / denominator;
}

function parseDecimal(value: string): { coefficient: bigint; scale: number } {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new Error('Stored decimal value is invalid.');
  }
  const [integer = '0', fraction = ''] = normalized.split('.');
  return {
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

function formatScaled(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  const result = fraction ? `${integer}.${fraction}` : integer;
  return negative ? `-${result}` : result;
}
