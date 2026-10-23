import { effectiveContextTokens, type ModelInstance, type ModelRecord } from '@wazir/core';
import type { ReadinessRecord } from './types.js';

/**
 * Parsed form of `requiredCapabilities` strings (from prompts / targets).
 *
 * Recognised forms (case-insensitive):
 * - `toolCalling` | `tools` | `tool-use` | `tool_use` | `function-calling` -> native tool calling,
 *   which must also be *verified* by a readiness tool probe (declared support is not enough)
 * - `vision` | `structuredOutput` | `json` | `reasoning` | `embedding` | `audio` -> model flags
 * - `context:N` | `context>=N` | `minContext:N` | `context:32k` -> effective context window >= N tokens
 * - `local` -> only local (non-hosted) instances
 * - anything else -> must appear in the model's declared `capabilities`
 */
export interface CapabilityRequirements {
  raw: string[];
  toolCalling: boolean;
  flags: Array<'vision' | 'structuredOutput' | 'reasoning' | 'embedding' | 'audio'>;
  minContextTokens: number;
  localOnly: boolean;
  declared: string[];
  invalid: string[];
}

const TOOL_ALIASES = new Set(['toolcalling', 'tools', 'tool-use', 'tool_use', 'tooluse', 'function-calling', 'functioncalling', 'tool-calling']);
const FLAG_ALIASES: Record<string, CapabilityRequirements['flags'][number]> = {
  vision: 'vision',
  structuredoutput: 'structuredOutput',
  'structured-output': 'structuredOutput',
  json: 'structuredOutput',
  reasoning: 'reasoning',
  embedding: 'embedding',
  embeddings: 'embedding',
  audio: 'audio',
};

function parseTokens(value: string): number | undefined {
  const m = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] === 'k' ? 1024 : m[2] === 'm' ? 1024 * 1024 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

export function parseCapabilities(required: readonly string[] | undefined): CapabilityRequirements {
  const out: CapabilityRequirements = { raw: [], toolCalling: false, flags: [], minContextTokens: 0, localOnly: false, declared: [], invalid: [] };
  for (const entry of required ?? []) {
    if (typeof entry !== 'string') continue;
    const cap = entry.trim();
    if (!cap) continue;
    out.raw.push(cap);
    const lower = cap.toLowerCase();
    const ctx = lower.match(/^(?:context|mincontext|min-context|context-tokens)\s*(?::|>=|=)\s*(.+)$/);
    if (ctx) {
      const tokens = parseTokens(ctx[1]);
      if (tokens === undefined) out.invalid.push(cap);
      else out.minContextTokens = Math.max(out.minContextTokens, tokens);
      continue;
    }
    if (TOOL_ALIASES.has(lower)) { out.toolCalling = true; continue; }
    if (FLAG_ALIASES[lower]) { if (!out.flags.includes(FLAG_ALIASES[lower])) out.flags.push(FLAG_ALIASES[lower]); continue; }
    if (lower === 'local' || lower === 'local-only') { out.localOnly = true; continue; }
    if (!out.declared.includes(cap)) out.declared.push(cap);
  }
  return out;
}

/** Context the instance can actually serve: a runtime-reported window wins over the record. */
export function instanceContextTokens(record: ModelRecord, instance?: ModelInstance): number {
  return instance?.contextTokens ?? effectiveContextTokens(record);
}

/**
 * Checks capability requirements for one instance. Returns the first failure
 * (as a human-readable rejection) and the satisfied checks (as reasons).
 */
export function checkCapabilities(
  req: CapabilityRequirements,
  record: ModelRecord,
  instance: ModelInstance | undefined,
  readiness: ReadinessRecord | undefined,
): { ok: boolean; reasons: string[]; rejection?: string } {
  const reasons: string[] = [];
  if (req.invalid.length > 0) return { ok: false, reasons, rejection: `invalid capability requirement(s): ${req.invalid.join(', ')}` };
  if (req.toolCalling) {
    if (!record.toolCalling) return { ok: false, reasons, rejection: 'tool calling required but the model does not declare support' };
    if (readiness?.toolUse !== 'verified') {
      return {
        ok: false,
        reasons,
        rejection: `tool calling required but not verified by a readiness tool probe (${readiness?.toolUse ?? 'never probed'})`,
      };
    }
    reasons.push('tool calling: declared and verified by probe');
  }
  for (const flag of req.flags) {
    const supported =
      flag === 'vision' ? record.vision
        : flag === 'structuredOutput' ? record.structuredOutput || record.capabilities.includes('structuredOutput')
          : flag === 'reasoning' ? record.reasoning || record.capabilities.includes('reasoning')
            : flag === 'embedding' ? record.embedding
              : record.audio;
    if (!supported) return { ok: false, reasons, rejection: `${flag} required but unsupported` };
    reasons.push(`${flag}: supported`);
  }
  if (req.minContextTokens > 0) {
    const ctx = instanceContextTokens(record, instance);
    if (ctx < req.minContextTokens) return { ok: false, reasons, rejection: `context ${ctx} < required ${req.minContextTokens}` };
    reasons.push(`context ${ctx} >= required ${req.minContextTokens}`);
  }
  for (const cap of req.declared) {
    const has = record.capabilities.some((c) => c.toLowerCase() === cap.toLowerCase());
    if (!has) return { ok: false, reasons, rejection: `capability '${cap}' missing` };
    reasons.push(`capability '${cap}': present`);
  }
  return { ok: true, reasons };
}
