import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import { setup } from './helpers/orchestratorFixture.js';
import {
  FailureFeedbackLog,
  JobOrchestrator,
  TaskRecoveryPolicy,
  buildJobVerificationReport,
  buildTaskVerificationReport,
  classifyTaskError,
  classifyTaskOutcome,
  enforceVerification,
  judgeImprovementCandidate,
  type JobTaskOutcome,
  type TaskVerificationReport,
} from '../src/index.js';
import { ExecutionFailure } from '@wazir/shared';

const report = (verdict: TaskVerificationReport['verdict'], reasons: string[] = []): TaskVerificationReport => ({
  schemaVersion: 1, verdict, modelReportedSuccess: true, evaluationSuccess: verdict === 'VERIFIED', criteria: [],
  reasons, generatedAt: new Date(0).toISOString(),
});

describe('TaskRecoveryPolicy classification', () => {
  const cases: Array<[string, JobTaskOutcome, string]> = [
    ['budget termination', { success: false, error: 'stopped', terminationReason: 'MAX_TOKENS' }, 'resource_budget'],
    ['quota in text', { success: false, error: 'QUOTA_EXHAUSTED: monthly limit' }, 'resource_budget'],
    ['policy kind', { success: false, error: 'nope', errorKind: 'policy' }, 'tool_or_policy'],
    ['legacy policy text', { success: false, error: 'denied by policy' }, 'tool_or_policy'],
    ['protocol', { success: false, error: 'bad json', errorKind: 'protocol' }, 'model_protocol'],
    ['verification', { success: false, error: 'tests failed', errorKind: 'verification' }, 'code_or_test'],
    ['infrastructure', { success: false, error: 'ECONNRESET', errorKind: 'infrastructure' }, 'transient_infrastructure'],
    ['unknown outcome is never re-run', { success: false, error: 'TOOL_OUTCOME_UNKNOWN: git commit' }, 'nonrecoverable'],
    ['budget beats coarse kind', { success: false, error: 'x', errorKind: 'protocol', terminationReason: 'MAX_WALL_CLOCK' }, 'resource_budget'],
    ['unclassified', { success: false, error: 'something odd happened' }, 'unclassified'],
  ];
  for (const [name, outcome, category] of cases) {
    it(`${name} -> ${category}`, () => expect(classifyTaskOutcome(outcome).category).toBe(category));
  }

  it('classifies thrown errors from structured fields first', () => {
    expect(classifyTaskError(new ExecutionFailure('TOOL_OUTCOME_UNKNOWN', 'x')).category).toBe('nonrecoverable');
    expect(classifyTaskError(Object.assign(new Error('socket'), { code: 'ECONNRESET' })).category).toBe('transient_infrastructure');
    expect(classifyTaskError(new Error('boom')).category).toBe('unclassified');
    expect(classifyTaskError(new Error('Policy denied write')).category).toBe('tool_or_policy');
  });

  it('signatures ignore ids, numbers and paths so repeats of one defect match', () => {
    const a = classifyTaskOutcome({ success: false, errorKind: 'verification', error: 'test failed at /tmp/a/b.ts:12 run 3f2a9c1e-1111-2222-3333-444455556666' });
    const b = classifyTaskOutcome({ success: false, errorKind: 'verification', error: 'test failed at /var/x.ts:99 run 00000000-aaaa-bbbb-cccc-ddddeeeeffff' });
    expect(a.signature).toBe(b.signature);
  });
});

describe('TaskRecoveryPolicy decisions', () => {
  const policy = new TaskRecoveryPolicy({ backoffBaseMs: 100, backoffMaxMs: 1000, random: () => 1 });
  const transient = classifyTaskOutcome({ success: false, errorKind: 'infrastructure', error: 'reset' });

  it('backs off exponentially and caps the delay', () => {
    expect([0, 1, 2, 3, 10].map((n) => policy.decide(transient, n, 20).delayMs)).toEqual([100, 200, 400, 800, 1000]);
  });

  it('never retries stop categories, even with retries left', () => {
    for (const outcome of [
      { success: false, terminationReason: 'MAX_TOKENS' as const },
      { success: false, errorKind: 'policy' as const },
      { success: false, errorKind: 'cancelled' as const },
      { success: false, error: 'AUTH_FAILED' },
    ]) {
      expect(policy.decide(classifyTaskOutcome(outcome), 0, 10)).toMatchObject({ retry: false, reason: 'not_retryable' });
    }
  });

  it('stops on no progress: the same signature failing repeatedly', () => {
    const c = classifyTaskOutcome({ success: false, errorKind: 'verification', error: 'same assertion' });
    expect(policy.decide(c, 1, 10, [c.signature]).retry).toBe(true);
    expect(policy.decide(c, 2, 10, [c.signature, c.signature])).toMatchObject({ retry: false, reason: 'no_progress' });
    // A different failure in between is progress.
    expect(policy.decide(c, 2, 10, [c.signature, 'code_or_test:other']).retry).toBe(true);
  });

  it('is bounded by maxRetries for every category', () => {
    expect(policy.decide(transient, 3, 3)).toMatchObject({ retry: false, reason: 'retry_budget_exhausted' });
  });
});

