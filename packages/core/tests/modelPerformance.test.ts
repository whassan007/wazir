import { describe, expect, it } from 'vitest';
import { measureModelPerformance } from '../src/services/modelPerformance.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { Scheduler } from '../src/services/scheduler.js';
import { ComputerRegistry, RuntimeRegistry, type ExecutionRecord, type ModelPerformanceProfile } from '@wazir/core';

/**
 * Phase 15: model capability metrics are measured from durable execution evidence
 * (typed terminations, route changes, revision-stamped checks, tool calls,
 * timestamps) — never from model claims or hard-coded scores — and then used in routing.
 */
let n = 0;
function run(opts: {
  model: string;
  reason?: string;
  finalModel?: string;
  checks?: Array<{ name: 'build' | 'test'; ok: boolean }>;
  toolCalls?: number;
  durationMs?: number;
  metrics?: { actionAttempts: number; validActions: number };
  escalatedFrom?: { model: string; failureClass: string };
  type?: string;
}): ExecutionRecord {
  n += 1;
  const start = new Date('2026-01-01T00:00:00Z');
  const events: unknown[] = [];
  if (opts.escalatedFrom) {
    events.push({ id: `r${n}`, executionId: `e${n}`, type: 'model.route.changed', timestamp: start, data: { accepted: true, previousModel: opts.escalatedFrom.model, newModel: opts.finalModel, failureClass: opts.escalatedFrom.failureClass } });
  }
  if (opts.reason) {
    events.push({ id: `t${n}`, executionId: `e${n}`, type: 'termination.completed', timestamp: start, data: {
      reason: opts.reason, modelId: opts.finalModel ?? opts.model,
      protocolMetrics: opts.metrics ? { ...opts.metrics, validationErrors: 0, malformedActions: 0, adherenceRate: 0 } : undefined,
    } });
  }
  return {
    execution: { id: `e${n}`, taskId: 't', runtimeId: 'r', modelId: opts.model, status: 'completed', createdAt: start, startedAt: start, completedAt: new Date(start.getTime() + (opts.durationMs ?? 1000)) },
    task: { id: 't', type: opts.type ?? 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: start },
    policyDecisions: [],
    toolCalls: Array.from({ length: opts.toolCalls ?? 0 }, (_, i) => ({ id: `c${i}`, tool: 'read', input: {}, ok: true, policyEffect: 'allow', policyRule: 'x', durationMs: 1, at: start })),
    filesChanged: [],
    checks: (opts.checks ?? []).map((c) => ({ ...c, command: c.name, output: '', durationMs: 1 })),
    errors: [],
    events,
  } as unknown as ExecutionRecord;
}

