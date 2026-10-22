import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerationEvent, GenerationRequest, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { createEngine, type RookEngine } from '../src/engine.js';
import { planTask, executeTask, runSubagent } from '../src/run.js';
import { runTaskCommand, taskStatusCommand } from '../src/commands.js';

function fakeAdapter(
  script: (req: GenerationRequest) => AsyncIterable<GenerationEvent>,
  onCancel?: (requestId: string) => void,
): RuntimeAdapter {
  return {
    id: 'ollama',
    info: { id: 'ollama', name: 'Fake Ollama', version: 'test', endpoint: 'mock://local', local: true },
    capabilities: { streaming: true, toolCalling: true, embeddings: false, vision: false, structuredOutput: true },
    healthCheck: async () => 'healthy',
    discoverModels: async () => [],
    loadModel: async () => {},
    unloadModel: async () => {},
    generate: script,
    embed: async () => [],
    cancel: async (requestId: string) => {
      onCancel?.(requestId);
    },
  };
}

async function createTestEngine(
  projectRoot: string,
  script: (req: GenerationRequest) => AsyncIterable<GenerationEvent>,
  onCancel?: (requestId: string) => void,
): Promise<RookEngine> {
  const engine = await createEngine({ projectRoot, skipDiscovery: true });
  engine.runtimes.register({
    id: 'ollama',
    name: 'Fake Ollama',
    version: 'test',
    local: true,
    health: 'healthy',
    capabilities: { streaming: true, toolCalling: true, embeddings: false, vision: false, structuredOutput: true },
  });
  engine.models.register({
    id: 'qwen-coder:14b',
    name: 'Qwen Coder 14B',
    provider: 'ollama',
    family: 'qwen',
    capabilities: ['coding', 'reasoning', 'planning', 'fast'],
    contextWindow: 32768,
    toolCalling: true,
    structuredOutput: true,
    local: true,
    costPer1kInput: 0,
    costPer1kOutput: 0,
  });
  engine.scheduler.registerComputer({
    id: 'local',
    name: 'Local',
    hostname: 'localhost',
    os: process.platform,
    arch: process.arch,
    cpuCores: 8,
    ramTotalGb: 32,
    ramAvailableGb: 24,
    Local: true,
    status: 'online',
    activeTasks: 0,
    maxConcurrentTasks: 4,
    runtimes: ['ollama'],
    loadedModels: ['qwen-coder:14b'],
    availableModels: ['qwen-coder:14b'],
    capabilities: ['local'],
  });
  const adapter = fakeAdapter(script, onCancel);
  engine.worker.registerAdapter(adapter);
  engine.adapters.set('ollama', adapter);
  return engine;
}

