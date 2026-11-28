import { describe, expect, it } from 'vitest';
import { UnifiedOptimizationEngine } from '../src/unifiedOptimizationEngine.js';

describe('UnifiedOptimizationEngine', () => {
  it('routes at phase boundaries with capacity safety and session stickiness', () => {
    const engine = new UnifiedOptimizationEngine();
    const chosen = engine.routeAtPhaseBoundary({
      sessionId: 's1',
      phase: 'implement',
      profiles: [
        {
          modelId: 'qwen3-coder:30b',
          harnessId: 'wazir-native',
          hostId: 'dgx',
          qualityScore: 0.94,
          verificationPassRate: 0.92,
          avgLatencyMs: 420,
          costPer1kTokensUsd: 0,
          availableRamGB: 64,
          requiredRamGB: 20,
          sampleCount: 30,
        },
        {
          modelId: 'oversized-model',
          harnessId: 'wazir-native',
          hostId: 'laptop',
          qualityScore: 0.99,
          verificationPassRate: 0.99,
          avgLatencyMs: 100,
          costPer1kTokensUsd: 0,
          availableRamGB: 16,
          requiredRamGB: 80,
          sampleCount: 10,
        },
      ],
    });
    expect(chosen.modelId).toBe('qwen3-coder:30b');
  });

  it('rejects self-attestation and returns UNVERIFIED when independent evidence is missing', () => {
    const engine = new UnifiedOptimizationEngine();
    const verdict = engine.evaluateWithIndependentEvidence({
      requiredCriteria: ['tests_pass'],
      evidence: [
        { criterionId: 'tests_pass', verifierId: 'agent-1', authorId: 'agent-1', passed: true, score: 1.0, summary: 'self' },
      ],
    });
    expect(verdict.validationState).toBe('UNVERIFIED');
    expect(verdict.weightedScore).toBeNull();
  });

  it('rejects regressions in bounded repair loops and retains best candidate', async () => {
    const engine = new UnifiedOptimizationEngine();
    const result = await engine.runBoundedRepairLoop({
      baseline: 'v0',
      baselineScore: 0.6,
      targetScore: 0.9,
      maxIterations: 3,
      step: async (iter) => {
        if (iter === 1) return { candidate: 'v1', score: 0.8, verified: true };
        if (iter === 2) return { candidate: 'v2-regressed', score: 0.5, verified: true };
        return { candidate: 'v3', score: 0.92, verified: true };
      },
    });
    expect(result.terminationReason).toBe('target_reached');
    expect(result.bestCandidate).toBe('v3');
    expect(result.history[1]?.accepted).toBe(false);
  });
});
