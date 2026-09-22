import { describe, it, expect } from 'vitest';
import { evaluateExecution } from '../../src/index.js';
import type { ExecutionRecord, Task, ExecutionEvent } from '@wazir/core';

describe('LIVE-CODE-08: Evidence-Bound Revision Invalidation', () => {
  const dummyTask: Task = { id: 't1', type: 'coding', title: 't', input: 't', status: 'ready', requirements: {} };
  
  function makeRecord(overrides: Partial<ExecutionRecord>): ExecutionRecord {
    return {
      execution: { id: 'ex1', taskId: 't1', agentId: 'a1', workerId: 'w1', runtimeId: 'r1', modelId: 'm1', status: 'completed', createdAt: new Date() },
      task: dummyTask,
      policyDecisions: [],
      toolCalls: [],
      checks: [],
      filesChanged: [],
      events: [],
      errors: [],
      ...overrides
    };
  }

  it('TEST 08-A — failed current build = VERIFICATION_FAILED', () => {
    const record = makeRecord({
      checks: [{ name: 'build', command: 'make', ok: false, output: 'error', durationMs: 10 }],
      events: [
        { id: '1', executionId: 'ex1', type: 'check.completed', timestamp: new Date(), data: { name: 'build' } }
      ]
    });
    const result = evaluateExecution(record, { expectedEvidence: ['checks_pass'] });
    expect(result.success).toBe(false);
    expect(result.reasons.some(r => r.includes('evidence missing: checks failed'))).toBe(true);
  });

  it('TEST 08-B — stale build = VERIFICATION_FAILED', () => {
    const oldTime = new Date(Date.now() - 10000);
    const newTime = new Date();
    const record = makeRecord({
      checks: [{ name: 'build', command: 'make', ok: true, output: 'ok', durationMs: 10 }],
      filesChanged: ['src/main.cpp'],
      events: [
        { id: '1', executionId: 'ex1', type: 'check.completed', timestamp: oldTime, data: { name: 'build' } },
        { id: '2', executionId: 'ex1', type: 'files.changed', timestamp: newTime, data: { files: ['src/main.cpp'] } }
      ]
    });
    const result = evaluateExecution(record, { expectedEvidence: ['checks_pass'] });
    expect(result.success).toBe(false);
    expect(result.reasons.some(r => r.includes('BUILD_EVIDENCE_STALE'))).toBe(true);
  });

  it('TEST 08-D — current evidence = VERIFICATION_PASSED', () => {
    const oldTime = new Date(Date.now() - 10000);
    const newTime = new Date();
    const record = makeRecord({
      checks: [{ name: 'build', command: 'make', ok: true, output: 'ok', durationMs: 10 }],
      filesChanged: ['src/main.cpp'],
      events: [
        { id: '1', executionId: 'ex1', type: 'files.changed', timestamp: oldTime, data: { files: ['src/main.cpp'] } },
        { id: '2', executionId: 'ex1', type: 'check.completed', timestamp: newTime, data: { name: 'build' } }
      ]
    });
    const result = evaluateExecution(record, { expectedEvidence: ['checks_pass'] });
    expect(result.success).toBe(true);
  });
});
