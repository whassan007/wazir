import { describe, it, expect } from 'vitest';
import { tokensPerSecond } from '../src/utils.js';

describe('tokensPerSecond', () => {
  it('calculates tokens per second for normal case (100 output tokens over 2000ms -> 50)', () => {
    const result = tokensPerSecond(100, 2000);
    expect(result).toBe(50);
  });

  it('returns 0 when durationMs is 0', () => {
    const result = tokensPerSecond(100, 0);
    expect(result).toBe(0);
  });

  it('handles fractional results correctly', () => {
    // 60 tokens over 3000ms = 20 tok/s
    expect(tokensPerSecond(60, 3000)).toBe(20);
    // 10 tokens over 500ms = 20 tok/s
    expect(tokensPerSecond(10, 500)).toBe(20);
  });

  it('handles very high throughput case (10,000 output tokens / 500ms = 20,000 tok/s) - no overflow or precision loss', () => {
    const result = tokensPerSecond(10000, 500);
    expect(result).toBe(20000);
  });

  it('handles very low throughput case (10 output tokens / 60,000ms = 0.167 tok/s) - verifies rounding', () => {
    const result = tokensPerSecond(10, 60000);
    // Expected: 10 / 60 = 0.1666... which rounds to 0.2 when displayed with 1 decimal
    expect(result).toBeCloseTo(0.167, 3);
  });

  it('handles zero output tokens case (0 output tokens / 5000ms = 0 tok/s) - safe handling', () => {
    const result = tokensPerSecond(0, 5000);
    expect(result).toBe(0);
    // Verify no NaN or Infinity
    expect(isNaN(result)).toBe(false);
    expect(isFinite(result)).toBe(true);
  });
});
