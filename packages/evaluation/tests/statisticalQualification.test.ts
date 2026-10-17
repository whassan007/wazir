import { describe, expect, it } from 'vitest';
import type { BenchmarkSuiteResult, BenchmarkTask, ExecutionRecord, ExperimentPlan } from '@wazir/core';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { MetaOptimizerService } from '../src/metaOptimizerService.js';
import { RegressionGuard } from '../src/regressionGuard.js';
import { binomialUpperTail, exactImprovementLowerBound } from '../src/pairedEvidence.js';

function suite(label: string, times: number[], taskId = 'repair'): BenchmarkSuiteResult {
  return {
    runnerId: label, totalTasks: times.length, passedTasks: times.length, failedTasks: 0,
    results: times.map((time, repetition) => ({
      taskId, repetition, taskName: taskId, category: 'CODE_REPAIR', runnerId: label,
      evaluationVersion: 'test-v1', taskDefinitionHash: 'same-definition', durationMs: time,
      scoreReport: { executionId: `${label}-${taskId}-${repetition}`, passed: true, metrics: {
        taskSuccess: true, physicalVerificationSuccess: true, totalWallTimeMs: time,
        inputTokens: time, outputTokens: 0,
      } },
    })),
    aggregateMetrics: { totalTokens: times.reduce((sum, time) => sum + time, 0), totalWallTimeMs: times.reduce((a, b) => a + b, 0), totalCostUsd: 0 },
  } as unknown as BenchmarkSuiteResult;
}
function plan(): ExperimentPlan {
  return {
    primaryMetric: 'wall_time', sampleSize: 5,
    requiredImprovement: { metric: 'wall_time', operator: '<=', targetValue: 1, isRelativeFactor: true },
    budget: { maxCandidatesPerExperiment: 1 }, protectedMetrics: ['task_success'],
    hypothesis: { expectedMetricEffect: { direction: 'decrease' } },
  } as ExperimentPlan;
}
function evaluate(baseline: BenchmarkSuiteResult, candidate: BenchmarkSuiteResult, experiment = plan()) {
  return new RegressionGuard().evaluate({
    plan: experiment, baselineSuite: baseline, candidateSuite: candidate,
    comparison: new BenchmarkService().compareSuites(baseline, candidate),
  });
}
const five = (value: number) => Array(5).fill(value);

