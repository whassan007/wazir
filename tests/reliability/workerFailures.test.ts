// Worker-side failure handling against a real HTTP control plane backed by the shipped
// TaskDispatcher (see fixtures/controlPlane.mjs). Every scenario asserts the same two
// properties: the model generation is not blindly repeated, and at most one terminal
// result is committed per dispatched request.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '@wazir/shared';
import { Worker, executeRequest } from '@wazir/workers';
// @ts-expect-error -- untyped .mjs fixture shared with child processes
import { startControlPlane, scriptedAdapter, waitFor } from './fixtures/controlPlane.mjs';

type Plane = Awaited<ReturnType<typeof startControlPlane>>;
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const request = (id: string, extra: Record<string, unknown> = {}) =>
  ({ requestId: id, executionId: `exec-${id}`, modelId: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra });

async function plane(options: Record<string, unknown> = {}): Promise<Plane> {
  const p = await startControlPlane(options);
  cleanup.push(() => p.close());
  return p;
}

async function worker(p: Plane, adapter: unknown, computerId = 'w1', extra: Record<string, unknown> = {}): Promise<Worker> {
  const w = new Worker({ computerId, serverUrl: p.url, adapters: [adapter as never], heartbeatIntervalMs: 60_000, resultRetryBaseMs: 10, ...extra });
  await w.start();
  cleanup.push(() => w.stop());
  return w;
}

const outcome = async (p: Plane, id: string) => (await p.dispatcher.status(id))?.outcome;

