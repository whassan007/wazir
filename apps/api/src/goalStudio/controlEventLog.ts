import { GOAL_STORE_KEYS, GoalStudioFailure } from '@wazir/goals';
import type { GoalEventLog, GoalRunId, GoalStudioDeps, GoalStudioEvent } from '@wazir/goals';
import type { KeyValueStore } from '@wazir/shared';

/**
 * Durable, replayable Goal Studio event log (workstream 07 owns the
 * `goals/events/` key space).
 *
 * - `seq` is strictly monotonic per run, starting at 1, with no holes.
 * - An event is persisted before any subscriber sees it, so a client that
 *   reconnects and replays from `read(runId, lastSeq)` never misses one.
 * - Appends for one run are serialized in-process; when the store offers an
 *   atomic `update`, the head counter is advanced through it so two processes
 *   sharing a store still never issue the same seq.
 */
export interface GoalEventLogOptions {
  /** Hard cap on one `read` page. */
  maxReadLimit?: number;
}

const DEFAULT_MAX_READ = 1000;

function headKey(runId: GoalRunId): string {
  // `goals/events/<runId>` (no trailing slash) never matches the event prefix
  // `goals/events/<runId>/`, so it cannot be mistaken for an event on list().
  return `goals/events/${runId}`;
}

function eventPrefix(runId: GoalRunId): string {
  return `goals/events/${runId}/`;
}

export class StoreGoalEventLog implements GoalEventLog {
  private readonly chains = new Map<GoalRunId, Promise<unknown>>();
  private readonly listeners = new Map<GoalRunId, Set<(event: GoalStudioEvent) => void>>();
  private readonly clock: () => Date;
  private readonly maxRead: number;

  constructor(private readonly store: KeyValueStore, clock?: () => Date, options: GoalEventLogOptions = {}) {
    this.clock = clock ?? (() => new Date());
    this.maxRead = options.maxReadLimit ?? DEFAULT_MAX_READ;
  }

  append(input: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { timestamp?: string }): Promise<GoalStudioEvent> {
    const runId = input.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      return Promise.reject(new GoalStudioFailure('VALIDATION', 'goal studio events must carry a runId'));
    }
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.appendNow(runId, input));
    this.chains.set(runId, next);
    void next.finally(() => {
      if (this.chains.get(runId) === next) this.chains.delete(runId);
    }).catch(() => undefined);
    return next;
  }

  private async appendNow(runId: GoalRunId, input: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { timestamp?: string }): Promise<GoalStudioEvent> {
    const seq = await this.nextSeq(runId);
    const event: GoalStudioEvent = {
      ...input,
      seq,
      runId,
      timestamp: input.timestamp ?? this.clock().toISOString(),
      data: input.data ?? {},
    };
    await this.store.put(GOAL_STORE_KEYS.event(runId, seq), event);
    const listeners = this.listeners.get(runId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must never fail the producer.
        }
      }
    }
    return event;
  }

  private async nextSeq(runId: GoalRunId): Promise<number> {
    const existing = await this.store.get<{ seq: number }>(headKey(runId));
    // A missing head (first event, or a store restored without it) is rebuilt
    // from the persisted events so seq never restarts below what is on disk.
    const floor = existing ? 0 : await this.lastPersistedSeq(runId);
    if (this.store.update) {
      const head = await this.store.update<{ seq: number }>(headKey(runId), (current) => ({
        seq: Math.max(current?.seq ?? 0, floor) + 1,
      }));
      return head.seq;
    }
    const seq = Math.max(existing?.seq ?? 0, floor) + 1;
    await this.store.put(headKey(runId), { seq });
    return seq;
  }

  private async lastPersistedSeq(runId: GoalRunId): Promise<number> {
    const entries = await this.store.list(eventPrefix(runId));
    let max = 0;
    for (const entry of entries) {
      const seq = (entry.value as GoalStudioEvent | undefined)?.seq;
      if (typeof seq === 'number' && seq > max) max = seq;
    }
    return max;
  }

  async read(runId: GoalRunId, afterSeq = 0, limit?: number): Promise<GoalStudioEvent[]> {
    const cap = Math.max(1, Math.min(limit ?? this.maxRead, this.maxRead));
    const entries = await this.store.list(eventPrefix(runId));
    return entries
      .map((entry) => entry.value as GoalStudioEvent)
      .filter((event) => event && typeof event.seq === 'number' && event.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, cap);
  }

  subscribe(runId: GoalRunId, listener: (event: GoalStudioEvent) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  /** Number of live subscribers for a run (used by tests to prove SSE cleanup). */
  subscriberCount(runId: GoalRunId): number {
    return this.listeners.get(runId)?.size ?? 0;
  }
}

/** Factory per INTEGRATION-CONTRACTS §10. */
export function createGoalEventLog(deps: GoalStudioDeps & { options?: GoalEventLogOptions }): StoreGoalEventLog {
  return new StoreGoalEventLog(deps.store, deps.clock, deps.options);
}
