import type {
  CheckRunRecord,
  ContextDecision,
  EvaluationResult,
  Execution,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionRecord,
  ExecutionStatus,
  PolicyDecision,
  SchedulerDecision,
  Task,
  TokenUsage,
  ToolCallRecord,
} from '../types/index.js';

export interface ExecutionEngineOptions {
  /** Persists a record after every mutation. */
  persist?: (record: ExecutionRecord) => void | Promise<void>;
  /** Seeds the engine from durable storage at startup. */
  load?: () => ExecutionRecord[] | Promise<ExecutionRecord[]>;
  idPrefix?: string;
}

let eventCounter = 0;
let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Durable execution tracking. Every execution produces a complete record:
 * task, agent, model, runtime, computer, context, policy decisions,
 * scheduling decision, tool calls, files changed, checks, errors,
 * latency, token usage, final result and evaluation.
 */
export class ExecutionEngine {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly persist?: (record: ExecutionRecord) => void | Promise<void>;
  private readonly idPrefix: string;
  readonly ready: Promise<void>;

  constructor(options: ExecutionEngineOptions = {}) {
    this.persist = options.persist;
    this.idPrefix = options.idPrefix ?? 'exec';
    this.ready = Promise.resolve(options.load?.()).then((loaded) => {
      if (!loaded) return;
      for (const record of loaded) {
        this.records.set(record.execution.id, record);
      }
    }).catch(() => {});
  }

  async create(params: {
    task: Task;
    agentId?: string;
    computerId: string;
    runtimeId: string;
    modelId: string;
    workerId?: string;
    scheduling?: SchedulerDecision;
    context?: ContextDecision;
  }): Promise<ExecutionRecord> {
    const now = new Date();
    const execution: Execution = {
      id: nextId(this.idPrefix),
      taskId: params.task.id,
      agentId: params.agentId,
      computerId: params.computerId,
      runtimeId: params.runtimeId,
      modelId: params.modelId,
      workerId: params.workerId,
      status: 'queued',
      createdAt: now,
    };

    const record: ExecutionRecord = {
      execution,
      task: params.task,
      scheduling: params.scheduling,
      context: params.context,
      policyDecisions: [],
      toolCalls: [],
      filesChanged: [],
      checks: [],
      errors: [],
      events: [
        {
          id: nextId('evt'),
          executionId: execution.id,
          type: 'execution.created',
          timestamp: now,
          data: {
            agentId: params.agentId,
            computerId: params.computerId,
            runtimeId: params.runtimeId,
            modelId: params.modelId,
          },
        },
      ],
    };

    this.records.set(execution.id, record);
    await this.flush(record);
    return record;
  }

  async setScheduled(executionId: string, scheduling: SchedulerDecision): Promise<void> {
    const record = this.require(executionId);
    record.scheduling = scheduling;
    this.pushEvent(record, 'execution.scheduled', scheduling);
    await this.flush(record);
  }

  async setStatus(executionId: string, status: ExecutionStatus): Promise<void> {
    const record = this.require(executionId);
    record.execution.status = status;
    const now = new Date();
    if (status === 'running' && !record.execution.startedAt) {
      record.execution.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      record.execution.completedAt = now;
    }

    const eventType: ExecutionEventType =
      status === 'running'
        ? 'execution.assigned'
        : status === 'completed'
          ? 'execution.completed'
          : status === 'failed'
            ? 'execution.failed'
            : status === 'cancelled'
              ? 'execution.cancelled'
              : 'execution.scheduled';

    this.pushEvent(record, eventType, { status });
    await this.flush(record);
  }

  async recordPolicy(executionId: string, decision: PolicyDecision): Promise<void> {
    const record = this.require(executionId);
    record.policyDecisions.push(decision);
    this.pushEvent(record, 'policy.decision', decision);
    await this.flush(record);
  }

  async recordToolCall(executionId: string, call: ToolCallRecord): Promise<void> {
    const record = this.require(executionId);
    record.toolCalls.push(call);
    this.pushEvent(record, 'tool.completed', {
      tool: call.tool,
      ok: call.ok,
      policyEffect: call.policyEffect,
      durationMs: call.durationMs,
    });
    await this.flush(record);
  }

  async recordToolStart(executionId: string, tool: string, input: unknown): Promise<void> {
    const record = this.require(executionId);
    this.pushEvent(record, 'tool.started', { tool, input });
    await this.flush(record);
  }

  async recordCheck(executionId: string, check: CheckRunRecord): Promise<void> {
    const record = this.require(executionId);
    record.checks.push(check);
    this.pushEvent(record, 'check.completed', check);
    await this.flush(record);
  }

  async recordEvent(executionId: string, type: ExecutionEventType, data?: unknown): Promise<void> {
    const record = this.require(executionId);
    this.pushEvent(record, type, data);
    await this.flush(record);
  }

  async recordError(executionId: string, error: string): Promise<void> {
    const record = this.require(executionId);
    record.errors.push(error);
    await this.flush(record);
  }

  async recordUsage(executionId: string, usage: TokenUsage): Promise<void> {
    const record = this.require(executionId);
    record.usage = {
      input: (record.usage?.input ?? 0) + usage.input,
      output: (record.usage?.output ?? 0) + usage.output,
      total: (record.usage?.total ?? 0) + (usage.total ?? usage.input + usage.output),
    };
    await this.flush(record);
  }

  async recordFilesChanged(executionId: string, files: string[]): Promise<void> {
    const record = this.require(executionId);
    for (const file of files) {
      if (!record.filesChanged.includes(file)) {
        record.filesChanged.push(file);
      }
    }
    await this.flush(record);
  }

  async setResult(executionId: string, result: string): Promise<void> {
    const record = this.require(executionId);
    record.result = result;
    await this.flush(record);
  }

  async setEvaluation(executionId: string, evaluation: EvaluationResult): Promise<void> {
    const record = this.require(executionId);
    record.evaluation = evaluation;
    this.pushEvent(record, 'evaluation.completed', evaluation);
    await this.flush(record);
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.records.get(executionId);
  }

  require(executionId: string): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }
    return record;
  }

  async list(): Promise<ExecutionRecord[]> {
    return Array.from(this.records.values()).sort((a, b) =>
      b.execution.createdAt.getTime() - a.execution.createdAt.getTime(),
    );
  }

  async listByTask(taskId: string): Promise<ExecutionRecord[]> {
    const records = await this.list();
    return records.filter((r) => r.execution.taskId === taskId);
  }

  async events(executionId: string): Promise<ExecutionEvent[]> {
    const record = await this.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }
    return [...record.events].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }

  /** Replays the recorded event stream in order. */
  async *replay(executionId: string): AsyncIterable<ExecutionEvent> {
    const events = await this.events(executionId);
    for (const event of events) {
      yield event;
    }
  }

  private pushEvent(record: ExecutionRecord, type: ExecutionEventType, data?: unknown): void {
    eventCounter += 1;
    record.events.push({
      id: nextId('evt'),
      executionId: record.execution.id,
      type,
      timestamp: new Date(),
      data,
    });
  }

  private async flush(record: ExecutionRecord): Promise<void> {
    if (this.persist) {
      await this.persist(record);
    }
  }
}

export function createExecutionEngine(options: ExecutionEngineOptions = {}): ExecutionEngine {
  return new ExecutionEngine(options);
}
