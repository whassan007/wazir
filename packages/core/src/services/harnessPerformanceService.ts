import type { KeyValueStore } from '@wazir/shared';
import type { AgentErrorKind, TerminationReason } from '../types/agent.js';
import type { CheckRunRecord, ExecutionRecord } from '../types/execution.js';
import type { ModelCapabilityCategory } from '../types/modelIntelligence.js';
import type { Task } from '../types/task.js';
import type { CostStatus } from '../types/telemetry.js';
import {
  ModelIntelligenceService,
  type HarnessModelCapabilityProfile,
  type HarnessProfileSegmentationKey,
} from './modelIntelligenceService.js';
import { TaskCapabilityClassifier } from './taskCapabilityClassifier.js';

export type { HarnessModelCapabilityProfile, HarnessProfileSegmentationKey };

const LOCAL_RUNTIME_IDS = new Set([
  'local',
  'lmstudio',
  'ollama',
  'llama.cpp',
  'llamacpp',
  'vllm',
  'mlx',
]);

/**
 * 95% confidence level z-score for Wilson score interval.
 */
const Z_95 = 1.959963984540054;

export interface UncertaintyInterval {
  /** Lower bound of the 95% Wilson score confidence interval in [0, 1]. */
  lowerBound: number;
  /** Upper bound of the 95% Wilson score confidence interval in [0, 1]. */
  upperBound: number;
  /** Width of the confidence interval (upperBound - lowerBound) in [0, 1]. */
  width: number;
  /** Confidence level (0.95). */
  confidenceLevel: number;
}

export type HarnessOutcomeClassification =
  | 'verified_success'
  | 'coding_failure'
  | 'unverified_completion'
  | 'provider_outage';

export interface HarnessPerformanceSegment {
  harnessId: string;
  modelId: string;
  runtimeId: string;
  taskCategory?: ModelCapabilityCategory | string;
  environment?: string;
  modelVersion?: string;
  harnessVersion?: string;
  quantization?: string;
  wazirProtocolVersion?: string;
}

export interface HarnessOutcomeInput {
  executionId: string;
  attemptId?: string;
  attempt?: number;
  retryCount?: number;
  firstAttemptSuccess?: boolean;

  harnessId: string;
  modelId: string;
  runtimeId: string;
  taskCategory?: ModelCapabilityCategory | string;
  task?: Partial<Task> & { description?: string; metadata?: Record<string, unknown> };
  objective?: string;
  environment?: string;

  modelVersion?: string;
  harnessVersion?: string;
  quantization?: string;
  wazirProtocolVersion?: string;

  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown' | string;
  /** True only when independent controller verification passed at final workspaceRevision. */
  verified?: boolean;
  workspaceRevision?: string | number;
  filesChanged?: string[];
  mutationRequired?: boolean;
  checks?: CheckRunRecord[];
  errors?: string[];

  terminationReason?: TerminationReason | string;
  errorKind?: AgentErrorKind | string;
  failureClassification?: string;

  costUSD?: number;
  costStatus?: CostStatus;
  durationMs?: number;
  firstTokenLatencyMs?: number;
  verificationDurationMs?: number;
  coldStartMs?: number;

  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
    costStatus?: CostStatus;
    durationMs?: number;
    firstTokenLatencyMs?: number;
    modelCalls?: number;
  };

  timestamp?: Date | string | number;
}

export interface RecordedExecutionSummary {
  executionId: string;
  harnessId: string;
  modelId: string;
  runtimeId: string;
  taskCategory: ModelCapabilityCategory;
  environment: string;
  attemptIds: string[];
  retryCount: number;
  firstAttemptSuccess: boolean;
  eventualVerifiedSuccess: boolean;
  latestClassification: HarnessOutcomeClassification;
  totalCostUSD?: number;
  costStatus?: CostStatus;
  totalDurationMs: number;
  updatedAt: string;
}

export interface HarnessPerformanceProfile {
  id: string;
  segmentKey: string;
  harnessId: string;
  modelId: string;
  runtimeId: string;
  taskCategory: ModelCapabilityCategory;
  environment: string;

  modelVersion: string;
  harnessVersion: string;
  quantization: string;
  wazirProtocolVersion: string;

  /** Total coding/task evaluation samples (verifiedSuccessCount + codingFailureCount). Excludes provider outages. */
  sampleCount: number;
  /** Executions where independent controller verification confirmed physical success. */
  verifiedSuccessCount: number;
  /** Executions that failed task/coding/verification requirements (includes unverified self-reported completions). */
  codingFailureCount: number;
  /** Subset of coding failures where the harness/model claimed completion without passing independent verification. */
  unverifiedCompletionCount: number;
  /** Provider/infrastructure outages (429 rate limit, ECONNREFUSED, timeout before response, etc.). */
  providerOutageCount: number;

  /** Empirical verified success probability in [0, 1] over coding samples (verifiedSuccessCount / sampleCount). */
  verifiedSuccessRate: number;
  /** Evidence-weighted coding capability score in [0, 1] (never penalized by provider outages). */
  capabilityScore: number;
  /** Infrastructure availability rate in [0, 1]: sampleCount / (sampleCount + providerOutageCount). */
  availabilityRate: number;

  /** Wilson score 95% confidence interval for verifiedSuccessRate. */
  uncertainty: UncertaintyInterval;
  /** Asymptotic statistical confidence in [0, 1]. */
  confidence: number;

  /** Total retry attempts recorded across executions in this segment. */
  retryCount: number;
  /** Number of executions that achieved verified success on their first attempt (0 retries). */
  firstAttemptSuccessCount: number;
  /** Number of executions that eventually achieved verified success (including after retries). */
  eventualVerifiedSuccessCount: number;
  /** Fraction of coding executions that succeeded on the first attempt. */
  firstAttemptSuccessRate: number;
  /** Fraction of coding executions that eventually achieved verified success. */
  eventualVerifiedSuccessRate: number;
  /** Whether the most recent execution in this profile succeeded on the first attempt. */
  firstAttemptSuccess: boolean;
  /** Whether the most recent execution in this profile achieved eventual verified success. */
  eventualVerifiedSuccess: boolean;

  /** Average monetary cost in USD across executions with known/estimated cost (undefined when all costs are UNKNOWN). */
  avgCostUSD?: number;
  /** Expected USD cost per verified success (undefined when cost is UNKNOWN or verifiedSuccessCount === 0). */
  costPerVerifiedSuccessUSD?: number;
  /** Number of executions with ACTUAL or ESTIMATED numeric cost. */
  knownCostSampleCount: number;
  /** Number of executions with UNKNOWN cost status. */
  unknownCostCount: number;

