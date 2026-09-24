import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionEngine } from '@wazir/core';
import { localOutcomeInspector, planTaskResume } from '../src/recovery.js';

describe('planTaskResume', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wazir-resume-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function failedExecution() {
    const executions = new ExecutionEngine();
    const { execution } = await executions.create({
      task: { id: 't', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      jobId: 'job-1', computerId: 'local', runtimeId: 'r', modelId: 'm', workspaceRoot: root,
    });
    const id = execution.id;
    await executions.setStatus(id, 'running');
    await executions.recordFileMutations(id, [{ path: 'a.cpp', attempted: true, succeeded: true, existedBefore: false, existsAfter: true, beforeHash: undefined, afterHash: 'h', changed: true }], undefined);
    await executions.recordFilesChanged(id, ['a.cpp']);
    await executions.recordEvent(id, 'termination.completed', { reason: 'NO_PROGRESS', runStats: { turns: 5, toolCalls: 7, tokensUsed: 1234, longestNoProgressStreak: 6, duplicateActionsBlocked: 0, modelEscalations: 0 } });
    return { executions, id };
  }
  const inspect = () => localOutcomeInspector(root, 'local');

  it('resumes a failed execution with its inherited state, and records the resumption', async () => {
    const { executions, id } = await failedExecution();
    await executions.recordError(id, 'NO_PROGRESS: stuck');
    await executions.setStatus(id, 'failed');

    const plan = await planTaskResume(executions, id, inspect());

    expect(plan.action).toBe('resume');
    if (plan.action !== 'resume') return;
    expect(plan.resume).toMatchObject({ executionId: id, attempt: 2, filesChanged: ['a.cpp'], consumed: { toolCalls: 7, tokens: 1234 }, previousTermination: 'NO_PROGRESS', lastError: 'NO_PROGRESS: stuck' });
    expect(plan.reasons[0]).toContain('previous attempt ended failed; resuming the same execution');
    expect((await executions.events(id)).filter((e) => e.eventType === 'execution.resumed')).toHaveLength(1);
    const again = await planTaskResume(executions, id, inspect());
    expect(again.action === 'resume' && again.resume.attempt).toBe(3);
  });

  it('refuses while a non-idempotent call has no provable outcome — even though the execution is already failed', async () => {
    const { executions, id } = await failedExecution();
    await executions.recordToolStart(id, 'git', { command: 'commit -m fix' }, { callId: 'c1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
    await executions.setStatus(id, 'failed');

    const plan = await planTaskResume(executions, id, inspect());

    expect(plan.action).toBe('refuse');
    expect(plan.reasons[0]).toContain("'git' (call c1) was dispatched with no confirmed outcome");
    expect(executions.require(id).errors.at(-1)).toContain('RESUME_REFUSED');
  });

  it('reconciles a write that physically landed, then resumes', async () => {
    const { executions, id } = await failedExecution();
    await executions.recordToolStart(id, 'write', { path: 'b.cpp', content: 'int b;' }, { callId: 'w1', sideEffectClass: 'IDEMPOTENT_WRITE' });
    await writeFile(join(root, 'b.cpp'), 'int b;');

    const plan = await planTaskResume(executions, id, inspect());

    expect(plan.action).toBe('resume');
    expect(plan.action === 'resume' && plan.resume.reconciled[0]).toContain("'write' APPLIED");
    expect(executions.toolCheckpoints(id).find((c) => c.callId === 'w1')?.state).toBe('COMPLETED');
  });

  it('never resumes a completed execution', async () => {
    const executions = new ExecutionEngine();
    const { execution } = await executions.create({
      task: { id: 't', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local', runtimeId: 'r', modelId: 'm',
    });
    await executions.setStatus(execution.id, 'running');
    await executions.setStatus(execution.id, 'completed');
    expect((await planTaskResume(executions, execution.id, inspect())).action).toBe('refuse');
  });
});
