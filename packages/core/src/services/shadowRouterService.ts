import type { KeyValueStore } from '@wazir/shared';
import type { RouteAssessment, RouteCandidate, ResourceRouter } from '../resources/router.js';
import { DEFAULT_WEIGHTS } from '../resources/router.js';
import type { PolicyMode, RoutingWeights, WorkloadClass } from '../resources/types.js';
import { HOSTED_RUNTIME_TYPES } from '../types/runtime.js';
import type { Task } from '../types/task.js';

export const SHADOW_ROUTER_STORE_PREFIX = 'shadow-router/' as const;
export const SHADOW_ROUTER_STATE_KEY = 'shadow-router/state' as const;

export interface ShadowRouteCandidate extends RouteCandidate {
  harnessId?: string;
  workerId?: string;
  local?: boolean;
  admissible?: boolean;
  reasons?: string[];
  score?: number;
  predictedVerifiedSuccessProb?: number;
  expectedTotalCostUsd?: number;
  expectedCostUSD?: number;
  effectiveCostPerSuccessUsd?: number;
  expectedVerificationCostUsd?: number;
  expectedRetryCostUsd?: number;
  expectedColdStartCostUsd?: number;
  expectedLatencyMs?: number;
  sampleCount?: number;
  uncertainty?: number;
  factors?: {
    quality: number;
    reliability: number;
    capacity: number;
    cost: number;
    latency: number;
    quotaRisk: number;
  };
}

export interface ShadowRouteChoice {
  harnessId: string;
  modelId: string;
  runtimeId: string;
  workerId?: string;
  local: boolean;
  score: number;
  predictedSuccessProb: number;
  expectedCostUSD: number;
  expectedLatencyMs: number;
  sampleCount: number;
  uncertainty: number;
  reasons: string[];
}

export interface RoutingPolicyDescriptor {
  id: string;
  version?: string;
  mode?: PolicyMode;
  weights?: Partial<RoutingWeights>;
  minVerifiedSuccessRate?: number;
  maxLatencyMs?: number;
  maxCostUSD?: number;
  preferLocal?: boolean;
  router?: ResourceRouter;
  evaluate?: (
    task: Pick<Task, 'id' | 'type' | 'priority'> & Partial<Task>,
    candidates: ShadowRouteCandidate[],
  ) => ShadowRouteChoice | undefined;
}

export interface ObservedRouteOutcome {
  verifiedSuccess: boolean;
  actualCostUSD?: number;
  actualDurationMs: number;
  policyViolation?: boolean;
  recordedAt?: string;
}

export interface RouteCalibrationMetrics {
  /** |predictedSuccessProb - (verifiedSuccess ? 1 : 0)| */
  successProbError: number;
  /** (predictedSuccessProb - (verifiedSuccess ? 1 : 0))^2 */
  brierScore: number;
  /** actualCostUSD - expectedCostUSD (signed) */
  costEstimationErrorUSD?: number;
  /** |actualCostUSD - expectedCostUSD| */
  absCostEstimationErrorUSD?: number;
  /** actualDurationMs - expectedLatencyMs (signed) */
  latencyErrorMs: number;
  /** |actualDurationMs - expectedLatencyMs| */
  absLatencyErrorMs: number;
}

export interface ShadowEvaluationRecord {
  evaluationId: string;
  executionId: string;
  taskId: string;
  timestamp: string;
  productionPolicyId: string;
  shadowPolicyId: string;
  productionChoice: ShadowRouteChoice;
  shadowChoice: ShadowRouteChoice;
  /** Always equals productionChoice in evaluateShadow; may equal an explored candidate in decideWithExploration. */
  selectedChoice: ShadowRouteChoice;
  agreed: boolean;
  explored: boolean;
  explorationStrategy: 'none' | 'epsilon-greedy' | 'ucb' | 'under-sampled';
  explorationBlockedReason?: string;
  liveShadowExecutionAuthorized: boolean;
  liveShadowExecutionBlockReason?: string;
  predictedDelta: {
    successProbDelta: number;
    costDeltaUSD: number;
    latencyDeltaMs: number;
  };
  observed?: ObservedRouteOutcome;
  calibration?: RouteCalibrationMetrics;
}

export interface ExplorationDecisionResult {
  executionId: string;
  taskId: string;
  selectedChoice: ShadowRouteChoice;
  productionChoice: ShadowRouteChoice;
  explored: boolean;
  explorationStrategy: 'none' | 'epsilon-greedy' | 'ucb' | 'under-sampled';
  explorationBlockedReason?: string;
  liveShadowExecutionAuthorized: boolean;
  liveShadowExecutionBlockReason?: string;
  record: ShadowEvaluationRecord;
}

export interface PolicyRollbackEvent {
  rolledBackAt: string;
  fromPolicyId: string;
  toBaselinePolicyId: string;
  reason: string;
  observedSamples: number;
  observedVerifiedSuccessRate: number;
  meanCalibrationError: number;
}

export interface RollbackGuardResult {
  rolledBack: boolean;
  reason?: string;
  activePolicyId: string;
  baselinePolicyId: string;
  observedSamples: number;
  observedVerifiedSuccessRate: number;
  meanCalibrationError: number;
  event?: PolicyRollbackEvent;
}

export interface ShadowRouterConfig {
  /** Maximum fraction of requests allowed to explore in [0, 1] (default 0.10). */
  maxExplorationFraction?: number;
  /** Alias for maxExplorationFraction from shared contracts. */
  maxExplorationRate?: number;
  /** Cumulative monetary spend cap (USD) for exploratory routing (default 5.0). */
  maxExplorationCostUSD?: number;
  /** Alias for maxExplorationCostUSD from shared contracts. */
  maxExplorationCostUsd?: number;
  /** Maximum per-task extra cost (USD) over production choice allowed for exploration (default 0.50). */
  perTaskMaxCostDeltaUSD?: number;
  /** Alias for perTaskMaxCostDeltaUSD. */
  perTaskMaxCostDeltaUsd?: number;
  /** Candidate sample threshold below which a candidate is considered under-sampled (default 5). */
  minSamplesForConfidence?: number;
  /** Exploration strategy preference (default 'ucb'). */
  strategy?: 'ucb' | 'epsilon-greedy' | 'under-sampled';
  /** Epsilon probability in [0, 1] when strategy is 'epsilon-greedy' (default 0.10). */
  epsilon?: number;
  /** UCB exploration bonus scaling factor (default 0.25). */
  ucbExplorationConstant?: number;
  /** Block exploration on high-risk mutating tasks (default true). */
  blockHighRiskExploration?: boolean;
  /** Explicit opt-in required before any live duplicate shadow run can be authorized (default false). */
  allowLiveShadowExecution?: boolean;
  /** Minimum observed samples on an activated candidate policy before success-rate rollback triggers (default 5). */
  minRollbackSamples?: number;
  /** Minimum observed verified success rate before automatic rollback to baseline policy (default 0.60). */
  minObservedVerifiedSuccessRate?: number;
  /** Maximum mean calibration error before automatic rollback (optional). */
  maxCalibrationErrorThreshold?: number;
  /** Automatically check rollback guard when recording outcomes (default true). */
  autoRollbackOnGuardFailure?: boolean;
  /** Optional deterministic RNG in [0, 1) for testing. */
  random?: () => number;
}

