import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GenerationEvent, GenerationRequest, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import {
  AccountRegistry, DEFAULT_POLICY, ResourceLedger, TokenBudgetManager, governAdapter, validateResourceConfig,
  type AccountConfig, type ResourcePolicy,
} from '../src/resources/index.js';

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
let clock = T0;
let dir: string;
// These scenarios exercise enforcement, which is opt-in (policy.enforce defaults to false).
const policy = (p: Partial<ResourcePolicy> = {}): ResourcePolicy => ({ ...DEFAULT_POLICY, enforce: true, estimateMargin: 0, ...p });

function setup(accounts: AccountConfig[], p: Partial<ResourcePolicy> = {}, file = ':memory:') {
  const ledger = new ResourceLedger(file, () => clock);
  return { ledger, budget: new TokenBudgetManager(ledger, new AccountRegistry(accounts), policy(p)) };
}

const sub = (id: string, tokens: number, extra: Partial<AccountConfig> = {}): AccountConfig => ({
  id, provider: 'claude', kind: 'subscription', integration: 'vendor-cli', agents: [id],
  limits: [{ unit: 'tokens', window: '5h', limit: tokens, source: 'configured' }], ...extra,
});
const local: AccountConfig = { id: 'dgx', provider: 'lmstudio', kind: 'local', integration: 'local-endpoint', runtimeIds: ['lmstudio'], maxConcurrent: 1 };
const api: AccountConfig = {
  id: 'api', provider: 'openai', kind: 'api', integration: 'api-key', runtimeIds: ['openai'],
  pricing: { inputPerMTok: 2, outputPerMTok: 8 },
};

let n = 0;
const ask = (budget: TokenBudgetManager, accountId: string, input: number, output: number, extra: Record<string, unknown> = {}) =>
  budget.admit({ requestId: `r${++n}`, accountId, modelId: 'm', workload: 'routine', estimatedInputTokens: input, estimatedOutputTokens: output, ...extra } as any);

/** Scripted runtime adapter: yields the given events (or throws), records requests. */
function fakeAdapter(id: string, script: (req: GenerationRequest) => Array<GenerationEvent | Error>) {
  const seen: GenerationRequest[] = [];
  const adapter = {
    id, type: 'other',
    async *generate(req: GenerationRequest) {
      seen.push(req);
      for (const e of script(req)) {
        if (e instanceof Error) throw e;
        yield e;
      }
    },
    async healthCheck() { return { status: 'healthy' as const }; },
  } as unknown as RuntimeAdapter;
  return { adapter, seen };
}

