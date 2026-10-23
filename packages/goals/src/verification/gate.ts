import type { AcceptanceGateDecision, ArtifactRef, EvidenceRecord, GoalTarget, VerificationVerdict } from '../contracts.js';
import { GoalStudioFailure } from '../contracts.js';
import { DETERMINISTIC_METHODS, HUMAN_METHODS, SELF_REPORT_METHODS, type GateInput, type GateOptions, type WorkspaceState } from './types.js';

/**
 * Resolves a criterion reference (exact text or `#N`, 1-based) against the
 * target's acceptance list. Returns undefined for references that match nothing.
 */
export function resolveCriterion(target: Pick<GoalTarget, 'acceptance'>, ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const m = /^#(\d+)$/.exec(ref.trim());
  if (m) return target.acceptance[Number(m[1]) - 1];
  return target.acceptance.includes(ref) ? ref : undefined;
}

function byTime(a: EvidenceRecord, b: EvidenceRecord): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Reference state the evidence must be bound to: the caller-supplied snapshot,
 * or else the latest `checksum` batch recorded for this attempt (or latest
 * artifact-bearing batch if no `checksum` record is present).
 */
export function referenceState(evidence: EvidenceRecord[], attemptId: string): WorkspaceState | undefined {
  const checksums = evidence.filter((e) => e.attemptId === attemptId && e.validationMethod === 'checksum').sort(byTime);
  const candidates = checksums.length > 0 ? checksums : evidence.filter((e) => e.attemptId === attemptId && e.artifacts.length > 0).sort(byTime);
  const latest = candidates[candidates.length - 1];
  if (!latest) return undefined;
  const batch = candidates.filter((e) => e.workspaceRevision === latest.workspaceRevision);
  const artifacts = new Map<string, ArtifactRef>();
  for (const e of batch) for (const a of e.artifacts) artifacts.set(a.uri, a);
  return { workspaceRevision: latest.workspaceRevision, artifacts: [...artifacts.values()], problems: [] };
}

export function isSelfReport(e: EvidenceRecord, executors: ReadonlySet<string>): boolean {
  if (SELF_REPORT_METHODS.includes(e.validationMethod.toLowerCase())) return true;
  if (!e.validatorIdentity || !e.validatorIdentity.trim()) return true;
  return e.validatorIdentity === e.executorIdentity || executors.has(e.validatorIdentity);
}

/** Evidence is fresh when bound to the reference revision and every artifact digest it names is current. */
export function isFresh(e: EvidenceRecord, ref: WorkspaceState): boolean {
  if (e.workspaceRevision !== ref.workspaceRevision) return false;
  const current = new Map(ref.artifacts.map((a) => [a.uri, a.digest]));
  return e.artifacts.every((a) => current.get(a.uri) === a.digest);
}

/**
 * Deterministic acceptance gate. Pure: the same input always yields the same
 * decision (`decidedAt` is the newest evidence timestamp considered, not the clock).
 *
 * Rules, in precedence order:
 *  1. Attempt failed/cancelled, or any fresh FAIL evidence (any validator, any
 *     method, including the executor admitting failure)          → repair
 *  2. No fresh evidence for the current revision (never verified, artifacts
 *     changed since, or older graph revision)                      → repair
 *  3. externalDependency without fresh independent PASS
 *     `external-record` / `human-signoff`                          → awaiting_external
 *  4. requiresApproval (or no acceptance criteria at all) without a fresh
 *     `human-signoff` PASS                                         → needs_approval
 *  5. Any criterion UNKNOWN / NOT_RUN (no independent PASS)        → repair
 *     (deterministic verification ran and cannot decide; it needs a declared
 *     check or an operator signoff, or repair, before completion)
 *  6. Otherwise                                                    → completed
 *
 * Self-assessment never counts: evidence whose validator equals any executor
 * identity seen for the attempt, or whose method is a self-report, cannot PASS
 * anything. A model reviewer's PASS counts only with `acceptReviewerPass`.
 */
