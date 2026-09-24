import { describe, it, expect, beforeEach } from 'vitest';
import {
  DistributedBenchmarkFabric,
  WeightedHashRing,
  ShardWorkerDispatch,
} from '../src/distributedBenchmarkFabric.js';
import type {
  Computer,
  BenchmarkTask,
  ExecutionRecord,
  ExperimentPlan,
  CandidateImplementation,
  OptimizableConfig,
} from '@wazir/core';

describe('Capability-Weighted Distributed Scheduling & Hash-Ring Fabric', () => {
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
    models: ['qwen-2.5-coder', 'deepseek-coder'],
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
    name: 'Standard Developer Workstation',
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
    tags: ['cpu-only', 'dev'],
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
  };

  const generateTasks = (count: number): BenchmarkTask[] => {
    return Array.from({ length: count }, (_, idx) => ({
      id: `bench-task-${idx + 1}`,
      name: `Benchmark Task ${idx + 1}`,
      category: 'FEATURE_IMPLEMENTATION',
      description: `Task number ${idx + 1}`,
      prompt: `Implement requirement ${idx + 1}`,
      expectedFiles: [`solution_${idx + 1}.ts`],
    }));
  };

  beforeEach(() => {
    fabric = new DistributedBenchmarkFabric();
  });

  describe('1. WorkerCapacityProfile', () => {
    it('builds comprehensive multi-dimensional capacity profile for DGX node', () => {
      const profile = fabric.buildCapacityProfile(workerDgx);

      expect(profile.workerId).toBe('worker-dgx');
      expect(profile.cpuCores).toBe(96);
      expect(profile.cpuArchitecture).toBe('x64');
      expect(profile.ramTotalGB).toBe(1024);
      expect(profile.gpuCount).toBe(8);
      expect(profile.gpuVramGB).toBe(80);
      expect(profile.unifiedMemory).toBe(false);
      expect(profile.runtimes).toContain('lmstudio');
      expect(profile.loadedModels).toContain('qwen-2.5-coder');
      expect(profile.basePhysicalCapacity).toBeGreaterThan(200);
      expect(profile.availableCapacity).toBeGreaterThan(100);
    });

    it('builds unified memory profile for Mac Studio', () => {
      const profile = fabric.buildCapacityProfile(workerMac);

      expect(profile.workerId).toBe('worker-mac');
      expect(profile.cpuCores).toBe(24);
      expect(profile.cpuArchitecture).toBe('arm64');
      expect(profile.ramTotalGB).toBe(192);
      expect(profile.unifiedMemory).toBe(true);
      expect(profile.basePhysicalCapacity).toBeGreaterThan(40);
    });

    it('builds lightweight profile for CPU-only PC', () => {
      const profile = fabric.buildCapacityProfile(workerPc);

      expect(profile.workerId).toBe('worker-pc');
      expect(profile.cpuCores).toBe(8);
      expect(profile.gpuCount).toBe(0);
      expect(profile.gpuVramGB).toBe(0);
      expect(profile.basePhysicalCapacity).toBeLessThan(profile.ramTotalGB);
    });
  });

  describe('2. Workload-Specific Effective Capacity Computation', () => {
    it('computes GPU-heavy capacity where DGX dominates over PC', () => {
      const dgxCap = fabric.computeEffectiveCapacity(workerDgx, { requiresGpu: true, minVramGB: 24 });
      const pcCap = fabric.computeEffectiveCapacity(workerPc, { requiresGpu: true, minVramGB: 24 });

      expect(dgxCap.effectiveCapacity).toBeGreaterThan(pcCap.effectiveCapacity * 10);
      expect(dgxCap.weight).toBeGreaterThan(pcCap.weight);
    });

    it('computes CPU-bound capacity where cores and RAM dominate', () => {
      const dgxCap = fabric.computeEffectiveCapacity(workerDgx, { requiresGpu: false });
      const macCap = fabric.computeEffectiveCapacity(workerMac, { requiresGpu: false });

      // In CPU-only tasks, ratio reflects CPU/RAM scale rather than extreme GPU disparity
      expect(dgxCap.effectiveCapacity / macCap.effectiveCapacity).toBeLessThan(6);
    });

    it('applies model locality bonus when target model is already loaded', () => {
      const coldWorker: Computer = {
        ...workerMac,
        id: 'worker-mac-cold',
        models: [], // Target model not loaded
      };

      const warmCap = fabric.computeEffectiveCapacity(workerMac, { preferredModelId: 'qwen-2.5-coder' });
      const coldCap = fabric.computeEffectiveCapacity(coldWorker, { preferredModelId: 'qwen-2.5-coder' });

      expect(warmCap.effectiveCapacity).toBeGreaterThan(coldCap.effectiveCapacity);
      expect(warmCap.effectiveCapacity / coldCap.effectiveCapacity).toBeCloseTo(1.35, 1);
    });

    it('modulates capacity under dynamic memory pressure and CPU load', () => {
      const loadedWorker: Computer = {
        ...workerPc,
        load: {
          cpuPercent: 80,
          memoryUsedGB: 28,
          memoryAvailableGB: 4,
        },
      };

      const idleCap = fabric.computeEffectiveCapacity(workerPc, undefined, undefined, true);
      const busyCap = fabric.computeEffectiveCapacity(loadedWorker, undefined, undefined, true);

      expect(busyCap.effectiveCapacity).toBeLessThan(idleCap.effectiveCapacity);
    });
  });

  describe('3. Weighted Hash Ring & Deterministic Placement', () => {
    it('is strictly deterministic given identical seed and fleet', () => {
      const tasks = generateTasks(20);
      const workers = [workerDgx, workerMac, workerPc];
      const cfg = { id: 'cfg-test', version: 1 } as OptimizableConfig;

      const shardsA = fabric.shardTasks(tasks, workers, 'seed-12345', cfg, {
        workerWeights: { 'worker-dgx': 8, 'worker-mac': 3, 'worker-pc': 1 },
      });
      const shardsB = fabric.shardTasks(tasks, workers, 'seed-12345', cfg, {
        workerWeights: { 'worker-dgx': 8, 'worker-mac': 3, 'worker-pc': 1 },
      });

      for (let i = 0; i < shardsA.length; i++) {
        expect(shardsA[i].workerId).toBe(shardsB[i].workerId);
        expect(shardsA[i].tasks.map((t) => t.id)).toEqual(shardsB[i].tasks.map((t) => t.id));
      }
    });

    it('distributes tasks proportionally to capability weights (8 : 3 : 1)', () => {
      const tasks = generateTasks(120);
      const workers = [workerDgx, workerMac, workerPc];
      const cfg = { id: 'cfg-test', version: 1 } as OptimizableConfig;

      const shards = fabric.shardTasks(tasks, workers, 'seed-proportional-test', cfg, {
        workerWeights: { 'worker-dgx': 8, 'worker-mac': 3, 'worker-pc': 1 },
      });

      const dgxTasks = shards.find((s) => s.workerId === 'worker-dgx')!.tasks.length;
      const macTasks = shards.find((s) => s.workerId === 'worker-mac')!.tasks.length;
      const pcTasks = shards.find((s) => s.workerId === 'worker-pc')!.tasks.length;

      expect(dgxTasks + macTasks + pcTasks).toBe(120);
      // DGX (8/12 = ~66%) > Mac (3/12 = ~25%) > PC (1/12 = ~8%)
      expect(dgxTasks).toBeGreaterThan(macTasks);
      expect(macTasks).toBeGreaterThan(pcTasks);
      expect(dgxTasks).toBeGreaterThan(60);
      expect(pcTasks).toBeLessThan(25);
    });

    it('directly uses WeightedHashRing bucket mapping', () => {
      const ring = new WeightedHashRing(
        [
          { id: 'dgx', weight: 8 },
          { id: 'mac', weight: 3 },
          { id: 'pc', weight: 1 },
        ],
        'seed-ring-direct',
      );

      const counts: Record<string, number> = { dgx: 0, mac: 0, pc: 0 };
      for (let i = 0; i < 60; i++) {
        const wId = ring.getWorkerForTask(`task-${i}`, 'seed-ring-direct');
        counts[wId]++;
      }

      expect(counts.dgx).toBeGreaterThan(counts.mac);
      expect(counts.mac).toBeGreaterThan(counts.pc);
    });
  });

  describe('4. Workload Equivalence Invariant', () => {
    it('ensures baseline and candidate always execute on equivalent hardware for every task', async () => {
      const tasks = generateTasks(6);
      const workers = [workerDgx, workerMac, workerPc];
      const cfg = { id: 'cfg-baseline', version: 1 } as OptimizableConfig;

      const plan: ExperimentPlan = {
        experimentId: 'exp-workload-equiv',
        searchId: 'search-equiv',
        iteration: 1,
        hypothesisId: 'hypo-equiv',
        candidateCount: 1,
        benchmarkSuite: 'weighted-suite',
        worktreePrefix: 'wt-equiv',
        baselineScore: 0.7,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-equiv',
        hypothesisId: 'hypo-equiv',
        config: { id: 'cfg-cand', version: 2 } as OptimizableConfig,
        changes: ['Equivalence check'],
      };

      const baselineWorkersByTask = new Map<string, string>();
      const candidateWorkersByTask = new Map<string, string>();

      const dispatcher: ShardWorkerDispatch = {
        async executeTask({ task, worker, isCandidate }) {
          if (isCandidate) {
            candidateWorkersByTask.set(task.id, worker.id);
          } else {
            baselineWorkersByTask.set(task.id, worker.id);
          }
          return {
            execution: {
              id: `exec-${task.id}-${worker.id}`,
              taskId: task.id,
              status: 'completed',
              createdAt: new Date(),
              completedAt: new Date(),
            },
            task: { id: task.id },
            checks: [{ name: 'check', ok: true, durationMs: 40 }],
            filesChanged: [],
            tokens: { input: 100, output: 50 },
          } as unknown as ExecutionRecord;
        },
      };

      const result = await fabric.executeExperiment({
        plan,
        candidates: [candidate],
        tasks,
        workers,
        dispatcher,
        workerWeights: { 'worker-dgx': 8, 'worker-mac': 3, 'worker-pc': 1 },
      });

      expect(result.isDistributed).toBe(true);
      for (const task of tasks) {
        const bWorker = baselineWorkersByTask.get(task.id);
        const cWorker = candidateWorkersByTask.get(task.id);
        expect(bWorker).toBeDefined();
        expect(cWorker).toBeDefined();
        // INVARIANT: Both executed on the EXACT same worker!
        expect(bWorker).toBe(cWorker);
      }
    });
  });

  describe('5. Dynamic Rebalancing & Straggler Detection', () => {
    it('rebalances unstarted tasks cleanly without double-counting completed work', () => {
      const allTasks = generateTasks(10);
      const completedTaskIds = new Set(['bench-task-1', 'bench-task-2', 'bench-task-3']);
      const activeWorkers = [workerDgx, workerMac];
      const cfg = { id: 'cfg-rebalance', version: 1 } as OptimizableConfig;

      const rebalancedShards = fabric.rebalanceUnstartedTasks({
        completedTaskIds,
        allTasks,
        activeWorkers,
        seed: 'seed-rebalance',
        config: cfg,
      });

      const rebalancedTaskIds = rebalancedShards.flatMap((s) => s.tasks.map((t) => t.id));
      expect(rebalancedTaskIds.length).toBe(7);
      for (const id of completedTaskIds) {
        expect(rebalancedTaskIds).not.toContain(id);
      }
    });

    it('detects straggler nodes exceeding the latency threshold factor', async () => {
      const tasks = generateTasks(6);
      const workers = [workerDgx, workerMac];
      const plan: ExperimentPlan = {
        experimentId: 'exp-straggler-test',
        searchId: 'search-straggler',
        iteration: 1,
        hypothesisId: 'hypo-straggler',
        candidateCount: 1,
        benchmarkSuite: 'straggler-suite',
        worktreePrefix: 'wt-straggler',
        baselineScore: 0.8,
        status: 'DISPATCHED',
      };

      const candidate: CandidateImplementation = {
        candidateId: 'cand-straggler',
        hypothesisId: 'hypo-straggler',
        config: { id: 'cfg-cand', version: 2 } as OptimizableConfig,
        changes: ['Straggler check'],
      };

      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const onEvent = (name: string, data: Record<string, unknown>) => {
        events.push({ name, data });
      };

      // Mock dispatcher where worker-mac is an extreme straggler (10x slower)
      const dispatcher: ShardWorkerDispatch = {
        async executeTask({ task, worker }) {
          const duration = worker.id === 'worker-mac' ? 800 : 50;
          return {
            execution: {
              id: `exec-${task.id}-${worker.id}`,
              taskId: task.id,
              status: 'completed',
              createdAt: new Date(),
              completedAt: new Date(Date.now() + duration),
            },
            checks: [{ name: 'check', ok: true, durationMs: duration }],
            filesChanged: [],
            tokens: { input: 100, output: 50 },
          } as unknown as ExecutionRecord;
        },
      };

      const result = await fabric.executeExperiment({
        plan,
        candidates: [candidate],
        tasks,
        workers,
        dispatcher,
        stragglerThresholdFactor: 2.0,
        onEvent,
      });

      const stragglerEvent = events.find((e) => e.name === 'meta.distributed.straggler_detected');
      expect(stragglerEvent).toBeDefined();
      expect(stragglerEvent!.data.workerId).toBe('worker-mac');

      const macPlacement = result.workerPlacements!.find((p) => p.workerId === 'worker-mac');
      expect(macPlacement).toBeDefined();
      expect(macPlacement!.status).toBe('STRAGGLER');
    });
  });
});