  /** Average execution latency in milliseconds. */
  avgDurationMs: number;
  /** Median (p50) execution latency in milliseconds. */
  p50DurationMs: number;
  /** 95th percentile (p95) execution latency in milliseconds. */
  p95DurationMs: number;
  /** Average first-token latency in milliseconds when reported. */
  avgFirstTokenLatencyMs?: number;

  /** True when sampleCount >= minSamples and profile is not stale. */
  hasSufficientEvidence: boolean;
  /** True when sampleCount < minSamples. */
  insufficientEvidence: boolean;
  /** Explanation when evidence is insufficient. */
  insufficientEvidenceReason?: string;

  /** True when version/protocol/environment drifted or profile age exceeds maxAgeMs. */
  isStale: boolean;
  /** Explanation when profile is flagged as stale. */
  staleReason?: string;

  lastUpdated: Date;
}

export interface HarnessPerformanceQueryOptions {
  maxAgeMs?: number;
  minSamples?: number;
  now?: Date | number;
}

export interface HarnessPerformanceServiceOptions {
  store?: KeyValueStore;
  modelIntelligence?: ModelIntelligenceService;
  classifier?: TaskCapabilityClassifier;
  defaultProtocolVersion?: string;
  defaultEnvironment?: string;
  /** Maximum age in milliseconds before a profile is flagged as stale (default: 7 days). */
  maxAgeMs?: number;
  /** Minimum coding samples required before evidence is considered sufficient (default: 3). */
  minSamples?: number;
  /** Clock provider for deterministic testing. */
  now?: () => number;
  /** Defer initial store restoration until `ready` or `restore()` is awaited. */
  lazy?: boolean;
}

interface InternalProfileState {
  profile: HarnessPerformanceProfile;
  totalCostUSD: number;
  totalDurationMs: number;
  durationSamples: number[];
  totalFirstTokenLatencyMs: number;
  firstTokenSamples: number;
  executions: Record<string, RecordedExecutionSummary>;
}

interface PersistedHarnessProfileEnvelope {
  schemaVersion: 1;
  profile: Omit<HarnessPerformanceProfile, 'lastUpdated'> & { lastUpdated: string };
  totalCostUSD: number;
  totalDurationMs: number;
  durationSamples: number[];
  totalFirstTokenLatencyMs: number;
  firstTokenSamples: number;
  executions: Record<string, RecordedExecutionSummary>;
}

/**
 * Computes the Wilson score confidence interval for a binomial proportion.
 */
export function computeWilsonInterval(
  successes: number,
  total: number,
  z: number = Z_95,
): UncertaintyInterval {
  if (total <= 0) {
    return {
      lowerBound: 0,
      upperBound: 1,
      width: 1,
      confidenceLevel: 0.95,
    };
  }

  const k = Math.max(0, Math.min(total, successes));
  const pHat = k / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (pHat + z2 / (2 * total)) / denom;
  const radical = Math.sqrt((pHat * (1 - pHat)) / total + z2 / (4 * total * total));
  const margin = (z * radical) / denom;

  const lowerBound = Number(Math.max(0, Math.min(1, center - margin)).toFixed(4));
  const upperBound = Number(Math.max(0, Math.min(1, center + margin)).toFixed(4));
  const width = Number(Math.max(0, upperBound - lowerBound).toFixed(4));

  return {
    lowerBound,
    upperBound,
    width,
    confidenceLevel: 0.95,
  };
}

/**
 * Detects whether a failure was caused by a provider or infrastructure outage
 * (rate limits, connection failures, network timeouts before model response, etc.)
 * rather than a model/harness coding capability failure.
 */
export function isProviderInfrastructureOutage(input: {
  errorKind?: string;
  terminationReason?: string;
  failureClassification?: string;
  errors?: string[];
}): boolean {
  if (input.errorKind === 'infrastructure') {
    return true;
  }
  const term = (input.terminationReason ?? '').toUpperCase();
  if (term === 'PROVIDER_OUTAGE' || term === 'INFRASTRUCTURE_ERROR' || term === 'RATE_LIMITED') {
    return true;
  }
  const fc = (input.failureClassification ?? '').toLowerCase();
  if (
    fc === 'provider_outage' ||
    fc === 'infrastructure' ||
    fc === 'rate_limit' ||
    fc === 'rate_limited' ||
    fc === 'connection_error' ||
    fc === 'timeout_before_response'
  ) {
    return true;
  }

  const combinedErrors = [
    input.terminationReason ?? '',
    input.failureClassification ?? '',
    ...(input.errors ?? []),
  ].join(' ');

  if (
    /\b(429|502|503|504)\b|rate[\s_-]?limit|too many requests|quota exceeded|econnrefused|econnreset|enotfound|etimedout|ehostunreach|connection refused|socket hang up|network error|bad gateway|service unavailable|provider[\s_-]?outage|timeout before (?:model )?response|upstream connect/i.test(
      combinedErrors,
    )
  ) {
    return true;
  }

  return false;
}

function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return Number(sortedValues[idx].toFixed(2));
}

export class HarnessPerformanceService {
  private _ready?: Promise<void>;
  private readonly store?: KeyValueStore;
  public readonly modelIntelligence: ModelIntelligenceService;
  public readonly classifier: TaskCapabilityClassifier;
  private readonly defaultProtocolVersion: string;
  private readonly defaultEnvironment: string;
  private readonly maxAgeMs: number;
  private readonly minSamples: number;
  private readonly nowFn: () => number;

  /** Active profile states indexed by internal storage segment key. */
  private readonly states = new Map<string, InternalProfileState>();
  /** Global index of execution summaries by `${harnessId}::${executionId}`. */
  private readonly executionsIndex = new Map<string, { stateKey: string; summary: RecordedExecutionSummary }>();
  /** Pending store write promises. */
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(options: HarnessPerformanceServiceOptions = {}) {
    this.store = options.store;
    this.classifier = options.classifier ?? new TaskCapabilityClassifier();
    this.modelIntelligence =
      options.modelIntelligence ??
      new ModelIntelligenceService({
        store: options.store,
        classifier: this.classifier,
        defaultProtocolVersion: options.defaultProtocolVersion,
      });
    this.defaultProtocolVersion = options.defaultProtocolVersion ?? '1.0.0';
    this.defaultEnvironment = options.defaultEnvironment ?? 'default';
    this.maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    this.minSamples = options.minSamples ?? 3;
    this.nowFn = options.now ?? (() => Date.now());

    if (!options.lazy && this.store) {
      void this.ready;
    }
  }

  public get ready(): Promise<void> {
    this._ready ??= this.restore();
    return this._ready;
  }

