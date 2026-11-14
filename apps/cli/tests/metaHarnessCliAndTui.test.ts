import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  CapabilityGraphBuilder,
  MetaHarnessService,
} from '@wazir/core';
import {
  askCommand,
  executionPlanCommand,
  executionReportCommand,
  executionStatusCommand,
  hardwareCapabilitiesCommand,
  hardwareDiscoverCommand,
  hardwareInspectCommand,
  hardwareListCommand,
  hardwareTopologyCommand,
  qualifyMetaHarnessCommand,
  runtimesStatusCommand,
  workersStatusCommand,
} from '../src/commands.js';
import type { RookEngine } from '../src/engine.js';

function createTestHarnessService(): MetaHarnessService {
  const store = new MemoryStore();
  const builder = new CapabilityGraphBuilder({ coordinatorHostId: 'macbook_pro' });
  const nowIso = new Date().toISOString();

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/v0/models') || url.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'qwen-agentworld-35b-a3b', state: 'loaded' },
            { id: 'mlx-community/qwen3.5-9b', state: 'loaded' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/tags')) {
      return new Response(
        JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/ps')) {
      return new Response(
        JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { completion_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  void builder;
  return new MetaHarnessService({
    store,
    fetchImpl: mockFetch,
    hostDiscoveryDriver: {
      discoverLocalHost: async () => ({
        kind: 'physical_host',
        reachable: true,
        machineId: 'mach-mbp-local',
        hostId: 'macbook_pro',
        hostname: 'MacBook-Pro.local',
        aliases: ['macbook_pro'],
        os: { platform: 'darwin', release: '25.0.0', architecture: 'arm64', appleSiliconGeneration: 'M5 Pro' },
        cpu: { brand: 'Apple M5 Pro', architecture: 'arm64', logicalCores: 14, physicalCores: 14, utilizationPercent: 10 },
        gpus: [
          {
            gpuId: 'apple-gpu-mbp',
            index: 0,
            vendor: 'apple',
            model: 'Apple M5 Pro',
            metalSupported: true,
            unifiedMemory: true,
            totalMemoryGB: 24,
            availableMemoryGB: 14,
            usedMemoryGB: 10,
          },
        ],
        memory: {
          totalGB: 24,
          availableGB: 14,
          usedGB: 10,
          unifiedMemory: true,
          pressureLevel: 'normal',
          reservedBySystemGB: 3,
          reservedByUserGB: 0,
        },
        disk: { mountPoint: '/', totalGB: 1000, freeGB: 600, usedPercent: 40 },
        networkIdentityIds: [],
        localWorkerAvailable: true,
        workerIds: [],
        runtimeIds: [],
        workloadConflicts: [],
        resourceReservationsGB: { ramGB: 0, vramByGpuId: {} },
        lastDiscoveredAt: nowIso,
        provenance: ['local_introspection'],
        confidence: 1,
      }),
      discoverSshHost: async ({ hostId }) => ({
        kind: 'physical_host',
        reachable: true,
        machineId: hostId === 'dgx_spark' ? 'mach-dgx-gb10' : 'mach-studio-m4',
        hostId,
        hostname: hostId,
        aliases: [hostId],
        os: { platform: hostId === 'dgx_spark' ? 'linux' : 'darwin', release: '6.8', architecture: 'arm64' },
        cpu: { brand: 'ARM64', architecture: 'arm64', logicalCores: 20, physicalCores: 20, utilizationPercent: 15 },
        gpus: [
          {
            gpuId: `gpu-${hostId}`,
            index: 0,
            vendor: hostId === 'dgx_spark' ? 'nvidia' : 'apple',
            model: hostId === 'dgx_spark' ? 'NVIDIA GB10' : 'Apple M4 Max',
            unifiedMemory: true,
            totalMemoryGB: hostId === 'dgx_spark' ? 121.69 : 36,
            availableMemoryGB: hostId === 'dgx_spark' ? 86 : 16,
            usedMemoryGB: hostId === 'dgx_spark' ? 35.69 : 20,
          },
        ],
        memory: {
          totalGB: hostId === 'dgx_spark' ? 121.69 : 36,
          availableGB: hostId === 'dgx_spark' ? 86 : 16,
          usedGB: hostId === 'dgx_spark' ? 35.69 : 20,
          unifiedMemory: true,
          pressureLevel: 'normal',
          reservedBySystemGB: 4,
          reservedByUserGB: 0,
        },
        disk: { mountPoint: '/', totalGB: 2000, freeGB: 1400, usedPercent: 30 },
        networkIdentityIds: [],
        localWorkerAvailable: false,
        workerIds: [],
        runtimeIds: [],
        workloadConflicts: [],
        resourceReservationsGB: { ramGB: 0, vramByGpuId: {} },
        lastDiscoveredAt: nowIso,
        provenance: ['authorized_ssh'],
        confidence: 0.99,
      }),
    },
  });
}

describe('CLI & Natural-Language Shared MetaHarnessService Integration', () => {
  it('routes CLI hardware, runtime, worker, execution, and NL askCommand calls through one shared state', async () => {
    const svc = createTestHarnessService();

    // Before live discovery, report is strictly CONFIGURATION_ONLY (never fabricates live observations!)
    const preReport = JSON.parse((await executionReportCommand(svc, { json: true })).output);
    expect(preReport.reportMode).toBe('CONFIGURATION_ONLY');
    expect(preReport.qualification.status).toBe('PENDING_LIVE_VERIFICATION');

    // Run hardware discovery via CLI handler
    const discRes = await hardwareDiscoverCommand(svc, { json: true });
    expect(discRes.code).toBe(0);
    const discJson = JSON.parse(discRes.output);
    expect(Object.keys(discJson.graph.hosts)).toEqual(
      expect.arrayContaining(['macbook_pro', 'dgx_spark', 'mac_studio']),
    );

    // Inspect dgx_spark, list hosts, topology, capabilities, runtimes, workers
    expect((await hardwareListCommand(svc)).code).toBe(0);
    const dgxInspect = await hardwareInspectCommand(svc, 'dgx_spark');
    expect(dgxInspect.code).toBe(0);
    expect(dgxInspect.output).toContain('NVIDIA GB10');
    expect((await hardwareTopologyCommand(svc)).output).toContain('Physical Hosts');
    expect((await hardwareCapabilitiesCommand(svc)).output).toContain('dgx_spark');
    expect((await runtimesStatusCommand(svc)).output).toContain('dgx_spark:lmstudio');
    expect((await workersStatusCommand(svc)).code).toBe(0);

    // Plan 100 speed-optimized FS5 agents and verify status
    const planned = await executionPlanCommand(svc, 'Implement FS5 meta-harness', {
      scale: 100,
      speedOptimize: true,
    });
    expect(planned.code).toBe(0);
    expect(planned.output).toContain('forge-sovereign-5');
    expect((await executionStatusCommand(svc)).code).toBe(0);

    // Natural-language askCommand uses the EXACT same MetaHarnessService & store!
    const fakeEngine = {
      metaHarness: svc,
      config: { routing: {} },
    } as unknown as RookEngine;

    const nlGpu = await askCommand(fakeEngine, 'What GPUs do I have available?');
    expect(nlGpu.code).toBe(0);
    expect(nlGpu.output).toContain('NVIDIA GB10');

    const nlScale = await askCommand(fakeEngine, 'Can I execute 100 agents using my current infrastructure?');
    expect(nlScale.code).toBe(0);
    expect(nlScale.output).toContain('100');

    const qual = await qualifyMetaHarnessCommand(svc, 'acceptance');
    expect(qual.code).toBe(0);
  }, 30_000);
});
