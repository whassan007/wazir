/**
 * Phase-aware sticky model router.
 *
 * Once a model is selected for an execution + phase, subsequent turns keep
 * routing to it so KV/prompt caches stay warm and local/DGX runtimes avoid
 * load/unload thrashing. Stickiness is broken only when the model's health
 * degrades (circuit open or too many consecutive failures), observed latency
 * breaches the phase SLA, the required context no longer fits, or an explicit
 * escalation is requested. Escalations are bounded per execution and every
 * decision is appended to a deterministic audit trail.
 */

export type ExecutionPhase = 'planning' | 'coding' | 'verification' | 'fast_path' | 'recovery';

export type CircuitState = 'closed' | 'half_open' | 'open';

export type ModelLocality = 'local' | 'dgx' | 'remote';

export interface RouteCandidate {
  modelId: string;
  providerId: string;
  locality: ModelLocality;
  effectiveContextWindow: number;
  /** Already loaded in VRAM/memory. Remote providers are treated as resident when omitted. */
  resident?: boolean;
  /** Estimated cold-load time when not resident. */
  coldLoadMs?: number;
  ewmaLatencyMs?: number;
  p50LatencyMs?: number;
  throughputTps?: number;
  /** 0..1 */
  successRate?: number;
  circuitState?: CircuitState;
  availableSlots?: number;
  maxSlots?: number;
  memoryHeadroomGiB?: number;
  /** USD per million tokens; 0 for owned local/DGX hardware. */
  marginalCostPerMTok?: number;
  /** 0..1 quality rating used for thresholds and escalation ordering. */
  qualityScore?: number;
}

export interface ScoreWeights {
  residency: number;
  stickyCache: number;
  latency: number;
  reliability: number;
  capacity: number;
  cost: number;
}

export interface PhaseRoutePolicy {
  phase: ExecutionPhase;
  maxLatencyMs: number;
  maxConsecutiveFailures: number;
  minQuality: number;
  /** Inherit the sticky model from a compatible phase of the same execution. */
  preserveContextCache: boolean;
  compatiblePhases: ExecutionPhase[];
  weights: ScoreWeights;
}

export interface StickyRouteSession {
  executionId: string;
  phase: ExecutionPhase;
  modelId: string;
  providerId: string;
  turns: number;
  consecutiveFailures: number;
  lastLatencyMs?: number;
  updatedSequence: number;
}

export type RouteReason =
  | 'initial_selection'
  | 'sticky_reuse'
  | 'sticky_inherited'
  | 'failover_failures'
  | 'failover_circuit'
  | 'failover_latency'
  | 'failover_context'
  | 'failover_unavailable'
  | 'escalation'
  | 'escalation_limit'
  | 'no_eligible_candidate';

export type RejectReason =
  | 'circuit_open'
  | 'context_overflow'
  | 'below_quality'
  | 'consecutive_failures'
  | 'latency_sla'
  | 'excluded';

export interface ScoreBreakdown {
  residency: number;
  stickyCache: number;
  latency: number;
  reliability: number;
  capacity: number;
  cost: number;
}

export interface CandidateScore {
  modelId: string;
  providerId: string;
  total: number;
  breakdown: ScoreBreakdown;
  eligible: boolean;
  rejectReason?: RejectReason;
}

export interface RouteDecision {
  sequence: number;
  at: number;
  kind: 'route' | 'escalation';
  status: 'routed' | 'unroutable' | 'escalation_denied';
  executionId: string;
  phase: ExecutionPhase;
  reason: RouteReason;
  modelId?: string;
  providerId?: string;
  previousModelId?: string;
  sticky: boolean;
  degraded: boolean;
  score?: number;
  breakdown?: ScoreBreakdown;
  rejected: Array<{ modelId: string; reason: RejectReason }>;
  escalationsUsed: number;
  note?: string;
}

export interface RouteRequest {
  executionId: string;
  phase: ExecutionPhase;
  candidates: RouteCandidate[];
  requiredContextTokens?: number;
}

export interface EscalationRequest extends RouteRequest {
  reason?: string;
}

