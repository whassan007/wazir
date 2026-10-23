import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentResumeContext,
  AgentRuntime,
  ChatMessage,
  ToolResult,
} from '@wazir/core';
import {
  HARNESS_CONTRACT_SCHEMA_VERSION,
  NativeHarnessAdapter,
  createNativeChatHarnessAdapter,
  createNativeCodingHarnessAdapter,
  createNativeStepHarnessAdapter,
  type UnifiedExecutionRequest,
} from '../src/nativeHarnessAdapter.js';

function createBaseRequest(overrides: Partial<UnifiedExecutionRequest> = {}): UnifiedExecutionRequest {
  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: 'exec-test-1',
    taskId: 'task-test-1',
    objective: 'Implement src/add.ts and ensure tests pass',
    taskType: 'coding',
    modelPreference: 'qwen2.5-coder:7b',
    runtimePreference: 'ollama',
    workspace: {
      root: '/tmp/wazir-native-test',
      revision: 1,
    },
    constraints: {
      maxTurns: 15,
      maxToolCalls: 25,
      maxTokens: 100_000,
      maxDurationMs: 30_000,
      allowFallback: true,
    },
    verification: {
      requiredChecks: ['test'],
      protectedPaths: [],
      mutationRequired: true,
    },
    policyContext: {
      localOnly: true,
      toolAccess: true,
    },
    ...overrides,
  };
}