export interface ShadowRouterServiceOptions {
  store?: KeyValueStore;
  baselinePolicy?: RoutingPolicyDescriptor;
  shadowPolicy?: RoutingPolicyDescriptor;
  config?: ShadowRouterConfig;
}

interface ResolvedExplorationConfig {
  maxExplorationFraction: number;
  maxExplorationCostUSD: number;
  perTaskMaxCostDeltaUSD: number;
  minSamplesForConfidence: number;
  strategy: 'ucb' | 'epsilon-greedy' | 'under-sampled';
  epsilon: number;
  ucbExplorationConstant: number;
  blockHighRiskExploration: boolean;
  allowLiveShadowExecution: boolean;
  minRollbackSamples: number;
  minObservedVerifiedSuccessRate: number;
  maxCalibrationErrorThreshold?: number;
  autoRollbackOnGuardFailure: boolean;
  random: () => number;
}

export interface PersistedShadowRouterState {
  activePolicyId: string;
  baselinePolicyId: string;
  shadowPolicyId: string;
  isCandidatePolicyActive: boolean;
  totalDecisions: number;
  explorationCount: number;
  cumulativeExplorationCostUSD: number;
  rollbackHistory: PolicyRollbackEvent[];
}

const DEFAULT_BASELINE_POLICY: RoutingPolicyDescriptor = {
  id: 'baseline-balanced-v1',
  version: '1.0.0',
  mode: 'balanced',
};

const DEFAULT_SHADOW_POLICY: RoutingPolicyDescriptor = {
  id: 'shadow-quality-first-v1',
  version: '1.0.0',
  mode: 'quality-first',
};

function isLocalCandidate(candidate: ShadowRouteCandidate): boolean {
  if (typeof candidate.local === 'boolean') {
    return candidate.local;
  }
  const rt = candidate.runtimeId.toLowerCase();
  if (HOSTED_RUNTIME_TYPES.has(rt as never)) {
    return false;
  }
  if (['anthropic', 'openai', 'google', 'nvidia', 'remote', 'hosted', 'cloud'].some((p) => rt.includes(p))) {
    return false;
  }
  return true;
}

function estimateCandidateCostUSD(candidate: ShadowRouteCandidate): number {
  const base =
    candidate.expectedTotalCostUsd ??
    candidate.expectedCostUSD ??
    candidate.effectiveCostPerSuccessUsd ??
    0;
  const extra =
    (candidate.expectedVerificationCostUsd ?? 0) +
    (candidate.expectedRetryCostUsd ?? 0) +
    (candidate.expectedColdStartCostUsd ?? 0);
  // If expectedTotalCostUsd was already provided, do not double-add extra components
  const raw = candidate.expectedTotalCostUsd !== undefined ? candidate.expectedTotalCostUsd : base + extra;
  return Number(Math.max(0, raw).toFixed(6));
}

function estimateCandidateLatencyMs(candidate: ShadowRouteCandidate): number {
  if (candidate.expectedLatencyMs !== undefined && Number.isFinite(candidate.expectedLatencyMs)) {
    return Math.max(0, Math.round(candidate.expectedLatencyMs));
  }
  const loadPenalty =
    candidate.residency && candidate.residency !== 'ready'
      ? (candidate.estimatedLoadMs ?? 4_000)
      : 0;
  const baseLatency = isLocalCandidate(candidate) ? 1_200 : 1_800;
  return Math.max(0, Math.round(baseLatency + loadPenalty));
}

function estimatePredictedSuccessProb(candidate: ShadowRouteCandidate, maxCapability: number): number {
  if (
    candidate.predictedVerifiedSuccessProb !== undefined &&
    Number.isFinite(candidate.predictedVerifiedSuccessProb)
  ) {
    return Number(Math.max(0, Math.min(1, candidate.predictedVerifiedSuccessProb)).toFixed(4));
  }
  if (candidate.verifiedSuccessRate !== undefined && Number.isFinite(candidate.verifiedSuccessRate)) {
    return Number(Math.max(0, Math.min(1, candidate.verifiedSuccessRate)).toFixed(4));
  }
  if (candidate.factors?.reliability !== undefined && Number.isFinite(candidate.factors.reliability)) {
    return Number(Math.max(0, Math.min(1, candidate.factors.reliability)).toFixed(4));
  }
  const normCap = Math.max(0.05, Math.min(1, candidate.capabilityScore / Math.max(1, maxCapability)));
  return Number((0.4 + 0.5 * normCap).toFixed(4));
}

function computeUncertainty(sampleCount: number, explicitUncertainty?: number): number {
  if (explicitUncertainty !== undefined && Number.isFinite(explicitUncertainty)) {
    return Number(Math.max(0, Math.min(1, explicitUncertainty)).toFixed(4));
  }
  return Number((1 / Math.sqrt(1 + Math.max(0, sampleCount))).toFixed(4));
}

/**
 * ShadowRouterService evaluates candidate routing policies in shadow mode without mutating
 * production decisions, enforces bounded exploration under strict cost/rate/security constraints,
 * tracks predicted vs. observed calibration error, and supports automatic or manual rollback
 * to the baseline routing policy.
 */
export class ShadowRouterService {
  private readonly store?: KeyValueStore;
  private baselinePolicy: RoutingPolicyDescriptor;
  private activePolicy: RoutingPolicyDescriptor;
  private shadowPolicy: RoutingPolicyDescriptor;
  private isCandidatePolicyActive = false;
  private config: ResolvedExplorationConfig;

  private readonly evaluations = new Map<string, ShadowEvaluationRecord>();
  private readonly sampleCountsByRoute = new Map<string, number>();
  private readonly rollbackHistory: PolicyRollbackEvent[] = [];

  private totalDecisions = 0;
  private explorationCount = 0;
  private cumulativeExplorationCostUSD = 0;
  private activePolicyDecisionIds = new Set<string>();

