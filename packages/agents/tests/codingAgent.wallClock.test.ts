import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for the run-level wall-clock budget (Phase 19: execution
 * budgets). Distinct from `modelTurnTimeoutMs` (packages/agents/tests/
 * codingAgent.turnTimeout.test.ts), which only bounds a single turn — a task whose
 * every individual turn completes quickly could still run far longer than intended
 * in aggregate. This is exactly the originally-reported bug: a trivial task taking
 * 258 seconds despite never exceeding its per-turn or turn-count budgets.
 */
async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: AgentRunRequest = {
  modelId: 'fake-model',
  taskDescription: 'build a c++ program that sorts an array',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

function fastRuntime(): { runtime: AgentRuntime; counters: { generateCalls: number } } {
  const counters = { generateCalls: 0 };
  const runtime: AgentRuntime = {
    tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
    async *generate() {
      counters.generateCalls += 1;
      const reply = '{"action":"tool","tool":"read","input":{"path":"x.txt"}}';
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name): Promise<ToolResult> {
      return { ok: true, output: `ok:${name}`, durationMs: 1 };
    },
  };
  return { runtime, counters };
}

describe('CodingAgent.run — wall-clock budget', () => {
  it('stops with MAX_WALL_CLOCK before the first model call once the budget is already exhausted', async () => {
    const agent = createCodingAgent({ maxWallClockMs: 0, maxTurns: 30 });
    const { runtime, counters } = fastRuntime();

    const turns = await drain(agent.run(baseRequest, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('MAX_WALL_CLOCK');
    expect(counters.generateCalls).toBe(0);
  });

  it('a per-request maxWallClockMs overrides the constructor default', async () => {
    const agent = createCodingAgent({ maxWallClockMs: 20 * 60_000 }); // generous constructor default
    const { runtime, counters } = fastRuntime();

    const turns = await drain(agent.run({ ...baseRequest, maxWallClockMs: 0 }, runtime));

    expect(turns.at(-1)?.terminationReason).toBe('MAX_WALL_CLOCK');
    expect(counters.generateCalls).toBe(0);
  });

  it('does not trip the wall-clock budget for a run that completes well within it', async () => {
    const agent = createCodingAgent({ maxWallClockMs: 20 * 60_000, maxTurns: 5 });
    const { runtime } = fastRuntime();

    const turns = await drain(agent.run(baseRequest, runtime));

    expect(turns.some((t) => t.terminationReason === 'MAX_WALL_CLOCK')).toBe(false);
  });
});
