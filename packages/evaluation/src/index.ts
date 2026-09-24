import fs from 'node:fs';
import path from 'node:path';
import type {
  AcceptanceContract,
  CheckRunRecord,
  EvaluationResult,
  EvidenceType,
  ExecutionRecord,
  VerificationEvidence,
} from '@wazir/core';

export * from './types/verification.js';
export * from './continuousVerification.js';

export interface EvaluationOptions {
  /** If set, the task is only successful when each of these files changed. */
  expectedFiles?: string[];
  /** Expected evidence criteria, e.g. ["file_exists: src/main.cpp", "check_passed: test", "no_errors"] */
  expectedEvidence?: string[];
  /** Project or worktree root for verifying file existence on disk. */
  projectRoot?: string;
  /** Whether code modification is explicitly required for success. */
  mutationRequired?: boolean;
  /** Files that must NOT be modified. */
  protectedFiles?: string[];
  /** Acceptance contract defining required evidence types (BUILD, TEST, RUN, STATIC_CHECK). */
  acceptanceContract?: AcceptanceContract;
}

export interface VerifierParams {
  workspaceRevision: number;
  acceptanceContract: AcceptanceContract;
  evidence: VerificationEvidence[];
}

export interface VerifierResult {
  passed: boolean;
  reasons: string[];
  latestSuccessfulBuildRevision: number | null;
  latestSuccessfulTestRevision: number | null;
}

export const verifier = {
  verify(params: VerifierParams): VerifierResult {
    const reasons: string[] = [];
    let passed = true;

    const buildEvidences = params.evidence.filter((e) => e.type === 'BUILD');
    const successfulBuilds = buildEvidences.filter((e) => e.exitCode === 0);
    let latestSuccessfulBuildRevision: number | null = null;
    if (successfulBuilds.length > 0) {
      latestSuccessfulBuildRevision = Math.max(...successfulBuilds.map((e) => e.revision));
    }

    const testEvidences = params.evidence.filter((e) => e.type === 'TEST');
    const successfulTests = testEvidences.filter((e) => e.exitCode === 0);
    let latestSuccessfulTestRevision: number | null = null;
    if (successfulTests.length > 0) {
      latestSuccessfulTestRevision = Math.max(...successfulTests.map((e) => e.revision));
    }

    for (const required of params.acceptanceContract.requiredEvidence) {
      if (required === 'BUILD') {
        const buildAtCurrent = successfulBuilds.find((b) => b.revision === params.workspaceRevision);
        if (!buildAtCurrent) {
          passed = false;
          if (latestSuccessfulBuildRevision !== null) {
            reasons.push(
              `BUILD_EVIDENCE_STALE: Build evidence is stale (latest successful build was revision ${latestSuccessfulBuildRevision}, current workspace revision is ${params.workspaceRevision})`,
            );
          } else {
            reasons.push(
              `NO_BUILD_EVIDENCE: No successful build exists for current workspace revision ${params.workspaceRevision}`,
            );
          }
        } else {
          reasons.push(`evidence verified: BUILD passed for revision ${params.workspaceRevision}`);
        }
      } else if (required === 'TEST') {
        const testAtCurrent = successfulTests.find((t) => t.revision === params.workspaceRevision);
        if (!testAtCurrent) {
          passed = false;
          if (latestSuccessfulTestRevision !== null) {
            reasons.push(
              `TEST_EVIDENCE_STALE: Test evidence is stale for revision ${params.workspaceRevision}`,
            );
          } else {
            reasons.push(
              `TEST_EVIDENCE_MISSING: Test evidence missing for revision ${params.workspaceRevision}`,
            );
          }
        } else {
          reasons.push(`evidence verified: TEST passed for revision ${params.workspaceRevision}`);
        }
      } else if (required === 'RUN') {
        const runEvidences = params.evidence.filter((e) => e.type === 'RUN' && e.exitCode === 0);
        const runAtCurrent = runEvidences.find((r) => r.revision === params.workspaceRevision);
        if (!runAtCurrent) {
          passed = false;
          reasons.push(
            runEvidences.length > 0
              ? `RUN_EVIDENCE_STALE: Run evidence is stale for revision ${params.workspaceRevision}`
              : `RUN_EVIDENCE_MISSING: Run evidence missing for revision ${params.workspaceRevision}`,
          );
        } else {
          reasons.push(`evidence verified: RUN passed for revision ${params.workspaceRevision}`);
        }
      }
    }

    return { passed, reasons, latestSuccessfulBuildRevision, latestSuccessfulTestRevision };
  },
};

/**
 * Deterministic post-execution evaluation:
 * - expected files changed (when the task declared them)
 * - expected evidence satisfied (file existence, check success, error freedom)
 * - every executed check (test / lint / typecheck / build) passed
 * - no fatal errors were recorded during execution
 * - acceptance contract satisfied by external evidence bound to current revision
 *
 * Model claims in prose or summaries are hypotheses, never evidence.
 */
