import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  ShadowRouterService,
  type ShadowRouteCandidate,
  type RoutingPolicyDescriptor,
} from '../src/services/shadowRouterService.js';
import type { Task } from '../src/types/task.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    type: overrides.type ?? 'coding',
    title: overrides.title ?? 'Implement feature',
    input: overrides.input ?? 'Implement helper function and unit test',
    requirements: overrides.requirements ?? { capabilities: ['coding'] },
    policy: overrides.policy,
    execution: overrides.execution,
    mutationRequired: overrides.mutationRequired,
    priority: overrides.priority ?? 'normal',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date('2026-10-23T00:00:00Z'),
  };
}

function makeCandidatePool(): ShadowRouteCandidate[] {
  return [
    {
      harnessId: 'native',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'ollama',
      local: true,
      capabilityScore: 78,
      verifiedSuccessRate: 0.82,
      expectedTotalCostUsd: 0,
      expectedLatencyMs: 1400,
      sampleCount: 25,
      residency: 'ready',
    },
    {
      harnessId: 'claude-code-acp',
      modelId: 'claude-3-7-sonnet',
      runtimeId: 'anthropic',
      local: false,
      capabilityScore: 95,
      verifiedSuccessRate: 0.94,
      expectedTotalCostUsd: 0.12,
      expectedLatencyMs: 2600,
      sampleCount: 2, // under-sampled (< 5)
      residency: 'ready',
    },
    {
      harnessId: 'codex-cli',
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama',
      local: true,
      capabilityScore: 74,
      verifiedSuccessRate: 0.8,
      expectedTotalCostUsd: 0,
      expectedLatencyMs: 950,
      sampleCount: 1, // under-sampled local candidate (< 5)
      residency: 'ready',
    },
  ];
}

