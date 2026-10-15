import type {
  GenerationRequest,
  GenerationEvent,
  RuntimeAdapter,
} from '@wazir/runtimes-interfaces';
import type { WorkerExecutionRequest } from '@wazir/core';

export interface ExecutionStreamEvent extends GenerationEvent {}

export interface ExecutionOutcome {
  output: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

/**
 * Executes a single authorized request against a runtime adapter.
 * Pure execution: no scheduling, no policy, no model selection.
 * The caller supplies exactly which model/messages/tools to use.
 *
 * The outcome is `ok` only when the provider stream reached its `completed` event. A
 * stream that ends without one (a dropped connection the adapter didn't surface), a
 * completion the adapter marks `cancelled`, or no completion within `request.timeoutMs`
 * is a failure: partial output is returned for diagnosis but never reported as success.
 */
export async function executeRequest(
  adapter: RuntimeAdapter,
  request: WorkerExecutionRequest,
  onEvent?: (event: ExecutionStreamEvent) => void | Promise<void>,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const generationRequest: GenerationRequest = {
    providerRetryPolicy: request.providerRetryPolicy,
    modelId: request.modelId,
    messages: request.messages,
    tools: request.tools,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    contextTokens: request.contextTokens,
    stream: true,
    requestId: request.requestId,
  };

  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let ok = true;
  let completed = false;
  let error: string | undefined;

  const timeoutMs = request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol('timeout');
  const deadline = timeoutMs === undefined ? undefined : new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });

  try {
    const iterator = adapter.generate(generationRequest)[Symbol.asyncIterator]();
    for (;;) {
      const next = deadline ? await Promise.race([iterator.next(), deadline]) : await iterator.next();
      if (next === TIMED_OUT) {
        ok = false;
        error = `MODEL_REQUEST_TIMEOUT: no completion within ${timeoutMs}ms`;
        await adapter.cancel?.(request.requestId).catch(() => undefined);
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        await onEvent?.({ type: 'error', error });
        break;
      }
      if (next.done) break;
      const event = next.value;
      if (event.type === 'token' && event.content) {
        output += event.content;
        await onEvent?.({ type: 'token', content: event.content });
      } else if (event.type === 'tool_call') {
        await onEvent?.({ type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput });
      } else if (event.type === 'completed') {
        completed = true;
        if (event.content) output = event.content;
        inputTokens = event.usage?.inputTokens ?? 0;
        outputTokens = event.usage?.outputTokens ?? 0;
        if (event.finishReason === 'cancelled') {
          ok = false;
          error = 'MODEL_REQUEST_CANCELLED: the provider stream was aborted before it finished';
        }
        await onEvent?.({ type: 'completed', content: event.content, usage: event.usage });
      } else if (event.type === 'retry') {
        await onEvent?.(event);
      } else if (event.type === 'error') {
        ok = false;
        error = event.error;
        await onEvent?.(event);
      }
    }
    if (ok && !completed) {
      ok = false;
      error = 'STREAM_TRUNCATED: the provider stream ended without a completion event';
      await onEvent?.({ type: 'error', error });
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    await onEvent?.({ type: 'error', error });
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    output,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - started,
    ok,
    error,
  };
}

export async function cancelRequest(adapter: RuntimeAdapter, requestId: string): Promise<void> {
  await adapter.cancel?.(requestId);
}