/**
 * Derives a revision timeline purely from an ExecutionRecord's event log, for
 * records that were not produced by ExecutionEngine (and so carry no
 * `workspaceState`). Each `files.changed` event is a physical mutation and
 * advances the revision; a `check.completed` event is bound to the revision
 * in effect at the moment it occurred, so a check that ran before a later
 * mutation is stale relative to the final revision.
 */
function deriveEventRevisions(events: ExecutionRecord['events']): {
  currentRevision: number;
  checkRevision: Map<string, number>;
} {
  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let revision = 0;
  const checkRevision = new Map<string, number>();
  for (const event of sorted) {
    if (event.type === 'files.changed') {
      revision += 1;
    } else if (event.type === 'check.completed') {
      const name = (event.data as { name?: string } | undefined)?.name;
      if (name) {
        checkRevision.set(name, revision);
      }
    }
  }
  return { currentRevision: revision, checkRevision };
}

/**
 * Errors belonging to the attempt being evaluated. A resumed execution keeps earlier
 * attempts' errors as history; its `execution.resumed` event records how many existed
 * when it resumed, and only errors after the latest resumption decide this attempt.
 */
export function currentAttemptErrors(record: Pick<ExecutionRecord, 'errors'> & Partial<Pick<ExecutionRecord, 'events'>>): string[] {
  const resumed = [...(record.events ?? [])].reverse().find((e) => (e.eventType ?? e.type) === 'execution.resumed');
  const before = (resumed?.data as { errorsBefore?: unknown } | undefined)?.errorsBefore;
  return typeof before === 'number' ? record.errors.slice(before) : record.errors;
}

