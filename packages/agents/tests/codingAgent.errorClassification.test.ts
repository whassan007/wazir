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
 * `AgentTurn.errorKind` lets a consumer (retry policy, TUI, `wa executions inspect`) tell
 * "the model never produced a usable action" apart from "a real check failed" without
 * parsing prose out of the free-text `error` string. Also verifies `raw` — the exact model
 * response text a turn came from — is actually carried through, which is what let today's
 * live debugging (nvidia/nemotron-3-nano-omni's arguments silently vanishing) go straight
 * to the parser instead of guessing from the tool name alone.
 */
describe('CodingAgent.run — error classification and raw response capture', () => {
  it('tags "model repeatedly failed" as a protocol failure and carries the raw response', async () => {
    const runtime: AgentRuntime = {
      tools: [],
      async *generate() {
        // Never valid JSON — forces the correction budget to exhaust.
        const reply = 'I am thinking about this out loud without ever producing JSON.';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    const errorTurn = turns.find((t) => t.kind === 'error');
    expect(errorTurn?.error).toContain('repeatedly failed to produce valid JSON actions');
    expect(errorTurn?.errorKind).toBe('protocol');
    expect(errorTurn?.raw).toContain('thinking about this out loud');

    // Each individual bad attempt is now visible too (previously silent until the 3rd).
    const invalidTurns = turns.filter((t) => t.kind === 'message' && t.content?.startsWith('INVALID_JSON_ACTION'));
    expect(invalidTurns.length).toBeGreaterThan(0);
    expect(invalidTurns[0].raw).toContain('thinking about this out loud');
  });

  it('tags a verification failure as errorKind "verification"', async () => {
    let calls = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        calls += 1;
        const reply =
          calls === 1
            ? '{"action":"plan","content":"write it"}'
            : calls === 2
              ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"broken"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        if (name === 'write') return { ok: true, output: 'ok', durationMs: 1 };
        // test/lint/typecheck all fail -> VERIFY should report a verification failure.
        return { ok: false, output: '', error: `${name} failed`, durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    const errorTurn = turns.find((t) => t.kind === 'error');
    expect(errorTurn?.error).toContain('verification failed');
    expect(errorTurn?.errorKind).toBe('verification');
  });

  it('carries the raw response on a normal tool_call turn too', async () => {
    let calls = 0;
    const runtime: AgentRuntime = {
      tools: [{ name: 'glob', description: 'find files', inputSchema: {} }],
      async *generate() {
        calls += 1;
        const reply =
          calls === 1
            ? '{"action":"plan","content":"look around"}'
            : calls === 2
              ? '{"action":"tool","tool":"glob","input":{"pattern":"*.cpp"}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: '(no matches)', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    const toolTurn = turns.find((t) => t.kind === 'tool_call' && t.tool === 'glob');
    expect(toolTurn?.raw).toBe('{"action":"tool","tool":"glob","input":{"pattern":"*.cpp"}}');
  });
});
