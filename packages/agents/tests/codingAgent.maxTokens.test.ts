import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for the total token budget (Phase 19: execution budgets).
 * Distinct from `maxTokensPerTurn`, which only caps a single request's own
 * generation parameter — a run within its turn/tool-call/wall-clock budgets could
 * still accumulate unbounded actual model cost if context keeps growing turn over
 * turn. This is the class of bug the whole mission started from: a trivial task
 * accumulating hundreds of thousands of cumulative input tokens.
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

function reportingUsageRuntime(tokensPerCall: number): { runtime: AgentRuntime; counters: { generateCalls: number } } {
  const counters = { generateCalls: 0 };
  const runtime: AgentRuntime = {
    tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
    async *generate() {
      counters.generateCalls += 1;
      const reply = '{"action":"tool","tool":"read","input":{"path":"x.txt"}}';
      yield { type: 'token', content: reply };
      yield {
        type: 'completed',
        content: reply,
        usage: { inputTokens: tokensPerCall, outputTokens: 0, totalTokens: tokensPerCall },
      };
    },
    async executeTool(name): Promise<ToolResult> {
      return { ok: true, output: `ok:${name}`, durationMs: 1 };
    },
  };
  return { runtime, counters };
}

describe('CodingAgent.run — max tokens budget', () => {
  it('stops with MAX_TOKENS once reported usage crosses the budget, independent of turn/tool-call counts', async () => {
    const agent = createCodingAgent({ maxTokens: 250, maxTurns: 50 });
    const { runtime, counters } = reportingUsageRuntime(100);

    const turns = await drain(agent.run(baseRequest, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('MAX_TOKENS');
    // 100 + 100 = 200 (under 250), 100 + 100 + 100 = 300 (over 250) -> stops on the 3rd call.
    expect(counters.generateCalls).toBe(3);
  });

  it('a per-request maxTokens overrides the constructor default', async () => {
    const agent = createCodingAgent({ maxTokens: 1_000_000 });
    const { runtime } = reportingUsageRuntime(100);

    const turns = await drain(agent.run({ ...baseRequest, maxTokens: 50, maxTurns: 50 }, runtime));

    expect(turns.at(-1)?.terminationReason).toBe('MAX_TOKENS');
  });

  it('is not enforced when the runtime never reports usage', async () => {
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        yield { type: 'token', content: '{"action":"plan","content":"plan"}' };
        yield { type: 'completed', content: '{"action":"plan","content":"plan"}' }; // no usage field
      },
      async executeTool(name): Promise<ToolResult> {
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTokens: 1 }).run({ ...baseRequest, maxTurns: 3 }, runtime));

    expect(turns.some((t) => t.terminationReason === 'MAX_TOKENS')).toBe(false);
  });

  it('does not trip for a run well within budget', async () => {
    const agent = createCodingAgent({ maxTokens: 1_000_000, maxTurns: 5 });
    const { runtime } = reportingUsageRuntime(25);

    const turns = await drain(agent.run(baseRequest, runtime));

    expect(turns.some((t) => t.terminationReason === 'MAX_TOKENS')).toBe(false);
  });
});
