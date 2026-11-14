import { describe, it, expect } from 'vitest';
import {
  ComputerRegistry,
  RuntimeRegistry,
  ModelRegistry,
  PolicyEngine,
  Scheduler,
  SchedulingError,
  ResourceRouter,
  ResourceLedger,
  AccountRegistry,
  TokenBudgetManager,
  DEFAULT_POLICY,
  type AccountConfig,
  type Computer,
  type ModelRecord,
  type Task,
  type ExecutionRecord,
  type BenchmarkSuiteResult,
  type ComparativeBenchmarkSuiteResult,
  type ExperimentPlan,
} from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import {
  EvaluationService,
  RegressionGuard,
  MetaOptimizerService,
  BenchmarkService,
} from '../src/index.js';

describe('Wazir v0.2 Roadmap Verification Gates (Workstreams B, C, D)', () => {
  describe('Workstream B: KV-Cache VRAM Admission, Cold-Start Latency & Expected Cost per Verified Success', () => {
    it('rejects GPU placement before dispatch when GPU fits model weights but KV cache for target context will not fit', () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const policy = new PolicyEngine();

      const dgxNode: Computer = {
        id: 'dgx-spark-1',
        name: 'DGX Spark',
        type: 'server',
        status: 'online',
        health: 'healthy',
        local: false,
        os: { platform: 'linux', architecture: 'arm64', version: '6.8' },
        hardware: {
          cpu: 'Grace',
          cpuCores: 72,
          memoryGB: 128,
          gpu: {
            vendor: 'nvidia',
            model: 'GB10',
            memoryGB: 24,
            cuda: true,
          },
        },
        load: {
          cpuPercent: 10,
          memoryUsedGB: 32,
          memoryAvailableGB: 96,
          gpuMemoryUsedGB: 2,
          gpuMemoryAvailableGB: 22, // Fits weights plus the minimum coding context, but not the requested large context
        },
        runtimes: ['vllm'],
        models: ['qwen-32b'],
        capabilities: ['remoteExecution'],
        runtimeHealth: {},
        modelHealth: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      computers.register(dgxNode);
      runtimes.register({
        id: 'vllm',
        name: 'vLLM',
        type: 'vllm',
        runtimeKind: 'local',
        computerId: 'dgx-spark-1',
        status: 'running',
        health: 'healthy',
        capabilities: ['coding'],
        models: ['qwen-32b'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const modelRecord: ModelRecord = {
        id: 'qwen-32b',
        name: 'Qwen 32B',
        provider: 'local',
        family: 'qwen',
        contextMax: 131072,
        capabilities: ['coding'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: true,
        memory: { minSystemGB: 16, minGpuGB: 20 },
        runtimeCompatibility: ['vllm'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      models.register(modelRecord);
      models.upsertInstance({
        id: 'inst-qwen-32b',
        modelId: 'qwen-32b',
        runtimeId: 'vllm',
        computerId: 'dgx-spark-1',
        loaded: false,
        health: 'healthy',
        contextTokens: 8192,
      });

      const scheduler = new Scheduler({ computers, runtimes, models, policy });
      const task: Task = {
        id: 'task-kv-overflow',
        type: 'coding',
        title: 'Large context refactor',
        input: 'Refactor module with 73728 token context',
        requirements: { capabilities: ['coding'], minimumContext: 73728 },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      // The scheduler admits at least 16K context for coding; that working set fits in 22GB.
      const smallDecision = scheduler.plan({ task: { ...task, requirements: { capabilities: ['coding'], minimumContext: 8192 } }, requiredContextTokens: 8192 });
      expect(smallDecision.computerId).toBe('dgx-spark-1');

      // At 73728 context, weights plus KV/overhead exceed 24GB total VRAM.
      expect(() => scheduler.plan({ task, requiredContextTokens: 73728 })).toThrowError(SchedulingError);
      try {
        scheduler.plan({ task, requiredContextTokens: 73728 });
      } catch (err) {
        expect((err as SchedulingError).message).toContain('KV cache');
      }
    });

    it('optimizes expected cost per verified success and enforces minVerifiedSuccessRate and maxLatencyMs in ResourceRouter', () => {
      const apiAccount: AccountConfig = {
        id: 'acct-openai',
        provider: 'openai',
        kind: 'api',
        integration: 'api-key',
        runtimeIds: ['openai'],
        allowPaid: true,
        pricing: { inputPerMTok: 2, outputPerMTok: 8 },
      };
      const ledger = new ResourceLedger(':memory:');
      const budget = new TokenBudgetManager(
        ledger,
        new AccountRegistry([apiAccount]),
        {
          ...DEFAULT_POLICY,
          enforce: true,
          allowPaidApiFallback: true,
          minVerifiedSuccessRate: 0.6,
          maxLatencyMs: 5000,
        },
      );

      const router = new ResourceRouter({
        budget,
        resolveAccount: () => 'acct-openai',
      });

      const task: Task = {
        id: 't-cost-verified',
        type: 'coding',
        title: 'Implement feature',
        input: 'Write feature',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const assessments = router.assess({
        task,
        workload: 'routine',
        estimatedInputTokens: 4000,
        estimatedOutputTokens: 1000,
        candidates: [
          {
            modelId: 'cheap-unreliable',
            runtimeId: 'openai',
            capabilityScore: 5,
            residency: 'ready',
            verifiedSuccessRate: 0.4, // Below minVerifiedSuccessRate (0.6) -> rejected!
          },
          {
            modelId: 'cold-slow-model',
            runtimeId: 'openai',
            capabilityScore: 8,
            residency: 'load',
            verifiedSuccessRate: 0.9,
            estimatedLoadMs: 8000, // Exceeds maxLatencyMs (5000) -> rejected!
          },
          {
            modelId: 'reliable-resident',
            runtimeId: 'openai',
            capabilityScore: 8,
            residency: 'ready',
            verifiedSuccessRate: 0.8,
            estimatedLoadMs: 0,
            evictionRequired: false,
            kvCacheFits: true,
          },
        ],
      });

      const unreliable = assessments.find((a) => a.modelId === 'cheap-unreliable')!;
      expect(unreliable.admissible).toBe(false);
      expect(unreliable.reasons.join(' ')).toContain('below policy minimum');

      const slow = assessments.find((a) => a.modelId === 'cold-slow-model')!;
      expect(slow.admissible).toBe(false);
      expect(slow.reasons.join(' ')).toContain('exceeds maxLatencyMs');

      const reliable = assessments.find((a) => a.modelId === 'reliable-resident')!;
      expect(reliable.admissible).toBe(true);
      expect(reliable.effectiveCostPerSuccessUsd).toBeGreaterThan(0);
    });
  });

  describe('Workstream C: Protected Fixtures, Benchmark Contamination & Per-Category Regression Guard', () => {
    const evalService = new EvaluationService();

    const makeBaseExecutionRecord = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
      execution: {
        id: 'exec-1',
        taskId: 'task-1',
        status: 'completed',
        modelId: 'qwen-coder',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      } as any,
      task: {
        id: 'task-1',
        type: 'coding',
        title: 'Fix bug',
        input: 'Fix bug',
        requirements: {},
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
      result: { summary: 'Fixed bug', output: 'Done' } as any,
      filesChanged: ['src/index.ts'],
      workspaceState: { revision: 2 } as any,
      checks: [{ name: 'test', passed: true, durationMs: 100, workspaceRevision: 2 } as any],
      evidence: [
        {
          id: 'ev-1',
          type: 'test_result',
          command: 'npm test',
          exitCode: 0,
          passed: true,
          stdout: '1 passed',
          stderr: '',
          durationMs: 100,
          workspaceRevision: 2,
          timestamp: new Date(),
        } as any,
      ],
      toolCalls: [{ id: 'tc-1', toolName: 'bash', ok: true, durationMs: 50 } as any],
      events: [],
      errors: [],
      ...overrides,
    });

    it('rejects execution when candidate modifies protected benchmark fixtures', () => {
      const record = makeBaseExecutionRecord({
        filesChanged: ['src/index.ts', 'benchmarks/__fixtures__/expected.json'],
      });

      const report = evalService.evaluate(record, {
        expectedFiles: ['src/index.ts'],
      });

      expect(report.passed).toBe(false);
      expect(report.rejectionReason).toContain('PROTECTED_FIXTURE_MODIFIED');
      expect(report.metrics.rawMetrics?.protectedFixtureModified).toBe(true);
    });

    it('rejects execution when benchmark context is contaminated', () => {
      const record = makeBaseExecutionRecord({
        events: [
          {
            id: 'e-contam',
            executionId: 'exec-1',
            type: 'context.compiled' as any,
            timestamp: new Date(),
            data: { contaminated: true, tokens: 1200 },
          },
        ],
      });

      const report = evalService.evaluate(record);
      expect(report.passed).toBe(false);
      expect(report.rejectionReason).toContain('BENCHMARK_CONTAMINATED');
      expect(report.metrics.rawMetrics?.benchmarkContaminated).toBe(true);
    });

    it('computes categoryBreakdown and blocks promotion on CATEGORY_REGRESSION or MODEL_SCOPED_REGRESSION', () => {
      const guard = new RegressionGuard({ minSampleCount: 5 });

      const makeRun = (
        taskId: string,
        repetition: number,
        category: 'CODE_REPAIR' | ' ARCHITECTURE_REFACTOR' | any,
        passed: boolean,
        inputTokens: number,
        modelId: string,
      ) => ({
        taskId,
        taskName: taskId,
        repetition,
        category,
        runnerId: modelId,
        durationMs: 500,
        evaluationVersion: '1.0.0',
        taskDefinitionHash: `hash-${taskId}`,
        scoreReport: {
          executionId: `exec-${taskId}-${repetition}-${modelId}-${inputTokens}`,
          taskId,
          category,
          passed,
          summary: passed ? 'PASS' : 'FAIL',
          evaluationResult: { success: passed, assertions: [], errors: [], reasons: [], evaluatedAt: new Date() },
          metrics: {
            taskSuccess: passed,
            physicalVerificationSuccess: passed,
            totalModelCalls: 1,
            totalToolCalls: 1,
            failedToolCalls: 0,
            malformedActions: 0,
            peakContextTokens: inputTokens,
            repairCycles: 0,
            inputTokens,
            outputTokens: 100,
            compactedTokens: 0,
            totalWallTimeMs: 500,
            modelLatencyMs: 400,
            toolLatencyMs: 100,
            costEstimateUsd: 0.002,
            verificationLatencyMs: 50,
            rawMetrics: {
              tokenUsageAvailable: true,
              modelCallCountAvailable: true,
              modelId,
            },
          },
        },
      });

      const baselineResults = [
        ...[0, 1, 2, 3, 4].map((rep) => makeRun('task-easy', rep, 'CODE_REPAIR', true, 1000, 'qwen-coder')),
        ...[0, 1, 2, 3, 4].map((rep) => makeRun('task-hard', rep, 'FEATURE_IMPLEMENTATION', true, 1000, 'gemma-27b')),
      ];
      // Candidate improves tokens on task-easy (qwen-coder) but regresses pass rate & tokens on task-hard (gemma-27b)
      const candidateResults = [
        ...[0, 1, 2, 3, 4].map((rep) => makeRun('task-easy', rep, 'CODE_REPAIR', true, 700, 'qwen-coder')),
        ...[0, 1, 2, 3, 4].map((rep) => makeRun('task-hard', rep, 'FEATURE_IMPLEMENTATION', rep < 3, 1300, 'gemma-27b')),
      ];

      const baselineSuite: BenchmarkSuiteResult = {
        suiteId: 'base-suite',
        runnerId: 'multi',
        startedAt: new Date(),
        completedAt: new Date(),
        totalTasks: 10,
        passedTasks: 10,
        failedTasks: 0,
        passRate: 1.0,
        aggregateMetrics: {} as any,
        results: baselineResults as any,
      };
      const candidateSuite: BenchmarkSuiteResult = {
        suiteId: 'cand-suite',
        runnerId: 'multi',
        startedAt: new Date(),
        completedAt: new Date(),
        totalTasks: 10,
        passedTasks: 8,
        failedTasks: 2,
        passRate: 0.8,
        aggregateMetrics: {} as any,
        results: candidateResults as any,
      };
      const comparison: ComparativeBenchmarkSuiteResult = {
        baselineSuiteId: 'base-suite',
        candidateSuiteId: 'cand-suite',
        baselineRunnerId: 'multi',
        candidateRunnerId: 'multi',
        baselinePassRate: 1.0,
        candidatePassRate: 0.8,
        passRateDelta: -0.2,
        regressionDetected: true,
        regressedTasks: ['task-hard'],
        improvedTasks: ['task-easy'],
        aggregateDeltas: {} as any,
        taskComparisons: [],
        summary: 'Regressed on task-hard',
      };
      const plan: ExperimentPlan = {
        id: 'exp-1',
        hypothesisId: 'hyp-1',
        targetSubsystem: 'context_Invalidation',
        primaryMetric: 'input_tokens',
        protectedMetrics: ['task_success', 'verification_success'],
        sampleSize: 5,
        createdAt: new Date(),
      } as any;

      const guardResult = guard.evaluate({
        plan,
        baselineSuite,
        candidateSuite,
        comparison,
      });

      expect(guardResult.qualified).toBe(false);
      expect(guardResult.categoryBreakdown?.['CODE_REPAIR']?.regressed).toBe(false);
      expect(guardResult.categoryBreakdown?.['FEATURE_IMPLEMENTATION']?.regressed).toBe(true);
      expect(guardResult.regressionsDetected.some((r) => r.startsWith('CATEGORY_REGRESSION:'))).toBe(true);
      expect(guardResult.scopedModels).toEqual({
        improved: ['qwen-coder'],
        regressed: ['gemma-27b'],
      });
      expect(guardResult.regressionsDetected.some((r) => r.startsWith('MODEL_SCOPED_REGRESSION:'))).toBe(true);
    });
  });

  describe('Workstream D: Dynamic Baseline Model Recording', () => {
    it('derives baseline models from active routingRules instead of hardcoded model names', async () => {
      const store = new MemoryStore();
      const optimizer = new MetaOptimizerService({
        store,
        initialConfig: {
          id: 'cfg-v02',
          version: 1,
          routingRules: {
            coding: { preferredModel: 'deepseek-r1-distill', fallbackModel: 'llama-3.3-70b' },
            verification: { preferredModel: 'claude-3-7-sonnet' },
          },
          createdAt: new Date(),
        },
      });

      const baseline = await optimizer.recordBaseline({});
      expect(baseline.models).toEqual(['deepseek-r1-distill', 'llama-3.3-70b', 'claude-3-7-sonnet']);
    });

    it('F5: resolves phase models dynamically via ModelRegistry and Scheduler with explainable fallbacks when preferred model is missing or unloaded', () => {
      const registry = new ModelRegistry();
      registry.register({
        id: 'gemma-27b',
        name: 'Gemma 27B (Unloaded)',
        provider: 'local',
        family: 'gemma',
        contextMax: 32768,
        capabilities: ['reasoning'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: true,
        runtimeCompatibility: ['vllm'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      registry.upsertInstance({
        id: 'inst-gemma-27b',
        modelId: 'gemma-27b',
        runtimeId: 'vllm',
        computerId: 'dgx-1',
        loaded: false,
        state: 'UNLOADED',
        health: 'healthy',
      });

      registry.register({
        id: 'deepseek-coder-v2',
        name: 'DeepSeek Coder V2',
        provider: 'local',
        family: 'deepseek',
        contextMax: 65536,
        capabilities: ['coding', 'reasoning'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: true,
        runtimeCompatibility: ['vllm'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      registry.upsertInstance({
        id: 'inst-deepseek',
        modelId: 'deepseek-coder-v2',
        runtimeId: 'vllm',
        computerId: 'dgx-1',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      });

      const optimizer = new MetaOptimizerService({
        benchmarkService: new BenchmarkService(),
        modelRegistry: registry,
      });

      // 'plan' prefers 'gemma-27b' (which is unloaded); should fallback to available 'deepseek-coder-v2'
      const planResolution = optimizer.resolveModelForPhase('plan');
      expect(planResolution.modelId).toBe('deepseek-coder-v2');
      expect(planResolution.fallbackUsed).toBe(true);
      expect(planResolution.reasons.some((r) => r.includes('unavailable/unloaded'))).toBe(true);

      // 'repair' prefers 'qwen-2.5-coder' (not registered) and fallback 'gpt-4o' (not registered); should select 'deepseek-coder-v2'
      const repairResolution = optimizer.resolveModelForPhase('repair');
      expect(repairResolution.modelId).toBe('deepseek-coder-v2');
      expect(repairResolution.fallbackUsed).toBe(true);
      expect(repairResolution.reasons.some((r) => r.includes('not registered'))).toBe(true);
    });

    it('F2: fails closed when candidateVerificationPassed is omitted and candidate runs lack physicalVerificationSuccess or suite is empty', () => {
      const guard = new RegressionGuard({ minSampleCount: 5 });
      const plan: ExperimentPlan = {
        experimentId: 'exp-f2',
        hypothesisId: 'hyp-f2',
        primaryMetric: 'input_tokens',
        protectedMetrics: ['task_success', 'verification_success'],
        minSampleCount: 5,
      } as any;

      const emptySuite: BenchmarkSuiteResult = {
        category: 'CODE_REPAIR',
        runnerId: 'r1',
        totalTasks: 0,
        passedTasks: 0,
        failedTasks: 0,
        results: [],
        aggregateMetrics: { totalWallTimeMs: 0, totalModelCalls: 0, totalToolCalls: 0, totalTokens: 0, totalCostUsd: 0, averageRepairCycles: 0 },
        summary: 'empty',
      };
      const emptyComparison: ComparativeBenchmarkSuiteResult = {
        suiteName: 'empty',
        baselineSuite: emptySuite,
        candidateSuite: emptySuite,
        taskComparisons: [],
        aggregateDeltas: {
          passRateDelta: 0,
          tokensDelta: 0,
          tokensSavedPct: 0,
          wallTimeDeltaMs: 0,
          wallTimeSavedPct: 0,
          costDeltaUsd: 0,
          repairCyclesDelta: 0,
        },
        regressedTasks: [],
        improvedTasks: [],
        summary: 'empty',
      };

      const emptyResult = guard.evaluate({
        plan,
        baselineSuite: emptySuite,
        candidateSuite: emptySuite,
        comparison: emptyComparison,
      });
      expect(emptyResult.qualified).toBe(false);
      expect(emptyResult.inconclusiveReasons?.some((r) => r.includes('EMPTY_BENCHMARK_SUITE'))).toBe(true);
    });

    it('Section 2: terminates hanging benchmark runners at timeoutMs and rejects empty benchmark suites', async () => {
      const bench = new BenchmarkService();
      bench.register({
        id: 'hang-task',
        name: 'Hanging Task',
        category: 'CODE_REPAIR',
        description: 'Task with a runner that ignores abortSignal',
        prompt: 'Fix it',
        timeoutMs: 60,
      });

      const hangingRunner = {
        id: 'hanging-runner',
        name: 'Hanging Runner',
        run: async () => {
          // Ignores context.abortSignal completely
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          throw new Error('Should have timed out before reaching here');
        },
      };

      const res = await bench.runTask('hang-task', hangingRunner, { timeoutMs: 60 });
      expect(res.scoreReport.passed).toBe(false);
      expect(res.error).toBe('BENCHMARK_DEADLINE_EXCEEDED');
      expect(res.scoreReport.rejectionReason).toBe('BENCHMARK_DEADLINE_EXCEEDED');

      await expect(bench.runBenchmarkSuite([], hangingRunner)).rejects.toThrow('EMPTY_BENCHMARK_SUITE');
    });
  });
});

