import { describe, expect, it } from 'vitest';
import { ComputerRegistry, ModelRegistry, RuntimeRegistry, HealthEvidenceLog } from '@wazir/core';
import { collectHealthReport, fleetNodeHealth, healthExitCode, renderHealthReport } from '../src/health.js';
import { renderFleetView, type FleetWorkerItem } from '../src/tui/observabilityViews.js';

const ANSI = /\u001b\[/;
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function engine(opts: { runtimeHealth?: 'healthy' | 'degraded' | 'unavailable'; state?: 'READY' | 'LOADED'; inferenceError?: string; telemetry?: boolean } = {}) {
  const computers = new ComputerRegistry();
  computers.register({ id: 'DGX-01', name: 'DGX-01', type: 'server', local: true, hardware: { memoryGB: 116 } } as never);
  const runtimes = new RuntimeRegistry();
  runtimes.register({ id: 'lmstudio', type: 'lmstudio', name: 'LM Studio', version: '1', computerId: 'DGX-01' });
  runtimes.setHealth('lmstudio', opts.runtimeHealth ?? 'healthy');
  const models = new ModelRegistry();
  models.register({
    id: 'qwen3-coder', name: 'qwen3-coder', provider: 'lmstudio', family: 'qwen', contextMax: 65536, capabilities: ['coding'],
    toolCalling: true, structuredOutput: false, vision: false, audio: false, embedding: false, reasoning: false,
    runtimeCompatibility: 'any', local: true, createdAt: new Date(), updatedAt: new Date(),
  } as never);
  models.upsertInstance({
    id: 'i1', modelId: 'qwen3-coder', computerId: 'DGX-01', runtimeId: 'lmstudio', runtimeModelId: 'qwen3-coder',
    loaded: true, state: opts.state ?? 'READY', health: opts.state === 'LOADED' ? 'degraded' : 'healthy', contextTokens: 32768,
  });
  const health = new HealthEvidenceLog();
  health.recordInference('lmstudio', 'qwen3-coder', { error: opts.inferenceError });
  if (opts.telemetry) health.recordTelemetry('lmstudio', 'OBSERVED');
  const worker = { id: 'w1', computerId: 'DGX-01', isRunning: true, info: { status: 'online' as const, lastHeartbeat: new Date() } };
  return { computers, runtimes, models, health, worker } as never;
}

describe('wa models health', () => {
  it('JSON output is ANSI-free, parseable and carries diagnostics with evidence', () => {
    const report = collectHealthReport(engine({ state: 'LOADED' }));
    const json = JSON.stringify(report, null, 2);
    expect(json).not.toMatch(ANSI);
    const parsed = JSON.parse(json);
    expect(parsed.runtimes[0]).toMatchObject({ runtimeId: 'lmstudio', state: 'READY' });
    expect(parsed.models[0]).toMatchObject({ loaded: true, ready: false });
    expect(parsed.diagnostics.map((d: { code: string }) => d.code)).toContain('MODEL_NOT_READY');
    expect(parsed.diagnostics[0].evidence.length).toBeGreaterThan(0);
  });

  it('text output shows runtime, inference and telemetry on separate axes', () => {
    const text = stripAnsi(renderHealthReport(collectHealthReport(engine())));
    expect(text).toMatch(/Runtime\s+READY/);
    expect(text).toMatch(/Inference\s+HEALTHY/);
    expect(text).toMatch(/Telemetry\s+UNKNOWN/);
    expect(text).toContain('TELEMETRY_UNAVAILABLE');
  });

  it('--detail shows the evidence behind a classification', () => {
    const text = stripAnsi(renderHealthReport(collectHealthReport(engine({ state: 'LOADED' })), { detail: true }));
    expect(text).toContain('MODEL_NOT_READY');
    expect(text).toContain('Reason: model is loaded but has not been verified ready');
    expect(text).toContain('model state = LOADED');
    expect(text).toMatch(/last successful inference = \d+s ago/);
  });

  it('exit code: telemetry/UNKNOWN never fail; errors do', () => {
    expect(healthExitCode(collectHealthReport(engine()))).toBe(0);
    expect(healthExitCode(collectHealthReport(engine({ runtimeHealth: 'degraded' })))).toBe(0);
    expect(healthExitCode(collectHealthReport(engine({ runtimeHealth: 'unavailable' })))).toBe(1);
    expect(healthExitCode(collectHealthReport(engine({ inferenceError: 'HTTP 500' })))).toBe(1);
  });
});

describe('Mission Control FLEET health indicators', () => {
  const card = (h: FleetWorkerItem['health']): FleetWorkerItem => ({
    id: 'DGX-01', name: 'DGX-01', type: 'server', status: 'online', runtimes: ['lmstudio'], loadedModels: ['qwen3-coder'],
    ram: { totalGB: 116, availableGB: 45 }, reservations: 0, shards: [], health: h,
  });

  it('renders compact runtime/model/inference/telemetry lines', () => {
    const h = fleetNodeHealth(collectHealthReport(engine({ telemetry: true })), 'DGX-01');
    expect(h).toMatchObject({ runtime: { name: 'lmstudio', state: 'READY' }, model: { id: 'qwen3-coder', state: 'READY' }, inference: 'HEALTHY', telemetry: 'OBSERVED' });
    expect(h.diagnostics).toEqual([]);
    const lines = renderFleetView({ workers: [card(h)], selectedIndex: 0, width: 100, maxRows: 30 }).map(stripAnsi);
    expect(lines.some((l) => /Runtime lmstudio READY\s+Model qwen3-coder READY/.test(l))).toBe(true);
    expect(lines.some((l) => /Inference HEALTHY\s+Telemetry OBSERVED/.test(l))).toBe(true);
  });

  it('telemetry UNKNOWN does not degrade runtime indicators', () => {
    const h = fleetNodeHealth(collectHealthReport(engine()), 'DGX-01');
    expect(h.runtime?.state).toBe('READY');
    expect(h.inference).toBe('HEALTHY');
    expect(h.telemetry).toBe('UNKNOWN');
  });

  it('shows the top diagnostic, and evidence only for the selected node, within width', () => {
    const h = fleetNodeHealth(collectHealthReport(engine({ state: 'LOADED' })), 'DGX-01');
    for (const width of [70, 100, 140]) {
      const selected = renderFleetView({ workers: [card(h)], selectedIndex: 0, width, maxRows: 30 }).map(stripAnsi);
      const unselected = renderFleetView({ workers: [card(h)], selectedIndex: -1, width, maxRows: 30 }).map(stripAnsi);
      expect(selected.some((l) => l.includes('MODEL_NOT_READY'))).toBe(true);
      expect(selected.some((l) => l.includes('model state = LOADED'))).toBe(true);
      expect(unselected.some((l) => l.includes('model state = LOADED'))).toBe(false);
      for (const l of selected) expect(l.length).toBeLessThanOrEqual(width);
    }
  });
});
