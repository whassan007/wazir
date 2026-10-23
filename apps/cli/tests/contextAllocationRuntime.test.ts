import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEngine } from './support/contextFixtures.js';
import { executeTask, planTask } from '../src/run.js';
import type { RookEngine } from '../src/engine.js';

type DriverResult = { events: Array<Record<string, unknown>>[] };

/** Replaces the agent loop with a driver that issues the given requests through the real runtime.generate. */
async function drive(
  engine: RookEngine,
  requests: Array<{ messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>; maxTokens?: number }>,
): Promise<{ executionId: string; out: DriverResult }> {
  const out: DriverResult = { events: [] };
  const agent = engine.agents.get('wazir-coding')!;
  vi.spyOn(agent, 'run').mockImplementation(async function* (_req, runtime) {
    for (const r of requests) {
      const events: Array<Record<string, unknown>> = [];
      for await (const e of runtime.generate({ modelId: 'fake-model', messages: r.messages, maxTokens: r.maxTokens })) {
        events.push(e as unknown as Record<string, unknown>);
      }
      out.events.push(events);
    }
  });
  const outcome = await executeTask(engine, 'write a hello file', { quiet: true });
  return { executionId: outcome.executionId, out };
}

const allEvents = (engine: RookEngine, id: string, type: string) =>
  engine.executions.require(id).events.filter((e) => (e.eventType ?? e.type) === type).map((e) => e.data as Record<string, any>);

