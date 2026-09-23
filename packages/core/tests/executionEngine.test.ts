import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExecutionEngine,
  type ExecutionEngineOptions,
} from '../src/services/executionEngine.js';

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;
  const recordHistory: any[] = [];

  beforeEach(() => {
    engine = new ExecutionEngine({
      persist: (record) => recordHistory.push(record),
    });
  });

  it('creates execution with initial state', async () => {
    await engine.ready;

    const task = {
      id: 'task-1',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    expect(record.execution.status).toBe('queued');
    expect(record.execution.taskId).toBe('task-1');
    expect(record.events.length).toBe(1);
    expect(record.events[0].type).toBe('execution.created');
  });

  it('transitions from queued to running', async () => {
    await engine.ready;

    const task = {
      id: 'task-2',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    expect(record.execution.startedAt).toBeUndefined();

    await engine.setStatus(record.execution.id, 'running');

    expect(record.execution.status).toBe('running');
    expect(record.execution.startedAt).toBeDefined();
  });

  it('transitions from running to completed', async () => {
    await engine.ready;

    const task = {
      id: 'task-3',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'completed');

    expect(record.execution.status).toBe('completed');
    expect(record.execution.completedAt).toBeDefined();
  });

  it('transitions from running to failed', async () => {
    await engine.ready;

    const task = {
      id: 'task-4',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'failed');

    expect(record.execution.status).toBe('failed');
  });

  it('transitions from running to cancelled', async () => {
    await engine.ready;

    const task = {
      id: 'task-5',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'cancelled');

    expect(record.execution.status).toBe('cancelled');
  });

  it('records policy decisions', async () => {
    await engine.ready;

    const task = {
      id: 'task-6',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    const decision = {
      tool: 'read',
      decision: 'allow' as const,
      rule: 'filesystem-project-allow',
      reasons: ['path is inside project root'],
    };

    await engine.recordPolicy(record.execution.id, decision);

    expect(record.policyDecisions.length).toBe(1);
    expect(record.policyDecisions[0]).toEqual(decision);
  });

  it('records tool calls', async () => {
    await engine.ready;

    const task = {
      id: 'task-7',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    const call = {
      id: 'call-1',
      tool: 'read',
      input: { path: '/test/file.txt' },
      ok: true,
      output: 'file content',
      policyEffect: 'allow' as const,
      policyRule: 'filesystem-project-allow',
      durationMs: 50,
      at: new Date(),
    };

    await engine.recordToolCall(record.execution.id, call);

    expect(record.toolCalls.length).toBe(1);
    expect(record.toolCalls[0]).toEqual(call);
  });

  it('lists executions by task id', async () => {
    await engine.ready;

    const task = {
      id: 'task-8',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    await engine.create({
      task,
      computerId: 'computer-2',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    const executions = await engine.listByTask('task-8');
    expect(executions.length).toBe(2);
  });

  it('replays events in order', async () => {
    await engine.ready;

    const task = {
      id: 'task-9',
      type: 'coding' as const,
      input: 'Write a test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const record = await engine.create({
      task,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'completed');

    const events = await engine.events(record.execution.id);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('execution.created');
    expect(events[1].type).toBe('execution.assigned');
    expect(events[2].type).toBe('execution.completed');
  });

  it('tracks parentExecutionId and lists child executions', async () => {
    await engine.ready;

    const parentTask = {
      id: 'task-parent',
      type: 'coding' as const,
      input: 'Parent task',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const parent = await engine.create({
      task: parentTask,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    const childTask = {
      id: 'task-child',
      type: 'coding' as const,
      input: 'Child subtask',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const child = await engine.create({
      task: childTask,
      parentExecutionId: parent.execution.id,
      computerId: 'computer-1',
      runtimeId: 'runtime-1',
      modelId: 'model-1',
    });

    expect(child.execution.parentExecutionId).toBe(parent.execution.id);

    const children = await engine.listChildren(parent.execution.id);
    expect(children.length).toBe(1);
    expect(children[0].execution.id).toBe(child.execution.id);

    const nonExistentChildren = await engine.listChildren('non-existent');
    expect(nonExistentChildren.length).toBe(0);
  });
});

describe('ExecutionEngine.findUnknownOutcomeToolCall — durable step checkpoints', () => {
  let engine: ExecutionEngine;

  beforeEach(() => {
    engine = new ExecutionEngine();
  });

  async function makeExecution() {
    const record = await engine.create({
      task: {
        id: 'task-1', type: 'coding' as const, input: 'x',
        requirements: { capabilities: [] }, priority: 'normal', status: 'pending', createdAt: new Date(),
      },
      computerId: 'computer-1', runtimeId: 'runtime-1', modelId: 'model-1',
    });
    return record.execution.id;
  }

  it('returns undefined when no tool has ever been started', async () => {
    const id = await makeExecution();
    expect(engine.findUnknownOutcomeToolCall(id)).toBeUndefined();
  });

  it('returns undefined once every started tool has a matching completed result', async () => {
    const id = await makeExecution();
    await engine.recordToolStart(id, 'read', { path: 'a.ts' });
    await engine.recordToolCall(id, { id: 'c1', tool: 'read', input: { path: 'a.ts' }, ok: true, durationMs: 1, at: new Date() });
    await engine.recordToolStart(id, 'shell', { command: 'echo hi' });
    await engine.recordToolCall(id, { id: 'c2', tool: 'shell', input: { command: 'echo hi' }, ok: true, durationMs: 1, at: new Date() });
    expect(engine.findUnknownOutcomeToolCall(id)).toBeUndefined();
  });

  it('flags the most recent started tool when it has no matching completed result', async () => {
    const id = await makeExecution();
    await engine.recordToolStart(id, 'read', { path: 'a.ts' });
    await engine.recordToolCall(id, { id: 'c1', tool: 'read', input: { path: 'a.ts' }, ok: true, durationMs: 1, at: new Date() });
    await engine.recordToolStart(id, 'shell', { command: 'git commit -am wip' });
    // No recordToolCall for this one — process died mid-tool-call.

    const unknown = engine.findUnknownOutcomeToolCall(id);
    expect(unknown?.tool).toBe('shell');
    expect(unknown?.input).toEqual({ command: 'git commit -am wip' });
  });
});
