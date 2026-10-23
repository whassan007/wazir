import { ComputerRegistry, ModelRegistry, RuntimeRegistry, type ModelRecord } from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import type { ProbeAdapter, ProbeGenerationEvent, ProbeGenerationRequest, ReadinessRecord } from '../../src/routing/index.js';

export const caps = {
  chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false,
  reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false,
};

export function model(id: string, extra: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id, name: id, provider: 'ollama', family: /qwen/i.test(id) ? 'qwen' : 'other', contextMax: 32768, capabilities: ['generalChat', 'coding'],
    toolCalling: false, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
    runtimeCompatibility: ['ollama'], local: true, createdAt: new Date(0), updatedAt: new Date(0), ...extra,
  };
}

export interface Fleet {
  models: ModelRegistry;
  runtimes: RuntimeRegistry;
  computers: ComputerRegistry;
  store: MemoryStore;
  now: { t: number };
  clock: () => Date;
}

export function fleet(): Fleet {
  const models = new ModelRegistry();
  const runtimes = new RuntimeRegistry();
  const computers = new ComputerRegistry();
  computers.register({
    id: 'local', name: 'Local', type: 'workstation', local: true,
    os: { platform: 'darwin', architecture: 'arm64', version: '1' },
    hardware: { cpu: 'm', cpuCores: 8, memoryGB: 64 }, runtimes: ['ollama', 'lmstudio'],
  });
  computers.register({
    id: 'remote', name: 'Remote', type: 'remote-worker', local: false,
    os: { platform: 'linux', architecture: 'x64', version: '1' },
    hardware: { cpu: 'x', cpuCores: 16, memoryGB: 128 }, runtimes: ['ollama-remote'],
  });
  runtimes.register({ id: 'ollama', type: 'ollama', name: 'Ollama', version: '1', computerId: 'local', capabilities: caps });
  runtimes.setHealth('ollama', 'healthy');
  runtimes.register({ id: 'lmstudio', type: 'lmstudio', name: 'LM Studio', version: '1', computerId: 'local', capabilities: caps });
  runtimes.setHealth('lmstudio', 'healthy');
  runtimes.register({ id: 'ollama-remote', type: 'ollama', name: 'Ollama remote', version: '1', computerId: 'remote', capabilities: caps });
  runtimes.setHealth('ollama-remote', 'healthy');
  runtimes.register({ id: 'anthropic', type: 'anthropic', name: 'Anthropic', version: '1', runtimeKind: 'hosted', capabilities: caps });
  runtimes.setHealth('anthropic', 'healthy');
  const now = { t: Date.parse('2026-10-22T12:00:00.000Z') };
  return { models, runtimes, computers, store: new MemoryStore(), now, clock: () => new Date(now.t) };
}

export function addLocal(f: Fleet, id: string, opts: { runtimeId?: string; computerId?: string; loaded?: boolean; state?: any; extra?: Partial<ModelRecord>; contextTokens?: number } = {}) {
  f.models.register(model(id, opts.extra));
  const runtimeId = opts.runtimeId ?? 'ollama';
  const loaded = opts.loaded ?? true;
  return f.models.upsertInstance({
    id: `${id}@${runtimeId}`, modelId: id, runtimeId, computerId: opts.computerId ?? 'local', runtimeModelId: `rt-${id}`,
    loaded, state: opts.state ?? (loaded ? 'READY' : 'INSTALLED'), health: 'healthy', contextTokens: opts.contextTokens,
  });
}

export function addHosted(f: Fleet, id: string) {
  f.models.register(model(id, { provider: 'anthropic', runtimeCompatibility: ['anthropic'], local: false, toolCalling: true }));
  return f.models.upsertInstance({ id: `${id}@anthropic`, modelId: id, runtimeId: 'anthropic', runtimeModelId: id, loaded: true, state: 'READY', health: 'healthy' });
}

export function ready(f: Fleet, modelId: string, instanceId: string, extra: Partial<ReadinessRecord> = {}): ReadinessRecord {
  return {
    modelId, instanceId, runtimeId: instanceId.split('@')[1] ?? 'ollama', ready: true, checkedAt: new Date(f.now.t).toISOString(),
    latencyMs: 100, source: 'probe', generation: 'verified', toolUse: 'untested', reason: 'test', ...extra,
  };
}

type Script = (req: ProbeGenerationRequest) => ProbeGenerationEvent[] | Promise<ProbeGenerationEvent[]> | 'hang';

/** Fake runtime adapter: records every request, replays scripted events. */
export class FakeAdapter implements ProbeAdapter {
  readonly requests: ProbeGenerationRequest[] = [];
  constructor(public script: Script, readonly type = 'ollama', readonly id = 'fake') {}
  async *generate(req: ProbeGenerationRequest): AsyncIterable<ProbeGenerationEvent> {
    this.requests.push(req);
    const events = await this.script(req);
    if (events === 'hang') {
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()));
      return;
    }
    for (const e of events) yield e;
  }
}

export const okScript: Script = (req) =>
  req.tools ? [{ type: 'tool_call', toolName: req.tools[0].name, toolInput: { status: 'ok' } }, { type: 'completed' }] : [{ type: 'token', content: 'OK' }, { type: 'completed' }];
