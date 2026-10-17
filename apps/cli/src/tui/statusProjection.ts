export type ConversationStatus =
  | 'IDLE' | 'PLANNING' | 'RUNNING' | 'WAITING_FOR_MODEL' | 'WAITING_FOR_APPROVAL'
  | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface ProjectedTaskStatus {
  taskId: string;
  status: ConversationStatus;
  activity: string;
  startedAt?: number;
}

const terminal = new Set<ConversationStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Presentation projection only; the JobOrchestrator remains authoritative. */
export class StatusProjection {
  private readonly tasks = new Map<string, ProjectedTaskStatus>();
  private readonly terminalEvents = new Map<string, ConversationStatus>();

  seed(taskIds: string[]): void {
    for (const taskId of taskIds) {
      if (!this.tasks.has(taskId)) this.tasks.set(taskId, { taskId, status: 'IDLE', activity: 'Working...' });
    }
  }

  apply(event: { type: string; taskId?: string; phase?: string; event?: any; error?: string }, now = Date.now()): ProjectedTaskStatus | undefined {
    const id = event.taskId;
    if (!id) return undefined;
    const task = this.tasks.get(id) ?? { taskId: id, status: 'IDLE' as const, activity: 'Working...' };
    this.tasks.set(id, task);
    // Once terminal evidence arrives, delayed model/tool events cannot resurrect it.
    const terminalStatus = this.terminalEvents.get(id);
    if (terminalStatus && event.type !== 'task:retry') return task;

    if (event.type === 'task:started') {
      task.status = 'RUNNING'; task.activity = 'Working...'; task.startedAt ??= now;
    } else if (event.type === 'task:retry') {
      this.terminalEvents.delete(id); task.status = 'RUNNING'; task.activity = 'Recovering from a failed check...';
    } else if (event.type === 'task:completed') {
      task.status = 'COMPLETED'; task.activity = 'Completed'; this.terminalEvents.set(id, 'COMPLETED');
    } else if (event.type === 'task:failed') {
      task.status = 'FAILED'; task.activity = 'Failed'; this.terminalEvents.set(id, 'FAILED');
    } else if (event.type === 'task:cancelled') {
      task.status = 'CANCELLED'; task.activity = 'Cancelled'; this.terminalEvents.set(id, 'CANCELLED');
    } else if (event.type === 'task:progress') {
      const progress = event.event ?? {};
      if (progress.kind === 'token') {
        task.status = 'RUNNING'; task.activity = 'Working...';
      } else if (progress.phase === 'plan' || event.phase === 'plan') {
        task.status = 'PLANNING'; task.activity = 'Planning approach...';
      } else if (progress.phase === 'verify' || progress.phase === 'test' || event.phase === 'verify') {
        task.status = 'VERIFYING'; task.activity = 'Verifying changes...';
      } else if (progress.tool) {
        task.status = 'RUNNING'; task.activity = classifyTool(progress.tool, progress.metadata);
      } else if (progress.phase) {
        task.status = 'RUNNING'; task.activity = classifyPhase(progress.phase);
      }
    }
    return task;
  }

  setWaitingForApproval(taskIds: string[], waiting: boolean): void {
    const ids = waiting ? taskIds : [...this.tasks.keys()];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (!task || terminal.has(task.status)) continue;
      if (waiting) { task.status = 'WAITING_FOR_APPROVAL'; task.activity = 'Waiting for approval...'; }
      else if (task.status === 'WAITING_FOR_APPROVAL') { task.status = 'RUNNING'; task.activity = 'Working...'; }
    }
  }

  getTasks(): ProjectedTaskStatus[] { return [...this.tasks.values()].map((task) => ({ ...task })); }
  getTask(taskId: string): ProjectedTaskStatus | undefined { const task = this.tasks.get(taskId); return task && { ...task }; }
}

function classifyPhase(phase: string): string {
  switch (phase.toLowerCase()) {
    case 'plan': return 'Planning approach...';
    case 'verify': case 'test': return 'Verifying changes...';
    case 'route': case 'routing': return 'Finding a worker...';
    default: return 'Working...';
  }
}

export function classifyTool(tool: string, metadata?: Record<string, unknown>): string {
  switch (tool.toLowerCase()) {
    case 'glob': case 'search': case 'read': return 'Exploring repository...';
    case 'write': case 'edit': return 'Updating source files...';
    case 'test': case 'lint': case 'typecheck': return `Running ${tool.toLowerCase()}...`;
    case 'build': return 'Compiling...';
    case 'shell': {
      const command = String(metadata?.command ?? '').toLowerCase();
      if (/\b(test|vitest|jest|pytest|ctest)\b/.test(command)) return 'Running tests...';
      if (/\b(build|compile|tsc|cmake|make|cargo)\b/.test(command)) return 'Compiling...';
      return 'Running command...';
    }
    default: return 'Working...';
  }
}
