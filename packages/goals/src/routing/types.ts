import type {
  ComputerRegistry,
  ModelInstance,
  ModelRecord,
  ModelRegistry,
  ModelReliabilityTracker,
  Pricing,
  RuntimeRegistry,
} from '@wazir/core';
import type { GoalStudioDeps, GoalStudioError, ModelRouteDecision, ModelRouter } from '../contracts.js';

/**
 * Structural subset of `@wazir/runtimes-interfaces` RuntimeAdapter that a
 * readiness probe needs. Every real adapter (Ollama, LM Studio, ...) satisfies it,
 * so `@wazir/goals` does not take a dependency on the runtime packages.
 */
export interface ProbeAdapter {
  readonly id?: string;
  readonly type?: string;
  generate(request: ProbeGenerationRequest): AsyncIterable<ProbeGenerationEvent>;
}

export interface ProbeGenerationRequest {
  modelId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  stream?: boolean;
  signal?: AbortSignal;
  requestId?: string;
  enableThinking?: boolean;
  executionLimits?: { maxModelCalls?: number; deadlineAt?: number };
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'none' | 'required';
  resourceContext?: { taskId?: string; workload?: string; agent?: string };
}

export interface ProbeGenerationEvent {
  type: string;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  error?: string;
  finishReason?: string;
}

export type ProbeAdapterResolver =
  | Map<string, ProbeAdapter>
  | Record<string, ProbeAdapter>
  | ((runtimeId: string) => ProbeAdapter | undefined);

export type CheckVerdict = 'verified' | 'failed' | 'untested';

/** One readiness observation for one model instance. */
export interface ReadinessRecord {
  modelId: string;
  instanceId: string;
  runtimeId: string;
  /** Model id as the runtime knows it (what the probe actually sent). */
  runtimeModelId?: string;
  computerId?: string;
  ready: boolean;
  /** ISO-8601. Freshness is judged against the probe TTL. */
  checkedAt: string;
  latencyMs?: number;
  /** 'probe' = tiny real generation; 'execution' = a real routed task succeeded/failed. */
  source: 'probe' | 'execution' | 'external';
  generation: CheckVerdict;
  toolUse: CheckVerdict;
  reason: string;
  outputExcerpt?: string;
  error?: string;
}

export interface ProbeOptions {
  /** Ignore a fresh cached result and probe again. */
  force?: boolean;
  /** Also verify native tool calling (only meaningful for models that declare it). */
  tools?: boolean;
}

export interface ReadinessProbe {
  readonly ttlMs: number;
  /**
   * Performs (or returns a fresh cached) tiny real generation against the
   * instance's local runtime. Never contacts a hosted/paid provider.
   */
  probe(target: { modelId: string; instanceId?: string }, options?: ProbeOptions): Promise<ReadinessRecord>;
  /** Latest record for the instance (or the model's freshest), fresh or not. Never probes. */
  status(modelId: string, instanceId?: string): ReadinessRecord | undefined;
  /** True when `record` is a successful observation younger than the TTL. */
  isFresh(record: ReadinessRecord | undefined): boolean;
  /** Stores externally obtained evidence (e.g. a successful routed execution). */
  record(record: ReadinessRecord): void;
  /** Drops readiness so the instance must be re-verified before it is routed again. */
  invalidate(modelId: string, instanceId?: string, reason?: string): void;
  list(): ReadinessRecord[];
}

