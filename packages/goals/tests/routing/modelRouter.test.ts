import { describe, expect, it } from 'vitest';
import { ModelReliabilityTracker } from '@wazir/core';
import { createModelRouter, createReadinessProbe, isFleetModelRouter, ROUTING_STORE_KEYS, type FleetModelRouter } from '../../src/routing/index.js';
import { addHosted, addLocal, FakeAdapter, fleet, okScript, ready, type Fleet } from './helpers.js';

const local0 = { requiredCapabilities: [], remainingHostedBudgetUsd: 0, localFirst: true };

function router(f: Fleet, extra: Partial<Parameters<typeof createModelRouter>[0]> = {}): FleetModelRouter {
  return createModelRouter({ store: f.store, clock: f.clock, workspaceRoot: '/tmp/ws', models: f.models, runtimes: f.runtimes, computers: f.computers, ...extra });
}

describe('createModelRouter: verified readiness', () => {
  it('never routes to a model that only reports healthy/READY without a successful probe', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const r = router(f);
    expect(f.models.isModelReady('m1')).toBe(true); // registry says READY+healthy
    const d = await r.route(local0);
    expect(d).toBeUndefined();
    const ex = await r.explain(local0);
    expect(ex.candidates[0].rejection).toMatch(/not verified ready: never probed/);
  });

  it('routes after a successful local probe and explains the decision', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const r = router(f, { adapters: { ollama: new FakeAdapter(okScript) } });
    await r.probeLocal();
    const d = (await r.route(local0))!;
    expect(d.modelId).toBe('m1');
    expect(d.runtimeId).toBe('ollama');
    expect(d.computerId).toBe('local');
    expect(d.hosted).toBe(false);
    expect(d.estimatedCostUsd).toBe(0);
    expect(d.reasons.join('\n')).toMatch(/verified ready by probe/);
    expect(d.rejected).toEqual([]);
    expect(isFleetModelRouter(r)).toBe(true);
  });

  it('rejects a failed probe and a stale (expired TTL) probe', async () => {
    const f = fleet();
    addLocal(f, 'bad');
    addLocal(f, 'old');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock, ttlMs: 60_000 });
    probe.record(ready(f, 'bad', 'bad@ollama', { ready: false, generation: 'failed', reason: 'generation failed: HTTP 500' }));
    probe.record(ready(f, 'old', 'old@ollama'));
    f.now.t += 120_000;
    const r = router(f, { probe });
    const ex = await r.explain(local0);
    expect(ex.decision).toBeUndefined();
    const by = Object.fromEntries(ex.candidates.map((c) => [c.modelId, c.rejection]));
    expect(by.bad).toMatch(/not verified ready: generation failed: HTTP 500/);
    expect(by.old).toMatch(/exceeds TTL 60s/);
  });

  it('does not route to instances on offline computers, unavailable runtimes, or draining instances', async () => {
    const f = fleet();
    addLocal(f, 'remote-m', { runtimeId: 'ollama-remote', computerId: 'remote' });
    addLocal(f, 'rt-down', { runtimeId: 'lmstudio' });
    addLocal(f, 'draining', { state: 'DRAINING' });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    for (const [m, i] of [['remote-m', 'remote-m@ollama-remote'], ['rt-down', 'rt-down@lmstudio'], ['draining', 'draining@ollama']]) probe.record(ready(f, m, i));
    f.computers.setOffline('remote');
    f.runtimes.setHealth('lmstudio', 'unavailable');
    const ex = await router(f, { probe }).explain(local0);
    expect(ex.decision).toBeUndefined();
    const by = Object.fromEntries(ex.candidates.map((c) => [c.modelId, c.rejection]));
    expect(by['remote-m']).toMatch(/computer 'remote' is offline/);
    expect(by['rt-down']).toMatch(/runtime 'lmstudio' unavailable/);
    expect(by.draining).toMatch(/instance draining/);
  });
});

