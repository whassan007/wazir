import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

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

/**
 * A fake runtime that always emits a plan turn first (so the PLAN phase exits
 * immediately, keeping the identical-tool-call streak confined to WORK, where
 * the breaker is actually wired), then repeats one `shell` call verbatim
 * forever — exactly the "same g++ invocation over and over" pattern observed
 * in a real stuck job.
 */
function stuckOnIdenticalToolCall(): { runtime: AgentRuntime; counters: { shellCalls: number } } {
  let calls = 0;
  const counters = { shellCalls: 0 };
  const runtime: AgentRuntime = {
    tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
    async *generate() {
      calls += 1;
      const reply =
        calls === 1
          ? '{"action":"plan","content":"compile it"}'
          : '{"action":"tool","tool":"shell","input":{"command":"g++ main.cpp -o quicksort"}}';
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(name): Promise<ToolResult> {
      // Only 'shell' fails, so VERIFY's test/lint/typecheck checks pass cleanly
      // afterward and don't add unrelated calls to the count under test.
      if (name === 'shell') {
        counters.shellCalls += 1;
        return { ok: false, output: '', error: 'Operation not permitted', durationMs: 1 };
      }
      return { ok: true, output: 'ok', durationMs: 1 };
    },
  };
  return { runtime, counters };
}

describe('CodingAgent.run — circuit breaker', () => {
  it('stops after the same tool call repeats toolRepeatLimit times, instead of grinding to maxTurns', async () => {
    const agent = createCodingAgent({ toolRepeatLimit: 3, maxTurns: 20 });
    const { runtime, counters } = stuckOnIdenticalToolCall();

    const turns = await drain(agent.run(baseRequest, runtime));

    const breakerTurn = turns.find((t) => t.kind === 'error' && t.error?.includes('circuit breaker'));
    expect(breakerTurn).toBeDefined();
    // 3 identical calls happen (each one bumps the streak); the 3rd is caught
    // before executing a 4th — proof this fires well short of maxTurns (20).
    expect(counters.shellCalls).toBe(2);
  });

  it('does not trip when consecutive tool calls use different input', async () => {
    let n = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
      async *generate() {
        n += 1;
        const reply =
          n === 1
            ? '{"action":"plan","content":"compile it"}'
            : n <= 5
              ? `{"action":"tool","tool":"shell","input":{"command":"attempt ${n}"}}`
              : '{"action":"done","summary":"ok"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ toolRepeatLimit: 3 }).run(baseRequest, runtime));

    expect(turns.some((t) => t.kind === 'error' && t.error?.includes('circuit breaker'))).toBe(false);
  });
});
