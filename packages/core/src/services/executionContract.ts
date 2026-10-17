import { createHash } from 'node:crypto';
import type { Task } from '../types/task.js';
import type { AcceptanceContract } from '../types/execution.js';
import type { VerificationEvidence } from '../types/verification.js';
import { evidencePassed, latestEvidenceAtRevision } from './evidencePolicy.js';

export interface ExecutionContract {
  version: 1;
  taskId: string;
  originalRequest: string;
  objective: string;
  requirements: Task['requirements'];
  constraints: NonNullable<Task['policy']>;
  targetRepository: string | null;
  targetFiles: string[];
  deliverables: string[];
  acceptance: AcceptanceContract;
  dependencies: string[];
  assumptions: string[];
  completionConditions: string[];
  digest: string;
}

/** Controller snapshot: no model is allowed to rewrite the authoritative request. */
export function createExecutionContract(task: Task, workspaceRoot?: string): ExecutionContract {
  const acceptance = structuredClone(task.acceptanceContract ?? { requiredEvidence: [] });
  const ids = new Set<string>();
  for (const criterion of acceptance.criteria ?? []) {
    if (!criterion.id?.trim() || !criterion.condition?.trim() || ids.has(criterion.id)) throw new Error('Invalid or duplicate acceptance criterion');
    if (!criterion.verification || (criterion.verification !== 'human_review' && !['BUILD', 'TEST', 'LINT', 'TYPECHECK', 'STATIC_ANALYSIS', 'STATIC_CHECK', 'ACCEPTANCE', 'BROWSER', 'RUN'].includes(criterion.verification))) throw new Error('Invalid criterion verification method');
    ids.add(criterion.id);
  }
  const data = {
    version: 1 as const, taskId: task.id, originalRequest: task.input, objective: task.title ?? task.input,
    requirements: task.requirements ? structuredClone(task.requirements) : {}, constraints: structuredClone(task.policy ?? {}),
    targetRepository: workspaceRoot ?? task.policy?.projectRoot ?? null,
    targetFiles: [...(task.expectedArtifacts ?? task.requirements?.expectedArtifacts ?? [])],
    deliverables: [...(task.expectedArtifacts ?? task.requirements?.expectedArtifacts ?? [])], acceptance,
    dependencies: [...(task.contextFrom ?? [])],
    assumptions: acceptance.criteria?.length ? [] : ['Semantic acceptance criteria were not supplied; legacy evidence requirements do not prove the full user intent.'],
    completionConditions: ['All mandatory criteria have current controller evidence', 'All dispatched tool outcomes are reconciled'],
  };
  return { ...data, digest: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

/** Human-review criteria stay pending until an authorized review path is implemented. */
export function missingAcceptanceCriteria(contract: AcceptanceContract | undefined, evidence: VerificationEvidence[], revision: number): string[] {
  return (contract?.criteria ?? []).filter(c => {
    if (c.mandatory === false) return false;
    if (c.verification === 'human_review') return true;
    const matches = latestEvidenceAtRevision(evidence, revision, c.verification)
      .filter(e => e.metadata?.criterionId === c.id);
    return matches.length === 0 || !matches.every(evidencePassed);
  }).map(c => c.id);
}
