import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPool, PostgresStore, runKvMigration } from '../../../packages/database/src/index.js';
import { JsonFileStore, type KeyValueStore } from '../../../packages/shared/src/store.js';
import type { Pool } from 'pg';
import { startSimulatedInference, type SimulatedInferenceServer } from './simulatedInference.js';

export interface ClusterHarnessOptions {
  databaseUrl?: string;
  registrationToken?: string;
  apiToken?: string;
}

export interface WorkerProcess {
  id: string;
  computerId: string;
  pid: number;
  process: ChildProcess;
  logs: string[];
  token?: string;
}

export interface ApiProcess {
  pid: number;
  port: number;
  url: string;
  process: ChildProcess;
  logs: string[];
}

export class ClusterHarness {
  readonly rootDir: string;
  readonly apiDistPath: string;
  readonly workerDistPath: string;
  readonly tempDir: string;
  readonly registrationToken: string;
  readonly apiToken: string;
  readonly workerLeaseMs: number;
  readonly databaseUrl?: string;

  private apiProc?: ApiProcess;
  private port?: number;
  readonly evidence: any[] = [];
  private readonly knownTokens = new Set<string>();
  private readonly lastResponses = new Map<string, string>();
  private readonly children: ChildProcess[] = [];
  private readonly processLogs: Array<{ pid?: number; logs: string[] }> = [];
  private readonly workers = new Map<string, WorkerProcess>();
  private simulatedInference?: SimulatedInferenceServer;
  private dbPool?: Pool;
  private durableStore?: KeyValueStore;

  constructor(tempDir: string, options: ClusterHarnessOptions = {}) {
    this.rootDir = path.resolve(__dirname, '../../../');
    this.apiDistPath = path.resolve(this.rootDir, 'apps/api/dist/main.js');
    this.workerDistPath = path.resolve(this.rootDir, 'apps/worker/dist/index.js');
    this.tempDir = tempDir;
    this.databaseUrl = options.databaseUrl ?? process.env.WAZIR_TEST_DATABASE_URL;
    this.registrationToken = options.registrationToken ?? `reg-secret-${Date.now()}`;
    this.apiToken = options.apiToken ?? `api-token-${Date.now()}`;
    this.workerLeaseMs = 30_000;
  }

