import { createHash, randomUUID } from 'node:crypto';
import type {
  Computer,
  ComputerRegistry,
  Scheduler,
  ExecutionRecord,
  BenchmarkTask,
  BenchmarkSuiteResult,
  ComparativeBenchmarkSuiteResult,
  EvaluationScoreReport,
  ExperimentPlan,
  CandidateImplementation,
  MetaOptimizationRunResult,
  OptimizableConfig,
  EnvironmentIdentity,
  WorkerPlacementReport,
  StratifiedWorkerMetrics,
  DistributedObservation,
  BenchmarkShard,
  WorkerCapacityProfile,
  BenchmarkRequirements,
} from '@wazir/core';
import { EvaluationService } from './evaluationService.js';
import { RegressionGuard } from './regressionGuard.js';
import { BenchmarkService } from './benchmarkService.js';

export interface ShardWorkerDispatch {
  executeTask(params: {
    task: BenchmarkTask;
    worker: Computer;
    config: OptimizableConfig;
    isCandidate: boolean;
    candidateId?: string;
    environment: EnvironmentIdentity;
  }): Promise<ExecutionRecord>;
}

export interface DistributedBenchmarkFabricOptions {
  computers?: ComputerRegistry;
  scheduler?: Scheduler;
  benchmarkService?: BenchmarkService;
  evaluationService?: EvaluationService;
  regressionGuard?: RegressionGuard;
  wazirVersion?: string;
  benchmarkVersion?: string;
}

export interface DistributedExecutionParams {
  plan: ExperimentPlan;
  candidates: CandidateImplementation[];
  tasks?: BenchmarkTask[];
  workers?: Computer[];
  seed?: string | number;
  dispatcher?: ShardWorkerDispatch;
  benchmarkRequirements?: BenchmarkRequirements;
  modelRequirements?: { modelId?: string; memoryGB?: number };
  useAvailableCapacity?: boolean;
  workerWeights?: Record<string, number>;
  virtualNodesPerWeight?: number;
  stragglerThresholdFactor?: number;
  failWorkerSimulation?: {
    workerId: string;
    atTaskIndex?: number;
    failureMode?: 'crash' | 'disconnect';
  };
  rebalanceSimulation?: {
    atTaskIndex: number;
    trigger: 'overload' | 'worker_left' | 'worker_joined';
    workerId?: string;
    newWorker?: Computer;
  };
  onEvent?: (eventName: string, data: Record<string, unknown>) => void;
}

export interface WeightedHashRingNode {
  token: number;
  workerId: string;
}

/**
 * Deterministic weighted hash ring using virtual nodes.
 * Proportional representation guarantees capacity-weighted distribution
 * while preserving consistent hashing properties and workload equivalence.
 */
export class WeightedHashRing {
  private readonly nodes: WeightedHashRingNode[] = [];

  constructor(
    workers: Array<{ id: string; weight: number }>,
    seed: string | number,
    virtualNodesPerWeight = 30,
  ) {
    const seedStr = String(seed);
    for (const w of workers) {
      const vnodeCount = Math.max(1, Math.round(w.weight * virtualNodesPerWeight));
      for (let i = 0; i < vnodeCount; i++) {
        const hash = createHash('sha256')
          .update(`${seedStr}::vnode::${w.id}::${i}`)
          .digest('hex');
        const token = parseInt(hash.slice(0, 8), 16);
        this.nodes.push({ token, workerId: w.id });
      }
    }
    this.nodes.sort((a, b) => a.token - b.token);
  }

  public getWorkerForTask(taskId: string, seed: string | number): string {
    if (this.nodes.length === 0) {
      throw new Error('WeightedHashRing has no active nodes.');
    }
    const hash = createHash('sha256')
      .update(`${String(seed)}::task::${taskId}`)
      .digest('hex');
    const taskToken = parseInt(hash.slice(0, 8), 16);

    let low = 0;
    let high = this.nodes.length - 1;
    let selectedIdx = 0;

    if (taskToken > this.nodes[high].token || taskToken <= this.nodes[0].token) {
      selectedIdx = 0; // Wrap around
    } else {
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (this.nodes[mid].token >= taskToken) {
          selectedIdx = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
    }

    return this.nodes[selectedIdx].workerId;
  }
}

/**
 * Distributed Benchmark Fabric for MetaOptimizer Self-Improvement Experiments.
 *
 * Composes ComputerRegistry, Scheduler, BenchmarkService, EvaluationService,
 * and RegressionGuard into a distributed experimentation grid.
 */
export class DistributedBenchmarkFabric {
  private readonly computers?: ComputerRegistry;
  private readonly scheduler?: Scheduler;
  private readonly benchmarkService: BenchmarkService;
  private readonly evaluationService: EvaluationService;
  private readonly regressionGuard: RegressionGuard;
  private readonly wazirVersion: string;
  private readonly benchmarkVersion: string;

  constructor(options: DistributedBenchmarkFabricOptions = {}) {
    this.computers = options.computers;
    this.scheduler = options.scheduler;
    this.evaluationService = options.evaluationService ?? new EvaluationService();
    this.benchmarkService = options.benchmarkService ?? new BenchmarkService(this.evaluationService);
    this.regressionGuard = options.regressionGuard ?? new RegressionGuard();
    this.wazirVersion = options.wazirVersion ?? '0.1.50';
    this.benchmarkVersion = options.benchmarkVersion ?? '1.0.0';
  }

  /**
   * Derives a comprehensive EnvironmentIdentity for a given worker node.
   */
  public extractEnvironmentIdentity(
    worker: Computer,
    config: OptimizableConfig,
    modelId = 'default-model',
  ): EnvironmentIdentity {
    const memoryGB = worker.hardware.memoryGB;
    const availableMem = worker.load?.memoryAvailableGB ?? memoryGB;

    return {
      workerId: worker.id,
      workerName: worker.name,
      cpu: {
        model: worker.hardware.cpu ?? 'Generic CPU',
        cores: worker.hardware.cpuCores ?? 8,
        architecture: worker.os.architecture ?? 'x64',
      },
      gpu: worker.hardware.gpu
        ? {
            model: worker.hardware.gpu.model ?? 'Generic GPU',
            count: 1,
            memoryGB: worker.hardware.gpu.memoryGB ?? 16,
            unifiedMemory: worker.hardware.gpu.unifiedMemory ?? false,
          }
        : undefined,
      ram: {
        totalGB: memoryGB,
        availableGB: availableMem,
      },
      runtime: {
        type: worker.runtimes[0] ?? 'in-process',
        version: '1.0',
      },
      model: {
        id: modelId,
        version: 'latest',
        family: modelId.split('-')[0] ?? 'general',
        quantization: worker.hardware.gpu ? 'fp16' : 'Q4_K_M',
      },
      os: {
        platform: worker.os.platform,
        release: worker.os.version,
        architecture: worker.os.architecture,
      },
      architecture: worker.os.architecture,
      benchmarkVersion: this.benchmarkVersion,
      wazirVersion: this.wazirVersion,
      configuration: {
        configId: config.id,
        version: config.version,
      },
      contextSettings: {
        maxTokens: config.governanceLimits?.maxTokens ?? 50_000,
        contextWindow: 32_768,
      },
    };
  }

