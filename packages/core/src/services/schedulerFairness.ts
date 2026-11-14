/**
 * Bounded, fair, starvation-free task scheduler queue.
 *
 * - Admission is bounded globally and per tenant / per job; overflow is
 *   rejected with a structured {@link SchedulerQueueFullError} so callers can
 *   apply backpressure instead of growing memory without limit.
 * - Each task's effective priority ages linearly with wait time, so a
 *   continuous stream of high-priority work can delay — but never starve —
 *   low-priority tasks.
 * - Dispatch picks a job first, penalising jobs by their in-flight and
 *   recently-dispatched load, so one large job cannot monopolise every worker
 *   slot while other jobs have runnable tasks.
 */

export type SchedulerPriorityLevel = 'critical' | 'high' | 'normal' | 'low';
export type SchedulerPriority = SchedulerPriorityLevel | number;

export const SCHEDULER_PRIORITY_WEIGHTS: Readonly<Record<SchedulerPriorityLevel, number>> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
};

export type SchedulerQueueFullCode = 'QUEUE_CAPACITY_EXCEEDED' | 'TENANT_QUOTA_EXCEEDED';

export class SchedulerQueueFullError extends Error {
  readonly code: SchedulerQueueFullCode;
  /** Which limit tripped: the whole queue, a tenant, or a job. */
  readonly scope: 'queue' | 'tenant' | 'job';
  /** Tenant or job id for scoped limits; undefined for the global limit. */
  readonly key: string | undefined;
  readonly limit: number;

  constructor(code: SchedulerQueueFullCode, scope: 'queue' | 'tenant' | 'job', limit: number, key?: string) {
    super(
      scope === 'queue'
        ? `Scheduler queue is full (limit ${limit})`
        : `Scheduler ${scope} '${key}' exceeded its queue quota (limit ${limit})`,
    );
    this.name = 'SchedulerQueueFullError';
    this.code = code;
    this.scope = scope;
    this.key = key;
    this.limit = limit;
  }
}

export interface FairSchedulerQueueOptions {
  /** Maximum queued (not yet dispatched) tasks across all jobs. Default 500. */
  maxQueueSize?: number;
  /** Maximum queued tasks per tenant. Default 50. */
  maxPerTenantQueueSize?: number;
  /** Maximum queued tasks per job. Default 50. */
  maxPerJobQueueSize?: number;
  /** Effective-priority points gained per second of waiting. Default 1. */
  agingRatePerSec?: number;
  /**
   * Effective-priority points subtracted from a job's best task per unit of
   * load (in-flight + weighted recent dispatches), divided by the job weight.
   * Default 25 — one priority tier per in-flight task.
   */
  fairnessPenaltyPerSlot?: number;
  /** Window over which dispatches count as "recent". Default 5000ms. */
  recentDispatchWindowMs?: number;
  /** Load contributed by each recent dispatch, on top of in-flight. Default 0.5. */
  recentDispatchWeight?: number;
  /**
   * Hard cap on concurrently in-flight tasks per job. A job at its cap is
   * skipped while any other job has runnable tasks. Default Infinity.
   */
  maxInFlightPerJob?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface SchedulerEnqueueInput<T> {
  id?: string;
  jobId: string;
  /** Tenant for quota accounting; defaults to the job id. */
  tenantId?: string;
  priority?: SchedulerPriority;
  /** Relative share for this task's job (higher = tolerates more load). Default 1. */
  jobWeight?: number;
  payload: T;
}

export interface SchedulerTask<T> {
  readonly id: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly priority: SchedulerPriority;
  readonly basePriority: number;
  readonly enqueuedAtMs: number;
  readonly payload: T;
}

export interface SchedulerDispatch<T> extends SchedulerTask<T> {
  readonly dispatchedAtMs: number;
  readonly waitMs: number;
  readonly effectivePriority: number;
  /** True when aging let this task overtake a queued task of higher base priority. */
  readonly agedPromotion: boolean;
}

export interface SchedulerQueueMetrics {
  depth: number;
  inFlight: number;
  byPriority: Record<SchedulerPriorityLevel, number>;
  oldestWaitMs: number;
  totalAdmitted: number;
  totalRejected: number;
  totalDispatched: number;
  totalCompleted: number;
  agedPromotions: number;
  rejectedByCode: Record<SchedulerQueueFullCode, number>;
  queuedByJob: Record<string, number>;
  inFlightByJob: Record<string, number>;
}

interface QueuedEntry<T> extends SchedulerTask<T> {
  /** Time-invariant ordering key: basePriority - agingRate * enqueuedSec. */
  readonly sortKey: number;
  readonly seq: number;
}

interface JobState<T> {
  /** Queued entries sorted by sortKey desc, then seq asc. */
  queue: QueuedEntry<T>[];
  inFlight: number;
  recentDispatches: number[];
  weight: number;
}

export function resolveSchedulerPriority(priority: SchedulerPriority | undefined): number {
  if (priority === undefined) return SCHEDULER_PRIORITY_WEIGHTS.normal;
  if (typeof priority === 'number') {
    if (!Number.isFinite(priority)) throw new RangeError(`Invalid scheduler priority: ${priority}`);
    return priority;
  }
  const weight = SCHEDULER_PRIORITY_WEIGHTS[priority];
  if (weight === undefined) throw new RangeError(`Unknown scheduler priority: ${String(priority)}`);
  return weight;
}

export function classifySchedulerPriority(weight: number): SchedulerPriorityLevel {
  if (weight >= SCHEDULER_PRIORITY_WEIGHTS.critical) return 'critical';
  if (weight >= SCHEDULER_PRIORITY_WEIGHTS.high) return 'high';
  if (weight >= SCHEDULER_PRIORITY_WEIGHTS.normal) return 'normal';
  return 'low';
}

export class FairSchedulerQueue<T> {
  private readonly maxQueueSize: number;
  private readonly maxPerTenantQueueSize: number;
  private readonly maxPerJobQueueSize: number;
  private readonly agingRatePerSec: number;
  private readonly fairnessPenaltyPerSlot: number;
  private readonly recentDispatchWindowMs: number;
  private readonly recentDispatchWeight: number;
  private readonly maxInFlightPerJob: number;
  private readonly now: () => number;

