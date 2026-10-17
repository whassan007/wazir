import { describe, expect, it, vi } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRuntime, AgentTurn } from '@wazir/core';

describe('compiled tool surface protocol recovery', () => {
  it.each([false, true])('rejects alternating unavailable calls before dispatch (native=%s)', async native => {
    let calls = 0;
    const executeTool = vi.fn();
    const rt: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: {} }],
      runtimeCapabilities: { nativeToolCalling: native },
      async *generate() {
        const name = ['documentSymbols', 'findReferences', 'code_mode'][calls++ % 3];
        if (native) yield { type: 'tool_call', toolName: name, toolInput: {} };
        else yield { type: 'token', content: JSON.stringify({ action: 'tool', tool: name, input: {} }) };
        yield { type: 'completed' };
      }, executeTool,
    };
    const turns: AgentTurn[] = [];
    for await (const t of createCodingAgent().run({ modelId: 'fixture', taskType: 'coding', taskDescription: 'repair', projectRoot: '/tmp', maxTurns: 30 }, rt)) turns.push(t);
    expect(calls).toBe(3);
    expect(executeTool).not.toHaveBeenCalled();
    expect(turns.at(-1)?.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
    expect(turns.at(-1)?.error).toContain('smoke-tested');
  });

  it('advertises the current phase and native protocol in both prompt and schemas', async () => {
    let calls = 0;
    const rt: AgentRuntime = {
      tools: ['read', 'write'].map(name => ({ name, description: name, inputSchema: {} })),
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate(req) {
        calls++;
        const system = req.messages[0].content;
        expect(system).toContain('available native function');
        expect(system).not.toContain('MUST output exactly one JSON object');
        const names = req.tools?.map(t => t.name);
        if (calls === 1) {
          expect(names).not.toContain('write');
          expect(system).not.toContain('- write:');
          yield { type: 'token', content: '{"action":"plan","content":"inspect then implement"}' };
        } else {
          expect(names).toContain('write');
          expect(system).toContain('- write:');
          yield { type: 'token', content: '{"action":"done","summary":"fixture"}' };
        }
        yield { type: 'completed' };
      }, async executeTool() { return { ok: true, output: '', durationMs: 0 }; },
    };
    for await (const t of createCodingAgent({ maxRepairCycles: 0 }).run({ modelId: 'fixture', taskType: 'coding', taskDescription: 'repair', projectRoot: '/tmp', maxTurns: 2 }, rt)) { /* exhaust */ }
    expect(calls).toBe(2);
  });
});
