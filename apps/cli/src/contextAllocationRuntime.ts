/**
 * Runtime wiring for native context-window allocation: plan-time sizing and
 * per-invocation allocation shared by `wa run` and the fleet runner.
 * Pure policy lives in @wazir/core (allocateContext / resolveModelContextLimits);
 * this file only connects it to the engine's registry, ledger and execution log.
 */
import {
  allocateContext,
  estimateRequestTokens,
  resolveModelContextLimits,
  effectiveContextTokens,
  type ContextAllocation,
  type ContextDecision,
  type ContextPart,
  type ContextUsageRecord,
  type ModelContextLimits,
  type ModelRecord,
} from '@wazir/core';
import type { RookEngine } from './engine.js';

/** Provider-valid failure text; matches the coding agent's overflow-recovery pattern ("prompt is too long"). */
export const CONTEXT_PREFLIGHT_OVERFLOW = 'CONTEXT_PREFLIGHT_OVERFLOW';

type Placement = { runtimeId: string; computerId?: string };

/** Limits for the model on the given placement (the loaded instance, when one is registered). */
export function limitsFor(engine: Pick<RookEngine, 'models'>, modelId: string, placement?: Placement): ModelContextLimits {
  const model = engine.models.getRequired(modelId);
  const instances = engine.models.instancesOf(modelId);
  const instance = placement
    ? instances.find((i) => i.runtimeId === placement.runtimeId && (placement.computerId === undefined || i.computerId === placement.computerId))
    : undefined;
  return resolveModelContextLimits(model, instance);
}

/**
 * The largest usable window W for a model: the allocator's effective window
 * (unknown limits fall to the conservative assumption), further bounded by an
 * operator-configured context when the limits are known.
 */