  private readonly jobs = new Map<string, JobState<T>>();
  private readonly queuedByTenant = new Map<string, number>();
  private readonly inFlightTasks = new Map<string, SchedulerDispatch<T>>();
  private readonly queuedIds = new Map<string, string>();
  private depth = 0;
  private seq = 0;
  private totalAdmitted = 0;
  private totalRejected = 0;
  private totalDispatched = 0;
  private totalCompleted = 0;
  private agedPromotions = 0;
  private readonly rejectedByCode: Record<SchedulerQueueFullCode, number> = {
    QUEUE_CAPACITY_EXCEEDED: 0,
    TENANT_QUOTA_EXCEEDED: 0,
  };

  constructor(options: FairSchedulerQueueOptions = {}) {
    this.maxQueueSize = positiveLimit(options.maxQueueSize, 500, 'maxQueueSize');
    this.maxPerTenantQueueSize = positiveLimit(options.maxPerTenantQueueSize, 50, 'maxPerTenantQueueSize');
    this.maxPerJobQueueSize = positiveLimit(options.maxPerJobQueueSize, 50, 'maxPerJobQueueSize');
    this.agingRatePerSec = nonNegative(options.agingRatePerSec, 1, 'agingRatePerSec');
    this.fairnessPenaltyPerSlot = nonNegative(options.fairnessPenaltyPerSlot, 25, 'fairnessPenaltyPerSlot');
    this.recentDispatchWindowMs = nonNegative(options.recentDispatchWindowMs, 5000, 'recentDispatchWindowMs');
    this.recentDispatchWeight = nonNegative(options.recentDispatchWeight, 0.5, 'recentDispatchWeight');
    this.maxInFlightPerJob = positiveLimit(options.maxInFlightPerJob, Infinity, 'maxInFlightPerJob');
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.depth;
  }

  get inFlightCount(): number {
    return this.inFlightTasks.size;
  }

  /** Returns the rejection that admitting a task would produce, or null. */
  checkAdmission(jobId: string, tenantId: string = jobId): SchedulerQueueFullError | null {
    if (this.depth >= this.maxQueueSize) {
      return new SchedulerQueueFullError('QUEUE_CAPACITY_EXCEEDED', 'queue', this.maxQueueSize);
    }
    if ((this.queuedByTenant.get(tenantId) ?? 0) >= this.maxPerTenantQueueSize) {
      return new SchedulerQueueFullError('TENANT_QUOTA_EXCEEDED', 'tenant', this.maxPerTenantQueueSize, tenantId);
    }
    if ((this.jobs.get(jobId)?.queue.length ?? 0) >= this.maxPerJobQueueSize) {
      return new SchedulerQueueFullError('TENANT_QUOTA_EXCEEDED', 'job', this.maxPerJobQueueSize, jobId);
    }
    return null;
  }

