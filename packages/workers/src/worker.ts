import type {
  ComputerRegistration,
  HardwareInfo,
  OSInfo,
  WorkerExecutionRequest,
  WorkerInfo,
} from '@rook/core';
import { generateId } from '@rook/shared';
import type { RuntimeAdapter } from '@rook/runtimes-interfaces';
import { currentLoad, discoverHardware } from './hardwareDiscovery.js';
import {
  defaultAdapters,
  discoverRuntimes,
  type DiscoveredRuntime,
} from './runtimeDiscovery.js';
import { cancelRequest, executeRequest, type ExecutionStreamEvent } from './taskExecutor.js';

export interface WorkerOptions {
  computerId?: string;
  name?: string;
  /** Control plane URL. Omit to run the worker in local (in-process) mode. */
  serverUrl?: string;
  adapters?: RuntimeAdapter[];
  heartbeatIntervalMs?: number;
}

/**
 * A Rook worker runs on a target computer.
 *
 * Responsibilities: register, report hardware, discover runtimes and models,
 * report health and utilization, execute authorized requests, stream events,
 * support cancellation, report metrics.
 *
 * A worker NEVER makes global scheduling decisions — it only executes what the
 * control plane authorizes and sends.
 */
export class Worker {
  readonly id: string;
  readonly computerId: string;
  readonly name: string;
  info: WorkerInfo;

  private readonly serverUrl?: string;
  private readonly heartbeatIntervalMs: number;
  private adapters: DiscoveredRuntime[] = [];
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private running = false;

  private readonly configuredAdapters?: RuntimeAdapter[];

  constructor(options: WorkerOptions = {}) {
    this.computerId = options.computerId ?? generateId('computer-');
    this.id = options.computerId ? generateId(`worker-${options.computerId}-`) : generateId('worker-');
    this.name = options.name ?? `worker-${process.env.HOSTNAME ?? 'local'}`;
    this.serverUrl = options.serverUrl ? options.serverUrl.replace(/\/+$/, '') : undefined;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.configuredAdapters = options.adapters;
    this.info = {
      id: this.id,
      computerId: this.computerId,
      version: process.version,
      status: 'offline',
      runtimes: [],
      models: [],
    };
  }

  get discovered(): DiscoveredRuntime[] {
    return this.adapters;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<WorkerInfo> {
    if (this.running) {
      return this.info;
    }
    this.running = true;

    const adapters = this.configuredAdapters ?? defaultAdapters();
    const hardware = await discoverHardware();
    this.adapters = await discoverRuntimes(adapters);

    const runtimeIds = this.adapters.map((r) => r.id);
    const modelIds = this.adapters.flatMap((r) => r.models.map((m) => m.id));

    this.info = {
      ...this.info,
      status: 'online',
      runtimes: runtimeIds,
      models: modelIds,
      lastHeartbeat: new Date(),
    };

    if (this.serverUrl) {
      await this.register(hardware.os, hardware.hardware);
      this.startHeartbeatLoop();
    }

    return this.info;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.info = { ...this.info, status: 'offline' };
  }

  adapterForModel(modelId: string): RuntimeAdapter | undefined {
    const discovered = this.adapters.find((runtime) =>
      runtime.models.some((model) => model.id === modelId),
    );
    if (discovered) {
      return discovered.adapter;
    }
    // fall back to the first healthy runtime (explicit requests may use its native id)
    return this.adapters.find((runtime) => runtime.health !== 'unavailable')?.adapter;
  }

  /**
   * Execute an authorized request. The worker only executes; it does not
   * schedule, select models, or authorize anything.
   */
  async execute(
    request: WorkerExecutionRequest,
    onEvent?: (event: ExecutionStreamEvent) => void,
  ) {
    const adapter = this.adapterForModel(request.modelId);
    if (!adapter) {
      throw new Error(`no runtime available to serve model '${request.modelId}'`);
    }
    return executeRequest(adapter, request, onEvent);
  }

  async cancel(requestId: string): Promise<void> {
    for (const discovered of this.adapters) {
      await cancelRequest(discovered.adapter, requestId).catch(() => undefined);
    }
  }

  async heartbeat(): Promise<void> {
    if (!this.serverUrl) {
      this.info = { ...this.info, lastHeartbeat: new Date(), status: 'online' };
      return;
    }
    const runtimeHealth: Record<string, { status: string }> = {};
    const modelHealth: Record<string, { loaded: boolean }> = {};
    for (const discovered of this.adapters) {
      runtimeHealth[discovered.id] = { status: discovered.health };
      for (const model of discovered.models) {
        modelHealth[model.id] = { loaded: discovered.health === 'healthy' };
      }
    }
    await fetch(`${this.serverUrl}/computers/${encodeURIComponent(this.computerId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        load: currentLoad(),
        runtimes: Object.keys(runtimeHealth),
        models: Object.keys(modelHealth),
        runtimeHealth,
        modelHealth,
      }),
    }).catch(() => undefined);
    this.info = { ...this.info, lastHeartbeat: new Date() };
  }

  private async register(os: OSInfo, hardware: HardwareInfo): Promise<void> {
    if (!this.serverUrl) return;
    const registration: ComputerRegistration = {
      id: this.computerId,
      name: this.name,
      type: 'workstation',
      local: true,
      os,
      hardware,
      runtimes: this.info.runtimes,
      models: this.info.models,
    };
    await fetch(`${this.serverUrl}/computers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registration),
    });
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }
}

export function createWorker(options: WorkerOptions = {}): Worker {
  return new Worker(options);
}
