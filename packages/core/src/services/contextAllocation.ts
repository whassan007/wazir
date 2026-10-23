/**
 * Token budget calculator for P0 context-window allocation.
 *
 * Pure functions only. Given resolved model limits and a request's estimated
 * input, picks the smallest sufficient context window from the planning
 * targets and computes output/reasoning/system/tool/safety reservations.
 * Estimation reuses resources/estimator.ts; window arithmetic reuses
 * computeUsableBudget from contextCompiler.ts.
 */

import {
  DEFAULT_CONTEXT_TARGETS,
  DEFAULT_UNKNOWN_LIMIT_POLICY,
  type ContextAllocation,
  type ContextAllocationRequest,
  type ContextReservations,
  type ModelContextLimits,
  type UnknownLimitPolicy,
} from '../types/contextAllocation.js';
import { estimateInputTokens, padEstimate } from '../resources/estimator.js';
import { computeUsableBudget } from './contextCompiler.js';

export interface TokenEstimateInput {
  systemPrompt?: string;
  messages?: Array<{ role: string; content: string }>;
  /** Tool/function schemas; estimated from their JSON size. */
  tools?: unknown[];
  /** actual/estimated ratio from the ledger. Values below 1 are not applied (padEstimate semantics). */
  calibrationRatio?: number;
  /** Safety margin applied on top of the calibrated estimate. */
  marginFraction?: number;
}

export interface TokenEstimate {
  systemTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
  totalTokens: number;
  /** 'exact' when a caller-supplied tokenizer counted the text; otherwise 'heuristic'. */
  method: 'heuristic' | 'exact';
}

export interface ReservationPolicy {
  outputTokens: number;
  reasoningTokens: number;
  safetyFraction: number;
  minSafetyTokens: number;
}

export const DEFAULT_RESERVATION_POLICY: ReservationPolicy = {
  outputTokens: 4_096,
  reasoningTokens: 0,
  safetyFraction: 0.05,
  minSafetyTokens: 256,
};

