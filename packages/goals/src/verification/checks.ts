import { promises as fs } from 'node:fs';
import { sanitizeUntrustedOutput } from '@wazir/shared';
import type { VerificationVerdict } from '../contracts.js';
import { normalizeArtifactPath, resolveInside } from './digest.js';
import type { CheckRunner, CheckRunResult, DeclaredCheck, JsonSchemaLite } from './types.js';

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_TIMEOUT_MS = 600_000;
export const MIN_CHECK_TIMEOUT_MS = 1_000;
const EXCERPT_LIMIT = 4_000;

export function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_CHECK_TIMEOUT_MS;
  return Math.min(MAX_CHECK_TIMEOUT_MS, Math.max(MIN_CHECK_TIMEOUT_MS, Math.floor(ms)));
}

/** Structural view of @wazir/tools `runShell` (loaded lazily; see createSandboxedCheckRunner). */
type RunShell = (command: string, options: {
  cwd: string;
  projectRoot?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  networkAllowed?: boolean;
  signal?: AbortSignal;
}) => Promise<{ code: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean; sandbox: string }>;

/**
 * Default CheckRunner: Wazir's existing tool process path (`@wazir/tools`
 * runShell) — OS sandbox when available (bwrap / sandbox-exec), writes confined
 * to the workspace, no network, rlimits, process-group kill on timeout, reduced
 * environment. When WAZIR_SANDBOX=required and no backend exists, the command is
 * not run and the check is reported NOT_RUN.
 *
 * `@wazir/tools` is loaded by specifier at runtime because @wazir/goals does not
 * (yet) declare it as a dependency; see the agent-04 report integration notes.
 */
export function createSandboxedCheckRunner(loader: () => Promise<RunShell> = loadRunShell): CheckRunner {
  return {
    async run({ command, cwd, timeoutMs, signal }): Promise<CheckRunResult> {
      let runShell: RunShell;
      try {
        runShell = await loader();
      } catch (error) {
        return { exitCode: -1, stdout: '', stderr: '', timedOut: false, durationMs: 0, sandbox: 'unavailable', error: `process tooling unavailable: ${(error as Error).message}` };
      }
      try {
        const res = await runShell(command, { cwd, projectRoot: cwd, timeoutMs, maxBuffer: 1024 * 1024, networkAllowed: false, signal });
        return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut, durationMs: res.durationMs, sandbox: res.sandbox };
      } catch (error) {
        return { exitCode: -1, stdout: '', stderr: '', timedOut: false, durationMs: 0, sandbox: 'unavailable', error: (error as Error).message };
      }
    },
  };
}

async function loadRunShell(): Promise<RunShell> {
  const specifier = '@wazir/tools';
  const mod = (await import(specifier)) as { runShell?: RunShell };
  if (typeof mod.runShell !== 'function') throw new Error('@wazir/tools does not export runShell');
  return mod.runShell;
}

export function excerpt(text: string): string {
  // Strip terminal escapes and redact secrets before persisting (shared sanitizer).
  const cleaned = sanitizeUntrustedOutput(text);
  return cleaned.length > EXCERPT_LIMIT ? `${cleaned.slice(0, EXCERPT_LIMIT)}\n…[truncated ${cleaned.length - EXCERPT_LIMIT} chars]` : cleaned;
}