  /** Admits a task or throws {@link SchedulerQueueFullError}. */
  enqueue(input: SchedulerEnqueueInput<T>): SchedulerTask<T> {
    const tenantId = input.tenantId ?? input.jobId;
    const basePriority = resolveSchedulerPriority(input.priority);
    const rejection = this.checkAdmission(input.jobId, tenantId);
    if (rejection) {
      this.totalRejected++;
      this.rejectedByCode[rejection.code]++;
      throw rejection;
    }

    const seq = ++this.seq;
    const id = input.id ?? `sched-${seq}`;
    if (this.queuedIds.has(id) || this.inFlightTasks.has(id)) {
      throw new Error(`Scheduler task '${id}' is already queued or in flight`);
    }

    const enqueuedAtMs = this.now();
    const entry: QueuedEntry<T> = {
      id,
      jobId: input.jobId,
      tenantId,
      priority: input.priority ?? 'normal',
      basePriority,
      enqueuedAtMs,
      payload: input.payload,
      sortKey: basePriority - (this.agingRatePerSec * enqueuedAtMs) / 1000,
      seq,
    };

    const job = this.getOrCreateJob(input.jobId);
    if (input.jobWeight !== undefined) {
      if (!(input.jobWeight > 0) || !Number.isFinite(input.jobWeight)) {
        throw new RangeError(`Invalid jobWeight: ${input.jobWeight}`);
      }
      job.weight = input.jobWeight;
    }
    insertSorted(job.queue, entry);
    this.queuedIds.set(id, input.jobId);
    this.queuedByTenant.set(tenantId, (this.queuedByTenant.get(tenantId) ?? 0) + 1);
    this.depth++;
    this.totalAdmitted++;
    return publicTask(entry);
  }

  /** Non-throwing variant of {@link enqueue}. */
  tryEnqueue(
    input: SchedulerEnqueueInput<T>,
  ): { ok: true; task: SchedulerTask<T> } | { ok: false; error: SchedulerQueueFullError } {
    try {
      return { ok: true, task: this.enqueue(input) };
    } catch (error) {
      if (error instanceof SchedulerQueueFullError) return { ok: false, error };
      throw error;
    }
  }

  /**
   * Removes and returns the next task to run, marking it in flight until
   * {@link complete} is called. Returns undefined when nothing is queued.
   */
  dequeue(): SchedulerDispatch<T> | undefined {
    if (this.depth === 0) return undefined;
    const now = this.now();

    let best: { job: JobState<T>; score: number; head: QueuedEntry<T> } | undefined;
    let bestCapped: typeof best;
    for (const job of this.jobs.values()) {
      const head = job.queue[0];
      if (!head) continue;
      this.pruneRecent(job, now);
      const load = job.inFlight + this.recentDispatchWeight * job.recentDispatches.length;
      const score = this.effectivePriority(head, now) - (this.fairnessPenaltyPerSlot * load) / job.weight;
      const candidate = { job, score, head };
      if (job.inFlight >= this.maxInFlightPerJob) {
        if (!bestCapped || beats(candidate, bestCapped)) bestCapped = candidate;
      } else if (!best || beats(candidate, best)) {
        best = candidate;
      }
    }
    const chosen = best ?? bestCapped;
    if (!chosen) return undefined;

    const { job, head } = chosen;
    job.queue.shift();
    const agedPromotion = this.overtookHigherBase(head);
    if (agedPromotion) this.agedPromotions++;

    this.queuedIds.delete(head.id);
    this.decrementTenant(head.tenantId);
    this.depth--;
    job.inFlight++;
    job.recentDispatches.push(now);
    this.totalDispatched++;

    const dispatch: SchedulerDispatch<T> = {
      ...publicTask(head),
      dispatchedAtMs: now,
      waitMs: now - head.enqueuedAtMs,
      effectivePriority: this.effectivePriority(head, now),
      agedPromotion,
    };
    this.inFlightTasks.set(head.id, dispatch);
    return dispatch;
  }

  /** Releases a dispatched task's in-flight slot. Returns false if unknown. */
  complete(taskId: string): boolean {
    const dispatch = this.inFlightTasks.get(taskId);
    if (!dispatch) return false;
    this.inFlightTasks.delete(taskId);
    const job = this.jobs.get(dispatch.jobId);
    if (job) {
      job.inFlight--;
      this.maybeDropJob(dispatch.jobId, job);
    }
    this.totalCompleted++;
    return true;
  }

  /** Cancels a queued (not yet dispatched) task. Returns false if not queued. */
  remove(taskId: string): boolean {
    const jobId = this.queuedIds.get(taskId);
    if (jobId === undefined) return false;
    const job = this.jobs.get(jobId)!;
    const index = job.queue.findIndex((entry) => entry.id === taskId);
    const [entry] = job.queue.splice(index, 1);
    this.queuedIds.delete(taskId);
    this.decrementTenant(entry.tenantId);
    this.depth--;
    this.maybeDropJob(jobId, job);
    return true;
  }

