import { describe, expect, it } from 'vitest';
import {
  StickyRouter,
  resolvePhasePolicy,
  scoreRouteCandidate,
  type RouteCandidate,
} from '../src/services/stickyRouter.js';

function candidate(overrides: Partial<RouteCandidate> & Pick<RouteCandidate, 'modelId'>): RouteCandidate {
  return {
    providerId: 'dgx-1',
    locality: 'dgx',
    effectiveContextWindow: 32_000,
    resident: true,
    ewmaLatencyMs: 2_000,
    throughputTps: 40,
    successRate: 0.99,
    circuitState: 'closed',
    availableSlots: 4,
    maxSlots: 4,
    memoryHeadroomGiB: 16,
    marginalCostPerMTok: 0,
    qualityScore: 0.8,
    ...overrides,
  };
}

function makeRouter(options: ConstructorParameters<typeof StickyRouter>[0] = {}) {
  let tick = 1_000;
  return new StickyRouter({ now: () => tick++, ...options });
}

const local = candidate({ modelId: 'qwen-coder-32b' });
const localAlt = candidate({ modelId: 'llama-70b', providerId: 'dgx-2', qualityScore: 0.85, ewmaLatencyMs: 2_500 });
const remote = candidate({
  modelId: 'claude-opus-5-5',
  providerId: 'anthropic',
  locality: 'remote',
  effectiveContextWindow: 200_000,
  resident: undefined,
  memoryHeadroomGiB: undefined,
  marginalCostPerMTok: 15,
  qualityScore: 0.97,
  ewmaLatencyMs: 4_000,
});

describe('scoreRouteCandidate', () => {
  const policy = resolvePhasePolicy('coding');

  it('applies a cold-load penalty to non-resident local models', () => {
    const warm = scoreRouteCandidate(local, { policy });
    const cold = scoreRouteCandidate({ ...local, resident: false, coldLoadMs: 45_000 }, { policy });
    expect(warm.breakdown.residency).toBe(1);
    expect(cold.breakdown.residency).toBeCloseTo(0.25, 5);
    expect(cold.total).toBeLessThan(warm.total);
  });

  it('awards the sticky cache bonus only to the previously used model', () => {
    const sticky = scoreRouteCandidate(local, { policy, stickyModelId: local.modelId });
    const other = scoreRouteCandidate(localAlt, { policy, stickyModelId: local.modelId });
    expect(sticky.breakdown.stickyCache).toBe(1);
    expect(other.breakdown.stickyCache).toBe(0);
    expect(sticky.total - scoreRouteCandidate(local, { policy }).total).toBeCloseTo(policy.weights.stickyCache, 5);
  });

  it('prefers zero-marginal-cost models that meet the quality threshold', () => {
    const free = scoreRouteCandidate(local, { policy });
    const paid = scoreRouteCandidate(remote, { policy });
    expect(free.breakdown.cost).toBe(1);
    expect(paid.breakdown.cost).toBeLessThan(0.5);
    expect(free.total).toBeGreaterThan(paid.total);
  });

  it('marks open circuits, context overflow, and low quality as ineligible', () => {
    expect(scoreRouteCandidate({ ...local, circuitState: 'open' }, { policy }).rejectReason).toBe('circuit_open');
    expect(scoreRouteCandidate(local, { policy, requiredContextTokens: 64_000 }).rejectReason).toBe('context_overflow');
    expect(scoreRouteCandidate({ ...local, qualityScore: 0.2 }, { policy }).rejectReason).toBe('below_quality');
    const halfOpen = scoreRouteCandidate({ ...local, circuitState: 'half_open' }, { policy });
    expect(halfOpen.eligible).toBe(true);
    expect(halfOpen.breakdown.reliability).toBeLessThan(scoreRouteCandidate(local, { policy }).breakdown.reliability);
  });

  it('scores capacity from free slots and memory headroom', () => {
    const busy = scoreRouteCandidate({ ...local, availableSlots: 0, memoryHeadroomGiB: 1 }, { policy });
    const idle = scoreRouteCandidate(local, { policy });
    expect(busy.breakdown.capacity).toBeLessThan(0.1);
    expect(idle.breakdown.capacity).toBe(1);
  });
});

