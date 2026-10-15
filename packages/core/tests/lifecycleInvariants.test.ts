import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import {
  AgentRegistry, ComputerRegistry, ExecutionEngine, JobManager, JobOrchestrator, ModelRegistry, RuntimeRegistry, Scheduler,
  canTransitionExecution, canTransitionJob, canTransitionNode, canTransitionTask,
} from '../src/index.js';
import type { JobTaskExecutor, JobTaskOutcome, Task } from '../src/index.js';

const TASK_STATUSES = ['pending', 'planning', 'scheduled', 'running', 'completed', 'failed', 'cancelled', 'blocked'] as const;

describe('transition tables', () => {
  it('nothing leaves completed or cancelled; same-status is an idempotent no-op', () => {
    for (const to of TASK_STATUSES) {
      expect(canTransitionTask('completed', to)).toBe(to === 'completed');
      expect(canTransitionTask('cancelled', to)).toBe(to === 'cancelled');
    }
  });

  it('failed only moves back to the queued state (explicit retry)', () => {
    for (const to of TASK_STATUSES) expect(canTransitionTask('failed', to)).toBe(to === 'failed' || to === 'pending');
    expect(canTransitionNode('failed', 'idle')).toBe(true);
    expect(canTransitionNode('failed', 'running')).toBe(false);
    expect(canTransitionNode('failed', 'completed')).toBe(false);
    expect(canTransitionNode('completed', 'failed')).toBe(false);
  });

  it('a finished job never changes status', () => {
    for (const from of ['completed', 'failed', 'cancelled'] as const) {
      for (const to of ['pending', 'running', 'completed', 'failed', 'cancelled'] as const) {
        expect(canTransitionJob(from, to)).toBe(from === to);
      }
    }
    expect(canTransitionJob('paused', 'running')).toBe(true);
  });

  it('executions resume from failed/cancelled only with a recorded resumption, never into another terminal status', () => {
    expect(canTransitionExecution('failed', 'running', false)).toBe(false);
    expect(canTransitionExecution('failed', 'running', true)).toBe(true);
    expect(canTransitionExecution('failed', 'completed', true)).toBe(false);
    expect(canTransitionExecution('cancelled', 'failed', true)).toBe(false);
    expect(canTransitionExecution('completed', 'running', true)).toBe(false);
    expect(canTransitionExecution('completed', 'failed', true)).toBe(false);
  });
});

