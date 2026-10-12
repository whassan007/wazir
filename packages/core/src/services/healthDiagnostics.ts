import type { Computer } from '../types/computer.js';
import type { ModelInstance, ModelLifecycleEvent, ModelRecord } from '../types/model.js';
import type { ResourceSnapshot } from '../types/modelLifecycle.js';
import type { ExecutionRecord } from '../types/execution.js';
import type { RuntimeRecord } from '../types/runtime.js';
import type {
  DiagnosticCode,
  DiagnosticEvidence,
  HealthDiagnostic,
  HealthObservations,
  HealthReport,
  HealthThresholds,
  InferenceHealthState,
  InferenceOutcome,
  ModelHealthProjection,
  ResourcePressure,
  RuntimeHealthProjection,
  RuntimeHealthState,
  TelemetryHealthState,
  WorkerHealthProjection,
} from '../types/healthDiagnostics.js';

export const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = [
  'RUNTIME_UNREACHABLE', 'MODEL_NOT_LOADED', 'MODEL_NOT_READY', 'MODEL_LOAD_FAILED', 'INSUFFICIENT_MEMORY',
  'QUEUE_PRESSURE', 'INFERENCE_FAILED', 'TELEMETRY_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'UNKNOWN',
];

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  queuePressureDepth: 8,
  memoryHighFraction: 0.85,
  memoryCriticalFraction: 0.95,
  recentWindow: 5,
};

export interface HealthSnapshotInput {
  runtimes: RuntimeRecord[];
  models: ModelRecord[];
  instances: ModelInstance[];
  computers: Computer[];
  /** Resource snapshots keyed by computer id (ComputerRegistry.resourceSnapshot). */
  resources?: Record<string, ResourceSnapshot>;
  workers?: Array<{ id: string; computerId: string; status?: 'online' | 'offline'; running?: boolean; lastHeartbeat?: Date }>;
  observations?: HealthObservations;
  thresholds?: Partial<HealthThresholds>;
  now?: Date;
}

export const inferenceKey = (runtimeId: string, modelId: string): string => `${runtimeId}::${modelId}`;
const iso = (d?: Date): string | undefined => (d ? d.toISOString() : undefined);

function resourcePressure(snapshot: ResourceSnapshot | undefined, t: HealthThresholds): ResourcePressure {
  if (!snapshot) return { level: 'UNKNOWN', reservedMemoryBytes: 0 };
  const reserved = snapshot.activeReservations.filter((r) => !r.settledAt).reduce((n, r) => n + r.memoryBytes, 0);
  const total = snapshot.totalMemoryBytes > 0 ? snapshot.totalMemoryBytes : undefined;
  const available = snapshot.availableMemoryBytes;
  const base = { reservedMemoryBytes: reserved, totalMemoryBytes: total, availableMemoryBytes: available, observedAt: iso(snapshot.observedAt) };
  if (total === undefined || available === undefined) return { ...base, level: 'UNKNOWN' };
  const used = Math.max(0, total - available);
  const fraction = (used + reserved) / total;
  const level = fraction >= t.memoryCriticalFraction ? 'CRITICAL' : fraction >= t.memoryHighFraction ? 'HIGH' : 'OK';
  return { ...base, usedMemoryBytes: used, level };
}

