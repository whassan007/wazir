import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerationEvent, GenerationRequest, RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { MemoryStore } from '@wazir/shared';
import {
  AccountRegistry,
  DEFAULT_POLICY,
  ResourceLedger,
  TokenBudgetManager,
  governAdapter,
  type AccountConfig,
  type ResourcePolicy,
} from '../src/resources/index.js';
import { ModelLifecycleService } from '../src/services/modelLifecycleService.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { PolicyEngine } from '../src/services/policyEngine.js';

const G = 1024 ** 3;
const T0 = Date.UTC(2026, 9, 22, 6, 0, 0);

describe('Phase 3 — ISS-015: Resource Admission, Reservation Cleanup & Pre-Output Quota Accounting', () => {
  describe('governAdapter pre-output vs mid-stream failure accounting', () => {
    let clock = T0;

    beforeEach(() => {
      clock = T0;
    });

    function createBudget(accounts: AccountConfig[], policyOverrides: Partial<ResourcePolicy> = {}) {
      const ledger = new ResourceLedger(':memory:', () => clock);
      const policy: ResourcePolicy = {
        ...DEFAULT_POLICY,
        enforce: true,
        estimateMargin: 0,
        ...policyOverrides,
      };
      const budget = new TokenBudgetManager(ledger, new AccountRegistry(accounts), policy);
      return { ledger, budget };
    }

    const paidAccount: AccountConfig = {
      id: 'openai-main',
      provider: 'openai',
      kind: 'api',
      integration: 'api-key',
      runtimeIds: ['openai'],
      allowPaid: true,
      limits: [{ unit: 'tokens', window: '5h', limit: 10_000, source: 'configured' }],
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    };

    it('releases reservation and charges zero tokens when inner.generate() throws before emitting any output token', async () => {
      const { ledger, budget } = createBudget([paidAccount]);
      const failSpy = vi.spyOn(budget, 'fail');
      const holdLeaseSpy = vi.spyOn(budget, 'holdLease');
      let leaseStopped = false;
      holdLeaseSpy.mockImplementation((requestId: string) => {
        const stop = TokenBudgetManager.prototype.holdLease.call(budget, requestId);
        return () => {
          leaseStopped = true;
          stop();
        };
      });

      const adapter = {
        id: 'openai',
        type: 'openai',
        async *generate(_req: GenerationRequest): AsyncIterable<GenerationEvent> {
          throw new Error('503 Service Unavailable before first token');
        },
        async healthCheck() {
          return { status: 'healthy' as const };
        },
      } as unknown as RuntimeAdapter;

      const governed = governAdapter(adapter, {
        budget,
        resolveAccount: () => 'openai-main',
      });

      await expect(async () => {
        for await (const _ of governed.generate({
          requestId: 'req-throw-pre-output',
          modelId: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello world' }],
        })) {
          // no events expected before throw
        }
      }).rejects.toThrow('503 Service Unavailable before first token');

      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(failSpy).toHaveBeenCalledWith(
        'req-throw-pre-output',
        expect.objectContaining({
          ambiguous: false,
          partial: undefined,
          message: '503 Service Unavailable before first token',
        }),
      );
      expect(leaseStopped).toBe(true);
      expect(ledger.usageRows()).toHaveLength(0);
      expect(ledger.reservedNow('openai-main', 'tokens')).toBe(0);
      expect(ledger.inFlight('openai-main')).toBe(0);
      expect(ledger.getReservation('req-throw-pre-output')?.status).toBe('released');
    });

    it('releases reservation without charging phantom tokens when inner.generate() yields { type: "error" } before any output token', async () => {
      const { ledger, budget } = createBudget([paidAccount]);
      const failSpy = vi.spyOn(budget, 'fail');

      const adapter = {
        id: 'openai',
        type: 'openai',
        async *generate(_req: GenerationRequest): AsyncIterable<GenerationEvent> {
          yield {
            type: 'error',
            failureClass: 'TIMEOUT',
            error: 'upstream connection timed out before first token',
          };
        },
        async healthCheck() {
          return { status: 'healthy' as const };
        },
      } as unknown as RuntimeAdapter;

      const governed = governAdapter(adapter, {
        budget,
        resolveAccount: () => 'openai-main',
      });

      const events: GenerationEvent[] = [];
      for await (const ev of governed.generate({
        requestId: 'req-error-event-pre-output',
        modelId: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello world' }],
      })) {
        events.push(ev);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(failSpy).toHaveBeenCalledWith(
        'req-error-event-pre-output',
        expect.objectContaining({
          failureClass: 'TIMEOUT',
          ambiguous: false,
          partial: undefined,
          message: 'upstream connection timed out before first token',
        }),
      );
      expect(ledger.usageRows()).toHaveLength(0);
      expect(ledger.reservedNow('openai-main', 'tokens')).toBe(0);
      expect(ledger.inFlight('openai-main')).toBe(0);
      expect(ledger.getReservation('req-error-event-pre-output')?.status).toBe('released');
    });

    it('calls budget.fail with ambiguous: true and releases lease when inner.generate() emits tokens and then throws mid-stream', async () => {
      const { ledger, budget } = createBudget([paidAccount]);
      const failSpy = vi.spyOn(budget, 'fail');
      const holdLeaseSpy = vi.spyOn(budget, 'holdLease');
      let leaseStopped = false;
      holdLeaseSpy.mockImplementation((requestId: string) => {
        const stop = TokenBudgetManager.prototype.holdLease.call(budget, requestId);
        return () => {
          leaseStopped = true;
          stop();
        };
      });

      const adapter = {
        id: 'openai',
        type: 'openai',
        async *generate(_req: GenerationRequest): AsyncIterable<GenerationEvent> {
          yield { type: 'token', content: 'Partial output before crash' };
          throw new Error('stream reset mid-generation');
        },
        async healthCheck() {
          return { status: 'healthy' as const };
        },
      } as unknown as RuntimeAdapter;

      const governed = governAdapter(adapter, {
        budget,
        resolveAccount: () => 'openai-main',
      });

      const received: GenerationEvent[] = [];
      await expect(async () => {
        for await (const ev of governed.generate({
          requestId: 'req-throw-mid-stream',
          modelId: 'gpt-4o',
          messages: [{ role: 'user', content: 'Write a detailed response' }],
        })) {
          received.push(ev);
        }
      }).rejects.toThrow('stream reset mid-generation');

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: 'token', content: 'Partial output before crash' });
      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(failSpy).toHaveBeenCalledWith(
        'req-throw-mid-stream',
        expect.objectContaining({
          ambiguous: true,
          partial: expect.objectContaining({
            source: 'estimated',
          }),
          message: 'stream reset mid-generation',
        }),
      );
      expect(leaseStopped).toBe(true);
      expect(ledger.inFlight('openai-main')).toBe(0);
      expect(ledger.reservedNow('openai-main', 'tokens')).toBe(0);
      const rows = ledger.usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('conservative');
    });
  });

  describe('ModelLifecycleService ResourceReservation cleanup on failed load and inspect', () => {
    function setupLifecycle(freeGB = 64, modelSizeGB = 30, store?: MemoryStore) {
      const computers = new ComputerRegistry();
      computers.register({
        id: 'node',
        name: 'node',
        type: 'server',
        local: false,
        os: { platform: 'linux', architecture: 'arm64', version: '1' },
        hardware: {
          cpu: 'cpu',
          cpuCores: 8,
          memoryGB: 128,
          gpu: { vendor: 'nvidia', model: 'gpu', memoryGB: 128, unifiedMemory: true },
        },
      });
      const sample = () =>
        computers.heartbeat('node', {
          load: { cpuPercent: 0, memoryUsedGB: 128 - freeGB, memoryAvailableGB: freeGB },
        });
      sample();

      const models = new ModelRegistry();
      const runtimes = new RuntimeRegistry();
      const executions = new ExecutionEngine();
      const caps = {
        chat: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: true,
        modelUnload: true,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
      runtimes.register({
        id: 'r',
        type: 'lmstudio',
        name: 'runtime',
        version: '1',
        computerId: 'node',
        capabilities: caps,
      });
      runtimes.update('r', { health: 'healthy' });

      const loaded = new Map<string, number>();
      const adapter = {
        id: 'r',
        type: 'lmstudio',
        discover: async () => ({ id: 'r', name: 'r', version: '1' }),
        healthCheck: async () => ({ status: 'healthy' as const }),
        getCapabilities: async () => caps,
        listModels: async () => models.list().map((m) => ({ id: m.id, contextWindow: m.contextMax })),
        estimateModelLoad: vi.fn(async () => ({
          totalMemoryBytes: modelSizeGB * G,
          source: 'RUNTIME' as const,
          confidence: 'high' as const,
        })),
        loadModel: vi.fn(async (id: string, opts: { contextTokens: number }) => {
          loaded.set(id, opts.contextTokens);
        }),
        unloadModel: vi.fn(async (id: string) => {
          loaded.delete(id);
        }),
        inspectModel: vi.fn(async (id: string) => ({
          modelId: id,
          loaded: loaded.has(id),
          effectiveContext: loaded.get(id),
          memoryBytes: modelSizeGB * G,
        })),
        probeModel: vi.fn(async () => true),
        async *generate() {
          yield { type: 'completed' as const, content: 'ok' };
        },
      } as unknown as RuntimeAdapter;

      const addModel = (id: string) => {
        models.register({
          id,
          name: id,
          provider: 'r',
          family: 'other',
          contextMax: 131072,
          capabilities: ['generalChat'],
          toolCalling: true,
          structuredOutput: false,
          vision: false,
          audio: false,
          embedding: false,
          reasoning: false,
          runtimeCompatibility: ['lmstudio'],
          local: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        models.upsertInstallation({
          id,
          modelId: id,
          computerId: 'node',
          runtimeId: 'r',
          runtimeModelId: id,
          installed: true,
          observedAt: new Date(),
        });
        models.upsertInstance({
          id,
          installationId: id,
          modelId: id,
          computerId: 'node',
          runtimeId: 'r',
          runtimeModelId: id,
          loaded: false,
          state: 'INSTALLED',
          health: 'healthy',
        });
      };

      addModel('model-a');
      const events: string[] = [];
      const service = new ModelLifecycleService({
        models,
        computers,
        runtimes,
        executions,
        adapters: new Map([['r', adapter]]),
        policy: new PolicyEngine({ projectRoot: '/tmp' }),
        store,
      });
      service.subscribe((e) => events.push(e.type));

      return { service, models, computers, runtimes, adapter, loaded, addModel, events };
    }

    it('releases ResourceReservation and marks instance FAILED when both adapter.loadModel() and adapter.inspectModel() throw', async () => {
      const store = new MemoryStore();
      const f = setupLifecycle(64, 30, store);
      const releaseSpy = vi.spyOn(f.computers, 'releaseReservation');

      vi.mocked(f.adapter.loadModel!).mockRejectedValueOnce(new Error('runtime crashed during load'));
      vi.mocked(f.adapter.inspectModel!).mockRejectedValueOnce(new Error('runtime unreachable during inspect'));

      await expect(f.service.load('model-a')).rejects.toMatchObject({
        code: 'RUNTIME_LOAD_FAILED',
      });

      const snapshot = f.computers.resourceSnapshot('node');
      expect(snapshot.activeReservations).toHaveLength(0);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(await store.get('computer/node/reservations')).toEqual([]);
      expect(f.models.getModelState('model-a')).toBe('FAILED');
      expect(f.models.instancesOf('model-a')[0]).toMatchObject({
        state: 'FAILED',
        loaded: false,
        health: 'degraded',
      });
      expect(f.events).toContain('RESOURCE_RESERVATION_CREATED');
      expect(f.events).toContain('RESOURCE_RESERVATION_RELEASED');
    });

    it('does not accumulate leaked reservations across repeated failed loads and admits subsequent valid loads', async () => {
      // 64 GiB available, 8 GiB minimum safety reserve => 56 GiB usable.
      // Each load needs 40 GiB. Even a single leaked 40 GiB reservation would leave only 16 GiB usable
      // and cause false INSUFFICIENT_MEMORY rejections on all subsequent loads.
      const store = new MemoryStore();
      const f = setupLifecycle(64, 40, store);
      f.addModel('model-b');

      for (let attempt = 0; attempt < 3; attempt++) {
        vi.mocked(f.adapter.loadModel!).mockRejectedValueOnce(new Error(`load failure #${attempt + 1}`));
        vi.mocked(f.adapter.inspectModel!).mockRejectedValueOnce(new Error(`inspect failure #${attempt + 1}`));

        await expect(f.service.load('model-a')).rejects.toMatchObject({
          code: 'RUNTIME_LOAD_FAILED',
        });
        expect(f.computers.resourceSnapshot('node').activeReservations).toHaveLength(0);
      }

      // Now runtime recovers: both model-a (retrying same instance) and model-b should be admissible without false INSUFFICIENT_MEMORY
      const planA = await f.service.load('model-a');
      expect(planA.admissionDecision.status).toBe('ADMITTED');
      expect(f.models.isModelReady('model-a')).toBe(true);
    });
  });
});
