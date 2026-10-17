import { describe, expect, it } from 'vitest';
import type { BenchmarkSuiteResult, ExecutionRecord, ExperimentPlan } from '@wazir/core';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { RegressionGuard } from '../src/regressionGuard.js';
import {
  candidateDominates, candidateVectorsEquivalent, computeParetoFrontier,
  extractMetricValueSafe, readBenchmarkMetric,
} from '../src/multiObjectiveOptimizer.js';

function suite(overrides: Record<string, unknown>[] = [{}]): BenchmarkSuiteResult {
  return {
    runnerId: 'test', totalTasks: overrides.length, passedTasks: overrides.length, failedTasks: 0,
    results: overrides.map((metrics, i) => ({
      taskId: `task-${i}`, taskName: `Task ${i}`, category: 'CODE_REPAIR', runnerId: 'test', durationMs: 900,
      scoreReport: { passed: true, metrics: {
        taskSuccess: true, physicalVerificationSuccess: true,
        totalWallTimeMs: 100, inputTokens: 20, outputTokens: 5,
        totalToolCalls: 4, failedToolCalls: 1, malformedActions: 2,
        repairCycles: 0, costEstimateUsd: 0, ...metrics,
      } },
    })),
    aggregateMetrics: { totalTokens: 999999, totalCostUsd: 999999 },
  } as unknown as BenchmarkSuiteResult;
}
const plan = {
  primaryMetric: 'wall_time', requiredImprovement: { metric: 'wall_time', operator: '<=', targetValue: 0.8, isRelativeFactor: true },
  protectedMetrics: ['task_success'],
} as ExperimentPlan;
function guard(baseline: BenchmarkSuiteResult, candidate: BenchmarkSuiteResult, experiment = plan) {
  return new RegressionGuard().evaluate({
    plan: experiment, baselineSuite: baseline, candidateSuite: candidate,
    comparison: new BenchmarkService(new EvaluationService()).compareSuites(baseline, candidate),
  });
}

