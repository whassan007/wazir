/**
 * P0 context-window allocation contracts (contract version 1).
 *
 * Shared by the model registry (limits), the allocation calculator, and the
 * execution pipeline. Types and constants only — behaviour lives in
 * services/contextAllocation.ts.
 */

export const CONTEXT_ALLOCATION_CONTRACT_VERSION = 1 as const;

/**
 * Where a context/output limit came from, most to least trustworthy.
 * 'default-unknown' means no source reported a limit and a conservative
 * policy value is in use — it must never be presented as a model capability.
 */
export type ContextLimitSource =
  | 'provider-api'        // reported by the provider's models endpoint at discovery time
  | 'runtime-discovered'  // reported by a local serving runtime (Ollama / LM Studio)
  | 'provider-documented' // a documented value shipped in an adapter table
  | 'operator-configured' // set by the operator in Wazir config
  | 'default-unknown';    // nothing known; conservative policy applied

/**
 * How a provider counts output against the window.
 *  - 'shared':      input + output (+ reasoning) must fit in one context window
 *  - 'independent': input and output have separate limits, each enforced alone
 *  - 'unknown':     treated as 'shared' (the conservative choice)
 */
export type ContextAccounting = 'shared' | 'independent' | 'unknown';

/** Whether reasoning/thinking tokens are drawn from the output allowance. */
export type ReasoningAccounting = 'counts-against-output' | 'separate' | 'not-supported' | 'unknown';

/** Resolved limits for one model (optionally one loaded instance). */
export interface ModelContextLimits {
  modelId: string;
  /** Advertised total context window. Undefined when unknown. */
  contextWindowTokens?: number;
  /** Provider-enforced input limit, when distinct from the window. */
  maxInputTokens?: number;
  /** Provider-enforced output (max_tokens) limit. */
  maxOutputTokens?: number;
  /** Context the local runtime is configured/loaded with (n_ctx / num_ctx). */
  runtimeContextTokens?: number;
  /** True when the runtime context can be chosen per request or per load. */
  runtimeContextConfigurable: boolean;
  accounting: ContextAccounting;
  reasoningAccounting: ReasoningAccounting;
  source: ContextLimitSource;
  /** False when `source === 'default-unknown'`. */
  known: boolean;
  /** Human-readable derivation, one line per decision. */
  notes: string[];
}

/** Token reservations taken out of the window before input is placed. */
export interface ContextReservations {
  outputTokens: number;
  reasoningTokens: number;
  systemTokens: number;
  toolSchemaTokens: number;
  safetyTokens: number;
}

/** Configurable planning targets — not provider-supported settings. */
export const DEFAULT_CONTEXT_TARGETS: readonly number[] = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072];

export interface UnknownLimitPolicy {
  /** Window assumed when nothing reports a limit. */
  assumedContextTokens: number;
  /** Output cap assumed when nothing reports one. */
  assumedMaxOutputTokens: number;
}

export const DEFAULT_UNKNOWN_LIMIT_POLICY: UnknownLimitPolicy = {
  assumedContextTokens: 8_192,
  assumedMaxOutputTokens: 2_048,
};

export interface ContextAllocationRequest {
  limits: ModelContextLimits;
  /** Estimated tokens of the prompt content (messages + task + history), excluding reservations. */
  estimatedInputTokens: number;
  /** Requested reservations; the allocator may clamp output to the model's maxOutputTokens. */
  reservations: Partial<ContextReservations>;
  targets?: readonly number[];
  unknownLimitPolicy?: UnknownLimitPolicy;
}

export type ContextAllocationOutcome =
  | 'fits'          // a target fits within effective limits
  | 'fits-at-limit' // no planning target fits, but the effective limit does
  | 'cannot-fit';   // exceeds effective limits; the caller must not invoke the provider

export interface ContextAllocation {
  modelId: string;
  outcome: ContextAllocationOutcome;
  /**
   * Context size to request from the runtime (num_ctx / n_ctx) — the smallest
   * planning target that fits, clamped to the effective window. Undefined for
   * providers whose window is not configurable per request.
   */
  requestedContextTokens?: number;
  /** Total window this allocation plans against (target or limit). */
  allocatedWindowTokens: number;
  /** Maximum input tokens allowed after all reservations. */
  inputBudgetTokens: number;
  /** Final reservations after clamping to model limits. */
  reservations: ContextReservations;
  /** max_tokens to send to the provider. */
  maxOutputTokens: number;
  estimatedInputTokens: number;
  /** estimatedInputTokens / inputBudgetTokens, in [0, ∞). >1 means overflow. */
  utilization: number;
  limitSource: ContextLimitSource;
  /** True when the unknown-limit policy supplied the window or output cap. */
  conservativePolicyApplied: boolean;
  reasons: string[];
}

/** Estimated vs actual token accounting for one invocation. */
export interface ContextUsageRecord {
  modelId: string;
  requestId?: string;
  allocatedWindowTokens: number;
  requestedContextTokens?: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  /** Provider-reported values; undefined when the provider did not report them. Never estimated. */
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualReasoningTokens?: number;
  /** actualInputTokens / estimatedInputTokens when both known. */
  inputEstimateRatio?: number;
}
