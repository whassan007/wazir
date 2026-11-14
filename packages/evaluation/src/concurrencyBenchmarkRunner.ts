import * as os from 'node:os';
import { performance } from 'node:perf_hooks';

export type BenchmarkExecutionMode = 'deterministic' | 'live';

export const DEFAULT_CONCURRENCY_LEVELS = [1, 4, 8, 20] as const;

export interface LatencyDistribution {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface MemorySnapshotDelta {
  rssBeforeMB: number;
  rssAfterMB: number;
  heapUsedBeforeMB: number;
  heapUsedAfterMB: number;
  heapDeltaMB: number;
}

export interface TokenUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ConcurrencyLevelBenchmarkResult {
  mode: BenchmarkExecutionMode;
  concurrency: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  wallClockDurationMs: number;
  throughputTasksPerSec: number;
  latency: LatencyDistribution;
  memory: MemorySnapshotDelta;
  tokens: TokenUsageMetrics;
  retries: number;
  maxObservedInFlight: number;
  liveMetrics?: {
    provider: string;
    model: string;
    ttftP50Ms: number;
    ttftP95Ms: number;
    tokensPerSec: number;
  };
  overheadBreakdownMs?: {
    taskSchedulingMeanMs: number;
    contextCompilationMeanMs: number;
    toolDispatchMeanMs: number;
    persistenceWriteMeanMs: number;
    checkpointCreateMeanMs: number;
    checkpointLookupMeanMs: number;
  };
}

export interface SubsystemMicrobenchmarkMetrics {
  cliStartupColdMs: number;
  cliStartupWarmP50Ms: number;
  engineInitP50Ms: number;
  storeWriteP50Ms: number;
  checkpointLookupP50Ms: number;
  toolDispatchP50Ms: number;
}

export interface BenchmarkEnvironmentMetadata {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuCount: number;
  totalMemoryMB: number;
  timestamp: string;
}

export interface BenchmarkLiveProviderMetadata {
  provider: string;
  model: string;
  endpoint?: string;
}

export interface BenchmarkSuiteRunReport {
  suiteId: string;
  mode: BenchmarkExecutionMode;
  environment: BenchmarkEnvironmentMetadata;
  providerMetadata?: BenchmarkLiveProviderMetadata;
  concurrencyLevels: number[];
  levels: ConcurrencyLevelBenchmarkResult[];
  subsystems: SubsystemMicrobenchmarkMetrics;
  startedAt: string;
  completedAt: string;
  totalWallClockMs: number;
}

export interface DeterministicTaskOverheadSample {
  taskSchedulingMs?: number;
  contextCompilationMs?: number;
  toolDispatchMs?: number;
  persistenceWriteMs?: number;
  checkpointCreateMs?: number;
  checkpointLookupMs?: number;
}

export interface BenchmarkTaskExecutionContext {
  taskIndex: number;
  concurrency: number;
  attempt: number;
  activeInFlight: number;
  mode: BenchmarkExecutionMode;
}

export interface DeterministicTaskExecutionOutcome {
  ok?: boolean;
  durationMs?: number;
  tokens?: Partial<TokenUsageMetrics>;
  retries?: number;
  overhead?: DeterministicTaskOverheadSample;
}

export interface LiveTaskExecutionOutcome {
  ok?: boolean;
  durationMs?: number;
  ttftMs?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  retries?: number;
  provider?: string;
  model?: string;
}

export type DeterministicWorkloadTaskFn = (
  ctx: BenchmarkTaskExecutionContext,
) => Promise<DeterministicTaskExecutionOutcome | undefined> | DeterministicTaskExecutionOutcome | undefined;

export type LiveWorkloadTaskFn = (
  ctx: BenchmarkTaskExecutionContext,
) => Promise<LiveTaskExecutionOutcome>;

export interface LiveBenchmarkAdapter {
  provider: string;
  model: string;
  endpoint?: string;
  executeTask: LiveWorkloadTaskFn;
}

export interface ConcurrencyBenchmarkRunnerOptions {
  suiteId?: string;
  concurrencyLevels?: number[];
  tasksPerLevel?: number | ((concurrency: number) => number);
  maxRetriesPerTask?: number;
  subsystemIterations?: number;
  subsystemsOverride?: Partial<SubsystemMicrobenchmarkMetrics>;
}

export interface MetricDeltaEntry {
  baseline: number;
  candidate: number;
  absoluteDelta: number;
  percentageDelta: number;
  improved: boolean;
  regressed: boolean;
}

export interface ConcurrencyLevelComparison {
  concurrency: number;
  p50Ms: MetricDeltaEntry;
  p95Ms: MetricDeltaEntry;
  p99Ms: MetricDeltaEntry;
  throughputTasksPerSec: MetricDeltaEntry;
  heapDeltaMB: MetricDeltaEntry;
}

export interface SubsystemMicrobenchmarkComparison {
  cliStartupColdMs: MetricDeltaEntry;
  cliStartupWarmP50Ms: MetricDeltaEntry;
  engineInitP50Ms: MetricDeltaEntry;
  storeWriteP50Ms: MetricDeltaEntry;
  checkpointLookupP50Ms: MetricDeltaEntry;
  toolDispatchP50Ms: MetricDeltaEntry;
}

export interface BenchmarkComparisonSummary {
  mode: BenchmarkExecutionMode;
  baselineSuiteId: string;
  candidateSuiteId: string;
  comparedAt: string;
  concurrencyComparisons: ConcurrencyLevelComparison[];
  subsystemComparisons: SubsystemMicrobenchmarkComparison;
  hasRegressions: boolean;
  regressionDetails: string[];
}

function bytesToMB(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function roundMetric(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Number(val.toFixed(4));
}

export function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return roundMetric(sortedValues[0]);
  const clamped = Math.max(0, Math.min(100, percentile));
  const rank = (clamped / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) {
    return roundMetric(sortedValues[lowerIndex]);
  }
  const weight = rank - lowerIndex;
  const interpolated = sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
  return roundMetric(interpolated);
}

export function computeLatencyDistribution(samplesMs: number[]): LatencyDistribution {
  const valid = samplesMs.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return {
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
    };
  }
  const sum = valid.reduce((acc, v) => acc + v, 0);
  return {
    minMs: roundMetric(valid[0]),
    p50Ms: computePercentile(valid, 50),
    p95Ms: computePercentile(valid, 95),
    p99Ms: computePercentile(valid, 99),
    maxMs: roundMetric(valid[valid.length - 1]),
    meanMs: roundMetric(sum / valid.length),
  };
}

