// Fault injection across a simulated process restart. "Process A" runs a job over a shared
// store until it is killed: its store handle starts refusing writes (a dead process cannot
// write) and the injected clock moves past its lease. "Process B" is a fresh JobManager and
// orchestrator over the same store that recovers the job. Local and deterministic: no
// child processes, no live model, no remote worker.
import { describe, it, expect } from 'vitest';
import { MemoryStore, type KeyValueStore } from '@wazir/shared';
import { ApprovalQueue, type JobTaskExecutor } from '../src/index.js';
import { setup } from './helpers/orchestratorFixture.js';

function killableStore(inner: MemoryStore): KeyValueStore & { kill(): void } {
  let dead = false;
  const guard = () => { if (dead) throw new Error('PROCESS_DEAD'); };
  return {
    kill: () => { dead = true; },
    update: async (key, mutate) => { guard(); return inner.update!(key, mutate); },
    put: async (key, value) => { guard(); return inner.put(key, value); },
    get: async (key) => inner.get(key),
    list: async (prefix) => inner.list(prefix),
    delete: async (key) => { guard(); return inner.delete(key); },
    clear: async () => { guard(); return inner.clear(); },
  };
}

const LEASE = 200;

async function crashDuring(store: MemoryStore, clock: { t: number }, executor: JobTaskExecutor, maxRetries: number, reached: Promise<void>) {
  const a = killableStore(store);
  const { orchestrator } = setup(executor, { store: a, now: () => clock.t, leaseMs: LEASE, backoffBaseMs: 1 });
  const job = await orchestrator.createJob({ title: 'restart', maxRetries, tasks: [{ task: { id: 't1', input: 'x' } }] });
  void orchestrator.runJob(job.id).catch(() => undefined);
  await reached;
  a.kill();
  clock.t += LEASE * 10;
  return job.id;
}