describe('Verification gate', () => {
  it('a FAILED or BLOCKED report overrides a success claim', () => {
    expect(enforceVerification({ success: true, verification: report('FAILED', ['evidence missing: x']) }, false))
      .toMatchObject({ success: false, errorKind: 'verification' });
    expect(enforceVerification({ success: true, verification: report('BLOCKED') }, false)).toMatchObject({ success: false, errorKind: 'policy' });
  });

  it('INCONCLUSIVE passes by default and fails when verified completion is required', () => {
    expect(enforceVerification({ success: true, verification: report('INCONCLUSIVE') }, false).success).toBe(true);
    expect(enforceVerification({ success: true, verification: report('INCONCLUSIVE') }, true).success).toBe(false);
  });

  it('buildTaskVerificationReport separates model, tool, test and verified success', () => {
    const r = buildTaskVerificationReport({
      modelReportedSuccess: true,
      evaluation: { success: false, reasons: ['evidence missing: check \'test\' did not pass'] },
      checks: [{ name: 'test', ok: false, command: 'npm test', exitCode: 1 }],
      toolCalls: { total: 3, failed: 0 },
      filesChanged: ['src/a.ts'],
    });
    expect(r).toMatchObject({ verdict: 'FAILED', modelReportedSuccess: true, toolExecutionSuccess: true, testSuccess: false, evaluationSuccess: false });
    expect(r.criteria.some((c) => c.id === 'check:test' && c.status === 'failed')).toBe(true);
  });

  it('nothing checkable is INCONCLUSIVE, not VERIFIED', () => {
    const r = buildTaskVerificationReport({ modelReportedSuccess: true, evaluation: { success: true, reasons: ['no files changed'] }, checks: [], filesChanged: [] });
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('passing evidence is VERIFIED', () => {
    const r = buildTaskVerificationReport({
      modelReportedSuccess: true, evaluation: { success: true, reasons: ['evidence verified: check \'test\' passed'] },
      checks: [{ name: 'test', ok: true, exitCode: 0 }], filesChanged: ['a.ts'], expectedEvidence: ['check_passed: test'],
    });
    expect(r.verdict).toBe('VERIFIED');
  });
});

describe('JobOrchestrator bounded recovery (fault injection)', () => {
  it('does not retry a budget stop: one attempt, failed job, decision recorded', async () => {
    let calls = 0;
    const { orchestrator } = setup(async () => { calls++; return { success: false, error: 'budget', terminationReason: 'MAX_TOKENS' }; });
    const job = await orchestrator.createJob({ title: 'budget', maxRetries: 5, tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id);
    expect(calls).toBe(1);
    expect(done.status).toBe('failed');
    expect(done.graph.nodes[0].lastRecovery).toMatchObject({ category: 'resource_budget', reason: 'not_retryable', strategy: 'stop' });
    expect(done.verification?.verdict).toBe('FAILED');
  });

  it('retries transient failures with backoff, then completes; attempts carry the decisions', async () => {
    let calls = 0;
    const events: string[] = [];
    const { orchestrator } = setup(async () => (++calls < 3
      ? { success: false, error: 'ECONNRESET', errorKind: 'infrastructure' }
      : { success: true, result: 'ok', verification: report('VERIFIED') }), { backoffBaseMs: 5 });
    const job = await orchestrator.createJob({ title: 'transient', tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id, { onEvent: (e) => events.push(e.type) });
    expect(calls).toBe(3);
    expect(done.status).toBe('completed');
    const attempts = done.graph.nodes[0].attempts!;
    expect(attempts.map((a) => a.recovery?.strategy)).toEqual(['retry_with_backoff', 'retry_with_backoff']);
    expect(attempts.every((a) => (a.recovery?.delayMs ?? 0) > 0)).toBe(true);
    expect(events.filter((e) => e === 'task:recovery')).toHaveLength(2);
    expect(done.verification?.verdict).toBe('VERIFIED');
  });

  it('stops a no-progress repair loop before exhausting maxRetries', async () => {
    let calls = 0;
    const { orchestrator } = setup(async () => { calls++; return { success: false, error: 'expected 2 got 3', errorKind: 'verification' }; });
    const job = await orchestrator.createJob({ title: 'loop', maxRetries: 10, tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id);
    expect(calls).toBe(3);
    expect(done.status).toBe('failed');
    expect(done.graph.nodes[0].lastRecovery?.reason).toBe('no_progress');
  });

  it('a success claim with failed verification never completes the job', async () => {
    const { orchestrator } = setup(async () => ({ success: true, result: 'I am done!', verification: report('FAILED', ['evidence missing: file x']) }));
    const job = await orchestrator.createJob({ title: 'liar', maxRetries: 1, tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id);
    expect(done.status).toBe('failed');
    expect(done.tasks[0].status).toBe('failed');
    expect(done.verification?.tasks[0]).toMatchObject({ verdict: 'FAILED' });
  });

  it('requireVerifiedCompletion turns INCONCLUSIVE into a failure', async () => {
    const { orchestrator } = setup(async () => ({ success: true, verification: report('INCONCLUSIVE') }));
    const a = await orchestrator.createJob({ title: 'lenient', tasks: [{ task: { id: 'a', input: 'x' } }] });
    expect((await orchestrator.runJob(a.id)).status).toBe('completed');
    expect(orchestrator.getJob(a.id)!.verification?.verdict).toBe('INCONCLUSIVE');
    const b = await orchestrator.createJob({ title: 'strict', maxRetries: 0, tasks: [{ task: { id: 'b', input: 'x' } }] });
    expect((await orchestrator.runJob(b.id, { requireVerifiedCompletion: true })).status).toBe('failed');
  });

  it('legacy executors without a report keep working and are reported UNVERIFIED', async () => {
    const { orchestrator } = setup(async () => ({ success: true }));
    const job = await orchestrator.createJob({ title: 'legacy', tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id);
    expect(done.status).toBe('completed');
    expect(done.verification?.verdict).toBe('UNVERIFIED');
  });

  it('replanning is bounded: a repair task that keeps failing cannot replan forever', async () => {
    let replans = 0;
    const { orchestrator } = setup(async (task) => ({ success: false, error: `broken ${task.id}`, errorKind: 'verification' }));
    const job = await orchestrator.createJob({ title: 'replan', maxRetries: 0, tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id, {
      replanner: async () => { replans++; return { repairTasks: [{ task: { input: 'repair' } }] }; },
    });
    expect(replans).toBe(2);
    expect(done.status).toBe('failed');
    expect(Math.max(...done.graph.nodes.map((n) => n.replanGeneration ?? 0))).toBe(2);
  });

  it('never replans a policy or budget stop', async () => {
    let replans = 0;
    const { orchestrator } = setup(async () => ({ success: false, error: 'x', terminationReason: 'MAX_WALL_CLOCK' }));
    const job = await orchestrator.createJob({ title: 'no-replan', tasks: [{ task: { id: 't1', input: 'x' } }] });
    await orchestrator.runJob(job.id, { replanner: async () => { replans++; return { repairTasks: [{ task: { input: 'r' } }] }; } });
    expect(replans).toBe(0);
  });

  it('cancellation during backoff stops the task without another attempt', async () => {
    let calls = 0;
    let orchestratorRef: JobOrchestrator | undefined;
    let jobId = '';
    const { orchestrator } = setup(async () => {
      calls++;
      setTimeout(() => void orchestratorRef!.cancelJob(jobId), 20);
      return { success: false, error: 'ECONNREFUSED', errorKind: 'infrastructure' };
    }, { backoffBaseMs: 10_000 });
    orchestratorRef = orchestrator;
    const job = await orchestrator.createJob({ title: 'cancel', tasks: [{ task: { id: 't1', input: 'x' } }] });
    jobId = job.id;
    const started = Date.now();
    const done = await orchestrator.runJob(job.id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
    expect(done.status).toBe('cancelled');
  });

  it('the retry decision is durable before backoff ends (crash mid-backoff keeps diagnostics)', async () => {
    const store = new MemoryStore();
    let jobId = '';
    let snapshot: any;
    let calls = 0;
    const { orchestrator } = setup(async () => {
      if (++calls === 1) {
        // Inspect the store while the orchestrator is waiting out the backoff.
        setTimeout(async () => { snapshot = await store.get(`job/${jobId}`); }, 30);
        return { success: false, error: 'ETIMEDOUT', errorKind: 'infrastructure' };
      }
      return { success: true };
    }, { store, backoffBaseMs: 200 });
    const job = await orchestrator.createJob({ title: 'durable', tasks: [{ task: { id: 't1', input: 'x' } }] });
    jobId = job.id;
    await orchestrator.runJob(job.id);
    expect(snapshot.graph.nodes[0].attempts[0].recovery).toMatchObject({ category: 'transient_infrastructure', strategy: 'retry_with_backoff' });
    expect(snapshot.graph.nodes[0].retryCount).toBe(1);
  });

  it('records one feedback row per failed task, idempotently, with placement and outcome', async () => {
    const store = new MemoryStore();
    const feedback = new FailureFeedbackLog(store);
    let calls = 0;
    const { orchestrator } = setup(async () => (++calls === 1
      ? { success: false, error: 'bad action', errorKind: 'protocol', usage: { input: 10, output: 5, total: 15 } }
      : { success: true, verification: report('VERIFIED') }), { feedback });
    const job = await orchestrator.createJob({ title: 'fb', tasks: [{ task: { id: 't1', input: 'x' } }] });
    await orchestrator.runJob(job.id);
    const rows = await feedback.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: job.id, taskId: 't1', category: 'model_protocol', recovered: true, attempts: 2,
      verificationVerdict: 'VERIFIED', modelId: 'fake-model', recoveryStrategies: ['retry'], usage: { total: 15 } });
    await feedback.record({ ...rows[0] });
    expect(await feedback.list()).toHaveLength(1);
  });
});

describe('Controlled self-improvement gates', () => {
  async function candidate() {
    const feedback = new FailureFeedbackLog(new MemoryStore());
    for (let i = 0; i < 3; i++) {
      await feedback.record({ jobId: `j${i}`, taskId: 't', signature: 'model_protocol:bad json', category: 'model_protocol',
        recoveryStrategies: ['retry'], attempts: 2, recovered: false });
    }
    const [c] = await feedback.proposeCandidates(3);
    return c;
  }

  it('proposes a prompt-level candidate with a measurable hypothesis and all gates required', async () => {
    const c = await candidate();
    expect(c).toMatchObject({ target: 'prompt', occurrences: 3, successMetric: { name: 'signature_recurrence_rate' } });
    expect(c.requiredGates).toContain('protected_merge_authorization');
  });

  it('rejects a candidate missing any gate, with too few runs, or that degrades reliability', async () => {
    const c = await candidate();
    const all = [...c.requiredGates];
    const good = { baseline: { runs: 10, recurrences: 10, verifiedRate: 0.5 }, candidate: { runs: 10, recurrences: 1, verifiedRate: 0.6 } };
    expect(judgeImprovementCandidate(c, { gatesPassed: all.filter((g) => g !== 'protected_merge_authorization'), ...good }))
      .toMatchObject({ accepted: false, reason: 'missing_gate' });
    expect(judgeImprovementCandidate(c, { gatesPassed: all, baseline: good.baseline, candidate: { ...good.candidate, runs: 2 } }))
      .toMatchObject({ accepted: false, reason: 'insufficient_evidence' });
    expect(judgeImprovementCandidate(c, { gatesPassed: all, baseline: good.baseline, candidate: { ...good.candidate, verifiedRate: 0.4 } }))
      .toMatchObject({ accepted: false, reason: 'degraded_reliability' });
    expect(judgeImprovementCandidate(c, { gatesPassed: all, ...good })).toMatchObject({ accepted: true });
  });
});

describe('Job verification report', () => {
  it('superseded tasks do not count against the job verdict', async () => {
    const { orchestrator } = setup(async (task) => (task.input === 'repair'
      ? { success: true, verification: report('VERIFIED') }
      : { success: false, error: 'broken', errorKind: 'verification' }));
    const job = await orchestrator.createJob({ title: 'sup', tasks: [{ task: { id: 't1', input: 'x' } }] });
    const done = await orchestrator.runJob(job.id, { replanner: async () => ({ repairTasks: [{ task: { input: 'repair' } }] }) });
    expect(done.status).toBe('completed');
    const r = buildJobVerificationReport(done, new Set(['t1']));
    expect(r.verdict).toBe('VERIFIED');
    expect(done.verification?.verdict).toBe('VERIFIED');
  });
});
