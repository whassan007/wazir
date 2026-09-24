import { describe, it, expect, beforeEach } from 'vitest';
import {
  MetaOptimizerService,
  DEFAULT_OPTIMIZABLE_CONFIG,
} from '../src/metaOptimizerService.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { MemoryStore } from '@wazir/shared';
import type {
  BenchmarkRunner,
  BenchmarkTask,
  ExecutionRecord,
} from '@wazir/core';

describe('Gate 13: Empirical Meta-Optimizer', () => {
  let benchmarkService: BenchmarkService;
  let evaluationService: EvaluationService;
  let metaOptimizer: MetaOptimizerService;
  let store: MemoryStore;

  const task1: BenchmarkTask = {
    id: 'opt-bench-1',
    name: 'Simple Syntax Fix',
    category: 'CODE_REPAIR',
    description: 'Fix syntax error in index.ts',
    prompt: 'Fix syntax error',
    expectedFiles: ['index.ts'],
    mutationRequired: true,
  };

  const task2: BenchmarkTask = {
    id: 'opt-bench-2',
    name: 'Unit Test Coverage',
    category: 'FEATURE_IMPLEMENTATION',
    description: 'Add tests for utility',
    prompt: 'Add test suite',
    expectedFiles: ['utils.test.ts'],
    mutationRequired: true,
  };

  beforeEach(() => {
    store = new MemoryStore();
    evaluationService = new EvaluationService();
    benchmarkService = new BenchmarkService(evaluationService);
    benchmarkService.register(task1);
    benchmarkService.register(task2);

    metaOptimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      store,
    });
  });

  it('initializes with default active config and proposes mutations', () => {
    const config = metaOptimizer.getActiveConfig();
    expect(config.id).toBe(DEFAULT_OPTIMIZABLE_CONFIG.id);
    expect(config.contextWeights?.definitionRelevance).toBe(1.0);

    const candidate = metaOptimizer.proposeCandidate([
      {
        type: 'WEIGHT_ADJUSTMENT',
        path: 'contextWeights.definitionRelevance',
        oldValue: 1.0,
        newValue: 1.5,
        rationale: 'Prioritize symbol definitions in context compiler',
      },
      {
        type: 'PROMPT_TWEAK',
        path: 'prompts.repairGuidance',
        oldValue: config.prompts?.repairGuidance,
        newValue: 'Strictly check diagnostics before declaring repair complete.',
        rationale: 'Reduce repair cycles',
      },
    ]);

    expect(candidate.candidateId).toBeDefined();
    expect(candidate.config.contextWeights?.definitionRelevance).toBe(1.5);
    expect(candidate.config.prompts?.repairGuidance).toContain('Strictly check diagnostics');
    expect(candidate.config.version).toBe(config.version + 1);
  });

  it('rejects candidate when a regression is detected on passing tasks (ZERO REGRESSION TOLERANCE)', async () => {
    const candidate = metaOptimizer.proposeCandidate([
      {
        type: 'POLICY_MODIFICATION',
        path: 'toolPolicies.codeModeThreshold',
        oldValue: 3,
        newValue: 10,
        rationale: 'Test regression detection',
      },
    ]);

    // Baseline runner: passes task1 and task2
    let runCount = 0;
    const runner: BenchmarkRunner = {
      id: 'mock-regressing-runner',
      name: 'Mock Regressing Runner',
      async run(task): Promise<ExecutionRecord> {
        runCount++;
        // First 2 runs are baseline (passes both). Next 2 are candidate (breaks task2).
        const isCandidate = runCount > 2;
        const pass = isCandidate ? task.id === 'opt-bench-1' : true;

        return {
          execution: {
            id: `exec-${task.id}-${runCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'test',
            status: pass ? 'completed' : 'failed',
            createdAt: new Date(),
            completedAt: new Date(),
          },
          task: {
            id: task.id,
            type: 'benchmark',
            title: task.name,
            input: task.prompt,
            requirements: {},
            priority: 'normal',
            status: pass ? 'completed' : 'failed',
            createdAt: new Date(),
          },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: pass ? task.expectedFiles ?? [] : [],
          checks: [{ name: 'test', command: 'npm test', ok: pass, durationMs: 100 }],
          errors: pass ? [] : ['Regression occurred in test execution'],
          events: [],
          usage: { inputTokens: 500, outputTokens: 200 },
        };
      },
    };

    const result = await metaOptimizer.evaluateCandidate(candidate, runner, [task1, task2]);

    expect(result.decision).toBe('REJECTED');
    expect(result.comparison.regressionDetected).toBe(true);
    expect(result.comparison.regressedTasks).toContain('opt-bench-2');
    expect(result.reasons.some((r) => r.includes('REGRESSION_DETECTED'))).toBe(true);

    // Active config must remain the baseline
    expect(metaOptimizer.getActiveConfig().id).toBe(DEFAULT_OPTIMIZABLE_CONFIG.id);
  });

  it('accepts candidate when pass rate strictly improves', async () => {
    const candidate = metaOptimizer.proposeCandidate([
      {
        type: 'PROMPT_TWEAK',
        path: 'prompts.verificationInstruction',
        oldValue: '',
        newValue: 'Ensure verification oracle passes before emitting completion token.',
        rationale: 'Improve pass rate on complex tasks',
      },
    ]);

    let runCount = 0;
    const runner: BenchmarkRunner = {
      id: 'mock-improving-runner',
      name: 'Mock Improving Runner',
      async run(task): Promise<ExecutionRecord> {
        runCount++;
        // Baseline: fails task2. Candidate: passes both task1 and task2.
        const isCandidate = runCount > 2;
        const pass = isCandidate ? true : task.id === 'opt-bench-1';

        return {
          execution: {
            id: `exec-${task.id}-${runCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'test',
            status: pass ? 'completed' : 'failed',
            createdAt: new Date(),
            completedAt: new Date(),
          },
          task: {
            id: task.id,
            type: 'benchmark',
            title: task.name,
            input: task.prompt,
            requirements: {},
            priority: 'normal',
            status: pass ? 'completed' : 'failed',
            createdAt: new Date(),
          },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: pass ? task.expectedFiles ?? [] : [],
          checks: [{ name: 'test', command: 'npm test', ok: pass, durationMs: 100 }],
          errors: pass ? [] : ['Test failed in baseline'],
          events: [],
          usage: { inputTokens: 500, outputTokens: 200 },
        };
      },
    };

    const result = await metaOptimizer.evaluateCandidate(candidate, runner, [task1, task2]);

    expect(result.decision).toBe('ACCEPTED');
    expect(result.comparison.regressionDetected).toBe(false);
    expect(result.comparison.passRateDelta).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes('PASS_RATE_IMPROVEMENT'))).toBe(true);

    // Active config promoted!
    expect(metaOptimizer.getActiveConfig().id).toBe(candidate.candidateId);
  });

  it('accepts candidate that preserves 100% pass rate while significantly reducing token/cost consumption', async () => {
    const candidate = metaOptimizer.proposeCandidate([
      {
        type: 'WEIGHT_ADJUSTMENT',
        path: 'contextWeights.recencyRelevance',
        oldValue: 0.5,
        newValue: 0.2,
        rationale: 'Cut down recent message bloat',
      },
    ]);

    let runCount = 0;
    const runner: BenchmarkRunner = {
      id: 'mock-efficient-runner',
      name: 'Mock Efficient Runner',
      async run(task): Promise<ExecutionRecord> {
        runCount++;
        const isCandidate = runCount > 2;
        // Both baseline and candidate pass all tasks, but candidate uses 80% fewer tokens
        const tokens = isCandidate ? 100 : 1000;

        return {
          execution: {
            id: `exec-${task.id}-${runCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'test',
            status: 'completed',
            createdAt: new Date(),
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
          usage: { inputTokens: tokens, outputTokens: tokens / 2 },
        };
      },
    };

    const result = await metaOptimizer.evaluateCandidate(candidate, runner, [task1, task2]);

    expect(result.decision).toBe('ACCEPTED');
    expect(result.comparison.regressionDetected).toBe(false);
    expect(result.comparison.passRateDelta).toBe(0);
    expect(result.comparison.tokenUsageDelta).toBeLessThan(0);
    expect(result.comparison.costDelta).toBeLessThan(0);
    expect(result.reasons.some((r) => r.includes('EFFICIENCY_IMPROVEMENT'))).toBe(true);

    // Active config promoted!
    expect(metaOptimizer.getActiveConfig().id).toBe(candidate.candidateId);
  });

  it('rejects candidate when there is no empirical advantage', async () => {
    const candidate = metaOptimizer.proposeCandidate([
      {
        type: 'PROMPT_TWEAK',
        path: 'prompts.systemPromptPrefix',
        oldValue: 'You are Wazir',
        newValue: 'You are Wazir autonomous control plane',
        rationale: 'Cosmetic edit',
      },
    ]);

    const runner: BenchmarkRunner = {
      id: 'mock-identical-runner',
      name: 'Mock Identical Runner',
      async run(task): Promise<ExecutionRecord> {
        return {
          execution: {
            id: `exec-${task.id}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'test',
            status: 'completed',
            createdAt: new Date(),
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
          usage: { inputTokens: 500, outputTokens: 200 },
        };
      },
    };

    const result = await metaOptimizer.evaluateCandidate(candidate, runner, [task1, task2]);

    expect(result.decision).toBe('REJECTED');
    expect(result.reasons.some((r) => r.includes('NO_EMPIRICAL_ADVANTAGE'))).toBe(true);
  });

  it('supports rollback to baseline configuration', async () => {
    const originalConfig = metaOptimizer.getActiveConfig();

    const candidate = metaOptimizer.proposeCandidate([
      {
        type: 'PROMPT_TWEAK',
        path: 'prompts.repairGuidance',
        oldValue: '',
        newValue: 'New repair guidance',
        rationale: 'Tune guidance',
      },
    ]);

    let runCount = 0;
    const runner: BenchmarkRunner = {
      id: 'mock-runner',
      name: 'Mock Runner',
      async run(task): Promise<ExecutionRecord> {
        runCount++;
        const isCandidate = runCount > 2;
        return {
          execution: {
            id: `exec-${task.id}-${runCount}`,
            taskId: task.id,
            runtimeId: 'test',
            modelId: 'test',
            status: 'completed',
            createdAt: new Date(),
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
          usage: { inputTokens: isCandidate ? 200 : 800, outputTokens: 100 },
        };
      },
    };

    const runResult = await metaOptimizer.evaluateCandidate(candidate, runner, [task1, task2]);
    expect(runResult.decision).toBe('ACCEPTED');
    expect(metaOptimizer.getActiveConfig().id).toBe(candidate.candidateId);

    // Rollback to baseline
    const rolledBack = await metaOptimizer.rollback(runResult.runId);
    expect(rolledBack.id).toBe(originalConfig.id);
    expect(metaOptimizer.getActiveConfig().id).toBe(originalConfig.id);
  });
});
