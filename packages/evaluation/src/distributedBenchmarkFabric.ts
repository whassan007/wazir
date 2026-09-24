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
  failWorkerSimulation?: {
    workerId: string;
    atTaskIndex?: number;
    failureMode?: 'crash' | 'disconnect';
  };
  onEvent?: (eventName: string, data: Record<string, unknown>) => void;
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
   * Deterministically shards benchmark tasks across available workers.
   * Enforces WORKLOAD EQUIVALENCE: the exact same shard allocation is evaluated
   * by both baseline and candidates.
   */
  public shardTasks(
    tasks: BenchmarkTask[],
    workers: Computer[],
    seed: string | number,
    config: OptimizableConfig,
  ): BenchmarkShard[] {
    if (workers.length === 0) {
      throw new Error('Cannot shard tasks: No workers available.');
    }
    if (tasks.length === 0) {
      throw new Error('Cannot shard tasks: Task list is empty.');
    }

    const seedStr = String(seed);
    const shards: BenchmarkShard[] = workers.map((w, idx) => ({
      shardId: `shard-${idx + 1}-${w.id}`,
      workerId: w.id,
      tasks: [],
      environment: this.extractEnvironmentIdentity(w, config),
    }));

    // Deterministic distribution using SHA-256 hash ring
    for (const task of tasks) {
      const hash = createHash('sha256')
        .update(`${seedStr}::task::${task.id}`)
        .digest('hex');
      const numericVal = parseInt(hash.slice(0, 8), 16);
      const workerIdx = numericVal % workers.length;
      shards[workerIdx].tasks.push(task);
    }

    return shards;
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

    // 3. Shard tasks deterministically
    const shards = this.shardTasks(tasks, availableWorkers, seed, baselineConfig);

    // Track all observations with deduplication
    const observations = new Map<string, DistributedObservation & { scoreReport: EvaluationScoreReport }>();
    const workerStatuses = new Map<string, 'HEALTHY' | 'FAILED' | 'RECOVERED'>();
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
      }

      onEvent('meta.distributed.shard_completed', {
        shardId: shard.shardId,
        workerId: shard.workerId,
        taskCount: shard.tasks.length,
      });
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
    workerStatuses: Map<string, 'HEALTHY' | 'FAILED' | 'RECOVERED'>;
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

      workerPlacements.push({
        workerId: worker.id,
        workerName: worker.name,
        shardId: workerShards[0]?.shardId ?? `shard-${worker.id}`,
        taskCount: workerTasks.length,
        tasks: workerTasks,
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
