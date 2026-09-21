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

/**
 * Regression for a real transcript against nvidia/nemotron-3-nano-omni: the model
 * repeatedly emitted tool calls with required arguments missing (`write({})`,
 * `read({})`, `shell({})`), each of which used to run the full tool/policy pipeline
 * just to bounce off a generic denial ("requires a path argument") — a full turn spent
 * per attempt, framed as an authorization decision rather than a missing argument.
 * These now get rejected locally before the tool ever runs, with a specific message.
 */
describe('CodingAgent.run — tool argument validation', () => {
  it('rejects a malformed write({}) before it ever reaches executeTool, then accepts the corrected call', async () => {
    let calls = 0;
    let executeToolCalls = 0;
    const seenMessages: ChatMessage[][] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate(request) {
        calls += 1;
        seenMessages.push(request.messages);
        const reply =
          calls === 1
            ? '{"action":"plan","content":"write the file"}'
            : calls === 2
              ? '{"action":"tool","tool":"write","input":{}}' // malformed: no path/content
              : calls === 3
                ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}'
                : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        // VERIFY always probes test/lint/typecheck too; only 'write' calls are relevant here.
        if (name === 'write') executeToolCalls += 1;
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    // The malformed call (call 2) must never reach the real tool executor — only the
    // corrected call (call 3) does.
    expect(executeToolCalls).toBe(1);

    // The next turn's messages (index 3 = the 4th call's input) must see a specific,
    // actionable correction, not a generic tool-result.
    const afterRejection = seenMessages[2]; // input to call 3, right after call 2 was rejected
    expect(afterRejection.some((m) => m.content.includes('ACTION_VALIDATION_FAILED'))).toBe(true);
    expect(afterRejection.some((m) => m.content.includes("missing required argument(s): path, content"))).toBe(true);
  });

  it('rejects read({}) and shell({}) the same way, without ever executing them', async () => {
    let calls = 0;
    const executed: string[] = [];
    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read a file', inputSchema: {} },
        { name: 'shell', description: 'run a shell command', inputSchema: {} },
      ],
      async *generate() {
        calls += 1;
        const reply =
          calls === 1
            ? '{"action":"plan","content":"inspect"}'
            : calls === 2
              ? '{"action":"tool","tool":"read","input":{}}'
              : calls === 3
                ? '{"action":"tool","tool":"shell","input":{}}'
                : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        if (name === 'read' || name === 'shell') executed.push(name);
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    expect(executed).toEqual([]);
  });

  it('does not reject a write whose content is a legitimate empty string', async () => {
    let calls = 0;
    const executed: Array<{ name: string; input: unknown }> = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        calls += 1;
        const reply =
          calls === 1
            ? '{"action":"plan","content":"create an empty file"}'
            : calls === 2
              ? '{"action":"tool","tool":"write","input":{"path":"empty.txt","content":""}}'
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name, input): Promise<ToolResult> {
        if (name === 'write') executed.push({ name, input });
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    expect(executed).toEqual([{ name: 'write', input: { path: 'empty.txt', content: '' } }]);
  });
});