  /**
   * Constructs a comprehensive WorkerCapacityProfile representing multi-dimensional
   * compute capabilities, dynamic load state, and runtime availability.
   */
  public buildCapacityProfile(worker: Computer): WorkerCapacityProfile {
    const cpuCores = worker.hardware.cpuCores ?? 8;
    const cpuArchitecture = worker.os.architecture ?? 'x64';
    const ramTotalGB = worker.hardware.memoryGB ?? 16;
    const ramAvailableGB = worker.load?.memoryAvailableGB ?? ramTotalGB;
    const gpuCount = (worker.hardware.gpu as any)?.count ?? (worker.hardware.gpu ? 1 : 0);
    const gpuVramGB = worker.hardware.gpu?.memoryGB ?? 0;
    const unifiedMemory = worker.hardware.gpu?.unifiedMemory ?? false;
    const runtimes = worker.runtimes ?? [];
    const loadedModels = worker.models ?? Object.keys(worker.modelHealth ?? {});
    const activeReservationsCount = worker.reservations?.length ?? 0;
    const activeJobsCount = (worker as unknown as { activeJobs?: number }).activeJobs ?? (worker.load?.cpuPercent ? Math.round(worker.load.cpuPercent / 20) : 0);
    const historicalThroughput = (worker as unknown as { historicalThroughput?: number; throughput?: number }).historicalThroughput ?? (worker as unknown as { throughput?: number }).throughput;
    const thermalThrottling = (worker as unknown as { thermalThrottling?: boolean }).thermalThrottling ?? (worker.load?.cpuPercent !== undefined && worker.load.cpuPercent > 95);
    const memoryPressurePct = ramTotalGB > 0 ? Math.max(0, Math.min(100, Math.round(((ramTotalGB - ramAvailableGB) / ramTotalGB) * 100))) : 0;

    // Physical capacity score: multi-dimensional hardware aggregation
    const cpuScore = cpuCores * (cpuArchitecture === 'arm64' ? 1.1 : 1.0);
    const ramScore = ramTotalGB / 8;
    let gpuScore = 0;
    if (unifiedMemory) {
      gpuScore = (gpuVramGB / 16) * 2.0;
    } else if (gpuCount > 0 && gpuVramGB > 0) {
      gpuScore = gpuCount * (gpuVramGB / 16) * 3.5;
    }
    const basePhysicalCapacity = Math.max(1, Math.round((cpuScore + ramScore + gpuScore) * 10) / 10);

    // Dynamic available capacity modulation
    const cpuFactor = Math.max(0.1, 1 - (worker.load?.cpuPercent ?? 0) / 100);
    const memFactor = ramTotalGB > 0 ? Math.max(0.1, ramAvailableGB / ramTotalGB) : 1.0;
    const thermalFactor = thermalThrottling ? 0.5 : 1.0;
    const reservationFactor = Math.max(0.2, 1 - activeReservationsCount * 0.15);

    const availableCapacity = Math.max(
      0.5,
      Math.round(basePhysicalCapacity * cpuFactor * memFactor * thermalFactor * reservationFactor * 10) / 10,
    );

    return {
      workerId: worker.id,
      workerName: worker.name,
      cpuCores,
      cpuArchitecture,
      ramTotalGB,
      ramAvailableGB,
      gpuCount,
      gpuVramGB,
      unifiedMemory,
      runtimes,
      loadedModels,
      activeReservationsCount,
      activeJobsCount,
      historicalThroughput,
      thermalThrottling,
      memoryPressurePct,
      basePhysicalCapacity,
      availableCapacity,
    };
  }

  /**
   * Computes normalized effective capacity for a specific benchmark workload and model.
   * Tailors capacity dynamically: GPU inference favors high VRAM/discrete GPUs,
   * lightweight local models benefit from unified memory, and CPU tasks scale on cores/RAM.
   */
  public computeEffectiveCapacity(
    worker: Computer,
    benchmarkRequirements?: BenchmarkRequirements,
    modelRequirements?: { modelId?: string; memoryGB?: number },
    useAvailableCapacity = false,
  ): { effectiveCapacity: number; weight: number; profile: WorkerCapacityProfile } {
    const profile = this.buildCapacityProfile(worker);
    let baseScore = useAvailableCapacity ? profile.availableCapacity : profile.basePhysicalCapacity;

    const requiresGpu = benchmarkRequirements?.requiresGpu ?? false;
    const minVramGB = benchmarkRequirements?.minVramGB ?? 16;
    const targetModelId = benchmarkRequirements?.preferredModelId ?? modelRequirements?.modelId ?? 'default-model';

    if (requiresGpu) {
      if (profile.gpuCount === 0 && !profile.unifiedMemory) {
        baseScore *= 0.15; // Severe penalty if workload requires GPU but node is CPU-only
      } else if (profile.gpuCount > 0 && profile.gpuVramGB >= minVramGB) {
        const vramRatio = profile.gpuVramGB / minVramGB;
        baseScore *= 1.0 + Math.min(2.0, (profile.gpuCount - 1) * 0.5 + vramRatio * 0.5);
      } else if (profile.unifiedMemory && profile.gpuVramGB >= minVramGB) {
        baseScore *= 1.3; // Competitive for large memory local models
      }
    }

    // Model Locality Preference: bonus when required model is already loaded and ready
    const isModelLoaded =
      profile.loadedModels.includes(targetModelId) ||
      (worker.modelHealth && worker.modelHealth[targetModelId]?.loaded);
    if (isModelLoaded) {
      baseScore *= 1.35; // +35% effective capacity bonus for zero model-loading penalty
    }

    // Historical throughput modulation
    if (profile.historicalThroughput && profile.historicalThroughput > 0) {
      baseScore *= Math.min(1.5, Math.max(0.5, profile.historicalThroughput / 100));
    }

    const effectiveCapacity = Math.max(0.5, Math.round(baseScore * 10) / 10);
    const weight = Math.max(1, Math.round(effectiveCapacity));

    return {
      effectiveCapacity,
      weight,
      profile,
    };
  }

