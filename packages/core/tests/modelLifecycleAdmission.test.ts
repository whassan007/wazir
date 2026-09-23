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