async function drain(it: AsyncIterable<GenerationEvent>) {
  const out: GenerationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => { clock = T0; n = 0; dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-res-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('default policy: limits are not enforced', () => {
  it('admits past quotas, cooldowns and the paid gate, but still accounts every request', () => {
    const { budget, ledger } = setup([sub('A', 1_000), api], { enforce: false });
    expect(DEFAULT_POLICY.enforce).toBe(false);
    for (let i = 0; i < 5; i++) expect(ask(budget, 'A', 1_000, 0).outcome).toBe('admitted');
    ledger.setHealth('api', 'auth_blocked', undefined, 'test');
    const paid = ask(budget, 'api', 10, 10);
    expect(paid.outcome).toBe('admitted');
    expect(paid.reasons.join(' ')).toMatch(/limits not enforced/);
    expect(ledger.reservedNow('A', 'tokens')).toBe(5_000);
  });

  it('the emergency stop still applies (an operator switch, not a limit)', () => {
    const { budget } = setup([sub('A', 1_000), local], { enforce: false });
    budget.emergencyStop('test');
    expect(ask(budget, 'A', 1, 1).outcome).toBe('blocked');
    expect(ask(budget, 'dgx', 1, 1).outcome).toBe('admitted');
  });
});

describe('subscription quotas', () => {
  it('admits separate credentials against one shared provider quota atomically', () => {
    const shared = { quotaGroup: 'claude-team', limits: [{ unit: 'tokens' as const, window: '5h', limit: 1_000, source: 'configured' as const }] };
    const { budget } = setup([sub('A', 1_000, shared), sub('B', 1_000, shared)]);
    expect(ask(budget, 'A', 700, 0, { workload: 'critical-review' }).outcome).toBe('admitted');
    expect(ask(budget, 'B', 300, 0, { workload: 'critical-review' }).outcome).toBe('admitted');
    expect(ask(budget, 'A', 1, 0, { workload: 'critical-review' }).outcome).toBe('deferred');
  });

  it('labels paid accounting as advisory when enforcement is disabled', () => {
    const { budget } = setup([api], { enforce: false });
    const decision = ask(budget, 'api', 10, 10);
    expect(decision.outcome).toBe('admitted');
    expect(decision.reasons.join(' ')).toContain('paid-account authorization is advisory');
  });

  it('1. two subscriptions with different quotas are enforced independently', () => {
    const { budget } = setup([sub('A', 10_000), sub('B', 3_000)]);
    expect(ask(budget, 'A', 2_000, 1_000).outcome).toBe('admitted');
    expect(ask(budget, 'B', 2_000, 500).outcome).toBe('admitted');
    expect(ask(budget, 'B', 1_000, 0).outcome).toBe('deferred');
    expect(ask(budget, 'A', 1_000, 0).outcome).toBe('admitted');
  });

  it('2. an account approaching its limit is reserved for complex work', () => {
    const { budget } = setup([sub('A', 10_000)]);
    expect(ask(budget, 'A', 8_000, 0).outcome).toBe('admitted');
    // 8,000 + 1,600 = 96% -> critical mode
    const routine = ask(budget, 'A', 1_600, 0);
    expect(routine).toMatchObject({ outcome: 'blocked', mode: 'critical' });
    expect(routine.reasons.join(' ')).toMatch(/critical mode/);
    expect(ask(budget, 'A', 500, 0, { workload: 'critical-review' }).outcome).toBe('admitted');
  });

  it('2b. conservation mode admits complex work and refuses routine work', () => {
    const { budget: b2 } = setup([sub('A', 100_000)]);
    expect(ask(b2, 'A', 85_000, 0, { workload: 'complex' }).outcome).toBe('admitted');
    expect(ask(b2, 'A', 100, 0).reasons.join(' ')).toMatch(/conservation mode/);
    expect(ask(b2, 'A', 100, 0, { workload: 'complex' }).outcome).toBe('admitted');
  });

  it('3. both subscriptions exhausted: deferred with a retry time, nothing silently substituted', () => {
    const { budget } = setup([sub('A', 1_000), sub('B', 1_000)]);
    ask(budget, 'A', 1_000, 0, { workload: 'critical-review' });
    ask(budget, 'B', 1_000, 0, { workload: 'critical-review' });
    for (const id of ['A', 'B']) {
      const d = ask(budget, id, 10, 0, { workload: 'critical-review' });
      expect(d.outcome).toBe('deferred');
      expect(d.accountId).toBe(id);
      expect(d.retryAt).toBeGreaterThan(clock);
    }
  });

  it('9. unknown limits are handled explicitly per policy', () => {
    const unknown = (policyName: 'allow' | 'conserve' | 'deny') =>
      sub(`u-${policyName}`, 0, { limits: [{ unit: 'requests', window: '5h', limit: null, source: 'estimated' }], unknownLimitPolicy: policyName });
    const { budget } = setup([unknown('allow'), unknown('conserve'), unknown('deny')]);
    const allowed = ask(budget, 'u-allow', 10, 10);
    expect(allowed.outcome).toBe('admitted');
    expect(allowed.reasons.join(' ')).toMatch(/limit unknown/);
    expect(ask(budget, 'u-conserve', 10, 10).outcome).toBe('blocked');
    expect(ask(budget, 'u-conserve', 10, 10, { workload: 'complex' }).outcome).toBe('admitted');
    const denied = ask(budget, 'u-deny', 10, 10);
    expect(denied.outcome).toBe('blocked'); // waiting cannot make an unknown limit known
    expect(denied.retryAt).toBeUndefined();
  });

  it('10. quota resets at the window boundary', () => {
    const { budget } = setup([sub('A', 1_000, { limits: [{ unit: 'tokens', window: 'day', limit: 1_000, source: 'configured' }] })]);
    budget.reconcile(ask(budget, 'A', 900, 100, { workload: 'critical-review' }).requestId, { inputTokens: 900, outputTokens: 100, source: 'provider-reported' });
    const blocked = ask(budget, 'A', 10, 0, { workload: 'critical-review' });
    expect(blocked.outcome).toBe('deferred');
    expect(blocked.retryAt).toBe(Date.UTC(2026, 9, 13));
    clock = Date.UTC(2026, 9, 13, 0, 0, 1);
    expect(ask(budget, 'A', 10, 0).outcome).toBe('admitted');
  });

  it('20. a rolling window releases usage as it ages out (long workflows across windows)', () => {
    const { budget } = setup([sub('A', 1_000)]);
    budget.reconcile(ask(budget, 'A', 1_000, 0, { workload: 'critical-review' }).requestId, { inputTokens: 1_000, outputTokens: 0, source: 'provider-reported' });
    expect(ask(budget, 'A', 100, 0, { workload: 'critical-review' }).outcome).toBe('deferred');
    clock += 5 * 3_600_000 + 1;
    expect(ask(budget, 'A', 100, 0).outcome).toBe('admitted');
  });
});

describe('local inference (DGX Spark)', () => {
  it('4. local accounts admit routine work without token limits', () => {
    const { budget } = setup([local]);
    expect(ask(budget, 'dgx', 50_000, 8_000).outcome).toBe('admitted');
  });

  it('6b. GPU concurrency: a second request queues until the first finishes', async () => {
    const { budget, ledger } = setup([local], { localQueueTimeoutMs: 5_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const slow = {
      id: 'lmstudio', type: 'lmstudio',
      async *generate() {
        calls++;
        if (calls === 1) await gate;
        yield { type: 'completed', usage: { inputTokens: 5, outputTokens: 5 } } as GenerationEvent;
      },
    } as unknown as RuntimeAdapter;
    const governed = governAdapter(slow, { budget, resolveAccount: () => 'dgx', sleep: () => new Promise((r) => setTimeout(r, 2)) });
    const first = drain(governed.generate({ modelId: 'm', messages: [{ role: 'user', content: 'a' }] }));
    await new Promise((r) => setTimeout(r, 5));
    expect(ledger.inFlight('dgx')).toBe(1);
    const second = drain(governed.generate({ modelId: 'm', messages: [{ role: 'user', content: 'b' }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.at(-1)?.type).toBe('completed');
    expect(b.at(-1)?.type).toBe('completed');
    expect(calls).toBe(2);
  });

  it('5. local endpoint unavailable: refused connection is released, not charged', async () => {
    const { budget, ledger } = setup([local]);
    const { adapter } = fakeAdapter('lmstudio', () => [{ type: 'error', failureClass: 'TRANSPORT', error: 'connect ECONNREFUSED 127.0.0.1:1234' }]);
    const events = await drain(governAdapter(adapter, { budget, resolveAccount: () => 'dgx' }).generate({ modelId: 'm', messages: [{ role: 'user', content: 'x' }] }));
    expect(events.at(-1)?.type).toBe('error');
    expect(ledger.usageRows()).toHaveLength(0);
    expect(ledger.inFlight('dgx')).toBe(0);
  });

  it('6. GPU out-of-memory before output is released and passed through', async () => {
    const { budget, ledger } = setup([local]);
    const { adapter } = fakeAdapter('lmstudio', () => [{ type: 'error', status: 500, failureClass: 'SERVER', error: 'CUDA out of memory' }]);
    const events = await drain(governAdapter(adapter, { budget, resolveAccount: () => 'dgx' }).generate({ modelId: 'm', messages: [{ role: 'user', content: 'x' }] }));
    expect(events.at(-1)?.error).toContain('out of memory');
    expect(ledger.usageRows()).toHaveLength(0);
  });
});

describe('concurrency and durability', () => {
  it('7. concurrent agents in separate processes cannot double-spend one budget', () => {
    const file = path.join(dir, 'ledger.db');
    const accounts = [sub('A', 10_000)];
    // Two independent connections to one file = two Wazir processes.
    const p1 = setup(accounts, {}, file);
    const p2 = setup(accounts, {}, file);
    const results = [];
    for (let i = 0; i < 20; i++) results.push(ask(i % 2 ? p1.budget : p2.budget, 'A', 1_000, 0, { workload: 'critical-review' }));
    const admitted = results.filter((r) => r.outcome === 'admitted');
    expect(admitted).toHaveLength(10);
    expect(p1.ledger.reservedNow('A', 'tokens')).toBe(10_000);
    p1.ledger.close(); p2.ledger.close();
  });

  it('11/17. a restart recovers abandoned reservations once, conservatively', () => {
    const file = path.join(dir, 'ledger.db');
    const before = setup([sub('A', 100_000)], { leaseMs: 60_000 }, file);
    const d = ask(before.budget, 'A', 4_000, 1_000);
    expect(d.outcome).toBe('admitted');
    before.ledger.close(); // process dies mid-request
    clock += 61_000;
    const after = setup([sub('A', 100_000)], { leaseMs: 60_000 }, file);
    expect(after.ledger.recoverExpired()).toBe(1);
    expect(after.ledger.recoverExpired()).toBe(0);
    const rows = after.ledger.usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: d.requestId, inputTokens: 4_000, outputTokens: 1_000, source: 'conservative' });
    expect(after.ledger.reservedNow('A', 'tokens')).toBe(0);
    after.ledger.close();
  });

  it('13. duplicate reconciliation (retried callback) never charges twice', () => {
    const { budget, ledger } = setup([sub('A', 100_000)]);
    const d = ask(budget, 'A', 100, 100);
    expect(budget.reconcile(d.requestId, { inputTokens: 90, outputTokens: 40, source: 'provider-reported' })).toBe(true);
    expect(budget.reconcile(d.requestId, { inputTokens: 90, outputTokens: 40, source: 'provider-reported' })).toBe(false);
    expect(ledger.usageRows()).toHaveLength(1);
    expect(ledger.events({ kind: 'duplicate_settle' })).toHaveLength(1);
  });

  it('18. reconciliation replaces the reservation with actuals and calibrates estimates', () => {
    const { budget, ledger } = setup([sub('A', 100_000)]);
    const d = ask(budget, 'A', 1_000, 500);
    expect(ledger.reservedNow('A', 'tokens')).toBe(1_500);
    budget.reconcile(d.requestId, { inputTokens: 1_300, outputTokens: 200, source: 'provider-reported' }, { rawEstimatedInput: 1_000 });
    expect(ledger.reservedNow('A', 'tokens')).toBe(0);
    expect(ledger.usedSince('A', 'tokens', T0)).toBe(1_500);
    expect(ledger.calibration('m').ratio).toBeCloseTo(1.3);
  });

  it('audit trail is append-only', () => {
    const { budget, ledger } = setup([sub('A', 100_000)]);
    ask(budget, 'A', 1, 1);
    expect(() => ledger.db.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(() => ledger.db.exec("UPDATE events SET kind = 'x'")).toThrow(/append-only/);
  });
});

describe('provider failures through the governed adapter', () => {
  const run = (budget: TokenBudgetManager, events: Array<GenerationEvent | Error>) =>
    drain(governAdapter(fakeAdapter('openai', () => events).adapter, { budget, resolveAccount: () => 'api' }).generate({ modelId: 'm', messages: [{ role: 'user', content: 'hello' }] }));

  it('8. HTTP 429 with Retry-After starts a cooldown, honoured by admission', async () => {
    const { budget } = setup([{ ...api, allowPaid: true }]);
    await run(budget, [{ type: 'error', status: 429, failureClass: 'RATE_LIMIT', retryAfterMs: 20_000, error: 'rate limited' }]);
    const d = ask(budget, 'api', 10, 10);
    expect(d.outcome).toBe('deferred');
    expect(d.retryAt).toBe(T0 + 20_000);
    clock += 20_001;
    expect(ask(budget, 'api', 10, 10).outcome).toBe('admitted');
  });

  it('19. authentication failure blocks the account until an operator resets it; never retried', async () => {
    const { budget, ledger } = setup([{ ...api, allowPaid: true }]);
    await run(budget, [{ type: 'error', status: 401, failureClass: 'AUTH_FAILED', error: 'invalid api key' }]);
    clock += 24 * 3_600_000;
    const d = ask(budget, 'api', 10, 10);
    expect(d.outcome).toBe('blocked');
    expect(d.reasons.join(' ')).toMatch(/failed authentication/);
    expect(ledger.usageRows()).toHaveLength(0);
    budget.resetHealth('api');
    expect(ask(budget, 'api', 10, 10).outcome).toBe('admitted');
  });

  it('quota exhaustion from the provider blocks until its reset', async () => {
    const { budget } = setup([{ ...api, allowPaid: true }]);
    await run(budget, [{ type: 'error', status: 429, failureClass: 'QUOTA_EXHAUSTED', retryAfterMs: 3_600_000, error: 'insufficient_quota' }]);
    expect(ask(budget, 'api', 10, 10).outcome).toBe('deferred');
    clock += 3_600_001;
    expect(ask(budget, 'api', 10, 10).outcome).toBe('admitted');
  });

  it('12. an interrupted stream is charged conservatively (the provider may have billed it)', async () => {
    const { budget, ledger } = setup([{ ...api, allowPaid: true }]);
    await run(budget, [{ type: 'token', content: 'partial ' }, { type: 'error', failureClass: 'TRANSPORT', error: 'socket hang up' }]);
    const [row] = ledger.usageRows();
    expect(row.source).toBe('conservative');
    expect(row.outputTokens).toBeGreaterThan(0);
    expect(ledger.events({ kind: 'ambiguous' })).toHaveLength(1);
  });

  it('14. missing provider usage is recorded as an estimate, never as provider-reported', async () => {
    const { budget, ledger } = setup([{ ...api, allowPaid: true }]);
    await run(budget, [{ type: 'token', content: 'answer text' }, { type: 'completed', content: 'answer text' }]);
    expect(ledger.usageRows()[0].source).toBe('estimated');
  });

  it('records provider-reported usage, cached tokens and cost', async () => {
    const { budget, ledger } = setup([{ ...api, allowPaid: true, pricing: { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 } }]);
    await run(budget, [{ type: 'completed', usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 } }]);
    const [row] = ledger.usageRows();
    expect(row).toMatchObject({ source: 'provider-reported', cachedInputTokens: 500_000 });
    expect(row.costUsd).toBeCloseTo(0.5 * 2 + 0.5 * 0.5 + 0.1 * 8);
  });

  it('rate-limit headers reporting zero remaining start a cooldown until their reset', async () => {
    const { budget } = setup([{ ...api, allowPaid: true }]);
    const reset = new Date(T0 + 45_000).toISOString();
    await run(budget, [{ type: 'completed', usage: { inputTokens: 1, outputTokens: 1 }, rateLimit: { source: 'provider-headers', remainingRequests: 0, resetRequestsAt: reset } }]);
    expect(ask(budget, 'api', 1, 1)).toMatchObject({ outcome: 'deferred', retryAt: T0 + 45_000 });
  });

  it('refused requests never reach the provider', async () => {
    const { budget } = setup([api]); // paid API, not authorised
    const { adapter, seen } = fakeAdapter('openai', () => [{ type: 'completed' }]);
    const events = await drain(governAdapter(adapter, { budget, resolveAccount: () => 'api' }).generate({ modelId: 'm', messages: [{ role: 'user', content: 'x' }] }));
    expect(seen).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: 'error', failureClass: 'POLICY_DENIED' });
    expect(events[0].error).toMatch(/paid fallback is not authorized/);
  });
});

describe('policy controls', () => {
  it('15. capability mismatch is refused before dispatch (context window, workload)', () => {
    const { budget } = setup([{ ...local, contextLimits: { m: 8_192 }, workloads: ['routine', 'summarization'] }]);
    expect(ask(budget, 'dgx', 8_000, 1_000).reasons.join(' ')).toMatch(/context is 8192/);
    expect(ask(budget, 'dgx', 10, 10, { workload: 'critical-review' }).reasons.join(' ')).toMatch(/does not serve/);
  });

  it('emergency stop blocks cloud dispatch only', () => {
    const { budget } = setup([sub('A', 100_000), local]);
    budget.emergencyStop('test');
    expect(ask(budget, 'A', 1, 1).reasons.join(' ')).toMatch(/emergency stop/);
    expect(ask(budget, 'dgx', 1, 1).outcome).toBe('admitted');
    budget.resume();
    expect(ask(budget, 'A', 1, 1).outcome).toBe('admitted');
  });

  it('paid spend ceilings and per-task token budgets are enforced', () => {
    const { budget } = setup([{ ...api, allowPaid: true }], { dailySpendUsd: 1, maxTaskTokens: 5_000 });
    expect(ask(budget, 'api', 100_000, 100_000).outcome).toBe('admitted'); // $1.00
    expect(ask(budget, 'api', 10_000, 0).reasons.join(' ')).toMatch(/daily paid spend ceiling/);
    expect(ask(budget, 'api', 3_000, 0, { taskId: 't1' }).outcome).toBe('deferred'); // still over spend
    const { budget: b2 } = setup([sub('A', 1e9)], { maxTaskTokens: 5_000 });
    expect(ask(b2, 'A', 3_000, 0, { taskId: 't1' }).outcome).toBe('admitted');
    expect(ask(b2, 'A', 3_000, 0, { taskId: 't1' }).reasons.join(' ')).toMatch(/task token budget/);
  });

  it('validates configuration and rejects subscriptions used outside their vendor CLI', () => {
    expect(() => validateResourceConfig({ accounts: [{ id: 'x', provider: 'claude', kind: 'subscription', integration: 'api-key', agents: ['c'] }] }))
      .toThrow(/vendor CLI/);
    expect(() => validateResourceConfig({ accounts: [{ ...local, limits: [{ unit: 'tokens', window: 'fortnight', limit: 1, source: 'configured' }] }] }))
      .toThrow(/window must be/);
    expect(() => validateResourceConfig({ accounts: [{ ...api, env: { OPENAI_API_KEY: 'sk-live' } }] })).toThrow(/looks like a secret/);
  });
});

describe('routing', () => {
  // Imported lazily so the file's earlier suites stay independent of the router.
  const load = () => import('../src/resources/router.js');
  const hosted: AccountConfig = { ...api, allowPaid: true, pricing: { inputPerMTok: 3, outputPerMTok: 15 } };
  const resolve = (runtimeId: string) => (runtimeId === 'lmstudio' ? 'dgx' : runtimeId === 'openai' ? 'api' : undefined);
  const candidates = [
    { modelId: 'local-model', runtimeId: 'lmstudio', capabilityScore: 8 },
    { modelId: 'cloud-model', runtimeId: 'openai', capabilityScore: 10 },
  ];

  it('routine work prefers local inference (no cost, no quota risk)', async () => {
    const { ResourceRouter } = await load();
    const { budget } = setup([{ ...local, maxConcurrent: 2 }, hosted]);
    const out = new ResourceRouter({ budget, resolveAccount: resolve }).assess({ task: { id: 't' }, workload: 'routine', estimatedInputTokens: 2_000, candidates });
    const best = out.filter((a) => a.admissible).sort((a, b) => b.score! - a.score!)[0];
    expect(best.modelId).toBe('local-model');
  });

  it('16. an underperforming local model loses to a reliable alternative', async () => {
    const { ResourceRouter } = await load();
    const { budget, ledger } = setup([{ ...local, maxConcurrent: 2 }, hosted], { mode: 'quality-first' });
    for (let i = 0; i < 6; i++) ledger.appendEvent('provider_error', { accountId: 'dgx' }, { failureClass: 'SERVER' });
    ledger.settle({ requestId: 'ok', accountId: 'dgx', modelId: 'local-model', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0, source: 'provider-reported', at: clock, local: true });
    const out = new ResourceRouter({ budget, resolveAccount: resolve }).assess({ task: { id: 't' }, workload: 'routine', estimatedInputTokens: 2_000, candidates });
    const byModel = Object.fromEntries(out.map((a) => [a.modelId, a]));
    expect(byModel['local-model'].factors!.reliability).toBeLessThan(0.5);
    expect(byModel['cloud-model'].score!).toBeGreaterThan(byModel['local-model'].score!);
  });

  it('unauthorised paid APIs and emergency stop are hard constraints, not score penalties', async () => {
    const { ResourceRouter } = await load();
    const { budget } = setup([{ ...local, maxConcurrent: 2 }, api]);
    const out = new ResourceRouter({ budget, resolveAccount: resolve }).assess({ task: { id: 't' }, workload: 'complex', estimatedInputTokens: 2_000, candidates });
    const cloud = out.find((a) => a.modelId === 'cloud-model')!;
    expect(cloud.admissible).toBe(false);
    expect(cloud.reasons.join(' ')).toMatch(/paid fallback is not authorized/);
  });

  it('complex work is not silently substituted by a much weaker model', async () => {
    const { ResourceRouter } = await load();
    const { budget } = setup([{ ...local, maxConcurrent: 2 }, hosted]);
    const out = new ResourceRouter({ budget, resolveAccount: resolve }).assess({
      task: { id: 't' }, workload: 'complex', estimatedInputTokens: 2_000,
      candidates: [{ modelId: 'tiny', runtimeId: 'lmstudio', capabilityScore: 2 }, { modelId: 'cloud-model', runtimeId: 'openai', capabilityScore: 10 }],
    });
    expect(out.find((a) => a.modelId === 'tiny')).toMatchObject({ admissible: false });
    expect(out.find((a) => a.modelId === 'tiny')!.reasons.join(' ')).toMatch(/not substituted/);
  });

  it('classifies workloads from existing task signals', async () => {
    const { classifyWorkload } = await load();
    expect(classifyWorkload({ type: 'coding', priority: 'normal', input: 'add a unit test for parse()' } as any)).toBe('routine');
    expect(classifyWorkload({ type: 'architecture', priority: 'normal', input: 'x' } as any)).toBe('complex');
    expect(classifyWorkload({ type: 'review', priority: 'critical', input: 'final review' } as any)).toBe('critical-review');
    expect(classifyWorkload({ type: 'chat', priority: 'normal', input: 'Summarize this log' } as any)).toBe('summarization');
  });
});

describe('governed adapter instrumentation', () => {
  it('a wrapper assigned to generate wraps the governed call once (no double admission)', async () => {
    const { ledger, budget } = setup([local], { enforce: false });
    const { adapter, seen } = fakeAdapter('lmstudio', () => [{ type: 'token', content: 'hi' }, { type: 'completed', content: 'hi', usage: { inputTokens: 3, outputTokens: 1 } }]);
    const governed = governAdapter(adapter, { budget, resolveAccount: () => 'dgx' });
    const generate = governed.generate.bind(governed);
    let wrapped = 0;
    governed.generate = async function* (req: GenerationRequest) { wrapped++; yield* generate(req); };
    const events = await drain(governed.generate({ requestId: 'req-once', modelId: 'm', messages: [{ role: 'user', content: 'x' }] }));
    expect(events.map((e) => e.type)).toEqual(['token', 'completed']);
    expect(wrapped).toBe(1);
    expect(seen).toHaveLength(1);
    expect(ledger.getReservation('req-once')).toBeDefined();
  });

  it('a second admission of the same request id is refused plainly, not a SQLite error', () => {
    // Default policy (enforce=false) is what reached the unique constraint live.
    const { budget } = setup([local], { enforce: false });
    const req = { requestId: 'dup-1', accountId: 'dgx', modelId: 'm', workload: 'routine' as const, estimatedInputTokens: 1, estimatedOutputTokens: 1 };
    expect(budget.admit(req).outcome).toBe('admitted');
    const again = budget.admit(req);
    expect(again.outcome).toBe('blocked');
    expect(again.reasons.join(' ')).toContain('DUPLICATE_REQUEST_ID');
  });
});
