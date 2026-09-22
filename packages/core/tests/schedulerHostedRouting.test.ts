import { describe, it, expect } from 'vitest';
import { ComputerRegistry, ModelRegistry, PolicyEngine, RuntimeRegistry, Scheduler, SchedulingError } from '../src/index.js';
import type { ModelRecord, Task } from '../src/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    type: 'coding',
    input: 'do something',
    requirements: {},
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function registerHostedModel(models: ModelRegistry, id: string, overrides: Partial<ModelRecord> = {}): void {
  models.register({
    id,
    name: id,
    provider: 'anthropic',
    family: 'other',
    contextMax: 200_000,
    capabilities: ['generalChat', 'coding'],
    toolCalling: true,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: ['anthropic'],
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  models.upsertInstance({
    id: `${id}::hosted::anthropic`,
    modelId: id,
    runtimeId: 'anthropic',
    runtimeModelId: id,
    loaded: true,
    state: 'READY',
    health: 'healthy',
  });
}

function setup(policyOptions: { allowHostedProvidersDefault?: boolean } = {}) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  runtimes.register({
    id: 'anthropic', type: 'anthropic', name: 'Anthropic', version: 'v1', runtimeKind: 'hosted',
    capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: true, embeddings: false, reasoning: true, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
  });
  runtimes.update('anthropic', { health: 'healthy' });
  const models = new ModelRegistry();
  const policy = new PolicyEngine({ projectRoot: '/tmp', ...policyOptions });
  const scheduler = new Scheduler({ computers, runtimes, models, policy });
  return { computers, runtimes, models, policy, scheduler };
}

describe('Scheduler — hosted provider routing (Anthropic/OpenAI/Google)', () => {
  it('#17 local-only policy prevents a task from ever being routed to a hosted provider', () => {
    const { models, scheduler } = setup({ allowHostedProvidersDefault: true }); // even with the engine default ON
    registerHostedModel(models, 'claude-sonnet-4');

    const task = makeTask({ policy: { localOnly: true, allowHostedProviders: true } }); // and an explicit per-task opt-in

    expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
    try {
      scheduler.plan({ task });
    } catch (error) {
      expect((error as SchedulingError).message).toMatch(/local-only|No model satisfies/);
    }
  });

  it('#17 sensitive/restricted dataClassification also overrides an explicit hosted opt-in', () => {
    const { models, scheduler } = setup({ allowHostedProvidersDefault: true });
    registerHostedModel(models, 'claude-sonnet-4');

    const task = makeTask({ policy: { dataClassification: 'restricted', allowHostedProviders: true } });

    expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
  });

  it('#18 hosted routing is rejected by default when no policy eligibility is granted at all', () => {
    const { models, scheduler } = setup(); // no allowHostedProvidersDefault
    registerHostedModel(models, 'claude-sonnet-4');

    const task = makeTask(); // no task.policy.allowHostedProviders either

    expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
  });

  it('#18 hosted routing succeeds once policy eligibility is explicitly granted (task-level)', () => {
    const { models, scheduler } = setup();
    registerHostedModel(models, 'claude-sonnet-4');

    const task = makeTask({ policy: { allowHostedProviders: true } });

    const decision = scheduler.plan({ task });
    expect(decision.modelId).toBe('claude-sonnet-4');
    expect(decision.runtimeId).toBe('anthropic');
    expect(decision.computerId).toBeUndefined();
    expect(decision.computerDecision.placementKind).toBe('hosted');
  });

  it('#18 hosted routing succeeds via the engine-wide default when the task itself is silent on it', () => {
    const { models, scheduler } = setup({ allowHostedProvidersDefault: true });
    registerHostedModel(models, 'claude-sonnet-4');

    const task = makeTask(); // task.policy is entirely absent

    const decision = scheduler.plan({ task });
    expect(decision.runtimeId).toBe('anthropic');
  });

  it('#20 model discovery does not imply eligibility — a hosted model missing a required capability is still rejected', () => {
    const { models, scheduler } = setup({ allowHostedProvidersDefault: true }); // hosted routing fully allowed
    registerHostedModel(models, 'claude-instant-no-tools', { toolCalling: false });

    const task = makeTask({ requirements: { toolCalling: true } });

    // Policy eligibility is granted, but capability matching is a completely
    // separate gate (Scheduler Phase 1's existing scoreModel() rejection) —
    // being "discovered and policy-eligible" must never bypass it.
    expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
  });

  it('#20 an eligible hosted model with sufficient capabilities is still correctly selected (eligibility gate is additive, not exclusionary of good matches)', () => {
    const { models, scheduler } = setup({ allowHostedProvidersDefault: true });
    registerHostedModel(models, 'claude-sonnet-4', { toolCalling: true, reasoning: true });

    const task = makeTask({ requirements: { toolCalling: true } });

    const decision = scheduler.plan({ task });
    expect(decision.modelId).toBe('claude-sonnet-4');
  });
});