  /** Current effective priority of a queued task, or undefined if not queued. */
  getEffectivePriority(taskId: string): number | undefined {
    const jobId = this.queuedIds.get(taskId);
    if (jobId === undefined) return undefined;
    const entry = this.jobs.get(jobId)!.queue.find((candidate) => candidate.id === taskId);
    return entry ? this.effectivePriority(entry, this.now()) : undefined;
  }

  getMetrics(): SchedulerQueueMetrics {
    const now = this.now();
    const byPriority: Record<SchedulerPriorityLevel, number> = { critical: 0, high: 0, normal: 0, low: 0 };
    const queuedByJob: Record<string, number> = {};
    const inFlightByJob: Record<string, number> = {};
    let oldestEnqueuedAtMs = Infinity;
    for (const [jobId, job] of this.jobs) {
      if (job.queue.length > 0) queuedByJob[jobId] = job.queue.length;
      if (job.inFlight > 0) inFlightByJob[jobId] = job.inFlight;
      for (const entry of job.queue) {
        byPriority[classifySchedulerPriority(entry.basePriority)]++;
        if (entry.enqueuedAtMs < oldestEnqueuedAtMs) oldestEnqueuedAtMs = entry.enqueuedAtMs;
      }
    }
    return {
      depth: this.depth,
      inFlight: this.inFlightTasks.size,
      byPriority,
      oldestWaitMs: oldestEnqueuedAtMs === Infinity ? 0 : Math.max(0, now - oldestEnqueuedAtMs),
      totalAdmitted: this.totalAdmitted,
      totalRejected: this.totalRejected,
      totalDispatched: this.totalDispatched,
      totalCompleted: this.totalCompleted,
      agedPromotions: this.agedPromotions,
      rejectedByCode: { ...this.rejectedByCode },
      queuedByJob,
      inFlightByJob,
    };
  }

  private effectivePriority(entry: QueuedEntry<T>, now: number): number {
    return entry.basePriority + (this.agingRatePerSec * Math.max(0, now - entry.enqueuedAtMs)) / 1000;
  }

  /**
   * True when a still-queued task has a higher base priority yet no greater
   * effective priority than the dispatched one — i.e. aging, not base
   * priority, decided the order.
   */
  private overtookHigherBase(dispatched: QueuedEntry<T>): boolean {
    for (const job of this.jobs.values()) {
      for (const entry of job.queue) {
        if (entry.basePriority > dispatched.basePriority && entry.sortKey <= dispatched.sortKey) return true;
      }
    }
    return false;
  }

  private pruneRecent(job: JobState<T>, now: number): void {
    const cutoff = now - this.recentDispatchWindowMs;
    let drop = 0;
    while (drop < job.recentDispatches.length && job.recentDispatches[drop] <= cutoff) drop++;
    if (drop > 0) job.recentDispatches.splice(0, drop);
  }

  private getOrCreateJob(jobId: string): JobState<T> {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = { queue: [], inFlight: 0, recentDispatches: [], weight: 1 };
      this.jobs.set(jobId, job);
    }
    return job;
  }

  private maybeDropJob(jobId: string, job: JobState<T>): void {
    if (job.queue.length > 0 || job.inFlight > 0) return;
    this.pruneRecent(job, this.now());
    if (job.recentDispatches.length === 0) this.jobs.delete(jobId);
  }

  private decrementTenant(tenantId: string): void {
    const remaining = (this.queuedByTenant.get(tenantId) ?? 1) - 1;
    if (remaining <= 0) this.queuedByTenant.delete(tenantId);
    else this.queuedByTenant.set(tenantId, remaining);
  }
}

function beats<T>(
  a: { score: number; head: QueuedEntry<T> },
  b: { score: number; head: QueuedEntry<T> },
): boolean {
  if (a.score !== b.score) return a.score > b.score;
  return a.head.seq < b.head.seq;
}

function insertSorted<T>(queue: QueuedEntry<T>[], entry: QueuedEntry<T>): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = queue[mid];
    const before = other.sortKey > entry.sortKey || (other.sortKey === entry.sortKey && other.seq < entry.seq);
    if (before) lo = mid + 1;
    else hi = mid;
  }
  queue.splice(lo, 0, entry);
}

function publicTask<T>(entry: QueuedEntry<T>): SchedulerTask<T> {
  return {
    id: entry.id,
    jobId: entry.jobId,
    tenantId: entry.tenantId,
    priority: entry.priority,
    basePriority: entry.basePriority,
    enqueuedAtMs: entry.enqueuedAtMs,
    payload: entry.payload,
  };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!(value >= 1)) throw new RangeError(`${name} must be >= 1, got ${value}`);
  return value;
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number >= 0`);
  return value;
}