describe('optimizer metric integrity', () => {
  it('uses complete observed counts and actual wall time, preserving measured zero', () => {
    const observed = suite([{}, { totalToolCalls: 6, failedToolCalls: 3, malformedActions: 1 }]);
    expect(extractMetricValueSafe('tool_failures', observed)).toBe(4);
    expect(extractMetricValueSafe('tool_failure_rate', observed)).toBe(0.4);
    expect(extractMetricValueSafe('malformed_actions', observed)).toBe(3);
    expect(extractMetricValueSafe('total_tokens', observed)).toBe(50);
    expect(extractMetricValueSafe('input_tokens', observed)).toBe(20);
    expect(extractMetricValueSafe('repair_cycles', observed)).toBe(0);
    expect(extractMetricValueSafe('monetary_cost', observed)).toBe(0);
    expect(readBenchmarkMetric('monetary_cost', observed)).toEqual({ kind: 'estimated', value: 0 });
    const result = guard(suite([{ totalWallTimeMs: 200 }]), suite());
    expect(result.primaryObjectiveMet).toBe(true);
    expect(result.summary).toContain('INCONCLUSIVE'); // one observation cannot qualify
  });

  it.each([undefined, null, Number.NaN, Infinity, -1, '0'])(
    'does not substitute zero or aggregate totals for invalid token telemetry: %s', (inputTokens) => {
      const observed = suite([{}, { inputTokens }]);
      expect(readBenchmarkMetric('input_tokens', observed).kind).toBe('unavailable');
      expect(extractMetricValueSafe('total_tokens', observed)).toBeNaN();
    },
  );

  it('requires complete custom metrics and does not interpret cumulative input as peak context', () => {
    expect(readBenchmarkMetric('custom', suite([{ rawMetrics: { custom: 2 } }, { rawMetrics: { custom: 4 } }]))).toEqual({ kind: 'measured', value: 3 });
    expect(readBenchmarkMetric('custom', suite([{ rawMetrics: { custom: 2 } }, {}])).kind).toBe('unavailable');
    expect(extractMetricValueSafe('peak_context_tokens', suite())).toBeNaN();
    expect(extractMetricValueSafe('verification_success', suite([{ physicalVerificationSuccess: undefined }]))).toBeNaN();
    expect(extractMetricValueSafe('task_success', suite([]))).toBeNaN();
  });

  it('does not manufacture a rate when no tools ran or accept impossible failure counts', () => {
    expect(extractMetricValueSafe('tool_failure_rate', suite([{ totalToolCalls: 0, failedToolCalls: 0 }]))).toBeNaN();
    expect(extractMetricValueSafe('tool_failure_rate', suite([{ failedToolCalls: 5 }]))).toBeNaN();
    expect(extractMetricValueSafe('tool_failures', suite([{ failedToolCalls: 0.5 }]))).toBeNaN();
  });

  it('marks missing mandatory measurements inconclusive while retaining known failures', () => {
    const candidate = suite([{ failedToolCalls: undefined }]);
    const experiment = { ...plan, primaryMetric: 'tool_failures', requiredImprovement: { metric: 'tool_failures', operator: '<=', targetValue: 0 } } as ExperimentPlan;
    const result = guard(suite(), candidate, experiment);
    expect(result.qualified).toBe(false);
    expect(result.summary).toContain('INCONCLUSIVE');
    expect(result.inconclusiveReasons.join(' ')).toContain('UNAVAILABLE_METRIC');
    const failed = new RegressionGuard().evaluate({
      plan: experiment, baselineSuite: suite(), candidateSuite: candidate,
      comparison: new BenchmarkService(new EvaluationService()).compareSuites(suite(), candidate),
      candidateVerificationPassed: false, verificationErrors: ['tests failed'],
    });
    expect(failed.summary).toContain('REJECTED');
  });

  it('excludes incomplete vectors and computes a sole candidate volume from observed deltas', () => {
    const objectives = [{ metric: 'wall_time', direction: 'MINIMIZE' as const }];
    const valid = { candidateId: 'valid', rawMetrics: { wall_time: 75 }, normalizedDeltas: { wall_time: -0.25 }, qualifies: true, disqualificationReasons: [] };
    const missing = { candidateId: 'missing', rawMetrics: {}, normalizedDeltas: {}, qualifies: true, disqualificationReasons: [] };
    expect(candidateDominates(missing, valid, objectives)).toBe(false);
    expect(candidateVectorsEquivalent(missing, missing, objectives)).toBe(false);
    const frontier = computeParetoFrontier([valid, missing], objectives);
    expect(frontier.frontierCandidates.map((v) => v.candidateId)).toEqual(['valid']);
    expect(frontier.hypervolume).toBe(0.25);
    expect(missing.qualifies).toBe(false);
  });

  it('instruments real tool failures and protocol counters without inventing missing counters', () => {
    const record = {
      execution: { id: 'execution', taskId: 'task', status: 'failed', modelId: 'test', createdAt: new Date() },
      task: { id: 'task', requirements: {} },
      policyDecisions: [], checks: [], errors: [], filesChanged: [],
      toolCalls: [{ ok: false }, { ok: true }, { ok: false }], events: [],
    } as unknown as ExecutionRecord;
    const service = new EvaluationService();
    expect(service.evaluate(record).metrics.failedToolCalls).toBe(2);
    expect(service.evaluate(record).metrics.malformedActions).toBeUndefined();
    record.events = [{ type: 'termination.completed', timestamp: new Date(), data: { protocolMetrics: { malformedActions: 3 } } }] as ExecutionRecord['events'];
    expect(service.evaluate(record).metrics.malformedActions).toBe(3);
    record.events.push({ type: 'model.route.changed', timestamp: new Date(), data: { accepted: true } } as ExecutionRecord['events'][number]);
    expect(service.evaluate(record).metrics.malformedActions).toBeUndefined();
  });
});
