import { describe, it, expect, vi } from 'vitest';
import { ModelLifecycleService } from '../src/services/modelLifecycleService.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { MemoryStore } from '@wazir/shared';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
const G = 1024 ** 3;
function setup(free = 64, size: (ctx: number) => number = () => 30, store?: MemoryStore) {
 const computers = new ComputerRegistry();
 computers.register({ id: 'node', name: 'node', type: 'server', local: false,
   os: { platform: 'linux', architecture: 'arm64', version: '1' },
   hardware: { cpu: 'cpu', cpuCores: 8, memoryGB: 128, gpu: { vendor: 'nvidia', model: 'gpu', memoryGB: 128, unifiedMemory: true } } });
 const sample = () => computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 128 - free, memoryAvailableGB: free } }); sample();
 const models = new ModelRegistry(), runtimes = new RuntimeRegistry(), executions = new ExecutionEngine();
 const caps = { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false,
   modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false };
 runtimes.register({ id: 'r', type: 'lmstudio', name: 'runtime', version: '1', computerId: 'node', capabilities: caps });
 runtimes.update('r', { health: 'healthy' });
 const loaded = new Map<string, number>();
 const adapter = {
   id: 'r', type: 'lmstudio', discover: async () => ({ id: 'r', name: 'r', version: '1' }), healthCheck: async () => ({ status: 'healthy' }),
   getCapabilities: async () => caps,
   listModels: async () => models.list().map(m => ({ id: m.id, contextWindow: m.contextMax })),
   estimateModelLoad: vi.fn(async (_id: string, ctx: number) => ({ totalMemoryBytes: size(ctx) * G, source: 'RUNTIME', confidence: 'high' })),
   loadModel: vi.fn(async (id: string, opts: { contextTokens: number }) => { loaded.set(id, opts.contextTokens); }),
   unloadModel: vi.fn(async (id: string) => { loaded.delete(id); free += 30; sample(); }),
   inspectModel: vi.fn(async (id: string) => ({ modelId: id, loaded: loaded.has(id), effectiveContext: loaded.get(id), memoryBytes: 30 * G })),
   probeModel: vi.fn(async () => true),
   async *generate() { yield { type: 'completed', content: 'ok' }; },
 } as unknown as RuntimeAdapter;
 const add = (id: string) => {
   models.register({ id, name: id, provider: 'r', family: 'other', contextMax: 131072, capabilities: ['generalChat'],
     toolCalling: true, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
     runtimeCompatibility: ['lmstudio'], local: true, createdAt: new Date(), updatedAt: new Date() });
   models.upsertInstallation({ id, modelId: id, computerId: 'node', runtimeId: 'r', runtimeModelId: id, installed: true, observedAt: new Date() });
   models.upsertInstance({ id, installationId: id, modelId: id, computerId: 'node', runtimeId: 'r', runtimeModelId: id, loaded: false, state: 'INSTALLED', health: 'healthy' });
 };
 add('a');
 const events: string[] = [];
 const service = new ModelLifecycleService({ models, computers, runtimes, executions, adapters: new Map([['r', adapter]]), policy: new PolicyEngine({ projectRoot: '/tmp' }), store });
 service.subscribe(e => events.push(e.type));
 return { service, models, computers, runtimes, executions, adapter, loaded, add, events };
}
describe('model lifecycle admission and observed readiness', () => {
 it('verifies a discovered LOADED resident without demanding reload', async () => {
   const f = setup(); f.loaded.set('a', 32768);
   await f.service.discoverAndReconcile({ verify: false });
   expect(f.models.getModelState('a')).toBe('LOADED');
   const p = await f.service.ensureReady('a', { minimumContext: 8192 });
   expect(p.reuse).toBe(true);
   expect(f.adapter.loadModel).not.toHaveBeenCalled();
   expect(f.adapter.probeModel).toHaveBeenCalledTimes(1);
   expect(f.models.isModelReady('a')).toBe(true);
 });
 it('admits safe load, then verifies context and readiness', async () => {
   const f = setup(); const p = await f.service.load('a');
   expect(p.admissionDecision.status).toBe('ADMITTED');
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);
   expect(f.adapter.probeModel).toHaveBeenCalled(); expect(f.models.isModelReady('a')).toBe(true);
 });
 it.each([[32, 40], [116, 145.6]])('denies %s GiB free / %s GiB required with ZERO load attempts', async (free, required) => {
   const f = setup(free, () => required);
   await expect(f.service.load('a')).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.loadModel).not.toHaveBeenCalled();
 });
 it('rejects explicit context unless fit is enabled, reporting downshift', async () => {
   const f = setup(40, ctx => 16 + ctx / 2048);
   await expect(f.service.load('a', { context: 131072 })).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.loadModel).not.toHaveBeenCalled();
   const plan = await f.service.load('a', { context: 131072, fit: true });
   expect(plan.effectiveContext).toBe(32768); expect(plan.contextReason).toBe('MACHINE_RESOURCE_LIMIT');
   expect(f.events).toContain('MODEL_CONTEXT_DOWNSHIFTED');
 });
 it('never fits below task minimum', async () => {
   const f = setup(32, ctx => 16 + ctx / 2048);
   await expect(f.service.load('a', { context: 131072, fit: true, minimumContext: 32768 })).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.loadModel).not.toHaveBeenCalled();
 });
 it('denies active unload and drains without admitting new assignments', async () => {
   const f = setup(); await f.service.load('a');
   const record = await f.executions.create({ task: { id: 'task' } as any, computerId: 'node', runtimeId: 'r', modelId: 'a' });
   await expect(f.service.unload('a')).rejects.toMatchObject({ code: 'MODEL_IN_USE' });
   expect(f.adapter.unloadModel).not.toHaveBeenCalled();
   const pending = f.service.unload('a', { drain: true });
   await vi.waitFor(() => expect(f.models.getModelState('a')).toBe('DRAINING'));
   expect(f.models.isModelReady('a')).toBe(false);
   await f.executions.setStatus(record.execution.id, 'completed'); await pending;
   expect(f.models.getModelState('a')).toBe('UNLOADED');
 });
 it('protects pinned eviction candidates', async () => {
   const f = setup(40); f.add('b');
   f.loaded.set('b', 32768); f.models.upsertInstance({ ...f.models.instancesOf('b')[0], loaded: true, state: 'READY', residentMemoryBytes: 30 * G, pinned: true });
   f.computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 110, memoryAvailableGB: 18 } });
   await expect(f.service.load('a', { evict: true })).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.unloadModel).not.toHaveBeenCalled();
 });
 it('plans eviction and requires fresh admission after reclaim', async () => {
   const f = setup(18); f.add('b');
   f.loaded.set('b', 32768); f.models.upsertInstance({ ...f.models.instancesOf('b')[0], loaded: true, state: 'READY', residentMemoryBytes: 30 * G });
   const p = await f.service.load('a', { evict: true });
   expect(p.modelsToEvict[0].instanceId).toBe('b');
   expect(f.adapter.unloadModel).toHaveBeenCalledWith('b'); expect(f.models.isModelReady('a')).toBe(true);
 });
 it('prevents concurrent loads from overcommitting the computer', async () => {
   const f = setup(60, () => 40); f.add('b');
   const results = await Promise.allSettled([f.service.load('a'), f.service.load('b')]);
   expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);
 });
 it('reconciles external unload and external load with stable instance identity', async () => {
   const f = setup(); await f.service.load('a'); f.loaded.delete('a'); await f.service.reconcile();
   expect(f.models.getModelState('a')).toBe('UNLOADED');
   f.loaded.set('a', 32768); await f.service.reconcile(); await f.service.reconcile();
   expect(f.models.listInstances()).toHaveLength(1); expect(f.models.isModelReady('a')).toBe(true);
 });
 it('does not mark READY when load succeeds but probe fails', async () => {
   const f = setup(); vi.mocked(f.adapter.probeModel!).mockResolvedValue(false);
   await expect(f.service.load('a')).rejects.toMatchObject({ code: 'MODEL_READINESS_FAILED' });
   expect(f.models.isModelReady('a')).toBe(false); expect(f.events).toContain('MODEL_LOAD_FAILED');
 });
 it('dry-run produces a plan without mutation or retained reservations', async () => {
   const f = setup(); const p = await f.service.load('a', { dryRun: true });
   expect(p.estimate.estimatedTotalMemory).toBe(30 * G); expect(p.admissionDecision.status).toBe('ADMITTED');
   expect(f.adapter.loadModel).not.toHaveBeenCalled(); expect(f.adapter.unloadModel).not.toHaveBeenCalled();
   expect(f.computers.resourceSnapshot('node').activeReservations).toHaveLength(0);
 });
 it('denies unknown estimates instead of assuming a default model size', async () => {
   const f = setup(); vi.mocked(f.adapter.estimateModelLoad!).mockResolvedValue({ source: 'UNKNOWN', confidence: 'unknown' });
   await expect(f.service.load('a')).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED', reasons: ['ESTIMATE_UNKNOWN'] });
   expect(f.adapter.loadModel).not.toHaveBeenCalled();
 });
 it('can admit an unknown estimate only with an explicit bounded reservation policy', async () => {
   const f = setup();
   vi.mocked(f.adapter.estimateModelLoad!).mockResolvedValue({ source: 'UNKNOWN', confidence: 'unknown' });
   const policy = new PolicyEngine({ projectRoot: '/tmp', modelLifecycle: { allowUnknownEstimate: true, unknownReservationBytes: 20 * G } });
   const service = new ModelLifecycleService({ models: f.models, computers: f.computers, runtimes: f.runtimes,
     adapters: new Map([['r', f.adapter]]), policy });
   const plan = await service.load('a');
   expect(plan.estimate.classification).toBe('UNKNOWN');
   expect(plan.estimate.estimateSource).toBe('UNKNOWN');
   expect(plan.reservation?.memoryBytes).toBe(20 * G);
   expect(f.models.isModelReady('a')).toBe(true);
 });
 it('shares computer reservations across independent control-plane instances', async () => {
   const store = new MemoryStore();
   const first = setup(60, () => 40, store);
   const second = setup(60, () => 40, store);
   second.add('b');
   const results = await Promise.allSettled([first.service.load('a'), second.service.load('b')]);
   expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
   expect(vi.mocked(first.adapter.loadModel!).mock.calls.length + vi.mocked(second.adapter.loadModel!).mock.calls.length).toBe(1);
   const reservations = await store.get('computer/node/reservations') as Array<{ memoryBytes: number }>;
   expect(reservations).toHaveLength(1);
   expect(reservations[0].memoryBytes).toBe(40 * G);
 });
 it('restores pin intent after a fresh reconciliation', async () => {
   const store = new MemoryStore();
   const f = setup(64, () => 30, store);
   await f.service.pin('a');
   f.models.instancesOf('a')[0].pinned = false;
   await f.service.reconcile();
   expect(f.models.instancesOf('a')[0].pinned).toBe(true);
   expect(f.models.listInstallations().filter(i => i.modelId === 'a')).toHaveLength(1);
 });
});


