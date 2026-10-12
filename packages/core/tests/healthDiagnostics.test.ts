import { describe, expect, it } from 'vitest';
import { buildHealthReport, HealthEvidenceLog, inferenceKey, type HealthSnapshotInput } from '../src/services/healthDiagnostics.js';
import type { Computer, ModelInstance, ModelRecord, ResourceSnapshot, RuntimeRecord } from '../src/types/index.js';

const NOW = new Date('2026-09-24T12:00:00Z');
const GiB = 1024 ** 3;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function runtime(patch: Partial<RuntimeRecord> = {}): RuntimeRecord {
  return {
    id: 'lmstudio-dgx', type: 'lmstudio', name: 'LM Studio', version: '1', computerId: 'DGX-01',
    health: 'healthy', capabilities: { promptCacheTelemetry: true } as RuntimeRecord['capabilities'],
    loadedModels: [], lastCheckedAt: NOW, ...patch,
  };
}
function instance(patch: Partial<ModelInstance> = {}): ModelInstance {
  return {
    id: 'inst-1', modelId: 'qwen3', computerId: 'DGX-01', runtimeId: 'lmstudio-dgx', runtimeModelId: 'qwen3',
    loaded: true, state: 'READY', health: 'healthy', contextTokens: 32768, ...patch,
  };
}
const model = { id: 'qwen3', contextMax: 131072, memory: { minSystemGB: 20 } } as ModelRecord;
const computer = { id: 'DGX-01', reservations: [] } as unknown as Computer;
const snapshot = (availableGiB: number): ResourceSnapshot => ({
  computerId: 'DGX-01', totalMemoryBytes: 116 * GiB, availableMemoryBytes: availableGiB * GiB,
  unifiedMemory: true, activeReservations: [], observedAt: NOW,
});

function report(patch: Partial<HealthSnapshotInput> = {}) {
  return buildHealthReport({
    runtimes: [runtime()], models: [model], instances: [instance()], computers: [computer],
    resources: { 'DGX-01': snapshot(45) },
    workers: [{ id: 'w1', computerId: 'DGX-01', status: 'online', running: true }],
    observations: {
      inference: { [inferenceKey('lmstudio-dgx', 'qwen3')]: [{ at: minutesAgo(1) }] },
      telemetry: { 'lmstudio-dgx': 'OBSERVED' },
    },
    now: NOW,
    ...patch,
  });
}
const codes = (r: ReturnType<typeof report>) => r.diagnostics.map((d) => d.code);

