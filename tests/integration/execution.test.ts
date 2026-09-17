import { describe, it, expect } from 'vitest';
import {
  ExecutionEngine,
} from '@wazir/core';

describe('Integration: Execution Engine', () => {
  // Test execution state transitions
  it('creates execution with queued status', async () => {
    const engine = new ExecutionEngine();
    
    await engine.ready;
    
    const task = {
      id: 'task-1',
      type: 'coding' as const,
      input: 'test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    
    const record = await engine.create({
      task,
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
    });
    
    expect(record.execution.status).toBe('queued');
  });

  it('transitions execution to running', async () => {
    const engine = new ExecutionEngine();
    
    await engine.ready;
    
    const task = {
      id: 'task-2',
      type: 'coding' as const,
      input: 'test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    
    const record = await engine.create({ task, computerId: 'c1', runtimeId: 'r1', modelId: 'm1' });
    await engine.setStatus(record.execution.id, 'running');
    
    expect(record.execution.status).toBe('running');
    expect(record.execution.startedAt).toBeDefined();
  });

  it('records tool calls with policy information', async () => {
    const engine = new ExecutionEngine();
    
    await engine.ready;
    
    const task = {
      id: 'task-3',
      type: 'coding' as const,
      input: 'test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    
    const record = await engine.create({ task, computerId: 'c1', runtimeId: 'r1', modelId: 'm1' });
    
    await engine.recordToolCall(record.execution.id, {
      id: 'call-1',
      tool: 'read',
      input: { path: '/test/file.txt' },
      ok: true,
      output: 'content',
      policyEffect: 'allow',
      policyRule: 'filesystem-project-allow',
      durationMs: 50,
      at: new Date(),
    });
    
    expect(record.toolCalls.length).toBe(1);
    expect(record.toolCalls[0].tool).toBe('read');
  });

  it('transitions to completed', async () => {
    const engine = new ExecutionEngine();
    
    await engine.ready;
    
    const task = {
      id: 'task-4',
      type: 'coding' as const,
      input: 'test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    
    const record = await engine.create({ task, computerId: 'c1', runtimeId: 'r1', modelId: 'm1' });
    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'completed');
    
    expect(record.execution.status).toBe('completed');
  });

  it('transitions to failed', async () => {
    const engine = new ExecutionEngine();
    
    await engine.ready;
    
    const task = {
      id: 'task-5',
      type: 'coding' as const,
      input: 'test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    
    const record = await engine.create({ task, computerId: 'c1', runtimeId: 'r1', modelId: 'm1' });
    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'failed');
    
    expect(record.execution.status).toBe('failed');
  });

  it('transitions to cancelled', async () => {
    const engine = new ExecutionEngine();
    
    await engine.ready;
    
    const task = {
      id: 'task-6',
      type: 'coding' as const,
      input: 'test',
      requirements: { capabilities: [] },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    
    const record = await engine.create({ task, computerId: 'c1', runtimeId: 'r1', modelId: 'm1' });
    await engine.setStatus(record.execution.id, 'running');
    await engine.setStatus(record.execution.id, 'cancelled');
    
    expect(record.execution.status).toBe('cancelled');
  });
});