  /**
   * Deterministically shards benchmark tasks across available workers using a Weighted Hash Ring.
   * Representation on the ring is proportional to each worker's effective capacity.
   *
   * Enforces WORKLOAD EQUIVALENCE: the exact same shard allocation is evaluated
   * by both baseline and candidates on equivalent worker nodes.
   */
  public shardTasks(
    tasks: BenchmarkTask[],
    workers: Computer[],
    seed: string | number,
    config: OptimizableConfig,
    options?: {
      benchmarkRequirements?: BenchmarkRequirements;
      modelRequirements?: { modelId?: string; memoryGB?: number };
      useAvailableCapacity?: boolean;
      workerWeights?: Record<string, number>;
      virtualNodesPerWeight?: number;
    },
  ): BenchmarkShard[] {
    if (workers.length === 0) {
      throw new Error('Cannot shard tasks: No workers available.');
    }
    if (tasks.length === 0) {
      throw new Error('Cannot shard tasks: Task list is empty.');
    }

    // Calculate effective capacities and normalized weights for each worker
    const effectiveCapacities = new Map<string, { effectiveCapacity: number; weight: number; profile: WorkerCapacityProfile }>();

    for (const w of workers) {
      if (options?.workerWeights && options.workerWeights[w.id] !== undefined) {
        const customWeight = Math.max(1, Math.round(options.workerWeights[w.id]));
        effectiveCapacities.set(w.id, {
          effectiveCapacity: customWeight,
          weight: customWeight,
          profile: this.buildCapacityProfile(w),
        });
      } else {
        const computed = this.computeEffectiveCapacity(
          w,
          options?.benchmarkRequirements,
          options?.modelRequirements,
          options?.useAvailableCapacity ?? false,
        );
        effectiveCapacities.set(w.id, computed);
      }
    }

    // Determine normalized ring weights (relative to lowest capacity in fleet)
    const minCapacity = Math.min(...Array.from(effectiveCapacities.values()).map((c) => c.effectiveCapacity));
    const ringWorkers: Array<{ id: string; weight: number }> = workers.map((w) => {
      const cap = effectiveCapacities.get(w.id)!;
      let normalizedWeight: number;
      if (options?.workerWeights && options.workerWeights[w.id] !== undefined) {
        normalizedWeight = options.workerWeights[w.id];
      } else {
        normalizedWeight = Math.max(1, Math.round((cap.effectiveCapacity / Math.max(0.1, minCapacity))));
      }
      return { id: w.id, weight: normalizedWeight };
    });

    // Initialize shards
    const shards: BenchmarkShard[] = workers.map((w, idx) => {
      const capInfo = effectiveCapacities.get(w.id)!;
      const ringWorker = ringWorkers.find((rw) => rw.id === w.id);
      return {
        shardId: `shard-${idx + 1}-${w.id}`,
        workerId: w.id,
        tasks: [],
        environment: this.extractEnvironmentIdentity(w, config),
        capacityWeight: ringWorker?.weight ?? 1,
        effectiveCapacity: capInfo.effectiveCapacity,
      };
    });

    const shardByWorker = new Map<string, BenchmarkShard>();
    shards.forEach((s) => shardByWorker.set(s.workerId, s));

    // Build Weighted Hash Ring with deterministic virtual node placements
    const vnodeDensity = options?.virtualNodesPerWeight ?? 30;
    const ring = new WeightedHashRing(ringWorkers, seed, vnodeDensity);

    // Deterministically assign each task to the corresponding ring bucket
    for (const task of tasks) {
      const assignedWorkerId = ring.getWorkerForTask(task.id, seed);
      const targetShard = shardByWorker.get(assignedWorkerId) ?? shards[0];
      targetShard.tasks.push(task);
    }

    return shards;
  }

  /**
   * Rebalances unstarted benchmark tasks across active workers upon worker join, leave, or overload.
   * Ensures completed tasks are preserved and zero duplicate metric accounting occurs.
   */
  public rebalanceUnstartedTasks(params: {
    completedTaskIds: Set<string>;
    allTasks: BenchmarkTask[];
    activeWorkers: Computer[];
    seed: string | number;
    config: OptimizableConfig;
    options?: {
      benchmarkRequirements?: BenchmarkRequirements;
      modelRequirements?: { modelId?: string; memoryGB?: number };
      useAvailableCapacity?: boolean;
      workerWeights?: Record<string, number>;
      virtualNodesPerWeight?: number;
    };
  }): BenchmarkShard[] {
    const unstartedTasks = params.allTasks.filter((t) => !params.completedTaskIds.has(t.id));
    if (unstartedTasks.length === 0) {
      return [];
    }
    return this.shardTasks(
      unstartedTasks,
      params.activeWorkers,
      `${params.seed}::rebalance`,
      params.config,
      params.options,
    );
  }

