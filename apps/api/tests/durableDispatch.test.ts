import { describe, it, expect } from 'vitest';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskDispatcher } from '../src/server.js';

const request = { requestId: 'request-1', executionId: 'exec-1', modelId: 'test', messages: [] };
const outcome = { ok: true, output: 'done', inputTokens: 1, outputTokens: 2, durationMs: 3 };

describe('durable dispatch and worker fencing', () => {
  it('admits only one competing claim, renews it, and fences an expired holder', async () => {
    const store = new MemoryStore();
    let now = 0;
    const a = new TaskDispatcher(store, () => now, 1000);
    const b = new TaskDispatcher(store, () => now, 1000);
    await a.dispatch('computer', request);
    const results = await Promise.allSettled([a.claim(request.requestId, 'computer'), b.claim(request.requestId, 'computer')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const first = results.find(r => r.status === 'fulfilled')!;
    if (first.status !== 'fulfilled') throw new Error('missing claim');
    now = 500;
    await a.renew(request.requestId, first.value.token);
    now = 1200;
    await expect(b.claim(request.requestId, 'computer')).rejects.toThrow('RESOURCE_BUSY');
    now = 1501;
    const second = await b.claim(request.requestId, 'computer');
    expect(second.attempt).toBe(2);
    await expect(a.resolve(request.requestId, outcome, first.value.token)).rejects.toThrow('LEASE_LOST');
    await expect(a.renew(request.requestId, first.value.token)).rejects.toThrow('LEASE_LOST');
    await b.resolve(request.requestId, outcome, second.token);
    await b.resolve(request.requestId, { ...outcome, output: 'overwrite' }, second.token);
    expect((await a.status(request.requestId))?.outcome?.output).toBe('done');
    await expect(a.claim(request.requestId, 'computer')).rejects.toThrow('RESOURCE_BUSY');
  });

  it('persists requests and results across dispatcher and file-store restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wazir-dispatch-'));
    try {
      const file = join(dir, 'store.json');
      const a = new TaskDispatcher(new JsonFileStore(file));
      await a.dispatch('computer', request);
      const b = new TaskDispatcher(new JsonFileStore(file));
      await b.ready;
      expect(b.ownerOf(request.requestId)).toBe('computer');
      expect(b.totalQueued).toBe(1);
      const lease = await b.claim(request.requestId, 'computer');
      await b.resolve(request.requestId, outcome, lease.token);
      const c = new TaskDispatcher(new JsonFileStore(file));
      await c.ready;
      expect(c.totalQueued).toBe(0);
      expect((await c.awaitOutcome(request.requestId, 100)).output).toBe('done');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('recognizes terminal retries as duplicates even after lease expiry and never appends duplicate events', async () => {
    const store = new MemoryStore();
    let now = 0;
    const dispatcher = new TaskDispatcher(store, () => now, 1000);
    await dispatcher.dispatch('computer', request);
    const lease = await dispatcher.claim(request.requestId, 'computer');
    const event = { executionId: request.executionId, type: 'started' as const, data: { attemptId: lease.attemptId } };
    await dispatcher.recordEvent(request.requestId, event, lease.token);
    await dispatcher.recordEvent(request.requestId, event, lease.token);
    await dispatcher.commit(request.requestId, outcome, lease.token);
    now = 2000;
    await expect(dispatcher.commit(request.requestId, { ...outcome, output: 'stale overwrite' }, lease.token)).resolves.toBe('duplicate');
    const status = await dispatcher.status(request.requestId);
    expect(status?.outcome?.output).toBe('done');
    expect(status?.events.filter(e => e.type === 'started')).toHaveLength(1);
  });

  it('allows only one concurrent terminal commit and preserves the winning outcome', async () => {
    const store = new MemoryStore();
    const a = new TaskDispatcher(store, Date.now, 1000);
    const b = new TaskDispatcher(store, Date.now, 1000);
    await a.dispatch('computer', request);
    const lease = await a.claim(request.requestId, 'computer');
    const results = await Promise.all([
      a.commit(request.requestId, { ...outcome, output: 'winner-a' }, lease.token),
      b.commit(request.requestId, { ...outcome, output: 'winner-b' }, lease.token),
    ]);
    expect(results.sort()).toEqual(['committed', 'duplicate']);
    expect((await b.status(request.requestId))?.outcome?.output).toMatch(/^winner-[ab]$/);
  });
});

describe('independent process claim race', () => {
  it('allows only one process to claim a durable dispatch', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const dir = await mkdtemp(join(tmpdir(), 'wazir-process-claims-'));
    try {
      const file = join(dir, 'store.json');
      const dispatcher = new TaskDispatcher(new JsonFileStore(file));
      await dispatcher.dispatch('computer', request);
      const source = `
        const { TaskDispatcher } = require('./apps/api/dist/server.js');
        const { JsonFileStore } = require('@wazir/shared');
        (async () => {
          const d = new TaskDispatcher(new JsonFileStore(process.argv[1]));
          await d.ready;
          try { await d.claim('request-1', 'computer'); process.stdout.write('claimed'); }
          catch (e) { if (e.message !== 'RESOURCE_BUSY') throw e; process.stdout.write('busy'); }
        })().catch(e => { console.error(e); process.exitCode = 1; });
      `;
      const results = await Promise.all([run(process.execPath, ['-e', source, file]), run(process.execPath, ['-e', source, file])]);
      expect(results.map(r => r.stdout).sort()).toEqual(['busy', 'claimed']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