describe('health diagnostics projection', () => {
  it('healthy runtime: no diagnostics, READY/HEALTHY/OBSERVED', () => {
    const r = report();
    expect(codes(r)).toEqual([]);
    expect(r.runtimes[0]).toMatchObject({
      state: 'READY', endpointReachable: true, inferenceReady: true, inference: 'HEALTHY', telemetryStatus: 'OBSERVED',
      loadedModels: ['qwen3'], queueDepth: null,
    });
    expect(r.runtimes[0].resourcePressure).toMatchObject({ level: 'OK', usedMemoryBytes: 71 * GiB, totalMemoryBytes: 116 * GiB });
    expect(r.models[0]).toMatchObject({ installed: true, loaded: true, ready: true, contextLimit: 32768, memoryEstimateBytes: 20 * GiB });
    expect(r.models[0].lastSuccessfulInference).toBe(minutesAgo(1));
  });

  it('runtime unavailable: one RUNTIME_UNREACHABLE, model symptoms suppressed', () => {
    const r = report({
      runtimes: [runtime({ health: 'unavailable' })],
      instances: [instance({ loaded: true, state: 'LOADED', health: 'degraded' })],
    });
    expect(codes(r)).toEqual(['RUNTIME_UNREACHABLE']);
    expect(r.runtimes[0]).toMatchObject({ state: 'UNREACHABLE', endpointReachable: false, inferenceReady: false });
    expect(r.diagnostics[0].domain).toBe('RUNTIME');
  });

  it('hosted provider marked unavailable is not claimed unreachable', () => {
    const r = report({ runtimes: [runtime({ runtimeKind: 'hosted', health: 'unavailable', computerId: undefined })], instances: [], observations: {} });
    expect(codes(r)).toEqual([]);
    expect(r.runtimes[0]).toMatchObject({ state: 'UNAVAILABLE', endpointReachable: null, inferenceReady: false });
  });

  it('model installed but unloaded (wanted): MODEL_NOT_LOADED', () => {
    const r = report({ instances: [instance({ loaded: false, state: 'INSTALLED', desired: { state: 'READY' } })], observations: {} });
    expect(codes(r)).toEqual(['MODEL_NOT_LOADED']);
    expect(r.models[0]).toMatchObject({ installed: true, loaded: false, ready: false });
  });

  it('installed but unloaded and not wanted is not a problem', () => {
    const r = report({ instances: [instance({ loaded: false, state: 'INSTALLED' })], observations: {} });
    expect(codes(r)).not.toContain('MODEL_NOT_LOADED');
  });

  it('loaded but not ready: MODEL_NOT_READY with evidence; LOADED != READY', () => {
    const r = report({
      instances: [instance({ state: 'LOADED', health: 'degraded' })],
      observations: {
        inference: { [inferenceKey('lmstudio-dgx', 'qwen3')]: [{ at: minutesAgo(14) }] },
        readinessProbeFailures: { 'inst-1': { at: minutesAgo(0), error: 'timeout' } },
        telemetry: { 'lmstudio-dgx': 'OBSERVED' },
      },
    });
    expect(codes(r)).toEqual(['MODEL_NOT_READY']);
    expect(r.models[0]).toMatchObject({ loaded: true, ready: false, lifecycleState: 'LOADED' });
    const ev = Object.fromEntries(r.diagnostics[0].evidence.map((e) => [e.label, e.value]));
    expect(ev['model state']).toBe('LOADED');
    expect(ev['readiness probe']).toBe('failed: timeout');
    expect(ev['last successful inference']).toBe('14m ago');
    expect(r.runtimes[0].inferenceReady).toBe(false);
  });

  it('model load failure: MODEL_LOAD_FAILED in MODEL_LOAD domain', () => {
    const r = report({
      instances: [instance({ loaded: false, state: 'FAILED', health: 'degraded', error: 'bad gguf' })],
      observations: { loadFailures: { [inferenceKey('lmstudio-dgx', 'qwen3')]: { at: minutesAgo(2), error: 'RUNTIME_LOAD_FAILED' } } },
    });
    expect(codes(r)).toEqual(['MODEL_LOAD_FAILED']);
    expect(r.diagnostics[0].domain).toBe('MODEL_LOAD');
    expect(r.models[0].lastLoadFailure?.error).toBe('RUNTIME_LOAD_FAILED');
  });

  it('memory admission rejection: INSUFFICIENT_MEMORY in RESOURCE domain', () => {
    const r = report({
      resources: { 'DGX-01': snapshot(4) },
      instances: [instance({ loaded: false, state: 'INSTALLED', desired: { state: 'READY' } })],
      observations: { admissionDenials: { [inferenceKey('lmstudio-dgx', 'qwen3')]: { at: minutesAgo(1), reasons: ['INSUFFICIENT_MEMORY'] } } },
    });
    expect(codes(r)).toEqual(['INSUFFICIENT_MEMORY']);
    expect(r.diagnostics[0].domain).toBe('RESOURCE');
    expect(r.runtimes[0].resourcePressure.level).toBe('CRITICAL');
  });

  it('memory pressure alone does not invent an admission failure', () => {
    const r = report({ resources: { 'DGX-01': snapshot(4) } });
    expect(codes(r)).toEqual([]);
    expect(r.runtimes[0].resourcePressure.level).toBe('CRITICAL');
  });

  it('queue pressure: QUEUE_PRESSURE only when depth is reported and over threshold', () => {
    const base = report().runtimes[0];
    const r = report({ observations: { queueDepth: { 'lmstudio-dgx': 12 }, telemetry: { 'lmstudio-dgx': 'OBSERVED' } } });
    expect(codes(r)).toEqual(['QUEUE_PRESSURE']);
    expect(r.runtimes[0].queueDepth).toBe(12);
    expect(base.queueDepth).toBeNull();
    expect(codes(report({ observations: { queueDepth: { 'lmstudio-dgx': 2 } } }))).not.toContain('QUEUE_PRESSURE');
  });

  it('inference failure: INFERENCE_FAILED while runtime stays READY', () => {
    const r = report({
      observations: {
        inference: { [inferenceKey('lmstudio-dgx', 'qwen3')]: [{ at: minutesAgo(5) }, { at: minutesAgo(1), error: 'HTTP 500' }] },
        telemetry: { 'lmstudio-dgx': 'OBSERVED' },
      },
    });
    expect(codes(r)).toEqual(['INFERENCE_FAILED']);
    expect(r.runtimes[0]).toMatchObject({ state: 'READY', inference: 'FAILING' });
    expect(r.runtimes[0].lastFailure?.error).toBe('HTTP 500');
    expect(r.models[0].recentFailures).toHaveLength(1);
  });

  it('telemetry unavailable: non-fatal, runtime READY and inference HEALTHY', () => {
    const r = report({ observations: { inference: { [inferenceKey('lmstudio-dgx', 'qwen3')]: [{ at: minutesAgo(1) }] } } });
    expect(codes(r)).toEqual(['TELEMETRY_UNAVAILABLE']);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'info', domain: 'TELEMETRY' });
    expect(r.runtimes[0]).toMatchObject({ state: 'READY', inference: 'HEALTHY', telemetryStatus: 'UNKNOWN' });
  });

  it('telemetry unsupported by the runtime is not reported as unavailable', () => {
    const r = report({
      runtimes: [runtime({ capabilities: { promptCacheTelemetry: false } as RuntimeRecord['capabilities'] })],
      observations: { inference: { [inferenceKey('lmstudio-dgx', 'qwen3')]: [{ at: minutesAgo(1) }] } },
    });
    expect(codes(r)).toEqual([]);
    expect(r.runtimes[0].telemetryStatus).toBe('UNSUPPORTED');
  });

  it('worker unavailable: WORKER_UNAVAILABLE in WORKER domain', () => {
    const r = report({ workers: [{ id: 'w1', computerId: 'DGX-01', status: 'offline', running: false }] });
    expect(codes(r)).toEqual(['WORKER_UNAVAILABLE']);
    expect(r.diagnostics[0].domain).toBe('WORKER');
  });

  it('UNKNOWN: degraded runtime without evidence is not collapsed into failure', () => {
    const r = report({ runtimes: [runtime({ health: 'degraded' })], instances: [], observations: {} });
    expect(codes(r)).toEqual(['UNKNOWN']);
    expect(r.diagnostics[0].severity).toBe('info');
    expect(r.runtimes[0]).toMatchObject({ state: 'DEGRADED', endpointReachable: null, inferenceReady: null, inference: 'UNKNOWN' });
  });

  it('UNKNOWN: unobserved resources and missing evidence stay unknown', () => {
    const r = report({ resources: {}, observations: {} });
    expect(r.runtimes[0].resourcePressure.level).toBe('UNKNOWN');
    expect(r.runtimes[0].inference).toBe('UNKNOWN');
    expect(r.runtimes[0].telemetryStatus).toBe('UNKNOWN');
    expect(codes(r)).toEqual([]);
  });

  it('summary counts every code', () => {
    const r = report({ workers: [{ id: 'w1', computerId: 'DGX-01', status: 'offline' }] });
    expect(r.summary.WORKER_UNAVAILABLE).toBe(1);
    expect(r.summary.UNKNOWN).toBe(0);
    expect(Object.keys(r.summary)).toHaveLength(10);
  });
});