describe('measureModelPerformance', () => {
  it('derives rates and medians from execution evidence only', () => {
    const profiles = measureModelPerformance([
      run({ model: 'q', reason: 'VERIFICATION_PASSED', checks: [{ name: 'build', ok: true }, { name: 'test', ok: false }, { name: 'test', ok: true }], toolCalls: 4, durationMs: 1000, metrics: { actionAttempts: 10, validActions: 9 } }),
      run({ model: 'q', reason: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED', checks: [{ name: 'build', ok: false }, { name: 'build', ok: true }], toolCalls: 8, durationMs: 3000, metrics: { actionAttempts: 10, validActions: 5 } }),
      run({ model: 'q', reason: 'NO_PROGRESS', toolCalls: 20, durationMs: 5000 }),
      run({ model: 'q' }), // agent never reached a typed termination: not a sample
    ]).get('q')!;

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      taskClass: 'coding',
      samples: 3,
      verifiedSuccessRate: 0.333,
      firstPassBuildRate: 0.5, // first build passed in 1 of 2 runs that built; a later passing build doesn't count
      firstPassTestRate: 0,
      protocolFailureRate: 0.333,
      noProgressRate: 0.333,
      schemaReliability: 0.7,
      medianToolCalls: 8,
      medianDurationMs: 3000,
    } satisfies Partial<ModelPerformanceProfile>);
  });

  it('keeps task classes separate and reports null for unobserved rates', () => {
    const measured = measureModelPerformance([run({ model: 'q', reason: 'VERIFICATION_PASSED', type: 'chat' })]).get('q')!;
    expect(measured.map((p) => p.taskClass)).toEqual(['chat']);
    expect(measured[0].firstPassBuildRate).toBeNull();
    expect(measured[0].schemaReliability).toBeNull();
  });

  it('after an escalation, charges the failure to the abandoned model and credits the outcome to the final model, without mixing run-level metrics', () => {
    const measured = measureModelPerformance([
      run({ model: 'weak', finalModel: 'strong', reason: 'VERIFICATION_PASSED', escalatedFrom: { model: 'weak', failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED' }, checks: [{ name: 'build', ok: true }], toolCalls: 6 }),
    ]);
    expect(measured.get('weak')![0]).toMatchObject({ samples: 1, protocolFailureRate: 1, verifiedSuccessRate: 0 });
    expect(measured.get('strong')![0]).toMatchObject({ samples: 1, verifiedSuccessRate: 1, firstPassBuildRate: null, medianToolCalls: null });
  });
});

describe('ModelRegistry performance', () => {
  const base = { name: 'q', provider: 'ollama', family: 'qwen' as const, contextMax: 32768, capabilities: ['coding' as const], toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: ['ollama' as const], local: true, createdAt: new Date(), updatedAt: new Date() };
  it('keeps measured profiles when a model is re-registered by discovery', () => {
    const models = new ModelRegistry();
    models.register({ id: 'q', ...base });
    const [profile] = measureModelPerformance([run({ model: 'q', reason: 'VERIFICATION_PASSED' })]).get('q')!;
    models.setPerformance('q', [profile]);
    models.register({ id: 'q', ...base });
    expect(models.performanceFor('q', 'coding')?.samples).toBe(1);
  });
});

describe('Scheduler uses measured performance', () => {
  function setup() {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    computers.register({ id: 'local-1', name: 'L', type: 'workstation' as const, local: true, os: { platform: 'linux', architecture: 'x64', version: '5' }, hardware: { cpu: 'c', cpuCores: 8, memoryGB: 32 }, runtimes: ['ollama'], models: [], capabilities: [] });
    runtimes.register({ id: 'ollama', type: 'ollama' as const, name: 'O', version: '1', computerId: 'local-1', health: 'healthy' as const, capabilities: { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false }, loadedModels: [] });
    for (const id of ['a-big', 'b-small']) {
      models.register({ id, name: id, provider: 'ollama', family: 'qwen' as const, contextMax: 32768, capabilities: ['coding'], toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: ['ollama' as const], local: true, createdAt: new Date(), updatedAt: new Date() });
      models.upsertInstance({ id: `${id}-i`, modelId: id, computerId: 'local-1', runtimeId: 'ollama' as const, runtimeModelId: id, loaded: true, health: 'healthy' as const });
    }
    return { models, scheduler: new Scheduler({ computers, runtimes, models } as never) };
  }
  const task = { id: 't', type: 'coding' as const, input: 'x', requirements: { capabilities: ['coding'] }, priority: 'normal', status: 'pending', createdAt: new Date() } as never;
  const records = (model: string, reason: string, count: number) => Array.from({ length: count }, () => run({ model, reason }));

  it('breaks an otherwise-equal tie toward the model with better measured outcomes, and says so', () => {
    const { models, scheduler } = setup();
    expect(scheduler.plan({ task }).modelId).toBe('a-big'); // lexicographic tie-break without evidence
    const measured = measureModelPerformance([...records('a-big', 'MODEL_PROTOCOL_BUDGET_EXHAUSTED', 3), ...records('b-small', 'VERIFICATION_PASSED', 3)]);
    for (const [id, profiles] of measured) models.setPerformance(id, profiles);
    const decision = scheduler.plan({ task });
    expect(decision.modelId).toBe('b-small');
    expect(decision.modelDecision.reasons.some((r) => r.startsWith('measured coding: 100% verified over 3 runs'))).toBe(true);
  });

  it('ignores profiles with too few samples', () => {
    const { models, scheduler } = setup();
    const measured = measureModelPerformance([...records('a-big', 'MODEL_PROTOCOL_BUDGET_EXHAUSTED', 2), ...records('b-small', 'VERIFICATION_PASSED', 2)]);
    for (const [id, profiles] of measured) models.setPerformance(id, profiles);
    expect(scheduler.plan({ task }).modelId).toBe('a-big');
  });
});
