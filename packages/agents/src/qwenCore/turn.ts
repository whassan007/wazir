import type { AgentRuntime, ChatMessage } from '@wazir/core';
import { injectFault } from '@wazir/shared';
import { parseXmlToolCalls } from './xmlToolFallback.js';

export const QWEN_CONTEXT_OVERFLOW_PATTERN =
  /CONTEXT_PREFLIGHT_OVERFLOW|MODEL_CONTEXT_OVERFLOW|context.{0,25}(length|window|size).{0,25}(exceed|too (long|large)|maximum)|maximum context length|reduce the (length|number) of (the )?messages|prompt is too long|input is too long|exceeds the available context size|n_ctx/i;

const TRANSIENT_STREAM_PATTERN =
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ECONNABORTED|UND_ERR_SOCKET|socket hang up|fetch failed|other side closed/i;

const MAX_STREAM_RETRIES = 2;

export interface QwenToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
  raw?: string;
}

export interface QwenTurnResult {
  content: string;
  rawContent: string;
  reasoning: string;
  toolCalls: QwenToolCallRequest[];
  tokensUsed: number;
  finishReason?: string;
  timedOut: boolean;
  contextOverflow: boolean;
  error?: string;
  retryNotes: string[];
}

export interface RunQwenTurnOptions {
  runtime: AgentRuntime;
  modelId: string;
  messages: ChatMessage[];
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  maxTokens?: number;
  temperature?: number;
  modelTurnTimeoutMs?: number;
  turnIndex: number;
  isCancelled?: () => boolean;
}

async function runSingleQwenTurnAttempt(options: RunQwenTurnOptions): Promise<QwenTurnResult> {
  const { runtime, modelId, messages, tools, maxTokens, temperature, modelTurnTimeoutMs, turnIndex, isCancelled } = options;

  let content = '';
  let reasoning = '';
  const toolCalls: QwenToolCallRequest[] = [];
  let tokensUsed = 0;
  let finishReason: string | undefined;
  let timedOut = false;
  let explicitOverflowClass = false;
  let error: string | undefined;
  const retryNotes: string[] = [];

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (modelTurnTimeoutMs && modelTurnTimeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      runtime.cancelCurrentTurn?.();
    }, modelTurnTimeoutMs);
  }

  try {
    await injectFault('DURING_MODEL_STREAM');
    let callCounter = 0;
    const stream = runtime.generate({
      modelId,
      messages,
      maxTokens,
      temperature,
      tools: tools.length > 0 ? tools : undefined,
      toolChoice: tools.length > 0 ? 'auto' : undefined,
      parallelToolCalls: tools.length > 0 ? true : undefined,
    });

    for await (const event of stream) {
      if (isCancelled?.()) {
        runtime.cancelCurrentTurn?.();
        break;
      }
      if (timedOut) {
        break;
      }

      if (event.type === 'token' && event.content) {
        content += event.content;
      } else if (event.type === 'reasoning' && event.content) {
        reasoning += event.content;
      } else if (event.type === 'tool_call' && event.toolName) {
        let parsedInput: Record<string, unknown> = {};
        if (typeof event.toolInput === 'string') {
          try {
            const parsed = JSON.parse(event.toolInput);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedInput = parsed as Record<string, unknown>;
            }
          } catch {
            parsedInput = { __malformedJson: event.toolInput };
          }
        } else if (event.toolInput && typeof event.toolInput === 'object' && !Array.isArray(event.toolInput)) {
          parsedInput = event.toolInput as Record<string, unknown>;
        }
        toolCalls.push({
          id: event.toolCallId || `call_${turnIndex}_${callCounter++}`,
          name: event.toolName,
          input: parsedInput,
          raw: JSON.stringify({ name: event.toolName, input: parsedInput }),
        });
      } else if (event.type === 'retry') {
        const delaySec = ((event.retryDelayMs ?? 0) / 1000).toFixed(1);
        retryNotes.push(
          `Provider retry ${event.retryAttempt ?? 1}${event.failureClass ? ` (${event.failureClass})` : ''} in ${delaySec}s: ${event.error ?? 'transient error'}`,
        );
      } else if (event.type === 'completed') {
        if (!content && event.content) {
          content = event.content;
        }
        if (event.finishReason) {
          finishReason = event.finishReason;
        }
        if (event.usage) {
          tokensUsed += event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        }
      } else if (event.type === 'error') {
        error = event.error ?? 'Unknown model generation error';
        if (event.failureClass === 'MODEL_CONTEXT_OVERFLOW') {
          explicitOverflowClass = true;
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const rawContent = content;

  // Fallback for local Qwen servers emitting <tool_call> XML blocks in text content
  if (toolCalls.length === 0 && !error && content.includes('<tool_call>')) {
    const xmlParsed = parseXmlToolCalls(content, turnIndex);
    if (xmlParsed.calls.length > 0) {
      for (const c of xmlParsed.calls) {
        toolCalls.push({ ...c, raw: rawContent });
      }
      content = xmlParsed.strippedContent;
    }
  }

  const contextOverflow = explicitOverflowClass || Boolean(error && QWEN_CONTEXT_OVERFLOW_PATTERN.test(error));

  return {
    content,
    rawContent,
    reasoning,
    toolCalls,
    tokensUsed,
    finishReason,
    timedOut,
    contextOverflow,
    error,
    retryNotes,
  };
}

/**
 * Executes a single Qwen Code 1.0 model turn with bounded stream-disconnect recovery.
 */
export async function runQwenModelTurn(options: RunQwenTurnOptions): Promise<QwenTurnResult> {
  const aggregatedRetryNotes: string[] = [];

  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    const res = await runSingleQwenTurnAttempt(options);
    aggregatedRetryNotes.push(...res.retryNotes);
    res.retryNotes = [...aggregatedRetryNotes];

    if (!res.error || res.timedOut || res.contextOverflow || options.isCancelled?.()) {
      return res;
    }

    // Only retry mid-stream socket drops if we haven't already collected tool calls
    if (attempt < MAX_STREAM_RETRIES && res.toolCalls.length === 0 && TRANSIENT_STREAM_PATTERN.test(res.error)) {
      aggregatedRetryNotes.push(
        `Stream disconnected (${res.error}); retrying turn (${attempt + 1}/${MAX_STREAM_RETRIES})`,
      );
      continue;
    }

    return res;
  }

  return runSingleQwenTurnAttempt(options);
}
