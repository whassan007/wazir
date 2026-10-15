import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import { ToolReceiptManager } from '../src/proactive/toolReceipt.js';

describe('ToolReceiptManager (Adapted from Qwen-Live-Harness)', () => {
  it('creates authoritative atomic receipts for tool operations', () => {
    const manager = new ToolReceiptManager();

    const receipt = manager.createReceipt({
      toolName: 'patchTool',
      op: 'apply_patch',
      input: { file: 'src/index.ts', patch: '@@ -1,1 +1,2 @@' },
      output: 'Patch applied cleanly',
      success: true,
    });

    expect(receipt.atomic).toBe(true);
    expect(receipt.committed).toBe(true);
    expect(receipt.results[0].toolName).toBe('patchTool');
    expect(receipt.results[0].success).toBe(true);
  });

  it('guarantees idempotency by returning cached receipt for identical tool calls', () => {
    const manager = new ToolReceiptManager();

    const input = { command: 'npm test', cwd: '/tmp/repo' };
    const r1 = manager.createReceipt({
      toolName: 'shell',
      op: 'execute_tool',
      input,
      output: 'All tests passed',
      success: true,
    });

    const r2 = manager.createReceipt({
      toolName: 'shell',
      op: 'execute_tool',
      input,
      output: 'Duplicate execution',
      success: true,
    });

    // Identical fingerprint returns the exact same receipt without re-executing
    expect(r1.receiptId).toBe(r2.receiptId);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r2.results[0].output).toBe('All tests passed');
  });
});

describe('ToolReceiptManager fingerprint and durability (P0 regression)', () => {
  it('different tool names and inputs never collide (the old replacer dropped both)', () => {
    const m = new ToolReceiptManager();
    const fps = new Set([
      m.computeFingerprint('shell', { command: 'rm -rf build' }),
      m.computeFingerprint('shell', { command: 'ls' }),
      m.computeFingerprint('writeFile', { command: 'ls' }),
      m.computeFingerprint('readFile', {}),
      m.computeFingerprint('writeFile', {}),
      m.computeFingerprint('shell', { a: { b: 1 } }),
      m.computeFingerprint('shell', { a: { b: 2 } }),
      m.computeFingerprint('shell', { a: [1, 2] }),
      m.computeFingerprint('shell', { a: [2, 1] }),
      m.computeFingerprint('shell', { a: '1' }),
      m.computeFingerprint('shell', { a: 1 }),
      m.computeFingerprint('shell', { a: null }),
      m.computeFingerprint('shell', { a: Number.NaN }),
    ]);
    expect(fps.size).toBe(13);
  });

  it('a different tool with the same input is executed, not deduplicated', () => {
    const m = new ToolReceiptManager();
    const r1 = m.createReceipt({ toolName: 'deleteFile', op: 'execute_tool', input: { path: 'a' }, success: true });
    const r2 = m.createReceipt({ toolName: 'writeFile', op: 'execute_tool', input: { content: 'x' }, success: true });
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
    expect(r2.results[0].toolName).toBe('writeFile');
  });

  it('is deterministic regardless of key order at any depth', () => {
    const m = new ToolReceiptManager();
    expect(m.computeFingerprint('t', { b: { y: 1, x: 2 }, a: 1 })).toBe(m.computeFingerprint('t', { a: 1, b: { x: 2, y: 1 } }));
  });

  it('scopes deduplication by operation scope and execution identity', () => {
    const m = new ToolReceiptManager();
    const input = { command: 'git push' };
    const a = m.createReceipt({ toolName: 'shell', op: 'execute_tool', input, scope: '/repo-a', executionId: 'e1', success: true });
    const b = m.createReceipt({ toolName: 'shell', op: 'execute_tool', input, scope: '/repo-b', executionId: 'e1', success: true });
    const c = m.createReceipt({ toolName: 'shell', op: 'execute_tool', input, scope: '/repo-a', executionId: 'e2', success: true });
    const retry = m.createReceipt({ toolName: 'shell', op: 'execute_tool', input, scope: '/repo-a', executionId: 'e1', success: true });
    expect(new Set([a.receiptId, b.receiptId, c.receiptId]).size).toBe(3);
    expect(retry.receiptId).toBe(a.receiptId);
  });

  it('a failed attempt is not committed and does not block a retry', () => {
    const m = new ToolReceiptManager();
    const p = { toolName: 'patchTool', op: 'apply_patch' as const, input: { file: 'x' } };
    const failed = m.createReceipt({ ...p, success: false, error: 'conflict' });
    expect(failed.committed).toBe(false);
    expect(m.hasReceipt(failed.fingerprint)).toBe(false);
    const ok = m.createReceipt({ ...p, success: true, output: 'applied' });
    expect(ok.committed).toBe(true);
    expect(ok.results[0].output).toBe('applied');
  });

  it('refuses cyclic input rather than hashing it ambiguously', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => new ToolReceiptManager().computeFingerprint('t', cyclic)).toThrow(/cyclic/);
  });
});

describe('ToolReceiptManager durable begin/settle', () => {
  const id = { toolName: 'shell', op: 'execute_tool' as const, input: { command: 'deploy' }, scope: 'proj', executionId: 'exec-1' };

  it('only one concurrent attempt acquires; a committed receipt survives a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wazir-receipts-'));
    try {
      const file = join(dir, 'store.json');
      const a = new ToolReceiptManager({ store: new JsonFileStore(file) });
      const b = new ToolReceiptManager({ store: new JsonFileStore(file) });
      const [ra, rb] = await Promise.all([a.begin(id), b.begin(id)]);
      expect([ra.status, rb.status].sort()).toEqual(['acquired', 'in_flight']);
      const winner = ra.status === 'acquired' ? ra : rb;
      if (winner.status !== 'acquired') throw new Error('no winner');
      await a.settle({ ...id, fingerprint: winner.fingerprint, attemptToken: winner.attemptToken, success: true, output: 'deployed' });

      const restarted = new ToolReceiptManager({ store: new JsonFileStore(file) });
      const again = await restarted.begin(id);
      expect(again.status).toBe('committed');
      if (again.status === 'committed') expect(again.receipt.results[0].output).toBe('deployed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('a failed attempt releases the fingerprint for a retry', async () => {
    const m = new ToolReceiptManager({ store: new MemoryStore() });
    const first = await m.begin(id);
    if (first.status !== 'acquired') throw new Error('expected acquire');
    const failed = await m.settle({ ...id, fingerprint: first.fingerprint, attemptToken: first.attemptToken, success: false, error: 'boom' });
    expect(failed.committed).toBe(false);
    const second = await m.begin(id);
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') expect(second.attempt).toBe(2);
  });

  it('recovers after a crash: an expired pending attempt is re-acquired and the stale result is fenced', async () => {
    let now = 0;
    const store = new MemoryStore();
    const crashed = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    const first = await crashed.begin(id);
    if (first.status !== 'acquired') throw new Error('expected acquire');
    now = 500;
    expect((await new ToolReceiptManager({ store, leaseMs: 1000, now: () => now }).begin(id)).status).toBe('in_flight');
    now = 1500;
    const recovered = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    const second = await recovered.begin(id);
    if (second.status !== 'acquired') throw new Error('expected re-acquire');
    expect(second.attempt).toBe(2);
    await expect(crashed.settle({ ...id, fingerprint: first.fingerprint, attemptToken: first.attemptToken, success: true }))
      .rejects.toThrow('LEASE_LOST');
    const done = await recovered.settle({ ...id, fingerprint: second.fingerprint, attemptToken: second.attemptToken, success: true, output: 'ok' });
    expect(done.committed).toBe(true);
  });
});
