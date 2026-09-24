import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionEngine, type ExecutionRecord, type ToolCallCheckpoint } from '@wazir/core';
import { localOutcomeInspector, reconcileLocalOutcomes } from '../src/recovery.js';

describe('CLI startup recovery', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wazir-recovery-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function crashedWrite(opts: { computerId: string; jobId?: string }) {
    let durable!: ExecutionRecord;
    const engine = new ExecutionEngine({ persist: (r) => { durable = structuredClone(r); } });
    const { execution } = await engine.create({
      task: { id: 't', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: opts.computerId, runtimeId: 'r', modelId: 'm', ...(opts.jobId ? { jobId: opts.jobId } : {}),
    } as never);
    await engine.recordToolStart(execution.id, 'write', { path: 'main.cpp', content: 'int main(){}' }, { callId: 'w', sideEffectClass: 'IDEMPOTENT_WRITE' });
    // Process dies here; a new process loads the durable record.
    const restarted = new ExecutionEngine({ load: () => [durable], persist: (r) => { durable = structuredClone(r); } });
    await restarted.ready;
    return { engine: restarted, id: execution.id };
  }

  it('reconciles a local standalone write that provably landed', async () => {
    await writeFile(join(root, 'main.cpp'), 'int main(){}');
    const { engine, id } = await crashedWrite({ computerId: 'local' });
    const done = await reconcileLocalOutcomes(engine, localOutcomeInspector(root, 'local'));
    expect(done).toEqual([{ executionId: id, callId: 'w', outcome: 'APPLIED' }]);
    expect(engine.reconstruct(id).plan.action).toBe('resume');
  });

  it('does not judge a remote or job-worktree execution against the local tree', async () => {
    await writeFile(join(root, 'main.cpp'), 'int main(){}');
    const inspect = localOutcomeInspector(root, 'local');
    const call = { toolName: 'write', sideEffectClass: 'IDEMPOTENT_WRITE', input: { path: 'main.cpp', content: 'int main(){}' } } as ToolCallCheckpoint;
    const remote = { execution: { computerId: 'gpu-box' } } as ExecutionRecord;
    const jobTask = { execution: { computerId: 'local', jobId: 'job-1' } } as ExecutionRecord;
    expect((await inspect(remote, call)).outcome).toBe('UNDETERMINED');
    expect((await inspect(jobTask, call)).outcome).toBe('UNDETERMINED');

    const { engine, id } = await crashedWrite({ computerId: 'gpu-box' });
    expect(await reconcileLocalOutcomes(engine, inspect)).toEqual([]);
    expect(engine.reconstruct(id).plan.action).toBe('reconcile');
  });
});