function defaultDeterministicWorkload(ctx: BenchmarkTaskExecutionContext): DeterministicTaskExecutionOutcome {
  const t0 = performance.now();
  // 1. Task scheduling overhead simulation
  const scheduleQueue = Array.from({ length: 16 }, (_, idx) => ({
    id: `task-${ctx.concurrency}-${ctx.taskIndex}-${idx}`,
    priority: (idx * 7 + ctx.taskIndex) % 5,
  })).sort((a, b) => b.priority - a.priority);
  const tSchedule = performance.now();

  // 2. Context compilation overhead simulation
  const compiledContext = scheduleQueue
    .map((item) => `[CTX:${item.id}:P${item.priority}]`)
    .join('\n');
  const tContext = performance.now();

  // 3. Tool dispatch overhead simulation
  const toolPayload = JSON.stringify({
    tool: 'read_file',
    target: compiledContext.slice(0, 48),
    attempt: ctx.attempt,
  });
  const parsedTool = JSON.parse(toolPayload) as { tool: string; target: string };
  const tTool = performance.now();

  // 4. Persistence write simulation (in-memory serialized state frame)
  const recordBuffer = Buffer.from(
    JSON.stringify({
      taskIndex: ctx.taskIndex,
      concurrency: ctx.concurrency,
      tool: parsedTool.tool,
      contextLen: compiledContext.length,
    }),
    'utf8',
  );
  const tStore = performance.now();

  // 5. Checkpoint creation & lookup simulation
  const checkpointMap = new Map<string, Buffer>();
  const checkpointKey = `ckpt-${ctx.concurrency}-${ctx.taskIndex}`;
  checkpointMap.set(checkpointKey, recordBuffer);
  const tCkptCreate = performance.now();

  const lookedUp = checkpointMap.get(checkpointKey);
  const tCkptLookup = performance.now();

  const syntheticInputTokens = 120 + (ctx.taskIndex % 15) * 4;
  const syntheticOutputTokens = 60 + ((lookedUp?.byteLength ?? 0) % 25);

  return {
    ok: true,
    tokens: {
      inputTokens: syntheticInputTokens,
      outputTokens: syntheticOutputTokens,
      totalTokens: syntheticInputTokens + syntheticOutputTokens,
    },
    retries: 0,
    overhead: {
      taskSchedulingMs: roundMetric(tSchedule - t0),
      contextCompilationMs: roundMetric(tContext - tSchedule),
      toolDispatchMs: roundMetric(tTool - tContext),
      persistenceWriteMs: roundMetric(tStore - tTool),
      checkpointCreateMs: roundMetric(tCkptCreate - tStore),
      checkpointLookupMs: roundMetric(tCkptLookup - tCkptCreate),
    },
  };
}

