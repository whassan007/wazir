import type { CheckRunRecord, EvaluationResult, ExecutionRecord } from '@wazir/core';

export * from './types/verification.js';
export * from './continuousVerification.js';

export interface EvaluationOptions {
  /** If set, the task is only successful when each of these files changed. */
  expectedFiles?: string[];
}

/**
 * Deterministic post-execution evaluation:
 * - expected files changed (when the task declared them)
 * - every executed check (test / lint / typecheck / build) passed
 * - no fatal errors were recorded during execution
 *
 * Tool calls denied by policy are NOT fatal — they are recorded in
 * toolCalls and policyDecisions for inspection.
 */
export function evaluateExecution(
  record: Pick<ExecutionRecord, 'filesChanged' | 'checks' | 'errors'>,
  options: EvaluationOptions = {},
): EvaluationResult {
  const reasons: string[] = [];
  const checks: CheckRunRecord[] = [...record.checks];

  let success = true;

  if (options.expectedFiles && options.expectedFiles.length > 0) {
    const changed = record.filesChanged.map((f) => f.replace(/\\/g, '/'));
    const missing = options.expectedFiles.filter((expected) => {
      const normalized = expected.replace(/\\/g, '/');
      return !changed.some((c) => c === normalized || c.endsWith(`/${normalized}`));
    });
    if (missing.length > 0) {
      success = false;
      reasons.push(`expected files were not changed: ${missing.join(', ')}`);
    } else {
      reasons.push(`all expected files changed: ${options.expectedFiles.join(', ')}`);
    }
  } else if (record.filesChanged.length > 0) {
    reasons.push(`files changed: ${record.filesChanged.length}`);
  } else {
    reasons.push('no files changed');
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    success = false;
    reasons.push(`failed checks: ${failed.map((c) => `${c.name} (${c.command})`).join(', ')}`);
  } else if (checks.length > 0) {
    reasons.push(`all ${checks.length} checks passed (${checks.map((c) => c.name).join(', ')})`);
  } else {
    reasons.push('no checks were executed');
  }

  if (record.errors.length > 0) {
    success = false;
    reasons.push(`${record.errors.length} error(s) recorded during execution`);
  }

  return {
    success,
    reasons,
    filesChanged: record.filesChanged,
    checks,
    evaluatedAt: new Date(),
  };
}
