import { HOSTED_RUNTIME_TYPES, ModelReliabilityTracker, type ModelInstance, type ModelRecord, type Pricing } from '@wazir/core';
import { GoalStudioFailure, type ModelRouteDecision } from '../contracts.js';
import { checkCapabilities, instanceContextTokens, parseCapabilities, type CapabilityRequirements } from './capabilities.js';
import { errorMessage, isHostedInstance } from './hosting.js';
import { createReadinessProbe } from './readinessProbe.js';
import type {
  FleetComputerEntry,
  FleetModelEntry,
  FleetModelRegistrationInput,
  FleetModelRouter,
  FleetSnapshot,
  GoalModelRouteDecision,
  ModelAccounting,
  ModelRouterDeps,
  ProbeSweepResult,
  ReadinessProbe,
  ReadinessRecord,
  RouteCandidateExplanation,
  RouteExplanation,
  RouteOutcomeInput,
  RouteOutcomeRecord,
  RouteRequest,
} from './types.js';

/** KeyValueStore prefixes written only by this workstream (09). */
export const ROUTING_STORE_KEYS = {
  outcome: (modelId: string, seq: number, at: string) => `goals/routing/outcomes/${encodeURIComponent(modelId)}/${at}-${String(seq).padStart(8, '0')}`,
  outcomesPrefix: 'goals/routing/outcomes/',
  readiness: (modelId: string, instanceId: string) => `goals/routing/readiness/${encodeURIComponent(modelId)}/${encodeURIComponent(instanceId)}`,
  readinessPrefix: 'goals/routing/readiness/',
} as const;

const UNSERVABLE_STATES = new Set(['DRAINING', 'UNLOADING', 'UNAVAILABLE', 'LOADING']);
const DEFAULT_TOKENS = { input: 8000, output: 2000 };
const OUTCOME_WINDOW = 20;
const MIN_HISTORY = 3;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface InstanceEval {
  instance: ModelInstance;
  hosted: boolean;
  eligible: boolean;
  tier: number;
  score: number;
  reasons: string[];
  rejection?: string;
  estimatedCostUsd: number;
  estimatedLatencyMs?: number;
  readiness?: ReadinessRecord;
}

interface ModelEval {
  record: ModelRecord;
  best?: InstanceEval;
  instances: InstanceEval[];
  rejection?: string;
}

/**
 * Capability-, readiness-, budget- and reliability-aware model router for Goal Studio.
 *
 * Hard rules (a candidate failing any is rejected with the reason):
 *  1. caller exclusions;
 *  2. the instance is servable: not draining/unloading/loading/unavailable, runtime not
 *     unavailable, computer online (local/remote) — a hosted instance needs a runtime;
 *  3. **verified ready**: a fresh (<= TTL) successful readiness observation — a real
 *     generation probe or a successful routed execution. Healthy heartbeats do not count;
 *  4. required capabilities (tool calling must be probe-verified; context window; flags);
 *  5. hosted spend: budget 0 => never hosted; unknown pricing => never hosted;
 *     estimated cost above the remaining budget => rejected;
 *  6. reliability circuit (ModelReliabilityTracker) not OPEN;
 *  7. resources: a non-resident local model must fit the computer's available memory.
 *
 * Ranking: local-first puts every eligible local instance ahead of every hosted one,
 * then score (residency, measured reliability, latency, headroom, load, cost), then
 * model id and instance id lexicographically, so equal inputs always route equally.
 */
export class GoalStudioModelRouter implements FleetModelRouter {
  readonly readiness: ReadinessProbe;
  private readonly reliability: ModelReliabilityTracker;
  private readonly clock: () => Date;
  private readonly taskClass: string;
  private readonly tokens: { input: number; output: number };
  private outcomesList: RouteOutcomeRecord[] = [];
  private seq = 0;
  private hydrated?: Promise<void>;

  constructor(private readonly deps: ModelRouterDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.taskClass = deps.taskClass ?? 'goal-studio';
    this.tokens = deps.estimatedTokens ?? DEFAULT_TOKENS;
    this.reliability = deps.reliability ?? new ModelReliabilityTracker();
    this.readiness =
      deps.probe ??
      createReadinessProbe({
        models: deps.models,
        runtimes: deps.runtimes,
        adapters: deps.adapters,
        ttlMs: deps.readinessTtlMs,
        timeoutMs: deps.probeTimeoutMs,
        clock: this.clock,
        onRecord: (r) => void this.persistReadiness(r),
      });
  }

  // ------------------------------------------------------------------ routing

