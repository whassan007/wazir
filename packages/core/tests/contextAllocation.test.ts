import { describe, it, expect } from 'vitest';
import {
  allocateContext,
  estimateRequestTokens,
  DEFAULT_RESERVATION_POLICY,
} from '../src/services/contextAllocation.js';
import {
  DEFAULT_UNKNOWN_LIMIT_POLICY,
  type ContextAllocationRequest,
  type ModelContextLimits,
} from '../src/types/contextAllocation.js';
import { estimateInputTokens, estimateTextTokens } from '../src/resources/estimator.js';

function limits(over: Partial<ModelContextLimits> = {}): ModelContextLimits {
  return {
    modelId: 'test-model',
    contextWindowTokens: 1_000_000,
    runtimeContextConfigurable: false,
    accounting: 'shared',
    reasoningAccounting: 'not-supported',
    source: 'provider-documented',
    known: true,
    notes: [],
    ...over,
  };
}

type ReqOverrides = Partial<Omit<ContextAllocationRequest, 'limits'>> & { limits?: Partial<ModelContextLimits> };

function req(over: ReqOverrides = {}): ContextAllocationRequest {
  const { limits: lim, ...rest } = over;
  return {
    limits: limits(lim),
    estimatedInputTokens: 2_500,
    reservations: { outputTokens: 1_024 },
    ...rest,
  };
}

describe('allocateContext: window selection', () => {
  it('gives a simple task on a 1M hosted model the 4096 target, not the max window', () => {
    const a = allocateContext(req());
    expect(a.outcome).toBe('fits');
    expect(a.allocatedWindowTokens).toBe(4_096);
    // Hosted, not configurable: no per-request context is requested.
    expect(a.requestedContextTokens).toBeUndefined();
    expect(a.maxOutputTokens).toBe(1_024);
    expect(a.conservativePolicyApplied).toBe(false);
    // 4096 - (output 1024 + safety 256) = 2816
    expect(a.inputBudgetTokens).toBe(2_816);
  });

  it('picks 32768 for a long task on a configurable 32K local model and requests it', () => {
    const a = allocateContext(
      req({
        estimatedInputTokens: 30_000,
        reservations: { outputTokens: 1_024 },
        limits: {
          contextWindowTokens: 32_768,
          runtimeContextTokens: 8_192,
          runtimeContextConfigurable: true,
          source: 'runtime-discovered',
        },
      }),
    );
    expect(a.outcome).toBe('fits');
    expect(a.allocatedWindowTokens).toBe(32_768);
    expect(a.requestedContextTokens).toBe(32_768);
  });

  it('returns fits-at-limit when the window is not a target and no target holds the need', () => {
    const a = allocateContext(
      req({
        estimatedInputTokens: 15_000,
        reservations: { outputTokens: 1_024 },
        limits: { contextWindowTokens: 20_000, runtimeContextConfigurable: true, source: 'runtime-discovered' },
      }),
    );
    expect(a.outcome).toBe('fits-at-limit');
    expect(a.allocatedWindowTokens).toBe(20_000);
    expect(a.requestedContextTokens).toBe(20_000);
  });

  it('returns cannot-fit with required vs available tokens on overflow', () => {
    const a = allocateContext(
      req({
        estimatedInputTokens: 9_000,
        limits: { contextWindowTokens: 8_192 },
      }),
    );
    expect(a.outcome).toBe('cannot-fit');
    expect(a.allocatedWindowTokens).toBe(8_192);
    expect(a.utilization).toBeGreaterThan(1);
    expect(a.reasons.some((r) => /requires \d+ tokens, available 8192 tokens/.test(r))).toBe(true);
  });

  it('reports Infinity utilization when the input budget is zero and input is non-empty', () => {
    const a = allocateContext(
      req({
        estimatedInputTokens: 100,
        reservations: { outputTokens: 8_192 },
        limits: { contextWindowTokens: 8_192 },
      }),
    );
    expect(a.outcome).toBe('cannot-fit');
    expect(a.inputBudgetTokens).toBe(0);
    expect(a.utilization).toBe(Infinity);
  });

  it('uses a non-configurable runtime context smaller than the window as the ceiling', () => {
    const fixed = limits({
      contextWindowTokens: 131_072,
      runtimeContextTokens: 8_192,
      runtimeContextConfigurable: false,
      source: 'runtime-discovered',
    });
    const overflow = allocateContext({ limits: fixed, estimatedInputTokens: 9_000, reservations: { outputTokens: 512 } });
    expect(overflow.outcome).toBe('cannot-fit');
    expect(overflow.allocatedWindowTokens).toBe(8_192);
    expect(overflow.requestedContextTokens).toBeUndefined();

    const fits = allocateContext({ limits: fixed, estimatedInputTokens: 2_000, reservations: { outputTokens: 1_024 } });
    expect(fits.allocatedWindowTokens).toBe(4_096);
  });

  it('ignores a configurable runtime value as a ceiling', () => {
    const a = allocateContext({
      limits: limits({
        contextWindowTokens: 131_072,
        runtimeContextTokens: 8_192,
        runtimeContextConfigurable: true,
        source: 'runtime-discovered',
      }),
      estimatedInputTokens: 9_000,
      reservations: { outputTokens: 512 },
    });
    expect(a.outcome).toBe('fits');
    expect(a.allocatedWindowTokens).toBe(16_384);
    expect(a.requestedContextTokens).toBe(16_384);
  });
});

