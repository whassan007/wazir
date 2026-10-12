/**
 * Canary Timeline Explorer — read-only projection of canary history.
 *
 * Sources (never mutated, never authoritative):
 *   1. `canary/events/*` in the durable KeyValueStore (operator actions persisted by
 *      CanaryDeploymentService.recordOperatorAction).
 *   2. Live CanaryEvents observed via CanaryDeploymentService.onEvent during this TUI
 *      session, held in a bounded per-canary ring buffer (automatic transitions,
 *      regressions and rollbacks are emitted but not persisted by the service).
 *   3. The persisted CanaryRecord itself: `startTime` and `rollbackReason` are stored
 *      facts, surfaced only when no matching event exists (e.g. after a restart).
 *
 * Nothing here invents events: every entry maps 1:1 to a stored event or a stored
 * record field, and any detail not present in that source renders as UNKNOWN.
 */
import type { CanaryEvent, CanaryRecord } from '@wazir/core';
import { color } from '../colors.js';
import { stripAnsi, stringDisplayWidth, truncateToDisplayWidth } from './unicode.js';
import type { WhyExplanationData } from './observabilityViews.js';

export const UNKNOWN = 'UNKNOWN';
/** Maximum entries retained/rendered per canary timeline (bounded retrieval). */
export const TIMELINE_MAX_ENTRIES = 200;
/** Live buffer caps: state-changing events vs. high-volume sample events. */
export const LIVE_BUFFER_MAX_EVENTS = 200;
export const LIVE_BUFFER_MAX_SAMPLES = 50;
export const LIVE_BUFFER_MAX_CANARIES = 32;

export type CanaryTimelineFilter = 'ALL' | 'TRANSITIONS' | 'OPERATOR' | 'REGRESSION' | 'SHADOW';
export const CANARY_TIMELINE_FILTERS: CanaryTimelineFilter[] = ['ALL', 'TRANSITIONS', 'OPERATOR', 'REGRESSION', 'SHADOW'];

export interface CanaryGuardEvidence {
  metric: string;
  baselineValue: string;
  canaryValue: string;
  delta: string;
  threshold: string;
  description: string;
}

export interface CanaryTimelineEntry {
  id: string;
  timestamp?: Date;
  eventType: string;
  label: string;
  source: 'store' | 'live' | 'record';
  stage: string;
  previousState: string;
  newState: string;
  allocation: string;
  actor: string;
  reason: string;
  sampleCount: string;
  guardEvidence?: CanaryGuardEvidence;
  relatedIds: string[];
  isOperator: boolean;
  isTransition: boolean;
  isRegression: boolean;
  isShadow: boolean;
}

export interface CanaryTimelineResult {
  canaryId: string;
  entries: CanaryTimelineEntry[];
  /** True when older entries were dropped to respect TIMELINE_MAX_ENTRIES. */
  truncated: boolean;
  totalAvailable: number;
}

type TimelineStore = { list(prefix: string): Promise<Array<{ key: string; value: unknown }>> };

// ---------------------------------------------------------------------------
// Live event buffer (bounded)
// ---------------------------------------------------------------------------

const SAMPLE_TYPES = new Set(['canary.sample.recorded', 'shadow.sample.recorded']);

export class CanaryLiveEventBuffer {
  private readonly events = new Map<string, CanaryEvent[]>();
  private readonly samples = new Map<string, CanaryEvent[]>();

  push(event: CanaryEvent): void {
    if (!event?.canaryId) return;
    const target = SAMPLE_TYPES.has(event.type) ? this.samples : this.events;
    const cap = SAMPLE_TYPES.has(event.type) ? LIVE_BUFFER_MAX_SAMPLES : LIVE_BUFFER_MAX_EVENTS;
    let list = target.get(event.canaryId);
    if (!list) {
      if (target.size >= LIVE_BUFFER_MAX_CANARIES) {
        const oldest = target.keys().next().value;
        if (oldest !== undefined) target.delete(oldest);
      }
      list = [];
      target.set(event.canaryId, list);
    }
    list.push(event);
    if (list.length > cap) list.splice(0, list.length - cap);
  }

  get(canaryId: string): CanaryEvent[] {
    return [...(this.events.get(canaryId) ?? []), ...(this.samples.get(canaryId) ?? [])];
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function str(value: unknown): string {
  if (value === undefined || value === null || value === '') return UNKNOWN;
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toFixed(6))) : UNKNOWN;
  return String(value);
}