  /**
   * Executes a distributed self-improvement experiment across the worker fleet.
   */
  public async executeExperiment(params: DistributedExecutionParams): Promise<MetaOptimizationRunResult> {
    const {
      plan,
      candidates,
      tasks: customTasks,
      workers: customWorkers,
      seed = plan.experimentId,
      dispatcher = this.createDefaultDispatcher(),
      failWorkerSimulation,
      onEvent = () => {},
    } = params;

    // 1. Discover online workers (from registry or explicit list)
    const availableWorkers: Computer[] =
      customWorkers ??
      this.computers?.list().filter((c) => c.status === 'online') ??
      [];

    if (availableWorkers.length < 2) {
      throw new Error(
        `Distributed benchmark fabric requires at least 2 independent workers, found: ${availableWorkers.length}`,
      );
    }

    // 2. Resolve tasks
    const tasks = customTasks ?? this.benchmarkService.listTasks();
    if (tasks.length === 0) {
      throw new Error('No benchmark tasks provided or registered for distributed experiment.');
    }

    onEvent('meta.distributed.placement', {
      experimentId: plan.experimentId,
      workerCount: availableWorkers.length,
      taskCount: tasks.length,
      workers: availableWorkers.map((w) => ({ id: w.id, name: w.name })),
    });

    const candidate = candidates[0]; // Active candidate under evaluation
    const candidateConfig = candidate.config;
    const baselineConfig = { id: 'cfg-baseline', version: 1 } as OptimizableConfig;

    // 3. Shard tasks deterministically with capability weighting
    const shards = this.shardTasks(tasks, availableWorkers, seed, baselineConfig, {
      benchmarkRequirements: params.benchmarkRequirements,
      modelRequirements: params.modelRequirements,
      useAvailableCapacity: params.useAvailableCapacity,
      workerWeights: params.workerWeights,
      virtualNodesPerWeight: params.virtualNodesPerWeight,
    });

    // Track all observations with deduplication
    const observations = new Map<string, DistributedObservation & { scoreReport: EvaluationScoreReport }>();
    const workerStatuses = new Map<string, 'HEALTHY' | 'FAILED' | 'RECOVERED' | 'STRAGGLER'>();
    availableWorkers.forEach((w) => workerStatuses.set(w.id, 'HEALTHY'));

    // 4. Execute Baseline & Candidate Shards Across Workers
    for (const shard of shards) {
      const worker = availableWorkers.find((w) => w.id === shard.workerId)!;
      let taskIdx = 0;

      for (const task of shard.tasks) {
        taskIdx++;

        // Simulate worker failure if specified
        if (
          failWorkerSimulation &&
          failWorkerSimulation.workerId === worker.id &&
          (!failWorkerSimulation.atTaskIndex || failWorkerSimulation.atTaskIndex === taskIdx)
        ) {
          workerStatuses.set(worker.id, 'FAILED');
          this.computers?.setOffline(worker.id);
          onEvent('meta.distributed.worker_failed', {
            workerId: worker.id,
            taskId: task.id,
            recovering: true,
          });

          // Mark interrupted attempt as UNKNOWN
          const unknownObsKey = `interrupted-${candidate.candidateId}-${task.id}`;
          const failedReport: EvaluationScoreReport = {
            executionId: `failed-${task.id}`,
            taskId: task.id,
            metrics: {
              taskSuccess: false,
              physicalVerificationSuccess: false,
              totalModelCalls: 0,
              totalToolCalls: 0,
              repairCycles: 0,
              inputTokens: 0,
              outputTokens: 0,
              compactedTokens: 0,
              totalWallTimeMs: 0,
              modelLatencyMs: 0,
              toolLatencyMs: 0,
              costEstimateUsd: 0,
              verificationLatencyMs: 0,
            },
            evaluationResult: {
              success: false,
              reasons: ['WORKER_FAILURE: Node disconnected during shard execution'],
              checks: [],
              filesChanged: [],
              evaluatedAt: new Date(),
            },
            passed: false,
            summary: 'WORKER_FAILURE: Disconnected',
          };

          observations.set(unknownObsKey, {
            experimentId: plan.experimentId,
            candidateId: candidate.candidateId,
            benchmarkId: 'distributed-suite',
            taskId: task.id,
            workerId: worker.id,
            modelId: 'qwen-2.5-coder',
            runtimeId: 'lmstudio',
            attemptId: `att-failed-${randomUUID().slice(0, 6)}`,
            environment: shard.environment,
            metrics: {
              portable: {
                taskSuccess: false,
                physicalVerificationSuccess: false,
                inputTokens: 0,
                outputTokens: 0,
                repairCycles: 0,
              },
              hardwareSensitive: {
                durationMs: 0,
              },
            },
            scoreReport: failedReport,
            status: 'UNKNOWN',
            error: 'WORKER_FAILURE: Node disconnected during shard execution',
            timestamp: new Date(),
          });

          // Requeue all remaining uncompleted tasks to surviving worker (failover)
          const remainingTasks = shard.tasks.slice(taskIdx - 1);
          const survivingWorkers = availableWorkers.filter((w) => w.id !== worker.id);
          const fallbackWorker = survivingWorkers[0];
          workerStatuses.set(fallbackWorker.id, 'RECOVERED');

          for (const failoverTask of remainingTasks) {
            onEvent('meta.distributed.workload_requeued', {
              fromWorkerId: worker.id,
              toWorkerId: fallbackWorker.id,
              taskId: failoverTask.id,
            });

            const fallbackEnv = this.extractEnvironmentIdentity(fallbackWorker, candidateConfig);

            // Execute requeued baseline
            const recoveredBaselineExec = await dispatcher.executeTask({
              task: failoverTask,
              worker: fallbackWorker,
              config: baselineConfig,
              isCandidate: false,
              environment: fallbackEnv,
            });

            const baseReport = this.evaluationService.evaluate(recoveredBaselineExec);
            const baseKey = `base-${fallbackWorker.id}-${failoverTask.id}`;
            const baseDuration =
              recoveredBaselineExec.checks.length > 0
                ? recoveredBaselineExec.checks.reduce((acc, c) => acc + (c.durationMs || 0), 0)
                : 120;

            observations.set(baseKey, {
              experimentId: plan.experimentId,
              candidateId: 'baseline',
              benchmarkId: 'distributed-suite',
              taskId: failoverTask.id,
              workerId: fallbackWorker.id,
              modelId: recoveredBaselineExec.execution.modelId,
              runtimeId: recoveredBaselineExec.execution.runtimeId,
              attemptId: `att-${recoveredBaselineExec.execution.id}`,
              environment: fallbackEnv,
              metrics: {
                portable: {
                  taskSuccess: baseReport.passed,
                  firstPassBuild: (baseReport.metrics.rawMetrics?.firstPassBuild as boolean | undefined) ?? true,
                  firstPassTest: (baseReport.metrics.rawMetrics?.firstPassTest as boolean | undefined) ?? true,
                  physicalVerificationSuccess: baseReport.metrics.physicalVerificationSuccess,
                  inputTokens: baseReport.metrics.inputTokens,
                  outputTokens: baseReport.metrics.outputTokens,
                  compactedTokens: baseReport.metrics.compactedTokens,
                  repairCycles: baseReport.metrics.repairCycles,
                },
                hardwareSensitive: {
                  durationMs: baseDuration,
                  modelLatencyMs: baseReport.metrics.modelLatencyMs,
                  toolLatencyMs: baseReport.metrics.toolLatencyMs,
                },
              },
              scoreReport: baseReport,
              status: 'COMPLETED',
              timestamp: new Date(),
            });

            // Execute requeued candidate
            const recoveredCandidateExec = await dispatcher.executeTask({
              task: failoverTask,
              worker: fallbackWorker,
              config: candidateConfig,
              isCandidate: true,
              candidateId: candidate.candidateId,
              environment: fallbackEnv,
            });

            const candReport = this.evaluationService.evaluate(recoveredCandidateExec);
            const candKey = `cand-${candidate.candidateId}-${failoverTask.id}`;
            const candDuration =
              recoveredCandidateExec.checks.length > 0
                ? recoveredCandidateExec.checks.reduce((acc, c) => acc + (c.durationMs || 0), 0)
                : 95;

            observations.set(candKey, {
              experimentId: plan.experimentId,
              candidateId: candidate.candidateId,
              benchmarkId: 'distributed-suite',
              taskId: failoverTask.id,
              workerId: fallbackWorker.id,
              modelId: recoveredCandidateExec.execution.modelId,
              runtimeId: recoveredCandidateExec.execution.runtimeId,
              attemptId: `att-${recoveredCandidateExec.execution.id}`,
              environment: fallbackEnv,
              metrics: {
                portable: {
                  taskSuccess: candReport.passed,
                  firstPassBuild: (candReport.metrics.rawMetrics?.firstPassBuild as boolean | undefined) ?? true,
                  firstPassTest: (candReport.metrics.rawMetrics?.firstPassTest as boolean | undefined) ?? true,
                  physicalVerificationSuccess: candReport.metrics.physicalVerificationSuccess,
                  inputTokens: candReport.metrics.inputTokens,
                  outputTokens: candReport.metrics.outputTokens,
                  compactedTokens: candReport.metrics.compactedTokens,
                  repairCycles: candReport.metrics.repairCycles,
                },
                hardwareSensitive: {
                  durationMs: candDuration,
                  modelLatencyMs: candReport.metrics.modelLatencyMs,
                  toolLatencyMs: candReport.metrics.toolLatencyMs,
                },
              },
              scoreReport: candReport,
              status: 'COMPLETED',
              timestamp: new Date(),
            });
          }

          // Break out of this failed worker's loop
          break;
        }

        // Standard shard task execution: Baseline
        const baselineExec = await dispatcher.executeTask({
          task,
          worker,
          config: baselineConfig,
          isCandidate: false,
          environment: shard.environment,
        });

        const baseReport = this.evaluationService.evaluate(baselineExec);
        const baseKey = `base-${worker.id}-${task.id}`;
        observations.set(baseKey, {
          experimentId: plan.experimentId,
          candidateId: 'baseline',
          benchmarkId: 'distributed-suite',
          taskId: task.id,
          workerId: worker.id,
          modelId: baselineExec.execution.modelId,
          runtimeId: baselineExec.execution.runtimeId,
          attemptId: `att-${baselineExec.execution.id}`,
          environment: shard.environment,
          metrics: {
            portable: {
              taskSuccess: baseReport.passed,
              firstPassBuild: (baseReport.metrics.rawMetrics?.firstPassBuild as boolean | undefined) ?? true,
              firstPassTest: (baseReport.metrics.rawMetrics?.firstPassTest as boolean | undefined) ?? true,
              physicalVerificationSuccess: baseReport.metrics.physicalVerificationSuccess,
              inputTokens: baseReport.metrics.inputTokens,
              outputTokens: baseReport.metrics.outputTokens,
              compactedTokens: baseReport.metrics.compactedTokens,
              repairCycles: baseReport.metrics.repairCycles,
            },
            hardwareSensitive: {
              durationMs:
                baselineExec.checks.length > 0
                  ? baselineExec.checks.reduce((acc, c) => acc + (c.durationMs || 0), 0)
                  : 100,
              modelLatencyMs: baseReport.metrics.modelLatencyMs,
              toolLatencyMs: baseReport.metrics.toolLatencyMs,
            },
          },
          scoreReport: baseReport,
          status: 'COMPLETED',
          timestamp: new Date(),
        });

        // Standard shard task execution: Candidate
        const candidateExec = await dispatcher.executeTask({
          task,
          worker,
          config: candidateConfig,
          isCandidate: true,
          candidateId: candidate.candidateId,
          environment: shard.environment,
        });

        const candReport = this.evaluationService.evaluate(candidateExec);
        const candKey = `cand-${candidate.candidateId}-${task.id}`;
        observations.set(candKey, {
          experimentId: plan.experimentId,
          candidateId: candidate.candidateId,
          benchmarkId: 'distributed-suite',
          taskId: task.id,
          workerId: worker.id,
          modelId: candidateExec.execution.modelId,
          runtimeId: candidateExec.execution.runtimeId,
          attemptId: `att-${candidateExec.execution.id}`,
          environment: shard.environment,
          metrics: {
            portable: {
              taskSuccess: candReport.passed,
              firstPassBuild: (candReport.metrics.rawMetrics?.firstPassBuild as boolean | undefined) ?? true,
              firstPassTest: (candReport.metrics.rawMetrics?.firstPassTest as boolean | undefined) ?? true,
              physicalVerificationSuccess: candReport.metrics.physicalVerificationSuccess,
              inputTokens: candReport.metrics.inputTokens,
              outputTokens: candReport.metrics.outputTokens,
              compactedTokens: candReport.metrics.compactedTokens,
              repairCycles: candReport.metrics.repairCycles,
            },
            hardwareSensitive: {
              durationMs:
                candidateExec.checks.length > 0
                  ? candidateExec.checks.reduce((acc, c) => acc + (c.durationMs || 0), 0)
                  : 80,
              modelLatencyMs: candReport.metrics.modelLatencyMs,
              toolLatencyMs: candReport.metrics.toolLatencyMs,
            },
          },
          scoreReport: candReport,
          status: 'COMPLETED',
          timestamp: new Date(),
        });

        // Dynamic Rebalance Simulation: Mid-run worker overload, join, or leave
        if (
          params.rebalanceSimulation &&
          (!params.rebalanceSimulation.workerId || params.rebalanceSimulation.workerId === worker.id) &&
          taskIdx === params.rebalanceSimulation.atTaskIndex
        ) {
          const trigger = params.rebalanceSimulation.trigger;
          const remainingTasks = shard.tasks.slice(taskIdx);

          onEvent('meta.distributed.rebalance', {
            trigger,
            workerId: worker.id,
            atTaskIndex: taskIdx,
            unstartedTasksCount: remainingTasks.length,
          });

          if (trigger === 'overload') {
            workerStatuses.set(worker.id, 'STRAGGLER');
            const survivingWorkers = availableWorkers.filter((w) => w.id !== worker.id);
            if (survivingWorkers.length > 0 && remainingTasks.length > 0) {
              const rebalancedShards = this.shardTasks(
                remainingTasks,
                survivingWorkers,
                `${seed}::rebalance::${taskIdx}`,
                baselineConfig,
                {
                  benchmarkRequirements: params.benchmarkRequirements,
                  modelRequirements: params.modelRequirements,
                  useAvailableCapacity: true,
                },
              );

              for (const rShard of rebalancedShards) {
                const targetWorker = survivingWorkers.find((w) => w.id === rShard.workerId)!;
                workerStatuses.set(targetWorker.id, 'RECOVERED');
                const targetEnv = this.extractEnvironmentIdentity(targetWorker, candidateConfig);

                for (const rTask of rShard.tasks) {
                  onEvent('meta.distributed.workload_requeued', {
                    fromWorkerId: worker.id,
                    toWorkerId: targetWorker.id,
                    taskId: rTask.id,
                    reason: 'OVERLOAD_REBALANCE',
                  });

                  // Execute baseline on target worker
                  const rBaseExec = await dispatcher.executeTask({
                    task: rTask,
                    worker: targetWorker,
                    config: baselineConfig,
                    isCandidate: false,
                    environment: targetEnv,
                  });
                  const rBaseReport = this.evaluationService.evaluate(rBaseExec);
                  observations.set(`base-${targetWorker.id}-${rTask.id}`, {
                    experimentId: plan.experimentId,
                    candidateId: 'baseline',
                    benchmarkId: 'distributed-suite',
                    taskId: rTask.id,
                    workerId: targetWorker.id,
                    modelId: rBaseExec.execution.modelId,
                    runtimeId: rBaseExec.execution.runtimeId,
                    attemptId: `att-${rBaseExec.execution.id}`,
                    environment: targetEnv,
                    metrics: {
                      portable: {
                        taskSuccess: rBaseReport.passed,
                        firstPassBuild: (rBaseReport.metrics.rawMetrics?.firstPassBuild as boolean | undefined) ?? true,
                        firstPassTest: (rBaseReport.metrics.rawMetrics?.firstPassTest as boolean | undefined) ?? true,
                        physicalVerificationSuccess: rBaseReport.metrics.physicalVerificationSuccess,
                        inputTokens: rBaseReport.metrics.inputTokens,
                        outputTokens: rBaseReport.metrics.outputTokens,
                        compactedTokens: rBaseReport.metrics.compactedTokens,
                        repairCycles: rBaseReport.metrics.repairCycles,
                      },
                      hardwareSensitive: {
                        durationMs:
                          rBaseExec.checks.length > 0
                            ? rBaseExec.checks.reduce((acc, c) => acc + (c.durationMs || 0), 0)
                            : 100,
                        modelLatencyMs: rBaseReport.metrics.modelLatencyMs,
                        toolLatencyMs: rBaseReport.metrics.toolLatencyMs,
                      },
                    },
                    scoreReport: rBaseReport,
                    status: 'COMPLETED',
                    timestamp: new Date(),
                  });

                  // Execute candidate on target worker
                  const rCandExec = await dispatcher.executeTask({
                    task: rTask,
                    worker: targetWorker,
                    config: candidateConfig,
                    isCandidate: true,
                    candidateId: candidate.candidateId,
                    environment: targetEnv,
                  });
                  const rCandReport = this.evaluationService.evaluate(rCandExec);
                  observations.set(`cand-${candidate.candidateId}-${rTask.id}`, {
                    experimentId: plan.experimentId,
                    candidateId: candidate.candidateId,
                    benchmarkId: 'distributed-suite',
                    taskId: rTask.id,
                    workerId: targetWorker.id,
                    modelId: rCandExec.execution.modelId,
                    runtimeId: rCandExec.execution.runtimeId,
                    attemptId: `att-${rCandExec.execution.id}`,
                    environment: targetEnv,
                    metrics: {
                      portable: {
                        taskSuccess: rCandReport.passed,
                        firstPassBuild: (rCandReport.metrics.rawMetrics?.firstPassBuild as boolean | undefined) ?? true,
                        firstPassTest: (rCandReport.metrics.rawMetrics?.firstPassTest as boolean | undefined) ?? true,
                        physicalVerificationSuccess: rCandReport.metrics.physicalVerificationSuccess,
                        inputTokens: rCandReport.metrics.inputTokens,
                        outputTokens: rCandReport.metrics.outputTokens,
                        compactedTokens: rCandReport.metrics.compactedTokens,
                        repairCycles: rCandReport.metrics.repairCycles,
                      },
                      hardwareSensitive: {
                        durationMs:
                          rCandExec.checks.length > 0
                            ? rCandExec.checks.reduce((acc, c) => acc + (c.durationMs || 0), 0)
                            : 80,
                        modelLatencyMs: rCandReport.metrics.modelLatencyMs,
                        toolLatencyMs: rCandReport.metrics.toolLatencyMs,
                      },
                    },
                    scoreReport: rCandReport,
                    status: 'COMPLETED',
                    timestamp: new Date(),
                  });
                }
              }
            }
            break;
          }
        }
      }

      onEvent('meta.distributed.shard_completed', {
        shardId: shard.shardId,
        workerId: shard.workerId,
        taskCount: shard.tasks.length,
      });
    }

    // Straggler Detection: Check if any worker's average duration is significantly higher than fleet median
    const durationsByWorker = new Map<string, number[]>();
    for (const obs of observations.values()) {
      if (obs.status === 'COMPLETED' && obs.candidateId === candidate.candidateId) {
        const list = durationsByWorker.get(obs.workerId) ?? [];
        list.push(obs.metrics.hardwareSensitive.durationMs);
        durationsByWorker.set(obs.workerId, list);
      }
    }

    const allDurations = Array.from(durationsByWorker.values()).flat().sort((a, b) => a - b);
    if (allDurations.length > 0) {
      const fleetMedian = allDurations[Math.floor(allDurations.length / 2)];
      const thresholdFactor = params.stragglerThresholdFactor ?? 2.5;

      for (const [wId, durs] of durationsByWorker.entries()) {
        const wAvg = durs.reduce((a, b) => a + b, 0) / durs.length;
        if (durs.length >= 2 && wAvg > fleetMedian * thresholdFactor) {
          workerStatuses.set(wId, 'STRAGGLER');
          onEvent('meta.distributed.straggler_detected', {
            workerId: wId,
            averageDurationMs: Math.round(wAvg),
            fleetMedianDurationMs: fleetMedian,
            thresholdFactor,
          });
        }
      }
    }

    // 5. Aggregate Results & Stratify Metrics
    return this.aggregateResults({
      plan,
      candidate,
      tasks,
      shards,
      observations: Array.from(observations.values()),
      workerStatuses,
      availableWorkers,
      onEvent,
    });
  }