describe('allocateContext: output and unknown limits', () => {
  it('clamps requested output to maxOutputTokens', () => {
    const a = allocateContext(
      req({ reservations: { outputTokens: 8_000 }, limits: { maxOutputTokens: 2_048 } }),
    );
    expect(a.maxOutputTokens).toBe(2_048);
    expect(a.reservations.outputTokens).toBe(2_048);
    expect(a.reasons.some((r) => r.includes('clamped to provider cap 2048'))).toBe(true);
    expect(a.conservativePolicyApplied).toBe(false);
  });

  it('uses the default output reservation when none is requested', () => {
    const a = allocateContext({ limits: limits(), estimatedInputTokens: 100, reservations: {} });
    expect(a.maxOutputTokens).toBe(DEFAULT_RESERVATION_POLICY.outputTokens);
  });

  it('applies the assumed 8192 window and 2048 output cap when limits are unknown', () => {
    const unknown = limits({
      modelId: 'mystery',
      contextWindowTokens: undefined,
      maxOutputTokens: undefined,
      known: false,
      source: 'default-unknown',
    });

    // Output 4096 requested, clamped to the assumed 2048 cap; fits the assumed window.
    const small = allocateContext({ limits: unknown, estimatedInputTokens: 1_000, reservations: {} });
    expect(small.conservativePolicyApplied).toBe(true);
    expect(small.maxOutputTokens).toBe(DEFAULT_UNKNOWN_LIMIT_POLICY.assumedMaxOutputTokens);
    expect(small.allocatedWindowTokens).toBeLessThanOrEqual(DEFAULT_UNKNOWN_LIMIT_POLICY.assumedContextTokens);
    expect(small.limitSource).toBe('default-unknown');

    // Input that only fits the assumed 8192 window.
    const big = allocateContext({ limits: unknown, estimatedInputTokens: 6_000, reservations: {} });
    expect(big.outcome).toBe('cannot-fit');
    expect(big.allocatedWindowTokens).toBe(8_192);
    expect(big.conservativePolicyApplied).toBe(true);
    expect(big.reasons.some((r) => r.includes('available 8192'))).toBe(true);
  });
});