describe('repeated paired statistical qualification', () => {
  it('never qualifies a single run or lets a lowered minimum bypass repetition requirements', () => {
    const result = evaluate(suite('base', [100]), suite('cand', [50]));
    expect(result.qualified).toBe(false);
    expect(result.summary).toContain('INCONCLUSIVE');
    expect(result.inconclusiveReasons.join(' ')).toContain('INSUFFICIENT_SAMPLES');
    for (const minSampleCount of [0, 1, 4, 5.5, NaN, Infinity]) {
      expect(() => new RegressionGuard({ minSampleCount })).toThrow();
    }
  });

  it('qualifies consistent independent paired improvement and records exact evidence', () => {
    const result = evaluate(suite('base', five(100)), suite('cand', five(50)));
    expect(result.qualified).toBe(true);
    expect(result.statisticalEvidence?.[0]).toMatchObject({ pairCount: 5, wins: 5, losses: 0, pValue: 1 / 32, supported: true });
    expect(result.statisticalEvidence![0].improvementProbabilityLowerBound).toBeCloseTo(Math.pow(0.05, 1 / 5), 10);
  });

  it('leaves a lower average with inconsistent outcomes inconclusive', () => {
    const result = evaluate(suite('base', five(100)), suite('cand', [70, 80, 90, 110, 120]));
    expect(result.primaryObjectiveMet).toBe(true);
    expect(result.qualified).toBe(false);
    expect(result.statisticalEvidence![0].pValue).toBeCloseTo(0.5);
    expect(result.summary).toContain('INCONCLUSIVE');
  });

  it('does not qualify equal outcomes or use ties to inflate informative sample count', () => {
    expect(evaluate(suite('base', five(100)), suite('cand', five(100))).qualified).toBe(false);
    const result = evaluate(suite('base', Array(20).fill(100)), suite('cand', [50, ...Array(19).fill(100)]));
    expect(result.statisticalEvidence![0]).toMatchObject({ wins: 1, ties: 19, supported: false });
  });

  it('corrects for all planned objectives and candidate comparisons', () => {
    const experiment = { ...plan(), objectives: [{ metric: 'wall_time', direction: 'MINIMIZE' }, { metric: 'input_tokens', direction: 'MINIMIZE' }] } as ExperimentPlan;
    const result = evaluate(suite('base', five(100)), suite('cand', five(50)), experiment);
    expect(result.statisticalEvidence![0].adjustedAlpha).toBe(0.025);
    expect(result.qualified).toBe(false); // uncorrected p=.03125 would pass
    expect(evaluate(suite('base', Array(8).fill(100)), suite('cand', Array(8).fill(50)), experiment).qualified).toBe(true);
    experiment.budget.maxCandidatesPerExperiment = 4;
    expect(evaluate(suite('base', five(100)), suite('cand', five(50)), experiment).qualified).toBe(false);
  });

  it.each(['duplicate', 'unpaired', 'replayed execution', 'missing version', 'changed definition', 'category mismatch'])(
    'blocks %s evidence', (failure) => {
      const base = suite('base', five(100));
      const cand = suite('cand', five(50));
      if (failure === 'duplicate') cand.results[1].repetition = 0;
      if (failure === 'unpaired') cand.results.pop();
      if (failure === 'replayed execution') cand.results[1].scoreReport.executionId = cand.results[0].scoreReport.executionId;
      if (failure === 'missing version') cand.results[0].evaluationVersion = undefined;
      if (failure === 'changed definition') {
        base.results[1].taskDefinitionHash = 'changed';
        cand.results[1].taskDefinitionHash = 'changed';
      }
      if (failure === 'category mismatch') cand.results[0].category = 'TOOL_USE';
      const result = evaluate(base, cand);
      expect(result.qualified).toBe(false);
      expect(result.summary).toContain('INCONCLUSIVE');
    },
  );

  it('pairs by task and repetition rather than result order', () => {
    const base = suite('base', five(100));
    const cand = suite('cand', five(50));
    cand.results.reverse();
    expect(evaluate(base, cand).qualified).toBe(true);
  });

  it('rejects a paired correctness regression even when aggregate pass rate is unchanged', () => {
    const base = suite('base', five(100));
    const cand = suite('cand', five(50));
    base.results[0].scoreReport.passed = false;
    cand.results[1].scoreReport.passed = false;
    base.passedTasks = cand.passedTasks = 4;
    const result = evaluate(base, cand);
    expect(result.summary).toContain('REJECTED');
    expect(result.regressionsDetected.join(' ')).toContain('PAIRED_CORRECTNESS_REGRESSION');
  });

  it('does not let many easy-task repetitions hide inconclusive harder-task results', () => {
    const base = suite('base', Array(20).fill(100), 'easy');
    const cand = suite('cand', Array(20).fill(50), 'easy');
    base.results.push(...suite('base', [100], 'hard').results);
    cand.results.push(...suite('cand', [50], 'hard').results);
    const result = evaluate(base, cand);
    expect(result.qualified).toBe(false);
    expect(result.inconclusiveReasons.join(' ')).toContain("'hard' has 1 paired repetitions");
  });

  it('blocks task-level average harm even when frequent tiny wins and easy tasks dominate the aggregate', () => {
    const base = suite('base', Array(10).fill(1000), 'easy');
    const cand = suite('cand', Array(10).fill(1), 'easy');
    base.results.push(...suite('base', Array(10).fill(100), 'hard').results);
    cand.results.push(...suite('cand', [...Array(9).fill(99), 10000], 'hard').results);
    const result = evaluate(base, cand);
    expect(result.qualified).toBe(false);
    expect(result.statisticalEvidence?.find((e) => e.taskId === 'hard')?.meanPairedImprovement).toBeLessThan(0);
  });

  it('computes exact binomial tails and bounded uncertainty for large samples', () => {
    expect(binomialUpperTail(0, 0)).toBe(1);
    expect(binomialUpperTail(4, 5)).toBeCloseTo(6 / 32, 12);
    expect(binomialUpperTail(500, 1000)).toBeGreaterThan(0.5);
    expect(binomialUpperTail(500, 1000)).toBeLessThan(0.52);
    expect(exactImprovementLowerBound(0, 5, 0.05)).toBe(0);
    expect(new RegressionGuard().computeStatistics([]).mean).toBeNaN();
    expect(new RegressionGuard().computeStatistics([42]).confidenceInterval95[0]).toBeNaN();
  });
});

