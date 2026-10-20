import { ModelLifecycleError, SchedulingError } from '@wazir/core';
import type { ModelFallback, ModelLoadOptions, Scheduler, SchedulerDecision, Task } from '@wazir/core';

/** Upper bound on distinct models tried for one task, so a bad registry cannot loop. */
export const MAX_ROUTE_ATTEMPTS = 3;

/**
 * Plans a task and confirms the chosen model is still served by its runtime before
 * anything is dispatched. An unavailable model is excluded and the Scheduler re-plans;
 * every skip is returned as a fallback with its reason. A model the user pinned is never
 * replaced: it fails immediately with the runtime's reason.
 */
export async function planAvailableRoute(
  engine: {
    scheduler: Pick<Scheduler, 'plan'>;
    lifecycle?: { verifyAvailable(modelId: string, options?: ModelLoadOptions): Promise<void> };
  },
  input: { task: Task; requiredContextTokens?: number },
  maxAttempts = MAX_ROUTE_ATTEMPTS,
): Promise<SchedulerDecision> {
  const tried: string[] = [];
  const fallbacks: ModelFallback[] = [];
  let skipped: { from: string; reason: string } | undefined;
  for (;;) {
    const scheduling = engine.scheduler.plan({ ...input, excludeModelIds: tried });
    if (skipped) fallbacks.push({ ...skipped, to: scheduling.modelId });
    skipped = undefined;
    if (scheduling.computerId && engine.lifecycle) {
      try {
        await engine.lifecycle.verifyAvailable(scheduling.modelId, { computerId: scheduling.computerId, runtimeId: scheduling.runtimeId });
      } catch (error) {
        if (!(error instanceof ModelLifecycleError) || error.code !== 'MODEL_UNAVAILABLE') throw error;
        const reason = error.reasons[0] ?? error.message;
        if (input.task.execution?.targetModelId === scheduling.modelId) {
          throw new SchedulingError(`Requested model '${scheduling.modelId}' is unavailable: ${reason}. No silent fallback will be performed.`, [reason]);
        }
        tried.push(scheduling.modelId);
        if (tried.length >= maxAttempts) {
          throw new SchedulingError(`No available model after ${tried.length} attempts (${tried.join(', ')}).`, [reason]);
        }
        skipped = { from: scheduling.modelId, reason };
        continue;
      }
    }
    if (!fallbacks.length) return scheduling;
    return { ...scheduling, fallbacks, reasons: [...scheduling.reasons, ...fallbacks.map((f) => `fallback: ${f.from} -> ${f.to} (${f.reason})`)] };
  }
}