describe('allocateContext: accounting and reasoning', () => {
  it('treats shared and independent accounting differently for the same numbers', () => {
    const shared = allocateContext({
      limits: limits({ contextWindowTokens: 8_192, accounting: 'shared' }),
      estimatedInputTokens: 6_000,
      reservations: { outputTokens: 4_096 },
    });
    const independent = allocateContext({
      limits: limits({ contextWindowTokens: 8_192, accounting: 'independent' }),
      estimatedInputTokens: 6_000,
      reservations: { outputTokens: 4_096 },
    });
    // Shared: 6000 + 410 safety + 4096 output > 8192. Independent: output does not share the window.
    expect(shared.outcome).toBe('cannot-fit');
    expect(independent.outcome).toBe('fits');
    expect(independent.allocatedWindowTokens).toBe(8_192);
    expect(independent.maxOutputTokens).toBe(4_096);
  });

  it('computes different input budgets for shared and independent accounting', () => {
    const base = { estimatedInputTokens: 4_000, reservations: { outputTokens: 2_048 } };
    const shared = allocateContext({ ...base, limits: limits({ contextWindowTokens: 8_192 }) });
    const independent = allocateContext({
      ...base,
      limits: limits({ contextWindowTokens: 8_192, accounting: 'independent' }),
    });
    expect(shared.allocatedWindowTokens).toBe(8_192);
    expect(independent.allocatedWindowTokens).toBe(8_192);
    // Safety is 5% of the need: shared needs 4000 + 2048 = 6048 → 303; independent needs 4000 → 200, floored to 256.
    // Shared subtracts output (2048) + safety (303); independent subtracts only safety (256).
    expect(shared.inputBudgetTokens).toBe(8_192 - 2_048 - 303);
    expect(independent.inputBudgetTokens).toBe(8_192 - 256);
  });

  it('does not double count reasoning that counts against output', () => {
    const base = { estimatedInputTokens: 2_000 };
    const counts = allocateContext({
      ...base,
      reservations: { outputTokens: 1_024, reasoningTokens: 2_048 },
      limits: limits({ contextWindowTokens: 8_192, reasoningAccounting: 'counts-against-output' }),
    });
    const separate = allocateContext({
      ...base,
      reservations: { outputTokens: 1_024, reasoningTokens: 2_048 },
      limits: limits({ contextWindowTokens: 8_192, reasoningAccounting: 'separate' }),
    });

    // Counts-against: one 3072 reservation inside max_tokens.
    expect(counts.maxOutputTokens).toBe(3_072);
    expect(counts.reservations.outputTokens).toBe(3_072);
    expect(counts.reservations.reasoningTokens).toBe(0);
    // Separate: 1024 output + 2048 reasoning, max_tokens is output only.
    expect(separate.maxOutputTokens).toBe(1_024);
    expect(separate.reservations.reasoningTokens).toBe(2_048);
    // Same window reserve either way, so the same input budget.
    expect(counts.inputBudgetTokens).toBe(separate.inputBudgetTokens);
    expect(counts.allocatedWindowTokens).toBe(separate.allocatedWindowTokens);
  });

  it('clamps counts-against-output reasoning to the output cap', () => {
    const a = allocateContext({
      limits: limits({ maxOutputTokens: 2_048, reasoningAccounting: 'counts-against-output' }),
      estimatedInputTokens: 100,
      reservations: { outputTokens: 1_024, reasoningTokens: 2_048 },
    });
    expect(a.maxOutputTokens).toBe(2_048);
  });

  it('drops reasoning reserve when reasoning is not supported', () => {
    const a = allocateContext({
      limits: limits({ reasoningAccounting: 'not-supported' }),
      estimatedInputTokens: 100,
      reservations: { outputTokens: 512, reasoningTokens: 4_096 },
    });
    expect(a.reservations.reasoningTokens).toBe(0);
    expect(a.maxOutputTokens).toBe(512);
  });
});

