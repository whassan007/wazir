// Crash-point recovery across real, independent OS processes (crashPointProcess.mjs).
// The first process drives one job → task → execution through model generation, a
// non-idempotent shell effect, an idempotent file write, read-only verification and
// terminal settlement, and is killed at one point; a fresh process then reconstructs
// state from the durable store alone and plans recovery. SIGKILL gives the dying process
// no chance to react; SIGTERM runs its graceful handler (settle what it can, exit 0).
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const script = 'tests/reliability/crashPointProcess.mjs';

interface Recovered {
  jobs: number;
  jobStatusBefore?: string; taskStatusBefore?: string; acquire?: string; jobStatus?: string; taskStatus?: string; nodeState?: string; retryCount?: number;
  executionStatusBefore?: string; errors?: string[]; plan?: { action: 'resume' | 'refuse'; reasons: string[]; reconciled: string[] };
  checkpoints?: Array<{ callId: string; state: string }>; unresolved?: string[]; consumedModelRequests?: number;
  nextWrite?: string; reconcileEvents?: string[]; effect: string; outFile: string | null;
}

async function crash(point: string, signal: 'SIGKILL' | 'SIGTERM', dir: string): Promise<string> {
  try {
    await exec(process.execPath, [script, 'run', point, signal, dir], { timeout: 20_000 });
    return 'exit 0';
  } catch (error) {
    const e = error as { signal?: string; code?: number };
    return e.signal ?? `exit ${e.code}`;
  }
}

