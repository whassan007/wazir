import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  OptimizableConfig, ExperimentPlan, CandidateImplementation, BaselineRecord,
  MetaOptimizationRunResult, MetaOptimizationBudget, MetaOptimizerBudgetConsumption,
  BenchmarkRunResult,
} from '@wazir/core';

export const OPTIMIZER_STATE_KEY = 'meta_optimizer/state/v1';
const zeroUsage = (): MetaOptimizerBudgetConsumption => ({ experimentsCount: 0, candidatesCount: 0, modelCallsCount: 0, tokensCount: 0, wallTimeMs: 0, costUSD: 0 });
export interface OptimizerExperimentState {
  id: string;
  baselineRevision: number;
  baselineConfig: OptimizableConfig;
  budget: MetaOptimizationBudget;
  usage: MetaOptimizerBudgetConsumption;
  startedAt: number;
  status: 'RUNNING' | 'COMPLETED' | 'STOPPED';
  stopReason?: string;
  samples: Record<string, BenchmarkRunResult>;
}
export interface OptimizerState {
  schemaVersion: 1;
  revision: number;
  configRevision: number;
  activeConfig: OptimizableConfig;
  budget: MetaOptimizationBudget;
  consumption: MetaOptimizerBudgetConsumption;
  plans: Record<string, ExperimentPlan>;
  candidates: Record<string, CandidateImplementation>;
  baselines: Record<string, BaselineRecord>;
  history: MetaOptimizationRunResult[];
  rollbacks: Array<{ candidateId: string; runId: string; previous: OptimizableConfig; promoted: OptimizableConfig }>;
  experiments: Record<string, OptimizerExperimentState>;
  inFlight?: { id: string; experimentId: string; sampleKey: string; taskId: string; repetition: number; startedAt: number };
  accountingUncertain?: string;
  receipts: Record<string, { experimentId: string; sampleKey: string; executionId: string }>;
}

function requireId(id: string): void {
  if (typeof id !== 'string' || !id || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('INVALID_OPTIMIZER_ID');
}
function validConfig(value: OptimizableConfig): boolean {
  return !!value && typeof value.id === 'string' && value.id.length > 0 && Number.isSafeInteger(value.version) && value.version >= 0;
}
export function validateBudget(budget: MetaOptimizationBudget): void {
  for (const key of ['maxExperiments', 'maxCandidatesPerExperiment', 'maxModelCalls', 'maxTokens', 'maxWallTimeMs'] as const) {
    if (!Number.isFinite(budget?.[key]) || budget[key] < 0) throw new Error(`INVALID_OPTIMIZER_BUDGET: ${key}`);
  }
  for (const key of ['maxExperiments', 'maxCandidatesPerExperiment', 'maxModelCalls', 'maxTokens'] as const) {
    if (!Number.isSafeInteger(budget[key])) throw new Error(`INVALID_OPTIMIZER_BUDGET: ${key} must be an integer`);
  }
  for (const key of ['maxMonetaryCostUSD', 'maxGPUTimeMs'] as const) {
    if (budget[key] !== undefined && (!Number.isFinite(budget[key]) || budget[key] < 0)) throw new Error(`INVALID_OPTIMIZER_BUDGET: ${key}`);
  }
}
function validateState(state: OptimizerState): void {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.configRevision) || state.configRevision < 0 || !validConfig(state.activeConfig) ||
      !state.receipts || !state.plans || !state.candidates || !state.baselines || !state.experiments || !Array.isArray(state.history) || !Array.isArray(state.rollbacks)) {
    throw new Error('INVALID_OPTIMIZER_STATE: Unsupported or corrupt optimizer snapshot');
  }
  validateBudget(state.budget);
  for (const key of Object.keys(zeroUsage())) {
    if (!Number.isFinite(state.consumption?.[key]) || state.consumption[key] < 0) throw new Error(`INVALID_OPTIMIZER_STATE: consumption.${key}`);
  }
  for (const experiment of Object.values(state.experiments)) {
    if (!experiment || !experiment.samples || !validConfig(experiment.baselineConfig) || !Number.isFinite(experiment.startedAt)) throw new Error('INVALID_OPTIMIZER_STATE: experiment');
    validateBudget(experiment.budget);
    for (const key of Object.keys(zeroUsage())) {
      if (!Number.isFinite(experiment.usage?.[key]) || experiment.usage[key] < 0) throw new Error('INVALID_OPTIMIZER_STATE: experiment usage');
    }
  }
  if (state.inFlight && (!state.inFlight.id || !state.experiments[state.inFlight.experimentId] || !Number.isFinite(state.inFlight.startedAt))) {
    throw new Error('INVALID_OPTIMIZER_STATE: in-flight sample');
  }
}

