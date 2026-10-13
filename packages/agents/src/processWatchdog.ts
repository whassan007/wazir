import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Kills process group `pgid` when `ownerPid` exits. Agents run in their own process group
 * so cancel/timeout can reach their children; that also means they outlive a `wa` that is
 * SIGKILLed, OOM-killed or loses its terminal, and keep editing the workspace unsupervised.
 * This watchdog runs in its own session (outside the group it kills), polls once a second,
 * and exits by itself when the group is gone. POSIX only; the caller kills it on normal exit.
 */
export function spawnGroupWatchdog(ownerPid: number, pgid: number): ChildProcess | undefined {
  if (process.platform === 'win32') return undefined;
  const script = `while kill -0 ${ownerPid} 2>/dev/null; do kill -0 -${pgid} 2>/dev/null || exit 0; sleep 1; done; kill -KILL -${pgid} 2>/dev/null; exit 0`;
  try {
    const w = spawn('/bin/sh', ['-c', script], { stdio: 'ignore', detached: true });
    w.on('error', () => undefined);
    w.unref();
    return w;
  } catch {
    return undefined;
  }
}
