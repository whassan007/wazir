import type {
  GenerationRequest,
  RuntimeAdapter,
} from '@wazir/runtimes-interfaces';
import type { WorkerExecutionRequest } from '@wazir/core';

export interface ExecutionStreamEvent {
  type: 'token' | 'tool_call' | 'completed' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  error?: string;
}

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
  onEvent?: (event: ExecutionStreamEvent) => void,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const generationRequest: GenerationRequest = {
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
        onEvent?.({ type: 'token', content: event.content });
      } else if (event.type === 'tool_call') {
        onEvent?.({ type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput });
      } else if (event.type === 'completed') {
        if (event.content) output = event.content;
        inputTokens = event.usage?.inputTokens ?? 0;
        outputTokens = event.usage?.outputTokens ?? 0;
        onEvent?.({ type: 'completed', content: event.content, usage: event.usage });
      } else if (event.type === 'error') {
        ok = false;
        error = event.error;
        onEvent?.({ type: 'error', error: event.error });
      }
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    onEvent?.({ type: 'error', error });
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
