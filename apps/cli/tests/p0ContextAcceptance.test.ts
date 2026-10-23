import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEngine } from './support/contextFixtures.js';
import { InvocationContextAllocator, CONTEXT_PREFLIGHT_OVERFLOW } from '../src/contextAllocationRuntime.js';
import { runSubagent, type SubagentRunContext } from '../src/run.js';
import type { RookEngine } from '../src/engine.js';

/** Plain text sized roughly by the estimator; the exact token count is read back from allocation results. */
const text = (words: number) => 'lorem ipsum dolor sit amet '.repeat(words);

async function execFor(engine: RookEngine, modelId: string) {
  const record = await engine.executions.create({
    task: { id: 'task-acceptance', type: 'coding', input: 'acceptance', priority: 'normal', status: 'running', createdAt: new Date() } as any,
    agentId: 'wazir-coding', computerId: 'local', runtimeId: 'fake', modelId,
  });
  return record.execution.id;
}

describe('P0 acceptance: provider-specific accounting through InvocationContextAllocator.prepare', () => {
  let projectRoot: string;
  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('the same numbers fit under independent accounting but overflow under shared accounting', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-p0-acc-'));
    const base = { contextMax: 8_192, maxOutputTokens: 4_096, local: true, contextLimitSource: 'runtime-discovered' as const };
    const shared = await buildEngine(projectRoot, { ...base, contextAccounting: 'shared' });
    const independent = await buildEngine(projectRoot, { ...base, contextAccounting: 'independent' });
    const request = { modelId: 'fake-model', messages: [{ role: 'user', content: text(900) }], maxTokens: 4_096 };
    const placement = { runtimeId: 'fake', computerId: 'local' };

    const sharedPrepared = await new InvocationContextAllocator(shared.engine, await execFor(shared.engine, 'fake-model'), 4_096).prepare(request, placement);
    const independentPrepared = await new InvocationContextAllocator(independent.engine, await execFor(independent.engine, 'fake-model'), 4_096).prepare(request, placement);

    // Same estimated input on both sides; only the accounting differs.
    expect(sharedPrepared.allocation.estimatedInputTokens).toBe(independentPrepared.allocation.estimatedInputTokens);
    expect(sharedPrepared.allocation.estimatedInputTokens).toBeGreaterThan(4_000);
    expect(sharedPrepared.allocation.outcome).toBe('cannot-fit');
    expect(sharedPrepared.preflightError).toMatch(new RegExp(`^${CONTEXT_PREFLIGHT_OVERFLOW}`));
    expect(independentPrepared.allocation.outcome).toBe('fits');
    expect(independentPrepared.preflightError).toBeUndefined();
    expect(independentPrepared.maxTokens).toBe(4_096);
  });

  it('enforces maxInputTokens below the window, even when the window itself would fit', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-p0-acc-'));
    const base = { contextMax: 32_768, maxInputTokens: 8_000, maxOutputTokens: 1_024, local: true, contextAccounting: 'independent' as const, contextLimitSource: 'runtime-discovered' as const };
    const over = await buildEngine(projectRoot, base, { runtimeType: 'ollama' });
    const under = await buildEngine(projectRoot, base, { runtimeType: 'ollama' });
    const placement = { runtimeId: 'fake', computerId: 'local' };

    // Estimated input well above maxInputTokens: the window is 32K but the input side is capped at 8K.
    const overPrepared = await new InvocationContextAllocator(over.engine, await execFor(over.engine, 'fake-model'), 1_024).prepare(
      { modelId: 'fake-model', messages: [{ role: 'user', content: text(2_500) }], maxTokens: 1_024 },
      placement,
    );
    expect(overPrepared.allocation.outcome).toBe('cannot-fit');
    expect(overPrepared.allocation.reasons.some((r) => r.includes('maxInputTokens allows 8000'))).toBe(true);
    expect(overPrepared.preflightError).toBeDefined();

    // Well under the input cap: fits, and the window is sized to the request rather than the 32K maximum.
    const underPrepared = await new InvocationContextAllocator(under.engine, await execFor(under.engine, 'fake-model'), 1_024).prepare(
      { modelId: 'fake-model', messages: [{ role: 'user', content: text(200) }], maxTokens: 1_024 },
      placement,
    );
    expect(underPrepared.allocation.outcome).toBe('fits');
    expect(underPrepared.preflightError).toBeUndefined();
    expect(underPrepared.contextTokens!).toBeLessThan(32_768);
  });
});

describe('P0 acceptance: sub-agent invocations are sized and preflighted', () => {
  let projectRoot: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  async function runChild(engine: RookEngine, requests: Array<{ content: string; maxTokens: number }>) {
    const agent = engine.agents.get('wazir-coding')!;
    const childEvents: Array<Record<string, any>> = [];
    vi.spyOn(agent, 'run').mockImplementation(async function* (_req, runtime) {
      for (const r of requests) {
        for await (const e of runtime.generate({ modelId: 'fake-model', messages: [{ role: 'user', content: r.content }], maxTokens: r.maxTokens })) {
          childEvents.push(e as unknown as Record<string, any>);
        }
      }
      yield { kind: 'done', content: 'ok' } as never;
    });
    const parentExecutionId = await execFor(engine, 'fake-model');
    const context: SubagentRunContext = {
      parentExecutionId,
      parentTaskId: 'task-acceptance',
      projectRoot: engine.projectRoot,
      modelId: 'fake-model',
      runtimeId: 'fake',
      computerId: 'local',
      subagentDepth: 0,
      log: () => {},
      loader: { start: () => {}, stop: () => {}, setText: () => {}, clear: () => {} } as never,
      emitJson: () => {},
      signal: undefined,
    };
    const result = await runSubagent(engine, { description: 'a small sub-task' }, context);
    const childId = result.output.match(/execution ([^\s\]]+)/)?.[1];
    return { childId, childEvents, result };
  }

  it('a sub-agent request that cannot fit yields MODEL_CONTEXT_OVERFLOW and never reaches the provider', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-p0-sub-'));
    const { engine, requests } = await buildEngine(projectRoot, {
      contextMax: 8_192, maxOutputTokens: 2_048, local: true, contextAccounting: 'shared', contextLimitSource: 'runtime-discovered',
    });
    const { childId, childEvents } = await runChild(engine, [{ content: text(20_000), maxTokens: 512 }]);
    expect(requests).toHaveLength(0);
    const error = childEvents.find((e) => e.type === 'error');
    expect(error?.failureClass).toBe('MODEL_CONTEXT_OVERFLOW');
    expect(String(error?.error)).toMatch(/prompt is too long/);
    expect(childId).toBeTruthy();
    const allocated = engine.executions.require(childId!).events.filter((e) => (e.eventType ?? e.type) === 'context.allocated');
    expect(allocated.some((e) => (e.data as Record<string, unknown>).outcome === 'cannot-fit')).toBe(true);
  });

  it('a sub-agent request is clamped to the model output cap and sized to a window', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-p0-sub-'));
    const { engine, requests } = await buildEngine(projectRoot, {
      contextMax: 8_192, maxOutputTokens: 2_048, local: true, contextAccounting: 'shared', contextLimitSource: 'runtime-discovered',
    });
    const { childEvents } = await runChild(engine, [{ content: 'hi', maxTokens: 64_000 }]);
    expect(childEvents.some((e) => e.type === 'error')).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBe(2_048);
    expect(requests[0].contextTokens).toBeGreaterThan(0);
    expect(requests[0].contextTokens!).toBeLessThanOrEqual(8_192);
  });
});
