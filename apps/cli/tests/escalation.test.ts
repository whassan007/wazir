import { describe, expect, it } from 'vitest';
import { SchedulingError, type ModelEscalationRequest, type SchedulerDecision, type Task } from '@wazir/core';
import { createEscalationHandler, planEscalation, prepareGenerationPlacement } from '../src/escalation.js';

const task = (targetModelId?: string): Task => ({
  id: 't', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(),
  execution: { targetModelId },
});
const request: ModelEscalationRequest = {
  currentModelId: 'weak', triedModelIds: ['weak'], failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED', reason: 'bad JSON',
};
const decision = (over: Partial<SchedulerDecision>): SchedulerDecision => ({
  modelId: 'strong', modelInstanceId: 'strong-i', readiness: 'READY_NOW', runtimeId: 'lmstudio', computerId: 'local',
  modelDecision: { modelId: 'strong', modelInstanceId: 'strong-i', strategy: 'capability_match', score: 5, reasons: ['coding capability: present'] },
  computerDecision: { computerId: 'local', runtimeId: 'lmstudio', score: 1, reasons: [] },
  reasons: [], decidedAt: new Date(), ...over,
} as SchedulerDecision);
const placement = { runtimeId: 'lmstudio', computerId: 'local' };

describe('planEscalation', () => {
  it('asks the scheduler with every tried model excluded and the pin cleared, and accepts a same-placement ready model', () => {
    const calls: unknown[] = [];
    const plan = planEscalation({ plan: (input) => { calls.push(input); return decision({}); } }, { task: task(), requiredContextTokens: 9000, placement, request });
    expect(plan.decision).toEqual({ modelId: 'strong', reason: "scheduler: coding capability: present; same placement 'lmstudio' on 'local', ready now" });
    expect(calls).toEqual([expect.objectContaining({ excludeModelIds: ['weak'], requiredContextTokens: 9000 })]);
  });

  it('never substitutes a pinned model', () => {
    const plan = planEscalation({ plan: () => { throw new Error('must not route'); } }, { task: task('weak'), placement, request });
    expect(plan.decision.modelId).toBeUndefined();
    expect(plan.decision.reason).toContain("pins model 'weak'");
  });

  it('declines, with the scheduler reasons, when no alternative is eligible', () => {
    const plan = planEscalation({ plan: () => { throw new SchedulingError('No model satisfies the task requirements.', ['strong: coding circuit open']); } }, { task: task(), placement, request });
    expect(plan.decision.modelId).toBeUndefined();
    expect(plan.decision.reason).toContain('coding circuit open');
  });

  it('accepts an alternative on another placement or needing a load, and says which', () => {
    const remote = planEscalation({ plan: () => decision({ computerId: 'gpu-box', readiness: 'LOADABLE' }) }, { task: task(), placement, request });
    expect(remote.decision.modelId).toBe('strong');
    expect(remote.decision.reason).toContain("re-placed to 'lmstudio' on 'gpu-box', must be loaded");
    expect(remote.scheduling?.computerId).toBe('gpu-box');
    const same = planEscalation({ plan: () => decision({}) }, { task: task(), placement, request });
    expect(same.decision.reason).toContain("same placement 'lmstudio' on 'local', ready now");
  });
});