describe('native context allocation wired into executeTask', () => {
  let projectRoot: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });
  const root = async () => (projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-ctxalloc-')));

  it('a simple task on a 1M hosted-style model gets a small window and a capped max_tokens', async () => {
    const { engine, requests } = await buildEngine(await root(), {
      contextMax: 1_000_000, maxOutputTokens: 8192, local: false, contextAccounting: 'shared', contextLimitSource: 'provider-documented',
    });
    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });
    expect(outcome.success).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.maxTokens!).toBeLessThanOrEqual(8192);
      expect(r.contextTokens).toBeUndefined(); // hosted: no per-request context size
    }
    const allocated = allEvents(engine, outcome.executionId, 'context.allocated');
    expect(allocated.length).toBe(requests.length);
    for (const a of allocated) {
      expect(a.allocatedWindowTokens).toBeLessThanOrEqual(8192);
      expect(a.allocatedWindowTokens).toBeLessThan(1_000_000);
      expect(a.limitSource).toBe('provider-documented');
    }
  });

  it('local configurable 32K model: contextTokens grows with the conversation, never shrinks, never exceeds 32768', async () => {
    const { engine, requests } = await buildEngine(await root(), {
      contextMax: 32_768, maxOutputTokens: 4096, local: true, contextAccounting: 'shared', contextLimitSource: 'runtime-discovered',
    }, { runtimeType: 'ollama' });
    const filler = (chars: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, chars);
    const msg = (c: string) => ({ role: 'user' as const, content: c });
    // small, big, small again, huge-but-fitting, small
    await drive(engine, [
      { messages: [msg('hi')], maxTokens: 512 },
      { messages: [msg(filler(30_000))], maxTokens: 512 },
      { messages: [msg('hi')], maxTokens: 512 },
      { messages: [msg(filler(80_000))], maxTokens: 512 },
      { messages: [msg('hi')], maxTokens: 512 },
    ]);
    const sent = requests.map((r) => r.contextTokens!);
    expect(sent).toHaveLength(5);
    for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeGreaterThanOrEqual(sent[i - 1]);
    expect(sent[0]).toBeLessThan(sent[3]);
    expect(Math.max(...sent)).toBeLessThanOrEqual(32_768);
  });

  it('a cannot-fit request never reaches the provider and yields a MODEL_CONTEXT_OVERFLOW error the agent recognises', async () => {
    const { engine, requests } = await buildEngine(await root(), {
      contextMax: 16_384, maxOutputTokens: 2048, local: true, contextAccounting: 'shared', contextLimitSource: 'runtime-discovered',
    });
    const huge = 'x'.repeat(400_000);
    const { out } = await drive(engine, [{ messages: [{ role: 'user', content: huge }], maxTokens: 512 }]);
    expect(requests).toHaveLength(0);
    const events = out.events[0];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].failureClass).toBe('MODEL_CONTEXT_OVERFLOW');
    const msg = String(events[0].error);
    expect(msg).toMatch(/^CONTEXT_PREFLIGHT_OVERFLOW: .*requires \d+ tokens, available 16384 \(source runtime-discovered\)/);
    // The CodingAgent's overflow-recovery pattern keys on message wording.
    expect(msg).toMatch(/prompt is too long/i);
  });

  it('clamps a request max_tokens that is larger than the model output cap', async () => {
    const { engine, requests } = await buildEngine(await root(), {
      contextMax: 200_000, maxOutputTokens: 4096, local: false, contextAccounting: 'shared', contextLimitSource: 'provider-documented',
    });
    await drive(engine, [{ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64_000 }]);
    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBe(4096);
  });

  it('unknown limits flow through the conservative 8192/2048 policy and a small task still completes', async () => {
    const { engine, requests } = await buildEngine(await root(), {
      contextMax: 131_072, local: false, contextLimitSource: 'default-unknown',
    });
    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });
    expect(outcome.success).toBe(true);
    for (const r of requests) expect(r.maxTokens!).toBeLessThanOrEqual(2048);
    const allocated = allEvents(engine, outcome.executionId, 'context.allocated');
    expect(allocated.length).toBeGreaterThan(0);
    for (const a of allocated) {
      expect(a.conservativePolicyApplied).toBe(true);
      expect(a.limitSource).toBe('default-unknown');
      expect(a.allocatedWindowTokens).toBeLessThanOrEqual(8192);
      expect(a.maxOutputTokens).toBeLessThanOrEqual(2048);
    }
  });

  it('getContextTokens reports the usable window, not the per-call target', async () => {
    const { engine } = await buildEngine(await root(), {
      contextMax: 65_536, maxOutputTokens: 4096, local: true, contextAccounting: 'shared', contextLimitSource: 'runtime-discovered',
    });
    const run = vi.spyOn(engine.agents.get('wazir-coding')!, 'run');
    await executeTask(engine, 'write a hello file', { quiet: true });
    expect(run.mock.calls[0][1].getContextTokens?.()).toBe(65_536);
  });

  it('context.usage records provider-reported usage, and leaves actuals undefined when none is reported', async () => {
    const root1 = await root();
    const reported = await buildEngine(root1, { contextMax: 32_768, maxOutputTokens: 4096, local: true, contextLimitSource: 'runtime-discovered' });
    const o1 = await executeTask(reported.engine, 'write a hello file', { quiet: true });
    const u1 = allEvents(reported.engine, o1.executionId, 'context.usage');
    expect(u1.length).toBeGreaterThan(0);
    expect(u1[0]).toMatchObject({ modelId: 'fake-model', actualInputTokens: 111, actualOutputTokens: 7, actualReasoningTokens: 3 });
    expect(u1[0].estimatedInputTokens).toBeGreaterThan(0);
    expect(u1[0].inputEstimateRatio).toBeCloseTo(111 / u1[0].estimatedInputTokens, 5);

    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-ctxalloc-'));
    try {
      const silent = await buildEngine(root2, { contextMax: 32_768, maxOutputTokens: 4096, local: true, contextLimitSource: 'runtime-discovered' }, { usage: false });
      const o2 = await executeTask(silent.engine, 'write a hello file', { quiet: true });
      const u2 = allEvents(silent.engine, o2.executionId, 'context.usage');
      expect(u2.length).toBeGreaterThan(0);
      for (const u of u2) {
        expect(u.actualInputTokens).toBeUndefined();
        expect(u.actualOutputTokens).toBeUndefined();
        expect(u.actualReasoningTokens).toBeUndefined();
        expect(u.inputEstimateRatio).toBeUndefined();
        expect(u.estimatedInputTokens).toBeGreaterThan(0);
      }
    } finally {
      await fs.rm(root2, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('planTask shrinks the output reserve to fit a fixed 8K context, and still refuses a prompt that cannot fit', async () => {
    const spec = { contextMax: 8192, maxOutputTokens: 2048, local: true, contextAccounting: 'shared' as const, contextLimitSource: 'operator-configured' as const };
    // Fits once tool schemas and safety are reserved only if the output reserve gives way (floor 1024).
    const fitted = await planTask((await buildEngine(await root(), spec)).engine, 'refactor everything. ' + 'detail '.repeat(1000));
    expect(fitted.ok).toBe(true);
    if (fitted.ok) {
      expect(fitted.plan.allocation!.maxOutputTokens).toBeLessThan(2048);
      expect(fitted.plan.allocation!.maxOutputTokens).toBeGreaterThanOrEqual(1024);
      expect(fitted.plan.allocation!.reasons.some((r) => r.includes('output reserve reduced'))).toBe(true);
    }
    // Too large for the window at any output reserve: refused before any provider call, with required vs available.
    const refused = await planTask((await buildEngine(await root(), spec)).engine, 'refactor everything. ' + 'detail '.repeat(1400));
    expect(refused.ok).toBe(false);
    if (refused.ok === false) expect(refused.reasons.join(' | ')).toMatch(/context 8192 < required \d+/);
  });

  it('planTask attaches the initial allocation (small window on a large model)', async () => {
    const { engine } = await buildEngine(await root(), {
      contextMax: 1_000_000, maxOutputTokens: 8192, local: false, contextLimitSource: 'provider-documented',
    });
    const planned = await planTask(engine, 'write a hello file');
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.plan.allocation?.outcome).toBe('fits');
      expect(planned.plan.allocation!.allocatedWindowTokens).toBeLessThan(1_000_000);
      expect(planned.plan.context.available.tokens).toBe(1_000_000);
    }
  });
});