export class ConcurrencyBenchmarkRunner {
  private readonly suiteId: string;
  private readonly concurrencyLevels: number[];
  private readonly tasksPerLevelResolver: (concurrency: number) => number;
  private readonly maxRetriesPerTask: number;
  private readonly subsystemIterations: number;
  private readonly subsystemsOverride?: Partial<SubsystemMicrobenchmarkMetrics>;

  constructor(options: ConcurrencyBenchmarkRunnerOptions = {}) {
    this.suiteId = options.suiteId ?? `wazir-concurrency-bench-${Date.now()}`;
    const levels = options.concurrencyLevels ?? [...DEFAULT_CONCURRENCY_LEVELS];
    if (levels.length === 0 || levels.some((c) => !Number.isInteger(c) || c < 1)) {
      throw new Error('concurrencyLevels must be a non-empty array of positive integers');
    }
    this.concurrencyLevels = [...levels];

    if (typeof options.tasksPerLevel === 'function') {
      this.tasksPerLevelResolver = options.tasksPerLevel;
    } else if (typeof options.tasksPerLevel === 'number') {
      const fixed = Math.max(1, Math.floor(options.tasksPerLevel));
      this.tasksPerLevelResolver = () => fixed;
    } else {
      this.tasksPerLevelResolver = (concurrency: number) => Math.max(20, concurrency * 4);
    }

    this.maxRetriesPerTask = Math.max(0, Math.floor(options.maxRetriesPerTask ?? 1));
    this.subsystemIterations = Math.max(5, Math.floor(options.subsystemIterations ?? 25));
    this.subsystemsOverride = options.subsystemsOverride;
  }

  /**
   * Runs a deterministic, repeatable zero-network benchmark suite across configured concurrency levels.
   */
  public async runDeterministicSuite(
    workloadFn: DeterministicWorkloadTaskFn = defaultDeterministicWorkload,
  ): Promise<BenchmarkSuiteRunReport> {
    const startedAt = new Date().toISOString();
    const suiteStart = performance.now();

    const subsystems = this.measureDeterministicSubsystems();
    const levels: ConcurrencyLevelBenchmarkResult[] = [];

    for (const concurrency of this.concurrencyLevels) {
      const totalTasks = Math.max(1, this.tasksPerLevelResolver(concurrency));
      const levelResult = await this.runDeterministicLevel(concurrency, totalTasks, workloadFn);
      levels.push(levelResult);
    }

    const totalWallClockMs = roundMetric(performance.now() - suiteStart);
    const completedAt = new Date().toISOString();

    return {
      suiteId: this.suiteId,
      mode: 'deterministic',
      environment: this.captureEnvironmentMetadata(),
      concurrencyLevels: [...this.concurrencyLevels],
      levels,
      subsystems,
      startedAt,
      completedAt,
      totalWallClockMs,
    };
  }

