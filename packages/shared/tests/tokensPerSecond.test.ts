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
});
