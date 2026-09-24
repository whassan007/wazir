import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelRegistry,
  ModelLifecycleService,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { executeTask } from '../src/run.js';
import type { RookEngine } from '../src/engine.js';

/**
 * Real "Task -> Result" end-to-end test, replacing the placeholder that
 * used to live at tests/integration/endToEnd.test.ts (`expect(true).toBe
 * (true)`, with a comment saying full coverage "would require mocking all
 * dependencies"). This builds an actual RookEngine (real PolicyEngine, real
 * Scheduler, real ExecutionEngine, real ToolRegistry running real
 * filesystem/check tools against a scratch project directory) and only
 * fakes the one thing that's genuinely external: the model itself.
 */
async function buildTestEngine(projectRoot: string, scriptedReplies?: string[], executions = new ExecutionEngine()): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();

  computers.register({
    id: 'local',
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'fake',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });

  runtimes.update('fake', { health: 'healthy' });

  models.register({
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake',
    family: 'other',
    contextMax: 32_768,
    capabilities: ['generalChat', 'coding'],
    toolCalling: false,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'fake-model::local::fake',
    modelId: 'fake-model',
    computerId: 'local',
    runtimeId: 'fake',
    runtimeModelId: 'fake-model',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 32_768,
  });

  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
  const scheduler = new Scheduler({ computers, runtimes, models, agents });

  let callCount = 0;
  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async inspectModel(modelId) { return { modelId, loaded: true, effectiveContext: 32768 }; },
    async probeModel() { return true; },
    async discover() {
      return { id: 'fake', name: 'fake', version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: 'fake-model', name: 'fake-model' }];
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    // The only faked part of the whole pipeline: turn 1 writes a file
    // through the real `write` tool, turn 2 reports done. Everything else
    // (policy authorization, scheduling, the tool call, execution
    // recording, verification) is the genuine production code path.
    async *generate() {
      const replies = scriptedReplies ?? [
        '{"action":"plan","content":"write hello file"}',
        '{"action":"tool","tool":"write","input":{"path":"hello.txt","content":"hi from the fake model"}}',
        '{"action":"done","summary":"wrote hello.txt"}',
      ];
      const reply = replies[Math.min(callCount, replies.length - 1)];
      callCount += 1;
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };

  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: (modelId: string) => (modelId === 'fake-model' ? fakeAdapter : undefined),
  } as unknown as Worker;

  return {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters: new Map([['fake', fakeAdapter]]) }),
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
  };
}