  /**
   * Runs a live benchmark suite against a real provider/model workload adapter across configured concurrency levels.
   * Explicitly tagged with `mode: 'live'` so live network latency is never mixed with deterministic microbenchmarks.
   */
  public async runLiveSuite(adapter: LiveBenchmarkAdapter): Promise<BenchmarkSuiteRunReport> {
    if (!adapter || typeof adapter.executeTask !== 'function') {
      throw new Error('Live benchmark suite requires a valid LiveBenchmarkAdapter with executeTask()');
    }
    if (!adapter.provider || !adapter.model) {
      throw new Error('LiveBenchmarkAdapter must specify non-empty provider and model metadata');
    }

    const startedAt = new Date().toISOString();
    const suiteStart = performance.now();

    const subsystems = this.measureDeterministicSubsystems();
    const levels: ConcurrencyLevelBenchmarkResult[] = [];

    for (const concurrency of this.concurrencyLevels) {
      const totalTasks = Math.max(1, this.tasksPerLevelResolver(concurrency));
      const levelResult = await this.runLiveLevel(concurrency, totalTasks, adapter);
      levels.push(levelResult);
    }

    const totalWallClockMs = roundMetric(performance.now() - suiteStart);
    const completedAt = new Date().toISOString();

    return {
      suiteId: this.suiteId,
      mode: 'live',
      environment: this.captureEnvironmentMetadata(),
      providerMetadata: {
        provider: adapter.provider,
        model: adapter.model,
        endpoint: adapter.endpoint,
      },
      concurrencyLevels: [...this.concurrencyLevels],
      levels,
      subsystems,
      startedAt,
      completedAt,
      totalWallClockMs,
    };
  }

  private async runDeterministicLevel(
    concurrency: number,
    totalTasks: number,
    workloadFn: DeterministicWorkloadTaskFn,
  ): Promise<ConcurrencyLevelBenchmarkResult> {
    const memBefore = process.memoryUsage();
    const startWall = performance.now();

    let nextTaskIndex = 0;
    let activeInFlight = 0;
    let maxObservedInFlight = 0;
    let completedTasks = 0;
    let failedTasks = 0;
    let totalRetries = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    const latenciesMs: number[] = [];
    const overheadSamples: DeterministicTaskOverheadSample[] = [];

    const workerCount = Math.min(concurrency, totalTasks);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= totalTasks) {
          break;
        }

        activeInFlight += 1;
        if (activeInFlight > maxObservedInFlight) {
          maxObservedInFlight = activeInFlight;
        }

        const taskStart = performance.now();
        let attempt = 0;
        let succeeded = false;
        let outcome: DeterministicTaskExecutionOutcome | undefined;