  constructor(options: ShadowRouterServiceOptions = {}) {
    this.store = options.store;
    this.baselinePolicy = options.baselinePolicy ?? DEFAULT_BASELINE_POLICY;
    this.activePolicy = this.baselinePolicy;
    this.shadowPolicy = options.shadowPolicy ?? DEFAULT_SHADOW_POLICY;
    this.config = this.resolveConfig(options.config);
  }

  private resolveConfig(cfg?: ShadowRouterConfig): ResolvedExplorationConfig {
    return {
      maxExplorationFraction: Math.max(
        0,
        Math.min(1, cfg?.maxExplorationFraction ?? cfg?.maxExplorationRate ?? 0.1),
      ),
      maxExplorationCostUSD: Math.max(
        0,
        cfg?.maxExplorationCostUSD ?? cfg?.maxExplorationCostUsd ?? 5.0,
      ),
      perTaskMaxCostDeltaUSD: Math.max(
        0,
        cfg?.perTaskMaxCostDeltaUSD ?? cfg?.perTaskMaxCostDeltaUsd ?? 0.5,
      ),
      minSamplesForConfidence: Math.max(1, cfg?.minSamplesForConfidence ?? 5),
      strategy: cfg?.strategy ?? 'ucb',
      epsilon: Math.max(0, Math.min(1, cfg?.epsilon ?? 0.1)),
      ucbExplorationConstant: Math.max(0, cfg?.ucbExplorationConstant ?? 0.25),
      blockHighRiskExploration: cfg?.blockHighRiskExploration ?? true,
      allowLiveShadowExecution: cfg?.allowLiveShadowExecution ?? false,
      minRollbackSamples: Math.max(1, cfg?.minRollbackSamples ?? 5),
      minObservedVerifiedSuccessRate: Math.max(
        0,
        Math.min(1, cfg?.minObservedVerifiedSuccessRate ?? 0.6),
      ),
      maxCalibrationErrorThreshold: cfg?.maxCalibrationErrorThreshold,
      autoRollbackOnGuardFailure: cfg?.autoRollbackOnGuardFailure ?? true,
      random: cfg?.random ?? Math.random,
    };
  }

  public updateConfig(patch: Partial<ShadowRouterConfig>): void {
    this.config = this.resolveConfig({
      ...this.config,
      ...patch,
    });
  }

  public getActivePolicy(): RoutingPolicyDescriptor {
    return this.activePolicy;
  }

  public getBaselinePolicy(): RoutingPolicyDescriptor {
    return this.baselinePolicy;
  }

  public getShadowPolicy(): RoutingPolicyDescriptor {
    return this.shadowPolicy;
  }

  public setShadowPolicy(policy: RoutingPolicyDescriptor): void {
    this.shadowPolicy = policy;
  }

  /**
   * Promotes a candidate/shadow routing policy to be the active production policy,
   * preserving the previous active policy as the baseline for instant rollback.
   */
  public activateCandidatePolicy(policy?: RoutingPolicyDescriptor): RoutingPolicyDescriptor {
    const target = policy ?? this.shadowPolicy;
    if (!this.isCandidatePolicyActive) {
      this.baselinePolicy = this.activePolicy;
    }
    this.activePolicy = target;
    this.isCandidatePolicyActive = target.id !== this.baselinePolicy.id;
    this.activePolicyDecisionIds.clear();
    this.persistStateAsync();
    return this.activePolicy;
  }

  private routeKey(harnessId: string, modelId: string, runtimeId: string): string {
    return `${harnessId}::${modelId}::${runtimeId}`;
  }

  private getSampleCount(candidate: ShadowRouteCandidate): number {
    if (candidate.sampleCount !== undefined && Number.isFinite(candidate.sampleCount)) {
      return Math.max(0, candidate.sampleCount);
    }
    const key = this.routeKey(candidate.harnessId ?? 'native', candidate.modelId, candidate.runtimeId);
    return this.sampleCountsByRoute.get(key) ?? 0;
  }

