import type { ComputerRegistry } from '@wazir/core';

/**
 * This process *is* the local computer's worker, so it must heartbeat it for as long as
 * it lives. Without this the local computer was only heartbeated at startup and on model
 * placement, and this same process's RecoveryManager declared it offline after 60s of
 * quiet — e.g. during a long test check — orphaning the execution it was still running.
 * The timer is unref'd: it never keeps the process alive, and it stops when the process
 * dies, which is exactly when the worker should go stale.
 */
export function startLocalHeartbeat(
  computers: ComputerRegistry,
  computerId: string,
  load: () => NonNullable<Parameters<ComputerRegistry['heartbeat']>[1]>['load'],
  intervalMs = 15_000,
): () => void {
  const timer = setInterval(() => { computers.heartbeat(computerId, { load: load() }); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
