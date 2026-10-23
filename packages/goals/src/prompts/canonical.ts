import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively, `undefined` members dropped,
 * no whitespace. Two structurally equal values always serialize identically, so
 * the digest of a prompt's content is stable across processes and stores.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) continue;
    out[key] = normalize(member);
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Deep structural clone through JSON (prompt records are plain JSON data). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