  /**
   * Evaluates a list of candidates under a given routing policy without mutating input candidates.
   */
  public scoreCandidatesForPolicy(
    task: Pick<Task, 'id' | 'type' | 'priority'> & Partial<Task>,
    candidates: readonly ShadowRouteCandidate[],
    policy: RoutingPolicyDescriptor,
    workload: WorkloadClass = 'routine',
    estimatedInputTokens = 1000,
  ): ShadowRouteChoice[] {
    if (candidates.length === 0) {
      return [];
    }

    if (policy.evaluate) {
      const cloned = candidates.map((c) => ({ ...c, reasons: c.reasons ? [...c.reasons] : undefined }));
      const custom = policy.evaluate(task, cloned);
      if (custom) {
        return [custom];
      }
    }

    let assessed: Array<ShadowRouteCandidate & Partial<RouteAssessment>> = candidates.map((c) => ({
      ...c,
      reasons: c.reasons ? [...c.reasons] : [],
    }));

    if (policy.router) {
      const routerAssessments = policy.router.assess({
        task: { id: task.id },
        workload,
        estimatedInputTokens,
        candidates: assessed,
      });
      assessed = routerAssessments.map((ra, idx) => ({
        ...assessed[idx],
        ...ra,
      }));
    }

    const mode: PolicyMode = policy.mode ?? 'balanced';
    const weights: RoutingWeights = {
      ...DEFAULT_WEIGHTS[mode],
      ...(policy.weights ?? {}),
    };

    const localOnlyRequired =
      task.policy?.localOnly === true ||
      task.requirements?.localOnly === true ||
      task.execution?.routingMode === 'LOCAL_ONLY' ||
      task.policy?.dataClassification === 'sensitive' ||
      task.policy?.dataClassification === 'restricted';

    const maxCapability = Math.max(1, ...assessed.map((c) => c.capabilityScore));
    const preliminary = assessed.filter((c) => {
      if (c.admissible === false) return false;
      if (c.kvCacheFits === false) return false;
      const local = isLocalCandidate(c);
      if (localOnlyRequired && !local) return false;
      const predProb = estimatePredictedSuccessProb(c, maxCapability);
      if (policy.minVerifiedSuccessRate !== undefined && predProb < policy.minVerifiedSuccessRate) {
        return false;
      }
      const latency = estimateCandidateLatencyMs(c);
      if (policy.maxLatencyMs !== undefined && latency > policy.maxLatencyMs) {
        return false;
      }
      const cost = estimateCandidateCostUSD(c);
      if (policy.maxCostUSD !== undefined && cost > policy.maxCostUSD) {
        return false;
      }
      return true;
    });

    if (preliminary.length === 0) {
      return [];
    }

    const maxCost = Math.max(0, ...preliminary.map((c) => estimateCandidateCostUSD(c)));
    const maxLatency = Math.max(1, ...preliminary.map((c) => estimateCandidateLatencyMs(c)));

    const choices: ShadowRouteChoice[] = preliminary.map((c) => {
      const local = isLocalCandidate(c);
      const predictedSuccessProb = estimatePredictedSuccessProb(c, maxCapability);
      const expectedCostUSD = estimateCandidateCostUSD(c);
      const expectedLatencyMs = estimateCandidateLatencyMs(c);
      const sampleCount = this.getSampleCount(c);
      const uncertainty = computeUncertainty(sampleCount, c.uncertainty);

      const qualityFactor = c.factors?.quality ?? c.capabilityScore / maxCapability;
      const reliabilityFactor = c.factors?.reliability ?? predictedSuccessProb;
      const capacityFactor =
        c.factors?.capacity ??
        (c.residency === 'reload' ? 0.4 : c.residency === 'load' ? 0.2 : 1.0);
      const costFactor = c.factors?.cost ?? (maxCost > 0 ? expectedCostUSD / maxCost : 0);
      const latencyFactor = c.factors?.latency ?? (maxLatency > 0 ? expectedLatencyMs / maxLatency : 0.5);
      const quotaRiskFactor = c.factors?.quotaRisk ?? (local ? 0 : 0.25);

      let score =
        weights.quality * qualityFactor +
        weights.reliability * reliabilityFactor +
        weights.capacity * capacityFactor -
        weights.cost * costFactor -
        weights.latency * latencyFactor -
        weights.quotaRisk * quotaRiskFactor;

      if (policy.preferLocal || mode === 'local-first') {
        if (local) score += 0.35;
      }

      const harnessId = c.harnessId ?? 'native';
      const reasons = [
        ...(c.reasons ?? []),
        `policy=${policy.id} (mode=${mode}): score=${score.toFixed(4)}, prob=${predictedSuccessProb.toFixed(2)}, cost=$${expectedCostUSD.toFixed(4)}, latency=${expectedLatencyMs}ms`,
      ];

      return {
        harnessId,
        modelId: c.modelId,
        runtimeId: c.runtimeId,
        workerId: c.workerId,
        local,
        score: Number(score.toFixed(4)),
        predictedSuccessProb,
        expectedCostUSD,
        expectedLatencyMs,
        sampleCount,
        uncertainty,
        reasons,
      };
    });

    choices.sort(
      (a, b) =>
        b.score - a.score ||
        b.predictedSuccessProb - a.predictedSuccessProb ||
        a.expectedCostUSD - b.expectedCostUSD ||
        a.modelId.localeCompare(b.modelId) ||
        a.harnessId.localeCompare(b.harnessId),
    );

    return choices;
  }

  /**
   * Checks whether a task is blocked from routing exploration or live shadow execution due to
   * privacy, security, locality, or criticality constraints.
   */
  public checkTaskExplorationSafety(
    task: Pick<Task, 'id' | 'type' | 'priority'> & Partial<Task>,
    options?: { highRisk?: boolean },
  ): { allowed: boolean; reason?: string; localOnly: boolean } {
    const dataClassification = task.policy?.dataClassification;
    if (dataClassification === 'sensitive' || dataClassification === 'restricted') {
      return {
        allowed: false,
        reason: `blocked: task dataClassification is '${dataClassification}'`,
        localOnly: true,
      };
    }

    if (task.priority === 'critical') {
      return {
        allowed: false,
        reason: `blocked: task priority is 'critical'`,
        localOnly: Boolean(task.policy?.localOnly || task.requirements?.localOnly),
      };
    }

    if (task.execution?.targetModelId) {
      return {
        allowed: false,
        reason: `blocked: task has explicit targetModelId pin '${task.execution.targetModelId}'`,
        localOnly: Boolean(task.policy?.localOnly || task.requirements?.localOnly),
      };
    }

    const isMutating = Boolean(task.mutationRequired || task.requirements?.mutationRequired);
    const isHighRisk =
      options?.highRisk === true ||
      (isMutating && (task.priority === 'high' || (task as Record<string, unknown>).highRisk === true));

    if (this.config.blockHighRiskExploration && isHighRisk) {
      return {
        allowed: false,
        reason: 'blocked: high-risk mutating task when blockHighRiskExploration is enabled',
        localOnly: Boolean(task.policy?.localOnly || task.requirements?.localOnly),
      };
    }

    const localOnly =
      task.policy?.localOnly === true ||
      task.requirements?.localOnly === true ||
      task.execution?.routingMode === 'LOCAL_ONLY';

    return { allowed: true, localOnly };
  }

