import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '@wazir/shared';
import {
  ExecutionEngine,
  WorktreeManager,
  CheckpointService,
} from '../src/index.js';
import type { ExecutionCheckpoint } from '../src/types/index.js';

const EXECUTIONS = 20;
const PER_EXECUTION = 6;
const FILES_PER_SNAPSHOT = 200;

function executionId(i: number): string {
  return `exec-${String(i).padStart(2, '0')}`;
}

function makeCheckpoint(exec: number, rev: number): ExecutionCheckpoint {
  const filesSnapshot: Record<string, string> = {};
  for (let f = 0; f < FILES_PER_SNAPSHOT; f++) {
    filesSnapshot[`src/file-${f}.ts`] = `// exec ${exec} rev ${rev} file ${f}\n${'x'.repeat(256)}\n`;
  }
  return {
    id: `chk-${exec}-${rev}`,
    executionId: executionId(exec),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, exec, rev)),
    workspaceRevision: rev,
    workspaceRoot: `/tmp/ws-${exec}`,
    worktreeState: { isGit: false, filesSnapshot },
    planState: { jobId: `job-${exec % 5}`, status: 'running' },
    verificationState: { revision: rev, evidenceIds: [], checksPass: rev % 2 === 0 },
    description: `exec ${exec} rev ${rev}`,
  };
}