describe('createModelRouter: capabilities', () => {
  function setup() {
    const f = fleet();
    addLocal(f, 'small', { extra: { contextMax: 8192 } });
    addLocal(f, 'tooly', { extra: { toolCalling: true, contextMax: 131072, capabilities: ['coding', 'agenticExecution'] } });
    addLocal(f, 'tooly-unverified', { extra: { toolCalling: true, contextMax: 131072 } });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'small', 'small@ollama'));
    probe.record(ready(f, 'tooly', 'tooly@ollama', { toolUse: 'verified' }));
    probe.record(ready(f, 'tooly-unverified', 'tooly-unverified@ollama', { toolUse: 'failed' }));
    return { f, r: router(f, { probe }) };
  }

  it('requires probe-verified tool use, not just declared support', async () => {
    const { r } = setup();
    const ex = await r.explain({ ...local0, requiredCapabilities: ['toolCalling'] });
    expect(ex.decision!.modelId).toBe('tooly');
    const by = Object.fromEntries(ex.decision!.rejected.map((x) => [x.modelId, x.reason]));
    expect(by.small).toMatch(/does not declare support/);
    expect(by['tooly-unverified']).toMatch(/not verified by a readiness tool probe \(failed\)/);
  });

  it('enforces the context window and declared capabilities', async () => {
    const { r } = setup();
    const d = (await r.route({ ...local0, requiredCapabilities: ['context:32k', 'agenticExecution'] }))!;
    expect(d.modelId).toBe('tooly');
    const by = Object.fromEntries(d.rejected.map((x) => [x.modelId, x.reason]));
    expect(by.small).toMatch(/context 8192 < required 32768/);
    expect(by['tooly-unverified']).toMatch(/capability 'agenticExecution' missing/);
    expect(await r.route({ ...local0, requiredCapabilities: ['context:1m'] })).toBeUndefined();
    expect((await r.explain({ ...local0, requiredCapabilities: ['context:lots'] })).candidates[0].rejection).toMatch(/invalid capability/);
  });

  it('uses the runtime-reported context window over the model maximum', async () => {
    const f = fleet();
    addLocal(f, 'm', { extra: { contextMax: 131072 }, contextTokens: 4096 });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'm', 'm@ollama'));
    const ex = await router(f, { probe }).explain({ ...local0, requiredCapabilities: ['context>=16000'] });
    expect(ex.candidates[0].rejection).toMatch(/context 4096 < required 16000/);
  });
});

