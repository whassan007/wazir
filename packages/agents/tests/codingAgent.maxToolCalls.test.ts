import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for the total tool-call budget (Phase 19: execution budgets).
 * Distinct from `toolRepeatLimit` (packages/agents/tests/codingAgent.circuitBreaker.
 * test.ts), which only catches the exact same call repeated back to back — a model
 * alternating between several different, individually-novel tools/arguments is not
 * caught by that breaker at all and would otherwise be bounded only by `maxTurns`.
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

function alwaysNovelToolRuntime(): { runtime: AgentRuntime; counters: { executed: number } } {
  const counters = { executed: 0 };
  let n = 0;
  const runtime: AgentRuntime = {
    tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
    async *generate() {
      n += 1;
      // Every call reads a distinctly-named file, so the circuit breaker (exact
      // repeat detection) never trips — only a total tool-call budget can stop this.
      const reply = n === 1
        ? '{"action":"plan","content":"inspect"}'
        : `{"action":"tool","tool":"read","input":{"path":"file-${n}.txt"}}`;
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name): Promise<ToolResult> {
      counters.executed += 1;
      return { ok: true, output: `ok:${name}`, durationMs: 1 };
    },
  };
  return { runtime, counters };
}

describe('CodingAgent.run — max tool calls budget', () => {
  it('stops with MAX_TOOL_CALLS once the total real-dispatch budget is exhausted, even with no repeated calls', async () => {
    const agent = createCodingAgent({ maxToolCalls: 3, maxTurns: 50 });
    const { runtime, counters } = alwaysNovelToolRuntime();

    const turns = await drain(agent.run(baseRequest, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('MAX_TOOL_CALLS');
    expect(counters.executed).toBe(3);
  });

  it('a per-request maxToolCalls overrides the constructor default', async () => {
    const agent = createCodingAgent({ maxToolCalls: 100 });
    const { runtime, counters } = alwaysNovelToolRuntime();

    const turns = await drain(agent.run({ ...baseRequest, maxToolCalls: 2, maxTurns: 50 }, runtime));

    expect(turns.at(-1)?.terminationReason).toBe('MAX_TOOL_CALLS');
    expect(counters.executed).toBe(2);
  });

  it('does not trip the tool-call budget for a run well within it', async () => {
    let n = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        n += 1;
        const reply =
          n === 1
            ? '{"action":"plan","content":"plan"}'
            : n === 2
              ? '{"action":"tool","tool":"write","input":{"path":"x.txt","content":"x"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxToolCalls: 100 }).run({ ...baseRequest, maxTurns: 10 }, runtime));

    expect(turns.some((t) => t.terminationReason === 'MAX_TOOL_CALLS')).toBe(false);
    expect(turns.at(-1)?.kind).toBe('done');
  });
});
