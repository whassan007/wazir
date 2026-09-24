import type { AgentRunStats, CircuitStatus, ModelProtocolMetrics, TerminationReason } from '@wazir/core';
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
  protocolMetrics?: ModelProtocolMetrics,
  runStats?: AgentRunStats,
): Promise<CircuitStatus | null> {
  // protocolMetrics feed the measured schemaReliability (see measureModelPerformance);
  // runStats are the agent's own harness counters, surfaced by summarizeExecution.
  await engine.executions.recordEvent(executionId, 'termination.completed', { reason, modelId, taskClass, protocolMetrics, runStats });
  return engine.reliability?.recordTermination(modelId, taskClass, reason) ?? null;
}