export interface RouteOutcome {
  modelId: string;
  success: boolean;
  latencyMs?: number;
}

export interface ModelHealth {
  consecutiveFailures: number;
  lastLatencyMs?: number;
  ewmaLatencyMs?: number;
}

export interface ScoreContext {
  policy: PhaseRoutePolicy;
  stickyModelId?: string;
  requiredContextTokens?: number;
  health?: ModelHealth;
}

export interface StickyRouterOptions {
  policies?: Partial<Record<ExecutionPhase, Partial<Omit<PhaseRoutePolicy, 'phase'>>>>;
  maxEscalationsPerExecution?: number;
  /** Injected clock so audit timestamps are deterministic in tests. */
  now?: () => number;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2;
export const DEFAULT_MAX_ESCALATIONS_PER_EXECUTION = 2;

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  residency: 0.2,
  stickyCache: 0.25,
  latency: 0.15,
  reliability: 0.15,
  capacity: 0.1,
  cost: 0.15,
};

const COLD_LOAD_PENALTY_CEILING_MS = 60_000;
const TARGET_THROUGHPUT_TPS = 50;
const TARGET_MEMORY_HEADROOM_GIB = 8;
const COST_SCALE_USD_PER_MTOK = 10;
const LATENCY_EWMA_ALPHA = 0.3;

const CACHE_SHARING_PHASES: ExecutionPhase[] = ['planning', 'coding', 'verification'];

const PHASE_DEFAULTS: Record<ExecutionPhase, Omit<PhaseRoutePolicy, 'phase' | 'weights'>> = {
  planning: { maxLatencyMs: 30_000, maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES, minQuality: 0.6, preserveContextCache: true, compatiblePhases: CACHE_SHARING_PHASES },
  coding: { maxLatencyMs: 20_000, maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES, minQuality: 0.6, preserveContextCache: true, compatiblePhases: CACHE_SHARING_PHASES },
  verification: { maxLatencyMs: 20_000, maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES, minQuality: 0.5, preserveContextCache: true, compatiblePhases: CACHE_SHARING_PHASES },
  fast_path: { maxLatencyMs: 3_000, maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES, minQuality: 0.3, preserveContextCache: false, compatiblePhases: [] },
  recovery: { maxLatencyMs: 45_000, maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES, minQuality: 0.7, preserveContextCache: false, compatiblePhases: [] },
};