  async route(input: RouteRequest): Promise<GoalModelRouteDecision | undefined> {
    return (await this.explain(input)).decision;
  }

  async explain(input: RouteRequest): Promise<RouteExplanation> {
    await this.hydrate();
    const request: RouteRequest = {
      requiredCapabilities: Array.isArray(input?.requiredCapabilities) ? input.requiredCapabilities.filter((c) => typeof c === 'string') : [],
      remainingHostedBudgetUsd: Number.isFinite(input?.remainingHostedBudgetUsd) ? Math.max(0, input.remainingHostedBudgetUsd) : 0,
      localFirst: input?.localFirst !== false,
      excludeModelIds: Array.isArray(input?.excludeModelIds) ? [...input.excludeModelIds] : [],
    };
    const req = parseCapabilities(request.requiredCapabilities);
    const decidedAt = this.clock().toISOString();
    const evals = this.deps.models.list().map((record) => this.evaluateModel(record, req, request));

    const eligible = evals.filter((e) => e.best).sort((a, b) => compareInstance(a.best!, b.best!) || a.record.id.localeCompare(b.record.id));
    const winner = eligible[0];
    const candidates: RouteCandidateExplanation[] = [];
    const rejected: ModelRouteDecision['rejected'] = [];
    for (const e of [...evals].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
      const show = e.best ?? e.instances[0];
      let rejection = e.rejection;
      if (e.best && e !== winner) {
        const w = winner.best!;
        rejection = w.tier < e.best.tier
          ? `outranked: local-first policy prefers local model '${winner.record.id}'`
          : `outranked: score ${e.best.score} < ${w.score} of '${winner.record.id}'`;
        if (w.tier === e.best.tier && w.score === e.best.score) rejection = `outranked: tie at score ${w.score}, '${winner.record.id}' wins lexicographically`;
      }
      if (e !== winner) rejected.push({ modelId: e.record.id, reason: rejection ?? 'not eligible' });
      candidates.push({
        modelId: e.record.id,
        instanceId: show?.instance.id,
        runtimeId: show?.instance.runtimeId,
        computerId: show?.instance.computerId,
        hosted: show?.hosted ?? !e.record.local,
        eligible: !!e.best,
        score: e.best?.score,
        estimatedCostUsd: show?.estimatedCostUsd,
        estimatedLatencyMs: show?.estimatedLatencyMs,
        reasons: show?.reasons ?? [],
        rejection: e === winner ? undefined : rejection,
      });
    }

    let decision: GoalModelRouteDecision | undefined;
    if (winner) {
      const b = winner.best!;
      decision = {
        modelId: winner.record.id,
        runtimeId: b.instance.runtimeId,
        computerId: b.instance.computerId,
        hosted: b.hosted,
        estimatedCostUsd: b.estimatedCostUsd,
        reasons: [
          `selected '${winner.record.id}' via ${b.instance.runtimeId}${b.instance.computerId ? ` on ${b.instance.computerId}` : ''} (score ${b.score}${request.localFirst ? ', local-first' : ''})`,
          ...b.reasons,
          `${eligible.length} eligible of ${evals.length} registered model(s)`,
        ],
        rejected,
        decidedAt,
        instanceId: b.instance.id,
        score: b.score,
        estimatedLatencyMs: b.estimatedLatencyMs,
        readiness: { checkedAt: b.readiness!.checkedAt, latencyMs: b.readiness!.latencyMs, source: b.readiness!.source },
      };
    }
    return { request, decision, candidates, decidedAt };
  }

  private evaluateModel(record: ModelRecord, req: CapabilityRequirements, request: RouteRequest): ModelEval {
    if (request.excludeModelIds!.includes(record.id)) {
      return { record, instances: [], rejection: 'excluded by caller (already tried or explicitly excluded)' };
    }
    const instances = this.deps.models.instancesOf(record.id);
    if (instances.length === 0) return { record, instances: [], rejection: 'no instance on any runtime' };
    const circuit = this.reliability.status(record.id, this.taskClass, this.clock());
    const evals = instances.map((i) => this.evaluateInstance(record, i, req, request, circuit));
    const ok = evals.filter((e) => e.eligible).sort(compareInstance);
    if (ok.length > 0) return { record, instances: evals, best: ok[0] };
    const rejection = evals.length === 1 ? evals[0].rejection! : evals.map((e) => `${e.instance.id}: ${e.rejection}`).join('; ');
    return { record, instances: evals, rejection };
  }

