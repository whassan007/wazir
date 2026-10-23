import { injectFault, type KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  type GoalEventLog,
  type GoalRunId,
  type GoalStudioDeps,
  type GoalStudioEvent,
} from '../contracts.js';
import { atomicUpdate, plain } from './atomic.js';

/**
 * Durable, gap-free Goal Studio event log (persistence for workstream 07's SSE routes).
 *
 *   goals/event-heads/<runId>         EventHead: last allocated seq + the most recent events.
 *   goals/events/<runId>/<seq>        one GoalStudioEvent per key (GOAL_STORE_KEYS.event).
 *
 * `seq` is allocated by an atomic update of the head, so it is strictly monotonic per
 * run across every process sharing the store. The event is written into the head's
 * `recent` window in that same update, then materialised to its own key; a crash in
 * between leaves it readable from the head (and the next append materialises it), so
 * a reconnecting client replaying `?after=<seq>` never sees a gap.
 *
 * Events without a runId (graph/prompt revisions) go to the `_global` stream.
 */

export const GLOBAL_EVENT_STREAM = '_global';
const RECENT_WINDOW = 64;
const DEFAULT_READ_LIMIT = 1_000;

export function eventHeadKey(runId: GoalRunId): string {
  return `goals/event-heads/${runId}`;
}

interface EventHead {
  v: number;
  runId: GoalRunId;
  seq: number;
  recent: GoalStudioEvent[];
}

export interface GoalEventLogOptions {
  /**
   * How often subscribers poll the store for events appended by other processes.
   * In-process appends are delivered immediately regardless. 0 disables polling.
   * Default 1000ms.
   */
  pollIntervalMs?: number;
}

export interface DurableGoalEventLog extends GoalEventLog {
  /** Like `subscribe`, but first delivers every stored event with `seq > afterSeq` (gap-free resume). */
  subscribeFrom(runId: GoalRunId, afterSeq: number, listener: (event: GoalStudioEvent) => void): () => void;
  /** Last allocated seq for a run (0 when it has no events). */
  head(runId: GoalRunId): Promise<number>;
  /** Stops every subscription and poll timer. */
  close(): void;
}

interface Subscription {
  runId: GoalRunId;
  listener: (event: GoalStudioEvent) => void;
  /** Highest seq delivered (or deliberately skipped). Undefined until initialised. */
  lastSeq?: number;
  /** Events appended in this process before the subscription finished initialising. */
  early: number[];
  draining: boolean;
  again: boolean;
  closed: boolean;
}

class GoalEventLogImpl implements DurableGoalEventLog {
  private readonly store: KeyValueStore;
  private readonly clock: () => Date;
  private readonly pollIntervalMs: number;
  private readonly subs = new Map<GoalRunId, Set<Subscription>>();
  private readonly timers = new Map<GoalRunId, NodeJS.Timeout>();

  constructor(deps: GoalStudioDeps, options: GoalEventLogOptions = {}) {
    if (!deps?.store) throw new GoalStudioFailure('INTERNAL', 'createGoalEventLog requires deps.store');
    this.store = deps.store;
    this.clock = deps.clock ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  async append(input: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { timestamp?: string }): Promise<GoalStudioEvent> {
    if (!input?.type) throw new GoalStudioFailure('VALIDATION', 'event requires a type');
    const stream = input.runId ?? GLOBAL_EVENT_STREAM;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(stream)) throw new GoalStudioFailure('VALIDATION', `invalid run id '${stream}'`);
    const base = plain({ ...input, data: input.data ?? {}, timestamp: input.timestamp ?? this.clock().toISOString() });

    // Materialise anything a crashed appender left only in the head, before it can
    // slide out of the recent window.
    const before = await this.readHead(stream);
    if (before) await this.materialise(stream, before.recent);

    let event!: GoalStudioEvent;
    await atomicUpdate<EventHead>(this.store, eventHeadKey(stream), (current) => {
      const head = current ?? { v: 1, runId: stream, seq: 0, recent: [] };
      event = { ...base, seq: head.seq + 1 } as GoalStudioEvent;
      return { ...head, seq: event.seq, recent: [...head.recent, event].slice(-RECENT_WINDOW) };
    });
    const key = GOAL_STORE_KEYS.event(stream, event.seq);
    await injectFault('DURING_EVENT_PERSIST', { key, runId: stream, seq: event.seq });
    await this.store.put(key, event).catch(() => undefined); // still readable from the head
    this.notify(stream, event.seq);
    return plain(event);
  }

