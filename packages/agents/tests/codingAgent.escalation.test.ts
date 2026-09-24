import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ModelEscalationRequest, ToolResult } from '@wazir/core';

/**
 * Phase 14: failure-based model escalation. The agent decides the current model has
 * demonstrably failed; the host (routing owner) picks the replacement or declines.
 * Every switch is an explicit, typed routeChange turn.
 */
async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: AgentRunRequest = {
  modelId: 'weak-model',
  taskDescription: 'write main.cpp',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
  maxTurns: 30,
};

const PLAN = '{"action":"plan","content":"write it"}';
const WRITE = '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}';
const DONE = '{"action":"done","summary":"done"}';

/** weak-model plans, then only ever emits prose; strong-model writes and finishes. */
function runtime(escalate?: AgentRuntime['escalate']) {
  const modelsUsed: string[] = [];
  const escalations: ModelEscalationRequest[] = [];
  let strongTurns = 0;
  let weakTurns = 0;
  const rt: AgentRuntime = {
    tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
    async *generate(request) {
      modelsUsed.push(request.modelId);
      let reply: string;
      if (request.modelId === 'strong-model') {
        strongTurns += 1;
        reply = strongTurns === 1 ? WRITE : DONE;
      } else {
        weakTurns += 1;
        reply = weakTurns === 1 ? PLAN : 'I will now think about writing the file.';
      }
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name, input): Promise<ToolResult> {
      if (name === 'write') {
        return { ok: true, output: 'written', durationMs: 1, fileMutations: [{ path: String(input.path), attempted: true, succeeded: true, existedBefore: false, existsAfter: true, beforeHash: undefined, afterHash: 'h', changed: true }] };
      }
      return { ok: true, output: 'ok', durationMs: 1 };
    },
    ...(escalate ? {
      async escalate(request: ModelEscalationRequest) {
        escalations.push(request);
        return escalate(request);
      },
    } : {}),
  };
  return { rt, modelsUsed, escalations };
}

describe('CodingAgent.run — failure-based model escalation', () => {
  it('escalates after protocol-budget exhaustion and completes on the new model, with an explicit route change', async () => {
    const { rt, modelsUsed, escalations } = runtime(async () => ({ modelId: 'strong-model', reason: 'next eligible model by capability score' }));

    const turns = await drain(createCodingAgent().run(baseRequest, rt));

    expect(escalations).toEqual([{
      currentModelId: 'weak-model',
      triedModelIds: ['weak-model'],
      failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED',
      reason: 'model repeatedly failed to produce valid JSON actions',
    }]);
    const change = turns.find((t) => t.routeChange)?.routeChange;
    expect(change).toEqual({
      previousModel: 'weak-model',
      newModel: 'strong-model',
      failureClass: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED',
      reason: 'model repeatedly failed to produce valid JSON actions',
      routeDecision: 'next eligible model by capability score',
    });
    expect(modelsUsed.slice(-2)).toEqual(['strong-model', 'strong-model']);
    expect(turns.at(-1)?.kind).toBe('done');
    expect(turns.at(-1)?.terminationReason).toBe('VERIFICATION_PASSED');
  });

  it('terminates with the original reason when the host declines, and records why', async () => {
    const { rt, modelsUsed } = runtime(async () => ({ reason: 'task pins model weak-model; no silent substitution' }));

    const turns = await drain(createCodingAgent().run(baseRequest, rt));

    expect(turns.some((t) => t.content?.includes('model escalation declined') && t.content.includes('no silent substitution'))).toBe(true);
    expect(turns.at(-1)?.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
    expect(modelsUsed.every((m) => m === 'weak-model')).toBe(true);
  });

  it('is bounded by maxModelEscalations', async () => {
    const { rt, escalations } = runtime(async () => ({ modelId: 'weak-model-2', reason: 'r' }));

    const turns = await drain(createCodingAgent({ maxModelEscalations: 1 }).run(baseRequest, rt));

    // weak-model-2 also only emits prose; a second escalation is not requested.
    expect(escalations).toHaveLength(1);
    expect(turns.at(-1)?.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
  });

  it('never escalates without a host escalate hook (unchanged behavior)', async () => {
    const { rt } = runtime();
    const turns = await drain(createCodingAgent().run(baseRequest, rt));
    expect(turns.some((t) => t.routeChange)).toBe(false);
    expect(turns.at(-1)?.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
  });

  it('refuses a host decision that names an already-tried model', async () => {
    const { rt, modelsUsed } = runtime(async () => ({ modelId: 'weak-model', reason: 'same model' }));
    const turns = await drain(createCodingAgent().run(baseRequest, rt));
    expect(turns.some((t) => t.routeChange)).toBe(false);
    expect(modelsUsed.every((m) => m === 'weak-model')).toBe(true);
  });
});