function assertNonNegativeFinite(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0 (got ${String(value)})`);
  }
}

/** Per-message framing overhead used by the estimator; derived rather than duplicated. */
function framingTokens(): number {
  return estimateInputTokens({ messages: [{ content: '' }] });
}

/**
 * Estimates request input tokens by component. Without a counter this is the
 * shared heuristic; with a counter, text is counted by the counter and the
 * estimator's framing overhead is added per message.
 */
export function estimateRequestTokens(
  input: TokenEstimateInput,
  counter?: (text: string) => number,
): TokenEstimate {
  const calibrationRatio = input.calibrationRatio ?? 1;
  const margin = input.marginFraction ?? 0;
  assertNonNegativeFinite('calibrationRatio', calibrationRatio);
  assertNonNegativeFinite('marginFraction', margin);

  let systemRaw: number;
  let messageRaw: number;
  let toolRaw: number;

  if (counter) {
    const frame = framingTokens();
    const count = (text: string): number => {
      const n = counter(text);
      assertNonNegativeFinite('counter result', n);
      return n;
    };
    systemRaw = input.systemPrompt ? count(input.systemPrompt) + frame : 0;
    messageRaw = 0;
    for (const m of input.messages ?? []) {
      messageRaw += count(m.content) + frame;
    }
    toolRaw = input.tools?.length ? count(JSON.stringify(input.tools)) : 0;
  } else {
    systemRaw = estimateInputTokens({ systemPrompt: input.systemPrompt });
    messageRaw = estimateInputTokens({
      messages: (input.messages ?? []).map((m) => ({ content: m.content })),
    });
    toolRaw = estimateInputTokens({ tools: input.tools });
  }

  const systemTokens = padEstimate(systemRaw, calibrationRatio, margin);
  const messageTokens = padEstimate(messageRaw, calibrationRatio, margin);
  const toolSchemaTokens = padEstimate(toolRaw, calibrationRatio, margin);

  return {
    systemTokens,
    messageTokens,
    toolSchemaTokens,
    totalTokens: systemTokens + messageTokens + toolSchemaTokens,
    method: counter ? 'exact' : 'heuristic',
  };
}

function validateRequest(req: ContextAllocationRequest, policy: ReservationPolicy, unknown: UnknownLimitPolicy): void {
  const { limits, estimatedInputTokens, reservations, targets } = req;
  assertNonNegativeFinite('estimatedInputTokens', estimatedInputTokens);
  assertNonNegativeFinite('limits.contextWindowTokens', limits.contextWindowTokens);
  assertNonNegativeFinite('limits.maxInputTokens', limits.maxInputTokens);
  assertNonNegativeFinite('limits.maxOutputTokens', limits.maxOutputTokens);
  assertNonNegativeFinite('limits.runtimeContextTokens', limits.runtimeContextTokens);
  assertNonNegativeFinite('reservations.outputTokens', reservations.outputTokens);
  assertNonNegativeFinite('reservations.reasoningTokens', reservations.reasoningTokens);
  assertNonNegativeFinite('reservations.systemTokens', reservations.systemTokens);
  assertNonNegativeFinite('reservations.toolSchemaTokens', reservations.toolSchemaTokens);
  assertNonNegativeFinite('reservations.safetyTokens', reservations.safetyTokens);
  assertNonNegativeFinite('policy.outputTokens', policy.outputTokens);
  assertNonNegativeFinite('policy.reasoningTokens', policy.reasoningTokens);
  assertNonNegativeFinite('policy.safetyFraction', policy.safetyFraction);
  assertNonNegativeFinite('policy.minSafetyTokens', policy.minSafetyTokens);
  assertNonNegativeFinite('unknownLimitPolicy.assumedContextTokens', unknown.assumedContextTokens);
  assertNonNegativeFinite('unknownLimitPolicy.assumedMaxOutputTokens', unknown.assumedMaxOutputTokens);
  for (const t of targets ?? []) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
      throw new RangeError(`context targets must be finite and > 0 (got ${String(t)})`);
    }
  }
}

/**
 * Picks the smallest sufficient context allocation for one request.
 * The optional policy supplies default output/reasoning reservations and the
 * safety floor; it defaults to DEFAULT_RESERVATION_POLICY.
 */
export function allocateContext(
  req: ContextAllocationRequest,
  policy: ReservationPolicy = DEFAULT_RESERVATION_POLICY,
): ContextAllocation {
  const unknownPolicy = req.unknownLimitPolicy ?? DEFAULT_UNKNOWN_LIMIT_POLICY;
  validateRequest(req, policy, unknownPolicy);

  const { limits, reservations: requested } = req;
  const estimatedInput = req.estimatedInputTokens;
  const reasons: string[] = [];
  let conservativePolicyApplied = false;

  // 1. Effective window W.
  const runtimeBound = limits.runtimeContextConfigurable ? undefined : limits.runtimeContextTokens;
  const windowCandidates = [limits.contextWindowTokens, runtimeBound].filter(
    (v): v is number => v !== undefined,
  );
  const windowKnown = limits.known !== false && windowCandidates.length > 0;
  let windowTokens: number;
  if (windowKnown) {
    windowTokens = Math.min(...windowCandidates);
    if (limits.contextWindowTokens !== undefined) {
      reasons.push(`window ${windowTokens} = min of advertised window ${limits.contextWindowTokens}` +
        (runtimeBound !== undefined ? ` and fixed runtime context ${runtimeBound}` : ''));
    } else {
      reasons.push(`window ${windowTokens} = fixed runtime context (no advertised window)`);
    }
    if (limits.runtimeContextConfigurable && limits.runtimeContextTokens !== undefined) {
      reasons.push(`runtime context ${limits.runtimeContextTokens} is configurable; not used as a ceiling`);
    }
  } else {
    windowTokens = unknownPolicy.assumedContextTokens;
    conservativePolicyApplied = true;
    reasons.push(`no window known (source ${limits.source}); assumed ${windowTokens} by unknown-limit policy`);
  }

  // 2. Output reservation (clamped to the provider cap).
  const outputRequested = requested.outputTokens ?? policy.outputTokens;
  let outputCap: number | undefined;
  if (limits.known === false) {
    outputCap = unknownPolicy.assumedMaxOutputTokens;
    conservativePolicyApplied = true;
    reasons.push(`output cap unknown; clamped to assumed ${outputCap} by unknown-limit policy`);
  } else if (limits.maxOutputTokens !== undefined) {
    outputCap = limits.maxOutputTokens;
  } else if (!windowKnown) {
    outputCap = unknownPolicy.assumedMaxOutputTokens;
    conservativePolicyApplied = true;
    reasons.push(`output cap unknown; clamped to assumed ${outputCap} by unknown-limit policy`);
  }
  let outputBase = Math.max(1, outputRequested);
  if (outputCap !== undefined && outputBase > outputCap) {
    reasons.push(`output requested ${outputRequested} clamped to provider cap ${outputCap}`);
    outputBase = Math.max(1, outputCap);
  } else {
    reasons.push(`output reserved ${outputBase}`);
  }

  // 3. Reasoning (never counted twice).
  const reasoningRequested = requested.reasoningTokens ?? policy.reasoningTokens;
  const accounting = limits.reasoningAccounting;
  let outputSent: number;
  let reasoningReserve: number;
  let reasoningSeparate: boolean;
  if (accounting === 'not-supported') {
    reasoningReserve = 0;
    reasoningSeparate = false;
    outputSent = outputBase;
    if (reasoningRequested > 0) reasons.push('reasoning not supported by provider; reasoning reserve 0');
  } else if (accounting === 'counts-against-output') {
    reasoningSeparate = false;
    reasoningReserve = 0;
    const combined = outputBase + reasoningRequested;
    outputSent = outputCap !== undefined ? Math.min(outputCap, combined) : combined;
    reasons.push(`reasoning ${reasoningRequested} counts against max_tokens; max_tokens ${outputSent}, window reserve counted once`);
    if (outputSent < combined) reasons.push(`output+reasoning ${combined} clamped to provider cap ${outputCap}`);
  } else {
    // 'separate' and 'unknown' (conservative): reserve output and reasoning separately.
    reasoningSeparate = true;
    reasoningReserve = reasoningRequested;
    outputSent = outputBase;
    if (accounting === 'unknown') reasons.push('reasoning accounting unknown; reserved separately (conservative)');
    reasons.push(`reasoning reserved separately: ${reasoningReserve}`);
  }

  const systemTokens = requested.systemTokens ?? 0;
  const toolSchemaTokens = requested.toolSchemaTokens ?? 0;
  const shared = limits.accounting !== 'independent';
  const outputInWindow = shared ? outputSent : 0;
  const reasoningInWindow = shared && reasoningSeparate ? reasoningReserve : 0;
  if (!shared) reasons.push('independent accounting: output does not consume the input window');

  // 4. Safety margin, as a fraction of what the request actually needs. Basing it on a
  // window is circular: a need that misses one target would be charged 5% of the next,
  // larger one (and 5% of a 1M window would make a 4K allocation impossible).
  const rawNeed = estimatedInput + systemTokens + toolSchemaTokens + outputInWindow + reasoningInWindow;
  const safetyTokens = Math.max(
    policy.minSafetyTokens,
    Math.ceil(policy.safetyFraction * rawNeed),
    requested.safetyTokens ?? 0,
  );
  const safetyFor = (_window: number): number => safetyTokens;

  // 5. Need for a candidate window T. Shared: everything in one window.
  // Independent: only the input side must fit in T; output has its own cap.
  const inputNeedFor = (window: number): number =>
    estimatedInput + systemTokens + toolSchemaTokens + safetyFor(window);
  const needFor = (window: number): number =>
    shared ? inputNeedFor(window) + outputInWindow + reasoningInWindow : inputNeedFor(window);

  const maxInput = limits.maxInputTokens;
  const feasible = (window: number): boolean =>
    needFor(window) <= window && (maxInput === undefined || inputNeedFor(window) <= maxInput);

  // 6. Smallest sufficient configuration.
  let outcome: ContextAllocation['outcome'];
  let allocated: number;
  const targets = [...(req.targets ?? DEFAULT_CONTEXT_TARGETS)].sort((a, b) => a - b);
  const chosen = targets.find((t) => t <= windowTokens && feasible(t));
  if (chosen !== undefined) {
    outcome = 'fits';
    allocated = chosen;
    reasons.push(`smallest target ${chosen} fits: required ${needFor(chosen)} tokens (safety ${safetyFor(chosen)})`);
  } else if (feasible(windowTokens)) {
    outcome = 'fits-at-limit';
    allocated = windowTokens;
    reasons.push(`no planning target fits; using window limit ${windowTokens} (required ${needFor(windowTokens)})`);
  } else {
    outcome = 'cannot-fit';
    allocated = windowTokens;
    if (maxInput !== undefined && inputNeedFor(windowTokens) > maxInput) {
      reasons.push(
        `cannot fit: input side requires ${inputNeedFor(windowTokens)} tokens, maxInputTokens allows ${maxInput}`,
      );
    }
    if (needFor(windowTokens) > windowTokens) {
      reasons.push(
        `cannot fit: requires ${needFor(windowTokens)} tokens, available ${windowTokens} tokens (window)`,
      );
    }
  }
  const safety = safetyFor(allocated);
  if (maxInput !== undefined) {
    reasons.push(`input side ${inputNeedFor(allocated)} vs maxInputTokens ${maxInput}`);
  }
  reasons.push(`safety ${safety}`);

  // 7. Input budget and utilization.
  let inputBudgetTokens: number;
  if (shared) {
    inputBudgetTokens = computeUsableBudget({
      effectiveContextTokens: allocated,
      reserveOutputTokens: outputInWindow + reasoningInWindow,
      reserveToolSchemaTokens: systemTokens + toolSchemaTokens,
      reserveSafetyTokens: safety,
    });
  } else {
    inputBudgetTokens = computeUsableBudget({
      effectiveContextTokens: Math.min(maxInput ?? windowTokens, allocated),
      reserveOutputTokens: 0,
      reserveToolSchemaTokens: systemTokens + toolSchemaTokens,
      reserveSafetyTokens: safety,
    });
  }
  const utilization =
    inputBudgetTokens > 0
      ? estimatedInput / inputBudgetTokens
      : estimatedInput > 0
        ? Infinity
        : 0;

  // 8. Final reservations. Under counts-against-output, reasoning is folded into outputTokens.
  const reservations: ContextReservations = {
    outputTokens: outputSent,
    reasoningTokens: reasoningInWindow,
    systemTokens,
    toolSchemaTokens,
    safetyTokens: safety,
  };
  const maxOutputTokens = outputSent;
  const requestedContextTokens = limits.runtimeContextConfigurable ? allocated : undefined;

  return {
    modelId: limits.modelId,
    outcome,
    requestedContextTokens,
    allocatedWindowTokens: allocated,
    inputBudgetTokens,
    reservations,
    maxOutputTokens,
    estimatedInputTokens: estimatedInput,
    utilization,
    limitSource: limits.source,
    conservativePolicyApplied,
    reasons,
  };
}