export function effectiveWindow(limits: ModelContextLimits, model?: Pick<ModelRecord, 'contextMax' | 'configuredContext'>): number {
  const w = allocateContext({ limits, estimatedInputTokens: 0, reservations: { outputTokens: 1 }, targets: [] }).allocatedWindowTokens;
  if (limits.known && model?.configuredContext !== undefined) return Math.min(w, effectiveContextTokens(model));
  return w;
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

export interface PlannedContext {
  context: ContextDecision;
  allocation: ContextAllocation;
  limits: ModelContextLimits;
}

/**
 * Compiles `parts` against the model's effective window W (never a planning
 * target, so optional parts are not dropped just because a small target was
 * chosen) with allocation-derived reservations, and attaches the allocation
 * for the initial request. `context.fits === false` means even critical parts
 * plus reservations exceed W.
 */
export function planContext(
  engine: RookEngine,
  parts: ContextPart[],
  modelId: string,
  options: { tools?: unknown[]; outputReserveTokens: number; placement?: Placement },
): PlannedContext {
  const model = engine.models.getRequired(modelId);
  const limits = limitsFor(engine, modelId, options.placement);
  const window = effectiveWindow(limits, model);
  const toolSchemaTokens = estimateRequestTokens({ tools: options.tools }).toolSchemaTokens;
  const inputTokens = engine.compiler.budget(parts, 0).inputTokens;
  const first = allocateContext({
    limits,
    estimatedInputTokens: inputTokens,
    reservations: { outputTokens: options.outputReserveTokens, toolSchemaTokens },
  });
  const shared = limits.accounting !== 'independent';
  const reserve = (shared ? first.reservations.outputTokens + first.reservations.reasoningTokens : 0)
    + toolSchemaTokens + first.reservations.safetyTokens;
  const context = engine.compiler.compile(
    parts,
    { tokens: window, source: limits.source === 'default-unknown' ? 'default' : model.configuredContext !== undefined ? 'configured' : 'discovered' },
    Math.max(reserve, first.maxOutputTokens),
  );
  const allocation = context.finalInputTokens === inputTokens
    ? first
    : allocateContext({
        limits,
        estimatedInputTokens: context.finalInputTokens,
        reservations: { outputTokens: options.outputReserveTokens, toolSchemaTokens },
      });
  if (!context.fits) {
    context.reasons.push(
      `context cannot fit: requires ${context.finalRequiredTokens} tokens, available ${window} tokens (limit source: ${limits.source})`,
    );
  }
  return { context, allocation, limits };
}

export interface PreparedInvocation {
  allocation: ContextAllocation;
  /** max_tokens to send; never above the model's output cap. */
  maxTokens: number;
  /** num_ctx to send; undefined for runtimes whose context is not per-request configurable. */
  contextTokens?: number;
  /** Set when the request cannot fit: the provider must not be called. */
  preflightError?: string;
}

/**
 * Per-execution allocator: one call to `prepare` before each provider request,
 * and `recordUsage` when it completes. Keeps contextTokens monotonic per model
 * so a local runtime is not reloaded to a smaller context mid-execution.
 */
export class InvocationContextAllocator {
  private readonly sent = new Map<string, number>();
  private readonly pending = new Map<string, { allocation: ContextAllocation; estimated: number }>();

  constructor(
    private readonly engine: RookEngine,
    private readonly executionId: string,
    private readonly defaultOutputTokens: number,
  ) {}

  windowFor(modelId: string, placement?: Placement): number {
    return effectiveWindow(limitsFor(this.engine, modelId, placement), this.engine.models.getRequired(modelId));
  }

  private calibrationRatio(modelId: string): number | undefined {
    try {
      const { ratio, samples } = this.engine.resources.budget.ledger.calibration(modelId);
      return samples > 0 && Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
    } catch {
      return undefined;
    }
  }

  async prepare(
    request: { modelId: string; messages: Array<{ role: string; content: unknown }>; maxTokens?: number; tools?: unknown[] },
    placement?: Placement,
  ): Promise<PreparedInvocation> {
    const limits = limitsFor(this.engine, request.modelId, placement);
    const estimate = estimateRequestTokens({
      messages: request.messages.map((m) => ({ role: m.role, content: asText(m.content) })),
      tools: request.tools,
      calibrationRatio: this.calibrationRatio(request.modelId),
    });
    const allocation = allocateContext({
      limits,
      estimatedInputTokens: estimate.totalTokens,
      reservations: { outputTokens: request.maxTokens ?? this.defaultOutputTokens },
    });

    let contextTokens: number | undefined;
    if (allocation.requestedContextTokens !== undefined) {
      contextTokens = Math.max(allocation.requestedContextTokens, this.sent.get(request.modelId) ?? 0);
      // Never exceed the model's usable window.
      contextTokens = Math.min(contextTokens, this.windowFor(request.modelId, placement));
      // A request that is not sent must not ratchet the context up.
      if (allocation.outcome !== 'cannot-fit') this.sent.set(request.modelId, contextTokens);
    }
    const maxTokens = Math.min(request.maxTokens ?? allocation.maxOutputTokens, allocation.maxOutputTokens);

    await this.engine.executions.recordEvent(this.executionId, 'context.allocated', {
      modelId: request.modelId,
      outcome: allocation.outcome,
      allocatedWindowTokens: allocation.allocatedWindowTokens,
      requestedContextTokens: contextTokens,
      maxOutputTokens: maxTokens,
      estimatedInputTokens: allocation.estimatedInputTokens,
      inputBudgetTokens: allocation.inputBudgetTokens,
      limitSource: allocation.limitSource,
      conservativePolicyApplied: allocation.conservativePolicyApplied,
      reasons: allocation.reasons.slice(0, 6),
    });
    this.pending.set(request.modelId, { allocation, estimated: estimate.totalTokens });

    let preflightError: string | undefined;
    if (allocation.outcome === 'cannot-fit') {
      const required = allocation.estimatedInputTokens + (limits.accounting === 'independent' ? 0 : maxTokens) + allocation.reservations.safetyTokens;
      preflightError = `${CONTEXT_PREFLIGHT_OVERFLOW}: prompt is too long: requires ${required} tokens, available ${allocation.allocatedWindowTokens} (source ${allocation.limitSource})`;
    }
    return { allocation, maxTokens, contextTokens, preflightError };
  }

  /** Records provider-reported usage only; actual fields stay undefined when not reported. */
  async recordUsage(modelId: string, requestId: string | undefined, usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }): Promise<void> {
    const pending = this.pending.get(modelId);
    if (!pending) return;
    const { allocation, estimated } = pending;
    const actualInput = typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined;
    const record: ContextUsageRecord = {
      modelId,
      requestId,
      allocatedWindowTokens: allocation.allocatedWindowTokens,
      requestedContextTokens: allocation.requestedContextTokens,
      estimatedInputTokens: estimated,
      reservedOutputTokens: allocation.maxOutputTokens,
      actualInputTokens: actualInput,
      actualOutputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined,
      actualReasoningTokens: typeof usage?.reasoningTokens === 'number' ? usage.reasoningTokens : undefined,
      inputEstimateRatio: actualInput !== undefined && estimated > 0 ? actualInput / estimated : undefined,
    };
    await this.engine.executions.recordEvent(this.executionId, 'context.usage', record);
  }
}
