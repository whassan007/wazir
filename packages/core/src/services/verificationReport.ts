import type {
  AcceptanceCriterionResult,
  Job,
  JobVerificationReport,
  TaskAttemptRecovery,
  TaskVerificationReport,
  VerificationVerdict,
} from '../types/job.js';

/** Minimal shape of a check run; matches ExecutionRecord['checks'] entries. */
interface CheckLike { name: string; ok: boolean; command?: string; exitCode?: number | null }

export interface TaskVerificationInput {
  /** The agent ended with a completion turn. */
  modelReportedSuccess: boolean;
  /** Result of the deterministic evaluator (evaluateExecution). */
  evaluation: { success: boolean; reasons: string[] };
  checks: CheckLike[];
  /** Tool calls the controller ran this attempt and how many failed. */
  toolCalls?: { total: number; failed: number };
  filesChanged: string[];
  expectedEvidence?: string[];
  mutationRequired?: boolean;
  /** Set when verification itself could not run (cancellation, policy, unreconciled side effects). */
  blockedReason?: string;
  workspaceRevision?: number;
  executionId?: string;
  now?: () => Date;
}

const PASS = /^(evidence verified|all expected files changed)/i;
const FAIL = /(missing|stale|not changed|did not pass|_FAILED|PROTECTED_FIXTURE_MODIFIED|mutation required|errors were recorded)/i;

function criterionFromReason(reason: string, index: number): AcceptanceCriterionResult | undefined {
  if (PASS.test(reason)) return { id: `evaluation:${index}`, description: reason, status: 'passed', evidence: [reason] };
  if (FAIL.test(reason)) return { id: `evaluation:${index}`, description: reason, status: 'failed', evidence: [reason] };
  return undefined;
}

/**
 * Turns the deterministic evaluation of one attempt into a machine-readable report. Each
 * criterion is backed by a check run or an evaluator finding — never by model prose.
 */
export function buildTaskVerificationReport(input: TaskVerificationInput): TaskVerificationReport {
  const criteria: AcceptanceCriterionResult[] = [];
  for (const check of input.checks) {
    criteria.push({
      id: `check:${check.name}`,
      description: `${check.name} check`,
      status: check.ok ? 'passed' : 'failed',
      evidence: [`${check.command ?? check.name} exited ${check.exitCode ?? (check.ok ? 0 : 'non-zero')}`],
    });
  }
  input.evaluation.reasons.forEach((reason, index) => {
    const criterion = criterionFromReason(reason, index);
    if (criterion) criteria.push(criterion);
  });
  // Declared evidence the evaluator said nothing about stays visibly unverified.
  for (const expected of input.expectedEvidence ?? []) {
    const key = expected.replace(/^[a-z_]+:\s*/, '').trim();
    if (key && !criteria.some((c) => c.description.includes(key))) {
      criteria.push({ id: `expected:${expected}`, description: expected, status: 'unverified', evidence: [] });
    }
  }
  if (input.mutationRequired && input.filesChanged.length > 0) {
    criteria.push({ id: 'mutation', description: 'task required a code change', status: 'passed', evidence: input.filesChanged.slice(0, 20) });
  }

  const tests = input.checks.filter((c) => c.name === 'test');
  let verdict: VerificationVerdict;
  if (input.blockedReason) verdict = 'BLOCKED';
  else if (!input.evaluation.success || criteria.some((c) => c.status === 'failed')) verdict = 'FAILED';
  else if (criteria.some((c) => c.status === 'unverified') || !criteria.some((c) => c.status === 'passed')) verdict = 'INCONCLUSIVE';
  else verdict = 'VERIFIED';

  return {
    schemaVersion: 1,
    verdict,
    modelReportedSuccess: input.modelReportedSuccess,
    toolExecutionSuccess: input.toolCalls && input.toolCalls.total > 0 ? input.toolCalls.failed === 0 : undefined,
    testSuccess: tests.length > 0 ? tests.every((t) => t.ok) : undefined,
    evaluationSuccess: input.evaluation.success,
    criteria,
    workspaceRevision: input.workspaceRevision,
    executionId: input.executionId,
    reasons: input.blockedReason ? [input.blockedReason, ...input.evaluation.reasons] : [...input.evaluation.reasons],
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * Summary written onto the job when it settles. The job verdict is VERIFIED only if every
 * task that counts (not superseded by a repair plan) completed with a VERIFIED report.
 */
export function buildJobVerificationReport(job: Job, supersededTaskIds: ReadonlySet<string>, now: () => Date = () => new Date()): JobVerificationReport {
  const tasks = job.graph.nodes.map((node) => {
    const taskId = node.taskId ?? node.id;
    const superseded = supersededTaskIds.has(taskId) || Boolean(node.error?.startsWith('Superseded by repair plan'));
    const recoveries: TaskAttemptRecovery[] = [
      ...(node.attempts ?? []).flatMap((a) => (a.recovery ? [a.recovery] : [])),
      ...(node.lastRecovery ? [node.lastRecovery] : []),
    ];
    const report = node.verification;
    const verdict: JobVerificationReport['tasks'][number]['verdict'] =
      node.state === 'idle' || (node.state !== 'completed' && !node.executedAt && !report && recoveries.length === 0 && node.error === 'Dependency failed')
        ? 'NOT_RUN'
        : report?.verdict ?? (node.state === 'completed' ? 'UNVERIFIED' : 'FAILED');
    return { taskId, state: node.state, superseded, verdict, attempts: (node.attempts?.length ?? 0) + (node.state === 'idle' ? 0 : 1), recoveries, report };
  });
  const counted = tasks.filter((t) => !t.superseded);
  let verdict: JobVerificationReport['verdict'];
  if (counted.some((t) => t.verdict === 'BLOCKED')) verdict = 'BLOCKED';
  else if (counted.some((t) => t.verdict === 'FAILED' || t.state === 'failed' || t.state === 'cancelled')) verdict = 'FAILED';
  else if (counted.some((t) => t.verdict === 'NOT_RUN')) verdict = 'INCONCLUSIVE';
  else if (counted.some((t) => t.verdict === 'INCONCLUSIVE')) verdict = 'INCONCLUSIVE';
  else if (counted.some((t) => t.verdict === 'UNVERIFIED')) verdict = 'UNVERIFIED';
  else verdict = counted.length > 0 ? 'VERIFIED' : 'INCONCLUSIVE';
  return { schemaVersion: 1, jobId: job.id, verdict, tasks, generatedAt: now().toISOString() };
}