  private evaluateInstance(
    record: ModelRecord,
    instance: ModelInstance,
    req: CapabilityRequirements,
    request: RouteRequest,
    circuit: ReturnType<ModelReliabilityTracker['status']>,
  ): InstanceEval {
    const runtime = this.deps.runtimes?.get(instance.runtimeId);
    const hosted = isHostedInstance(instance, runtime, record);
    const out: InstanceEval = { instance, hosted, eligible: false, tier: request.localFirst && hosted ? 1 : 0, score: 0, reasons: [], estimatedCostUsd: 0 };
    const reject = (why: string): InstanceEval => ({ ...out, rejection: why });

    // 2. servable
    if (UNSERVABLE_STATES.has(instance.state ?? '')) return reject(`instance ${instance.state?.toLowerCase()}`);
    if (instance.health === 'unavailable') return reject(`instance unavailable${instance.error ? `: ${instance.error}` : ''}`);
    if (runtime?.health === 'unavailable') return reject(`runtime '${runtime.id}' unavailable`);
    if (hosted && !runtime && this.deps.runtimes) return reject(`hosted runtime '${instance.runtimeId}' is not registered`);
    const computer = instance.computerId ? this.deps.computers?.get(instance.computerId) : undefined;
    if (instance.computerId && this.deps.computers) {
      if (!computer) return reject(`computer '${instance.computerId}' is not registered`);
      if (computer.status !== 'online') return reject(`computer '${computer.id}' is ${computer.status}`);
      if (computer.health === 'unavailable') return reject(`computer '${computer.id}' health unavailable`);
    }
    if (req.localOnly && hosted) return reject('capability "local" requires a local instance');

    // 3. verified ready
    const readiness = this.readiness.status(record.id, instance.id);
    out.readiness = readiness;
    if (!readiness) return reject(hosted ? 'not verified ready: hosted model has no successful execution evidence (hosted models are never probed)' : 'not verified ready: never probed');
    if (!readiness.ready) return reject(`not verified ready: ${readiness.reason}`);
    if (!this.readiness.isFresh(readiness)) {
      const age = Math.round((this.clock().getTime() - Date.parse(readiness.checkedAt)) / 1000);
      return reject(`not verified ready: last verification ${age}s ago exceeds TTL ${Math.round(this.readiness.ttlMs / 1000)}s`);
    }
    out.reasons.push(`verified ready by ${readiness.source} at ${readiness.checkedAt}${readiness.latencyMs !== undefined ? ` (${readiness.latencyMs}ms)` : ''}`);

    // 4. capabilities
    const caps = checkCapabilities(req, record, instance, readiness);
    if (!caps.ok) return reject(caps.rejection!);
    out.reasons.push(...caps.reasons);

    // 5. hosted spend
    if (hosted) {
      if (request.remainingHostedBudgetUsd <= 0) return reject('hosted inference denied: remaining hosted budget is $0');
      const pricing = this.deps.pricing?.(record.id, instance.runtimeId);
      if (!pricing || !validPricing(pricing)) return reject('hosted model has no known pricing; spend cannot be bounded');
      out.estimatedCostUsd = round6((this.tokens.input * pricing.inputPerMTok + this.tokens.output * pricing.outputPerMTok) / 1_000_000);
      if (out.estimatedCostUsd > request.remainingHostedBudgetUsd) {
        return reject(`estimated cost $${out.estimatedCostUsd} exceeds remaining hosted budget $${request.remainingHostedBudgetUsd}`);
      }
      out.reasons.push(`hosted: estimated $${out.estimatedCostUsd} within remaining budget $${request.remainingHostedBudgetUsd}`);
    } else {
      out.reasons.push('local inference: $0');
    }

    // 6. reliability circuit
    if (circuit.state === 'OPEN') return reject(`reliability: ${circuit.reason}`);

    // 7. resources for a non-resident local model
    if (!hosted && !instance.loaded && computer && this.deps.computers && record.memory?.minSystemGB) {
      try {
        const snap = this.deps.computers.resourceSnapshot(computer.id);
        const held = snap.activeReservations.filter((r) => !r.settledAt).reduce((n, r) => n + r.memoryBytes, 0);
        if (snap.availableMemoryBytes !== undefined) {
          const availGB = (snap.availableMemoryBytes - held) / 1024 ** 3;
          if (availGB < record.memory.minSystemGB) {
            return reject(`resources: ${computer.id} has ${availGB.toFixed(1)}GB available < ${record.memory.minSystemGB}GB needed to load`);
          }
          out.reasons.push(`resources: ${availGB.toFixed(1)}GB available >= ${record.memory.minSystemGB}GB to load`);
        }
      } catch (error) {
        out.reasons.push(`resources: snapshot unavailable (${errorMessage(error)})`);
      }
    }

    // Score.
    let score = 0;
    if (instance.loaded && instance.state === 'READY') { score += 20; out.reasons.push('resident and READY (+20)'); }
    else if (instance.loaded) { score += 10; out.reasons.push('loaded (+10)'); }
    else { score -= 5; out.reasons.push('not resident: cold load expected (-5)'); }

    if (!hosted && (record.family === 'qwen' || /qwen/i.test(record.id))) {
      score += 3;
      out.reasons.push('local Qwen coding model preference (+3)');
    }

    const history = this.attributableHistory(record.id);
    if (history.length >= MIN_HISTORY) {
      const rate = history.filter((o) => o.ok).length / history.length;
      const bonus = Math.round(rate * 30);
      score += bonus;
      out.reasons.push(`measured success ${Math.round(rate * 100)}% over ${history.length} routed runs (+${bonus})`);
    } else {
      out.reasons.push(`reliability: ${history.length} routed run(s), neutral`);
    }
    const perf = record.performance?.[this.taskClass];
    if (perf && perf.samples >= MIN_HISTORY) {
      const bonus = Math.round(perf.verifiedSuccessRate * 10);
      score += bonus;
      out.reasons.push(`execution evidence: ${Math.round(perf.verifiedSuccessRate * 100)}% verified over ${perf.samples} runs (+${bonus})`);
    }
    if (circuit.state === 'HALF_OPEN') { score -= 10; out.reasons.push(`reliability: ${circuit.reason} (-10)`); }

    const latency = this.estimatedLatency(record.id, readiness);
    out.estimatedLatencyMs = latency;
    if (latency !== undefined) {
      const penalty = round2(Math.min(20, latency / 500));
      score -= penalty;
      out.reasons.push(`estimated latency ${latency}ms (-${penalty})`);
    }
    if (req.minContextTokens > 0 && instanceContextTokens(record, instance) >= req.minContextTokens * 2) {
      score += 2;
      out.reasons.push('context headroom >= 2x requirement (+2)');
    }
    if (computer) {
      const cpu = computer.load?.cpuPercent;
      if (cpu !== undefined && Number.isFinite(cpu)) {
        const penalty = round2(Math.min(5, Math.max(0, cpu) / 20));
        score -= penalty;
        out.reasons.push(`computer CPU ${Math.round(cpu)}% (-${penalty})`);
      }
      if (computer.health === 'degraded') { score -= 5; out.reasons.push('computer degraded (-5)'); }
      if (computer.local) { score += 1; out.reasons.push('control-plane host (+1)'); }
    }
    if (hosted && out.estimatedCostUsd > 0) {
      const penalty = round2(Math.min(20, out.estimatedCostUsd * 100));
      score -= penalty;
      out.reasons.push(`cost penalty (-${penalty})`);
    }
    if (request.localFirst) out.reasons.push(hosted ? 'local-first: hosted ranks after every eligible local model' : 'local-first: local model preferred');
    return { ...out, eligible: true, score: round2(score) };
  }

