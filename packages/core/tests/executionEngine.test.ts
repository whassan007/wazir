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
});
