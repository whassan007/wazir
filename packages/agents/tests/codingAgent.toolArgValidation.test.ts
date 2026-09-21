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

  it('rejects placeholder shell command "..." without executing the shell', async () => {
    let calls = 0;
    const executed: string[] = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
      async *generate() {
        calls += 1;
        const reply =
          calls === 1
            ? '{"action":"plan","content":"test"}'
            : calls === 2
              ? '{"action":"tool","tool":"shell","input":{"command":"..."}}' // placeholder!
              : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name): Promise<ToolResult> {
        if (name === 'shell') executed.push(name);
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    expect(executed).toEqual([]);
    const validationMsgs = turns.filter((t) => t.kind === 'message' && t.content?.includes('ACTION_VALIDATION_FAILED'));
    expect(validationMsgs.length).toBe(1);
    expect(validationMsgs[0].content).toContain('placeholder');
  });

  it('fails with errorKind protocol after 3 consecutive identical validation failures', async () => {
    const runtime: AgentRuntime = {
      tools: [{ name: 'glob', description: 'search files', inputSchema: {} }],
      async *generate() {
        // Continuously emits glob with no pattern or invalid placeholder
        const reply = '{"action":"tool","tool":"glob","input":{"pattern":"..."}}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    const errorTurn = turns.find((t) => t.kind === 'error');
    expect(errorTurn).toBeDefined();
    expect(errorTurn?.errorKind).toBe('protocol');
    expect(errorTurn?.error).toContain('protocol recovery failed');
  });

  it('executes native tool_call events from runtime without text parsing', async () => {
    let calls = 0;
    const executed: Array<{ name: string; input: unknown }> = [];
    const runtime: AgentRuntime = {
      tools: [{ name: 'shell', description: 'run command', inputSchema: {} }],
      async *generate() {
        calls += 1;
        if (calls === 1) {
          yield {
            type: 'tool_call',
            toolName: 'shell',
            toolInput: { command: 'ls -la' },
          };
          yield { type: 'completed' };
        } else {
          yield { type: 'token', content: '{"action":"done","summary":"finished"}' };
          yield { type: 'completed' };
        }
      },
      async executeTool(name, input): Promise<ToolResult> {
        if (name === 'shell') executed.push({ name, input });
        return { ok: true, output: 'total 0', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 5 }).run(baseRequest, runtime));

    expect(executed).toEqual([{ name: 'shell', input: { command: 'ls -la' } }]);
    const toolTurns = turns.filter((t) => t.kind === 'tool_call');
    expect(toolTurns.length).toBe(1);
    expect(toolTurns[0].tool).toBe('shell');
  });

  it('forbids mutating file tools (write, edit) during the PLAN phase, but permits them once IMPLEMENT phase starts', async () => {
    let calls = 0;
    const executedTools: Array<{ name: string; input: unknown }> = [];
    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read a file', inputSchema: {} },
        { name: 'write', description: 'write a file', inputSchema: {} },
      ],
      async *generate() {
        calls += 1;
        const reply =
          calls === 1
            ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"premature write"}}'
            : calls === 2
              ? '{"action":"plan","content":"1. write main.cpp 2. compile"}'
              : calls === 3
                ? '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"legitimate write"}}'
                : '{"action":"done","summary":"done"}';
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply };
      },
      async executeTool(name, input): Promise<ToolResult> {
        if (name === 'write') executedTools.push({ name, input });
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

    // The premature write in PLAN phase was blocked; only the write in IMPLEMENT phase executed
    expect(executedTools.length).toBe(1);
    expect(executedTools[0].input).toEqual({ path: 'main.cpp', content: 'legitimate write' });

    // Verify warning message was emitted for premature write
    const validationMessage = turns.find(
      (t) => t.kind === 'message' && t.content?.includes("'write' is not permitted during the planning phase"),
    );
    expect(validationMessage).toBeDefined();
  });
});