export function resolvePhasePolicy(
  phase: ExecutionPhase,
  override: Partial<Omit<PhaseRoutePolicy, 'phase'>> = {},
): PhaseRoutePolicy {
  const base = PHASE_DEFAULTS[phase];
  return {
    phase,
    maxLatencyMs: override.maxLatencyMs ?? base.maxLatencyMs,
    maxConsecutiveFailures: override.maxConsecutiveFailures ?? base.maxConsecutiveFailures,
    minQuality: override.minQuality ?? base.minQuality,
    preserveContextCache: override.preserveContextCache ?? base.preserveContextCache,
    compatiblePhases: [...(override.compatiblePhases ?? base.compatiblePhases)],
    weights: { ...DEFAULT_SCORE_WEIGHTS, ...(override.weights ?? {}) },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function isResident(candidate: RouteCandidate): boolean {
  return candidate.resident ?? candidate.locality === 'remote';
}

function observedLatency(candidate: RouteCandidate, health?: ModelHealth): number | undefined {
  return health?.ewmaLatencyMs ?? candidate.ewmaLatencyMs ?? candidate.p50LatencyMs;
}

/**
 * Hard eligibility checks. Latency and failure rejections are "soft": the
 * router may still fall back to such a candidate (flagged degraded) when
 * nothing else is eligible.
 */
function rejectReasonFor(candidate: RouteCandidate, ctx: ScoreContext): RejectReason | undefined {
  if ((candidate.circuitState ?? 'closed') === 'open') return 'circuit_open';
  if ((ctx.requiredContextTokens ?? 0) > candidate.effectiveContextWindow) return 'context_overflow';
  if ((candidate.qualityScore ?? 1) < ctx.policy.minQuality) return 'below_quality';
  if ((ctx.health?.consecutiveFailures ?? 0) >= ctx.policy.maxConsecutiveFailures) return 'consecutive_failures';
  if (ctx.health?.lastLatencyMs !== undefined && ctx.health.lastLatencyMs > ctx.policy.maxLatencyMs) return 'latency_sla';
  return undefined;
}

export function scoreRouteCandidate(candidate: RouteCandidate, ctx: ScoreContext): CandidateScore {
  const { policy } = ctx;

  const residency = isResident(candidate)
    ? 1
    : clamp01(1 - (candidate.coldLoadMs ?? COLD_LOAD_PENALTY_CEILING_MS) / COLD_LOAD_PENALTY_CEILING_MS);

  const stickyCache = ctx.stickyModelId === candidate.modelId ? 1 : 0;

  const latencyMs = observedLatency(candidate, ctx.health);
  const latencyPart = latencyMs === undefined ? 0.5 : clamp01(1 - latencyMs / policy.maxLatencyMs);
  const tpsPart = candidate.throughputTps === undefined ? 0.5 : clamp01(candidate.throughputTps / TARGET_THROUGHPUT_TPS);
  const latency = 0.7 * latencyPart + 0.3 * tpsPart;

  const circuitFactor = { closed: 1, half_open: 0.5, open: 0 }[candidate.circuitState ?? 'closed'];
  const failurePenalty = clamp01(1 - (ctx.health?.consecutiveFailures ?? 0) / Math.max(1, policy.maxConsecutiveFailures));
  const reliability = clamp01(candidate.successRate ?? 1) * circuitFactor * (0.5 + 0.5 * failurePenalty);

  const slotPart = candidate.maxSlots && candidate.maxSlots > 0
    ? clamp01((candidate.availableSlots ?? candidate.maxSlots) / candidate.maxSlots)
    : candidate.availableSlots === 0 ? 0 : 1;
  const memoryPart = candidate.memoryHeadroomGiB === undefined
    ? (candidate.locality === 'remote' ? 1 : 0.5)
    : clamp01(candidate.memoryHeadroomGiB / TARGET_MEMORY_HEADROOM_GIB);
  const capacity = 0.7 * slotPart + 0.3 * memoryPart;

  const marginalCost = candidate.marginalCostPerMTok ?? (candidate.locality === 'remote' ? COST_SCALE_USD_PER_MTOK : 0);
  const meetsQuality = (candidate.qualityScore ?? 1) >= policy.minQuality;
  const cost = marginalCost <= 0 && meetsQuality ? 1 : 1 / (1 + Math.max(0, marginalCost) / COST_SCALE_USD_PER_MTOK);

  const breakdown: ScoreBreakdown = {
    residency: round(residency),
    stickyCache,
    latency: round(latency),
    reliability: round(reliability),
    capacity: round(capacity),
    cost: round(cost),
  };
  const w = policy.weights;
  const total = round(
    w.residency * residency +
      w.stickyCache * stickyCache +
      w.latency * latency +
      w.reliability * reliability +
      w.capacity * capacity +
      w.cost * cost,
  );

  const rejectReason = rejectReasonFor(candidate, ctx);
  return { modelId: candidate.modelId, providerId: candidate.providerId, total, breakdown, eligible: !rejectReason, rejectReason };
}

const SOFT_REJECTS: ReadonlySet<RejectReason> = new Set(['consecutive_failures', 'latency_sla']);

function byScoreThenId(a: CandidateScore, b: CandidateScore): number {
  return b.total - a.total || a.modelId.localeCompare(b.modelId);
}

export class StickyRouter {
  private readonly policies: Record<ExecutionPhase, PhaseRoutePolicy>;
  private readonly maxEscalations: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, StickyRouteSession>();
  private readonly health = new Map<string, Map<string, ModelHealth>>();
  private readonly history = new Map<string, RouteDecision[]>();
  private readonly escalations = new Map<string, { count: number; abandoned: Set<string> }>();
  private sequence = 0;

  constructor(options: StickyRouterOptions = {}) {
    const phases: ExecutionPhase[] = ['planning', 'coding', 'verification', 'fast_path', 'recovery'];
    this.policies = Object.fromEntries(
      phases.map((phase) => [phase, resolvePhasePolicy(phase, options.policies?.[phase])]),
    ) as Record<ExecutionPhase, PhaseRoutePolicy>;
    this.maxEscalations = options.maxEscalationsPerExecution ?? DEFAULT_MAX_ESCALATIONS_PER_EXECUTION;
    this.now = options.now ?? (() => Date.now());
  }

  getPolicy(phase: ExecutionPhase): PhaseRoutePolicy {
    return this.policies[phase];
  }

  getSession(executionId: string, phase: ExecutionPhase): StickyRouteSession | undefined {
    const session = this.sessions.get(sessionKey(executionId, phase));
    return session ? { ...session } : undefined;
  }

  getRouteHistory(executionId: string): RouteDecision[] {
    return (this.history.get(executionId) ?? []).map((entry) => ({ ...entry, rejected: [...entry.rejected] }));
  }

  getEscalationCount(executionId: string): number {
    return this.escalations.get(executionId)?.count ?? 0;
  }

  getModelHealth(executionId: string, modelId: string): ModelHealth | undefined {
    const health = this.health.get(executionId)?.get(modelId);
    return health ? { ...health } : undefined;
  }

  clearExecution(executionId: string): void {
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${executionId}\u0000`)) this.sessions.delete(key);
    }
    this.health.delete(executionId);
    this.history.delete(executionId);
    this.escalations.delete(executionId);
  }

  route(request: RouteRequest): RouteDecision {
    const policy = this.policies[request.phase];
    const own = this.sessions.get(sessionKey(request.executionId, request.phase));
    const inherited = own ? undefined : this.findInheritableSession(request.executionId, policy);
    const stickySession = own ?? inherited;
    const stickyModelId = stickySession?.modelId;

    const scores = this.scoreAll(request, policy, stickyModelId);
    const rejected = scores.filter((s) => !s.eligible).map((s) => ({ modelId: s.modelId, reason: s.rejectReason! }));

    if (stickyModelId) {
      const stickyScore = scores.find((s) => s.modelId === stickyModelId);
      if (stickyScore?.eligible) {
        return this.commit(request, policy, stickyScore, {
          kind: 'route',
          reason: own ? 'sticky_reuse' : 'sticky_inherited',
          sticky: true,
          degraded: false,
          rejected,
          previousModelId: stickyModelId,
        });
      }
    }

    const breakReason: RouteReason = stickyModelId
      ? failoverReason(scores.find((s) => s.modelId === stickyModelId))
      : 'initial_selection';
    return this.selectBest(request, policy, scores, rejected, breakReason, stickyModelId, 'route');
  }

  recordOutcome(executionId: string, phase: ExecutionPhase, outcome: RouteOutcome): ModelHealth {
    const perExecution = this.health.get(executionId) ?? new Map<string, ModelHealth>();
    this.health.set(executionId, perExecution);
    const current = perExecution.get(outcome.modelId) ?? { consecutiveFailures: 0 };
    const next: ModelHealth = { ...current };
    next.consecutiveFailures = outcome.success ? 0 : current.consecutiveFailures + 1;
    if (outcome.latencyMs !== undefined) {
      next.lastLatencyMs = outcome.latencyMs;
      next.ewmaLatencyMs = current.ewmaLatencyMs === undefined
        ? outcome.latencyMs
        : round(LATENCY_EWMA_ALPHA * outcome.latencyMs + (1 - LATENCY_EWMA_ALPHA) * current.ewmaLatencyMs);
    }
    perExecution.set(outcome.modelId, next);

    const session = this.sessions.get(sessionKey(executionId, phase));
    if (session && session.modelId === outcome.modelId) {
      session.consecutiveFailures = next.consecutiveFailures;
      session.lastLatencyMs = next.lastLatencyMs;
    }
    return { ...next };
  }

  escalateRoute(request: EscalationRequest): RouteDecision {
    const policy = this.policies[request.phase];
    const state = this.escalations.get(request.executionId) ?? { count: 0, abandoned: new Set<string>() };
    this.escalations.set(request.executionId, state);
    const session = this.sessions.get(sessionKey(request.executionId, request.phase))
      ?? this.findInheritableSession(request.executionId, policy);
    const currentModelId = session?.modelId;

    if (state.count >= this.maxEscalations) {
      return this.record({
        sequence: ++this.sequence,
        at: this.now(),
        kind: 'escalation',
        status: 'escalation_denied',
        executionId: request.executionId,
        phase: request.phase,
        reason: 'escalation_limit',
        modelId: currentModelId,
        providerId: session?.providerId,
        previousModelId: currentModelId,
        sticky: Boolean(currentModelId),
        degraded: false,
        rejected: [],
        escalationsUsed: state.count,
        note: request.reason,
      });
    }

    const excluded = new Set(state.abandoned);
    if (currentModelId) excluded.add(currentModelId);
    const currentQuality = request.candidates.find((c) => c.modelId === currentModelId)?.qualityScore ?? 0;

    const scores = this.scoreAll(request, policy, undefined).map((s) =>
      excluded.has(s.modelId) ? { ...s, eligible: false, rejectReason: 'excluded' as RejectReason } : s,
    );
    const rejected = scores.filter((s) => !s.eligible).map((s) => ({ modelId: s.modelId, reason: s.rejectReason! }));
    const quality = new Map(request.candidates.map((c) => [c.modelId, c.qualityScore ?? 1]));
    // Escalation moves to a stronger model when one exists; fall back to any eligible peer.
    const stronger = scores.filter((s) => s.eligible && (quality.get(s.modelId) ?? 0) > currentQuality);
    const pool = stronger.length > 0 ? stronger : scores.filter((s) => s.eligible);
    const best = [...pool].sort((a, b) =>
      (quality.get(b.modelId) ?? 0) - (quality.get(a.modelId) ?? 0) || byScoreThenId(a, b),
    )[0];

    if (!best) {
      return this.record({
        sequence: ++this.sequence,
        at: this.now(),
        kind: 'escalation',
        status: 'unroutable',
        executionId: request.executionId,
        phase: request.phase,
        reason: 'no_eligible_candidate',
        previousModelId: currentModelId,
        sticky: false,
        degraded: false,
        rejected,
        escalationsUsed: state.count,
        note: request.reason,
      });
    }

    state.count += 1;
    if (currentModelId) state.abandoned.add(currentModelId);
    return this.commit(request, policy, best, {
      kind: 'escalation',
      reason: 'escalation',
      sticky: false,
      degraded: false,
      rejected,
      previousModelId: currentModelId,
      note: request.reason,
      resetSession: true,
    });
  }

  private scoreAll(request: RouteRequest, policy: PhaseRoutePolicy, stickyModelId: string | undefined): CandidateScore[] {
    const perExecution = this.health.get(request.executionId);
    return request.candidates.map((candidate) =>
      scoreRouteCandidate(candidate, {
        policy,
        stickyModelId,
        requiredContextTokens: request.requiredContextTokens,
        health: perExecution?.get(candidate.modelId),
      }),
    );
  }

  private selectBest(
    request: RouteRequest,
    policy: PhaseRoutePolicy,
    scores: CandidateScore[],
    rejected: RouteDecision['rejected'],
    reason: RouteReason,
    previousModelId: string | undefined,
    kind: RouteDecision['kind'],
  ): RouteDecision {
    // Never re-pick the model whose stickiness was just broken unless nothing else works.
    const eligible = scores.filter((s) => s.eligible).sort(byScoreThenId);
    let best = eligible[0];
    let degraded = false;
    if (!best) {
      best = scores
        .filter((s) => s.rejectReason && SOFT_REJECTS.has(s.rejectReason) && s.modelId !== previousModelId)
        .sort(byScoreThenId)[0]
        ?? scores.filter((s) => s.rejectReason && SOFT_REJECTS.has(s.rejectReason)).sort(byScoreThenId)[0];
      degraded = Boolean(best);
    }
    if (!best) {
      const escalationsUsed = this.getEscalationCount(request.executionId);
      return this.record({
        sequence: ++this.sequence,
        at: this.now(),
        kind,
        status: 'unroutable',
        executionId: request.executionId,
        phase: request.phase,
        reason: 'no_eligible_candidate',
        previousModelId,
        sticky: false,
        degraded: false,
        rejected,
        escalationsUsed,
      });
    }
    return this.commit(request, policy, best, {
      kind,
      reason,
      sticky: false,
      degraded,
      rejected,
      previousModelId,
      resetSession: true,
    });
  }

  private commit(
    request: RouteRequest,
    _policy: PhaseRoutePolicy,
    score: CandidateScore,
    meta: {
      kind: RouteDecision['kind'];
      reason: RouteReason;
      sticky: boolean;
      degraded: boolean;
      rejected: RouteDecision['rejected'];
      previousModelId?: string;
      note?: string;
      resetSession?: boolean;
    },
  ): RouteDecision {
    const sequence = ++this.sequence;
    const key = sessionKey(request.executionId, request.phase);
    const existing = this.sessions.get(key);
    const health = this.health.get(request.executionId)?.get(score.modelId);
    if (existing && existing.modelId === score.modelId && !meta.resetSession) {
      existing.turns += 1;
      existing.updatedSequence = sequence;
    } else {
      this.sessions.set(key, {
        executionId: request.executionId,
        phase: request.phase,
        modelId: score.modelId,
        providerId: score.providerId,
        turns: 1,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        lastLatencyMs: health?.lastLatencyMs,
        updatedSequence: sequence,
      });
    }
    if (meta.kind === 'escalation') {
      // An escalated model starts with a clean failure streak so it is not immediately failed over.
      const perExecution = this.health.get(request.executionId);
      const h = perExecution?.get(score.modelId);
      if (h) h.consecutiveFailures = 0;
    }

    return this.record({
      sequence,
      at: this.now(),
      kind: meta.kind,
      status: 'routed',
      executionId: request.executionId,
      phase: request.phase,
      reason: meta.reason,
      modelId: score.modelId,
      providerId: score.providerId,
      previousModelId: meta.previousModelId,
      sticky: meta.sticky,
      degraded: meta.degraded,
      score: score.total,
      breakdown: score.breakdown,
      rejected: meta.rejected,
      escalationsUsed: this.getEscalationCount(request.executionId),
      note: meta.note,
    });
  }

  private findInheritableSession(executionId: string, policy: PhaseRoutePolicy): StickyRouteSession | undefined {
    if (!policy.preserveContextCache) return undefined;
    let latest: StickyRouteSession | undefined;
    for (const phase of policy.compatiblePhases) {
      if (phase === policy.phase) continue;
      const candidate = this.sessions.get(sessionKey(executionId, phase));
      if (candidate && (!latest || candidate.updatedSequence > latest.updatedSequence)) latest = candidate;
    }
    return latest;
  }

  private record(decision: RouteDecision): RouteDecision {
    const entries = this.history.get(decision.executionId) ?? [];
    entries.push(decision);
    this.history.set(decision.executionId, entries);
    return { ...decision, rejected: [...decision.rejected] };
  }
}

function sessionKey(executionId: string, phase: ExecutionPhase): string {
  return `${executionId}\u0000${phase}`;
}

function failoverReason(stickyScore: CandidateScore | undefined): RouteReason {
  switch (stickyScore?.rejectReason) {
    case undefined:
      return 'failover_unavailable';
    case 'circuit_open':
      return 'failover_circuit';
    case 'context_overflow':
      return 'failover_context';
    case 'latency_sla':
      return 'failover_latency';
    case 'consecutive_failures':
      return 'failover_failures';
    default:
      return 'failover_unavailable';
  }
}
