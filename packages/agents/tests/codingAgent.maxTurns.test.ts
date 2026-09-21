import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * A fake `AgentRuntime` whose model never says "done" on its own — every
 * generate() call replies with a tool call. This forces the agent's turn
 * loop to run until it hits whatever turn cap is in effect, which is
 * exactly the behavior under test here: does the per-request `maxTurns`
 * (threaded from `apps/cli`'s `--max-turns` flag through `executeTask` ->
 * `agent.run()`) actually bound the loop, or does the agent silently use
 * only its own constructor-time default regardless of what the caller asks
 * for? The check tools ('test'/'lint'/'typecheck') always pass, so once the
 * turn loop ends the deterministic VERIFY phase completes in one cycle.
 *
 * `toolName` defaults to 'read' (most tests here only care about the turn
 * count). VERIFY now also fails outright when zero files were ever changed
 * — pass 'write' for a test that needs the run to actually reach 'done'.
 */
function fakeRuntime(toolName = 'read'): { runtime: AgentRuntime; counters: { generateCalls: number }; toolCalls: string[] } {
  const counters = { generateCalls: 0 };
  const toolCalls: string[] = [];
  const runtime: AgentRuntime = {
    tools: [{ name: toolName, description: `${toolName} a file`, inputSchema: {} }],
    async *generate() {
      counters.generateCalls += 1;
      const input = toolName === 'write' ? '{"path":"x.txt","content":"x"}' : '{"path":"x.txt"}';
      const reply =
        counters.generateCalls === 1 && toolName === 'write'
          ? '{"action":"plan","content":"plan"}'
          : `{"action":"tool","tool":"${toolName}","input":${input}}`;
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name): Promise<ToolResult> {
      toolCalls.push(name);
      return { ok: true, output: `ok:${name}`, durationMs: 1 };
    },
  };
  return { runtime, counters, toolCalls };
}

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: Omit<AgentRunRequest, 'maxTurns'> = {
  modelId: 'fake-model',
  taskDescription: 'do something that never finishes on its own',
  taskType: 'coding',
  projectRoot: '/tmp/fake-project',
};

describe('CodingAgent.run — maxTurns', () => {
  it('caps the number of model turns at the per-request maxTurns, overriding a larger constructor default', async () => {
    const agent = createCodingAgent({ maxTurns: 30 }); // constructor default is intentionally larger
    const { runtime, counters } = fakeRuntime('write');

    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 5 }, runtime));

    // Before the fix, `run()` only ever read `this.maxTurns` (the
    // constructor value, 30), so this would be 30 instead of 5.
    expect(counters.generateCalls).toBe(5);
    expect(turns.at(-1)?.kind).toBe('done'); // files were changed and checks pass, so it still completes cleanly
  });

  it('falls back to the constructor default when the request specifies no maxTurns', async () => {
    const agent = createCodingAgent({ maxTurns: 4 });
    const { runtime, counters } = fakeRuntime();

    await drain(agent.run({ ...baseRequest }, runtime));

    expect(counters.generateCalls).toBe(4);
  });

  it('a smaller per-request maxTurns overrides a larger constructor default in the other direction too', async () => {
    const agent = createCodingAgent(); // default constructor maxTurns (30)
    const { runtime, counters } = fakeRuntime();

    await drain(agent.run({ ...baseRequest, maxTurns: 6 }, runtime));

    expect(counters.generateCalls).toBe(6);
  });

  it('still executes the requested tool on every turn, not just spins without doing anything', async () => {
    const agent = createCodingAgent();
    const { runtime, toolCalls } = fakeRuntime();

    await drain(agent.run({ ...baseRequest, maxTurns: 5 }, runtime));

    // PLAN (3 turns) + WORK turns each call `read`, then VERIFY calls the
    // three check tools once verification kicks in.
    expect(toolCalls.filter((t) => t === 'read').length).toBe(5);
    expect(toolCalls).toEqual(expect.arrayContaining(['test', 'lint', 'typecheck']));
  });
});