describe('StickyRouter', () => {
  it('keeps routing to the sticky model even when a competitor scores higher on raw metrics', () => {
    const router = makeRouter();
    const first = router.route({ executionId: 'e1', phase: 'coding', candidates: [local, localAlt] });
    expect(first.reason).toBe('initial_selection');
    expect(first.modelId).toBe(local.modelId);

    // A faster competitor appears; stickiness should hold to preserve the KV cache.
    const faster = { ...localAlt, ewmaLatencyMs: 200, throughputTps: 120 };
    const second = router.route({ executionId: 'e1', phase: 'coding', candidates: [local, faster] });
    expect(second.reason).toBe('sticky_reuse');
    expect(second.sticky).toBe(true);
    expect(second.modelId).toBe(local.modelId);
    expect(router.getSession('e1', 'coding')?.turns).toBe(2);
  });

  it('avoids cold-loading a model when a resident one is available', () => {
    const router = makeRouter();
    const coldBetter = { ...localAlt, resident: false, coldLoadMs: 50_000, qualityScore: 0.9 };
    const decision = router.route({ executionId: 'e2', phase: 'coding', candidates: [coldBetter, local] });
    expect(decision.modelId).toBe(local.modelId);
    expect(decision.breakdown?.residency).toBe(1);
  });

  it('inherits the sticky model across compatible phases when preserveContextCache is enabled', () => {
    const router = makeRouter();
    router.route({ executionId: 'e3', phase: 'planning', candidates: [local, localAlt] });
    const coding = router.route({ executionId: 'e3', phase: 'coding', candidates: [localAlt, local] });
    expect(coding.reason).toBe('sticky_inherited');
    expect(coding.modelId).toBe(local.modelId);

    // fast_path does not preserve context cache, so it selects independently.
    const fast = router.route({ executionId: 'e3', phase: 'fast_path', candidates: [local, localAlt] });
    expect(fast.reason).toBe('initial_selection');
  });

  it('does not inherit across phases when preserveContextCache is disabled', () => {
    const router = makeRouter({ policies: { coding: { preserveContextCache: false } } });
    router.route({ executionId: 'e3b', phase: 'planning', candidates: [local] });
    const coding = router.route({ executionId: 'e3b', phase: 'coding', candidates: [local] });
    expect(coding.reason).toBe('initial_selection');
    expect(coding.sticky).toBe(false);
  });

  it('fails over after maxConsecutiveFailures (default 2) and not before', () => {
    const router = makeRouter();
    router.route({ executionId: 'e4', phase: 'coding', candidates: [local, localAlt] });

    router.recordOutcome('e4', 'coding', { modelId: local.modelId, success: false });
    const afterOne = router.route({ executionId: 'e4', phase: 'coding', candidates: [local, localAlt] });
    expect(afterOne.modelId).toBe(local.modelId);
    expect(afterOne.reason).toBe('sticky_reuse');

    router.recordOutcome('e4', 'coding', { modelId: local.modelId, success: false });
    const afterTwo = router.route({ executionId: 'e4', phase: 'coding', candidates: [local, localAlt] });
    expect(afterTwo.reason).toBe('failover_failures');
    expect(afterTwo.modelId).toBe(localAlt.modelId);
    expect(afterTwo.previousModelId).toBe(local.modelId);
    expect(afterTwo.rejected).toContainEqual({ modelId: local.modelId, reason: 'consecutive_failures' });

    // The new model is now sticky.
    const next = router.route({ executionId: 'e4', phase: 'coding', candidates: [local, localAlt] });
    expect(next.reason).toBe('sticky_reuse');
    expect(next.modelId).toBe(localAlt.modelId);
  });

  it('resets the failure streak on success', () => {
    const router = makeRouter();
    router.route({ executionId: 'e4b', phase: 'coding', candidates: [local, localAlt] });
    router.recordOutcome('e4b', 'coding', { modelId: local.modelId, success: false });
    router.recordOutcome('e4b', 'coding', { modelId: local.modelId, success: true });
    router.recordOutcome('e4b', 'coding', { modelId: local.modelId, success: false });
    expect(router.getModelHealth('e4b', local.modelId)?.consecutiveFailures).toBe(1);
    expect(router.route({ executionId: 'e4b', phase: 'coding', candidates: [local, localAlt] }).modelId).toBe(local.modelId);
  });

  it('fails over when observed latency exceeds the phase SLA', () => {
    const router = makeRouter();
    router.route({ executionId: 'e5', phase: 'fast_path', candidates: [local, localAlt] });
    const sla = router.getPolicy('fast_path').maxLatencyMs;
    router.recordOutcome('e5', 'fast_path', { modelId: local.modelId, success: true, latencyMs: sla + 1 });

    const decision = router.route({ executionId: 'e5', phase: 'fast_path', candidates: [local, localAlt] });
    expect(decision.reason).toBe('failover_latency');
    expect(decision.modelId).toBe(localAlt.modelId);
  });

  it('fails over when the circuit breaker opens', () => {
    const router = makeRouter();
    router.route({ executionId: 'e6', phase: 'verification', candidates: [local, localAlt] });
    const decision = router.route({
      executionId: 'e6',
      phase: 'verification',
      candidates: [{ ...local, circuitState: 'open' }, localAlt],
    });
    expect(decision.reason).toBe('failover_circuit');
    expect(decision.modelId).toBe(localAlt.modelId);
  });

  it('reroutes when the required context overflows the sticky model window', () => {
    const router = makeRouter();
    router.route({ executionId: 'e7', phase: 'coding', candidates: [local, remote], requiredContextTokens: 8_000 });
    const decision = router.route({
      executionId: 'e7',
      phase: 'coding',
      candidates: [local, remote],
      requiredContextTokens: 120_000,
    });
    expect(decision.reason).toBe('failover_context');
    expect(decision.modelId).toBe(remote.modelId);
    expect(decision.rejected).toContainEqual({ modelId: local.modelId, reason: 'context_overflow' });
  });

  it('falls back to a degraded candidate rather than failing when only soft rejections remain', () => {
    const router = makeRouter();
    router.route({ executionId: 'e8', phase: 'coding', candidates: [local] });
    router.recordOutcome('e8', 'coding', { modelId: local.modelId, success: false });
    router.recordOutcome('e8', 'coding', { modelId: local.modelId, success: false });
    const decision = router.route({ executionId: 'e8', phase: 'coding', candidates: [local] });
    expect(decision.status).toBe('routed');
    expect(decision.degraded).toBe(true);
    expect(decision.modelId).toBe(local.modelId);
  });

  it('reports unroutable when every candidate is hard-rejected', () => {
    const router = makeRouter();
    const decision = router.route({
      executionId: 'e9',
      phase: 'coding',
      candidates: [{ ...local, circuitState: 'open' }],
    });
    expect(decision.status).toBe('unroutable');
    expect(decision.reason).toBe('no_eligible_candidate');
  });

  it('escalates to stronger models and enforces maxEscalationsPerExecution (default 2)', () => {
    const router = makeRouter();
    const candidates = [local, localAlt, remote];
    router.route({ executionId: 'e10', phase: 'coding', candidates });

    const first = router.escalateRoute({ executionId: 'e10', phase: 'coding', candidates, reason: 'tests failing' });
    expect(first.status).toBe('routed');
    expect(first.modelId).toBe(remote.modelId);
    expect(first.previousModelId).toBe(local.modelId);
    expect(first.escalationsUsed).toBe(1);

    // Escalated model becomes sticky.
    expect(router.route({ executionId: 'e10', phase: 'coding', candidates }).modelId).toBe(remote.modelId);

    const second = router.escalateRoute({ executionId: 'e10', phase: 'coding', candidates });
    expect(second.status).toBe('routed');
    // Already-abandoned models are not revisited.
    expect(second.modelId).toBe(localAlt.modelId);
    expect(second.escalationsUsed).toBe(2);

    const third = router.escalateRoute({ executionId: 'e10', phase: 'coding', candidates });
    expect(third.status).toBe('escalation_denied');
    expect(third.reason).toBe('escalation_limit');
    expect(third.modelId).toBe(localAlt.modelId);
    expect(router.getEscalationCount('e10')).toBe(2);
    expect(router.route({ executionId: 'e10', phase: 'coding', candidates }).modelId).toBe(localAlt.modelId);
  });

  it('honours a custom escalation limit and isolates budgets per execution', () => {
    const router = makeRouter({ maxEscalationsPerExecution: 1 });
    const candidates = [local, remote];
    router.route({ executionId: 'a', phase: 'recovery', candidates });
    expect(router.escalateRoute({ executionId: 'a', phase: 'recovery', candidates }).status).toBe('routed');
    expect(router.escalateRoute({ executionId: 'a', phase: 'recovery', candidates }).status).toBe('escalation_denied');

    router.route({ executionId: 'b', phase: 'recovery', candidates });
    expect(router.escalateRoute({ executionId: 'b', phase: 'recovery', candidates }).status).toBe('routed');
  });

  it('records a deterministic audit trail of routing and escalation decisions', () => {
    const run = () => {
      const router = makeRouter({ maxEscalationsPerExecution: 1 });
      const candidates = [local, localAlt, remote];
      router.route({ executionId: 'audit', phase: 'planning', candidates });
      router.route({ executionId: 'audit', phase: 'coding', candidates });
      router.recordOutcome('audit', 'coding', { modelId: local.modelId, success: false });
      router.recordOutcome('audit', 'coding', { modelId: local.modelId, success: false });
      router.route({ executionId: 'audit', phase: 'coding', candidates });
      router.escalateRoute({ executionId: 'audit', phase: 'coding', candidates, reason: 'stuck' });
      router.escalateRoute({ executionId: 'audit', phase: 'coding', candidates });
      return router.getRouteHistory('audit');
    };

    const history = run();
    expect(history.map((d) => [d.sequence, d.kind, d.reason, d.modelId])).toEqual([
      [1, 'route', 'initial_selection', local.modelId],
      [2, 'route', 'sticky_inherited', local.modelId],
      [3, 'route', 'failover_failures', localAlt.modelId],
      [4, 'escalation', 'escalation', remote.modelId],
      [5, 'escalation', 'escalation_limit', remote.modelId],
    ]);
    expect(history[3].note).toBe('stuck');
    expect(history.map((d) => d.at)).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(run()).toEqual(history);

    // Returned history is a copy; mutating it does not affect the router's trail.
    history.pop();
    expect(run()).toHaveLength(5);
  });

  it('clears all state for an execution', () => {
    const router = makeRouter();
    router.route({ executionId: 'gone', phase: 'coding', candidates: [local] });
    router.clearExecution('gone');
    expect(router.getSession('gone', 'coding')).toBeUndefined();
    expect(router.getRouteHistory('gone')).toEqual([]);
    expect(router.route({ executionId: 'gone', phase: 'coding', candidates: [local] }).reason).toBe('initial_selection');
  });
});