describe('createModelRouter: hosted budget and local-first', () => {
  function setup(pricing = true) {
    const f = fleet();
    addLocal(f, 'local-m', { loaded: false });
    addHosted(f, 'claude-x');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'local-m', 'local-m@ollama', { latencyMs: 9000 }));
    probe.record(ready(f, 'claude-x', 'claude-x@anthropic', { source: 'execution', latencyMs: 10 }));
    const r = router(f, { probe, pricing: pricing ? (id) => (id === 'claude-x' ? { inputPerMTok: 3, outputPerMTok: 15 } : undefined) : undefined });
    return { f, r, probe };
  }

  it('remaining hosted budget 0 never routes hosted, even when it would score higher', async () => {
    const { r } = setup();
    const d = (await r.route({ requiredCapabilities: [], remainingHostedBudgetUsd: 0, localFirst: false }))!;
    expect(d.modelId).toBe('local-m');
    expect(d.rejected.find((x) => x.modelId === 'claude-x')!.reason).toMatch(/remaining hosted budget is \$0/);
  });

  it('local-first prefers any eligible local model over hosted; without it the better-scoring hosted model wins', async () => {
    const { r } = setup();
    const lf = (await r.route({ requiredCapabilities: [], remainingHostedBudgetUsd: 5, localFirst: true }))!;
    expect(lf.modelId).toBe('local-m');
    expect(lf.rejected.find((x) => x.modelId === 'claude-x')!.reason).toMatch(/local-first policy prefers local model 'local-m'/);
    const open = (await r.route({ requiredCapabilities: [], remainingHostedBudgetUsd: 5, localFirst: false }))!;
    expect(open.modelId).toBe('claude-x');
    expect(open.hosted).toBe(true);
    expect(open.estimatedCostUsd).toBeCloseTo((8000 * 3 + 2000 * 15) / 1e6, 6);
  });

  it('rejects hosted when cost exceeds the remaining budget or pricing is unknown', async () => {
    const { r } = setup();
    const ex = await r.explain({ requiredCapabilities: [], remainingHostedBudgetUsd: 0.01, localFirst: false });
    expect(ex.candidates.find((c) => c.modelId === 'claude-x')!.rejection).toMatch(/exceeds remaining hosted budget \$0.01/);
    const { r: r2 } = setup(false);
    const ex2 = await r2.explain({ requiredCapabilities: [], remainingHostedBudgetUsd: 100, localFirst: false });
    expect(ex2.candidates.find((c) => c.modelId === 'claude-x')!.rejection).toMatch(/no known pricing/);
  });

  it('a hosted model with no execution evidence is never treated as verified ready', async () => {
    const f = fleet();
    addHosted(f, 'claude-x');
    const r = router(f, { pricing: () => ({ inputPerMTok: 1, outputPerMTok: 1 }) });
    const ex = await r.explain({ requiredCapabilities: [], remainingHostedBudgetUsd: 100, localFirst: false });
    expect(ex.decision).toBeUndefined();
    expect(ex.candidates[0].rejection).toMatch(/hosted models are never probed/);
  });

  it('capability "local" excludes hosted instances', async () => {
    const { r } = setup();
    const d = (await r.route({ requiredCapabilities: ['local'], remainingHostedBudgetUsd: 5, localFirst: false }))!;
    expect(d.modelId).toBe('local-m');
  });

  it('prefers local Qwen coding models when ready over other local models with equal readiness and residency', async () => {
    const f = fleet();
    addLocal(f, 'alpha-llama', { extra: { family: 'llama' } });
    addLocal(f, 'qwen2.5-coder:32b', { extra: { family: 'qwen' } });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'alpha-llama', 'alpha-llama@ollama'));
    probe.record(ready(f, 'qwen2.5-coder:32b', 'qwen2.5-coder:32b@ollama'));
    const r = router(f, { probe });
    const d = (await r.route(local0))!;
    expect(d.modelId).toBe('qwen2.5-coder:32b');
    expect(d.reasons.join('\n')).toMatch(/local Qwen coding model preference/);
  });

  it('registers models and optional instances/readiness via registerModel()', async () => {
    const f = fleet();
    const r = router(f);
    const entry = await r.registerModel!({
      id: 'qwen2.5-coder:14b',
      name: 'Qwen 2.5 Coder 14B',
      provider: 'ollama',
      local: true,
      toolCalling: true,
      capabilities: ['coding', 'agenticExecution'],
      instance: { runtimeId: 'ollama', computerId: 'local', loaded: true, state: 'READY' },
      readiness: { ready: true, latencyMs: 42, toolUse: 'verified' },
    });
    expect(entry.modelId).toBe('qwen2.5-coder:14b');
    expect(entry.readiness.ready).toBe(true);
    const d = (await r.route({ ...local0, requiredCapabilities: ['toolCalling', 'agenticExecution'] }))!;
    expect(d.modelId).toBe('qwen2.5-coder:14b');
  });
});

