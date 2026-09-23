import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for the explicit, controller-set `terminationReason` on the
 * terminal turn — Phase 12 of the execution-architecture-upgrade mission ("explicit
 * stop conditions", never an unbounded loop with only prose explaining why it stopped).
 * Each case below drives the agent into a specific, real stop condition and checks the
 * reason is exactly what the controller logic set, not inferred from free text.
 */

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: Omit<AgentRunRequest, 'maxTurns'> = {
  modelId: 'fake-model',
  taskDescription: 'do something',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

describe('CodingAgent.run — explicit terminationReason', () => {
  it('MAX_TURNS: exhausting the turn budget before verification passes is tagged, not silently treated as an ordinary failure', async () => {
    // Model only ever reads a file — never writes, never says done — so the turn
    // budget is what actually stops the run, and VERIFY then fails (no mutation).
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
      async *generate() {
        const reply = '{"action":"tool","tool":"read","input":{"path":"x.txt"}}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };
    const agent = createCodingAgent();

    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 5 }, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('MAX_TURNS');
  });

  it('VERIFICATION_PASSED: a genuine completion is tagged distinctly from a budget-triggered stop', async () => {
    let call = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        call += 1;
        const reply =
          call === 1
            ? '{"action":"plan","content":"plan"}'
            : call === 2
              ? '{"action":"tool","tool":"write","input":{"path":"x.txt","content":"x"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };
    const agent = createCodingAgent();

    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 10 }, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('done');
    expect(last?.terminationReason).toBe('VERIFICATION_PASSED');
  });

  it('MODEL_PROTOCOL_BUDGET_EXHAUSTED: repeated unparseable responses stop the run with that exact reason', async () => {
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
      async *generate() {
        const reply = 'this is not json at all, just prose';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };
    const agent = createCodingAgent();

    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 10 }, runtime));
    const last = turns.at(-1);

    expect(last?.kind).toBe('error');
    expect(last?.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
  });
});
