import { randomBytes } from 'node:crypto';
import { GoalStudioFailure, type PromptDefinition } from '../contracts.js';
import { canonicalJson } from './canonical.js';
import { renderPrompt } from './render.js';
import { validateAgainstSchema } from './schema.js';
import type {
  PromptEvalCase,
  PromptEvalCaseResult,
  PromptEvalCheck,
  PromptEvaluationResult,
  PromptRunner,
} from './types.js';

export const MAX_EVAL_CASES = 200;
export const DEFAULT_EVAL_TIMEOUT_MS = 60_000;

export interface EvaluatePromptOptions {
  clock?: () => Date;
  runnerId?: string;
  actor?: string;
  /** Per-case runner timeout. */
  timeoutMs?: number;
  /** Aborts the whole evaluation. */
  signal?: AbortSignal;
}

/** Parses model output as JSON: raw JSON, or the first ```json fenced block. */
export function parseJsonOutput(output: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof output !== 'string') return output === undefined ? { ok: false } : { ok: true, value: output };
  const trimmed = output.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  for (const text of candidates) {
    if (!text) continue;
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      // try next candidate
    }
  }
  return { ok: false };
}

function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => isSubset(value, (actual as Record<string, unknown>)[key]));
  }
  return canonicalJson(expected) === canonicalJson(actual);
}

export function validateEvalCases(cases: unknown): PromptEvalCase[] {
  if (!Array.isArray(cases) || cases.length === 0) throw new GoalStudioFailure('VALIDATION', 'cases must be a non-empty array');
  if (cases.length > MAX_EVAL_CASES) throw new GoalStudioFailure('VALIDATION', `at most ${MAX_EVAL_CASES} cases per evaluation`);
  const ids = new Set<string>();
  return cases.map((raw, index) => {
    const item = raw as PromptEvalCase;
    if (!item || typeof item !== 'object') throw new GoalStudioFailure('VALIDATION', `cases[${index}] must be an object`);
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `case-${index + 1}`;
    if (ids.has(id)) throw new GoalStudioFailure('VALIDATION', `duplicate case id '${id}'`);
    ids.add(id);
    if (!item.inputs || typeof item.inputs !== 'object' || Array.isArray(item.inputs)) {
      throw new GoalStudioFailure('VALIDATION', `cases[${index}].inputs must be an object`);
    }
    if (item.expect?.matches !== undefined) {
      try {
        new RegExp(item.expect.matches);
      } catch (error) {
        throw new GoalStudioFailure('VALIDATION', `cases[${index}].expect.matches is not a valid regular expression: ${(error as Error).message}`);
      }
    }
    return { id, inputs: item.inputs, expect: item.expect };
  });
}

