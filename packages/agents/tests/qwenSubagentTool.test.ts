import { describe, expect, it } from 'vitest';
import {
  normalizeQwenToolAlias,
  normalizeQwenToolInput,
  createQwenSubagentExecutor,
  filterToolsForSubagentRole,
  WazirQwenAgent,
} from '../src/index.js';
import { SubagentsLedger, type AgentRuntime, type ToolResult } from '@wazir/core';

describe('Qwen Subagent Tool Tests (A038)', () => {
  it('normalizes Qwen Code task(prompt, subagent_type) alias to canonical dispatch_subagent(description, role)', () => {
    expect(
      normalizeQwenToolAlias('task', new Set(['read', 'dispatch_subagent'])),
    ).toBe('dispatch_subagent');

    expect(
      normalizeQwenToolInput('dispatch_subagent', {
        prompt: 'inspect router',
        subagent_type: 'Explore',
      }),
    ).toEqual({
      description: 'inspect router',
      role: 'explore',
    });
  });

  it('restricts explore and plan subagent roles strictly to read-only tools', async () => {
    const tools: AgentRuntime['tools'] = [
      { name: 'read', description: 'read a file', inputSchema: {} },
      { name: 'search', description: 'search codebase', inputSchema: {} },
      { name: 'write', description: 'write to a file', inputSchema: {} },
      { name: 'edit', description: 'edit a file', inputSchema: {} },
      { name: 'multi_edit', description: 'multi edit files', inputSchema: {} },
      { name: 'shell', description: 'execute shell commands', inputSchema: {} },
      { name: 'dispatch_subagent', description: 'dispatch subtask', inputSchema: {} },
    ];

    const exploreTools = filterToolsForSubagentRole(tools, 'explore');
    expect(exploreTools.map((t) => t.name)).toEqual(['read', 'search']);

    const planTools = filterToolsForSubagentRole(tools, 'plan');
    expect(planTools.map((t) => t.name)).toEqual(['read', 'search']);

    let callIdx = 0;
    const executedTools: string[] = [];
    const runtime: AgentRuntime = {
      tools,
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        callIdx += 1;
        if (callIdx === 1) {
          yield {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'write',
            toolInput: { path: 'hack.txt', content: 'nope' },
          };
          yield { type: 'completed', content: '' };
        } else {
          yield { type: 'token', content: 'Read-only check finished.' };
          yield { type: 'completed', content: 'Read-only check finished.' };
        }
      },
      async executeTool(name): Promise<ToolResult> {
        executedTools.push(name);
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const executor = createQwenSubagentExecutor({
      parentModelId: 'fake-model',
      parentProjectRoot: '/tmp/test',
      parentRuntime: runtime,
      maxDepth: 1,
    });

    const result = await executor({ description: 'Inspect files safely', role: 'explore' });
    expect(result.ok).toBe(true);
    expect(executedTools).not.toContain('write');
  });

  it('enforces maxDepth = 1 recursion guard on nested subagent attempts', async () => {
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read a file', inputSchema: {} }],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        yield { type: 'completed', content: 'finished' };
      },
      async executeTool(): Promise<ToolResult> {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const executor = createQwenSubagentExecutor({
      parentModelId: 'fake-model',
      parentProjectRoot: '/tmp/test',
      parentRuntime: runtime,
      maxDepth: 1,
      currentDepth: 1,
    });

    const result = await executor({ description: 'nested subtask', role: 'worker' });
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('POLICY_DENIED');
  });

  it('records subagent lifecycle (running -> completed) in SubagentsLedger via in-process WazirQwenAgent fallback', async () => {
    const ledger = new SubagentsLedger();
    const agent = new WazirQwenAgent({
      maxTurns: 4,
      subagentsLedger: ledger,
    });

    let parentCall = 0;
    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read a file', inputSchema: {} },
        { name: 'dispatch_subagent', description: 'dispatch subtask', inputSchema: {} },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate(request) {
        if (request.tools?.some((t) => t.name === 'dispatch_subagent')) {
          parentCall += 1;
          if (parentCall === 1) {
            yield {
              type: 'tool_call',
              toolCallId: 'tc-sub-1',
              toolName: 'task',
              toolInput: { prompt: 'read README', subagent_type: 'explore' },
            };
            yield { type: 'completed', content: '' };
          } else {
            yield { type: 'token', content: 'Parent finished using subagent summary.' };
            yield { type: 'completed', content: 'Parent finished using subagent summary.' };
          }
        } else {
          yield { type: 'token', content: 'README summary: project initialized.' };
          yield { type: 'completed', content: 'README summary: project initialized.' };
        }
      },
      async executeTool(name): Promise<ToolResult> {
        if (name === 'dispatch_subagent') {
          throw new Error('dispatch_subagent must be executed via the runtime harness');
        }
        return { ok: true, output: 'read result', durationMs: 1 };
      },
    };

    const turns = [];
    for await (const turn of agent.run(
      {
        modelId: 'fake-model',
        taskDescription: 'Inspect and summarize README.md in repository',
        taskType: 'coding',
        projectRoot: '/tmp/test',
        mutationRequired: false,
      },
      runtime,
    )) {
      turns.push(turn);
    }

    const snap = ledger.snapshot();
    expect(snap.counts.completed).toBe(1);
    expect(snap.tasks[0]?.source).toBe('explore');
    const doneTurn = turns.find((t) => t.kind === 'done');
    expect(doneTurn).toBeDefined();
  });

  it('allows worker role subagent to mutate authorized files while recording changed files in metadata', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = mkdtempSync(join(tmpdir(), 'wazir-subagent-worker-'));
    let step = 0;
    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read a file', inputSchema: {} },
        { name: 'write', description: 'write to a file', inputSchema: {} },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        step += 1;
        if (step === 1) {
          yield {
            type: 'tool_call',
            toolCallId: 'tc-w1',
            toolName: 'write',
            toolInput: { path: 'out.txt', content: 'hello' },
          };
          yield { type: 'completed', content: '' };
        } else {
          yield { type: 'token', content: 'Wrote out.txt.' };
          yield { type: 'completed', content: 'Wrote out.txt.' };
        }
      },
      async executeTool(name): Promise<ToolResult> {
        if (name === 'write') {
          writeFileSync(join(tempDir, 'out.txt'), 'hello', 'utf8');
          return {
            ok: true,
            output: 'file written',
            durationMs: 1,
            fileMutations: [
              {
                path: 'out.txt',
                attempted: true,
                succeeded: true,
                existedBefore: false,
                existsAfter: true,
                changed: true,
              },
            ],
          };
        }
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    try {
      const ledger = new SubagentsLedger();
      const executor = createQwenSubagentExecutor({
        ledger,
        parentModelId: 'fake-model',
        parentProjectRoot: tempDir,
        parentRuntime: runtime,
        maxDepth: 1,
      });

      const result = await executor({
        description: 'Create out.txt',
        role: 'worker',
        expectedArtifacts: ['out.txt'],
      });
      expect(result.ok).toBe(true);
      expect(result.metadata?.filesChanged).toContain('out.txt');
      expect(ledger.snapshot().counts.completed).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