  /**
   * Runs a shadow routing policy alongside the active production policy on the exact same task
   * and candidate pool. Records both decisions without changing the production routing decision
   * or triggering unauthorized live duplicate execution.
   */
  public evaluateShadow(input: {
    executionId?: string;
    task: Pick<Task, 'id' | 'type' | 'priority'> & Partial<Task>;
    candidates: readonly ShadowRouteCandidate[];
    productionPolicy?: RoutingPolicyDescriptor;
    shadowPolicy?: RoutingPolicyDescriptor;
    workload?: WorkloadClass;
    estimatedInputTokens?: number;
    requestLiveShadowExecution?: boolean;
    highRisk?: boolean;
  }): ShadowEvaluationRecord {
    const prodPolicy = input.productionPolicy ?? this.activePolicy;
    const shadPolicy = input.shadowPolicy ?? this.shadowPolicy;
    const workload = input.workload ?? 'routine';
    const estimatedInputTokens = input.estimatedInputTokens ?? 1000;

    const prodRanked = this.scoreCandidatesForPolicy(
      input.task,
      input.candidates,
      prodPolicy,
      workload,
      estimatedInputTokens,
    );
    if (prodRanked.length === 0) {
      throw new Error(`No admissible production route candidates for task '${input.task.id}'`);
    }

    const shadRanked = this.scoreCandidatesForPolicy(
      input.task,
      input.candidates,
      shadPolicy,
      workload,
      estimatedInputTokens,
    );
    const productionChoice = prodRanked[0];
    const shadowChoice = shadRanked[0] ?? productionChoice;

    const agreed =
      productionChoice.harnessId === shadowChoice.harnessId &&
      productionChoice.modelId === shadowChoice.modelId &&
      productionChoice.runtimeId === shadowChoice.runtimeId;

    // Live shadow execution gate: default false unless explicitly configured AND safe AND within budget
    let liveShadowExecutionAuthorized = false;
    let liveShadowExecutionBlockReason: string | undefined;

    if (!input.requestLiveShadowExecution) {
      liveShadowExecutionBlockReason = 'live shadow execution not requested (shadow-only dry evaluation)';
    } else if (!this.config.allowLiveShadowExecution) {
      liveShadowExecutionBlockReason = 'allowLiveShadowExecution is false in configuration';
    } else {
      const safety = this.checkTaskExplorationSafety(input.task, { highRisk: input.highRisk });
      if (!safety.allowed) {
        liveShadowExecutionBlockReason = safety.reason;
      } else if (safety.localOnly && !shadowChoice.local) {
        liveShadowExecutionBlockReason = 'localOnly constraint forbids remote live shadow execution';
      } else if (
        this.cumulativeExplorationCostUSD + shadowChoice.expectedCostUSD >
        this.config.maxExplorationCostUSD
      ) {
        liveShadowExecutionBlockReason = `live shadow cost ($${shadowChoice.expectedCostUSD.toFixed(4)}) would exceed maxExplorationCostUSD ($${this.config.maxExplorationCostUSD.toFixed(4)})`;
      } else if (shadowChoice.expectedCostUSD > this.config.perTaskMaxCostDeltaUSD) {
        liveShadowExecutionBlockReason = `live shadow cost ($${shadowChoice.expectedCostUSD.toFixed(4)}) exceeds perTaskMaxCostDeltaUSD ($${this.config.perTaskMaxCostDeltaUSD.toFixed(4)})`;
      } else {
        liveShadowExecutionAuthorized = true;
        this.cumulativeExplorationCostUSD = Number(
          (this.cumulativeExplorationCostUSD + shadowChoice.expectedCostUSD).toFixed(6),
        );
      }
    }

    const executionId = input.executionId ?? `exec-${input.task.id}-${Date.now()}-${this.evaluations.size + 1}`;
    const record: ShadowEvaluationRecord = {
      evaluationId: `shadow-${executionId}`,
      executionId,
      taskId: input.task.id,
      timestamp: new Date().toISOString(),
      productionPolicyId: prodPolicy.id,
      shadowPolicyId: shadPolicy.id,
      productionChoice: structuredClone(productionChoice),
      shadowChoice: structuredClone(shadowChoice),
      selectedChoice: structuredClone(productionChoice),
      agreed,
      explored: false,
      explorationStrategy: 'none',
      liveShadowExecutionAuthorized,
      liveShadowExecutionBlockReason,
      predictedDelta: {
        successProbDelta: Number(
          (shadowChoice.predictedSuccessProb - productionChoice.predictedSuccessProb).toFixed(4),
        ),
        costDeltaUSD: Number(
          (shadowChoice.expectedCostUSD - productionChoice.expectedCostUSD).toFixed(6),
        ),
        latencyDeltaMs: shadowChoice.expectedLatencyMs - productionChoice.expectedLatencyMs,
      },
    };

    this.evaluations.set(executionId, record);
    if (this.isCandidatePolicyActive && prodPolicy.id === this.activePolicy.id) {
      this.activePolicyDecisionIds.add(executionId);
    }
    this.persistRecordAsync(record);
    this.persistStateAsync();

    return structuredClone(record);
  }