describe('allocateContext: input limits and targets', () => {
  it('enforces maxInputTokens against the input side', () => {
    const over = allocateContext({
      limits: limits({ contextWindowTokens: 32_768, maxInputTokens: 8_000 }),
      estimatedInputTokens: 9_000,
      reservations: { outputTokens: 1_024 },
    });
    expect(over.outcome).toBe('cannot-fit');
    expect(over.reasons.some((r) => r.includes('maxInputTokens allows 8000'))).toBe(true);

    const under = allocateContext({
      limits: limits({ contextWindowTokens: 32_768, maxInputTokens: 8_000 }),
      estimatedInputTokens: 7_000,
      reservations: { outputTokens: 1_024 },
    });
    expect(under.outcome).toBe('fits');
    expect(under.allocatedWindowTokens).toBe(16_384);
  });

  it('honours a custom targets list', () => {
    const a = allocateContext({
      limits: limits(),
      estimatedInputTokens: 3_000,
      reservations: { outputTokens: 512 },
      targets: [2_048, 6_144],
    });
    expect(a.allocatedWindowTokens).toBe(6_144);
  });
});

describe('estimateRequestTokens', () => {
  it('sums system, message, and tool components', () => {
    const tools = [{ name: 'read_file', parameters: { type: 'object' } }];
    const est = estimateRequestTokens({
      systemPrompt: 'You are a careful assistant.',
      messages: [{ role: 'user', content: 'Summarise the file.' }],
      tools,
    });
    expect(est.method).toBe('heuristic');
    expect(est.systemTokens).toBe(estimateInputTokens({ systemPrompt: 'You are a careful assistant.' }));
    expect(est.messageTokens).toBe(
      estimateInputTokens({ messages: [{ content: 'Summarise the file.' }] }),
    );
    expect(est.toolSchemaTokens).toBe(estimateTextTokens(JSON.stringify(tools)));
    expect(est.totalTokens).toBe(est.systemTokens + est.messageTokens + est.toolSchemaTokens);
  });

  it('applies calibrationRatio and marginFraction', () => {
    const input = {
      systemPrompt: 'System text that is long enough to matter.',
      messages: [{ role: 'user', content: 'Hello there, this is a message.' }],
    };
    const base = estimateRequestTokens(input);
    const doubled = estimateRequestTokens({ ...input, calibrationRatio: 2 });
    expect(doubled.totalTokens).toBe(base.totalTokens * 2);
    const withMargin = estimateRequestTokens({ ...input, marginFraction: 0.5 });
    expect(withMargin.systemTokens).toBe(Math.ceil(base.systemTokens * 1.5));
    // A ratio below 1 is not applied (padEstimate semantics).
    expect(estimateRequestTokens({ ...input, calibrationRatio: 0.5 }).totalTokens).toBe(base.totalTokens);
  });

  it('uses a supplied counter and reports method exact', () => {
    const est = estimateRequestTokens(
      { systemPrompt: 'abcd', messages: [{ role: 'user', content: 'hello' }] },
      (text) => text.length,
    );
    expect(est.method).toBe('exact');
    const frame = estimateInputTokens({ messages: [{ content: '' }] });
    expect(est.systemTokens).toBe(4 + frame);
    expect(est.messageTokens).toBe(5 + frame);
    expect(est.toolSchemaTokens).toBe(0);
  });
});

describe('input validation', () => {
  it('throws RangeError for negative or NaN token counts', () => {
    expect(() => allocateContext(req({ estimatedInputTokens: -1 }))).toThrow(RangeError);
    expect(() => allocateContext(req({ estimatedInputTokens: Number.NaN }))).toThrow(RangeError);
    expect(() => allocateContext(req({ reservations: { outputTokens: -5 } }))).toThrow(RangeError);
    expect(() => allocateContext(req({ reservations: { safetyTokens: Number.NaN } }))).toThrow(RangeError);
    expect(() => allocateContext(req({ limits: { maxInputTokens: -1 } }))).toThrow(RangeError);
    expect(() => allocateContext(req({ targets: [0] }))).toThrow(RangeError);
  });

  it('throws RangeError for invalid estimator inputs', () => {
    expect(() => estimateRequestTokens({ calibrationRatio: Number.NaN })).toThrow(RangeError);
    expect(() => estimateRequestTokens({ marginFraction: -0.1 })).toThrow(RangeError);
  });
});