  static async create(options: ClusterHarnessOptions = {}): Promise<ClusterHarness> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-dist-cluster-'));
    const harness = new ClusterHarness(tempDir, options);
    await harness.init();
    return harness;
  }

  private async init(): Promise<void> {
    if (process.env.WAZIR_REQUIRE_DATABASE === '1' && !this.databaseUrl) throw new Error('Mandatory PostgreSQL URL missing');
    if (this.databaseUrl) {
      if (!/^wazir_.*_test$/.test(new URL(this.databaseUrl).pathname.slice(1))) throw new Error('Use a dedicated wazir_*_test database');
      // A unique schema gives each cluster its own dispatch and credential namespace.
      const schema = `dist_${randomUUID().replaceAll('-', '')}`;
      const admin = createPool({ connectionString: this.databaseUrl });
      try { await admin.query(`CREATE SCHEMA ${schema}`); } finally { await admin.end(); }
      const isolated = new URL(this.databaseUrl);
      isolated.searchParams.set('options', `-c search_path=${schema}`);
      (this as { databaseUrl?: string }).databaseUrl = isolated.toString();
      this.dbPool = createPool({ connectionString: this.databaseUrl });
      await runKvMigration(this.dbPool);
      this.durableStore = new PostgresStore(this.dbPool);
    } else {
      this.durableStore = new JsonFileStore(path.join(this.tempDir, 'wazir.json'));
    }
    this.simulatedInference = await startSimulatedInference();
  }

  get simulated(): SimulatedInferenceServer {
    if (!this.simulatedInference) throw new Error('Simulated inference server not initialized');
    return this.simulatedInference;
  }

  get api(): ApiProcess {
    if (!this.apiProc) throw new Error('API server is not running');
    return this.apiProc;
  }

  get store(): KeyValueStore | undefined {
    return this.durableStore;
  }

  redact(text: string): string {
    let out = text;
    if (this.registrationToken) {
      out = out.replaceAll(this.registrationToken, '[REDACTED_REG_TOKEN]');
    }
    if (this.apiToken) {
      out = out.replaceAll(this.apiToken, '[REDACTED_API_TOKEN]');
    }
    for (const token of this.knownTokens) out = out.replaceAll(token, '[REDACTED_WORKER_TOKEN]');
    return out.replace(/"(?:leaseToken|token)":"[^"]+"/g, '"token":"[REDACTED]"');
  }

  async startApi(): Promise<ApiProcess> {
    if (this.apiProc) return this.apiProc;

    if (!this.port) this.port = await new Promise<number>((resolve, reject) => {
      const socket = createServer(); socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => { const port = (socket.address() as AddressInfo).port; socket.close(() => resolve(port)); });
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ROOK_OLLAMA_URL: this.simulated.baseUrl,
      WAZIR_OLLAMA_URL: this.simulated.baseUrl,
      ROOK_LMSTUDIO_URL: 'http://127.0.0.1:1/v1',
      WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1/v1',
      WAZIR_LMS_DISABLE: '1',
      PORT: String(this.port),
      WAZIR_HOST: '127.0.0.1',
      WAZIR_HOME: this.tempDir,
      WAZIR_REGISTRATION_TOKEN: this.registrationToken,
      WAZIR_API_TOKEN: this.apiToken,
    };

    delete env.WAZIR_ALLOW_UNAUTHENTICATED;
    delete env.WAZIR_TLS_CERT; delete env.WAZIR_TLS_KEY;
    if (this.databaseUrl) {
      env.WAZIR_DATABASE_URL = this.databaseUrl;
      delete env.WAZIR_IN_MEMORY;
    } else {
      delete env.WAZIR_DATABASE_URL;
      delete env.WAZIR_IN_MEMORY;
    }

    const child = spawn(process.execPath, [this.apiDistPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.children.push(child);
    const logs: string[] = [];
    this.processLogs.push({ pid: child.pid, logs });
    this.evidence.push({ event: 'spawn', pid: child.pid, at: Date.now() });
    child.once('exit', (code, signal) => this.evidence.push({ event: 'exit', pid: child.pid, code, signal, at: Date.now() }));
    let detectedPort: number | undefined;

    const portRegex = /wazir-api listening.*http:\/\/127\.0\.0\.1:(\d+)/;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Timeout waiting for API to start. Logs:\n${logs.join('\n')}`));
      }, 10_000);

      const onData = (data: Buffer) => {
        const text = data.toString('utf8');
        logs.push(this.redact(text));
        const match = text.match(portRegex);
        if (match && match[1]) {
          detectedPort = Number(match[1]);
          clearTimeout(timeout);
          resolve();
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', (d) => logs.push(this.redact(d.toString('utf8'))));

      child.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.once('exit', (code, sig) => {
        clearTimeout(timeout);
        reject(new Error(`API exited prematurely with code=${code} sig=${sig}. Logs:\n${logs.join('\n')}`));
      });
    });

    if (!detectedPort || !child.pid) {
      throw new Error('Failed to resolve API port or PID');
    }

    const apiUrl = `http://127.0.0.1:${detectedPort}`;

    // Poll /health until 200 OK
    await this.pollUntil(
      async () => {
        try {
          const res = await fetch(`${apiUrl}/health`);
          return res.ok;
        } catch {
          return false;
        }
      },
      5000,
      100,
      'API /health readiness',
    );

    this.apiProc = {
      pid: child.pid,
      port: detectedPort,
      url: apiUrl,
      process: child,
      logs,
    };

    return this.apiProc;
  }

  async stopApi(signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
    if (!this.apiProc) return null;
    const proc = this.apiProc.process;
    this.apiProc = undefined;

    return new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 2000);

      proc.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });

      proc.kill(signal);
    });
  }

  async restartApi(): Promise<ApiProcess> {
    await this.stopApi('SIGKILL');
    return this.startApi();
  }

  async startWorker(options: {
    computerId: string;
    name?: string;
    token?: string;
    registrationToken?: string;
  }): Promise<WorkerProcess> {
    const api = await this.startApi();
    const computerId = options.computerId;
    if (options.token) this.knownTokens.add(options.token);
    const name = options.name ?? `worker-${computerId}`;
    const regToken = options.registrationToken ?? this.registrationToken;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ROOK_OLLAMA_URL: this.simulated.baseUrl,
      WAZIR_OLLAMA_URL: this.simulated.baseUrl,
      ROOK_LMSTUDIO_URL: 'http://127.0.0.1:54329/v1', // unreachable fallback
      WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:54329/v1',
      WAZIR_LMS_DISABLE: '1',
      WAZIR_REGISTRATION_TOKEN: regToken,
      WAZIR_HOME: path.join(this.tempDir, computerId),
    };

    delete env.WAZIR_WORKER_TOKEN;
    delete env.WAZIR_DATABASE_URL;
    delete env.WAZIR_IN_MEMORY;
    delete env.WAZIR_ALLOW_UNAUTHENTICATED;
    await fs.mkdir(env.WAZIR_HOME!, { recursive: true });
    if (options.token) {
      env.WAZIR_WORKER_TOKEN = options.token;
    }

    const args = [
      this.workerDistPath,
      '--server', api.url,
      '--computer', computerId,
      '--name', name,
    ];

    const child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.children.push(child);
    const logs: string[] = [];
    this.processLogs.push({ pid: child.pid, logs });
    this.evidence.push({ event: 'spawn', pid: child.pid, at: Date.now() });
    child.once('exit', (code, signal) => this.evidence.push({ event: 'exit', pid: child.pid, code, signal, at: Date.now() }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Timeout waiting for worker ${computerId} to come online. Logs:\n${logs.join('\n')}`));
      }, 10_000);

      const onData = (data: Buffer) => {
        const text = data.toString('utf8');
        logs.push(this.redact(text));
        if (text.includes('online') || text.includes('waiting for work')) {
          clearTimeout(timeout);
          resolve();
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', (d) => logs.push(this.redact(d.toString('utf8'))));

      child.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.once('exit', (code, sig) => {
        clearTimeout(timeout);
        reject(new Error(`Worker ${computerId} exited prematurely with code=${code} sig=${sig}. Logs:\n${logs.join('\n')}`));
      });
    });

    // Wait until registered in API
    await this.pollUntil(
      async () => {
        const computers = await this.getComputers();
        const found = computers.find((c: any) => c.id === computerId);
        return found && found.status === 'online';
      },
      5000,
      100,
      `Worker ${computerId} registration in control plane`,
    );

    const workerObj: WorkerProcess = {
      id: computerId,
      computerId,
      pid: child.pid!,
      process: child,
      logs,
      token: options.token,
    };

    if (this.workers.has(computerId)) throw new Error('Stop the old process before replacing a worker');
    this.workers.set(computerId, workerObj);
    // The controller exposes stream readiness through dispatch's connected field.
    // Registration output alone does not prove SSE is attached.
    return workerObj;
  }

  getWorker(computerId: string): WorkerProcess | undefined {
    return this.workers.get(computerId);
  }

  async killWorker(computerId: string, signal: NodeJS.Signals = 'SIGKILL'): Promise<number | null> {
    const worker = this.workers.get(computerId);
    if (!worker) return null;
    this.workers.delete(computerId);

    return new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        worker.process.kill('SIGKILL');
      }, 2000);

      worker.process.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });

      worker.process.kill(signal);
    });
  }

  async dispatchTask(
    computerId: string,
    request: { requestId: string; executionId: string; modelId?: string; messages?: any[] },
    waitMs = 0,
  ): Promise<{ status: number; body: any }> {
    const api = await this.startApi();
    const payload = {
      computerId,
      request: {
        requestId: request.requestId,
        executionId: request.executionId,
        modelId: request.modelId ?? 'simulated-test-model:latest',
        messages: request.messages ?? [{ role: 'user', content: 'test payload' }],
      },
    };

    const res = await fetch(`${api.url}/api/v1/tasks/dispatch?wait=${waitMs}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));
    const route = res.url.replace(api.url, '');
    const safeBody = this.redact(JSON.stringify(body));
    if (!route.endsWith('/status') || this.lastResponses.get(route) !== safeBody) {
      this.evidence.push({ event: 'http', url: route, status: res.status, body: JSON.parse(safeBody), at: Date.now() });
      this.lastResponses.set(route, safeBody);
    }
    return { status: res.status, body };
  }

  async getTaskStatus(requestId: string): Promise<{ status: number; body: any }> {
    const api = await this.startApi();
    const res = await fetch(`${api.url}/api/v1/tasks/${encodeURIComponent(requestId)}/status`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    const body = await res.json().catch(() => ({}));
    const route = res.url.replace(api.url, '');
    const safeBody = this.redact(JSON.stringify(body));
    if (!route.endsWith('/status') || this.lastResponses.get(route) !== safeBody) {
      this.evidence.push({ event: 'http', url: route, status: res.status, body: JSON.parse(safeBody), at: Date.now() });
      this.lastResponses.set(route, safeBody);
    }
    return { status: res.status, body };
  }

  async getComputers(): Promise<any[]> {
    const api = await this.startApi();
    const res = await fetch(`${api.url}/api/v1/computers`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { computers?: any[] };
    return data.computers ?? [];
  }

  async claim(
    computerId: string,
    requestId: string,
    bearerToken?: string,
  ): Promise<{ status: number; body: any }> {
    const api = await this.startApi();
    const token = bearerToken ?? this.workers.get(computerId)?.token;
    const res = await fetch(
      `${api.url}/computers/${encodeURIComponent(computerId)}/executions/${encodeURIComponent(requestId)}/claim`,
      {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
    const body = await res.json().catch(() => ({}));
    const route = res.url.replace(api.url, '');
    const safeBody = this.redact(JSON.stringify(body));
    if (!route.endsWith('/status') || this.lastResponses.get(route) !== safeBody) {
      this.evidence.push({ event: 'http', url: route, status: res.status, body: JSON.parse(safeBody), at: Date.now() });
      this.lastResponses.set(route, safeBody);
    }
    return { status: res.status, body };
  }

  async renew(
    computerId: string,
    requestId: string,
    leaseToken: string,
    bearerToken?: string,
  ): Promise<{ status: number; body: any }> {
    const api = await this.startApi();
    const token = bearerToken ?? this.workers.get(computerId)?.token;
    const res = await fetch(
      `${api.url}/computers/${encodeURIComponent(computerId)}/executions/${encodeURIComponent(requestId)}/renew`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ leaseToken }),
      },
    );
    const body = await res.json().catch(() => ({}));
    const route = res.url.replace(api.url, '');
    const safeBody = this.redact(JSON.stringify(body));
    if (!route.endsWith('/status') || this.lastResponses.get(route) !== safeBody) {
      this.evidence.push({ event: 'http', url: route, status: res.status, body: JSON.parse(safeBody), at: Date.now() });
      this.lastResponses.set(route, safeBody);
    }
    return { status: res.status, body };
  }

  async reportResult(
    computerId: string,
    requestId: string,
    outcome: { ok: boolean; output: string; [key: string]: any },
    leaseToken: string,
    bearerToken?: string,
  ): Promise<{ status: number; body: any }> {
    const api = await this.startApi();
    const token = bearerToken ?? this.workers.get(computerId)?.token;
    const res = await fetch(
      `${api.url}/computers/${encodeURIComponent(computerId)}/executions/${encodeURIComponent(requestId)}/result`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...outcome, leaseToken }),
      },
    );
    const body = await res.json().catch(() => ({}));
    const route = res.url.replace(api.url, '');
    const safeBody = this.redact(JSON.stringify(body));
    if (!route.endsWith('/status') || this.lastResponses.get(route) !== safeBody) {
      this.evidence.push({ event: 'http', url: route, status: res.status, body: JSON.parse(safeBody), at: Date.now() });
      this.lastResponses.set(route, safeBody);
    }
    return { status: res.status, body };
  }

  async pollUntil(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs: number,
    intervalMs = 100,
    description = 'condition',
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await predicate()) return;
      } catch {
        // continue polling
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
  }

  async waitForExpiry(requestId: string): Promise<void> {
    await this.pollUntil(async () => {
      const record = await this.store!.get<any>(`dispatch/${requestId}`);
      return record?.lease?.expiresAt <= Date.now();
    }, 40_000, 50, 'authoritative lease expiration');
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve()); child.kill('SIGKILL');
    })));
    this.workers.clear(); this.apiProc = undefined;
    await this.simulatedInference?.close();
    await this.dbPool?.end();
    const destination = path.resolve(process.env.WAZIR_DISTRIBUTED_EVIDENCE ?? 'test-results/distributed', path.basename(this.tempDir));
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'evidence.json'), this.redact(JSON.stringify(this.evidence, null, 2)));
    for (const entry of this.processLogs) await fs.writeFile(path.join(destination, `${entry.pid}.log`), this.redact(entry.logs.join('')));
    await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}
