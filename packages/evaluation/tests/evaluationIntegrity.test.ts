import { describe, it, expect } from 'vitest';
import { evaluateExecution } from '../src/index.js';
import type { ExecutionRecord } from '@wazir/core';

function makeBaseRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date();
  return {
    execution: {
      id: 'exec-1',
      taskId: 'task-1',
      runtimeId: 'nvidia',
      modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      status: 'completed',
      createdAt: now,
    },
    task: {
      id: 'task-1',
      type: 'coding',
      input: 'Implement feature',
      requirements: {},
      priority: 'normal',
      status: 'completed',
      createdAt: now,
    },
    policyDecisions: [],
    toolCalls: [],
    filesChanged: [],
    checks: [],
    errors: [],
    events: [],
    ...overrides,
  };
}

describe('Evaluation Integrity Regression Suite (ISS-008)', () => {
  it('enforces mutationRequired when passed via options.mutationRequired', () => {
    const record = makeBaseRecord({ filesChanged: [] });
    const result = evaluateExecution(record, { mutationRequired: true });
    expect(result.success).toBe(false);
    expect(result.reasons).toContain('mutation required: task requires code modification but no files changed');
  });

  it('preserves task-level and contract-level mutationRequired when options.mutationRequired is omitted', () => {
    const taskMutationRecord = makeBaseRecord({
      filesChanged: [],
      task: {
        id: 'task-mut-1',
        type: 'coding',
        input: 'Modify src/index.ts',
        mutationRequired: true,
        requirements: {},
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
    });
    const res1 = evaluateExecution(taskMutationRecord);
    expect(res1.success).toBe(false);
    expect(res1.reasons).toContain('mutation required: task requires code modification but no files changed');

    const contractMutationRecord = makeBaseRecord({
      filesChanged: [],
      executionContract: {
        version: 1,
        taskId: 'task-mut-2',
        originalRequest: 'Modify src/index.ts',
        objective: 'Modify src/index.ts',
        requirements: { mutationRequired: true },
        constraints: {},
        targetRepository: null,
        targetFiles: [],
        deliverables: [],
        acceptance: { requiredEvidence: [] },
        dependencies: [],
        assumptions: [],
        completionConditions: [],
        digest: 'digest-1',
      },
    });
    const res2 = evaluateExecution(contractMutationRecord);
    expect(res2.success).toBe(false);
    expect(res2.reasons).toContain('mutation required: task requires code modification but no files changed');
  });

  it('fails evaluation on unresolved failed shell commands and passes when the same command succeeds on retry', () => {
    const now = new Date();
    const failedShellRecord = makeBaseRecord({
      filesChanged: ['src/index.ts'],
      toolCalls: [
        {
          id: 'tc-1',
          tool: 'shell',
          input: { command: 'g++ main.cpp -o main', cwd: '/workspace' },
          ok: false,
          error: 'compilation failed',
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 50,
          at: now,
        },
      ],
    });
    const failedResult = evaluateExecution(failedShellRecord);
    expect(failedResult.success).toBe(false);
    expect(failedResult.reasons).toContain('unresolved shell command failure or policy denial');

    const retriedShellRecord = makeBaseRecord({
      filesChanged: ['src/index.ts'],
      toolCalls: [
        {
          id: 'tc-1',
          tool: 'shell',
          input: { command: 'g++ main.cpp -o main', cwd: '/workspace' },
          ok: false,
          error: 'compilation failed',
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 50,
          at: now,
        },
        {
          id: 'tc-2',
          tool: 'shell',
          input: { command: 'g++ main.cpp -o main', cwd: '/workspace' },
          ok: true,
          output: '',
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 60,
          at: new Date(now.getTime() + 100),
        },
      ],
    });
    const retriedResult = evaluateExecution(retriedShellRecord);
    expect(retriedResult.success).toBe(true);
  });

  it('never evaluates terminal failed or cancelled execution records as success: true', () => {
    const failedExecRecord = makeBaseRecord({
      filesChanged: ['src/index.ts'],
      execution: {
        id: 'exec-failed',
        taskId: 'task-1',
        runtimeId: 'nvidia',
        modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        status: 'failed',
        createdAt: new Date(),
      },
    });
    const failedEval = evaluateExecution(failedExecRecord);
    expect(failedEval.success).toBe(false);
    expect(failedEval.reasons).toContain('execution status is failed');

    const cancelledExecRecord = makeBaseRecord({
      filesChanged: ['src/index.ts'],
      execution: {
        id: 'exec-cancelled',
        taskId: 'task-1',
        runtimeId: 'nvidia',
        modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        status: 'cancelled',
        createdAt: new Date(),
      },
    });
    const cancelledEval = evaluateExecution(cancelledExecRecord);
    expect(cancelledEval.success).toBe(false);
    expect(cancelledEval.reasons).toContain('execution status is cancelled');
  });
});
