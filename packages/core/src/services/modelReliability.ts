import type { TerminationReason } from '../types/agent.js';
import type { ExecutionRecord } from '../types/execution.js';

/**
 * Per-(model, task class) circuit breaker.
 *
 * Tracks recent model-attributable outcomes. When the failure rate over the
 * rolling window crosses the threshold the circuit OPENs and the Scheduler stops
 * routing that task class to the model. After a cooldown it becomes HALF_OPEN:
 * the next routed run is a trial — success CLOSEs it (history reset), failure
 * re-OPENs it. One failure never opens a circuit (`minSamples`), and nothing is
 * permanently blacklisted.
 *
 * Only failures the model is responsible for count. Provider outages, policy
 * denials, cancellations and budget limits imposed by the caller say nothing
 * about the model's reliability and are ignored.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ModelReliabilityOptions {
  /** Outcomes kept per (model, task class). Default 10. */
  window?: number;
  /** Outcomes required before the circuit may open. Default 4. */
  minSamples?: number;
  /** Failure fraction at or above which the circuit opens. Default 0.6. */
  failureRateThreshold?: number;
  /** How long an OPEN circuit rejects routing before a HALF_OPEN trial. Default 10 minutes. */
  cooldownMs?: number;
}

export interface ReliabilityOutcome {
  modelId: string;
  taskClass: string;
  success: boolean;
  reason?: TerminationReason | string;
  at?: Date;
}

export interface CircuitStatus {
  state: CircuitState;
  samples: number;
  failures: number;
  failureRate: number;
  openedAt?: Date;
  /** Human-readable explanation suitable for routing reasons. */
  reason: string;
}

interface Circuit {
  outcomes: Array<{ success: boolean; reason?: string; at: Date }>;
  openedAt?: Date;
}

// Stop reasons that reflect the model's own behavior. Anything else (e.g.
// CANCELLED, POLICY_DENIED, MAX_WALL_CLOCK on a slow host) is not evidence
// about the model and is not recorded.
const MODEL_ATTRIBUTABLE_FAILURES = new Set<string>([
  'MODEL_PROTOCOL_BUDGET_EXHAUSTED',
  'NO_PROGRESS',
  'REPEATED_ACTION',
  'MAX_REPAIRS',
  'MAX_TURNS',
  'MAX_TOOL_CALLS',
  'MAX_TOKENS',
]);
const SUCCESS_REASONS = new Set<string>(['VERIFICATION_PASSED', 'COMPLETED']);

/** 'success' / 'failure' when a termination says something about the model, else null. */
export function classifyTerminationForReliability(reason: string | undefined): 'success' | 'failure' | null {
  if (!reason) return null;
  if (SUCCESS_REASONS.has(reason)) return 'success';
  if (MODEL_ATTRIBUTABLE_FAILURES.has(reason)) return 'failure';
  return null;
}

export class ModelReliabilityTracker {
  private readonly window: number;
  private readonly minSamples: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly circuits = new Map<string, Circuit>();

  constructor(options: ModelReliabilityOptions = {}) {
    this.window = options.window ?? 10;
    this.minSamples = options.minSamples ?? 4;
    this.threshold = options.failureRateThreshold ?? 0.6;
    this.cooldownMs = options.cooldownMs ?? 10 * 60_000;
    if (this.window < 1 || this.minSamples < 1 || this.minSamples > this.window) throw new Error('invalid reliability window');
    if (!(this.threshold > 0 && this.threshold <= 1)) throw new Error('failureRateThreshold must be in (0, 1]');
  }

  private key(modelId: string, taskClass: string): string {
    return `${modelId}\u0000${taskClass}`;
  }

  record(outcome: ReliabilityOutcome): CircuitStatus {
    const at = outcome.at ?? new Date();
    const key = this.key(outcome.modelId, outcome.taskClass);
    const circuit = this.circuits.get(key) ?? { outcomes: [] };
    this.circuits.set(key, circuit);
    const prior = this.evaluate(circuit, at).state;