  async read(runId: GoalRunId, afterSeq = 0, limit = DEFAULT_READ_LIMIT): Promise<GoalStudioEvent[]> {
    const stream = runId ?? GLOBAL_EVENT_STREAM;
    const after = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LIMIT;
    const head = await this.readHead(stream);
    if (!head) return [];
    const bySeq = new Map<number, GoalStudioEvent>();
    for (const { value } of await this.store.list(`goals/events/${stream}/`)) {
      const event = plain(value as GoalStudioEvent);
      if (event && Number.isSafeInteger(event.seq)) bySeq.set(event.seq, event);
    }
    for (const event of head.recent) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
    return [...bySeq.values()]
      .filter((e) => e.seq > after && e.seq <= head.seq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, max);
  }

  async head(runId: GoalRunId): Promise<number> {
    return (await this.readHead(runId ?? GLOBAL_EVENT_STREAM))?.seq ?? 0;
  }

  subscribe(runId: GoalRunId, listener: (event: GoalStudioEvent) => void): () => void {
    return this.addSubscription(runId ?? GLOBAL_EVENT_STREAM, listener, undefined);
  }

  subscribeFrom(runId: GoalRunId, afterSeq: number, listener: (event: GoalStudioEvent) => void): () => void {
    return this.addSubscription(runId ?? GLOBAL_EVENT_STREAM, listener, Math.max(0, Math.floor(afterSeq || 0)));
  }

  close(): void {
    for (const set of this.subs.values()) for (const sub of set) sub.closed = true;
    this.subs.clear();
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private addSubscription(stream: GoalRunId, listener: (event: GoalStudioEvent) => void, afterSeq: number | undefined): () => void {
    const sub: Subscription = { runId: stream, listener, lastSeq: afterSeq, early: [], draining: false, again: false, closed: false };
    let set = this.subs.get(stream);
    if (!set) {
      set = new Set();
      this.subs.set(stream, set);
    }
    set.add(sub);
    if (sub.lastSeq === undefined) {
      // Deliver only events appended after this call: start from the current head,
      // minus any in-process appends that raced the head read.
      void this.readHead(stream).then((head) => {
        const earliest = sub.early.length ? Math.min(...sub.early) - 1 : Infinity;
        sub.lastSeq = Math.min(head?.seq ?? 0, earliest);
        this.drain(sub);
      }, () => {
        sub.lastSeq = 0;
        this.drain(sub);
      });
    } else {
      this.drain(sub);
    }
    if (this.pollIntervalMs > 0 && !this.timers.has(stream)) {
      const timer = setInterval(() => {
        for (const s of this.subs.get(stream) ?? []) this.drain(s);
      }, this.pollIntervalMs);
      timer.unref?.();
      this.timers.set(stream, timer);
    }
    return () => {
      sub.closed = true;
      const current = this.subs.get(stream);
      current?.delete(sub);
      if (current && current.size === 0) {
        this.subs.delete(stream);
        const timer = this.timers.get(stream);
        if (timer) clearInterval(timer);
        this.timers.delete(stream);
      }
    };
  }

  private notify(stream: GoalRunId, seq: number): void {
    for (const sub of this.subs.get(stream) ?? []) {
      if (sub.lastSeq === undefined) sub.early.push(seq);
      else if (seq > sub.lastSeq) this.drain(sub);
    }
  }

  /** Delivers every stored event after `sub.lastSeq`, in seq order, exactly once. */
  private drain(sub: Subscription): void {
    if (sub.closed || sub.lastSeq === undefined) return;
    if (sub.draining) {
      sub.again = true;
      return;
    }
    sub.draining = true;
    void (async () => {
      try {
        do {
          sub.again = false;
          const events = await this.read(sub.runId, sub.lastSeq);
          for (const event of events) {
            if (sub.closed) return;
            if (event.seq <= (sub.lastSeq ?? 0)) continue;
            sub.lastSeq = event.seq;
            try {
              sub.listener(event);
            } catch {
              // A failing listener must not stop delivery to itself or others.
            }
          }
        } while (sub.again && !sub.closed);
      } catch {
        // Transient store read failure: the next append or poll retries.
      } finally {
        sub.draining = false;
      }
    })();
  }

  private async readHead(stream: GoalRunId): Promise<EventHead | undefined> {
    return plain(await this.store.get<EventHead>(eventHeadKey(stream)));
  }

  private async materialise(stream: GoalRunId, events: GoalStudioEvent[]): Promise<void> {
    for (const event of events) {
      const key = GOAL_STORE_KEYS.event(stream, event.seq);
      if (await this.store.get(key)) continue;
      await this.store.put(key, event);
    }
  }
}

export function createGoalEventLog(deps: GoalStudioDeps, options: GoalEventLogOptions = {}): DurableGoalEventLog {
  return new GoalEventLogImpl(deps, options);
}

export function createEventLog(deps: GoalStudioDeps, options: GoalEventLogOptions = {}): DurableGoalEventLog {
  return createGoalEventLog(deps, options);
}
