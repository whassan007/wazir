import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountRegistry, DEFAULT_POLICY, ResourceLedger, TokenBudgetManager, type AccountConfig } from '../src/resources/index.js';

// Real OS processes sharing one SQLite ledger: what concurrent `wa` invocations do.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
let dir: string;
let worker: string;

const accounts: AccountConfig[] = [{
  id: 'A', provider: 'claude', kind: 'subscription', integration: 'vendor-cli', agents: ['A'],
  limits: [{ unit: 'tokens', window: '5h', limit: 20_000, source: 'configured' }],
}];

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-mp-'));
  worker = path.join(dir, 'worker.mjs');
  const esbuild = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  const r = spawnSync(esbuild, [path.join(here, 'fixtures/ledgerWorker.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${worker}`, '--log-level=error'], { shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr}`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (error) => resolve({ code: null, out, err: `${err}${error.message}` }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('ledger across real processes', () => {
  it('six processes racing for one budget admit exactly the limit, never more', async () => {
    const file = path.join(dir, 'race.db');
    new ResourceLedger(file).close(); // create the schema once, before the race
    const startAt = Date.now() + 1_500;
    const results = await Promise.all(Array.from({ length: 6 }, () => run(['race', file, JSON.stringify(accounts), String(startAt)])));
    expect(results.every((r) => r.code === 0)).toBe(true);
    const admitted = results.reduce((n, r) => n + JSON.parse(r.out).admitted, 0);
    expect(admitted).toBe(20); // 60 attempts × 1000 tokens against a 20000-token limit
    const ledger = new ResourceLedger(file);
    expect(ledger.reservedNow('A', 'tokens')).toBe(20_000);
    ledger.close();
  }, 30_000);

  it('a process killed between reservation and settlement is charged once, conservatively, even when several processes recover at once', async () => {
    const file = path.join(dir, 'kill.db');
    new ResourceLedger(file).close();
    const p = spawn(process.execPath, [worker, 'reserve-and-hang', file, JSON.stringify(accounts), 'req-killed'], { env: { ...process.env, LEASE_MS: '500' } });
    const line = await new Promise<string>((resolve) => p.stdout.once('data', (d) => resolve(String(d).trim())));
    expect(line).toBe('admitted');
    p.kill('SIGKILL');
    await new Promise((r) => p.on('exit', r));
    await new Promise((r) => setTimeout(r, 700)); // lease expires

    const startAt = Date.now() + 1_000;
    const recoverers = await Promise.all(Array.from({ length: 4 }, () => run(['recover', file, JSON.stringify(accounts), String(startAt)])));
    expect(recoverers.every((r) => r.code === 0), JSON.stringify(recoverers)).toBe(true);
    expect(recoverers.reduce((n, r) => n + JSON.parse(r.out).recovered, 0)).toBe(1);

    const ledger = new ResourceLedger(file);
    const rows = ledger.usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: 'req-killed', inputTokens: 4_000, outputTokens: 1_000, source: 'conservative' });
    expect(ledger.events({ kind: 'expired' })).toHaveLength(1);
    expect(ledger.events({ kind: 'duplicate_settle' })).toHaveLength(0);
    ledger.close();
  }, 30_000);
});

describe('lease heartbeat', () => {
  it('a long-running request keeps its reservation; without the heartbeat it would be recovered mid-flight', () => {
    vi.useFakeTimers();
    try {
      let clock = Date.UTC(2026, 9, 12);
      const ledger = new ResourceLedger(':memory:', () => clock);
      const budget = new TokenBudgetManager(ledger, new AccountRegistry(accounts), { ...DEFAULT_POLICY, enforce: true, estimateMargin: 0, leaseMs: 60_000 });
      const admit = (id: string) => budget.admit({ requestId: id, accountId: 'A', modelId: 'agent:A', workload: 'critical-review', estimatedInputTokens: 1_000, estimatedOutputTokens: 0 });

      expect(admit('held').outcome).toBe('admitted');
      expect(admit('unheld').outcome).toBe('admitted');
      const stop = budget.holdLease('held');
      for (let i = 0; i < 30; i++) { clock += 10_000; vi.advanceTimersByTime(10_000); } // 5 minutes

      expect(ledger.recoverExpired()).toBe(1); // only the unheld one
      expect(ledger.getReservation('held')?.status).toBe('active');
      expect(ledger.getReservation('unheld')?.status).toBe('settled');
      expect(ledger.inFlight('A')).toBe(1);

      stop();
      expect(budget.reconcile('held', { inputTokens: 900, outputTokens: 300, source: 'estimated' })).toBe(true);
      expect(ledger.events({ kind: 'duplicate_settle' })).toHaveLength(0);
      ledger.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