  private attributableHistory(modelId: string): RouteOutcomeRecord[] {
    return this.outcomesList.filter((o) => o.modelId === modelId && o.attributable).slice(-OUTCOME_WINDOW);
  }

  /** Average actual latency of recent routed runs, else the readiness probe's latency. */
  private estimatedLatency(modelId: string, readiness: ReadinessRecord | undefined): number | undefined {
    const recent = this.outcomesList.filter((o) => o.modelId === modelId && o.ok).slice(-OUTCOME_WINDOW);
    if (recent.length > 0) return Math.round(recent.reduce((n, o) => n + o.actualLatencyMs, 0) / recent.length);
    return readiness?.latencyMs;
  }

  // ----------------------------------------------------------------- outcomes

  async recordOutcome(input: RouteOutcomeInput): Promise<RouteOutcomeRecord> {
    await this.hydrate();
    const d = input.decision as Partial<GoalModelRouteDecision> & ModelRouteDecision;
    const at = this.clock();
    const taskClass = input.taskClass ?? this.taskClass;
    const error = input.error === undefined ? undefined : errorMessage(input.error);

    let attributable = input.ok;
    if (input.terminationReason) {
      const status = this.reliability.recordTermination(d.modelId, taskClass, input.terminationReason, at);
      attributable = status !== null;
    } else if (input.ok) {
      this.reliability.record({ modelId: d.modelId, taskClass, success: true, reason: 'COMPLETED', at });
    } else if (input.modelAttributable) {
      this.reliability.record({ modelId: d.modelId, taskClass, success: false, reason: error ?? 'model failure', at });
      attributable = true;
    }

    const record: RouteOutcomeRecord = {
      seq: ++this.seq,
      modelId: d.modelId,
      instanceId: d.instanceId,
      runtimeId: d.runtimeId,
      computerId: d.computerId,
      hosted: d.hosted,
      ok: input.ok,
      attributable,
      taskClass,
      estimatedCostUsd: d.estimatedCostUsd ?? 0,
      actualCostUsd: Number.isFinite(input.actualCostUsd) ? input.actualCostUsd! : d.hosted ? d.estimatedCostUsd ?? 0 : 0,
      estimatedLatencyMs: d.estimatedLatencyMs,
      actualLatencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
      error,
      terminationReason: input.terminationReason,
      runId: input.runId,
      targetId: input.targetId,
      attemptId: input.attemptId,
      recordedAt: at.toISOString(),
    };
    this.outcomesList.push(record);
    await this.deps.store.put(ROUTING_STORE_KEYS.outcome(record.modelId, record.seq, record.recordedAt), record);

    // Readiness feedback: a real success is fresh evidence; any failure forces re-verification.
    const instanceId = d.instanceId ?? this.deps.models.instancesOf(d.modelId).find((i) => i.runtimeId === d.runtimeId && i.computerId === d.computerId)?.id;
    if (instanceId) {
      if (input.ok) {
        const prior = this.readiness.status(d.modelId, instanceId);
        this.readiness.record({
          modelId: d.modelId,
          instanceId,
          runtimeId: d.runtimeId,
          computerId: d.computerId,
          runtimeModelId: prior?.runtimeModelId,
          ready: true,
          checkedAt: record.recordedAt,
          latencyMs: prior?.latencyMs,
          source: 'execution',
          generation: 'verified',
          toolUse: prior?.toolUse ?? 'untested',
          reason: `routed execution succeeded in ${record.actualLatencyMs}ms`,
        });
      } else {
        this.readiness.invalidate(d.modelId, instanceId, `routed execution failed: ${error ?? 'unknown error'}`);
      }
    }
    return record;
  }

