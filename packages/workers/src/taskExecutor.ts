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
  let error: string | undefined;

  try {
    const events = adapter.generate(generationRequest);
    for await (const event of events) {
      if (event.type === 'token' && event.content) {
        output += event.content;
        await onEvent?.({ type: 'token', content: event.content });
      } else if (event.type === 'tool_call') {
        await onEvent?.({ type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput });
      } else if (event.type === 'completed') {
        if (event.content) output = event.content;
        inputTokens = event.usage?.inputTokens ?? 0;
        outputTokens = event.usage?.outputTokens ?? 0;
        await onEvent?.({ type: 'completed', content: event.content, usage: event.usage });
      } else if (event.type === 'retry') {
        await onEvent?.(event);
      } else if (event.type === 'error') {
        ok = false;
        error = event.error;
        await onEvent?.(event);
      }
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    await onEvent?.({ type: 'error', error });
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