        try {
          while (attempt <= this.maxRetriesPerTask) {
            try {
              const rawResult = await workloadFn({
                taskIndex,
                concurrency,
                attempt,
                activeInFlight,
                mode: 'deterministic',
              });
              outcome = rawResult ?? undefined;
              if (outcome && outcome.ok === false) {
                if (attempt < this.maxRetriesPerTask) {
                  attempt += 1;
                  totalRetries += 1;
                  continue;
                }
                succeeded = false;
                break;
              }
              succeeded = true;
              break;
            } catch {
              if (attempt < this.maxRetriesPerTask) {
                attempt += 1;
                totalRetries += 1;
              } else {
                succeeded = false;
                break;
              }
            }
          }

          const measuredDurationMs =
            outcome && typeof outcome.durationMs === 'number' && outcome.durationMs >= 0
              ? outcome.durationMs
              : performance.now() - taskStart;

          latenciesMs.push(measuredDurationMs);

          if (outcome?.retries && outcome.retries > 0) {
            totalRetries += outcome.retries;
          }

          if (outcome?.tokens) {
            const inTok = outcome.tokens.inputTokens ?? 0;
            const outTok = outcome.tokens.outputTokens ?? 0;
            const totTok = outcome.tokens.totalTokens ?? inTok + outTok;
            inputTokens += inTok;
            outputTokens += outTok;
            totalTokens += totTok;
          }

          if (outcome?.overhead) {
            overheadSamples.push(outcome.overhead);
          }

          if (succeeded) {
            completedTasks += 1;
          } else {
            failedTasks += 1;
          }
        } finally {
          activeInFlight -= 1;
        }
      }
    });

    await Promise.all(workers);

    const wallClockDurationMs = Math.max(0.0001, performance.now() - startWall);
    const memAfter = process.memoryUsage();

    const rssBeforeMB = bytesToMB(memBefore.rss);
    const rssAfterMB = bytesToMB(memAfter.rss);
    const heapUsedBeforeMB = bytesToMB(memBefore.heapUsed);
    const heapUsedAfterMB = bytesToMB(memAfter.heapUsed);
    const heapDeltaMB = roundMetric(heapUsedAfterMB - heapUsedBeforeMB);

    const throughputTasksPerSec = roundMetric((completedTasks / wallClockDurationMs) * 1000);

    const meanOf = (getter: (s: DeterministicTaskOverheadSample) => number | undefined): number => {
      const vals = overheadSamples.map(getter).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (vals.length === 0) return 0;
      return roundMetric(vals.reduce((a, b) => a + b, 0) / vals.length);
    };

    return {
      mode: 'deterministic',
      concurrency,
      totalTasks,
      completedTasks,
      failedTasks,
      wallClockDurationMs: roundMetric(wallClockDurationMs),
      throughputTasksPerSec,
      latency: computeLatencyDistribution(latenciesMs),
      memory: {
        rssBeforeMB,
        rssAfterMB,
        heapUsedBeforeMB,
        heapUsedAfterMB,
        heapDeltaMB,
      },
      tokens: {
        inputTokens,
        outputTokens,
        totalTokens,
      },
      retries: totalRetries,
      maxObservedInFlight,
      overheadBreakdownMs:
        overheadSamples.length > 0
          ? {
              taskSchedulingMeanMs: meanOf((s) => s.taskSchedulingMs),
              contextCompilationMeanMs: meanOf((s) => s.contextCompilationMs),
              toolDispatchMeanMs: meanOf((s) => s.toolDispatchMs),
              persistenceWriteMeanMs: meanOf((s) => s.persistenceWriteMs),
              checkpointCreateMeanMs: meanOf((s) => s.checkpointCreateMs),
              checkpointLookupMeanMs: meanOf((s) => s.checkpointLookupMs),
            }
          : undefined,
    };
  }

  private async runLiveLevel(
    concurrency: number,
    totalTasks: number,
    adapter: LiveBenchmarkAdapter,
  ): Promise<ConcurrencyLevelBenchmarkResult> {
    const memBefore = process.memoryUsage();
    const startWall = performance.now();

    let nextTaskIndex = 0;
    let activeInFlight = 0;
    let maxObservedInFlight = 0;
    let completedTasks = 0;
    let failedTasks = 0;
    let totalRetries = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    const latenciesMs: number[] = [];
    const ttftSamplesMs: number[] = [];

    const workerCount = Math.min(concurrency, totalTasks);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= totalTasks) {
          break;
        }

        activeInFlight += 1;
        if (activeInFlight > maxObservedInFlight) {
          maxObservedInFlight = activeInFlight;
        }

        const taskStart = performance.now();
        let attempt = 0;
        let succeeded = false;
        let outcome: LiveTaskExecutionOutcome | undefined;

        try {
          while (attempt <= this.maxRetriesPerTask) {
            try {
              outcome = await adapter.executeTask({
                taskIndex,
                concurrency,
                attempt,
                activeInFlight,
                mode: 'live',
              });
              if (outcome.ok === false) {
                if (attempt < this.maxRetriesPerTask) {
                  attempt += 1;
                  totalRetries += 1;
                  continue;
                }
                succeeded = false;
                break;
              }
              succeeded = true;
              break;
            } catch {
              if (attempt < this.maxRetriesPerTask) {
                attempt += 1;
                totalRetries += 1;
              } else {
                succeeded = false;
                break;
              }
            }
          }

          const measuredDurationMs =
            outcome && typeof outcome.durationMs === 'number' && outcome.durationMs >= 0
              ? outcome.durationMs
              : performance.now() - taskStart;

          latenciesMs.push(measuredDurationMs);

          if (outcome) {
            if (typeof outcome.ttftMs === 'number' && outcome.ttftMs >= 0) {
              ttftSamplesMs.push(outcome.ttftMs);
            }
            if (outcome.retries && outcome.retries > 0) {
              totalRetries += outcome.retries;
            }
            const inTok = outcome.inputTokens ?? 0;
            const outTok = outcome.outputTokens ?? 0;
            const totTok = outcome.totalTokens ?? inTok + outTok;
            inputTokens += inTok;
            outputTokens += outTok;
            totalTokens += totTok;
          }

          if (succeeded) {
            completedTasks += 1;
          } else {
            failedTasks += 1;
          }
        } finally {
          activeInFlight -= 1;
        }
      }
    });

    await Promise.all(workers);

    const wallClockDurationMs = Math.max(0.0001, performance.now() - startWall);
    const memAfter = process.memoryUsage();

    const rssBeforeMB = bytesToMB(memBefore.rss);
    const rssAfterMB = bytesToMB(memAfter.rss);
    const heapUsedBeforeMB = bytesToMB(memBefore.heapUsed);
    const heapUsedAfterMB = bytesToMB(memAfter.heapUsed);
    const heapDeltaMB = roundMetric(heapUsedAfterMB - heapUsedBeforeMB);

    const throughputTasksPerSec = roundMetric((completedTasks / wallClockDurationMs) * 1000);
    const sortedTtft = [...ttftSamplesMs].sort((a, b) => a - b);

    return {
      mode: 'live',
      concurrency,
      totalTasks,
      completedTasks,
      failedTasks,
      wallClockDurationMs: roundMetric(wallClockDurationMs),
      throughputTasksPerSec,
      latency: computeLatencyDistribution(latenciesMs),
      memory: {
        rssBeforeMB,
        rssAfterMB,
        heapUsedBeforeMB,
        heapUsedAfterMB,
        heapDeltaMB,
      },
      tokens: {
        inputTokens,
        outputTokens,
        totalTokens,
      },
      retries: totalRetries,
      maxObservedInFlight,
      liveMetrics: {
        provider: adapter.provider,
        model: adapter.model,
        ttftP50Ms: computePercentile(sortedTtft, 50),
        ttftP95Ms: computePercentile(sortedTtft, 95),
        tokensPerSec: roundMetric((totalTokens / wallClockDurationMs) * 1000),
      },
    };
  }

  private measureDeterministicSubsystems(): SubsystemMicrobenchmarkMetrics {
    const cliColdSamples: number[] = [];
    const cliWarmSamples: number[] = [];
    const engineInitSamples: number[] = [];
    const storeWriteSamples: number[] = [];
    const checkpointLookupSamples: number[] = [];
    const toolDispatchSamples: number[] = [];

    const checkpointTable = new Map<string, { revision: number; stateHash: string }>();
    for (let i = 0; i < 200; i++) {
      checkpointTable.set(`ckpt-key-${i}`, { revision: i, stateHash: `hash-${i * 31}` });
    }

    for (let i = 0; i < this.subsystemIterations; i++) {
      // Cold CLI command graph assembly
      const tCold0 = performance.now();
      const commandRegistry = new Map<string, { name: string; flags: string[] }>();
      for (let c = 0; c < 24; c++) {
        commandRegistry.set(`cmd-${c}`, { name: `cmd-${c}`, flags: ['--json', '--verbose', '--concurrency'] });
      }
      cliColdSamples.push(performance.now() - tCold0);

      // Warm CLI dispatch lookup
      const tWarm0 = performance.now();
      const matched = commandRegistry.get(`cmd-${i % 24}`);
      if (!matched) {
        throw new Error('Unexpected missing command in warm lookup');
      }
      cliWarmSamples.push(performance.now() - tWarm0);

      // Engine initialization microbenchmark
      const tEng0 = performance.now();
      const engineConfig = {
        maxConcurrency: 20,
        revision: i,
        tools: ['read_file', 'write_file', 'edit_file', 'shell'],
      };
      const engineState = { ...engineConfig, initializedAt: i };
      if (engineState.maxConcurrency !== 20) {
        throw new Error('Invalid engine state');
      }
      engineInitSamples.push(performance.now() - tEng0);

      // Store write serialization microbenchmark
      const tStore0 = performance.now();
      const serialized = JSON.stringify({
        executionId: `exec-${i}`,
        status: 'completed',
        revision: i,
        filesChanged: [`src/file-${i}.ts`],
      });
      if (serialized.length === 0) {
        throw new Error('Serialization failed');
      }
      storeWriteSamples.push(performance.now() - tStore0);

      // Checkpoint lookup microbenchmark
      const tCkpt0 = performance.now();
      const ckpt = checkpointTable.get(`ckpt-key-${i % 200}`);
      if (!ckpt) {
        throw new Error('Checkpoint lookup failed');
      }
      checkpointLookupSamples.push(performance.now() - tCkpt0);

      // Tool dispatch microbenchmark
      const tTool0 = performance.now();
      const dispatchEnvelope = {
        tool: 'read_file',
        args: { path: `/workspace/file-${i}.ts` },
      };
      const validatedPath = dispatchEnvelope.args.path.startsWith('/workspace/');
      if (!validatedPath) {
        throw new Error('Tool validation failed');
      }
      toolDispatchSamples.push(performance.now() - tTool0);
    }

    const coldSorted = [...cliColdSamples].sort((a, b) => a - b);
    const warmSorted = [...cliWarmSamples].sort((a, b) => a - b);
    const engineSorted = [...engineInitSamples].sort((a, b) => a - b);
    const storeSorted = [...storeWriteSamples].sort((a, b) => a - b);
    const ckptSorted = [...checkpointLookupSamples].sort((a, b) => a - b);
    const toolSorted = [...toolDispatchSamples].sort((a, b) => a - b);

    return {
      cliStartupColdMs: this.subsystemsOverride?.cliStartupColdMs ?? computePercentile(coldSorted, 50),
      cliStartupWarmP50Ms: this.subsystemsOverride?.cliStartupWarmP50Ms ?? computePercentile(warmSorted, 50),
      engineInitP50Ms: this.subsystemsOverride?.engineInitP50Ms ?? computePercentile(engineSorted, 50),
      storeWriteP50Ms: this.subsystemsOverride?.storeWriteP50Ms ?? computePercentile(storeSorted, 50),
      checkpointLookupP50Ms: this.subsystemsOverride?.checkpointLookupP50Ms ?? computePercentile(ckptSorted, 50),
      toolDispatchP50Ms: this.subsystemsOverride?.toolDispatchP50Ms ?? computePercentile(toolSorted, 50),
    };
  }

  private captureEnvironmentMetadata(): BenchmarkEnvironmentMetadata {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryMB: bytesToMB(os.totalmem()),
      timestamp: new Date().toISOString(),
    };
  }
}

