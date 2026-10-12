import { expect, it } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRuntime, AgentRunRequest } from '@wazir/core';
const request: AgentRunRequest = { modelId: 'test', taskDescription: 'Look up two numbers and add them', taskType: 'code_analysis', projectRoot: '/tmp', mutationRequired: false };
it('preserves native call IDs and tool results through the real agent and accepts a verified native final answer', async () => {
  let turn = 0;
  const runtime: AgentRuntime = {
    tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } }],
    runtimeCapabilities: { nativeToolCalling: true },
    async *generate(req) {
      if (turn++ === 0) yield { type: 'tool_call', toolName: 'lookup', toolCallId: 'provider-call-1', toolInput: { key: 'fact' } };
      else {
        expect(req.messages.find(m => m.role === 'assistant' && m.toolCalls)?.toolCalls).toEqual([{ id: 'provider-call-1', name: 'lookup', arguments: { key: 'fact' } }]);
        expect(req.messages.find(m => m.role === 'tool')).toMatchObject({ toolCallId: 'provider-call-1', content: '42' });
        yield { type: 'token', content: 'The answer is 42.' };
      }
      yield { type: 'completed', finishReason: turn === 1 ? 'tool_calls' : 'stop' };
    },
    async executeTool(name) { return name === 'lookup' ? { ok: true, output: '42', durationMs: 0 } : { ok: false, output: 'missing script', durationMs: 0 }; },
  };
  const events = [];
  for await (const event of createCodingAgent().run(request, runtime)) events.push(event);
  expect(events.at(-1)).toMatchObject({ kind: 'done', content: 'The answer is 42.', terminationReason: 'VERIFICATION_PASSED' });
  expect(turn).toBe(2);
});
it('rejects a parallel batch without executing any of it, then recovers on a single call', async () => {
  const executed: string[] = [];
  let turn = 0;
  const runtime: AgentRuntime = {
    tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } }],
    runtimeCapabilities: { nativeToolCalling: true },
    async *generate(req) {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_call', toolName: 'lookup', toolCallId: 'one', toolInput: { key: 'a' } };
        yield { type: 'tool_call', toolName: 'lookup', toolCallId: 'two', toolInput: { key: 'b' } };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      if (turn === 2) {
        // The batch never became history, so no unanswered call ids reach the provider.
        expect(req.messages.some((m) => m.toolCalls?.length)).toBe(false);
        expect(req.messages.at(-1)?.content).toContain('Issue exactly one tool call per turn');
        yield { type: 'tool_call', toolName: 'lookup', toolCallId: 'three', toolInput: { key: 'a' } };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'token', content: 'The answer is 42.' };
      yield { type: 'completed', finishReason: 'stop' };
    },
    async executeTool(name, input) { executed.push(`${name}:${JSON.stringify(input)}`); return { ok: true, output: '42', durationMs: 0 }; },
  };
  const events = [];
  for await (const event of createCodingAgent().run(request, runtime)) events.push(event);
  expect(executed.filter((e) => e.startsWith('lookup'))).toEqual(['lookup:{"key":"a"}']);
  expect(events.some((e: any) => String(e.content ?? '').startsWith('PARALLEL_TOOL_CALLS_REJECTED'))).toBe(true);
  expect(events.at(-1)).toMatchObject({ kind: 'done', content: 'The answer is 42.' });
});

it('preserves a native final answer after the planning phase has ended', async () => {
  let calls = 0;
  const runtime: AgentRuntime = {
    tools: [], runtimeCapabilities: { nativeToolCalling: true },
    async *generate() {
      const text = ++calls === 1 ? '{"action":"plan","content":"compute the answer"}' : 'The answer is 67231.';
      yield { type: 'token', content: text }; yield { type: 'completed', finishReason: 'stop' };
    },
    async executeTool() { return { ok: false, output: 'missing script', durationMs: 0 }; },
  };
  const events = [];
  for await (const event of createCodingAgent().run(request, runtime)) events.push(event);
  expect(events.at(-1)).toMatchObject({ kind: 'done', content: 'The answer is 67231.' });
});