describe('createModelRouter: exclusions, reliability, determinism', () => {
  it('honours excludeModelIds with an explicit reason', async () => {
    const f = fleet();
    addLocal(f, 'a');
    addLocal(f, 'b');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'a', 'a@ollama'));
    probe.record(ready(f, 'b', 'b@ollama'));
    const d = (await router(f, { probe }).route({ ...local0, excludeModelIds: ['a'] }))!;
    expect(d.modelId).toBe('b');
    expect(d.rejected).toEqual([{ modelId: 'a', reason: 'excluded by caller (already tried or explicitly excluded)' }]);
  });

  it('breaks equal scores lexicographically and stays stable across calls and registration order', async () => {
    const f = fleet();
    for (const id of ['zeta', 'alpha', 'mid']) addLocal(f, id);
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    for (const id of ['zeta', 'alpha', 'mid']) probe.record(ready(f, id, `${id}@ollama`));
    const r = router(f, { probe });
    const picks = await Promise.all([1, 2, 3].map(() => r.route(local0)));
    expect(picks.map((p) => p!.modelId)).toEqual(['alpha', 'alpha', 'alpha']);
    expect(picks[0]!.rejected.map((x) => x.modelId)).toEqual(['mid', 'zeta']);
    expect(picks[0]!.rejected[0].reason).toMatch(/tie at score/);
  });

  it('an OPEN reliability circuit removes the model from routing', async () => {
    const f = fleet();
    addLocal(f, 'flaky');
    addLocal(f, 'steady');
    const reliability = new ModelReliabilityTracker({ minSamples: 2, window: 4 });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'flaky', 'flaky@ollama'));
    probe.record(ready(f, 'steady', 'steady@ollama', { latencyMs: 5000 }));
    for (let i = 0; i < 2; i++) reliability.record({ modelId: 'flaky', taskClass: 'goal-studio', success: false, reason: 'NO_PROGRESS', at: f.clock() });
    const d = (await router(f, { probe, reliability }).route(local0))!;
    expect(d.modelId).toBe('steady');
    expect(d.rejected[0]).toMatchObject({ modelId: 'flaky' });
    expect(d.rejected[0].reason).toMatch(/reliability: circuit open/);
  });

  it('measured success history and latency change the ranking', async () => {
    const f = fleet();
    addLocal(f, 'a');
    addLocal(f, 'b');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'a', 'a@ollama'));
    probe.record(ready(f, 'b', 'b@ollama'));
    const r = router(f, { probe });
    const first = (await r.route(local0))!;
    expect(first.modelId).toBe('a');
    const bDecision = { ...first, modelId: 'b', instanceId: 'b@ollama' };
    for (let i = 0; i < 3; i++) await r.recordOutcome({ decision: bDecision, ok: true, latencyMs: 200 });
    for (let i = 0; i < 3; i++) await r.recordOutcome({ decision: first, ok: false, latencyMs: 9000, terminationReason: 'VERIFICATION_FAILED' });
    probe.record(ready(f, 'a', 'a@ollama')); // re-verified after the invalidations
    const next = (await r.route(local0))!;
    expect(next.modelId).toBe('b');
    expect(next.reasons.join('\n')).toMatch(/measured success 100% over 3 routed runs/);
  });
});

describe('createModelRouter: outcomes, fallback, accounting', () => {
  function setup() {
    const f = fleet();
    addLocal(f, 'a');
    addLocal(f, 'b', { loaded: false });
    const r = router(f, { adapters: { ollama: new FakeAdapter(okScript) } });
    return { f, r };
  }

  it('fallback re-routes excluding the failed model and invalidates its readiness', async () => {
    const { r } = setup();
    await r.probeLocal();
    const first = (await r.route(local0))!;
    expect(first.modelId).toBe('a');
    const next = (await r.fallback({ ...local0, failed: first, error: 'runtime crashed: HTTP 500', latencyMs: 1200 }))!;
    expect(next.modelId).toBe('b');
    expect(next.reasons[0]).toBe("fallback after runtime crashed: HTTP 500 (from 'a')");
    expect(next.rejected.find((x) => x.modelId === 'a')!.reason).toMatch(/excluded by caller/);
    // Even without the exclusion, 'a' needs a fresh verification after failing.
    const plain = await r.explain(local0);
    expect(plain.candidates.find((c) => c.modelId === 'a')!.rejection).toMatch(/readiness invalidated: routed execution failed/);
    // A non-attributable failure (runtime crash) does not count against the model's circuit.
    const acct = (await r.accounting()).find((a) => a.modelId === 'a')!;
    expect(acct).toMatchObject({ routes: 1, failures: 1, attributableSamples: 0 });
  });

  it('fallback returns undefined when nothing else is verified ready', async () => {
    const f = fleet();
    addLocal(f, 'only');
    const r = router(f, { adapters: { ollama: new FakeAdapter(okScript) } });
    await r.probeLocal();
    const d = (await r.route(local0))!;
    expect(await r.fallback({ ...local0, failed: d, error: { code: 'EXECUTION_FAILED', message: 'boom', retryable: true } })).toBeUndefined();
  });

  it('records estimated vs actual cost/latency, persists outcomes, and hydrates a fresh router', async () => {
    const { f, r } = setup();
    await r.probeLocal();
    const d = (await r.route(local0))!;
    expect(d.estimatedLatencyMs).toBeGreaterThanOrEqual(0);
    const out = await r.recordOutcome({ decision: d, ok: true, latencyMs: 1500, runId: 'run1', targetId: 'T1', attemptId: 'att1' });
    expect(out).toMatchObject({ modelId: 'a', ok: true, attributable: true, estimatedCostUsd: 0, actualCostUsd: 0, actualLatencyMs: 1500, runId: 'run1' });
    expect(out.estimatedLatencyMs).toBe(d.estimatedLatencyMs);
    const stored = await f.store.list(ROUTING_STORE_KEYS.outcomesPrefix);
    expect(stored).toHaveLength(1);
    // The success is fresh readiness evidence from a real execution.
    expect(r.readiness.status('a', 'a@ollama')).toMatchObject({ ready: true, source: 'execution' });

    const r2 = router(f); // no adapters: relies on persisted state
    const acct = (await r2.accounting()).find((a) => a.modelId === 'a')!;
    expect(acct).toMatchObject({ routes: 1, successes: 1, avgActualLatencyMs: 1500 });
    expect((await r2.route(local0))!.estimatedLatencyMs).toBe(1500);
  });

  it('a successful outcome on a hosted route is accounted at its estimate when no actual cost is reported', async () => {
    const f = fleet();
    addHosted(f, 'claude-x');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    probe.record(ready(f, 'claude-x', 'claude-x@anthropic', { source: 'execution' }));
    const r = router(f, { probe, pricing: () => ({ inputPerMTok: 1, outputPerMTok: 1 }) });
    const d = (await r.route({ requiredCapabilities: [], remainingHostedBudgetUsd: 1, localFirst: true }))!;
    expect(d.hosted).toBe(true);
    await r.recordOutcome({ decision: d, ok: true, latencyMs: 10 });
    await r.recordOutcome({ decision: d, ok: true, latencyMs: 10, actualCostUsd: 0.5 });
    const acct = (await r.accounting()).find((a) => a.modelId === 'claude-x')!;
    expect(acct.estimatedCostUsd).toBeCloseTo(0.02, 6);
    expect(acct.actualCostUsd).toBeCloseTo(0.51, 6);
  });
});

