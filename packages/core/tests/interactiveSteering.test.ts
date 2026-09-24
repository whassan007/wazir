import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExecutionEngine } from '../src/index.js';

describe('Gate 6: Interactive Pause / Steer / Resume', () => {
  let tempDir: string;
  let executionEngine: ExecutionEngine;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-steer-test-'));
    executionEngine = new ExecutionEngine({ workspace: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('pauses execution mid-flight and transitions status to paused', async () => {
    const record = await executionEngine.create({
      task: {
        id: 'task-pause',
        type: 'coding',
        input: 'long running task',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt-1',
      modelId: 'model-a',
      workspaceRoot: tempDir,
    });

    expect(executionEngine.isPaused(record.execution.id)).toBe(false);

    // Pause execution mid-flight
    await executionEngine.pause(record.execution.id, 'Operator requested pause');

    expect(executionEngine.isPaused(record.execution.id)).toBe(true);
    expect(record.execution.status).toBe('paused');

    // Verify event emitted
    const pauseEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.paused',
    );
    expect(pauseEvents.length).toBe(1);
    expect((pauseEvents[0].data as any).reason).toBe('Operator requested pause');
  });

  it('steers execution with injected constraints and provenance records who, what, when', async () => {
    const record = await executionEngine.create({
      task: {
        id: 'task-steer',
        type: 'coding',
        input: 'code task',
        requirements: {},
        priority: 'normal',
        status: 'running',
        maxTurns: 10,
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt-1',
      modelId: 'model-a',
      workspaceRoot: tempDir,
    });

    // Steer: inject guidance + modify constraints + route model
    const steerResult = await executionEngine.steer(record.execution.id, {
      who: 'operator@supervisor',
      guidance: 'Do not use eval or direct bash calls. Use python script instead.',
      injectedConstraints: {
        maxTurns: 5,
        protectedFiles: ['package.json'],
      },
      changeModelRouting: {
        modelId: 'claude-3-5-sonnet',
        runtimeId: 'anthropic-runtime',
      },
    });

    expect(steerResult.success).toBe(true);
    expect(steerResult.who).toBe('operator@supervisor');
    expect(steerResult.whatChanged.guidance).toBe(
      'Do not use eval or direct bash calls. Use python script instead.',
    );
    expect(steerResult.effectiveAt).toBeInstanceOf(Date);

    // Verify task constraint modification took effect
    expect(record.task.maxTurns).toBe(5);
    expect(record.task.expectedEvidence).toContain('protected:package.json');

    // Verify model routing changed
    expect(record.execution.modelId).toBe('claude-3-5-sonnet');
    expect(record.execution.runtimeId).toBe('anthropic-runtime');

    // Verify model.route.changed event emitted
    const routeEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'model.route.changed',
    );
    expect(routeEvents.length).toBe(1);
    expect((routeEvents[0].data as any).toModel).toBe('claude-3-5-sonnet');

    // Verify execution.steered event captured in provenance
    const steerEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.steered',
    );
    expect(steerEvents.length).toBe(1);
    expect((steerEvents[0].data as any).who).toBe('operator@supervisor');
  });

  it('cancels scheduled tool calls when requested by steering', async () => {
    const record = await executionEngine.create({
      task: {
        id: 'task-tool-cancel',
        type: 'coding',
        input: 'task',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    expect(executionEngine.isToolCancelled(record.execution.id)).toBe(false);

    // Steer to cancel in-flight / scheduled tools
    await executionEngine.steer(record.execution.id, {
      who: 'safety-monitor',
      cancelScheduledToolCalls: true,
      guidance: 'Dangerous command detected. Cancel all scheduled tool operations.',
    });

    expect(executionEngine.isToolCancelled(record.execution.id)).toBe(true);
    expect(executionEngine.isToolCancelled(record.execution.id, 'tc-123')).toBe(true);
  });

  it('resumes paused execution and allows consuming queued steering guidance', async () => {
    const record = await executionEngine.create({
      task: {
        id: 'task-resume',
        type: 'coding',
        input: 'task',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    // 1. Pause
    await executionEngine.pause(record.execution.id);
    expect(executionEngine.isPaused(record.execution.id)).toBe(true);

    // 2. Steer with follow-up instructions while paused
    await executionEngine.steer(record.execution.id, {
      who: 'user',
      guidance: 'Please also add comprehensive comments to each exported function.',
    });

    // 3. Resume
    await executionEngine.resume(record.execution.id, 'User provided input and resumed');
    expect(executionEngine.isPaused(record.execution.id)).toBe(false);
    expect(record.execution.status).toBe('running');

    // Verify resumption event recorded
    const resumeEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.resumed',
    );
    expect(resumeEvents.length).toBe(1);

    // Verify agent loop consumes the queued steering guidance
    const steering = executionEngine.getSteering(record.execution.id);
    expect(steering).toBeDefined();
    expect(steering?.guidance).toBe(
      'Please also add comprehensive comments to each exported function.',
    );

    // After popping, steering queue is drained
    expect(executionEngine.getSteering(record.execution.id)).toBeUndefined();
  });
});