    if (prior === 'HALF_OPEN') {
      if (outcome.success) {
        // Trial passed: close with a clean slate so stale failures can't re-open it.
        circuit.outcomes = [{ success: true, reason: outcome.reason, at }];
        circuit.openedAt = undefined;
      } else {
        circuit.outcomes.push({ success: false, reason: outcome.reason, at });
        circuit.openedAt = at;
      }
    } else {
      circuit.outcomes.push({ success: outcome.success, reason: outcome.reason, at });
      if (circuit.outcomes.length > this.window) circuit.outcomes.splice(0, circuit.outcomes.length - this.window);
      if (prior === 'CLOSED') {
        const { failures, samples } = this.counts(circuit);
        if (samples >= this.minSamples && failures / samples >= this.threshold) circuit.openedAt = at;
      }
    }
    if (circuit.outcomes.length > this.window) circuit.outcomes.splice(0, circuit.outcomes.length - this.window);
    return this.evaluate(circuit, at);
  }

  /** Records a run's termination when it is model-attributable; returns null otherwise. */
  recordTermination(modelId: string, taskClass: string, reason: string | undefined, at?: Date): CircuitStatus | null {
    const verdict = classifyTerminationForReliability(reason);
    if (!verdict) return null;
    return this.record({ modelId, taskClass, success: verdict === 'success', reason, at });
  }

  status(modelId: string, taskClass: string, now: Date = new Date()): CircuitStatus {
    const circuit = this.circuits.get(this.key(modelId, taskClass));
    return circuit ? this.evaluate(circuit, now) : { state: 'CLOSED', samples: 0, failures: 0, failureRate: 0, reason: 'no reliability history' };
  }

  /** False only while the circuit is OPEN; a HALF_OPEN circuit admits its trial. */
  allows(modelId: string, taskClass: string, now: Date = new Date()): boolean {
    return this.status(modelId, taskClass, now).state !== 'OPEN';
  }

  /**
   * Rebuilds circuits from durable execution history, oldest first, using the
   * `termination.completed` event each run recorded. Runs without one are skipped.
   */
  hydrate(records: ExecutionRecord[]): void {
    const terminations: ReliabilityOutcome[] = [];
    for (const record of records) {
      for (const event of record.events) {
        const type = event.eventType ?? event.type;
        // An accepted mid-run escalation is a failure of the model it abandoned.
        if (type === 'model.route.changed') {
          const change = event.data as { accepted?: boolean; previousModel?: string; failureClass?: string } | undefined;
          if (change?.accepted && change.previousModel && classifyTerminationForReliability(change.failureClass) === 'failure') {
            terminations.push({ modelId: change.previousModel, taskClass: record.task.type, success: false, reason: change.failureClass, at: new Date(event.timestamp) });
          }
        }
      }
      const event = [...record.events].reverse().find((e) => (e.eventType ?? e.type) === 'termination.completed');
      const data = event?.data as { reason?: string; modelId?: string } | undefined;
      const verdict = classifyTerminationForReliability(data?.reason);
      if (!event || !verdict) continue;
      terminations.push({
        // The model that was running when the run stopped, which differs from the
        // scheduled one after an escalation.
        modelId: data?.modelId ?? record.execution.modelId,
        taskClass: record.task.type,
        success: verdict === 'success',
        reason: data?.reason,
        at: new Date(event.timestamp),
      });
    }
    terminations.sort((a, b) => a.at!.getTime() - b.at!.getTime());
    for (const outcome of terminations) this.record(outcome);
  }

  private counts(circuit: Circuit): { failures: number; samples: number } {
    return { samples: circuit.outcomes.length, failures: circuit.outcomes.filter((o) => !o.success).length };
  }

  private evaluate(circuit: Circuit, now: Date): CircuitStatus {
    const { failures, samples } = this.counts(circuit);
    const failureRate = samples > 0 ? Number((failures / samples).toFixed(3)) : 0;
    const summary = `${failures}/${samples} recent model-attributable failures`;
    if (!circuit.openedAt) return { state: 'CLOSED', samples, failures, failureRate, reason: summary };
    const elapsed = now.getTime() - circuit.openedAt.getTime();
    if (elapsed < this.cooldownMs) {
      return { state: 'OPEN', samples, failures, failureRate, openedAt: circuit.openedAt, reason: `circuit open: ${summary}; retry after ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s` };
    }
    return { state: 'HALF_OPEN', samples, failures, failureRate, openedAt: circuit.openedAt, reason: `circuit half-open: trial run after ${summary}` };
  }
}
