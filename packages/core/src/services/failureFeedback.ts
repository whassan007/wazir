import type { KeyValueStore } from '@wazir/shared';
import type { Job, JobNode, TaskAttemptRecovery } from '../types/job.js';

/**
 * Durable feedback for controlled self-improvement. One record per task that failed at
 * least once, written when its job settles. Records are evidence for a human- or
 * supervisor-run improvement loop; nothing in this module changes code, prompts,
 * routing or policy, so it cannot bypass the gates that protect those.
 */
export interface FailureFeedbackRecord {
  id: string;
  jobId: string;
  taskId: string;
  signature: string;
  category: string;
  failureClass?: string;
  terminationReason?: string;
  modelId?: string;
  runtimeId?: string;
  computerId?: string;
  taskType?: string;
  /** Strategies applied in order (retry, retry_with_backoff, stop). */
  recoveryStrategies: string[];
  attempts: number;
  /** Did the task end up completed after recovering? */
  recovered: boolean;
  verificationVerdict?: string;
  /** False when the final attempt's tests failed; undefined when no test ran. */
  regressionFree?: boolean;
  usage?: { input: number; output: number; total: number };
  recordedAt: string;
}

/** Candidate improvement proposed from recurring failures. Inert data. */
export interface ImprovementCandidate {
  signature: string;
  category: string;
  occurrences: number;
  recoveryRate: number;
  /** Prompts, routing and retry policy are preferred over core changes. */
  target: 'prompt' | 'routing' | 'retry_policy' | 'core';
  hypothesis: string;
  /** Metric a candidate must improve against the recorded baseline to be accepted. */
  successMetric: { name: 'signature_recurrence_rate'; baseline: number; mustBeBelow: number };
  requiredGates: ReadonlyArray<CandidateGate>;
}

export type CandidateGate =
  | 'isolated_worktree'
  | 'regression_test'
  | 'security_policy_check'
  | 'baseline_comparison'
  | 'protected_merge_authorization';

export const REQUIRED_CANDIDATE_GATES: ReadonlyArray<CandidateGate> = Object.freeze([
  'isolated_worktree', 'regression_test', 'security_policy_check', 'baseline_comparison', 'protected_merge_authorization',
]);

export interface CandidateEvidence {
  /** Every gate that actually passed, as recorded by whoever ran it. */
  gatesPassed: CandidateGate[];
  baseline: { runs: number; recurrences: number; verifiedRate: number };
  candidate: { runs: number; recurrences: number; verifiedRate: number };
}

export type CandidateVerdict =
  | { accepted: true; reason: string }
  | { accepted: false; reason: 'missing_gate' | 'insufficient_evidence' | 'degraded_reliability' | 'no_improvement'; detail: string };

/**
 * Accept/reject rule for an improvement candidate. Pure and conservative: every gate must
 * be evidenced, both arms need runs, verified completion must not drop, and the target
 * failure must recur less. Authorization for a protected merge is a gate like any other —
 * this function has no override.
 */
export function judgeImprovementCandidate(candidate: ImprovementCandidate, evidence: CandidateEvidence, minRuns = 5): CandidateVerdict {
  const missing = candidate.requiredGates.filter((gate) => !evidence.gatesPassed.includes(gate));
  if (missing.length > 0) return { accepted: false, reason: 'missing_gate', detail: missing.join(', ') };
  if (evidence.baseline.runs < minRuns || evidence.candidate.runs < minRuns) {
    return { accepted: false, reason: 'insufficient_evidence', detail: `need >= ${minRuns} runs per arm` };
  }
  if (evidence.candidate.verifiedRate < evidence.baseline.verifiedRate) {
    return { accepted: false, reason: 'degraded_reliability',
      detail: `verified rate ${evidence.candidate.verifiedRate.toFixed(3)} < baseline ${evidence.baseline.verifiedRate.toFixed(3)}` };
  }
  const rate = evidence.candidate.recurrences / evidence.candidate.runs;
  if (rate >= candidate.successMetric.mustBeBelow) {
    return { accepted: false, reason: 'no_improvement', detail: `recurrence ${rate.toFixed(3)} >= ${candidate.successMetric.mustBeBelow.toFixed(3)}` };
  }
  return { accepted: true, reason: `recurrence ${rate.toFixed(3)} < ${candidate.successMetric.mustBeBelow.toFixed(3)} with no reliability loss` };
}

const PREFIX = 'feedback/failure/';

export class FailureFeedbackLog {
  constructor(private readonly store: KeyValueStore, private readonly options: { maxRecords?: number; now?: () => Date } = {}) {}

