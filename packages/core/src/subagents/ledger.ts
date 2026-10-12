/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import { stripControlSequences, tailSlice } from '../permissions/adaptorUtils.js';
import {
  MAX_SUBAGENT_TASKS,
  MAX_SUBAGENTS_SNAPSHOT_BYTES,
  type SubagentFilter,
  type SubagentStatus,
  type SubagentTask,
  type SubagentsSnapshot,
} from './types.js';

const TERMINAL = new Set<SubagentStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const OUTPUT_CHARS = 16_384;
const MAX_TERMINAL_DETAILS = 32;

function clean(value: string, max: number): string {
  const text = stripControlSequences(value);
  return text.length > max ? tailSlice(text, max) : text;
}

export class SubagentsLedger {
  private readonly states = new Map<string, SubagentStatus>();
  private readonly monitors = new Set<string>();
  private readonly details = new Map<string, SubagentTask>();
  private revision = 0;
  private readonly archived: SubagentsSnapshot['counts'] = {
    running: 0,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly onChange?: (snapshot: SubagentsSnapshot) => void,
  ) {}

  upsert(
    value: Omit<SubagentTask, 'activity' | 'output' | 'events'> &
      Partial<Pick<SubagentTask, 'activity' | 'output' | 'events'>>,
  ): void {
    if (this.closed) return;
    const previous = this.details.get(value.id);
    const previousState = this.states.get(value.id);

    // Terminal-only replay after detail eviction must not count it again
    if (!previousState && TERMINAL.has(value.status)) return;
    if (
      previousState &&
      previousState !== value.status &&
      TERMINAL.has(previousState) &&
      (previousState !== 'interrupted' || !TERMINAL.has(value.status))
    ) {
      return;
    }

    const task: SubagentTask = {
      activity: '',
      output: '',
      events: [],
      ...previous,
      ...value,
      title: clean(value.title, 240),
      request: clean(value.request, 4096),
    };

    if (task.backend) task.backend = clean(task.backend, 256);
    if (task.sessionId) task.sessionId = clean(task.sessionId, 256);
    if (task.source) task.source = clean(task.source, 256);
    task.activity = clean(task.activity, 1024);
    if (task.output.length > OUTPUT_CHARS) task.outputTruncated = true;
    task.output = clean(task.output, OUTPUT_CHARS);

    if (
      task.outputMessage !== undefined &&
      (typeof task.outputMessage !== 'string' || task.outputMessage.length > 512)
    ) {
      delete task.outputMessage;
    }

    task.events = task.events.slice(-24).map((event) => ({
      ...event,
      text: clean(event.text, 1024),
    }));

    this.states.set(task.id, task.status);
    if (task.kind === 'proactive' && task.source !== 'timer') {
      this.monitors.add(task.id);
    }
    this.details.set(task.id, task);

    // Evict oldest terminal tasks beyond MAX_TERMINAL_DETAILS
    const terminalIds: string[] = [];
    for (const [id, state] of this.states) {
      if (TERMINAL.has(state)) terminalIds.push(id);
    }
    if (terminalIds.length > MAX_TERMINAL_DETAILS) {
      const oldestId = terminalIds[0];
      const oldestState = this.states.get(oldestId);
      if (oldestState === 'completed') this.archived.completed += 1;
      else if (oldestState === 'failed') this.archived.failed += 1;
      else if (oldestState === 'cancelled') this.archived.cancelled += 1;
      else if (oldestState === 'interrupted') this.archived.interrupted += 1;
      this.states.delete(oldestId);
      this.details.delete(oldestId);
      this.monitors.delete(oldestId);
    }

    this.bumpRevision();
  }

  get(id: string): SubagentTask | undefined {
    return this.details.get(id);
  }

  list(filter: SubagentFilter = 'all', limit = MAX_SUBAGENT_TASKS): SubagentTask[] {
    const list: SubagentTask[] = [];
    for (const task of this.details.values()) {
      if (this.matchesFilter(task, filter)) {
        list.push(task);
        if (list.length >= limit) break;
      }
    }
    return list;
  }

  snapshot(): SubagentsSnapshot {
    const counts = {
      running: this.archived.running,
      completed: this.archived.completed,
      needsAttention: this.archived.needsAttention,
      failed: this.archived.failed,
      cancelled: this.archived.cancelled,
      interrupted: this.archived.interrupted,
    };

    const tasks: SubagentTask[] = [];
    let omitted = 0;

    for (const task of this.details.values()) {
      if (task.status === 'running' || task.status === 'starting' || task.status === 'monitoring') {
        counts.running += 1;
      } else if (task.status === 'completed') {
        counts.completed += 1;
      } else if (task.status === 'failed') {
        counts.failed += 1;
      } else if (task.status === 'cancelled') {
        counts.cancelled += 1;
      } else if (task.status === 'interrupted') {
        counts.interrupted += 1;
      }

      if (task.status === 'waiting' || (task.permissions && task.permissions.length > 0)) {
        counts.needsAttention += 1;
      }

      if (tasks.length < MAX_SUBAGENT_TASKS) {
        tasks.push(task);
      } else {
        omitted += 1;
      }
    }

    return {
      revision: this.revision,
      counts,
      tasks,
      omitted,
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private matchesFilter(task: SubagentTask, filter: SubagentFilter): boolean {
    if (filter === 'all') return true;
    if (filter === 'running') {
      return task.status === 'running' || task.status === 'starting' || task.status === 'monitoring';
    }
    if (filter === 'completed') return task.status === 'completed';
    if (filter === 'needsAttention') {
      return task.status === 'waiting' || (task.permissions !== undefined && task.permissions.length > 0);
    }
    return false;
  }

  private bumpRevision(): void {
    this.revision += 1;
    if (this.onChange && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.closed) {
          this.onChange?.(this.snapshot());
        }
      }, 25);
    }
  }
}