describe('HealthEvidenceLog', () => {
  it('tracks load failures and admission denials from lifecycle events, cleared on READY', () => {
    const log = new HealthEvidenceLog();
    log.onLifecycleEvent({ type: 'MODEL_ADMISSION_DENIED', modelId: 'qwen3', runtimeId: 'rt', timestamp: NOW, reason: 'INSUFFICIENT_MEMORY,CONTEXT' });
    log.onLifecycleEvent({ type: 'MODEL_LOAD_FAILED', modelId: 'qwen3', runtimeId: 'rt', timestamp: NOW, reason: 'RUNTIME_LOAD_FAILED' });
    let s = log.snapshot();
    expect(s.admissionDenials?.['rt::qwen3'].reasons).toEqual(['INSUFFICIENT_MEMORY', 'CONTEXT']);
    expect(s.loadFailures?.['rt::qwen3'].error).toBe('RUNTIME_LOAD_FAILED');
    log.onLifecycleEvent({ type: 'MODEL_READY', modelId: 'qwen3', runtimeId: 'rt', timestamp: NOW });
    s = log.snapshot();
    expect(s.loadFailures).toEqual({});
    expect(s.admissionDenials).toEqual({});
  });

  it('hydrates only explicit inference outcomes and telemetry from execution records', () => {
    const log = new HealthEvidenceLog();
    const execution = { runtimeId: 'rt', modelId: 'qwen3' } as never;
    log.hydrateFromExecutions([{
      execution,
      events: [
        { id: '1', executionId: 'x', type: 'generation.completed', timestamp: new Date(minutesAgo(3)) },
        { id: '2', executionId: 'x', type: 'generation.completed', timestamp: new Date(minutesAgo(2)), data: { outcome: 'completed' } },
        { id: '3', executionId: 'x', type: 'generation.completed', timestamp: new Date(minutesAgo(1)), data: { outcome: 'error', error: 'boom' } },
        { id: '4', executionId: 'x', type: 'prompt_cache.telemetry', timestamp: new Date(minutesAgo(1)), data: { source: 'OBSERVED' } },
      ],
    }]);
    const s = log.snapshot();
    expect(s.inference?.['rt::qwen3']).toEqual([{ at: minutesAgo(2) }, { at: minutesAgo(1), error: 'boom' }]);
    expect(s.telemetry?.rt).toBe('OBSERVED');
  });
});

describe('health report JSON', () => {
  it('is plain serializable data with no ANSI and stable top-level shape', () => {
    const r = report({ observations: { inference: { [inferenceKey('lmstudio-dgx', 'qwen3')]: [{ at: minutesAgo(1), error: 'x' }] } } });
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/\u001b\[/);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(['diagnostics', 'generatedAt', 'models', 'runtimes', 'summary', 'workers']);
    expect(parsed.runtimes[0].runtimeId).toBe('lmstudio-dgx');
    expect(parsed.diagnostics[0]).toHaveProperty('evidence');
  });
});