describe('Phase 2 CLI Execution Correctness Regressions (ISS-006, ISS-008, ISS-009, ISS-010, ISS-011)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'wazir-phase2-exec-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'phase2-fixture', version: '1.0.0' }));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ISS-006 & ISS-008: short mutation prompts are not classified as conversational fast-path and fail when 0 mutations occur', async () => {
    const engine = await createTestEngine(tmp, async function* () {
      const done = JSON.stringify({ action: 'done', summary: 'Claimed fix without touching files' });
      yield { type: 'token', content: done };
      yield { type: 'completed', content: done, usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } };
    });

    for (const prompt of ['Fix src/a.ts', 'Create out.txt', 'Update package.json']) {
      const planned = await planTask(engine, prompt, { type: 'chat' });
      expect(planned.ok).toBe(true);
      if (planned.ok) {
        expect(planned.plan.task.mutationRequired).toBe(true);
        expect(planned.plan.agent.descriptor.name).not.toBe('wazir-chat');
      }
    }

    const outcome = await executeTask(engine, 'Fix src/a.ts', { quiet: true });
    expect(outcome.success).toBe(false);
    expect(outcome.filesChanged).toEqual([]);
    const record = await engine.executions.get(outcome.executionId);
    expect(record?.execution.status).toBe('failed');
  });

  it('ISS-008: expectedFiles tasks fail when expected files are not mutated', async () => {
    const engine = await createTestEngine(tmp, async function* () {
      const done = JSON.stringify({ action: 'done', summary: 'Done without creating expected artifact' });
      yield { type: 'token', content: done };
      yield { type: 'completed', content: done, usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 } };
    });

    const outcome = await executeTask(engine, 'Say hello', {
      expectedFiles: ['required-output.txt'],
      quiet: true,
    });
    expect(outcome.success).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('required-output.txt'))).toBe(true);
    const record = await engine.executions.get(outcome.executionId);
    expect(record?.execution.status).toBe('failed');
  });

  it('ISS-009: preflight, planTask, and activateExecution failures persist terminal failed execution records', async () => {
    const engine = await createTestEngine(tmp, async function* () {
      const done = JSON.stringify({ action: 'done', summary: 'ok' });
      yield { type: 'token', content: done };
      yield { type: 'completed', content: done };
    });

    // 1. Agent preflight failure in runTaskCommand persists a failed execution record
    engine.agents.register({
      descriptor: {
        name: 'failing-preflight-agent',
        description: 'Failing preflight test agent',
        strategy: 'external',
        capabilities: ['coding'],
      },
      preflight: async () => ({ ok: false, reason: 'external CLI binary missing' }),
      async *run() {
        yield { kind: 'done', content: 'unreachable' };
      },
    } as any);

    const preflightRes = await runTaskCommand(engine, 'Fix bug', {
      agent: 'failing-preflight-agent',
      json: true,
    });
    expect(preflightRes.code).toBe(1);
    const preflightJson = JSON.parse(preflightRes.output);
    expect(preflightJson.success).toBe(false);
    expect(preflightJson.executionId).toBeTruthy();
    const preflightRec = await engine.executions.get(preflightJson.executionId);
    expect(preflightRec?.execution.status).toBe('failed');
    expect(preflightRec?.errors.some((e) => e.includes('external CLI binary missing'))).toBe(true);

    // 2. planTask failure in executeTask persists a failed execution record
    const planFailOutcome = await executeTask(engine, 'Fix bug', {
      model: 'unregistered-model-id',
      quiet: true,
    });
    expect(planFailOutcome.success).toBe(false);
    expect(planFailOutcome.executionId).not.toBe('—');
    const planFailRec = await engine.executions.get(planFailOutcome.executionId);
    expect(planFailRec?.execution.status).toBe('failed');

    // 3. activateExecution failure in executeTask persists a failed execution record
    const origActivate = engine.lifecycle.activateExecution.bind(engine.lifecycle);
    engine.lifecycle.activateExecution = async () => {
      throw new Error('LIFECYCLE_ACTIVATION_REJECTED: out of VRAM');
    };
    try {
      const actFailOutcome = await executeTask(engine, 'What is 2 + 2?', {
        type: 'chat',
        quiet: true,
      });
      expect(actFailOutcome.success).toBe(false);
      const actFailRec = await engine.executions.get(actFailOutcome.executionId);
      expect(actFailRec?.execution.status).toBe('failed');
      expect(actFailRec?.errors.some((e) => e.includes('LIFECYCLE_ACTIVATION_REJECTED'))).toBe(true);
    } finally {
      engine.lifecycle.activateExecution = origActivate;
    }
  });

  it('ISS-010: taskStatusCommand reads authoritative persisted execution status and returns code 1 for unknown IDs', async () => {
    const engine = await createTestEngine(tmp, async function* () {
      const answer = 'Authoritative answer from model';
      yield { type: 'token', content: answer };
      yield { type: 'completed', content: answer, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    });

    // Unknown ID returns code 1 and never fabricates "queued"
    const missingSync = taskStatusCommand(engine, 'nonexistent-task-id-999', { json: true });
    expect(missingSync.code).toBe(1);
    expect(missingSync.output).toContain('not found');
    expect(missingSync.output).not.toContain('queued');

    const outcome = await executeTask(engine, 'What is 2 + 2?', { type: 'chat', quiet: true });
    expect(outcome.success).toBe(true);

    const statusRes = await taskStatusCommand(engine, outcome.executionId, { json: true });
    expect(statusRes.code).toBe(0);
    const parsed = JSON.parse(statusRes.output);
    expect(parsed.executionId).toBe(outcome.executionId);
    expect(parsed.status).toBe('completed');

    const textRes = taskStatusCommand(engine, parsed.id);
    expect(textRes.code).toBe(0);
    expect(textRes.output).toContain('status:    completed');
  });

  it('ISS-011: streams token chunks immediately via onToken and preserves full non-truncated result > 500 chars in runTaskCommand', async () => {
    const longAnswer = 'A'.repeat(750) + '_TAIL_MARKER';
    const chunkTimestamps: number[] = [];
    let completedTimestamp = 0;

    const engine = await createTestEngine(tmp, async function* () {
      yield { type: 'token', content: longAnswer.slice(0, 300) };
      await new Promise((r) => setTimeout(r, 15));
      yield { type: 'token', content: longAnswer.slice(300) };
      await new Promise((r) => setTimeout(r, 15));
      completedTimestamp = Date.now();
      yield { type: 'completed', content: longAnswer, usage: { inputTokens: 10, outputTokens: 200, totalTokens: 210 } };
    });

    const receivedTokens: string[] = [];
    const outcome = await executeTask(engine, 'What is the full specification?', {
      type: 'chat',
      quiet: true,
      onToken: (tok) => {
        receivedTokens.push(tok);
        chunkTimestamps.push(Date.now());
      },
    });

    expect(outcome.success).toBe(true);
    expect(receivedTokens).toEqual([longAnswer.slice(0, 300), longAnswer.slice(300)]);
    expect(chunkTimestamps[0]).toBeLessThan(completedTimestamp);

    const cmdRes = await runTaskCommand(engine, 'What is the full specification?', {
      type: 'chat',
    });
    expect(cmdRes.code).toBe(0);
    expect(cmdRes.output).toContain('_TAIL_MARKER');
    expect(cmdRes.output).toContain(longAnswer);
  });

  it('ISS-011: propagates AbortSignal to adapter.generate and marks execution status as cancelled', async () => {
    let observedSignal: AbortSignal | undefined;
    let cancelCalledWith: string | undefined;
    const abortController = new AbortController();

    const engine = await createTestEngine(
      tmp,
      async function* (req: GenerationRequest) {
        observedSignal = req.signal;
        yield { type: 'token', content: 'Starting...' };
        abortController.abort();
        yield { type: 'token', content: 'Should not continue' };
        yield { type: 'completed', content: 'Should not complete' };
      },
      (reqId) => {
        cancelCalledWith = reqId;
      },
    );

    const outcome = await executeTask(engine, 'What is 2 + 2?', {
      type: 'chat',
      quiet: true,
      signal: abortController.signal,
    });

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(cancelCalledWith).toBeDefined();
    expect(outcome.success).toBe(false);
    const record = await engine.executions.get(outcome.executionId);
    expect(record?.execution.status).toBe('cancelled');
  });

  it('ISS-006, ISS-008 & ISS-011: runSubagent enforces mutationRequired/expectedArtifacts and forwards AbortSignal', async () => {
    let subagentSignal: AbortSignal | undefined;
    const engine = await createTestEngine(tmp, async function* (req: GenerationRequest) {
      subagentSignal = req.signal;
      const done = JSON.stringify({ action: 'done', summary: 'Subagent finished without writing file' });
      yield { type: 'token', content: done };
      yield { type: 'completed', content: done, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    });

    const parentTask = {
      id: 'task-parent-1',
      type: 'coding' as const,
      input: 'Parent task',
      requirements: { minimumContext: 8192 },
      priority: 'normal' as const,
      status: 'running' as const,
      createdAt: new Date(),
    };
    const parentRec = await engine.executions.create({
      task: parentTask,
      agentId: 'wazir-coding',
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'qwen-coder:14b',
      workerId: engine.worker.id,
      workspaceRoot: tmp,
    });

    const subAbort = new AbortController();
    const res = await runSubagent(
      engine,
      {
        description: 'Create sub-output.txt',
        expectedArtifacts: ['sub-output.txt'],
      },
      {
        parentExecutionId: parentRec.execution.id,
        parentTaskId: parentTask.id,
        projectRoot: tmp,
        modelId: 'qwen-coder:14b',
        runtimeId: 'ollama',
        computerId: 'local',
        subagentDepth: 0,
        log: () => {},
        loader: { start: () => {}, stop: () => {}, clear: () => {}, setText: () => {} } as any,
        emitJson: () => {},
        signal: subAbort.signal,
      },
    );

    expect(subagentSignal).toBeDefined();
    expect(res.ok).toBe(false);
    const children = await engine.executions.listChildren(parentRec.execution.id);
    expect(children.length).toBe(1);
    expect(children[0].execution.status).toBe('failed');
  });
});