describe('JobManager rejects terminal-state corruption', () => {
  const setup = async () => {
    const m = new JobManager();
    await m.ready;
    const job = m.create({ title: 'lifecycle', tasks: [{ task: { id: 't', input: 'x' } }, { task: { id: 'u', input: 'y' } }] });
    return { m, job };
  };

  it('COMPLETED → CANCELLED, COMPLETED → RUNNING and a late failure are rejected', async () => {
    const { m, job } = await setup();
    await m.updateTaskStatus(job.id, 't', 'running');
    await m.completeTask(job.id, 't', 'verified result');
    await expect(m.updateTaskStatus(job.id, 't', 'cancelled')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.updateTaskStatus(job.id, 't', 'running')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.failTask(job.id, 't', 'stale late error', Infinity)).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.failTask(job.id, 't', 'stale late error', 0)).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.updateAgentState(job.id, 't', 'failed', undefined, 'late')).rejects.toThrow('INVALID_STATE_TRANSITION');
    const task = m.get(job.id)!.tasks.find((t) => t.id === 't')!;
    const node = m.get(job.id)!.graph.nodes.find((n) => n.id === 't')!;
    expect(task.status).toBe('completed');
    expect([node.state, node.result, node.error]).toEqual(['completed', 'verified result', undefined]);
    // A duplicate completion is a no-op, not an error.
    await m.completeTask(job.id, 't', 'verified result');
  });

  it('FAILED → COMPLETED and FAILED → RUNNING are rejected; FAILED → PENDING (retry) is allowed', async () => {
    const { m, job } = await setup();
    await m.updateTaskStatus(job.id, 'u', 'running');
    await m.failTask(job.id, 'u', 'boom', Infinity);
    await expect(m.completeTask(job.id, 'u', 'late success')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.updateTaskStatus(job.id, 'u', 'running')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await m.updateAgentState(job.id, 'u', 'idle');
    await m.updateTaskStatus(job.id, 'u', 'pending');
    await m.updateTaskStatus(job.id, 'u', 'running');
    await m.updateAgentState(job.id, 'u', 'running');
    await m.completeTask(job.id, 'u', 'recovered');
    expect(m.get(job.id)!.tasks.find((t) => t.id === 'u')!.status).toBe('completed');
  });

  it('a finished job cannot be moved to another status', async () => {
    const { m, job } = await setup();
    await m.setJobStatus(job.id, 'running');
    await m.setJobStatus(job.id, 'completed', { completedAt: new Date() });
    await expect(m.setJobStatus(job.id, 'failed')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.setJobStatus(job.id, 'running')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(m.cancel(job.id)).rejects.toThrow(/terminal status/);
    expect(m.get(job.id)!.status).toBe('completed');
  });

  it('two processes sharing a file store: a cancel cannot overwrite a completed job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wazir-lifecycle-'));
    try {
      const file = join(dir, 'store.json');
      const a = new JobManager({ store: new JsonFileStore(file) });
      await a.ready;
      const job = a.create({ title: 'race', tasks: [{ task: { id: 'only', input: 'x' } }] });
      await a.save(job.id);
      await a.acquire(job.id);
      await a.updateTaskStatus(job.id, 'only', 'running');
      await a.completeTask(job.id, 'only', 'done');
      await a.setJobStatus(job.id, 'completed', { completedAt: new Date() });
      await a.release(job.id);
      const b = new JobManager({ store: new JsonFileStore(file) });
      await b.ready;
      await expect(b.cancel(job.id)).rejects.toThrow(/terminal status 'completed'/);
      await expect(b.acquire(job.id)).rejects.toThrow('JOB_TERMINAL');
      const c = new JobManager({ store: new JsonFileStore(file) });
      await c.ready;
      expect(c.get(job.id)!.status).toBe('completed');
      expect(c.get(job.id)!.tasks[0].status).toBe('completed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('a fenced (lease-lost) write leaves the local copy matching the store, not the rejected change', async () => {
    const store = new MemoryStore();
    let now = 0;
    const a = new JobManager({ store, now: () => now, leaseMs: 1000 });
    await a.ready;
    const job = a.create({ title: 'fence', tasks: [{ task: { id: 'x', input: 'x' } }] });
    await a.save(job.id);
    await a.acquire(job.id);
    await a.updateTaskStatus(job.id, 'x', 'running');
    now = 5000;
    const b = new JobManager({ store, now: () => now, leaseMs: 1000 });
    await b.ready;
    await b.acquire(job.id);
    await expect(a.completeTask(job.id, 'x', 'stale')).rejects.toThrow('JOB_LEASE_LOST');
    expect(a.get(job.id)!.tasks[0].status).not.toBe('completed');
  });
});

