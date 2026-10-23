import { describe, it, expect, vi } from 'vitest';
import { ModelLifecycleService, formatReadinessBlock } from '../src/services/modelLifecycleService.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { ModelLifecycleError } from '../src/types/modelLifecycle.js';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';

const G = 1024 ** 3;

interface TestFixtureOptions {
  freeMemoryGB?: number;
  totalMemoryGB?: number;
  runtimeHealthy?: boolean;
  loadDelayMs?: number;
}

function createFixture(opts: TestFixtureOptions = {}) {
  const freeGB = opts.freeMemoryGB ?? 64;
  const totalGB = opts.totalMemoryGB ?? 128;
  const computers = new ComputerRegistry();
  computers.register({
    id: 'mac-studio',
    name: 'Mac Studio M2',
    type: 'workstation',
    local: true,
    os: { platform: 'darwin', architecture: 'arm64', version: '14.0' },
    hardware: {
      cpu: 'Apple M2 Ultra',
      cpuCores: 24,
      memoryGB: totalGB,
      gpu: { vendor: 'apple', model: 'Apple M2 Ultra GPU', memoryGB: totalGB, unifiedMemory: true },
    },
  });

  const updateMemory = (free: number) => {
    computers.heartbeat('mac-studio', {
      load: {
        cpuPercent: 10,
        memoryUsedGB: Math.max(0, totalGB - free),
        memoryAvailableGB: free,
      },
    });
  };
  updateMemory(freeGB);

  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const executions = new ExecutionEngine();

  const caps = {
    chat: true,
    streaming: true,
    toolCalling: true,
    structuredOutput: false,
    vision: true,
    embeddings: false,
    reasoning: true,
    modelLoad: true,
    modelUnload: true,
    modelDownload: false,
    statefulChat: false,
    mcp: false,
  };

  runtimes.register({
    id: 'local-mlx',
    type: 'mlx',
    name: 'MLX Local Runtime',
    version: '0.1.0',
    computerId: 'mac-studio',
    capabilities: caps,
  });
  runtimes.update('local-mlx', { health: opts.runtimeHealthy !== false ? 'healthy' : 'unavailable' });

  // Hosted runtime for API models
  runtimes.register({
    id: 'anthropic-api',
    type: 'anthropic',
    name: 'Anthropic Claude API',
    runtimeKind: 'hosted',
    capabilities: caps,
  });
  runtimes.update('anthropic-api', { health: 'healthy' });

  const loadedContexts = new Map<string, number>();

  const fakeLocalAdapter = {
    id: 'local-mlx',
    type: 'mlx',
    discover: async () => ({ id: 'local-mlx', name: 'MLX', version: '0.1.0' }),
    healthCheck: async () => ({ status: opts.runtimeHealthy !== false ? 'healthy' : 'unavailable' }),
    getCapabilities: async () => caps,
    listModels: async () => models.list().map((m) => ({ id: m.id, contextWindow: m.contextMax })),
    estimateModelLoad: vi.fn(async (modelId: string, _ctx: number) => {
      const isHeavy = modelId.includes('heavy') || modelId.includes('27b') || modelId.includes('70b');
      return {
        totalMemoryBytes: (isHeavy ? 22 : 6) * G,
        source: 'RUNTIME' as const,
        confidence: 'high' as const,
      };
    }),
    loadModel: vi.fn(async (id: string, loadOpts?: { contextTokens?: number }) => {
      if (opts.loadDelayMs && opts.loadDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.loadDelayMs));
      }
      loadedContexts.set(id, loadOpts?.contextTokens ?? 32768);
    }),
    unloadModel: vi.fn(async (id: string) => {
      loadedContexts.delete(id);
    }),
    inspectModel: vi.fn(async (id: string) => ({
      modelId: id,
      loaded: loadedContexts.has(id),
      effectiveContext: loadedContexts.get(id) ?? 32768,
      memoryBytes: 6 * G,
    })),
    probeModel: vi.fn(async () => true),
    async *generate() {
      yield { type: 'completed', content: 'ok' };
    },
  } as unknown as RuntimeAdapter;

  const fakeHostedAdapter = {
    id: 'anthropic-api',
    type: 'anthropic',
    discover: async () => ({ id: 'anthropic-api', name: 'Anthropic', version: '1.0.0' }),
    healthCheck: async () => ({ status: 'healthy' }),
    getCapabilities: async () => caps,
    listModels: async () => [{ id: 'claude-3-5-sonnet', contextWindow: 200000 }],
    loadModel: vi.fn(async () => {
      throw new Error('Hosted models cannot be locally loaded');
    }),
    unloadModel: vi.fn(async () => {}),
    inspectModel: vi.fn(async (id: string) => ({ modelId: id, loaded: true, effectiveContext: 200000 })),
    probeModel: vi.fn(async () => true),
    async *generate() {
      yield { type: 'completed', content: 'hosted ok' };
    },
  } as unknown as RuntimeAdapter;

  const adapters = new Map<string, RuntimeAdapter>([
    ['local-mlx', fakeLocalAdapter],
    ['anthropic-api', fakeHostedAdapter],
  ]);

  const service = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    executions,
    adapters,
    policy: new PolicyEngine({ projectRoot: '/tmp' }),
  });

  const registerModel = (cfg: {
    id: string;
    local?: boolean;
    runtimeId?: string;
    computerId?: string;
    parameters?: string;
    minSystemGB?: number;
    contextMax?: number;
    loaded?: boolean;
    pinned?: boolean;
  }) => {
    const isLocal = cfg.local !== false;
    const runtimeId = cfg.runtimeId ?? (isLocal ? 'local-mlx' : 'anthropic-api');
    const computerId = isLocal ? (cfg.computerId ?? 'mac-studio') : undefined;

    models.register({
      id: cfg.id,
      name: cfg.id,
      provider: runtimeId,
      family: 'other',
      parameters: cfg.parameters ?? '8B',
      contextMax: cfg.contextMax ?? 32768,
      capabilities: ['generalChat', 'toolCalling'],
      toolCalling: true,
      structuredOutput: false,
      vision: true,
      audio: false,
      embedding: false,
      reasoning: true,
      memory: cfg.minSystemGB ? { minSystemGB: cfg.minSystemGB } : undefined,
      runtimeCompatibility: [isLocal ? 'mlx' : 'anthropic'],
      local: isLocal,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (isLocal && computerId) {
      models.upsertInstallation({
        id: `${cfg.id}::${computerId}::${runtimeId}`,
        modelId: cfg.id,
        computerId,
        runtimeId,
        runtimeModelId: cfg.id,
        installed: true,
        observedAt: new Date(),
      });

      const loaded = cfg.loaded ?? false;
      if (loaded) {
        loadedContexts.set(cfg.id, cfg.contextMax ?? 32768);
      }

      models.upsertInstance({
        id: `${cfg.id}::${computerId}::${runtimeId}`,
        installationId: `${cfg.id}::${computerId}::${runtimeId}`,
        modelId: cfg.id,
        computerId,
        runtimeId,
        runtimeModelId: cfg.id,
        loaded,
        state: loaded ? 'READY' : 'INSTALLED',
        health: 'healthy',
        contextTokens: loaded ? (cfg.contextMax ?? 32768) : undefined,
        pinned: cfg.pinned ?? false,
      });
    }
  };

  return {
    service,
    models,
    runtimes,
    computers,
    executions,
    localAdapter: fakeLocalAdapter,
    hostedAdapter: fakeHostedAdapter,
    loadedContexts,
    registerModel,
    updateMemory,
  };
}

describe('ModelLoadingLifecycle Service Enhancement', () => {
  describe('1. Loaded-model reuse', () => {
    it('immediately reuses an already loaded/READY model with 0 adapter load calls and emits Ready progress', async () => {
      const f = createFixture();
      f.registerModel({ id: 'qwen-8b', loaded: true, contextMax: 32768 });

      const progressMessages: string[] = [];
      const result = await f.service.ensureModelReadyForTask({
        modelId: 'qwen-8b',
        computerId: 'mac-studio',
        requiredContextTokens: 8192,
        onProgress: (msg) => progressMessages.push(msg),
      });

      expect(result.reused).toBe(true);
      expect(result.modelId).toBe('qwen-8b');
      expect(result.computerId).toBe('mac-studio');
      expect(result.effectiveContext).toBe(32768);
      expect(f.localAdapter.loadModel).not.toHaveBeenCalled();
      expect(progressMessages).toContain('Ready: qwen-8b');
    });

    it('immediately reuses hosted API models without invoking local loadModel', async () => {
      const f = createFixture();
      f.registerModel({ id: 'claude-3-5-sonnet', local: false, runtimeId: 'anthropic-api', contextMax: 200000 });

      const progressMessages: string[] = [];
      const result = await f.service.ensureModelReadyForTask({
        modelId: 'claude-3-5-sonnet',
        requiredContextTokens: 16384,
        onProgress: (msg) => progressMessages.push(msg),
      });

      expect(result.reused).toBe(true);
      expect(result.modelId).toBe('claude-3-5-sonnet');
      expect(f.hostedAdapter.loadModel).not.toHaveBeenCalled();
      expect(f.localAdapter.loadModel).not.toHaveBeenCalled();
      expect(progressMessages).toContain('Ready: claude-3-5-sonnet');
    });
  });

  describe('2. Compatible unloaded model loading with progress & verification', () => {
    it('loads an unloaded model, emitting Loading -> Ready progress and verifying readiness probe', async () => {
      const f = createFixture();
      f.registerModel({ id: 'gemma-12b', loaded: false, contextMax: 32768 });

      const progressMessages: string[] = [];
      const events: string[] = [];
      f.service.subscribe((e) => events.push(e.type));

      const result = await f.service.ensureModelReadyForTask({
        modelId: 'gemma-12b',
        computerId: 'mac-studio',
        requiredContextTokens: 8192,
        onProgress: (msg) => progressMessages.push(msg),
      });

      expect(result.reused).toBe(false);
      expect(result.modelId).toBe('gemma-12b');
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(1);
      expect(f.localAdapter.inspectModel).toHaveBeenCalled();
      expect(f.localAdapter.probeModel).toHaveBeenCalled();

      // Verified progress messages: Loading ${model} on ${device}... -> Ready: ${model}
      expect(progressMessages.some((msg) => msg.startsWith('Loading gemma-12b on Mac Studio M2...'))).toBe(true);
      expect(progressMessages).toContain('Ready: gemma-12b');

      // Lifecycle events
      expect(events).toContain('MODEL_LOADING');
      expect(events).toContain('MODEL_READY');
      expect(f.service.isModelReady('gemma-12b')).toBe(true);
    });

    it('fails when probeModel readiness verification fails and cleans up adapter', async () => {
      const f = createFixture();
      f.registerModel({ id: 'faulty-model', loaded: false, contextMax: 32768 });

      // Simulate probe failure
      (f.localAdapter.probeModel as any).mockResolvedValueOnce(false);

      await expect(
        f.service.ensureModelReadyForTask({
          modelId: 'faulty-model',
          computerId: 'mac-studio',
        }),
      ).rejects.toThrow();

      expect(f.localAdapter.unloadModel).toHaveBeenCalled();
      expect(f.service.isModelReady('faulty-model')).toBe(false);
      expect(f.service.getModelState('faulty-model')).toBe('FAILED');
    });
  });

  describe('3. Loading timeout handling and failed-load recovery', () => {
    it('enforces timeoutMs around adapter load and recovers on subsequent retry', async () => {
      const f = createFixture();
      f.registerModel({ id: 'slow-model', loaded: false, contextMax: 32768 });

      // First call: adapter hangs for 300ms, timeout is 50ms
      (f.localAdapter.loadModel as any).mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      const err = await f.service
        .ensureModelReadyForTask({
          modelId: 'slow-model',
          computerId: 'mac-studio',
          timeoutMs: 50,
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ModelLifecycleError);
      expect(err.code).toBe('MODEL_LOAD_TIMEOUT');
      expect(f.localAdapter.unloadModel).toHaveBeenCalled();
      expect(f.service.isModelReady('slow-model')).toBe(false);
      expect(f.service.getModelState('slow-model')).toBe('FAILED');

      // Recovery: next attempt succeeds quickly
      (f.localAdapter.loadModel as any).mockImplementationOnce(async (id: string, opts?: { contextTokens?: number }) => {
        f.loadedContexts.set(id, opts?.contextTokens ?? 32768);
      });

      const recovered = await f.service.ensureModelReadyForTask({
        modelId: 'slow-model',
        computerId: 'mac-studio',
        timeoutMs: 1000,
      });

      expect(recovered.reused).toBe(false);
      expect(f.service.isModelReady('slow-model')).toBe(true);
      expect(f.service.getModelState('slow-model')).toBe('READY');
    });
  });

  describe('4. Known-ineligible model circuit breaker protection', () => {
    it('does not repeatedly attempt runtime load on a 22GB model when host has 0.1GB free RAM', async () => {
      // Host has only 0.1GB free RAM
      const f = createFixture({ freeMemoryGB: 0.1, totalMemoryGB: 64 });
      f.registerModel({ id: 'heavy-22gb-model', parameters: '32B', minSystemGB: 22, loaded: false });

      // Attempt 1: Preflight rejection
      let call1Error: any;
      try {
        await f.service.ensureModelReadyForTask({
          modelId: 'heavy-22gb-model',
          computerId: 'mac-studio',
        });
      } catch (e) {
        call1Error = e;
      }

      expect(call1Error).toBeInstanceOf(ModelLifecycleError);
      expect(call1Error.code).toBe('MODEL_ADMISSION_DENIED');
      // Adapter load was NEVER called
      expect(f.localAdapter.loadModel).not.toHaveBeenCalled();

      // Check circuit breaker status
      const status = f.service.isKnownIneligible('heavy-22gb-model');
      expect(status.ineligible).toBe(true);
      expect(status.reason).toBeDefined();

      // Attempt 2: ensureModelReadyForTask fails fast via circuit breaker
      await expect(
        f.service.ensureModelReadyForTask({
          modelId: 'heavy-22gb-model',
          computerId: 'mac-studio',
        }),
      ).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });

      // Attempt 3: ensureLoaded fails fast
      await expect(f.service.ensureLoaded('heavy-22gb-model')).rejects.toMatchObject({
        code: 'MODEL_ADMISSION_DENIED',
      });

      // Attempt 4: load fails fast
      await expect(f.service.load('heavy-22gb-model')).rejects.toMatchObject({
        code: 'MODEL_ADMISSION_DENIED',
      });

      // Crucial: 0 loadModel calls throughout all repeated attempts!
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(0);
    });

    it('respects circuit breaker TTL and manual clearing', async () => {
      const f = createFixture();
      f.service.markIneligible('test-model', 'Insufficient memory', 40);

      expect(f.service.isKnownIneligible('test-model').ineligible).toBe(true);

      // Wait for TTL expiration
      await new Promise((r) => setTimeout(r, 60));
      expect(f.service.isKnownIneligible('test-model').ineligible).toBe(false);

      // Test manual clear
      f.service.markIneligible('test-model-2', 'OOM failure', 60000);
      expect(f.service.isKnownIneligible('test-model-2').ineligible).toBe(true);
      f.service.clearIneligible('test-model-2');
      expect(f.service.isKnownIneligible('test-model-2').ineligible).toBe(false);
    });
  });

  describe('5. Concurrent loading deduplication', () => {
    it('deduplicates simultaneous ensureModelReadyForTask calls to a single adapter load', async () => {
      const f = createFixture({ loadDelayMs: 40 });
      f.registerModel({ id: 'concurrent-model', loaded: false, contextMax: 32768 });

      const [r1, r2, r3] = await Promise.all([
        f.service.ensureModelReadyForTask({ modelId: 'concurrent-model', computerId: 'mac-studio' }),
        f.service.ensureModelReadyForTask({ modelId: 'concurrent-model', computerId: 'mac-studio' }),
        f.service.ensureModelReadyForTask({ modelId: 'concurrent-model', computerId: 'mac-studio' }),
      ]);

      // All 3 resolved
      expect(r1.modelId).toBe('concurrent-model');
      expect(r2.modelId).toBe('concurrent-model');
      expect(r3.modelId).toBe('concurrent-model');

      // Adapter was called EXACTLY ONCE
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(1);

      // Subsequent callers report reused: true
      const reusedCount = [r1.reused, r2.reused, r3.reused].filter(Boolean).length;
      expect(reusedCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('6. Safe idle unloading protecting active and pinned models', () => {
    it('unloads only idle unpinned models, strictly protecting active and pinned models', async () => {
      const f = createFixture();

      // 1. Pinned via instance.pinned = true
      f.registerModel({ id: 'm-pinned-inst', loaded: true, pinned: true });

      // 2. Pinned via pinnedModelIds parameter
      f.registerModel({ id: 'm-pinned-param', loaded: true, pinned: false });

      // 3. Active via active task execution in ExecutionEngine
      f.registerModel({ id: 'm-active-task', loaded: true, pinned: false });
      await f.executions.create({
        task: { id: 'task-123' } as any,
        modelId: 'm-active-task',
        computerId: 'mac-studio',
        runtimeId: 'local-mlx',
      });

      // 4. Active via activeModelIds parameter
      f.registerModel({ id: 'm-active-param', loaded: true, pinned: false });

      // 5. Idle model 1 (eligible for unload)
      f.registerModel({ id: 'm-idle-1', loaded: true, pinned: false });

      // 6. Idle model 2 (eligible for unload)
      f.registerModel({ id: 'm-idle-2', loaded: true, pinned: false });

      const result = await f.service.unloadIdleModels({
        pinnedModelIds: ['m-pinned-param'],
        activeModelIds: ['m-active-param'],
      });

      // Unloaded list must contain only the idle models
      expect(result.unloaded).toContain('m-idle-1');
      expect(result.unloaded).toContain('m-idle-2');
      expect(result.unloaded).not.toContain('m-pinned-inst');
      expect(result.unloaded).not.toContain('m-pinned-param');
      expect(result.unloaded).not.toContain('m-active-task');
      expect(result.unloaded).not.toContain('m-active-param');

      // Skipped lists
      expect(result.skippedPinned).toContain('m-pinned-inst');
      expect(result.skippedPinned).toContain('m-pinned-param');
      expect(result.skippedActive).toContain('m-active-task');
      expect(result.skippedActive).toContain('m-active-param');

      // Verify adapter unload calls: only m-idle-1 and m-idle-2 were unloaded
      expect(f.localAdapter.unloadModel).toHaveBeenCalledWith('m-idle-1');
      expect(f.localAdapter.unloadModel).toHaveBeenCalledWith('m-idle-2');
      expect(f.localAdapter.unloadModel).not.toHaveBeenCalledWith('m-pinned-inst');
      expect(f.localAdapter.unloadModel).not.toHaveBeenCalledWith('m-pinned-param');
      expect(f.localAdapter.unloadModel).not.toHaveBeenCalledWith('m-active-task');
      expect(f.localAdapter.unloadModel).not.toHaveBeenCalledWith('m-active-param');

      // Protected models remain READY
      expect(f.service.isModelReady('m-pinned-inst')).toBe(true);
      expect(f.service.isModelReady('m-pinned-param')).toBe(true);
      expect(f.service.isModelReady('m-active-task')).toBe(true);
      expect(f.service.isModelReady('m-active-param')).toBe(true);

      // Idle models are now unloaded
      expect(f.service.isModelReady('m-idle-1')).toBe(false);
      expect(f.service.isModelReady('m-idle-2')).toBe(false);
    });

    it('respects targetFreeMemoryGB and stops unloading once free memory target is met', async () => {
      // 50GB free out of 128GB
      const f = createFixture({ freeMemoryGB: 50, totalMemoryGB: 128 });
      f.registerModel({ id: 'm-idle-a', loaded: true });
      f.registerModel({ id: 'm-idle-b', loaded: true });

      // Target is 40GB free -> host already has 50GB free!
      const result = await f.service.unloadIdleModels({
        targetFreeMemoryGB: 40,
        computerId: 'mac-studio',
      });

      // No models needed to be unloaded
      expect(result.unloaded).toHaveLength(0);
      expect(f.localAdapter.unloadModel).not.toHaveBeenCalled();
    });
  });

  describe('7. selectAndPrepareLocalModel and readiness details', () => {
    it('reuses an already-loaded local model immediately (reused: true, 0 adapter loads) even when remaining host memory is smaller than weight size, returning exact 4-line formattedReadiness', async () => {
      // Host has 64GB total, but only 0.1GB remaining free RAM!
      const f = createFixture({ freeMemoryGB: 0.1, totalMemoryGB: 64 });
      f.registerModel({
        id: 'qwen-heavy-22gb',
        parameters: '32B',
        minSystemGB: 22,
        loaded: true,
        contextMax: 32768,
      });

      // Synchronous assessment & admission check do NOT double-charge resident memory
      const assessment = f.service.assessModelSync('qwen-heavy-22gb', 'mac-studio');
      expect(assessment.classification).toBe('SAFE');

      const admission = f.service.checkAdmission('qwen-heavy-22gb', 'mac-studio');
      expect(admission.admitted).toBe(true);
      expect(admission.alreadyLoaded).toBe(true);
      expect(admission.classification).toBe('SAFE');

      const progressMessages: string[] = [];
      const result = await f.service.selectAndPrepareLocalModel('qwen-heavy-22gb', {
        onProgress: (m) => progressMessages.push(m),
      });

      expect(result.ok).toBe(true);
      expect(result.reused).toBe(true);
      expect(result.modelId).toBe('qwen-heavy-22gb');
      expect(result.computerId).toBe('mac-studio');
      expect(result.deviceLabel).toBe('Mac Studio M2');
      expect(result.contextTokens).toBe(32768);
      expect(result.status).toBe('Ready');
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(0);
      expect(progressMessages).toContain('Ready: qwen-heavy-22gb');

      // Verify exact 4-line runtime execution block
      const lines = result.formattedReadiness.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('Model: qwen-heavy-22gb');
      expect(lines[1]).toBe('Device: Mac Studio M2');
      expect(lines[2]).toBe('Context: 32768 tokens');
      expect(lines[3]).toBe('Status: Ready');
      expect(result.formattedReadiness).toBe(
        formatReadinessBlock('qwen-heavy-22gb', 'Mac Studio M2', 32768, 'Ready'),
      );
    });

    it('loads a compatible installed local model (reused: false), emits Loading ... -> Ready: ..., verifies readiness, and returns Status: Ready', async () => {
      const f = createFixture({ freeMemoryGB: 64, totalMemoryGB: 128 });
      f.registerModel({ id: 'gemma-12b', loaded: false, contextMax: 32768 });

      const progressMessages: string[] = [];
      const result = await f.service.selectAndPrepareLocalModel('gemma-12b', {
        onProgress: (m) => progressMessages.push(m),
      });

      expect(result.ok).toBe(true);
      expect(result.reused).toBe(false);
      expect(result.modelId).toBe('gemma-12b');
      expect(result.computerId).toBe('mac-studio');
      expect(result.deviceLabel).toBe('Mac Studio M2');
      expect(result.status).toBe('Ready');
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(1);
      expect(f.localAdapter.inspectModel).toHaveBeenCalled();
      expect(f.localAdapter.probeModel).toHaveBeenCalled();
      expect(f.service.isModelReady('gemma-12b')).toBe(true);

      // Verify progress emission sequence: Loading ... -> Ready: ...
      expect(progressMessages.some((msg) => msg.startsWith('Loading gemma-12b on Mac Studio M2...'))).toBe(true);
      expect(progressMessages).toContain('Ready: gemma-12b');

      // Formatted 4-line block
      const lines = result.formattedReadiness.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('Model: gemma-12b');
      expect(lines[1]).toBe('Device: Mac Studio M2');
      expect(lines[2]).toContain('Context:');
      expect(lines[3]).toBe('Status: Ready');
    });

    it('rejects an incompatible 22GB model on 0.1GB RAM before calling adapter loadModel, returning ok: false with a clear memory error', async () => {
      const f = createFixture({ freeMemoryGB: 0.1, totalMemoryGB: 64 });
      f.registerModel({ id: 'heavy-22gb-model', parameters: '32B', minSystemGB: 22, loaded: false });

      const result = await f.service.selectAndPrepareLocalModel('heavy-22gb-model');

      expect(result.ok).toBe(false);
      expect(result.reused).toBe(false);
      expect(result.status).toBe('Failed');
      expect(result.error).toBeDefined();
      expect(result.error?.toLowerCase()).toMatch(/memory|insufficient|required|tier|fit/);
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(0);

      // Circuit breaker is tripped
      expect(f.service.isKnownIneligible('heavy-22gb-model').ineligible).toBe(true);

      // Formatted block reflects Failed status
      const lines = result.formattedReadiness.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('Model: heavy-22gb-model');
      expect(lines[1]).toBe('Device: Mac Studio M2');
      expect(lines[3]).toBe('Status: Failed');
    });

    it('supports loadNow: false for installed compatible models without loading into memory', async () => {
      const f = createFixture({ freeMemoryGB: 64, totalMemoryGB: 128 });
      f.registerModel({ id: 'phi-4-14b', loaded: false, contextMax: 16384 });

      const result = await f.service.selectAndPrepareLocalModel('phi-4-14b', { loadNow: false });

      expect(result.ok).toBe(true);
      expect(result.reused).toBe(false);
      expect(result.status).toBe('Installed (Can load)');
      expect(result.contextTokens).toBeGreaterThan(0);
      expect(f.localAdapter.loadModel).toHaveBeenCalledTimes(0);
      expect(f.service.isModelReady('phi-4-14b')).toBe(false);

      const lines = result.formattedReadiness.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('Model: phi-4-14b');
      expect(lines[3]).toBe('Status: Installed (Can load)');
    });

    it('ensures ensureModelReadyForTask also returns deviceLabel, status: Ready, and formattedReadiness', async () => {
      const f = createFixture();
      f.registerModel({ id: 'qwen-ready', loaded: true, contextMax: 32768 });

      const readyRes = await f.service.ensureModelReadyForTask({
        modelId: 'qwen-ready',
        computerId: 'mac-studio',
      });

      expect(readyRes.deviceLabel).toBe('Mac Studio M2');
      expect(readyRes.status).toBe('Ready');
      expect(readyRes.formattedReadiness).toBeDefined();
      expect(readyRes.formattedReadiness).toContain('Model: qwen-ready');
      expect(readyRes.formattedReadiness).toContain('Device: Mac Studio M2');
      expect(readyRes.formattedReadiness).toContain('Context: 32768 tokens');
      expect(readyRes.formattedReadiness).toContain('Status: Ready');
    });
  });
});
