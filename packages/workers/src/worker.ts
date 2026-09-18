import type {
  ComputerRegistration,
  HardwareInfo,
  OSInfo,
  WorkerEventType,
  WorkerExecutionRequest,
  WorkerInfo,
} from '@wazir/core';
import { generateId } from '@wazir/shared';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { currentLoad, discoverHardware, type HardwareReport } from './hardwareDiscovery.js';
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
  /**
   * Cluster registration secret (`WAZIR_REGISTRATION_TOKEN` on the API).
   * Required to register when the control plane has one configured, and
   * lets a restarted worker re-claim its computer id.
   */
  registrationToken?: string;
  /**
   * Pre-shared per-computer token. When set it is used as this computer's
   * bearer token instead of a server-minted one, so identity survives
   * restarts without a registration token.
   */
  token?: string;
  adapters?: RuntimeAdapter[];
  heartbeatIntervalMs?: number;
}

/**
 * A Wazir worker runs on a target computer.
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
  private _hardware?: HardwareReport;

  private readonly serverUrl?: string;
  private readonly registrationToken?: string;
  /** Bearer token proving this process owns `computerId` on the control plane. */
  private token?: string;
  private readonly heartbeatIntervalMs: number;
  private adapters: DiscoveredRuntime[] = [];
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private running = false;
  private taskStreamAbort?: AbortController;
  private taskStreamRetryTimer: NodeJS.Timeout | undefined;

  private readonly configuredAdapters?: RuntimeAdapter[];

  constructor(options: WorkerOptions = {}) {
    this.computerId = options.computerId ?? generateId('computer-');
    this.id = options.computerId ? generateId(`worker-${options.computerId}-`) : generateId('worker-');
    this.name = options.name ?? `worker-${process.env.HOSTNAME ?? 'local'}`;
    this.serverUrl = options.serverUrl ? options.serverUrl.replace(/\/+$/, '') : undefined;
    this.registrationToken = options.registrationToken || undefined;
    this.token = options.token || undefined;
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
  get hardwareReport(): HardwareReport {
    if (!this._hardware) {
      this._hardware = discoverHardware() as any;
    }
    return this._hardware;
  }

  async start(): Promise<WorkerInfo> {
    if (this.running) {
      return this.info;
    }
    this.running = true;

    const adapters = this.configuredAdapters ?? defaultAdapters();
    const hardware = await discoverHardware();
    this._hardware = hardware;
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
      this.connectTaskStream();
    }

    return this.info;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.taskStreamRetryTimer) {
      clearTimeout(this.taskStreamRetryTimer);
      this.taskStreamRetryTimer = undefined;
    }
    this.taskStreamAbort?.abort();
    this.taskStreamAbort = undefined;
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
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
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
    // `local` is decided by the control plane from the transport (an HTTP
    // registration is never local); a self-reported `true` would let a
    // `localOnly` task be routed to this machine over the network.
    const registration: ComputerRegistration & { token?: string } = {
      id: this.computerId,
      name: this.name,
      type: 'workstation',
      local: false,
      os,
      hardware,
      runtimes: this.info.runtimes,
      models: this.info.models,
      token: this.token,
    };
    // Re-registration proves ownership with the token we already hold;
    // first registration (or a restart without state) uses the cluster
    // registration token when one is configured.
    const credential = this.token ?? this.registrationToken;

    // The control plane and its workers are typically started together by
    // an orchestrator (Docker Compose, systemd, Kubernetes) with no
    // guarantee the API is already accepting connections yet — a bare,
    // unretried fetch() here would crash the worker on that ordinary
    // startup race (observed running this for real under `docker compose
    // up`: the worker exited before the API's listener was ready, and only
    // came back up because Compose's restart policy masked it).
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(`${this.serverUrl}/computers/register`, {
          method: 'POST',
          headers: credential
            ? { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }
            : { 'Content-Type': 'application/json' },
          body: JSON.stringify(registration),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          const error = new Error(`registration failed: HTTP ${response.status}${body.error ? ` (${body.error})` : ''}`);
          // Auth failures are not transient; retrying only delays the report.
          if (response.status === 401 || response.status === 403) throw Object.assign(error, { fatal: true });
          throw error;
        }
        const body = (await response.json()) as { token?: string };
        if (typeof body.token === 'string' && body.token) {
          this.token = body.token;
        }
        return;
      } catch (error) {
        if (attempt === attempts || (error as { fatal?: boolean }).fatal) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  private authHeaders(base: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...base, Authorization: `Bearer ${this.token}` } : base;
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

  /**
   * Holds an SSE connection open against the control plane and executes each
   * dispatched `WorkerExecutionRequest` as it arrives. This is the piece that
   * lets a remote worker actually receive tasks — previously it only
   * registered and sent heartbeats, with no way to be handed work.
   */
  private connectTaskStream(): void {
    if (!this.serverUrl || !this.running) return;
    const abort = new AbortController();
    this.taskStreamAbort = abort;

    void this.runTaskStream(abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (!this.running || abort.signal.aborted) return;
        this.taskStreamRetryTimer = setTimeout(() => this.connectTaskStream(), 2_000);
        this.taskStreamRetryTimer.unref?.();
      });
  }

  private async runTaskStream(signal: AbortSignal): Promise<void> {
    const response = await fetch(
      `${this.serverUrl}/computers/${encodeURIComponent(this.computerId)}/tasks/stream`,
      { signal, headers: this.authHeaders({ Accept: 'text/event-stream' }) },
    );
    if (!response.ok || !response.body) {
      throw new Error(`task stream connect failed: HTTP ${response.status}`);
    }

    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        this.handleTaskFrame(frame);
      }
    }
  }

  private handleTaskFrame(frame: string): void {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return;
    try {
      const request = JSON.parse(dataLine.slice(5).trim()) as WorkerExecutionRequest;
      void this.handleDispatchedTask(request);
    } catch {
      // malformed frame; ignore rather than killing the stream
    }
  }

  /** Executes a control-plane-dispatched request and reports events/outcome back. */
  private async handleDispatchedTask(request: WorkerExecutionRequest): Promise<void> {
    await this.reportEvent(request, 'started');
    try {
      // `execute()`'s onEvent callback is synchronous (it can't await), but
      // each call fires an HTTP POST — without chaining them explicitly,
      // two events emitted back-to-back (e.g. two token events with no
      // real delay between them) race as independent in-flight requests
      // and can land at the control plane in the wrong order. Chaining
      // onto `reportChain` serializes the POSTs without blocking the
      // generator loop itself.
      let reportChain: Promise<void> = Promise.resolve();
      const outcome = await this.execute(request, (event) => {
        reportChain = reportChain.then(() =>
          this.reportEvent(request, this.mapStreamEventType(event.type), event),
        );
      });
      await reportChain;
      await this.reportResult(request, outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.reportEvent(request, 'failed', { error: message });
      await this.reportResult(request, {
        ok: false,
        output: '',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        error: message,
      });
    }
  }

  private mapStreamEventType(type: ExecutionStreamEvent['type']): WorkerEventType {
    if (type === 'completed') return 'completed';
    if (type === 'error') return 'failed';
    if (type === 'tool_call') return 'tool_call';
    return 'token';
  }

  private async reportEvent(request: WorkerExecutionRequest, type: WorkerEventType, data?: unknown): Promise<void> {
    if (!this.serverUrl) return;
    await fetch(
      `${this.serverUrl}/computers/${encodeURIComponent(this.computerId)}/executions/${encodeURIComponent(request.requestId)}/events`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ executionId: request.executionId, type, data }),
      },
    ).catch(() => undefined);
  }

  private async reportResult(
    request: WorkerExecutionRequest,
    outcome: { ok: boolean; output: string; inputTokens: number; outputTokens: number; durationMs: number; error?: string },
  ): Promise<void> {
    if (!this.serverUrl) return;
    await fetch(
      `${this.serverUrl}/computers/${encodeURIComponent(this.computerId)}/executions/${encodeURIComponent(request.requestId)}/result`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(outcome),
      },
    ).catch(() => undefined);
  }
}

export function createWorker(options: WorkerOptions = {}): Worker {
  return new Worker(options);
}
