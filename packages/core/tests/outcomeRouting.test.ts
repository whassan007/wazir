import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountRegistry,
  DEFAULT_POLICY,
  MIN_MEASURED_SAMPLES,
  ResourceLedger,
  ResourceRouter,
  TokenBudgetManager,
  type AccountConfig,
  type ResourcePolicy,
  type RouteCandidate,
} from '../src/resources/index.js';
import {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  SchedulingError,
  type HarnessPerformanceLookup,
  type Task,
} from '../src/index.js';

const T0 = Date.UTC(2026, 9, 23, 2, 0, 0);

function createBudgetEnv(
  accounts: AccountConfig[],
  policyOverrides: Partial<ResourcePolicy> = {},
) {
  let clock = T0;
  const ledger = new ResourceLedger(':memory:', () => clock);
  const policy: ResourcePolicy = {
    ...DEFAULT_POLICY,
    enforce: true,
    paidApiFallback: true,
    estimateMargin: 0,
    ...policyOverrides,
  };
  const budget = new TokenBudgetManager(ledger, new AccountRegistry(accounts), policy);
  return {
    ledger,
    budget,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

const localAccount: AccountConfig = {
  id: 'acct-local-dgx',
  provider: 'ollama',
  kind: 'local',
  integration: 'local-endpoint',
  runtimeIds: ['ollama', 'lmstudio'],
  maxConcurrent: 4,
};

const openaiAccount: AccountConfig = {
  id: 'acct-openai-prod',
  provider: 'openai',
  kind: 'api',
  integration: 'api-key',
  runtimeIds: ['openai'],
  allowPaid: true,
  pricing: {
    'gpt-fast-cheap': { inputPerMTok: 1, outputPerMTok: 2 },
    'gpt-reliable-pro': { inputPerMTok: 2, outputPerMTok: 4 },
    'gpt-expensive': { inputPerMTok: 15, outputPerMTok: 60 },
  },
};

const anthropicAccount: AccountConfig = {
  id: 'acct-anthropic-prod',
  provider: 'anthropic',
  kind: 'api',
  integration: 'api-key',
  runtimeIds: ['anthropic'],
  allowPaid: true,
  pricing: { inputPerMTok: 3, outputPerMTok: 15 },
};

const resolveByRuntime = (runtimeId: string): string | undefined => {
  if (runtimeId === 'ollama' || runtimeId === 'lmstudio') return localAccount.id;
  if (runtimeId === 'openai') return openaiAccount.id;
  if (runtimeId === 'anthropic') return anthropicAccount.id;
  return undefined;
};

describe('Outcome-Based Routing Optimizer (ResourceRouter & Scheduler)', () => {
  it('1. evaluates full Candidate = Harness + Model + Runtime + Worker + Account tuple and records audit metadata', () => {
    const { budget, ledger } = createBudgetEnv([localAccount, openaiAccount, anthropicAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const candidates: RouteCandidate[] = [
      {
        harnessId: 'native-harness',
        modelId: 'qwen2.5-coder:32b',
        runtimeId: 'ollama',
        workerId: 'worker-dgx-1',
        capabilityScore: 9,
        residency: 'ready',
        verifiedSuccessRate: 0.88,
        sampleCount: 12,
        uncertainty: 0.06,
        avgLatencyMs: 1200,
      },
      {
        harnessId: 'claude-code-acp',
        modelId: 'claude-sonnet-4',
        runtimeId: 'anthropic',
        workerId: 'worker-cloud',
        capabilityScore: 10,
        residency: 'ready',
        verifiedSuccessRate: 0.92,
        sampleCount: 15,
        uncertainty: 0.05,
        avgLatencyMs: 2400,
      },
    ];

    const assessments = router.assess({
      task: { id: 'task-tuple-1' },
      workload: 'routine',
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
      candidates,
    });

    expect(assessments).toHaveLength(2);
    const localAssessment = assessments.find((a) => a.harnessId === 'native-harness')!;
    const cloudAssessment = assessments.find((a) => a.harnessId === 'claude-code-acp')!;

    expect(localAssessment).toMatchObject({
      harnessId: 'native-harness',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'ollama',
      workerId: 'worker-dgx-1',
      accountId: 'acct-local-dgx',
      admissible: true,
      fallbackRuleBased: false,
      expectedCompletionLatencyMs: 1200,
      expectedLatencyMs: 1200,
      quotaExhaustionRisk: 0,
    });
    expect(localAssessment.predictedVerifiedSuccessProb).toBeCloseTo(0.88 * 0.8, 3);
    expect(cloudAssessment).toMatchObject({
      harnessId: 'claude-code-acp',
      modelId: 'claude-sonnet-4',
      runtimeId: 'anthropic',
      workerId: 'worker-cloud',
      accountId: 'acct-anthropic-prod',
      admissible: true,
      fallbackRuleBased: false,
    });

    const selected = router.selectOptimalCandidate({
      task: { id: 'task-tuple-1' },
      workload: 'routine',
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
      candidates,
    });
    expect(selected).toBeDefined();
    expect(selected?.harnessId).toBe('native-harness');

    const routingEvents = ledger.events({ kind: 'routing' });
    expect(routingEvents.length).toBeGreaterThan(0);
    expect(routingEvents[0].data).toMatchObject({
      chosenHarness: 'native-harness',
      chosenWorker: 'worker-dgx-1',
    });
  });

  it('2. computes full cost breakdown (execution, verification, retry, cold-start, total, and effective per success)', () => {
    const { budget } = createBudgetEnv([openaiAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    // gpt-reliable-pro: $2/M input, $4/M output
    // 100,000 input ($0.20) + 25,000 output ($0.10) => $0.30 execution cost
    const [assessment] = router.assess({
      task: { id: 'task-cost-breakdown' },
      workload: 'routine',
      estimatedInputTokens: 100_000,
      estimatedOutputTokens: 25_000,
      candidates: [
        {
          harnessId: 'native',
          modelId: 'gpt-reliable-pro',
          runtimeId: 'openai',
          workerId: 'hosted-1',
          capabilityScore: 9,
          verifiedSuccessRate: 0.9,
          sampleCount: 10,
          expectedVerificationCostUsd: 0.05,
          expectedRetryCostUsd: 0.08,
          expectedColdStartCostUsd: 0.02,
        },
      ],
    });

    expect(assessment.admissible).toBe(true);
    expect(assessment.expectedExecutionCostUsd).toBeCloseTo(0.3, 6);
    expect(assessment.expectedVerificationCostUsd).toBeCloseTo(0.05, 6);
    expect(assessment.expectedRetryCostUsd).toBeCloseTo(0.08, 6);
    expect(assessment.expectedColdStartCostUsd).toBeCloseTo(0.02, 6);
    expect(assessment.expectedTotalCostUsd).toBeCloseTo(0.3 + 0.05 + 0.08 + 0.02, 6);
    // predictedVerifiedSuccessProb = 0.9 * 0.8 (default account reliability) = 0.72
    expect(assessment.predictedVerifiedSuccessProb).toBeCloseTo(0.72, 4);
    expect(assessment.effectiveCostPerSuccessUsd).toBeCloseTo(0.45 / 0.72, 5);
  });

  it('3. derives expectedRetryCostUsd automatically from failure probability when not explicitly provided', () => {
    const { budget } = createBudgetEnv([openaiAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    // Execution cost = $0.30, verification cost = $0.06 => $0.36 per attempt
    // verifiedSuccessRate = 0.75, rel = 0.8 => successProb = 0.60
    // Expected retry cost = 0.36 * (1 - 0.60) / 0.60 = 0.24
    // Expected total cost = 0.30 + 0.06 + 0.24 + 0.01 (coldStart) = 0.61
    const [assessment] = router.assess({
      task: { id: 'task-auto-retry-cost' },
      workload: 'routine',
      estimatedInputTokens: 100_000,
      estimatedOutputTokens: 25_000,
      candidates: [
        {
          modelId: 'gpt-reliable-pro',
          runtimeId: 'openai',
          capabilityScore: 8,
          verifiedSuccessRate: 0.75,
          sampleCount: 8,
          expectedVerificationCostUsd: 0.06,
          expectedColdStartCostUsd: 0.01,
        },
      ],
    });

    expect(assessment.predictedVerifiedSuccessProb).toBeCloseTo(0.6, 4);
    expect(assessment.expectedExecutionCostUsd).toBeCloseTo(0.3, 6);
    expect(assessment.expectedVerificationCostUsd).toBeCloseTo(0.06, 6);
    expect(assessment.expectedRetryCostUsd).toBeCloseTo(0.24, 6);
    expect(assessment.expectedColdStartCostUsd).toBeCloseTo(0.01, 6);
    expect(assessment.expectedTotalCostUsd).toBeCloseTo(0.61, 6);
    expect(assessment.effectiveCostPerSuccessUsd).toBeCloseTo(0.61, 6);
  });

  it('4. minimizes expected cost per verified completion: higher verified success rate beats cheaper per-call model with high retry waste', () => {
    const { budget } = createBudgetEnv([openaiAccount], { mode: 'budget-first' });
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    // Candidate 1 (gpt-fast-cheap): $1/M in, $2/M out -> 100k in + 25k out = $0.15/call + $0.05 verification = $0.20/attempt
    //   verifiedSuccessRate = 0.25 (rel 0.8 -> p = 0.20) -> expected cost per verified completion = $0.20 / 0.20 = $1.00
    // Candidate 2 (gpt-reliable-pro): $2/M in, $4/M out -> 100k in + 25k out = $0.30/call + $0.05 verification = $0.35/attempt
    //   verifiedSuccessRate = 0.95 (rel 0.8 -> p = 0.76) -> expected cost per verified completion = $0.35 / 0.76 = $0.4605
    const selected = router.selectOptimalCandidate({
      task: { id: 'task-min-verified-cost' },
      workload: 'routine',
      estimatedInputTokens: 100_000,
      estimatedOutputTokens: 25_000,
      optimizeFor: 'cost_per_verified_success',
      candidates: [
        {
          harnessId: 'native',
          modelId: 'gpt-fast-cheap',
          runtimeId: 'openai',
          capabilityScore: 8,
          verifiedSuccessRate: 0.25,
          sampleCount: 10,
          expectedVerificationCostUsd: 0.05,
        },
        {
          harnessId: 'native',
          modelId: 'gpt-reliable-pro',
          runtimeId: 'openai',
          capabilityScore: 8,
          verifiedSuccessRate: 0.95,
          sampleCount: 10,
          expectedVerificationCostUsd: 0.05,
        },
      ],
    });

    expect(selected).toBeDefined();
    expect(selected!.modelId).toBe('gpt-reliable-pro');
    expect(selected!.effectiveCostPerSuccessUsd).toBeLessThan(0.5);
  });

  it('5. enforces minVerifiedSuccessRate hard constraint when empirical sampleCount >= MIN_MEASURED_SAMPLES', () => {
    const { budget } = createBudgetEnv([openaiAccount], { minVerifiedSuccessRate: 0.7 });
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const assessments = router.assess({
      task: { id: 'task-min-quality' },
      workload: 'routine',
      estimatedInputTokens: 10_000,
      candidates: [
        {
          modelId: 'gpt-fast-cheap',
          runtimeId: 'openai',
          capabilityScore: 7,
          verifiedSuccessRate: 0.55,
          sampleCount: 6,
        },
        {
          modelId: 'gpt-reliable-pro',
          runtimeId: 'openai',
          capabilityScore: 9,
          verifiedSuccessRate: 0.85,
          sampleCount: 6,
        },
      ],
    });

    const rejected = assessments.find((a) => a.modelId === 'gpt-fast-cheap')!;
    const admitted = assessments.find((a) => a.modelId === 'gpt-reliable-pro')!;

    expect(rejected.admissible).toBe(false);
    expect(rejected.reasons.join(' ')).toContain('below policy minimum 70%');
    expect(admitted.admissible).toBe(true);
  });

  it('6. falls back to rule-based routing when empirical sampleCount < 3 (MIN_MEASURED_SAMPLES)', () => {
    expect(MIN_MEASURED_SAMPLES).toBe(3);
    const { budget } = createBudgetEnv([openaiAccount], { minVerifiedSuccessRate: 0.7 });
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    // Even though verifiedSuccessRate is 0.2, sampleCount is 2 (< 3), so router must NOT trust it,
    // must set fallbackRuleBased = true, and use rule-based reliability prior (0.8).
    const [assessment] = router.assess({
      task: { id: 'task-low-samples' },
      workload: 'routine',
      estimatedInputTokens: 10_000,
      candidates: [
        {
          harnessId: 'external-cli',
          modelId: 'gpt-fast-cheap',
          runtimeId: 'openai',
          capabilityScore: 8,
          verifiedSuccessRate: 0.2,
          sampleCount: 2,
        },
      ],
    });

    expect(assessment.admissible).toBe(true);
    expect(assessment.fallbackRuleBased).toBe(true);
    expect(assessment.predictedVerifiedSuccessProb).toBeCloseTo(0.8, 4);
    expect(assessment.scoringRationale?.some((r) => r.includes('sampleCount (2) < MIN_MEASURED_SAMPLES (3)'))).toBe(true);
  });

  it('7. sets fallbackRuleBased=true when verifiedSuccessRate is undefined (unmeasured candidate)', () => {
    const { budget } = createBudgetEnv([localAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const [assessment] = router.assess({
      task: { id: 'task-unmeasured' },
      workload: 'routine',
      estimatedInputTokens: 5_000,
      candidates: [
        {
          harnessId: 'native',
          modelId: 'qwen-local',
          runtimeId: 'ollama',
          capabilityScore: 7,
        },
      ],
    });

    expect(assessment.admissible).toBe(true);
    expect(assessment.fallbackRuleBased).toBe(true);
    expect(assessment.predictedVerifiedSuccessProb).toBeCloseTo(0.8, 4);
    expect(assessment.scoringRationale?.some((r) => r.includes('no empirical verifiedSuccessRate measurement'))).toBe(true);
  });

  it('8. rejects candidates when predicted completion latency (generation + cold-start) exceeds deadlineMs / maxLatencyMs', () => {
    const { budget } = createBudgetEnv([localAccount, openaiAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const assessments = router.assess({
      task: { id: 'task-deadline' },
      workload: 'routine',
      estimatedInputTokens: 8_000,
      deadlineMs: 5_000,
      candidates: [
        {
          harnessId: 'native',
          modelId: 'cold-local-70b',
          runtimeId: 'ollama',
          workerId: 'dgx-1',
          capabilityScore: 9,
          residency: 'load',
          estimatedLoadMs: 4_500,
          avgLatencyMs: 2_000, // 4500 + 2000 = 6500ms > 5000ms deadline
          verifiedSuccessRate: 0.9,
          sampleCount: 5,
        },
        {
          harnessId: 'native',
          modelId: 'gpt-reliable-pro',
          runtimeId: 'openai',
          workerId: 'cloud',
          capabilityScore: 9,
          residency: 'ready',
          avgLatencyMs: 1_800, // 1800ms <= 5000ms deadline
          verifiedSuccessRate: 0.9,
          sampleCount: 5,
        },
      ],
    });

    const slowCandidate = assessments.find((a) => a.modelId === 'cold-local-70b')!;
    const fastCandidate = assessments.find((a) => a.modelId === 'gpt-reliable-pro')!;

    expect(slowCandidate.admissible).toBe(false);
    expect(slowCandidate.expectedCompletionLatencyMs).toBe(6_500);
    expect(slowCandidate.reasons.join(' ')).toMatch(/exceeds maxLatencyMs 5000ms \(deadline exceeded\)/);

    expect(fastCandidate.admissible).toBe(true);
    expect(fastCandidate.expectedCompletionLatencyMs).toBe(1_800);
  });

  it('9. rejects candidates when expectedTotalCostUsd exceeds maxCostUSD budget', () => {
    const { budget } = createBudgetEnv([openaiAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const assessments = router.assess({
      task: { id: 'task-budget-cap' },
      workload: 'routine',
      estimatedInputTokens: 100_000,
      estimatedOutputTokens: 20_000,
      maxCostUSD: 0.50,
      candidates: [
        {
          // 100k * $15/M ($1.50) + 20k * $60/M ($1.20) = $2.70 execution cost > $0.50 maxCostUSD
          modelId: 'gpt-expensive',
          runtimeId: 'openai',
          capabilityScore: 10,
          verifiedSuccessRate: 0.95,
          sampleCount: 10,
        },
        {
          // 100k * $1/M ($0.10) + 20k * $2/M ($0.04) = $0.14 execution cost
          // p = 0.85 * 0.8 = 0.68 -> total expected cost = 0.14 / 0.68 = $0.2059 <= $0.50
          modelId: 'gpt-fast-cheap',
          runtimeId: 'openai',
          capabilityScore: 8,
          verifiedSuccessRate: 0.85,
          sampleCount: 10,
        },
      ],
    });

    const expensive = assessments.find((a) => a.modelId === 'gpt-expensive')!;
    const affordable = assessments.find((a) => a.modelId === 'gpt-fast-cheap')!;

    expect(expensive.admissible).toBe(false);
    expect(expensive.expectedTotalCostUsd).toBeGreaterThan(0.50);
    expect(expensive.reasons.join(' ')).toContain('exceeds maxCostUSD budget $0.5000');

    expect(affordable.admissible).toBe(true);
    expect(affordable.expectedTotalCostUsd).toBeLessThanOrEqual(0.50);
  });

  it('10. enforces runtime availability, worker availability, and GPU KV-cache fit as hard constraints', () => {
    const { budget } = createBudgetEnv([localAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const assessments = router.assess({
      task: { id: 'task-hw-constraints' },
      workload: 'routine',
      estimatedInputTokens: 16_000,
      candidates: [
        {
          modelId: 'model-runtime-down',
          runtimeId: 'ollama',
          workerId: 'worker-1',
          capabilityScore: 8,
          runtimeAvailable: false,
        },
        {
          modelId: 'model-worker-down',
          runtimeId: 'ollama',
          workerId: 'worker-offline',
          capabilityScore: 8,
          workerAvailable: false,
        },
        {
          modelId: 'model-vram-oom',
          runtimeId: 'ollama',
          workerId: 'worker-1',
          capabilityScore: 8,
          kvCacheFits: false,
        },
        {
          modelId: 'model-healthy',
          runtimeId: 'ollama',
          workerId: 'worker-1',
          capabilityScore: 8,
          runtimeAvailable: true,
          workerAvailable: true,
          kvCacheFits: true,
        },
      ],
    });

    expect(assessments.find((a) => a.modelId === 'model-runtime-down')?.admissible).toBe(false);
    expect(assessments.find((a) => a.modelId === 'model-runtime-down')?.reasons.join(' ')).toContain("runtime 'ollama' is unavailable");

    expect(assessments.find((a) => a.modelId === 'model-worker-down')?.admissible).toBe(false);
    expect(assessments.find((a) => a.modelId === 'model-worker-down')?.reasons.join(' ')).toContain("worker 'worker-offline' is unavailable");

    expect(assessments.find((a) => a.modelId === 'model-vram-oom')?.admissible).toBe(false);
    expect(assessments.find((a) => a.modelId === 'model-vram-oom')?.reasons.join(' ')).toContain('insufficient usable GPU VRAM');

    expect(assessments.find((a) => a.modelId === 'model-healthy')?.admissible).toBe(true);
  });

  it('11. reflects account quota exhaustion risk and blocks unauthorized paid accounts', () => {
    const subAccount: AccountConfig = {
      id: 'sub-claude',
      provider: 'claude',
      kind: 'subscription',
      integration: 'vendor-cli',
      runtimeIds: ['claude-cli'],
      limits: [{ unit: 'tokens', window: '5h', limit: 10_000, source: 'configured' }],
    };
    const unauthorizedPaid: AccountConfig = {
      id: 'paid-unauth',
      provider: 'openai',
      kind: 'api',
      integration: 'api-key',
      runtimeIds: ['openai'],
      allowPaid: false,
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    };

    const { budget } = createBudgetEnv([subAccount, unauthorizedPaid], { paidApiFallback: false });
    // Reserve 7,200 tokens on subAccount -> adding 500 tokens puts it at 77% (advisory mode -> quotaExhaustionRisk = 0.3)
    budget.admit({
      requestId: 'r-warmup',
      accountId: 'sub-claude',
      modelId: 'claude-sonnet',
      workload: 'routine',
      estimatedInputTokens: 7_200,
      estimatedOutputTokens: 0,
    });

    const router = new ResourceRouter({
      budget,
      resolveAccount: (rt) => (rt === 'claude-cli' ? 'sub-claude' : rt === 'openai' ? 'paid-unauth' : undefined),
    });

    const assessments = router.assess({
      task: { id: 'task-quota-risk' },
      workload: 'routine',
      estimatedInputTokens: 300,
      estimatedOutputTokens: 200,
      candidates: [
        { modelId: 'claude-sonnet', runtimeId: 'claude-cli', capabilityScore: 9, verifiedSuccessRate: 0.9, sampleCount: 5 },
        { modelId: 'gpt-4o', runtimeId: 'openai', capabilityScore: 9, verifiedSuccessRate: 0.9, sampleCount: 5 },
      ],
    });

    const subAssessment = assessments.find((a) => a.modelId === 'claude-sonnet')!;
    const paidAssessment = assessments.find((a) => a.modelId === 'gpt-4o')!;

    expect(subAssessment.admissible).toBe(true);
    expect(subAssessment.quotaExhaustionRisk).toBeCloseTo(0.3, 4);

    expect(paidAssessment.admissible).toBe(false);
    expect(paidAssessment.reasons.join(' ')).toContain('paid fallback is not authorized');
  });

  it('12. populates structured scoringRationale with candidate identity, empirical calibration, cost, latency, and utility breakdown', () => {
    const { budget } = createBudgetEnv([openaiAccount]);
    const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

    const [assessment] = router.assess({
      task: { id: 'task-rationale' },
      workload: 'routine',
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
      candidates: [
        {
          harnessId: 'codex-acp',
          modelId: 'gpt-reliable-pro',
          runtimeId: 'openai',
          workerId: 'worker-cloud-2',
          capabilityScore: 9,
          verifiedSuccessRate: 0.91,
          sampleCount: 14,
          uncertainty: 0.04,
          avgLatencyMs: 1450,
          expectedVerificationCostUsd: 0.01,
          expectedColdStartCostUsd: 0.005,
        },
      ],
    });

    expect(assessment.scoringRationale).toBeDefined();
    expect(assessment.rationale).toEqual(assessment.scoringRationale);
    const joined = assessment.scoringRationale!.join('\n');
    expect(joined).toContain('candidate: harness=codex-acp model=gpt-reliable-pro runtime=openai worker=worker-cloud-2 account=acct-openai-prod');
    expect(joined).toContain('empirical: verifiedSuccessRate=91.0% over 14 samples (uncertainty=4.0%)');
    expect(joined).toContain('cost: execution=');
    expect(joined).toContain('latency: expectedCompletionLatencyMs=1450ms');
    expect(joined).toContain('quotaRisk: 0% (mode=normal)');
    expect(joined).toContain('utility: score=');
  });

  describe('Scheduler integration with HarnessPerformanceLookup and ResourceRouter', () => {
    let computers: ComputerRegistry;
    let runtimes: RuntimeRegistry;
    let models: ModelRegistry;
    let agents: AgentRegistry;
    let policy: PolicyEngine;

    beforeEach(() => {
      computers = new ComputerRegistry();
      runtimes = new RuntimeRegistry();
      models = new ModelRegistry();
      agents = new AgentRegistry();
      policy = new PolicyEngine();

      computers.register({
        id: 'dgx-node-1',
        name: 'DGX Node 1',
        type: 'workstation',
        local: true,
        os: { platform: 'linux', architecture: 'x64', version: '6.8' },
        hardware: { cpu: 'Grace', cpuCores: 32, memoryGB: 128, gpu: { vendor: 'nvidia', model: 'GH200', memoryGB: 96, cuda: true } },
        runtimes: ['ollama'],
        models: ['model-alpha', 'model-beta'],
        capabilities: ['localExecution'],
      });

      runtimes.register({
        id: 'ollama',
        type: 'ollama',
        name: 'Ollama',
        version: '0.5',
        computerId: 'dgx-node-1',
        health: 'healthy',
        capabilities: {
          chat: true,
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          vision: false,
          embeddings: false,
          reasoning: true,
          modelLoad: true,
          modelUnload: true,
          modelDownload: false,
          statefulChat: false,
          mcp: false,
        },
        loadedModels: ['model-alpha', 'model-beta'],
      });

      for (const id of ['model-alpha', 'model-beta']) {
        models.register({
          id,
          name: id,
          provider: 'ollama',
          family: 'qwen',
          contextMax: 32768,
          capabilities: ['generalChat', 'coding'],
          toolCalling: true,
          structuredOutput: true,
          vision: false,
          audio: false,
          embedding: false,
          reasoning: true,
          runtimeCompatibility: ['ollama'],
          local: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        models.upsertInstance({
          id: `inst-${id}`,
          modelId: id,
          computerId: 'dgx-node-1',
          runtimeId: 'ollama',
          runtimeModelId: `${id}:latest`,
          state: 'READY',
          loaded: true,
          health: 'healthy',
        });
      }

      agents.register({
        descriptor: {
          name: 'wazir-coding-harness',
          version: '1.0.0',
          description: 'Coding harness',
          capabilities: ['coding'],
          taskTypes: ['coding'],
          stepModes: ['act'],
          supportsStreaming: false,
          supportsCancellation: true,
          supportsCheckpointing: true,
        },
        execute: async () => ({ status: 'completed', output: 'ok' }) as any,
      });
    });

    it('13. passes resolved harnessId, sampleCount, and empirical verifiedSuccessRate into ResourceRouter and selects top-performing model', () => {
      const { budget } = createBudgetEnv([localAccount], { mode: 'quality-first' });
      const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

      const seenParams: Array<Parameters<HarnessPerformanceLookup['getSuccessRate']>[0]> = [];
      const harnessPerformance: HarnessPerformanceLookup = {
        getSuccessRate(params) {
          seenParams.push(params);
          if (params.modelId === 'model-alpha') {
            return { verifiedSuccessRate: 0.45, sampleCount: 8, uncertainty: 0.12, avgLatencyMs: 2200 };
          }
          if (params.modelId === 'model-beta') {
            return { verifiedSuccessRate: 0.94, sampleCount: 10, uncertainty: 0.05, avgLatencyMs: 1100 };
          }
          return undefined;
        },
      };

      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        agents,
        policy,
        harnessPerformance,
        resources: { router },
      });

      const task: Task = {
        id: 'task-sched-outcome-1',
        type: 'coding',
        input: 'Implement feature X with unit tests',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const decision = scheduler.plan({ task });

      expect(decision.agentId).toBe('wazir-coding-harness');
      expect(decision.modelId).toBe('model-beta');
      expect(decision.modelDecision.strategy).toBe('empirical_profile');
      expect(seenParams.some((p) => p.harnessId === 'wazir-coding-harness' && p.modelId === 'model-beta')).toBe(true);
      expect(decision.modelDecision.reasons.some((r) => r.startsWith('outcome-routing:'))).toBe(true);
      expect(decision.modelDecision.empiricalExplanation?.selectionReason).toContain('outcome-routing:');
    });

    it('14. falls back to rule-based routing in Scheduler when harnessPerformance reports sampleCount < 3', () => {
      const { budget } = createBudgetEnv([localAccount], { minVerifiedSuccessRate: 0.75 });
      const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

      const harnessPerformance: HarnessPerformanceLookup = {
        getSuccessRate(params) {
          // Low sample count (2 < 3) with low score 0.30 should NOT reject the model under minVerifiedSuccessRate,
          // because outcome routing falls back to rule-based routing when sampleCount < 3.
          return {
            verifiedSuccessRate: params.modelId === 'model-alpha' ? 0.30 : 0.25,
            sampleCount: 2,
            uncertainty: 0.4,
          };
        },
      };

      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        agents,
        policy,
        harnessPerformance,
        resources: { router },
      });

      const task: Task = {
        id: 'task-sched-fallback',
        type: 'coding',
        input: 'Fix minor lint issue',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const decision = scheduler.plan({ task });
      expect(decision.modelId).toBe('model-alpha');
      expect(
        decision.modelDecision.reasons.some((r) =>
          r.includes('insufficient samples (2 < 3); fallback to rule-based routing'),
        ),
      ).toBe(true);
      expect(
        decision.modelDecision.reasons.some((r) =>
          r.includes('fallback: rule-based prior used because empirical sampleCount (2) < MIN_MEASURED_SAMPLES (3)'),
        ),
      ).toBe(true);
    });

    it('15. rejects candidate in Scheduler when empirical harness latency or verifiedSuccessRate violates policy bounds', () => {
      const { budget } = createBudgetEnv([localAccount], {
        minVerifiedSuccessRate: 0.65,
        maxLatencyMs: 3000,
      });
      const router = new ResourceRouter({ budget, resolveAccount: resolveByRuntime });

      const harnessPerformance: HarnessPerformanceLookup = {
        getSuccessRate(params) {
          if (params.modelId === 'model-alpha') {
            // Exceeds maxLatencyMs (4800 > 3000)
            return { verifiedSuccessRate: 0.90, sampleCount: 6, avgLatencyMs: 4800 };
          }
          if (params.modelId === 'model-beta') {
            // Within latency (1500 <= 3000) and above minVerifiedSuccessRate (0.85 >= 0.65)
            return { verifiedSuccessRate: 0.85, sampleCount: 6, avgLatencyMs: 1500 };
          }
          return undefined;
        },
      };

      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        agents,
        policy,
        harnessPerformance,
        resources: { router },
      });

      const task: Task = {
        id: 'task-sched-reject-slow',
        type: 'coding',
        input: 'Implement parser module',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const decision = scheduler.plan({ task });
      expect(decision.modelId).toBe('model-beta');

      const alphaEval = decision.modelDecision.empiricalExplanation?.evaluatedCandidates.find(
        (c) => c.modelId === 'model-alpha',
      );
      expect(alphaEval?.eligible).toBe(false);
      expect(alphaEval?.resourceAllowed).toBe(false);
      expect(alphaEval?.resourceRejection).toContain('exceeds maxLatencyMs 3000ms');

      // Also verify that pinning the ineligible model fails closed with SchedulingError
      expect(() =>
        scheduler.plan({
          task: { ...task, execution: { targetModelId: 'model-alpha' } },
        }),
      ).toThrowError(SchedulingError);
    });
  });
});