export interface ModelRouterDeps extends GoalStudioDeps {
  models: ModelRegistry;
  runtimes?: RuntimeRegistry;
  computers?: ComputerRegistry;
  /** Per-(model, task class) circuit breaker. A private tracker is created when absent. */
  reliability?: ModelReliabilityTracker;
  /** Readiness evidence source. Built from `adapters` when absent. */
  probe?: ReadinessProbe;
  /** Runtime adapters by runtime id (e.g. the API server's `state.adapters`). */
  adapters?: ProbeAdapterResolver;
  /** USD per million tokens for hosted models. A hosted model without pricing is never routed. */
  pricing?: (modelId: string, runtimeId: string) => Pricing | undefined;
  /** Tokens assumed per routed task when estimating hosted cost. Default 8000 in / 2000 out. */
  estimatedTokens?: { input: number; output: number };
  /** Reliability task class Goal Studio routes record against. Default 'goal-studio'. */
  taskClass?: string;
  /** Readiness TTL when the probe is built here. Default 10 minutes. */
  readinessTtlMs?: number;
  /** Probe timeout when the probe is built here. Default 20 s. */
  probeTimeoutMs?: number;
}

export interface RouteRequest {
  requiredCapabilities: string[];
  remainingHostedBudgetUsd: number;
  localFirst: boolean;
  excludeModelIds?: string[];
}

/** `ModelRouteDecision` plus the measurements behind it (extra fields are additive). */
export interface GoalModelRouteDecision extends ModelRouteDecision {
  instanceId: string;
  score: number;
  estimatedLatencyMs?: number;
  readiness: { checkedAt: string; latencyMs?: number; source: ReadinessRecord['source'] };
}

export interface RouteCandidateExplanation {
  modelId: string;
  instanceId?: string;
  runtimeId?: string;
  computerId?: string;
  hosted: boolean;
  eligible: boolean;
  score?: number;
  estimatedCostUsd?: number;
  estimatedLatencyMs?: number;
  reasons: string[];
  /** Present when ineligible or outranked. */
  rejection?: string;
}

export interface RouteExplanation {
  request: RouteRequest;
  decision?: GoalModelRouteDecision;
  candidates: RouteCandidateExplanation[];
  decidedAt: string;
}

export interface RouteOutcomeInput {
  decision: ModelRouteDecision;
  ok: boolean;
  /** Wall-clock latency of the routed work. */
  latencyMs: number;
  actualCostUsd?: number;
  tokens?: { input: number; output: number };
  error?: string | GoalStudioError;
  /** Wazir TerminationReason; classifies the failure for the circuit breaker. */
  terminationReason?: string;
  /** Without a terminationReason, failures count against the model only when true. */
  modelAttributable?: boolean;
  taskClass?: string;
  runId?: string;
  targetId?: string;
  attemptId?: string;
}

export interface RouteOutcomeRecord {
  seq: number;
  modelId: string;
  instanceId?: string;
  runtimeId: string;
  computerId?: string;
  hosted: boolean;
  ok: boolean;
  attributable: boolean;
  taskClass: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  estimatedLatencyMs?: number;
  actualLatencyMs: number;
  error?: string;
  terminationReason?: string;
  runId?: string;
  targetId?: string;
  attemptId?: string;
  recordedAt: string;
}

export interface ModelAccounting {
  modelId: string;
  routes: number;
  successes: number;
  failures: number;
  attributableSamples: number;
  attributableSuccessRate?: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  avgEstimatedLatencyMs?: number;
  avgActualLatencyMs?: number;
  lastOutcomeAt?: string;
}

export interface FleetModelEntry {
  modelId: string;
  name: string;
  provider: string;
  local: boolean;
  hosted: boolean;
  state: string;
  capabilities: {
    declared: string[];
    toolCalling: boolean;
    structuredOutput: boolean;
    vision: boolean;
    reasoning: boolean;
    contextTokens: number;
  };
  instances: Array<{
    id: string;
    runtimeId: string;
    computerId?: string;
    state?: string;
    health: string;
    loaded: boolean;
    contextTokens?: number;
    hosted: boolean;
    readiness?: ReadinessRecord & { fresh: boolean; ageMs: number };
  }>;
  readiness: { ready: boolean; fresh: boolean; checkedAt?: string; ageMs?: number; latencyMs?: number; toolUse?: CheckVerdict; reason: string };
  reliability: { state: string; samples: number; failures: number; failureRate: number; reason: string };
  accounting: ModelAccounting;
}