describe('ShadowRouterService', () => {
  let baselinePolicy: RoutingPolicyDescriptor;
  let shadowPolicy: RoutingPolicyDescriptor;

  beforeEach(() => {
    baselinePolicy = {
      id: 'prod-local-first-v1',
      version: '1.0.0',
      mode: 'local-first',
      preferLocal: true,
    };
    shadowPolicy = {
      id: 'shadow-quality-first-v2',
      version: '2.0.0',
      mode: 'quality-first',
      preferLocal: false,
    };
  });

  it('1. evaluates shadow policy alongside production policy without altering production decision', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
    });
    const task = makeTask({ id: 'task-shadow-1' });
    const candidates = makeCandidatePool();

    const record = service.evaluateShadow({
      executionId: 'exec-shadow-1',
      task,
      candidates,
    });

    // Production policy (local-first) chooses the zero-cost local model
    expect(record.productionChoice.modelId).toBe('qwen2.5-coder:32b');
    expect(record.productionChoice.local).toBe(true);
    expect(record.productionChoice.expectedCostUSD).toBe(0);

    // Shadow policy (quality-first) chooses the higher-capability remote model
    expect(record.shadowChoice.modelId).toBe('claude-3-7-sonnet');
    expect(record.shadowChoice.harnessId).toBe('claude-code-acp');
    expect(record.shadowChoice.predictedSuccessProb).toBeCloseTo(0.94, 2);
    expect(record.shadowChoice.expectedCostUSD).toBeCloseTo(0.12, 4);

    // Selected route is strictly the production route; no exploration or live shadow run occurs
    expect(record.selectedChoice).toEqual(record.productionChoice);
    expect(record.agreed).toBe(false);
    expect(record.explored).toBe(false);
    expect(record.liveShadowExecutionAuthorized).toBe(false);
    expect(record.predictedDelta.successProbDelta).toBeCloseTo(0.94 - 0.82, 2);
    expect(record.predictedDelta.costDeltaUSD).toBeCloseTo(0.12, 4);
    expect(record.predictedDelta.latencyDeltaMs).toBe(2600 - 1400);
  });

  it('2. does not mutate input candidates during shadow evaluation', () => {
    const service = new ShadowRouterService({ baselinePolicy, shadowPolicy });
    const candidates = makeCandidatePool();
    const snapshot = structuredClone(candidates);

    service.evaluateShadow({
      executionId: 'exec-immutable',
      task: makeTask(),
      candidates,
    });

    expect(candidates).toEqual(snapshot);
  });

  it('3. blocks live duplicate shadow execution unless allowLiveShadowExecution is explicitly true', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        allowLiveShadowExecution: false,
        maxExplorationCostUSD: 10,
      },
    });

    const record = service.evaluateShadow({
      executionId: 'exec-no-live-dup',
      task: makeTask(),
      candidates: makeCandidatePool(),
      requestLiveShadowExecution: true,
    });

    expect(record.liveShadowExecutionAuthorized).toBe(false);
    expect(record.liveShadowExecutionBlockReason).toContain('allowLiveShadowExecution is false');
    expect(service.getExplorationStats().cumulativeExplorationCostUSD).toBe(0);
  });

  it('4. authorizes live duplicate shadow execution only when explicitly enabled, safe, and within budget', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        allowLiveShadowExecution: true,
        maxExplorationCostUSD: 0.20,
        perTaskMaxCostDeltaUSD: 0.25,
      },
    });

    // First request ($0.12) fits inside $0.20 cap
    const first = service.evaluateShadow({
      executionId: 'exec-live-ok',
      task: makeTask({ id: 't-1' }),
      candidates: makeCandidatePool(),
      requestLiveShadowExecution: true,
    });
    expect(first.liveShadowExecutionAuthorized).toBe(true);
    expect(service.getExplorationStats().cumulativeExplorationCostUSD).toBeCloseTo(0.12, 4);

    // Second request ($0.12) would push cumulative spend to $0.24 > $0.20 cap -> blocked!
    const second = service.evaluateShadow({
      executionId: 'exec-live-over-budget',
      task: makeTask({ id: 't-2' }),
      candidates: makeCandidatePool(),
      requestLiveShadowExecution: true,
    });
    expect(second.liveShadowExecutionAuthorized).toBe(false);
    expect(second.liveShadowExecutionBlockReason).toContain('maxExplorationCostUSD');
  });

  it('5. explores under-sampled (harness, model) candidates using UCB bounded exploration', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        strategy: 'ucb',
        minSamplesForConfidence: 5,
        maxExplorationFraction: 0.25,
        maxExplorationCostUSD: 2.0,
        perTaskMaxCostDeltaUSD: 0.5,
      },
    });

    const decision = service.decideWithExploration({
      executionId: 'exec-ucb-1',
      task: makeTask({ id: 'task-ucb-1' }),
      candidates: makeCandidatePool(),
    });

    expect(decision.explored).toBe(true);
    expect(decision.explorationStrategy).toBe('ucb');
    // Production choice is qwen2.5-coder:32b (25 samples), while explored choice is one of the under-sampled (<5 samples) candidates
    expect(decision.productionChoice.modelId).toBe('qwen2.5-coder:32b');
    expect(decision.selectedChoice.modelId).not.toBe(decision.productionChoice.modelId);
    expect(decision.selectedChoice.sampleCount).toBeLessThan(5);
  });

  it('6. supports epsilon-greedy bounded exploration using deterministic RNG', () => {
    const rolls = [0.04, 0.85];
    let idx = 0;
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        strategy: 'epsilon-greedy',
        epsilon: 0.1,
        maxExplorationFraction: 0.5,
        random: () => rolls[idx++ % rolls.length],
      },
    });

    // Roll 1: 0.04 < 0.10 -> explores
    const d1 = service.decideWithExploration({
      executionId: 'exec-eps-1',
      task: makeTask({ id: 't-eps-1' }),
      candidates: makeCandidatePool(),
    });
    expect(d1.explored).toBe(true);
    expect(d1.explorationStrategy).toBe('epsilon-greedy');

    // Roll 2: 0.85 >= 0.10 -> exploits production choice (even if fraction were raised)
    service.updateConfig({ maxExplorationFraction: 1.0, random: () => 0.85 });
    const d2 = service.decideWithExploration({
      executionId: 'exec-eps-2',
      task: makeTask({ id: 't-eps-2' }),
      candidates: makeCandidatePool(),
    });
    expect(d2.explored).toBe(false);
    expect(d2.selectedChoice.modelId).toBe(d2.productionChoice.modelId);
    expect(d2.explorationBlockedReason).toContain('epsilon-greedy roll');
  });

  it('7. strictly enforces maxExplorationFraction across a stream of requests', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        strategy: 'ucb',
        maxExplorationFraction: 0.1, // max 10%
        maxExplorationCostUSD: 10.0,
        perTaskMaxCostDeltaUSD: 1.0,
        minSamplesForConfidence: 10,
      },
    });

    let exploredCount = 0;
    const totalRequests = 20;
    for (let i = 0; i < totalRequests; i++) {
      const res = service.decideWithExploration({
        executionId: `exec-rate-${i}`,
        task: makeTask({ id: `task-rate-${i}` }),
        candidates: makeCandidatePool(),
      });
      if (res.explored) {
        exploredCount += 1;
      }
    }

    // 10% of 20 is 2 requests
    expect(exploredCount).toBe(2);
    expect(service.getExplorationStats().explorationRate).toBeLessThanOrEqual(0.1);
  });

  it('8. enforces perTaskMaxCostDeltaUSD and blocks exploring overly expensive candidates', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        strategy: 'ucb',
        maxExplorationFraction: 0.5,
        maxExplorationCostUSD: 10.0,
        perTaskMaxCostDeltaUSD: 0.05, // $0.05 max delta
      },
    });

    // Only alternative is a remote model costing $0.25 (delta $0.25 > $0.05)
    const candidates: ShadowRouteCandidate[] = [
      {
        harnessId: 'native',
        modelId: 'local-coder',
        runtimeId: 'ollama',
        local: true,
        capabilityScore: 80,
        verifiedSuccessRate: 0.85,
        expectedTotalCostUsd: 0,
        sampleCount: 20,
      },
      {
        harnessId: 'claude-code-acp',
        modelId: 'expensive-opus',
        runtimeId: 'anthropic',
        local: false,
        capabilityScore: 92,
        verifiedSuccessRate: 0.92,
        expectedTotalCostUsd: 0.25,
        sampleCount: 1,
      },
    ];

    const res = service.decideWithExploration({
      executionId: 'exec-cost-delta',
      task: makeTask(),
      candidates,
    });

    expect(res.explored).toBe(false);
    expect(res.selectedChoice.modelId).toBe('local-coder');
    expect(res.explorationBlockedReason).toContain('perTaskMaxCostDeltaUSD');
  });

  it('9. enforces cumulative maxExplorationCostUSD budget across tasks', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        strategy: 'ucb',
        maxExplorationFraction: 1.0,
        maxExplorationCostUSD: 0.15, // Only enough for one $0.12 exploration
        perTaskMaxCostDeltaUSD: 0.5,
      },
    });

    const candidates: ShadowRouteCandidate[] = [
      {
        harnessId: 'native',
        modelId: 'local-coder',
        runtimeId: 'ollama',
        local: true,
        capabilityScore: 80,
        verifiedSuccessRate: 0.85,
        expectedTotalCostUsd: 0,
        sampleCount: 20,
      },
      {
        harnessId: 'claude-code-acp',
        modelId: 'claude-sonnet',
        runtimeId: 'anthropic',
        local: false,
        capabilityScore: 90,
        verifiedSuccessRate: 0.91,
        expectedTotalCostUsd: 0.12,
        sampleCount: 1,
      },
    ];

    const first = service.decideWithExploration({
      executionId: 'exec-budget-1',
      task: makeTask({ id: 't-b1' }),
      candidates,
    });
    expect(first.explored).toBe(true);
    expect(first.selectedChoice.modelId).toBe('claude-sonnet');
    expect(service.getExplorationStats().cumulativeExplorationCostUSD).toBeCloseTo(0.12, 4);

    // Second attempt requires another $0.12 -> $0.24 > $0.15 -> blocked!
    const second = service.decideWithExploration({
      executionId: 'exec-budget-2',
      task: makeTask({ id: 't-b2' }),
      candidates,
    });
    expect(second.explored).toBe(false);
    expect(second.selectedChoice.modelId).toBe('local-coder');
    expect(second.explorationBlockedReason).toContain('maxExplorationCostUSD');
  });

  it('10. never explores on tasks with sensitive or restricted dataClassification', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: { maxExplorationFraction: 1.0 },
    });

    const sensitiveTask = makeTask({
      id: 'task-sensitive',
      policy: { dataClassification: 'sensitive' },
    });
    const restrictedTask = makeTask({
      id: 'task-restricted',
      policy: { dataClassification: 'restricted' },
    });

    const res1 = service.decideWithExploration({
      executionId: 'exec-sens',
      task: sensitiveTask,
      candidates: makeCandidatePool(),
    });
    expect(res1.explored).toBe(false);
    expect(res1.selectedChoice.local).toBe(true);
    expect(res1.explorationBlockedReason).toContain("dataClassification is 'sensitive'");

    const res2 = service.decideWithExploration({
      executionId: 'exec-rest',
      task: restrictedTask,
      candidates: makeCandidatePool(),
    });
    expect(res2.explored).toBe(false);
    expect(res2.selectedChoice.local).toBe(true);
    expect(res2.explorationBlockedReason).toContain("dataClassification is 'restricted'");
  });

  it('11. never explores a remote candidate when localOnly is true', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: { maxExplorationFraction: 1.0 },
    });

    // Pool has only 1 local model and 1 under-sampled remote model
    const candidates: ShadowRouteCandidate[] = [
      {
        harnessId: 'native',
        modelId: 'local-qwen',
        runtimeId: 'ollama',
        local: true,
        capabilityScore: 78,
        verifiedSuccessRate: 0.82,
        expectedTotalCostUsd: 0,
        sampleCount: 15,
      },
      {
        harnessId: 'claude-code-acp',
        modelId: 'remote-claude',
        runtimeId: 'anthropic',
        local: false,
        capabilityScore: 95,
        verifiedSuccessRate: 0.94,
        expectedTotalCostUsd: 0.05,
        sampleCount: 0,
      },
    ];

    const localOnlyTask = makeTask({
      id: 'task-local-only',
      policy: { localOnly: true },
    });

    const decision = service.decideWithExploration({
      executionId: 'exec-local-only',
      task: localOnlyTask,
      candidates,
    });

    expect(decision.explored).toBe(false);
    expect(decision.selectedChoice.modelId).toBe('local-qwen');
    expect(decision.selectedChoice.local).toBe(true);
    expect(decision.explorationBlockedReason).toContain('localOnly');
  });

  it('12. blocks exploration on critical-priority tasks, pinned targetModelId, and high-risk mutating tasks', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        maxExplorationFraction: 1.0,
        blockHighRiskExploration: true,
      },
    });

    const criticalDecision = service.decideWithExploration({
      executionId: 'exec-crit',
      task: makeTask({ id: 't-crit', priority: 'critical' }),
      candidates: makeCandidatePool(),
    });
    expect(criticalDecision.explored).toBe(false);
    expect(criticalDecision.explorationBlockedReason).toContain("priority is 'critical'");

    const pinnedDecision = service.decideWithExploration({
      executionId: 'exec-pin',
      task: makeTask({
        id: 't-pin',
        execution: { targetModelId: 'qwen2.5-coder:32b' },
      }),
      candidates: makeCandidatePool(),
    });
    expect(pinnedDecision.explored).toBe(false);
    expect(pinnedDecision.explorationBlockedReason).toContain('targetModelId pin');

    const highRiskMutatingDecision = service.decideWithExploration({
      executionId: 'exec-high-risk',
      task: makeTask({
        id: 't-mut',
        priority: 'high',
        mutationRequired: true,
      }),
      candidates: makeCandidatePool(),
    });
    expect(highRiskMutatingDecision.explored).toBe(false);
    expect(highRiskMutatingDecision.explorationBlockedReason).toContain('high-risk mutating task');
  });

  it('13. records observed outcomes and computes probability, cost, and latency calibration errors', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: { maxExplorationFraction: 1.0 },
    });

    const decision = service.decideWithExploration({
      executionId: 'exec-cal-1',
      task: makeTask({ id: 'task-cal-1' }),
      candidates: makeCandidatePool(),
    });

    const expectedProb = decision.selectedChoice.predictedSuccessProb;
    const expectedCost = decision.selectedChoice.expectedCostUSD;
    const expectedLatency = decision.selectedChoice.expectedLatencyMs;

    const updated = service.recordObservedOutcome('exec-cal-1', {
      verifiedSuccess: false,
      actualCostUSD: 0.18,
      actualDurationMs: 3100,
    });

    expect(updated.observed?.verifiedSuccess).toBe(false);
    expect(updated.calibration).toBeDefined();
    // Since verifiedSuccess is false (0), error is |predictedSuccessProb - 0|
    expect(updated.calibration!.successProbError).toBeCloseTo(expectedProb, 4);
    expect(updated.calibration!.brierScore).toBeCloseTo(expectedProb * expectedProb, 4);
    expect(updated.calibration!.costEstimationErrorUSD).toBeCloseTo(0.18 - expectedCost, 5);
    expect(updated.calibration!.absCostEstimationErrorUSD).toBeCloseTo(
      Math.abs(0.18 - expectedCost),
      5,
    );
    expect(updated.calibration!.latencyErrorMs).toBe(3100 - expectedLatency);
  });

  it('14. automatically rolls back an activated candidate policy when observed verified success rate drops below threshold', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        minRollbackSamples: 4,
        minObservedVerifiedSuccessRate: 0.6,
        autoRollbackOnGuardFailure: true,
        maxExplorationFraction: 0,
      },
    });

    // Activate shadow policy as the active production policy
    service.activateCandidatePolicy(shadowPolicy);
    expect(service.getActivePolicy().id).toBe(shadowPolicy.id);

    // Run 4 executions where 3 fail verification (25% verified success < 60% threshold)
    const outcomes = [true, false, false, false];
    for (let i = 0; i < outcomes.length; i++) {
      const execId = `exec-rb-${i}`;
      service.evaluateShadow({
        executionId: execId,
        task: makeTask({ id: `task-rb-${i}` }),
        candidates: makeCandidatePool(),
      });
      service.recordObservedOutcome(execId, {
        verifiedSuccess: outcomes[i],
        actualCostUSD: 0.12,
        actualDurationMs: 2500,
      });
    }

    // Service should have automatically rolled back to baselinePolicy
    expect(service.getActivePolicy().id).toBe(baselinePolicy.id);
    expect(service.getExplorationStats().isCandidatePolicyActive).toBe(false);
    const history = service.getRollbackHistory();
    expect(history).toHaveLength(1);
    expect(history[0].fromPolicyId).toBe(shadowPolicy.id);
    expect(history[0].toBaselinePolicyId).toBe(baselinePolicy.id);
    expect(history[0].observedVerifiedSuccessRate).toBeCloseTo(0.25, 2);
    expect(history[0].reason).toContain('dropped below minimum threshold');
  });

  it('15. immediately rolls back candidate policy when a policyViolation is observed', () => {
    const service = new ShadowRouterService({
      baselinePolicy,
      shadowPolicy,
      config: {
        minRollbackSamples: 10,
        autoRollbackOnGuardFailure: true,
      },
    });

    service.activateCandidatePolicy(shadowPolicy);
    service.evaluateShadow({
      executionId: 'exec-pol-violation',
      task: makeTask({ id: 'task-pol-violation' }),
      candidates: makeCandidatePool(),
    });

    service.recordObservedOutcome('exec-pol-violation', {
      verifiedSuccess: true,
      actualCostUSD: 0.1,
      actualDurationMs: 2000,
      policyViolation: true,
    });

    expect(service.getActivePolicy().id).toBe(baselinePolicy.id);
    expect(service.getRollbackHistory()).toHaveLength(1);
    expect(service.getRollbackHistory()[0].reason).toContain('Policy violation');
  });

  it('16. supports manual rollbackToBaseline and persists state + evaluations to KeyValueStore', async () => {
    const store = new MemoryStore();
    const service = new ShadowRouterService({
      store,
      baselinePolicy,
      shadowPolicy,
      config: { maxExplorationFraction: 0.5 },
    });

    service.activateCandidatePolicy(shadowPolicy);
    service.decideWithExploration({
      executionId: 'exec-persist-1',
      task: makeTask({ id: 'task-persist-1' }),
      candidates: makeCandidatePool(),
    });
    service.recordObservedOutcome('exec-persist-1', {
      verifiedSuccess: true,
      actualCostUSD: 0.05,
      actualDurationMs: 1500,
    });

    const manualEvent = service.rollbackToBaseline('Operator initiated manual rollback');
    expect(manualEvent.fromPolicyId).toBe(shadowPolicy.id);
    expect(manualEvent.toBaselinePolicyId).toBe(baselinePolicy.id);
    expect(service.getActivePolicy().id).toBe(baselinePolicy.id);

    await service.flushToStore();

    // Rehydrate a new service instance from the same store
    const rehydrated = new ShadowRouterService({
      store,
      baselinePolicy,
      shadowPolicy,
    });
    await rehydrated.loadFromStore();

    expect(rehydrated.getActivePolicy().id).toBe(baselinePolicy.id);
    expect(rehydrated.getRollbackHistory()).toHaveLength(1);
    expect(rehydrated.getRollbackHistory()[0].reason).toBe('Operator initiated manual rollback');
    const savedEval = rehydrated.getEvaluation('exec-persist-1');
    expect(savedEval).toBeDefined();
    expect(savedEval?.observed?.verifiedSuccess).toBe(true);
    expect(savedEval?.calibration).toBeDefined();
  });
});