describe('createModelRouter: resources and fleet', () => {
  it('rejects loading a non-resident local model that does not fit available memory', async () => {
    const f = fleet();
    addLocal(f, 'huge', { loaded: false, runtimeId: 'ollama-remote', computerId: 'remote', extra: { memory: { minSystemGB: 100 } } });
    f.computers.heartbeat('remote', { load: { cpuPercent: 10, memoryUsedGB: 100, memoryAvailableGB: 28 } as any });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: () => new Date() });
    probe.record({ ...ready(f, 'huge', 'huge@ollama-remote'), checkedAt: new Date().toISOString() });
    const ex = await router(f, { probe, clock: () => new Date() }).explain(local0);
    expect(ex.candidates[0].rejection).toMatch(/resources: remote has 28.0GB available < 100GB/);
  });

  it('fleet() summarises models, readiness, reliability, runtimes and computer resources', async () => {
    const f = fleet();
    addLocal(f, 'a');
    addHosted(f, 'claude-x');
    const r = router(f, { adapters: { ollama: new FakeAdapter(okScript) } });
    const sweep = await r.probeLocal();
    expect(sweep.probed.map((p) => p.modelId)).toEqual(['a']);
    expect(sweep.skipped).toEqual([{ modelId: 'claude-x', instanceId: 'claude-x@anthropic', reason: 'hosted: never probed (no paid calls)' }]);
    const snap = await r.fleet();
    expect(snap.summary).toMatchObject({ models: 2, verifiedReady: 1, hosted: 1, computers: 2 });
    const a = snap.models.find((m) => m.modelId === 'a')!;
    expect(a.readiness).toMatchObject({ ready: true, fresh: true });
    expect(a.instances[0].readiness?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(a.reliability.state).toBe('CLOSED');
    expect(snap.models.find((m) => m.modelId === 'claude-x')!.readiness.reason).toBe('never verified');
    expect(snap.runtimes.find((x) => x.id === 'anthropic')!.kind).toBe('hosted');
    expect(snap.computers.find((c) => c.id === 'local')!.resources!.totalMemoryGB).toBe(64);
    expect(snap.computers.find((c) => c.id === 'local')!.heartbeat).toBe('local');
  });
});