  /**
   * Flushes all in-flight asynchronous store persistence operations.
   */
  public async flush(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await Promise.all(Array.from(this.pendingWrites));
    }
  }

  /**
   * Restores persisted harness performance profiles from `KeyValueStore` under `harness-perf/`.
   */
  public async restore(): Promise<void> {
    if (!this.store) return;
    await this.flush();

    const entries = await this.store.list('harness-perf/');
    for (const { key, value } of entries) {
      if (!key.startsWith('harness-perf/') || !value || typeof value !== 'object') {
        continue;
      }
      const env = value as PersistedHarnessProfileEnvelope;
      if (env.schemaVersion !== 1 || !env.profile || typeof env.profile.segmentKey !== 'string') {
        continue;
      }

      const restoredProfile: HarnessPerformanceProfile = {
        ...env.profile,
        lastUpdated: new Date(env.profile.lastUpdated),
      };

      const stateKey = this.getInternalStateKey({
        harnessId: restoredProfile.harnessId,
        modelId: restoredProfile.modelId,
        runtimeId: restoredProfile.runtimeId,
        taskCategory: restoredProfile.taskCategory,
        environment: restoredProfile.environment,
        modelVersion: restoredProfile.modelVersion,
        harnessVersion: restoredProfile.harnessVersion,
        quantization: restoredProfile.quantization,
        wazirProtocolVersion: restoredProfile.wazirProtocolVersion,
      });

      const executions = env.executions ? structuredClone(env.executions) : {};
      const state: InternalProfileState = {
        profile: restoredProfile,
        totalCostUSD: env.totalCostUSD ?? 0,
        totalDurationMs: env.totalDurationMs ?? 0,
        durationSamples: Array.isArray(env.durationSamples) ? [...env.durationSamples] : [],
        totalFirstTokenLatencyMs: env.totalFirstTokenLatencyMs ?? 0,
        firstTokenSamples: env.firstTokenSamples ?? 0,
        executions,
      };

      this.states.set(stateKey, state);
      for (const [execId, summary] of Object.entries(executions)) {
        this.executionsIndex.set(`${restoredProfile.harnessId}::${execId}`, {
          stateKey,
          summary,
        });
      }
    }
  }

  /**
   * Canonical 5-part segment key for `(harnessId, modelId, runtimeId, taskCategory, environment)`.
   * Appends version qualifiers when non-default versions are explicitly segmented.
   */
  public getSegmentKey(segment: HarnessPerformanceSegment): string {
    const harnessId = segment.harnessId || 'native';
    const modelId = segment.modelId;
    const runtimeId = segment.runtimeId || 'default';
    const category = this.normalizeCategory(segment.taskCategory);
    const environment = segment.environment || this.defaultEnvironment;
    return `${harnessId}::${modelId}::${runtimeId}::${category}::${environment}`;
  }

  private getInternalStateKey(segment: HarnessPerformanceSegment): string {
    const base = this.getSegmentKey(segment);
    const modelVer = segment.modelVersion ?? 'default';
    const harnessVer = segment.harnessVersion ?? 'default';
    const quant = segment.quantization ?? 'default';
    const proto = segment.wazirProtocolVersion || this.defaultProtocolVersion;
    if (
      modelVer === 'default' &&
      harnessVer === 'default' &&
      quant === 'default' &&
      proto === this.defaultProtocolVersion
    ) {
      return base;
    }
    return `${base}::${modelVer}::${harnessVer}::${quant}::${proto}`;
  }

  public classifyTaskCategory(input: {
    taskCategory?: ModelCapabilityCategory | string;
    task?: Partial<Task> & { description?: string; metadata?: Record<string, unknown> };
    objective?: string;
  }): ModelCapabilityCategory {
    if (input.taskCategory) {
      return this.normalizeCategory(input.taskCategory);
    }
    if (input.task) {
      const syntheticTask: Task = {
        id: input.task.id ?? 'ad-hoc',
        type: input.task.type ?? 'coding',
        title: input.task.title ?? input.objective ?? '',
        input: input.task.input ?? input.objective ?? '',
        requirements: input.task.requirements ?? {},
        priority: input.task.priority ?? 'normal',
        status: input.task.status ?? 'pending',
        createdAt: input.task.createdAt ?? new Date(this.nowFn()),
        ...(input.task.description ? { description: input.task.description } : {}),
        ...(input.task.metadata ? { metadata: input.task.metadata } : {}),
      } as Task;
      return this.classifier.classify(syntheticTask).primaryCategory;
    }
    if (input.objective) {
      return this.modelIntelligence.classifyTask(input.objective).primaryCategory;
    }
    return 'implementation';
  }

  private normalizeCategory(category?: ModelCapabilityCategory | string): ModelCapabilityCategory {
    if (!category) return 'implementation';
    return category as ModelCapabilityCategory;
  }

  /**
   * Evaluates whether an outcome achieved independent controller verification.
   * Self-reported completion (`status === 'completed'`) without physical verification
   * is NEVER counted as `verifiedSuccess`.
   */
  private evaluateIndependentVerification(input: HarnessOutcomeInput): boolean {
    const errors = input.errors ?? [];
    if (errors.length > 0) {
      return false;
    }

    if (
      input.terminationReason &&
      input.terminationReason !== 'COMPLETED' &&
      input.terminationReason !== 'VERIFICATION_PASSED'
    ) {
      return false;
    }

    if (input.status && input.status !== 'completed') {
      return false;
    }

    const checks = input.checks ?? [];
    if (checks.length > 0) {
      const allChecksPassed = checks.every((c) => c.ok);
      if (!allChecksPassed) {
        return false;
      }
      // Verify check revisions are not stale relative to final workspaceRevision when both are numeric
      const finalRev =
        typeof input.workspaceRevision === 'number'
          ? input.workspaceRevision
          : typeof input.workspaceRevision === 'string' && /^\d+$/.test(input.workspaceRevision)
            ? Number.parseInt(input.workspaceRevision, 10)
            : undefined;
      if (finalRev !== undefined) {
        const hasStaleCheck = checks.some(
          (c) => c.workspaceRevision !== undefined && c.workspaceRevision < finalRev,
        );
        if (hasStaleCheck) {
          return false;
        }
      }
    }

    // Explicit controller verification flag
    if (input.verified === true) {
      return true;
    }
    if (input.verified === false) {
      return false;
    }

    // When `verified` is omitted, require non-empty passing checks at final revision
    if (checks.length > 0) {
      if (input.mutationRequired === true && (input.filesChanged?.length ?? 0) === 0) {
        return false;
      }
      return true;
    }

    // Self-reported completion without independent verification checks or verified===true fails closed
    return false;
  }

  /**
   * Records an execution outcome into the empirical `(harnessId, modelId, runtimeId, taskCategory, environment)` profile.
   */
  public recordOutcome(
    input: HarnessOutcomeInput,
  ): HarnessPerformanceProfile & PromiseLike<HarnessPerformanceProfile> {
    const taskCategory = this.classifyTaskCategory({
      taskCategory: input.taskCategory,
      task: input.task,
      objective: input.objective,
    });
    const environment = input.environment || this.defaultEnvironment;
    const segment: HarnessPerformanceSegment = {
      harnessId: input.harnessId || 'native',
      modelId: input.modelId,
      runtimeId: input.runtimeId || 'default',
      taskCategory,
      environment,
      modelVersion: input.modelVersion ?? 'default',
      harnessVersion: input.harnessVersion ?? 'default',
      quantization: input.quantization ?? 'default',
      wazirProtocolVersion: input.wazirProtocolVersion || this.defaultProtocolVersion,
    };

    const state = this.getOrCreateState(segment);
    const { profile } = state;

    const executionId = input.executionId;
    const attemptId =
      input.attemptId ??
      (input.attempt !== undefined ? `attempt-${input.attempt}` : 'attempt-1');

    const existingExec = state.executions[executionId];
    if (existingExec && existingExec.attemptIds.includes(attemptId)) {
      // Exact duplicate (executionId, attemptId) -> idempotent no-op
      return this.attachThenable(this.applyStalenessAndThresholds(profile), Promise.resolve());
    }

    // Classify outcome: provider/infrastructure outage vs verified success vs coding failure
    const isOutage = isProviderInfrastructureOutage({
      errorKind: input.errorKind,
      terminationReason: input.terminationReason,
      failureClassification: input.failureClassification,
      errors: input.errors,
    });

    let classification: HarnessOutcomeClassification;
    if (isOutage) {
      classification = 'provider_outage';
    } else if (this.evaluateIndependentVerification(input)) {
      classification = 'verified_success';
    } else if ((input.status === 'completed' || input.status === undefined) && input.verified !== true) {
      classification = 'unverified_completion';
    } else {
      classification = 'coding_failure';
    }

    // Extract cost & latency
    const rawCostUSD = input.costUSD ?? input.usage?.costUSD;
    const rawCostStatus = input.costStatus ?? input.usage?.costStatus;
    const isLocalRuntime = LOCAL_RUNTIME_IDS.has(segment.runtimeId.toLowerCase());
    const effectiveCostStatus: CostStatus =
      rawCostStatus ??
      (typeof rawCostUSD === 'number'
        ? 'ACTUAL'
        : isLocalRuntime
          ? 'ACTUAL'
          : 'UNKNOWN');
    const effectiveCostUSD: number | undefined =
      effectiveCostStatus === 'UNKNOWN'
        ? undefined
        : typeof rawCostUSD === 'number' && Number.isFinite(rawCostUSD)
          ? rawCostUSD
          : isLocalRuntime
            ? 0
            : undefined;

    const durationMs = Math.max(0, input.durationMs ?? input.usage?.durationMs ?? 0);
    const firstTokenMs = input.firstTokenLatencyMs ?? input.usage?.firstTokenLatencyMs;
    const nowMs =
      input.timestamp instanceof Date
        ? input.timestamp.getTime()
        : typeof input.timestamp === 'number'
          ? input.timestamp
          : typeof input.timestamp === 'string'
            ? new Date(input.timestamp).getTime()
            : this.nowFn();

    if (!existingExec) {
      // First time seeing this executionId in this segment
      const explicitRetries = Math.max(
        0,
        input.retryCount ?? (input.attempt !== undefined && input.attempt > 1 ? input.attempt - 1 : 0),
      );
      const isVerifiedSuccess = classification === 'verified_success';
      const firstAttemptSucceeded =
        input.firstAttemptSuccess !== undefined
          ? input.firstAttemptSuccess && isVerifiedSuccess
          : isVerifiedSuccess && explicitRetries === 0;

      const summary: RecordedExecutionSummary = {
        executionId,
        harnessId: segment.harnessId,
        modelId: segment.modelId,
        runtimeId: segment.runtimeId,
        taskCategory,
        environment,
        attemptIds: [attemptId],
        retryCount: explicitRetries,
        firstAttemptSuccess: firstAttemptSucceeded,
        eventualVerifiedSuccess: isVerifiedSuccess,
        latestClassification: classification,
        totalCostUSD: effectiveCostUSD,
        costStatus: effectiveCostStatus,
        totalDurationMs: durationMs,
        updatedAt: new Date(nowMs).toISOString(),
      };
      state.executions[executionId] = summary;
      this.executionsIndex.set(`${segment.harnessId}::${executionId}`, {
        stateKey: this.getInternalStateKey(segment),
        summary,
      });

      if (classification === 'provider_outage') {
        profile.providerOutageCount += 1;
      } else if (classification === 'verified_success') {
        profile.sampleCount += 1;
        profile.verifiedSuccessCount += 1;
        if (firstAttemptSucceeded) {
          profile.firstAttemptSuccessCount += 1;
        }
        profile.eventualVerifiedSuccessCount += 1;
      } else {
        profile.sampleCount += 1;
        profile.codingFailureCount += 1;
        if (classification === 'unverified_completion') {
          profile.unverifiedCompletionCount += 1;
        }
      }

      profile.retryCount += explicitRetries;
      profile.firstAttemptSuccess = firstAttemptSucceeded;
      profile.eventualVerifiedSuccess = isVerifiedSuccess;

      if (effectiveCostUSD !== undefined) {
        state.totalCostUSD += effectiveCostUSD;
        profile.knownCostSampleCount += 1;
      } else if (effectiveCostStatus === 'UNKNOWN') {
        profile.unknownCostCount += 1;
      }

      state.totalDurationMs += durationMs;
      state.durationSamples.push(durationMs);
      if (typeof firstTokenMs === 'number' && Number.isFinite(firstTokenMs)) {
        state.totalFirstTokenLatencyMs += firstTokenMs;
        state.firstTokenSamples += 1;
      }
    } else {
      // Subsequent attempt (retry) for an already-tracked executionId
      existingExec.attemptIds.push(attemptId);
      const addedRetries =
        input.retryCount !== undefined && input.retryCount > existingExec.retryCount
          ? input.retryCount - existingExec.retryCount
          : 1;
      existingExec.retryCount += addedRetries;
      profile.retryCount += addedRetries;

      const prevClassification = existingExec.latestClassification;
      existingExec.latestClassification = classification;
      existingExec.totalDurationMs += durationMs;
      existingExec.updatedAt = new Date(nowMs).toISOString();

      // Update duration total for the existing execution sample
      state.totalDurationMs += durationMs;
      if (state.durationSamples.length > 0) {
        state.durationSamples[state.durationSamples.length - 1] += durationMs;
      } else {
        state.durationSamples.push(durationMs);
      }

      if (effectiveCostUSD !== undefined) {
        if (existingExec.totalCostUSD !== undefined) {
          existingExec.totalCostUSD += effectiveCostUSD;
          state.totalCostUSD += effectiveCostUSD;
        } else {
          existingExec.totalCostUSD = effectiveCostUSD;
          existingExec.costStatus = effectiveCostStatus;
          state.totalCostUSD += effectiveCostUSD;
          profile.knownCostSampleCount += 1;
          if (profile.unknownCostCount > 0) {
            profile.unknownCostCount -= 1;
          }
        }
      }

      if (classification === 'provider_outage') {
        profile.providerOutageCount += 1;
      } else if (classification === 'verified_success') {
        if (prevClassification === 'coding_failure' || prevClassification === 'unverified_completion') {
          // Transition this execution from coding failure to eventual verified success without double-counting sampleCount
          profile.codingFailureCount = Math.max(0, profile.codingFailureCount - 1);
          profile.verifiedSuccessCount += 1;
          if (!existingExec.eventualVerifiedSuccess) {
            existingExec.eventualVerifiedSuccess = true;
            profile.eventualVerifiedSuccessCount += 1;
          }
        } else if (prevClassification === 'provider_outage') {
          // Previous attempt was an outage; now we have a coding sample
          profile.sampleCount += 1;
          profile.verifiedSuccessCount += 1;
          existingExec.eventualVerifiedSuccess = true;
          profile.eventualVerifiedSuccessCount += 1;
        }
      } else {
        // Coding failure or unverified completion on retry
        if (prevClassification === 'provider_outage') {
          profile.sampleCount += 1;
          profile.codingFailureCount += 1;
        } else if (prevClassification === 'verified_success') {
          // Regression on subsequent attempt
          profile.verifiedSuccessCount = Math.max(0, profile.verifiedSuccessCount - 1);
          profile.codingFailureCount += 1;
          if (existingExec.eventualVerifiedSuccess) {
            existingExec.eventualVerifiedSuccess = false;
            profile.eventualVerifiedSuccessCount = Math.max(0, profile.eventualVerifiedSuccessCount - 1);
          }
        }
        if (classification === 'unverified_completion') {
          profile.unverifiedCompletionCount += 1;
        }
      }

      profile.firstAttemptSuccess = existingExec.firstAttemptSuccess;
      profile.eventualVerifiedSuccess = existingExec.eventualVerifiedSuccess;
    }

    // Recompute derived metrics on the profile
    this.recomputeProfileMetrics(state, new Date(nowMs));

    // Synchronize coding outcomes (excluding provider outages) into ModelIntelligenceService
    if (classification !== 'provider_outage') {
      this.syncToModelIntelligence(input, segment, classification === 'verified_success');
    }

    const writePromise = this.persistState(state);
    return this.attachThenable(this.applyStalenessAndThresholds(profile), writePromise);
  }

  /**
   * Ingests an `ExecutionRecord` or `HarnessOutcomeInput` and updates harness + model intelligence profiles.
   */
  public recordExecution(
    recordOrOutcome: ExecutionRecord | HarnessOutcomeInput,
    segment?: Partial<HarnessPerformanceSegment> & {
      harnessId?: string;
      model?: string;
      runtime?: string;
      attemptId?: string;
      attempt?: number;
      retryCount?: number;
      verified?: boolean;
      costUSD?: number;
      costStatus?: CostStatus;
      durationMs?: number;
      errorKind?: AgentErrorKind | string;
      terminationReason?: TerminationReason | string;
      failureClassification?: string;
    },
  ): HarnessPerformanceProfile & PromiseLike<HarnessPerformanceProfile> {
    if (!this.isExecutionRecord(recordOrOutcome)) {
      return this.recordOutcome({
        ...recordOrOutcome,
        ...(segment
          ? {
              harnessId: segment.harnessId ?? recordOrOutcome.harnessId,
              modelId: segment.modelId ?? segment.model ?? recordOrOutcome.modelId,
              runtimeId: segment.runtimeId ?? segment.runtime ?? recordOrOutcome.runtimeId,
              taskCategory: segment.taskCategory ?? recordOrOutcome.taskCategory,
              environment: segment.environment ?? recordOrOutcome.environment,
              modelVersion: segment.modelVersion ?? recordOrOutcome.modelVersion,
              harnessVersion: segment.harnessVersion ?? recordOrOutcome.harnessVersion,
              quantization: segment.quantization ?? recordOrOutcome.quantization,
              wazirProtocolVersion: segment.wazirProtocolVersion ?? recordOrOutcome.wazirProtocolVersion,
              attemptId: segment.attemptId ?? recordOrOutcome.attemptId,
              attempt: segment.attempt ?? recordOrOutcome.attempt,
              retryCount: segment.retryCount ?? recordOrOutcome.retryCount,
              verified: segment.verified ?? recordOrOutcome.verified,
              costUSD: segment.costUSD ?? recordOrOutcome.costUSD,
              costStatus: segment.costStatus ?? recordOrOutcome.costStatus,
              durationMs: segment.durationMs ?? recordOrOutcome.durationMs,
              errorKind: segment.errorKind ?? recordOrOutcome.errorKind,
              terminationReason: segment.terminationReason ?? recordOrOutcome.terminationReason,
              failureClassification: segment.failureClassification ?? recordOrOutcome.failureClassification,
            }
          : {}),
      });
    }

    const record = recordOrOutcome;
    const harnessId =
      segment?.harnessId ??
      ((record.execution as unknown as Record<string, unknown>).harnessId as string | undefined) ??
      record.execution.agentId ??
      'native';
    const modelId = segment?.modelId ?? segment?.model ?? record.execution.modelId;
    const runtimeId = segment?.runtimeId ?? segment?.runtime ?? record.execution.runtimeId;
    const classification = this.classifier.classify(record.task);
    const taskCategory = segment?.taskCategory ?? classification.primaryCategory;
    const environment = segment?.environment ?? this.defaultEnvironment;

    // Extract termination / error metadata from events if present
    const termEvent = [...(record.events ?? [])]
      .reverse()
      .find((e) => (e.eventType ?? e.type) === 'termination.completed');
    const termData = (termEvent?.data ?? {}) as {
      reason?: TerminationReason;
      errorKind?: AgentErrorKind;
    };
    const retryEvents = (record.events ?? []).filter((e) => {
      const t = e.eventType ?? e.type;
      return t === 'retry.scheduled' || (t as string) === 'repair.cycle';
    }).length;

    const checks = record.checks ?? [];
    const errors = record.errors ?? [];
    const filesChanged = record.filesChanged ?? [];
    const finalWorkspaceRev = record.workspaceState?.revision;

    let verified = segment?.verified;
    if (verified === undefined && record.evaluation) {
      const checksOk = checks.length === 0 || checks.every((c) => c.ok);
      const staleCheck =
        finalWorkspaceRev !== undefined &&
        checks.some((c) => c.workspaceRevision !== undefined && c.workspaceRevision < finalWorkspaceRev);
      verified = record.evaluation.success && errors.length === 0 && checksOk && !staleCheck;
    }

    const startedMs = record.execution.startedAt
      ? new Date(record.execution.startedAt).getTime()
      : record.execution.createdAt
        ? new Date(record.execution.createdAt).getTime()
        : undefined;
    const completedMs = record.execution.completedAt
      ? new Date(record.execution.completedAt).getTime()
      : undefined;
    const toolAndCheckDuration =
      (record.toolCalls ?? []).reduce((sum, tc) => sum + (tc.durationMs ?? 0), 0) +
      checks.reduce((sum, ch) => sum + (ch.durationMs ?? 0), 0);
    const durationMs =
      segment?.durationMs ??
      (startedMs !== undefined && completedMs !== undefined && completedMs >= startedMs
        ? completedMs - startedMs
        : toolAndCheckDuration);

    return this.recordOutcome({
      executionId: record.execution.id,
      attemptId: segment?.attemptId,
      attempt: segment?.attempt,
      retryCount: segment?.retryCount ?? retryEvents,
      harnessId,
      modelId,
      runtimeId,
      taskCategory,
      task: record.task,
      environment,
      modelVersion: segment?.modelVersion,
      harnessVersion: segment?.harnessVersion,
      quantization: segment?.quantization,
      wazirProtocolVersion: segment?.wazirProtocolVersion,
      status: record.execution.status,
      verified,
      workspaceRevision: finalWorkspaceRev,
      filesChanged,
      mutationRequired: (record.task as unknown as Record<string, unknown>).mutationRequired as
        | boolean
        | undefined,
      checks,
      errors,
      terminationReason: segment?.terminationReason ?? termData.reason,
      errorKind: segment?.errorKind ?? termData.errorKind,
      failureClassification: segment?.failureClassification,
      costUSD: segment?.costUSD,
      costStatus: segment?.costStatus,
      durationMs,
      timestamp: record.execution.completedAt ?? record.execution.createdAt,
    });
  }

  /**
   * Retrieves the empirical performance profile for `(harnessId, modelId, runtimeId, taskCategory, environment)`.
   * Flags configuration drift (modelVersion, harnessVersion, quantization, protocol, environment) or expired age (`maxAgeMs`).
   */
  public getProfile(
    segment: HarnessPerformanceSegment,
    options: HarnessPerformanceQueryOptions = {},
  ): HarnessPerformanceProfile | undefined {
    const targetInternalKey = this.getInternalStateKey(segment);
    const exact = this.states.get(targetInternalKey);
    if (exact) {
      return this.applyStalenessAndThresholds(exact.profile, options);
    }

    const reqHarness = segment.harnessId || 'native';
    const reqModel = segment.modelId;
    const reqRuntime = segment.runtimeId || 'default';
    const reqCategory = segment.taskCategory
      ? this.normalizeCategory(segment.taskCategory)
      : undefined;
    const reqEnv = segment.environment || this.defaultEnvironment;

    // 1. Check if caller omitted version/quantization qualifiers and an active profile exists for the same 5-tuple
    const hasExplicitVersionFilter =
      segment.modelVersion !== undefined ||
      segment.harnessVersion !== undefined ||
      segment.quantization !== undefined ||
      segment.wazirProtocolVersion !== undefined;

    if (!hasExplicitVersionFilter) {
      const candidates: InternalProfileState[] = [];
      for (const state of this.states.values()) {
        const p = state.profile;
        if (
          p.harnessId === reqHarness &&
          p.modelId === reqModel &&
          p.runtimeId === reqRuntime &&
          (reqCategory === undefined || p.taskCategory === reqCategory) &&
          p.environment === reqEnv
        ) {
          candidates.push(state);
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.profile.lastUpdated.getTime() - a.profile.lastUpdated.getTime());
        return this.applyStalenessAndThresholds(candidates[0].profile, options);
      }
    }

    // 2. Check for configuration or environment drift across profiles for the same (harnessId, modelId, runtimeId, taskCategory)
    for (const state of this.states.values()) {
      const p = state.profile;
      if (
        p.harnessId === reqHarness &&
        p.modelId === reqModel &&
        p.runtimeId === reqRuntime &&
        (reqCategory === undefined || p.taskCategory === reqCategory)
      ) {
        const reqModelVer = segment.modelVersion ?? p.modelVersion;
        const reqHarnessVer = segment.harnessVersion ?? p.harnessVersion;
        const reqQuant = segment.quantization ?? p.quantization;
        const reqProto = segment.wazirProtocolVersion ?? p.wazirProtocolVersion;

        const driftedFields: string[] = [];
        if (p.modelVersion !== reqModelVer) {
          driftedFields.push(`modelVersion: ${p.modelVersion} -> ${reqModelVer}`);
        }
        if (p.harnessVersion !== reqHarnessVer) {
          driftedFields.push(`harnessVersion: ${p.harnessVersion} -> ${reqHarnessVer}`);
        }
        if (p.quantization !== reqQuant) {
          driftedFields.push(`quantization: ${p.quantization} -> ${reqQuant}`);
        }
        if (p.wazirProtocolVersion !== reqProto) {
          driftedFields.push(`wazirProtocolVersion: ${p.wazirProtocolVersion} -> ${reqProto}`);
        }
        if (segment.environment !== undefined && p.environment !== segment.environment) {
          driftedFields.push(`environment: ${p.environment} -> ${segment.environment}`);
        }

        if (driftedFields.length > 0) {
          const baseView = this.applyStalenessAndThresholds(p, options);
          return {
            ...baseView,
            isStale: true,
             hasSufficientEvidence: false,
            staleReason: `Profile configuration drift (${driftedFields.join(', ')})`,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Lists all tracked harness performance profiles matching an optional filter.
   */
  public listProfiles(
    filter?: Partial<HarnessPerformanceSegment>,
    options: HarnessPerformanceQueryOptions = {},
  ): HarnessPerformanceProfile[] {
    const results: HarnessPerformanceProfile[] = [];
    for (const state of this.states.values()) {
      const p = state.profile;
      if (filter?.harnessId && p.harnessId !== filter.harnessId) continue;
      if (filter?.modelId && p.modelId !== filter.modelId) continue;
      if (filter?.runtimeId && p.runtimeId !== filter.runtimeId) continue;
      if (filter?.taskCategory && p.taskCategory !== filter.taskCategory) continue;
      if (filter?.environment && p.environment !== filter.environment) continue;
      results.push(this.applyStalenessAndThresholds(p, options));
    }
    return results;
  }

  /**
   * Compares all harnesses that have measured profiles for the given `(modelId, runtimeId, taskCategory, environment)`,
   * ordered by lower confidence bound of verified success rate descending.
   */
  public compareHarnesses(
    query: {
      modelId: string;
      runtimeId: string;
      taskCategory?: ModelCapabilityCategory | string;
      environment?: string;
    },
    options: HarnessPerformanceQueryOptions = {},
  ): HarnessPerformanceProfile[] {
    const profiles = this.listProfiles(
      {
        modelId: query.modelId,
        runtimeId: query.runtimeId,
        taskCategory: query.taskCategory,
        environment: query.environment,
      },
      options,
    );
    return profiles.sort(
      (a, b) =>
        b.uncertainty.lowerBound - a.uncertainty.lowerBound ||
        b.verifiedSuccessRate - a.verifiedSuccessRate ||
        a.harnessId.localeCompare(b.harnessId),
    );
  }

  /**
   * Retrieves the deduplicated execution summary for a given `executionId`.
   */
  public getExecutionSummary(
    executionId: string,
    harnessId?: string,
  ): RecordedExecutionSummary | undefined {
    if (harnessId) {
      const entry = this.executionsIndex.get(`${harnessId}::${executionId}`);
      return entry ? structuredClone(entry.summary) : undefined;
    }
    for (const [key, entry] of this.executionsIndex.entries()) {
      if (key.endsWith(`::${executionId}`)) {
        return structuredClone(entry.summary);
      }
    }
    return undefined;
  }

  private getOrCreateState(segment: HarnessPerformanceSegment): InternalProfileState {
    const stateKey = this.getInternalStateKey(segment);
    let state = this.states.get(stateKey);
    if (!state) {
      const segmentKey = this.getSegmentKey(segment);
      const category = this.normalizeCategory(segment.taskCategory);
      const environment = segment.environment || this.defaultEnvironment;
      const initialUncertainty = computeWilsonInterval(0, 0);

      const profile: HarnessPerformanceProfile = {
        id: stateKey,
        segmentKey,
        harnessId: segment.harnessId || 'native',
        modelId: segment.modelId,
        runtimeId: segment.runtimeId || 'default',
        taskCategory: category,
        environment,
        modelVersion: segment.modelVersion ?? 'default',
        harnessVersion: segment.harnessVersion ?? 'default',
        quantization: segment.quantization ?? 'default',
        wazirProtocolVersion: segment.wazirProtocolVersion || this.defaultProtocolVersion,
        sampleCount: 0,
        verifiedSuccessCount: 0,
        codingFailureCount: 0,
        unverifiedCompletionCount: 0,
        providerOutageCount: 0,
        verifiedSuccessRate: 0,
        capabilityScore: 0.5,
        availabilityRate: 1,
        uncertainty: initialUncertainty,
        confidence: 0,
        retryCount: 0,
        firstAttemptSuccessCount: 0,
        eventualVerifiedSuccessCount: 0,
        firstAttemptSuccessRate: 0,
        eventualVerifiedSuccessRate: 0,
        firstAttemptSuccess: false,
        eventualVerifiedSuccess: false,
        avgCostUSD: undefined,
        costPerVerifiedSuccessUSD: undefined,
        knownCostSampleCount: 0,
        unknownCostCount: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        avgFirstTokenLatencyMs: undefined,
        hasSufficientEvidence: false,
        insufficientEvidence: true,
        insufficientEvidenceReason: `Insufficient verified samples (0 < ${this.minSamples})`,
        isStale: false,
        lastUpdated: new Date(this.nowFn()),
      };

      state = {
        profile,
        totalCostUSD: 0,
        totalDurationMs: 0,
        durationSamples: [],
        totalFirstTokenLatencyMs: 0,
        firstTokenSamples: 0,
        executions: {},
      };
      this.states.set(stateKey, state);
    }
    return state;
  }

  private recomputeProfileMetrics(state: InternalProfileState, updatedAt: Date): void {
    const { profile } = state;
    const n = profile.sampleCount;
    const k = profile.verifiedSuccessCount;

    profile.verifiedSuccessRate = n > 0 ? Number((k / n).toFixed(4)) : 0;
    profile.uncertainty = computeWilsonInterval(k, n);
    profile.confidence =
      n > 0 ? Number((1 - 1 / Math.sqrt(1 + n / 1.5)).toFixed(3)) : 0;

    profile.firstAttemptSuccessRate =
      n > 0 ? Number((profile.firstAttemptSuccessCount / n).toFixed(4)) : 0;
    profile.eventualVerifiedSuccessRate =
      n > 0 ? Number((profile.eventualVerifiedSuccessCount / n).toFixed(4)) : 0;

    // Capability score combines verifiedSuccessRate and firstAttemptSuccessRate, never penalized by providerOutageCount
    if (n > 0) {
      const retryPenalty = Math.min(0.25, (profile.retryCount / Math.max(1, n)) * 0.08);
      const rawCapability =
        profile.verifiedSuccessRate * 0.75 +
        profile.firstAttemptSuccessRate * 0.25 -
        retryPenalty;
      profile.capabilityScore = Number(Math.max(0, Math.min(1, rawCapability)).toFixed(4));
    } else {
      profile.capabilityScore = 0.5;
    }

    const totalWithOutages = n + profile.providerOutageCount;
    profile.availabilityRate =
      totalWithOutages > 0 ? Number((n / totalWithOutages).toFixed(4)) : 1;

    if (profile.knownCostSampleCount > 0) {
      profile.avgCostUSD = Number(
        (state.totalCostUSD / profile.knownCostSampleCount).toFixed(6),
      );
      profile.costPerVerifiedSuccessUSD =
        k > 0 ? Number((state.totalCostUSD / k).toFixed(6)) : undefined;
    } else if (profile.unknownCostCount > 0) {
      profile.avgCostUSD = undefined;
      profile.costPerVerifiedSuccessUSD = undefined;
    } else {
      profile.avgCostUSD = 0;
      profile.costPerVerifiedSuccessUSD = undefined;
    }

    const durCount = state.durationSamples.length;
    if (durCount > 0) {
      profile.avgDurationMs = Number((state.totalDurationMs / durCount).toFixed(2));
      const sorted = [...state.durationSamples].sort((a, b) => a - b);
      profile.p50DurationMs = computePercentile(sorted, 50);
      profile.p95DurationMs = computePercentile(sorted, 95);
    } else {
      profile.avgDurationMs = 0;
      profile.p50DurationMs = 0;
      profile.p95DurationMs = 0;
    }

    if (state.firstTokenSamples > 0) {
      profile.avgFirstTokenLatencyMs = Number(
        (state.totalFirstTokenLatencyMs / state.firstTokenSamples).toFixed(2),
      );
    }

    profile.insufficientEvidence = n < this.minSamples;
    profile.insufficientEvidenceReason = profile.insufficientEvidence
      ? `Insufficient verified samples (${n} < ${this.minSamples})`
      : undefined;
    profile.hasSufficientEvidence = !profile.insufficientEvidence && !profile.isStale;

    profile.lastUpdated = updatedAt;
  }

  private applyStalenessAndThresholds(
    profile: HarnessPerformanceProfile,
    options: HarnessPerformanceQueryOptions = {},
  ): HarnessPerformanceProfile {
    const maxAgeMs = options.maxAgeMs ?? this.maxAgeMs;
    const minSamples = options.minSamples ?? this.minSamples;
    const nowMs =
      options.now instanceof Date
        ? options.now.getTime()
        : typeof options.now === 'number'
          ? options.now
          : this.nowFn();

    const ageMs = Math.max(0, nowMs - profile.lastUpdated.getTime());
    const isAgeStale = ageMs > maxAgeMs;
    const isStale = Boolean(profile.isStale || isAgeStale);
    const staleReason = profile.staleReason
      ? profile.staleReason
      : isAgeStale
        ? `Profile age (${ageMs}ms) exceeds maxAgeMs (${maxAgeMs}ms)`
        : undefined;

    const insufficientEvidence = profile.sampleCount < minSamples;
    const insufficientEvidenceReason = insufficientEvidence
      ? `Insufficient verified samples (${profile.sampleCount} < ${minSamples})`
      : undefined;

    return {
      ...profile,
      uncertainty: { ...profile.uncertainty },
      isStale,
      staleReason,
      insufficientEvidence,
      insufficientEvidenceReason,
      hasSufficientEvidence: !insufficientEvidence && !isStale,
    };
  }

  private syncToModelIntelligence(
    input: HarnessOutcomeInput,
    segment: HarnessPerformanceSegment,
    verifiedSuccess: boolean,
  ): void {
    const segKey: HarnessProfileSegmentationKey = {
      model: segment.modelId,
      runtime: segment.runtimeId,
      quantization: segment.quantization,
      modelVersion: segment.modelVersion,
      wazirProtocolVersion: segment.wazirProtocolVersion || this.defaultProtocolVersion,
      harnessId: segment.harnessId,
      environment: segment.environment,
    };

    const syntheticRecord: ExecutionRecord = {
      execution: {
        id: `${input.executionId}::${ input.attemptId ?? input.attempt ?? 1 }`,
        taskId: input.task?.id ?? 'task-perf',
        runtimeId: segment.runtimeId,
        modelId: segment.modelId,
        status: verifiedSuccess ? 'completed' : 'failed',
        createdAt: new Date(this.nowFn()),
      },
      task: {
        id: input.task?.id ?? 'task-perf',
        type: input.task?.type ?? 'coding',
        title: input.task?.title ?? input.objective ?? String(segment.taskCategory ?? 'implementation'),
        input: input.task?.input ?? input.objective ?? String(segment.taskCategory ?? 'implementation'),
        requirements: input.task?.requirements ?? {},
        priority: input.task?.priority ?? 'normal',
        status: verifiedSuccess ? 'completed' : 'failed',
        createdAt: new Date(this.nowFn()),
        metadata: {
          ...(input.task?.metadata ?? {}),
          capabilityCategory: segment.taskCategory,
        },
      } as unknown as Task,
      policyDecisions: [],
      toolCalls: [],
      filesChanged: verifiedSuccess ? (input.filesChanged?.length ? input.filesChanged : ['verified.ts']) : [],
      checks: [
        {
          name: 'test',
          command: 'verify',
          ok: verifiedSuccess,
          output: verifiedSuccess ? 'ok' : 'failed',
          durationMs: input.verificationDurationMs ?? 10,
        },
      ],
      errors: verifiedSuccess ? [] : input.errors?.length ? input.errors : ['Verification failed'],
      events: [],
    };

    this.modelIntelligence.recordExecution(syntheticRecord, segKey);
  }

  private persistState(state: InternalProfileState): Promise<void> {
    if (!this.store) {
      return Promise.resolve();
    }

    const storageKey = `harness-perf/${state.profile.segmentKey}`;
    const envelope: PersistedHarnessProfileEnvelope = {
      schemaVersion: 1,
      profile: {
        ...state.profile,
        lastUpdated: state.profile.lastUpdated.toISOString(),
      },
      totalCostUSD: state.totalCostUSD,
      totalDurationMs: state.totalDurationMs,
      durationSamples: [...state.durationSamples],
      totalFirstTokenLatencyMs: state.totalFirstTokenLatencyMs,
      firstTokenSamples: state.firstTokenSamples,
      executions: structuredClone(state.executions),
    };

    const p = this.store.put(storageKey, envelope);
    this.pendingWrites.add(p);
    void p.finally(() => {
      this.pendingWrites.delete(p);
    });
    return p;
  }

  private attachThenable(
    profile: HarnessPerformanceProfile,
    writePromise: Promise<void>,
  ): HarnessPerformanceProfile & PromiseLike<HarnessPerformanceProfile> {
    const clone: HarnessPerformanceProfile = {
      ...profile,
      uncertainty: { ...profile.uncertainty },
    };
    const thenable = Object.create(clone) as HarnessPerformanceProfile &
      PromiseLike<HarnessPerformanceProfile>;
    Object.assign(thenable, clone);
    Object.defineProperty(thenable, 'then', {
      enumerable: false,
      configurable: true,
      value: <TResult1 = HarnessPerformanceProfile, TResult2 = never>(
        onfulfilled?: ((value: HarnessPerformanceProfile) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> => {
        return writePromise.then(() => clone).then(onfulfilled, onrejected);
      },
    });
    return thenable;
  }

  private isExecutionRecord(val: ExecutionRecord | HarnessOutcomeInput): val is ExecutionRecord {
    return (
      typeof val === 'object' &&
      val !== null &&
      'execution' in val &&
      typeof (val as ExecutionRecord).execution === 'object' &&
      (val as ExecutionRecord).execution !== null &&
      typeof (val as ExecutionRecord).execution.id === 'string'
    );
  }
}