describe('CheckpointService indexed lookup', () => {
  let tempDir: string;
  let executionEngine: ExecutionEngine;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-chk-perf-'));
    executionEngine = new ExecutionEngine({ workspace: tempDir });
    worktreeManager = new WorktreeManager({ worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees') });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seededService(): Promise<{ service: CheckpointService; store: MemoryStore; all: ExecutionCheckpoint[] }> {
    const store = new MemoryStore();
    const digester = new CheckpointService({ executionEngine, worktreeManager, lazy: true });
    const all: ExecutionCheckpoint[] = [];
    // Insert revisions out of order so "latest" cannot depend on insertion order.
    const revOrder = [3, 0, 5, 1, 4, 2];
    for (let e = 0; e < EXECUTIONS; e++) {
      for (const rev of revOrder.slice(0, PER_EXECUTION)) {
        const checkpoint = makeCheckpoint(e, rev);
        all.push(checkpoint);
        await store.put(`checkpoint/${checkpoint.id}`, {
          version: 1,
          digest: digester.computeDigest(checkpoint),
          checkpoint,
        });
      }
    }
    const service = new CheckpointService({ store, executionEngine, worktreeManager, defaultWorkspaceRoot: tempDir });
    await service.ready;
    return { service, store, all };
  }

  it('returns exact per-execution results from the index across 120 checkpoints / 20 executions', async () => {
    const { service, all } = await seededService();
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(service.listCheckpoints()).toHaveLength(all.length);

    for (let e = 0; e < EXECUTIONS; e++) {
      const id = executionId(e);
      const listed = service.listCheckpoints(id);
      const expected = all.filter((c) => c.executionId === id);
      expect(listed.map((c) => c.id).sort()).toEqual(expected.map((c) => c.id).sort());
      expect(listed.every((c) => c.executionId === id)).toBe(true);
      expect(listed[0].createdAt).toBeInstanceOf(Date);
      expect(listed[0].worktreeState.filesSnapshot['src/file-0.ts']).toContain(`exec ${e}`);

      const latest = service.getLatestCheckpoint(id);
      expect(latest?.id).toBe(`chk-${e}-${PER_EXECUTION - 1}`);
      expect(latest?.workspaceRevision).toBe(PER_EXECUTION - 1);
    }

    expect(service.listCheckpoints('missing')).toEqual([]);
    expect(service.getLatestCheckpoint('missing')).toBeUndefined();
    // Empty string preserves legacy "list all" semantics.
    expect(service.listCheckpoints('')).toHaveLength(all.length);
  });

  it('returns defensive clones that cannot mutate internal state', async () => {
    const { service } = await seededService();
    const id = executionId(3);
    const listed = service.listCheckpoints(id);
    listed[0].worktreeState.filesSnapshot['src/file-0.ts'] = 'tampered';
    listed[0].executionId = 'other';
    const latest = service.getLatestCheckpoint(id)!;
    latest.workspaceRevision = 999;

    const again = service.listCheckpoints(id);
    expect(again.every((c) => c.executionId === id)).toBe(true);
    expect(again.some((c) => c.worktreeState.filesSnapshot['src/file-0.ts'] === 'tampered')).toBe(false);
    expect(service.getLatestCheckpoint(id)?.workspaceRevision).toBe(PER_EXECUTION - 1);
    expect(service.verifyCheckpointIntegrity(listed[0].id).valid).toBe(true);
  });

  it('breaks workspaceRevision ties by most recent createdAt', async () => {
    const store = new MemoryStore();
    const digester = new CheckpointService({ executionEngine, worktreeManager, lazy: true });
    const older = { ...makeCheckpoint(1, 2), id: 'chk-older', createdAt: new Date(1000) };
    const newer = { ...makeCheckpoint(1, 2), id: 'chk-newer', createdAt: new Date(2000) };
    for (const c of [newer, older]) {
      await store.put(`checkpoint/${c.id}`, { version: 1, digest: digester.computeDigest(c), checkpoint: c });
    }
    const service = new CheckpointService({ store, executionEngine, worktreeManager });
    await service.ready;
    expect(service.getLatestCheckpoint(executionId(1))?.id).toBe('chk-newer');
  });

  it('is orders of magnitude faster than deep-cloning the full store', async () => {
    const { service } = await seededService();
    const target = executionId(7);
    const iterations = 20;

    const time = (fn: () => void): number => {
      fn(); // warm up
      const start = performance.now();
      for (let i = 0; i < iterations; i++) fn();
      return performance.now() - start;
    };

    const fullScan = time(() => {
      service.listCheckpoints().filter((c) => c.executionId === target);
    });
    const indexed = time(() => {
      service.listCheckpoints(target);
    });
    const latest = time(() => {
      service.getLatestCheckpoint(target);
    });
    const summaries = time(() => {
      service.listCheckpointSummaries(target);
    });

    // 6 of 120 checkpoints cloned => ~20x less work; require a conservative 5x to stay CI-stable.
    expect(indexed * 5).toBeLessThan(fullScan);
    // Latest clones one checkpoint; summaries clone no snapshots at all.
    expect(latest * 20).toBeLessThan(fullScan);
    expect(summaries * 50).toBeLessThan(fullScan);
  });

  it('lists checkpoints by job via the job index', async () => {
    const { service, all } = await seededService();
    for (let j = 0; j < 5; j++) {
      const jobId = `job-${j}`;
      const byJob = service.listCheckpointsByJob(jobId);
      const expected = all.filter((c) => c.planState?.jobId === jobId);
      expect(byJob.map((c) => c.id).sort()).toEqual(expected.map((c) => c.id).sort());
    }
    expect(service.listCheckpointsByJob('job-none')).toEqual([]);
  });

  it('returns lightweight summaries without filesSnapshot payloads', async () => {
    const { service, all } = await seededService();
    const id = executionId(4);
    const summaries = service.listCheckpointSummaries(id);
    expect(summaries).toHaveLength(PER_EXECUTION);
    for (const summary of summaries) {
      const source = all.find((c) => c.id === summary.id)!;
      expect(summary).toEqual({
        id: source.id,
        executionId: id,
        jobId: source.planState?.jobId,
        workspaceRevision: source.workspaceRevision,
        createdAt: source.createdAt,
        filesCount: FILES_PER_SNAPSHOT,
        checksPass: source.verificationState.checksPass,
        description: source.description,
      });
      expect(summary).not.toHaveProperty('worktreeState');
    }
    expect(service.listCheckpointSummaries()).toHaveLength(all.length);
    expect(service.listCheckpointSummaries('missing')).toEqual([]);
  });

  it('indexes checkpoints created live through checkpoint() by execution and job', async () => {
    await fs.writeFile(path.join(tempDir, 'a.ts'), 'a\n', 'utf8');
    const service = new CheckpointService({ executionEngine, worktreeManager, defaultWorkspaceRoot: tempDir });
    const records = [];
    for (let i = 0; i < 2; i++) {
      records.push(await executionEngine.create({
        task: { id: `task-${i}`, type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
        jobId: `live-job-${i}`,
        computerId: 'local',
        runtimeId: 'rt',
        modelId: 'model',
        workspaceRoot: tempDir,
      }));
    }
    const first = await service.checkpoint(records[0].execution.id, { description: 'first' });
    const second = await service.checkpoint(records[0].execution.id, { description: 'second' });
    const other = await service.checkpoint(records[1].execution.id);

    expect(service.listCheckpoints(records[0].execution.id).map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(service.listCheckpoints(records[1].execution.id).map((c) => c.id)).toEqual([other.id]);
    expect(service.listCheckpointsByJob('live-job-0').map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(service.listCheckpointsByJob('live-job-1').map((c) => c.id)).toEqual([other.id]);
    expect(service.getLatestCheckpoint(records[0].execution.id)?.id).toBe(
      second.createdAt.getTime() >= first.createdAt.getTime() ? second.id : first.id,
    );
    expect(service.listCheckpointSummaries(records[0].execution.id).find((s) => s.id === first.id)?.description).toBe('first');
    expect(service.verifyCheckpointIntegrity(first.id)).toEqual({ valid: true, digestMatch: true });
  });

  it('keeps indexes consistent on delete and prune', async () => {
    const { service, store } = await seededService();
    const id = executionId(2);

    expect(await service.deleteCheckpoint(`chk-2-${PER_EXECUTION - 1}`)).toBe(true);
    expect(await service.deleteCheckpoint('chk-missing')).toBe(false);
    expect(service.listCheckpoints(id)).toHaveLength(PER_EXECUTION - 1);
    expect(service.getLatestCheckpoint(id)?.workspaceRevision).toBe(PER_EXECUTION - 2);
    expect(service.getCheckpoint(`chk-2-${PER_EXECUTION - 1}`)).toBeUndefined();
    expect(await store.get(`checkpoint/chk-2-${PER_EXECUTION - 1}`)).toBeUndefined();
    expect(service.listCheckpointsByJob('job-2').some((c) => c.id === `chk-2-${PER_EXECUTION - 1}`)).toBe(false);

    const pruned = await service.pruneCheckpoints(id, 2);
    expect(pruned).toHaveLength(PER_EXECUTION - 3);
    expect(service.listCheckpoints(id).map((c) => c.workspaceRevision).sort()).toEqual([PER_EXECUTION - 3, PER_EXECUTION - 2]);

    await service.pruneCheckpoints(id, 0);
    expect(service.listCheckpoints(id)).toEqual([]);
    expect(service.getLatestCheckpoint(id)).toBeUndefined();
    expect(service.listCheckpointSummaries(id)).toEqual([]);
    // Other executions untouched.
    expect(service.listCheckpoints(executionId(3))).toHaveLength(PER_EXECUTION);

    // Restart from the store: deleted checkpoints do not resurrect.
    const restarted = new CheckpointService({ store, executionEngine, worktreeManager });
    await restarted.ready;
    expect(restarted.listCheckpoints(id)).toEqual([]);
    expect(restarted.listCheckpoints()).toHaveLength(EXECUTIONS * PER_EXECUTION - PER_EXECUTION);
  });

  it('re-indexes a checkpoint id that is re-imported under a different execution', async () => {
    const { service } = await seededService();
    const original = service.getCheckpoint('chk-0-0')!;
    const portable = await (async () => {
      // Create an execution so export can resolve its record.
      const record = await executionEngine.create({
        task: { id: 'task-port', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
        computerId: 'local',
        runtimeId: 'rt',
        modelId: 'model',
        workspaceRoot: tempDir,
      });
      await fs.writeFile(path.join(tempDir, 'p.ts'), 'p\n', 'utf8');
      const fresh = new CheckpointService({ executionEngine, worktreeManager, defaultWorkspaceRoot: tempDir });
      const chk = await fresh.checkpoint(record.execution.id);
      return { record, envelope: await fresh.exportPortableCheckpoint(chk.id) };
    })();

    const imported = await service.importPortableCheckpoint(portable.envelope);
    expect(service.listCheckpoints(portable.record.execution.id).map((c) => c.id)).toEqual([imported.id]);
    expect(service.getLatestCheckpoint(portable.record.execution.id)?.id).toBe(imported.id);
    expect(service.verifyCheckpointIntegrity(imported.id)).toEqual({ valid: true, digestMatch: true });
    expect(service.getCheckpoint(original.id)?.executionId).toBe(executionId(0));
  });

  describe('verifyCheckpointIntegrity (fail-closed)', () => {
    it('accepts untampered checkpoints', async () => {
      const { service } = await seededService();
      expect(service.verifyCheckpointIntegrity('chk-5-3')).toEqual({ valid: true, digestMatch: true });
    });

    it('rejects unknown checkpoints', async () => {
      const { service } = await seededService();
      expect(service.verifyCheckpointIntegrity('chk-nope')).toEqual({
        valid: false,
        reason: 'CHECKPOINT_NOT_FOUND',
        digestMatch: false,
      });
    });

    it('detects tampered file snapshot content', async () => {
      const { service } = await seededService();
      const internal = (service as any).checkpoints.get('chk-5-3') as ExecutionCheckpoint;
      internal.worktreeState.filesSnapshot['src/file-0.ts'] = 'malicious payload';
      expect(service.verifyCheckpointIntegrity('chk-5-3')).toEqual({
        valid: false,
        reason: 'CHECKPOINT_DIGEST_MISMATCH',
        digestMatch: false,
      });
    });

    it('detects injected files and tampered revisions', async () => {
      const { service } = await seededService();
      const a = (service as any).checkpoints.get('chk-6-1') as ExecutionCheckpoint;
      a.worktreeState.filesSnapshot['evil.sh'] = 'rm -rf /';
      expect(service.verifyCheckpointIntegrity('chk-6-1').valid).toBe(false);

      const b = (service as any).checkpoints.get('chk-6-2') as ExecutionCheckpoint;
      b.workspaceRevision = 42;
      const result = service.verifyCheckpointIntegrity('chk-6-2');
      expect(result.valid).toBe(false);
      expect(result.digestMatch).toBe(false);
    });

    it('fails closed on structural corruption even when the digest still matches', async () => {
      const { service } = await seededService();
      const c = (service as any).checkpoints.get('chk-7-1') as ExecutionCheckpoint;
      (c as any).createdAt = new Date('not a date');
      expect(service.verifyCheckpointIntegrity('chk-7-1')).toEqual({
        valid: false,
        reason: 'INVALID_CREATED_AT',
        digestMatch: true,
      });

      const d = (service as any).checkpoints.get('chk-7-2') as ExecutionCheckpoint;
      (d as any).verificationState = undefined;
      expect(service.verifyCheckpointIntegrity('chk-7-2').reason).toBe('INVALID_VERIFICATION_STATE');

      const e = (service as any).checkpoints.get('chk-7-3') as ExecutionCheckpoint;
      (e.worktreeState as any).filesSnapshot = undefined;
      const result = service.verifyCheckpointIntegrity('chk-7-3');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_FILES_SNAPSHOT');
    });

    it('rejects non-string snapshot entries and id mismatches', async () => {
      const { service } = await seededService();
      const c = (service as any).checkpoints.get('chk-8-1') as ExecutionCheckpoint;
      (c.worktreeState.filesSnapshot as any)['src/file-1.ts'] = 123;
      expect(service.verifyCheckpointIntegrity('chk-8-1').valid).toBe(false);

      const d = (service as any).checkpoints.get('chk-8-2') as ExecutionCheckpoint;
      d.id = 'chk-forged';
      expect(service.verifyCheckpointIntegrity('chk-8-2').reason).toBe('CHECKPOINT_ID_MISMATCH');
    });
  });
});