async function recover(dir: string, fault?: string): Promise<Recovered> {
  const { stdout } = await exec(process.execPath, [script, 'recover', dir, ...(fault ? [fault] : [])], { timeout: 20_000 });
  return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

async function scenario(point: string, signal: 'SIGKILL' | 'SIGTERM') {
  const dir = await mkdtemp(path.join(tmpdir(), `wazir-crash-${point}-`));
  try {
    const died = await crash(point, signal, dir);
    // SIGKILL is not catchable; SIGTERM is handled and exits cleanly.
    expect(died).toBe(signal === 'SIGKILL' ? 'SIGKILL' : 'exit 0');
    expect(await readFile(path.join(dir, 'progress.log'), 'utf8')).toContain(`dying at ${point}`);
    return { dir, recovered: await recover(dir) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Invariants that hold at every crash point, whatever was interrupted. */
function expectSafe(r: Recovered) {
  // A non-idempotent effect is never repeated by recovery.
  expect(r.effect === '' || r.effect === 'once\n').toBe(true);
  // A crashed execution is never reported completed, and a crashed job never terminal.
  expect(r.executionStatusBefore).not.toBe('completed');
  if (r.jobStatusBefore) expect(['completed', 'failed', 'cancelled']).not.toContain(r.jobStatusBefore);
  // An interrupted task is re-queued exactly once by the takeover, within its bound.
  if (r.taskStatusBefore === 'running') expect([r.acquire, r.taskStatus, r.nodeState, r.retryCount]).toEqual(['ok', 'pending', 'idle', 1]);
}

const SIGNALS = process.platform === 'win32' ? [] as const : (['SIGKILL', 'SIGTERM'] as const);

describe.skipIf(SIGNALS.length === 0)('crash-point recovery across independent processes', () => {
  for (const signal of SIGNALS) {
    describe(signal, () => {
      it('1. before task creation commits: nothing half-written, nothing to recover', async () => {
        const { dir, recovered } = await scenario('before-task-commit', signal);
        try {
          expect(recovered.jobs).toBe(0);
          expect(recovered.effect).toBe('');
        } finally { await rm(dir, { recursive: true, force: true }); }
      });

      it('2. immediately after persistence: the queued job survives and is resumable', async () => {
        const { dir, recovered } = await scenario('after-persist', signal);
        try {
          expectSafe(recovered);
          expect([recovered.jobs, recovered.jobStatusBefore, recovered.acquire, recovered.taskStatus, recovered.retryCount]).toEqual([1, 'pending', 'ok', 'pending', 0]);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });

      for (const [n, point] of [['3', 'before-tool'], ['4', 'during-generation']] as const) {
        it(`${n}. ${point}: nothing was dispatched, so the same execution resumes`, async () => {
          const { dir, recovered } = await scenario(point, signal);
          try {
            expectSafe(recovered);
            expect(recovered.executionStatusBefore).toBe(signal === 'SIGKILL' ? 'failed' : 'cancelled');
            if (signal === 'SIGKILL') expect(recovered.errors![0]).toContain('INTERRUPTED');
            expect(recovered.plan!.action).toBe('resume');
            expect(recovered.unresolved).toEqual([]);
            expect(recovered.consumedModelRequests).toBe(1); // the interrupted generation still counts against budget
            expect(recovered.effect).toBe('');
            expect(recovered.nextWrite).toBe('allowed');
          } finally { await rm(dir, { recursive: true, force: true }); }
        });
      }

      for (const [n, point] of [['5', 'during-shell'], ['7', 'before-result-persist']] as const) {
        it(`${n}. ${point}: the shell effect happened once and is not replayed; recovery refuses until reconciled`, async () => {
          const { dir, recovered } = await scenario(point, signal);
          try {
            expectSafe(recovered);
            expect(recovered.effect).toBe('once\n');
            expect(recovered.plan!.action).toBe('refuse');
            expect(recovered.plan!.reasons[0]).toContain("'shell' (call shell-1) was dispatched with no confirmed outcome");
            expect(recovered.unresolved).toEqual(['shell-1']);
            // Even a caller that ignores the refusal and forces the execution open can't dispatch another write.
            expect(recovered.nextWrite).toContain('must be reconciled');
          } finally { await rm(dir, { recursive: true, force: true }); }
        });
      }

      it('6. after filesystem mutation: the write is proven APPLIED from disk and not redone', async () => {
        const { dir, recovered } = await scenario('after-fs-mutation', signal);
        try {
          expectSafe(recovered);
          expect(recovered.outFile).toBe('final content\n');
          expect(recovered.plan!.action).toBe('resume');
          expect(recovered.plan!.reconciled).toEqual(["'write' APPLIED: 'out.txt' holds exactly the intended content"]);
          expect(recovered.checkpoints).toEqual([{ callId: 'shell-1', state: 'COMPLETED' }, { callId: 'write-1', state: 'COMPLETED' }]);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });

      it('8. during verification: the read-only check is simply re-runnable; no stale pass is carried over', async () => {
        const { dir, recovered } = await scenario('during-verification', signal);
        try {
          expectSafe(recovered);
          expect(recovered.plan!.action).toBe('resume');
          expect(recovered.plan!.reconciled[0]).toContain("'read' NOT_APPLIED");
          expect(recovered.checkpoints!.find((c) => c.callId === 'verify-1')!.state).toBe('FAILED');
        } finally { await rm(dir, { recursive: true, force: true }); }
      });

      it('9. during terminal status settlement: no terminal outcome was committed; the work is resumable', async () => {
        const { dir, recovered } = await scenario('during-settlement', signal);
        try {
          expectSafe(recovered);
          expect(recovered.outFile).toBe('final content\n');
          expect(recovered.plan!.action).toBe('resume');
          expect(recovered.unresolved).toEqual([]);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });
    });
  }

  for (const nth of [1, 2]) {
    it(`10. during recovery itself (killed at persist #${nth}): a second recovery converges, reconciling exactly once`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'wazir-crash-recovery-'));
      try {
        expect(await crash('after-fs-mutation', 'SIGKILL', dir)).toBe('SIGKILL');
        await expect(recover(dir, `DURING_EVENT_PERSIST:${nth}`)).rejects.toMatchObject({ signal: 'SIGKILL' });
        expect(await readFile(path.join(dir, 'progress.log'), 'utf8')).toContain(`recovery dying at DURING_EVENT_PERSIST #${nth}`);
        const second = await recover(dir);
        expectSafe({ ...second, taskStatusBefore: undefined });
        expect(second.plan!.action).toBe('resume');
        expect(second.reconcileEvents).toEqual(['write-1:reconciled']);
        expect(second.retryCount).toBe(1); // the interrupted recovery did not burn an extra retry
        expect(second.effect).toBe('once\n');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
}, 120_000);
