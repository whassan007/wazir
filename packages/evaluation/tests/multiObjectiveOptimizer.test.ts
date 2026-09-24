import { describe, it, expect, beforeEach } from 'vitest';
import type {
  BenchmarkRunner,
  BenchmarkTask,
  CandidateImplementation,
  CandidateMetricVector,
  ExecutionRecord,
  ExperimentPlan,
  MultiObjectiveParetoFrontier,
  OptimizationObjective,
} from '@wazir/core';
import {
  extractMetricValueSafe,
  computeBaselineRelativeDelta,
  isBetterOrEqual,
  isStrictlyBetter,
  candidateDominates,
  candidateVectorsEquivalent,
  evaluateMetricConstraint,
  computeParetoFrontier,
  computeHypervolume,
  applySelectionPolicy,
  explainMultiObjectiveExperiment,
} from '../src/multiObjectiveOptimizer.js';
import {
  MetaOptimizerService,
  DEFAULT_OPTIMIZABLE_CONFIG,
} from '../src/metaOptimizerService.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { RegressionGuard } from '../src/regressionGuard.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';

describe('Multi-Objective Empirical Optimization', () => {
  let memoryService: MemoryService;
  let evaluationService: EvaluationService;
  let benchmarkService: BenchmarkService;
  let metaOptimizer: MetaOptimizerService;
  let store: MemoryStore;

  const sampleTask: BenchmarkTask = {
    id: 'mo-task-1',
    name: 'Multi-Objective Benchmark Task',
    category: 'CODE_REPAIR',
    description: 'Repair task with multiple measurable dimensions',
    prompt: 'Fix parser memory leak',
    expectedFiles: ['parser.ts'],
    mutationRequired: true,
  };

  beforeEach(() => {
    store = new MemoryStore();
    memoryService = new MemoryService();
    evaluationService = new EvaluationService();
    benchmarkService = new BenchmarkService(evaluationService);
    benchmarkService.register(sampleTask);

    metaOptimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      memoryService,
      store,
    });
  });

  // ======================================================================
  // 1. Single-Objective Backward Compatibility
  // ======================================================================
  it('1. single-objective backward compatibility: operates smoothly without objectives array', async () => {
    // Single objective plan with primaryMetric only
    const legacyPlan: ExperimentPlan = {
      experimentId: 'exp-single-legacy',
      name: 'legacy-single-metric-experiment',
      hypothesis: {
        id: 'hyp-legacy',
        targetComponent: 'ContextCompiler',
        domain: 'context_policy',
        proposedChange: 'Reduce definition weights',
        expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.15, direction: 'decrease' },
        possibleRegressions: [],
        requiredBenchmark: ['CODE_REPAIR'],
        successThreshold: 70_000,
      },
      primaryMetric: 'input_tokens',
      secondaryMetrics: [],
      requiredImprovement: {
        metric: 'input_tokens',
        operator: '<=',
        targetValue: 70_000,
      },
      regressionConstraints: {},
      benchmarkCategories: ['CODE_REPAIR'],
      benchmarkTasks: ['mo-task-1'],
      sampleSize: 2,
      budget: { maxExperiments: 2, maxCandidatesPerExperiment: 1, maxModelCalls: 10, maxTokens: 100_000, maxWallTimeMs: 5000 },
      createdAt: new Date(),
    };

    const candidates = await metaOptimizer.generateCandidates(legacyPlan, 1);
    let runIndex = 0;

    const runner: BenchmarkRunner = {
      id: 'legacy-runner',
      name: 'Legacy Single-Objective Runner',
      async run(task) {
        runIndex++;
        const isCand = runIndex > 1;
        return {
          execution: {
            id: `exec-${task.id}-${runIndex}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'qwen',
            status: 'completed',
            createdAt: new Date(Date.now() - 200),
            completedAt: new Date(),
          },
          task: {
            id: task.id,
            type: 'benchmark',
            title: task.name,
            input: task.prompt,
            requirements: {},
            priority: 'normal',
            status: 'completed',
            createdAt: new Date(),
          },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: task.expectedFiles ?? [],
          checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
          errors: [],
          events: [],
          usage: { input: isCand ? 65_000 : 80_000, output: 500 },
        };
      },
    };

    const results = await metaOptimizer.evaluateCandidates({
      plan: legacyPlan,
      candidates,
      runner,
      tasks: [sampleTask],
    });

    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe('QUALIFIED');
    expect(results[0].comparison.tokenUsageDelta).toBeLessThan(0);
    // Backward compatibility: no error thrown when plan.objectives is absent
    expect(results[0].paretoFrontier).toBeUndefined();
  });

  // ======================================================================
  // 2. Two-Objective Frontier
  // ======================================================================
  it('2. two-objective frontier: detects non-dominated tradeoff pair', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 1.0 },
    ];

    const c1: CandidateMetricVector = {
      candidateId: 'C1-TokenSaver',
      rawMetrics: { input_tokens: 60_000, wall_time: 250 },
      normalizedDeltas: { input_tokens: -0.25, wall_time: 0.10 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c2: CandidateMetricVector = {
      candidateId: 'C2-SpeedSpecialist',
      rawMetrics: { input_tokens: 85_000, wall_time: 150 },
      normalizedDeltas: { input_tokens: 0.06, wall_time: -0.35 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1, c2], objectives);

    expect(frontier.frontierCandidates).toHaveLength(2);
    expect(frontier.dominatedCandidates).toHaveLength(0);
    expect(frontier.frontierCandidates.map((c) => c.candidateId)).toEqual(['C1-TokenSaver', 'C2-SpeedSpecialist']);
  });

  // ======================================================================
  // 3. Three-Objective Frontier
  // ======================================================================
  it('3. three-objective frontier: retains 3 non-dominated competing specialists', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'repair_cycles', direction: 'MINIMIZE', importance: 1.0 },
    ];

    // C1: balanced (better wall time than C2, better tokens/repairs than C3)
    const c1: CandidateMetricVector = {
      candidateId: 'C1-Balanced',
      rawMetrics: { input_tokens: 75_000, wall_time: 220, repair_cycles: 2 },
      normalizedDeltas: { input_tokens: -0.15, wall_time: -0.10, repair_cycles: -0.33 },
      qualifies: true,
      disqualificationReasons: [],
    };

    // C2: token specialist (lowest tokens, best repairs, but higher latency)
    const c2: CandidateMetricVector = {
      candidateId: 'C2-TokenSpecialist',
      rawMetrics: { input_tokens: 60_000, wall_time: 280, repair_cycles: 1 },
      normalizedDeltas: { input_tokens: -0.30, wall_time: 0.15, repair_cycles: -0.66 },
      qualifies: true,
      disqualificationReasons: [],
    };

    // C3: speed specialist (fastest latency, but highest tokens)
    const c3: CandidateMetricVector = {
      candidateId: 'C3-SpeedSpecialist',
      rawMetrics: { input_tokens: 90_000, wall_time: 140, repair_cycles: 3 },
      normalizedDeltas: { input_tokens: 0.05, wall_time: -0.45, repair_cycles: 0 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1, c2, c3], objectives);

    expect(frontier.frontierCandidates).toHaveLength(3);
    expect(frontier.dominatedCandidates).toHaveLength(0);
    expect(frontier.frontierCandidates.map((c) => c.candidateId)).toEqual([
      'C1-Balanced',
      'C2-TokenSpecialist',
      'C3-SpeedSpecialist',
    ]);
  });

  // ======================================================================
  // 4. Dominated Candidate Removed
  // ======================================================================
  it('4. dominated candidate removed: excludes strictly inferior candidates from frontier', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'repair_cycles', direction: 'MINIMIZE', importance: 1.0 },
    ];

    const c1: CandidateMetricVector = {
      candidateId: 'C1-Leader',
      rawMetrics: { input_tokens: 70_000, wall_time: 200, repair_cycles: 2 },
      normalizedDeltas: { input_tokens: -0.20, wall_time: -0.20, repair_cycles: -0.33 },
      qualifies: true,
      disqualificationReasons: [],
    };

    // C4 is worse than C1 in every dimension
    const c4: CandidateMetricVector = {
      candidateId: 'C4-Dominated',
      rawMetrics: { input_tokens: 75_000, wall_time: 220, repair_cycles: 3 },
      normalizedDeltas: { input_tokens: -0.10, wall_time: -0.10, repair_cycles: 0 },
      qualifies: true,
      disqualificationReasons: [],
    };

    expect(candidateDominates(c1, c4, objectives)).toBe(true);
    expect(candidateDominates(c4, c1, objectives)).toBe(false);

    const frontier = computeParetoFrontier([c1, c4], objectives);

    expect(frontier.frontierCandidates).toHaveLength(1);
    expect(frontier.frontierCandidates[0].candidateId).toBe('C1-Leader');
    expect(frontier.dominatedCandidates).toHaveLength(1);
    expect(frontier.dominatedCandidates[0].candidateId).toBe('C4-Dominated');
  });

  // ======================================================================
  // 5. Equivalent Candidates Retained
  // ======================================================================
  it('5. equivalent candidates retained: keeps tied candidates on the frontier', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 1.0 },
    ];

    const c1: CandidateMetricVector = {
      candidateId: 'C1-TwinA',
      rawMetrics: { input_tokens: 70_000, wall_time: 200 },
      normalizedDeltas: { input_tokens: -0.20, wall_time: -0.20 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c2: CandidateMetricVector = {
      candidateId: 'C2-TwinB',
      rawMetrics: { input_tokens: 70_000, wall_time: 200 },
      normalizedDeltas: { input_tokens: -0.20, wall_time: -0.20 },
      qualifies: true,
      disqualificationReasons: [],
    };

    expect(candidateVectorsEquivalent(c1, c2, objectives)).toBe(true);
    expect(candidateDominates(c1, c2, objectives)).toBe(false);
    expect(candidateDominates(c2, c1, objectives)).toBe(false);

    const frontier = computeParetoFrontier([c1, c2], objectives);

    expect(frontier.frontierCandidates).toHaveLength(2);
    expect(frontier.dominatedCandidates).toHaveLength(0);
  });

  // ======================================================================
  // 6. Correctness Failure Excluded (Constraints First)
  // ======================================================================
  it('6. correctness failure excluded: never admits failing candidate to frontier', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
      { metric: 'wall_time', direction: 'MINIMIZE' },
    ];

    // C1 has phenomenal metrics but failed correctness/verification
    const c1Failing: CandidateMetricVector = {
      candidateId: 'C1-BrokenCorrectness',
      rawMetrics: { input_tokens: 10_000, wall_time: 50 },
      normalizedDeltas: { input_tokens: -0.90, wall_time: -0.80 },
      qualifies: false,
      disqualificationReasons: ['VERIFICATION_FAILURE: Unit test failed on parser'],
    };

    const c2Passing: CandidateMetricVector = {
      candidateId: 'C2-ValidCandidate',
      rawMetrics: { input_tokens: 75_000, wall_time: 200 },
      normalizedDeltas: { input_tokens: -0.15, wall_time: -0.20 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1Failing, c2Passing], objectives);

    // Failing candidate MUST be excluded from frontierCandidates
    expect(frontier.frontierCandidates).toHaveLength(1);
    expect(frontier.frontierCandidates[0].candidateId).toBe('C2-ValidCandidate');
  });

  // ======================================================================
  // 7. Protected Regression Excluded (Zero Regression)
  // ======================================================================
  it('7. protected regression excluded: excludes candidates triggering protected metric violation', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
    ];

    const c1Regressed: CandidateMetricVector = {
      candidateId: 'C1-Regressed',
      rawMetrics: { input_tokens: 50_000, task_success: 0.5 },
      normalizedDeltas: { input_tokens: -0.40, task_success: -0.50 },
      qualifies: false,
      disqualificationReasons: ['PROTECTED_METRIC_REGRESSION: task_success dropped below threshold'],
    };

    const c2Safe: CandidateMetricVector = {
      candidateId: 'C2-Safe',
      rawMetrics: { input_tokens: 70_000, task_success: 1.0 },
      normalizedDeltas: { input_tokens: -0.15, task_success: 0 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1Regressed, c2Safe], objectives);

    expect(frontier.frontierCandidates).toHaveLength(1);
    expect(frontier.frontierCandidates[0].candidateId).toBe('C2-Safe');
  });

  // ======================================================================
  // 8. Deterministic Frontier
  // ======================================================================
  it('8. deterministic frontier: produces identical ordered frontier regardless of candidate permutation', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
      { metric: 'wall_time', direction: 'MINIMIZE' },
    ];

    const cA: CandidateMetricVector = {
      candidateId: 'C-Alpha',
      rawMetrics: { input_tokens: 60_000, wall_time: 250 },
      normalizedDeltas: { input_tokens: -0.25, wall_time: 0.1 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const cB: CandidateMetricVector = {
      candidateId: 'C-Beta',
      rawMetrics: { input_tokens: 80_000, wall_time: 150 },
      normalizedDeltas: { input_tokens: 0.05, wall_time: -0.3 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const cC: CandidateMetricVector = {
      candidateId: 'C-Gamma',
      rawMetrics: { input_tokens: 70_000, wall_time: 200 },
      normalizedDeltas: { input_tokens: -0.10, wall_time: -0.1 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const f1 = computeParetoFrontier([cA, cB, cC], objectives);
    const f2 = computeParetoFrontier([cC, cA, cB], objectives);
    const f3 = computeParetoFrontier([cB, cC, cA], objectives);

    const ids1 = f1.frontierCandidates.map((c) => c.candidateId);
    const ids2 = f2.frontierCandidates.map((c) => c.candidateId);
    const ids3 = f3.frontierCandidates.map((c) => c.candidateId);

    expect(ids1).toEqual(['C-Alpha', 'C-Beta', 'C-Gamma']);
    expect(ids2).toEqual(ids1);
    expect(ids3).toEqual(ids1);
    expect(f1.hypervolume).toBe(f2.hypervolume);
  });

  // ======================================================================
  // 9. Lexicographic Selection
  // ======================================================================
  it('9. lexicographic selection: picks best candidate using strict objective priority ordering', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
      { metric: 'wall_time', direction: 'MINIMIZE' },
    ];

    // C1 and C2 tie on input_tokens, C2 has better wall_time
    const c1: CandidateMetricVector = {
      candidateId: 'C1',
      rawMetrics: { input_tokens: 65_000, wall_time: 240 },
      normalizedDeltas: { input_tokens: -0.2, wall_time: 0.1 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c2: CandidateMetricVector = {
      candidateId: 'C2',
      rawMetrics: { input_tokens: 65_000, wall_time: 190 },
      normalizedDeltas: { input_tokens: -0.2, wall_time: -0.1 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c3: CandidateMetricVector = {
      candidateId: 'C3',
      rawMetrics: { input_tokens: 75_000, wall_time: 150 },
      normalizedDeltas: { input_tokens: 0.05, wall_time: -0.3 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1, c2, c3], objectives);

    const plan: ExperimentPlan = {
      experimentId: 'exp-lex',
      name: 'lexicographic-test',
      hypothesis: { id: 'h', targetComponent: 'C', domain: 'context_policy', proposedChange: '', expectedMetricEffect: { metric: 'input_tokens', expectedDelta: 0, direction: 'decrease' }, possibleRegressions: [], requiredBenchmark: [], successThreshold: 0 },
      primaryMetric: 'input_tokens',
      secondaryMetrics: [],
      benchmarkCategories: [],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 3, maxModelCalls: 10, maxTokens: 1000, maxWallTimeMs: 1000 },
      createdAt: new Date(),
      objectives,
      selectionPolicy: 'LEXICOGRAPHIC',
      lexicographicOrder: ['input_tokens', 'wall_time'],
    };

    const decision = applySelectionPolicy(frontier, plan);

    expect(decision.selectedCandidateId).toBe('C2');
    expect(decision.selectionReason).toContain('LEXICOGRAPHIC');
  });

  // ======================================================================
  // 10. Weighted-After-Pareto Selection
  // ======================================================================
  it('10. weighted-after-Pareto: scores non-dominated candidates by pre-registered weights', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 0.8 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 0.2 },
    ];

    const c1TokenHeavy: CandidateMetricVector = {
      candidateId: 'C1-TokenHeavy',
      rawMetrics: { input_tokens: 50_000, wall_time: 250 },
      normalizedDeltas: { input_tokens: -0.40, wall_time: 0.10 }, // 40% token savings
      qualifies: true,
      disqualificationReasons: [],
    };

    const c2SpeedHeavy: CandidateMetricVector = {
      candidateId: 'C2-SpeedHeavy',
      rawMetrics: { input_tokens: 85_000, wall_time: 140 },
      normalizedDeltas: { input_tokens: 0.05, wall_time: -0.40 }, // 40% speedup
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1TokenHeavy, c2SpeedHeavy], objectives);

    const plan: ExperimentPlan = {
      experimentId: 'exp-weighted',
      name: 'weighted-test',
      hypothesis: { id: 'h', targetComponent: 'C', domain: 'context_policy', proposedChange: '', expectedMetricEffect: { metric: 'input_tokens', expectedDelta: 0, direction: 'decrease' }, possibleRegressions: [], requiredBenchmark: [], successThreshold: 0 },
      primaryMetric: 'input_tokens',
      secondaryMetrics: [],
      benchmarkCategories: [],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 2, maxModelCalls: 10, maxTokens: 1000, maxWallTimeMs: 1000 },
      createdAt: new Date(),
      objectives,
      selectionPolicy: 'WEIGHTED_AFTER_PARETO',
      weights: { input_tokens: 0.8, wall_time: 0.2 },
    };

    const decision = applySelectionPolicy(frontier, plan);

    expect(decision.selectedCandidateId).toBe('C1-TokenHeavy');
    expect(decision.selectionReason).toContain('WEIGHTED_AFTER_PARETO');
  });

  // ======================================================================
  // 11. No Policy => No Fabricated Winner
  // ======================================================================
  it('11. no policy => no fabricated winner: preserves frontier under PARETO_ONLY', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
      { metric: 'wall_time', direction: 'MINIMIZE' },
    ];

    const c1: CandidateMetricVector = {
      candidateId: 'C1',
      rawMetrics: { input_tokens: 60_000, wall_time: 250 },
      normalizedDeltas: { input_tokens: -0.25, wall_time: 0.1 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c2: CandidateMetricVector = {
      candidateId: 'C2',
      rawMetrics: { input_tokens: 80_000, wall_time: 150 },
      normalizedDeltas: { input_tokens: 0.05, wall_time: -0.3 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1, c2], objectives);

    const plan: ExperimentPlan = {
      experimentId: 'exp-pareto-only',
      name: 'pareto-only-test',
      hypothesis: { id: 'h', targetComponent: 'C', domain: 'context_policy', proposedChange: '', expectedMetricEffect: { metric: 'input_tokens', expectedDelta: 0, direction: 'decrease' }, possibleRegressions: [], requiredBenchmark: [], successThreshold: 0 },
      primaryMetric: 'input_tokens',
      secondaryMetrics: [],
      benchmarkCategories: [],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 2, maxModelCalls: 10, maxTokens: 1000, maxWallTimeMs: 1000 },
      createdAt: new Date(),
      objectives,
      selectionPolicy: 'PARETO_ONLY',
    };

    const decision = applySelectionPolicy(frontier, plan);

    // Must NOT invent or fabricate a winner
    expect(decision.selectedCandidateId).toBeUndefined();
    expect(decision.selectionReason).toContain('PARETO_ONLY: Retained 2 non-dominated candidates');
  });

  // ======================================================================
  // 12. Baseline-Relative Normalization
  // ======================================================================
  it('12. baseline-relative normalization: computes percentage deltas and preserves raw values', () => {
    // 80,000 vs 100,000 tokens => -20%
    const tokenDelta = computeBaselineRelativeDelta(80_000, 100_000);
    expect(tokenDelta).toBeCloseTo(-0.20, 5);

    // 150ms vs 200ms wall time => -25%
    const timeDelta = computeBaselineRelativeDelta(150, 200);
    expect(timeDelta).toBeCloseTo(-0.25, 5);

    // 2 repair cycles vs 5 => -60%
    const repairDelta = computeBaselineRelativeDelta(2, 5);
    expect(repairDelta).toBeCloseTo(-0.60, 5);

    // Edge case: zero baseline
    const zeroBaseDelta = computeBaselineRelativeDelta(50, 0);
    expect(zeroBaseDelta).toBe(1.0);
    const zeroZeroDelta = computeBaselineRelativeDelta(0, 0);
    expect(zeroZeroDelta).toBe(0);
  });

  // ======================================================================
  // 13. UNKNOWN Metrics Handled
  // ======================================================================
  it('13. UNKNOWN metrics handled: extracts custom/arbitrary metrics safely without throwing', () => {
    const mockSuite: any = {
      category: 'CUSTOM',
      runnerId: 'test',
      totalTasks: 1,
      passedTasks: 1,
      failedTasks: 0,
      results: [
        {
          scoreReport: {
            passed: true,
            metrics: {
              rawMetrics: {
                custom_cache_miss_rate: 0.12,
                gpu_memory_mb: 2048,
              },
            },
          },
        },
      ],
      aggregateMetrics: {
        totalTokens: 1000,
        custom_system_metric: 42,
      },
    };

    const val1 = extractMetricValueSafe('custom_cache_miss_rate', mockSuite);
    expect(val1).toBe(0.12);

    const val2 = extractMetricValueSafe('custom_system_metric', mockSuite);
    expect(val2).toBe(42);

    const missingVal = extractMetricValueSafe('completely_unregistered_metric', mockSuite);
    expect(missingVal).toBe(0);
  });

  // ======================================================================
  // 14. Memory Persistence
  // ======================================================================
  it('14. memory persistence: records full candidate metric vectors and frontier into MemoryService', async () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
      { metric: 'wall_time', direction: 'MINIMIZE' },
    ];

    const plan: ExperimentPlan = {
      experimentId: 'exp-mem-persist',
      name: 'memory-persistence-test',
      hypothesis: {
        id: 'hyp-mem',
        targetComponent: 'RoutingRules',
        domain: 'routing',
        proposedChange: 'Route to fast model',
        expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.1, direction: 'decrease' },
        possibleRegressions: [],
        requiredBenchmark: ['CODE_REPAIR'],
        successThreshold: 75_000,
      },
      primaryMetric: 'input_tokens',
      secondaryMetrics: [],
      benchmarkCategories: ['CODE_REPAIR'],
      benchmarkTasks: ['mo-task-1'],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 2, maxModelCalls: 10, maxTokens: 100_000, maxWallTimeMs: 5000 },
      createdAt: new Date(),
      objectives,
      selectionPolicy: 'PARETO_ONLY',
    };

    const candidates = await metaOptimizer.generateCandidates(plan, 2);

    let callCount = 0;
    const runner: BenchmarkRunner = {
      id: 'mem-runner',
      name: 'Memory Runner',
      async run(task) {
        callCount++;
        const isCandidate = callCount > 1;
        const candIndex = callCount - 2; // 0 or 1
        return {
          execution: {
            id: `exec-${task.id}-${callCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'qwen',
            status: 'completed',
            createdAt: new Date(Date.now() - (candIndex === 0 ? 300 : 150)),
            completedAt: new Date(),
          },
          task: {
            id: task.id,
            type: 'benchmark',
            title: task.name,
            input: task.prompt,
            requirements: {},
            priority: 'normal',
            status: 'completed',
            createdAt: new Date(),
          },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: task.expectedFiles ?? [],
          checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
          errors: [],
          events: [],
          usage: { input: isCandidate ? (candIndex === 0 ? 60_000 : 80_000) : 75_000, output: 200 },
        };
      },
    };

    const results = await metaOptimizer.evaluateCandidates({
      plan,
      candidates,
      runner,
      tasks: [sampleTask],
    });

    expect(results).toHaveLength(2);
    expect(results[0].paretoFrontier).toBeDefined();

    // Query episodic memory
    const episodes = memoryService.queryEpisodic({ repositoryScope: 'wazir' });
    const metaEpisodes = episodes.filter((e) => e.executionId === 'exp-mem-persist');

    expect(metaEpisodes.length).toBeGreaterThanOrEqual(1);
    const firstEp = metaEpisodes[0];
    expect(firstEp.metadata?.paretoFrontier).toBeDefined();
    expect(firstEp.metadata?.metricVectors).toBeDefined();
    expect(firstEp.metadata?.tradeoffsSummary).toBeDefined();
  });

  // ======================================================================
  // 15. Explainability
  // ======================================================================
  it('15. explainability: produces clear, structured multi-objective markdown audit report', () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 1.0 },
    ];

    const c1: CandidateMetricVector = {
      candidateId: 'C1-TokenSaver',
      rawMetrics: { input_tokens: 60_000, wall_time: 250 },
      normalizedDeltas: { input_tokens: -0.25, wall_time: 0.1 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c2: CandidateMetricVector = {
      candidateId: 'C2-SpeedSpecialist',
      rawMetrics: { input_tokens: 85_000, wall_time: 150 },
      normalizedDeltas: { input_tokens: 0.06, wall_time: -0.35 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const c3Dominated: CandidateMetricVector = {
      candidateId: 'C3-Dominated',
      rawMetrics: { input_tokens: 90_000, wall_time: 260 },
      normalizedDeltas: { input_tokens: 0.12, wall_time: 0.15 },
      qualifies: true,
      disqualificationReasons: [],
    };

    const frontier = computeParetoFrontier([c1, c2, c3Dominated], objectives);

    const plan: ExperimentPlan = {
      experimentId: 'exp-explain-audit',
      name: 'explainability-audit-test',
      hypothesis: { id: 'h', targetComponent: 'C', domain: 'context_policy', proposedChange: 'Ablate prompt redundancy', expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.2, direction: 'decrease' }, possibleRegressions: [], requiredBenchmark: [], successThreshold: 0 },
      primaryMetric: 'input_tokens',
      secondaryMetrics: [],
      benchmarkCategories: ['CODE_REPAIR'],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 3, maxModelCalls: 10, maxTokens: 1000, maxWallTimeMs: 1000 },
      createdAt: new Date(),
      objectives,
      selectionPolicy: 'PARETO_ONLY',
    };

    const explanation = explainMultiObjectiveExperiment(plan, frontier);

    expect(explanation).toContain('EXPLAIN MULTI-OBJECTIVE EXPERIMENT: exp-explain-audit');
    expect(explanation).toContain('Multi-Objective Targets & Directions:');
    expect(explanation).toContain('input_tokens: MINIMIZE');
    expect(explanation).toContain('wall_time: MINIMIZE');
    expect(explanation).toContain('Policy: PARETO_ONLY');
    expect(explanation).toContain('Non-Dominated Pareto Frontier:');
    expect(explanation).toContain('C1-TokenSaver');
    expect(explanation).toContain('C2-SpeedSpecialist');
    expect(explanation).toContain('Dominated Candidates (Excluded from Frontier):');
    expect(explanation).toContain('C3-Dominated');
    expect(explanation).toContain('Tradeoffs Summary:');
    expect(explanation).toContain('No single winner fabricated');
  });
});