function lastOutcome(list: InferenceOutcome[] | undefined): InferenceOutcome | undefined {
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function inferenceState(outcomes: InferenceOutcome[]): InferenceHealthState {
  const last = lastOutcome(outcomes);
  if (!last) return 'UNKNOWN';
  return last.error ? 'FAILING' : 'HEALTHY';
}

function byTime(a: InferenceOutcome, b: InferenceOutcome): number {
  return a.at.localeCompare(b.at);
}

/**
 * Builds a read-only health report. Pure: callers pass snapshots of the authoritative
 * registries; nothing here mutates them.
 *
 * Rules (first match wins per subject, so one root cause is not reported as many):
 * - Worker offline                                     → WORKER_UNAVAILABLE
 * - Local runtime health 'unavailable'                 → RUNTIME_UNREACHABLE (model checks on it are suppressed)
 * - Hosted runtime 'unavailable' (auth/eligibility)   → state UNAVAILABLE, no reachability claim, no diagnostic
 * - Admission denied with INSUFFICIENT_MEMORY          → INSUFFICIENT_MEMORY
 * - Instance FAILED or a recorded load failure         → MODEL_LOAD_FAILED
 * - Loaded but not READY/healthy, or failed probe      → MODEL_NOT_READY
 * - Desired READY (or pinned) but not loaded           → MODEL_NOT_LOADED
 * - Instance UNAVAILABLE on a reachable runtime        → UNKNOWN (contradictory evidence)
 * - Last inference outcome for runtime+model failed    → INFERENCE_FAILED (independent of the above)
 * - Queue depth ≥ threshold (only when reported)       → QUEUE_PRESSURE
 * - Inference succeeded but cache telemetry not observed on a runtime that claims it → TELEMETRY_UNAVAILABLE (info)
 * - Runtime 'degraded' with no probe/inference evidence and no other diagnostic → UNKNOWN
 *
 * Telemetry status never changes runtime `state` or `inference`.
 */
export function buildHealthReport(input: HealthSnapshotInput): HealthReport {
  const t: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, ...input.thresholds };
  const obs = input.observations ?? {};
  const now = input.now ?? new Date();
  const diagnostics: HealthDiagnostic[] = [];
  const push = (d: HealthDiagnostic) => diagnostics.push(d);

  // Workers
  const workers: WorkerHealthProjection[] = (input.workers ?? []).map((w) => ({
    workerId: w.id,
    computerId: w.computerId,
    status: w.status ?? 'unknown',
    running: w.running ?? null,
    lastHeartbeat: iso(w.lastHeartbeat),
  }));
  for (const w of workers) {
    if (w.status === 'offline' || w.running === false) {
      push({
        code: 'WORKER_UNAVAILABLE', domain: 'WORKER', severity: 'error',
        subject: { kind: 'worker', id: w.workerId },
        reason: `worker ${w.workerId} on ${w.computerId} is not serving requests`,
        evidence: [
          { label: 'worker status', value: w.status, source: 'Worker' },
          { label: 'worker running', value: w.running, source: 'Worker' },
          { label: 'last heartbeat', value: w.lastHeartbeat ?? null, source: 'Worker' },
        ],
      });
    }
  }

  const pressureByComputer = new Map<string, ResourcePressure>();
  for (const c of input.computers) pressureByComputer.set(c.id, resourcePressure(input.resources?.[c.id], t));
  const reservationsByInstance = new Map<string, { count: number; memoryBytes: number }>();
  for (const c of input.computers) {
    for (const r of c.reservations ?? []) {
      if (r.settledAt) continue;
      const cur = reservationsByInstance.get(r.instanceId) ?? { count: 0, memoryBytes: 0 };
      reservationsByInstance.set(r.instanceId, { count: cur.count + 1, memoryBytes: cur.memoryBytes + r.memoryBytes });
    }
  }
  const modelById = new Map(input.models.map((m) => [m.id, m]));

  // Models
  const models: ModelHealthProjection[] = [];
  const runtimeById = new Map(input.runtimes.map((r) => [r.id, r]));

  for (const i of input.instances) {
    const key = inferenceKey(i.runtimeId, i.modelId);
    const outcomes = [...(obs.inference?.[key] ?? [])].sort(byTime);
    const successes = outcomes.filter((o) => !o.error);
    const failures = outcomes.filter((o) => o.error).slice(-t.recentWindow);
    const state = i.state ?? (i.loaded ? 'LOADED' : 'INSTALLED');
    const ready = i.loaded && state === 'READY' && i.health === 'healthy';
    const loadFailure = obs.loadFailures?.[i.id] ?? obs.loadFailures?.[key];
    const model = modelById.get(i.modelId);
    const memEstimate = i.residentMemoryBytes
      ?? (model?.memory?.minSystemGB !== undefined ? model.memory.minSystemGB * 1024 ** 3 : undefined);
    const projection: ModelHealthProjection = {
      instanceId: i.id,
      modelId: i.modelId,
      runtimeId: i.runtimeId,
      computerId: i.computerId,
      installed: state !== 'DISCOVERED',
      loaded: i.loaded,
      ready,
      lifecycleState: state,
      contextLimit: i.contextTokens ?? (model ? model.configuredContext ?? model.contextMax : undefined),
      currentReservations: reservationsByInstance.get(i.id) ?? { count: 0, memoryBytes: 0 },
      memoryEstimateBytes: memEstimate,
      lastSuccessfulInference: lastOutcome(successes)?.at,
      recentFailures: failures,
      lastLoadFailure: loadFailure,
    };
    models.push(projection);

    const runtime = runtimeById.get(i.runtimeId);
    if (runtime?.health === 'unavailable') continue; // root cause is the runtime (unreachable, or hosted auth)

    const subject = { kind: 'model' as const, id: `${i.modelId}@${i.runtimeId}` };
    const baseEvidence: DiagnosticEvidence[] = [
      { label: 'model state', value: state, source: 'ModelRegistry' },
      { label: 'loaded', value: i.loaded, source: 'ModelRegistry' },
      { label: 'instance health', value: i.health, source: 'ModelRegistry' },
    ];
    const lastOk: DiagnosticEvidence = {
      label: 'last successful inference',
      value: projection.lastSuccessfulInference ? ago(projection.lastSuccessfulInference, now) : null,
      source: 'inference observations',
    };
    const denial = obs.admissionDenials?.[key];
    const probe = obs.readinessProbeFailures?.[i.id];

    if (denial && denial.reasons.includes('INSUFFICIENT_MEMORY') && !ready) {
      const p = i.computerId ? pressureByComputer.get(i.computerId) : undefined;
      push({
        code: 'INSUFFICIENT_MEMORY', domain: 'RESOURCE', severity: 'error', subject,
        reason: 'memory admission rejected the load',
        evidence: [
          ...baseEvidence,
          { label: 'admission reasons', value: denial.reasons.join(', '), source: 'lifecycle event', observedAt: denial.at },
          { label: 'available memory bytes', value: p?.availableMemoryBytes ?? null, source: 'ResourceSnapshot' },
          { label: 'reserved memory bytes', value: p?.reservedMemoryBytes ?? null, source: 'ResourceSnapshot' },
          { label: 'memory estimate bytes', value: memEstimate ?? null, source: 'ModelRecord' },
        ],
      });
    } else if (state === 'FAILED' || (loadFailure && !ready)) {
      push({
        code: 'MODEL_LOAD_FAILED', domain: 'MODEL_LOAD', severity: 'error', subject,
        reason: 'the runtime failed to load the model',
        evidence: [
          ...baseEvidence,
          { label: 'load error', value: loadFailure?.error ?? i.error ?? null, source: loadFailure ? 'lifecycle event' : 'ModelRegistry', observedAt: loadFailure?.at },
        ],
      });
    } else if ((i.loaded && !ready && state !== 'LOADING' && state !== 'DRAINING' && state !== 'UNLOADING') || (probe && !ready)) {
      push({
        code: 'MODEL_NOT_READY', domain: 'MODEL', severity: 'warning', subject,
        reason: 'model is loaded but has not been verified ready',
        evidence: [
          ...baseEvidence,
          { label: 'readiness probe', value: probe ? `failed${probe.error ? `: ${probe.error}` : ''}` : null, source: 'readiness probe', observedAt: probe?.at },
          lastOk,
        ],
      });
    } else if (!i.loaded && (i.desired?.state === 'READY' || i.pinned) && state !== 'LOADING') {
      push({
        code: 'MODEL_NOT_LOADED', domain: 'MODEL', severity: 'warning', subject,
        reason: 'model is installed and wanted, but not loaded',
        evidence: [
          ...baseEvidence,
          { label: 'desired state', value: i.desired?.state ?? null, source: 'ModelRegistry' },
          { label: 'pinned', value: i.pinned ?? false, source: 'ModelRegistry' },
        ],
      });
    } else if (state === 'UNAVAILABLE' && runtime?.health === 'healthy') {
      push({
        code: 'UNKNOWN', domain: 'MODEL', severity: 'info', subject,
        reason: 'instance is marked unavailable while its runtime reports healthy; evidence is contradictory',
        evidence: [...baseEvidence, { label: 'runtime health', value: runtime.health, source: 'RuntimeRegistry' }],
      });
    }

    const last = lastOutcome(outcomes);
    if (last?.error) {
      push({
        code: 'INFERENCE_FAILED', domain: 'MODEL', severity: 'error', subject,
        reason: 'the most recent inference request failed',
        evidence: [
          { label: 'last error', value: last.error, source: 'inference observations', observedAt: last.at },
          { label: 'recent failures', value: failures.length, source: 'inference observations' },
          lastOk,
        ],
      });
    }
  }

  // Runtimes
  const runtimes: RuntimeHealthProjection[] = [];
  for (const r of input.runtimes) {
    const instances = input.instances.filter((i) => i.runtimeId === r.id);
    const rtModels = models.filter((m) => m.runtimeId === r.id);
    const outcomes = Object.entries(obs.inference ?? {})
      .filter(([k]) => k.startsWith(`${r.id}::`))
      .flatMap(([, v]) => v)
      .sort(byTime);
    // Hosted providers are marked 'unavailable' for auth/eligibility, which says nothing about reachability.
    const hosted = r.runtimeKind === 'hosted';
    const state: RuntimeHealthState =
      r.health === 'unavailable' ? (hosted ? 'UNAVAILABLE' : 'UNREACHABLE')
        : r.health === 'healthy' ? 'READY' : r.health === 'degraded' ? 'DEGRADED' : 'UNKNOWN';
    const endpointReachable = state === 'UNREACHABLE' ? false : r.health === 'healthy' ? true : null;
    const inferenceReady =
      state === 'UNREACHABLE' || state === 'UNAVAILABLE' ? false : rtModels.some((m) => m.ready) ? true : instances.length > 0 ? false : null;
    const telemetryObserved = obs.telemetry?.[r.id];
    const telemetryStatus: TelemetryHealthState =
      telemetryObserved ?? (r.capabilities?.promptCacheTelemetry === false ? 'UNSUPPORTED' : 'UNKNOWN');
    const queueDepth = obs.queueDepth?.[r.id] ?? null;
    const lastFailure = [...outcomes].reverse().find((o) => o.error);
    const projection: RuntimeHealthProjection = {
      runtimeId: r.id,
      runtimeType: r.type,
      computerId: r.computerId,
      state,
      endpointReachable,
      inferenceReady,
      loadedModels: [...new Set([...r.loadedModels, ...instances.filter((i) => i.loaded).map((i) => i.modelId)])].sort(),
      queueDepth,
      resourcePressure: (r.computerId && pressureByComputer.get(r.computerId)) || { level: 'UNKNOWN', reservedMemoryBytes: 0 },
      inference: inferenceState(outcomes),
      lastSuccessfulInference: [...outcomes].reverse().find((o) => !o.error)?.at,
      lastFailure,
      telemetryStatus,
      lastCheckedAt: iso(r.lastCheckedAt),
    };
    runtimes.push(projection);

    const subject = { kind: 'runtime' as const, id: r.id };
    const before = diagnostics.length;
    if (state === 'UNREACHABLE') {
      push({
        code: 'RUNTIME_UNREACHABLE', domain: 'RUNTIME', severity: 'error', subject,
        reason: `${r.name || r.type} endpoint is not reachable`,
        evidence: [
          { label: 'runtime health', value: r.health, source: 'RuntimeRegistry' },
          { label: 'endpoint', value: r.url ?? null, source: 'RuntimeRegistry' },
          { label: 'last checked', value: projection.lastCheckedAt ?? null, source: 'RuntimeRegistry' },
          { label: 'affected model instances', value: instances.length, source: 'ModelRegistry' },
        ],
      });
      continue;
    }
    // Unusable hosted provider: `wa doctor`'s hosted-provider check owns the auth explanation.
    if (state === 'UNAVAILABLE') continue;
    if (queueDepth !== null && queueDepth >= t.queuePressureDepth) {
      push({
        code: 'QUEUE_PRESSURE', domain: 'RESOURCE', severity: 'warning', subject,
        reason: `queue depth ${queueDepth} at or above threshold ${t.queuePressureDepth}`,
        evidence: [
          { label: 'queue depth', value: queueDepth, source: 'dispatcher' },
          { label: 'threshold', value: t.queuePressureDepth, source: 'HealthThresholds' },
        ],
      });
    }
    if (telemetryStatus === 'UNKNOWN' && projection.inference === 'HEALTHY' && r.capabilities?.promptCacheTelemetry !== false) {
      push({
        code: 'TELEMETRY_UNAVAILABLE', domain: 'TELEMETRY', severity: 'info', subject,
        reason: 'inference succeeded but prompt-cache telemetry was not observed (non-fatal)',
        evidence: [
          { label: 'inference', value: projection.inference, source: 'inference observations' },
          { label: 'cache telemetry', value: telemetryStatus, source: 'prompt-cache telemetry' },
          { label: 'runtime claims cache telemetry', value: r.capabilities?.promptCacheTelemetry ?? null, source: 'RuntimeCapabilities' },
        ],
      });
    }
    const hasModelDiag = diagnostics.some((d) => d.subject.kind === 'model' && d.subject.id.endsWith(`@${r.id}`));
    if (state === 'DEGRADED' && projection.inference === 'UNKNOWN' && diagnostics.length === before && !hasModelDiag) {
      push({
        code: 'UNKNOWN', domain: 'RUNTIME', severity: 'info', subject,
        reason: 'runtime is not confirmed healthy and there is no probe or inference evidence to classify further',
        evidence: [
          { label: 'runtime health', value: r.health, source: 'RuntimeRegistry' },
          { label: 'endpoint reachable', value: null, source: 'RuntimeRegistry' },
          { label: 'inference outcomes', value: 0, source: 'inference observations' },
        ],
      });
    }
  }

  const summary = Object.fromEntries(DIAGNOSTIC_CODES.map((c) => [c, 0])) as Record<DiagnosticCode, number>;
  for (const d of diagnostics) summary[d.code]++;

  return { generatedAt: now.toISOString(), runtimes, models, workers, diagnostics, summary };
}

