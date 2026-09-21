import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ChatMessage, ToolResult } from '@wazir/core';

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

describe('CodingAgent.run — circuit breaker', () => {
  it('suppresses further real execution and corrects the model instead of erroring the whole run, after the same tool call repeats toolRepeatLimit times', async () => {
    // The breaker used to yield a top-level `kind:'error'` turn and stop the run dead —
    // which meant one stuck tool call killed an otherwise-recoverable task outright. It
    // now feeds the model a corrective tool-result message and lets the run continue, so
    // there is no longer any turn-level event marking the trip; the only externally
    // observable effects are (a) the real tool stops actually executing once the streak
    // hits the limit, and (b) the next model turn sees the correction in its messages.
    const agent = createCodingAgent({ toolRepeatLimit: 3, maxTurns: 20 });
    let calls = 0;
    const counters = { shellCalls: 0 };
    const seenMessages: ChatMessage[][] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
      async *generate(request) {
        calls += 1;
        seenMessages.push(request.messages);
        const reply =
          calls === 1
            ? '{"action":"plan","content":"compile it"}'
            : '{"action":"tool","tool":"shell","input":{"command":"g++ main.cpp -o quicksort"}}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        if (name === 'shell') {
          counters.shellCalls += 1;
          return { ok: false, output: '', error: 'Operation not permitted', durationMs: 1 };
        }
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    await drain(agent.run(baseRequest, runtime));

    // 3 identical calls happen (each one bumps the streak); the 3rd is caught
    // before executing a 4th — proof this fires well short of maxTurns (20).
    expect(counters.shellCalls).toBe(2);

    // calls: 1=plan, 2=shell(streak 1, executes), 3=shell(streak 2, executes),
    // 4=shell(streak 3, TRIPPED — blocked, not executed). The correction lands in the
    // messages for the *next* call, i.e. index 4 (0-indexed) = the 5th call's input.
    const afterTrip = seenMessages[4];
    expect(afterTrip).toBeDefined();
    expect(afterTrip.some((m) => m.content.includes('ACTION_BLOCKED_DUPLICATE'))).toBe(true);
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
