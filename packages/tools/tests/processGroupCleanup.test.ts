import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { runShell } from '../src/process.js';

describe('process group cleanup on timeout/cancel', () => {
  it.skipIf(process.platform === 'win32')(
    'kills a grandchild process, not just the direct shell, when the command times out',
    async () => {
      // The shell backgrounds a long-lived `sleep`, echoes its PID, then itself
      // exits — before this fix, killing only the direct child left `sleep`
      // running as an orphan because `child.kill()` never reached it.
      const result = await runShell(
        'sleep 30 & echo "GRANDCHILD_PID:$!"; wait $!',
        { cwd: os.tmpdir(), unsandboxed: true, timeoutMs: 300 },
      );
      expect(result.timedOut).toBe(true);

      const match = /GRANDCHILD_PID:(\d+)/.exec(result.stdout);
      expect(match).toBeTruthy();
      const grandchildPid = Number(match![1]);

      // Give the kernel a moment to actually reap the process, then check it's gone.
      await new Promise((r) => setTimeout(r, 200));
      let alive = true;
      try {
        process.kill(grandchildPid, 0); // signal 0: existence check only
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
    5_000,
  );

  it.skipIf(process.platform === 'win32')(
    'kills the process group when the caller aborts via signal',
    async () => {
      const controller = new AbortController();
      const promise = runShell('sleep 30 & echo "GRANDCHILD_PID:$!"; wait $!', {
        cwd: os.tmpdir(),
        unsandboxed: true,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, 150));
      controller.abort();
      const result = await promise;
      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
    },
    5_000,
  );
});