describe('worker failure handling', () => {
  it('duplicate task delivery: aggressive redelivery runs the generation once and commits once', async () => {
    const p = await plane({ redeliverMs: 15, leaseMs: 2_000 });
    const adapter = scriptedAdapter(async function* (_r: unknown, ctx: { sleep(ms: number): Promise<void> }) {
      await ctx.sleep(300);
      yield { type: 'completed', content: 'once' };
    });
    await worker(p, adapter);
    await p.dispatcher.dispatch('w1', request('dup'));
    await waitFor(async () => (await outcome(p, 'dup')) !== undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.state.generateCalls).toEqual(['dup']);
    expect(p.stats.committed).toBe(1);
    expect((await outcome(p, 'dup')).output).toBe('once');
  });

  it('concurrent claim attempts from two dispatcher processes sharing a store: exactly one lease', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wazir-claims-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'store.json');
    const { TaskDispatcher } = await import('../../apps/api/dist/server.js' as string);
    const a = new TaskDispatcher(new JsonFileStore(file));
    const b = new TaskDispatcher(new JsonFileStore(file));
    await a.dispatch('w1', request('race'));
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).claim('race', 'w1')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.message === 'RESOURCE_BUSY')).toBe(true);
  });

  it('lease renewal failure: the worker cancels the generation and never submits a result for the lost lease', async () => {
    const p = await plane({ leaseMs: 300, faults: { refuseRenew: true } });
    const adapter = scriptedAdapter(async function* (_r: unknown, ctx: { sleep(ms: number): Promise<void>; cancelled: boolean }) {
      await ctx.sleep(2_000);
      yield ctx.cancelled ? { type: 'completed', finishReason: 'cancelled' } : { type: 'completed', content: 'late' };
    });
    await worker(p, adapter);
    await p.dispatcher.dispatch('w1', request('renew'));
    await waitFor(() => adapter.state.cancelled.includes('renew'));
    await new Promise((r) => setTimeout(r, 200));
    expect(p.stats.results).toHaveLength(0);
    expect(await outcome(p, 'renew')).toBeUndefined();
  });

  it('controller communication interruption: dropped result POSTs are re-sent and committed exactly once', async () => {
    const p = await plane({ faults: { dropResults: 3 } });
    const adapter = scriptedAdapter(async function* () { yield { type: 'completed', content: 'delivered' }; });
    await worker(p, adapter);
    await p.dispatcher.dispatch('w1', request('drop'));
    await waitFor(async () => (await outcome(p, 'drop')) !== undefined);
    expect(p.stats.droppedResults).toBe(3);
    expect(p.stats.committed).toBe(1);
    expect(adapter.state.generateCalls).toEqual(['drop']);
    expect((await outcome(p, 'drop')).output).toBe('delivered');
  });

  it('result delivery is bounded: a control plane that never accepts stops being retried', async () => {
    const p = await plane({ faults: { dropResults: 1_000 } });
    const adapter = scriptedAdapter(async function* () { yield { type: 'completed', content: 'x' }; });
    await worker(p, adapter, 'w1', { resultRetryAttempts: 4 });
    await p.dispatcher.dispatch('w1', request('bounded'));
    await waitFor(() => p.stats.results.length >= 4);
    await new Promise((r) => setTimeout(r, 400));
    expect(p.stats.results).toHaveLength(4);
    expect(await outcome(p, 'bounded')).toBeUndefined();
  });

  it('stale result submission: a superseded lease cannot commit, and the current holder commits once', async () => {
    let now = 0;
    const p = await plane({ now: () => now, leaseMs: 1_000 });
    await p.dispatcher.dispatch('w1', request('stale'));
    const first = await p.dispatcher.claim('stale', 'w1');
    now = 5_000; // first holder's lease expired (it hung or was partitioned)
    const second = await p.dispatcher.claim('stale', 'w1');
    const result = { ok: true, output: '', inputTokens: 0, outputTokens: 0, durationMs: 0 };
    await expect(p.dispatcher.commit('stale', { ...result, output: 'stale' }, first.token)).rejects.toThrow('LEASE_LOST');
    expect(await p.dispatcher.commit('stale', { ...result, output: 'current' }, second.token)).toBe('committed');
    expect(await p.dispatcher.commit('stale', { ...result, output: 'again' }, second.token)).toBe('duplicate');
    await expect(p.dispatcher.commit('stale', { ...result, output: 'stale' }, first.token)).rejects.toThrow('LEASE_LOST');
    expect((await outcome(p, 'stale')).output).toBe('current');
  });

  it('cancellation race: stopping the worker as the generation finishes yields no result or exactly one', async () => {
    for (const stopAfterMs of [0, 40, 80, 120]) {
      const p = await plane({ leaseMs: 5_000 });
      const adapter = scriptedAdapter(async function* (_r: unknown, ctx: { sleep(ms: number): Promise<void>; cancelled: boolean }) {
        await ctx.sleep(80);
        yield ctx.cancelled ? { type: 'completed', finishReason: 'cancelled' } : { type: 'completed', content: 'raced' };
      });
      const w = await worker(p, adapter);
      await p.dispatcher.dispatch('w1', request(`race-${stopAfterMs}`));
      await waitFor(() => adapter.state.generateCalls.length === 1);
      await new Promise((r) => setTimeout(r, stopAfterMs));
      await w.stop();
      await new Promise((r) => setTimeout(r, 150));
      expect(p.stats.committed).toBeLessThanOrEqual(1);
      const out = await outcome(p, `race-${stopAfterMs}`);
      if (out) expect(out).toMatchObject({ ok: true, output: 'raced' });
      else expect(adapter.state.cancelled).toContain(`race-${stopAfterMs}`);
    }
  });

  it('timed-out model request: timeoutMs is enforced, the adapter is cancelled and a failure is committed', async () => {
    const p = await plane();
    const adapter = scriptedAdapter(async function* (_r: unknown, ctx: { sleep(ms: number): Promise<void> }) {
      yield { type: 'token', content: 'thinking' };
      await ctx.sleep(10_000);
      yield { type: 'completed', content: 'too late' };
    });
    await worker(p, adapter);
    const started = Date.now();
    await p.dispatcher.dispatch('w1', request('slow', { timeoutMs: 150 }));
    await waitFor(async () => (await outcome(p, 'slow')) !== undefined, 5_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await outcome(p, 'slow')).toMatchObject({ ok: false, error: expect.stringContaining('MODEL_REQUEST_TIMEOUT') });
    expect(adapter.state.cancelled).toContain('slow');
  });

  it('partial stream disconnection: a stream that ends or throws without completing is never a success', async () => {
    const truncated = scriptedAdapter(async function* () { yield { type: 'token', content: 'half an ans' }; });
    const thrown = scriptedAdapter(async function* () { yield { type: 'token', content: 'half' }; throw new Error('ECONNRESET'); });
    const aborted = scriptedAdapter(async function* () { yield { type: 'token', content: 'x' }; yield { type: 'completed', finishReason: 'cancelled' }; });
    const a = await executeRequest(truncated as never, request('t') as never);
    const b = await executeRequest(thrown as never, request('u') as never);
    const c = await executeRequest(aborted as never, request('v') as never);
    expect(a).toMatchObject({ ok: false, output: 'half an ans', error: expect.stringContaining('STREAM_TRUNCATED') });
    expect(b).toMatchObject({ ok: false, error: 'ECONNRESET' });
    expect(c).toMatchObject({ ok: false, error: expect.stringContaining('MODEL_REQUEST_CANCELLED') });
  });

  it('long-running task shutdown and worker process death: another worker process finishes it, one result', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wazir-worker-death-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const marker = path.join(dir, 'marker');
    await writeFile(marker, '');
    const p = await plane({ leaseMs: 400, redeliverMs: 100 });
    const spawnWorker = async (generationMs: number): Promise<ChildProcess> => {
      const child = spawn(process.execPath, ['tests/reliability/workerProcess.mjs', p.url, 'w1', String(generationMs), marker], { stdio: ['ignore', 'pipe', 'inherit'] });
      cleanup.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
        child.once('exit', (code, signal) => reject(new Error(`worker exited early ${code ?? signal}`)));
      });
      return child;
    };
    const exited = (child: ChildProcess) => new Promise<string>((resolve) => child.once('exit', (code, signal) => resolve(String(signal ?? code))));

    for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
      const id = `long-${signal}`;
      const doomed = await spawnWorker(60_000);
      await p.dispatcher.dispatch('w1', request(id));
      await waitFor(async () => (await readFile(marker, 'utf8')).includes(`start ${id}`));
      const exit = exited(doomed);
      doomed.kill(signal);
      expect(await exit).toBe(signal === 'SIGKILL' ? 'SIGKILL' : '0');
      expect(await outcome(p, id)).toBeUndefined(); // the dead attempt committed nothing

      const survivor = await spawnWorker(50);
      await waitFor(async () => (await outcome(p, id)) !== undefined, 10_000);
      const out = await outcome(p, id);
      expect(out).toMatchObject({ ok: true, output: `answer from ${survivor.pid}` });
      const log = await readFile(marker, 'utf8');
      expect(log.match(new RegExp(`done ${id}`, 'g'))).toHaveLength(1);
      const status = await p.dispatcher.status(id);
      expect(status!.events.filter((e: { type: string }) => e.type === 'lease_acquired')).toHaveLength(2);
      const stopped = exited(survivor);
      survivor.kill('SIGTERM');
      await stopped;
    }
    expect(p.stats.committed).toBe(2);
  }, 30_000);
});