  async fallback(input: RouteRequest & { failed: ModelRouteDecision; error: string | import('../contracts.js').GoalStudioError; latencyMs?: number; terminationReason?: string; modelAttributable?: boolean }): Promise<GoalModelRouteDecision | undefined> {
    const error = errorMessage(input.error);
    await this.recordOutcome({
      decision: input.failed,
      ok: false,
      latencyMs: input.latencyMs ?? 0,
      error,
      terminationReason: input.terminationReason,
      modelAttributable: input.modelAttributable,
    });
    const exclude = [...new Set([...(input.excludeModelIds ?? []), input.failed.modelId])];
    const next = await this.route({ requiredCapabilities: input.requiredCapabilities, remainingHostedBudgetUsd: input.remainingHostedBudgetUsd, localFirst: input.localFirst, excludeModelIds: exclude });
    if (next) next.reasons.unshift(`fallback after ${error} (from '${input.failed.modelId}')`);
    return next;
  }

  // -------------------------------------------------------------- monitoring

  async probeLocal(options: { modelIds?: string[]; force?: boolean; tools?: boolean } = {}): Promise<ProbeSweepResult> {
    await this.hydrate();
    const result: ProbeSweepResult = { probed: [], skipped: [] };
    const models = this.deps.models.list().filter((m) => !options.modelIds || options.modelIds.includes(m.id));
    for (const id of options.modelIds ?? []) {
      if (!models.some((m) => m.id === id)) result.skipped.push({ modelId: id, reason: 'model is not registered' });
    }
    // Sequential on purpose: probes share local accelerators; parallel loads would contend.
    for (const model of models) {
      for (const instance of this.deps.models.instancesOf(model.id)) {
        if (isHostedInstance(instance, this.deps.runtimes?.get(instance.runtimeId), model)) {
          result.skipped.push({ modelId: model.id, instanceId: instance.id, reason: 'hosted: never probed (no paid calls)' });
          continue;
        }
        if (instance.computerId && this.deps.computers) {
          const c = this.deps.computers.get(instance.computerId);
          if (!c || c.status !== 'online') {
            result.skipped.push({ modelId: model.id, instanceId: instance.id, reason: `computer '${instance.computerId}' offline or unknown` });
            continue;
          }
        }
        result.probed.push(await this.readiness.probe({ modelId: model.id, instanceId: instance.id }, { force: options.force, tools: options.tools }));
      }
    }
    return result;
  }

