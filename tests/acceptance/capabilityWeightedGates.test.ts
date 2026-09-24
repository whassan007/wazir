import { describe, it, expect, beforeEach } from 'vitest';
import {
  DistributedBenchmarkFabric,
  ShardWorkerDispatch,
  EvaluationService,
  BenchmarkService,
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

/**
 * Gate G61 & G62 Acceptance Tests:
 * - G61 (Test 66): CAPABILITY_WEIGHTED_FLEET
 * - G62 (Test 67): DYNAMIC_REBALANCE
 */
describe('G61 / G62 Acceptance: Capability-Weighted Fleet & Dynamic Rebalance', () => {
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
    models: ['qwen-2.5-coder'],
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
    models: ['qwen-2.5-coder'],
    tags: ['mac', 'arm64', 'metal'],
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
  };

  const workerPc: Computer = {
    id: 'worker-pc',
    name: 'Standard Developer PC',
    endpoint: 'http://pc-01.internal:8080',
    status: 'online',
    hardware: {
      cpu: 'Intel Core i7-13700K',
      cpuCores: 8,
      memoryGB: 32,
    },
    os: {
      platform: 'linux',
      version: 'Ubuntu 22.04',
      architecture: 'x64',
    },
    runtimes: ['in-process'],
    models: [],
    tags: ['pc', 'dev', 'cpu'],
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
  };

  const fleetTasks: BenchmarkTask[] = Array.from({ length: 12 }, (_, i) => ({
    id: `task-fleet-${i + 1}`,
    name: `Fleet Benchmark Task ${i + 1}`,
    category: 'ALGORITHMIC_OPTIMIZATION',
    description: `Task ${i + 1} for capability-weighted evaluation`,
    prompt: `Optimize computational routine ${i + 1}`,
    expectedFiles: [`routine_${i + 1}.ts`],
  }));

  beforeEach(() => {
    computerRegistry = new ComputerRegistry();
    computerRegistry.register(workerDgx);
    computerRegistry.register(workerMac);
    computerRegistry.register(workerPc);

    evaluationService = new EvaluationService();
    benchmarkService = new BenchmarkService(evaluationService);
    fleetTasks.forEach((t) => benchmarkService.register(t));
    regressionGuard = new RegressionGuard();

    fabric = new DistributedBenchmarkFabric({
      computers: computerRegistry,
      evaluationService,
      benchmarkService,
      regressionGuard,
    });
  });

  describe('G61: Capability-Weighted Fleet Placement (Test 66)', () => {
    it('schedules tasks across DGX(8):Mac(3):PC(1) fleet proportionally, preserves workload equivalence, and attaches capacity profiles', async () => {
      const plan: ExperimentPlan = {
        experimentId: 'exp-g61-weighted-fleet',
        searchId: 'search-g61',
        iteration: 1,
        hypothesisId: 'hypo-g61',
        candidateCount: 1,
        benchmarkSuite: 'weighted-fleet-suite',
        worktreePrefix: 'wt-g61',
        baselineScore: 0.75,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-g61-speedup',
        hypothesisId: 'hypo-g61',
        config: {
          id: 'cfg-g61',
          version: 2,
        } as OptimizableConfig,
        changes: ['Vectorize numerical computation'],
      };

      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const onEvent = (name: string, data: Record<string, unknown>) => {
        events.push({ name, data });
      };

      // Mock dispatcher tracking baseline/candidate pairing
      const taskExecutions = new Map<string, { baselineWorker?: string; candidateWorker?: string }>();

      const dispatcher: ShardWorkerDispatch = {
        async executeTask({ task, worker, isCandidate }) {
          const entry = taskExecutions.get(task.id) ?? {};
          if (isCandidate) {
            entry.candidateWorker = worker.id;
          } else {
            entry.baselineWorker = worker.id;
          }
          taskExecutions.set(task.id, entry);

          const baseDuration = worker.id === 'worker-dgx' ? 40 : worker.id === 'worker-mac' ? 80 : 150;
          const duration = isCandidate ? Math.round(baseDuration * 0.7) : baseDuration;

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
            ],
            filesChanged: [],
            events: [],
            tokens: {
              input: isCandidate ? 1200 : 1500,
              output: isCandidate ? 300 : 400,
            },
          } as unknown as ExecutionRecord;
        },
      };

      const result = await fabric.executeExperiment({
        plan,
        candidates: [candidate],
        tasks: fleetTasks,
        workers: [workerDgx, workerMac, workerPc],
        dispatcher,
        workerWeights: {
          'worker-dgx': 8,
          'worker-mac': 3,
          'worker-pc': 1,
        },
        onEvent,
      });

      // 1. Placement verification across all 3 heterogeneous workers
      expect(result.isDistributed).toBe(true);
      expect(result.workerPlacements).toBeDefined();
      expect(result.workerPlacements!.length).toBe(3);

      const dgxPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-dgx')!;
      const macPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-mac')!;
      const pcPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-pc')!;

      expect(dgxPlacement).toBeDefined();
      expect(macPlacement).toBeDefined();
      expect(pcPlacement).toBeDefined();

      // Proportionality check: DGX (weight 8) > Mac (weight 3) > PC (weight 1)
      expect(dgxPlacement.taskCount).toBeGreaterThan(macPlacement.taskCount);
      expect(macPlacement.taskCount).toBeGreaterThan(pcPlacement.taskCount);
      expect(dgxPlacement.taskCount + macPlacement.taskCount + pcPlacement.taskCount).toBe(fleetTasks.length);

      // 2. WORKLOAD EQUIVALENCE INVARIANT:
      // For every single task, baseline and candidate executed on identical worker
      for (const task of fleetTasks) {
        const execs = taskExecutions.get(task.id)!;
        expect(execs.baselineWorker).toBeDefined();
        expect(execs.candidateWorker).toBeDefined();
        expect(execs.baselineWorker).toBe(execs.candidateWorker);
      }

      // 3. WorkerPlacementReport metadata verification
      expect(dgxPlacement.capacityWeight).toBe(8);
      expect(macPlacement.capacityWeight).toBe(3);
      expect(pcPlacement.capacityWeight).toBe(1);
      expect(dgxPlacement.capacityProfile).toBeDefined();
      expect(dgxPlacement.capacityProfile!.gpuCount).toBe(8);
      expect(macPlacement.capacityProfile!.unifiedMemory).toBe(true);

      // Decision qualifies under improved candidate
      expect(result.decision).toBe('QUALIFIED');
    });
  });

  describe('G62: Dynamic Rebalance & Straggler Detection (Test 67)', () => {
    it('safely rebalances unstarted workload upon mid-run worker overload, avoids double accounting, and isolates stragglers', async () => {
      const plan: ExperimentPlan = {
        experimentId: 'exp-g62-dynamic-rebalance',
        searchId: 'search-g62',
        iteration: 1,
        hypothesisId: 'hypo-g62',
        candidateCount: 1,
        benchmarkSuite: 'rebalance-suite',
        worktreePrefix: 'wt-g62',
        baselineScore: 0.8,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-g62-resilience',
        hypothesisId: 'hypo-g62',
        config: {
          id: 'cfg-g62',
          version: 2,
        } as OptimizableConfig,
        changes: ['Adaptive concurrency backoff'],
      };

      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const onEvent = (name: string, data: Record<string, unknown>) => {
        events.push({ name, data });
      };

      const executedTaskAttempts = new Map<string, number>();

      const dispatcher: ShardWorkerDispatch = {
        async executeTask({ task, worker, isCandidate }) {
          const attemptKey = `${worker.id}::${task.id}::${isCandidate}`;
          executedTaskAttempts.set(attemptKey, (executedTaskAttempts.get(attemptKey) ?? 0) + 1);

          return {
            execution: {
              id: `exec-${worker.id}-${task.id}-${isCandidate ? 'cand' : 'base'}`,
              taskId: task.id,
              status: 'COMPLETED',
              createdAt: new Date(),
              completedAt: new Date(Date.now() + 60),
            },
            checks: [
              {
                id: 'chk-build',
                name: 'build',
                type: 'BUILD',
                ok: true,
                passed: true,
                durationMs: 60,
              },
            ],
            filesChanged: [],
            events: [],
            tokens: { input: 1000, output: 250 },
          } as unknown as ExecutionRecord;
        },
      };

      // Mid-run overload simulation on worker-pc at task index 1
      const result = await fabric.executeExperiment({
        plan,
        candidates: [candidate],
        tasks: fleetTasks,
        workers: [workerDgx, workerMac, workerPc],
        dispatcher,
        workerWeights: {
          'worker-dgx': 8,
          'worker-mac': 3,
          'worker-pc': 1,
        },
        rebalanceSimulation: {
          workerId: 'worker-mac',
          atTaskIndex: 1,
          trigger: 'overload',
        },
        onEvent,
      });

      // 1. Verify rebalance event was emitted
      const rebalanceEvent = events.find((e) => e.name === 'meta.distributed.rebalance');
      expect(rebalanceEvent).toBeDefined();
      expect(rebalanceEvent!.data.trigger).toBe('overload');
      expect(rebalanceEvent!.data.workerId).toBe('worker-mac');

      // 2. Overloaded worker was marked as STRAGGLER, surviving nodes recovered
      const macPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-mac')!;
      expect(macPlacement).toBeDefined();
      expect(macPlacement.status).toBe('STRAGGLER');

      // 3. ZERO DOUBLE ACCOUNTING: Every task in fleetTasks is completed exactly once for baseline and candidate
      expect(result.comparison.baselineTasks).toBe(fleetTasks.length);
      expect(result.comparison.candidateTasks).toBe(fleetTasks.length);

      // Decision remains deterministic
      expect(result.decision).toBe('QUALIFIED');
    });
  });
});
