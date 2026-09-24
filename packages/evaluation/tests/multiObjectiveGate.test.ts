import { describe, it, expect, beforeEach } from 'vitest';
import type {
  BenchmarkRunner,
  BenchmarkTask,
  ExecutionRecord,
  ExperimentPlan,
  CandidateMetricVector,
  OptimizationObjective,
} from '@wazir/core';
import {
  MetaOptimizerService,
  DEFAULT_OPTIMIZABLE_CONFIG,
} from '../src/metaOptimizerService.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { RegressionGuard } from '../src/regressionGuard.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';

describe('G43: Multi-Objective Empirical Meta-Optimization (MULTI_OBJECTIVE_META)', () => {
  let memoryService: MemoryService;
  let evaluationService: EvaluationService;
  let benchmarkService: BenchmarkService;
  let metaOptimizer: MetaOptimizerService;
  let store: MemoryStore;

  const repairTask: BenchmarkTask = {
    id: 'g43-task-1',
    name: 'Async Pipeline Repair',
    category: 'CODE_REPAIR',
    description: 'Fix pipeline race condition with optimal tokens, latency, and repairs',
    prompt: 'Fix async pipeline race condition',
    expectedFiles: ['pipeline.ts'],
    mutationRequired: true,
  };

  beforeEach(() => {
    store = new MemoryStore();
    memoryService = new MemoryService();
    evaluationService = new EvaluationService();
    benchmarkService = new BenchmarkService(evaluationService);
    benchmarkService.register(repairTask);

    metaOptimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      memoryService,
      store,
    });
  });

  it('G43 Criterion 1-6: evaluates real experiment across 3 objectives, forming genuine Pareto frontier without fabricated winner', async () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 1.0 },
      { metric: 'repair_cycles', direction: 'MINIMIZE', importance: 1.0 },
    ];

    const plan: ExperimentPlan = {
      experimentId: 'exp-g43-pareto',
      name: 'g43-multi-objective-optimization',
      hypothesis: {
        id: 'hyp-g43',
        targetComponent: 'ContextCompiler',
        domain: 'context_policy',
        proposedChange: 'Multi-objective context and repair policy optimization',
        expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.2, direction: 'decrease' },
        possibleRegressions: [],
        requiredBenchmark: ['CODE_REPAIR'],
        successThreshold: 80_000,
      },
      primaryMetric: 'input_tokens',
      secondaryMetrics: ['wall_time', 'repair_cycles'],
      objectives,
      protectedMetrics: ['task_success'],
      selectionPolicy: 'PARETO_ONLY',
      benchmarkCategories: ['CODE_REPAIR'],
      benchmarkTasks: ['g43-task-1'],
      sampleSize: 1,
      budget: {
        maxExperiments: 1,
        maxCandidatesPerExperiment: 4,
        maxModelCalls: 50,
        maxTokens: 500_000,
        maxWallTimeMs: 60_000,
      },
      createdAt: new Date(),
    };

    // Generate 4 candidate implementations
    const candidates = await metaOptimizer.generateCandidates(plan, 4);
    expect(candidates).toHaveLength(4);

    // Call count:
    // Call 1: Baseline
    // Call 2: C1 (balanced)
    // Call 3: C2 (token specialist)
    // Call 4: C3 (speed specialist)
    // Call 5: C4 (dominated by C1)
    let callIndex = 0;
    const runner: BenchmarkRunner = {
      id: 'g43-runner',
      name: 'G43 Multi-Objective Empirical Runner',
      async run(task) {
        callIndex++;

        // Baseline vs Candidates data
        let inputTokens = 100_000;
        let durationMs = 300_000;
        let repairCycles = 5;

        if (callIndex === 1) {
          // Baseline
          inputTokens = 100_000;
          durationMs = 300_000;
          repairCycles = 5;
        } else if (callIndex === 2) {
          // C1: Balanced (75K tokens, 220s wall time, 3 repairs)
          inputTokens = 75_000;
          durationMs = 220_000;
          repairCycles = 3;
        } else if (callIndex === 3) {
          // C2: Token Specialist (55K tokens, 280s wall time, 2 repairs)
          inputTokens = 55_000;
          durationMs = 280_000;
          repairCycles = 2;
        } else if (callIndex === 4) {
          // C3: Speed Specialist (90K tokens, 140s wall time, 4 repairs)
          inputTokens = 90_000;
          durationMs = 140_000;
          repairCycles = 4;
        } else {
          // C4: Dominated by C1 (85K > 75K tokens, 240s > 220s wall time, 4 > 3 repairs)
          inputTokens = 85_000;
          durationMs = 240_000;
          repairCycles = 4;
        }

        return {
          execution: {
            id: `exec-${task.id}-${callIndex}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'qwen',
            status: 'completed',
            createdAt: new Date(Date.now() - durationMs),
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
          // Equal correctness: all checks pass, zero errors
          checks: [{ name: 'unit-test', command: 'npm test', ok: true, durationMs: 150 }],
          errors: [],
          events: [],
          usage: { input: inputTokens, output: 500 },
          durationMs,
          metadata: {
            repair_cycles: repairCycles,
          },
        } as unknown as ExecutionRecord;
      },
    };

    const results = await metaOptimizer.evaluateCandidates({
      plan,
      candidates,
      runner,
      tasks: [repairTask],
    });

    expect(results).toHaveLength(4);

    const firstResult = results[0];
    const frontier = firstResult.paretoFrontier;
    expect(frontier).toBeDefined();

    // 1. Equal correctness: all 4 candidates satisfied all constraints
    const vectors = Object.values(firstResult.metricVectors ?? {}) as CandidateMetricVector[];
    expect(vectors).toHaveLength(4);
    for (const v of vectors) {
      expect(v.qualifies).toBe(true);
      expect(v.disqualificationReasons).toHaveLength(0);
    }

    // 2. Non-dominated Pareto frontier: exactly 3 candidates (C1, C2, C3)
    const frontierIds = frontier!.frontierCandidates.map((c) => c.candidateId);
    expect(frontierIds).toHaveLength(3);
    expect(frontierIds).toContain(candidates[0].candidateId); // C1
    expect(frontierIds).toContain(candidates[1].candidateId); // C2
    expect(frontierIds).toContain(candidates[2].candidateId); // C3

    // 3. Dominated candidates: C4 strictly dominated by C1
    const dominatedIds = frontier!.dominatedCandidates.map((c) => c.candidateId);
    expect(dominatedIds).toHaveLength(1);
    expect(dominatedIds).toContain(candidates[3].candidateId); // C4

    // 4. Tradeoff preservation under PARETO_ONLY: no winner fabricated
    expect(frontier!.selectedCandidateId).toBeUndefined();
    expect(frontier!.policyUsed).toBe('PARETO_ONLY');
    expect(frontier!.tradeoffsSummary).toContain(candidates[0].candidateId);
    expect(frontier!.tradeoffsSummary).toContain(candidates[1].candidateId);
    expect(frontier!.tradeoffsSummary).toContain(candidates[2].candidateId);

    // 5. Positive Hypervolume improvement
    expect(frontier!.hypervolume).toBeGreaterThan(0);

    // 6. Explainability: report generated explaining frontier and tradeoffs
    const explanation = metaOptimizer.explainExperiment(plan.experimentId);
    expect(explanation).toContain('Multi-Objective Pareto Analysis');
    expect(explanation).toContain('Non-Dominated Candidates on Frontier: 3');
    expect(explanation).toContain('Dominated Candidates: 1');
    expect(explanation).toContain('Tradeoffs Summary');
  });

  it('G43 Policy Flexibility: supports pre-registered selection policies (LEXICOGRAPHIC & WEIGHTED_AFTER_PARETO)', async () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE', importance: 0.8 },
      { metric: 'wall_time', direction: 'MINIMIZE', importance: 0.2 },
    ];

    // Lexicographic plan: prioritize wall_time first
    const lexPlan: ExperimentPlan = {
      experimentId: 'exp-g43-lex',
      name: 'g43-lexicographic-test',
      hypothesis: { id: 'h', targetComponent: 'C', domain: 'routing', proposedChange: '', expectedMetricEffect: { metric: 'wall_time', expectedDelta: -0.3, direction: 'decrease' }, possibleRegressions: [], requiredBenchmark: [], successThreshold: 0 },
      primaryMetric: 'wall_time',
      secondaryMetrics: ['input_tokens'],
      objectives,
      selectionPolicy: 'LEXICOGRAPHIC',
      lexicographicOrder: ['wall_time', 'input_tokens'],
      benchmarkCategories: ['CODE_REPAIR'],
      benchmarkTasks: ['g43-task-1'],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 2, maxModelCalls: 20, maxTokens: 100_000, maxWallTimeMs: 10_000 },
      createdAt: new Date(),
    };

    const candidates = await metaOptimizer.generateCandidates(lexPlan, 2);

    let callCount = 0;
    const runner: BenchmarkRunner = {
      id: 'lex-runner',
      name: 'Lexicographic Runner',
      async run(task) {
        callCount++;
        const isCandidate = callCount > 1;
        const candIndex = callCount - 2;

        return {
          execution: {
            id: `exec-${callCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'qwen',
            status: 'completed',
            createdAt: new Date(),
            completedAt: new Date(),
          },
          task: { id: task.id, type: 'b', title: 'b', input: '', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: task.expectedFiles ?? [],
          checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
          errors: [],
          events: [],
          usage: { input: isCandidate ? (candIndex === 0 ? 60_000 : 80_000) : 75_000, output: 200 },
          durationMs: isCandidate ? (candIndex === 0 ? 250_000 : 150_000) : 200_000,
        } as unknown as ExecutionRecord;
      },
    };

    const lexResults = await metaOptimizer.evaluateCandidates({
      plan: lexPlan,
      candidates,
      runner,
      tasks: [repairTask],
    });

    // Lexicographic ordering ['wall_time', 'input_tokens'] must pick C2 (index 1) which has 150s wall time
    const lexFrontier = lexResults[0].paretoFrontier;
    expect(lexFrontier?.selectedCandidateId).toBe(candidates[1].candidateId);
  });

  it('G43 Constraints First: excludes failing candidate even if it has superior resource metrics', async () => {
    const objectives: OptimizationObjective[] = [
      { metric: 'input_tokens', direction: 'MINIMIZE' },
      { metric: 'wall_time', direction: 'MINIMIZE' },
    ];

    const plan: ExperimentPlan = {
      experimentId: 'exp-g43-constraints',
      name: 'g43-constraints-first-test',
      hypothesis: { id: 'h', targetComponent: 'C', domain: 'context_policy', proposedChange: '', expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.5, direction: 'decrease' }, possibleRegressions: [], requiredBenchmark: [], successThreshold: 0 },
      primaryMetric: 'input_tokens',
      secondaryMetrics: ['wall_time'],
      objectives,
      benchmarkCategories: ['CODE_REPAIR'],
      benchmarkTasks: ['g43-task-1'],
      sampleSize: 1,
      budget: { maxExperiments: 1, maxCandidatesPerExperiment: 2, maxModelCalls: 20, maxTokens: 100_000, maxWallTimeMs: 10_000 },
      createdAt: new Date(),
    };

    const candidates = await metaOptimizer.generateCandidates(plan, 2);

    let callCount = 0;
    const runner: BenchmarkRunner = {
      id: 'guard-runner',
      name: 'Constraint Guard Runner',
      async run(task) {
        callCount++;
        const isCandidate = callCount > 1;
        const candIndex = callCount - 2;

        const isFailing = isCandidate && candIndex === 0;

        return {
          execution: {
            id: `exec-${callCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'qwen',
            status: isFailing ? 'failed' : 'completed',
            createdAt: new Date(),
            completedAt: new Date(),
          },
          task: { id: task.id, type: 'b', title: 'b', input: '', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: task.expectedFiles ?? [],
          // Candidate 0 fails check
          checks: [{ name: 'test', command: 'npm test', ok: !isFailing, durationMs: 100 }],
          errors: isFailing ? [{ message: 'Assertion failed: expected 200 OK' }] : [],
          events: [],
          usage: { input: isFailing ? 20_000 : 70_000, output: 200 }, // C0 has amazing 20K tokens!
          durationMs: 100_000,
        } as unknown as ExecutionRecord;
      },
    };

    const results = await metaOptimizer.evaluateCandidates({
      plan,
      candidates,
      runner,
      tasks: [repairTask],
    });

    const frontier = results[0].paretoFrontier;
    expect(frontier).toBeDefined();

    // Failing candidate must be disqualified and excluded from frontier
    const frontierIds = frontier!.frontierCandidates.map((c) => c.candidateId);
    expect(frontierIds).not.toContain(candidates[0].candidateId);
    expect(frontierIds).toContain(candidates[1].candidateId);

    const failingVector = results[0].metricVectors?.[candidates[0].candidateId];
    expect(failingVector?.qualifies).toBe(false);
  });
});
