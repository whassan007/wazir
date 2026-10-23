/** Reference GoalEventLog: per-run monotonic seq, durable in the KeyValueStore, live fan-out. */
import { EventEmitter } from 'node:events';
import type { KeyValueStore } from '@wazir/shared';
import { GOAL_STORE_KEYS, type GoalEventLog, type GoalRunId, type GoalStudioEvent } from '../../../packages/goals/src/contracts.js';
import { clone, fail, listIso, mutexFor, systemClock, type Clock } from './util.js';

const emitters = new WeakMap<object, EventEmitter>();
function emitterFor(store: object): EventEmitter {
  let e = emitters.get(store);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(0);
    emitters.set(store, e);
  }
  return e;
}

/** Events without a runId are logged under this pseudo-run. */
export const GLOBAL_EVENT_STREAM = '_global';

export class MemoryGoalEventLog implements GoalEventLog {
  private readonly clock: Clock;
  constructor(private readonly store: KeyValueStore, opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  async append(event: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { timestamp?: string }): Promise<GoalStudioEvent> {
    if (!event || typeof event.type !== 'string') fail('VALIDATION', 'event.type is required');
    const stream = event.runId ?? GLOBAL_EVENT_STREAM;
    const stored = await mutexFor(this.store).run(`events:${stream}`, async () => {
      const head = await this.store.get<number>(`goals/events-head/${stream}`);
      const seq = (head ?? 0) + 1;
      const full: GoalStudioEvent = { ...clone(event), seq, timestamp: event.timestamp ?? this.clock().toISOString(), data: clone(event.data ?? {}) };
      await this.store.put(GOAL_STORE_KEYS.event(stream, seq), full);
      await this.store.put(`goals/events-head/${stream}`, seq);
      return full;
    });
    emitterFor(this.store).emit(stream, clone(stored));
    return stored;
  }

  async read(runId: GoalRunId, afterSeq = 0, limit?: number): Promise<GoalStudioEvent[]> {
    const all = (await listIso<GoalStudioEvent>(this.store, `goals/events/${runId}/`)).map((e) => e.value).filter((e) => e.seq > afterSeq);
    return limit === undefined ? all : all.slice(0, Math.max(0, limit));
  }

  subscribe(runId: GoalRunId, listener: (event: GoalStudioEvent) => void): () => void {
    const emitter = emitterFor(this.store);
    const handler = (e: GoalStudioEvent) => listener(e);
    emitter.on(runId, handler);
    return () => emitter.off(runId, handler);
  }
}