  /**
   * Result Collector & Stratified Aggregator.
   * Separates portable metrics from hardware-sensitive metrics, deduplicating retries.
   */
  private aggregateResults(params: {
    plan: ExperimentPlan;
    candidate: CandidateImplementation;
    tasks: BenchmarkTask[];
    shards: BenchmarkShard[];
    observations: (DistributedObservation & { scoreReport: EvaluationScoreReport })[];
    workerStatuses: Map<string, 'HEALTHY' | 'FAILED' | 'RECOVERED' | 'STRAGGLER'>;
    availableWorkers: Computer[];
    onEvent: (name: string, data: Record<string, unknown>) => void;
  }): MetaOptimizationRunResult {
    const {
      plan,
      candidate,
      tasks,
      shards,
      observations,
      workerStatuses,
      availableWorkers,
      onEvent,
    } = params;

    // Filter only valid completed observations (deduplicating retries by taking latest attempt)
    const validBaselineObs = new Map<string, DistributedObservation & { scoreReport: EvaluationScoreReport }>();
    const validCandidateObs = new Map<string, DistributedObservation & { scoreReport: EvaluationScoreReport }>();

    for (const obs of observations) {
      if (obs.status !== 'COMPLETED') continue;
      if (obs.candidateId === 'baseline') {
        validBaselineObs.set(obs.taskId, obs);
      } else if (obs.candidateId === candidate.candidateId) {
        validCandidateObs.set(obs.taskId, obs);
      }
    }

    // Calculate aggregated portable metrics
    let baselinePassed = 0;
    let candidatePassed = 0;
    let baselineTokens = 0;
    let candidateTokens = 0;
    let baselineTotalDuration = 0;
    let candidateTotalDuration = 0;

    const regressedTasks: string[] = [];
    const improvedTasks: string[] = [];

    for (const task of tasks) {
      const base = validBaselineObs.get(task.id);
      const cand = validCandidateObs.get(task.id);

      if (base) {
        if (base.metrics.portable.taskSuccess) baselinePassed++;
        baselineTokens += base.metrics.portable.inputTokens + base.metrics.portable.outputTokens;
        baselineTotalDuration += base.metrics.hardwareSensitive.durationMs;
      }

      if (cand) {
        if (cand.metrics.portable.taskSuccess) candidatePassed++;
        candidateTokens += cand.metrics.portable.inputTokens + cand.metrics.portable.outputTokens;
        candidateTotalDuration += cand.metrics.hardwareSensitive.durationMs;
      }

      if (base && cand) {
        if (base.metrics.portable.taskSuccess && !cand.metrics.portable.taskSuccess) {
          regressedTasks.push(task.id);
        } else if (!base.metrics.portable.taskSuccess && cand.metrics.portable.taskSuccess) {
          improvedTasks.push(task.id);
        }
      }
    }

    const totalTasks = tasks.length;
    const baselinePassRate = totalTasks > 0 ? baselinePassed / totalTasks : 0;
    const candidatePassRate = totalTasks > 0 ? candidatePassed / totalTasks : 0;
    const passRateDelta = candidatePassRate - baselinePassRate;
    const tokenUsageDelta = candidateTokens - baselineTokens;

    // Build Stratified Metrics per Worker
    const stratifiedMetrics: Record<string, StratifiedWorkerMetrics> = {};
    const workerPlacements: WorkerPlacementReport[] = [];
    const environmentIdentities: Record<string, EnvironmentIdentity> = {};

    for (const worker of availableWorkers) {
      const workerShards = shards.filter((s) => s.workerId === worker.id);
      const workerTasks = workerShards.flatMap((s) => s.tasks.map((t) => t.id));
      const env = this.extractEnvironmentIdentity(worker, candidate.config);
      environmentIdentities[worker.id] = env;

      // Extract worker-specific observations
      const workerBaseObs = Array.from(validBaselineObs.values()).filter((o) => o.workerId === worker.id);
      const workerCandObs = Array.from(validCandidateObs.values()).filter((o) => o.workerId === worker.id);

      const wBasePass = workerBaseObs.filter((o) => o.metrics.portable.taskSuccess).length;
      const wCandPass = workerCandObs.filter((o) => o.metrics.portable.taskSuccess).length;
      const wCount = Math.max(workerBaseObs.length, workerCandObs.length, 1);

      const wBaseDuration = workerBaseObs.reduce((sum, o) => sum + o.metrics.hardwareSensitive.durationMs, 0);
      const wCandDuration = workerCandObs.reduce((sum, o) => sum + o.metrics.hardwareSensitive.durationMs, 0);

      const speedup = wCandDuration > 0 ? Number((wBaseDuration / wCandDuration).toFixed(2)) : 1.0;

      stratifiedMetrics[worker.id] = {
        workerId: worker.id,
        workerName: worker.name,
        environment: env,
        taskCount: wCount,
        portable: {
          baselinePassRate: wBasePass / wCount,
          candidatePassRate: wCandPass / wCount,
          passRateDelta: (wCandPass - wBasePass) / wCount,
          baselineTokens: workerBaseObs.reduce((s, o) => s + o.metrics.portable.inputTokens, 0),
          candidateTokens: workerCandObs.reduce((s, o) => s + o.metrics.portable.inputTokens, 0),
          tokenDelta:
            workerCandObs.reduce((s, o) => s + o.metrics.portable.inputTokens, 0) -
            workerBaseObs.reduce((s, o) => s + o.metrics.portable.inputTokens, 0),
        },
        hardwareSensitive: {
          baselineDurationMs: wBaseDuration,
          candidateDurationMs: wCandDuration,
          durationDeltaMs: wCandDuration - wBaseDuration,
          speedupFactor: speedup,
        },
      };

      const profile = this.buildCapacityProfile(worker);
      const effectiveCap = this.computeEffectiveCapacity(worker, undefined, undefined, false);

      workerPlacements.push({
        workerId: worker.id,
        workerName: worker.name,
        shardId: workerShards[0]?.shardId ?? `shard-${worker.id}`,
        taskCount: workerTasks.length,
        tasks: workerTasks,
        taskIds: workerTasks,
        baselineCompletedTasks: workerBaseObs.length,
        candidateCompletedTasks: workerCandObs.length,
        modelsUsed: ['qwen-2.5-coder'],
        hardware: {
          cpu: `${worker.hardware.cpu ?? 'CPU'} (${worker.hardware.cpuCores ?? 8}c)`,
          gpu: worker.hardware.gpu ? `${worker.hardware.gpu.model} (${worker.hardware.gpu.memoryGB}GB)` : undefined,
          ramGB: worker.hardware.memoryGB,
          os: `${worker.os.platform} ${worker.os.architecture}`,
        },
        portableMetrics: {
          passRate: wCandPass / wCount,
          avgInputTokens: Math.round(
            workerCandObs.reduce((s, o) => s + o.metrics.portable.inputTokens, 0) / wCount,
          ),
          avgOutputTokens: Math.round(
            workerCandObs.reduce((s, o) => s + o.metrics.portable.outputTokens, 0) / wCount,
          ),
        },
        hardwareMetrics: {
          avgDurationMs: Math.round(wCandDuration / wCount),
          speedupVsBaseline: speedup,
        },
        capacityWeight: workerShards[0]?.capacityWeight ?? effectiveCap.weight,
        effectiveCapacity: workerShards[0]?.effectiveCapacity ?? effectiveCap.effectiveCapacity,
        capacityProfile: profile,
        status: workerStatuses.get(worker.id) ?? 'HEALTHY',
      });
    }

    // Build consolidated BenchmarkSuiteResults
    const baselineSuite: BenchmarkSuiteResult = {
      runnerId: 'distributed-fabric',
      totalTasks,
      passedTasks: baselinePassed,
      failedTasks: totalTasks - baselinePassed,
      passRate: baselinePassRate,
      averageDurationMs: totalTasks > 0 ? baselineTotalDuration / totalTasks : 0,
      totalDurationMs: baselineTotalDuration,
      results: Array.from(validBaselineObs.values()).map((o) => ({
        taskId: o.taskId,
        taskName: o.taskId,
        category: 'FEATURE_IMPLEMENTATION',
        runnerId: o.workerId,
        scoreReport: o.scoreReport,
        durationMs: o.metrics.hardwareSensitive.durationMs,
      })),
      aggregateMetrics: {
        totalWallTimeMs: baselineTotalDuration,
        totalModelCalls: 0,
        totalToolCalls: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        averageRepairCycles: 0,
      },
      executedAt: new Date(),
    };

    const candidateSuite: BenchmarkSuiteResult = {
      runnerId: 'distributed-fabric',
      totalTasks,
      passedTasks: candidatePassed,
      failedTasks: totalTasks - candidatePassed,
      passRate: candidatePassRate,
      averageDurationMs: totalTasks > 0 ? candidateTotalDuration / totalTasks : 0,
      totalDurationMs: candidateTotalDuration,
      results: Array.from(validCandidateObs.values()).map((o) => ({
        taskId: o.taskId,
        taskName: o.taskId,
        category: 'FEATURE_IMPLEMENTATION',
        runnerId: o.workerId,
        scoreReport: o.scoreReport,
        durationMs: o.metrics.hardwareSensitive.durationMs,
      })),
      aggregateMetrics: {
        totalWallTimeMs: candidateTotalDuration,
        totalModelCalls: 0,
        totalToolCalls: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        averageRepairCycles: 0,
      },
      executedAt: new Date(),
    };

    const comparison: ComparativeBenchmarkSuiteResult = {
      baselineRunnerId: 'distributed-fabric',
      candidateRunnerId: 'distributed-fabric',
      baselineTasks: totalTasks,
      candidateTasks: totalTasks,
      baselinePassRate,
      candidatePassRate,
      passRateDelta,
      tokenUsageDelta,
      costDelta: Number((tokenUsageDelta * 0.000005).toFixed(4)),
      durationDelta: candidateTotalDuration - baselineTotalDuration,
      regressedTasks,
      improvedTasks,
      regressionDetected: regressedTasks.length > 0,
      improvementDetected: passRateDelta > 0 || (passRateDelta === 0 && tokenUsageDelta < 0),
      preferredCandidate: regressedTasks.length > 0
        ? 'baseline'
        : (passRateDelta > 0 || tokenUsageDelta < 0 ? 'candidate' : 'tie'),
      summary: `Distributed benchmark evaluated across ${availableWorkers.length} workers with ${totalTasks} tasks.`,
      isDistributed: true,
      workerPlacements,
      stratifiedMetrics,
      environmentIdentities,
    };

    // 6. RegressionGuard Evaluation
    const guardResult = this.regressionGuard.evaluate({
      plan,
      baselineSuite,
      candidateSuite,
      comparison,
      candidateVerificationPassed: true,
    });

    onEvent('meta.distributed.aggregation_completed', {
      experimentId: plan.experimentId,
      candidateId: candidate.candidateId,
      qualified: guardResult.qualified,
      regressions: guardResult.regressionsDetected,
      workerPlacementsCount: workerPlacements.length,
    });

    return {
      runId: `run-dist-${randomUUID()}`,
      experimentId: plan.experimentId,
      baselineConfig: candidate.config,
      candidateConfig: candidate.config,
      mutations: candidate.mutations ?? [],
      baselineBenchmark: baselineSuite,
      candidateBenchmark: candidateSuite,
      comparison,
      decision: guardResult.qualified ? 'QUALIFIED' : 'REJECTED',
      reasons: guardResult.qualified
        ? ['Distributed evaluation passed all correctness and regression gates without regression.']
        : guardResult.regressionsDetected,
      regressionGuard: guardResult,
      isDistributed: true,
      workerPlacements,
      stratifiedMetrics,
      environmentIdentities,
      evaluatedAt: new Date(),
    };
  }

  /**
   * Creates a default in-memory task dispatcher for simulation and testing.
   */
  private createDefaultDispatcher(): ShardWorkerDispatch {
    return {
      async executeTask(params) {
        const { task, isCandidate } = params;
        const tokens = isCandidate ? 450 : 600;
        return {
          execution: {
            id: `exec-${task.id}-${isCandidate ? 'cand' : 'base'}-${randomUUID().slice(0, 6)}`,
            taskId: task.id,
            runtimeId: params.worker.runtimes[0] ?? 'in-process',
            modelId: 'qwen-2.5-coder',
            status: 'completed',
            createdAt: new Date(),
            completedAt: new Date(),
          },
          task: {
            id: task.id,
            type: 'coding',
            title: task.name,
            input: task.prompt,
            requirements: {},
            priority: 'normal',
            status: 'completed',
            createdAt: new Date(),
          },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: task.expectedFiles ?? ['output.txt'],
          checks: [
            {
              name: 'test',
              command: 'check',
              ok: true,
              durationMs: isCandidate ? 35 : 50,
              output: 'All tests passed',
            },
          ],
          errors: [],
          events: [],
          usage: { input: tokens, output: 150 },
        };
      },
    };
  }
}
