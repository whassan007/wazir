/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import { randomUUID } from 'node:crypto';

export type ProactiveTaskStatus =
  | 'provisioning'
  | 'running'
  | 'delivering'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ProactiveTaskType = 'health_check' | 'time_reminder' | 'execution_monitor';

export interface ProactiveTask {
  taskId: string;
  title: string;
  taskType: ProactiveTaskType;
  status: ProactiveTaskStatus;
  repeat: boolean;
  generation: number;
  createdAt: number;
  updatedAt: number;
  triggerCount: number;
  failureCount: number;
  cooldownUntil?: number;
  awaitingFalse?: boolean;
  lastSummary?: string;
  error?: string;
  durationSec?: number;
}

export interface CreateProactiveTaskInput {
  title: string;
  taskType: ProactiveTaskType;
  repeat?: boolean;
  durationSec?: number;
}

export class ProactiveTaskManager {
  private readonly tasks = new Map<string, ProactiveTask>();
  private readonly generations = new Map<string, number>();

  createTask(input: CreateProactiveTaskInput): ProactiveTask {
    const taskId = randomUUID();
    const task: ProactiveTask = {
      taskId,
      title: input.title.trim().slice(0, 240),
      taskType: input.taskType,
      status: 'running',
      repeat: input.repeat ?? false,
      generation: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      triggerCount: 0,
      failureCount: 0,
      durationSec: input.durationSec,
    };

    this.tasks.set(taskId, task);
    this.generations.set(taskId, 1);
    return task;
  }

  getTask(taskId: string): ProactiveTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: ProactiveTaskStatus): ProactiveTask[] {
    const list = Array.from(this.tasks.values());
    return status ? list.filter((t) => t.status === status) : list;
  }

  updateStatus(taskId: string, status: ProactiveTaskStatus, error?: string): ProactiveTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    task.status = status;
    task.updatedAt = Date.now();
    if (error) task.error = error;
    if (status === 'failed') task.failureCount += 1;
    return task;
  }

  recordTrigger(taskId: string, summary?: string, cooldownMs = 10_000): ProactiveTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    task.triggerCount += 1;
    task.updatedAt = Date.now();
    task.lastSummary = summary;
    task.cooldownUntil = Date.now() + cooldownMs;
    task.awaitingFalse = true;

    if (!task.repeat) {
      task.status = 'completed';
    }
    return task;
  }

  resetHysteresis(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.awaitingFalse = false;
      task.updatedAt = Date.now();
    }
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    return true;
  }

  clear(): void {
    this.tasks.clear();
    this.generations.clear();
  }
}