/** Validates `value` against the JSON-schema subset. Unknown keywords → UNKNOWN. */
export function validateSchema(value: unknown, schema: JsonSchemaLite, at = '$'): { verdict: VerificationVerdict; errors: string[] } {
  const supported = new Set(['type', 'required', 'properties', 'items', 'enum', 'const', 'minItems', 'minLength', 'minimum', 'maximum', '$schema', 'title', 'description', 'additionalProperties']);
  const errors: string[] = [];
  let unknown = false;
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) {
      unknown = true;
      errors.push(`${at}: unsupported schema keyword '${key}'`);
    }
  }
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === 'integer' ? Number.isInteger(value) : schema.type === actual;
    if (!ok) errors.push(`${at}: expected ${schema.type}, got ${actual}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: not in enum`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: const mismatch`);
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => {
      const r = validateSchema(item, schema.items as JsonSchemaLite, `${at}[${i}]`);
      if (r.verdict === 'UNKNOWN') unknown = true;
      errors.push(...r.errors);
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) if (!(req in obj)) errors.push(`${at}: missing required '${req}'`);
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(obj)) if (!(k in schema.properties)) errors.push(`${at}: unexpected property '${k}'`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj) {
        const r = validateSchema(obj[k], sub, `${at}.${k}`);
        if (r.verdict === 'UNKNOWN') unknown = true;
        errors.push(...r.errors);
      }
    }
  }
  const hardErrors = errors.filter((e) => !e.includes('unsupported schema keyword'));
  if (hardErrors.length > 0) return { verdict: 'FAIL', errors };
  if (unknown) return { verdict: 'UNKNOWN', errors };
  return { verdict: 'PASS', errors };
}

export interface CheckOutcome {
  verdict: VerificationVerdict;
  method: string;
  command?: string;
  exitCode?: number;
  outputExcerpt?: string;
  limitations: string[];
}

async function readArtifact(root: string, artifact: string | undefined): Promise<{ bytes?: Buffer; problem?: string }> {
  if (!artifact) return { problem: 'check declares no artifact' };
  try {
    const rel = normalizeArtifactPath(artifact);
    const real = await resolveInside(root, rel);
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { problem: `not a regular file: ${rel}` };
    if (stat.size > 64 * 1024 * 1024) return { problem: `artifact too large for content checks: ${rel}` };
    return { bytes: await fs.readFile(real) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problem: `artifact missing: ${artifact}` };
    return { problem: (error as Error).message };
  }
}

/** Runs one declared check. Never throws; failures to run are NOT_RUN / UNKNOWN, never PASS. */
export async function runDeclaredCheck(
  check: DeclaredCheck,
  root: string,
  runner: CheckRunner | undefined,
  signal?: AbortSignal,
): Promise<CheckOutcome> {
  switch (check.kind) {
    case 'command': {
      const method = check.testSuite ? 'test-suite' : 'command';
      if (!check.command || !check.command.trim()) return { verdict: 'NOT_RUN', method, limitations: ['command check declares no command'] };
      if (!runner) return { verdict: 'NOT_RUN', method, command: check.command, limitations: ['no check runner configured'] };
      const res = await runner.run({ command: check.command, cwd: root, timeoutMs: clampTimeout(check.timeoutMs), signal });
      const limitations: string[] = [];
      if (res.sandbox === 'none') limitations.push('ran without an OS sandbox (host execution; WAZIR_SANDBOX not required)');
      if (res.error) return { verdict: 'NOT_RUN', method, command: check.command, limitations: [...limitations, `command not run: ${res.error}`] };
      if (res.timedOut) return { verdict: 'FAIL', method, command: check.command, exitCode: res.exitCode, outputExcerpt: excerpt(`${res.stdout}\n${res.stderr}`.trim()), limitations: [...limitations, `timed out after ${clampTimeout(check.timeoutMs)}ms`] };
      return {
        verdict: res.exitCode === 0 ? 'PASS' : 'FAIL',
        method,
        command: check.command,
        exitCode: res.exitCode,
        outputExcerpt: excerpt(`${res.stdout}\n${res.stderr}`.trim()),
        limitations,
      };
    }
    case 'exists':
    case 'non-empty': {
      const r = await readArtifact(root, check.artifact);
      if (r.problem) return { verdict: 'FAIL', method: 'existence', outputExcerpt: r.problem, limitations: [r.problem] };
      if (check.kind === 'non-empty' && (r.bytes?.length ?? 0) === 0) return { verdict: 'FAIL', method: 'existence', outputExcerpt: 'artifact is empty', limitations: [`artifact is empty: ${check.artifact}`] };
      return { verdict: 'PASS', method: 'existence', outputExcerpt: `${check.artifact}: ${r.bytes?.length ?? 0} bytes`, limitations: ['existence does not establish semantic correctness'] };
    }
    case 'contains': {
      if (!check.pattern) return { verdict: 'NOT_RUN', method: 'content-check', limitations: ['contains check declares no pattern'] };
      const r = await readArtifact(root, check.artifact);
      if (r.problem) return { verdict: 'FAIL', method: 'content-check', outputExcerpt: r.problem, limitations: [r.problem] };
      const ok = (r.bytes as Buffer).toString('utf8').includes(check.pattern);
      return { verdict: ok ? 'PASS' : 'FAIL', method: 'content-check', outputExcerpt: ok ? 'pattern found' : `pattern not found in ${check.artifact}`, limitations: [] };
    }
    case 'json-schema': {
      if (!check.schema) return { verdict: 'NOT_RUN', method: 'schema', limitations: ['schema check declares no schema'] };
      const r = await readArtifact(root, check.artifact);
      if (r.problem) return { verdict: 'FAIL', method: 'schema', outputExcerpt: r.problem, limitations: [r.problem] };
      let parsed: unknown;
      try {
        parsed = JSON.parse((r.bytes as Buffer).toString('utf8'));
      } catch (error) {
        return { verdict: 'FAIL', method: 'schema', outputExcerpt: `invalid JSON: ${(error as Error).message}`, limitations: [] };
      }
      const v = validateSchema(parsed, check.schema);
      return { verdict: v.verdict, method: 'schema', outputExcerpt: excerpt(v.errors.join('\n') || 'schema valid'), limitations: v.verdict === 'UNKNOWN' ? ['schema uses unsupported keywords'] : [] };
    }
    default:
      return { verdict: 'NOT_RUN', method: 'command', limitations: [`unsupported check kind '${(check as DeclaredCheck).kind}'`] };
  }
}
