import { createHash } from 'node:crypto';
import type { GoalGraphDefinition } from '../contracts.js';

/**
 * Canonical JSON: object keys sorted (code-unit order) at every level, array
 * order preserved, `undefined` members dropped, Dates as ISO strings. Two
 * structurally equal definitions always produce the same string, whatever
 * key order a store (e.g. Postgres JSONB) hands back.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, 0));
}

function normalize(value: unknown, depth: number): unknown {
  if (depth > 128) throw new Error('canonicalJson: value nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v, depth + 1)));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === 'function') continue;
      out[key] = normalize(v, depth + 1);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Contract digest: sha256 hex of the canonical JSON of the definition. */
export function graphDigest(definition: GoalGraphDefinition): string {
  return sha256Hex(canonicalJson(definition));
}