async function runWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject before aborting so the caller sees the timeout, not the abort.
          reject(new Error(`runner timed out after ${timeoutMs}ms`));
          controller.abort(new Error('timeout'));
        }, timeoutMs);
        if (outer?.aborted) reject(new Error('evaluation aborted'));
        outer?.addEventListener('abort', () => reject(new Error('evaluation aborted')), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

async function evaluateCase(def: PromptDefinition, testCase: PromptEvalCase, runner: PromptRunner, options: EvaluatePromptOptions): Promise<PromptEvalCaseResult> {
  const began = Date.now();
  const expect = testCase.expect ?? {};
  const checks: PromptEvalCheck[] = [];
  const finish = (extra: Partial<PromptEvalCaseResult>): PromptEvalCaseResult => ({
    caseId: testCase.id,
    passed: checks.length > 0 && checks.every((check) => check.passed),
    checks,
    durationMs: Date.now() - began,
    ...extra,
  });

  let rendered: string;
  try {
    rendered = renderPrompt(def, testCase.inputs).text;
  } catch (error) {
    const message = (error as Error).message;
    checks.push({ name: 'render', passed: Boolean(expect.renderFails), message });
    return finish({ error: expect.renderFails ? undefined : message });
  }
  if (expect.renderFails) {
    checks.push({ name: 'render', passed: false, message: 'expected rendering to fail but it succeeded' });
    return finish({ rendered });
  }
  checks.push({ name: 'render', passed: true });

  let response;
  try {
    response = await runWithTimeout((signal) => runner({ prompt: def, rendered, inputs: testCase.inputs, caseId: testCase.id, signal }), options.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS, options.signal);
  } catch (error) {
    const message = (error as Error).message;
    checks.push({ name: 'runner', passed: false, message });
    return finish({ rendered, error: message });
  }
  const output = response?.output;
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  const parsed = parseJsonOutput(output);

  const needsJson = (def.outputSchema && expect.validateOutputSchema !== false) || expect.equals !== undefined || expect.subset !== undefined;
  if (needsJson && !parsed.ok) checks.push({ name: 'json', passed: false, message: 'output is not valid JSON' });

  if (def.outputSchema && expect.validateOutputSchema !== false && parsed.ok) {
    const issues = validateAgainstSchema(def.outputSchema, parsed.value);
    checks.push({ name: 'outputSchema', passed: issues.length === 0, message: issues.length ? issues.map((i) => `${i.path} ${i.message}`).join('; ') : undefined });
  }
  for (const needle of expect.contains ?? []) {
    checks.push({ name: `contains:${needle}`, passed: text.includes(needle), message: text.includes(needle) ? undefined : `output does not contain '${needle}'` });
  }
  for (const needle of expect.notContains ?? []) {
    checks.push({ name: `notContains:${needle}`, passed: !text.includes(needle), message: text.includes(needle) ? `output contains forbidden '${needle}'` : undefined });
  }
  if (expect.matches !== undefined) {
    const ok = new RegExp(expect.matches).test(text);
    checks.push({ name: 'matches', passed: ok, message: ok ? undefined : `output does not match /${expect.matches}/` });
  }
  if (expect.equals !== undefined && parsed.ok) {
    const ok = canonicalJson(parsed.value) === canonicalJson(expect.equals);
    checks.push({ name: 'equals', passed: ok, message: ok ? undefined : 'parsed output differs from expected value' });
  }
  if (expect.subset !== undefined && parsed.ok) {
    const ok = isSubset(expect.subset, parsed.value);
    checks.push({ name: 'subset', passed: ok, message: ok ? undefined : 'parsed output is missing expected fields' });
  }
  return finish({ rendered, output: parsed.ok ? parsed.value : output, modelId: response?.modelId, costUsd: response?.costUsd });
}

export function evaluationId(clock: () => Date): string {
  return `${clock().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
}

/**
 * Runs `cases` against one prompt version with an injected runner and checks each
 * output against `outputSchema` and the per-case expectations. Cases run
 * sequentially (deterministic order, bounded load on local inference). Pure: does
 * not persist anything; `PromptAdmin.evaluate` stores the result.
 */
export async function evaluatePrompt(def: PromptDefinition, cases: PromptEvalCase[], runner: PromptRunner, options: EvaluatePromptOptions = {}): Promise<PromptEvaluationResult> {
  const clock = options.clock ?? (() => new Date());
  const validCases = validateEvalCases(cases);
  const startedAt = clock().toISOString();
  const results: PromptEvalCaseResult[] = [];
  for (const testCase of validCases) {
    if (options.signal?.aborted) throw new GoalStudioFailure('CANCELLED', 'evaluation aborted');
    results.push(await evaluateCase(def, testCase, runner, options));
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    id: evaluationId(clock),
    promptId: def.id,
    version: def.version,
    digest: def.digest,
    runnerId: options.runnerId ?? 'injected',
    actor: options.actor ?? 'system',
    startedAt,
    finishedAt: clock().toISOString(),
    cases: results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? passed / results.length : 0,
      costUsd: results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0),
    },
  };
}
