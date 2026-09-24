import { describe, expect, it } from 'vitest';
import { ModelReliabilityTracker, classifyTerminationForReliability } from '../src/services/modelReliability.js';
import { Scheduler } from '../src/services/scheduler.js';
import { ComputerRegistry, ModelRegistry, RuntimeRegistry, type ExecutionRecord } from '@wazir/core';

const t0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

describe('ModelReliabilityTracker', () => {
  it('does not open on a single failure', () => {
    const tracker = new ModelReliabilityTracker({ minSamples: 3 });
    const status = tracker.record({ modelId: 'm', taskClass: 'coding', success: false, at: t0 });
    expect(status.state).toBe('CLOSED');
  });

  it('opens once the failure rate over enough samples crosses the threshold, scoped to the task class', () => {
    const tracker = new ModelReliabilityTracker({ minSamples: 3, failureRateThreshold: 0.6 });
    for (let i = 0; i < 3; i++) tracker.record({ modelId: 'm', taskClass: 'coding', success: false, at: at(i) });
    expect(tracker.status('m', 'coding', at(10)).state).toBe('OPEN');
    expect(tracker.allows('m', 'coding', at(10))).toBe(false);
    expect(tracker.status('m', 'chat', at(10)).state).toBe('CLOSED');
  });

  it('goes HALF_OPEN after the cooldown; a successful trial closes it, a failed trial re-opens it', () => {
    const tracker = new ModelReliabilityTracker({ minSamples: 2, cooldownMs: 1000 });
    tracker.record({ modelId: 'm', taskClass: 'coding', success: false, at: at(0) });
    tracker.record({ modelId: 'm', taskClass: 'coding', success: false, at: at(1) });
    expect(tracker.status('m', 'coding', at(500)).state).toBe('OPEN');
    expect(tracker.status('m', 'coding', at(2000)).state).toBe('HALF_OPEN');
    expect(tracker.allows('m', 'coding', at(2000))).toBe(true);

    expect(tracker.record({ modelId: 'm', taskClass: 'coding', success: false, at: at(2000) }).state).toBe('OPEN');
    expect(tracker.record({ modelId: 'm', taskClass: 'coding', success: true, at: at(3500) }).state).toBe('CLOSED');
    // Clean slate: one further failure does not immediately re-open it.
    expect(tracker.record({ modelId: 'm', taskClass: 'coding', success: false, at: at(3600) }).state).toBe('CLOSED');
  });

  it('only counts model-attributable terminations', () => {
    expect(classifyTerminationForReliability('VERIFICATION_PASSED')).toBe('success');
    expect(classifyTerminationForReliability('MODEL_PROTOCOL_BUDGET_EXHAUSTED')).toBe('failure');
    expect(classifyTerminationForReliability('NO_PROGRESS')).toBe('failure');
    expect(classifyTerminationForReliability('VERIFICATION_FAILED')).toBe('failure');
    expect(classifyTerminationForReliability('CANCELLED')).toBeNull();
    expect(classifyTerminationForReliability('POLICY_DENIED')).toBeNull();
    expect(classifyTerminationForReliability(undefined)).toBeNull();
    const tracker = new ModelReliabilityTracker({ minSamples: 1 });
    expect(tracker.recordTermination('m', 'coding', 'CANCELLED')).toBeNull();
    expect(tracker.status('m', 'coding').samples).toBe(0);
  });

  it('rebuilds circuits from durable termination events', () => {
    const record = (i: number, reason: string) => ({
      execution: { id: `e${i}`, modelId: 'm' },
      task: { type: 'coding' },
      events: [{ id: `ev${i}`, executionId: `e${i}`, type: 'termination.completed', timestamp: at(i), data: { reason } }],
    }) as unknown as ExecutionRecord;
    const tracker = new ModelReliabilityTracker({ minSamples: 3, cooldownMs: 60_000 });
    tracker.hydrate([record(2, 'NO_PROGRESS'), record(0, 'REPEATED_ACTION'), record(1, 'MODEL_PROTOCOL_BUDGET_EXHAUSTED'), record(3, 'CANCELLED')]);
    const status = tracker.status('m', 'coding', at(10));
    expect(status.state).toBe('OPEN');
    expect(status.samples).toBe(3);
  });
});