describe('startup context policy', () => {
 it('NONE loads nothing and EXPLICIT performs fresh admission', async () => {
   const f = setup(32, () => 40);
   expect(await f.service.applyStartupPolicy({ mode: 'none' })).toEqual({ restored: [], failed: [], missing: [] });
   const result = await f.service.applyStartupPolicy({ mode: 'explicit', models: [{ modelId: 'a', context: 32768 }] });
   expect(result.failed).toEqual(['a']);
   expect(f.adapter.loadModel).not.toHaveBeenCalled();
 });
 it('RESTORE uses instance target and desired context, verifying readiness again', async () => {
   const f = setup();
   f.models.upsertInstance({ ...f.models.instancesOf('a')[0], desired: { state: 'READY', contextTokens: 16384 } });
   const result = await f.service.applyStartupPolicy({ mode: 'restore' });
   expect(result.restored).toEqual(['a']);
   expect(f.adapter.loadModel).toHaveBeenCalledWith('a', { contextTokens: 16384 });
   expect(f.adapter.probeModel).toHaveBeenCalled();
 });
 it('MAX_SAFE selects the largest safe context while AUTO selects a practical context', async () => {
   const f = setup(72, ctx => 16 + ctx / 2048);
   expect((await f.service.estimate('a', { mode: 'AUTO' })).effectiveContext).toBe(32768);
   expect((await f.service.estimate('a', { mode: 'MAX_SAFE' })).effectiveContext).toBe(98304);
 });
 it('prevents independent controllers loading the same instance twice', async () => {
   const store = new MemoryStore();
   const a = setup(128, () => 20, store), b = setup(128, () => 20, store);
   let release!: () => void;
   vi.mocked(a.adapter.loadModel!).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); a.loaded.set('a', 32768); });
   const first = a.service.load('a');
   await vi.waitFor(() => expect(a.adapter.loadModel).toHaveBeenCalled());
   await expect(b.service.load('a')).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(b.adapter.loadModel).not.toHaveBeenCalled();
   release(); await first;
 });
});
describe('reconcile isolates per-model failures', () => {
 it('one model that cannot be inspected does not take the whole runtime offline', async () => {
   const f = setup();
   f.add('b');
   (f.adapter.inspectModel as any).mockImplementation(async (id: string) => {
     if (id === 'b') throw new Error('RESOURCE_BUSY: multiple runtime instances require explicit selection');
     return { modelId: id, loaded: true, effectiveContext: 131072, memoryBytes: 30 * G };
   });
   await f.service.discoverAndReconcile({ verify: false });
   expect(f.runtimes.get('r')?.health).toBe('healthy');
   expect(f.models.instancesOf('a')[0]).toMatchObject({ loaded: true, health: 'healthy' });
   expect(f.models.instancesOf('b')[0]).toMatchObject({ state: 'UNAVAILABLE', health: 'unavailable' });
 });
 it('preserves a verified READY state across a read-only (verify:false) reconcile', async () => {
   const f = setup();
   await f.service.load('a');
   expect(f.models.isModelReady('a')).toBe(true);
   const probeCallsBefore = (f.adapter.probeModel as any).mock.calls.length;
   await f.service.discoverAndReconcile({ verify: false });
   expect(f.models.isModelReady('a')).toBe(true);
   expect(f.models.instancesOf('a')[0].state).toBe('READY');
   expect((f.adapter.probeModel as any).mock.calls.length).toBe(probeCallsBefore);
 });
 it('reusing an already-READY model is ADMITTED even when a hypothetical fresh load would be INSUFFICIENT, but a genuine fresh load under the same scarcity is DENIED', async () => {
   const f = setup(40, () => 20);
   f.add('b');
   await f.service.load('a');
   expect(f.models.isModelReady('a')).toBe(true);
   f.computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 127.9, memoryAvailableGB: 0.1 } });
   const reusePlan = await f.service.load('a');
   expect(reusePlan.reuse).toBe(true);
   expect(reusePlan.admissionDecision.status).toBe('ADMITTED');
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);
   await expect(f.service.load('b')).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
 });
 it('reserves only the memory increase when a resident model needs a larger context', async () => {
   const f = setup(20, () => 40);
   f.loaded.set('a', 4096);
   f.models.upsertInstance({ ...f.models.instancesOf('a')[0], loaded: true, state: 'READY', contextTokens: 4096, residentMemoryBytes: 30 * G });
   const plan = await f.service.load('a', { minimumContext: 8192 });
   expect(plan.reuse).toBe(false);
   expect(plan.estimate.estimatedTotalMemory).toBe(40 * G);
   expect(plan.estimate.reservationMemoryBytes).toBe(10 * G);
   expect(plan.reservation?.memoryBytes).toBe(10 * G);
   expect(plan.admissionDecision.status).toBe('ADMITTED');
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);
 });
});