describe('ExecutionEngine rejects terminal-state corruption', () => {
  const task = { id: 'exec-task', type: 'coding', input: 'x', requirements: { capabilities: [] }, priority: 'normal', status: 'pending', createdAt: new Date() } as unknown as Task;
  const create = async (engine: ExecutionEngine) =>
    (await engine.create({ task, computerId: 'c', runtimeId: 'r', modelId: 'm' })).execution.id;

  it('VERIFIED/COMPLETED → FAILED from a late stale event is rejected', async () => {
    const engine = new ExecutionEngine();
    const id = await create(engine);
    await engine.setStatus(id, 'running');
    await engine.setStatus(id, 'completed');
    await expect(engine.setStatus(id, 'failed')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(engine.setStatus(id, 'cancelled')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(engine.setStatus(id, 'running')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(engine.pause(id)).rejects.toThrow('INVALID_STATE_TRANSITION');
    expect((await engine.get(id))!.execution.status).toBe('completed');
    await engine.setStatus(id, 'completed'); // duplicate terminal event: no-op
  });

  it('INTERRUPTED/orphaned → COMPLETED is rejected for the stale worker; an explicit resumption re-opens it', async () => {
    const engine = new ExecutionEngine();
    const id = await create(engine);
    await engine.setStatus(id, 'running');
    await engine.orphan(id, 'worker stopped heartbeating');
    // The worker that was declared dead reports late.
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(engine.setStatus(id, 'running')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(engine.resume(id)).rejects.toThrow('INVALID_STATE_TRANSITION');
    // Recovery records an explicit resumption (as planTaskResume does), then it may run.
    await engine.recordEvent(id, 'execution.resumed', { attempt: 2, reasons: ['test'] });
    await engine.setStatus(id, 'running');
    await engine.setStatus(id, 'completed');
    // The resumption is consumed by the next terminal event; it can't be reused.
    await expect(engine.setStatus(id, 'failed')).rejects.toThrow('INVALID_STATE_TRANSITION');
  });

  it('a resumption authorizes re-activation only, not a direct jump to another terminal status', async () => {
    const engine = new ExecutionEngine();
    const id = await create(engine);
    await engine.setStatus(id, 'running');
    await engine.setStatus(id, 'failed');
    await engine.recordEvent(id, 'execution.resumed', { attempt: 2 });
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow('INVALID_STATE_TRANSITION');
    await expect(engine.setStatus(id, 'cancelled')).rejects.toThrow('INVALID_STATE_TRANSITION');
  });

  it('operator pause/resume still works on a live execution', async () => {
    const engine = new ExecutionEngine();
    const id = await create(engine);
    await engine.setStatus(id, 'running');
    await engine.pause(id);
    await engine.resume(id);
    expect((await engine.get(id))!.execution.status).toBe('running');
  });
});

function orchestrator(executor: JobTaskExecutor) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  computers.register({ id: 'local', name: 'local', type: 'workstation', local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6' }, hardware: { cpu: 'x', cpuCores: 4, memoryGB: 16 }, capabilities: ['localExecution'] });
  runtimes.register({ id: 'rt', type: 'other', name: 'rt', version: '1', computerId: 'local', capabilities: {
    chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false,
    modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false } });
  models.register({ id: 'm', name: 'm', provider: 'rt', family: 'other', contextMax: 32_768, capabilities: ['generalChat', 'coding'],
    toolCalling: true, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
    runtimeCompatibility: 'any', local: true, createdAt: new Date(), updatedAt: new Date() });
  models.upsertInstance({ id: 'm::local::rt', modelId: 'm', computerId: 'local', runtimeId: 'rt', runtimeModelId: 'm', loaded: true, health: 'healthy', contextTokens: 32_768 });
  agents.register({ descriptor: { name: 'a', version: '1', description: 'a', capabilities: ['coding'], requiredTools: [],
    modelRequirements: { capabilities: ['coding'] }, permissions: [], taskTypes: ['coding', 'chat'], strategy: 't' },
  async *run() { yield { kind: 'done', content: 'done' }; } }, 'native');
  const executions = new ExecutionEngine();
  const scheduler = new Scheduler({ computers, runtimes, models, agents });
  return new JobOrchestrator({ scheduler, executionEngine: executions, computers, runtimes, models, agents, taskExecutor: executor, jobManager: new JobManager() });
}

describe('JobOrchestrator settlement', () => {
  it('cancelling a task after it completed keeps the completed outcome', async () => {
    const o = orchestrator(async () => ({ success: true, result: 'r' }));
    const job = await o.createJob({ title: 'x', tasks: [{ task: { id: 'done', input: 'x' } }] });
    const finished = await o.runJob(job.id);
    await o.cancelTask(job.id, 'done');
    expect(finished.status).toBe('completed');
    expect(finished.tasks[0].status).toBe('completed');
  });

  it('a timeout fails in-flight work without ever recording it as cancelled', async () => {
    const statuses: string[] = [];
    const o = orchestrator((_task, ctx) => new Promise<JobTaskOutcome>((resolve) => {
      ctx.signal?.addEventListener('abort', () => resolve({ success: false, error: 'aborted' }));
    }));
    const job = await o.createJob({ title: 't', tasks: [{ task: { id: 'hang', input: 'x' } }] });
    o.subscribe(job.id, (ev) => { if (ev.type === 'job:failed' || ev.type === 'job:cancelled') statuses.push(ev.type); });
    const finished = await o.runJob(job.id, { timeoutSeconds: 1 });
    await new Promise((r) => setTimeout(r, 50)); // let the aborted executor settle
    expect(finished.status).toBe('failed');
    expect(finished.tasks[0].status).toBe('failed');
    expect(finished.graph.nodes[0].state).toBe('failed');
    expect(finished.graph.nodes[0].error).toContain('exceeded the 1s timeout');
    expect(statuses).toEqual(['job:failed']);
  });

  it('a task the operator cancelled before the job timed out stays cancelled', async () => {
    const o = orchestrator((_task, ctx) => new Promise<JobTaskOutcome>((resolve) => {
      ctx.signal?.addEventListener('abort', () => resolve({ success: false, error: 'aborted' }));
    }));
    const job = await o.createJob({ title: 't', tasks: [{ task: { id: 'a', input: 'x' } }, { task: { id: 'b', input: 'y' } }] });
    const run = o.runJob(job.id, { timeoutSeconds: 1 });
    await new Promise((r) => setTimeout(r, 100));
    await o.cancelTask(job.id, 'a');
    const finished = await run;
    await new Promise((r) => setTimeout(r, 50));
    expect(finished.status).toBe('failed');
    expect(finished.tasks.find((t) => t.id === 'a')!.status).toBe('cancelled');
    expect(finished.tasks.find((t) => t.id === 'b')!.status).toBe('failed');
  });
});
