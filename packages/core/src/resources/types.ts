/**
 * Resource-aware orchestration types. An *account* is one independently authorised source of
 * inference: a local runtime on this machine (DGX Spark), a provider API key (billed per
 * token), or a consumer subscription used through its vendor's own CLI agent.
 */

/** How Wazir is permitted to use the account. */
export type AccountKind = 'local' | 'api' | 'subscription';
export type IntegrationMethod = 'local-endpoint' | 'api-key' | 'oauth' | 'vendor-cli';

/**
 * Where a limit value comes from. Only `provider-reported` is authoritative; everything
 * else is Wazir's own enforcement or an estimate, and is labelled as such everywhere.
 */
export type LimitSource = 'provider-reported' | 'provider-documented' | 'configured' | 'estimated';

/** What a limit counts. `tokens` = input + output (cached input counted at `cachedInputWeight`). */
export type LimitUnit = 'tokens' | 'input_tokens' | 'output_tokens' | 'requests' | 'cost_usd';

/**
 * Accounting window. Rolling: `5h`, `1m`, `24h`, `7d` (any `<n>m|h|d`). Calendar (UTC):
 * `day`, `week` (ISO, Monday start), `month`.
 */
export type WindowSpec = string;

/** Utilization thresholds as fractions of the limit (defaults 0.70 / 0.85 / 0.95). */
export interface Thresholds {
  advisory: number;
  conserve: number;
  critical: number;
}

export interface LimitSpec {
  unit: LimitUnit;
  window: WindowSpec;
  /** The limit. `null` = the account has this kind of limit but its value is unknown. */
  limit: number | null;
  source: LimitSource;
  /** Hard limits block dispatch at 100%. Soft limits only drive conservation (default: hard). */
  hard?: boolean;
  thresholds?: Partial<Thresholds>;
  note?: string;
}

/** Workload classes, from cheapest to most demanding. */
export const WORKLOAD_CLASSES = ['deterministic', 'summarization', 'bulk', 'routine', 'complex', 'critical-review'] as const;
export type WorkloadClass = typeof WORKLOAD_CLASSES[number];

export interface Pricing {
  /** USD per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
}

export interface AccountConfig {
  id: string;
  /** Human label for dashboards. */
  label?: string;
  provider: string;
  kind: AccountKind;
  integration: IntegrationMethod;
  /** What this account serves. Local/API: runtime ids; subscription: agent names. */
  runtimeIds?: string[];
  agents?: string[];
  /** Model ids served (exact or `*` glob). Empty = any model of the bound runtimes/agents. */
  models?: string[];
  /** Model context limits, by model id; used to reject oversize requests before dispatch. */
  contextLimits?: Record<string, number>;
  limits?: LimitSpec[];
  /** Max requests in flight on this account (GPU concurrency for local accounts). */
  maxConcurrent?: number;
  /** Requests-per-minute and tokens-per-minute, enforced as rolling 1m limits. */
  rpm?: number;
  tpm?: number;
  pricing?: Pricing | Record<string, Pricing>;
  /** Higher = preferred when otherwise equal. */
  priority?: number;
  /** Workloads this account may serve at all (default: all). */
  workloads?: WorkloadClass[];
  /** Workloads still admitted in conservation mode (default: complex, critical-review). */
  reserveFor?: WorkloadClass[];
  /** Workloads still admitted in critical mode (default: critical-review). */
  criticalOnly?: WorkloadClass[];
  /** API accounts are paid; they are used only when `policy.paidApiFallback` is true or this is. */
  allowPaid?: boolean;
  /** Extra environment for a vendor CLI (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME) — one login each. */
  env?: Record<string, string>;
  /** Reading names only: a value of an env var holding a key, never the key itself. */
  credentialRef?: string;
  enabled?: boolean;
  /** Admission when a limit's value is unknown (default 'conserve'). */
  unknownLimitPolicy?: 'allow' | 'conserve' | 'deny';
}

