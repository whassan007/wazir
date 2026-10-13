import { spawn, type ChildProcess } from 'node:child_process';
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
  /** Extra environment, e.g. a vendor CLI config dir selecting one account's login. */
  env?: Record<string, string>;
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
        env: this.spec.env ? { ...process.env, ...this.spec.env } : undefined,
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
      // If Wazir itself dies (SIGKILL, OOM, closed terminal) the detached group would keep
      // running and editing the workspace unsupervised. A watchdog outside the group kills
      // it once this process is gone, and exits on its own when the group finishes.
      const watchdog = detached && child.pid !== undefined ? spawnWatchdog(process.pid, child.pid) : undefined;
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const cancelPoll = setInterval(() => { if (request.isCancelled?.()) stop('cancelled'); }, 250);
      const settle = () => {
        clearTimeout(timer);
        clearInterval(cancelPoll);
        try { watchdog?.kill('SIGKILL'); } catch { /* already gone */ }
      };
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

/**
 * Kills process group `pgid` when `ownerPid` exits. Polls once a second; stops when the group
 * is gone. Runs in its own session so it survives the owner and is not in the group it kills.
 */
function spawnWatchdog(ownerPid: number, pgid: number): ChildProcess | undefined {
  const script = `while kill -0 ${ownerPid} 2>/dev/null; do kill -0 -${pgid} 2>/dev/null || exit 0; sleep 1; done; kill -KILL -${pgid} 2>/dev/null; exit 0`;
  try {
    const w = spawn('/bin/sh', ['-c', script], { stdio: 'ignore', detached: true });
    w.on('error', () => undefined);
    w.unref();
    return w;
  } catch {
    return undefined;
  }
}
