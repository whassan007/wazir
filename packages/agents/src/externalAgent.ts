import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  TaskType,
} from '@wazir/core';

const MAX_CAPTURE = 20_000;

export interface ExternalAgentSpec {
  name: string;
  version: string;
  description: string;
  /** Executable to run for a task, e.g. 'opencode' or 'bionic'. */
  command: string;
  args?: string[];
  taskTypes: TaskType[];
  capabilities: string[];
  timeoutMs?: number;
}

/**
 * Adapter for external agent harnesses (OpenCode, Bionic, ...).
 * External agents are OPTIONAL execution providers — Wazir remains the
 * control plane: it schedules the task, selects the model/computer, and
 * records the execution. The external process only provides the reasoning loop.
 */
export class ExternalAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
    this.descriptor = {
      name: spec.name,
      version: spec.version,
      description: spec.description,
      capabilities: spec.capabilities,
      requiredTools: [],
      modelRequirements: { capabilities: [] },
      permissions: [],
      taskTypes: spec.taskTypes,
      strategy: 'external',
    };
  }

  async *run(request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const args = [...(this.spec.args ?? []), request.taskDescription];

    const timeoutMs = this.spec.timeoutMs ?? 600_000;
    const output = await new Promise<string | undefined>((resolve, reject) => {
      let captured = '';
      let stopReason: 'timeout' | 'cancelled' | undefined;
      // Own process group (POSIX) so timeout/cancel reaches the harness's children too:
      // killing only the direct child leaves grandchildren holding the stdout pipe,
      // and 'close' then never fires.
      const detached = process.platform !== 'win32';
      const child = spawn(this.spec.command, args, {
        cwd: request.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
      });
      const stop = (reason: 'timeout' | 'cancelled') => {
        if (stopReason) return;
        stopReason = reason;
        try {
          if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const cancelPoll = setInterval(() => { if (request.isCancelled?.()) stop('cancelled'); }, 250);
      const settle = () => { clearTimeout(timer); clearInterval(cancelPoll); };
      // Only the first MAX_CAPTURE chars are reported, so stop buffering past that.
      const append = (chunk: string) => {
        if (captured.length < MAX_CAPTURE) captured += chunk.slice(0, MAX_CAPTURE - captured.length);
      };
      child.stdout.setEncoding('utf8').on('data', append);
      child.stderr.setEncoding('utf8').on('data', append);
      child.on('error', (error) => {
        settle();
        reject(error);
      });
      child.on('close', (code) => {
        settle();
        if (stopReason === 'cancelled') resolve(undefined);
        else if (stopReason === 'timeout') reject(new Error(`'${this.spec.command}' timed out after ${timeoutMs}ms`));
        else if (code === 0) resolve(captured);
        else {
          // The agent's own last words say why; an exit code alone is not diagnosable.
          const tail = captured.trim().split('\n').slice(-3).join(' ').slice(-300);
          reject(new Error(`'${this.spec.command}' exited with code ${code}${tail ? `: ${tail}` : ''}`));
        }
      });
    });

    if (output === undefined || request.isCancelled?.()) {
      yield { kind: 'error', error: 'cancelled' };
      return;
    }

    yield { kind: 'message', content: output };
    yield { kind: 'done', content: `external agent '${this.descriptor.name}' completed` };
  }
}
