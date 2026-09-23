import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { HealthStatus } from '@wazir/runtimes-interfaces';

export interface ProcessConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  healthEndpoint?: string;
  startupTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export interface ManagedProcess {
  config: ProcessConfig;
  process: ChildProcess | null;
  status: 'idle' | 'starting' | 'running' | 'failed' | 'stopped';
  pid?: number;
  stdout: string[];
  stderr: string[];
  health: HealthStatus;
  lastHealthCheck?: Date;
}

export interface ProcessManagerOptions {
  processes?: ProcessConfig[];
  detectExisting?: boolean;
}

const DEFAULT_STARTUP_TIMEOUT = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL = 5_000;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly healthCheckIntervals = new Map<string, NodeJS.Timeout>();

  constructor(options: ProcessManagerOptions = {}) {
    for (const config of options.processes ?? []) {
      this.register(config);
    }
    if (options.detectExisting) {
      void this.detectRunningProcesses();
    }
  }

  register(config: ProcessConfig): ManagedProcess {
    const processRecord: ManagedProcess = {
      config,
      process: null,
      status: 'idle',
      stdout: [],
      stderr: [],
      health: { status: 'unavailable' },
    };
    this.processes.set(config.id, processRecord);
    return processRecord;
  }

  async start(id: string): Promise<void> {
    const record = this.require(id);

    if (record.status === 'running') {
      return;
    }

    record.status = 'starting';
    record.stdout = [];
    record.stderr = [];

    // Detached (POSIX) so the child becomes the leader of its own process
    // group: stop() below kills that whole group, not just this one pid.
    // Previously this was `detached: false`, which meant the child shared
    // *this* process's own group — `process.kill(-record.pid!, ...)` in
    // stop() was therefore targeting the wrong group entirely (this
    // process's, or nothing at all, depending on OS group assignment), a
    // pre-existing bug independent of the missing grace/verify logic below.
    const child = spawn(record.config.command, record.config.args ?? [], {
      env: { ...process.env, ...record.config.env },
      detached: process.platform !== 'win32',
    });

    record.process = child;
    record.pid = child.pid;

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      record.stdout.push(line);
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      record.stderr.push(line);
    });

    child.on('close', (code) => {
      if (record.status === 'starting') {
        record.status = 'failed';
        record.health = { status: 'degraded', message: `Process exited with code ${code}` };
      } else {
        record.status = 'stopped';
      }
      this.stopHealthCheck(id);
    });

    child.on('error', (error) => {
      record.status = 'failed';
      record.health = { status: 'degraded', message: error.message };
      this.stopHealthCheck(id);
    });

    await this.waitForStartup(record, id);
  }

  /**
   * Stops a managed process: SIGTERM, wait up to `graceMs` for it to actually
   * exit, escalate to SIGKILL if it hasn't, then verify death before
   * updating the registry. Previously this sent a signal and immediately
   * marked the record 'stopped' with no verification at all — a process
   * that ignored SIGTERM (or SIGKILL, briefly, before the kernel delivers
   * it) was reported stopped while still actually running.
   */
  async stop(id: string, graceMs = 5000): Promise<void> {
    const record = this.require(id);

    if (!record.process) {
      return;
    }

    this.stopHealthCheck(id);
    const child = record.process;
    const pid = record.pid;

    let exited = false;
    child.once('exit', () => { exited = true; });

    if (process.platform === 'win32') {
      if (pid !== undefined) killWindowsTree(pid);
    } else if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    }

    const deadline = Date.now() + graceMs;
    while (!exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!exited) {
      if (process.platform === 'win32') {
        if (pid !== undefined) killWindowsTree(pid);
      } else if (pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
      const killDeadline = Date.now() + 2000;
      while (!exited && Date.now() < killDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // Verify death rather than assume it: a signal delivery failure (wrong
    // pid re-used by an unrelated process, permission error, ...) should
    // surface as a real failure, not a silently-wrong 'stopped' status.
    const stillAlive = pid !== undefined && !exited && isAlive(pid);
    record.process = null;
    record.pid = undefined;
    if (stillAlive) {
      record.status = 'failed';
      record.health = { status: 'degraded', message: `Process ${pid} did not exit after SIGTERM/SIGKILL` };
      throw new Error(`PROCESS_STOP_FAILED: '${id}' (pid ${pid}) is still running after SIGKILL`);
    }
    record.status = 'stopped';
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  list(): ManagedProcess[] {
    return Array.from(this.processes.values());
  }

  getStatus(id: string): 'idle' | 'starting' | 'running' | 'failed' | 'stopped' {
    const record = this.require(id);
    return record.status;
  }

  async healthCheck(id: string): Promise<HealthStatus> {
    const record = this.require(id);

    if (record.status !== 'running') {
      return { status: 'degraded', message: `Process not running (status: ${record.status})` };
    }

    if (!record.config.healthEndpoint) {
      return { status: 'unavailable' };
    }

    try {
      const response = await fetch(record.config.healthEndpoint);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      record.lastHealthCheck = new Date();
      return { status: 'healthy', message: 'OK' };
    } catch (error) {
      record.health = { status: 'degraded', message: error instanceof Error ? error.message : String(error) };
      return record.health;
    }
  }

  private async waitForStartup(record: ManagedProcess, id: string): Promise<void> {
    const timeoutMs = record.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!record.process || record.status === 'failed') {
        throw new Error(`Process failed to start: ${record.stderr.slice(-5).join('\n')}`);
      }

      if (record.config.healthEndpoint) {
        try {
          const response = await fetch(record.config.healthEndpoint);
          if (response.ok) {
            record.status = 'running';
            record.health = { status: 'healthy', message: 'OK' };
            this.startHealthCheck(id);
            return;
          }
        } catch {
          // Health endpoint not yet available
        }
      } else {
        // No health endpoint, assume running after successful spawn
        record.status = 'running';
        record.health = { status: 'healthy', message: 'Process started' };
        this.startHealthCheck(id);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Process startup timed out after ${timeoutMs}ms`);
  }

  private startHealthCheck(id: string): void {
    const record = this.require(id);
    if (record.config.healthEndpoint) {
      const intervalMs = record.config.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL;
      const interval = setInterval(() => void this.healthCheck(id), intervalMs);
      this.healthCheckIntervals.set(id, interval);
    }
  }

  private stopHealthCheck(id: string): void {
    const interval = this.healthCheckIntervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(id);
    }
  }

  private require(id: string): ManagedProcess {
    const record = this.processes.get(id);
    if (!record) {
      throw new Error(`Process '${id}' not registered`);
    }
    return record;
  }

  private async detectRunningProcesses(): Promise<void> {
    // Placeholder for process detection logic
    // Could use ps, lsof, or platform-specific APIs
  }
}

export function createProcessManager(options: ProcessManagerOptions = {}): ProcessManager {
  return new ProcessManager(options);
}

/** Terminates a process and everything it spawned. Node's own child.kill() on Windows only reaches the direct process. */
function killWindowsTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // best effort
  }
}

/** Existence check (kill -0) — throws if the pid is gone or not ours, which is exactly what "is it dead yet" needs. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
