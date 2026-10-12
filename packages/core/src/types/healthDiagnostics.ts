/**
 * Runtime & model health diagnostics.
 *
 * A read-only projection over authoritative state (RuntimeRegistry, ModelRegistry,
 * ComputerRegistry, worker info, lifecycle events, inference/telemetry observations).
 * It never owns or mutates that state. Missing evidence stays UNKNOWN; it is never
 * collapsed into a failure. Prompt-cache telemetry is reported on its own axis and
 * never feeds runtime or inference health.
 */

export type DiagnosticCode =
  | 'RUNTIME_UNREACHABLE'
  | 'MODEL_NOT_LOADED'
  | 'MODEL_NOT_READY'
  | 'MODEL_LOAD_FAILED'
  | 'INSUFFICIENT_MEMORY'
  | 'QUEUE_PRESSURE'
  | 'INFERENCE_FAILED'
  | 'TELEMETRY_UNAVAILABLE'
  | 'WORKER_UNAVAILABLE'
  | 'UNKNOWN';

/** Which layer a diagnostic belongs to — keeps model, runtime and telemetry failures separate. */
export type DiagnosticDomain = 'RUNTIME' | 'MODEL' | 'MODEL_LOAD' | 'RESOURCE' | 'TELEMETRY' | 'WORKER';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticEvidence {
  /** What was observed, e.g. "model state", "readiness probe". */
  label: string;
  /** Observed value, verbatim; `null` means the evidence was not available. */
  value: string | number | boolean | null;
  /** Where the observation came from, e.g. "ModelRegistry", "lifecycle event". */
  source: string;
  observedAt?: string;
}

export interface HealthDiagnostic {
  code: DiagnosticCode;
  domain: DiagnosticDomain;
  severity: DiagnosticSeverity;
  subject: { kind: 'runtime' | 'model' | 'computer' | 'worker'; id: string };
  reason: string;
  evidence: DiagnosticEvidence[];
}

/**
 * UNAVAILABLE: the registry marks the runtime unusable without reachability evidence
 * (hosted providers are marked unavailable when unauthenticated/ineligible).
 */
export type RuntimeHealthState = 'READY' | 'DEGRADED' | 'UNREACHABLE' | 'UNAVAILABLE' | 'UNKNOWN';
export type InferenceHealthState = 'HEALTHY' | 'FAILING' | 'UNKNOWN';
/** Mirrors CacheMetricStatus semantics: OBSERVED, explicitly unsupported, or simply not known. */
export type TelemetryHealthState = 'OBSERVED' | 'ESTIMATED' | 'UNSUPPORTED' | 'UNKNOWN';
export type ResourcePressureLevel = 'OK' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface ResourcePressure {
  level: ResourcePressureLevel;
  totalMemoryBytes?: number;
  usedMemoryBytes?: number;
  availableMemoryBytes?: number;
  reservedMemoryBytes: number;
  observedAt?: string;
}

export interface InferenceOutcome {
  at: string;
  error?: string;
}

export interface RuntimeHealthProjection {
  runtimeId: string;
  runtimeType: string;
  computerId?: string;
  state: RuntimeHealthState;
  /** `null` = never probed / not known. */
  endpointReachable: boolean | null;
  inferenceReady: boolean | null;
  loadedModels: string[];
  queueDepth: number | null;
  resourcePressure: ResourcePressure;
  inference: InferenceHealthState;
  lastSuccessfulInference?: string;
  lastFailure?: InferenceOutcome;
  telemetryStatus: TelemetryHealthState;
  lastCheckedAt?: string;
}

export interface ModelHealthProjection {
  instanceId: string;
  modelId: string;
  runtimeId: string;
  computerId?: string;
  installed: boolean;
  /** Weights resident in the runtime. Distinct from `ready`. */
  loaded: boolean;
  /** Loaded AND verified usable (lifecycle state READY and healthy). */
  ready: boolean;
  lifecycleState: string;
  contextLimit?: number;
  currentReservations: { count: number; memoryBytes: number };
  memoryEstimateBytes?: number;
  lastSuccessfulInference?: string;
  recentFailures: InferenceOutcome[];
  lastLoadFailure?: InferenceOutcome;
}

export interface WorkerHealthProjection {
  workerId: string;
  computerId: string;
  status: 'online' | 'offline' | 'unknown';
  running: boolean | null;
  lastHeartbeat?: string;
}

export interface HealthReport {
  generatedAt: string;
  runtimes: RuntimeHealthProjection[];
  models: ModelHealthProjection[];
  workers: WorkerHealthProjection[];
  diagnostics: HealthDiagnostic[];
  summary: Record<DiagnosticCode, number>;
}

/** Observations the projection consumes; everything is optional so absence means UNKNOWN. */
export interface HealthObservations {
  /** Inference outcomes keyed by `${runtimeId}::${modelId}`. Most recent last. */
  inference?: Record<string, InferenceOutcome[]>;
  /** Most recent prompt-cache telemetry status keyed by runtimeId. */
  telemetry?: Record<string, TelemetryHealthState>;
  /** Most recent load failure keyed by instance id or `${runtimeId}::${modelId}`. */
  loadFailures?: Record<string, InferenceOutcome>;
  /** Most recent admission rejection keyed by `${runtimeId}::${modelId}`. */
  admissionDenials?: Record<string, { at: string; reasons: string[] }>;
  /** Queue depth keyed by runtimeId, only when an authoritative source exists. */
  queueDepth?: Record<string, number>;
  /** Failed readiness probe keyed by instance id. */
  readinessProbeFailures?: Record<string, { at: string; error?: string }>;
}

export interface HealthThresholds {
  queuePressureDepth: number;
  memoryHighFraction: number;
  memoryCriticalFraction: number;
  /** Only this many trailing inference outcomes are considered "recent". */
  recentWindow: number;
}