export function ago(at: string, now: Date): string {
  const ms = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return at;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Accumulates observations that registries don't retain (load failures, admission
 * denials, inference outcomes, cache-telemetry status). Bounded, in-memory, advisory.
 */
export class HealthEvidenceLog {
  private inference = new Map<string, InferenceOutcome[]>();
  private telemetry = new Map<string, TelemetryHealthState>();
  private loadFailures = new Map<string, InferenceOutcome>();
  private admissionDenials = new Map<string, { at: string; reasons: string[] }>();
  private probeFailures = new Map<string, { at: string; error?: string }>();

  constructor(private readonly maxPerKey = 20) {}

  onLifecycleEvent(event: ModelLifecycleEvent): void {
    const runtimeId = event.runtimeId ?? (event.data?.runtimeId as string | undefined);
    if (!runtimeId) return;
    const key = inferenceKey(runtimeId, event.modelId);
    const at = event.timestamp.toISOString();
    if (event.type === 'MODEL_LOAD_FAILED') this.loadFailures.set(key, { at, error: event.error ?? event.reason });
    else if (event.type === 'MODEL_ADMISSION_DENIED') this.admissionDenials.set(key, { at, reasons: (event.reason ?? '').split(',').filter(Boolean) });
    else if (event.type === 'MODEL_READY') {
      this.loadFailures.delete(key);
      this.admissionDenials.delete(key);
    }
  }

