import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime, AgentTurn, ChatMessage } from '@wazir/core';
import {
  ChatCompressionService,
  createCodingAgent,
  inferMutationRequired,
  loadProjectInstructions,
  parseXmlToolCalls,
  partitionAtomicTurnGroups,
  requiresWorkspaceGrounding,
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

  it('8. LoopDetectionService injects a pre-halt [loop warning] nudge when distinct empty searches approach maxNoProgressIterations', async () => {
    let turn = 0;
    const seenMessages: ChatMessage[][] = [];

    const rt: AgentRuntime = {
      tools: [{ name: 'glob', description: 'glob', inputSchema: { type: 'object' } }],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate(req) {
        turn += 1;
        seenMessages.push(structuredClone(req.messages));
        if (seenMessages.at(-1)?.some((m) => m.content.includes('empty or duplicate observations'))) {
          yield { type: 'token', content: 'Workspace contains no matching files; here is my review summary.' };
          yield { type: 'completed', finishReason: 'stop' };
          return;
        }
        yield {
          type: 'tool_call',
          toolCallId: `g_${turn}`,
          toolName: 'glob',
          toolInput: { pattern: `**/*.ext${turn}` },
        };
        yield { type: 'completed', finishReason: 'tool_calls' };
      },
      async executeTool() {
        // Every distinct glob returns the identical empty result -> novel observation on turn 1, then streak 1, 2, 3...
        return { ok: true, output: '', durationMs: 1 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent({ maxNoProgressIterations: 5, maxModelEscalations: 0 }).run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'review the code in the repo',
          taskType: 'coding',
          mutationRequired: false,
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(turns.at(-1)).toMatchObject({
      kind: 'done',
      content: 'Workspace contains no matching files; here is my review summary.',
    });
    expect(seenMessages.some((batch) => batch.some((m) => m.content.includes('[loop warning]')))).toBe(true);
  });

  it('9. Recovers from single-turn CONTEXT_PREFLIGHT_OVERFLOW via in-place tool trimming and escalates when window remains exhausted', async () => {
    const svc = new ChatCompressionService();
    const singleGroupMsgs: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'Inspect repo' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc1', name: 'read', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'read', arguments: { path: 'b.ts' } },
        ],
      },
      { role: 'tool', toolCallId: 'tc1', name: 'read', content: 'A'.repeat(24_000) },
      { role: 'tool', toolCallId: 'tc2', name: 'read', content: 'B'.repeat(24_000) },
    ];
    const trimNote = svc.trimOversizedToolOutputs({
      messages: singleGroupMsgs,
      effectiveContextTokens: 8192,
      toolSchemaTokens: 500,
    });
    expect(trimNote).toContain('trimmed 2 oversized tool output(s)');
    expect(singleGroupMsgs).toHaveLength(5);
    expect(singleGroupMsgs[3].toolCallId).toBe('tc1');
    expect(singleGroupMsgs[4].toolCallId).toBe('tc2');
    expect(singleGroupMsgs[3].content.length).toBeLessThan(12_000);

    // End-to-end agent escalation when 8k model keeps overflowing even after forced compaction
    const modelsCalled: string[] = [];
    let currentWindow = 8192;
    const rt: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
      runtimeCapabilities: { nativeToolCalling: true },
      getContextTokens: () => currentWindow,
      async escalate(req) {
        expect(req.currentModelId).toBe('qwen-9b-8k');
        expect(req.failureClass).toBe('RESOURCE_EXHAUSTED');
        currentWindow = 32_768;
        return { modelId: 'qwen-30b-32k', reason: 'escalated to 32k context model' };
      },
      async *generate(req) {
        modelsCalled.push(req.modelId);
        if (req.modelId === 'qwen-9b-8k') {
          yield {
            type: 'error',
            error: 'CONTEXT_PREFLIGHT_OVERFLOW: Prompt requires 16356 tokens, available 8192',
            failureClass: 'MODEL_CONTEXT_OVERFLOW',
          };
          return;
        }
        yield { type: 'token', content: 'Completed review on 32k model.' };
        yield { type: 'completed', finishReason: 'stop' };
      },
      async executeTool() {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent({ maxModelEscalations: 2 }).run(
        {
          modelId: 'qwen-9b-8k',
          taskDescription: 'review VLA forge code and provide recommendations',
          taskType: 'coding',
          mutationRequired: false,
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(modelsCalled).toContain('qwen-30b-32k');
    expect(turns.some((t) => t.content?.includes('model escalated: qwen-9b-8k -> qwen-30b-32k'))).toBe(true);
    expect(turns.at(-1)).toMatchObject({ kind: 'done', content: 'Completed review on 32k model.' });
  });

  it('12. Infers mutation & workspace grounding for file-targeted prompts and nudges 0-tool-call answers', async () => {
    expect(
      inferMutationRequired({
        modelId: 'm',
        taskDescription: 'Thread countryCode parameter across taxRate.ts and checkout.ts',
        taskType: 'coding',
        projectRoot: root,
      }),
    ).toBe(true);
    expect(
      inferMutationRequired({
        modelId: 'm',
        taskDescription: 'Include algorithm metadata in computeDigest.ts and tokenVerifier.ts',
        taskType: 'coding',
        projectRoot: root,
      }),
    ).toBe(true);
    expect(
      requiresWorkspaceGrounding({
        modelId: 'm',
        taskDescription: 'Check HTTP status mapping in errors.ts for RateLimitError',
        taskType: 'coding',
        projectRoot: root,
      }),
    ).toBe(true);
    expect(
      requiresWorkspaceGrounding({
        modelId: 'm',
        taskDescription: 'What is 12 * 8?',
        taskType: 'coding',
        projectRoot: root,
      }),
    ).toBe(false);

    let turn = 0;
    let readCalled = false;
    const rt: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'token', content: 'RateLimitError maps to 500.' };
          yield { type: 'completed', finishReason: 'stop' };
        } else if (turn === 2) {
          yield {
            type: 'tool_call',
            toolCallId: 'call_read_1',
            toolName: 'read',
            toolInput: { path: 'errors.ts' },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'token', content: 'RateLimitError maps to 429.' };
          yield { type: 'completed', finishReason: 'stop' };
        }
      },
      async executeTool(name) {
        if (name === 'read') readCalled = true;
        return { ok: true, output: 'export const RateLimitError = 429;', durationMs: 1 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent().run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Check HTTP status mapping in errors.ts for RateLimitError',
          taskType: 'coding',
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(readCalled).toBe(true);
    expect(turns.at(-1)).toMatchObject({
      kind: 'done',
      content: 'RateLimitError maps to 429.',
      terminationReason: 'VERIFICATION_PASSED',
    });
  });

  it('13. ChatCompressionService.maybeCompressWithModel uses LLM <state_snapshot> and falls back deterministically on error', async () => {
    const svc = new ChatCompressionService();
    const mkMessages = (): ChatMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Fix bug in auth.ts' },
      {
        role: 'assistant',
        content: 'reading auth.ts',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'auth.ts' } }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'read', content: 'x'.repeat(2500) },
      {
        role: 'assistant',
        content: 'editing auth.ts',
        toolCalls: [{ id: 'c2', name: 'edit', arguments: { path: 'auth.ts', oldString: 'a', newString: 'b' } }],
      },
      { role: 'tool', toolCallId: 'c2', name: 'edit', content: 'edited' },
      {
        role: 'assistant',
        content: 'testing',
        toolCalls: [{ id: 'c3', name: 'test', arguments: {} }],
      },
      { role: 'tool', toolCallId: 'c3', name: 'test', content: 'passed' },
    ];

    const llmMsgs = mkMessages();
    const llmNote = await svc.maybeCompressWithModel({
      messages: llmMsgs,
      request: { modelId: 'm', taskDescription: 'Fix bug in auth.ts', taskType: 'coding', projectRoot: root },
      effectiveContextTokens: 8192,
      maxTokensPerTurn: 2048,
      toolSchemaTokens: 500,
      compactionRatio: 0.7,
      filesChanged: new Set(['auth.ts']),
      unresolvedDiagnostics: null,
      webEvidence: new Map(),
      force: true,
      summarize: async () => '<state_snapshot><key_knowledge>auth.ts line 12 fixed</key_knowledge></state_snapshot>',
    });
    expect(llmNote).toContain('context compacted (LLM)');
    expect(llmMsgs.some((m) => m.content.includes('auth.ts line 12 fixed'))).toBe(true);

    const fallbackMsgs = mkMessages();
    const fallbackNote = await svc.maybeCompressWithModel({
      messages: fallbackMsgs,
      request: { modelId: 'm', taskDescription: 'Fix bug in auth.ts', taskType: 'coding', projectRoot: root },
      effectiveContextTokens: 8192,
      maxTokensPerTurn: 2048,
      toolSchemaTokens: 500,
      compactionRatio: 0.7,
      filesChanged: new Set(['auth.ts']),
      unresolvedDiagnostics: null,
      webEvidence: new Map(),
      force: true,
      summarize: async () => {
        throw new Error('model timeout');
      },
    });
    expect(fallbackNote).toContain('context compacted:');
    expect(fallbackMsgs.some((m) => m.content.includes('<state_snapshot>'))).toBe(true);
  });

  it('14. Read-only review progress: diverse read/search calls do NOT trigger NO_PROGRESS', async () => {
    let turn = 0;
    const rt: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: { type: 'object' } },
        { name: 'search', description: 'search', inputSchema: { type: 'object' } },
        { name: 'glob', description: 'glob', inputSchema: { type: 'object' } },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate() {
        turn += 1;
        if (turn <= 6) {
          const isRead = turn % 2 === 1;
          yield {
            type: 'tool_call',
            toolCallId: `ro_${turn}`,
            toolName: isRead ? 'read' : 'search',
            toolInput: isRead ? { path: `src/file${turn}.ts` } : { pattern: `sym_${turn}` },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'token', content: 'Review complete: inspected 3 files and 3 symbols.' };
          yield { type: 'completed', finishReason: 'stop' };
        }
      },
      async executeTool(name, input) {
        return {
          ok: true,
          output: `unique result for ${name}:${JSON.stringify(input)}`,
          durationMs: 1,
        };
      },
    };

    const turns = await collectTurns(
      createCodingAgent({ maxNoProgressIterations: 3 }).run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Review the auth and billing modules',
          taskType: 'review',
          mutationRequired: false,
          projectRoot: root,
        },
        rt,
      ),
    );

    expect(turns.some((t) => t.terminationReason === 'NO_PROGRESS')).toBe(false);
    expect(turns.at(-1)).toMatchObject({
      kind: 'done',
      content: 'Review complete: inspected 3 files and 3 symbols.',
      terminationReason: 'VERIFICATION_PASSED',
    });
  });

  it('15. Read-only duplicate scan suppression issues synthesis nudge and allows clean synthesis without NO_PROGRESS', async () => {
    let turn = 0;
    const seenToolCounts: number[] = [];
    const seenMessages: ChatMessage[][] = [];

    const rt: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: { type: 'object' } },
        { name: 'glob', description: 'glob', inputSchema: { type: 'object' } },
        { name: 'search', description: 'search', inputSchema: { type: 'object' } },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      async *generate(req) {
        turn += 1;
        seenToolCounts.push(req.tools?.length ?? 0);
        seenMessages.push(structuredClone(req.messages));
        if (turn === 1) {
          yield {
            type: 'tool_call',
            toolCallId: 'r_1',
            toolName: 'read',
            toolInput: { path: 'src/index.ts' },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else if (turn <= 8 && (req.tools?.length ?? 0) > 0) {
          // Repeated distinct directory scans returning empty results
          yield {
            type: 'tool_call',
            toolCallId: `scan_${turn}`,
            toolName: turn % 2 === 0 ? 'glob' : 'search',
            toolInput: { pattern: `missing_${turn}` },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield {
            type: 'token',
            content: 'Synthesized findings from src/index.ts: entry point exports startServer().',
          };
          yield { type: 'completed', finishReason: 'stop' };
        }
      },
      async executeTool(name) {
        if (name === 'read') {
          return { ok: true, output: 'export function startServer() { return 42; }', durationMs: 1 };
        }
        return { ok: true, output: 'No matches found.', durationMs: 1 };
      },
    };

    const turns = await collectTurns(
      createCodingAgent({ maxNoProgressIterations: 8, maxModelEscalations: 0 }).run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Review src/index.ts and summarize findings',
          taskType: 'review',
          mutationRequired: false,
          projectRoot: root,
        },
        rt,
      ),
    );

    // Did not burn 8 turns of scans and did not crash with NO_PROGRESS
    expect(turn).toBeLessThanOrEqual(7);
    expect(turns.some((t) => t.terminationReason === 'NO_PROGRESS')).toBe(false);
    expect(
      turns.some(
        (t) =>
          t.kind === 'message' &&
          t.content?.includes('Synthesize your findings from the files already read instead of repeating directory scans'),
      ),
    ).toBe(true);
    // Final synthesis turn had tools stripped (0 tools)
    expect(seenToolCounts.at(-1)).toBe(0);
    expect(turns.at(-1)).toMatchObject({
      kind: 'done',
      terminationReason: 'VERIFICATION_PASSED',
    });
  });

  it('16. Context overflow prevention on 8192-token runtime: trims/compacts/strips optional schemas and never resends unchanged oversized prompt', async () => {
    // Part A: Preflight trims oversized tool output + strips optional schemas so 8k turn succeeds
    let turnA = 0;
    const toolNamesPerCallA: string[][] = [];
    const maxMsgCharsPerCallA: number[] = [];

    const rtA: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: { type: 'object' } },
        { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
        { name: 'read_many_files', description: 'read many', inputSchema: { type: 'object', properties: { pad: { type: 'string', description: 'x'.repeat(2000) } } } },
        { name: 'multi_edit', description: 'multi edit', inputSchema: { type: 'object', properties: { pad: { type: 'string', description: 'y'.repeat(2000) } } } },
        { name: 'todo_write', description: 'todo', inputSchema: { type: 'object', properties: { pad: { type: 'string', description: 'z'.repeat(2000) } } } },
        { name: 'web_search', description: 'web search', inputSchema: { type: 'object', properties: { pad: { type: 'string', description: 'w'.repeat(2000) } } } },
      ],
      runtimeCapabilities: { nativeToolCalling: true },
      getContextTokens: () => 8192,
      async *generate(req) {
        turnA += 1;
        toolNamesPerCallA.push((req.tools ?? []).map((t) => t.name));
        maxMsgCharsPerCallA.push(Math.max(...req.messages.map((m) => m.content.length)));
        if (turnA === 1) {
          yield { type: 'tool_call', toolCallId: 'big_read', toolName: 'read', toolInput: { path: 'big.ts' } };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'token', content: 'Reviewed big.ts within 8192-token budget.' };
          yield { type: 'completed', finishReason: 'stop' };
        }
      },
      async executeTool() {
        return { ok: true, output: 'LINE\n'.repeat(6000), durationMs: 1 };
      },
    };

    const turnsA = await collectTurns(
      createCodingAgent({ maxModelEscalations: 0 }).run(
        {
          modelId: 'qwen-8k',
          taskDescription: 'Review big.ts',
          taskType: 'review',
          mutationRequired: false,
          projectRoot: root,
        },
        rtA,
      ),
    );

    expect(turnsA.at(-1)).toMatchObject({ kind: 'done', terminationReason: 'VERIFICATION_PASSED' });
    // Turn 2 saw trimmed tool output and/or stripped optional schemas
    expect(maxMsgCharsPerCallA[1]).toBeLessThan(24_000);

    // Part B: Unrecoverable oversized prompt on 8192-token runtime returns RESOURCE_EXHAUSTED without resending unchanged prompt
    let generateCallsB = 0;
    const rtB: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
      runtimeCapabilities: { nativeToolCalling: true },
      getContextTokens: () => 8192,
      async *generate() {
        generateCallsB += 1;
        yield {
          type: 'error',
          error: 'MODEL_CONTEXT_OVERFLOW: Prompt exceeds 8192 tokens',
          failureClass: 'MODEL_CONTEXT_OVERFLOW',
        };
      },
      async executeTool() {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const turnsB = await collectTurns(
      createCodingAgent({ maxModelEscalations: 0 }).run(
        {
          modelId: 'qwen-8k',
          taskDescription: 'Review this huge prompt: ' + 'word '.repeat(5000),
          taskType: 'review',
          mutationRequired: false,
          projectRoot: root,
        },
        rtB,
      ),
    );

    expect(generateCallsB).toBe(0);
    expect(turnsB.at(-1)).toMatchObject({
      kind: 'error',
      terminationReason: 'RESOURCE_EXHAUSTED',
    });
    expect(turnsB.at(-1)?.error).toContain('MODEL_CONTEXT_OVERFLOW');
  });
});