describe('createEscalationHandler (shared by wa run and fleet tasks)', () => {
  function harness(plan: () => SchedulerDecision, failPrepare?: string) {
    const prepared: string[] = [];
    const events: Array<{ type: string; data: unknown }> = [];
    const charged: string[] = [];
    const switched: string[] = [];
    const declined: string[] = [];
    const escalate = createEscalationHandler(
      {
        scheduler: { plan },
        executions: { recordEvent: async (_id, type, data) => { events.push({ type, data }); } },
        reliability: { recordTermination: (modelId: string, _cls: string, reason?: string) => { charged.push(`${modelId}:${reason}`); } },
      },
      {
        executionId: 'exec-1', task: task(), requiredContextTokens: 9000, placement: () => placement,
        prepare: async (next) => { prepared.push(next.modelId); if (failPrepare) throw new Error(failPrepare); return { contextTokens: 16384 }; },
        onEscalated: (_r, next, contextTokens) => switched.push(`${next.modelId}@${next.computerId}:${contextTokens}`),
        onDeclined: (_r, reason) => declined.push(reason),
      },
    );
    return { escalate, events, charged, switched, declined, prepared };
  }

  it('accepted: records the route change, charges the abandoned model, reports the new model', async () => {
    const h = harness(() => decision({}));
    expect(await h.escalate(request)).toMatchObject({ modelId: 'strong' });
    expect(h.events).toEqual([{ type: 'model.route.changed', data: expect.objectContaining({ previousModel: 'weak', newModel: 'strong', accepted: true, failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED' }) }]);
    expect(h.charged).toEqual(['weak:MODEL_PROTOCOL_BUDGET_EXHAUSTED']);
    expect(h.prepared).toEqual(['strong']);
    expect(h.switched).toEqual(['strong@local:16384']);
  });

  it('re-placement: prepares the new placement first and records where generation moved', async () => {
    const h = harness(() => decision({ computerId: 'gpu-box', readiness: 'LOADABLE' }));
    expect(await h.escalate(request)).toMatchObject({ modelId: 'strong' });
    expect(h.prepared).toEqual(['strong']);
    expect(h.switched).toEqual(['strong@gpu-box:16384']);
    expect(h.events[0].data).toMatchObject({ accepted: true, runtimeId: 'lmstudio', computerId: 'gpu-box' });
  });

  it('a placement that cannot be prepared declines the escalation, keeps the current model, charges nobody', async () => {
    const h = harness(() => decision({ computerId: 'gpu-box', readiness: 'LOADABLE' }), 'MODEL_ADMISSION_DENIED');
    expect((await h.escalate(request)).modelId).toBeUndefined();
    expect(h.events[0].data).toMatchObject({ accepted: false, newModel: null });
    expect(h.declined[0]).toContain("could not prepare 'strong': MODEL_ADMISSION_DENIED");
    expect(h.charged).toEqual([]);
    expect(h.switched).toEqual([]);
  });

  it('declined by routing: still records the decision, prepares nothing, charges nobody', async () => {
    const h = harness(() => { throw new SchedulingError('No model satisfies the task requirements.', ['strong: coding circuit open']); });
    expect((await h.escalate(request)).modelId).toBeUndefined();
    expect(h.events).toEqual([{ type: 'model.route.changed', data: expect.objectContaining({ accepted: false, newModel: null }) }]);
    expect(h.prepared).toEqual([]);
    expect(h.charged).toEqual([]);
    expect(h.declined[0]).toContain('coding circuit open');
  });
});

describe('prepareGenerationPlacement', () => {
  const model = { id: 'strong', contextMax: 32768 } as never;
  function engine(over: { runtimeKind?: string; adapter?: boolean; apiUrl?: string; load?: () => Promise<{ effectiveContext: number }> } = {}) {
    const loads: unknown[] = [];
    return {
      loads,
      engine: {
        models: { getRequired: () => model, instancesOf: () => [{ id: 'strong-i', contextTokens: 8192 }] },
        runtimes: { get: () => ({ runtimeKind: over.runtimeKind }) },
        adapters: { get: () => (over.adapter === false ? undefined : {}) },
        worker: { computerId: 'local' },
        config: { apiUrl: over.apiUrl },
        lifecycle: { ensureReady: async (modelId: string, options: unknown) => { loads.push({ modelId, options }); return over.load ? over.load() : { effectiveContext: 24000 }; } },
      },
    };
  }
  const opts = { executionId: 'exec-1', minimumContext: 9000 };

  it('a ready model on this computer needs no load and serves its instance context', async () => {
    const e = engine();
    expect(await prepareGenerationPlacement(e.engine, decision({}), opts)).toEqual({ contextTokens: 8192 });
    expect(e.loads).toEqual([]);
  });

  it('an unloaded model is loaded through the lifecycle service, like an initial placement', async () => {
    const e = engine();
    expect(await prepareGenerationPlacement(e.engine, decision({ readiness: 'LOADABLE' }), opts)).toEqual({ contextTokens: 24000 });
    expect(e.loads).toEqual([{ modelId: 'strong', options: expect.objectContaining({ computerId: 'local', runtimeId: 'lmstudio', minimumContext: 9000, executionId: 'exec-1', initiator: 'model-escalation' }) }]);
  });

  it('a lifecycle refusal propagates so the escalation is declined', async () => {
    const e = engine({ load: async () => { throw new Error('MODEL_ADMISSION_DENIED'); } });
    await expect(prepareGenerationPlacement(e.engine, decision({ readiness: 'LOADABLE' }), opts)).rejects.toThrow('MODEL_ADMISSION_DENIED');
  });

  it('a remote computer requires a control-plane URL', async () => {
    await expect(prepareGenerationPlacement(engine().engine, decision({ computerId: 'gpu-box' }), opts)).rejects.toThrow('no control-plane API URL');
    expect(await prepareGenerationPlacement(engine({ apiUrl: 'http://cp' }).engine, decision({ computerId: 'gpu-box' }), opts)).toEqual({ contextTokens: 8192 });
  });

  it('a hosted runtime requires a configured adapter and serves the model context', async () => {
    await expect(prepareGenerationPlacement(engine({ adapter: false }).engine, decision({ computerId: undefined, runtimeId: 'anthropic' }), opts)).rejects.toThrow("no adapter is configured for hosted runtime 'anthropic'");
    expect(await prepareGenerationPlacement(engine().engine, decision({ computerId: undefined, runtimeId: 'anthropic' }), opts)).toEqual({ contextTokens: 32768 });
  });
});
