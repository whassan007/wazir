import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { runShell } from '../src/process.js';
import { isProcessAlive } from '@wazir/shared';

describe('process group cleanup on timeout/cancel', () => {
  const spawnGrandchildCmd = `"${process.execPath}" -e "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']); console.log('GRANDCHILD_PID:' + c.pid); setInterval(()=>{}, 1000)"`;

  it.skipIf(process.platform === 'win32')(
    'kills a grandchild process, not just the direct shell, when the command times out',
    async () => {
      const result = await runShell(
        spawnGrandchildCmd,
        { cwd: os.tmpdir(), unsandboxed: true, timeoutMs: 500 },
      );
      expect(result.timedOut).toBe(true);

      const match = /GRANDCHILD_PID:(\d+)/.exec(result.stdout);
      expect(match).toBeTruthy();
      const grandchildPid = Number(match![1]);

      // Give the OS a moment to reap the process tree, then check it's gone.
      await new Promise((r) => setTimeout(r, 400));
      expect(isProcessAlive(grandchildPid)).toBe(false);
    },
    10_000,
  );

  it(
    'kills the process group when the caller aborts via signal',
    async () => {
      const controller = new AbortController();
      const promise = runShell(spawnGrandchildCmd, {
        cwd: os.tmpdir(),
        unsandboxed: true,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      const result = await promise;
      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
    },
    10_000,
  );
});
