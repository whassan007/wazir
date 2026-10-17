import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import type { BenchmarkRunResult, BenchmarkTask, ExecutionRecord, ExperimentPlan, MetaOptimizationRunResult, OptimizableConfig } from '@wazir/core';
import { OptimizerStateManager, OPTIMIZER_STATE_KEY, type OptimizerState } from '../src/optimizerState.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { MetaOptimizerService, DEFAULT_OPTIMIZABLE_CONFIG } from '../src/metaOptimizerService.js';

const config = { id: 'baseline', version: 1 } as OptimizableConfig;
const budget = { maxExperiments: 10, maxCandidatesPerExperiment: 2, maxTokens: 10_000, maxModelCalls: 100, maxWallTimeMs: 60_000, maxMonetaryCostUSD: 10 };
const plan = (id = 'experiment'): ExperimentPlan => ({ experimentId: id, budget: { ...budget }, sampleSize: 1 } as ExperimentPlan);
function result(tokens = 20, calls = 1, cost = 0.01): BenchmarkRunResult {
  return {
    taskId: 'task', repetition: 0, durationMs: 1,
    scoreReport: { executionId: 'exec', passed: true, metrics: {
      inputTokens: tokens, outputTokens: 0, totalModelCalls: calls, costEstimateUsd: cost,
      rawMetrics: { tokenUsageAvailable: true, modelCallCountAvailable: true },
    } },
  } as unknown as BenchmarkRunResult;
}
async function qualified(manager: OptimizerStateManager, id = 'experiment', candidateId = 'candidate') {
  const experiment = plan(id);
  await manager.plan(experiment);
  const state = await manager.begin(experiment, config);
  const reservation = await manager.reserve(id, 'baseline/task/0', 'task', 0);
  await manager.complete(reservation.id, result());
  const candidate = { id: candidateId, version: 2 } as OptimizableConfig;
  const proof = {
    runId: `run-${id}`, experimentId: id, baselineConfig: config, candidateConfig: candidate,
    decision: 'QUALIFIED', regressionGuard: { qualified: true }, evaluatedAt: new Date(),
  } as MetaOptimizationRunResult;
  await manager.record(proof);
  await manager.finish(id);
  return { state, candidate, proof };
}
class FaultStore extends MemoryStore {
  reject?: (state: OptimizerState) => boolean;
  attempted?: OptimizerState;
  override async update<T>(key: string, mutate: (current: T | undefined) => T): Promise<T> {
    return super.update(key, (current) => {
      const next = mutate(current);
      if (key === OPTIMIZER_STATE_KEY && this.reject?.(next as OptimizerState)) {
        this.attempted = structuredClone(next) as OptimizerState;
        throw new Error('injected store failure');
      }
      return next;
    });
  }
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('durable optimizer state', () => {
  it('restores active configuration, budgets, candidates, history, receipts and rollback from disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wazir-optimizer-recovery-')); directories.push(dir);
    const file = path.join(dir, 'state.json');
    const manager = new OptimizerStateManager(new JsonFileStore(file), config, budget);
    const candidate = { candidateId: 'candidate', experimentId: 'experiment', config: { id: 'candidate', version: 2 } } as any;
    await manager.addCandidates(plan(), [candidate]);
    const proof = await qualified(manager);
    await manager.promote('candidate', proof.candidate, proof.proof);
    const restored = new OptimizerStateManager(new JsonFileStore(file), { id: 'wrong-default', version: 0 } as OptimizableConfig, { ...budget, maxTokens: 1_000_000 });
    const snapshot = await restored.read();
    expect(snapshot.activeConfig.id).toBe('candidate');
    expect(snapshot.budget.maxTokens).toBe(10_000);
    expect(snapshot.consumption).toMatchObject({ experimentsCount: 1, candidatesCount: 1, tokensCount: 20, modelCallsCount: 1, costUSD: 0.01 });
    expect(snapshot.history[0].runId).toBe('run-experiment');
    expect(Object.keys(snapshot.receipts)).toHaveLength(1);
    expect(snapshot.candidates.candidate.config.id).toBe('candidate');
    const rolledBack = await restored.rollback('run-experiment');
    expect(rolledBack.activeConfig).toEqual(config);
    expect((await new OptimizerStateManager(new JsonFileStore(file), config, budget).read()).activeConfig).toEqual(config);
  });

  it('keeps pending dispatches after restart and blocks automatic replay and new work', async () => {
    const store = new MemoryStore();
    const manager = new OptimizerStateManager(store, config, budget);
    await manager.begin(plan(), config);
    const reserved = await manager.reserve('experiment', 'baseline/task/0', 'task', 0);
    const restored = new OptimizerStateManager(store, config, budget);
    expect((await restored.read()).inFlight?.id).toBe(reserved.id);
    await expect(restored.begin(plan('new'), config)).rejects.toThrow('OPTIMIZER_SAMPLE_PENDING');
    await expect(restored.reserve('experiment', 'baseline/task/0', 'task', 0)).rejects.toThrow('OPTIMIZER_SAMPLE_PENDING');
    await restored.complete(reserved.id, result());
    await restored.complete(reserved.id, result()); // committed-write response retry
    expect((await restored.read()).consumption.tokensCount).toBe(20);
    await expect(restored.complete(reserved.id, result(21))).rejects.toThrow('RECEIPT_CONFLICT');
    await expect(restored.reserve('experiment', 'baseline/task/0', 'task', 0)).rejects.toThrow('ALREADY_RECORDED');
  });

  it('does not erase a running sample when another instance hydrates', async () => {
    const store = new MemoryStore();
    const first = new OptimizerStateManager(store, config, budget);
    const second = new OptimizerStateManager(store, config, budget);
    await first.begin(plan(), config);
    const reservation = await first.reserve('experiment', 'baseline/task/0', 'task', 0);
    await second.read();
    await expect(second.reserve('experiment', 'candidate/task/0', 'task', 0)).rejects.toThrow('SAMPLE_PENDING');
    await first.complete(reservation.id, result());
    expect((await second.read()).consumption.modelCallsCount).toBe(1);
  });

  it('allows only one concurrent promotion against a baseline revision', async () => {
    const store = new MemoryStore();
    const first = new OptimizerStateManager(store, config, budget);
    const a = await qualified(first, 'a', 'candidate-a');
    const second = new OptimizerStateManager(store, config, budget);
    const b = await qualified(second, 'b', 'candidate-b');
    const outcomes = await Promise.allSettled([
      first.promote('candidate-a', a.candidate, a.proof), second.promote('candidate-b', b.candidate, b.proof),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await first.read()).configRevision).toBe(1);
    expect((await first.read()).rollbacks).toHaveLength(1);
  });

  it('does not publish configuration or rollback metadata on a failed atomic write', async () => {
    const store = new FaultStore(); const manager = new OptimizerStateManager(store, config, budget);
    const candidate = await qualified(manager);
    store.reject = (s) => s.configRevision > 0;
    await expect(manager.promote('candidate', candidate.candidate, candidate.proof)).rejects.toThrow('injected');
    expect((await manager.read()).activeConfig).toEqual(config);
    expect((await manager.read()).rollbacks).toHaveLength(0);
  });

  it('preserves a pending reservation when accounting cannot be written', async () => {
    const store = new FaultStore(); const manager = new OptimizerStateManager(store, config, budget);
    await manager.begin(plan(), config);
    const reserved = await manager.reserve('experiment', 'baseline/task/0', 'task', 0);
    store.reject = (s) => Object.keys(s.receipts).length > 0;
    await expect(manager.complete(reserved.id, result())).rejects.toThrow('injected');
    const restored = new OptimizerStateManager(store, config, budget);
    expect((await restored.read()).inFlight?.id).toBe(reserved.id);
    expect((await restored.read()).consumption.tokensCount).toBe(0); // explicitly unresolved, not claimed as unused quota
    store.reject = undefined;
    await restored.complete(reserved.id, result());
    expect((await restored.read()).consumption.tokensCount).toBe(20);
  });

  it.each(['maxTokens', 'maxModelCalls', 'maxMonetaryCostUSD'] as const)('stops before dispatch when %s has no allowance', async (limit) => {
    const constrained = { ...budget, [limit]: 0 };
    const manager = new OptimizerStateManager(new MemoryStore(), config, constrained);
    await expect(manager.begin({ ...plan(), budget: constrained }, config)).rejects.toThrow('BUDGET_EXHAUSTED');
    expect((await manager.read()).inFlight).toBeUndefined();
  });

  it('preserves overspend diagnostics and prevents another sample after a runner exceeds its allowance', async () => {
    const manager = new OptimizerStateManager(new MemoryStore(), config, { ...budget, maxTokens: 10 });
    await manager.begin(plan(), config);
    const reserved = await manager.reserve('experiment', 'baseline/task/0', 'task', 0);
    expect(reserved.remaining.maxTokens).toBe(10);
    const completed = await manager.complete(reserved.id, result(20));
    expect(completed.consumption.tokensCount).toBe(20);
    expect(completed.experiments.experiment.status).toBe('STOPPED');
    expect(Object.values(completed.experiments.experiment.samples)).toHaveLength(1);
    await expect(manager.reserve('experiment', 'next', 'task', 1)).rejects.toThrow('NOT_RUNNING');
    await expect(manager.begin(plan('another'), config)).rejects.toThrow('BUDGET_EXHAUSTED');
  });

  it('marks absent usage unknown instead of treating it as free execution', async () => {
    const manager = new OptimizerStateManager(new MemoryStore(), config, budget);
    await manager.begin(plan(), config);
    const reserved = await manager.reserve('experiment', 'baseline/task/0', 'task', 0);
    const missing = result(); missing.scoreReport.metrics.rawMetrics!.tokenUsageAvailable = false;
    const state = await manager.complete(reserved.id, missing);
    expect(state.accountingUncertain).toBeDefined();
    await expect(manager.begin(plan('another'), config)).rejects.toThrow('ACCOUNTING_UNKNOWN');
  });

  it.each([[1.5, 1], [20, 0.5], [20, 0]])('treats contradictory or fractional usage (%s tokens / %s calls) as unknown', async (tokens, calls) => {
    const manager = new OptimizerStateManager(new MemoryStore(), config, budget);
    await manager.begin(plan(), config);
    const reserved = await manager.reserve('experiment', 'baseline/task/0', 'task', 0);
    const state = await manager.complete(reserved.id, result(tokens, calls));
    expect(state.accountingUncertain).toBeDefined();
    await expect(manager.begin(plan('another'), config)).rejects.toThrow('ACCOUNTING_UNKNOWN');
  });

  it('refuses configured GPU limits when GPU time cannot be measured', async () => {
    const manager = new OptimizerStateManager(new MemoryStore(), config, { ...budget, maxGPUTimeMs: 1 });
    await expect(manager.begin(plan(), config)).rejects.toThrow('GPU_ACCOUNTING_UNAVAILABLE');
  });

  it('reserves experiment and candidate counts atomically across instances', async () => {
    const store = new MemoryStore();
    const limit = { ...budget, maxExperiments: 1, maxCandidatesPerExperiment: 1 };
    const first = new OptimizerStateManager(store, config, limit);
    const second = new OptimizerStateManager(store, config, limit);
    const experiments = await Promise.allSettled([first.begin(plan('a'), config), second.begin(plan('b'), config)]);
    expect(experiments.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const p = { ...plan('c'), budget: limit };
    const candidates = await Promise.allSettled([
      first.addCandidates(p, [{ candidateId: 'c1', experimentId: 'c' } as any]),
      second.addCandidates(p, [{ candidateId: 'c2', experimentId: 'c' } as any]),
    ]);
    expect(candidates.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await first.read()).consumption.candidatesCount).toBe(1);
  });

  it('fails on corrupt state and read errors without replacing them with fresh counters', async () => {
    const store = new MemoryStore(); await store.put(OPTIMIZER_STATE_KEY, { schemaVersion: 99 });
    const manager = new OptimizerStateManager(store, config, budget);
    await expect(manager.read()).rejects.toThrow('INVALID_OPTIMIZER_STATE');
    expect(await store.get(OPTIMIZER_STATE_KEY)).toEqual({ schemaVersion: 99 });
    class Unreadable extends MemoryStore { override async get<T>(): Promise<T> { throw new Error('read failed'); } }
    await expect(new OptimizerStateManager(new Unreadable(), config, budget).read()).rejects.toThrow('read failed');
  });

  it('migrates legacy configuration/history while retaining unknown historical accounting', async () => {
    const store = new MemoryStore(); await store.put('meta_optimizer/active_config', { id: 'legacy', version: 3 });
    const manager = new OptimizerStateManager(store, config, budget);
    const state = await manager.read();
    expect(state.activeConfig.id).toBe('legacy');
    expect(state.accountingUncertain).toContain('Legacy');
    await expect(manager.begin(plan(), state.activeConfig)).rejects.toThrow('ACCOUNTING_UNKNOWN');
  });

  it('does not let force or operator approval substitute for qualification evidence', async () => {
    const optimizer = new MetaOptimizerService({ benchmarkService: new BenchmarkService(), store: new MemoryStore() });
    const candidate = { candidateId: 'unverified', config: { id: 'unverified', version: 2 }, strategy: 'ROUTING' } as any;
    const promotion = await optimizer.promoteCandidate(candidate, { force: true, operatorApproved: true });
    expect(promotion.success).toBe(false);
    expect(promotion.reason).toContain('QUALIFICATION_REQUIRED');
    expect(optimizer.getActiveConfig().id).toBe(DEFAULT_OPTIMIZABLE_CONFIG.id);
  });
});