  async record(entry: Omit<FailureFeedbackRecord, 'id' | 'recordedAt'>): Promise<FailureFeedbackRecord> {
    const now = this.options.now?.() ?? new Date();
    // Sortable key: retention prunes the oldest. jobId+taskId makes a re-record idempotent.
    const id = `${now.getTime().toString().padStart(15, '0')}-${entry.jobId}-${entry.taskId}`;
    const existing = (await this.store.list(PREFIX)).find((e) => (e.value as FailureFeedbackRecord).jobId === entry.jobId
      && (e.value as FailureFeedbackRecord).taskId === entry.taskId);
    if (existing) return existing.value as FailureFeedbackRecord;
    const full: FailureFeedbackRecord = { ...entry, id, recordedAt: now.toISOString() };
    await this.store.put(`${PREFIX}${id}`, full);
    await this.prune();
    return full;
  }

  async list(): Promise<FailureFeedbackRecord[]> {
    return (await this.store.list(PREFIX)).map((e) => e.value as FailureFeedbackRecord)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Records grouped by signature, most frequent first. */
  async recurring(minOccurrences = 3): Promise<Array<{ signature: string; category: string; records: FailureFeedbackRecord[] }>> {
    const groups = new Map<string, FailureFeedbackRecord[]>();
    for (const r of await this.list()) groups.set(r.signature, [...(groups.get(r.signature) ?? []), r]);
    return [...groups.entries()]
      .filter(([, records]) => records.length >= minOccurrences)
      .map(([signature, records]) => ({ signature, category: records[0].category, records }))
      .sort((a, b) => b.records.length - a.records.length);
  }

  /** Shape consumed by a self-improvement supervisor's `observe()`. */
  async incidents(minOccurrences = 3): Promise<Array<{ source: string; kind: string; summary: string }>> {
    return (await this.recurring(minOccurrences)).map((group) => ({
      source: 'orchestrator.recovery',
      kind: group.category,
      summary: `${group.records.length}x ${group.signature}`,
    }));
  }

  async proposeCandidates(minOccurrences = 3): Promise<ImprovementCandidate[]> {
    const all = await this.list();
    return (await this.recurring(minOccurrences)).map((group) => {
      const recoveryRate = group.records.filter((r) => r.recovered).length / group.records.length;
      const baseline = group.records.length / Math.max(1, all.length);
      return {
        signature: group.signature,
        category: group.category,
        occurrences: group.records.length,
        recoveryRate,
        target: targetFor(group.category),
        hypothesis: `Changing ${targetFor(group.category).replace('_', ' ')} lowers the share of failures with signature "${group.signature}" below ${(baseline / 2).toFixed(3)} without lowering the verified-completion rate.`,
        successMetric: { name: 'signature_recurrence_rate', baseline, mustBeBelow: baseline / 2 },
        requiredGates: REQUIRED_CANDIDATE_GATES,
      };
    });
  }

  private async prune(): Promise<void> {
    const max = this.options.maxRecords ?? 500;
    const entries = (await this.store.list(PREFIX)).sort((a, b) => a.key.localeCompare(b.key));
    for (const entry of entries.slice(0, Math.max(0, entries.length - max))) await this.store.delete(entry.key);
  }
}

function targetFor(category: string): ImprovementCandidate['target'] {
  if (category === 'model_protocol') return 'prompt';
  if (category === 'transient_infrastructure' || category === 'resource_budget') return 'routing';
  if (category === 'code_or_test' || category === 'unclassified') return 'retry_policy';
  return 'core';
}

/** Feedback rows for every task in a settled job that failed at least one attempt. */
export function feedbackFromJob(job: Job, placements: ReadonlyMap<string, { modelId?: string; runtimeId?: string; computerId?: string }>,
  usage: ReadonlyMap<string, { input: number; output: number; total: number }> = new Map()): Array<Omit<FailureFeedbackRecord, 'id' | 'recordedAt'>> {
  return job.graph.nodes.flatMap((node: JobNode) => {
    const recoveries: TaskAttemptRecovery[] = [
      ...(node.attempts ?? []).flatMap((a) => (a.recovery ? [a.recovery] : [])),
      ...(node.lastRecovery ? [node.lastRecovery] : []),
    ];
    if (recoveries.length === 0) return [];
    const taskId = node.taskId ?? node.id;
    const last = recoveries[recoveries.length - 1];
    const task = job.tasks.find((t) => t.id === taskId);
    return [{
      jobId: job.id,
      taskId,
      signature: last.signature,
      category: last.category,
      failureClass: last.failureClass,
      terminationReason: last.terminationReason,
      ...placements.get(taskId),
      taskType: task?.type,
      recoveryStrategies: recoveries.map((r) => r.strategy),
      attempts: (node.attempts?.length ?? 0) + 1,
      recovered: node.state === 'completed',
      verificationVerdict: node.verification?.verdict,
      regressionFree: node.verification?.testSuccess,
      usage: usage.get(taskId),
    }];
  });
}