export function evaluateGate(input: GateInput, options: GateOptions = {}): AcceptanceGateDecision {
  const { run, target, attempt } = input;
  if (attempt.runId !== run.runId || attempt.targetId !== target.id) {
    throw new GoalStudioFailure('VALIDATION', `attempt ${attempt.id} does not belong to run ${run.runId} target ${target.id}`);
  }
  const currentAttemptId = run.targets?.[target.id]?.lastAttemptId;
  const isStaleAttemptOnLedger = currentAttemptId !== undefined && currentAttemptId !== attempt.id;
  const reasons: string[] = [];
  if (isStaleAttemptOnLedger) {
    reasons.push(`STALE_ATTEMPT: attempt ${attempt.id} is superseded by current attempt ${currentAttemptId}`);
  }
  const scoped = input.evidence.filter((e) => e.runId === run.runId && e.targetId === target.id);
  const executors = new Set<string>();
  for (const e of scoped) if (e.attemptId === attempt.id && e.executorIdentity) executors.add(e.executorIdentity);
  if (input.executorIdentity) executors.add(input.executorIdentity);

  const ref = input.current ?? referenceState(scoped, attempt.id);
  const considered = scoped.filter((e) => e.attemptId === attempt.id && e.graphRevision === run.graphRevision);
  const staleGraph = scoped.filter((e) => e.attemptId === attempt.id && e.graphRevision !== run.graphRevision).length;
  if (staleGraph > 0) reasons.push(`IGNORED_GRAPH_REVISION: ${staleGraph} evidence record(s) bound to another graph revision`);
  const fresh = ref ? considered.filter((e) => isFresh(e, ref)) : [];
  const stale = considered.length - fresh.length;
  if (stale > 0) reasons.push(`STALE_EVIDENCE: ${stale} evidence record(s) not bound to current revision ${ref?.workspaceRevision ?? '(none)'}`);
  const otherAttempts = scoped.filter((e) => e.attemptId !== attempt.id).length;
  if (otherAttempts > 0) reasons.push(`IGNORED_OTHER_ATTEMPTS: ${otherAttempts} evidence record(s) from other attempts`);

  const independent = (e: EvidenceRecord) => !isSelfReport(e, executors);
  const selfPasses = fresh.filter((e) => e.verdict === 'PASS' && !independent(e));
  if (selfPasses.length > 0) reasons.push(`SELF_VERIFICATION_REJECTED: ${selfPasses.length} PASS record(s) from the executor itself do not count`);
  const humanSigner = (e: EvidenceRecord) => e.validatorIdentity.startsWith('user:');
  const countsAsPass = (e: EvidenceRecord): boolean => {
    if (e.verdict !== 'PASS' || !independent(e)) return false;
    if (DETERMINISTIC_METHODS.includes(e.validationMethod)) return true;
    if (HUMAN_METHODS.includes(e.validationMethod)) {
      if (e.validationMethod === 'human-signoff') return humanSigner(e) || Boolean(e.validatorIdentity.trim());
      return Boolean(e.validatorIdentity.trim());
    }
    if (e.validationMethod === 'adversarial-review') return options.acceptReviewerPass === true;
    return false;
  };

  // Per-criterion verdicts.
  const perCriterion: AcceptanceGateDecision['perCriterion'] = target.acceptance.map((criterion) => {
    const mine = fresh.filter((e) => resolveCriterion(target, e.criterion) === criterion);
    const fails = mine.filter((e) => e.verdict === 'FAIL');
    if (fails.length) return { criterion, verdict: 'FAIL' as VerificationVerdict, evidenceIds: fails.map((e) => e.id) };
    const passes = mine.filter(countsAsPass);
    if (passes.length) return { criterion, verdict: 'PASS' as VerificationVerdict, evidenceIds: passes.map((e) => e.id) };
    const unknown = mine.filter((e) => e.verdict === 'UNKNOWN' || e.verdict === 'PASS');
    if (unknown.length) return { criterion, verdict: 'UNKNOWN' as VerificationVerdict, evidenceIds: unknown.map((e) => e.id) };
    return { criterion, verdict: 'NOT_RUN' as VerificationVerdict, evidenceIds: mine.map((e) => e.id) };
  });

  const decidedAt = [...considered].sort(byTime).pop()?.createdAt ?? attempt.endedAt ?? attempt.startedAt;
  const decide = (decision: AcceptanceGateDecision['decision']): AcceptanceGateDecision => ({
    runId: run.runId,
    targetId: target.id,
    attemptId: attempt.id,
    decision,
    perCriterion,
    reasons,
    decidedAt,
  });

  // 1. failures
  if (attempt.outcome === 'failed' || attempt.outcome === 'cancelled') reasons.push(`ATTEMPT_${attempt.outcome.toUpperCase()}: executor attempt did not succeed`);
  if (ref && ref.problems.length > 0) for (const p of ref.problems) reasons.push(`ARTIFACT_PROBLEM: ${p.reason}`);
  const failures = fresh.filter((e) => e.verdict === 'FAIL');
  for (const f of failures) reasons.push(`FAIL: ${f.validationMethod}${f.criterion ? ` [${f.criterion}]` : ''}${f.command ? ` \`${f.command}\`` : ''} (${f.id})${f.limitations.length ? ` — ${f.limitations.join('; ')}` : ''}`);
  if (isStaleAttemptOnLedger || attempt.outcome === 'failed' || attempt.outcome === 'cancelled' || failures.length > 0 || (ref && ref.problems.length > 0)) return decide('repair');

  // 2. not verified against current bytes
  if (!ref) {
    reasons.push('NOT_VERIFIED: no checksum evidence for this attempt; run verification');
    return decide('repair');
  }
  if (fresh.length === 0) {
    reasons.push(`NOT_VERIFIED: no evidence bound to current revision ${ref.workspaceRevision}`);
    return decide('repair');
  }
  // Every declared artifact must be in the verified set with a valid sha256:<64hex> digest.
  const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;
  const verifiedByUri = new Map<string, ArtifactRef>();
  for (const a of ref.artifacts) {
    verifiedByUri.set(a.uri.replace(/\/$/, ''), a);
  }
  const missingArtifacts: string[] = [];
  const invalidDigestArtifacts: string[] = [];
  for (const raw of target.artifacts) {
    const norm = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const found = verifiedByUri.get(norm);
    if (!found) {
      missingArtifacts.push(raw);
    } else if (!SHA256_RE.test(found.digest) || found.sizeBytes === 0) {
      invalidDigestArtifacts.push(`${raw} (${found.sizeBytes === 0 ? 'empty' : `invalid digest '${found.digest}'`})`);
    }
  }
  if (missingArtifacts.length > 0) {
    reasons.push(`ARTIFACT_NOT_VERIFIED: ${missingArtifacts.join(', ')}`);
    return decide('repair');
  }
  if (invalidDigestArtifacts.length > 0) {
    reasons.push(`ARTIFACT_INVALID_DIGEST: ${invalidDigestArtifacts.join(', ')}`);
    return decide('repair');
  }

  // 3. external dependency
  if (target.externalDependency) {
    const external = fresh.filter((e) => HUMAN_METHODS.includes(e.validationMethod) && countsAsPass(e));
    if (external.length === 0) {
      reasons.push('AWAITING_EXTERNAL: externalDependency requires a fresh external-record or human-signoff PASS from an attributable principal');
      return decide('awaiting_external');
    }
  }

  // 4. approval
  const signoffs = fresh.filter((e) => e.validationMethod === 'human-signoff' && countsAsPass(e));
  if (target.requiresApproval && signoffs.length === 0) {
    reasons.push('NEEDS_APPROVAL: requiresApproval target has no fresh human-signoff');
    return decide('needs_approval');
  }
  if (target.acceptance.length === 0 && signoffs.length === 0) {
    reasons.push('NEEDS_APPROVAL: target declares no acceptance criteria; completion requires a human-signoff');
    return decide('needs_approval');
  }

  // 5. undecidable criteria
  const open = perCriterion.filter((c) => c.verdict !== 'PASS');
  if (open.length > 0) {
    for (const c of open) reasons.push(`${c.verdict}: "${c.criterion}" has no independent PASS evidence for revision ${ref.workspaceRevision}`);
    return decide('repair');
  }

  reasons.push(`COMPLETED: all ${perCriterion.length} criteria PASS with independent evidence at ${ref.workspaceRevision}`);
  return decide('completed');
}