describe('optimizer collection boundaries', () => {
  const task: BenchmarkTask = { id: 'task', name: 'Task', category: 'TOOL_USE', prompt: 'Task', description: 'Task', expectedFiles: ['fixed.ts'], mutationRequired: true };
  function setup(store = new FaultStore(), tokens = 20, delay = 0) {
    const benchmark = new BenchmarkService(); benchmark.register(task);
    let calls = 0; let observedBudget: unknown;
    const runner = { id: 'runner', name: 'Runner', async run(t: BenchmarkTask, context: any): Promise<ExecutionRecord> {
      calls++; observedBudget = context.resourceBudget;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        execution: { id: `exec-${calls}`, taskId: t.id, createdAt: new Date(), status: 'completed' }, task: { id: t.id, requirements: {} },
        policyDecisions: [], toolCalls: [], filesChanged: ['fixed.ts'], checks: [{ name: 'test', command: 'test', ok: true, durationMs: 1 }],
        errors: [], events: [], totalModelCalls: 1, usage: { input: tokens, output: 0 },
      } as unknown as ExecutionRecord;
    } };
    const optimizer = new MetaOptimizerService({ benchmarkService: benchmark, store, budget });
    const candidate = optimizer.proposeCandidate([{ type: 'PROMPT_TWEAK', path: 'prompts.test', oldValue: '', newValue: 'test', rationale: 'test' }]);
    return { optimizer, candidate, runner, store, benchmark, calls: () => calls, observedBudget: () => observedBudget };
  }

  it('writes the reservation before invoking a runner', async () => {
    const fixture = setup(); fixture.store.reject = (s) => !!s.inFlight;
    await expect(fixture.optimizer.evaluateCandidate(fixture.candidate, fixture.runner, [task])).rejects.toThrow('injected');
    expect(fixture.calls()).toBe(0);
    expect((await fixture.optimizer.getRecoveryState()).inFlight).toBeUndefined();
  });

  it('reconciles an accounting failure after restart without rerunning side effects', async () => {
    const fixture = setup(); fixture.store.reject = (s) => Object.keys(s.receipts).length > 0;
    await expect(fixture.optimizer.evaluateCandidate(fixture.candidate, fixture.runner, [task])).rejects.toThrow('injected');
    expect(fixture.calls()).toBe(1);
    const attempted = fixture.store.attempted!;
    const recordedResult = Object.values(Object.values(attempted.experiments)[0].samples)[0];
    fixture.store.reject = undefined;
    const restarted = new MetaOptimizerService({ benchmarkService: fixture.benchmark, store: fixture.store, budget });
    await restarted.hydrate();
    const state = await restarted.getRecoveryState();
    expect(state.inFlight).toBeDefined();
    expect(restarted.getConsumption().accountingStatus).toBe('pending');
    await restarted.reconcilePendingSample(state.inFlight!.id, recordedResult);
    await restarted.reconcilePendingSample(state.inFlight!.id, recordedResult);
    expect(restarted.getConsumption().tokensCount).toBe(20);
    expect(restarted.getConsumption().accountingStatus).toBe('complete');
    expect((await restarted.getRecoveryState()).inFlight).toBeUndefined();
    expect(fixture.calls()).toBe(1);
  });

  it('restores service history, counters and rollback after a qualified promotion', async () => {
    const fixture = setup();
    const source = fixture.runner.run;
    fixture.runner.run = async (t, context) => {
      const record = await source(t, context);
      if (context.config.id !== DEFAULT_OPTIMIZABLE_CONFIG.id) record.usage!.input = 10;
      return record;
    };
    const run = await fixture.optimizer.evaluateCandidate(fixture.candidate, fixture.runner, [task], { repetitions: 10 });
    expect(run.decision).toBe('ACCEPTED');
    const restarted = new MetaOptimizerService({ benchmarkService: fixture.benchmark, store: fixture.store });
    await restarted.hydrate();
    expect(restarted.getActiveConfig().id).toBe(fixture.candidate.config.id);
    expect(restarted.getHistory()[0].runId).toBe(run.runId);
    expect(restarted.getConsumption().tokensCount).toBe(300);
    expect(restarted.getConsumption().modelCallsCount).toBe(20);
    expect((await restarted.rollback(run.runId)).id).toBe(DEFAULT_OPTIMIZABLE_CONFIG.id);
  });

  it('keeps the service baseline when a promotion write fails', async () => {
    const fixture = setup();
    const source = fixture.runner.run;
    fixture.runner.run = async (t, context) => {
      const record = await source(t, context);
      if (context.config.id !== DEFAULT_OPTIMIZABLE_CONFIG.id) record.usage!.input = 10;
      return record;
    };
    fixture.store.reject = (s) => s.configRevision > 0;
    await expect(fixture.optimizer.evaluateCandidate(fixture.candidate, fixture.runner, [task], { repetitions: 10 })).rejects.toThrow('injected');
    expect(fixture.optimizer.getActiveConfig().id).toBe(DEFAULT_OPTIMIZABLE_CONFIG.id);
    expect((await fixture.optimizer.getRecoveryState()).rollbacks).toHaveLength(0);
    expect(fixture.optimizer.getHistory()[0].regressionGuard?.qualified).toBe(true);
  });

  it('surfaces synchronous plan persistence failures before execution', async () => {
    const fixture = setup(); fixture.store.reject = () => true;
    fixture.optimizer.designExperiment({ hypothesis: {
      id: 'hypothesis', targetComponent: 'test', domain: 'prompts', proposedChange: 'test',
      expectedMetricEffect: { metric: 'input_tokens', direction: 'decrease', expectedDelta: -1 },
      possibleRegressions: [], requiredBenchmark: [], successThreshold: 1,
    } });
    await expect(fixture.optimizer.flush()).rejects.toThrow('injected');
    await expect(fixture.optimizer.evaluateCandidate(fixture.candidate, fixture.runner, [task])).rejects.toThrow('injected');
    expect(fixture.calls()).toBe(0);
  });

  it('passes remaining limits and stops at the next dispatch boundary', async () => {
    const fixture = setup(undefined, 10_001);
    await expect(fixture.optimizer.evaluateCandidate(fixture.candidate, fixture.runner, [task])).rejects.toThrow('BUDGET_EXHAUSTED');
    expect(fixture.calls()).toBe(1);
    expect(fixture.observedBudget()).toMatchObject({ maxTokens: 10_000, maxModelCalls: 100 });
    const state = await fixture.optimizer.getRecoveryState();
    expect(state.consumption.tokensCount).toBe(10_001);
    expect(Object.values(state.experiments)[0].samples).toBeDefined();
  });

  it('does not accept a late result from a runner that ignores cancellation', async () => {
    const fixture = setup(undefined, 1, 80);
    const short = new MetaOptimizerService({ benchmarkService: fixture.benchmark, budget: { ...budget, maxWallTimeMs: 30 } });
    await expect(short.evaluateCandidate(fixture.candidate, fixture.runner, [task])).rejects.toThrow();
    expect(fixture.calls()).toBe(1);
    const state = await short.getRecoveryState();
    expect(state.accountingUncertain).toBeDefined();
    expect(Object.values(Object.values(state.experiments)[0].samples)[0].scoreReport.passed).toBe(false);
  });
});
