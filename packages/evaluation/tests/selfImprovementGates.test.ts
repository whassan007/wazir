import { describe, it, expect, beforeEach } from 'vitest';
import {
  MetaOptimizerService,
  DEFAULT_OPTIMIZABLE_CONFIG,
} from '../src/metaOptimizerService.js';
import { OpportunityDetector } from '../src/opportunityDetector.js';
import { RegressionGuard } from '../src/regressionGuard.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';
import type {
  BenchmarkRunner,
  BenchmarkTask,
  ExecutionRecord,
  ExperimentPlan,
} from '@wazir/core';

describe('G29 / G30 / G31 Acceptance Meta-Benchmarks', () => {
  let benchmarkService: BenchmarkService;
  let evaluationService: EvaluationService;
  let memoryService: MemoryService;
  let store: MemoryStore;
  let optimizer: MetaOptimizerService;

  const benchTask1: BenchmarkTask = {
    id: 'g29-bench-1',
    name: 'Context Compaction Task',
    category: 'CONTEXT_STRESS',
    description: 'Ensure bounded context compaction',
    prompt: 'Process long history',
    expectedFiles: ['state.json'],
    mutationRequired: true,
  };

  const benchTask2: BenchmarkTask = {
    id: 'g29-bench-2',
    name: 'Compile Repair Task',
    category: 'CODE_REPAIR',
    description: 'Repair syntax error in parser',
    prompt: 'Fix parser error',
    expectedFiles: ['parser.cpp'],
    mutationRequired: true,
  };

  beforeEach(() => {
    store = new MemoryStore();
    memoryService = new MemoryService();
    evaluationService = new EvaluationService();
    benchmarkService = new BenchmarkService(evaluationService);
    benchmarkService.register(benchTask1);
    benchmarkService.register(benchTask2);

    optimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      memoryService,
      store,
    });
  });

  // ======================================================================
  // G29: SELF_IMPROVEMENT
  // ======================================================================
  describe('Gate 29: SELF_IMPROVEMENT', () => {
    it('proves all 12 empirical self-improvement invariants end-to-end', async () => {
      // 1. Invariant 1: Record immutable baseline and ensure baseline preserved
      const initialActiveConfig = optimizer.getActiveConfig();
      const baselineRecord = await optimizer.recordBaseline({
        config: initialActiveConfig,
        commitSha: 'commit-baseline-001',
        workspaceRoot: '/workspace/main',
      });
      expect(baselineRecord.id).toBeDefined();
      expect(baselineRecord.config.id).toBe(initialActiveConfig.id);

      // 2. Identify deliberate measurable inefficiency from executions
      const pastExecutions: ExecutionRecord[] = [
        {
          execution: { id: 'hist-1', taskId: 't1', runtimeId: 'r', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't1', type: 'code', title: 't1', input: '', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['a.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
          errors: [],
          events: [],
          usage: { input: 78_000, output: 1000 },
        },
        {
          execution: { id: 'hist-2', taskId: 't2', runtimeId: 'r', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't2', type: 'code', title: 't2', input: '', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['b.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
          errors: [],
          events: [],
          usage: { input: 82_000, output: 1000 },
        },
        {
          execution: { id: 'hist-3', taskId: 't3', runtimeId: 'r', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't3', type: 'code', title: 't3', input: '', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['c.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
          errors: [],
          events: [],
          usage: { input: 79_000, output: 1000 },
        },
      ];

      const opportunities = optimizer.observe({ executions: pastExecutions });
      expect(opportunities.length).toBeGreaterThan(0);
      const targetOpp = opportunities.find((o) => o.category === 'HIGH_CONTEXT_GROWTH');
      expect(targetOpp).toBeDefined();

      // 3. Formulate hypothesis
      const hypotheses = optimizer.formulateHypotheses(targetOpp!);
      expect(hypotheses.length).toBeGreaterThan(0);
      const hyp = hypotheses[0];

      // 4. Invariant 3: Acceptance criteria defined BEFORE candidate results are observed
      const plan: ExperimentPlan = optimizer.designExperiment({
        hypothesis: hyp,
        sampleSize: 1,
        tasks: ['g29-bench-1', 'g29-bench-2'],
      });
      expect(plan.experimentId).toBeDefined();
      expect(plan.primaryMetric).toBe('peak_context_tokens');
      expect(plan.requiredImprovement.targetValue).toBeLessThan(targetOpp!.baseline);

      // 5. Invariant 2: Candidate generated in isolated structure (independent ID and configuration)
      const candidates = await optimizer.generateCandidates(plan, 1);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      expect(candidate.candidateId).not.toBe(initialActiveConfig.id);
      expect(candidate.config.id).not.toBe(initialActiveConfig.id);

      // 6. Invariant 4 & 5: Candidate physical mutations and build verification
      candidate.filesChanged = ['packages/core/src/services/contextCompiler.ts'];
      const verification = await optimizer.verifyCandidate(candidate);
      expect(verification.allPassed).toBe(true);

      // 7. Invariant 7 & 8: Baseline and candidate benchmarked under equivalent workload
      let invocationCount = 0;
      const runner: BenchmarkRunner = {
        id: 'g29-runner',
        name: 'G29 Verified Runner',
        async run(task) {
          invocationCount++;
          // First 2 runs: baseline. Next 2 runs: candidate.
          const isCandidate = invocationCount > 2;
          const tokens = isCandidate ? 50_000 : 80_000;

          return {
            execution: {
              id: `exec-${task.id}-${invocationCount}`,
              taskId: task.id,
              runtimeId: 'test',
              modelId: 'qwen',
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
            checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 80 }],
            errors: [],
            events: [],
            usage: { input: tokens, output: 200 },
          };
        },
      };

      // 8. Invariant 6, 9, 10: Verification, RegressionGuard execution, decision based on evidence
      const runResults = await optimizer.evaluateCandidates({
        plan,
        candidates,
        runner,
        tasks: [benchTask1, benchTask2],
      });

      expect(runResults).toHaveLength(1);
      const result = runResults[0];
      expect(result.decision).toBe('QUALIFIED');
      expect(result.regressionGuard?.qualified).toBe(true);
      expect(result.regressionGuard?.regressionsDetected).toHaveLength(0);
      expect(result.comparison.regressionDetected).toBe(false);

      // 9. Invariant 11: Learning persisted in MemoryService
      const episodes = memoryService.queryEpisodic({ repositoryScope: 'wazir' });
      expect(episodes.length).toBeGreaterThan(0);
      expect(episodes.some((e) => e.attemptOutcome === 'success')).toBe(true);

      // 10. Invariant 12: Baseline unchanged unless explicit authorized promotion occurs
      expect(optimizer.getActiveConfig().id).toBe(initialActiveConfig.id);

      // Explicit promotion
      const promoResult = await optimizer.promoteCandidate(candidate, { operatorApproved: true });
      expect(promoResult.success).toBe(true);
      expect(optimizer.getActiveConfig().id).toBe(candidate.config.id);
    });
  });

  // ======================================================================
  // G30: SELF_IMPROVEMENT_REGRESSION
  // ======================================================================
  describe('Gate 30: SELF_IMPROVEMENT_REGRESSION', () => {
    it('strictly rejects superficially attractive candidate that breaks a protected metric (ZERO REGRESSION TOLERANCE)', async () => {
      const plan: ExperimentPlan = {
        experimentId: 'exp-g30-regression',
        name: 'aggressive-token-pruning',
        hypothesis: {
          id: 'hyp-g30',
          targetComponent: 'ContextCompiler',
          domain: 'context_policy',
          proposedChange: 'Drop 50% of history aggressively',
          expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.5, direction: 'decrease' },
          possibleRegressions: ['task_success'],
          requiredBenchmark: ['CONTEXT_STRESS'],
          successThreshold: 45_000,
        },
        primaryMetric: 'input_tokens',
        secondaryMetrics: ['task_success'],
        requiredImprovement: {
          metric: 'input_tokens',
          operator: '<=',
          targetValue: 45_000,
        },
        regressionConstraints: {
          task_success: {
            metric: 'task_success',
            operator: '>=',
            targetValue: 1.0,
          },
        },
        benchmarkCategories: ['CONTEXT_STRESS'],
        benchmarkTasks: ['g29-bench-1', 'g29-bench-2'],
        sampleSize: 1,
        budget: { maxExperiments: 5, maxCandidatesPerExperiment: 2, maxModelCalls: 50, maxTokens: 100_000, maxWallTimeMs: 1000 },
        createdAt: new Date(),
      };

      const candidates = await optimizer.generateCandidates(plan, 1);

      // Candidate reduces tokens by 50% BUT breaks task2 (pass rate drops from 100% to 50%)
      let invocationCount = 0;
      const runner: BenchmarkRunner = {
        id: 'g30-runner',
        name: 'Regressing Candidate Runner',
        async run(task) {
          invocationCount++;
          const isCandidate = invocationCount > 2;
          const pass = isCandidate ? task.id === 'g29-bench-1' : true; // Breaks task2!
          const tokens = isCandidate ? 30_000 : 80_000; // 62% token reduction!

          return {
            execution: {
              id: `exec-${task.id}-${invocationCount}`,
              taskId: task.id,
              runtimeId: 'test',
              modelId: 'qwen',
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
            checks: [{ name: 'test', command: 'npm test', ok: pass, durationMs: 80 }],
            errors: pass ? [] : ['Regression: parsing logic broken due to omitted context'],
            events: [],
            usage: { input: tokens, output: 200 },
          };
        },
      };

      const runResults = await optimizer.evaluateCandidates({
        plan,
        candidates,
        runner,
        tasks: [benchTask1, benchTask2],
      });

      expect(runResults).toHaveLength(1);
      const result = runResults[0];

      // Must be REJECTED despite massive token reduction
      expect(result.decision).toBe('REJECTED');
      expect(result.comparison.regressionDetected).toBe(true);
      expect(result.comparison.regressedTasks).toContain('g29-bench-2');
      expect(result.regressionGuard?.qualified).toBe(false);
      expect(result.regressionGuard?.summary).toContain('REJECTED');

      // Baseline must remain active
      expect(optimizer.getActiveConfig().id).toBe(DEFAULT_OPTIMIZABLE_CONFIG.id);

      // Failure must be learned in MemoryService
      const episodes = memoryService.queryEpisodic({ repositoryScope: 'wazir' });
      expect(episodes.some((e) => e.attemptOutcome === 'failure')).toBe(true);
    });
  });

  // ======================================================================
  // G31: SELF_IMPROVEMENT_INCONCLUSIVE
  // ======================================================================
  describe('Gate 31: SELF_IMPROVEMENT_INCONCLUSIVE', () => {
    it('returns INCONCLUSIVE when evidence is insufficient or noisy (Wazir does not invent certainty)', async () => {
      // Configure RegressionGuard requiring at least 5 benchmark samples
      const strictGuard = new RegressionGuard({ minSampleCount: 5 });
      const optimizerWithStrictGuard = new MetaOptimizerService({
        benchmarkService,
        evaluationService,
        regressionGuard: strictGuard,
        memoryService,
      });

      const plan: ExperimentPlan = {
        experimentId: 'exp-g31-inconclusive',
        name: 'sample-size-test',
        hypothesis: {
          id: 'hyp-g31',
          targetComponent: 'ContextCompiler',
          domain: 'context_policy',
          proposedChange: 'Micro-optimization of weight',
          expectedMetricEffect: { metric: 'input_tokens', expectedDelta: -0.05, direction: 'decrease' },
          possibleRegressions: [],
          requiredBenchmark: ['CONTEXT_STRESS'],
          successThreshold: 75_000,
        },
        primaryMetric: 'input_tokens',
        secondaryMetrics: [],
        requiredImprovement: {
          metric: 'input_tokens',
          operator: '<=',
          targetValue: 75_000,
        },
        regressionConstraints: {},
        benchmarkCategories: ['CONTEXT_STRESS'],
        benchmarkTasks: ['g29-bench-1'],
        sampleSize: 1, // Only 1 sample evaluated, below minSampleCount 5!
        budget: { maxExperiments: 5, maxCandidatesPerExperiment: 2, maxModelCalls: 50, maxTokens: 100_000, maxWallTimeMs: 1000 },
        createdAt: new Date(),
      };

      const candidates = await optimizerWithStrictGuard.generateCandidates(plan, 1);

      let invocationCount = 0;
      const runner: BenchmarkRunner = {
        id: 'g31-runner',
        name: 'Single Sample Runner',
        async run(task) {
          invocationCount++;
          const isCandidate = invocationCount > 1;
          return {
            execution: {
              id: `exec-${task.id}-${invocationCount}`,
              taskId: task.id,
              runtimeId: 'test',
              modelId: 'qwen',
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
            checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 80 }],
            errors: [],
            events: [],
            usage: { input: isCandidate ? 70_000 : 80_000, output: 200 },
          };
        },
      };

      const runResults = await optimizerWithStrictGuard.evaluateCandidates({
        plan,
        candidates,
        runner,
        tasks: [benchTask1], // Only 1 task run
      });

      expect(runResults).toHaveLength(1);
      const result = runResults[0];

      // Must be INCONCLUSIVE, not QUALIFIED or ACCEPTED
      expect(result.decision).toBe('INCONCLUSIVE');
      expect(result.regressionGuard?.inconclusiveReasons.length).toBeGreaterThan(0);
      expect(result.regressionGuard?.summary).toContain('INCONCLUSIVE');
    });
  });
});
