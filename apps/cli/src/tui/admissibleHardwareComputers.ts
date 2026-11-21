import type { RoutingMode, Scheduler, Task } from '@wazir/core';

/** Only distribute to computers that the actual scheduler can place on.
 * A host being ONLINE is not sufficient when a cold model requires 8 GB
 * and that host has only 0.15 GB available. No model is loaded by this probe.
 */
export function admissibleHardwareComputers(
  scheduler: Pick<Scheduler, 'plan'>,
  computerIds: readonly string[],
  input: string,
  routingMode?: RoutingMode,
): string[] {
  const visited = new Set<string>();
  return computerIds.filter((computerId) => {
    if (visited.has(computerId)) return false;
    visited.add(computerId);
    const task: Task = {
      id: `interactive-admission-${computerId}`,
      type: 'coding',
      title: input.slice(0, 60),
      input,
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
      requirements: {},
      execution: {
        targetComputerId: computerId,
        routingMode: routingMode ?? 'LOCAL_ONLY',
      },
    };
    try {
      return scheduler.plan({ task }).computerId === computerId;
    } catch {
      // Admission failures make this host ineligible for weighted dispatch.
      // The orchestrator retains responsibility for reporting a final failure.
      return false;
    }
  });
}
