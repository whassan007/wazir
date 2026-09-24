import type { ExecutionRecord } from '../types/execution.js';
import type { ModelProtocolMetrics } from '../types/agent.js';
import type { ModelPerformanceProfile } from '../types/model.js';

/**
 * Derives per-(model, task class) performance profiles from execution evidence.
 *
 * Inputs are durable facts only: the typed `termination.completed` event (reason,
 * the model running at the end, protocol metrics), `model.route.changed` events,
 * revision-stamped check records, recorded tool calls and execution timestamps.
 * Nothing the model said about itself is used.
 *
 * Run-level metrics (first-pass build/test, tool calls, duration) are only taken
 * from runs that stayed on one model; after an escalation those facts can't be
 * attributed to a single model. Failure rates still count the abandoned model.
 */

const SUCCESS = new Set(['VERIFICATION_PASSED', 'COMPLETED']);
const PROTOCOL = new Set(['MODEL_PROTOCOL_BUDGET_EXHAUSTED']);
const NO_PROGRESS = new Set(['NO_PROGRESS', 'REPEATED_ACTION']);

interface Accumulator {
  samples: number;
  successes: number;
  protocolFailures: number;
  noProgress: number;
  builds: number;
  firstBuildPasses: number;
  tests: number;
  firstTestPasses: number;
  actionAttempts: number;
  validActions: number;
  sawMetrics: boolean;
  toolCalls: number[];
  durations: number[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const rate = (n: number, d: number): number => (d > 0 ? Number((n / d).toFixed(3)) : 0);
const optionalRate = (n: number, d: number): number | null => (d > 0 ? Number((n / d).toFixed(3)) : null);

export function measureModelPerformance(records: ExecutionRecord[], now: Date = new Date()): Map<string, ModelPerformanceProfile[]> {
  const acc = new Map<string, Accumulator>();
  const get = (modelId: string, taskClass: string): Accumulator => {
    const key = `${modelId}\u0000${taskClass}`;
    let a = acc.get(key);
    if (!a) {
      a = { samples: 0, successes: 0, protocolFailures: 0, noProgress: 0, builds: 0, firstBuildPasses: 0, tests: 0, firstTestPasses: 0, actionAttempts: 0, validActions: 0, sawMetrics: false, toolCalls: [], durations: [] };
      acc.set(key, a);
    }
    return a;
  };

  for (const record of records) {
    const taskClass = record.task.type;
    const type = (e: { eventType?: string; type: string }) => e.eventType ?? e.type;
    const escalations = record.events.filter((e) => type(e) === 'model.route.changed' && (e.data as { accepted?: boolean } | undefined)?.accepted);
    for (const event of escalations) {
      const change = event.data as { previousModel?: string; failureClass?: string };
      if (!change.previousModel) continue;
      const a = get(change.previousModel, taskClass);
      a.samples += 1;
      if (PROTOCOL.has(change.failureClass ?? '')) a.protocolFailures += 1;
      if (NO_PROGRESS.has(change.failureClass ?? '')) a.noProgress += 1;
    }

    const termination = [...record.events].reverse().find((e) => type(e) === 'termination.completed');
    if (!termination) continue;
    const data = termination.data as { reason?: string; modelId?: string; protocolMetrics?: ModelProtocolMetrics } | undefined;
    const modelId = data?.modelId ?? record.execution.modelId;
    const a = get(modelId, taskClass);
    a.samples += 1;
    const reason = data?.reason ?? '';
    if (SUCCESS.has(reason)) a.successes += 1;
    if (PROTOCOL.has(reason)) a.protocolFailures += 1;
    if (NO_PROGRESS.has(reason)) a.noProgress += 1;
    if (data?.protocolMetrics && escalations.length === 0) {
      a.sawMetrics = true;
      a.actionAttempts += data.protocolMetrics.actionAttempts;
      a.validActions += data.protocolMetrics.validActions;
    }
    if (escalations.length > 0) continue;

    const firstBuild = record.checks.find((c) => c.name === 'build');
    if (firstBuild) {
      a.builds += 1;
      if (firstBuild.ok) a.firstBuildPasses += 1;
    }
    const firstTest = record.checks.find((c) => c.name === 'test');
    if (firstTest) {
      a.tests += 1;
      if (firstTest.ok) a.firstTestPasses += 1;
    }
    a.toolCalls.push(record.toolCalls.length);
    const { startedAt, completedAt } = record.execution;
    if (startedAt && completedAt) a.durations.push(new Date(completedAt).getTime() - new Date(startedAt).getTime());
  }

  const out = new Map<string, ModelPerformanceProfile[]>();
  for (const [key, a] of acc) {
    const [modelId, taskClass] = key.split('\u0000');
    const profile: ModelPerformanceProfile = {
      taskClass,
      samples: a.samples,
      verifiedSuccessRate: rate(a.successes, a.samples),
      firstPassBuildRate: optionalRate(a.firstBuildPasses, a.builds),
      firstPassTestRate: optionalRate(a.firstTestPasses, a.tests),
      protocolFailureRate: rate(a.protocolFailures, a.samples),
      noProgressRate: rate(a.noProgress, a.samples),
      schemaReliability: a.sawMetrics ? optionalRate(a.validActions, a.actionAttempts) : null,
      medianToolCalls: median(a.toolCalls),
      medianDurationMs: median(a.durations),
      measuredAt: now,
    };
    out.set(modelId, [...(out.get(modelId) ?? []), profile]);
  }
  return out;
}
