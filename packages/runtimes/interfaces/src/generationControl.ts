import type { GenerationEvent, GenerationRequest } from './index.js';

export class GenerationLimitError extends Error {
  constructor(readonly failureClass: 'RESOURCE_EXHAUSTED' | 'TIMEOUT' | 'CANCELLED', message: string) {
    super(message); this.name = 'GenerationLimitError';
  }
}

/** One logical generation's physical request admissions, including provider retries.
 * Total-token and dollar limits require additional verified input/pricing information. */
export class GenerationControl {
  readonly controller = new AbortController();
  readonly requestId: string;
  attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly externalAbort = () => this.controller.abort();
  constructor(readonly request: GenerationRequest) {
    this.requestId = request.requestId ?? `generation-${globalThis.crypto.randomUUID()}`;
    const limits = request.executionLimits;
    if (limits?.maxModelCalls !== undefined && (!Number.isSafeInteger(limits.maxModelCalls) || limits.maxModelCalls < 0)) {
      throw new GenerationLimitError('RESOURCE_EXHAUSTED', 'INVALID_GENERATION_LIMIT: maxModelCalls must be a nonnegative integer');
    }
    if (limits?.deadlineAt !== undefined && (!Number.isSafeInteger(limits.deadlineAt) || limits.deadlineAt < 0)) {
      throw new GenerationLimitError('RESOURCE_EXHAUSTED', 'INVALID_GENERATION_LIMIT: deadlineAt must be a nonnegative timestamp');
    }
    request.signal?.addEventListener('abort', this.externalAbort, { once: true });
    if (request.signal?.aborted) this.controller.abort();
    const armDeadline = () => {
      if (limits?.deadlineAt === undefined) return;
      const remaining = limits.deadlineAt - Date.now();
      if (remaining <= 0) { this.controller.abort(); return; }
      this.timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    armDeadline();
  }
  assertActive(): void {
    if (this.request.executionLimits?.deadlineAt !== undefined && Date.now() >= this.request.executionLimits.deadlineAt) {
      throw new GenerationLimitError('TIMEOUT', 'GENERATION_DEADLINE_EXCEEDED');
    }
    if (this.controller.signal.aborted) throw new GenerationLimitError('CANCELLED', 'GENERATION_CANCELLED');
  }
  assertAllowance(): void {
    this.assertActive();
    if (this.request.executionLimits?.maxModelCalls !== undefined && this.attempt >= this.request.executionLimits.maxModelCalls) {
      throw new GenerationLimitError('RESOURCE_EXHAUSTED', 'MAX_MODEL_CALLS: Provider request allowance exhausted');
    }
  }
  startAttempt(): GenerationEvent {
    this.assertAllowance(); this.attempt++;
    return { type: 'attempt_started', requestId: this.requestId, attempt: this.attempt, attemptId: `${this.requestId}:attempt:${this.attempt}` };
  }
  capRetries(retries: number): number {
    const maximum = this.request.executionLimits?.maxModelCalls;
    return maximum === undefined ? retries : Math.min(retries, Math.max(0, maximum - 1));
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.request.signal?.removeEventListener('abort', this.externalAbort);
    this.controller.abort();
  }
}

/** Adds identity, admission limits and cancellation to the established adapter stream. */
export async function* controlledGeneration(
  request: GenerationRequest,
  generate: (request: GenerationRequest, control: GenerationControl) => AsyncIterable<GenerationEvent>,
): AsyncIterable<GenerationEvent> {
  let control: GenerationControl | undefined;
  try {
    control = new GenerationControl(request);
    control.assertAllowance();
    for await (const event of generate({ ...request, requestId: control.requestId }, control)) {
      // Partial completions produced by cancellation must never become normal success unless explicitly marked finishReason: 'cancelled'.
      if (event.type === 'completed' && event.finishReason !== 'cancelled') control.assertActive();
      yield control.attempt > 0 ? {
        ...event, requestId: control.requestId, attempt: control.attempt,
        attemptId: `${control.requestId}:attempt:${control.attempt}`,
      } : event;
    }
  } catch (error) {
    if (!(error instanceof GenerationLimitError)) throw error;
    yield { type: 'error', requestId: control?.requestId ?? request.requestId, attempt: control?.attempt,
      failureClass: error.failureClass, error: error.message };
  } finally { control?.dispose(); }
}
