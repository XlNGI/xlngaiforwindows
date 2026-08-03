import { describe, expect, it } from 'vitest';
import {
  addDecimalStrings,
  calculateEstimatedCost,
  multiplyDecimalStrings,
  normalizeCurrency,
  normalizeDecimalPrice,
} from './usage-cost.js';

describe('usage cost', () => {
  it('calculates cached and regular input without double charging', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 12_480, cachedInputTokens: 8_000, outputTokens: 2_160 },
        {
          currency: 'CNY',
          unitTokens: 1_000_000,
          inputPrice: '10',
          cachedInputPrice: '2.5',
          outputPrice: '30',
          configuredAt: 'now',
        },
      ),
    ).toBe('0.1296');
  });

  it('uses the input price when cached pricing is absent and ignores reasoning for billing', () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 100,
          cachedInputTokens: 80,
          outputTokens: 20,
          reasoningTokens: 10,
        },
        {
          currency: 'USD',
          unitTokens: 1_000_000,
          inputPrice: '5',
          outputPrice: '20',
          configuredAt: 'now',
        },
      ),
    ).toBe('0.0009');
  });

  it('does not invent a cost when usage or pricing is missing', () => {
    expect(calculateEstimatedCost(undefined, undefined)).toBeUndefined();
    expect(
      calculateEstimatedCost(
        { reasoningTokens: 12 },
        {
          currency: 'USD',
          unitTokens: 1_000_000,
          inputPrice: '1',
          outputPrice: '1',
          configuredAt: 'now',
        },
      ),
    ).toBeUndefined();
  });

  it('normalizes decimal prices and adds decimal costs exactly', () => {
    expect(normalizeDecimalPrice('12.3400', 'Input price')).toBe('12.34');
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(addDecimalStrings(['0.1', '0.02', '10.003'])).toBe('10.123');
    expect(() => normalizeDecimalPrice('1.2345678901234', 'Input price')).toThrow(
      'fractional digits',
    );
  });

  it('multiplies provider credits by the configured per-credit price exactly', () => {
    expect(multiplyDecimalStrings('4', '0.03125')).toBe('0.125');
    expect(multiplyDecimalStrings('1.5', '0.03125')).toBe('0.046875');
  });
});
