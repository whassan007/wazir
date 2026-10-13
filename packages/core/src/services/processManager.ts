import { spawn, type ChildProcess } from 'node:child_process';
import type { HealthStatus } from '@wazir/runtimes-interfaces';
import { killProcessTree, isProcessAlive, terminateProcessTree, getSpawnCommand, sanitizeChildEnvironment } from '@wazir/shared';

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

    const spawnCmd = getSpawnCommand(record.config.command, record.config.args ?? []);
    const child = spawn(spawnCmd.command, spawnCmd.args, {
      env: sanitizeChildEnvironment(record.config.env),
      detached: process.platform !== 'win32',
      shell: spawnCmd.useShell,
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

    const stopped = await terminateProcessTree(child, {
      graceMs,
      wasDetached: process.platform !== 'win32',
    });

    record.process = null;
    record.pid = undefined;

    if (!stopped) {
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
