import { describe, expect, it } from 'vitest';
import { SchedulingError, type ModelEscalationRequest, type SchedulerDecision, type Task } from '@wazir/core';
import { createEscalationHandler, planEscalation } from '../src/escalation.js';

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
    expect(plan.decision).toEqual({ modelId: 'strong', reason: 'scheduler: coding capability: present' });
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

  it('declines an alternative that would need re-placement or loading', () => {
    const remote = planEscalation({ plan: () => decision({ computerId: 'gpu-box' }) }, { task: task(), placement, request });
    expect(remote.decision.reason).toContain('re-placement is not supported');
    const cold = planEscalation({ plan: () => decision({ readiness: 'LOADABLE' }) }, { task: task(), placement, request });
    expect(cold.decision.reason).toContain('not loaded');
  });
});

describe('createEscalationHandler (shared by wa run and fleet tasks)', () => {
  function harness(plan: () => SchedulerDecision) {
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
        executionId: 'exec-1', task: task(), requiredContextTokens: 9000, placement,
        onEscalated: (_r, modelId) => switched.push(modelId),
        onDeclined: (_r, reason) => declined.push(reason),
      },
    );
    return { escalate, events, charged, switched, declined };
  }

  it('accepted: records the route change, charges the abandoned model, reports the new model', async () => {
    const h = harness(() => decision({}));
    expect(await h.escalate(request)).toMatchObject({ modelId: 'strong' });
    expect(h.events).toEqual([{ type: 'model.route.changed', data: expect.objectContaining({ previousModel: 'weak', newModel: 'strong', accepted: true, failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED' }) }]);
    expect(h.charged).toEqual(['weak:MODEL_PROTOCOL_BUDGET_EXHAUSTED']);
    expect(h.switched).toEqual(['strong']);
  });

  it('declined: still records the decision, charges nobody, switches nothing', async () => {
    const h = harness(() => decision({ readiness: 'LOADABLE' }));
    expect((await h.escalate(request)).modelId).toBeUndefined();
    expect(h.events).toEqual([{ type: 'model.route.changed', data: expect.objectContaining({ accepted: false, newModel: null }) }]);
    expect(h.charged).toEqual([]);
    expect(h.switched).toEqual([]);
    expect(h.declined[0]).toContain('not loaded');
  });
});
