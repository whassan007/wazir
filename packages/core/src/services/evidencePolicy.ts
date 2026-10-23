import type { EvidenceType, VerificationEvidence } from '../types/verification.js';

/** Receipt order is authoritative; retries supersede only the same check identity. */
export function latestEvidenceAtRevision(evidence: VerificationEvidence[], revision: number, type?: EvidenceType): VerificationEvidence[] {
  const latest = new Map<string, VerificationEvidence>();
  for (const item of evidence) {
    const oracle = item.oracle ?? item.type;
    if ((item.workspaceRevision ?? item.revision) !== revision || (type && oracle !== type)) continue;
    const key = JSON.stringify([oracle, item.command ?? '', item.metadata?.criterionId ?? '', item.metadata?.target ?? '']);
    latest.set(key, item);
  }
  return [...latest.values()];
}

/**
 * True when the evidence is the executor vouching for itself: an explicit
 * self-report, or a validator identity equal to the executor identity.
 * Such records are kept for history but never satisfy a check.
 */
export function isSelfReportedEvidence(item: VerificationEvidence): boolean {
  const meta = item.metadata ?? {};
  if (meta.selfReported === true) return true;
  const method = typeof meta.validationMethod === 'string' ? meta.validationMethod.toLowerCase() : '';
  if (method === 'self-report' || method === 'self_report' || method === 'model-claim') return true;
  const validator = typeof meta.validatorIdentity === 'string' ? meta.validatorIdentity : undefined;
  const executor = typeof meta.executorIdentity === 'string' ? meta.executorIdentity : undefined;
  return validator !== undefined && executor !== undefined && validator === executor;
}

export function evidencePassed(item: VerificationEvidence): boolean {
  return item.exitCode === 0 && (item.status === undefined || item.status === 'PASS') && !isSelfReportedEvidence(item);
}

export function oracleSatisfied(evidence: VerificationEvidence[], revision: number, type: EvidenceType): boolean {
  const current = latestEvidenceAtRevision(evidence, revision, type);
  return current.length > 0 && current.every(evidencePassed);
}