export type PolicyMode = 'balanced' | 'local-first' | 'quality-first' | 'budget-first';

export interface RoutingWeights {
  quality: number;
  reliability: number;
  capacity: number;
  cost: number;
  latency: number;
  quotaRisk: number;
}

export interface ResourcePolicy {
  /**
   * Enforce limits (quotas, spend ceilings, concurrency, cooldowns, paid-API gate). Off by
   * default: requests are still accounted and routed, but never refused for budget reasons.
   * The emergency stop is an operator switch, not a limit, and applies either way.
   */
  enforce: boolean;
  mode: PolicyMode;
  /** Never dispatch to paid API accounts unless true (or the account sets allowPaid). */
  paidApiFallback: boolean;
  /** Safety margin added to every token estimate (default 0.25 = +25%). */
  estimateMargin: number;
  /** Reservation lease; an unreconciled reservation older than this is recovered. */
  leaseMs: number;
  /** Per-task token ceiling across all its requests (0 = none). */
  maxTaskTokens: number;
  /** Daily / monthly paid spend ceilings across all API accounts (0 = none). */
  dailySpendUsd: number;
  monthlySpendUsd: number;
  /** How long a local request waits for a GPU slot before giving up. */
  localQueueTimeoutMs: number;
  weights?: Partial<RoutingWeights>;
  /** Workload classes that must stay on local accounts (privacy). */
  localOnlyWorkloads?: WorkloadClass[];
  /** Minimum empirically calibrated correctness probability Q_min in [0, 1]. */
  minVerifiedSuccessRate?: number;
  /** Hard latency ceiling L_max in milliseconds (including cold-start/load time). */
  maxLatencyMs?: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { advisory: 0.70, conserve: 0.85, critical: 0.95 };

export const DEFAULT_POLICY: ResourcePolicy = {
  enforce: false,
  mode: 'balanced',
  paidApiFallback: false,
  estimateMargin: 0.25,
  leaseMs: 15 * 60_000,
  maxTaskTokens: 0,
  dailySpendUsd: 0,
  monthlySpendUsd: 0,
  localQueueTimeoutMs: 120_000,
};

/** Budget mode of one account, from its most-utilised limit. */
export type BudgetMode = 'normal' | 'advisory' | 'conserve' | 'critical' | 'exhausted' | 'unknown';

/** Live account state that does not come from usage arithmetic. */
export type AccountHealth = 'ok' | 'cooldown' | 'auth_blocked' | 'quota_blocked';

export interface LimitStatus {
  unit: LimitUnit;
  window: WindowSpec;
  limit: number | null;
  source: LimitSource;
  used: number;
  reserved: number;
  /** used + reserved over limit; undefined when the limit is unknown. */
  utilization?: number;
  windowStart: number;
  windowEnd?: number;
  mode: BudgetMode;
}

export interface AccountStatus {
  account: AccountConfig;
  health: AccountHealth;
  healthUntil?: number;
  healthReason?: string;
  mode: BudgetMode;
  limits: LimitStatus[];
  inFlight: number;
}

export interface UsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** Where the numbers come from. */
  source: 'provider-reported' | 'estimated' | 'conservative';
}

export interface ResourceAdmissionRequest {
  requestId: string;
  accountId: string;
  modelId: string;
  workload: WorkloadClass;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  taskId?: string;
  agent?: string;
  /** Requests reserved (1 per model call; agents may reserve more). */
  requests?: number;
}

export type ResourceAdmissionOutcome = 'admitted' | 'deferred' | 'blocked';

export interface ResourceAdmissionDecision {
  outcome: ResourceAdmissionOutcome;
  requestId: string;
  accountId: string;
  reservationId?: string;
  mode: BudgetMode;
  reasons: string[];
  /** For deferred: earliest time a retry may succeed. */
  retryAt?: number;
}