export interface FleetComputerEntry {
  id: string;
  name: string;
  workerId: string;
  local: boolean;
  status: string;
  health: string;
  heartbeat: 'fresh' | 'stale' | 'offline' | 'local';
  lastHeartbeat?: string;
  runtimes: string[];
  models: string[];
  resources?: {
    totalMemoryGB: number;
    availableMemoryGB?: number;
    totalVramGB?: number;
    availableVramGB?: number;
    unifiedMemory: boolean;
    cpuUtilization?: number;
    gpuUtilization?: number;
    activeReservations: number;
    reservedMemoryGB: number;
    observedAt: string;
  };
  resourceError?: string;
}

export interface FleetSnapshot {
  generatedAt: string;
  readinessTtlMs: number;
  taskClass: string;
  summary: { models: number; verifiedReady: number; hosted: number; computers: number; computersOnline: number; runtimes: number; runtimesHealthy: number };
  models: FleetModelEntry[];
  runtimes: Array<{ id: string; type: string; name: string; kind: 'local' | 'hosted'; health: string; computerId?: string; loadedModels: string[]; lastCheckedAt?: string }>;
  computers: FleetComputerEntry[];
}

export interface ProbeSweepResult {
  probed: ReadinessRecord[];
  skipped: Array<{ modelId: string; instanceId?: string; reason: string }>;
}

export interface FleetModelRegistrationInput {
  id: string;
  name?: string;
  provider?: string;
  family?: ModelRecord['family'];
  contextMax?: number;
  configuredContext?: number;
  capabilities?: ModelRecord['capabilities'];
  toolCalling?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  audio?: boolean;
  embedding?: boolean;
  reasoning?: boolean;
  quantization?: string;
  version?: string;
  memory?: ModelRecord['memory'];
  runtimeCompatibility?: ModelRecord['runtimeCompatibility'];
  local?: boolean;
  instance?: {
    id?: string;
    runtimeId: string;
    computerId?: string;
    runtimeModelId?: string;
    loaded?: boolean;
    state?: ModelInstance['state'];
    health?: ModelInstance['health'];
    contextTokens?: number;
  };
  readiness?: {
    ready: boolean;
    latencyMs?: number;
    toolUse?: CheckVerdict;
    reason?: string;
    source?: ReadinessRecord['source'];
  };
}

/** The ModelRouter Goal Studio composes, plus the fleet-monitoring surface. */
export interface FleetModelRouter extends ModelRouter {
  route(input: RouteRequest): Promise<GoalModelRouteDecision | undefined>;
  /** Dry run: the decision plus every candidate's evaluation. No side effects. */
  explain(input: RouteRequest): Promise<RouteExplanation>;
  /** Records actual cost/latency against the estimate; feeds reliability and readiness. */
  recordOutcome(input: RouteOutcomeInput): Promise<RouteOutcomeRecord>;
  /**
   * Records the failure, invalidates the failed instance's readiness, and re-routes
   * excluding it. The new decision's first reason is "fallback after <error>".
   */
  fallback(input: RouteRequest & { failed: ModelRouteDecision; error: string | GoalStudioError; latencyMs?: number; terminationReason?: string; modelAttributable?: boolean }): Promise<GoalModelRouteDecision | undefined>;
  /** Probes local instances only; hosted instances are listed as skipped. */
  probeLocal(options?: { modelIds?: string[]; force?: boolean; tools?: boolean }): Promise<ProbeSweepResult>;
  /** Registers or updates a model record (and optional serving instance / readiness record) in the fleet. */
  registerModel?(input: FleetModelRegistrationInput): Promise<FleetModelEntry>;
  fleet(): Promise<FleetSnapshot>;
  accounting(): Promise<ModelAccounting[]>;
  outcomes(modelId?: string): Promise<RouteOutcomeRecord[]>;
  readonly readiness: ReadinessProbe;
}