  async registerModel(input: FleetModelRegistrationInput): Promise<FleetModelEntry> {
    await this.hydrate();
    const id = typeof input?.id === 'string' ? input.id.trim() : '';
    if (!id) {
      throw new GoalStudioFailure('VALIDATION', 'model id is required');
    }
    const now = this.clock();
    const existing = this.deps.models.get(id);
    const provider = (typeof input.provider === 'string' && input.provider.trim()) ? input.provider.trim() : (existing?.provider ?? 'ollama');
    const local = typeof input.local === 'boolean' ? input.local : (existing?.local ?? !HOSTED_RUNTIME_TYPES.has(provider as any));
    const family: ModelRecord['family'] = input.family ?? existing?.family ?? (/qwen/i.test(id) ? 'qwen' : 'other');
    const contextMax = typeof input.contextMax === 'number' && Number.isFinite(input.contextMax) && input.contextMax > 0
      ? Math.round(input.contextMax)
      : (existing?.contextMax ?? 32768);
    const capabilities: ModelRecord['capabilities'] = Array.isArray(input.capabilities)
      ? input.capabilities
      : (existing?.capabilities ?? ['generalChat', 'coding']);

    const record: ModelRecord = {
      id,
      name: (typeof input.name === 'string' && input.name.trim()) ? input.name.trim() : (existing?.name ?? id),
      provider,
      family,
      contextMax,
      configuredContext: input.configuredContext ?? existing?.configuredContext,
      capabilities,
      toolCalling: input.toolCalling ?? existing?.toolCalling ?? false,
      structuredOutput: input.structuredOutput ?? existing?.structuredOutput ?? false,
      vision: input.vision ?? existing?.vision ?? false,
      audio: input.audio ?? existing?.audio ?? false,
      embedding: input.embedding ?? existing?.embedding ?? false,
      reasoning: input.reasoning ?? existing?.reasoning ?? false,
      quantization: input.quantization ?? existing?.quantization,
      version: input.version ?? existing?.version,
      memory: input.memory ?? existing?.memory,
      runtimeCompatibility: input.runtimeCompatibility ?? existing?.runtimeCompatibility ?? (local ? ['ollama'] : 'any'),
      local,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.deps.models.register(record);

    if (input.instance) {
      const runtimeId = typeof input.instance.runtimeId === 'string' ? input.instance.runtimeId.trim() : '';
      if (!runtimeId) {
        throw new GoalStudioFailure('VALIDATION', 'instance.runtimeId is required when registering an instance');
      }
      const instanceId = (typeof input.instance.id === 'string' && input.instance.id.trim())
        ? input.instance.id.trim()
        : `${id}@${runtimeId}`;
      const loaded = input.instance.loaded ?? true;
      const inst = this.deps.models.upsertInstance({
        id: instanceId,
        modelId: id,
        runtimeId,
        computerId: input.instance.computerId ?? (local ? 'local' : undefined),
        runtimeModelId: input.instance.runtimeModelId ?? id,
        loaded,
        state: input.instance.state ?? (loaded ? 'READY' : 'INSTALLED'),
        health: input.instance.health ?? 'healthy',
        contextTokens: input.instance.contextTokens,
      });
      if (input.readiness) {
        this.readiness.record({
          modelId: id,
          instanceId: inst.id,
          runtimeId: inst.runtimeId,
          runtimeModelId: inst.runtimeModelId,
          computerId: inst.computerId,
          ready: Boolean(input.readiness.ready),
          checkedAt: now.toISOString(),
          latencyMs: input.readiness.latencyMs ?? 50,
          source: input.readiness.source ?? 'external',
          generation: input.readiness.ready ? 'verified' : 'failed',
          toolUse: input.readiness.toolUse ?? (record.toolCalling && input.readiness.ready ? 'verified' : 'untested'),
          reason: input.readiness.reason ?? (input.readiness.ready ? 'registered with verified readiness' : 'registered not ready'),
        });
      }
    }

    const snap = await this.fleet();
    return snap.models.find((m) => m.modelId === id)!;
  }

  async accounting(): Promise<ModelAccounting[]> {
    await this.hydrate();
    const ids = [...new Set([...this.deps.models.list().map((m) => m.id), ...this.outcomesList.map((o) => o.modelId)])].sort();
    return ids.map((id) => this.accountingFor(id));
  }

  private accountingFor(modelId: string): ModelAccounting {
    const all = this.outcomesList.filter((o) => o.modelId === modelId);
    const attributable = all.filter((o) => o.attributable);
    const est = all.filter((o) => o.estimatedLatencyMs !== undefined);
    return {
      modelId,
      routes: all.length,
      successes: all.filter((o) => o.ok).length,
      failures: all.filter((o) => !o.ok).length,
      attributableSamples: attributable.length,
      attributableSuccessRate: attributable.length ? round2(attributable.filter((o) => o.ok).length / attributable.length) : undefined,
      estimatedCostUsd: round6(all.reduce((n, o) => n + o.estimatedCostUsd, 0)),
      actualCostUsd: round6(all.reduce((n, o) => n + o.actualCostUsd, 0)),
      avgEstimatedLatencyMs: est.length ? Math.round(est.reduce((n, o) => n + o.estimatedLatencyMs!, 0) / est.length) : undefined,
      avgActualLatencyMs: all.length ? Math.round(all.reduce((n, o) => n + o.actualLatencyMs, 0) / all.length) : undefined,
      lastOutcomeAt: all[all.length - 1]?.recordedAt,
    };
  }

  async outcomes(modelId?: string): Promise<RouteOutcomeRecord[]> {
    await this.hydrate();
    return this.outcomesList.filter((o) => !modelId || o.modelId === modelId).map((o) => ({ ...o }));
  }

  async fleet(): Promise<FleetSnapshot> {
    await this.hydrate();
    const now = this.clock();
    const withAge = (r: ReadinessRecord) => ({ ...r, fresh: this.readiness.isFresh(r), ageMs: Math.max(0, now.getTime() - Date.parse(r.checkedAt)) });
    const models: FleetModelEntry[] = this.deps.models.list().map((record) => {
      const instances = this.deps.models.instancesOf(record.id).map((i) => {
        const r = this.readiness.status(record.id, i.id);
        return {
          id: i.id,
          runtimeId: i.runtimeId,
          computerId: i.computerId,
          state: i.state,
          health: i.health,
          loaded: i.loaded,
          contextTokens: i.contextTokens,
          hosted: isHostedInstance(i, this.deps.runtimes?.get(i.runtimeId), record),
          readiness: r ? withAge(r) : undefined,
        };
      });
      const best = instances.map((i) => i.readiness).filter(Boolean).sort((a, b) => Number(b!.fresh) - Number(a!.fresh) || a!.ageMs - b!.ageMs)[0];
      const circuit = this.reliability.status(record.id, this.taskClass, now);
      return {
        modelId: record.id,
        name: record.name,
        provider: record.provider,
        local: record.local,
        hosted: instances.length > 0 ? instances.every((i) => i.hosted) : record.local === false,
        state: this.deps.models.getModelState(record.id),
        capabilities: {
          declared: [...record.capabilities],
          toolCalling: record.toolCalling,
          structuredOutput: record.structuredOutput,
          vision: record.vision,
          reasoning: record.reasoning,
          contextTokens: instanceContextTokens(record, this.deps.models.instancesOf(record.id).find((i) => i.contextTokens !== undefined)),
        },
        instances,
        readiness: best
          ? { ready: best.fresh, fresh: best.fresh, checkedAt: best.checkedAt, ageMs: best.ageMs, latencyMs: best.latencyMs, toolUse: best.toolUse, reason: best.fresh ? best.reason : best.ready ? `stale: ${best.reason}` : best.reason }
          : { ready: false, fresh: false, reason: 'never verified' },
        reliability: { state: circuit.state, samples: circuit.samples, failures: circuit.failures, failureRate: circuit.failureRate, reason: circuit.reason },
        accounting: this.accountingFor(record.id),
      };
    });

    const runtimes = (this.deps.runtimes?.list() ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      kind: (r.runtimeKind === 'hosted' || HOSTED_RUNTIME_TYPES.has(r.type) ? 'hosted' : 'local') as 'local' | 'hosted',
      health: r.health,
      computerId: r.computerId,
      loadedModels: [...r.loadedModels],
      lastCheckedAt: r.lastCheckedAt?.toISOString(),
    }));