describe('Scheduler + model circuit breaker', () => {
  function setup(reliability: ModelReliabilityTracker) {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    computers.register({
      id: 'local-1', name: 'Local', type: 'workstation' as const, local: true,
      os: { platform: 'linux', architecture: 'x64', version: '5.0' },
      hardware: { cpu: 'cpu', cpuCores: 8, memoryGB: 32 }, runtimes: ['ollama'], models: [], capabilities: ['localExecution'],
    });
    runtimes.register({
      id: 'ollama', type: 'ollama' as const, name: 'Ollama', version: '0.1', computerId: 'local-1', health: 'healthy' as const,
      capabilities: { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      loadedModels: [],
    });
    for (const [id, loaded] of [['model-a', true], ['model-b', false]] as const) {
      models.register({
        id, name: id, provider: 'ollama', family: 'qwen' as const, contextMax: 32768, capabilities: ['coding'],
        toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
        runtimeCompatibility: ['ollama' as const], local: true, createdAt: new Date(), updatedAt: new Date(),
      });
      models.upsertInstance({ id: `${id}-inst`, modelId: id, computerId: 'local-1', runtimeId: 'ollama' as const, runtimeModelId: id, loaded, health: 'healthy' as const });
    }
    return new Scheduler({ computers, runtimes, models, reliability } as never);
  }
  const task = (targetModelId?: string) => ({
    id: 't', type: 'coding' as const, input: 'fix', requirements: { capabilities: ['coding'] }, priority: 'normal', status: 'pending', createdAt: new Date(),
    ...(targetModelId ? { execution: { targetModelId } } : {}),
  }) as never;

  it('prefers the loaded model while its circuit is closed', () => {
    expect(setup(new ModelReliabilityTracker()).plan({ task: task() }).modelId).toBe('model-a');
  });

  it('routes coding work away from a model whose coding circuit is open, and explains why', () => {
    const reliability = new ModelReliabilityTracker({ minSamples: 2 });
    reliability.record({ modelId: 'model-a', taskClass: 'coding', success: false });
    reliability.record({ modelId: 'model-a', taskClass: 'coding', success: false });
    const scheduler = setup(reliability);
    const decision = scheduler.plan({ task: task() });
    expect(decision.modelId).toBe('model-b');
  });

  it('honors an explicit pin to a model with an open circuit, with a warning (no silent substitution)', () => {
    const reliability = new ModelReliabilityTracker({ minSamples: 2 });
    reliability.record({ modelId: 'model-a', taskClass: 'coding', success: false });
    reliability.record({ modelId: 'model-a', taskClass: 'coding', success: false });
    const decision = setup(reliability).plan({ task: task('model-a') });
    expect(decision.modelId).toBe('model-a');
    expect(decision.modelDecision.reasons.some((r) => r.includes('circuit open'))).toBe(true);
  });
});

describe('escalation support', () => {
  it('Scheduler never routes to an excluded (already tried) model', async () => {
    const { ComputerRegistry: C, ModelRegistry: M, RuntimeRegistry: R } = await import('@wazir/core');
    const computers = new C(); const runtimes = new R(); const models = new M();
    computers.register({ id: 'local-1', name: 'Local', type: 'workstation' as const, local: true, os: { platform: 'linux', architecture: 'x64', version: '5' }, hardware: { cpu: 'c', cpuCores: 8, memoryGB: 32 }, runtimes: ['ollama'], models: [], capabilities: [] });
    runtimes.register({ id: 'ollama', type: 'ollama' as const, name: 'O', version: '1', computerId: 'local-1', health: 'healthy' as const, capabilities: { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false }, loadedModels: [] });
    models.register({ id: 'only', name: 'only', provider: 'ollama', family: 'qwen' as const, contextMax: 32768, capabilities: ['coding'], toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: ['ollama' as const], local: true, createdAt: new Date(), updatedAt: new Date() });
    models.upsertInstance({ id: 'only-i', modelId: 'only', computerId: 'local-1', runtimeId: 'ollama' as const, runtimeModelId: 'only', loaded: true, health: 'healthy' as const });
    const scheduler = new Scheduler({ computers, runtimes, models } as never);
    const t = { id: 't', type: 'coding' as const, input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() } as never;
    expect(scheduler.plan({ task: t }).modelId).toBe('only');
    expect(() => scheduler.plan({ task: t, excludeModelIds: ['only'] })).toThrow(/No model satisfies/);
  });

  it('hydrate counts an accepted escalation against the abandoned model and the termination against the final model', () => {
    const record = {
      execution: { id: 'e', modelId: 'weak' },
      task: { type: 'coding' },
      events: [
        { id: '1', executionId: 'e', type: 'model.route.changed', timestamp: at(0), data: { accepted: true, previousModel: 'weak', newModel: 'strong', failureClass: 'NO_PROGRESS' } },
        { id: '2', executionId: 'e', type: 'termination.completed', timestamp: at(1), data: { reason: 'VERIFICATION_PASSED', modelId: 'strong' } },
      ],
    } as unknown as ExecutionRecord;
    const tracker = new ModelReliabilityTracker({ minSamples: 1 });
    tracker.hydrate([record]);
    expect(tracker.status('weak', 'coding', at(2))).toMatchObject({ samples: 1, failures: 1 });
    expect(tracker.status('strong', 'coding', at(2))).toMatchObject({ samples: 1, failures: 0 });
  });
});
