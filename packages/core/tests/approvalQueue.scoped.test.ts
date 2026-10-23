import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import { ApprovalQueue, approvalScopeKey } from '../src/index.js';
import type { ApprovalScope } from '../src/index.js';

const scope = (over: Partial<ApprovalScope> = {}): ApprovalScope => ({
  kind: 'goal-studio', runId: 'run-1', targetId: 'T1', attempt: 1, action: 'execute', ...over,
});

describe('ApprovalQueue scoped approvals (goal studio)', () => {
  it('binds a decision to exactly one (run, target, attempt, action) scope', async () => {
    const queue = new ApprovalQueue();
    const first = queue.requestScoped(scope());
    const other = queue.requestScoped(scope({ attempt: 2 }));
    expect(queue.count).toBe(2);
    const item = queue.findByScope(scope())!;
    expect(item.scopeKey).toBe(approvalScopeKey(scope()));

    // A resolution that names a different scope is refused and leaves it pending.
    const mismatch = queue.resolve(item.id, true, 'user:operator', { runId: 'run-1', attempt: 2 });
    expect(mismatch).toMatchObject({ ok: false, code: 'SCOPE_MISMATCH' });
    expect(queue.count).toBe(2);

    const ok = queue.resolve(item.id, true, 'user:operator', { runId: 'run-1', targetId: 'T1', attempt: 1, action: 'execute' });
    expect(ok.ok).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(queue.count).toBe(1);
    expect(queue.findByScope(scope({ attempt: 2 }))).toBeDefined();

    queue.deny(queue.findByScope(scope({ attempt: 2 }))!.id, 'user:operator');
    await expect(other).resolves.toBe(false);
  });

  it('is idempotent per scope and cannot be replayed', async () => {
    const queue = new ApprovalQueue();
    const a = queue.requestScoped(scope());
    const b = queue.requestScoped(scope());
    expect(queue.count).toBe(1);
    const id = queue.list()[0].id;
    expect(queue.approve(id, 'user:operator')).toBe(true);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);

    // Replaying the resolution is rejected with a precise code.
    expect(queue.resolve(id, false, 'user:operator')).toMatchObject({ ok: false, code: 'ALREADY_RESOLVED' });
    // Re-requesting the same scope returns the recorded decision without prompting.
    await expect(queue.requestScoped(scope())).resolves.toBe(true);
    expect(queue.count).toBe(0);
    // Attribution is recorded.
    expect(queue.record(id)).toMatchObject({ status: 'approved', resolvedBy: 'user:operator' });
  });

  it('expires unanswered scoped requests (fail closed) and reports EXPIRED', async () => {
    const queue = new ApprovalQueue({ scopedTimeoutMs: 20 });
    const pending = queue.requestScoped(scope());
    const id = queue.list()[0].id;
    expect(queue.list()[0].expiresAt).toBeInstanceOf(Date);
    await expect(pending).resolves.toBe(false);
    expect(queue.resolve(id, true, 'user:operator')).toMatchObject({ ok: false, code: 'EXPIRED' });
    await expect(queue.requestScoped(scope())).resolves.toBe(false);
  });

  it('expires a request whose deadline has passed even if the timer has not fired', async () => {
    let now = 1_000;
    const queue = new ApprovalQueue({ now: () => now, scopedTimeoutMs: 60_000 });
    const pending = queue.requestScoped(scope());
    const id = queue.list()[0].id;
    now += 61_000;
    expect(queue.resolve(id, true, 'user:operator')).toMatchObject({ ok: false, code: 'EXPIRED' });
    await expect(pending).resolves.toBe(false);
  });

  it('never honours WAZIR_AUTO_APPROVE for scoped requests', async () => {
    const previous = process.env.WAZIR_AUTO_APPROVE;
    process.env.WAZIR_AUTO_APPROVE = '1';
    try {
      const queue = new ApprovalQueue({ allowEnvAutoApprove: true, scopedTimeoutMs: 20 });
      await expect(queue.requestScoped(scope())).resolves.toBe(false);
    } finally {
      if (previous === undefined) delete process.env.WAZIR_AUTO_APPROVE;
      else process.env.WAZIR_AUTO_APPROVE = previous;
    }
  });

  it('is not auto-denied by autoDenyNonInteractive (out-of-band approvers)', async () => {
    const queue = new ApprovalQueue({ autoDenyNonInteractive: true });
    const pending = queue.requestScoped(scope());
    expect(queue.count).toBe(1);
    queue.approve(queue.list()[0].id, 'user:operator');
    await expect(pending).resolves.toBe(true);
  });

  it('rejects malformed scopes', () => {
    const queue = new ApprovalQueue();
    expect(() => queue.requestScoped(scope({ runId: '' }))).toThrow(/runId/);
    expect(() => queue.requestScoped(scope({ attempt: -1 }))).toThrow(/attempt/);
  });

  it('scope keys cannot collide through separator injection', () => {
    expect(approvalScopeKey(scope({ runId: 'a:b', targetId: 'c' })))
      .not.toBe(approvalScopeKey(scope({ runId: 'a', targetId: 'b:c' })));
  });

  it('persists durably; pending requests expire across restart and decisions survive', async () => {
    const store = new MemoryStore();
    const q1 = new ApprovalQueue({ store });
    const approved = q1.requestScoped(scope({ targetId: 'A' }));
    void q1.requestScoped(scope({ targetId: 'B' }));
    q1.approve(q1.findByScope(scope({ targetId: 'A' }))!.id, 'user:operator');
    await approved;
    await q1.flush();

    const q2 = new ApprovalQueue({ store });
    await q2.init();
    expect(q2.count).toBe(0);
    const records = q2.records({ kind: 'goal-studio', runId: 'run-1' });
    expect(records.map((r) => [r.scope?.targetId, r.status]).sort()).toEqual([['A', 'approved'], ['B', 'expired']]);
    // Recorded decisions answer replays after restart; the expired one fails closed.
    await expect(q2.requestScoped(scope({ targetId: 'A' }))).resolves.toBe(true);
    await expect(q2.requestScoped(scope({ targetId: 'B' }))).resolves.toBe(false);
  });

  it('keeps the legacy approve/deny API working with attribution', async () => {
    const queue = new ApprovalQueue();
    const p = queue.enqueue({ tool: 'shell', input: { command: 'ls' } }, { decision: 'ask', rule: 'r', reasons: [] });
    const id = queue.list()[0].id;
    expect(id.startsWith('appr-')).toBe(true);
    expect(queue.approve(id, 'tui')).toBe(true);
    await expect(p).resolves.toBe(true);
    expect(queue.record(id)).toMatchObject({ status: 'approved', resolvedBy: 'tui' });
    expect(queue.approve(id)).toBe(false);
  });
});