    const computers: FleetComputerEntry[] = (this.deps.computers?.list() ?? []).map((c) => {
      const last = c.lastHeartbeat?.getTime() ?? c.createdAt.getTime();
      const elapsed = now.getTime() - last;
      const heartbeat: FleetComputerEntry['heartbeat'] = c.local ? 'local' : c.status === 'offline' || elapsed >= 60_000 ? 'offline' : elapsed >= 30_000 ? 'stale' : 'fresh';
      const entry: FleetComputerEntry = {
        id: c.id,
        name: c.name,
        workerId: `worker-${c.id}`,
        local: c.local,
        status: c.status,
        health: c.health,
        heartbeat,
        lastHeartbeat: c.lastHeartbeat?.toISOString(),
        runtimes: [...c.runtimes],
        models: [...c.models],
      };
      try {
        const s = this.deps.computers!.resourceSnapshot(c.id);
        const gb = (b: number | undefined) => (b === undefined ? undefined : round2(b / 1024 ** 3));
        const open = s.activeReservations.filter((r) => !r.settledAt);
        entry.resources = {
          totalMemoryGB: gb(s.totalMemoryBytes) ?? 0,
          availableMemoryGB: gb(s.availableMemoryBytes),
          totalVramGB: gb(s.totalVramBytes),
          availableVramGB: gb(s.availableVramBytes),
          unifiedMemory: s.unifiedMemory,
          cpuUtilization: s.cpuUtilization,
          gpuUtilization: s.gpuUtilization,
          activeReservations: open.length,
          reservedMemoryGB: gb(open.reduce((n, r) => n + r.memoryBytes, 0)) ?? 0,
          observedAt: s.observedAt.toISOString(),
        };
      } catch (error) {
        entry.resourceError = errorMessage(error);
      }
      return entry;
    });