function computeDeltaEntry(
  baseline: number,
  candidate: number,
  lowerIsBetter: boolean,
  regressionThresholdPct = 5,
): MetricDeltaEntry {
  const absoluteDelta = roundMetric(candidate - baseline);
  let percentageDelta = 0;
  if (Math.abs(baseline) > 1e-9) {
    percentageDelta = roundMetric(((candidate - baseline) / Math.abs(baseline)) * 100);
  } else if (Math.abs(candidate) > 1e-9) {
    percentageDelta = candidate > 0 ? 100 : -100;
  }

  const improved = lowerIsBetter ? candidate < baseline : candidate > baseline;
  const regressed = lowerIsBetter
    ? percentageDelta > regressionThresholdPct
    : percentageDelta < -regressionThresholdPct;

  return {
    baseline: roundMetric(baseline),
    candidate: roundMetric(candidate),
    absoluteDelta,
    percentageDelta,
    improved,
    regressed,
  };
}

/**
 * Computes percentage deltas between a baseline and candidate benchmark suite report
 * across matching concurrency levels (1, 4, 8, 20) and subsystem microbenchmarks.
 * Refuses to compare mixed execution modes ('deterministic' vs 'live').
 */
export function compareBenchmarkReports(
  baseline: BenchmarkSuiteRunReport,
  candidate: BenchmarkSuiteRunReport,
): BenchmarkComparisonSummary {
  if (baseline.mode !== candidate.mode) {
    throw new Error(
      `Cannot compare mixed benchmark modes: baseline is '${baseline.mode}' but candidate is '${candidate.mode}'`,
    );
  }

  const regressionDetails: string[] = [];
  const concurrencyComparisons: ConcurrencyLevelComparison[] = [];

  const candidateByConcurrency = new Map<number, ConcurrencyLevelBenchmarkResult>();
  for (const level of candidate.levels) {
    candidateByConcurrency.set(level.concurrency, level);
  }

  for (const baseLevel of baseline.levels) {
    const candLevel = candidateByConcurrency.get(baseLevel.concurrency);
    if (!candLevel) continue;

    const p50Ms = computeDeltaEntry(baseLevel.latency.p50Ms, candLevel.latency.p50Ms, true);
    const p95Ms = computeDeltaEntry(baseLevel.latency.p95Ms, candLevel.latency.p95Ms, true);
    const p99Ms = computeDeltaEntry(baseLevel.latency.p99Ms, candLevel.latency.p99Ms, true);
    const throughputTasksPerSec = computeDeltaEntry(
      baseLevel.throughputTasksPerSec,
      candLevel.throughputTasksPerSec,
      false,
    );
    const heapDeltaMB = computeDeltaEntry(baseLevel.memory.heapDeltaMB, candLevel.memory.heapDeltaMB, true);

    if (p50Ms.regressed) {
      regressionDetails.push(`concurrency=${baseLevel.concurrency}: p50Ms regressed by +${p50Ms.percentageDelta}%`);
    }
    if (p95Ms.regressed) {
      regressionDetails.push(`concurrency=${baseLevel.concurrency}: p95Ms regressed by +${p95Ms.percentageDelta}%`);
    }
    if (p99Ms.regressed) {
      regressionDetails.push(`concurrency=${baseLevel.concurrency}: p99Ms regressed by +${p99Ms.percentageDelta}%`);
    }
    if (throughputTasksPerSec.regressed) {
      regressionDetails.push(
        `concurrency=${baseLevel.concurrency}: throughputTasksPerSec regressed by ${throughputTasksPerSec.percentageDelta}%`,
      );
    }
    if (heapDeltaMB.regressed) {
      regressionDetails.push(
        `concurrency=${baseLevel.concurrency}: heapDeltaMB regressed by +${heapDeltaMB.percentageDelta}%`,
      );
    }

    concurrencyComparisons.push({
      concurrency: baseLevel.concurrency,
      p50Ms,
      p95Ms,
      p99Ms,
      throughputTasksPerSec,
      heapDeltaMB,
    });
  }

  const subsystemComparisons: SubsystemMicrobenchmarkComparison = {
    cliStartupColdMs: computeDeltaEntry(
      baseline.subsystems.cliStartupColdMs,
      candidate.subsystems.cliStartupColdMs,
      true,
    ),
    cliStartupWarmP50Ms: computeDeltaEntry(
      baseline.subsystems.cliStartupWarmP50Ms,
      candidate.subsystems.cliStartupWarmP50Ms,
      true,
    ),
    engineInitP50Ms: computeDeltaEntry(
      baseline.subsystems.engineInitP50Ms,
      candidate.subsystems.engineInitP50Ms,
      true,
    ),
    storeWriteP50Ms: computeDeltaEntry(
      baseline.subsystems.storeWriteP50Ms,
      candidate.subsystems.storeWriteP50Ms,
      true,
    ),
    checkpointLookupP50Ms: computeDeltaEntry(
      baseline.subsystems.checkpointLookupP50Ms,
      candidate.subsystems.checkpointLookupP50Ms,
      true,
    ),
    toolDispatchP50Ms: computeDeltaEntry(
      baseline.subsystems.toolDispatchP50Ms,
      candidate.subsystems.toolDispatchP50Ms,
      true,
    ),
  };

  for (const [key, entry] of Object.entries(subsystemComparisons) as Array<[string, MetricDeltaEntry]>) {
    if (entry.regressed) {
      regressionDetails.push(`subsystem.${key}: regressed by +${entry.percentageDelta}%`);
    }
  }

  return {
    mode: baseline.mode,
    baselineSuiteId: baseline.suiteId,
    candidateSuiteId: candidate.suiteId,
    comparedAt: new Date().toISOString(),
    concurrencyComparisons,
    subsystemComparisons,
    hasRegressions: regressionDetails.length > 0,
    regressionDetails,
  };
}
