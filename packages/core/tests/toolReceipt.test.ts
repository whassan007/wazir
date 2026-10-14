import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import { ToolReceiptManager, canonicalize, receiptFingerprint } from '../src/proactive/toolReceipt.js';

describe('ToolReceiptManager (Adapted from Qwen-Live-Harness)', () => {
  it('records receipts for executed tool operations without claiming atomicity or durability', () => {
    const manager = new ToolReceiptManager();

    const receipt = manager.createReceipt({
      toolName: 'patchTool',
      op: 'apply_patch',
      input: { file: 'src/index.ts', patch: '@@ -1,1 +1,2 @@' },
      output: 'Patch applied cleanly',
      success: true,
    });

    // createReceipt records an outcome after the fact in process memory: no check-then-
    // execute atomicity and no restart survival, so it must not claim either.
    expect(receipt.atomic).toBe(false);
    expect(receipt.durable).toBe(false);
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

  it('recovers after a crash: an expired idempotent attempt is re-acquired and the stale result is fenced', async () => {
    let now = 0;
    const store = new MemoryStore();
    const crashed = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    const first = await crashed.begin(id, { sideEffectClass: 'IDEMPOTENT_WRITE' });
    if (first.status !== 'acquired') throw new Error('expected acquire');
    now = 500;
    expect((await new ToolReceiptManager({ store, leaseMs: 1000, now: () => now }).begin(id)).status).toBe('in_flight');
    now = 1500;
    const recovered = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    const second = await recovered.begin(id, { sideEffectClass: 'IDEMPOTENT_WRITE' });
    if (second.status !== 'acquired') throw new Error('expected re-acquire');
    expect(second.attempt).toBe(2);
    await expect(crashed.settle({ ...id, fingerprint: first.fingerprint, attemptToken: first.attemptToken, success: true }))
      .rejects.toThrow('LEASE_LOST');
    const done = await recovered.settle({ ...id, fingerprint: second.fingerprint, attemptToken: second.attemptToken, success: true, output: 'ok' });
    expect(done.committed).toBe(true);
  });

  it('an expired non-idempotent attempt is outcome_unknown: never re-acquired until reconciled', async () => {
    let now = 0;
    const store = new MemoryStore();
    const crashed = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    const first = await crashed.begin(id); // default class: NON_IDEMPOTENT_WRITE
    if (first.status !== 'acquired') throw new Error('expected acquire');
    now = 5000;
    const recovered = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    expect((await recovered.begin(id)).status).toBe('outcome_unknown');
    // Still blocked on every later delivery, whatever the caller claims about the class.
    expect((await recovered.begin(id, { sideEffectClass: 'IDEMPOTENT_WRITE' })).status).toBe('outcome_unknown');
    // The crashed attempt's late result is fenced.
    await expect(crashed.settle({ ...id, fingerprint: first.fingerprint, attemptToken: first.attemptToken, success: true }))
      .rejects.toThrow('LEASE_LOST');
    // Proof that it happened commits it: it never runs again.
    expect(await recovered.reconcile({ ...id, fingerprint: first.fingerprint, outcome: 'APPLIED', evidence: 'deploy marker present' })).toBe('committed');
    expect((await recovered.begin(id)).status).toBe('committed');
  });

  it('an outcome_unknown attempt proven NOT_APPLIED may run again; reconcile refuses anything else', async () => {
    let now = 0;
    const store = new MemoryStore();
    const m = new ToolReceiptManager({ store, leaseMs: 1000, now: () => now });
    const first = await m.begin(id);
    if (first.status !== 'acquired') throw new Error('expected acquire');
    await expect(m.reconcile({ ...id, fingerprint: first.fingerprint, outcome: 'APPLIED', evidence: 'x' })).rejects.toThrow('NOTHING_TO_RECONCILE');
    now = 5000;
    expect((await m.begin(id)).status).toBe('outcome_unknown');
    expect(await m.reconcile({ ...id, fingerprint: first.fingerprint, outcome: 'NOT_APPLIED', evidence: 'no marker' })).toBe('failed');
    const retry = await m.begin(id);
    expect(retry.status).toBe('acquired');
    if (retry.status === 'acquired') expect(retry.attempt).toBe(2);
  });

  it('reports durability honestly: a MemoryStore is atomic but not durable, a file store is both', async () => {
    const mem = new ToolReceiptManager({ store: new MemoryStore() });
    const a = await mem.begin(id);
    if (a.status !== 'acquired') throw new Error('expected acquire');
    const r = await mem.settle({ ...id, fingerprint: a.fingerprint, attemptToken: a.attemptToken, success: true });
    expect([r.atomic, r.durable]).toEqual([true, false]);
    const dir = await mkdtemp(join(tmpdir(), 'wazir-receipts-'));
    try {
      const file = new ToolReceiptManager({ store: new JsonFileStore(join(dir, 's.json')) });
      const b = await file.begin(id);
      if (b.status !== 'acquired') throw new Error('expected acquire');
      const rf = await file.settle({ ...id, fingerprint: b.fingerprint, attemptToken: b.attemptToken, success: true });
      expect([rf.atomic, rf.durable]).toEqual([true, true]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('canonical serialization is injective for the tested operation classes', () => {
  // Each pair collided under the v2 encoding: a tag like {"$num":"NaN"} was also what a
  // plain object with a "$num" key serialized to, and Map/Set/class instances all
  // collapsed to "{}".
  const collidingPairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['NaN vs a {$num} object', { a: Number.NaN }, { a: { $num: 'NaN' } }],
    ['Infinity vs a {$num} object', { a: Infinity }, { a: { $num: 'Infinity' } }],
    ['bigint vs a {$bigint} object', { a: 10n }, { a: { $bigint: '10' } }],
    ['array hole vs a {$undefined} object', { a: [undefined] }, { a: [{ $undefined: true }] }],
    ['Date vs a {$date} object', { a: new Date(0) }, { a: { $date: '1970-01-01T00:00:00.000Z' } }],
    ['Map vs empty object', { a: new Map([['k', 1]]) }, { a: {} }],
    ['two different Maps', { a: new Map([['k', 1]]) }, { a: new Map([['k', 2]]) }],
    ['Set vs empty object', { a: new Set([1]) }, { a: {} }],
    ['bytes vs empty object', { a: new Uint8Array([1, 2]) }, { a: { 0: 1, 1: 2 } }],
    ['escaped key vs tag', { $$num: 'NaN' }, { $num: 'NaN' }],
  ];
  for (const [name, left, right] of collidingPairs) {
    it(`distinguishes ${name}`, () => {
      expect(canonicalize(left)).not.toBe(canonicalize(right));
      expect(receiptFingerprint({ toolName: 't', input: left })).not.toBe(receiptFingerprint({ toolName: 't', input: right }));
    });
  }

  it('Map and Set encodings are order-independent', () => {
    expect(canonicalize(new Map([['a', 1], ['b', 2]]))).toBe(canonicalize(new Map([['b', 2], ['a', 1]])));
    expect(canonicalize(new Set([2, 1]))).toBe(canonicalize(new Set([1, 2])));
  });

  it('refuses class instances instead of collapsing them to {}', () => {
    class Opaque { constructor(readonly secret = 1) {} }
    expect(() => canonicalize({ a: new Opaque() })).toThrow(/instance of Opaque/);
  });

  it('separates a duplicate delivery from an intentional repeat via the idempotency key', () => {
    const m = new ToolReceiptManager();
    const call = { toolName: 'shell', op: 'execute_tool' as const, input: { command: 'make release' }, executionId: 'e1' };
    const first = m.createReceipt({ ...call, idempotencyKey: 'step-7', success: true, output: 'v1' });
    const redelivered = m.createReceipt({ ...call, idempotencyKey: 'step-7', success: true, output: 'v1-again' });
    const intended = m.createReceipt({ ...call, idempotencyKey: 'step-8', success: true, output: 'v2' });
    expect(redelivered.receiptId).toBe(first.receiptId);
    expect(intended.receiptId).not.toBe(first.receiptId);
    expect(intended.results[0].output).toBe('v2');
  });

  it('a seeded random corpus of distinct inputs yields distinct fingerprints', () => {
    let seed = 0x5eed;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const leaf = (): unknown => {
      const r = rand();
      if (r < 0.15) return Math.floor(rand() * 5);
      if (r < 0.3) return String(Math.floor(rand() * 5));
      if (r < 0.4) return rand() < 0.5;
      if (r < 0.5) return null;
      if (r < 0.6) return { $num: 'NaN' };
      if (r < 0.7) return Number.NaN;
      if (r < 0.8) return [leaf()];
      return { [rand() < 0.5 ? 'k' : '$k']: leaf() };
    };
    const byCanonical = new Map<string, string>();
    for (let i = 0; i < 3000; i++) {
      const input = { v: leaf(), w: leaf() };
      const structural = JSON.stringify(input, (_k, v) => (typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : v));
      const fp = receiptFingerprint({ toolName: 't', input });
      const prior = byCanonical.get(fp);
      if (prior !== undefined) expect(prior).toBe(structural);
      byCanonical.set(fp, structural);
    }
    expect(byCanonical.size).toBeGreaterThan(100);
  });
});