function pct(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Number((value * 100).toFixed(2))}%` : UNKNOWN;
}

function guardFrom(src: Record<string, unknown> | undefined, description?: unknown): CanaryGuardEvidence | undefined {
  if (!src || src.metric === undefined) return undefined;
  return {
    metric: str(src.metric),
    baselineValue: str(src.baselineValue),
    canaryValue: str(src.canaryValue),
    delta: str(src.delta),
    threshold: str(src.threshold),
    description: str(description ?? src.description),
  };
}

function operatorLabel(action: string): string {
  if (action === 'pause') return 'PAUSED';
  if (action === 'resume') return 'RESUMED';
  if (action === 'advance') return 'ADVANCED';
  if (action === 'rollback') return 'ROLLBACK';
  if (action.startsWith('throttle')) return 'THROTTLED';
  return action ? action.toUpperCase() : 'OPERATOR_ACTION';
}

export function projectCanaryEvent(event: CanaryEvent, source: 'store' | 'live'): CanaryTimelineEntry {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const base: CanaryTimelineEntry = {
    id: event.id,
    timestamp: toDate(event.timestamp),
    eventType: event.type,
    label: event.type,
    source,
    stage: str(event.stage),
    previousState: UNKNOWN,
    newState: UNKNOWN,
    allocation: pct(event.allocation),
    actor: 'controller:CanaryDeploymentService',
    reason: UNKNOWN,
    sampleCount: UNKNOWN,
    relatedIds: [`candidate:${event.candidateId ?? UNKNOWN}`],
    isOperator: false,
    isTransition: false,
    isRegression: false,
    isShadow: event.stage === 'SHADOW',
  };

  switch (event.type) {
    case 'canary.started':
      base.label = 'STARTED';
      base.newState = str(event.stage);
      base.isTransition = true;
      break;
    case 'canary.stage.entered':
      base.label = str(event.stage);
      base.newState = str(event.stage);
      base.sampleCount = str(data.samplesAtTransition);
      base.isTransition = true;
      break;
    case 'canary.stage.completed':
      base.label = 'STAGE_COMPLETED';
      base.isTransition = true;
      break;
    case 'canary.ready_to_promote':
      base.label = 'READY_TO_PROMOTE';
      base.newState = 'READY_TO_PROMOTE';
      base.sampleCount = str(data.totalSamples);
      base.isTransition = true;
      break;
    case 'canary.sample.recorded':
      base.label = 'SAMPLE';
      base.sampleCount = str(data.totalExecutions);
      base.reason = `variant=${str(data.variant)} task=${str(data.taskSuccess)} verify=${str(data.verificationSuccess)}`;
      break;
    case 'canary.regression.detected': {
      const reason = data.reason as Record<string, unknown> | undefined;
      base.label = 'REGRESSION';
      base.reason = str(reason?.description);
      base.guardEvidence = guardFrom(reason) ?? guardFrom(data);
      base.isRegression = true;
      break;
    }
    case 'canary.rollback.triggered': {
      const operatorOverride = data.metric === 'operator_override';
      base.label = 'ROLLBACK';
      base.newState = 'ROLLED_BACK';
      base.reason = str(data.reason);
      base.guardEvidence = guardFrom(data, data.reason);
      base.actor = operatorOverride ? 'operator (operator_override)' : base.actor;
      base.isOperator = operatorOverride;
      base.isRegression = !operatorOverride;
      base.isTransition = true;
      break;
    }
    case 'canary.operator.action': {
      const action = typeof data.requestedAction === 'string' ? data.requestedAction : '';
      base.label = operatorLabel(action);
      base.previousState = str(data.previousState);
      base.newState = str(data.resultingState);
      base.actor = str(data.source);
      base.reason = action ? `requestedAction=${action}` : UNKNOWN;
      base.isOperator = true;
      base.isTransition = base.previousState !== base.newState || action === 'advance' || action.startsWith('throttle');
      break;
    }
    case 'shadow.started':
      base.label = 'SHADOW_STARTED';
      base.isShadow = true;
      base.isTransition = true;
      break;
    case 'shadow.completed':
      base.label = 'SHADOW_COMPLETED';
      base.isShadow = true;
      base.isTransition = true;
      break;
    case 'shadow.sample.recorded':
      base.label = 'SHADOW_SAMPLE';
      base.isShadow = true;
      break;
    default:
      break;
  }

  for (const key of ['executionId', 'taskId', 'evaluationId', 'runId']) {
    if (typeof data[key] === 'string') base.relatedIds.push(`${key.replace(/Id$/, '')}:${data[key]}`);
  }
  return base;
}

function recordEntries(record: CanaryRecord, events: CanaryTimelineEntry[]): CanaryTimelineEntry[] {
  const out: CanaryTimelineEntry[] = [];
  const blank = (id: string): CanaryTimelineEntry => ({
    id, eventType: 'record', label: '', source: 'record', stage: UNKNOWN, previousState: UNKNOWN,
    newState: UNKNOWN, allocation: UNKNOWN, actor: UNKNOWN, reason: UNKNOWN, sampleCount: UNKNOWN,
    relatedIds: [`candidate:${record.candidateId ?? UNKNOWN}`, ...(record.evidenceIds ?? []).map((e) => `evidence:${e}`)],
    isOperator: false, isTransition: true, isRegression: false, isShadow: false,
  });
  if (!events.some((e) => e.eventType === 'canary.started') && toDate(record.startTime)) {
    out.push({ ...blank(`record:${record.canaryId}:startTime`), timestamp: toDate(record.startTime), eventType: 'record.startTime', label: 'REGISTERED' });
  }
  const rb = record.rollbackReason;
  if (rb && !events.some((e) => e.eventType === 'canary.rollback.triggered')) {
    const override = rb.metric === 'operator_override';
    out.push({
      ...blank(`record:${record.canaryId}:rollbackReason`),
      timestamp: toDate(rb.timestamp) ?? toDate(record.completedAt),
      eventType: 'record.rollbackReason',
      label: 'ROLLBACK',
      newState: str(record.status),
      stage: str(record.stage),
      reason: str(rb.description),
      actor: override ? 'operator (operator_override)' : 'controller:CanaryDeploymentService',
      sampleCount: str(record.canaryMetrics?.totalExecutions),
      guardEvidence: guardFrom(rb as unknown as Record<string, unknown>),
      isOperator: override,
      isRegression: !override,
    });
  }
  return out;
}

/**
 * Loads a bounded, chronologically ordered timeline for one canary.
 * Read-only: only `store.list` and in-memory reads are performed.
 */
export async function loadCanaryTimeline(params: {
  canaryId: string;
  store?: TimelineStore;
  liveEvents?: CanaryEvent[];
  record?: CanaryRecord;
  limit?: number;
}): Promise<CanaryTimelineResult> {
  const limit = Math.max(1, params.limit ?? TIMELINE_MAX_ENTRIES);
  const byId = new Map<string, CanaryTimelineEntry>();

  if (params.store) {
    try {
      const stored = await params.store.list('canary/events/');
      for (const { value } of stored) {
        const ev = value as CanaryEvent;
        if (ev?.canaryId === params.canaryId && ev.id) byId.set(ev.id, projectCanaryEvent(ev, 'store'));
      }
    } catch {
      // Store unavailable: fall back to live events only.
    }
  }
  for (const ev of params.liveEvents ?? []) {
    if (ev?.canaryId === params.canaryId && ev.id && !byId.has(ev.id)) byId.set(ev.id, projectCanaryEvent(ev, 'live'));
  }

  const events = [...byId.values()];
  const all = params.record ? [...events, ...recordEntries(params.record, events)] : events;
  all.sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));

  const truncated = all.length > limit;
  return { canaryId: params.canaryId, entries: truncated ? all.slice(all.length - limit) : all, truncated, totalAvailable: all.length };
}

export function filterTimeline(entries: CanaryTimelineEntry[], filter: CanaryTimelineFilter): CanaryTimelineEntry[] {
  switch (filter) {
    case 'TRANSITIONS': return entries.filter((e) => e.isTransition);
    case 'OPERATOR': return entries.filter((e) => e.isOperator);
    case 'REGRESSION': return entries.filter((e) => e.isRegression || Boolean(e.guardEvidence));
    case 'SHADOW': return entries.filter((e) => e.isShadow);
    default: return entries;
  }
}

// ---------------------------------------------------------------------------
// Why integration
// ---------------------------------------------------------------------------

/** Builds a controller-grounded "why rollback?" explanation from exact stored evidence. */
export function buildCanaryRollbackWhy(entry: CanaryTimelineEntry, canaryId: string, width = 84, maxRows = 24): WhyExplanationData {
  const g = entry.guardEvidence;
  return {
    topic: 'rollback',
    headline: `Canary ${canaryId} rollback`,
    decision: entry.newState === UNKNOWN ? 'ROLLBACK' : entry.newState,
    rationale: [
      g ? g.description : entry.reason,
      entry.isOperator ? 'Rollback requested by operator; no RegressionGuard threshold was evaluated.' : 'RegressionGuard threshold breached (see evidence below).',
    ],
    evidence: [
      { label: 'Timestamp', value: entry.timestamp ? entry.timestamp.toISOString() : UNKNOWN },
      { label: 'Metric', value: g?.metric ?? UNKNOWN },
      { label: 'Baseline Value', value: g?.baselineValue ?? UNKNOWN },
      { label: 'Canary Value', value: g?.canaryValue ?? UNKNOWN },
      { label: 'Delta', value: g?.delta ?? UNKNOWN },
      { label: 'Threshold', value: g?.threshold ?? UNKNOWN },
      { label: 'Stage', value: entry.stage },
      { label: 'Actor', value: entry.actor },
    ],
    controllerAudit: {
      source: `CanaryDeploymentService (${entry.source}:${entry.eventType})`,
      verifiedAt: entry.timestamp ?? UNKNOWN,
      immutableHash: entry.id,
    },
    width,
    maxRows,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface CanaryTimelineViewData {
  canaryId: string;
  entries: CanaryTimelineEntry[];
  filter: CanaryTimelineFilter;
  selectedIndex: number;
  truncated: boolean;
  totalAvailable: number;
  loading?: boolean;
  width: number;
  maxRows: number;
}

function fit(text: string, w: number): string {
  const t = stringDisplayWidth(stripAnsi(text)) > w ? truncateToDisplayWidth(stripAnsi(text), w) : text;
  return t + ' '.repeat(Math.max(0, w - stringDisplayWidth(stripAnsi(t))));
}

function hhmm(d?: Date): string {
  if (!d) return '--:--:--';
  return d.toISOString().slice(11, 19);
}

export function renderCanaryTimelineModal(data: CanaryTimelineViewData): string[] {
  const modalWidth = Math.max(24, Math.min(data.width - 4, 96));
  const inner = modalWidth - 4;
  const border = '─'.repeat(modalWidth - 2);
  const row = (text: string) => `│ ${fit(text, inner)} │`;
  const lines: string[] = [];
  const visible = filterTimeline(data.entries, data.filter);
  const sel = visible.length ? Math.min(Math.max(0, data.selectedIndex), visible.length - 1) : -1;

  lines.push(`┌${border}┐`);
  lines.push(row(color.bold(color.cyan(`CANARY TIMELINE  ${data.canaryId}`))));
  lines.push(row(CANARY_TIMELINE_FILTERS.map((f) => (f === data.filter ? color.bold(`[${f}]`) : color.gray(f))).join(' ')));
  lines.push(`├${border}┤`);

  const detailRows = 11;
  const chrome = lines.length + 3 /* sep + footer + bottom */ + 1 /* status */;
  const listRows = Math.max(1, data.maxRows - chrome - (sel >= 0 ? detailRows + 1 : 0));

  if (data.loading) {
    lines.push(row(color.gray('Loading stored canary events…')));
  } else if (visible.length === 0) {
    lines.push(row(color.gray(data.entries.length === 0 ? 'No stored canary events for this canary.' : `No events match filter ${data.filter}.`)));
  } else {
    const start = Math.max(0, Math.min(sel - Math.floor(listRows / 2), visible.length - listRows));
    for (let i = start; i < Math.min(visible.length, start + listRows); i++) {
      const e = visible[i];
      const note = e.isOperator ? e.actor : e.guardEvidence ? e.guardEvidence.metric : e.reason !== UNKNOWN && !e.label.startsWith('SAMPLE') ? e.reason : '';
      const text = `${i === sel ? '▶' : ' '} ${hhmm(e.timestamp)}  ${e.label.padEnd(18)} ${note === UNKNOWN ? '' : note}`;
      lines.push(row(i === sel ? color.bold(text) : text));
    }
  }
  lines.push(row(color.gray(
    `${visible.length ? sel + 1 : 0}/${visible.length} shown · ${data.totalAvailable} total` +
      (data.truncated ? ` · oldest dropped (cap ${data.entries.length})` : ''),
  )));

  if (sel >= 0) {
    const e = visible[sel];
    const g = e.guardEvidence;
    lines.push(`├${border}┤`);
    const kv = (k: string, v: string) => row(`${color.bold(k.padEnd(14))} ${v}`);
    lines.push(kv('Timestamp', e.timestamp ? e.timestamp.toISOString() : UNKNOWN));
    lines.push(kv('Event', `${e.eventType} (${e.source})`));
    lines.push(kv('Previous', e.previousState));
    lines.push(kv('New', e.newState));
    lines.push(kv('Allocation', e.allocation));
    lines.push(kv('Actor/source', e.actor));
    lines.push(kv('Reason', e.reason));
    lines.push(kv('Samples', e.sampleCount));
    lines.push(kv('Guard', g ? `${g.metric} base=${g.baselineValue} canary=${g.canaryValue} Δ=${g.delta} thr=${g.threshold}` : UNKNOWN));
    lines.push(kv('Related ids', e.relatedIds.length ? e.relatedIds.join(', ') : UNKNOWN));
    lines.push(kv('Stage', e.stage));
  }

  lines.push(`├${border}┤`);
  lines.push(row(color.gray('[↑↓/jk] select  [f] filter  [w] why  [Esc] close  · read-only')));
  lines.push(`└${border}┘`);
  return lines.slice(0, Math.max(1, data.maxRows));
}

/** The stored rollback of a record as a timeline entry (undefined when the record has no rollbackReason). */
export function rollbackEntryFromRecord(record: CanaryRecord): CanaryTimelineEntry | undefined {
  return recordEntries(record, []).find((e) => e.eventType === 'record.rollbackReason');
}
