import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime, AgentTurn, ChatMessage } from '@wazir/core';
import {
  ChatCompressionService,
  createCodingAgent,
  loadProjectInstructions,
  parseXmlToolCalls,
  partitionAtomicTurnGroups,
} from '../src/codingAgent.js';

async function collectTurns(iter: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const out: AgentTurn[] = [];
  for await (const t of iter) out.push(t);
  return out;
}

describe('WazirQwenAgent — Qwen Code 1.0 Core Loop Transplant', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wazir-qwen-core-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('1. Direct 1-turn conversational answer even when taskType="coding" and all tools are available', async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const rt: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: { type: 'object' } },
        { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
        { name: 'build', description: 'build', inputSchema: { type: 'object' } },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        modelCalls += 1;
        yield { type: 'token', content: '96' };
        yield { type: 'completed', finishReason: 'stop' };
      },
      async executeTool() {
        toolCalls += 1;
        return { ok: true, output: '', durationMs: 0 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent().run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'What is 12 * 8? Reply with only the number.',
          taskType: 'coding', // simulates default `wa run`
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect(turns.at(-1)).toMatchObject({
      kind: 'done',
      content: '96',
      terminationReason: 'VERIFICATION_PASSED',
    });
  });

  it('2. Transparently normalizes habitual Qwen/Claude aliases (read_file, replace + snake_case) and XML <tool_call> fallbacks', async () => {
    const dispatched: Array<{ name: string; input: Record<string, unknown> }> = [];
    let turn = 0;

    const rt: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: { type: 'object' } },
        { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        turn += 1;
        if (turn === 1) {
          // Emit Qwen3Coder XML fallback using habitual `read_file` alias
          yield {
            type: 'token',
            content: '<tool_call><function=read_file><parameter=file_path>src/app.ts</parameter></function></tool_call>',
          };
          yield { type: 'completed', finishReason: 'stop' };
        } else if (turn === 2) {
          // Emit native `replace` alias with snake_case keys
          yield {
            type: 'tool_call',
            toolCallId: 'call_edit_1',
            toolName: 'replace',
            toolInput: {
              file_path: 'src/app.ts',
              old_string: 'const port = 3000;',
              new_string: 'const port = 8080;',
            },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'token', content: 'Updated port to 8080.' };
          yield { type: 'completed', finishReason: 'stop' };
        }
      },
      async executeTool(name, input) {
        dispatched.push({ name, input });
        if (name === 'read') {
          return { ok: true, output: '1: const port = 3000;', durationMs: 1 };
        }
        if (name === 'edit') {
          return {
            ok: true,
            output: 'edited src/app.ts',
            durationMs: 1,
            fileMutations: [
              {
                path: 'src/app.ts',
                attempted: true,
                succeeded: true,
                existedBefore: true,
                existsAfter: true,
                changed: true,
              },
            ],
          };
        }
        return { ok: false, output: 'unknown tool', durationMs: 0 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent().run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Update port in src/app.ts to 8080',
          taskType: 'coding',
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(dispatched).toEqual([
      { name: 'read', input: { path: 'src/app.ts' } },
      {
        name: 'edit',
        input: expect.objectContaining({
          path: 'src/app.ts',
          oldString: 'const port = 3000;',
          newString: 'const port = 8080;',
        }),
      },
    ]);
    expect(turns.at(-1)).toMatchObject({ kind: 'done', content: 'Updated port to 8080.' });
  });

  it('3. Decision #1: Skips build/test/lint/typecheck automatically on pure documentation edits unless --full-verify is set', async () => {
    const checksRun: string[] = [];
    const makeRuntime = (): AgentRuntime => {
      let turn = 0;
      return {
        tools: [
          { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
          { name: 'build', description: 'build', inputSchema: { type: 'object' } },
          { name: 'test', description: 'test', inputSchema: { type: 'object' } },
        ],
        runtimeCapabilities: { nativeToolCalling: true },
        async *generate() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: 'tool_call',
              toolCallId: 'doc_1',
              toolName: 'edit',
              toolInput: { path: 'README.md', oldString: '# Old', newString: '# New' },
            };
            yield { type: 'completed', finishReason: 'tool_calls' };
          } else {
            yield { type: 'token', content: 'Updated README heading.' };
            yield { type: 'completed', finishReason: 'stop' };
          }
        },
        async executeTool(name) {
          if (name === 'build' || name === 'test') {
            checksRun.push(name);
            return { ok: true, output: 'passed', durationMs: 1 };
          }
          return {
            ok: true,
            output: 'edited README.md',
            durationMs: 1,
            fileMutations: [
              {
                path: 'README.md',
                attempted: true,
                succeeded: true,
                existedBefore: true,
                existsAfter: true,
                changed: true,
              },
            ],
          };
        },
      };
    };

    // Default: doc-only edit skips build/test
    const defaultTurns = await collectTurns(
      createCodingAgent().run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Update README.md heading',
          taskType: 'coding',
          projectRoot: root,
        },
        makeRuntime(),
      ),
    );
    expect(checksRun).toEqual([]);
    expect(defaultTurns.some((t) => t.content?.includes('documentation-only changes'))).toBe(true);
    expect(defaultTurns.at(-1)?.kind).toBe('done');

    // Explicit --full-verify: runs build & test even for doc-only edit
    await collectTurns(
      createCodingAgent().run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Update README.md heading',
          taskType: 'coding',
          projectRoot: root,
          fullVerification: true,
        },
        makeRuntime(),
      ),
    );
    expect(checksRun).toEqual(['build', 'test']);
  });

  it('4. ChatCompressionService compacts into <state_snapshot> without splitting assistant.toolCalls from role:"tool" messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Refactor module' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
          { id: 'c2', name: 'read', arguments: { path: 'b.ts' } },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'read', content: 'x'.repeat(2000) },
      { role: 'tool', toolCallId: 'c2', name: 'read', content: 'y'.repeat(2000) },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c3', name: 'todo_write', arguments: { todos: [] } }],
      },
      { role: 'tool', toolCallId: 'c3', name: 'todo_write', content: '[x] (1) Read files\n[>] (2) Edit c.ts' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c4', name: 'read', arguments: { path: 'c.ts' } }],
      },
      { role: 'tool', toolCallId: 'c4', name: 'read', content: 'export const c = 3;' },
    ];

    const groups = partitionAtomicTurnGroups(messages, 2);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(3); // assistant + 2 tool responses kept together

    const svc = new ChatCompressionService();
    const note = svc.maybeCompress({
      messages,
      request: {
        modelId: 'qwen3-coder',
        taskDescription: 'Refactor module',
        taskType: 'coding',
        projectRoot: '/tmp',
      },
      effectiveContextTokens: 2048,
      maxTokensPerTurn: 256,
      toolSchemaTokens: 100,
      compactionRatio: 0.3,
      filesChanged: new Set(['a.ts']),
      unresolvedDiagnostics: null,
      webEvidence: new Map(),
      force: true,
    });

    expect(note).toContain('<state_snapshot>');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('<state_snapshot>');
    expect(messages[2].content).toContain('a.ts, b.ts');

    // Verify invariant: every remaining `role: 'tool'` is immediately preceded by an assistant toolCalls group containing its ID
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        let j = i - 1;
        while (j >= 0 && messages[j].role === 'tool') j--;
        expect(messages[j]?.role).toBe('assistant');
        const ids = messages[j]?.toolCalls?.map((tc) => tc.id) ?? [];
        expect(ids).toContain(messages[i].toolCallId);
      }
    }
  });

  it('5. LoopDetectionService issues a 2nd-call warning nudge before halting on 3rd identical call', async () => {
    let turn = 0;
    const seenMessages: ChatMessage[][] = [];

    const rt: AgentRuntime = {
      tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate(req) {
        turn += 1;
        seenMessages.push(structuredClone(req.messages));
        yield {
          type: 'tool_call',
          toolCallId: `s_${turn}`,
          toolName: 'search',
          toolInput: { pattern: 'nonexistent_symbol' },
        };
        yield { type: 'completed', finishReason: 'tool_calls' };
      },
      async executeTool() {
        return { ok: true, output: 'No matches found.', durationMs: 1 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent({ toolRepeatLimit: 3, maxModelEscalations: 0 }).run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Find nonexistent_symbol',
          taskType: 'code_analysis',
          mutationRequired: false,
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(turn).toBe(3);
    // Turn 3 saw the loop warning injected after Turn 2
    expect(seenMessages[2].some((m) => m.content.includes('[loop warning]'))).toBe(true);
    expect(turns.at(-1)).toMatchObject({
      kind: 'error',
      terminationReason: 'REPEATED_ACTION',
    });
  });

  it('6. Loads .wazir/instructions.md and QWEN.md inside <project_instructions trust="untrusted_repo_context">', async () => {
    await mkdir(join(root, '.wazir'), { recursive: true });
    await writeFile(join(root, '.wazir/instructions.md'), 'Prefer vitest over jest.');
    await writeFile(join(root, 'QWEN.md'), 'Use 2-space indentation.');

    const block = loadProjectInstructions(root);
    expect(block).toContain('<project_instructions trust="untrusted_repo_context">');
    expect(block).toContain('Prefer vitest over jest.');
    expect(block).toContain('Use 2-space indentation.');
  });

  it('7. parseXmlToolCalls parses both Qwen2.5 JSON <tool_call> and Qwen3 <function=...> formats', () => {
    const qwen25 = parseXmlToolCalls(
      'Let me check.\n<tool_call>{"name": "read", "arguments": {"path": "foo.ts", "limit": 50}}</tool_call>',
      1,
    );
    expect(qwen25.strippedContent).toBe('Let me check.');
    expect(qwen25.calls).toEqual([
      { id: 'xml-call-1-0', name: 'read', input: { path: 'foo.ts', limit: 50 } },
    ]);

    const qwen3 = parseXmlToolCalls(
      '<tool_call><function=search><parameter=pattern>TODO</parameter><parameter=path>src</parameter></function></tool_call>',
      2,
    );
    expect(qwen3.calls).toEqual([
      { id: 'xml-call-2-0', name: 'search', input: { pattern: 'TODO', path: 'src' } },
    ]);
  });
});
