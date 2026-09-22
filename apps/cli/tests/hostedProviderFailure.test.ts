import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRegistry, ModelRegistry, PolicyEngine, RuntimeRegistry, Scheduler } from '@wazir/core';
import { createSecretBroker } from '@wazir/secrets';
import { applyHostedProvider, createHostedProviders } from '../src/hostedProviders.js';

// #16: a hosted provider being unauthenticated/unreachable must never affect
// local model registration or scheduling — hostedProviders.ts only ever
// touches its own runtime/model rows (registerHostedModel), never the local
// discovery path (registerModel in engine.ts), so this is a structural
// guarantee, not just a lucky test outcome.
describe('Hosted provider failure isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#16 an unauthenticated hosted provider does not prevent local models from registering or scheduling', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-hostedfail-'));
    const secretBroker = await createSecretBroker({ secretsDir: dir });
    const config = { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] };

    const computers = new ComputerRegistry();
    computers.register({ id: 'local', name: 'local', type: 'workstation', local: true, os: { platform: 'linux', architecture: 'x64', version: '1' }, hardware: { cpu: 'x', cpuCores: 4, memoryGB: 16 } });
    const runtimes = new RuntimeRegistry();
    runtimes.register({ id: 'ollama', type: 'ollama', name: 'Ollama', version: '1', computerId: 'local', capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false } });
    runtimes.update('ollama', { health: 'healthy' });

    const models = new ModelRegistry();
    models.register({
      id: 'local-model', name: 'local-model', provider: 'ollama', family: 'qwen', contextMax: 32768,
      capabilities: ['generalChat'], toolCalling: true, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
      runtimeCompatibility: ['ollama'], local: true, createdAt: new Date(), updatedAt: new Date(),
    });
    models.upsertInstance({ id: 'local-model::local::ollama', modelId: 'local-model', computerId: 'local', runtimeId: 'ollama', runtimeModelId: 'local-model', loaded: true, health: 'healthy' });

    const policy = new PolicyEngine({ projectRoot: dir });
    const scheduler = new Scheduler({ computers, runtimes, models, policy });

    // Hosted providers never authenticated (no fetch stub — any accidental
    // network call would surface as a rejected promise, which
    // applyHostedProvider must swallow into an 'unavailable' health state).
    const hostedAdapters = createHostedProviders(config as any, secretBroker);
    for (const [id, adapter] of hostedAdapters) {
      await applyHostedProvider(id, adapter, { runtimes, models, config: config as any });
    }

    // Local models are completely unaffected.
    expect(models.get('local-model')).toBeDefined();
    const decision = scheduler.plan({ task: { id: 't1', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() } as any });
    expect(decision.modelId).toBe('local-model');
    expect(decision.computerId).toBe('local');

    // The hosted runtimes are registered but correctly marked unavailable —
    // not silently dropped, not crashing anything else.
    for (const id of ['anthropic', 'openai', 'google']) {
      expect(runtimes.get(id)?.health).toBe('unavailable');
      expect(runtimes.get(id)?.runtimeKind).toBe('hosted');
    }
  });

  it('a hosted provider whose model discovery throws mid-request degrades gracefully, not fatally', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-hostedfail2-'));
    const secretBroker = await createSecretBroker({ secretsDir: dir });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    // Seed a valid-looking stored credential so status() reports authenticated,
    // forcing applyHostedProvider into the discoverModels() try/catch branch.
    await secretBroker.putCredential('anthropic', JSON.stringify({ provider: 'anthropic', method: 'api-key', credential: { kind: 'api-key', apiKey: 'sk-ant-x' }, obtainedAt: new Date().toISOString() }));

    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const config = { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] };
    const hostedAdapters = createHostedProviders(config as any, secretBroker);

    await expect(applyHostedProvider('anthropic', hostedAdapters.get('anthropic')!, { runtimes, models, config: config as any })).resolves.not.toThrow();

    expect(runtimes.get('anthropic')?.health).toBe('degraded');
  });
});