describe('Recovery across a process restart', () => {
  it('a recovered job keeps its retry budget: retries are not reset by a restart', async () => {
    const store = new MemoryStore();
    const clock = { t: 1_000 };
    let aCalls = 0;
    let hung!: () => void;
    const reached = new Promise<void>((r) => { hung = r; });
    const jobId = await crashDuring(store, clock, async () => {
      if (++aCalls <= 2) return { success: false, error: `flaky ${aCalls}`, errorKind: 'infrastructure' };
      hung();
      return new Promise(() => undefined); // killed mid-attempt
    }, 3, reached);

    const persisted = await store.get<any>(`job/${jobId}`);
    expect(persisted.graph.nodes[0].retryCount).toBe(2);
    expect(persisted.graph.nodes[0].attempts.map((a: any) => a.recovery.category)).toEqual(['transient_infrastructure', 'transient_infrastructure']);

    let bCalls = 0;
    const { orchestrator: b } = setup(async () => { bCalls++; return { success: false, error: 'still flaky', errorKind: 'infrastructure' }; },
      { store, now: () => clock.t, leaseMs: LEASE, backoffBaseMs: 1 });
    const results = await b.recoverJobs();
    expect(results).toEqual([{ jobId, status: 'failed' }]);
    // maxRetries 3: two used in A, the interrupted attempt is the third run; at most one more here.
    expect(bCalls).toBeGreaterThanOrEqual(1);
    expect(bCalls).toBeLessThanOrEqual(2);
    expect(aCalls + bCalls).toBeLessThanOrEqual(1 + 3 + 1);
    const final = b.getJob(jobId)!;
    expect(final.verification?.verdict).toBe('FAILED');
  });

  it('an approval pending when the process died is asked again, not assumed: fail closed', async () => {
    const store = new MemoryStore();
    const clock = { t: 1_000 };
    const interactive = new ApprovalQueue({ defaultTimeoutMs: 60_000 });
    const unsubscribe = interactive.subscribe(() => undefined); // an approver UI is attached in A
    let pendingInA!: () => void;
    const reached = new Promise<void>((r) => { pendingInA = r; });
    let sideEffects = 0;
    const gated = (queue: ApprovalQueue, onPending?: () => void): JobTaskExecutor => async (task, ctx) => {
      const approval = queue.enqueue({ tool: 'shell', input: { command: 'git push' } } as any,
        { decision: 'ask', rule: 'push', reasons: ['requires approval'] } as any, { jobId: ctx.jobId, taskId: task.id });
      onPending?.();
      if (!(await approval)) return { success: false, error: 'POLICY_DENIED: approval required for git push', errorKind: 'policy' };
      sideEffects++;
      return { success: true };
    };
    const jobId = await crashDuring(store, clock, gated(interactive, pendingInA), 3, reached);
    unsubscribe();

    // B is headless: no approver attached, so the queue denies rather than blocking.
    let bCalls = 0;
    const headless = new ApprovalQueue({ autoDenyNonInteractive: true });
    const inner = gated(headless);
    const { orchestrator: b } = setup(async (task, ctx) => { bCalls++; return inner(task, ctx); },
      { store, now: () => clock.t, leaseMs: LEASE, backoffBaseMs: 1 });
    const results = await b.recoverJobs();
    expect(results).toEqual([{ jobId, status: 'failed' }]);
    expect(sideEffects).toBe(0);
    expect(bCalls).toBe(1); // a policy denial is not retried
    expect(b.getJob(jobId)!.graph.nodes[0].lastRecovery).toMatchObject({ category: 'tool_or_policy', strategy: 'stop' });
  });

  it('a cancellation requested before the restart is honoured by recovery', async () => {
    const store = new MemoryStore();
    const clock = { t: 1_000 };
    let hung!: () => void;
    const reached = new Promise<void>((r) => { hung = r; });
    const jobId = await crashDuring(store, clock, async () => { hung(); return new Promise(() => undefined); }, 3, reached);
    // Operator cancels while nobody owns the job (e.g. from another control-plane process).
    await store.update!<any>(`job/${jobId}`, (job) => ({ ...job, control: { cancelRequestedAt: clock.t } }));
    expect((await store.get<any>(`job/${jobId}`)).status).toBe('running');
    let bCalls = 0;
    const { orchestrator: b } = setup(async () => { bCalls++; return { success: true }; }, { store, now: () => clock.t, leaseMs: LEASE });
    await b.recoverJobs();
    expect(bCalls).toBe(0);
    expect(b.getJob(jobId)!.status).toBe('cancelled');
  });

  it('concurrent jobs recover independently: one job\'s failures never consume another\'s budget', async () => {
    const store = new MemoryStore();
    const calls = new Map<string, number>();
    const { orchestrator } = setup(async (task) => {
      const n = (calls.get(task.id) ?? 0) + 1;
      calls.set(task.id, n);
      if (task.id.startsWith('bad')) return { success: false, error: `flake ${task.id} ${n}`, errorKind: 'infrastructure' };
      if (n === 1) return { success: false, error: 'first try', errorKind: 'infrastructure' };
      return { success: true };
    }, { store, backoffBaseMs: 1 });
    const jobs = await Promise.all([0, 1, 2].map((i) => orchestrator.createJob({
      title: `c${i}`, maxRetries: 2, concurrencyLimit: 2,
      tasks: [{ task: { id: `good-${i}`, input: 'x' } }, { task: { id: `bad-${i}`, input: 'x' } }],
    })));
    const done = await Promise.all(jobs.map((j) => orchestrator.runJob(j.id)));
    for (const [i, job] of done.entries()) {
      expect(job.status).toBe('failed');
      expect(calls.get(`good-${i}`)).toBe(2);
      expect(calls.get(`bad-${i}`)).toBe(3);
      expect(job.graph.nodes.find((n) => n.id === `good-${i}`)!.state).toBe('completed');
    }
  });
});
