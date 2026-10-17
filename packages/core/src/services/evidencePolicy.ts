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

export function evidencePassed(item: VerificationEvidence): boolean {
  return item.exitCode === 0 && (item.status === undefined || item.status === 'PASS');
}

export function oracleSatisfied(evidence: VerificationEvidence[], revision: number, type: EvidenceType): boolean {
  const current = latestEvidenceAtRevision(evidence, revision, type);
  return current.length > 0 && current.every(evidencePassed);
}
