import type { WorkloadClass } from './types.js';

/**
 * Token estimation without a vendor tokenizer. Exact tokenizers exist only for some vendors
 * (none for Anthropic or arbitrary local GGUF models), so Wazir uses one conservative
 * character heuristic, corrected per model by the observed actual/estimated ratio (see
 * ResourceLedger.calibrate) and always reported as an estimate.
 */

/** Characters per token: prose ~4, code and JSON closer to 3; 3.2 errs toward over-counting. */
const CHARS_PER_TOKEN = 3.2;
/** Per-message framing overhead (role markers, separators) in chat templates. */
const PER_MESSAGE_TOKENS = 4;

export interface EstimatableRequest {
  systemPrompt?: string;
  prompt?: string;
  messages?: Array<{ content?: unknown; toolCalls?: unknown }>;
  tools?: unknown[];
  maxTokens?: number;
}

export function estimateTextTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** Raw (uncalibrated, unpadded) input-token estimate for a generation request. */
export function estimateInputTokens(req: EstimatableRequest): number {
  let tokens = 0;
  if (req.systemPrompt) tokens += estimateTextTokens(req.systemPrompt) + PER_MESSAGE_TOKENS;
  if (req.prompt) tokens += estimateTextTokens(req.prompt) + PER_MESSAGE_TOKENS;
  for (const m of req.messages ?? []) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    tokens += estimateTextTokens(content) + PER_MESSAGE_TOKENS;
    if (m.toolCalls) tokens += estimateTextTokens(JSON.stringify(m.toolCalls));
  }
  // Tool schemas are sent with every request and are often the largest fixed cost.
  if (req.tools?.length) tokens += estimateTextTokens(JSON.stringify(req.tools));
  return tokens;
}

/** Expected output when the request sets no max_tokens, by workload. */
const DEFAULT_OUTPUT: Record<WorkloadClass, number> = {
  deterministic: 0,
  summarization: 1_024,
  bulk: 1_024,
  routine: 2_048,
  complex: 4_096,
  'critical-review': 4_096,
};

export function estimateOutputTokens(req: EstimatableRequest, workload: WorkloadClass): number {
  return req.maxTokens && req.maxTokens > 0 ? req.maxTokens : DEFAULT_OUTPUT[workload];
}

/** Applies calibration and the safety margin; the result is what gets reserved. */
export function padEstimate(raw: number, calibrationRatio: number, margin: number): number {
  return Math.ceil(raw * Math.max(1, calibrationRatio) * (1 + Math.max(0, margin)));
}
