import { randomUUID } from 'node:crypto';
import type { GenerationEvent, GenerationRequest, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { estimateInputTokens, estimateOutputTokens, estimateTextTokens, padEstimate } from './estimator.js';
import type { TokenBudgetManager } from './budgetManager.js';
import { WORKLOAD_CLASSES, type ResourceAdmissionDecision, type UsageMeasurement, type WorkloadClass } from './types.js';

export interface GovernorOptions {
  budget: TokenBudgetManager;
  /** Account serving this runtime + model; undefined = the request is refused (unaccounted). */
  resolveAccount: (runtimeId: string, modelId: string) => string | undefined;
  /** Sleep used while queueing for local capacity (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const LEASE_RENEW_MS = 60_000;

/**
 * Wraps a RuntimeAdapter so that every generate() call passes resource admission and is
 * accounted: estimate → reserve → dispatch → reconcile (or fail/release). All other adapter
 * methods are passed through unchanged. A refused request yields an error event and is never
 * sent to the provider.
 */
export function governAdapter(inner: RuntimeAdapter, opts: GovernorOptions): RuntimeAdapter {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = opts.budget;
  const ledger = budget.ledger;

  async function* governedGenerate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    const requestId = request.requestId ?? `${inner.id}-${randomUUID()}`;
    const req: GenerationRequest = { ...request, requestId };
    const accountId = opts.resolveAccount(inner.id, request.modelId);
    if (!accountId) {
      yield { type: 'error', requestId, failureClass: 'POLICY_DENIED', error: `RESOURCE_ADMISSION_DENIED: no account is configured for runtime '${inner.id}' model '${request.modelId}'` };
      return;
    }
    const ctx = request.resourceContext ?? {};
    const workload: WorkloadClass = (WORKLOAD_CLASSES as readonly string[]).includes(ctx.workload ?? '') ? ctx.workload as WorkloadClass : 'routine';
    const rawInput = estimateInputTokens(req);
    const { ratio } = ledger.calibration(request.modelId);
    const estInput = padEstimate(rawInput, ratio, budget.policy.estimateMargin);
    const estOutput = estimateOutputTokens(req, workload);
    const admission = () => budget.admit({
      requestId, accountId, modelId: request.modelId, workload, taskId: ctx.taskId, agent: ctx.agent,
      estimatedInputTokens: estInput, estimatedOutputTokens: estOutput,
    });

    let decision: ResourceAdmissionDecision = admission();
    // Local capacity is a queue, not a refusal: wait for a GPU slot (bounded).
    const account = budget.accounts.get(accountId);
    if (decision.outcome === 'deferred' && account?.kind === 'local' && /concurrency limit/.test(decision.reasons.join(' '))) {
      const deadline = ledger.now() + budget.policy.localQueueTimeoutMs;
      let wait = 100;
      while (decision.outcome === 'deferred' && /concurrency limit/.test(decision.reasons.join(' ')) && ledger.now() < deadline) {
        await sleep(wait);
        wait = Math.min(1_000, wait * 2);
        decision = admission();
      }
    }
    if (decision.outcome !== 'admitted') {
      yield {
        type: 'error', requestId,
        failureClass: decision.outcome === 'deferred' ? 'RESOURCE_EXHAUSTED' : 'POLICY_DENIED',
        retryAfterMs: decision.retryAt ? Math.max(0, decision.retryAt - ledger.now()) : undefined,
        error: `RESOURCE_ADMISSION_${decision.outcome.toUpperCase()}: ${decision.reasons.join('; ')}`,
      };
      return;
    }

    const started = ledger.now();
    let lastRenew = started;
    let outputSeen = false;
    let outputText = '';
    let settled = false;
    const estimatedUsage = (): UsageMeasurement => ({
      inputTokens: rawInput, outputTokens: estimateTextTokens(outputText), source: 'estimated',
    });
    try {
      for await (const event of inner.generate(req)) {
        const now = ledger.now();
        if (now - lastRenew > LEASE_RENEW_MS) {
          ledger.renewLease(requestId, now + budget.policy.leaseMs);
          lastRenew = now;
        }
        if (event.type === 'token' || event.type === 'reasoning' || event.type === 'tool_call') {
          outputSeen = true;
          if (event.content) outputText += event.content;
        }
        if (event.rateLimit) {
          ledger.observe(accountId, 'rate_limit', event.rateLimit);
          const exhausted = event.rateLimit.remainingRequests === 0 || event.rateLimit.remainingTokens === 0;
          if (exhausted) {
            const reset = Date.parse(event.rateLimit.remainingRequests === 0 ? event.rateLimit.resetRequestsAt ?? '' : event.rateLimit.resetTokensAt ?? '');
            if (Number.isFinite(reset) && reset > now) ledger.setHealth(accountId, 'cooldown', reset, 'provider rate-limit headers report 0 remaining');
          }
        }
        if (event.type === 'retry') {
          ledger.appendEvent(event.failureClass === 'RATE_LIMIT' ? 'rate_limited' : 'provider_error', { accountId, requestId, taskId: ctx.taskId }, { retry: true, attempt: event.retryAttempt, delayMs: event.retryDelayMs });
        }
        if (event.type === 'completed') {
          const u = event.usage;
          const reported = !!u && (u.inputTokens > 0 || u.outputTokens > 0);
          const usage: UsageMeasurement = reported
            ? { inputTokens: u!.inputTokens, outputTokens: u!.outputTokens, cachedInputTokens: u!.cacheReadTokens, reasoningTokens: u!.reasoningTokens, source: 'provider-reported' }
            : estimatedUsage();
          if (event.finishReason === 'cancelled' && !reported) {
            usage.inputTokens = Math.max(usage.inputTokens, rawInput);
          }
          budget.reconcile(requestId, usage, { durationMs: now - started, agent: ctx.agent, rawEstimatedInput: rawInput });
          settled = true;
        }
        if (event.type === 'error') {
          const ambiguous = outputSeen || (event.failureClass === 'TIMEOUT' && event.status === undefined);
          budget.fail(requestId, {
            failureClass: event.failureClass, status: event.status, retryAfterMs: event.retryAfterMs, ambiguous,
            partial: outputSeen ? estimatedUsage() : undefined, message: event.error,
          });
          settled = true;
        }
        yield event;
      }
    } finally {
      if (!settled) {
        // Consumer stopped early or the stream threw: the prompt was sent and some output
        // produced, so charge what can be estimated rather than releasing.
        budget.reconcile(requestId, { ...estimatedUsage(), source: outputSeen ? 'estimated' : 'conservative' }, { durationMs: ledger.now() - started, agent: ctx.agent });
      }
    }
  }

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'generate') return governedGenerate;
      if (prop === '__governed') return true;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const isGoverned = (adapter: RuntimeAdapter): boolean => (adapter as unknown as { __governed?: boolean }).__governed === true;