describe('benchmark repetition collection and legacy promotion', () => {
  const task: BenchmarkTask = { id: 'repeat', name: 'Repeat', category: 'CODE_REPAIR', description: 'Fixture', prompt: 'Fixture', expectedFiles: ['fixed.ts'], mutationRequired: true };
  function runner() {
    let index = 0;
    const workspaces: string[] = [];
    return {
      workspaces, id: 'fixture', name: 'Fixture',
      async run(t: BenchmarkTask, context: { workspaceRoot: string; config?: { id: string } }): Promise<ExecutionRecord> {
        workspaces.push(context.workspaceRoot);
        const candidate = context.config?.id.startsWith('opt-candidate');
        return {
          execution: { id: `exec-${++index}`, taskId: t.id, status: 'completed', createdAt: new Date() },
          task: { id: t.id, requirements: {} }, toolCalls: [], policyDecisions: [], errors: [], events: [],
          filesChanged: ['fixed.ts'], checks: [{ name: 'test', command: 'test', ok: true, durationMs: 1 }],
          totalModelCalls: 1,
          usage: { input: candidate ? 50 : 100, output: 1 },
        } as unknown as ExecutionRecord;
      },
    };
  }

  it('runs each repetition in a new workspace and records immutable pairing identities', async () => {
    const service = new BenchmarkService(); service.register(task);
    const execution = runner();
    const result = await service.runBenchmarkSuite([task], execution, { repetitions: 5 });
    expect(result.results.map((r) => r.repetition)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(execution.workspaces).size).toBe(5);
    expect(new Set(result.results.map((r) => r.taskDefinitionHash)).size).toBe(1);
    expect(result.results.every((r) => r.evaluationVersion)).toBe(true);
    await expect(service.runBenchmarkSuite([task], execution, { repetitions: 1.5 })).rejects.toThrow();
    await expect(service.runBenchmarkSuite([task, task], execution)).rejects.toThrow();
  });

  it('keeps runner mutations to acceptance definitions out of evaluation', async () => {
    const service = new BenchmarkService(); service.register(task);
    const execution = runner();
    const result = await service.runTask(task.id, {
      id: 'mutating', name: 'Mutating',
      async run(t, context) {
        t.expectedFiles = []; t.mutationRequired = false;
        const record = await execution.run(t, context);
        record.filesChanged = [];
        return record;
      },
    });
    expect(result.scoreReport.passed).toBe(false);
    expect(service.getTask(task.id)?.expectedFiles).toEqual(['fixed.ts']);
  });

  it('blocks legacy single-suite promotion and preserves the active configuration', async () => {
    const service = new BenchmarkService(); service.register(task);
    const optimizer = new MetaOptimizerService({ benchmarkService: service });
    const baseline = optimizer.getActiveConfig().id;
    const candidate = optimizer.proposeCandidate([{ type: 'WEIGHT_ADJUSTMENT', path: 'contextWeights.recencyRelevance', oldValue: 1, newValue: 0.5, rationale: 'Fixture' }]);
    const result = await optimizer.evaluateCandidate(candidate, runner(), [task]);
    expect(result.decision).toBe('INCONCLUSIVE');
    expect(result.regressionGuard).toBeDefined();
    expect(optimizer.getActiveConfig().id).toBe(baseline);
  });
});