describe('executeTask — real end-to-end Task -> Result flow', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails cleanly, instead of crashing, when the store rejects a write mid-run', async () => {
    // Phase 24 live run (exec-muf5bd29-1): another process changed the stored record, the
    // next write hit EXECUTION_STORAGE_CONFLICT, and the error escaped executeTask as a
    // fatal unhandledRejection because its own error path wrote to the record again.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-'));
    let conflicted = false;
    const executions = new ExecutionEngine({
      persist: (record) => {
        if (conflicted || record.events.some((e) => (e.eventType ?? e.type) === 'tool.call.started')) {
          conflicted = true;
          throw new Error(`EXECUTION_STORAGE_CONFLICT: ${record.execution.id}`);
        }
      },
    });
    const engine = await buildTestEngine(projectRoot, undefined, executions);

    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });

    expect(conflicted).toBe(true);
    expect(outcome.success).toBe(false);
    expect(outcome.reasons.join(' ')).toContain('EXECUTION_STORAGE_CONFLICT');
    expect(outcome.reasons.join(' ')).toContain('stopped rather than overwrite history');
  });

  it('plans, schedules, runs the agent loop through real policy-gated tools, and evaluates the result', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-'));
    const engine = await buildTestEngine(projectRoot);

    const outcome = await executeTask(engine, 'write a hello file', { quiet: true });

    expect(outcome.success).toBe(true);
    expect(outcome.errors).toEqual([]);
    expect(outcome.filesChanged).toContain('hello.txt');
    expect(outcome.result).toContain('hello.txt');

    // The real `write` tool actually ran against the real filesystem.
    const written = await fs.readFile(path.join(projectRoot, 'hello.txt'), 'utf8');
    expect(written).toBe('hi from the fake model');

    // The real ExecutionEngine actually recorded the run.
    const record = engine.executions.require(outcome.executionId);
    expect(record.execution.status).toBe('completed');
    expect(record.execution.owner).toEqual({ pid: process.pid, host: os.hostname() });
    expect(record.execution.computerId).toBe('local');
    expect(record.execution.modelId).toBe('fake-model');
    expect(record.toolCalls.some((c) => c.tool === 'write' && c.ok)).toBe(true);
    // Every tool call went through real policy authorization, not a bypass.
    expect(record.toolCalls.every((c) => c.policyEffect === 'allow')).toBe(true);
  });

  it('a task that writes source code but never compiles/tests it is NOT reported as a verified success', async () => {
    // Regression test for a real, live-observed false-positive-completion
    // bug: writing main.cpp and never running anything against it used to
    // still report "Task completed" (evaluateExecution() defaulted
    // success=true whenever nothing had explicitly failed, including the
    // "no checks were executed" case). See run.ts's touchesSourceCode() /
    // packages/evaluation/src/index.ts's checks_pass tightening.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-unverified-'));
    const engine = await buildTestEngine(projectRoot, [
      '{"action":"plan","content":"write main.cpp"}',
      '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){return 0;}"}}',
      '{"action":"done","summary":"Task completed. Verification checks passed."}',
    ]);

    const outcome = await executeTask(engine, 'write a c++ program', { quiet: true });

    expect(outcome.success).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('no checks were executed to verify against'))).toBe(true);
    // The model's own self-reported prose is still surfaced as `result`
    // (informational), but it must never be what drives `success`.
    expect(outcome.result).toContain('Verification checks passed');
  });

  it('a task that compiles source code via a raw `shell` call IS recorded as a real check and can succeed', async () => {
    // Companion regression test: the compiler must actually be *recognized*
    // as a check. This also pins the exact live bug found while verifying
    // the fix — BUILD_INVOCATION_PATTERN originally used a trailing `\b`
    // (word boundary), which never matches immediately after `g++`/`c++`
    // /`clang++` (neither the trailing '+' nor the following space is a
    // \w character, so there is no word/non-word transition for \b to
    // anchor on) — `(?=\s|$)` is required instead.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-verified-'));
    const engine = await buildTestEngine(projectRoot, [
      '{"action":"plan","content":"write and compile main.cpp"}',
      '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){return 0;}"}}',
      '{"action":"tool","tool":"shell","input":{"command":"g++ -std=c++17 -o main main.cpp && ./main"}}',
      '{"action":"done","summary":"compiled and ran successfully"}',
    ]);

    const outcome = await executeTask(engine, 'write and compile a c++ program', { quiet: true });

    expect(outcome.success).toBe(true);
    expect(outcome.reasons.some((r) => r.includes('all checks passed'))).toBe(true);

    const record = engine.executions.require(outcome.executionId);
    expect(record.checks).toHaveLength(1);
    expect(record.checks[0]).toMatchObject({ name: 'build', ok: true });
  });

  it('denies a tool call whose target path escapes the project root, end to end', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-'));
    const engine = await buildTestEngine(projectRoot);
    const adapter = engine.worker.adapterForModel('fake-model')!;

    // Override the scripted replies for this test: try to escape the
    // project root, then give up.
    let callCount = 0;
    adapter.generate = async function* () {
      const replies = [
        '{"action":"plan","content":"try to write outside"}',
        '{"action":"tool","tool":"write","input":{"path":"../../etc/escape.txt","content":"pwned"}}',
        '{"action":"done","summary":"gave up after the write was denied"}',
      ];
      const reply = replies[Math.min(callCount, replies.length - 1)];
      callCount += 1;
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5 } };
    };

    const outcome = await executeTask(engine, 'try to write outside the project', { quiet: true });

    expect(outcome.filesChanged).toEqual([]);
    const record = engine.executions.require(outcome.executionId);
    const writeCall = record.toolCalls.find((c) => c.tool === 'write');
    expect(writeCall?.ok).toBe(false);
    expect(writeCall?.policyEffect).toBe('deny');
    await expect(fs.access(path.join(projectRoot, '..', 'etc', 'escape.txt'))).rejects.toThrow();
  });

  it('emits newline-delimited JSON stream events when json option is provided', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-json-'));
    const engine = await buildTestEngine(projectRoot);

    const emittedLines: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = function (str: any) {
      if (typeof str === 'string') {
        emittedLines.push(str);
      }
      return true;
    } as any;

    try {
      const outcome = await executeTask(engine, 'create hello.txt containing "hi from json"', {
        json: true,
        quiet: true,
      });

      expect(outcome.success).toBe(true);

      const parsed = emittedLines
        .flatMap((l) => l.split('\n'))
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l));

      const types = parsed.map((p) => p.type);
      expect(types).toContain('start');
      expect(types).toContain('done');
      expect(parsed.some((p) => p.type === 'start' && p.taskId)).toBe(true);
      expect(parsed.some((p) => p.type === 'done' && p.executionId)).toBe(true);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
