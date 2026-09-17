import { describe, it, expect } from 'vitest';
import {
  ApprovalQueue,
  PolicyEngine,
  PolicyActionRequest,
  PolicyDecision,
} from '../src/index.js';

describe('ApprovalQueue — non-blocking multi-agent policy authorization', () => {
  it('enqueues ask decisions without blocking other asynchronous tasks', async () => {
    const queue = new ApprovalQueue();
    const policy = new PolicyEngine({
      projectRoot: '/test',
      approvalQueue: queue,
    });

    const task1Request: PolicyActionRequest = {
      tool: 'shell',
      input: { command: 'rm -rf build' },
      executionId: 'exec-1',
    };
    const task2Request: PolicyActionRequest = {
      tool: 'shell',
      input: { command: 'npm install' },
      executionId: 'exec-2',
    };

    // Both agents execute concurrently and hit policy.authorize()
    const task1AuthPromise = policy.authorize(task1Request);
    const task2AuthPromise = policy.authorize(task2Request);

    // Both are enqueued in the approval queue
    expect(queue.count).toBe(2);
    const items = queue.list();
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.input.command === 'rm -rf build')).toBe(true);
    expect(items.some((i) => i.input.command === 'npm install')).toBe(true);

    // Agent 1 is approved
    const item1 = items.find((i) => i.input.command === 'rm -rf build')!;
    queue.approve(item1.id);

    // Task 1 resolves immediately to allow
    const decision1 = await task1AuthPromise;
    expect(decision1.decision).toBe('allow');
    expect(decision1.reasons).toContain('approved by user via approval queue');

    // Task 2 is still pending!
    expect(queue.count).toBe(1);

    // Agent 2 is denied
    const item2 = items.find((i) => i.input.command === 'npm install')!;
    queue.deny(item2.id);

    // Task 2 resolves to deny
    const decision2 = await task2AuthPromise;
    expect(decision2.decision).toBe('deny');
    expect(decision2.reasons).toContain('denied by user via approval queue');

    expect(queue.count).toBe(0);
  });

  it('notifies subscribers when approvals are enqueued or resolved', async () => {
    const queue = new ApprovalQueue();
    const notifications: number[] = [];

    const unsubscribe = queue.subscribe((items) => {
      notifications.push(items.length);
    });

    const dummyRequest: PolicyActionRequest = { tool: 'git', input: { args: ['commit', '-m', 'test'] } };
    const dummyDecision: PolicyDecision = { decision: 'ask', rule: 'git-write-ask', reasons: ['git write requires approval'] };

    const promise = queue.enqueue(dummyRequest, dummyDecision);
    expect(notifications).toContain(1);

    const pending = queue.list()[0];
    queue.approve(pending.id);
    await promise;

    expect(notifications).toContain(0);
    unsubscribe();
  });

  it('supports approveAll and denyAll across multiple pending requests', async () => {
    const queue = new ApprovalQueue();
    const req1 = queue.enqueue({ tool: 'shell', input: { command: 'git add .' } }, { decision: 'ask', rule: 'git-write-ask', reasons: [] });
    const req2 = queue.enqueue({ tool: 'shell', input: { command: 'git commit' } }, { decision: 'ask', rule: 'git-write-ask', reasons: [] });

    expect(queue.count).toBe(2);
    queue.approveAll();

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(queue.count).toBe(0);
  });
});