  recordInference(runtimeId: string, modelId: string, outcome: { at?: Date; error?: string } = {}): void {
    const key = inferenceKey(runtimeId, modelId);
    const list = this.inference.get(key) ?? [];
    list.push({ at: (outcome.at ?? new Date()).toISOString(), ...(outcome.error ? { error: outcome.error } : {}) });
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.inference.set(key, list);
  }

  recordTelemetry(runtimeId: string, status: TelemetryHealthState): void {
    this.telemetry.set(runtimeId, status);
  }

  recordProbeFailure(instanceId: string, error?: string, at = new Date()): void {
    this.probeFailures.set(instanceId, { at: at.toISOString(), error });
  }

  /**
   * Rebuilds inference and cache-telemetry evidence from durable execution records.
   * Only `generation.completed` events carrying an explicit outcome count; older events
   * without one are skipped rather than assumed successful.
   */
  hydrateFromExecutions(records: Array<Pick<ExecutionRecord, 'execution' | 'events'>>): void {
    const events = records.flatMap((r) => (r.events ?? []).map((e) => ({ e, x: r.execution })))
      .sort((a, b) => new Date(a.e.timestamp).getTime() - new Date(b.e.timestamp).getTime());
    for (const { e, x } of events) {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const runtimeId = typeof data.runtimeId === 'string' ? data.runtimeId : x.runtimeId;
      const modelId = typeof data.modelId === 'string' ? data.modelId : x.modelId;
      if (!runtimeId) continue;
      if (e.type === 'generation.completed' && modelId && (data.outcome === 'completed' || data.outcome === 'error')) {
        this.recordInference(runtimeId, modelId, {
          at: new Date(e.timestamp),
          error: data.outcome === 'error' ? String(data.error ?? 'inference error') : undefined,
        });
      } else if (e.type === 'prompt_cache.telemetry') {
        const source = data.source;
        this.recordTelemetry(runtimeId, source === 'OBSERVED' || source === 'ESTIMATED' || source === 'UNSUPPORTED' ? source : 'UNKNOWN');
      }
    }
  }

  snapshot(): HealthObservations {
    return {
      inference: Object.fromEntries([...this.inference].map(([k, v]) => [k, [...v]])),
      telemetry: Object.fromEntries(this.telemetry),
      loadFailures: Object.fromEntries(this.loadFailures),
      admissionDenials: Object.fromEntries(this.admissionDenials),
      readinessProbeFailures: Object.fromEntries(this.probeFailures),
    };
  }
}
