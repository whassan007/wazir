import { describe, expect, it } from 'vitest';
import type { ModelContextLimits } from '@wazir/core';
import { allocateFitted, MIN_OUTPUT_TOKENS } from '../src/contextAllocationRuntime.js';

const limits = (over: Partial<ModelContextLimits> = {}): ModelContextLimits => ({
  modelId: 'm', contextWindowTokens: 8_192, runtimeContextConfigurable: false, accounting: 'shared',
  reasoningAccounting: 'not-supported', source: 'runtime-discovered', known: true, notes: [], ...over,
});

describe('allocateFitted', () => {
  it('reduces the output reserve to fit a fixed 8K context instead of failing', () => {
    // 2386 prompt + 2742 tools + 4096 output + safety > 8192: the unfitted allocation cannot fit.
    const a = allocateFitted(limits(), { estimatedInputTokens: 2_386, toolSchemaTokens: 2_742, outputTokens: 4_096 });
    expect(a.outcome).not.toBe('cannot-fit');
    expect(a.maxOutputTokens).toBeLessThan(4_096);
    expect(a.maxOutputTokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
    expect(2_386 + 2_742 + a.maxOutputTokens + a.reservations.safetyTokens).toBeLessThanOrEqual(8_192);
    expect(a.reasons.some((r) => r.includes('output reserve reduced from 4096'))).toBe(true);
  });

  it('keeps the full reserve when it fits', () => {
    const a = allocateFitted(limits({ contextWindowTokens: 262_144 }), { estimatedInputTokens: 2_386, toolSchemaTokens: 2_742, outputTokens: 4_096 });
    expect(a.maxOutputTokens).toBe(4_096);
    expect(a.allocatedWindowTokens).toBe(16_384);
  });

  it('still refuses when even the floor does not fit, and never trims input', () => {
    const a = allocateFitted(limits(), { estimatedInputTokens: 7_500, outputTokens: 4_096 });
    expect(a.outcome).toBe('cannot-fit');
    expect(a.estimatedInputTokens).toBe(7_500);
  });

  it('does not shrink output under independent accounting (output does not share the window)', () => {
    const a = allocateFitted(limits({ accounting: 'independent', maxInputTokens: 4_000 }), { estimatedInputTokens: 5_000, outputTokens: 4_096 });
    expect(a.outcome).toBe('cannot-fit');
    expect(a.maxOutputTokens).toBe(4_096);
  });
});
