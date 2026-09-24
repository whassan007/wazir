import { describe, expect, it } from 'vitest';
import { SchedulingError, type ModelEscalationRequest, type SchedulerDecision, type Task } from '@wazir/core';
import { planEscalation } from '../src/escalation.js';

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