describe('telemetry refresh, structured explanations, and admission invariants', () => {
 it('refreshes telemetry once on missing or stale telemetry before admission and does not permanently blacklist on transient gaps', async () => {
   const computers = new ComputerRegistry();
   computers.register({ id: 'node', name: 'node', type: 'server', local: false,
     os: { platform: 'linux', architecture: 'arm64', version: '1' },
     hardware: { cpu: 'cpu', cpuCores: 8, memoryGB: 128, gpu: { vendor: 'nvidia', model: 'gpu', memoryGB: 128, unifiedMemory: true } } });
   const models = new ModelRegistry(), runtimes = new RuntimeRegistry(), executions = new ExecutionEngine();
   const caps = { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false,
     modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false };
   runtimes.register({ id: 'r', type: 'lmstudio', name: 'runtime', version: '1', computerId: 'node', capabilities: caps });
   runtimes.update('r', { health: 'healthy' });
   const loaded = new Map<string, number>();
   const adapter = {
     id: 'r', type: 'lmstudio', discover: async () => ({ id: 'r', name: 'r', version: '1' }), healthCheck: async () => ({ status: 'healthy' }),
     getCapabilities: async () => caps,
     listModels: async () => models.list().map(m => ({ id: m.id, contextWindow: m.contextMax })),
     estimateModelLoad: vi.fn(async () => ({ totalMemoryBytes: 30 * G, source: 'RUNTIME', confidence: 'high' })),
     loadModel: vi.fn(async (id: string, opts: { contextTokens: number }) => { loaded.set(id, opts.contextTokens); }),
     unloadModel: vi.fn(async (id: string) => { loaded.delete(id); }),
     inspectModel: vi.fn(async (id: string) => ({ modelId: id, loaded: loaded.has(id), effectiveContext: loaded.get(id), memoryBytes: 30 * G })),
     probeModel: vi.fn(async () => true),
     async *generate() { yield { type: 'completed', content: 'ok' }; },
   } as unknown as RuntimeAdapter;
   models.register({ id: 'a', name: 'a', provider: 'r', family: 'other', contextMax: 131072, capabilities: ['generalChat'],
     toolCalling: true, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
     runtimeCompatibility: ['lmstudio'], local: true, createdAt: new Date(), updatedAt: new Date() });
   models.upsertInstallation({ id: 'a', modelId: 'a', computerId: 'node', runtimeId: 'r', runtimeModelId: 'a', installed: true, observedAt: new Date() });
   models.upsertInstance({ id: 'a', installationId: 'a', modelId: 'a', computerId: 'node', runtimeId: 'r', runtimeModelId: 'a', loaded: false, state: 'INSTALLED', health: 'healthy' });

   let allowHeartbeat = false;
   const refreshResources = vi.fn(async (computerId: string) => {
     if (allowHeartbeat) {
       computers.heartbeat(computerId, { load: { cpuPercent: 0, memoryUsedGB: 64, memoryAvailableGB: 64 } });
     }
   });
   const service = new ModelLifecycleService({
     models, computers, runtimes, executions, adapters: new Map([['r', adapter]]),
     policy: new PolicyEngine({ projectRoot: '/tmp' }), refreshResources,
   });

   // 1. Missing telemetry: refreshResources is called once, still unavailable -> denied with HARDWARE_TELEMETRY_UNAVAILABLE
   await expect(service.load('a')).rejects.toMatchObject({
     code: 'MODEL_ADMISSION_DENIED',
     reasons: ['HARDWARE_TELEMETRY_UNAVAILABLE'],
   });
   expect(refreshResources).toHaveBeenCalledTimes(1);
   expect(adapter.loadModel).not.toHaveBeenCalled();
   expect(service.isKnownIneligible('a').ineligible).toBe(false);

   // 2. Stale telemetry: heartbeat older than 30s -> refreshResources called once, still stale -> denied with HARDWARE_TELEMETRY_STALE
   computers.get('node')!.resourceObservedAt = new Date(Date.now() - 60_000);
   computers.get('node')!.load = { cpuPercent: 0, memoryUsedGB: 64, memoryAvailableGB: 64 };
   await expect(service.load('a')).rejects.toMatchObject({
     code: 'MODEL_ADMISSION_DENIED',
     reasons: ['HARDWARE_TELEMETRY_STALE'],
   });
   expect(refreshResources).toHaveBeenCalledTimes(2);
   expect(service.isKnownIneligible('a').ineligible).toBe(false);

   // 3. Telemetry recovers via refreshResources -> admitted on retry without blacklisting (1 pre-admission refresh + 1 post-load refresh)
   allowHeartbeat = true;
   refreshResources.mockClear();
   const plan = await service.load('a');
   expect(refreshResources).toHaveBeenCalledTimes(2);
   expect(plan.admissionDecision.status).toBe('ADMITTED');
   expect(plan.admissionDecision.explanation?.measurement_fresh).toBe(true);
   expect(adapter.loadModel).toHaveBeenCalledTimes(1);
 });

 it('distinguishes MODEL_METADATA_MISSING and MODEL_METADATA_UNSUPPORTED from ESTIMATE_UNKNOWN', async () => {
   const f = setup();
   delete (f.adapter as any).estimateModelLoad;
   await expect(f.service.load('a')).rejects.toMatchObject({
     code: 'MODEL_ADMISSION_DENIED',
     reasons: ['MODEL_METADATA_MISSING'],
   });

   const inst = f.models.getInstallation('a')!;
   f.models.upsertInstallation({
     ...inst,
     profile: { weightBytes: -10, contextBytesPerToken: 1024, runtimeOverheadBytes: 1024 },
   });
   await expect(f.service.load('a')).rejects.toMatchObject({
     code: 'MODEL_ADMISSION_DENIED',
     reasons: ['MODEL_METADATA_UNSUPPORTED'],
   });
 });

 it('populates structured admission explanation fields for admitted, dry-run, reused, and denied plans', async () => {
   const f = setup(64, () => 30);

   const dryPlan = await f.service.load('a', { dryRun: true });
   expect(dryPlan.admissionDecision.explanation).toEqual({
     decision: 'ADMITTED',
     model: 'a',
     computer: 'node',
     runtime: 'r',
     context_tokens: 32768,
     memory_estimate_source: 'RUNTIME',
     hardware_measurement_source: 'HEARTBEAT',
     measurement_fresh: true,
     reused_loaded_model: false,
     reservation_created: false,
     reasons: [],
   });

   const loadPlan = await f.service.load('a');
   expect(loadPlan.admissionDecision.explanation).toEqual({
     decision: 'ADMITTED',
     model: 'a',
     computer: 'node',
     runtime: 'r',
     context_tokens: 32768,
     memory_estimate_source: 'RUNTIME',
     hardware_measurement_source: 'HEARTBEAT',
     measurement_fresh: true,
     reused_loaded_model: false,
     reservation_created: true,
     reasons: [],
   });

   const reusePlan = await f.service.load('a');
   expect(reusePlan.admissionDecision.explanation).toEqual({
     decision: 'ADMITTED',
     model: 'a',
     computer: 'node',
     runtime: 'r',
     context_tokens: 32768,
     memory_estimate_source: 'RUNTIME',
     hardware_measurement_source: 'HEARTBEAT',
     measurement_fresh: true,
     reused_loaded_model: true,
     reservation_created: false,
     reasons: [],
   });

   f.add('b');
   f.computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 118, memoryAvailableGB: 10 } });
   const deniedPlan = await f.service.estimate('b');
   expect(deniedPlan.admissionDecision.explanation).toEqual({
     decision: 'DENIED',
     model: 'b',
     computer: 'node',
     runtime: 'r',
     context_tokens: 32768,
     memory_estimate_source: 'RUNTIME',
     hardware_measurement_source: 'HEARTBEAT',
     measurement_fresh: true,
     reused_loaded_model: false,
     reservation_created: false,
     reasons: ['INSUFFICIENT_MEMORY'],
   });
 });

 it('atomically enforces concurrent memory reservations and marks reservation_created only for the admitted load', async () => {
   const f = setup(60, () => 40);
   f.add('b');
   const results = await Promise.allSettled([f.service.load('a'), f.service.load('b')]);
   const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.load>>> => r.status === 'fulfilled');
   const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
   expect(fulfilled).toHaveLength(1);
   expect(rejected).toHaveLength(1);
   expect(fulfilled[0].value.admissionDecision.explanation?.reservation_created).toBe(true);
   expect(rejected[0].reason).toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);
 });

 it('reuses already-loaded model without double-charging weights', async () => {
   const f = setup(64, () => 40);
   await f.service.load('a');
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);

   // Simulate almost no free memory left after 'a' is resident
   f.computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 127.5, memoryAvailableGB: 0.5 } });
   const plan = await f.service.load('a');
   expect(plan.reuse).toBe(true);
   expect(plan.admissionDecision.status).toBe('ADMITTED');
   expect(plan.admissionDecision.explanation?.reused_loaded_model).toBe(true);
   expect(plan.admissionDecision.explanation?.reservation_created).toBe(false);
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1);
 });

 it('never silently substitutes a pinned model on fallback or eviction', async () => {
   const f = setup(40, () => 30);
   f.add('b');
   f.add('c');
   await f.service.load('b');
   await f.service.pin('b');
   f.computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 110, memoryAvailableGB: 18 } });

   // Attempting to load 'a' with eviction must not evict pinned 'b' and must not substitute 'b'
   await expect(f.service.load('a', { evict: true })).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.unloadModel).not.toHaveBeenCalled();
   expect(f.models.isModelReady('b')).toBe(true);

   // Requesting a pinned model 'c' that cannot fit must deny 'c' rather than substituting 'b'
   await f.service.pin('c');
   await expect(f.service.load('c')).rejects.toMatchObject({ code: 'MODEL_ADMISSION_DENIED' });
   expect(f.adapter.loadModel).toHaveBeenCalledTimes(1); // only 'b' was loaded
 });
});
