import { randomUUID } from 'node:crypto';

export type SessionEventKind =
  | 'session_started'
  | 'brain_attached'
  | 'brain_detached'
  | 'hand_provisioned'
  | 'hand_disposed'
  | 'user_prompt'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'checkpoint'
  | 'session_completed'
  | 'session_failed';

export interface SessionLogEvent {
  seq: number;
  eventId: string;
  sessionId: string;
  kind: SessionEventKind;
  timestamp: string;
  brainId?: string;
  handId?: string;
  payload: Record<string, unknown>;
}

export interface SessionWakeSnapshot {
  sessionId: string;
  lastSeq: number;
  activeBrainId?: string;
  activeHandId?: string;
  events: SessionLogEvent[];
  recoveredAt: string;
}

/**
 * Externalized, append-only Session Event Log decoupling stateless "Brain"
 * reasoning loops from disposable "Hands" execution environments
 * (Anthropic Managed Agents pattern).
 *
 * Supports positional slicing (`getEvents(sessionId, fromSeq)`) and stateless
 * crash recovery / cross-brain handoff via `wake(sessionId, newBrainId)`.
 */
export class SessionEventLog {
  private readonly streams = new Map<string, SessionLogEvent[]>();

  emitEvent(
    sessionId: string,
    kind: SessionEventKind,
    payload: Record<string, unknown> = {},
    meta?: { brainId?: string; handId?: string },
  ): SessionLogEvent {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = [];
      this.streams.set(sessionId, stream);
    }
    const event: SessionLogEvent = {
      seq: stream.length + 1,
      eventId: `sev-${randomUUID()}`,
      sessionId,
      kind,
      timestamp: new Date().toISOString(),
      ...(meta?.brainId ? { brainId: meta.brainId } : {}),
      ...(meta?.handId ? { handId: meta.handId } : {}),
      payload,
    };
    stream.push(event);
    return event;
  }

  /**
   * Returns events strictly after `afterSeq` (positional slice, 0-based).
   */
  getEvents(sessionId: string, afterSeq = 0, limit?: number): SessionLogEvent[] {
    const stream = this.streams.get(sessionId) ?? [];
    const sliced = afterSeq > 0 ? stream.filter((e) => e.seq > afterSeq) : [...stream];
    return limit !== undefined && limit >= 0 ? sliced.slice(0, limit) : sliced;
  }

  /**
   * Wakes a session onto a stateless brain (new or resumed), recording
   * `brain_attached` and returning the full positional event state.
   */
  wake(sessionId: string, brainId: string): SessionWakeSnapshot {
    const existing = this.getEvents(sessionId);
    let activeHandId: string | undefined;
    for (const ev of existing) {
      if (ev.kind === 'hand_provisioned' && ev.handId) activeHandId = ev.handId;
      if (ev.kind === 'hand_disposed' && ev.handId === activeHandId) activeHandId = undefined;
    }

    const attached = this.emitEvent(sessionId, 'brain_attached', { previousSeq: existing.length }, { brainId, handId: activeHandId });
    return {
      sessionId,
      lastSeq: attached.seq,
      activeBrainId: brainId,
      activeHandId,
      events: [...existing, attached],
      recoveredAt: attached.timestamp,
    };
  }
}