  /**
   * Selects a route using the active production policy with bounded exploration for
   * under-sampled candidates, strictly enforcing privacy/locality/criticality constraints
   * and exploration rate/cost budgets.
   */
  public decideWithExploration(input: {
    executionId?: string;
    task: Pick<Task, 'id' | 'type' | 'priority'> & Partial<Task>;
    candidates: readonly ShadowRouteCandidate[];
    workload?: WorkloadClass;
    estimatedInputTokens?: number;
    highRisk?: boolean;
    requestLiveShadowExecution?: boolean;
  }): ExplorationDecisionResult {
    const executionId = input.executionId ?? `exec-${input.task.id}-${Date.now()}-${this.evaluations.size + 1}`;
    const workload = input.workload ?? 'routine';
    const estimatedInputTokens = input.estimatedInputTokens ?? 1000;

    // 1. Check hard task-level safety & locality constraints before scoring for exploration
    const safety = this.checkTaskExplorationSafety(input.task, { highRisk: input.highRisk });

    // Evaluate production baseline choices
    const rankedProd = this.scoreCandidatesForPolicy(
      input.task,
      input.candidates,
      this.activePolicy,
      workload,
      estimatedInputTokens,
    );

    if (rankedProd.length === 0) {
      throw new Error(`No admissible route candidates for task '${input.task.id}'`);
    }

    const productionChoice = rankedProd[0];

    // Also compute shadow policy choice for comparison logging
    const rankedShadow = this.scoreCandidatesForPolicy(
      input.task,
      input.candidates,
      this.shadowPolicy,
      workload,
      estimatedInputTokens,
    );
    const shadowChoice = rankedShadow[0] ?? productionChoice;

    let selectedChoice = productionChoice;
    let explored = false;
    let explorationStrategy: 'none' | 'epsilon-greedy' | 'ucb' | 'under-sampled' = 'none';
    let explorationBlockedReason: string | undefined;

    // Check if task constraints allow any exploration
    if (!safety.allowed) {
      explorationBlockedReason = safety.reason;
    } else if (safety.localOnly) {
      // Check if any non-local candidate was in the input pool and ensure we never explore a remote candidate
      const alternativeCandidates = rankedProd.slice(1);
      const hasRemoteAlternative = input.candidates.some((c) => !isLocalCandidate(c));
      const localAlternatives = alternativeCandidates.filter((c) => c.local);
      if (localAlternatives.length === 0) {
        explorationBlockedReason = hasRemoteAlternative
          ? 'blocked: localOnly constraint forbids exploring remote candidates'
          : 'no alternative local candidates available for exploration';
      }
    }

    // 2. Check exploration rate / fraction budget if not already blocked
    if (!explorationBlockedReason) {
      if (this.config.maxExplorationFraction <= 0) {
        explorationBlockedReason = 'blocked: maxExplorationFraction is 0';
      } else if (
        this.config.maxExplorationFraction < 1 &&
        this.totalDecisions > 0 &&
        this.explorationCount / this.totalDecisions >= this.config.maxExplorationFraction
      ) {
        explorationBlockedReason = `blocked: exploration fraction (${this.explorationCount}/${this.totalDecisions}) reached maxExplorationFraction (${this.config.maxExplorationFraction})`;
      }
    }

    // 3. Identify eligible alternative candidates that respect locality and cost budgets
    if (!explorationBlockedReason) {
      const alternatives = rankedProd.slice(1).filter((c) => !safety.localOnly || c.local);
      if (alternatives.length === 0) {
        explorationBlockedReason = 'no alternative eligible candidates available for exploration';
      } else {
        // Filter by perTaskMaxCostDeltaUSD and maxExplorationCostUSD
        const withinPerTaskDelta = alternatives.filter(
          (c) =>
            c.expectedCostUSD - productionChoice.expectedCostUSD <=
            this.config.perTaskMaxCostDeltaUSD,
        );
        if (withinPerTaskDelta.length === 0) {
          explorationBlockedReason = `blocked: all alternative candidates exceed perTaskMaxCostDeltaUSD ($${this.config.perTaskMaxCostDeltaUSD.toFixed(4)})`;
        } else {
          const withinTotalBudget = withinPerTaskDelta.filter((c) => {
            const incrementalOrDirectCost = Math.max(
              c.expectedCostUSD,
              Math.max(0, c.expectedCostUSD - productionChoice.expectedCostUSD),
            );
            return (
              this.cumulativeExplorationCostUSD + incrementalOrDirectCost <=
                this.config.maxExplorationCostUSD &&
              this.cumulativeExplorationCostUSD < this.config.maxExplorationCostUSD
            );
          });

          if (withinTotalBudget.length === 0) {
            explorationBlockedReason = `blocked: cumulative exploration cost ($${this.cumulativeExplorationCostUSD.toFixed(4)}) would exceed maxExplorationCostUSD ($${this.config.maxExplorationCostUSD.toFixed(4)})`;
          } else {
            // Select candidate via configured bounded exploration strategy
            const underSampled = withinTotalBudget.filter(
              (c) => c.sampleCount < this.config.minSamplesForConfidence,
            );

            if (this.config.strategy === 'epsilon-greedy') {
              const roll = this.config.random();
              if (roll < this.config.epsilon) {
                const pool = underSampled.length > 0 ? underSampled : withinTotalBudget;
                selectedChoice = pool[0];
                explored = true;
                explorationStrategy = 'epsilon-greedy';
              } else {
                explorationBlockedReason = `epsilon-greedy roll (${roll.toFixed(3)}) >= epsilon (${this.config.epsilon})`;
              }
            } else if (this.config.strategy === 'under-sampled') {
              if (underSampled.length > 0) {
                underSampled.sort(
                  (a, b) => a.sampleCount - b.sampleCount || b.score - a.score,
                );
                selectedChoice = underSampled[0];
                explored = true;
                explorationStrategy = 'under-sampled';
              } else {
                explorationBlockedReason = `all candidates meet minSamplesForConfidence (${this.config.minSamplesForConfidence})`;
              }
            } else {
              // Default: UCB-bounded exploration for under-sampled candidates
              if (underSampled.length > 0) {
                const totalSamples = Math.max(
                  1,
                  rankedProd.reduce((sum, c) => sum + c.sampleCount, 0),
                );
                const scoredUcb = underSampled.map((c) => {
                  const bonus =
                    this.config.ucbExplorationConstant *
                    Math.sqrt(Math.log(totalSamples + 1) / (c.sampleCount + 1));
                  return {
                    choice: c,
                    ucbScore: c.score + bonus,
                  };
                });
                scoredUcb.sort((a, b) => b.ucbScore - a.ucbScore);
                selectedChoice = {
                  ...scoredUcb[0].choice,
                  reasons: [
                    ...scoredUcb[0].choice.reasons,
                    `selected via UCB bounded exploration (samples=${scoredUcb[0].choice.sampleCount} < ${this.config.minSamplesForConfidence}, ucbScore=${scoredUcb[0].ucbScore.toFixed(4)})`,
                  ],
                };
                explored = true;
                explorationStrategy = 'ucb';
              } else {
                explorationBlockedReason = `all candidates meet minSamplesForConfidence (${this.config.minSamplesForConfidence})`;
              }
            }
          }
        }
      }
    }

    this.totalDecisions += 1;
    if (explored) {
      this.explorationCount += 1;
      const explorationSpend = Math.max(
        selectedChoice.expectedCostUSD,
        Math.max(0, selectedChoice.expectedCostUSD - productionChoice.expectedCostUSD),
      );
      this.cumulativeExplorationCostUSD = Number(
        (this.cumulativeExplorationCostUSD + explorationSpend).toFixed(6),
      );
    }

    // Live duplicate shadow execution remains strictly gated
    let liveShadowExecutionAuthorized = false;
    let liveShadowExecutionBlockReason = 'live shadow execution not requested';
    if (input.requestLiveShadowExecution) {
      if (!this.config.allowLiveShadowExecution) {
        liveShadowExecutionBlockReason = 'allowLiveShadowExecution is false in configuration';
      } else if (!safety.allowed) {
        liveShadowExecutionBlockReason = safety.reason ?? 'task blocked by safety constraints';
      } else if (safety.localOnly && !shadowChoice.local) {
        liveShadowExecutionBlockReason = 'localOnly constraint forbids remote live shadow execution';
      } else if (
        this.cumulativeExplorationCostUSD + shadowChoice.expectedCostUSD >
        this.config.maxExplorationCostUSD
      ) {
        liveShadowExecutionBlockReason = 'live shadow execution exceeds maxExplorationCostUSD';
      } else {
        liveShadowExecutionAuthorized = true;
        liveShadowExecutionBlockReason = undefined as unknown as string;
        this.cumulativeExplorationCostUSD = Number(
          (this.cumulativeExplorationCostUSD + shadowChoice.expectedCostUSD).toFixed(6),
        );
      }
    }

    const record: ShadowEvaluationRecord = {
      evaluationId: `shadow-${executionId}`,
      executionId,
      taskId: input.task.id,
      timestamp: new Date().toISOString(),
      productionPolicyId: this.activePolicy.id,
      shadowPolicyId: this.shadowPolicy.id,
      productionChoice: structuredClone(productionChoice),
      shadowChoice: structuredClone(shadowChoice),
      selectedChoice: structuredClone(selectedChoice),
      agreed:
        productionChoice.harnessId === shadowChoice.harnessId &&
        productionChoice.modelId === shadowChoice.modelId &&
        productionChoice.runtimeId === shadowChoice.runtimeId,
      explored,
      explorationStrategy,
      explorationBlockedReason,
      liveShadowExecutionAuthorized,
      liveShadowExecutionBlockReason: liveShadowExecutionAuthorized
        ? undefined
        : liveShadowExecutionBlockReason,
      predictedDelta: {
        successProbDelta: Number(
          (selectedChoice.predictedSuccessProb - productionChoice.predictedSuccessProb).toFixed(4),
        ),
        costDeltaUSD: Number(
          (selectedChoice.expectedCostUSD - productionChoice.expectedCostUSD).toFixed(6),
        ),
        latencyDeltaMs: selectedChoice.expectedLatencyMs - productionChoice.expectedLatencyMs,
      },
    };

    this.evaluations.set(executionId, record);
    if (this.isCandidatePolicyActive) {
      this.activePolicyDecisionIds.add(executionId);
    }
    this.persistRecordAsync(record);
    this.persistStateAsync();

    return {
      executionId,
      taskId: input.task.id,
      selectedChoice: structuredClone(selectedChoice),
      productionChoice: structuredClone(productionChoice),
      explored,
      explorationStrategy,
      explorationBlockedReason,
      liveShadowExecutionAuthorized,
      liveShadowExecutionBlockReason: record.liveShadowExecutionBlockReason,
      record: structuredClone(record),
    };
  }

