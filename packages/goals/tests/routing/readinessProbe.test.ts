import { describe, expect, it } from 'vitest';
import { createReadinessProbe } from '../../src/routing/index.js';
import { addHosted, addLocal, FakeAdapter, fleet, okScript } from './helpers.js';

describe('RuntimeReadinessProbe', () => {
  it('verifies readiness with a real tiny generation through the runtime adapter, using the runtime model id', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const adapter = new FakeAdapter(okScript);
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: adapter }, clock: f.clock });
    const r = await probe.probe({ modelId: 'm1' });
    expect(r.ready).toBe(true);
    expect(r.generation).toBe('verified');
    expect(r.toolUse).toBe('untested');
    expect(r.instanceId).toBe('m1@ollama');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].modelId).toBe('rt-m1');
    expect(adapter.requests[0].maxTokens).toBeLessThanOrEqual(32);
    expect(adapter.requests[0].executionLimits?.maxModelCalls).toBe(1);
    expect(probe.isFresh(r)).toBe(true);
  });

  it('caches successful results for the TTL and re-probes after expiry or when forced', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const adapter = new FakeAdapter(okScript);
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: adapter }, clock: f.clock, ttlMs: 60_000 });
    await probe.probe({ modelId: 'm1' });
    await probe.probe({ modelId: 'm1' });
    expect(adapter.requests).toHaveLength(1);
    await probe.probe({ modelId: 'm1' }, { force: true });
    expect(adapter.requests).toHaveLength(2);
    f.now.t += 61_000;
    expect(probe.isFresh(probe.status('m1', 'm1@ollama'))).toBe(false);
    await probe.probe({ modelId: 'm1' });
    expect(adapter.requests).toHaveLength(3);
  });

  it('deduplicates concurrent probes of the same instance', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const adapter = new FakeAdapter(async (req) => { await new Promise((r) => setTimeout(r, 10)); return okScript(req) as any; });
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: adapter }, clock: f.clock });
    const [a, b] = await Promise.all([probe.probe({ modelId: 'm1' }), probe.probe({ modelId: 'm1' })]);
    expect(a.ready && b.ready).toBe(true);
    expect(adapter.requests).toHaveLength(1);
  });

  it.each([
    ['runtime error event', () => [{ type: 'error', error: 'HTTP 500 model crashed' }], /HTTP 500/],
    ['empty answer', () => [{ type: 'completed' }], /empty answer/],
    ['reasoning only', () => [{ type: 'reasoning', content: 'hmm' }, { type: 'completed' }], /reasoning but no answer/],
    ['stream without completion', () => [{ type: 'token', content: 'O' }], /without completion/],
    ['adapter throws', () => { throw new Error('ECONNREFUSED 127.0.0.1:11434'); }, /ECONNREFUSED/],
  ])('reports not-ready on %s', async (_name, script, pattern) => {
    const f = fleet();
    addLocal(f, 'm1');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: new FakeAdapter(script as any) }, clock: f.clock });
    const r = await probe.probe({ modelId: 'm1' });
    expect(r.ready).toBe(false);
    expect(r.generation).toBe('failed');
    expect(r.reason).toMatch(pattern);
    expect(probe.isFresh(probe.status('m1'))).toBe(false);
  });

  it('times out a hung generation and aborts it', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const adapter = new FakeAdapter(() => 'hang');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: adapter }, clock: f.clock, timeoutMs: 30 });
    const r = await probe.probe({ modelId: 'm1' });
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/timed out after 30ms/);
    expect(adapter.requests[0].signal?.aborted).toBe(true);
  });

  it('verifies tool use for tool-declaring models and reports a model that answers in text instead as failed', async () => {
    const f = fleet();
    addLocal(f, 'tools-ok', { extra: { toolCalling: true } });
    addLocal(f, 'tools-bad', { extra: { toolCalling: true } });
    const probe = createReadinessProbe({
      models: f.models, runtimes: f.runtimes, clock: f.clock,
      adapters: (id) => (id === 'ollama' ? new FakeAdapter((req) => (req.modelId === 'rt-tools-bad' ? [{ type: 'token', content: 'OK' }, { type: 'completed' }] : okScript(req) as any)) : undefined),
    });
    const good = await probe.probe({ modelId: 'tools-ok' });
    const bad = await probe.probe({ modelId: 'tools-bad' });
    expect(good.toolUse).toBe('verified');
    expect(bad.ready).toBe(true);
    expect(bad.toolUse).toBe('failed');
  });

  it('never probes a hosted instance (no paid calls) and does not cache that as a failure', async () => {
    const f = fleet();
    addHosted(f, 'claude-x');
    const adapter = new FakeAdapter(okScript, 'anthropic');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { anthropic: adapter }, clock: f.clock });
    const r = await probe.probe({ modelId: 'claude-x', instanceId: 'claude-x@anthropic' });
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/never call paid/);
    expect(adapter.requests).toHaveLength(0);
    expect(probe.status('claude-x')).toBeUndefined();
  });

  it('refuses a local-looking instance whose adapter is a hosted provider', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const adapter = new FakeAdapter(okScript, 'openai');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: adapter }, clock: f.clock });
    expect((await probe.probe({ modelId: 'm1' })).ready).toBe(false);
    expect(adapter.requests).toHaveLength(0);
  });

  it('invalidate() forces re-verification and records never let older evidence overwrite newer', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, adapters: { ollama: new FakeAdapter(okScript) }, clock: f.clock });
    const r = await probe.probe({ modelId: 'm1' });
    f.now.t += 1000;
    probe.invalidate('m1', undefined, 'execution failed');
    expect(probe.isFresh(probe.status('m1', 'm1@ollama'))).toBe(false);
    probe.record(r); // older than the invalidation
    expect(probe.status('m1', 'm1@ollama')!.ready).toBe(false);
  });

  it('reports missing adapters and unregistered models without throwing', async () => {
    const f = fleet();
    addLocal(f, 'm1');
    const probe = createReadinessProbe({ models: f.models, runtimes: f.runtimes, clock: f.clock });
    expect((await probe.probe({ modelId: 'm1' })).reason).toMatch(/no runtime adapter/);
    expect((await probe.probe({ modelId: 'nope' })).reason).toMatch(/not registered/);
  });
});
