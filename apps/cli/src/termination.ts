import type { CircuitStatus, TerminationReason } from '@wazir/core';
import type { RookEngine } from './engine.js';

/**
 * Persists a run's typed stop condition as the durable `termination.completed`
 * event and feeds it to the model circuit breaker. The event — not the in-memory
 * tracker — is the source of truth: the tracker is rebuilt from these events on
 * the next engine start.
 */
export async function recordTermination(
  engine: Pick<RookEngine, 'executions' | 'reliability'>,
  executionId: string,
  reason: TerminationReason,
  modelId: string,
  taskClass: string,
): Promise<CircuitStatus | null> {
  await engine.executions.recordEvent(executionId, 'termination.completed', { reason, modelId, taskClass });
  return engine.reliability?.recordTermination(modelId, taskClass, reason) ?? null;
}