  /**
   * Links the observed physical verification outcome, cost, and duration back to the
   * shadow/exploration record and computes calibration metrics.
   * Automatically invokes `checkRollbackGuard()` when `autoRollbackOnGuardFailure` is enabled.
   */
  public recordObservedOutcome(
    executionId: string,
    observed: ObservedRouteOutcome,
  ): ShadowEvaluationRecord {
    const record = this.evaluations.get(executionId);
    if (!record) {
      throw new Error(`Shadow evaluation record not found for executionId '${executionId}'`);
    }

    const actualSuccessNumeric = observed.verifiedSuccess ? 1 : 0;
    const predProb = record.selectedChoice.predictedSuccessProb;
    const successProbError = Number(Math.abs(predProb - actualSuccessNumeric).toFixed(4));
    const brierScore = Number(Math.pow(predProb - actualSuccessNumeric, 2).toFixed(4));

    const costEstimationErrorUSD =
      observed.actualCostUSD !== undefined
        ? Number((observed.actualCostUSD - record.selectedChoice.expectedCostUSD).toFixed(6))
        : undefined;
    const absCostEstimationErrorUSD =
      costEstimationErrorUSD !== undefined
        ? Number(Math.abs(costEstimationErrorUSD).toFixed(6))
        : undefined;

    const latencyErrorMs = Math.round(
      observed.actualDurationMs - record.selectedChoice.expectedLatencyMs,
    );
    const absLatencyErrorMs = Math.abs(latencyErrorMs);

    const calibration: RouteCalibrationMetrics = {
      successProbError,
      brierScore,
      costEstimationErrorUSD,
      absCostEstimationErrorUSD,
      latencyErrorMs,
      absLatencyErrorMs,
    };

    record.observed = {
      ...observed,
      recordedAt: observed.recordedAt ?? new Date().toISOString(),
    };
    record.calibration = calibration;

    // Update observed sample counts for the selected (harness, model, runtime)
    const key = this.routeKey(
      record.selectedChoice.harnessId,
      record.selectedChoice.modelId,
      record.selectedChoice.runtimeId,
    );
    this.sampleCountsByRoute.set(key, (this.sampleCountsByRoute.get(key) ?? 0) + 1);

    // Reconcile exploration cost if actualCostUSD exceeded expectedCostUSD on an explored run
    if (record.explored && observed.actualCostUSD !== undefined) {
      const diff = observed.actualCostUSD - record.selectedChoice.expectedCostUSD;
      if (diff > 0) {
        this.cumulativeExplorationCostUSD = Number(
          (this.cumulativeExplorationCostUSD + diff).toFixed(6),
        );
      }
    }

    this.persistRecordAsync(record);

    if (this.config.autoRollbackOnGuardFailure) {
      this.checkRollbackGuard();
    }

    this.persistStateAsync();
    return structuredClone(record);
  }

  /**
   * Evaluates whether the currently active candidate policy must be rolled back to the
   * baseline policy due to degraded verified success rate, policy violation, or calibration drift.
   */
  public checkRollbackGuard(): RollbackGuardResult {
    const activeRecords = Array.from(this.evaluations.values()).filter(
      (r) =>
        r.observed !== undefined &&
        (this.isCandidatePolicyActive
          ? this.activePolicyDecisionIds.has(r.executionId) ||
            r.productionPolicyId === this.activePolicy.id
          : r.productionPolicyId === this.activePolicy.id),
    );

    const observedSamples = activeRecords.length;
    const verifiedSuccesses = activeRecords.filter((r) => r.observed?.verifiedSuccess).length;
    const observedVerifiedSuccessRate =
      observedSamples > 0 ? Number((verifiedSuccesses / observedSamples).toFixed(4)) : 1;
    const meanCalibrationError =
      observedSamples > 0
        ? Number(
            (
              activeRecords.reduce((acc, r) => acc + (r.calibration?.successProbError ?? 0), 0) /
              observedSamples
            ).toFixed(4),
          )
        : 0;

    if (!this.isCandidatePolicyActive) {
      return {
        rolledBack: false,
        activePolicyId: this.activePolicy.id,
        baselinePolicyId: this.baselinePolicy.id,
        observedSamples,
        observedVerifiedSuccessRate,
        meanCalibrationError,
      };
    }

    const hasPolicyViolation = activeRecords.some((r) => r.observed?.policyViolation === true);
    if (hasPolicyViolation) {
      const event = this.rollbackToBaseline('Policy violation observed under candidate routing policy');
      return {
        rolledBack: true,
        reason: event.reason,
        activePolicyId: this.activePolicy.id,
        baselinePolicyId: this.baselinePolicy.id,
        observedSamples,
        observedVerifiedSuccessRate,
        meanCalibrationError,
        event,
      };
    }

    if (observedSamples >= this.config.minRollbackSamples) {
      if (observedVerifiedSuccessRate < this.config.minObservedVerifiedSuccessRate) {
        const event = this.rollbackToBaseline(
          `Observed verified success rate (${(observedVerifiedSuccessRate * 100).toFixed(1)}%) dropped below minimum threshold (${(this.config.minObservedVerifiedSuccessRate * 100).toFixed(1)}%) across ${observedSamples} samples`,
        );
        return {
          rolledBack: true,
          reason: event.reason,
          activePolicyId: this.activePolicy.id,
          baselinePolicyId: this.baselinePolicy.id,
          observedSamples,
          observedVerifiedSuccessRate,
          meanCalibrationError,
          event,
        };
      }

      if (
        this.config.maxCalibrationErrorThreshold !== undefined &&
        meanCalibrationError > this.config.maxCalibrationErrorThreshold
      ) {
        const event = this.rollbackToBaseline(
          `Mean calibration error (${meanCalibrationError.toFixed(3)}) exceeded threshold (${this.config.maxCalibrationErrorThreshold.toFixed(3)})`,
        );
        return {
          rolledBack: true,
          reason: event.reason,
          activePolicyId: this.activePolicy.id,
          baselinePolicyId: this.baselinePolicy.id,
          observedSamples,
          observedVerifiedSuccessRate,
          meanCalibrationError,
          event,
        };
      }
    }

    return {
      rolledBack: false,
      activePolicyId: this.activePolicy.id,
      baselinePolicyId: this.baselinePolicy.id,
      observedSamples,
      observedVerifiedSuccessRate,
      meanCalibrationError,
    };
  }