    return {
      generatedAt: now.toISOString(),
      readinessTtlMs: this.readiness.ttlMs,
      taskClass: this.taskClass,
      summary: {
        models: models.length,
        verifiedReady: models.filter((m) => m.readiness.ready).length,
        hosted: models.filter((m) => m.hosted).length,
        computers: computers.length,
        computersOnline: computers.filter((c) => c.status === 'online').length,
        runtimes: runtimes.length,
        runtimesHealthy: runtimes.filter((r) => r.health === 'healthy').length,
      },
      models,
      runtimes,
      computers,
    };
  }

  // ------------------------------------------------------------- persistence

  /** Loads persisted outcomes (feeding the circuit breaker in order) and readiness records. */
  hydrate(): Promise<void> {
    this.hydrated ??= (async () => {
      const outcomes = (await this.deps.store.list(ROUTING_STORE_KEYS.outcomesPrefix).catch(() => []))
        .map((e) => e.value as RouteOutcomeRecord)
        .filter((o) => o && typeof o.modelId === 'string' && typeof o.recordedAt === 'string')
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.seq - b.seq);
      const live = this.outcomesList;
      this.outcomesList = [...outcomes, ...live];
      this.seq = Math.max(this.seq, ...outcomes.map((o) => o.seq), 0);
      if (!this.deps.reliability) {
        for (const o of outcomes) {
          if (!o.attributable) continue;
          if (o.terminationReason) this.reliability.recordTermination(o.modelId, o.taskClass, o.terminationReason, new Date(o.recordedAt));
          else this.reliability.record({ modelId: o.modelId, taskClass: o.taskClass, success: o.ok, reason: o.error, at: new Date(o.recordedAt) });
        }
      }
      if (!this.deps.probe) {
        const readiness = await this.deps.store.list(ROUTING_STORE_KEYS.readinessPrefix).catch(() => []);
        for (const e of readiness) {
          const r = e.value as ReadinessRecord;
          if (r && typeof r.modelId === 'string' && typeof r.instanceId === 'string' && !this.readiness.status(r.modelId, r.instanceId)) {
            // Restore; freshness is still judged by TTL, so an old record never makes a model routable.
            (this.readiness as { record(r: ReadinessRecord): void }).record(r);
          }
        }
      }
    })();
    return this.hydrated;
  }

  private async persistReadiness(record: ReadinessRecord): Promise<void> {
    try {
      await this.deps.store.put(ROUTING_STORE_KEYS.readiness(record.modelId, record.instanceId), record);
    } catch {
      // Readiness persistence is best-effort; the in-memory record is authoritative.
    }
  }
}

function compareInstance(a: InstanceEval, b: InstanceEval): number {
  return a.tier - b.tier || b.score - a.score || a.instance.id.localeCompare(b.instance.id);
}

function validPricing(p: Pricing): boolean {
  return Number.isFinite(p.inputPerMTok) && Number.isFinite(p.outputPerMTok) && p.inputPerMTok >= 0 && p.outputPerMTok >= 0;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Factory consumed by apps/api/src/goalStudio/services.ts (`services.router`). */
export function createModelRouter(deps: ModelRouterDeps): FleetModelRouter {
  return new GoalStudioModelRouter(deps);
}

/** True when a `ModelRouter` also exposes the fleet-monitoring surface. */
export function isFleetModelRouter(router: unknown): router is FleetModelRouter {
  const r = router as Partial<FleetModelRouter> | undefined;
  return !!r && typeof r.route === 'function' && typeof r.fleet === 'function' && typeof r.explain === 'function' && typeof r.probeLocal === 'function';
}
