import { describe, it, expect, beforeEach } from 'vitest';
import {
  DistributedBenchmarkFabric,
  ShardWorkerDispatch,
  MetaOptimizerService,
  BenchmarkService,
  EvaluationService,
  RegressionGuard,
} from '@wazir/evaluation';
import { ComputerRegistry } from '@wazir/core';
import type {
  Computer,
  BenchmarkTask,
  ExecutionRecord,
  ExperimentPlan,
  CandidateImplementation,
  OptimizableConfig,
} from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import { MemoryService } from '@wazir/memory';

/**
 * Gate G44 & G45 Acceptance Tests:
 * - G44 (Test 57): DISTRIBUTED_META
 * - G45 (Test 58): DISTRIBUTED_FAILURE
 */
describe('G44 / G45 Acceptance: Distributed Benchmark Fabric & Worker Resilience', () => {
  let computerRegistry: ComputerRegistry;
  let evaluationService: EvaluationService;
  let benchmarkService: BenchmarkService;
  let regressionGuard: RegressionGuard;
  let fabric: DistributedBenchmarkFabric;

  const workerDgx: Computer = {
    id: 'worker-dgx',
    name: 'NVIDIA DGX H100 Node 1',
    endpoint: 'http://dgx-01.internal:8080',
    status: 'online',
    hardware: {
      cpu: 'AMD EPYC 9654',
      cpuCores: 96,
      memoryGB: 1024,
      gpu: {
        model: 'NVIDIA H100 SXM5',
        count: 8,
        memoryGB: 80,
      },
    },
    os: {
      platform: 'linux',
      version: 'Ubuntu 22.04',
      architecture: 'x64',
    },
    runtimes: ['lmstudio', 'ollama'],
    tags: ['dgx', 'high-perf', 'gpu'],
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
  };

  const workerMac: Computer = {
    id: 'worker-mac',
    name: 'Apple Mac Studio M2 Ultra',
    endpoint: 'http://mac-01.internal:8080',
    status: 'online',
    hardware: {
      cpu: 'Apple M2 Ultra',
      cpuCores: 24,
      memoryGB: 192,
      gpu: {
        model: 'Apple M2 Ultra Metal',
        count: 1,
        memoryGB: 192,
        unifiedMemory: true,
      },
    },
    os: {
      platform: 'darwin',
      version: 'macOS 14.4',
      architecture: 'arm64',
    },
    runtimes: ['ollama'],
    tags: ['mac', 'arm64', 'metal'],
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
  };

  const testTasks: BenchmarkTask[] = [
    {
      id: 'task-distributed-1',
      name: 'Deterministic Context Compaction',
      category: 'CONTEXT_STRESS',
      description: 'Stress context compaction under high token loads',
      prompt: 'Compress history deterministically',
      expectedFiles: ['state.json'],
    },
    {
      id: 'task-distributed-2',
      name: 'C++ Ast Pattern Verification',
      category: 'CODE_REPAIR',
      description: 'Validate repair of AST node parsing',
      prompt: 'Repair AST node syntax in parser.cpp',
      expectedFiles: ['parser.cpp'],
    },
    {
      id: 'task-distributed-3',
      name: 'Parallel Branch Synthesis',
      category: 'LOGIC_PUZZLE',
      description: 'Test parallel search branch reasoning',
      prompt: 'Evaluate DAG branching logic',
      expectedFiles: ['solver.py'],
    },
    {
      id: 'task-distributed-4',
      name: 'Dynamic Tool Surface Filter',
      category: 'TOOL_USE',
      description: 'Filter unused tools deterministically',
      prompt: 'Surface required tool schemas for planning phase',
      expectedFiles: ['tools.json'],
    },
  ];

  beforeEach(() => {
    computerRegistry = new ComputerRegistry();
    computerRegistry.register(workerDgx);
    computerRegistry.register(workerMac);

    evaluationService = new EvaluationService();
    benchmarkService = new BenchmarkService(evaluationService);
    testTasks.forEach((t) => benchmarkService.register(t));
    regressionGuard = new RegressionGuard();

    fabric = new DistributedBenchmarkFabric({
      computers: computerRegistry,
      evaluationService,
      benchmarkService,
      regressionGuard,
    });
  });

  describe('G44: Distributed Meta Benchmark (Test 57)', () => {
    it('executes baseline and candidate benchmark shards across independent fleet workers with workload equivalence and stratified metrics', async () => {
      const plan: ExperimentPlan = {
        experimentId: 'exp-g44-dist-meta',
        searchId: 'search-01',
        iteration: 1,
        hypothesisId: 'hypo-01',
        candidateCount: 1,
        benchmarkSuite: 'distributed-suite',
        worktreePrefix: 'wt-dist',
        baselineScore: 0.75,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-fast-compact',
        hypothesisId: 'hypo-01',
        config: {
          id: 'cfg-fast-compact',
          version: 2,
          contextCompactionThreshold: 0.65,
        } as OptimizableConfig,
        changes: ['Lowered compaction threshold to 0.65'],
      };

      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const onEvent = (name: string, data: Record<string, unknown>) => {
        events.push({ name, data });
      };

      // Mock dispatcher: Candidate is faster and passes all verification
      const dispatcher: ShardWorkerDispatch = {
        async executeTask({ task, worker, isCandidate }) {
          // Hardware-dependent latency: DGX is faster than Mac Studio
          const baseLatency = worker.id === 'worker-dgx' ? 100 : 250;
          // Candidate provides 2x speedup
          const duration = isCandidate ? baseLatency / 2 : baseLatency;

          return {
            execution: {
              id: `exec-${worker.id}-${task.id}-${isCandidate ? 'cand' : 'base'}`,
              taskId: task.id,
              status: 'COMPLETED',
              createdAt: new Date(),
              completedAt: new Date(Date.now() + duration),
            },
            checks: [
              {
                id: 'chk-build',
                name: 'build',
                type: 'BUILD',
                ok: true,
                passed: true,
                durationMs: duration,
              },
              {
                id: 'chk-test',
                name: 'test',
                type: 'TEST',
                ok: true,
                passed: true,
                durationMs: 10,
              },
            ],
            filesChanged: [],
            events: [],
            tokens: {
              input: isCandidate ? 1500 : 2000,
              output: isCandidate ? 400 : 500,
            },
          } as unknown as ExecutionRecord;
        },
      };

      const result = await fabric.executeExperiment({
        plan,
        candidates: [candidate],
        tasks: testTasks,
        dispatcher,
        onEvent,
      });

      // 1. Placement verification
      expect(result.isDistributed).toBe(true);
      expect(result.workerPlacements).toBeDefined();
      expect(result.workerPlacements!.length).toBe(2);

      const dgxPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-dgx');
      const macPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-mac');
      expect(dgxPlacement).toBeDefined();
      expect(macPlacement).toBeDefined();
      expect(dgxPlacement!.taskIds.length + macPlacement!.taskIds.length).toBe(testTasks.length);

      // 2. Workload equivalence: baseline and candidate evaluated on identical shards
      expect(dgxPlacement!.baselineCompletedTasks).toBe(dgxPlacement!.candidateCompletedTasks);
      expect(macPlacement!.baselineCompletedTasks).toBe(macPlacement!.candidateCompletedTasks);

      // 3. Environmental identity retention
      expect(result.environmentIdentities).toBeDefined();
      expect(result.environmentIdentities!['worker-dgx']).toBeDefined();
      expect(result.environmentIdentities!['worker-dgx'].gpu?.model).toBe('NVIDIA H100 SXM5');
      expect(result.environmentIdentities!['worker-mac'].cpu.model).toBe('Apple M2 Ultra');

      // 4. Metric Comparability: Portable metrics vs Hardware-Sensitive metrics
      expect(result.stratifiedMetrics).toBeDefined();
      const dgxStratified = result.stratifiedMetrics!['worker-dgx'];
      const macStratified = result.stratifiedMetrics!['worker-mac'];

      expect(dgxStratified).toBeDefined();
      expect(macStratified).toBeDefined();

      // Portable metrics (verification pass rates)
      expect(dgxStratified.portable.baselinePassRate).toBe(1.0);
      expect(dgxStratified.portable.candidatePassRate).toBe(1.0);

      // Hardware-sensitive metrics computed WITHIN-WORKER (stratified speedup)
      // DGX base duration ~110ms, cand duration ~60ms -> speedup ~1.8 - 2.0x
      expect(dgxStratified.hardwareSensitive.speedupFactor).toBeGreaterThan(1.5);
      expect(macStratified.hardwareSensitive.speedupFactor).toBeGreaterThan(1.5);

      // Cross-machine raw latency is NOT naively averaged without stratification
      expect(dgxStratified.hardwareSensitive.candidateDurationMs).toBeLessThan(
        macStratified.hardwareSensitive.baselineDurationMs,
      );

      // 5. Aggregate result consumed by RegressionGuard
      expect(result.comparison).toBeDefined();
      expect(result.decision).toBe('QUALIFIED');
      expect(result.regressionGuard).toBeDefined();
      expect(result.regressionGuard!.qualified).toBe(true);

      // 6. Provenance Events
      const placementEvent = events.find((e) => e.name === 'meta.distributed.placement');
      const aggEvent = events.find((e) => e.name === 'meta.distributed.aggregation_completed');
      expect(placementEvent).toBeDefined();
      expect(aggEvent).toBeDefined();
    });

    it('shards tasks deterministically based on seed and maintains workload equivalence', () => {
      const cfg = { id: 'cfg-base', version: 1 } as OptimizableConfig;
      const workers = [workerDgx, workerMac];

      const shards1 = fabric.shardTasks(testTasks, workers, 'seed-123', cfg);
      const shards2 = fabric.shardTasks(testTasks, workers, 'seed-123', cfg);

      expect(shards1.length).toBe(2);
      expect(shards1[0].tasks.map((t) => t.id)).toEqual(shards2[0].tasks.map((t) => t.id));
      expect(shards1[1].tasks.map((t) => t.id)).toEqual(shards2[1].tasks.map((t) => t.id));

      const totalTasksAssigned = shards1[0].tasks.length + shards1[1].tasks.length;
      expect(totalTasksAssigned).toBe(testTasks.length);
    });
  });

  describe('G45: Distributed Worker Failure Recovery (Test 58)', () => {
    it('isolates worker failure mid-experiment, preserves completed evidence, requeues incomplete workload, and avoids duplicate metric accounting', async () => {
      const plan: ExperimentPlan = {
        experimentId: 'exp-g45-dist-fail',
        searchId: 'search-02',
        iteration: 1,
        hypothesisId: 'hypo-02',
        candidateCount: 1,
        benchmarkSuite: 'distributed-suite',
        worktreePrefix: 'wt-dist-fail',
        baselineScore: 0.8,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-robust-exec',
        hypothesisId: 'hypo-02',
        config: {
          id: 'cfg-robust',
          version: 2,
        } as OptimizableConfig,
        changes: ['Add worker heartbeat threshold'],
      };

      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const onEvent = (name: string, data: Record<string, unknown>) => {
        events.push({ name, data });
      };

      const executedAttemptTracker = new Set<string>();

      const dispatcher: ShardWorkerDispatch = {
        async executeTask({ task, worker, isCandidate }) {
          const attemptKey = `${worker.id}::${task.id}::${isCandidate}`;
          executedAttemptTracker.add(attemptKey);

          return {
            execution: {
              id: `exec-${worker.id}-${task.id}-${isCandidate ? 'cand' : 'base'}`,
              taskId: task.id,
              status: 'COMPLETED',
              createdAt: new Date(),
              completedAt: new Date(Date.now() + 100),
            },
            checks: [
              {
                id: 'chk-build',
                name: 'build',
                type: 'BUILD',
                passed: true,
                durationMs: 80,
              },
            ],
            filesChanged: [],
            events: [],
            tokens: { input: 1000, output: 200 },
          } as unknown as ExecutionRecord;
        },
      };

      // Simulate failure of worker-mac during execution
      const result = await fabric.executeExperiment({
        plan,
        candidates: [candidate],
        tasks: testTasks,
        dispatcher,
        failWorkerSimulation: {
          workerId: 'worker-mac',
          atTaskIndex: 2,
        },
        onEvent,
      });

      // 1. Assert worker failure handled cleanly without false completion
      const failureEvent = events.find((e) => e.name === 'meta.distributed.worker_failed');
      const requeueEvent = events.find((e) => e.name === 'meta.distributed.workload_requeued');

      expect(failureEvent).toBeDefined();
      expect(failureEvent!.data.workerId).toBe('worker-mac');
      expect(requeueEvent).toBeDefined();
      expect(requeueEvent!.data.fromWorkerId).toBe('worker-mac');
      expect(requeueEvent!.data.toWorkerId).toBe('worker-dgx');

      // 2. Completed shard evidence preserved and surviving worker finished requeued tasks
      const macPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-mac');
      const dgxPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-dgx');

      expect(macPlacement).toBeDefined();
      expect(macPlacement!.status).toBe('FAILED');
      expect(dgxPlacement).toBeDefined();
      expect(dgxPlacement!.status).toBe('RECOVERED');

      // 3. No duplicate metric accounting
      expect(result.comparison).toBeDefined();
      const comparison = result.comparison;
      // All tasks were ultimately completed (either on worker-dgx or failover-recovered on worker-dgx)
      expect(comparison.candidateTasks).toBe(testTasks.length);
      expect(comparison.baselineTasks).toBe(testTasks.length);

      // Decision remains deterministic
      expect(result.decision).toBe('QUALIFIED');
    });
  });

  describe('MetaOptimizerService Distributed Integration', () => {
    it('integrates with MetaOptimizerService to run distributed experiments and explain worker placement', async () => {
      const store = new MemoryStore();
      const memoryService = new MemoryService();

      const optimizer = new MetaOptimizerService({
        benchmarkService,
        evaluationService,
        memoryService,
        store,
        distributedFabric: fabric,
        workerRegistry: computerRegistry,
      });

      const plan: ExperimentPlan = {
        experimentId: 'exp-optimizer-dist',
        searchId: 'search-03',
        iteration: 1,
        hypothesisId: 'hypo-03',
        candidateCount: 1,
        benchmarkSuite: 'distributed-suite',
        worktreePrefix: 'wt-opt-dist',
        baselineScore: 0.7,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-opt-dist',
        hypothesisId: 'hypo-03',
        filesChanged: ['packages/core/src/optimizer.ts'],
        config: {
          id: 'cfg-opt',
          version: 2,
        } as OptimizableConfig,
        changes: ['Enable speculative prompt caching'],
      };

      const runResults = await optimizer.evaluateCandidates({
        plan,
        candidates: [candidate],
        distributed: true,
      });
      const runResult = runResults[0];

      expect(runResult.isDistributed).toBe(true);
      expect(runResult.workerPlacements).toBeDefined();
      expect(runResult.workerPlacements!.length).toBeGreaterThanOrEqual(2);

      // Test explainability formatting
      const explanation = optimizer.explainExperiment(runResult.experimentId);
      expect(explanation).toContain('Distributed Worker Placement');
      expect(explanation).toContain('worker-dgx');
      expect(explanation).toContain('worker-mac');
      expect(explanation).toContain('Stratified Hardware Metrics');
    });
  });
});