  /**
   * Immediately rolls back the active routing policy to the baseline policy and records the rollback event.
   */
  public rollbackToBaseline(reason: string): PolicyRollbackEvent {
    const activeRecords = Array.from(this.evaluations.values()).filter(
      (r) => r.observed !== undefined && r.productionPolicyId === this.activePolicy.id,
    );
    const observedSamples = activeRecords.length;
    const verifiedSuccesses = activeRecords.filter((r) => r.observed?.verifiedSuccess).length;
    const observedVerifiedSuccessRate =
      observedSamples > 0 ? Number((verifiedSuccesses / observedSamples).toFixed(4)) : 0;
    const meanCalibrationError =
      observedSamples > 0
        ? Number(
            (
              activeRecords.reduce((acc, r) => acc + (r.calibration?.successProbError ?? 0), 0) /
              observedSamples
            ).toFixed(4),
          )
        : 0;

    const event: PolicyRollbackEvent = {
      rolledBackAt: new Date().toISOString(),
      fromPolicyId: this.activePolicy.id,
      toBaselinePolicyId: this.baselinePolicy.id,
      reason,
      observedSamples,
      observedVerifiedSuccessRate,
      meanCalibrationError,
    };

    this.activePolicy = this.baselinePolicy;
    this.isCandidatePolicyActive = false;
    this.activePolicyDecisionIds.clear();
    this.rollbackHistory.push(event);
    this.persistStateAsync();

    return structuredClone(event);
  }

  public getEvaluation(executionId: string): ShadowEvaluationRecord | undefined {
    const rec = this.evaluations.get(executionId);
    return rec ? structuredClone(rec) : undefined;
  }

  public listEvaluations(): ShadowEvaluationRecord[] {
    return Array.from(this.evaluations.values()).map((r) => structuredClone(r));
  }

  public getRollbackHistory(): PolicyRollbackEvent[] {
    return structuredClone(this.rollbackHistory);
  }

  public getExplorationStats(): {
    totalDecisions: number;
    explorationCount: number;
    explorationRate: number;
    cumulativeExplorationCostUSD: number;
    remainingExplorationCostUSD: number;
    activePolicyId: string;
    baselinePolicyId: string;
    shadowPolicyId: string;
    isCandidatePolicyActive: boolean;
  } {
    return {
      totalDecisions: this.totalDecisions,
      explorationCount: this.explorationCount,
      explorationRate:
        this.totalDecisions > 0
          ? Number((this.explorationCount / this.totalDecisions).toFixed(4))
          : 0,
      cumulativeExplorationCostUSD: this.cumulativeExplorationCostUSD,
      remainingExplorationCostUSD: Number(
        Math.max(0, this.config.maxExplorationCostUSD - this.cumulativeExplorationCostUSD).toFixed(
          6,
        ),
      ),
      activePolicyId: this.activePolicy.id,
      baselinePolicyId: this.baselinePolicy.id,
      shadowPolicyId: this.shadowPolicy.id,
      isCandidatePolicyActive: this.isCandidatePolicyActive,
    };
  }

  public async flushToStore(): Promise<void> {
    if (!this.store) return;
    await this.store.put(SHADOW_ROUTER_STATE_KEY, this.serializeState());
    for (const record of this.evaluations.values()) {
      await this.store.put(
        `${SHADOW_ROUTER_STORE_PREFIX}evaluations/${record.executionId}`,
        record,
      );
    }
  }

  public async loadFromStore(): Promise<void> {
    if (!this.store) return;
    const state = await this.store.get<PersistedShadowRouterState>(SHADOW_ROUTER_STATE_KEY);
    if (state) {
      this.totalDecisions = state.totalDecisions;
      this.explorationCount = state.explorationCount;
      this.cumulativeExplorationCostUSD = state.cumulativeExplorationCostUSD;
      this.isCandidatePolicyActive = state.isCandidatePolicyActive;
      this.rollbackHistory.splice(0, this.rollbackHistory.length, ...(state.rollbackHistory ?? []));
      if (state.activePolicyId === this.shadowPolicy.id) {
        this.activePolicy = this.shadowPolicy;
      } else if (state.activePolicyId === this.baselinePolicy.id) {
        this.activePolicy = this.baselinePolicy;
      }
    }
    const entries = await this.store.list(`${SHADOW_ROUTER_STORE_PREFIX}evaluations/`);
    for (const entry of entries) {
      const rec = entry.value as ShadowEvaluationRecord | undefined;
      if (rec && rec.executionId) {
        this.evaluations.set(rec.executionId, rec);
      }
    }
  }

  private serializeState(): PersistedShadowRouterState {
    return {
      activePolicyId: this.activePolicy.id,
      baselinePolicyId: this.baselinePolicy.id,
      shadowPolicyId: this.shadowPolicy.id,
      isCandidatePolicyActive: this.isCandidatePolicyActive,
      totalDecisions: this.totalDecisions,
      explorationCount: this.explorationCount,
      cumulativeExplorationCostUSD: this.cumulativeExplorationCostUSD,
      rollbackHistory: structuredClone(this.rollbackHistory),
    };
  }

  private persistRecordAsync(record: ShadowEvaluationRecord): void {
    if (!this.store) return;
    void this.store
      .put(`${SHADOW_ROUTER_STORE_PREFIX}evaluations/${record.executionId}`, structuredClone(record))
      .catch(() => undefined);
  }

  private persistStateAsync(): void {
    if (!this.store) return;
    void this.store.put(SHADOW_ROUTER_STATE_KEY, this.serializeState()).catch(() => undefined);
  }
}
