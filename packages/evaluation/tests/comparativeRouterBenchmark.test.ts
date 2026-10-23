import { describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@wazir/core';
import { BENCHMARK_CATEGORIES } from '../src/benchmarkService.js';
import {
  CANONICAL_ROUTER_BENCHMARK_TASKS,
  ComparativeRouterBenchmark,
  REQUIRED_ROUTER_BENCHMARK_METRICS,
  computeMetricStatistics,
  createBaselineStaticRouterPolicy,
  createOutcomeQualifiedRouterPolicy,
  toJsonReport,
  toMarkdownReport,
  type RouterBenchmarkPolicy,
  type RouterBenchmarkTask,
} from '../src/comparativeRouterBenchmark.js';

function buildExecutionRecord(params: {
  id: string;
  task: RouterBenchmarkTask;
  passedChecks: boolean;
  filesChanged?: string[];
  inputTokens?: number;
  outputTokens?: number;
  policyAllowed?: boolean;
}): ExecutionRecord {
  const now = new Date();
  const requiredEvidence = params.task.acceptanceContract?.requiredEvidence ?? ['TEST'];
  return {
    execution: {
      id: params.id,
      taskId: params.task.id,
      runtimeId: 'cloud-openai',
      modelId: 'gpt-4.1-mini-calibrated',
      status: 'completed',
      startedAt: new Date(now.getTime() - 500),
      createdAt: new Date(now.getTime() - 500),
      completedAt: now,
    },
    task: {
      id: params.task.id,
      type: 'benchmark',
      title: params.task.name,
      input: params.task.prompt,
      requirements: {},
      priority: 'normal',
      status: 'completed',
      createdAt: now,
      acceptanceContract: params.task.acceptanceContract,
    },
    workspaceState: {
      root: `/tmp/bench/${params.task.id}`,
      revision: 1,
      dirty: true,
      filesChanged: params.filesChanged ?? params.task.expectedFiles ?? [],
    },
    acceptanceContract: params.task.acceptanceContract,
    policyDecisions:
      params.policyAllowed === false
        ? [{ action: 'tool.exec', allowed: false, reason: 'Unauthorized path mutation', at: now }]
        : [],
    toolCalls: [
      {
        tool: 'edit_file',
        input: {},
        output: 'ok',
        ok: true,
        durationMs: 25,
        at: now,
      },
    ],
    filesChanged: params.filesChanged ?? params.task.expectedFiles ?? [],
    checks: requiredEvidence.map((ev) => ({
      name: ev === 'BUILD' ? 'build' : 'test',
      command: `verify ${ev.toLowerCase()}`,
      ok: params.passedChecks,
      durationMs: 20,
      output: params.passedChecks ? 'ok' : 'failed',
    })),
    evidence: requiredEvidence.map((ev, i) => ({
      id: `ev-${params.id}-${i}`,
      type: ev,
      revision: 1,
      command: `verify ${ev.toLowerCase()}`,
      exitCode: params.passedChecks ? 0 : 1,
      durationMs: 20,
      output: params.passedChecks ? 'ok' : 'failed',
    })),
    errors: params.passedChecks ? [] : ['Check failed'],
    events: [],
    totalModelCalls: 1,
    usage: {
      input: params.inputTokens ?? 1000,
      output: params.outputTokens ?? 300,
    },
  };
}

describe('ComparativeRouterBenchmark', () => {
  it('1. provides >= 20 independently specified canonical tasks spanning all 7 categories and 3 difficulties', () => {
    const benchmark = new ComparativeRouterBenchmark();
    const canonical = benchmark.getCanonicalTasks();

    expect(CANONICAL_ROUTER_BENCHMARK_TASKS.length).toBeGreaterThanOrEqual(20);
    expect(canonical.length).toBe(CANONICAL_ROUTER_BENCHMARK_TASKS.length);

    const validation = benchmark.validateTaskSuite(canonical);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    for (const category of BENCHMARK_CATEGORIES) {
      const inCategory = canonical.filter((t) => t.category === category);
      expect(inCategory.length).toBeGreaterThanOrEqual(2);
    }

    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const inDifficulty = canonical.filter((t) => t.difficulty === difficulty);
      expect(inDifficulty.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('2. detects invalid task suites when task count < 20, duplicate IDs exist, or categories/difficulties are missing', () => {
    const benchmark = new ComparativeRouterBenchmark();
    const subset = CANONICAL_ROUTER_BENCHMARK_TASKS.slice(0, 10);
    const checkSubset = benchmark.validateTaskSuite(subset);
    expect(checkSubset.valid).toBe(false);
    expect(checkSubset.issues.some((i) => i.startsWith('INSUFFICIENT_TASK_COUNT'))).toBe(true);
    expect(checkSubset.issues.some((i) => i.startsWith('MISSING_CATEGORY'))).toBe(true);

    const duplicated = [
      ...CANONICAL_ROUTER_BENCHMARK_TASKS.slice(0, 20),
      CANONICAL_ROUTER_BENCHMARK_TASKS[0],
    ];
    const checkDup = benchmark.validateTaskSuite(duplicated);
    expect(checkDup.valid).toBe(false);
    expect(checkDup.issues.some((i) => i.startsWith('DUPLICATE_TASK_ID'))).toBe(true);
  });

  it('3. enforces matched conditions (task definitions, hardware eligibility, and execution budgets)', async () => {
    const benchmark = new ComparativeRouterBenchmark();
    const basePolicy = createBaselineStaticRouterPolicy();
    const candPolicy = createOutcomeQualifiedRouterPolicy();

    // Mismatched task definitions
    const alteredTasks = benchmark.getCanonicalTasks();
    alteredTasks[0].prompt = 'Different prompt for candidate';
    await expect(
      benchmark.runComparativeBenchmark(basePolicy, candPolicy, {
        candidateTasksOverride: alteredTasks,
      }),
    ).rejects.toThrow(/MATCHED_CONDITIONS_VIOLATION.*task definitions/);

    // Mismatched hardware eligibility / environment
    await expect(
      benchmark.runComparativeBenchmark(basePolicy, candPolicy, {
        environment: { availableVramGb: 16 },
        candidateEnvironmentOverride: { availableVramGb: 48 },
      }),
    ).rejects.toThrow(/MATCHED_CONDITIONS_VIOLATION.*hardware eligibility/);

    // Mismatched execution budgets
    await expect(
      benchmark.runComparativeBenchmark(basePolicy, candPolicy, {
        candidateBudgetOverride: { maxMonetaryCostUSD: 5.0 },
      }),
    ).rejects.toThrow(/MATCHED_CONDITIONS_VIOLATION.*execution budgets/);
  });

  it('4. computes all 7 required metrics plus sample count, mean, variance, standard error, and 95% confidence intervals', async () => {
    const benchmark = new ComparativeRouterBenchmark();
    const result = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      { repetitions: 2 },
    );

    expect(result.matchedConditions.enforced).toBe(true);
    expect(result.matchedConditions.taskCount).toBe(CANONICAL_ROUTER_BENCHMARK_TASKS.length);
    expect(result.matchedConditions.repetitions).toBe(2);

    for (const metric of REQUIRED_ROUTER_BENCHMARK_METRICS) {
      expect(typeof result.baseline[metric]).toBe('number');
      expect(typeof result.candidate[metric]).toBe('number');
      expect(typeof result.deltas[metric]).toBe('number');
      expect(result.metricComparisons[metric]).toBeDefined();
      expect(result.metricComparisons[metric].baselineCI95).toHaveLength(2);
      expect(result.metricComparisons[metric].candidateCI95).toHaveLength(2);
    }

    const baseStats = result.baseline.statistics.verified_success_rate;
    expect(baseStats.sampleCount).toBe(CANONICAL_ROUTER_BENCHMARK_TASKS.length * 2);
    expect(Number.isFinite(baseStats.mean)).toBe(true);
    expect(Number.isFinite(baseStats.variance)).toBe(true);
    expect(Number.isFinite(baseStats.standardError)).toBe(true);
    expect(baseStats.confidenceInterval95[0]).toBeLessThanOrEqual(baseStats.mean);
    expect(baseStats.confidenceInterval95[1]).toBeGreaterThanOrEqual(baseStats.mean);
  });

  it('5. reuses EvaluationService to reject apparent completions that lack physical verification evidence', async () => {
    const benchmark = new ComparativeRouterBenchmark();

    // Baseline claims completion on every task, but physical verification checks fail on half
    // Candidate passes physical verification on every task
    const result = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      {
        taskExecutor: ({ task, policy, repetition }) => {
          const isCandidate = policy.id === 'candidate-outcome-qualified-router';
          const idx = CANONICAL_ROUTER_BENCHMARK_TASKS.findIndex((t) => t.id === task.id);
          const passedPhysicalChecks = isCandidate ? true : idx % 2 === 0;
          return {
            status: 'COMPLETED',
            record: buildExecutionRecord({
              id: `exec-${policy.id}-${task.id}-${repetition}`,
              task,
              passedChecks: passedPhysicalChecks,
            }),
            costUsd: isCandidate ? 0.004 : 0.008,
            endToEndLatencyMs: isCandidate ? 750 : 1400,
            retryCount: isCandidate ? 0 : idx % 3 === 0 ? 1 : 0,
            fallbackUsed: false,
            policyViolation: false,
          };
        },
      },
    );

    // Every unverified baseline task had status === 'completed' (apparentCompletion = true),
    // but EvaluationService enforced physical verification so verified === false
    const unverifiedBaseline = result.baseline.completedEvaluations.filter((e) => !e.verified);
    expect(unverifiedBaseline.length).toBe(10);
    expect(unverifiedBaseline.every((e) => e.apparentCompletion === true)).toBe(true);

    expect(result.baseline.verified_success_rate).toBeCloseTo(11 / 21, 5);
    expect(result.candidate.verified_success_rate).toBe(1);
    expect(result.verdict).toBe('IMPROVEMENT');
  });

  it('6. separates blocked evaluations (status: BLOCKED) from completed evaluations when runtime or hardware is unavailable', async () => {
    const benchmark = new ComparativeRouterBenchmark();
    const customTasks = benchmark.getCanonicalTasks().map((task, idx) => {
      if (idx < 5) {
        return {
          ...task,
          hardwareEligibility: {
            ...task.hardwareEligibility,
            minAvailableVramGb: 80, // Exceeds 24GB available VRAM -> BLOCKED
          },
        };
      }
      return task;
    });

    const result = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      {
        tasks: customTasks,
        environment: { availableVramGb: 24 },
      },
    );

    expect(result.baseline.blockedCount).toBe(5);
    expect(result.baseline.completedCount).toBe(16);
    expect(result.candidate.blockedCount).toBe(5);
    expect(result.candidate.completedCount).toBe(16);

    expect(
      result.baseline.blockedEvaluations.every(
        (e) => e.status === 'BLOCKED' && e.verified === false && Boolean(e.blockedReason),
      ),
    ).toBe(true);
    expect(
      result.baseline.completedEvaluations.every((e) => e.status === 'COMPLETED'),
    ).toBe(true);
    expect(result.honestAssessment.some((a) => a.includes('Blocked tasks recorded separately'))).toBe(
      true,
    );
  });

  it('7. honestly reports NO_SIGNIFICANT_IMPROVEMENT when confidence intervals overlap and paired differences are noise', async () => {
    const benchmark = new ComparativeRouterBenchmark();

    // Baseline and candidate have nearly identical outcomes (only 1 task out of 21 differs)
    const result = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      {
        taskExecutor: ({ task, policy, repetition }) => {
          const isCandidate = policy.id === 'candidate-outcome-qualified-router';
          const idx = CANONICAL_ROUTER_BENCHMARK_TASKS.findIndex((t) => t.id === task.id);
          const pass = idx < 18 || (isCandidate && idx === 18);
          return {
            status: 'COMPLETED',
            record: buildExecutionRecord({
              id: `exec-${policy.id}-${task.id}-${repetition}`,
              task,
              passedChecks: pass,
            }),
            costUsd: 0.005,
            endToEndLatencyMs: 900,
            retryCount: 0,
            fallbackUsed: false,
            policyViolation: false,
          };
        },
      },
    );

    expect(result.deltas.verified_success_rate).toBeGreaterThan(0);
    expect(result.metricComparisons.verified_success_rate.confidenceIntervalsOverlap).toBe(true);
    expect(result.verdict).toBe('NO_SIGNIFICANT_IMPROVEMENT');
    expect(
      result.inconclusiveReasons.some((r) => r.includes('OVERLAPPING_CONFIDENCE_INTERVALS')),
    ).toBe(true);
  });

  it('8. honestly reports REGRESSION when candidate lowers verified_success_rate or introduces policy violations', async () => {
    const benchmark = new ComparativeRouterBenchmark();

    const regressionResult = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      {
        taskExecutor: ({ task, policy, repetition }) => {
          const isCandidate = policy.id === 'candidate-outcome-qualified-router';
          const idx = CANONICAL_ROUTER_BENCHMARK_TASKS.findIndex((t) => t.id === task.id);
          const pass = isCandidate ? idx < 12 : idx < 19;
          return {
            status: 'COMPLETED',
            record: buildExecutionRecord({
              id: `exec-${policy.id}-${task.id}-${repetition}`,
              task,
              passedChecks: pass,
              policyAllowed: !(isCandidate && idx === 0),
            }),
            costUsd: isCandidate ? 0.012 : 0.005,
            endToEndLatencyMs: isCandidate ? 1600 : 800,
            retryCount: isCandidate ? 1 : 0,
            fallbackUsed: isCandidate,
            policyViolation: isCandidate && idx === 0,
          };
        },
      },
    );

    expect(regressionResult.verdict).toBe('REGRESSION');
    expect(regressionResult.deltas.verified_success_rate).toBeLessThan(0);
    expect(regressionResult.deltas.policy_violation_rate).toBeGreaterThan(0);
    expect(regressionResult.regressions.length).toBeGreaterThanOrEqual(2);
  });

  it('9. reports NO_SIGNIFICANT_IMPROVEMENT when all tasks are blocked due to unavailable runtime', async () => {
    const benchmark = new ComparativeRouterBenchmark();
    const blockedPolicy: RouterBenchmarkPolicy = {
      id: 'blocked-policy',
      name: 'Blocked Policy',
      selectRoute: () => ({
        blockedReason: 'RUNTIME_UNAVAILABLE: No local or cloud runtime reachable',
        rationale: ['All runtimes offline'],
      }),
    };

    const result = await benchmark.runComparativeBenchmark(blockedPolicy, blockedPolicy);
    expect(result.baseline.completedCount).toBe(0);
    expect(result.baseline.blockedCount).toBe(CANONICAL_ROUTER_BENCHMARK_TASKS.length);
    expect(result.verdict).toBe('NO_SIGNIFICANT_IMPROVEMENT');
    expect(result.inconclusiveReasons.some((r) => r.includes('NO_COMPLETED_EVALUATIONS'))).toBe(
      true,
    );
  });

  it('10. computes per-category and per-difficulty breakdowns accurately', async () => {
    const benchmark = new ComparativeRouterBenchmark();
    const result = await benchmark.runComparativeBenchmark();

    for (const category of BENCHMARK_CATEGORIES) {
      const catSummary = result.candidate.byCategory[category];
      expect(catSummary).toBeDefined();
      expect(catSummary!.totalTasks).toBe(3);
      expect(catSummary!.completedTasks + catSummary!.blockedTasks).toBe(3);
    }

    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const diffSummary = result.candidate.byDifficulty[difficulty];
      expect(diffSummary).toBeDefined();
      expect(diffSummary!.totalTasks).toBe(7);
    }
  });

  it('11. generates structured Markdown and JSON reports with all 7 metrics, uncertainty, and blocked task details', async () => {
    const benchmark = new ComparativeRouterBenchmark();
    const tasksWithBlocked = benchmark.getCanonicalTasks();
    tasksWithBlocked[0].hardwareEligibility = {
      ...tasksWithBlocked[0].hardwareEligibility,
      minAvailableVramGb: 128,
    };

    const result = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      {
        benchmarkId: 'bench-report-test-01',
        tasks: tasksWithBlocked,
      },
    );

    const md = toMarkdownReport(result);
    expect(md).toContain('# Comparative Router Benchmark Report: `bench-report-test-01`');
    expect(md).toContain('## Execution Status Breakdown');
    expect(md).toContain('## Primary Router Metrics & Uncertainty (95% CI)');
    expect(md).toContain('## Blocked Task Evaluations');
    for (const metricName of REQUIRED_ROUTER_BENCHMARK_METRICS) {
      expect(md).toContain(`\`${metricName}\``);
    }

    const jsonStr = toJsonReport(result);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.benchmarkId).toBe('bench-report-test-01');
    expect(parsed.matchedConditions.enforced).toBe(true);
    expect(parsed.baseline.blockedCount).toBe(1);
    expect(parsed.candidate.blockedCount).toBe(1);
    expect(parsed.verdict).toBe(result.verdict);

    // Also verify helper statistics edge cases
    const emptyStats = computeMetricStatistics([]);
    expect(emptyStats.sampleCount).toBe(0);
    expect(Number.isNaN(emptyStats.mean)).toBe(true);
  });
});
