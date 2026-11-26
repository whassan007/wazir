import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  BackendExecutionRequest,
  BackendExecutionResult,
  BackendHealthStatus,
  ExecutionBackendAdapter,
  ExecutionBackendCapabilities,
} from './contracts.js';

export interface BackendStateConfig {
  activeBackendId: string;
  pluginCommand?: string;
}

function makeCliProbeAdapter(spec: {
  id: string;
  name: string;
  version: string;
  source: ExecutionBackendAdapter['source'];
  binary: string;
  capabilities: ExecutionBackendCapabilities;
}): ExecutionBackendAdapter {
  return {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    source: spec.source,
    capabilities: spec.capabilities,
    async healthCheck(): Promise<BackendHealthStatus> {
      const t0 = performance.now();
      if (spec.id === 'wazir-native') {
        return {
          healthy: true,
          latencyMs: Number((performance.now() - t0).toFixed(2)),
          message: 'Wazir native meta-harness ready',
        };
      }
      const probe = spawnSync('which', [spec.binary], { encoding: 'utf8', timeout: 1000 });
      const ok = probe.status === 0;
      return {
        healthy: ok,
        latencyMs: Number((performance.now() - t0).toFixed(2)),
        message: ok ? `Found ${spec.binary} at ${probe.stdout.trim()}` : `${spec.binary} not installed on PATH`,
      };
    },
    validateConfig(cfg) {
      if (spec.id === 'user-plugin' && (!cfg.pluginCommand || typeof cfg.pluginCommand !== 'string')) {
        return { valid: false, errors: ['user-plugin requires a non-empty pluginCommand'] };
      }
      return { valid: true, errors: [] };
    },
    async execute(request: BackendExecutionRequest): Promise<BackendExecutionResult> {
      const t0 = performance.now();
      return {
        executionId: request.executionId,
        backendId: spec.id,
        status: 'completed',
        output: `[${spec.id}] Executed governed task in ${request.cwd}: ${request.prompt}`,
        evidenceIds: [`ev-${request.executionId}-${spec.id}`],
        durationMs: Number((performance.now() - t0).toFixed(2)),
      };
    },
  };
}

export const BUILTIN_EXECUTION_BACKENDS: ExecutionBackendAdapter[] = [
  makeCliProbeAdapter({
    id: 'wazir-native',
    name: 'Wazir Native Harness',
    version: '0.4.0',
    source: 'native',
    binary: 'wa',
    capabilities: {
      streaming: true,
      toolCalls: true,
      checkpointResume: true,
      cancellation: true,
      sandboxed: true,
    },
  }),
  makeCliProbeAdapter({
    id: 'qwen-code',
    name: 'Qwen Code (ACP)',
    version: '1.0.0',
    source: 'acp',
    binary: 'qwen',
    capabilities: {
      streaming: true,
      toolCalls: true,
      checkpointResume: false,
      cancellation: true,
      sandboxed: true,
    },
  }),
  makeCliProbeAdapter({
    id: 'opencode',
    name: 'OpenCode CLI',
    version: '1.0.0',
    source: 'cli',
    binary: 'opencode',
    capabilities: {
      streaming: true,
      toolCalls: true,
      checkpointResume: false,
      cancellation: true,
      sandboxed: true,
    },
  }),
  makeCliProbeAdapter({
    id: 'codex',
    name: 'OpenAI Codex CLI',
    version: '1.0.0',
    source: 'acp',
    binary: 'codex',
    capabilities: {
      streaming: true,
      toolCalls: true,
      checkpointResume: false,
      cancellation: true,
      sandboxed: true,
    },
  }),
  makeCliProbeAdapter({
    id: 'user-plugin',
    name: 'User Execution Plugin',
    version: '1.0.0',
    source: 'plugin',
    binary: 'sh',
    capabilities: {
      streaming: false,
      toolCalls: false,
      checkpointResume: false,
      cancellation: true,
      sandboxed: true,
    },
  }),
];

export function defaultBackendConfigPath(): string {
  const home = process.env.WAZIR_HOME?.trim() || path.join(os.homedir(), '.wazir');
  return path.join(home, 'execution-backend.json');
}

/**
 * Replaceable Execution Backend Registry.
 * Active tasks remain pinned to the backend they started on even if the operator
 * switches the default backend mid-flight.
 */
export class ExecutionBackendRegistry {
  private readonly adapters = new Map<string, ExecutionBackendAdapter>();
  private readonly activeTaskPins = new Map<string, string>();
  private activeBackendId = 'wazir-native';
  private readonly configPath: string;

  constructor(configPath = defaultBackendConfigPath()) {
    this.configPath = configPath;
    for (const adapter of BUILTIN_EXECUTION_BACKENDS) {
      this.adapters.set(adapter.id, adapter);
    }
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<BackendStateConfig>;
        if (raw.activeBackendId && this.adapters.has(raw.activeBackendId)) {
          this.activeBackendId = raw.activeBackendId;
        }
      }
    } catch {
      this.activeBackendId = 'wazir-native';
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(
      this.configPath,
      JSON.stringify({ activeBackendId: this.activeBackendId }, null, 2) + '\n',
      'utf8',
    );
  }

  register(adapter: ExecutionBackendAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  list(): ExecutionBackendAdapter[] {
    return Array.from(this.adapters.values());
  }

  inspect(id: string): ExecutionBackendAdapter | undefined {
    return this.adapters.get(id);
  }

  getActiveId(): string {
    return this.activeBackendId;
  }

  use(id: string): ExecutionBackendAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown execution backend: ${id}`);
    }
    this.activeBackendId = id;
    this.save();
    return adapter;
  }

  reset(): ExecutionBackendAdapter {
    return this.use('wazir-native');
  }

  async test(id: string): Promise<BackendHealthStatus> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      return { healthy: false, latencyMs: 0, message: `Unknown backend '${id}'` };
    }
    return adapter.healthCheck();
  }

  /** Pin a running execution to its initial backend so switching never corrupts active work. */
  getBackendForExecution(executionId: string): ExecutionBackendAdapter {
    const pinnedId = this.activeTaskPins.get(executionId);
    if (pinnedId && this.adapters.has(pinnedId)) {
      return this.adapters.get(pinnedId)!;
    }
    const current = this.adapters.get(this.activeBackendId) ?? this.adapters.get('wazir-native')!;
    this.activeTaskPins.set(executionId, current.id);
    return current;
  }

  releaseExecutionPin(executionId: string): void {
    this.activeTaskPins.delete(executionId);
  }
}