export function evaluateExecution(
  record: Pick<ExecutionRecord, 'filesChanged' | 'checks' | 'errors'> &
    Partial<Pick<ExecutionRecord, 'events' | 'workspaceState' | 'evidence' | 'acceptanceContract' | 'task' | 'result'>>,
  options: EvaluationOptions = {},
): EvaluationResult {
  const errors = currentAttemptErrors(record);
  const reasons: string[] = [];
  const checks: CheckRunRecord[] = [...record.checks];
  const evidenceList: VerificationEvidence[] = record.evidence ? [...record.evidence] : [];

  // When ExecutionEngine has already tracked workspaceState, trust it. Otherwise, for a
  // standalone record that only carries an event log, derive revision progression from
  // the ordering of files.changed vs. check.completed events.
  const eventDerived =
    !record.workspaceState && record.events && record.events.length > 0
      ? deriveEventRevisions(record.events)
      : null;

  const currentRevision =
    record.workspaceState?.revision ?? eventDerived?.currentRevision ?? (record.filesChanged.length > 0 ? 1 : 0);

  // If evidenceList is empty but checks exist, construct baseline evidence bound to the
  // revision each check actually ran at (event-derived when available, else currentRevision).
  if (evidenceList.length === 0 && checks.length > 0) {
    for (const check of checks) {
      const evidenceType: EvidenceType | undefined =
        check.name === 'build' ? 'BUILD' :
        check.name === 'test' ? 'TEST' :
        check.name === 'lint' || check.name === 'typecheck' ? 'STATIC_CHECK' : undefined;
      if (evidenceType) {
        const boundRevision = eventDerived?.checkRevision.get(check.name) ?? currentRevision;
        evidenceList.push({
          id: `evd-${check.name}-${boundRevision}`,
          type: evidenceType,
          revision: boundRevision,
          command: check.command,
          exitCode: check.ok ? 0 : 1,
          durationMs: check.durationMs,
          output: check.output,
        });
      }
    }
  }

  const buildEvidences = evidenceList.filter((e) => e.type === 'BUILD');
  const successfulBuilds = buildEvidences.filter((e) => e.exitCode === 0);
  let latestSuccessfulBuildRevision: number | null = null;
  if (successfulBuilds.length > 0) {
    latestSuccessfulBuildRevision = Math.max(...successfulBuilds.map((e) => e.revision));
  }

  let success = true;

  // 1. Acceptance contract evaluation
  const contract = options.acceptanceContract
    ?? record.acceptanceContract
    ?? record.task?.acceptanceContract;

  if (contract && contract.requiredEvidence && contract.requiredEvidence.length > 0) {
    const contractResult = verifier.verify({
      workspaceRevision: currentRevision,
      acceptanceContract: contract,
      evidence: evidenceList,
    });
    if (!contractResult.passed) {
      success = false;
    }
    reasons.push(...contractResult.reasons);
  }

if (options.mutationRequired === true && record.filesChanged.length === 0) {
    success = false;
    reasons.push('mutation required: task requires code modification but no files changed');
  }

  if (options.protectedFiles && options.protectedFiles.length > 0) {
    const changed = record.filesChanged.map((f) => f.replace(/\\/g, '/'));
    const violated = options.protectedFiles.filter(protectedFile => {
      const normalized = protectedFile.replace(/\\/g, '/');
      return changed.some((c) => c === normalized || c.endsWith(`/${normalized}`));
    });
    if (violated.length > 0) {
      success = false;
      reasons.push(`PROTECTED_FIXTURE_MODIFIED: agent modified protected files: ${violated.join(', ')}`);
    }
  }

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
        if (errors.length > 0) {
          success = false;
          reasons.push(`evidence missing: errors were recorded (${errors.length})`);
        } else {
          reasons.push('evidence verified: no errors recorded');
        }
      } else if (trimmed === 'exit_code_zero' || trimmed === 'checks_pass') {
        if (checks.length === 0) {
          success = false;
          reasons.push('evidence missing: no checks were executed to verify against');
        } else {
          // If workspaceState exists (revision > 0) or a revision was derived from the event
          // log, check whether evidence at the current revision exists.
          if ((record.workspaceState && record.workspaceState.revision > 0) || eventDerived) {
            const currentChecks = evidenceList.filter((e) => e.revision === currentRevision);
            if (currentChecks.length === 0) {
              success = false;
              reasons.push('evidence missing: BUILD_EVIDENCE_STALE: checks were not run on current revision');
            } else {
              const failedCurrent = currentChecks.filter((e) => e.exitCode !== 0);
              if (failedCurrent.length > 0) {
                success = false;
                reasons.push(`evidence missing: checks failed: ${failedCurrent.map((c) => c.type).join(', ')}`);
              } else {
                reasons.push('evidence verified: all checks passed');
              }
            }
          } else {
            const failedChecks = checks.filter((c) => !c.ok);
            if (failedChecks.length > 0) {
              success = false;
              reasons.push(`evidence missing: checks failed: ${failedChecks.map((c) => c.name).join(', ')}`);
            } else {
              reasons.push('evidence verified: all checks passed');
            }
          }
        }
      } else if (trimmed === 'mutation_required' || trimmed === 'requires_mutation') {
        if (record.filesChanged.length === 0) {
          success = false;
          reasons.push('evidence missing: mutation required but no files were changed');
        } else {
          reasons.push(`evidence verified: files were changed (${record.filesChanged.length})`);
        }
      } else if (trimmed === 'source_contains_cpp') {
        // Only look at files the agent actually touched — guessing a hardcoded
        // filename like 'main.cpp' here means this check can fail even when the
        // agent correctly wrote e.g. quick_sort.cpp, since expectedArtifacts is
        // the sole mechanism responsible for pinning a required filename.
        const cppFile = changed.find((f) => f.endsWith('.cpp') || f.endsWith('.cc') || f.endsWith('.cxx'));
        if (!cppFile) {
          success = false;
          reasons.push('evidence missing: no C++ source file found');
        } else {
          reasons.push(`evidence verified: C++ source file '${cppFile}' exists`);
        }
      } else if (trimmed === 'compilation_succeeds') {
        const buildAtCurrent = successfulBuilds.find((b) => b.revision === currentRevision);
        if (buildAtCurrent) {
          reasons.push('evidence verified: compilation succeeded');
        } else {
          success = false;
          if (latestSuccessfulBuildRevision !== null) {
            reasons.push(
              `evidence missing: BUILD_EVIDENCE_STALE: build evidence is stale (latest successful build was revision ${latestSuccessfulBuildRevision}, current workspace revision is ${currentRevision})`,
            );
          } else {
            const failedBuild = buildEvidences.find((b) => b.revision === currentRevision && b.exitCode !== 0);
            if (failedBuild) {
              reasons.push('evidence missing: compilation did not succeed');
            } else {
              reasons.push(
                `evidence missing: NO_BUILD_EVIDENCE: no successful build exists for current workspace revision ${currentRevision}`,
              );
            }
          }
        }
      }
    }
  }

  // Check failure detection: a check that failed on an earlier revision
  // and was subsequently superseded by a passing check on a later revision
  // does not fail the execution. Only un-repaired failures fail the execution.
  if (record.workspaceState && record.workspaceState.revision > 0) {
    const failedCurrent = evidenceList.filter((e) => e.revision === currentRevision && e.exitCode !== 0);
    if (failedCurrent.length > 0) {
      success = false;
      reasons.push(`failed checks: ${failedCurrent.map((c) => `${c.type} (${c.command ?? ''})`).join(', ')}`);
    } else if (checks.length > 0) {
      reasons.push(`checks passed for current revision (${checks.map((c) => c.name).join(', ')})`);
    }
  } else {
    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      success = false;
      reasons.push(`failed checks: ${failed.map((c) => `${c.name} (${c.command})`).join(', ')}`);
    } else if (checks.length > 0) {
      reasons.push(`all ${checks.length} checks passed (${checks.map((c) => c.name).join(', ')})`);
    } else {
      reasons.push('no checks were executed');
    }
  }

  if (errors.length > 0) {
    success = false;
    reasons.push(`${errors.length} error(s) recorded during execution`);
  }

  return {
    success,
    reasons,
    filesChanged: record.filesChanged,
    checks,
    evaluatedAt: new Date(),
    workspaceRevision: currentRevision,
    latestSuccessfulBuildRevision,
    evidence: evidenceList,
  };
}
