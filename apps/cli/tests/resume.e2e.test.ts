import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry, ComputerRegistry, ContextCompiler, ExecutionEngine, ModelRegistry,
  ModelLifecycleService, PolicyEngine, RuntimeRegistry, Scheduler, WorktreeManager,
  type JobNode, type Task,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { ChatMessage } from '@wazir/core';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { createFleetTaskExecutor } from '../src/fleetRunner.js';
import type { RookEngine } from '../src/engine.js';

/**
 * Phase 21 end to end: a retried fleet task continues its SAME execution when durable
 * facts say that's safe, and refuses — without calling the model — when a previous
 * side effect is unresolved. Real engine, real tools; only the model adapter is fake.
 */
const CAPS = { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false };

function build(projectRoot: string, script: (requestIndex: number, messages: ChatMessage[]) => string) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();
  computers.register({ id: 'local', name: 't', type: 'workstation', local: true, os: { platform: os.platform(), architecture: os.arch(), version: os.release() }, hardware: { cpu: 'c', cpuCores: 4, memoryGB: 16 }, capabilities: ['localExecution'] });
  runtimes.register({ id: 'fake', type: 'other', name: 'fake', version: '1', computerId: 'local', capabilities: CAPS });
  runtimes.update('fake', { health: 'healthy' });
  models.register({ id: 'fake-model', name: 'fake-model', provider: 'fake', family: 'other', contextMax: 32768, capabilities: ['generalChat', 'coding'], toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false, runtimeCompatibility: 'any', local: true, createdAt: new Date(), updatedAt: new Date() });
  models.upsertInstance({ id: 'fake-model::local::fake', modelId: 'fake-model', computerId: 'local', runtimeId: 'fake', runtimeModelId: 'fake-model', loaded: true, state: 'READY', health: 'healthy', contextTokens: 32768 });
  agents.register(createCodingAgent(), 'native');
  const requests: ChatMessage[][] = [];
  const adapter = {
    id: 'fake', type: 'other',
    async discover() { return { id: 'fake', name: 'fake', version: '1' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return []; },
    async getCapabilities() { return CAPS; },
    async inspectModel(modelId: string) { return { modelId, loaded: true, effectiveContext: 32768 }; },
    async probeModel() { return true; },
    async *generate(req: { messages: ChatMessage[] }) {
      requests.push(req.messages);
      const reply = script(requests.length - 1, req.messages);
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 10, outputTokens: 10 } };
    },
  } as unknown as RuntimeAdapter;
  const adapters = new Map([['fake', adapter]]);
  const engine = {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot, configDir: path.join(projectRoot, '.wazir'),
    lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters }),
    computers, runtimes, models, agents, tools: new ToolRegistry(defaultTools),
    policy: new PolicyEngine({ projectRoot, networkAllowed: false }),
    scheduler: new Scheduler({ computers, runtimes, models, agents }),
    compiler: new ContextCompiler(), executions, adapters, worktrees: new WorktreeManager(), discovered: [],
    worker: { id: 'worker-local', computerId: 'local', adapterForModel: () => adapter } as unknown as Worker,
  } as unknown as RookEngine;
  return { engine, requests };
}

const task: Task = {
  id: 'task-1', type: 'coding', title: 'notes', input: 'write the release notes file',
  requirements: { capabilities: ['coding'], minimumContext: 1024 },
  priority: 'normal', status: 'running', createdAt: new Date(), updatedAt: new Date(),
} as Task;
const node = { id: task.id, type: 'task', taskId: task.id, state: 'running', dependencies: [], children: [] } as JobNode;
const assignment = { jobId: 'job-1', taskId: task.id, agentId: 'wazir-coding', modelId: 'fake-model', runtimeId: 'fake', computerId: 'local', assignedAt: new Date(), policy: [] };

describe('retried fleet task resumes the same execution (e2e)', () => {
  let projectRoot: string;
  afterEach(async () => { if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined); });

  it('attempt 2 continues execution 1 with the real prior state, instead of starting over', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-resume-e2e-'));
    let attempt = 1;
    const { engine, requests } = build(projectRoot, (i, messages) => {
      if (attempt === 1) {
        // Plan, write the file for real, then stall in prose until the protocol budget ends the attempt.
        return i === 0 ? '{"action":"plan","content":"write notes"}'
          : i === 1 ? '{"action":"tool","tool":"write","input":{"path":"NOTES.txt","content":"v1 notes"}}'
          : 'still thinking in prose';
      }
      // Attempt 2: the model is told the file already exists; it checks and finishes.
      const first = messages[1]?.content ?? '';
      return first.includes('RESUMING') && !messages.some((m) => m.role === 'assistant')
        ? '{"action":"plan","content":"verify existing notes"}'
        : messages.some((m) => m.content.includes('[tool result for read'))
          ? '{"action":"done","summary":"notes already written; verified"}'
          : '{"action":"tool","tool":"read","input":{"path":"NOTES.txt"}}';
    });
    const executor = createFleetTaskExecutor(engine, { useWorktrees: false });

    const first = await executor(task, { jobId: 'job-1', taskId: task.id, node, assignment });
    expect(first.success).toBe(false);
    const [record] = await engine.executions.listByTask(task.id);
    expect((await engine.executions.events(record.execution.id)).find((e) => e.eventType === 'termination.completed')?.data).toMatchObject({ reason: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED' });

    attempt = 2;
    const firstRequestOfAttempt2 = requests.length;
    const second = await executor(task, { jobId: 'job-1', taskId: task.id, node, assignment });

    const records = await engine.executions.listByTask(task.id);
    expect(records).toHaveLength(1); // same execution, no replacement
    const events = await engine.executions.events(record.execution.id);
    expect(events.find((e) => e.eventType === 'execution.resumed')?.data).toMatchObject({ attempt: 2 });
    const briefing = requests[firstRequestOfAttempt2][1].content;
    expect(briefing).toContain(`RESUMING execution ${record.execution.id} (attempt 2)`);
    expect(briefing).toContain('(MODEL_PROTOCOL_BUDGET_EXHAUSTED)');
    expect(briefing).toContain('Files already changed on disk: NOTES.txt');
    // No rewrite happened in attempt 2, yet the task completes: prior changes count.
    expect(second.success).toBe(true);
    expect(await fs.readFile(path.join(projectRoot, 'NOTES.txt'), 'utf8')).toBe('v1 notes');
  });

  it('refuses to re-run while a previous side effect is unresolved — and never calls the model', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-resume-e2e-'));
    const { engine, requests } = build(projectRoot, (i) => (i === 0 ? '{"action":"plan","content":"p"}' : 'prose'));
    const executor = createFleetTaskExecutor(engine, { useWorktrees: false });
    await executor(task, { jobId: 'job-1', taskId: task.id, node, assignment });
    const [record] = await engine.executions.listByTask(task.id);
    // A crash mid-commit in the previous attempt: dispatched, never recorded.
    await engine.executions.recordToolStart(record.execution.id, 'git', { command: 'commit -m notes' }, { callId: 'commit-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    const before = requests.length;

    const retry = await executor(task, { jobId: 'job-1', taskId: task.id, node, assignment });

    expect(retry.success).toBe(false);
    expect(retry.errorKind).toBe('policy');
    expect(retry.error).toContain("RESUME_REFUSED: 'git' (call commit-1) was dispatched with no confirmed outcome");
    expect(requests.length).toBe(before);
  });
});
