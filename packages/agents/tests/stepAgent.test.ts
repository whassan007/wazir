import { describe, expect, it } from 'vitest';
import { createStepAgent } from '../src/stepAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

const baseRequest: AgentRunRequest = {
  modelId: 'test-model',
  taskDescription: 'Create file src/main.cpp with hello world',
  taskType: 'coding',
  projectRoot: '/tmp/test-project',
  maxTurns: 10,
};

describe('StepAgent — Narrow Plan Step Executor', () => {
  it('executes tools and completes cleanly when action is done', async () => {
    const agent = createStepAgent();
    const toolExecutions: Array<{ name: string; input: Record<string, unknown> }> = [];

    let turnCount = 0;
    const runtime: AgentRuntime = {
      tools: [
        { name: 'write', description: 'write file', inputSchema: {} },
      ],
      async *generate() {
        turnCount += 1;
        if (turnCount === 1) {
          const content = '{"action":"tool","tool":"write","input":{"path":"src/main.cpp","content":"int main() {}"}}';
          yield { type: 'token', content };
          yield { type: 'completed', content };
        } else {
          const content = '{"action":"done","summary":"created src/main.cpp successfully"}';
          yield { type: 'token', content };
          yield { type: 'completed', content };
        }
      },
      async executeTool(name, input): Promise<ToolResult> {
        toolExecutions.push({ name, input });
        return { ok: true, output: 'wrote src/main.cpp', durationMs: 1 };
      },
    };

    const turns = await drain(agent.run(baseRequest, runtime));

    // Must yield tool_call and then done
    const toolCalls = turns.filter((t) => t.kind === 'tool_call');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].tool).toBe('write');
    expect(toolExecutions.length).toBe(1);

    const doneTurn = turns.find((t) => t.kind === 'done');
    expect(doneTurn).toBeDefined();
    expect(doneTurn?.content).toBe('created src/main.cpp successfully');
  });

  it('stops at bounded turn limit if model never says done', async () => {
    const agent = createStepAgent({ maxTurns: 3 });
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read file', inputSchema: {} }],
      async *generate() {
        const content = '{"action":"tool","tool":"read","input":{"path":"x.txt"}}';
        yield { type: 'token', content };
        yield { type: 'completed', content };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'contents', durationMs: 1 };
      },
    };

    // Use varying input so circuit breaker does not trip
    let seq = 0;
    const dynamicRuntime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read file', inputSchema: {} }],
      async *generate() {
        seq += 1;
        const content = `{"action":"tool","tool":"read","input":{"path":"file${seq}.txt"}}`;
        yield { type: 'token', content };
        yield { type: 'completed', content };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'contents', durationMs: 1 };
      },
    };

    const turns = await drain(agent.run({ ...baseRequest, maxTurns: 3 }, dynamicRuntime));
    const errorTurn = turns.find((t) => t.kind === 'error');
    expect(errorTurn).toBeDefined();
    expect(errorTurn?.error).toContain('reached turn limit (3 turns)');
  });

  it('trips circuit breaker if exact same tool and input repeated', async () => {
    const agent = createStepAgent({ toolRepeatLimit: 2 });
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read file', inputSchema: {} }],
      async *generate() {
        const content = '{"action":"tool","tool":"read","input":{"path":"repeat.txt"}}';
        yield { type: 'token', content };
        yield { type: 'completed', content };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: false, output: '', error: 'not found', durationMs: 1 };
      },
    };

    const turns = await drain(agent.run(baseRequest, runtime));
    const errorTurn = turns.find((t) => t.kind === 'error');
    expect(errorTurn).toBeDefined();
    expect(errorTurn?.error).toContain('circuit breaker');
  });
});
