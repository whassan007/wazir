import fs from 'node:fs';
import path from 'node:path';
import type { CheckRunRecord, EvaluationResult, ExecutionRecord } from '@wazir/core';

export * from './types/verification.js';
export * from './continuousVerification.js';

export interface EvaluationOptions {
  /** If set, the task is only successful when each of these files changed. */
  expectedFiles?: string[];
  /** Expected evidence criteria, e.g. ["file_exists: src/main.cpp", "check_passed: test", "no_errors"] */
  expectedEvidence?: string[];
  /** Project or worktree root for verifying file existence on disk. */
  projectRoot?: string;
}

/**
 * Deterministic post-execution evaluation:
 * - expected files changed (when the task declared them)
 * - expected evidence satisfied (file existence, check success, error freedom)
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

  // Verify expected evidence criteria
  if (options.expectedEvidence && options.expectedEvidence.length > 0) {
    const changed = record.filesChanged.map((f) => f.replace(/\\/g, '/'));
    for (const evidence of options.expectedEvidence) {
      const trimmed = evidence.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('file_exists:') || trimmed.startsWith('source_file_exists:')) {
        const target = trimmed.replace(/^(source_)?file_exists:\s*/, '').trim();
        const normalized = target.replace(/\\/g, '/');
        const inChanged = changed.some((c) => c === normalized || c.endsWith(`/${normalized}`));
        const onDisk = options.projectRoot ? fs.existsSync(path.resolve(options.projectRoot, target)) : false;
        if (!inChanged && !onDisk) {
          success = false;
          reasons.push(`evidence missing: file '${target}' does not exist`);
        } else {
          reasons.push(`evidence verified: file '${target}' exists`);
        }
      } else if (trimmed.startsWith('file_changed:')) {
        const target = trimmed.replace(/^file_changed:\s*/, '').trim();
        const normalized = target.replace(/\\/g, '/');
        const inChanged = changed.some((c) => c === normalized || c.endsWith(`/${normalized}`));
        if (!inChanged) {
          success = false;
          reasons.push(`evidence missing: file '${target}' was not changed`);
        } else {
          reasons.push(`evidence verified: file '${target}' was changed`);
        }
      } else if (trimmed.startsWith('check_passed:') || trimmed.startsWith('check_ok:')) {
        const checkName = trimmed.replace(/^check_(passed|ok):\s*/, '').trim();
        const found = checks.find((c) => c.name === checkName);
        if (!found || !found.ok) {
          success = false;
          reasons.push(`evidence missing: check '${checkName}' did not pass`);
        } else {
          reasons.push(`evidence verified: check '${checkName}' passed`);
        }
      } else if (trimmed === 'no_errors') {
        if (record.errors.length > 0) {
          success = false;
          reasons.push(`evidence missing: errors were recorded (${record.errors.length})`);
        } else {
          reasons.push('evidence verified: no errors recorded');
        }
      } else if (trimmed === 'exit_code_zero' || trimmed === 'checks_pass') {
        const failedChecks = checks.filter((c) => !c.ok);
        if (failedChecks.length > 0) {
          success = false;
          reasons.push(`evidence missing: checks failed: ${failedChecks.map((c) => c.name).join(', ')}`);
        } else {
          reasons.push('evidence verified: all checks passed');
        }
      }
    }
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
