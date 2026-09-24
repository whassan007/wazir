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
 * `process-tools.ts`'s `toToolResult` always sets `error` to a short
 * "<command> exited with code N" summary on failure, with the actual
 * compiler/test diagnostics in `output`. Regression for a bug where every
 * call site that reported a failed tool result picked `result.error` over
 * `result.output` (via `result.error ?? result.output`) — since `error` is
 * never empty on failure, the model never saw *why* a command failed, only
 * that it had, and was left guess-and-checking blind.
 */
it('feeds the model the real compiler diagnostics, not just the exit-code summary, on a failed shell call', async () => {
  const seenMessages: ChatMessage[][] = [];
  let calls = 0;
  const runtime: AgentRuntime = {
    tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
    async *generate(request) {
      calls += 1;
      seenMessages.push(request.messages);
      const reply =
        calls === 1
          ? '{"action":"plan","content":"compile it"}'
          : calls === 2
            ? '{"action":"tool","tool":"shell","input":{"command":"g++ main.cpp -o a.out"}}'
            : '{"action":"done","summary":"done"}';
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(): Promise<ToolResult> {
      return {
        ok: false,
        output: "main.cpp:3:1: error: expected ';' before 'return'",
        error: 'g++ main.cpp -o a.out exited with code 1',
        durationMs: 1,
      };
    },
  };

  await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

  // The 3rd generate() call (index 2) is the one that follows the failed shell
  // tool result, so its incoming messages must contain the real diagnostic.
  const messagesAfterFailure = seenMessages[2];
  const toolResultMessage = messagesAfterFailure.find((m) => m.content.includes('[tool result for shell'));
  expect(toolResultMessage).toBeDefined();
  expect(toolResultMessage!.content).toContain("expected ';' before 'return'");
  expect(toolResultMessage!.content).toContain('exited with code 1');
});

/**
 * Phase 3: observation compaction. A huge failed build must reach the model as a compact
 * summary (exit code, failing files, primary errors), while the raw output survives
 * unmodified in the `tool_call` turn — the execution evidence callers persist.
 */
it('compacts a huge failed build for the model while keeping the raw output as evidence', async () => {
  const seenMessages: ChatMessage[][] = [];
  let calls = 0;
  const noise = Array.from({ length: 3000 }, (_, i) => `note: candidate ${i} ignored`).join('\n');
  const raw = `${noise}\nmain.cpp:47:5: error: call to 'swap' is ambiguous\n1 error generated.`;
  const runtime: AgentRuntime = {
    tools: [{ name: 'shell', description: 'run a shell command', inputSchema: {} }],
    async *generate(request) {
      calls += 1;
      seenMessages.push(request.messages);
      const reply =
        calls === 1
          ? '{"action":"plan","content":"compile it"}'
          : calls === 2
            ? '{"action":"tool","tool":"shell","input":{"command":"g++ main.cpp -o a.out"}}'
            : '{"action":"done","summary":"done"}';
      yield { type: 'token', content: reply };
      yield { type: 'completed', content: reply };
    },
    async executeTool(): Promise<ToolResult> {
      return { ok: false, output: raw, error: 'g++ main.cpp -o a.out exited with code 1', durationMs: 1 };
    },
  };

  const turns = await drain(createCodingAgent({ maxTurns: 10 }).run(baseRequest, runtime));

  const evidence = turns.find((t) => t.kind === 'tool_call' && t.tool === 'shell');
  expect(evidence?.toolResult?.output).toBe(raw);

  const toolResultMessage = seenMessages[2].find((m) => m.content.includes('[tool result for shell'));
  expect(toolResultMessage!.content).toContain('exitCode: 1');
  expect(toolResultMessage!.content).toContain("main.cpp:47: call to 'swap' is ambiguous");
  expect(toolResultMessage!.content).not.toContain('candidate 5 ignored');
  expect(toolResultMessage!.content.length).toBeLessThan(5000);
});
