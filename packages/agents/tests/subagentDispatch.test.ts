import { describe, expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ChatMessage, ToolResult } from '@wazir/core';

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

describe('Subagent Dispatch & Nesting Boundaries', () => {
  it('omits dispatch_subagent from tools when subagentDepth >= 1', async () => {
    const agent = createCodingAgent({ maxTurns: 5 });
    const seenTools: string[][] = [];

    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read a file', inputSchema: {} },
        { name: 'dispatch_subagent', description: 'dispatch subtask', inputSchema: {} },
      ],
      async *generate(request) {
        seenTools.push(request.tools ? request.tools.map((t) => t.name) : []);
        const reply = '{"action":"plan","content":"subagent plan"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    // When subagentDepth is 0 (root), dispatch_subagent is visible to the model
    await drain(
      agent.run(
        {
          modelId: 'fake-model',
          taskDescription: 'root task',
          taskType: 'coding',
          projectRoot: '/tmp/test',
          subagentDepth: 0,
        },
        runtime,
      ),
    );

    expect(seenTools[0]).toContain('dispatch_subagent');

    // When subagentDepth is 1 (nested), dispatch_subagent is filtered out
    seenTools.length = 0;
    await drain(
      agent.run(
        {
          modelId: 'fake-model',
          taskDescription: 'child task',
          taskType: 'coding',
          projectRoot: '/tmp/test',
          subagentDepth: 1,
        },
        runtime,
      ),
    );

    expect(seenTools[0]).not.toContain('dispatch_subagent');
    expect(seenTools[0]).toContain('read');
  });

  it('allows root agent to call dispatch_subagent and receive condensed tool result', async () => {
    const agent = createCodingAgent({ maxTurns: 5 });
    let turns = 0;
    const executedTools: string[] = [];

    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read a file', inputSchema: {} },
        { name: 'dispatch_subagent', description: 'dispatch subtask', inputSchema: {} },
      ],
      async *generate() {
        turns++;
        let reply = '';
        if (turns === 1) {
          reply = '{"action":"plan","content":"I will dispatch a subagent"}';
        } else if (turns === 2) {
          reply =
            '{"action":"tool","tool":"dispatch_subagent","input":{"description":"explore directory tree"}}';
        } else {
          reply = '{"action":"done","content":"finished parent task"}';
        }
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name, input): Promise<ToolResult> {
        executedTools.push(name);
        if (name === 'dispatch_subagent') {
          return {
            ok: true,
            output: '[Subagent execution exec-sub-1 completed]\nSummary: Found 5 files\nFiles changed: none',
            durationMs: 15,
          };
        }
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const results = await drain(
      agent.run(
        {
          modelId: 'fake-model',
          taskDescription: 'parent task',
          taskType: 'coding',
          projectRoot: '/tmp/test',
          subagentDepth: 0,
          mutationRequired: false,
        },
        runtime,
      ),
    );

    expect(executedTools).toContain('dispatch_subagent');
    const doneTurn = results.find((r) => r.kind === 'done');
    expect(doneTurn).toBeDefined();
  });
});