function createScriptedRuntime(
  replies: Array<{
    content: string;
    delayMs?: number;
    usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  }>,
  toolHandler?: (name: string, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): { runtime: AgentRuntime; seenMessages: ChatMessage[][]; cancelSpy: ReturnType<typeof vi.fn> } {
  let turnIdx = 0;
  const seenMessages: ChatMessage[][] = [];
  const cancelSpy = vi.fn();

  const runtime: AgentRuntime = {
    tools: [
      { name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'write', description: 'Write file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
      { name: 'edit', description: 'Edit file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } } } },
      { name: 'glob', description: 'Glob files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
      { name: 'search', description: 'Search files', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'shell', description: 'Run shell', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
      { name: 'git', description: 'Run git', inputSchema: { type: 'object', properties: { args: { type: 'array' } } } },
      { name: 'test', description: 'Run tests', inputSchema: { type: 'object', properties: {} } },
      { name: 'build', description: 'Run build', inputSchema: { type: 'object', properties: {} } },
      { name: 'lint', description: 'Run lint', inputSchema: { type: 'object', properties: {} } },
      { name: 'typecheck', description: 'Run typecheck', inputSchema: { type: 'object', properties: {} } },
    ],
    cancelCurrentTurn: cancelSpy,
    async *generate(req) {
      seenMessages.push(req.messages.map((m) => ({ ...m })));
      const item = replies[Math.min(turnIdx++, replies.length - 1)];
      if (item.delayMs && item.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delayMs));
      }
      yield { type: 'token', content: item.content };
      yield {
        type: 'completed',
        content: item.content,
        usage: item.usage ?? { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      };
    },
    async executeTool(name, input) {
      if (toolHandler) {
        return await toolHandler(name, input);
      }
      return { ok: true, output: `ok:${name}`, durationMs: 5 };
    },
  };

  return { runtime, seenMessages, cancelSpy };
}

describe('NativeHarnessAdapter — Cross-Harness Execution Contract', () => {
  it('1. exposes a valid native HarnessDescriptor and completes a coding task with apparent completion (verified: false) when no external verification evidence is bound', async () => {
    const adapter = createNativeCodingHarnessAdapter();
    expect(adapter.descriptor.kind).toBe('native');
    expect(adapter.descriptor.harnessId).toBe('wazir-coding');
    expect(adapter.descriptor.supportedProtocols).toEqual(['native']);
    expect(adapter.descriptor.allowsModelSelection).toBe(true);
    expect(adapter.descriptor.capabilities).toEqual(
      expect.arrayContaining(['coding', 'streaming', 'tool-Forwarding', 'checkpoint-resume', 'cancellation']),
    );

    const { runtime } = createScriptedRuntime(
      [
        { content: '{"action":"plan","content":"1. write src/add.ts 2. finish"}' },
        { content: '{"action":"tool","tool":"write","input":{"path":"src/add.ts","content":"export const add = (a: number, b: number) => a + b;"}}' },
        { content: '{"action":"done","summary":"Implemented src/add.ts and verified."}' },
      ],
      (name, input) => {
        if (name === 'write') {
          return {
            ok: true,
            output: 'wrote src/add.ts',
            durationMs: 4,
            fileMutations: [
              {
                path: String(input.path),
                attempted: true,
                succeeded: true,
                existedBefore: false,
                existsAfter: true,
                changed: true,
              },
            ],
          };
        }
        return { ok: true, output: `${name} passed`, durationMs: 6 };
      },
    );

    const result = await adapter.execute(createBaseRequest(), runtime);

    expect(result.schemaVersion).toBe(HARNESS_CONTRACT_SCHEMA_VERSION);
    expect(result.executionId).toBe('exec-test-1');
    expect(result.taskId).toBe('task-test-1');
    expect(result.harnessId).toBe('wazir-coding');
    expect(result.harnessKind).toBe('native');
    expect(result.modelId).toBe('qwen2.5-coder:7b');
    expect(result.runtimeId).toBe('ollama');
    expect(result.status).toBe('completed');
    // Invariant 1: apparent completion is NOT verified until controller verification binds evidence
    expect(result.verified).toBe(false);
    expect(result.terminationReason).toBe('COMPLETED');
    expect(result.verificationEvidenceIds).toEqual([]);
    expect(result.filesChanged).toEqual(['src/add.ts']);
    expect(result.workspaceRevision).toBe('2');
    expect(result.output).toBe('Implemented src/add.ts and verified.');
    expect(result.provenance?.contractDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('2. distinguishes apparent completion from verified completion via verifyOutcome hook at the final workspace revision', async () => {
    const adapter = createNativeCodingHarnessAdapter();
    const { runtime } = createScriptedRuntime([
      { content: '{"action":"plan","content":"write file"}' },
      { content: '{"action":"tool","tool":"write","input":{"path":"src/index.ts","content":"export default 42;"}}' },
      { content: '{"action":"done","summary":"Done"}' },
    ]);

    const verifyOutcome = vi.fn(async (_req, _turns, workspaceRevision) => ({
      verified: true,
      evidenceIds: [`evd-test-${workspaceRevision}`, `evd-build-${workspaceRevision}`],
      checks: [
        {
          name: 'test' as const,
          command: 'vitest run',
          ok: true,
          output: '1 passed',
          durationMs: 12,
          workspaceRevision: Number(workspaceRevision),
        },
      ],
    }));

    const result = await adapter.execute(createBaseRequest(), {
      runtime,
      verifyOutcome,
    });

    expect(verifyOutcome).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.terminationReason).toBe('VERIFICATION_PASSED');
    expect(result.verificationEvidenceIds).toEqual(['evd-test-2', 'evd-build-2']);
    expect(result.checks?.some((c) => c.command === 'vitest run' && c.ok)).toBe(true);
  });

  it('3. fails with VERIFICATION_FAILED when verifyOutcome rejects apparent completion', async () => {
    const adapter = createNativeCodingHarnessAdapter();
    const { runtime } = createScriptedRuntime([
      { content: '{"action":"plan","content":"write file"}' },
      { content: '{"action":"tool","tool":"write","input":{"path":"src/broken.ts","content":"syntax error"}}' },
      { content: '{"action":"done","summary":"All good!"}' },
    ]);

    const result = await adapter.execute(createBaseRequest(), {
      runtime,
      verifyOutcome: async (_req, _turns, workspaceRevision) => ({
        verified: false,
        evidenceIds: [`evd-fail-${workspaceRevision}`],
        checks: [
          {
            name: 'test',
            command: 'vitest run',
            ok: false,
            output: 'FAIL src/broken.ts',
            durationMs: 15,
            workspaceRevision: Number(workspaceRevision),
          },
        ],
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.verified).toBe(false);
    expect(result.terminationReason).toBe('VERIFICATION_FAILED');
    expect(result.errorKind).toBe('verification');
    expect(result.failureClassification).toBe('VERIFICATION_FAILED');
    expect(result.errors?.some((e) => e.includes('rejected apparent completion'))).toBe(true);
  });

  it('4. normalizes ToolCallRecord[] and ToolCallCheckpoint[] across read-only, mutating, and check tools', async () => {
    const adapter = createNativeCodingHarnessAdapter();
    const { runtime } = createScriptedRuntime(
      [
        { content: '{"action":"plan","content":"inspect then write"}' },
        { content: '{"action":"tool","tool":"read","input":{"path":"README.md"}}' },
        { content: '{"action":"tool","tool":"write","input":{"path":"src/feature.ts","content":"export const x = 1;"}}' },
        { content: '{"action":"done","summary":"Feature written"}' },
      ],
      (name) => {
        if (name === 'read') {
          return { ok: true, output: '# Project', durationMs: 3, metadata: { sandbox: 'none' } };
        }
        if (name === 'write') {
          return {
            ok: true,
            output: 'written',
            durationMs: 7,
            fileMutations: [
              {
                path: 'src/feature.ts',
                attempted: true,
                succeeded: true,
                existedBefore: false,
                existsAfter: true,
                changed: true,
              },
            ],
          };
        }
        return { ok: true, output: 'check ok', durationMs: 10 };
      },
    );

    const result = await adapter.execute(createBaseRequest(), runtime);

    // read + write + host-side verification checks (build, test, lint, typecheck)
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(3);
    const readCall = result.toolCalls.find((c) => c.tool === 'read');
    const writeCall = result.toolCalls.find((c) => c.tool === 'write');
    expect(readCall).toMatchObject({
      tool: 'read',
      input: { path: 'README.md' },
      ok: true,
      output: '# Project',
      policyEffect: 'allow',
    });
    expect(writeCall).toMatchObject({
      tool: 'write',
      input: { path: 'src/feature.ts', content: 'export const x = 1;' },
      ok: true,
      policyEffect: 'allow',
    });

    const checkpoints = adapter.getToolCheckpoints();
    const readCp = checkpoints.find((c) => c.toolName === 'read');
    const writeCp = checkpoints.find((c) => c.toolName === 'write');
    expect(readCp?.sideEffectClass).toBe('READ_ONLY');
    expect(readCp?.state).toBe('COMPLETED');
    expect(writeCp?.sideEffectClass).toBe('IDEMPOTENT_WRITE');
    expect(writeCp?.state).toBe('COMPLETED');
  });

  it('5. tracks token usage, modelCalls, firstTokenLatencyMs, and enforces Invariant 3 monetary cost semantics (LOCAL=0 ACTUAL, PRICED=ESTIMATED, UNPRICED=UNKNOWN)', async () => {
    const replies = [
      { content: '{"action":"plan","content":"plan"}', delayMs: 15, usage: { inputTokens: 200, outputTokens: 50 } },
      { content: '{"action":"tool","tool":"write","input":{"path":"a.ts","content":"1"}}', usage: { inputTokens: 300, outputTokens: 60 } },
      { content: '{"action":"done","summary":"done"}', usage: { inputTokens: 400, outputTokens: 90 } },
    ];

    // Case A: Local runtime (ollama) -> costUSD: 0, costStatus: 'ACTUAL'
    const localAdapter = createNativeCodingHarnessAdapter();
    const { runtime: localRt } = createScriptedRuntime(replies);
    const localResult = await localAdapter.execute(createBaseRequest({ runtimePreference: 'ollama' }), localRt);

    expect(localResult.usage.inputTokens).toBe(900);
    expect(localResult.usage.outputTokens).toBe(200);
    expect(localResult.usage.totalTokens).toBe(1100);
    expect(localResult.usage.modelCalls).toBe(3);
    expect(localResult.usage.firstTokenLatencyMs).toBeGreaterThanOrEqual(10);
    expect(localResult.usage.costUSD).toBe(0);
    expect(localResult.usage.costStatus).toBe('ACTUAL');

    // Case B: Priced remote runtime -> costUSD > 0, costStatus: 'ESTIMATED'
    const pricedAdapter = createNativeCodingHarnessAdapter({
      isLocalRuntime: false,
      pricing: {
        inputCostPerMillionUsd: 1000, // $0.001 per token for easy math
        outputCostPerMillionUsd: 2000,
      },
    });
    const { runtime: pricedRt } = createScriptedRuntime(replies);
    const pricedResult = await pricedAdapter.execute(
      createBaseRequest({ runtimePreference: 'openai-api', modelPreference: 'gpt-4o' }),
      pricedRt,
    );
    expect(pricedResult.usage.costStatus).toBe('ESTIMATED');
    expect(pricedResult.usage.costUSD).toBeCloseTo((900 / 1_000_000) * 1000 + (200 / 1_000_000) * 2000, 6);

    // Case C: Unpriced remote runtime -> costStatus: 'UNKNOWN', costUSD: undefined (never 0)
    const unpricedAdapter = createNativeCodingHarnessAdapter({ isLocalRuntime: false });
    const { runtime: unpricedRt } = createScriptedRuntime(replies);
    const unpricedResult = await unpricedAdapter.execute(
      createBaseRequest({ runtimePreference: 'anthropic-cloud', modelPreference: 'claude-sonnet' }),
      unpricedRt,
    );
    expect(unpricedResult.usage.costStatus).toBe('UNKNOWN');
    expect(unpricedResult.usage.costUSD).toBeUndefined();
  });

  it('6. supports cooperative and abort cancellation mid-run and invokes checkpoint hook', async () => {
    const onCheckpoint = vi.fn(async (execId: string) => `ckpt-cancel-${execId}`);
    const adapter = createNativeCodingHarnessAdapter({ onCheckpoint });

    let callCount = 0;
    const cancelSpy = vi.fn();
    const runtime: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: {} }],
      cancelCurrentTurn: cancelSpy,
      async *generate() {
        callCount += 1;
        if (callCount === 1) {
          const c = '{"action":"plan","content":"inspect"}';
          yield { type: 'token', content: c };
          yield { type: 'completed', content: c };
          return;
        }
        // Trigger adapter.cancel() while turn 2 is streaming
        adapter.cancel();
        yield { type: 'token', content: '{"action":"tool"' };
      },
      async executeTool() {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const result = await adapter.execute(createBaseRequest(), runtime);

    expect(result.status).toBe('cancelled');
    expect(result.terminationReason).toBe('CANCELLED');
    expect(result.errorKind).toBe('cancelled');
    expect(result.failureClassification).toBe('EXECUTION_CANCELLED');
    expect(result.checkpointId).toBe('ckpt-cancel-exec-test-1');
    expect(onCheckpoint).toHaveBeenCalledWith('exec-test-1');
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('7. maps max-turns and protocol failure termination reasons accurately', async () => {
    const adapter = createNativeCodingHarnessAdapter({
      codingAgentOptions: { maxModelEscalations: 0 },
    });

    // Protocol failure: 3 consecutive invalid JSON responses
    const { runtime: badProtocolRt } = createScriptedRuntime([
      { content: 'I am rambling without any JSON object at all.' },
      { content: 'Still rambling without JSON.' },
      { content: 'Third time no JSON.' },
    ]);

    const protocolResult = await adapter.execute(
      createBaseRequest({ constraints: { maxTurns: 10, allowFallback: false } }),
      badProtocolRt,
    );

    expect(protocolResult.status).toBe('failed');
    expect(protocolResult.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
    expect(protocolResult.errorKind).toBe('protocol');
    expect(protocolResult.failureClassification).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');

    // Max turns failure: valid reads until turn limit reached
    let readSeq = 0;
    const maxTurnsRt: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: {} },
        { name: 'write', description: 'write', inputSchema: {} },
      ],
      async *generate() {
        readSeq += 1;
        const c =
          readSeq === 1
            ? '{"action":"plan","content":"read files"}'
            : `{"action":"tool","tool":"read","input":{"path":"file-${readSeq}.ts"}}`;
        yield { type: 'token', content: c };
        yield { type: 'completed', content: c };
      },
      async executeTool(_name, input) {
        return { ok: true, output: `content of ${String(input.path)}`, durationMs: 1 };
      },
    };

    const maxTurnsResult = await adapter.execute(
      createBaseRequest({ constraints: { maxTurns: 3, allowFallback: false } }),
      maxTurnsRt,
    );

    expect(maxTurnsResult.status).toBe('failed');
    expect(maxTurnsResult.terminationReason).toBe('MAX_TURNS');
    expect(maxTurnsResult.failureClassification).toBe('MAX_TURNS');
  });

  it('8. maps interrupted stream and OUTCOME_UNKNOWN mutating tool calls with checkpoint creation', async () => {
    const onCheckpoint = vi.fn(async (execId: string) => `ckpt-int-${execId}`);
    const adapter = createNativeCodingHarnessAdapter({ onCheckpoint });

    // Case A: Mutating tool throws mid-flight with unknown outcome
    const { runtime: unknownToolRt } = createScriptedRuntime(
      [
        { content: '{"action":"plan","content":"write file"}' },
        { content: '{"action":"tool","tool":"write","input":{"path":"src/critical.ts","content":"data"}}' },
      ],
      async (name) => {
        if (name === 'write') {
          throw new Error('TOOL_OUTCOME_UNKNOWN: worker connection reset during write');
        }
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    );

    const unknownResult = await adapter.execute(createBaseRequest(), unknownToolRt);

    expect(unknownResult.status).toBe('unknown');
    expect(unknownResult.verified).toBe(false);
    expect(unknownResult.failureClassification).toBe('TOOL_OUTCOME_UNKNOWN');
    expect(unknownResult.checkpointId).toBe('ckpt-int-exec-test-1');
    const writeCheckpoint = adapter.getToolCheckpoints().find((cp) => cp.toolName === 'write');
    expect(writeCheckpoint?.state).toBe('OUTCOME_UNKNOWN');

    // Case B: Stream interrupted mid-generation without completion
    const interruptedRt: AgentRuntime = {
      tools: [{ name: 'read', description: 'read', inputSchema: {} }],
      async *generate() {
        yield { type: 'token', content: '{"action":"plan"' };
        // Ends without 'completed' event -> CodingAgent throws INCOMPLETE_PROVIDER_STREAM
      },
      async executeTool() {
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };

    const intResult = await adapter.execute(createBaseRequest({ executionId: 'exec-int-2' }), interruptedRt);
    expect(intResult.status).toBe('interrupted');
    expect(intResult.checkpointId).toBe('ckpt-int-exec-int-2');
    expect(intResult.failureClassification).toBe('EXECUTION_INTERRUPTED');
  });

  it('9. forwards AgentResumeContext into the native agent and preserves prior filesChanged, workspaceRevision, and consumed budgets', async () => {
    const adapter = createNativeCodingHarnessAdapter();
    const resumeContext: AgentResumeContext = {
      executionId: 'exec-resume-1',
      attempt: 2,
      workspaceRevision: 5,
      filesChanged: ['src/alreadyModified.ts'],
      consumed: { toolCalls: 4, tokens: 2000 },
      verification: { passing: ['build'], failing: ['test'], stale: 0 },
      previousTermination: 'MAX_TURNS',
      lastError: 'MAX_TURNS: reached turn limit',
      reconciled: ["'write' APPLIED: verified on disk"],
    };

    const { runtime, seenMessages } = createScriptedRuntime([
      { content: '{"action":"plan","content":"verify existing change"}', usage: { inputTokens: 100, outputTokens: 20 } },
      { content: '{"action":"tool","tool":"read","input":{"path":"src/alreadyModified.ts"}}', usage: { inputTokens: 100, outputTokens: 20 } },
      { content: '{"action":"done","summary":"Verified resumed change"}', usage: { inputTokens: 100, outputTokens: 20 } },
    ]);

    const result = await adapter.execute(
      createBaseRequest({
        executionId: 'exec-resume-1',
        workspace: { root: '/tmp/wazir-resume', revision: 5 },
        resumeContext,
      }),
      {
        runtime,
        verificationEvidenceIds: ['evd-resumed-pass'],
      },
    );

    // Verify resume briefing was injected into initial prompt
    expect(seenMessages[0][1].content).toContain('RESUMING execution exec-resume-1 (attempt 2)');
    expect(seenMessages[0][1].content).toContain('Files already changed on disk: src/alreadyModified.ts');
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.terminationReason).toBe('VERIFICATION_PASSED');
    expect(result.workspaceRevision).toBe('5');
    expect(result.filesChanged).toContain('src/alreadyModified.ts');
    // Net tokens for this attempt = 3 * 120 = 360 (not double-counting prior 2000)
    expect(result.usage.totalTokens).toBe(360);
  });

  it('10. enforces verification.protectedPaths before dispatching mutating tools', async () => {
    const adapter = createNativeCodingHarnessAdapter();
    const executedTools: string[] = [];

    const { runtime } = createScriptedRuntime(
      [
        { content: '{"action":"plan","content":"try writing protected config then write allowed file"}' },
        { content: '{"action":"tool","tool":"write","input":{"path":".env.production","content":"SECRET=1"}}' },
        { content: '{"action":"tool","tool":"write","input":{"path":"src/safe.ts","content":"export const safe = true;"}}' },
        { content: '{"action":"done","summary":"Wrote safe file"}' },
      ],
      (name, input) => {
        executedTools.push(`${name}:${String(input.path ?? '')}`);
        return {
          ok: true,
          output: 'ok',
          durationMs: 2,
          fileMutations:
            name === 'write'
              ? [
                  {
                    path: String(input.path),
                    attempted: true,
                    succeeded: true,
                    existedBefore: false,
                    existsAfter: true,
                    changed: true,
                  },
                ]
              : undefined,
        };
      },
    );

    const result = await adapter.execute(
      createBaseRequest({
        verification: {
          requiredChecks: ['test'],
          protectedPaths: ['.env.production', 'secrets/'],
          mutationRequired: true,
        },
      }),
      runtime,
    );

    // .env.production write was blocked by adapter before reaching runtime.executeTool
    expect(executedTools).not.toContain('write:.env.production');
    expect(executedTools).toContain('write:src/safe.ts');

    const deniedCall = result.toolCalls.find((c) => c.tool === 'write' && (c.input as any)?.path === '.env.production');
    expect(deniedCall).toBeDefined();
    expect(deniedCall?.ok).toBe(false);
    expect(deniedCall?.policyEffect).toBe('deny');
    expect(deniedCall?.policyRule).toBe('verification.protectedPaths');
    expect(result.status).toBe('completed');
    expect(result.filesChanged).toEqual(['src/safe.ts']);
  });

  it('11. wraps ChatAgent and StepAgent seamlessly under the same UnifiedExecutionRequest/Result contract', async () => {
    // ChatAgent test
    const chatAdapter = createNativeChatHarnessAdapter();
    expect(chatAdapter.descriptor.harnessId).toBe('wazir-chat');
    expect(chatAdapter.descriptor.capabilities).toContain('chat');

    const { runtime: chatRt } = createScriptedRuntime([
      { content: '42 is the answer', usage: { inputTokens: 25, outputTokens: 5 } },
    ]);

    const chatResult = await chatAdapter.execute(
      createBaseRequest({
        taskType: 'chat',
        objective: 'What is 6 * 7?',
        verification: { requiredChecks: [], protectedPaths: [], mutationRequired: false },
      }),
      chatRt,
    );

    expect(chatResult.status).toBe('completed');
    expect(chatResult.output).toBe('42 is the answer');
    expect(chatResult.usage.totalTokens).toBe(30);

    // StepAgent test with real temp directory artifact hash check
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'wazir-step-test-'));
    try {
      const stepAdapter = createNativeStepHarnessAdapter();
      expect(stepAdapter.descriptor.harnessId).toBe('wazir-step');
      expect(stepAdapter.descriptor.capabilities).toContain('step-execution');

      const { runtime: stepRt } = createScriptedRuntime(
        [
          { content: '{"action":"tool","tool":"write","input":{"path":"step.txt","content":"step output"}}' },
          { content: '{"action":"done","summary":"Created step.txt"}' },
        ],
        (name, input) => {
          if (name === 'write') {
            const full = path.join(tmpDir, String(input.path));
            writeFileSync(full, String(input.content), 'utf8');
            return { ok: true, output: 'wrote step.txt', durationMs: 2 };
          }
          return { ok: true, output: 'ok', durationMs: 1 };
        },
      );

      const stepResult = await stepAdapter.execute(
        createBaseRequest({
          workspace: { root: tmpDir, revision: 10 },
          verification: {
            requiredChecks: [],
            protectedPaths: [],
            mutationRequired: true,
            expectedArtifacts: ['step.txt'],
          },
        }),
        stepRt,
      );

      expect(stepResult.status).toBe('completed');
      expect(stepResult.workspaceRevision).toBe('11');
      expect(stepResult.filesChanged).toEqual(['step.txt']);
      expect(stepResult.artifacts).toHaveLength(1);
      expect(stepResult.artifacts[0].path).toBe('step.txt');
      expect(stepResult.artifacts[0].hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('12. tracks model escalation updates in UnifiedExecutionResult.modelId when allowFallback is true', async () => {
    const adapter = new NativeHarnessAdapter({
      codingAgentOptions: { maxModelEscalations: 1 },
    });

    let turnCount = 0;
    const runtime: AgentRuntime = {
      tools: [
        { name: 'read', description: 'read', inputSchema: {} },
        { name: 'write', description: 'write', inputSchema: {} },
      ],
      escalate: async (req) => ({
        modelId: 'qwen2.5-coder:32b',
        reason: `Escalating from ${req.currentModelId} after ${req.failureClass}`,
      }),
      async *generate() {
        turnCount += 1;
        // First 3 turns emit unparseable text to trigger protocol escalation
        if (turnCount <= 3) {
          const bad = 'unparseable prose without json';
          yield { type: 'token', content: bad };
          yield { type: 'completed', content: bad };
          return;
        }
        if (turnCount === 4) {
          const plan = '{"action":"plan","content":"write with escalated model"}';
          yield { type: 'token', content: plan };
          yield { type: 'completed', content: plan };
          return;
        }
        if (turnCount === 5) {
          const write = '{"action":"tool","tool":"write","input":{"path":"esc.ts","content":"export const ok = 1;"}}';
          yield { type: 'token', content: write };
          yield { type: 'completed', content: write };
          return;
        }
        const done = '{"action":"done","summary":"Completed after model escalation"}';
        yield { type: 'token', content: done };
        yield { type: 'completed', content: done };
      },
      async executeTool(name) {
        if (name === 'write') {
          return {
            ok: true,
            output: 'wrote esc.ts',
            durationMs: 2,
            fileMutations: [
              {
                path: 'esc.ts',
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

    const result = await adapter.execute(
      createBaseRequest({
        modelPreference: 'qwen2.5-coder:1.5b',
        constraints: { maxTurns: 15, allowFallback: true },
      }),
      runtime,
    );

    expect(result.status).toBe('completed');
    expect(result.modelId).toBe('qwen2.5-coder:32b');
    expect(result.filesChanged).toEqual(['esc.ts']);
  });
});