export class OptimizerStateManager {
  private memory: OptimizerState;
  private initialization?: Promise<void>;
  constructor(private readonly store: KeyValueStore | undefined, config: OptimizableConfig, budget: MetaOptimizationBudget) {
    validateBudget(budget);
    this.memory = { schemaVersion: 1, revision: 0, configRevision: 0, activeConfig: structuredClone(config), budget: structuredClone(budget),
      consumption: zeroUsage(), plans: {}, candidates: {}, baselines: {}, history: [], rollbacks: [], experiments: {}, receipts: {} };
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        if (!this.store) return;
        if (!this.store.update) throw new Error('OPTIMIZER_ATOMIC_STORE_REQUIRED: Store must support atomic update');
        const existing = await this.store.get<OptimizerState>(OPTIMIZER_STATE_KEY);
        if (existing !== undefined) { validateState(existing); this.memory = structuredClone(existing); return; }
        const [active, oldRuns, runs, plans] = await Promise.all([
          this.store.get<OptimizableConfig>('meta_optimizer/active_config'),
          this.store.list('meta_optimizer/runs/'), this.store.list('meta/history/'), this.store.list('meta/plans/'),
        ]);
        const seed = structuredClone(this.memory);
        if (active !== undefined) {
          if (!validConfig(active)) throw new Error('INVALID_OPTIMIZER_STATE: legacy active configuration');
          seed.activeConfig = active;
        }
        for (const entry of [...oldRuns, ...runs]) {
          const run = entry.value as MetaOptimizationRunResult;
          if (!run?.runId || !validConfig(run.baselineConfig) || !validConfig(run.candidateConfig)) throw new Error('INVALID_OPTIMIZER_STATE: legacy history');
          if (!seed.history.some((r) => r.runId === run.runId)) seed.history.push(run);
        }
        for (const entry of plans) {
          const plan = entry.value as ExperimentPlan;
          if (!plan?.experimentId) throw new Error('INVALID_OPTIMIZER_STATE: legacy plan');
          seed.plans[plan.experimentId] = plan;
        }
        // Old stores did not record complete usage. Restoring history must not reset quota.
        if (active !== undefined || seed.history.length > 0 || Object.keys(seed.plans).length > 0) seed.accountingUncertain = 'Legacy optimizer usage has no complete ledger; reconciliation required';
        this.memory = await this.store.update(OPTIMIZER_STATE_KEY, (current: OptimizerState | undefined) => {
          if (current !== undefined) { validateState(current); return current; }
          return seed;
        });
      })().catch((error) => { this.initialization = undefined; throw error; });
    }
    await this.initialization;
  }

  async read(): Promise<OptimizerState> {
    await this.initialize();
    const current = this.store ? await this.store.get<OptimizerState>(OPTIMIZER_STATE_KEY) : this.memory;
    validateState(current!);
    return structuredClone(current!);
  }
  private async mutate(change: (state: OptimizerState) => void): Promise<OptimizerState> {
    await this.initialize();
    const update = (current: OptimizerState | undefined) => {
      validateState(current!);
      const next = structuredClone(current!);
      change(next);
      next.revision++;
      validateState(next);
      return next;
    };
    const result = this.store ? await this.store.update!(OPTIMIZER_STATE_KEY, update) : update(this.memory);
    this.memory = structuredClone(result);
    return structuredClone(result);
  }

  async plan(plan: ExperimentPlan): Promise<void> {
    requireId(plan.experimentId);
    await this.mutate((s) => {
      const existing = s.plans[plan.experimentId];
      if (existing && JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error('OPTIMIZER_PLAN_IMMUTABLE: Use a new experiment ID');
      s.plans[plan.experimentId] = structuredClone(plan);
    });
  }
  async baseline(baseline: BaselineRecord): Promise<void> {
    await this.mutate((s) => { s.baselines[baseline.id] = structuredClone(baseline); });
  }
  async addCandidates(plan: ExperimentPlan, candidates: CandidateImplementation[]): Promise<OptimizerState> {
    requireId(plan.experimentId);
    for (const candidate of candidates) requireId(candidate.candidateId);
    return this.mutate((s) => {
      const existingCount = Object.values(s.candidates).filter((c) => c.experimentId === plan.experimentId).length;
      if (existingCount + candidates.length > Math.min(s.budget.maxCandidatesPerExperiment, plan.budget.maxCandidatesPerExperiment) ||
          s.consumption.candidatesCount + candidates.length > s.budget.maxExperiments * s.budget.maxCandidatesPerExperiment) {
        throw new Error('META_OPTIMIZATION_BUDGET_EXHAUSTED: Candidate limit');
      }
      for (const candidate of candidates) {
        if (s.candidates[candidate.candidateId]) throw new Error('OPTIMIZER_CANDIDATE_ALREADY_RECORDED');
        s.candidates[candidate.candidateId] = { ...structuredClone(candidate), experimentId: plan.experimentId };
      }
      s.consumption.candidatesCount += candidates.length;
    });
  }
  async candidateStatus(candidate: CandidateImplementation): Promise<void> {
    await this.mutate((s) => {
      const previous = s.candidates[candidate.candidateId];
      if (!previous) return;
      if (JSON.stringify(previous.config) !== JSON.stringify(candidate.config)) throw new Error('OPTIMIZER_CANDIDATE_CONFIG_CHANGED: Create a new candidate');
      s.candidates[candidate.candidateId] = { ...structuredClone(candidate), experimentId: previous.experimentId };
    });
  }
  private checkResources(s: OptimizerState, experiment?: OptimizerExperimentState): void {
    if (s.accountingUncertain) throw new Error(`OPTIMIZER_ACCOUNTING_UNKNOWN: ${s.accountingUncertain}`);
    if (s.inFlight) throw new Error(`OPTIMIZER_SAMPLE_PENDING: ${s.inFlight.id}; outcome must be reconciled before dispatch`);
    for (const [usage, budget] of [[s.consumption, s.budget], ...(experiment ? [[experiment.usage, experiment.budget]] : [])] as Array<[MetaOptimizerBudgetConsumption, MetaOptimizationBudget]>) {
      for (const [used, limit] of [['modelCallsCount', 'maxModelCalls'], ['tokensCount', 'maxTokens'], ['wallTimeMs', 'maxWallTimeMs'], ['costUSD', 'maxMonetaryCostUSD']] as const) {
        if (budget[limit] !== undefined && usage[used] >= budget[limit]) throw new Error(`META_OPTIMIZATION_BUDGET_EXHAUSTED: ${limit}`);
      }
      if (budget.maxGPUTimeMs !== undefined) throw new Error('OPTIMIZER_GPU_ACCOUNTING_UNAVAILABLE: GPU budget cannot be enforced by this runner');
    }
    if (experiment && Date.now() - experiment.startedAt >= experiment.budget.maxWallTimeMs) throw new Error('META_OPTIMIZATION_BUDGET_EXHAUSTED: Experiment deadline');
  }
  async begin(plan: ExperimentPlan, expectedConfig: OptimizableConfig): Promise<OptimizerState> {
    requireId(plan.experimentId);
    return this.mutate((s) => {
      this.checkResources(s);
      if (JSON.stringify(s.activeConfig) !== JSON.stringify(expectedConfig)) throw new Error('OPTIMIZER_BASELINE_CHANGED: Reevaluate against the current baseline');
      if (s.experiments[plan.experimentId]) throw new Error('OPTIMIZER_EXPERIMENT_EXISTS: Never replay an existing experiment; inspect its diagnostics');
      if (s.consumption.experimentsCount >= s.budget.maxExperiments) throw new Error('META_OPTIMIZATION_BUDGET_EXHAUSTED: maxExperiments');
      const budget = { ...s.budget, ...plan.budget }; validateBudget(budget);
      s.experiments[plan.experimentId] = { id: plan.experimentId, baselineRevision: s.configRevision, baselineConfig: structuredClone(s.activeConfig), budget,
        usage: zeroUsage(), startedAt: Date.now(), status: 'RUNNING', samples: {} };
      s.consumption.experimentsCount++;
    });
  }
  async reserve(experimentId: string, sampleKey: string, taskId: string, repetition: number): Promise<{ id: string; remaining: { maxTokens: number; maxModelCalls: number; maxWallTimeMs: number; maxMonetaryCostUSD?: number } }> {
    const id = randomUUID();
    const state = await this.mutate((s) => {
      const experiment = s.experiments[experimentId];
      if (!experiment || experiment.status !== 'RUNNING') throw new Error('OPTIMIZER_EXPERIMENT_NOT_RUNNING');
      this.checkResources(s, experiment);
      if (experiment.samples[sampleKey]) throw new Error('OPTIMIZER_SAMPLE_ALREADY_RECORDED');
      s.inFlight = { id, experimentId, sampleKey, taskId, repetition, startedAt: Date.now() };
    });
    const e = state.experiments[experimentId];
    const remaining = (metric: keyof MetaOptimizerBudgetConsumption, limit: keyof MetaOptimizationBudget) => Math.min(
      state.budget[limit] === undefined ? Infinity : state.budget[limit] - state.consumption[metric],
      e.budget[limit] === undefined ? Infinity : e.budget[limit] - e.usage[metric],
    );
    return { id, remaining: {
      maxTokens: remaining('tokensCount', 'maxTokens'), maxModelCalls: remaining('modelCallsCount', 'maxModelCalls'),
      maxWallTimeMs: Math.max(0, Math.min(remaining('wallTimeMs', 'maxWallTimeMs'), e.budget.maxWallTimeMs - (Date.now() - e.startedAt))),
      ...(Number.isFinite(remaining('costUSD', 'maxMonetaryCostUSD')) ? { maxMonetaryCostUSD: remaining('costUSD', 'maxMonetaryCostUSD') } : {}),
    } };
  }
  async complete(id: string, result: BenchmarkRunResult): Promise<OptimizerState> {
    return this.mutate((s) => {
      const receipt = s.receipts[id];
      if (receipt) {
        const previous = s.experiments[receipt.experimentId].samples[receipt.sampleKey];
        if (JSON.stringify(previous) !== JSON.stringify(result)) throw new Error('OPTIMIZER_SAMPLE_RECEIPT_CONFLICT');
        return; // A retry after a committed write must not charge twice.
      }
      const pending = s.inFlight;
      if (!pending || pending.id !== id || pending.taskId !== result.taskId || pending.repetition !== result.repetition) throw new Error('OPTIMIZER_SAMPLE_RESERVATION_MISMATCH');
      const experiment = s.experiments[pending.experimentId];
      experiment.samples[pending.sampleKey] = structuredClone(result);
      const m = result.scoreReport?.metrics;
      const usage = { modelCallsCount: m?.totalModelCalls, tokensCount: m?.inputTokens + m?.outputTokens,
        wallTimeMs: result.durationMs, costUSD: m?.costEstimateUsd };
      if (result.error || m?.rawMetrics?.tokenUsageAvailable !== true || m?.rawMetrics?.modelCallCountAvailable !== true || !Number.isSafeInteger(usage.tokensCount) || !Number.isSafeInteger(usage.modelCallsCount) ||
          (usage.tokensCount > 0 && usage.modelCallsCount === 0) || Object.values(usage).some((v) => !Number.isFinite(v) || v < 0)) {
        s.accountingUncertain = `Sample ${pending.id} failed or has incomplete usage telemetry`;
      }
      for (const [key, value] of Object.entries(usage)) {
        if ((key === 'tokensCount' && (m?.rawMetrics?.tokenUsageAvailable !== true || !Number.isSafeInteger(value))) ||
            (key === 'modelCallsCount' && (m?.rawMetrics?.modelCallCountAvailable !== true || !Number.isSafeInteger(value)))) continue;
        if (Number.isFinite(value) && value >= 0) { s.consumption[key] += value; experiment.usage[key] += value; }
      }
      s.receipts[id] = { experimentId: pending.experimentId, sampleKey: pending.sampleKey, executionId: result.scoreReport.executionId };
      delete s.inFlight;
      const limits = [[s.consumption, s.budget], [experiment.usage, experiment.budget]] as const;
      const exceeded = limits.some(([used, budget]) => used.modelCallsCount > budget.maxModelCalls || used.tokensCount > budget.maxTokens || used.wallTimeMs > budget.maxWallTimeMs ||
        (budget.maxMonetaryCostUSD !== undefined && used.costUSD > budget.maxMonetaryCostUSD));
      if (s.accountingUncertain || exceeded || Date.now() - experiment.startedAt > experiment.budget.maxWallTimeMs) {
        experiment.status = 'STOPPED'; experiment.stopReason = s.accountingUncertain ?? 'META_OPTIMIZATION_BUDGET_EXHAUSTED';
      }
    });
  }
  async stop(experimentId: string, reason: string): Promise<void> {
    await this.mutate((s) => {
      const experiment = s.experiments[experimentId];
      if (experiment) { experiment.status = 'STOPPED'; experiment.stopReason = reason; }
    });
  }
  async record(run: MetaOptimizationRunResult): Promise<OptimizerState> {
    return this.mutate((s) => {
      const index = s.history.findIndex((r) => r.runId === run.runId);
      if (index >= 0) {
        const core = (value: MetaOptimizationRunResult) => {
          const { paretoFrontier, metricVectors, selectedReason, selectedCandidateId, ...evidence } = value as MetaOptimizationRunResult & { selectedReason?: string; selectedCandidateId?: string };
          return evidence;
        };
        if (JSON.stringify(core(s.history[index])) !== JSON.stringify(core(run))) throw new Error('OPTIMIZER_RUN_EVIDENCE_IMMUTABLE');
        s.history[index] = structuredClone(run);
      } else s.history.push(structuredClone(run));
      for (const candidate of Object.values(s.candidates)) {
        if (candidate.config.id === run.candidateConfig.id) candidate.status = 'EVALUATED';
      }
    });
  }
  async finish(experimentId: string): Promise<OptimizerState> {
    return this.mutate((s) => {
      const experiment = s.experiments[experimentId];
      if (experiment?.status === 'RUNNING') experiment.status = 'COMPLETED';
    });
  }
  async promote(candidateId: string, config: OptimizableConfig, run: MetaOptimizationRunResult): Promise<OptimizerState> {
    return this.mutate((s) => {
      const proof = s.history.find((r) => r.runId === run.runId);
      if (!proof?.regressionGuard?.qualified || !['QUALIFIED', 'ACCEPTED'].includes(proof.decision) ||
          JSON.stringify(proof.candidateConfig) !== JSON.stringify(config)) throw new Error('OPTIMIZER_QUALIFICATION_REQUIRED');
      if (s.accountingUncertain || s.inFlight) throw new Error('OPTIMIZER_UNRESOLVED_EXECUTION');
      const experiment = s.experiments[proof.experimentId!];
      if (!experiment || experiment.status !== 'COMPLETED' || experiment.baselineRevision !== s.configRevision ||
          JSON.stringify(proof.baselineConfig) !== JSON.stringify(s.activeConfig)) throw new Error('OPTIMIZER_BASELINE_CHANGED: Reevaluate before promotion');
      s.rollbacks.push({ candidateId, runId: proof.runId, previous: structuredClone(s.activeConfig), promoted: structuredClone(config) });
      s.activeConfig = structuredClone(config); s.configRevision++;
    });
  }
  async rollback(target?: string): Promise<OptimizerState> {
    return this.mutate((s) => {
      const entry = [...s.rollbacks].reverse().find((r) => !target || r.candidateId === target || r.runId === target);
      if (!entry) throw new Error('OPTIMIZER_ROLLBACK_NOT_FOUND');
      if (JSON.stringify(entry.promoted) !== JSON.stringify(s.activeConfig)) throw new Error('OPTIMIZER_ROLLBACK_CONFLICT: Target is not the active promotion');
      s.activeConfig = structuredClone(entry.previous); s.configRevision++;
    });
  }
}
